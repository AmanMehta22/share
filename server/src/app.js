import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Express application: health checks plus optional static hosting of the built
 * frontend so a single free host can run both halves of CodeShare.
 *
 * This server never accepts file uploads. There is no route that can receive
 * file bytes - by design.
 */
export function createApp({ config, store, clientDist } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config?.trustProxy ? 1 : 0);

  // Minimal security headers (no extra dependency needed).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      sessions: store ? store.size : 0,
      env: config?.nodeEnv ?? 'unknown',
    });
  });

  const dist = clientDist ?? fileURLToPath(new URL('../../client/dist', import.meta.url));
  const indexFile = join(dist, 'index.html');

  if (config?.serveClient && existsSync(indexFile)) {
    app.use(express.static(dist, { index: false, maxAge: config.isProduction ? '1h' : 0, fallthrough: true }));
    // SPA fallback for any non-API GET request.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
      res.sendFile(indexFile, (err) => {
        if (err) next();
      });
    });
  }

  // Anything else that is not the signaling endpoint.
  app.use((req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message:
        'This is the CodeShare signaling server. The frontend is served separately during development (Vite on port 5173).',
    });
  });

  // Express 5 uses async error propagation; keep an explicit safety net.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
  });

  return app;
}
