import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { env } from './lib/env.js';
import { connectDatabase, isDatabaseConnected} from './lib/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import {pinoHttp} from 'pino-http';
import { logger } from './lib/logger.js';
import { redis, checkRedisConnection } from './lib/redis.js';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes.js';
import cookieParser from 'cookie-parser';
import { initRealtime } from './modules/realtime/index.js';

const app = express();
const httpServer = createServer(app);
const port = Number(env.PORT || 4000);

// Trusts two proxies (Vercel edge -> Render load balancer). Without
// this, req.ip resolves to Vercel's own address for every request,
// which silently breaks every per-IP rate limiter (magic-link resend,
// login, public booking) since every caller looks like the same IP.
app.set('trust proxy', 2);

// helmet's default CSP assumes an API-only origin. When this process
// also serves the built SPA (architecture doc §14, below), the bundled
// JS/CSS are same-origin 'self' so the defaults still hold; only relax
// if a future build pulls in a cross-origin asset.
app.use(helmet());
app.use(pinoHttp({logger}));
app.use(express.json());
app.use(cookieParser());
// Same-origin deployment (architecture doc §14) means the browser never
// makes a cross-origin call in production, so CORS is only needed for
// the local two-process dev setup (Vite on :5173 → API on :4000).
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }),
);
app.use('/api', routes);

app.get('/health', (_req, res) => {
  const databaseConnected = isDatabaseConnected();

  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? 'ok' : 'degraded',
    database: databaseConnected ? 'connected' : 'disconnected',
  });
});

// ── Same-origin frontend serving (architecture doc §14) ────────────────
// One process serves both the `/api` routes above and the built SPA, so
// production is true same-origin: no CORS, no SameSite=None, no CSRF
// middleware needed. In local dev the frontend runs on its own Vite
// server and this block is simply skipped (no dist/ yet) — the dev proxy
// forwards /api/* instead.
//
// `import.meta.url` is apps/api/{dist,src}/server.{js,ts}; the web build
// output is apps/web/dist either way.
const frontendDist = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../web/dist',
);
const frontendBuilt = existsSync(path.join(frontendDist, 'index.html'));

if (frontendBuilt) {
  app.use(express.static(frontendDist));

  // SPA fallback: any non-/api, non-/health GET that didn't match a real
  // asset gets index.html so client-side routing survives a hard refresh
  // or a deep-linked URL.
  app.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api/') ||
      req.path === '/health'
    ) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  logger.info(`Serving built frontend from ${frontendDist}`);
} else {
  logger.warn(
    `No built frontend at ${frontendDist} — running API-only. ` +
      `Run \`npm run build\` in apps/web to enable same-origin serving.`,
  );
}

// Catch-all for unmatched routes (all remaining /api/* misses, plus any
// non-GET non-/api path), so a 404 comes back in the same `{ error }`
// shape as every other response instead of Express's default HTML page.
app.use((_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found.' },
  });
});

app.use(errorHandler)

// Last-resort safety net: log a truly unexpected crash before the
// process dies instead of letting it disappear silently.
process.on('uncaughtException', (error) => {
  logger.error(error, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(reason, 'Unhandled promise rejection');
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);

  httpServer.close(async (closeError) => {
    if (closeError) {
      logger.error(closeError, 'Error while closing HTTP server');
    }

    try {
      await mongoose.connection.close();
      redis.disconnect();
    } finally {
      process.exit(closeError ? 1 : 0);
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * One-line summary of which optional integrations are live, logged at
 * boot so a misconfigured deploy is obvious in the logs rather than
 * discovered when an email silently doesn't send (architecture doc §14's
 * env-var checklist, made observable).
 */
function logStartupConfig() {
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      port,
      email: env.RESEND_API_KEY ? 'resend' : 'console-stub',
      noShowScoring: env.GEMINI_API_KEY ? `gemini (${env.GEMINI_MODEL})` : 'disabled',
      frontend: frontendBuilt ? 'same-origin' : 'api-only',
    },
    'startup configuration',
  );
}

async function startServer() {
  await connectDatabase();
  await checkRedisConnection();

  initRealtime(httpServer);

  httpServer.listen(port, () => {
    logStartupConfig();
    logger.info(`API listening on http://localhost:${port}`);
  });
}


startServer();
