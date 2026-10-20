# AGENTS.md

TrafficAnalyzer detects traffic congestion and vehicle counts from live Belgrade camera feeds.
Currently implemented: a validated camera registry, CLI revalidation tooling, a web dashboard for
browsing/watching cameras, a real-time traffic-analysis pipeline (background-subtraction motion
detection, SQLite history, SSE push to the frontend), and traffic statistics (vehicles passed per
period, by direction and coarse size class).

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
| `VideoFrame` helpers | [src/analysis/videoFrame.ts](src/analysis/videoFrame.ts) | Yes — `resampleLuma` (area-average downscale) and `encodeJpeg` (thumbnail) on synthetic planes |
| `BackgroundModel` | [src/analysis/backgroundModel.ts](src/analysis/backgroundModel.ts) | Yes — injects a fake `LumaExtractor` over synthetic pixel data, no real image decoding |
| `MotionDetector` | [src/analysis/motionDetector.ts](src/analysis/motionDetector.ts) | Yes — same, through the `BackgroundModel` it wraps |
| `VehicleTracker` | [src/analysis/vehicleTracker.ts](src/analysis/vehicleTracker.ts) | Yes — pure ByteTrack-style logic (Kalman + Hungarian via [assignment.ts](src/analysis/assignment.ts)), timestamps passed in, no injectable seam needed |
| `OccupancyEstimator` | [src/analysis/occupancyEstimator.ts](src/analysis/occupancyEstimator.ts) | Yes — same, through the `BackgroundModel` it wraps |
| `CameraAnalyzer` | [src/analysis/cameraAnalyzer.ts](src/analysis/cameraAnalyzer.ts) | Yes — injects a fake detector/tracker/occupancy estimator; canned detections in, a result out |
| `AnalysisWorkerPool` | [src/analysis/analysisWorkerPool.ts](src/analysis/analysisWorkerPool.ts) | Yes — `AnalysisWorkerHost` driven by an in-process fake worker (`createWorker` seam); [analysisWorker.ts](src/analysis/analysisWorker.ts) is the thin `worker_threads` entry |
| `VehicleColorEstimator` | [src/analysis/vehicleColorEstimator.ts](src/analysis/vehicleColorEstimator.ts) | No — best-effort/cosmetic, low-risk (explicit PRD call-out). Currently unwired, see below |
| `TrafficHistoryStore` | [src/analysis/trafficHistoryStore.ts](src/analysis/trafficHistoryStore.ts) | Yes — against a real in-memory (`:memory:`) SQLite DB, not mocked |
| `TrafficAnalysisService` | [src/analysis/trafficAnalysisService.ts](src/analysis/trafficAnalysisService.ts) | Yes — mocks `FrameGrabberLike`/`CameraAnalyzerLike`/`TrafficHistoryStoreLike`/`AnalysisScheduler` |
| `YoloDetector` | [src/analysis/yoloDetector.ts](src/analysis/yoloDetector.ts) | Yes — letterbox/decode/NMS on synthetic tensors via the `YoloSession` seam, no real model |
| `LiveOverlayService` | [src/analysis/liveOverlayService.ts](src/analysis/liveOverlayService.ts) | Yes — mocks `FrameGrabberLike`, the per-camera pipeline factory and the scheduler |
| `CameraPassageModel` (`DirectionModel`, `SizeClassifier`) | [src/analysis/passageModel.ts](src/analysis/passageModel.ts) | Yes — pure logic over synthetic tracks |
| `TrafficStatsStore` | [src/analysis/trafficStatsStore.ts](src/analysis/trafficStatsStore.ts) | Through `TrafficStatsService`'s tests, against a real `:memory:` DB |
| `TrafficStatsService` | [src/analysis/trafficStatsService.ts](src/analysis/trafficStatsService.ts) | Yes — real `:memory:` `TrafficStatsStore` plus an injected `now` |
| Pipeline end-to-end | [src/analysis/pipeline.test.ts](src/analysis/pipeline.test.ts) | Yes — real ffmpeg + detector + tracker on committed synthetic footage with known ground truth ([__fixtures__/syntheticFootage.ts](src/analysis/__fixtures__/syntheticFootage.ts)) |
| Express app / routes | [src/server/app.ts](src/server/app.ts) | No — thin wiring around `CameraService`/`RevalidationService`/`HlsProxyService`/`SseChannel`/`TrafficAnalysisService`/`TrafficStatsService` |
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
seams (frame capture, a per-camera `createAnalyzer` factory, history store) plus a
`setTimeout`/`clearTimeout` `AnalysisScheduler`, so loop/concurrency-capping/throttling/fan-out
logic can be asserted deterministically without spawning ffmpeg, running real background
subtraction, or waiting on real timers — see
[src/analysis/trafficAnalysisService.test.ts](src/analysis/trafficAnalysisService.test.ts)'s
`FakeCapture` (the test pushes frames with chosen capture times) and `makeFakeScheduler()`.

Real camera streams can't be reached from CI, so end-to-end behaviour is tested on synthetic
footage: `src/analysis/__fixtures__/synthetic-two-lanes.mp4` is rendered by
`npx tsx src/analysis/__fixtures__/syntheticFootage.ts` from the `SCENE` ground truth in that file
(regenerate the clip whenever `SCENE` changes - rendering takes ~30s, so the clip is committed).

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
- `ffprobe`/`ffmpeg` are bundled via `@ffprobe-installer/ffprobe` / `@ffmpeg-installer/ffmpeg`
  (regular dependencies), but `FFPROBE_PATH` / `FFMPEG_PATH` env vars override them, and **on Linux
  they must**: the bundled Linux binaries are static-glibc builds that cannot resolve hostnames and
  segfault (exit 139) on any `https://` camera URL. The Docker image installs Debian's ffmpeg and
  sets both vars. The bundled binaries are still fine for local files (tests) and on Windows/macOS.
  Sandboxes behind an HTTP proxy hide this (ffmpeg then only connects to the proxy's IP) — test
  without the proxy. `CameraValidator` accepts an optional `ffprobePath` override.
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
- Image size: `.npmrc` must be copied in before `npm ci` (it skips onnxruntime-node's ~270 MB
  CUDA/TensorRT download, which silently landed in every image while it wasn't). Frontend libraries
  (vue, chart.js, hls.js, ...) are devDependencies because Vite bundles them; keep them there, or
  their optional peers (typescript, vite) come back into the prod tree. The build stage deletes the
  bundled `@ffmpeg-installer`/`@ffprobe-installer` and other platforms' native binaries, so
  `ffmpegRunner.ts`/`probeRunner.ts` must only `require` the bundled packages when
  `FFMPEG_PATH`/`FFPROBE_PATH` are unset. Most of what's left is the apt layer: Intel's GPU compute
  runtime (~260 MB unpacked) and Debian ffmpeg, whose SDL dependency drags in mesa + LLVM (~200 MB).
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
- `FrameGrabber.openCapture(camera)` returns a `FrameCapture` (`next()` / `close()`) backed by a
  long-running ffmpeg (`@ffmpeg-installer/ffmpeg`, the same bundled-binary pattern as
  `@ffprobe-installer/ffprobe`) decoding at a fixed low fps (`streamFps`, default 3, `ANALYSIS_FPS`
  env var in `src/server/index.ts`). Frames come out of ffmpeg already scaled to 320x240 as **raw
  `yuv420p`** (`VideoFrame`), one decoding thread per process (`-threads 1`) — never JPEG. The
  earlier MJPEG round trip (ffmpeg encodes every frame, `sharp` decodes it again once per background
  model) was ~75% of the pipeline's CPU and made a 22-camera fleet need ~3.5 cores; on a smaller
  Docker host that starved every capture into `frame capture timed out`. Background models take the
  luma plane via `resampleLuma`; the only JPEG left is the dashboard thumbnail
  (`TrafficAnalysisService.getLatestFrame`), encoded at most every `thumbnailIntervalMs` (2s).
  Don't reintroduce a per-frame encode/decode step on this path. Input is paced with `-re`: without it ffmpeg decodes each HLS
  segment in a burst (many seconds of frames within ~100ms, then silence), which made frame spacing
  meaningless to the tracker. Each frame carries `capturedAt` (decode time), which is the result's
  timestamp. The capture **supervises its own ffmpeg**: a process that exits is restarted after
  `restartDelayMs`, backing off exponentially to `maxRestartDelayMs` while it keeps dying without
  producing frames; a process that stays up but produces nothing for `stallTimeoutMs` (a live
  playlist that stopped advancing) is killed and restarted; HTTP(S) inputs get `-rw_timeout` and
  ffmpeg's `-reconnect` flags. A `next()` waits up to `timeoutMs` (30s) — deliberately longer than
  the 20s stall watchdog, so a dead stream is reported with the watchdog's real reason and a stream
  that is merely slow to open (HLS probing downloads whole 10s segments) isn't reported as broken.
  It stays closed once `close()` is called. `grabFrame(camera)` (one
  frame from a one-off process) still exists but is not used by the analysis service. Both reuse
  the same header-forwarding logic `CameraValidator`/`HlsProxyService` use for cameras needing a
  special `Referer`.
- `VehicleTracker` is ByteTrack-style: constant-velocity Kalman filter per track driven by real frame
  timestamps (`update(detections, timestampMs)`), optimal (Hungarian) association on a blend of IoU
  and uncertainty-gated centre distance (IoU alone fails for small fast vehicles, which have zero
  overlap with themselves between frames), a second pass where low-confidence detections may only
  keep confirmed tracks alive, `minHits` confirmation before a track is reported or counted, and
  `maxLostMs` coasting. A confirmed track that ends is emitted exactly once as a `FinishedTrack`
  (`CameraAnalysisResult.finishedTracks`) — the basis for counting vehicles rather than blobs. On
  the synthetic fixture the previous IoU-only tracker produced 112 ids for 7 vehicles at 3 fps.
- `TrafficAnalysisService` is the orchestrator, and only that: one continuous capture + analysis loop
  per `active` camera for as long as the service runs (inactive cameras are skipped entirely;
  startups are staggered), all analysis capped by a small concurrency pool (`maxConcurrency`,
  default 6; each camera has at most one frame in flight, so a slow host just drops queued frames).
  Detail subscribers get every frame's result; dashboard overview updates are throttled
  (`overviewIntervalMs`, but a changed badge/error goes out immediately); history gets one row per
  camera per `historyIntervalMs` (default 10s) with the mean count over that window; `onResult` is a
  hook called with every usable frame (incl. `finishedTracks`). It does not know how a frame becomes
  a result — that's `CameraAnalyzer`. Traffic-level (`light`/`moderate`/`heavy`) is derived primarily
  from roadway occupancy (see `OccupancyEstimator`), falling back to a tunable total-count threshold
  while occupancy is still warming up — exact numbers are an internal implementation detail, not a
  fixed spec. Continuous analysis of every camera is a deliberate product choice so
  statistics cover the whole fleet; the earlier design analyzed one frame per camera at startup,
  which never got past the detector's 20-frame warm-up, so every dashboard count was a zero.
- **The fleet's motion analysis runs on worker threads** (`AnalysisWorkerPool`, `ANALYSIS_THREADS`,
  default 2; `0` keeps it on the main thread). Measured on Bane's N150 with the GPU overlay: the
  main Node thread, not the CPU (231% of 400%), was the bottleneck. While it was busy it read the
  overlay's ffmpeg pipe late, so the overlay ran at 0.33-0.73x real time; at `ANALYSIS_FPS=1` it was
  1.00x. The pool's `createAnalyzer` plugs into `TrafficAnalysisService`'s existing seam, each camera
  stays on one worker (its learned state lives there), and a dead worker is replaced after
  `restartDelayMs` with its cameras re-created from scratch. Under `tsx` the worker registers
  `tsx/cjs/api` itself, since a worker thread doesn't inherit tsx's loader. On 20 synthetic cameras
  in the sandbox, main-thread busy time dropped from 39% to 8% with identical results.
- `VehicleColorEstimator` is currently **unwired** — nothing constructs or calls it. Per-detection
  crop+resize cost, compounding with detection count, slowed every tick down for a field nothing
  needed yet. It's kept on disk because re-enabling it is a one-line change inside
  `CameraAnalyzer.analyze` (map raw detections through `estimateColor`); it is deliberately not
  passed around as an injected-but-unused seam.
- A failed frame (capture or detection) or a warm-up frame (`warmingUp: true`, detector still
  learning the background) is **published but never persisted**, and never passed to `onResult`:
  its zeroed count and `light` badge describe the pipeline, not an empty road, and writing those to
  history would show up in the trend view as genuine quiet traffic. Live subscribers still get it,
  because a viewer needs to know the feed is broken or still settling. A warm-up frame also does
  not replace the dashboard overview.
- Results are pushed to the browser via Server-Sent Events, not polled: `GET /api/analysis/stream`
  (dashboard-wide overview) and `GET /api/cameras/:id/analysis/stream` (per-camera full detail —
  every active camera is analyzed continuously, so this only listens).
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
  connection. `StreamPlayer.vue`'s canvas overlay is synced to the picture by stream
  time (see "Overlay sync" below), so boxes no longer lag the video.

## Overlay sync and the watched-camera detector

- **Boxes are drawn by stream time, not arrival time.** The camera streams have 10s segments, an
  `EXT-X-DISCONTINUITY` on every segment and no `PROGRAM-DATE-TIME`, but their MPEG-TS PTS is
  continuous, so it is the shared clock. Continuous captures run ffmpeg with `-copyts` and a
  trailing `showinfo` filter (`-loglevel level+info`; `FfmpegFrameCapture.onStderr` pairs each
  frame with its pts by `showinfo`'s frame index `n`, and keeps only `[error]`-tagged lines as
  failure reasons). Results carry `streamTime` (seconds). In the browser, hls.js's
  `INIT_PTS_FOUND` (`initPTS / timescale` per discontinuity `cc`) plus `video.currentTime` gives
  the on-screen frame's PTS. `StreamPlayer.vue` buffers results and interpolates between the two
  either side of it, with PTS wrap (~95443s) handled by `streamDiff`. Before this, boxes were
  drawn on arrival and landed 5-10s away from their vehicles.
- **Analysis must run ahead of the player.** Captures join HLS at `-live_start_index -2`
  (`LIVE_START_INDEX`), and hls.js plays `liveSyncDurationCount: 3` (~30s behind live, which Bane
  accepted). That puts analysis ~10s ahead. A just-opened player needs results produced before it
  connected, which is what `TrafficAnalysisService.getRecentResults` (`GET
  /api/cameras/:id/analysis/recent`, last 45s) and `LiveOverlayService`'s replay-on-subscribe are for.
- **The watched camera gets YOLO boxes; statistics stay on motion detection** (Bane's call: YOLO11n
  costs ~110-185ms per 640px frame per core, far too much for 22 cameras). `LiveOverlayService`
  starts a 640x480 capture plus `YoloDetector` and its own `VehicleTracker` per camera on its first
  viewer (`GET /api/cameras/:id/overlay/stream`, SSE), lingers 15s after the last one, and serves at
  most `maxCameras` (2). The player falls back to the motion-analysis boxes when the overlay is
  refused, busy or keeps failing (`subscribeCameraOverlay`). The player also draws the motion boxes while the overlay
  starts (up to ~30s: it starts on the first viewer and its first results are ~10s ahead of the
  picture), handing over once an overlay result covers the frame on screen. Env: `OVERLAY_DETECTOR=off`,
  `OVERLAY_FPS` (3), `OVERLAY_THREADS` (2). The model is `models/yolo11n.onnx` (Ultralytics YOLO11n,
  AGPL-3.0, exported with a 640x480 input to match the capture - a square 640 input wasted a quarter
  of each inference on padding). `onnxruntime-node` is loaded lazily, and `.npmrc` skips its CUDA
  download. The Dockerfile drops its darwin/win32 binaries.
- **`OVERLAY_DEVICE=GPU` runs the overlay on an Intel iGPU via OpenVINO** (Bane's call after
  measuring recall: YOLO11n at 640px saw 3 of ~100 cars on Gazela, YOLO11s at 960px ~25-40, at ~4x
  the compute). `loadYoloModel` compiles `models/yolo11s-openvino/yolo11s.xml` (FP16 IR, 960x736
  input, output tensor renamed `output0` - an unnamed output makes `openvino-node` throw) on that
  device, caching kernels in `data/openvino-cache`, and falls back to YOLO11n on onnxruntime CPU if
  it fails; the overlay capture is 960x720 in GPU mode. `YoloDetector` takes a `() =>
  Promise<YoloModel>` so the CPU-or-GPU choice is made lazily on the first viewer. The container
  needs `/dev/dri` and the host's `render` GID in `group_add`. The runtime image is Debian trixie
  with Intel's Ubuntu 24.04 `intel-opencl-icd` (bookworm's 2022 driver predates the N150 iGPU);
  the Dockerfile drops `openvino-node`'s unused frontends and NPU plugin but must keep the IR
  frontend. The GPU path can't be exercised in CI or the sandbox (OpenVINO's CPU device can, with
  the same IR).
- **`OVERLAY_MODEL` picks the GPU model** (`OPENVINO_MODELS` in `yoloDetector.ts`): `yolo11s`
  (default), `yolo26n`, `yolo26s`, all FP16 IR, 960x736, output renamed `output0`. Ultralytics
  exports YOLO26 for OpenVINO with the same `[1, 84, anchors]` one-to-many head, so the same
  decoder and NMS apply. On six camera frames (960px, conf 0.25, OpenVINO CPU): YOLO11s 112
  vehicles at 145 ms, YOLO26n 77 at 59 ms (Gazela 7 vs 26), YOLO26s 98 at 139 ms. YOLO11s stays the
  default (Bane can compare live).
- **The overlay must never fall behind the player** (regression found on Bane's N150: boxes only
  flickered on now and then). Its capture uses `maxQueuedFrames: 1`, so a detector slower than
  `OVERLAY_FPS` skips frames instead of working through a growing backlog that the player soon
  overtakes. Its tracker draws every YOLO vehicle (`minHits: 1`, `minTravel: 0` - the motion
  pipeline's travel gate hid parked and queued cars) and keeps a missed car's box for
  `reportCoastingMs` (1s, only once a track has 3 matches and a trustworthy velocity). `maxSpeed: 2`
  (box diagonals per second) caps the association gate: with `minHits: 1` and ~1 fps on the N150,
  a young track's Kalman gate spanned the whole picture and its box slid across to another car. The player holds/interpolates across gaps up to 2s. Throughput is logged
  once a minute as `[LiveOverlayService] <id>: X frames/s, detection N ms/frame, V vehicles/frame`;
  on 3 sandbox cores it ran ~2.9 fps at ~155ms/frame with ~10 vehicles per frame on Slavija. The
  line also reports the capture's stream seconds per wall second: below 1x the overlay ffmpeg is
  starved of CPU (seen in the sandbox with the fleet plus YOLO on the CPU: 0.5-0.7x) and falls
  behind until the player overtakes it and draws no boxes.
- **The camera page's "In view" is the number of boxes drawn**, not the motion analysis's
  `totalCount`: `StreamPlayer` emits `inView` with the boxes it places on the current picture, and
  `CameraDetailView` passes it to `AnalysisPanel` (falling back to `totalCount` before the first
  result). YOLO boxed 13-14 vehicles where motion analysis said 4. The dashboard cards still show
  `totalCount`.
- **Motion-detection false positives, as measured on live footage**, and their fixes: a fountain
  (Slavija) and LED billboards (Gazela, Autokomanda) are covered by per-camera `ignoreZones` in
  `belgrade.json` (normalized polygons that `BackgroundModel` never treats as foreground or roadway,
  and that YOLO detections centred in are dropped from). Blobs that churn in place are filtered by
  `VehicleTracker`'s `minTravel`: a track is reported or counted only once it has travelled 0.6x its
  box size. The Železnička camera pans between presets, so `BackgroundModel` re-seeds when ≥60% of
  the picture is foreground on 2 consecutive frames (`sceneChangeRatio`). Cars merging into one blob
  in dense traffic is inherent to motion detection and is not fixed. Tooling to re-measure:
  record with `ffmpeg -i <m3u8> -t 180 -c copy x.ts`, then run `MotionDetector` and `VehicleTracker`
  offline over `-copyts ... showinfo` frames.

## Traffic statistics feature

- **Counts are passages, not snapshots.** `totalCount` on a result is vehicles in view on one
  frame; statistics count each vehicle once, when its track finishes. `TrafficStatsService`
  consumes `TrafficAnalysisService`'s `onResult` hook (wired in `src/server/index.ts`) and turns
  every `FinishedTrack` into a `VehiclePassage` via that camera's `CameraPassageModel`. It never
  sees error or warm-up results (the hook doesn't fire for them).
- **Direction** is learned, not configured: `DirectionModel` takes the principal axis of passage
  displacement vectors, oriented so `A` = down the frame (left-to-right on a near-horizontal road).
  The axis is re-seeded from persisted passages (last 7 days) on first use after a restart so labels
  stay stable. Optional human names live in the registry as `directions: { a, b }`.
- **Size class** (`car` / `large`) is approximate by design (Bane chose this over dropping type or
  reviving an ML classifier): box area compared with the median of recent vehicles in the same
  horizontal band of the frame, to cancel perspective. The UI always labels it approximate.
- **Coverage is stored next to counts.** `analysis_minutes` records which minutes each camera was
  actually analyzed (plus occupancy); every bucket in the API carries `coverage`, and the UI shades
  low-coverage buckets as "not analyzed" instead of drawing zero traffic — same principle as
  "failed ticks are never persisted".
- Storage: `data/traffic-stats.db` (gitignored), separate from `traffic-history.db`. `vehicle_passages`
  holds one row per vehicle; `passage_hours` is an hourly roll-up maintained in the same transaction
  on every insert, and `TrafficStatsStore.passageBuckets` serves any hour-aligned, hour-or-coarser
  query from it (5m/15m buckets and the rolling 5-minute/1-hour live counters read raw rows).
- Time zone: day buckets, "today" and the weekday x hour heatmap use `STATS_TIMEZONE` (default
  `Europe/Belgrade`), not the server's zone (UTC in Docker). Sub-day buckets align to UTC hours,
  which assumes a whole-hour UTC offset.
- API (thin routes in `app.ts`; a `StatsQueryError` becomes a 400): `GET /api/stats/summary?range=`,
  `GET /api/cameras/:id/stats?range=&bucket=`, `.../stats.csv`, `.../stats/heatmap?days=`,
  `.../stats/live`, plus `GET /api/cameras/:id/snapshot.jpg` (the analysis capture's latest frame,
  via `TrafficAnalysisService.getLatestFrame`). Allowed range/bucket pairs are `ALLOWED_BUCKETS` in
  `trafficStatsService.ts`, mirrored as `ALLOWED_BUCKETS_UI` in `src/web/composables/trafficUi.ts`.
- Frontend: a top bar (`App.vue`) with Dashboard / Statistics and a global range picker kept in the
  URL (`?range=`, via `useStatsRange`). Dashboard cards show the snapshot thumbnail and only open a
  live HLS preview on hover — never one video per card. Chart views (`CameraDetailView`,
  `StatisticsView`) are lazy-loaded routes so Chart.js stays out of the dashboard bundle; shared
  colors/labels live in `trafficUi.ts`.
