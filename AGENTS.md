# AGENTS.md

TrafficAnalyzer detects traffic congestion and vehicle counts from live Belgrade camera feeds.
Currently implemented: a validated camera registry, CLI revalidation tooling, a web dashboard for
browsing/watching cameras, and a real-time vehicle-detection/traffic-analysis pipeline (local ONNX
model, SQLite history, SSE push to the frontend).

Background/requirements: [docs/prd/belgrade-camera-registry.md](docs/prd/belgrade-camera-registry.md)
(registry + validator), [docs/prd/camera-dashboard-web-app.md](docs/prd/camera-dashboard-web-app.md)
(web app), and [docs/prd/vehicle-traffic-analysis.md](docs/prd/vehicle-traffic-analysis.md) (traffic
analysis pipeline + live UI). Registry data format: [data/cameras/README.md](data/cameras/README.md).

## Commands

- `npm test` — Jest (`ts-jest`), tests colocated as `*.test.ts` next to the module under test.
- `npm run dev` — runs backend (`tsx watch`, port 3001) and Vite dev server (port 5173) together via `concurrently`. Vite proxies `/api/*` to Express.
- `npm run build` — `tsc` (backend to `dist/`) + Vite build (frontend to `dist/web/`).
- `npm start` — runs the built server (`dist/server/index.js`), serving both the API and built frontend on one port.
- `npm run cameras:revalidate` — re-probes every camera in the registry with `ffprobe` and updates `status`/`lastVerifiedAt`/`lastError` in place.
- `dev:server`/`start` set `NODE_OPTIONS=--use-system-ca` (via `cross-env`) so Node's `fetch` (used by `HlsProxyService`) trusts the OS certificate store — see the TLS gotcha below. Not set on `cameras:revalidate`/`build`/`test` since they don't call `fetch` against camera streams (`ffprobe` already uses the OS trust store on its own).

## Architecture

Deep-module-per-concern pattern; each has one thin wiring layer and (where it has real logic) a
colocated `*.test.ts`:

| Module | Path | Tested? |
|---|---|---|
| `CameraRegistryStore` | [src/registry/cameraRegistryStore.ts](src/registry/cameraRegistryStore.ts) | No — thin file I/O + schema validation |
| `CameraValidator` | [src/validator/cameraValidator.ts](src/validator/cameraValidator.ts) | Yes — mocks `ProbeRunner` (see [probeRunner.ts](src/validator/probeRunner.ts)) |
| `CameraService` | [src/server/cameraService.ts](src/server/cameraService.ts) | Yes — mocks the `CameraSource` seam (`CameraRegistryStore`) |
| `RevalidationService` | [src/server/revalidationService.ts](src/server/revalidationService.ts) | Yes — mocks the `CameraRegistryWriter`/`CameraValidatorLike` seams |
| `HlsProxyService` | [src/server/hlsProxyService.ts](src/server/hlsProxyService.ts) | Yes — mocks the `CameraSource`/fetcher (`ResourceFetcher`) seams |
| `FrameGrabber` | [src/analysis/frameGrabber.ts](src/analysis/frameGrabber.ts) | Yes — mocks the `FfmpegRunner`/`FfmpegStreamRunner` seams (see [ffmpegRunner.ts](src/analysis/ffmpegRunner.ts)) |
| `VehicleDetector` | [src/analysis/vehicleDetector.ts](src/analysis/vehicleDetector.ts) | Yes — mocks the `InferenceRunner` seam (see [onnxRunner.ts](src/analysis/onnxRunner.ts)) |
| `VehicleColorEstimator` | [src/analysis/vehicleColorEstimator.ts](src/analysis/vehicleColorEstimator.ts) | No — best-effort/cosmetic, low-risk (explicit PRD call-out) |
| `TrafficHistoryStore` | [src/analysis/trafficHistoryStore.ts](src/analysis/trafficHistoryStore.ts) | Yes — against a real in-memory (`:memory:`) SQLite DB, not mocked |
| `TrafficAnalysisService` | [src/analysis/trafficAnalysisService.ts](src/analysis/trafficAnalysisService.ts) | Yes — mocks `FrameGrabberLike`/`VehicleDetectorLike`/`VehicleColorEstimatorLike`/`TrafficHistoryStoreLike`/`AnalysisScheduler` |
| Express app / routes | [src/server/app.ts](src/server/app.ts) | No — thin wiring around `CameraService`/`RevalidationService`/`HlsProxyService`/`TrafficAnalysisService` |
| Revalidate CLI | [src/cli/revalidate.ts](src/cli/revalidate.ts) | No — thin orchestrator |

Rule of thumb: new logic worth testing goes in a deep module with an injectable seam (constructor
option, e.g. `probeRunner`/`now`/`source`); route handlers and CLI entrypoints stay thin wiring and
don't get tests. Follow [src/validator/cameraValidator.test.ts](src/validator/cameraValidator.test.ts)
as the reference pattern for new tests (inject a fake for the single external dependency, assert on
the returned result shape). `TrafficAnalysisService` is the largest example of this: it takes five
injectable seams (frame grab, detect, color-estimate, history store, and a `setTimeout`/`clearTimeout`
`AnalysisScheduler`) so scheduling/boosting/concurrency-capping/traffic-level logic can be asserted
deterministically without spawning ffmpeg, loading the ONNX model, or waiting on real timers — see
[src/analysis/trafficAnalysisService.test.ts](src/analysis/trafficAnalysisService.test.ts)'s
`makeFakeScheduler()` (records `{fn, ms}` per `setTimeout` call, exposes `fire(index)` to await one
tick to completion).

Data flow: `data/cameras/belgrade.json` (validated against `belgrade.schema.json`) is the single
source of truth, loaded exclusively through `CameraRegistryStore` by both the CLI and
`CameraService` — never read directly elsewhere. `TrafficAnalysisService` reads the same
`CameraRegistryStore` (via the `CameraSource` seam) directly — not through `CameraService` — since
it only needs `load()`, not `CameraService`'s public-camera-shape mapping.

`src/web/` (Vue 3 + Vite + Tailwind) is a separate frontend project with its own
[tsconfig.json](src/web/tsconfig.json) and [vite.config.ts](src/web/vite.config.ts); it is excluded
from the root `tsconfig.json` and from Jest coverage. It talks to the backend via
[src/web/services/api.ts](src/web/services/api.ts) (`fetch` against `/api/cameras...`) and
[src/web/services/analysis.ts](src/web/services/analysis.ts) (REST bootstrap/history calls plus
`EventSource`-based SSE subscriptions against `/api/analysis/...`), never the filesystem. Frontend
components (including `AnalysisPanel.vue`, `StreamPlayer.vue`'s bounding-box canvas overlay, and
`CameraCard.vue`'s traffic badge) are intentionally untested, matching this project's existing
precedent for Vue components.

## Conventions / gotchas

- JSON Schema is draft 2020-12 (`$schema": ".../2020-12/schema"`) — must use `Ajv2020` from
  `ajv/dist/2020`, not the default `Ajv` (draft-07 only). `ajv-formats` is registered for `format`
  keywords like `date-time`.
- Pin `typescript` to `^5.x` — `ts-jest` requires `typescript@>=4.3 <7`; newer majors break it.
- `ffprobe` is bundled via `@ffprobe-installer/ffprobe` (a regular dependency) — no system ffmpeg
  install needed. `CameraValidator` accepts an optional `ffprobePath` override.
- Failed camera validation sets `status: "inactive"` and records `lastError`; entries are never
  deleted from the registry.
- On networks with a TLS-inspecting corporate proxy, `ffprobe`/curl trust the intercepting root CA
  (via the OS store) but Node's built-in `fetch` (undici, used by `HlsProxyService`) does not —
  it fails with `TypeError: fetch failed` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. This is why
  `dev:server`/`start` set `NODE_OPTIONS=--use-system-ca` (Node ≥22.9): it makes `fetch` trust the
  OS store too, matching `ffprobe`. Don't add this flag to a script also used to launch an older
  pinned Node runtime (e.g. the Dockerfile's `node:20` image) — an unsupported `NODE_OPTIONS` flag
  makes Node refuse to boot. The Dockerfile's `CMD` runs `node dist/server/index.js` directly
  (bypassing `npm start`), so this doesn't affect the container.
- Some upstream camera streams require a request header (e.g. `Referer`) the browser itself can't
  forge for a third-party origin (hotlink protection). Such cameras get an optional
  `headers: Record<string, string>` field in `belgrade.json`/`camera.ts` — `CameraValidator` passes
  it to `ffprobe` via `-headers` when probing directly, and `CameraService` rewrites the public
  `url` to a same-origin proxy path (`/api/cameras/:id/stream/:file`, served by `HlsProxyService`,
  which fetches the true upstream URL server-side with the configured headers) so the browser never
  needs to know the header exists. Cameras with no `headers` configured pass through unchanged.
- The API is otherwise read-only by design (no create/update/delete routes for camera data itself).
  The one exception is `POST /api/cameras/revalidate`, which starts the same ffprobe-based check
  as the `cameras:revalidate` CLI as an in-process background job (`RevalidationService`) and
  returns immediately (202 started / 409 already running); poll `GET /api/cameras/revalidate/status`
  for progress. `CameraRegistryStore` remains the only writer of `belgrade.json`, invoked either by
  the CLI or by `RevalidationService`; only one revalidation run (CLI or web-triggered) should be
  run at a time since neither takes a file lock.

## Vehicle traffic analysis feature

- Detection is local-only: `VehicleDetector` wraps a bundled YOLOv8n ONNX model
  (`models/yolov8n.onnx`, ~12MB, committed to git — see `onnxRunner.ts`'s `BUNDLED_MODEL_PATH`) run
  in-process via `onnxruntime-node`. No cloud API, no runtime download, no separate process.
  `FrameGrabber` supports two capture modes against ffmpeg (`@ffmpeg-installer/ffmpeg`, the same
  bundled-binary pattern as `@ffprobe-installer/ffprobe`): a one-off mode (spawn, wait for exit,
  return one frame — used for the ~10s background tick) and a streaming mode (`{ streaming: true }`
  — used for boosted ticks), which keeps a single long-running ffmpeg process per camera decoding at
  a fixed low fps (`streamFps`, default 3) and hands back whatever frame it most recently finished
  decoding. Re-spawning ffmpeg per tick (full HLS reconnect: playlist + segment fetch) was too slow
  to hit the boosted ~2fps target in practice — streaming mode is what actually makes multiple
  bounding-box updates per second achievable. `TrafficAnalysisService` starts the persistent stream
  implicitly on the first boosted `grabFrame(camera, { streaming: true })` call and tears it down via
  `frameGrabber.stopStreaming(cameraId)` when the last `subscribeCameraDetail` subscriber for that
  camera disconnects (and on `stop()`), so idle cameras don't keep an ffmpeg process running forever.
  Both modes reuse the same header-forwarding logic `CameraValidator`/`HlsProxyService` already use
  for cameras needing a special `Referer`.
- The pretrained COCO model has no dedicated "tram" class — `VehicleDetector`'s
  `COCO_TO_VEHICLE_CLASS` maps COCO's `train` class to `'tram'` as an accepted approximation for
  Belgrade's tram network (not a bug; revisit if a fine-tuned model ever becomes available). COCO's
  `bicycle` also maps to `'motorcycle'` (displayed as "Motorcycle/Bicycle" in the UI).
- `TrafficAnalysisService` is the orchestrator: one background tick per `active` camera (~10s
  interval, inactive cameras are skipped entirely), boosted to ~500ms while a camera has at least
  one `subscribeCameraDetail` subscriber (i.e. its detail page is open), all inference work capped
  by a small concurrency pool (`maxConcurrency`, default 3) with the rest queued. Traffic-level
  (`light`/`moderate`/`heavy`) is derived from a tunable total-count threshold — exact numbers are
  an internal implementation detail, not a fixed spec.
- Results are pushed to the browser via Server-Sent Events, not polled: `GET /api/analysis/stream`
  (dashboard-wide overview) and `GET /api/cameras/:id/analysis/stream` (per-camera full detail —
  opening this connection is literally what triggers the sampling-rate boost; closing it reverts).
  `GET /api/analysis/latest` and `GET /api/cameras/:id/analysis/history` back the initial
  bootstrap/trend-view REST calls. All four routes are thin wiring in `app.ts`'s `startSse`/
  `writeSseEvent` helpers plus direct calls into `TrafficAnalysisService` — no business logic there.
- Persistence: `TrafficHistoryStore` (better-sqlite3) writes every result to
  `data/traffic-history.db` (gitignored, runtime-generated, retained indefinitely — no pruning in
  this PRD), consistent with the project's "no separate database server" approach already used for
  `data/cameras/belgrade.json`. `TrafficAnalysisService` seeds its in-memory "latest overview" map
  from `historyStore.getLatestForAllCameras()` on construction, so a server restart doesn't blank
  the dashboard until the next tick lands.
- Frontend: `src/web/services/analysis.ts` wraps the REST + SSE calls above (used by both
  `DashboardView.vue` and `CameraDetailView.vue`). `DashboardView.vue` opens exactly **one** shared
  `subscribeOverview` connection for the whole dashboard and passes each camera's
  `CameraAnalysisOverview` down to `CameraCard.vue` as a prop — cards do not each open their own SSE
  connection. `StreamPlayer.vue`'s canvas overlay is expected to lag the live video slightly
  (frame-grab + inference time); that's an accepted tradeoff, not a bug.
