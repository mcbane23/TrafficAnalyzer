#!/usr/bin/env node
import path from 'node:path';
import { CameraRegistryStore } from '../registry/cameraRegistryStore';
import { CameraValidator } from '../validator/cameraValidator';
import { CameraService } from './cameraService';
import { RevalidationService } from './revalidationService';
import { HlsProxyService } from './hlsProxyService';
import { createApp } from './app';
import { FrameGrabber } from '../analysis/frameGrabber';
import { TrafficHistoryStore } from '../analysis/trafficHistoryStore';
import { TrafficAnalysisService } from '../analysis/trafficAnalysisService';
import { TrafficStatsStore } from '../analysis/trafficStatsStore';
import { TrafficStatsService } from '../analysis/trafficStatsService';
import { LiveOverlayService } from '../analysis/liveOverlayService';
import { AnalysisWorkerPool } from '../analysis/analysisWorkerPool';
import { YoloDetector, YoloModel, loadYoloModel } from '../analysis/yoloDetector';
import { VehicleTracker } from '../analysis/vehicleTracker';
import { ServerMetricsService } from './serverMetrics';

const REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');
// Runtime-generated - not committed (see .gitignore) - recreated on first boot.
const TRAFFIC_HISTORY_DB_PATH = path.resolve(__dirname, '../../data/traffic-history.db');
const TRAFFIC_STATS_DB_PATH = path.resolve(__dirname, '../../data/traffic-stats.db');
const DATA_DIR = path.resolve(__dirname, '../../data');
// Runtime-generated as well: OpenVINO's compiled GPU kernels for the overlay model.
const OPENVINO_CACHE_DIR = path.resolve(__dirname, '../../data/openvino-cache');
// Resolved from the working directory, not `__dirname` like the paths above:
// `__dirname` is src/server under `tsx watch` (uncompiled) but dist/server
// once built, so a `__dirname`-relative `../web` would land on src/web (raw
// TS/Vue source, wrongly served with .ts's default Content-Type of
// video/mp2t) instead of dist/web whenever the server runs uncompiled.
// `process.cwd()` is the project root either way (npm scripts and Docker's
// WORKDIR both run from there), so this always means dist/web - and in dev
// mode, before a build exists, `fs.existsSync` below correctly finds nothing
// and leaves the frontend to Vite's own dev server on :5173.
const STATIC_DIR = path.resolve(process.cwd(), 'dist/web');
const PORT = Number(process.env.PORT) || 3001;

const store = new CameraRegistryStore(REGISTRY_PATH, SCHEMA_PATH);
const cameraService = new CameraService(store);
const hlsProxyService = new HlsProxyService(store);
// One CameraAnalyzer per camera is built internally - it owns that camera's
// detector, tracker and occupancy model, all of which describe a single fixed
// viewpoint (see CameraAnalyzer's docstring).
// Every active camera is analyzed continuously at ANALYSIS_FPS (default 3);
// lower it if the host can't keep up with the whole fleet.
const ANALYSIS_FPS = Number(process.env.ANALYSIS_FPS) || undefined;
// Vehicle passages and analysis coverage for the statistics views, fed from
// every usable analysis result. STATS_TIMEZONE sets what "today" and the
// hour-of-day heatmap mean (the container itself usually runs in UTC).
const trafficStatsService = new TrafficStatsService(new TrafficStatsStore(TRAFFIC_STATS_DB_PATH), {
  timeZone: process.env.STATS_TIMEZONE || undefined,
});
// The fleet's motion analysis runs on ANALYSIS_THREADS worker threads
// (default 2), keeping the main thread free for captures, the live overlay
// and HTTP - see AnalysisWorkerPool. ANALYSIS_THREADS=0 runs it on the main
// thread as before.
const analysisThreads = process.env.ANALYSIS_THREADS === undefined ? 2 : Number(process.env.ANALYSIS_THREADS) || 0;
const analysisWorkers = analysisThreads > 0 ? new AnalysisWorkerPool({ size: analysisThreads }) : null;
// Each analyzed camera keeps one ffmpeg capture running (~17 MB and a share
// of a core). On a smaller host: ANALYSIS_ENABLED=false analyzes nothing (no
// statistics, badges or thumbnails; the live view and its YOLO boxes still
// work), ANALYSIS_CAMERAS=id1,id2 analyzes only those cameras, and
// ANALYSIS_MAX_CAMERAS=N at most N of them, in registry order.
const analysisEnabled = !/^(false|0|off|no)$/i.test(process.env.ANALYSIS_ENABLED?.trim() ?? '');
const analysisCameraIds = process.env.ANALYSIS_CAMERAS?.split(',').map((id) => id.trim()).filter(Boolean);
const analysisMaxCameras = process.env.ANALYSIS_MAX_CAMERAS?.trim() ? Number(process.env.ANALYSIS_MAX_CAMERAS) : undefined;
const trafficAnalysisService = new TrafficAnalysisService(
  store,
  new FrameGrabber({ streamFps: ANALYSIS_FPS }),
  new TrafficHistoryStore(TRAFFIC_HISTORY_DB_PATH),
  {
    enabled: analysisEnabled,
    cameraIds: analysisCameraIds,
    maxCameras: analysisMaxCameras !== undefined && Number.isInteger(analysisMaxCameras) ? analysisMaxCameras : undefined,
    onResult: (result) => trafficStatsService.handleResult(result),
    ...(analysisWorkers ? { createAnalyzer: (cameraId, camera) => analysisWorkers.createAnalyzer(cameraId, camera) } : {}),
  },
);
// Boxes over the camera someone is watching come from an appearance model
// (YOLO), run only while that camera has viewers - see LiveOverlayService.
// OVERLAY_DETECTOR=off falls back to drawing the motion-detection boxes;
// OVERLAY_FPS (default 3) and OVERLAY_THREADS (default 2) trade smoothness
// against CPU. OVERLAY_DEVICE=GPU runs a larger model on an Intel GPU
// through OpenVINO (the container needs /dev/dri), falling back to the CPU
// model if the GPU can't be used. OVERLAY_MODEL picks the GPU model:
// yolo26s (default), yolo26n (faster, finds fewer distant cars) or yolo26m
// (larger and ~3x slower). OVERLAY_CPU_MODEL picks the CPU one: yolo26n.
const overlayDevice = process.env.OVERLAY_DEVICE?.trim().toUpperCase() || 'CPU';
// OVERLAY_CONFIDENCE (default 0.2): the YOLO score a box needs to be drawn.
const overlayConfidence = Number(process.env.OVERLAY_CONFIDENCE) || undefined;
let overlayModel: Promise<YoloModel> | null = null;
let overlayModelLabel: string | null = null;
const loadOverlayModel = (): Promise<YoloModel> =>
  (overlayModel ??= loadYoloModel({
    device: overlayDevice,
    model: process.env.OVERLAY_MODEL,
    cpuModel: process.env.OVERLAY_CPU_MODEL,
    threads: Number(process.env.OVERLAY_THREADS) || 2,
    cacheDir: OPENVINO_CACHE_DIR,
  }).then((model) => {
    console.log(`[LiveOverlayService] detector: ${model.label}`);
    overlayModelLabel = model.label;
    return model;
  }));
const liveOverlayService =
  process.env.OVERLAY_DETECTOR === 'off'
    ? null
    : new LiveOverlayService(
        store,
        // One queued frame: when the detector is slower than the capture (a
        // busy host), it always takes the newest frame and skips the rest.
        // Working through a backlog instead puts it further behind every
        // second, until the player overtakes it and has no boxes to draw.
        new FrameGrabber({
          streamFps: Number(process.env.OVERLAY_FPS) || undefined,
          // The GPU model's 960px input is fed a matching frame (the streams
          // are 704x576, so this upscales; small cars get more pixels).
          frameWidth: overlayDevice === 'CPU' ? 640 : 960,
          frameHeight: overlayDevice === 'CPU' ? 480 : 720,
          maxQueuedFrames: 1,
        }),
        (camera) => ({
          detector: new YoloDetector(loadOverlayModel, {
            ignoreZones: camera.ignoreZones?.map((zone) => zone.points),
            minConfidence: overlayConfidence,
          }),
          // Every vehicle the model sees is drawn, parked or queued ones
          // included (no travel gate, no confirmation delay, and any detection
          // may start a track - the default 0.5 ByteTrack threshold hid every
          // car YOLO scored 0.25-0.5, about half of them in a queue on Brankov
          // most), and a car the model misses on one frame keeps its box for a
          // second instead of blinking out. maxSpeed stops a track from jumping
          // to a different car when frames are a second apart on a slow host.
          tracker: new VehicleTracker({ minHits: 1, minTravel: 0, reportCoastingMs: 1000, maxSpeed: 2, highConfidence: 0 }),
        }),
      );
// The Admin page's availability check rewrites camera statuses; the analysis
// then starts and stops cameras to match, without a restart. (The
// `cameras:revalidate` CLI runs in its own process, so it still needs one.)
const revalidationService = new RevalidationService(store, new CameraValidator(), undefined, undefined, async () => {
  const { started, stopped } = await trafficAnalysisService.reload();
  if (started.length || stopped.length) {
    console.log(`[TrafficAnalysisService] after availability check: started ${started.join(', ') || 'none'}; stopped ${stopped.join(', ') || 'none'}`);
  }
});
// CPU, memory and pipeline throughput for the Admin page, sampled every 5 s.
const serverMetrics = new ServerMetricsService({
  analysis: trafficAnalysisService,
  overlay: liveOverlayService,
  config: {
    analysisFps: ANALYSIS_FPS ?? 3,
    analysisThreads,
    overlayDevice: process.env.OVERLAY_DETECTOR === 'off' ? 'off' : overlayDevice,
    overlayModel: () => overlayModelLabel,
  },
  dataDir: DATA_DIR,
  databases: [
    { name: 'Traffic history', path: TRAFFIC_HISTORY_DB_PATH },
    { name: 'Traffic statistics', path: TRAFFIC_STATS_DB_PATH },
  ],
});
serverMetrics.start();
const app = createApp(
  cameraService,
  revalidationService,
  hlsProxyService,
  trafficAnalysisService,
  trafficStatsService,
  liveOverlayService,
  serverMetrics,
  STATIC_DIR,
);

// Write each camera's in-progress coverage minute before exiting (e.g. on `docker stop`).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    trafficStatsService.flush();
    process.exit(0);
  });
}

trafficAnalysisService.start().catch((err) => {
  console.error('Failed to start traffic analysis service:', err);
});

app.listen(PORT, () => {
  console.log(`TrafficAnalyzer server listening on http://localhost:${PORT}`);
});

