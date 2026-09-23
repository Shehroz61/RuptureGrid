// =====================================================================
// RuptureGrid v1.0 — Demo Fintech target (Phase 2)
// =====================================================================
// A genuinely separate application boundary (ADR-0002): own HTTP
// process, own configuration, own structured logging, OWN PostgreSQL.
// RuptureGrid holds no credentials to this database and this app holds
// no RuptureGrid credentials. Phase 2 adds the Incident Zero business
// core: wallets, provider payments/events, webhook processing with
// vulnerable/secure idempotency scopes, provider simulator, and the
// read-only inspection API.

import { loadDemoConfig } from '@rupturegrid/config';
import { createDemoDb, createFaultControlService } from '@rupturegrid/demo-db';
import { createLogger } from '@rupturegrid/logger';
import { createApp } from './app.js';
import { createDemoAdminService } from './admin-service.js';
import { createProviderSimulatorService } from './provider-simulator-service.js';
import { createWebhookProcessingService } from './webhook-processing-service.js';
import { createDemoInspectionService } from './inspection-service.js';

async function main(): Promise<void> {
  const config = loadDemoConfig();
  const logger = createLogger({
    service: 'demo-fintech',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const db = createDemoDb(config.DEMO_DATABASE_URL);
  const admin = createDemoAdminService(db);
  const simulator = createProviderSimulatorService({
    db,
    signingSecret: config.DEMO_PROVIDER_SIGNING_SECRET,
  });
  // Phase 9: target-owned fault control — plans live in the Demo's own
  // PostgreSQL and are armed/disarmed ONLY via the Demo's own admin API.
  const faults = createFaultControlService({ client: db.client });
  const webhook = createWebhookProcessingService({
    db,
    signingSecret: config.DEMO_PROVIDER_SIGNING_SECRET,
    modeProvider: () => admin.getProcessingMode(),
    faults,
  });
  const inspection = createDemoInspectionService(db);

  const app = createApp({
    db,
    admin,
    simulator,
    webhook,
    inspection,
    faults,
    adminToken: config.DEMO_ADMIN_TOKEN,
    inspectionToken: config.DEMO_INSPECTION_TOKEN,
    logger,
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
