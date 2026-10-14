// =====================================================================
// Integration — Phase 16 Demo Commerce target (ADR-0020; R-08)
// =====================================================================
// The second external-in-kind target, exercised over the REAL stack:
// the REAL compiled Commerce process on REAL TCP, the REAL Commerce
// PostgreSQL, the REAL Control PostgreSQL, and the REAL engine signing
// seam. Concurrency is released through a real test-side gate and the
// overlap is MEASURED from target-persisted processing timestamps —
// never asserted from Promise.all optimism (testing-strategy §6).
//
// This suite proves target BEHAVIOR and the platform seam, not the
// Phase 17 Checkout Zero scenario: the single-step documents below are
// test-local mechanical proofs (the scenario definition, invariants,
// CLI, report, and replay are explicitly out of Phase 16 scope).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createExecutionQueue, startExecutionWorker } from '@rupturegrid/queue';
import {
  CredentialAuthorizationError,
  CredentialResolutionError,
  DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
  ExperimentValidationError,
  StepProcessor,
  TargetRegistrationError,
  createExperiment,
  createRun,
  registerTarget,
  validateExperimentDocument,
  validateTargetManifest,
} from '@rupturegrid/engine';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';
import { createEngineEvidenceSink, validateGenericInspectionCapture } from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import {
  getControlPrisma,
  testTargetOriginCredentialPolicy,
  uniqueName,
  uniqueTestOrigin,
  waitFor,
} from './helpers/execution-harness.js';
import {
  CHECKOUT_SIGNATURE_HEADER,
  createCommerceClient,
  checkoutPayload,
  freshRequestAttemptId,
  loadCommerceManifest,
  startCommerceProcess,
} from './helpers/commerce-harness.js';
import type { CommerceClient, RunningCommerce } from './helpers/commerce-harness.js';

const prisma = getControlPrisma();
const SCOPE = 'checkout-zero-phase16';
const SKU = 'SKU-001';
const COMMERCE_SIGNING_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
// Phase 17 (ADR-0025): the commerce admin boundary is its OWN secret —
// naming the Demo Fintech admin token never authenticates here.
const COMMERCE_ADMIN_REF = 'COMMERCE_ADMIN_TOKEN';
// Phase 17: the committed Commerce manifest declares BOTH the signing
// reference and the admin reference (the golden scenario's setup step
// authenticates through the target's own admin API). This suite's
// policy/grant fixtures therefore grant both for the Commerce origin.
const COMMERCE_DECLARED_REFS = [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF] as const;

let env: TestEnv;
let running: RunningCommerce;
let client: CommerceClient;
let commerceTargetId: string | null = null;

// ---------------------------------------------------------------------
// Inspection entity shapes (mirroring the declared manifest queries)
// ---------------------------------------------------------------------

interface OrderRow {
  orderId: string;
  checkoutIntentId: string;
  processingAttemptId: string;
  customerId: string;
  cartId: string;
  totalMinor: number;
  currency: string;
  status: string;
  verificationScopeId: string;
  generationId: number;
}

interface ReservationRow {
  reservationId: string;
  orderId: string;
  sku: string;
  reservedUnits: number;
  status: string;
  verificationScopeId: string;
  generationId: number;
}

interface ProcessingAttemptRow {
  processingAttemptId: string;
  requestAttemptId: string;
  startSequence: number;
  startedAt: string;
  finishedAt: string;
  outcome: string;
  verificationScopeId: string;
  generationId: number;
}

interface RequestAttemptRow {
  requestAttemptId: string;
  checkoutIntentId: string;
  verificationScopeId: string;
  generationId: number;
}

interface SkuBaselineRow {
  sku: string;
  initialAvailableUnits: number;
  verificationScopeId: string;
  generationId: number;
}

interface SkuRemainingRow {
  sku: string;
  remainingAvailableUnits: number;
  verificationScopeId: string;
  generationId: number;
}

interface OrdersSummaryRow {
  checkoutIntentId: string;
  acceptedOrderTotal: number;
  verificationScopeId: string;
  generationId: number;
}

interface ReservationsSummaryRow {
  sku: string;
  acceptedReservationTotal: number;
  verificationScopeId: string;
  generationId: number;
}

// ---------------------------------------------------------------------
// Scope/generation binding
// ---------------------------------------------------------------------
// Every inspection query is a COMPLETE literal collection (ADR-0022):
// the target never filters or paginates, and every entity carries its
// own verificationScopeId + generationId. The platform binds facts to
// ONE coherent scope/generation by exact equality (ADR-0023 §4) — a
// persistent database may legitimately hold more than one scope (this
// suite itself resets one scope while a debug scope coexists), so the
// assertions below always bind before counting. Global arrays are never
// asserted on directly.

function inScope<T extends { verificationScopeId: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.verificationScopeId === SCOPE);
}

function inGeneration<T extends { verificationScopeId: string; generationId: number }>(
  rows: readonly T[],
  generationId: number,
): T[] {
  return inScope(rows).filter((row) => row.generationId === generationId);
}

function commerceCredentialPolicy(origin: string): TargetOriginCredentialPolicy {
  return testTargetOriginCredentialPolicy({
    [origin]: [...COMMERCE_DECLARED_REFS],
  });
}

async function ensureCommerceTarget(): Promise<string> {
  if (commerceTargetId !== null) {
    return commerceTargetId;
  }
  const displayName = uniqueName('demo-commerce');
  try {
    const registered = await registerTarget(
      prisma,
      {
        displayName,
        environment: 'LOCAL_DEVELOPMENT',
        origins: [running.baseUrl],
        contractKind: 'GENERIC_HTTP',
        credentialRefs: [...COMMERCE_DECLARED_REFS],
        manifest: loadCommerceManifest(displayName, running.baseUrl),
      },
      commerceCredentialPolicy(running.baseUrl),
    );
    commerceTargetId = registered.targetId;
  } catch (error) {
    if (error instanceof TargetRegistrationError) {
      // A previous run on this persistent dev database already owns this
      // origin (global by design) — reuse that registration, but ONLY if
      // it declares a Commerce manifest. Silently adopting a manifest-less
      // target is what produced the observed Phase 16 failures; the
      // beforeAll check makes this branch a race-only path, and a foreign
      // registration is now a loud, actionable failure.
      const existing = await prisma.targetRegistration.findFirstOrThrow({
        where: { origins: { some: { origin: running.baseUrl } } },
      });
      if (existing.manifestJson === null) {
        throw new Error(
          `Commerce fixture origin ${running.baseUrl} is registered to a target that declares NO manifest; ` +
            'refusing to silently inherit a foreign target (the beforeAll check should have picked an unregistered origin)',
          { cause: error },
        );
      }
      commerceTargetId = existing.id;
    } else {
      throw error;
    }
  }
  return commerceTargetId;
}

beforeAll(async () => {
  env = loadTestEnv();
  // Random high port: the persistent dev database keeps every previous
  // run's origin registrations, so a fixed port would collide with an
  // older registration (origin authority is global by design).
  //
  // CHECK-THEN-START (Phase 17 B1 fixture repair): a random port is only
  // safe if its origin is verified UNREGISTERED before the process binds
  // it — otherwise the registration below hits the clash path and this
  // suite silently inherits a foreign, manifest-less target, which is
  // exactly how Phase 16 failures appeared (null `manifestJson`, an
  // undeclared signature header, “no declared fault hook”). Bounded
  // repick, never a weakened assertion.
  const pickFreePort = (): number => 33000 + Math.floor(Math.random() * 6000);
  let port = pickFreePort();
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `http://127.0.0.1:${String(port)}`;
    const taken = await prisma.targetOrigin.findUnique({
      where: { origin: candidate },
      select: { id: true },
    });
    if (taken === null) {
      break;
    }
    if (attempt >= 15) {
      throw new Error(
        `no unregistered loopback origin found for the Commerce fixture in 16 picks (last tried ${candidate})`,
      );
    }
    port = pickFreePort();
  }
  running = await startCommerceProcess(env, port);
  client = createCommerceClient(running);
  await client.resetScenario({
    scopeToken: SCOPE,
    sku: SKU,
    initialAvailableUnits: 1,
    mode: 'VULNERABLE',
  });
});

afterAll(async () => {
  await running?.close();
});

// ---------------------------------------------------------------------
// A. Health and trust boundaries
// ---------------------------------------------------------------------

describe('Phase 16: Commerce health and trust boundaries', () => {
  it('reports liveness and readiness against its OWN PostgreSQL', async () => {
    const live = await fetch(`${running.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect((await live.json()) as { service: string }).toMatchObject({ service: 'demo-commerce' });
    const ready = await fetch(`${running.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { checks: Record<string, string> }).toMatchObject({
      checks: { commercePostgres: 'ok' },
    });
  });

  it('admin routes require the target-owned admin token (server-side)', async () => {
    const noToken = await fetch(`${running.baseUrl}/demo/admin/status`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${running.baseUrl}/demo/admin/status`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(wrongToken.status).toBe(401);
    expect(await client.getMode()).toBe('VULNERABLE');
  });

  it('inspection is read-only and credential-free by contract (no token exists)', async () => {
    const response = await fetch(`${running.baseUrl}/inspection/orders`);
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});

// ---------------------------------------------------------------------
// B. Scenario context (target-owned, admin API only)
// ---------------------------------------------------------------------

describe('Phase 16: Commerce scenario context', () => {
  it('reset establishes a fresh generation, SKU baseline, and declared mode', async () => {
    const context = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    expect(context.generationId).toBeGreaterThanOrEqual(1);
    expect(context.mode).toBe('VULNERABLE');
    const baseline = await client.inspection<SkuBaselineRow>('/inspection/sku-baseline');
    const row = baseline.find((entry) => entry.sku === SKU);
    expect(row).toMatchObject({
      sku: SKU,
      initialAvailableUnits: 1,
      verificationScopeId: SCOPE,
      generationId: context.generationId,
    });
    const remaining = await client.inspection<SkuRemainingRow>('/inspection/sku-remaining');
    expect(remaining.find((entry) => entry.sku === SKU)?.remainingAvailableUnits).toBe(1);
    expect(inScope(await client.inspection<OrderRow>('/inspection/orders'))).toHaveLength(0);
    expect(
      inScope(await client.inspection<ReservationRow>('/inspection/reservations')),
    ).toHaveLength(0);
  });

  it('every legitimate reset ADVANCES the integer generation', async () => {
    const first = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const second = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    expect(second.generationId).toBe(first.generationId + 1);
  });

  it('reset CLEARS the scope business state (repeatable scenarios, no residue)', async () => {
    const context = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const submitted = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-RESET-1', sku: SKU }),
      freshRequestAttemptId(),
    );
    expect(submitted.status).toBe(200);
    expect(inScope(await client.inspection<OrderRow>('/inspection/orders'))).toHaveLength(1);
    const after = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    expect(after.generationId).toBe(context.generationId + 1);
    expect(inScope(await client.inspection<OrderRow>('/inspection/orders'))).toHaveLength(0);
    expect(
      inScope(await client.inspection<ReservationRow>('/inspection/reservations')),
    ).toHaveLength(0);
    expect(
      inScope(
        await client.inspection<{ verificationScopeId: string }>('/inspection/checkout-intents'),
      ),
    ).toHaveLength(0);
    const remaining = await client.inspection<SkuRemainingRow>('/inspection/sku-remaining');
    expect(remaining.find((entry) => entry.sku === SKU)?.remainingAvailableUnits).toBe(1);
  });

  it('mode switching is durable target state (no reset required)', async () => {
    await client.setMode('SECURE');
    expect(await client.getMode()).toBe('SECURE');
    await client.setMode('VULNERABLE');
    expect(await client.getMode()).toBe('VULNERABLE');
  });
});

// ---------------------------------------------------------------------
// C. Signature boundary + transport contract
// ---------------------------------------------------------------------

describe('Phase 16: Commerce signature and transport boundary', () => {
  it('accepts a valid HMAC-SHA256 signature over the exact body bytes', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-SIG-1', sku: SKU }),
      freshRequestAttemptId(),
    );
    expect(result.status).toBe(200);
    expect(result.body?.['outcome']).toBe('ACCEPTED');
  });

  it('rejects a missing signature', async () => {
    const rawBody = Buffer.from(
      JSON.stringify(checkoutPayload({ checkoutIntentId: 'CHK-SIG-2', sku: SKU })),
      'utf8',
    );
    const result = await client.submitManual({
      rawBody,
      requestAttemptId: freshRequestAttemptId(),
    });
    expect(result.status).toBe(401);
    expect((result.body?.['error'] as { code: string }).code).toBe(
      'CHECKOUT_AUTHENTICATION_FAILED',
    );
  });

  it('rejects a signature made with the OTHER target secret (cross-target, never shared)', async () => {
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-SIG-3', sku: SKU }),
      freshRequestAttemptId(),
      env.demoProviderSigningSecret,
    );
    expect(result.status).toBe(401);
  });

  it('rejects a signature over different bytes (tampering)', async () => {
    const payload = checkoutPayload({ checkoutIntentId: 'CHK-SIG-4', sku: SKU });
    const signedBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const tamperedBytes = Buffer.from(JSON.stringify({ ...payload, totalMinor: '999999' }), 'utf8');
    const signature = createHmac('sha256', env.commerceSigningSecret)
      .update(signedBytes)
      .digest('hex');
    const result = await client.submitRaw(tamperedBytes, freshRequestAttemptId(), signature);
    expect(result.status).toBe(401);
  });

  it('requires the executor-assigned physical request identity header', async () => {
    const rawBody = Buffer.from(
      JSON.stringify(checkoutPayload({ checkoutIntentId: 'CHK-SIG-5', sku: SKU })),
      'utf8',
    );
    const signature = createHmac('sha256', env.commerceSigningSecret).update(rawBody).digest('hex');
    const result = await client.submitManual({ rawBody, signature });
    expect(result.status).toBe(400);
    expect((result.body?.['error'] as { code: string }).code).toBe('TRANSPORT_INVALID');
  });

  it('rejects malformed payloads with a stable 400 (closed contract, no coercion)', async () => {
    const badField = await client.submitSigned(
      { ...checkoutPayload({ checkoutIntentId: 'CHK-SIG-6', sku: SKU }), sneaky: true } as never,
      freshRequestAttemptId(),
    );
    expect(badField.status).toBe(400);
    expect((badField.body?.['error'] as { code: string }).code).toBe('PAYLOAD_INVALID');

    const floatMoney = await client.submitSigned(
      {
        ...checkoutPayload({ checkoutIntentId: 'CHK-SIG-7', sku: SKU }),
        totalMinor: '500000.5',
      },
      freshRequestAttemptId(),
    );
    expect(floatMoney.status).toBe(400);
    expect((floatMoney.body?.['error'] as { code: string }).code).toBe('PAYLOAD_INVALID');
  });

  it('rejects a repeated physical request identity (one identity per physical request)', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const requestAttemptId = freshRequestAttemptId();
    const first = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-DUP-1', sku: SKU }),
      requestAttemptId,
    );
    expect(first.status).toBe(200);
    // A DIFFERENT business submission claiming the SAME physical identity
    // is a malformed contract — a conflict on the recorded identity, not
    // a signature failure, and never silently accepted.
    const rawBody = Buffer.from(
      JSON.stringify(checkoutPayload({ checkoutIntentId: 'CHK-DUP-2', sku: SKU })),
      'utf8',
    );
    const signature = createHmac('sha256', env.commerceSigningSecret).update(rawBody).digest('hex');
    const duplicate = await client.submitRaw(rawBody, requestAttemptId, signature);
    expect(duplicate.status).toBe(409);
    expect((duplicate.body?.['error'] as { code: string }).code).toBe(
      'REQUEST_ATTEMPT_IDENTITY_CONFLICT',
    );
    // Only the first physical submission's effect exists.
    const orders = inScope(await client.inspection<OrderRow>('/inspection/orders'));
    expect(orders).toHaveLength(1);
    expect(orders[0]?.checkoutIntentId).toBe('CHK-DUP-1');
  });

  it('handles money as exact integer minor units (no float anywhere)', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const totalMinor = '9007199254740991'; // 2^53 − 1: the exact JSON-safe envelope
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-MONEY-1', sku: SKU, totalMinor }),
      freshRequestAttemptId(),
    );
    expect(result.status).toBe(200);
    const order = inScope(await client.inspection<OrderRow>('/inspection/orders')).find(
      (row) => row.checkoutIntentId === 'CHK-MONEY-1',
    );
    expect(order?.totalMinor).toBe(9007199254740991);
    expect(Number.isSafeInteger(order?.totalMinor)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// D/E. Canonical concurrency — VULNERABLE and SECURE
// ---------------------------------------------------------------------

describe('Phase 16: canonical concurrent submissions (VULNERABLE = 2/2/−1)', () => {
  it('two genuinely overlapping submissions oversell the last unit', async () => {
    const context = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const payload = checkoutPayload({ checkoutIntentId: 'CHK-001', sku: SKU });
    const requestIds: [string, string] = [freshRequestAttemptId(), freshRequestAttemptId()];
    const { responses, maxInFlight } = await client.submitConcurrent(payload, requestIds);

    // Real client-side overlap (the release gate dispatched both).
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body?.['outcome']).toBe('ACCEPTED');
    }

    await client.waitForQuiescence(SCOPE);

    // MEASURED overlap from TARGET-PERSISTED authoritative timestamps:
    // attempt A started before attempt B finished AND vice versa.
    const attempts = inGeneration(
      await client.inspection<ProcessingAttemptRow>('/inspection/processing-attempts'),
      context.generationId,
    ).sort((a, b) => a.startSequence - b.startSequence);
    expect(attempts).toHaveLength(2);
    const [a, b] = attempts;
    if (a === undefined || b === undefined) {
      throw new Error('expected two processing attempts');
    }
    expect(new Date(a.startedAt).getTime()).toBeLessThan(new Date(b.finishedAt).getTime());
    expect(new Date(b.startedAt).getTime()).toBeLessThan(new Date(a.finishedAt).getTime());
    expect(a.requestAttemptId).not.toBe(b.requestAttemptId);
    expect(new Set([a.requestAttemptId, b.requestAttemptId])).toEqual(new Set(requestIds));

    const orders = inGeneration(
      await client.inspection<OrderRow>('/inspection/orders'),
      context.generationId,
    );
    expect(orders).toHaveLength(2);
    expect(orders.every((order) => order.status === 'ACCEPTED')).toBe(true);
    expect(new Set(orders.map((order) => order.orderId)).size).toBe(2);
    for (const order of orders) {
      expect(order.checkoutIntentId).toBe('CHK-001');
      expect(order.customerId).toBe('CUST-001');
      expect(order.cartId).toBe('CART-001');
      expect(order.totalMinor).toBe(500000);
      expect(order.currency).toBe('PKR');
      expect(
        attempts.some((attempt) => attempt.processingAttemptId === order.processingAttemptId),
      ).toBe(true);
    }

    const reservations = inGeneration(
      await client.inspection<ReservationRow>('/inspection/reservations'),
      context.generationId,
    );
    expect(reservations).toHaveLength(2);
    expect(reservations.every((row) => row.sku === SKU && row.reservedUnits === 1)).toBe(true);
    expect(new Set(reservations.map((row) => row.orderId))).toEqual(
      new Set(orders.map((order) => order.orderId)),
    );

    const remaining = await client.inspection<SkuRemainingRow>('/inspection/sku-remaining');
    expect(remaining.find((row) => row.sku === SKU)?.remainingAvailableUnits).toBe(-1);

    // Scope/generation coherence: EVERY bound entity carries the exact
    // same declared scope token and generation (ADR-0023 §4).
    for (const row of [...orders, ...reservations, ...attempts]) {
      expect(row.verificationScopeId).toBe(SCOPE);
      expect(row.generationId).toBe(context.generationId);
    }

    // Observed-total completeness surfaces agree with the enumerated
    // effects (ADR-0023 observed-total mechanism).
    const ordersSummary = inGeneration(
      await client.inspection<OrdersSummaryRow>('/inspection/orders-summary'),
      context.generationId,
    );
    expect(
      ordersSummary.find((row) => row.checkoutIntentId === 'CHK-001')?.acceptedOrderTotal,
    ).toBe(2);
    const reservationsSummary = inScope(
      await client.inspection<ReservationsSummaryRow>('/inspection/reservations-summary'),
    );
    expect(reservationsSummary.find((row) => row.sku === SKU)?.acceptedReservationTotal).toBe(2);
  });
});

describe('Phase 16: canonical concurrent submissions (SECURE = 1/1/0)', () => {
  it('intent-keyed idempotency keeps exactly one accepted effect under the same pressure', async () => {
    const context = await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'SECURE',
    });
    // The SAME stable logical intent identity as the vulnerable run —
    // legal because the reset established a clean context (generation).
    const payload = checkoutPayload({ checkoutIntentId: 'CHK-001', sku: SKU });
    const requestIds: [string, string] = [freshRequestAttemptId(), freshRequestAttemptId()];
    const { responses, maxInFlight } = await client.submitConcurrent(payload, requestIds);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    const outcomes = responses.map((response) => response.body?.['outcome']).sort();
    expect(outcomes).toEqual(['ACCEPTED', 'INTENT_ALREADY_ACCEPTED']);

    await client.waitForQuiescence(SCOPE);

    const orders = inGeneration(
      await client.inspection<OrderRow>('/inspection/orders'),
      context.generationId,
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('ACCEPTED');
    const reservations = inGeneration(
      await client.inspection<ReservationRow>('/inspection/reservations'),
      context.generationId,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.reservedUnits).toBe(1);
    const remaining = await client.inspection<SkuRemainingRow>('/inspection/sku-remaining');
    expect(remaining.find((row) => row.sku === SKU)?.remainingAvailableUnits).toBe(0);

    const attempts = inGeneration(
      await client.inspection<ProcessingAttemptRow>('/inspection/processing-attempts'),
      context.generationId,
    );
    expect(attempts).toHaveLength(2);
    expect([...attempts.map((attempt) => attempt.outcome)].sort()).toEqual([
      'ACCEPTED',
      'INTENT_ALREADY_ACCEPTED',
    ]);
    for (const row of [...orders, ...reservations, ...attempts]) {
      expect(row.verificationScopeId).toBe(SCOPE);
      expect(row.generationId).toBe(context.generationId);
    }

    const ordersSummary = inGeneration(
      await client.inspection<OrdersSummaryRow>('/inspection/orders-summary'),
      context.generationId,
    );
    expect(
      ordersSummary.find((row) => row.checkoutIntentId === 'CHK-001')?.acceptedOrderTotal,
    ).toBe(1);
    const reservationsSummary = inScope(
      await client.inspection<ReservationsSummaryRow>('/inspection/reservations-summary'),
    );
    expect(reservationsSummary.find((row) => row.sku === SKU)?.acceptedReservationTotal).toBe(1);

    // The physical attempt identities were recorded verbatim.
    const requestAttempts = inGeneration(
      await client.inspection<RequestAttemptRow>('/inspection/request-attempts'),
      context.generationId,
    );
    expect(new Set(requestAttempts.map((row) => row.requestAttemptId))).toEqual(
      new Set(requestIds),
    );
  });
});

// ---------------------------------------------------------------------
// F. Controlled faults (closed v1 vocabulary, admin-armed)
// ---------------------------------------------------------------------

describe('Phase 16: Commerce controlled faults', () => {
  it('PRE_MUTATION_REJECTION rejects definitively before any persistence', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    await client.armFault('PRE_MUTATION_REJECTION', {
      planVersion: 'controlled-fault/v1',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
    });
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-FAULT-REJ-1', sku: SKU }),
      freshRequestAttemptId(),
    );
    expect(result.status).toBe(409);
    expect((result.body?.['error'] as { code: string }).code).toBe('CONTROLLED_FAULT_REJECTION');
    expect(inScope(await client.inspection<OrderRow>('/inspection/orders'))).toHaveLength(0);
    expect(
      inScope(await client.inspection<ReservationRow>('/inspection/reservations')),
    ).toHaveLength(0);
    const remaining = await client.inspection<SkuRemainingRow>('/inspection/sku-remaining');
    expect(remaining.find((row) => row.sku === SKU)?.remainingAvailableUnits).toBe(1);
    const status = await client.faultStatus();
    expect(
      status.plans.find((plan) => plan['faultKind'] === 'PRE_MUTATION_REJECTION'),
    ).toMatchObject({ triggersUsed: 1, maxTriggers: 1 });
    await client.disarmFault('PRE_MUTATION_REJECTION');
  });

  it('CRASH_MID_PROCESSING destroys the connection AFTER the business mutation committed', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    await client.armFault('CRASH_MID_PROCESSING', {
      planVersion: 'controlled-fault/v1',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
    });
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-FAULT-CRASH-1', sku: SKU }),
      freshRequestAttemptId(),
    );
    expect(result.status).toBeNull();
    expect(result.error).not.toBeNull();
    // Later, separate inspection reveals the committed truth — the
    // target's order DID occur; it is never merged into the caller's
    // execution knowledge (ADR-0008; the platform's concern, not here).
    const orders = inScope(await client.inspection<OrderRow>('/inspection/orders'));
    expect(orders.some((order) => order.checkoutIntentId === 'CHK-FAULT-CRASH-1')).toBe(true);
    expect(
      inScope(await client.inspection<ReservationRow>('/inspection/reservations')),
    ).toHaveLength(1);
    await client.disarmFault('CRASH_MID_PROCESSING');
  });

  it('RESPONSE_TRUNCATION loses the response mid-body after commit', async () => {
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    await client.armFault('RESPONSE_TRUNCATION', {
      planVersion: 'controlled-fault/v1',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
    });
    const result = await client.submitSigned(
      checkoutPayload({ checkoutIntentId: 'CHK-FAULT-TRUNC-1', sku: SKU }),
      freshRequestAttemptId(),
    );
    expect(result.error).not.toBeNull();
    const orders = inScope(await client.inspection<OrderRow>('/inspection/orders'));
    expect(orders.some((order) => order.checkoutIntentId === 'CHK-FAULT-TRUNC-1')).toBe(true);
    await client.disarmFault('RESPONSE_TRUNCATION');
  });

  it('refuses fault kinds outside the closed v1 vocabulary (no new fault kind exists)', async () => {
    const response = await fetch(`${running.baseUrl}/demo/admin/faults/SOMETHING_NEW`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${env.commerceAdminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        planVersion: 'controlled-fault/v1',
        activation: 'first_n_matching_deliveries',
        maxTriggers: 1,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FAULT_PLAN_UNKNOWN_KIND');
  });
});

// ---------------------------------------------------------------------
// G. Manifest, engine signing seam, and the generalized fault gate
// ---------------------------------------------------------------------

describe('Phase 16: Commerce target-manifest/v1 and engine signing seam', () => {
  it('registers the committed manifest and freezes the platform-resolved signing ref', async () => {
    const targetId = await ensureCommerceTarget();
    const row = await prisma.targetRegistration.findUniqueOrThrow({
      where: { id: targetId },
      select: { manifestJson: true },
    });
    const stored = row.manifestJson as Record<string, unknown>;
    expect(stored['manifestVersion']).toBe('target-manifest/v1');
    expect(stored['signatureHeader']).toBe('X-Commerce-Signature');
    // Phase 17: the committed manifest declares the signing ref AND the
    // admin ref (the golden scenario's setup step uses the admin API).
    expect(stored['credentialRefs']).toEqual([...COMMERCE_DECLARED_REFS]);
    expect(stored['faultHook']).toMatchObject({ path: '/checkout/submit' });

    // No secret VALUE can be anywhere in the stored provenance.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(env.commerceSigningSecret);
    expect(serialized).not.toContain(env.demoProviderSigningSecret);

    const policy = commerceCredentialPolicy(running.baseUrl);
    const created = await createExperiment(
      prisma,
      {
        name: uniqueName('commerce-manifest-run'),
        targetId,
        document: {
          steps: [
            {
              name: 'submit',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                headers: { [CHECKOUT_SIGNATURE_HEADER]: '${signature}' },
                body: JSON.stringify(
                  checkoutPayload({ checkoutIntentId: 'CHK-SNAPSHOT-1', sku: SKU }),
                ),
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
        },
      },
      policy,
    );
    const run = await createRun(prisma, created.revisionId, policy);
    const snapshot = await prisma.runSnapshot.findUniqueOrThrow({
      where: { id: run.snapshotId },
      select: { content: true },
    });
    const content = snapshot.content as {
      target: {
        manifestPolicy?: Record<string, unknown>;
        manifestEvidencePolicy?: { inspection: unknown[] };
      };
    };
    expect(content.target.manifestPolicy).toMatchObject({
      manifestVersion: 'target-manifest/v1',
      signatureHeader: 'x-commerce-signature',
      signatureCredentialRef: COMMERCE_SIGNING_REF,
      faultHook: { path: '/checkout/submit' },
    });
    expect(content.target.manifestEvidencePolicy?.inspection).toHaveLength(11);
    // Snapshot content never carries a secret value.
    const snapshotText = JSON.stringify(snapshot.content);
    expect(snapshotText).not.toContain(env.commerceSigningSecret);
    expect(snapshotText).not.toContain(env.demoProviderSigningSecret);
  });

  it('executes a REAL signed checkout through the generic executor with NO target-specific branch', async () => {
    const targetId = await ensureCommerceTarget();
    await client.resetScenario({
      scopeToken: SCOPE,
      sku: SKU,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
    const policy = commerceCredentialPolicy(running.baseUrl);
    const created = await createExperiment(
      prisma,
      {
        name: uniqueName('commerce-signed-step'),
        targetId,
        document: {
          steps: [
            {
              name: 'submit',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                headers: { 'x-commerce-signature': '${signature}' },
                body: JSON.stringify(
                  checkoutPayload({ checkoutIntentId: 'CHK-ENGINE-1', sku: SKU }),
                ),
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
        },
      },
      policy,
    );
    const run = await createRun(prisma, created.revisionId, policy);

    // The resolver knows BOTH secrets but records every reference it is
    // asked for: the frozen policy must resolve ONLY the Commerce ref.
    const resolvedRefs: string[] = [];
    const credentials = {
      resolve(ref: string): string {
        resolvedRefs.push(ref);
        if (ref === COMMERCE_SIGNING_REF) {
          return env.commerceSigningSecret;
        }
        if (ref === 'DEMO_PROVIDER_SIGNING_SECRET') {
          return env.demoProviderSigningSecret;
        }
        throw new CredentialResolutionError(ref);
      },
    };

    const queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
    const processor = new StepProcessor({
      prisma,
      config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
      credentials,
      // REAL evidence sink: the commerce path persists its observation
      // through the same durable Phase 4 store as every other target.
      evidenceSink: createEngineEvidenceSink(prisma),
    });
    const consumer = startExecutionWorker({
      redisUrl: env.redisUrl,
      prefix: env.queuePrefix,
      concurrency: 1,
      processJob: async (payload) => {
        await processor.processStep(payload.stepRunId);
      },
    });
    try {
      const first = run.stepRunIds[0];
      expect(first).toBeDefined();
      await queue.enqueueStep({ runId: run.runId, stepRunId: first as string, sequence: 0 });
      const terminal = await waitFor(async () => {
        const stepRow = await prisma.experimentStepRun.findUnique({
          where: { id: first as string },
          select: { state: true, sideEffectKnowledge: true },
        });
        if (stepRow === null || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(stepRow.state)) {
          return null;
        }
        return stepRow;
      });
      expect(terminal?.state).toBe('SUCCEEDED');
      expect(terminal?.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
      // Exactly the frozen Commerce ref was resolved — never the Fintech
      // provider secret, never any other reference.
      expect(resolvedRefs).toEqual([COMMERCE_SIGNING_REF]);
    } finally {
      await consumer.close();
      await queue.close();
    }

    // The target accepted the engine-composed signed request.
    const orders = inScope(await client.inspection<OrderRow>('/inspection/orders'));
    const engineOrder = orders.find((order) => order.checkoutIntentId === 'CHK-ENGINE-1');
    expect(engineOrder).toBeDefined();
    // The executor's physical invocation identity was recorded verbatim.
    const requestAttempts = inScope(
      await client.inspection<RequestAttemptRow>('/inspection/request-attempts'),
    );
    const engineAttempt = requestAttempts.find((row) => row.checkoutIntentId === 'CHK-ENGINE-1');
    expect(engineAttempt?.requestAttemptId.startsWith(`${run.runId}:`)).toBe(true);

    // ADR-0024 matrix case 14 (evidence surface): the REAL durable
    // observation for this commerce run carries NO secret value — neither
    // the Commerce signing secret nor the Provider one.
    const observations = await prisma.rawObservation.findMany({ where: { runId: run.runId } });
    expect(observations.length).toBeGreaterThan(0);
    const evidenceText = JSON.stringify(observations.map((row) => row.payload));
    expect(evidenceText).not.toContain(env.commerceSigningSecret);
    expect(evidenceText).not.toContain(env.demoProviderSigningSecret);
  });

  it('every declared inspection query matches the REAL response shape exactly', async () => {
    const manifest = validateTargetManifest(
      loadCommerceManifest('Demo Commerce verify', running.baseUrl),
    );
    for (const query of manifest.inspection) {
      const parsed = await client.inspection(query.path);
      const verdict = validateGenericInspectionCapture(parsed, query);
      expect(verdict, `${query.queryId}: ${verdict.detail}`).toMatchObject({ valid: true });
    }
  });

  it('the generalized fault gate accepts plans ONLY on the declared Commerce hook and kinds', async () => {
    const targetId = await ensureCommerceTarget();
    const target = await prisma.targetRegistration.findUniqueOrThrow({
      where: { id: targetId },
      include: { origins: true },
    });
    const policy = commerceCredentialPolicy(running.baseUrl);
    const faultDocument = (relativePath: string, faultKind: string) => ({
      steps: [
        {
          name: 'faulted',
          action: {
            method: 'POST' as const,
            relativePath,
            body: '{"probe":true}',
            mutation: 'MUTATING' as const,
            contract: 'GENERIC_HTTP' as const,
            faultPlan: {
              planVersion: 'controlled-fault/v1' as const,
              faultKind: faultKind as 'RESPONSE_TRUNCATION',
              activation: 'first_n_matching_deliveries' as const,
              maxTriggers: 1,
            },
          },
        },
      ],
    });
    // Declared hook + declared kind → accepted.
    expect(() =>
      validateExperimentDocument({
        target,
        credentialPolicy: policy,
        document: faultDocument('/checkout/submit', 'RESPONSE_TRUNCATION'),
      }),
    ).not.toThrow();
    // Undeclared route → refused.
    expect(() =>
      validateExperimentDocument({
        target,
        credentialPolicy: policy,
        document: faultDocument('/inspection/orders', 'RESPONSE_TRUNCATION'),
      }),
    ).toThrow(/declared fault-controlled delivery path/);
    // A kind outside the closed v1 vocabulary is refused at definition
    // time (no new fault kind exists anywhere in the platform).
    expect(() =>
      validateExperimentDocument({
        target,
        credentialPolicy: policy,
        document: faultDocument('/checkout/submit', 'NOT_A_KIND'),
      }),
    ).toThrow(/must be one of: PRE_MUTATION_REJECTION, CRASH_MID_PROCESSING, RESPONSE_TRUNCATION/);
  });

  it('STAGING targets remain denied fault execution (LOCAL_DEVELOPMENT only, R-14)', async () => {
    // uniqueTestOrigin allocates a collision-free loopback origin; the
    // STAGING registration below uses a unique https origin instead
    // (STAGING manifests/registrations are https-only).
    const stagingName = uniqueName('commerce-staging');
    const registered = await registerTarget(prisma, {
      displayName: stagingName,
      environment: 'STAGING',
      origins: [`https://${stagingName}.staging.example:8443`],
      contractKind: 'GENERIC_HTTP',
    });
    const target = await prisma.targetRegistration.findUniqueOrThrow({
      where: { id: registered.targetId },
      include: { origins: true },
    });
    expect(() =>
      validateExperimentDocument({
        target,
        document: {
          steps: [
            {
              name: 'staging-fault',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                body: '{}',
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
                faultPlan: {
                  planVersion: 'controlled-fault/v1',
                  faultKind: 'RESPONSE_TRUNCATION',
                  activation: 'first_n_matching_deliveries',
                  maxTriggers: 1,
                },
              },
            },
          ],
        },
      }),
    ).toThrow(/LOCAL_DEVELOPMENT targets/);
  });
});

// ---------------------------------------------------------------------
// ADR-0024 matrix remainder: registration/snapshot-level enforcement
// ---------------------------------------------------------------------
// These cases exercise the SAME real Control PostgreSQL and the SAME
// platform authorization seams as the rest of this suite. Grants are
// constructed platform-side (server-owned policy objects); registration
// requests never carry authorization.

describe('Phase 16: ADR-0024 registration and snapshot enforcement (real PostgreSQL)', () => {
  /** Registers the committed Commerce manifest on a fresh origin with overrides. */
  async function registerOn(
    origin: string,
    overrides: Record<string, unknown>,
    declaredRefs: string[],
    policy: TargetOriginCredentialPolicy,
  ): Promise<{ targetId: string }> {
    const displayName = uniqueName('commerce-cred');
    const manifest = { ...loadCommerceManifest(displayName, origin), ...overrides };
    return registerTarget(
      prisma,
      {
        displayName,
        environment: 'LOCAL_DEVELOPMENT',
        origins: [origin],
        contractKind: 'GENERIC_HTTP',
        credentialRefs: declaredRefs,
        manifest,
      },
      policy,
    );
  }

  it('Commerce → Provider: declaring the Provider signing ref is REJECTED with no durable row (matrix case 21)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    // The policy grants ONLY the Commerce refs for this origin, even
    // though the Provider ref is globally executable and signing-capable.
    const before = await prisma.targetRegistration.count();
    await expect(
      registerOn(
        origin,
        { credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'] },
        ['DEMO_PROVIDER_SIGNING_SECRET'],
        testTargetOriginCredentialPolicy({ [origin]: [...COMMERCE_DECLARED_REFS] }),
      ),
    ).rejects.toThrow(CredentialAuthorizationError);
    expect(await prisma.targetRegistration.count()).toBe(before);
    // No registration owns this origin (nothing partially persisted).
    expect(await prisma.targetOrigin.findUnique({ where: { origin } })).toBeNull();
  });

  it('Provider → Commerce: declaring the Commerce signing ref is REJECTED with no durable row (matrix case 22)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    const before = await prisma.targetRegistration.count();
    await expect(
      registerOn(
        origin,
        { credentialRefs: [COMMERCE_SIGNING_REF] },
        [COMMERCE_SIGNING_REF],
        testTargetOriginCredentialPolicy({ [origin]: ['DEMO_PROVIDER_SIGNING_SECRET'] }),
      ),
    ).rejects.toThrow(CredentialAuthorizationError);
    expect(await prisma.targetRegistration.count()).toBe(before);
    expect(await prisma.targetOrigin.findUnique({ where: { origin } })).toBeNull();
  });

  it('globally allowed but UNGRANTED, ordinary (no signatureHeader): REJECTED — authorization governs ALL declared refs (matrix case 23)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    // Strip the signature seam so ONLY the authorization question remains.
    const noSeam = loadCommerceManifest('x', origin);
    delete noSeam['signatureHeader'];
    const displayName = uniqueName('commerce-ordinary');
    const before = await prisma.targetRegistration.count();
    await expect(
      registerTarget(
        prisma,
        {
          displayName,
          environment: 'LOCAL_DEVELOPMENT',
          origins: [origin],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
          manifest: { ...noSeam, displayName, origins: [origin] },
        },
        commerceCredentialPolicy(origin),
      ),
    ).rejects.toThrow(/not platform-authorized/);
    expect(await prisma.targetRegistration.count()).toBe(before);
  });

  it('multi-origin partial grant is REJECTED (intersection, never union) — matrix case 26 at registration', async () => {
    const originA = await uniqueTestOrigin(prisma);
    const originB = await uniqueTestOrigin(prisma);
    const displayName = uniqueName('commerce-multiorigin');
    const manifest = { ...loadCommerceManifest(displayName, originA), origins: [originA, originB] };
    await expect(
      registerTarget(
        prisma,
        {
          displayName,
          environment: 'LOCAL_DEVELOPMENT',
          origins: [originA, originB],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: [COMMERCE_SIGNING_REF],
          manifest,
        },
        // Granted for A only: B contributes the empty set, so the
        // intersection excludes the ref.
        testTargetOriginCredentialPolicy({ [originA]: [...COMMERCE_DECLARED_REFS] }),
      ),
    ).rejects.toThrow(/not platform-authorized/);
    expect(await prisma.targetOrigin.findUnique({ where: { origin: originA } })).toBeNull();
    expect(await prisma.targetOrigin.findUnique({ where: { origin: originB } })).toBeNull();
  });

  it('an ambiguous declaration (two authorized signing refs) is REJECTED — no heuristic selects a key (matrix case 4)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    await expect(
      registerOn(
        origin,
        { credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET', COMMERCE_SIGNING_REF] },
        ['DEMO_PROVIDER_SIGNING_SECRET', COMMERCE_SIGNING_REF],
        testTargetOriginCredentialPolicy({
          [origin]: ['DEMO_PROVIDER_SIGNING_SECRET', COMMERCE_SIGNING_REF],
        }),
      ),
    ).rejects.toThrow(/ambiguous/);
    expect(await prisma.targetOrigin.findUnique({ where: { origin } })).toBeNull();
  });

  it('grant lifecycle: identical bytes rejected before the grant, accepted once it exists (matrix case 29)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    const displayName = uniqueName('commerce-lifecycle');
    const manifest = loadCommerceManifest(displayName, origin);
    const registration = {
      displayName,
      environment: 'LOCAL_DEVELOPMENT' as const,
      origins: [origin],
      contractKind: 'GENERIC_HTTP' as const,
      // Equal to the committed manifest's declared refs (registration
      // consistency is enforced separately from authorization).
      credentialRefs: [...COMMERCE_DECLARED_REFS],
      manifest,
    };
    // Before the grant exists: rejected (declarations enable nothing).
    await expect(
      registerTarget(prisma, registration, DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY),
    ).rejects.toThrow(/not platform-authorized/);
    expect(await prisma.targetOrigin.findUnique({ where: { origin } })).toBeNull();
    // The EXACT SAME bytes now succeed because the platform granted it.
    const registered = await registerTarget(prisma, registration, commerceCredentialPolicy(origin));
    expect(registered.targetId.length).toBeGreaterThan(0);
  });

  it('grant revoked after registration: a NEW run fails closed; historical snapshots are UNCHANGED (matrix case 28)', async () => {
    const origin = await uniqueTestOrigin(prisma);
    const grantedPolicy = commerceCredentialPolicy(origin);
    const { targetId } = await registerOn(origin, {}, [...COMMERCE_DECLARED_REFS], grantedPolicy);

    // A revision created + frozen while the grant exists.
    const created = await createExperiment(
      prisma,
      {
        name: uniqueName('commerce-revoke'),
        targetId,
        document: {
          steps: [
            {
              name: 'submit',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                headers: { [CHECKOUT_SIGNATURE_HEADER]: '${signature}' },
                body: JSON.stringify(
                  checkoutPayload({ checkoutIntentId: 'CHK-REVOKE-1', sku: SKU }),
                ),
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
        },
      },
      grantedPolicy,
    );
    const historicalRun = await createRun(prisma, created.revisionId, grantedPolicy);
    const historicalSnapshot = await prisma.runSnapshot.findUniqueOrThrow({
      where: { id: historicalRun.snapshotId },
      select: { content: true },
    });
    const snapshotRowsBefore = await prisma.runSnapshot.count();

    // The grant is revoked: the platform now holds NO grant for the origin.
    const revoked = DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY;
    // A NEW run from the UNCHANGED stored manifest fails closed...
    await expect(createRun(prisma, created.revisionId, revoked)).rejects.toThrow(
      /not platform-authorized/,
    );
    // ...with NO new snapshot row and NO rewrite of the existing one.
    expect(await prisma.runSnapshot.count()).toBe(snapshotRowsBefore);
    const after = await prisma.runSnapshot.findUniqueOrThrow({
      where: { id: historicalRun.snapshotId },
      select: { content: true },
    });
    expect(after.content).toEqual(historicalSnapshot.content);
    const policy = (after.content as { target: { manifestPolicy: Record<string, unknown> } }).target
      .manifestPolicy;
    expect(policy['signatureCredentialRef']).toBe(COMMERCE_SIGNING_REF);
  });

  it('B-1 (matrix case 31): an ordinary header token naming a globally usable but UNGRANTED/UNDECLARED ref is REJECTED on the real Commerce target — no send', async () => {
    const targetId = await ensureCommerceTarget();
    const target = await prisma.targetRegistration.findUniqueOrThrow({
      where: { id: targetId },
      include: { origins: true },
    });
    // The Provider signing ref is globally executable and signing-capable,
    // but the Commerce target never declared it — the audited B-1 shape.
    expect(target.credentialRefs).not.toContain('DEMO_PROVIDER_SIGNING_SECRET');
    try {
      validateExperimentDocument({
        target,
        document: {
          steps: [
            {
              name: 'attack',
              action: {
                method: 'GET',
                relativePath: '/inspection/orders',
                headers: {
                  authorization: 'Bearer ${credential.DEMO_PROVIDER_SIGNING_SECRET}',
                },
                mutation: 'READ_ONLY',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
        },
        credentialPolicy: commerceCredentialPolicy(running.baseUrl),
      });
      throw new Error('expected B-1 rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentValidationError);
      const issues = (error as ExperimentValidationError).issues.join('\n');
      expect(issues).toContain('DEMO_PROVIDER_SIGNING_SECRET'); // the NAME
      expect(issues).not.toContain(env.demoProviderSigningSecret); // never the VALUE
      expect(issues).not.toContain(env.commerceSigningSecret);
    }
  });
});

// ---------------------------------------------------------------------
// ADR-0024 matrix case 14: no secret value on ANY surface
// ---------------------------------------------------------------------

describe('Phase 16: ADR-0024 case 14 — secret values on NO surface', () => {
  it('the Commerce signing secret appears in no manifest, snapshot, evidence, log, or error', async () => {
    const secrets = [env.commerceSigningSecret, env.demoProviderSigningSecret];

    // (a) stored registration provenance for every Commerce-origin target.
    const registrations = await prisma.targetRegistration.findMany({
      select: { manifestJson: true },
    });
    const manifests = JSON.stringify(registrations.map((row) => row.manifestJson));
    for (const secret of secrets) {
      expect(manifests).not.toContain(secret);
    }

    // (b) every frozen snapshot content.
    const snapshots = await prisma.runSnapshot.findMany({ select: { content: true } });
    const snapshotText = JSON.stringify(snapshots.map((row) => row.content));
    for (const secret of secrets) {
      expect(snapshotText).not.toContain(secret);
    }

    // (c) durable evidence observations.
    const observations = await prisma.rawObservation.findMany({ select: { payload: true } });
    const evidenceText = JSON.stringify(observations.map((row) => row.payload));
    for (const secret of secrets) {
      expect(evidenceText).not.toContain(secret);
    }

    // (d) the REAL process log stream (stdout JSON + stderr).
    const logs = running.stdout() + running.stderr();
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
    }

    // (e) an authorization error message names the REF, never the value.
    const origin = await uniqueTestOrigin(prisma);
    try {
      await registerTarget(
        prisma,
        {
          displayName: uniqueName('commerce-leak-probe'),
          environment: 'LOCAL_DEVELOPMENT',
          origins: [origin],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: [COMMERCE_SIGNING_REF],
          manifest: loadCommerceManifest('x', origin) as Record<string, unknown>,
        },
        DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
      );
      throw new Error('expected authorization rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialAuthorizationError);
      const message = (error as Error).message;
      expect(message).toContain(COMMERCE_SIGNING_REF); // the NAME is allowed
      for (const secret of secrets) {
        expect(message).not.toContain(secret);
      }
    }

    // (f) the grant records (the test policy objects) are name-only.
    const grantText = JSON.stringify(commerceCredentialPolicy(running.baseUrl));
    for (const secret of secrets) {
      expect(grantText).not.toContain(secret);
    }
  });

  it('a signed run executed with NO runtime secret fails PRE-SEND and leaks nothing (matrix case 13)', async () => {
    const targetId = await ensureCommerceTarget();
    const policy = commerceCredentialPolicy(running.baseUrl);
    const created = await createExperiment(
      prisma,
      {
        name: uniqueName('commerce-missing-secret'),
        targetId,
        document: {
          steps: [
            {
              name: 'submit',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                headers: { [CHECKOUT_SIGNATURE_HEADER]: '${signature}' },
                body: JSON.stringify(
                  checkoutPayload({ checkoutIntentId: 'CHK-NOSECRET-1', sku: SKU }),
                ),
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
        },
      },
      policy,
    );
    const run = await createRun(prisma, created.revisionId, policy);
    const credentials = {
      resolve(ref: string): string {
        throw new CredentialResolutionError(ref);
      },
    };
    const first = run.stepRunIds[0] as string;
    const processor = new StepProcessor({
      prisma,
      config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
      credentials,
    });
    // Fail-closed BEFORE any transmission: the executor rejects the
    // invocation when the frozen ref cannot be resolved, and nothing is
    // sent. The rejection carries the reference NAME, never a value.
    let rejection: unknown;
    try {
      await processor.processStep(first);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(CredentialResolutionError);
    expect((rejection as Error).message).toContain(COMMERCE_SIGNING_REF);
    expect((rejection as Error).message).not.toContain(env.commerceSigningSecret);
    expect((rejection as Error).message).not.toContain(env.demoProviderSigningSecret);
    // No invocation reached SENT (the failure is provably pre-send)...
    const sentInvocations = await prisma.stepInvocation.findMany({
      where: { stepRunId: first, transportStage: 'REQUEST_SENT' },
      select: { id: true },
    });
    expect(sentInvocations).toEqual([]);
    // ...and the target never observed this intent.
    const orders = inScope(await client.inspection<OrderRow>('/inspection/orders'));
    expect(orders.some((order) => order.checkoutIntentId === 'CHK-NOSECRET-1')).toBe(false);
  });
});
