import express, { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CameraService } from './cameraService';
import { RevalidationService } from './revalidationService';
import { HlsProxyService } from './hlsProxyService';
import { SseChannel } from './sseChannel';
import { TrafficAnalysisService } from '../analysis/trafficAnalysisService';
import { LiveOverlayService } from '../analysis/liveOverlayService';
import { StatsQueryError, TrafficStatsService, parseBucket, parseRange } from '../analysis/trafficStatsService';

/**
 * Creates the Express app: read-only camera API routes, a background
 * revalidation trigger/status pair (the only mutating endpoints - they
 * don't accept a request body, they just kick off / report on the same
 * check the `cameras:revalidate` CLI performs), an HLS proxy route for
 * cameras that need special request headers the browser can't send
 * itself, the vehicle-traffic-analysis routes (bootstrap + SSE streams +
 * history), plus (when a built frontend is present) static file serving
 * and an SPA fallback so Vue Router's history-mode routes work on a hard
 * refresh/direct link.
 *
 * This module is thin wiring around `CameraService`, `RevalidationService`,
 * `HlsProxyService`, `SseChannel`, `TrafficAnalysisService` and
 * `TrafficStatsService` - it has no
 * logic worth unit testing beyond what's already covered there. Keeping it
 * that way is why `SseChannel` exists: everything it takes to hold a live
 * stream open used to sit in this file, exempted from tests by that same
 * rule.
 */
export function createApp(
  cameraService: CameraService,
  revalidationService: RevalidationService,
  hlsProxyService: HlsProxyService,
  trafficAnalysisService: TrafficAnalysisService,
  trafficStatsService: TrafficStatsService,
  liveOverlayService: LiveOverlayService | null,
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
    let unsubscribe = () => undefined as void;
    const channel = SseChannel.open(req, res, () => unsubscribe());
    unsubscribe = trafficAnalysisService.subscribeOverview((overview) => channel.send(overview));
  });

  // Per-camera SSE stream: every analyzed frame's full result (count, occupancy, tracked boxes). Every active
  // camera is analyzed continuously regardless - this only listens (see TrafficAnalysisService).
  app.get('/api/cameras/:id/analysis/stream', (req, res) => {
    let unsubscribe = () => undefined as void;
    const channel = SseChannel.open(req, res, () => unsubscribe());
    unsubscribe = trafficAnalysisService.subscribeCameraDetail(req.params.id, (result) => channel.send(result));
  });

  // Vehicle boxes for a watched camera from the appearance model, each tagged with its stream time. 404 when the
  // overlay detector is switched off - the player then draws the motion-analysis boxes instead.
  app.get('/api/cameras/:id/overlay/stream', (req, res) => {
    if (!liveOverlayService) {
      res.status(404).json({ error: 'Overlay detector is switched off.' });
      return;
    }
    let unsubscribe = () => undefined as void;
    const channel = SseChannel.open(req, res, () => unsubscribe());
    unsubscribe = liveOverlayService.subscribe(req.params.id, (result) => channel.send(result));
  });

  // The last ~45s of per-frame results, so a just-opened player has boxes for the (older) picture it is about to show.
  app.get('/api/cameras/:id/analysis/recent', (req, res) => {
    res.json(trafficAnalysisService.getRecentResults(req.params.id));
  });

  app.get('/api/cameras/:id/analysis/history', (req, res) => {
    // Passed through as-is: coercing and bounding the limit is
    // `TrafficHistoryStore.normalizeLimit`'s job, and it has to do it anyway
    // for any other caller.
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    res.json(trafficAnalysisService.getHistory(req.params.id, { limit, sinceIso }));
  });

  // Latest analyzed frame as a still thumbnail, so the dashboard doesn't need a live video per card.
  app.get('/api/cameras/:id/snapshot.jpg', (req, res) => {
    const frame = trafficAnalysisService.getLatestFrame(req.params.id);
    if (!frame) {
      res.status(404).json({ error: 'No frame captured yet for this camera.' });
      return;
    }
    res.set('Cache-Control', 'no-store').set('X-Captured-At', frame.capturedAt).type('image/jpeg').send(frame.buffer);
  });

  // Traffic statistics (vehicle passages per bucket, by direction and size class). Parameter validation is
  // TrafficStatsService's job; a StatsQueryError becomes a 400.
  type StatsHandler = (req: express.Request<{ id: string }>, res: express.Response) => void;
  const statsRoute = (handler: StatsHandler): StatsHandler => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      if (err instanceof StatsQueryError) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute statistics' });
    }
  };

  app.get('/api/stats/summary', statsRoute((req, res) => {
    res.json(trafficStatsService.getSummary(parseRange(req.query.range)));
  }));

  app.get('/api/cameras/:id/stats', statsRoute((req, res) => {
    const range = parseRange(req.query.range);
    res.json(trafficStatsService.getCameraStats(req.params.id, range, parseBucket(range, req.query.bucket)));
  }));

  app.get('/api/cameras/:id/stats.csv', statsRoute((req, res) => {
    const range = parseRange(req.query.range);
    const stats = trafficStatsService.getCameraStats(req.params.id, range, parseBucket(range, req.query.bucket));
    res
      .type('text/csv')
      .attachment(`${req.params.id}-${range}-${stats.bucket}.csv`)
      .send(trafficStatsService.toCsv(stats));
  }));

  app.get('/api/cameras/:id/stats/heatmap', statsRoute((req, res) => {
    const days = req.query.days === undefined ? undefined : Number(req.query.days);
    res.json(trafficStatsService.getHeatmap(req.params.id, days));
  }));

  app.get('/api/cameras/:id/stats/live', statsRoute((req, res) => {
    res.json(trafficStatsService.getLiveCounts(req.params.id));
  }));

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

