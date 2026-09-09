// =====================================================================
// Demo Fintech — HTTP composition (route layer only)
// =====================================================================
// Distinct trust boundaries (§32, §34, §59):
//   /health/*               — public
//   /demo/admin/*           — DEMO_ADMIN_TOKEN (reset, mode, status)
//   /demo/provider/*        — DEMO_ADMIN_TOKEN (privileged demo setup)
//   /webhooks/provider      — provider HMAC signature (not a bearer token)
//   /inspection/*           — DEMO_INSPECTION_TOKEN (read-only)
//
// The admin and inspection tokens are NEVER interchangeable: the
// inspection token grants read-only access and no admin capability.
// Admin/demo routes are demonstrably non-production: they exist to
// operate the local demo scenario only (§90).

import express from 'express';
import type { DemoDb, ProcessingMode } from '@rupturegrid/demo-db';
import {
  DELIVERY_ATTEMPT_HEADER,
  isWellFormedIdentity,
  PROCESSING_MODES,
  PROVIDER_SIGNATURE_HEADER,
} from '@rupturegrid/demo-db';
import { SERVICE_NAMES } from '@rupturegrid/shared';
import type { RuptureGridLogger } from '@rupturegrid/logger';
import { requireBearerToken } from './auth.js';
import { captureRawBody } from './raw-body.js';
import type { RequestWithRawBody } from './raw-body.js';
import { DemoDomainError, InvalidModeError, TransportError } from './errors.js';
import type { DemoAdminService } from './admin-service.js';
import type { DemoInspectionService } from './inspection-service.js';
import type { ProviderSimulatorService } from './provider-simulator-service.js';
import type { WebhookProcessingService } from './webhook-processing-service.js';

export interface AppDeps {
  db: DemoDb;
  admin: DemoAdminService;
  simulator: ProviderSimulatorService;
  webhook: WebhookProcessingService;
  inspection: DemoInspectionService;
  adminToken: string;
  inspectionToken: string;
  logger: RuptureGridLogger;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // ONE json parser, capturing the exact raw bytes for every JSON body
  // (≤256kb). A second route-level parser would be skipped by
  // body-parser's body-already-parsed guard, so the webhook's rawBody
  // must come from THIS parser — the signature then binds transmitted
  // bytes. Limit preserved (§96).
  app.use(express.json({ limit: '256kb', verify: captureRawBody }));

  const adminAuth = requireBearerToken(deps.adminToken);
  const inspectionAuth = requireBearerToken(deps.inspectionToken);

  // -----------------------------------------------------------------
  // Health (Phase 1 semantics preserved: liveness = process; readiness
  // = Demo PostgreSQL only — never RuptureGrid dependencies, §53)
  // -----------------------------------------------------------------
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'live', service: SERVICE_NAMES.demoFintech });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await deps.db.ping();
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

  // -----------------------------------------------------------------
  // Admin: reset + processing mode (target-owned, admin token)
  // -----------------------------------------------------------------
  app.post('/demo/admin/reset', adminAuth, async (_req, res, next) => {
    try {
      const baseline = await deps.admin.resetScenario();
      res.status(200).json({
        customerReference: baseline.customerReference,
        walletId: baseline.walletId,
        mode: baseline.mode,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put('/demo/admin/mode', adminAuth, async (req, res, next) => {
    try {
      const mode = (req.body as { mode?: unknown }).mode;
      if (typeof mode !== 'string' || !(PROCESSING_MODES as readonly string[]).includes(mode)) {
        throw new InvalidModeError(`mode must be one of: ${PROCESSING_MODES.join(', ')}`);
      }
      const applied = await deps.admin.setProcessingMode(mode as ProcessingMode);
      res.status(200).json({ mode: applied });
    } catch (error) {
      next(error);
    }
  });

  // Demo status: the current mode is observable (§107) — no secrets.
  app.get('/demo/admin/status', adminAuth, async (_req, res, next) => {
    try {
      const mode = await deps.admin.getProcessingMode();
      res.status(200).json({ mode, environment: 'demo' });
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Provider simulator (privileged demo setup — admin token, §59).
  // DEMO/DEVELOPMENT ONLY: this route exists solely to establish the
  // canonical demo scenario on a local/authorized-test target.
  // -----------------------------------------------------------------
  app.post('/demo/provider/payments', adminAuth, async (_req, res, next) => {
    try {
      const scenario = await deps.simulator.createCanonicalPaymentScenario();
      res.status(201).json(scenario);
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Provider webhook — authenticated by HMAC signature over the EXACT
  // raw bytes (§27, §58), never by a bearer token. Raw-body capture is
  // bound to THIS route so signatures bind transmitted bytes.
  // -----------------------------------------------------------------
  app.post('/webhooks/provider', async (req, res, next) => {
    try {
      const deliveryAttemptId = req.header(DELIVERY_ATTEMPT_HEADER);
      if (typeof deliveryAttemptId !== 'string' || !isWellFormedIdentity(deliveryAttemptId)) {
        throw new TransportError(`header ${DELIVERY_ATTEMPT_HEADER} missing or malformed`);
      }
      const result = await deps.webhook.processDelivery({
        deliveryAttemptId,
        rawBody: (req as RequestWithRawBody).rawBody ?? Buffer.alloc(0),
        signatureHeader: req.header(PROVIDER_SIGNATURE_HEADER),
        sourceIp: req.ip,
      });
      // Valid duplicates are successful processing responses (§41):
      // both APPLIED and IDEMPOTENT_DUPLICATE are 2xx with an explicit
      // outcome; the outcome field is the business truth.
      res.status(200).json({
        deliveryAttemptId: result.deliveryAttemptId,
        processingAttemptId: result.processingAttemptId,
        outcome: result.outcome,
        financialEffectId: result.financialEffectId,
        providerEventId: result.providerEventId,
        providerPaymentId: result.providerPaymentId,
      });
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Read-only inspection (distinct read-only credential, §33/§34)
  // -----------------------------------------------------------------
  app.get(
    '/inspection/provider-payments/:providerPaymentId',
    inspectionAuth,
    async (req, res, next) => {
      try {
        const lineage = await deps.inspection.paymentLineage(
          req.params.providerPaymentId as string,
        );
        res.status(200).json(lineage);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    '/inspection/wallets/:walletId/reconciliation',
    inspectionAuth,
    async (req, res, next) => {
      try {
        const reconciliation = await deps.inspection.walletReconciliation(
          req.params.walletId as string,
        );
        res.status(200).json(reconciliation);
      } catch (error) {
        next(error);
      }
    },
  );

  // -----------------------------------------------------------------
  // Stable error mapping (§42, §95): expected domain conditions map to
  // their documented status; everything else is a 500 without stack
  // traces, SQL, or connection strings. Unexpected errors are logged
  // (redacted structured logger) but never returned to the caller.
  // Body-parser transport failures (malformed JSON, oversized bodies)
  // are transport-level conditions — never 500 (§62, §63).
  // -----------------------------------------------------------------
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof DemoDomainError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      const parserErrorType =
        typeof error === 'object' && error !== null && 'type' in error
          ? (error as { type?: unknown }).type
          : undefined;
      if (parserErrorType === 'entity.parse.failed') {
        res.status(400).json({
          error: { code: 'TRANSPORT_INVALID', message: 'request body is not valid JSON' },
        });
        return;
      }
      if (parserErrorType === 'entity.too.large') {
        res.status(413).json({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'request body exceeds the accepted size limit',
          },
        });
        return;
      }
      deps.logger.error('unhandled request failure', {
        errorName: error instanceof Error ? error.name : 'unknown',
        errorDetail: error instanceof Error ? error.message.slice(0, 200) : 'non-error thrown',
      });
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    },
  );

  return app;
}
