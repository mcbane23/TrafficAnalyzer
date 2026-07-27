import express, { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CameraService } from './cameraService';

/**
 * Creates the Express app: two read-only camera API routes, plus (when a
 * built frontend is present) static file serving and an SPA fallback so
 * Vue Router's history-mode routes work on a hard refresh/direct link.
 *
 * This module is intentionally thin wiring around `CameraService` -
 * it has no logic worth unit testing beyond what's already covered there.
 */
export function createApp(cameraService: CameraService, staticDir?: string): Express {
  const app = express();

  app.get('/api/cameras', async (_req, res) => {
    try {
      const cameras = await cameraService.listCameras();
      res.json(cameras);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load cameras' });
    }
  });

  app.get('/api/cameras/:id', async (req, res) => {
    try {
      const camera = await cameraService.getCameraById(req.params.id);
      if (!camera) {
        res.status(404).json({ error: `Camera not found: ${req.params.id}` });
        return;
      }
      res.json(camera);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load camera' });
    }
  });

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // SPA fallback for Vue Router history mode - use middleware (not a route
    // pattern) so it works across Express versions regardless of their
    // wildcard-route syntax.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app;
}
