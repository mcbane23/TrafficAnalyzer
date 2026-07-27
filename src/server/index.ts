#!/usr/bin/env node
import path from 'node:path';
import { CameraRegistryStore } from '../registry/cameraRegistryStore';
import { CameraService } from './cameraService';
import { createApp } from './app';

const REGISTRY_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.json');
const SCHEMA_PATH = path.resolve(__dirname, '../../data/cameras/belgrade.schema.json');
// Matches src/web's Vite `build.outDir` (dist/web), relative to this file's
// own compiled location (dist/server).
const STATIC_DIR = path.resolve(__dirname, '../web');
const PORT = Number(process.env.PORT) || 3001;

const store = new CameraRegistryStore(REGISTRY_PATH, SCHEMA_PATH);
const cameraService = new CameraService(store);
const app = createApp(cameraService, STATIC_DIR);

app.listen(PORT, () => {
  console.log(`TrafficAnalyzer server listening on http://localhost:${PORT}`);
});
