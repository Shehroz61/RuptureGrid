// =====================================================================
// RuptureGrid v1.0 — Demo Fintech target (Phase 1 shell)
// =====================================================================
// A genuinely separate application boundary (ADR-0002): own HTTP
// process, own configuration, own structured logging, OWN PostgreSQL.
// RuptureGrid holds no credentials to this database and this app holds
// no RuptureGrid credentials. No wallet/payment/provider business logic
// exists yet (Phase 2).

import { loadDemoConfig } from '@rupturegrid/config';
import { createDemoDb } from '@rupturegrid/demo-db';
import { createLogger } from '@rupturegrid/logger';
import { SERVICE_NAMES } from '@rupturegrid/shared';
import express from 'express';

async function main(): Promise<void> {
  const config = loadDemoConfig();
  const logger = createLogger({
    service: 'demo-fintech',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const db = createDemoDb(config.DEMO_DATABASE_URL);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'live', service: SERVICE_NAMES.demoFintech });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await db.ping();
      res.status(200).json({
        status: 'ready',
        service: SERVICE_NAMES.demoFintech,
        checks: { demoPostgres: 'ok' },
      });
    } catch {
      res.status(503).json({
        status: 'not_ready',
        service: SERVICE_NAMES.demoFintech,
        checks: { demoPostgres: 'unavailable' },
      });
    }
  });

  const server = app.listen(config.DEMO_PORT, config.DEMO_HOST, () => {
    logger.info('demo-fintech started', {
      host: config.DEMO_HOST,
      port: config.DEMO_PORT,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    void Promise.allSettled([
      new Promise<void>((resolve) => server.close(() => resolve())),
      db.disconnect(),
    ]).then(() => {
      logger.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Demo Fintech failed to start: ${message}`);
  process.exit(1);
});
