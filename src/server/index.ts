#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CameraRegistryStore } from '../registry/cameraRegistryStore';
import { seedMissingFiles } from '../registry/seedRegistry';
import { CameraValidator } from '../validator/cameraValidator';
import { CameraService } from './cameraService';
import { RevalidationService } from './revalidationService';
import { HlsProxyService } from './hlsProxyService';
import { createApp } from './app';
import { FrameGrabber } from '../analysis/frameGrabber';
import { TrafficHistoryStore } from '../analysis/trafficHistoryStore';
import { TrafficAnalysisService } from '../analysis/trafficAnalysisService';
import { TrafficStatsStore } from '../analysis/trafficStatsStore';
import { DataRetentionService } from '../analysis/dataRetention';
import { TrafficStatsService } from '../analysis/trafficStatsService';
import { LiveOverlayService } from '../analysis/liveOverlayService';
import { FileThumbnailStore, StillThumbnailService } from '../analysis/stillThumbnailService';
import { AnalysisWorkerPool } from '../analysis/analysisWorkerPool';
import { DEFAULT_MIN_CONFIDENCE, DEFAULT_OPENVINO_MODEL, OPENVINO_MODELS, YoloDetector, YoloModel, loadYoloModel } from '../analysis/yoloDetector';
import { VehicleTracker } from '../analysis/vehicleTracker';
import { ServerMetricsService } from './serverMetrics';
import { AnalysisSettingsStore } from './analysisSettingsStore';
import { AdminSettingsService } from './adminSettingsService';
import { CameraEditor } from './cameraEditor';
import { ProcessingSettings } from '../types/admin';

const REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');
// Runtime-generated - not committed (see .gitignore) - recreated on first boot.
const TRAFFIC_HISTORY_DB_PATH = path.resolve(__dirname, '../../data/traffic-history.db');
const TRAFFIC_STATS_DB_PATH = path.resolve(__dirname, '../../data/traffic-stats.db');
const DATA_DIR = path.resolve(__dirname, '../../data');
const ANALYSIS_SETTINGS_PATH = path.join(DATA_DIR, 'analysis-settings.json');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
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

// The image keeps a copy of the camera registry outside data/, so an empty data
// mount (e.g. `./data`) gets the default registry instead of a server that
// can't start.
const REGISTRY_DEFAULTS_DIR = path.resolve(__dirname, '../../defaults/cameras');
const seeded = seedMissingFiles(REGISTRY_DEFAULTS_DIR, path.dirname(REGISTRY_PATH));
if (seeded.length) console.log(`[CameraRegistry] data/cameras was missing ${seeded.join(', ')}; copied the image's defaults`);

// The schema always comes from the image when it has one: a data volume keeps
// the copy it was first seeded with, which would reject fields added since.
const DEFAULT_SCHEMA_PATH = path.join(REGISTRY_DEFAULTS_DIR, 'belgrade.schema.json');
const store = new CameraRegistryStore(REGISTRY_PATH, fs.existsSync(DEFAULT_SCHEMA_PATH) ? DEFAULT_SCHEMA_PATH : SCHEMA_PATH);
const cameraService = new CameraService(store);
const hlsProxyService = new HlsProxyService(store);
// One CameraAnalyzer per camera is built internally - it owns that camera's
// detector, tracker and occupancy model, all of which describe a single fixed
// viewpoint (see CameraAnalyzer's docstring).
// Every camera switched on on the Admin page is analyzed continuously at the
// analysis frame rate set there (ANALYSIS_FPS is only its default, 3).
// Vehicle passages and analysis coverage for the statistics views, fed from
// every usable analysis result. STATS_TIMEZONE sets what "today" and the
// hour-of-day heatmap mean (the container itself usually runs in UTC).
const trafficStatsStore = new TrafficStatsStore(TRAFFIC_STATS_DB_PATH);
const trafficHistoryStore = new TrafficHistoryStore(TRAFFIC_HISTORY_DB_PATH);
const trafficStatsService = new TrafficStatsService(trafficStatsStore, {
  timeZone: process.env.STATS_TIMEZONE || undefined,
});
// The fleet's motion analysis runs on ANALYSIS_THREADS worker threads
// (default 2), keeping the main thread free for captures, the live overlay
// and HTTP - see AnalysisWorkerPool. ANALYSIS_THREADS=0 runs it on the main
// thread as before.
const analysisThreads = process.env.ANALYSIS_THREADS === undefined ? 2 : Number(process.env.ANALYSIS_THREADS) || 0;
const analysisWorkers = analysisThreads > 0 ? new AnalysisWorkerPool({ size: analysisThreads }) : null;
// The Admin page's settings, kept in the data volume: which cameras are
// analyzed (each keeps an ffmpeg capture running, ~17 MB and a share of a
// core, so none is until the user switches it on) and the processing knobs
// below. The env vars only set the knobs' defaults - see AdminSettingsService.
const overlayDevice = process.env.OVERLAY_DEVICE?.trim().toUpperCase() || 'CPU';
const overlayEnabled = process.env.OVERLAY_DETECTOR !== 'off';
const processingDefaults: ProcessingSettings = {
  analysisFps: Number(process.env.ANALYSIS_FPS) || 3,
  overlayFps: Number(process.env.OVERLAY_FPS) || 3,
  overlayModel: process.env.OVERLAY_MODEL && OPENVINO_MODELS[process.env.OVERLAY_MODEL] ? process.env.OVERLAY_MODEL : DEFAULT_OPENVINO_MODEL,
  overlayConfidence: Number(process.env.OVERLAY_CONFIDENCE) || DEFAULT_MIN_CONFIDENCE,
  // Individual passages; their hourly counts, which the statistics views read, are kept forever.
  passageRetentionDays: 30,
};
const analysisSettingsStore = new AnalysisSettingsStore(ANALYSIS_SETTINGS_PATH);
const initialSettings = analysisSettingsStore.load();
const analysisGrabber = new FrameGrabber({ streamFps: initialSettings.analysisFps ?? processingDefaults.analysisFps });
const trafficAnalysisService = new TrafficAnalysisService(
  store,
  analysisGrabber,
  trafficHistoryStore,
  {
    enabledCameras: initialSettings.enabledCameras,
    onResult: (result) => trafficStatsService.handleResult(result),
    ...(analysisWorkers ? { createAnalyzer: (cameraId, camera) => analysisWorkers.createAnalyzer(cameraId, camera) } : {}),
  },
);
// A dashboard thumbnail for every camera, analyzed or not: cameras left out
// of the analysis get a still from a one-off ffmpeg, one camera at a time,
// refreshed every 30 minutes - see StillThumbnailService.
const stillThumbnails = new StillThumbnailService(store, new FrameGrabber(), {
  liveFrame: (cameraId) => trafficAnalysisService.getLatestFrame(cameraId),
  store: new FileThumbnailStore(THUMBNAILS_DIR),
});
// Boxes over the camera someone is watching come from an appearance model
// (YOLO), run only while that camera has viewers - see LiveOverlayService.
// OVERLAY_DETECTOR=off falls back to drawing the motion-detection boxes;
// the overlay frame rate (OVERLAY_FPS, default 3) and OVERLAY_THREADS
// (default 2) trade smoothness against CPU. OVERLAY_DEVICE=GPU runs a larger
// model on an Intel GPU through OpenVINO (the container needs /dev/dri),
// falling back to the CPU model if the GPU can't be used. The GPU model is
// picked on the Admin page (OVERLAY_MODEL is its default): yolo26s, yolo26n
// (faster, finds fewer distant cars) or yolo26m (larger and ~3x slower).
// OVERLAY_CPU_MODEL picks the CPU one: yolo26n. The minimum score a box needs
// to be drawn is set there too (OVERLAY_CONFIDENCE, default 0.2).
let overlayModel: Promise<YoloModel> | null = null;
let overlayModelLabel: string | null = null;
const loadOverlayModel = (): Promise<YoloModel> =>
  (overlayModel ??= loadYoloModel({
    device: overlayDevice,
    model: adminSettings.effective().overlayModel,
    cpuModel: process.env.OVERLAY_CPU_MODEL,
    threads: Number(process.env.OVERLAY_THREADS) || 2,
    cacheDir: OPENVINO_CACHE_DIR,
  }).then((model) => {
    console.log(`[LiveOverlayService] detector: ${model.label}`);
    overlayModelLabel = model.label;
    return model;
  }));
const overlayGrabber = overlayEnabled
  ? // One queued frame: when the detector is slower than the capture (a
    // busy host), it always takes the newest frame and skips the rest.
    // Working through a backlog instead puts it further behind every
    // second, until the player overtakes it and has no boxes to draw.
    new FrameGrabber({
      streamFps: initialSettings.overlayFps ?? processingDefaults.overlayFps,
      // The GPU model's 960px input is fed a matching frame (the streams
      // are 704x576, so this upscales; small cars get more pixels).
      frameWidth: overlayDevice === 'CPU' ? 640 : 960,
      frameHeight: overlayDevice === 'CPU' ? 480 : 720,
      maxQueuedFrames: 1,
    })
  : null;
const liveOverlayService = !overlayGrabber
    ? null
    : new LiveOverlayService(
        store,
        overlayGrabber,
        (camera) => ({
          detector: new YoloDetector(loadOverlayModel, {
            ignoreZones: camera.ignoreZones?.map((zone) => zone.points),
            minConfidence: () => adminSettings.effective().overlayConfidence,
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
const adminSettings = new AdminSettingsService({
  store: analysisSettingsStore,
  defaults: processingDefaults,
  overlay: { enabled: overlayEnabled, device: overlayDevice, models: Object.keys(OPENVINO_MODELS) },
  listCameras: () => cameraService.listCameras(),
  analysis: trafficAnalysisService,
  analysisGrabber,
  overlayGrabber,
  // The next frame loads the new model; a model already loading finishes for nobody and is dropped.
  onOverlayModelChange: () => {
    overlayModel = null;
    overlayModelLabel = null;
  },
});
// The Admin page's availability check rewrites camera statuses; the analysis
// then starts and stops cameras to match, without a restart. (The
// `cameras:revalidate` CLI runs in its own process, so it still needs one.)
const cameraValidator = new CameraValidator();
const revalidationService = new RevalidationService(store, cameraValidator, undefined, undefined, async () => {
  const { started, stopped } = await trafficAnalysisService.reload();
  if (started.length || stopped.length) {
    console.log(`[TrafficAnalysisService] after availability check: started ${started.join(', ') || 'none'}; stopped ${stopped.join(', ') || 'none'}`);
  }
});
// The Admin page's camera editor. Each change is applied without a restart:
// hiding, showing or adding a camera brings the analyzed set in line, and new
// ignore zones rebuild that camera's analysis and live boxes.
const cameraEditor = new CameraEditor({
  store,
  validator: cameraValidator,
  isRevalidating: () => revalidationService.getStatus().state === 'running',
  onChanged: async (camera, change) => {
    if (change.zones) {
      await trafficAnalysisService.restartCamera(camera.id);
      liveOverlayService?.updateCamera(camera);
    }
    if (change.hidden || change.added) await trafficAnalysisService.reload();
    console.log(`[CameraEditor] ${change.added ? 'added' : 'edited'} camera "${camera.id}"`);
  },
});
// CPU, memory and pipeline throughput for the Admin page, sampled every 5 s.
const serverMetrics = new ServerMetricsService({
  analysis: trafficAnalysisService,
  overlay: liveOverlayService,
  config: {
    analysisFps: () => adminSettings.effective().analysisFps,
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
// Old rows out of both databases, hourly: history after 2 days, individual
// passages after the Admin page's retention (30 days by default).
const dataRetention = new DataRetentionService({
  history: trafficHistoryStore,
  passages: trafficStatsStore,
  historyDays: 2,
  passageDays: () => adminSettings.effective().passageRetentionDays,
});
dataRetention.start();
const app = createApp(
  cameraService,
  revalidationService,
  hlsProxyService,
  trafficAnalysisService,
  stillThumbnails,
  trafficStatsService,
  liveOverlayService,
  serverMetrics,
  adminSettings,
  cameraEditor,
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
stillThumbnails.start();

app.listen(PORT, () => {
  console.log(`TrafficAnalyzer server listening on http://localhost:${PORT}`);
});

