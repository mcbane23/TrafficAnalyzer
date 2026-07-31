import express, { Express, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CameraService } from './cameraService';
import { RevalidationService } from './revalidationService';
import { HlsProxyService } from './hlsProxyService';
import { TrafficAnalysisService } from '../analysis/trafficAnalysisService';

/**
 * Creates the Express app: read-only camera API routes, a background
 * revalidation trigger/status pair (the only mutating endpoints - they
 * don't accept a request body, they just kick off / report on the same
 * check the `cameras:revalidate` CLI performs), an HLS proxy route for
 * cameras that need special request headers the browser can't send
 * itself, the vehicle-traffic-analysis routes (bootstrap + SSE streams +
 * history, all thin wiring over `TrafficAnalysisService`), plus (when a
 * built frontend is present) static file serving and an SPA fallback so
 * Vue Router's history-mode routes work on a hard refresh/direct link.
 *
 * This module is intentionally thin wiring around `CameraService`,
 * `RevalidationService`, `HlsProxyService`, and `TrafficAnalysisService` -
 * it has no logic worth unit testing beyond what's already covered there.
 */
export function createApp(
  cameraService: CameraService,
  revalidationService: RevalidationService,
  hlsProxyService: HlsProxyService,
  trafficAnalysisService: TrafficAnalysisService,
  staticDir?: string,
): Express {
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

  app.post('/api/cameras/revalidate', (_req, res) => {
    const { started, status } = revalidationService.start();
    res.status(started ? 202 : 409).json(status);
  });

  app.get('/api/cameras/revalidate/status', (_req, res) => {
    res.json(revalidationService.getStatus());
  });

  app.get('/api/cameras/:id/stream/:file', async (req, res) => {
    try {
      const result = await hlsProxyService.fetchResource(req.params.id, req.params.file);
      if (!result) {
        res.status(404).json({ error: `No proxied stream for camera: ${req.params.id}` });
        return;
      }
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
      }
      res.status(result.status).send(result.body);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch upstream stream' });
    }
  });

  app.get('/api/cameras/:id/stream-alt/:file', async (req, res) => {
    try {
      const result = await hlsProxyService.fetchResource(req.params.id, req.params.file, 'alternate');
      if (!result) {
        res.status(404).json({ error: `No proxied alternate stream for camera: ${req.params.id}` });
        return;
      }
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
      }
      res.status(result.status).send(result.body);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch upstream alternate stream' });
    }
  });

  // Bootstrap snapshot for the dashboard, so cards have a count/badge to show before their SSE connection delivers the first live update.
  app.get('/api/analysis/latest', (_req, res) => {
    res.json(trafficAnalysisService.getLatestOverview());
  });

  // Dashboard-wide SSE stream: lightweight count + traffic-level overview for every analyzed camera.
  app.get('/api/analysis/stream', (req, res) => {
    startSse(res);
    const unsubscribe = trafficAnalysisService.subscribeOverview((overview) => writeSseEvent(res, overview));
    req.on('close', unsubscribe);
  });

  // Per-camera SSE stream: full detection results (counts, per-class breakdown, colors, boxes). Opening this
  // connection is what boosts that camera's sampling rate - see TrafficAnalysisService.subscribeCameraDetail.
  app.get('/api/cameras/:id/analysis/stream', (req, res) => {
    startSse(res);
    const unsubscribe = trafficAnalysisService.subscribeCameraDetail(req.params.id, (result) => writeSseEvent(res, result));
    req.on('close', unsubscribe);
  });

  app.get('/api/cameras/:id/analysis/history', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    res.json(trafficAnalysisService.getHistory(req.params.id, { limit, sinceIso }));
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

/** Sends the headers that open a Server-Sent Events connection and flushes them immediately. */
function startSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

/** Writes a single SSE event carrying a JSON payload. */
function writeSseEvent(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
