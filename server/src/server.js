import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { resolveConfig, ConfigError } from './config/env.js';
import { createApp } from './app.js';
import { SessionStore } from './services/sessionStore.js';
import { attachSignaling } from './services/signaling.js';
import { createLogger } from './utils/logger.js';

/**
 * Build the HTTP + Socket.IO signaling server without listening.
 * Exported so tests can start it on an ephemeral port.
 */
export function createNodeServer({ config, logger = createLogger({ level: 'warn' }) }) {
  const store = new SessionStore({
    ttlMs: config.sessionTtlMs,
    maxJoinAttempts: config.maxJoinAttempts,
    maxSessionsPerIp: config.maxSessionsPerIp,
  });

  const app = createApp({ config, store });
  const httpServer = createServer(app);

  const io = new SocketServer(httpServer, {
    // Strict CORS: only the origins listed in CLIENT_ORIGIN may open a socket.
    cors: {
      origin: config.clientOrigins.includes('*') ? true : config.clientOrigins,
      methods: ['GET', 'POST'],
      credentials: false,
    },
    // Signaling messages are tiny (SDP/ICE). A 64 KiB cap rejects oversized or
    // hostile payloads at the transport layer. File bytes never travel here.
    maxHttpBufferSize: 64 * 1024,
    // Do not serve the Socket.IO client bundle from this server.
    serveClient: false,
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  attachSignaling(io, { store, config, logger });
  store.startSweeper();

  const close = async () => {
    store.stopSweeper();
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
  };

  return { app, httpServer, io, store, close };
}

/** Boot the server, bind the port, install signal handlers. */
export async function startServer({ env = process.env, cwd = process.cwd() } = {}) {
  let config;
  try {
    config = resolveConfig(env, { cwd });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[codeshare] Configuration error: ${error.message}`);
      console.error('[codeshare] Fix server/.env (see server/.env.example) and try again.\n');
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.isProduction ? 'info' : 'debug', scope: 'codeshare' });
  const { httpServer, store, close } = createNodeServer({ config, logger });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, () => resolve());
  });

  logger.info('signaling server listening', {
    port: config.port,
    origins: config.clientOrigins.join(','),
    sessionTtlMinutes: Math.round(config.sessionTtlMs / 60_000),
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { httpServer, store, close, config };
}

// Run only when executed directly (`node src/server.js`), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startServer().catch((error) => {
    console.error('[codeshare] Failed to start:', error && error.message ? error.message : error);
    process.exit(1);
  });
}
