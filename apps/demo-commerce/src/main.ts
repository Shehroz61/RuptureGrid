// =====================================================================
// RuptureGrid v1.1 — Demo Commerce target (Phase 16, ADR-0020)
// =====================================================================
// A genuinely separate application boundary: own HTTP process, own
// configuration family (COMMERCE_*), own structured logging, OWN
// PostgreSQL. RuptureGrid holds no credentials to this database and
// this app holds no RuptureGrid credentials — the target implements
// its own checkout/inventory business logic (R-05, ADR-0002).

import { loadCommerceConfig } from '@rupturegrid/config';
import { createCommerceDb, createFaultControlService } from '@rupturegrid/commerce-db';
import { createLogger } from '@rupturegrid/logger';
import { createApp } from './app.js';
import { createCommerceAdminService } from './admin-service.js';
import { createCheckoutSubmissionService } from './checkout-service.js';
import { createCommerceInspectionService } from './inspection-service.js';

async function main(): Promise<void> {
  const config = loadCommerceConfig();
  const logger = createLogger({
    service: 'demo-commerce',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const db = createCommerceDb(config.COMMERCE_DATABASE_URL);
  // Target-owned fault control — plans live in the Commerce target's
  // own PostgreSQL and are armed/disarmed ONLY via the Commerce admin
  // API (ADR-0014).
  const faults = createFaultControlService({ client: db.client });
  const admin = createCommerceAdminService(db);
  const checkout = createCheckoutSubmissionService({
    db,
    faults,
    signingSecret: config.DEMO_COMMERCE_SIGNING_SECRET,
  });
  const inspection = createCommerceInspectionService(db);

  const app = createApp({
    db,
    admin,
    checkout,
    inspection,
    faults,
    adminToken: config.COMMERCE_ADMIN_TOKEN,
    logger,
  });

  const server = app.listen(config.COMMERCE_PORT, config.COMMERCE_HOST, () => {
    logger.info('demo-commerce started', {
      host: config.COMMERCE_HOST,
      port: config.COMMERCE_PORT,
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
  console.error(`Demo Commerce failed to start: ${message}`);
  process.exit(1);
});
