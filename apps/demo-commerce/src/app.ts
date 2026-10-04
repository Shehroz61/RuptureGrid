// =====================================================================
// Demo Commerce — HTTP composition (route layer only)
// =====================================================================
// Distinct trust boundaries (R-05, docs/checkout-zero.md §2):
//   /health/*               — public
//   /demo/admin/*           — COMMERCE_ADMIN_TOKEN (scenario, mode, faults)
//   /checkout/submit        — checkout HMAC signature over the exact body
//   /inspection/*           — NO credential (read-only by construction;
//                             the Phase 14 generic inspection adapter is
//                             credential-free by contract — a Commerce
//                             inspection credential does not exist)
//
// The admin route family exists to operate the local demo scenario only:
// it is demonstrably non-production, LOCAL_DEVELOPMENT-classified, and
// never reachable by RuptureGrid without the target's own credential.

import express from 'express';
import type { CommerceDb, CommerceMode, FaultControlService } from '@rupturegrid/commerce-db';
import {
  CHECKOUT_SIGNATURE_HEADER,
  isWellFormedIdentity,
  REQUEST_ATTEMPT_HEADER,
  validateFaultPlanInput,
} from '@rupturegrid/commerce-db';
import { SERVICE_NAMES } from '@rupturegrid/shared';
import type { RuptureGridLogger } from '@rupturegrid/logger';
import { requireBearerToken } from './auth.js';
import { BODY_LIMIT, captureRawBody } from './raw-body.js';
import type { RequestWithRawBody } from './raw-body.js';
import { CommerceDomainError, InvalidModeError, TransportError } from './errors.js';
import type { CommerceAdminService } from './admin-service.js';
import type { CheckoutSubmissionService } from './checkout-service.js';
import type { CommerceInspectionService } from './inspection-service.js';

export interface AppDeps {
  db: CommerceDb;
  admin: CommerceAdminService;
  checkout: CheckoutSubmissionService;
  inspection: CommerceInspectionService;
  /** Phase 16: target-owned fault control (armed via THIS admin API). */
  faults: FaultControlService;
  adminToken: string;
  logger: RuptureGridLogger;
}

/** Closed processing-mode vocabulary (matches the DB enum). */
const COMMERCE_MODES = ['VULNERABLE', 'SECURE'] as const;

function requireMode(value: unknown): CommerceMode {
  if (typeof value !== 'string' || !(COMMERCE_MODES as readonly string[]).includes(value)) {
    throw new InvalidModeError(`mode must be one of: ${COMMERCE_MODES.join(', ')}`);
  }
  return value as CommerceMode;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // ONE json parser, capturing the exact raw bytes for every JSON body
  // (≤256kb) — the checkout signature binds transmitted bytes.
  app.use(express.json({ limit: BODY_LIMIT, verify: captureRawBody }));

  const adminAuth = requireBearerToken(deps.adminToken);

  // -----------------------------------------------------------------
  // Health: liveness = process; readiness = the Commerce target's OWN
  // PostgreSQL only (never RuptureGrid dependencies).
  // -----------------------------------------------------------------
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'live', service: SERVICE_NAMES.demoCommerce });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await deps.db.ping();
      res.status(200).json({
        status: 'ready',
        service: SERVICE_NAMES.demoCommerce,
        checks: { commercePostgres: 'ok' },
      });
    } catch {
      res.status(503).json({
        status: 'not_ready',
        service: SERVICE_NAMES.demoCommerce,
        checks: { commercePostgres: 'unavailable' },
      });
    }
  });

  // -----------------------------------------------------------------
  // Admin: experiment context (scope/generation/SKU baseline/mode)
  // -----------------------------------------------------------------
  app.post('/demo/admin/scenario', adminAuth, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scopeToken = body['scopeToken'];
      const sku = body['sku'];
      const initialAvailableUnits = body['initialAvailableUnits'];
      if (typeof scopeToken !== 'string' || !isWellFormedIdentity(scopeToken)) {
        throw new TransportError('scopeToken must be a bounded identifier string');
      }
      if (typeof sku !== 'string' || !isWellFormedIdentity(sku)) {
        throw new TransportError('sku must be a bounded identifier string');
      }
      if (
        typeof initialAvailableUnits !== 'number' ||
        !Number.isInteger(initialAvailableUnits) ||
        initialAvailableUnits < 0
      ) {
        throw new TransportError(
          'initialAvailableUnits must be a non-negative integer unit count (never a float, R-06)',
        );
      }
      const mode = requireMode(body['mode']);
      const context = await deps.admin.resetScenario({
        scopeToken,
        sku,
        initialAvailableUnits,
        mode,
      });
      res.status(200).json({
        scopeToken: context.scopeToken,
        generationId: context.generationId,
        sku: context.sku,
        initialAvailableUnits: context.initialAvailableUnits,
        mode: context.mode,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put('/demo/admin/mode', adminAuth, async (req, res, next) => {
    try {
      const mode = requireMode((req.body as { mode?: unknown }).mode);
      const applied = await deps.admin.setProcessingMode(mode);
      res.status(200).json({ mode: applied });
    } catch (error) {
      next(error);
    }
  });

  app.get('/demo/admin/status', adminAuth, async (_req, res, next) => {
    try {
      const mode = await deps.admin.getProcessingMode();
      res.status(200).json({ mode, environment: 'demo' });
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Controlled fault control (target-owned, admin credential). Plans
  // live in the Commerce target's own PostgreSQL and are armed ONLY
  // through this API (ADR-0014); the vocabulary is the closed
  // controlled-fault/v1 set — no new fault kind exists.
  // -----------------------------------------------------------------
  app.put('/demo/admin/faults/:faultKind', adminAuth, async (req, res, next) => {
    try {
      const plan = validateFaultPlanInput({
        ...(req.body as Record<string, unknown>),
        faultKind: req.params.faultKind,
      });
      await deps.faults.arm(plan);
      const status = await deps.faults.status();
      const armed = status.plans.find((p) => p.faultKind === plan.faultKind);
      res.status(200).json({ armed });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/demo/admin/faults/:faultKind', adminAuth, async (req, res, next) => {
    try {
      await deps.faults.disarm(req.params.faultKind as string);
      res.status(200).json({ disarmed: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/demo/admin/faults', adminAuth, async (_req, res, next) => {
    try {
      res.status(200).json(await deps.faults.status());
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Checkout submission — authenticated by HMAC over the EXACT raw
  // bytes; the physical request identity comes from the executor-owned
  // framing header and is recorded verbatim.
  // -----------------------------------------------------------------
  app.post('/checkout/submit', async (req, res, next) => {
    try {
      const requestAttemptId = req.header(REQUEST_ATTEMPT_HEADER);
      if (typeof requestAttemptId !== 'string' || !isWellFormedIdentity(requestAttemptId)) {
        throw new TransportError(`header ${REQUEST_ATTEMPT_HEADER} missing or malformed`);
      }
      const result = await deps.checkout.submit({
        requestAttemptId,
        rawBody: (req as RequestWithRawBody).rawBody ?? Buffer.alloc(0),
        signatureHeader: req.header(CHECKOUT_SIGNATURE_HEADER),
        parsedBody: req.body,
      });

      const responseBody = {
        requestAttemptId: result.requestAttemptId,
        checkoutIntentId: result.checkoutIntentId,
        checkoutEventId: result.checkoutEventId,
        processingAttemptId: result.processingAttemptId,
        scopeToken: result.scopeToken,
        generationId: result.generationId,
        outcome: result.outcome,
        orderId: result.orderId,
        reservationId: result.reservationId,
      };

      // ---- Controlled-fault response-loss hooks ----
      // The business transaction COMMITTED and the processing attempt is
      // finalized: the mutation objectively occurred, and the target
      // then destroys the connection so the caller cannot observe the
      // outcome (docs/controlled-faults.md §4.2/§4.3). These hooks live
      // in the ROUTE layer because Express writes headers on the first
      // serialization call: truncation must pre-serialize with an
      // inflated Content-Length and destroy mid-body.
      const truncation = await deps.faults.consumeTrigger('RESPONSE_TRUNCATION');
      if (truncation === 'TRIGGERED') {
        const body = JSON.stringify(responseBody);
        // Honest headers for a body LARGER than what is sent: valid
        // headers, then the connection dies mid-body. Headers are not
        // knowledge (§4.3).
        res.status(200);
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8') + 512));
        res.write(body.slice(0, Math.floor(body.length / 2)));
        res.destroy();
        return;
      }
      const crash = await deps.faults.consumeTrigger('CRASH_MID_PROCESSING');
      if (crash === 'TRIGGERED') {
        // No response bytes at all: the client-observable signature of a
        // crash mid-processing (§4.2).
        res.destroy();
        return;
      }

      res.status(200).json(responseBody);
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Read-only inspection (credential-free by contract; literal static
  // collection paths — ADR-0022). Values are commerce facts, never
  // verdicts.
  // -----------------------------------------------------------------
  app.get('/inspection/checkout-intents', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.checkoutIntents());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/request-attempts', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.requestAttempts());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/processing-attempts', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.processingAttempts());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/orders', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.orders());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/reservations', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.reservations());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/skus', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.skus());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/sku-baseline', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.skuBaselines());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/sku-remaining', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.skuRemainings());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/orders-summary', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.ordersSummaries());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/reservations-summary', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.reservationsSummaries());
    } catch (error) {
      next(error);
    }
  });

  app.get('/inspection/quiescence', async (_req, res, next) => {
    try {
      res.status(200).json(await deps.inspection.quiescence());
    } catch (error) {
      next(error);
    }
  });

  // -----------------------------------------------------------------
  // Stable error mapping: expected domain conditions map to their
  // documented status; everything else is a 500 without stack traces,
  // SQL, or connection strings. Parser failures stay transport-level.
  // -----------------------------------------------------------------
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof CommerceDomainError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      // Target-domain errors raised by the Commerce DB business core
      // (stable status + code; bounded, secret-free messages).
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        ['CheckoutDomainError', 'FaultControlError'].includes(
          String((error as { name?: unknown }).name),
        ) &&
        'status' in error &&
        'code' in error
      ) {
        const domainError = error as unknown as { status: number; code: string; message: string };
        res
          .status(domainError.status)
          .json({ error: { code: domainError.code, message: domainError.message } });
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
