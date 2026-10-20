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

const REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');
// Runtime-generated - not committed (see .gitignore) - recreated on first boot.
const TRAFFIC_HISTORY_DB_PATH = path.resolve(__dirname, '../../data/traffic-history.db');
const TRAFFIC_STATS_DB_PATH = path.resolve(__dirname, '../../data/traffic-stats.db');
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
const revalidationService = new RevalidationService(store, new CameraValidator());
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
const trafficAnalysisService = new TrafficAnalysisService(
  store,
  new FrameGrabber({ streamFps: ANALYSIS_FPS }),
  new TrafficHistoryStore(TRAFFIC_HISTORY_DB_PATH),
  { onResult: (result) => trafficStatsService.handleResult(result) },
);
const app = createApp(
  cameraService,
  revalidationService,
  hlsProxyService,
  trafficAnalysisService,
  trafficStatsService,
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

