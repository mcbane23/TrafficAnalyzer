# PRD: Real-Time Vehicle Traffic Analysis

> **Revision (2026-10-20) - tracking reliability rework.** Three parts of this PRD are superseded:
> (1) sampling is no longer "low background rate, boosted while watched": every active camera is
> analyzed **continuously** (default 3 fps, `ANALYSIS_FPS`) through one self-reconnecting capture,
> and opening a detail page only listens; (2) detection is background-subtraction motion detection,
> not an object-detection model; (3) vehicle tracking is now **in scope**: a ByteTrack-style tracker
> gives each vehicle one id for its whole crossing and emits each finished vehicle once
> (`finishedTracks`), which is what vehicle counting builds on. History is one mean-count row per
> camera per 10s rather than one row per result. See AGENTS.md for the current design.

## Problem Statement

Today the dashboard and camera detail pages only let a user browse the camera registry and watch a live stream — the `AnalysisPanel` on the camera detail page is an empty "coming soon" placeholder. There is no way to actually see how much traffic is on a given camera's feed: no vehicle count, no breakdown by vehicle type, no indication of whether a road is quiet or congested, and no way to compare that at a glance across all cameras from the dashboard.

## Solution

Add a real-time vehicle-detection pipeline that watches each camera's live HLS stream, detects and classifies vehicles in sampled frames, and surfaces the results in two places:

- **Camera detail page**: the `AnalysisPanel` becomes a live panel showing the current total vehicle count, a breakdown by class (car, bus, truck, tram, motorcycle/bicycle), a best-effort dominant color per detected vehicle, and a short historical trend for that camera. The stream player itself overlays bounding boxes on top of the live video for the vehicles currently detected.
- **Dashboard overview**: each camera card gets a simple, at-a-glance overview — a current total vehicle count and a Light/Moderate/Heavy traffic-level badge — without needing to open the camera.

Under the hood, every active camera is sampled in the background at a low, fixed rate so the dashboard overview is always reasonably fresh. When a user opens a specific camera's detail page, that camera's sampling rate is temporarily boosted to give a much more responsive, "live-feeling" analysis experience while it's being watched. Detection uses a local, offline object-detection model (no cloud API, no separate service process) so the feature has no ongoing cost and no external network dependency. Every analysis result is persisted so a history/trend view is possible, and results are pushed to the browser in real time rather than polled.

## User Stories

1. As a user, I want to open a camera's detail page and see the current total number of vehicles detected in the live feed, so that I know how busy that location is right now.
2. ~~As a user, I want to see a breakdown of the current vehicle count by type (car, bus, truck, tram, motorcycle/bicycle)~~ — superseded: detection switched from appearance-based classification to motion detection (see Implementation Decisions), which cannot tell vehicle types apart. Every moving vehicle is now marked and counted as one generic class instead.
3. As a user, I want to see a best-effort dominant color shown for each currently detected vehicle, so that I can visually cross-reference what's on screen with the analysis output.
4. As a user, I want to see bounding boxes drawn over the moving vehicles directly on the live video, so that I can visually confirm what the system is detecting and where.
5. As a user, I want the count and boxes to update continuously while I'm watching a camera's detail page, so that the analysis feels live rather than static or stale.
6. As a user, I want to see a short recent history/trend of vehicle counts for the camera I'm viewing, so that I can tell if traffic is increasing, decreasing, or steady.
7. As a user, I want each camera card on the dashboard to show a current vehicle count and a simple traffic-level badge (e.g. Light/Moderate/Heavy), so that I can compare congestion across cameras without opening each one.
8. As a user, I want the dashboard overview to refresh automatically in the background, so that I don't have to manually reload the page to see updated traffic levels.
9. As a user, I want inactive cameras to clearly show that no analysis is available (rather than a stale or misleading count), so that I'm not misled about a camera that isn't actually streaming.
10. As a user, when I first open a camera's detail page and analysis hasn't produced a result yet, I want to see a clear "warming up / analyzing…" state rather than a blank or broken-looking panel.
11. As a user, if frame capture or detection fails for a camera (e.g. the stream is temporarily unreachable), I want to see a clear error/unavailable state in the analysis panel rather than a silently frozen count.
12. As a developer, I want vehicle detection to run against a local, bundled model (no external API calls, no API keys, no per-request cost), so that the feature works fully offline and has predictable operating cost.
13. As a developer, I want frame capture and inference decoupled behind clean, narrow interfaces, so that the detection pipeline can be tested without spawning real ffmpeg processes or loading a real ONNX model.
14. As a developer, I want a background sampling loop that ticks every active camera at a low, fixed rate (independent of whether anyone is viewing it), so that the dashboard overview always has a reasonably fresh result to show.
15. As a developer, I want the sampling rate for a specific camera to automatically increase while its detail page is open (and drop back down when no one is viewing it), so that the "live" experience is responsive without paying that cost for every camera all the time.
16. As a developer, I want concurrent inference work capped by a small worker pool/queue, so that CPU inference across ~23 cameras doesn't overwhelm the server.
17. As a developer, I want every analysis result (counts by class, timestamp, camera id) persisted to a local, file-based store, so that historical trend data survives a server restart and doesn't require running a separate database server.
18. As a developer, I want analysis results pushed to the browser as they're produced (rather than the frontend polling on an interval), so that the "real-time" framing of this feature is actually accurate.
19. As a developer, I want the vehicle classification and color-estimation logic isolated in their own modules with injectable seams, so that class-mapping edge cases (e.g. no dedicated "tram" class in the underlying model) and color-estimation logic can be unit tested in isolation.
20. As a developer, I want background analysis to skip cameras whose `status` is `inactive`, so that we don't waste CPU/ffmpeg processes on streams that are already known to be down.
21. As a maintainer, I want the model file bundled directly in the repository/image rather than downloaded at runtime, so that the feature isn't affected by network/proxy issues in restricted environments and works the same in every deployment.

## Implementation Decisions

- **Detection technology (superseded, see below)**: originally a local ONNX object-detection model (YOLOv8n, pretrained on COCO) run in-process via an ONNX Runtime Node binding, classifying vehicles by type. Replaced by motion detection: on this camera fleet vehicles are small, oblique, motion-blurred and heavily compressed, and appearance-based classification degraded worst on precisely the vehicles that were moving, while parked/stationary ones classified fine. A `MotionDetector` module instead finds moving objects via background subtraction (a slowly-adapting per-pixel running average — the same technique `OccupancyEstimator` already used for the traffic-level badge, see below) followed by connected-component blob extraction: every surviving blob is surfaced as one generic `'vehicle'` detection, with no type classification. This is resolution-independent in a way appearance classification isn't, at the cost of no longer being able to say what a moving object is, only that it's there and moving (or recently stopped — see below). No separate Python process, no cloud vision API, no model weights to bundle.
- **Vehicle classes surfaced**: a single generic `'vehicle'` class plus a total count — see `VehicleClass` in `src/types/analysis.ts`. Per-class breakdown (car/bus/truck/tram/motorcycle) was removed along with the classifier that produced it.
- **Stopped vehicles**: a vehicle stopped at a light or sitting in a jam is intentionally still counted for a while after it stops moving, rather than disappearing the instant it's stationary — `MotionDetector` adapts its background estimate for currently-foreground pixels far more slowly than for empty ones (`foregroundLearningRate`), so a brief stop doesn't immediately read as "now part of the scene." A vehicle that stays put far longer than that (i.e. actually parked) eventually does fade out of the count, at the same slow rate — this is deliberately a soft, tunable threshold, not a fixed dwell time.
- **Frame capture**: a new `FrameGrabber` module invokes ffmpeg (a new `@ffmpeg-installer/ffmpeg`-style bundled binary, following the same installer pattern already used for `@ffprobe-installer/ffprobe`) against a camera's stream URL (reusing the existing header/proxy handling used for cameras that need special request headers) and returns a single decoded frame as an image buffer. The actual process-spawning/IO is behind an injectable seam so tests don't spawn a real ffmpeg process.
- **Detection module**: `MotionDetector` wraps the background-subtraction/blob-extraction logic behind a narrow interface (`detect(frameBuffer) -> detections[]`), where each detection has a class (always `'vehicle'`), a best-effort confidence derived from the blob's shape, and a bounding box. The underlying pixel-extraction call (`LumaExtractor`) is an injectable seam so tests can supply synthetic pixel data without decoding a real image. Unlike the original classifier, an instance is stateful and scoped to one camera — its background model describes a single fixed viewpoint, so `TrafficAnalysisService` creates one per camera via a factory rather than sharing a single instance.
- **Color estimation**: a new `VehicleColorEstimator` module takes a frame buffer plus a bounding box and returns a best-effort dominant color for that cropped region. Kept separate from the detector so it can be tested independently of detection logic.
- **Orchestration**: a new `TrafficAnalysisService` is the central coordinator and the main piece of new business logic:
  - Runs a background tick for every camera whose registry `status` is `active`, on a fixed low-frequency interval (on the order of every 10 seconds per camera).
  - Tracks "detail view" subscriptions per camera id; while a camera has at least one active subscription, that camera's effective sampling rate is boosted (on the order of a few frames per second) for as long as the subscription lasts, and drops back to the background rate once the last subscriber disconnects.
  - Runs detection work through a small, fixed-size concurrency pool with the remaining work queued, so total concurrent detection across all cameras stays bounded regardless of how many cameras exist.
  - For each tick: grab a frame → detect moving vehicles → estimate colors for detected vehicles → derive a traffic-level badge (Light/Moderate/Heavy) from roadway occupancy, falling back to the total count while occupancy is still warming up (exact numbers are an implementation detail, not fixed by this PRD) → persist the result → publish it to any live subscribers for that camera (and to the dashboard-wide feed).
  - `FrameGrabber`, the per-camera detector factory, `TrafficHistoryStore`, and the clock/scheduler are all injectable, so the orchestration logic (scheduling, rate boosting, concurrency capping, traffic-level derivation) can be tested without real frame capture or detection.
- **Persistence**: a new `TrafficHistoryStore` module backed by a local SQLite database file (e.g. via `better-sqlite3`), consistent with the project's existing "no separate database server" approach for `data/cameras/belgrade.json`. Every analysis result is stored (camera id, timestamp, total count, traffic level) and retained indefinitely — no automatic pruning in this PRD.
- **Live delivery to the frontend**: results are pushed via Server-Sent Events rather than polled. A per-camera SSE endpoint delivers that camera's live detections/counts (and its connection lifecycle is what drives the sampling-rate boost/reset described above); a dashboard-wide SSE endpoint delivers the lighter background-rate overview (count + traffic-level badge) for all cameras at once.
- **API additions** (thin wiring over `TrafficAnalysisService`/`TrafficHistoryStore`, no new business logic in the route layer):
  - `GET /api/analysis/latest` — latest known snapshot (count, traffic level) for every camera, used to bootstrap the dashboard before its SSE connection delivers the first live update.
  - `GET /api/analysis/stream` — dashboard-wide SSE stream of overview updates.
  - `GET /api/cameras/:id/analysis/stream` — per-camera SSE stream of full detection results (count, colors, bounding boxes); opening this connection is the signal that boosts that camera's sampling rate, closing it reverts to the background rate.
  - `GET /api/cameras/:id/analysis/history` — recent persisted history for a single camera, used to render the detail page's trend view.
- **Frontend changes**:
  - `AnalysisPanel.vue` is rebuilt to show the live total count, per-vehicle color chips, a short trend view sourced from the history endpoint, and clear "warming up" / "unavailable" states, replacing the current static placeholder. (Originally also showed a per-class breakdown; removed along with type classification.)
  - `StreamPlayer.vue` gains a canvas overlay, absolutely positioned on top of the `<video>` element and scaled to its displayed size, drawing the bounding boxes from the latest per-camera SSE message. This overlay is expected to lag the live video slightly (frame-grab + inference time) — that's an accepted tradeoff, not a bug.
  - `CameraCard.vue` gains the current total count and a Light/Moderate/Heavy badge, sourced from the dashboard-wide bootstrap call plus SSE updates. Dashboard cards do not show bounding-box overlays — that stays specific to the camera detail page.
  - A new small frontend service module wraps the SSE subscriptions and the REST bootstrap/history calls, used by both the dashboard and detail views.
- **Skipping inactive cameras**: the background tick loop only schedules cameras whose registry `status` is `active`; a camera's detail page for an inactive camera shows the existing "camera inactive" messaging instead of attempting analysis.

## Testing Decisions

- Good tests here exercise observable behavior through each module's public interface (e.g. "given these injected detections, does the service pick the right traffic-level badge"), not internal implementation details of ffmpeg invocation or the background-subtraction math.
- **Modules tested**:
  - `FrameGrabber` — inject a fake process-runner/IO seam; assert it builds the right invocation for a camera's stream (including header/proxy handling) and correctly surfaces failures without spawning a real ffmpeg process.
  - `MotionDetector` — inject a fake `LumaExtractor` returning synthetic pixel data (no real image decoding); assert warmup suppression, that a moving object is boxed roughly where it is, that noise below the minimum blob area and frame-wide brightness shifts above the maximum are ignored, that perpetually-active pixels (foliage/water) are excluded, and that a stopped vehicle keeps being reported for a while before eventually fading out.
  - `TrafficAnalysisService` — inject fake `FrameGrabber`, a per-camera detector factory, `TrafficHistoryStore`, and a controllable clock/scheduler; assert background-tick scheduling per active camera, that inactive cameras are skipped, that a detail subscription boosts and then correctly reverts the sampling rate, that concurrent detection is capped/queued as expected, that one detector instance is created per camera rather than shared, and that the correct traffic-level badge is derived from a given total count/occupancy.
  - `TrafficHistoryStore` — tested against a real in-memory (`:memory:`) SQLite database rather than mocked, asserting that recorded results can be queried back correctly (latest-per-camera, and history-since-a-timestamp).
- **Not tested in this PRD**: `VehicleColorEstimator` (best-effort, cosmetic, low-risk logic), the new Express route layer (thin wiring, consistent with the existing camera routes), and all frontend Vue components (`AnalysisPanel`, `StreamPlayer`'s overlay, `CameraCard`'s badge) — matching this project's existing precedent of leaving frontend components untested.
- **Framework**: Jest (`ts-jest`), tests colocated as `*.test.ts` next to the module under test.
- **Prior art**: `src/validator/cameraValidator.test.ts` (inject a fake for the single external dependency) and `src/server/hlsProxyService.test.ts` (inject a fake `ResourceFetcher` instead of making real network calls) are the direct patterns to follow for `FrameGrabber` and `MotionDetector`'s injectable seams.

## Out of Scope

- Any cloud/external vision API integration — detection is local-only in this PRD.
- A separate Python/microservice detection process — detection runs in-process in the existing Node server.
- Automatic pruning/retention limits on historical data — history is kept indefinitely for now.
- Exact numeric thresholds for the Light/Moderate/Heavy traffic-level badge — left as a tunable internal default, not specified by this PRD.
- Any authentication/authorization around the new analysis endpoints (matches the existing app's trusted/local-context assumption).
- Vehicle tracking/re-identification across frames (e.g. avoiding double-counting the same vehicle across ticks, speed estimation) — each tick's count is an independent snapshot, not a deduplicated running total.
- Bounding-box overlays on the dashboard's small preview videos — overlays are detail-page only.
- Editing/exporting historical data from the UI — the history endpoint is read-only, for display purposes only.
- Long-term historical analytics/reporting features (e.g. daily/weekly aggregate reports, CSV export) beyond the short trend view on the detail page.
- Automated tests for `VehicleColorEstimator`, the new Express route layer, and any frontend component.

## Further Notes

- This PRD builds directly on the existing camera dashboard app (`docs/prd/camera-dashboard-web-app.md`), replacing its `AnalysisPanel` placeholder and extending its dashboard cards, without changing the existing camera registry, validator, or CLI.
- **Superseded**: detection originally used a bundled YOLOv8n ONNX model classifying vehicles by type (car/bus/truck/tram/motorcycle), with COCO's `train` class mapped to `'tram'` as a stand-in for Belgrade's tram network. This was replaced by motion detection (see Implementation Decisions) because appearance-based classification degraded worst on precisely the moving vehicles this feature exists to count, while a difference-from-background signal doesn't depend on resolution or motion blur. The tradeoff is that vehicle type is no longer known at all - every moving object is now one generic `'vehicle'` class. "no network dependency at runtime" remains true either way - motion detection has even less of a footprint, since there's no model file to bundle.
