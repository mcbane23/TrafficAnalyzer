# AGENTS.md

TrafficAnalyzer detects traffic congestion and vehicle counts from live Belgrade camera feeds.
Currently implemented: a validated camera registry, CLI revalidation tooling, a web dashboard for
browsing/watching cameras, and a real-time traffic-analysis pipeline (background-subtraction motion
detection, SQLite history, SSE push to the frontend).

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
| `SseChannel` | [src/server/sseChannel.ts](src/server/sseChannel.ts) | Yes — against a fake request/response plus an injectable `SseTimer` |
| `FrameGrabber` | [src/analysis/frameGrabber.ts](src/analysis/frameGrabber.ts) | Yes — mocks the `FfmpegRunner`/`FfmpegStreamRunner` seams (see [ffmpegRunner.ts](src/analysis/ffmpegRunner.ts)) |
| `BackgroundModel` | [src/analysis/backgroundModel.ts](src/analysis/backgroundModel.ts) | Yes — injects a fake `LumaExtractor` over synthetic pixel data, no real image decoding |
| `MotionDetector` | [src/analysis/motionDetector.ts](src/analysis/motionDetector.ts) | Yes — same, through the `BackgroundModel` it wraps |
| `VehicleTracker` | [src/analysis/vehicleTracker.ts](src/analysis/vehicleTracker.ts) | Yes — pure IoU-matching logic, no injectable seam needed |
| `OccupancyEstimator` | [src/analysis/occupancyEstimator.ts](src/analysis/occupancyEstimator.ts) | Yes — same, through the `BackgroundModel` it wraps |
| `CameraAnalyzer` | [src/analysis/cameraAnalyzer.ts](src/analysis/cameraAnalyzer.ts) | Yes — injects a fake detector/tracker/occupancy estimator; canned detections in, a result out |
| `VehicleColorEstimator` | [src/analysis/vehicleColorEstimator.ts](src/analysis/vehicleColorEstimator.ts) | No — best-effort/cosmetic, low-risk (explicit PRD call-out). Currently unwired, see below |
| `TrafficHistoryStore` | [src/analysis/trafficHistoryStore.ts](src/analysis/trafficHistoryStore.ts) | Yes — against a real in-memory (`:memory:`) SQLite DB, not mocked |
| `TrafficAnalysisService` | [src/analysis/trafficAnalysisService.ts](src/analysis/trafficAnalysisService.ts) | Yes — mocks `FrameGrabberLike`/`CameraAnalyzerLike`/`TrafficHistoryStoreLike`/`AnalysisScheduler` |
| Express app / routes | [src/server/app.ts](src/server/app.ts) | No — thin wiring around `CameraService`/`RevalidationService`/`HlsProxyService`/`SseChannel`/`TrafficAnalysisService` |
| Revalidate CLI | [src/cli/revalidate.ts](src/cli/revalidate.ts) | No — thin orchestrator |

Rule of thumb: new logic worth testing goes in a deep module with an injectable seam (constructor
option, e.g. `probeRunner`/`now`/`source`); route handlers and CLI entrypoints stay thin wiring and
don't get tests. Follow [src/validator/cameraValidator.test.ts](src/validator/cameraValidator.test.ts)
as the reference pattern for new tests (inject a fake for the single external dependency, assert on
the returned result shape).

A corollary that has bitten this codebase: **if a file exempted from tests as "thin wiring" starts
accumulating real logic, extract that logic into a module rather than leaving it untested by
default.** `SseChannel` exists for exactly this reason — heartbeat lifecycle, socket-timeout
disabling and write-after-close guarding all lived in `app.ts` under that exemption.

`TrafficAnalysisService` is the largest example of the injectable-seam pattern: it takes three
seams (frame grab, a per-camera `createAnalyzer` factory, history store) plus a
`setTimeout`/`clearTimeout` `AnalysisScheduler`, so scheduling/boosting/concurrency-capping/fan-out
logic can be asserted deterministically without spawning ffmpeg, running real background
subtraction, or waiting on real timers — see
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
  pinned Node runtime — an unsupported `NODE_OPTIONS` flag makes Node refuse to boot. The
  Dockerfile's `CMD` runs `node dist/server/index.js` directly (bypassing `npm start`), so this
  doesn't affect the container.
- Docker: the build stage uses the full `node:22-bookworm` image because `better-sqlite3` compiles
  from source on install (node-gyp needs Python + a C++ toolchain); the runtime stage is
  `node:22-bookworm-slim` (glibc, not alpine — the bundled ffmpeg/ffprobe binaries need glibc) and
  copies the already-pruned `node_modules` from the build stage rather than running `npm ci` again.
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): every branch/PR runs `npm ci`, `npm test`,
  `npm run build` and a Docker build, and keeps **nothing** on GitHub — no uploaded artifacts, no
  build records (`DOCKER_BUILD_RECORD_UPLOAD=false`), no npm cache, no Docker layer cache writes.
  Only a push to `main` pushes `ghcr.io/mcbane23/trafficanalyzer:latest` and `:<full commit sha>`
  (and writes the layer cache branches read from). Keep it that way when editing the workflow.
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

- **Per-camera state lives in one `CameraAnalyzer` instance, not in parallel maps.** An analyzer
  owns one camera's detector, tracker, occupancy estimator and traffic-level derivation, behind
  `analyze(frame, timestamp) -> CameraAnalysisResult`. All of those describe a single fixed
  viewpoint, are meaningless shared across cameras, and must be discarded together — so they have
  one lifetime: built per active camera in `TrafficAnalysisService.start()`, released in `stop()`.
  Add a new per-camera signal here, not as another `Map<cameraId, …>` on the service.
- `MotionDetector` and `OccupancyEstimator` are both built on `BackgroundModel`, which owns the
  per-pixel adaptive background, the seed-from-first-frame warmup, selective (slow) adaptation
  where something is present, and the long-run activity band that identifies roadway. They still
  hold **separate instances** per camera — their tuning genuinely differs (working resolution, and
  how long a stopped vehicle keeps being reported via `foregroundLearningRate`) — but there is only
  one implementation of the model itself. `BackgroundModel.observe(frame)` returns a foreground
  mask plus a roadway mask; reducing that to a ratio is `OccupancyEstimator`'s job, grouping it into
  blobs is `MotionDetector`'s.
- Detection is local-only and no longer classifies vehicle type: `MotionDetector` groups the
  foreground pixels `BackgroundModel` reports into connected-component blobs, and surfaces every
  blob as a single generic `'vehicle'` class (see `VehicleClass` in `types/analysis.ts`). This
  replaced an earlier YOLOv8n/ONNX appearance-based classifier: on this camera fleet, vehicles are
  small, oblique, motion-blurred and heavily compressed, and appearance classification degraded
  worst on precisely the vehicles that were moving — a difference-from-background signal doesn't
  care what the object looks like, only that it's there and the background isn't, so it stays
  reliable where classification didn't. Selective background adaptation (`foregroundLearningRate`,
  much slower than `learningRate`) means a vehicle stopped at a light or in a jam keeps being
  reported for a while after it stops moving rather than disappearing the instant it's stationary —
  a genuinely parked vehicle still eventually fades out of the count, just slower.
- `FrameGrabber` offers two capture modes against ffmpeg (`@ffmpeg-installer/ffmpeg`, the same
  bundled-binary pattern as `@ffprobe-installer/ffprobe`), as **two methods, not one method with a
  mode flag** — they differ in lifetime, not just behaviour. `grabFrame(camera)` spawns a process,
  waits for exit and returns one frame (used for a camera's single background pass).
  `openCapture(camera)` returns a `FrameCapture` (`next()` / `close()`) backed by a long-running
  ffmpeg decoding at a fixed low fps (`streamFps`, default 6), used for boosted ticks — re-spawning
  per tick (full HLS reconnect: playlist + segment fetch) was far too slow to hit multiple
  bounding-box updates per second. `TrafficAnalysisService` holds the capture on that camera's tick
  state and closes it when the last `subscribeCameraDetail` subscriber disconnects (and on
  `stop()`), so idle cameras don't keep an ffmpeg process running. Holding the object is what makes
  that impossible to forget: there is no stop-by-id call to remember, and no optional member on the
  seam a test fake can skip. A capture respawns its process transparently if ffmpeg dies mid-stream,
  but stays closed once `close()` is called. Both modes reuse the same header-forwarding logic
  `CameraValidator`/`HlsProxyService` already use for cameras needing a special `Referer`.
- `TrafficAnalysisService` is the orchestrator, and only that: scheduling, boosting, the concurrency
  pool, persistence and subscriber fan-out. One background tick per `active` camera (inactive
  cameras are skipped entirely), boosted while a camera has at least one `subscribeCameraDetail`
  subscriber (i.e. its detail page is open), all work capped by a small concurrency pool
  (`maxConcurrency`, default 6) with the rest queued. It does not know how a frame becomes a result
  — that's `CameraAnalyzer`. Traffic-level (`light`/`moderate`/`heavy`) is derived primarily from
  roadway occupancy (see `OccupancyEstimator`), falling back to a tunable total-count threshold
  while occupancy is still warming up — exact numbers are an internal implementation detail, not a
  fixed spec.
- `VehicleColorEstimator` is currently **unwired** — nothing constructs or calls it. Per-detection
  crop+resize cost, compounding with detection count, slowed every tick down for a field nothing
  needed yet. It's kept on disk because re-enabling it is a one-line change inside
  `CameraAnalyzer.analyze` (map raw detections through `estimateColor`); it is deliberately not
  passed around as an injected-but-unused seam.
- A failed tick (capture or detection) is **published but never persisted**: its zeroed count and
  `light` badge describe a broken feed, not an empty road, and writing those to history would show
  up in the trend view as genuine quiet traffic. Live subscribers still get it, because a viewer
  needs to know the feed is broken.
- Results are pushed to the browser via Server-Sent Events, not polled: `GET /api/analysis/stream`
  (dashboard-wide overview) and `GET /api/cameras/:id/analysis/stream` (per-camera full detail —
  opening this connection is literally what triggers the sampling-rate boost; closing it reverts).
  `GET /api/analysis/latest` and `GET /api/cameras/:id/analysis/history` back the initial
  bootstrap/trend-view REST calls. All four routes are thin wiring in `app.ts`: the two SSE routes
  open an `SseChannel` (which owns the headers, the disabled socket timeout, the keep-alive
  heartbeat and the write-after-close guards, and unsubscribes + tears itself down when the request
  closes) and the rest call straight into `TrafficAnalysisService`. The history route passes
  `?limit=` through uncoerced on purpose — bounding it is `TrafficHistoryStore.normalizeLimit`'s
  job, and it has to do it for any other caller anyway.
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
