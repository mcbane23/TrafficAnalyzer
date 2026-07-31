#!/usr/bin/env node
import path from 'node:path';
import { CameraRegistryStore } from '../registry/cameraRegistryStore';
import { CameraValidator } from '../validator/cameraValidator';
import { CameraService } from './cameraService';
import { RevalidationService } from './revalidationService';
import { HlsProxyService } from './hlsProxyService';
import { createApp } from './app';
import { FrameGrabber } from '../analysis/frameGrabber';
import { VehicleDetector } from '../analysis/vehicleDetector';
import { VehicleColorEstimator } from '../analysis/vehicleColorEstimator';
import { TrafficHistoryStore } from '../analysis/trafficHistoryStore';
import { TrafficAnalysisService } from '../analysis/trafficAnalysisService';

const REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');
// Runtime-generated - not committed (see .gitignore) - recreated on first boot.
const TRAFFIC_HISTORY_DB_PATH = path.resolve(__dirname, '../../data/traffic-history.db');
// Matches src/web's Vite `build.outDir` (dist/web), relative to this file's
// own compiled location (dist/server).
const STATIC_DIR = path.resolve(__dirname, '../web');
const PORT = Number(process.env.PORT) || 3001;

const store = new CameraRegistryStore(REGISTRY_PATH, SCHEMA_PATH);
const cameraService = new CameraService(store);
const revalidationService = new RevalidationService(store, new CameraValidator());
const hlsProxyService = new HlsProxyService(store);
const trafficAnalysisService = new TrafficAnalysisService(
  store,
  new FrameGrabber(),
  new VehicleDetector(),
  new VehicleColorEstimator(),
  new TrafficHistoryStore(TRAFFIC_HISTORY_DB_PATH),
);
const app = createApp(cameraService, revalidationService, hlsProxyService, trafficAnalysisService, STATIC_DIR);

trafficAnalysisService.start().catch((err) => {
  console.error('Failed to start traffic analysis service:', err);
});

app.listen(PORT, () => {
  console.log(`TrafficAnalyzer server listening on http://localhost:${PORT}`);
});

