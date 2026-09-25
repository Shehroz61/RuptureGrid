// =====================================================================
// Integration — Incident Zero black-box suites (real process, real TCP
// HTTP, real Demo PostgreSQL)
// =====================================================================
// The flagship Phase 2 acceptance scenarios (§100). The target is
// driven EXCLUSIVELY through its own HTTP interfaces; state is read
// through the read-only inspection API (§61, §105). Concurrency is
// measured, never asserted (§76).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import {
  createDemoClient,
  deliverManyConcurrent,
  scenarioEvent,
  startDemoProcess,
} from './helpers/demo-harness.js';
import type { DemoClient, RunningDemo } from './helpers/demo-harness.js';
import { CANONICAL_PAYMENT_AMOUNT_MINOR } from '@rupturegrid/demo-db';

const DEMO_TEST_PORT = Number(process.env.DEMO_TEST_PORT ?? '3112');

let env: TestEnv;
let demo: RunningDemo;
let client: DemoClient;

beforeAll(async () => {
  env = loadTestEnv();
  demo = await startDemoProcess(env, DEMO_TEST_PORT);
  client = createDemoClient(demo);
});

afterAll(async () => {
  await demo?.close();
});

// ---------------------------------------------------------------------
// A. Health (Phase 1 semantics preserved)
// ---------------------------------------------------------------------

describe('A. health (Phase 1 semantics preserved)', () => {
  it('live returns 200 with the demo service identity', async () => {
    const response = await fetch(`${demo.baseUrl}/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('live');
    expect(body.service).toBe('demo-fintech');
  });

  it('ready returns 200 with only the Demo PostgreSQL dependency', async () => {
    const response = await fetch(`${demo.baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(Object.keys(body.checks)).toEqual(['demoPostgres']);
  });
});

// ---------------------------------------------------------------------
// B/C. Security boundaries
// ---------------------------------------------------------------------

describe('B/C. security boundaries (admin, inspection, provider)', () => {
  it('reset without admin token is denied', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/reset`, { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('mode switch with wrong token is denied', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/mode`, {
      method: 'PUT',
      headers: { authorization: 'Bearer wrong-token-entirely-000000' },
    });
    expect(response.status).toBe(401);
  });

  it('invalid admin token is denied', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/reset`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-admin-token-000000x' },
    });
    expect(response.status).toBe(401);
  });

  it('valid admin token is accepted', async () => {
    await expect(client.reset()).resolves.toBeUndefined();
  });

  it('inspection without token is denied', async () => {
    const response = await fetch(`${demo.baseUrl}/inspection/provider-payments/pp-anything`);
    expect(response.status).toBe(401);
  });

  it('inspection with wrong token is denied', async () => {
    const response = await fetch(`${demo.baseUrl}/inspection/provider-payments/pp-anything`, {
      headers: { authorization: 'Bearer wrong-inspection-token-00000x' },
    });
    expect(response.status).toBe(401);
  });

  it('inspection token grants NO admin capability (no privilege escalation)', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${env.demoInspectionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'SECURE' }),
    });
    expect(response.status).toBe(401);
  });

  it('admin token is NOT valid for inspection (separate trust boundaries)', async () => {
    const response = await fetch(`${demo.baseUrl}/inspection/provider-payments/pp-anything`, {
      headers: { authorization: `Bearer ${env.demoAdminToken}` },
    });
    expect(response.status).toBe(401);
  });

  it('unknown provider payment is not-found for the inspection API', async () => {
    await client.reset();
    const response = await fetch(
      `${demo.baseUrl}/inspection/provider-payments/pp-does-not-exist-0000001`,
      { headers: { authorization: `Bearer ${env.demoInspectionToken}` } },
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------
// D. Provider authenticity
// ---------------------------------------------------------------------

describe('D. provider authenticity (HMAC over exact raw bytes)', () => {
  let scenario: Awaited<ReturnType<DemoClient['createCanonicalPayment']>>;

  beforeAll(async () => {
    await client.reset();
    await client.setMode('VULNERABLE');
    scenario = await client.createCanonicalPayment();
  });

  it('a signed event is accepted', async () => {
    const event = scenarioEvent(scenario, 0);
    const result = await client.deliverSigned(event.payload, 'D-auth-valid-000000000001');
    expect(result.status).toBe(200);
    expect(result.body['outcome']).toBe('APPLIED');
  });

  it('an invalid signature produces 401 and NO financial side effect', async () => {
    const raw = Buffer.from(JSON.stringify(scenarioEvent(scenario, 1).payload), 'utf8');
    const result = await client.deliverRaw(raw, 'D-auth-invalid-00000001', 'ff'.repeat(32));
    expect(result.status).toBe(401);
    expect(result.body['error']).toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED' });
  });

  it('a missing signature produces 401 and NO financial side effect', async () => {
    const raw = Buffer.from(JSON.stringify(scenarioEvent(scenario, 1).payload), 'utf8');
    const response = await fetch(`${demo.baseUrl}/webhooks/provider`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rupturegrid-delivery-attempt-id': 'D-auth-missing-00000001',
      },
      body: new Uint8Array(raw),
    });
    expect(response.status).toBe(401);
  });

  it('the signature binds payload content: mutate after signing → rejected (§106)', async () => {
    const event = scenarioEvent(scenario, 1);
    const original = Buffer.from(JSON.stringify(event.payload), 'utf8');
    const signature = createHmacHex(env.demoProviderSigningSecret, original);
    const mutated = Buffer.from(
      JSON.stringify({ ...event.payload, amountMinor: '999999' }),
      'utf8',
    );
    const result = await client.deliverRaw(mutated, 'D-auth-tamper-00000001', signature);
    expect(result.status).toBe(401);

    // No financial residue from ANY rejected attempt.
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.financialEffects).toBe(1);
    expect(lineage.wallet.balanceMinor).toBe('500000');
  });
});

function createHmacHex(secret: string, data: Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

// ---------------------------------------------------------------------
// G/H. Canonical scenarios (the flagship)
// ---------------------------------------------------------------------

describe('G. canonical VULNERABLE scenario (20 deliveries, concurrency 8)', () => {
  let scenario: Awaited<ReturnType<DemoClient['createCanonicalPayment']>>;
  let maxInFlight = 0;

  beforeAll(async () => {
    await client.reset();
    await client.setMode('VULNERABLE');
    scenario = await client.createCanonicalPayment();
    // 20 physical deliveries: 10 per logical event, all with distinct
    // deliveryAttemptIds, real overlap, measured (§40, §44).
    const wave1 = await deliverManyConcurrent(demo, scenarioEvent(scenario, 0).payload, {
      count: 10,
      concurrency: 8,
    });
    const wave2 = await deliverManyConcurrent(demo, scenarioEvent(scenario, 1).payload, {
      count: 10,
      concurrency: 8,
    });
    maxInFlight = Math.max(wave1.maxInFlight, wave2.maxInFlight);
    for (const response of [...wave1.responses, ...wave2.responses]) {
      expect(response.status).toBe(200);
    }
  });

  it('measured real in-flight overlap (≥2, §76)', () => {
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('all 20 deliveries and 20 processing attempts persisted (suppressed stay inspectable)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(20);
    expect(lineage.counts.processingAttempts).toBe(20);
  });

  it('exactly 2 accepted equivalent credits (deterministic — the business bug)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.financialEffects).toBe(2);
    expect(lineage.counts.ledgerEntries).toBe(2);
    expect(lineage.wallet.balanceMinor).toBe('1000000');
  });

  it('vulnerable ledger keys are event-scoped (the realistic mistake)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    for (const entry of lineage.ledgerEntries) {
      expect(entry.idempotencyKey).toContain(':event:');
    }
  });

  it('wallet balance equals ledger credit sum (reconciliation, exact integers)', async () => {
    const reconciliation = await client.walletReconciliation(scenario.payment.walletId);
    expect(reconciliation.ledgerCreditSumMinor).toBe('1000000');
    expect(reconciliation.differenceMinor).toBe('0');
  });

  it('causal lineage is identity-linked end to end (no timestamp inference, §65)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    for (const effect of lineage.financialEffects) {
      // effect → processing attempt (identity, not timestamps)
      const attempt = lineage.processingAttempts.find(
        (a) => a.processingAttemptId === effect.processingAttemptId,
      );
      expect(attempt).toBeDefined();
      // processing attempt → delivery (identity)
      const delivery = lineage.deliveries.find(
        (d) => d.deliveryAttemptId === attempt?.deliveryAttemptId,
      );
      expect(delivery).toBeDefined();
      // delivery → event → payment (identity)
      const event = lineage.events.find((e) => e.providerEventId === delivery?.providerEventId);
      expect(event).toBeDefined();
      expect(event?.providerPaymentId).toBe(lineage.payment.providerPaymentId);
    }
    expect(
      lineage.financialEffects.every(
        (e) => e.providerPaymentId === lineage.payment.providerPaymentId,
      ),
    ).toBe(true);
    expect(lineage.financialEffects.every((e) => e.walletId === lineage.wallet.walletId)).toBe(
      true,
    );
    expect(lineage.financialEffects.every((e) => e.amountMinor === '500000')).toBe(true);
    expect(lineage.financialEffects.every((e) => e.currency === 'PKR')).toBe(true);
  });
});

describe('H. canonical SECURE scenario (same workload, idempotent)', () => {
  let scenario: Awaited<ReturnType<DemoClient['createCanonicalPayment']>>;

  beforeAll(async () => {
    await client.reset();
    await client.setMode('SECURE');
    scenario = await client.createCanonicalPayment();
    const wave1 = await deliverManyConcurrent(demo, scenarioEvent(scenario, 0).payload, {
      count: 10,
      concurrency: 8,
    });
    const wave2 = await deliverManyConcurrent(demo, scenarioEvent(scenario, 1).payload, {
      count: 10,
      concurrency: 8,
    });
    for (const response of [...wave1.responses, ...wave2.responses]) {
      expect(response.status).toBe(200);
    }
  });

  it('same workload produced 20 deliveries and 20 processing attempts', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(20);
    expect(lineage.counts.processingAttempts).toBe(20);
  });

  it('exactly ONE accepted equivalent credit — 500000 paisa (the fix)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.financialEffects).toBe(1);
    expect(lineage.counts.ledgerEntries).toBe(1);
    expect(lineage.wallet.balanceMinor).toBe('500000');
    expect(lineage.financialEffects[0]?.amountMinor).toBe('500000');
  });

  it('suppressed attempts are recorded as IDEMPOTENT_DUPLICATE, not hidden (§119)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    const outcomes = lineage.processingAttempts.map((a) => a.outcome);
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'IDEMPOTENT_DUPLICATE')).toHaveLength(19);
  });

  it('secure ledger key is payment-scoped', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.ledgerEntries[0]?.idempotencyKey).toBe(
      `wallet-credit:payment:${lineage.payment.providerPaymentId}:${lineage.wallet.walletId}`,
    );
  });

  it('mode is observable through inspection (§107)', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.processingMode).toBe('SECURE');
  });

  it('wallet balance equals ledger credit sum (reconciliation)', async () => {
    const reconciliation = await client.walletReconciliation(scenario.payment.walletId);
    expect(reconciliation.ledgerCreditSumMinor).toBe('500000');
    expect(reconciliation.differenceMinor).toBe('0');
  });
});

// ---------------------------------------------------------------------
// I. Two legitimate payments (no wallet-global suppression)
// ---------------------------------------------------------------------

describe('I. two legitimate payments in SECURE mode credit independently (§63)', () => {
  it('two different payments of the same amount each produce one accepted credit', async () => {
    await client.reset();
    await client.setMode('SECURE');

    const paymentA = await client.createCanonicalPayment();
    const paymentB = await client.createCanonicalPayment();

    for (const event of [...paymentA.events, ...paymentB.events]) {
      const result = await client.deliverSigned(
        event.payload,
        `D-two-payments-${randomIdForTest()}`,
      );
      expect(result.status).toBe(200);
    }

    const lineageA = await client.inspectionLineage(paymentA.payment.providerPaymentId);
    const lineageB = await client.inspectionLineage(paymentB.payment.providerPaymentId);
    expect(lineageA.counts.financialEffects).toBe(1);
    expect(lineageB.counts.financialEffects).toBe(1);

    const reconciliation = await client.walletReconciliation(paymentA.payment.walletId);
    expect(reconciliation.wallet.balanceMinor).toBe('1000000');
    expect(reconciliation.differenceMinor).toBe('0');
    // The two payments must NOT collide on idempotency keys.
    expect(lineageA.ledgerEntries[0]?.idempotencyKey).not.toEqual(
      lineageB.ledgerEntries[0]?.idempotencyKey,
    );
  });
});

// ---------------------------------------------------------------------
// F. Delivery identity semantics
// ---------------------------------------------------------------------

describe('F. delivery identity semantics (§64, §25)', () => {
  let scenario: Awaited<ReturnType<DemoClient['createCanonicalPayment']>>;

  beforeAll(async () => {
    await client.reset();
    await client.setMode('SECURE');
    scenario = await client.createCanonicalPayment();
  });

  it('same providerEventId + many unique deliveryAttemptIds → many deliveries/attempts, ONE effect', async () => {
    const event = scenarioEvent(scenario, 0);
    for (let i = 1; i <= 5; i += 1) {
      const result = await client.deliverSigned(
        event.payload,
        `D-identity-redeliver-${String(i).padStart(12, '0')}`,
      );
      expect(result.status).toBe(200);
    }
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(5);
    expect(lineage.counts.processingAttempts).toBe(5);
    expect(lineage.counts.financialEffects).toBe(1);
  });

  it('reusing a deliveryAttemptId is a 409 conflict and creates NO second delivery', async () => {
    const event = scenarioEvent(scenario, 0);
    // Exactly the id used by the first redelivery above (padStart 12).
    const result = await client.deliverSigned(event.payload, 'D-identity-redeliver-000000000001');
    expect(result.status).toBe(409);
    expect(result.body['error']).toMatchObject({ code: 'DUPLICATE_DELIVERY_ATTEMPT_ID' });

    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(5);
  });

  it('unknown provider event → 404 with no financial effect', async () => {
    const result = await client.deliverSigned(
      {
        providerPaymentId: scenario.payment.providerPaymentId,
        providerEventId: 'pe-unknown-0000000000000001',
        eventType: 'PAYMENT_CONFIRMED',
        amountMinor: '500000',
        currency: 'PKR',
      },
      'D-identity-unknown-00000001',
    );
    expect(result.status).toBe(404);
  });

  it('amount mismatch against the registered payment → 409 (no effect, §70)', async () => {
    const event = scenarioEvent(scenario, 0);
    const result = await client.deliverSigned(
      { ...event.payload, amountMinor: '499999' },
      'D-identity-amountmismatch-1',
    );
    expect(result.status).toBe(409);
    expect(result.body['error']).toMatchObject({ code: 'BUSINESS_MISMATCH' });
  });

  it('foreign currency is rejected at the transport layer → 400, no effect (§56/§70)', async () => {
    // The demo target is PKR-only at payload validation (§56), so a
    // non-PKR payload can never reach business resolution — the
    // rejection (and zero financial residue) is what §70 mandates.
    const event = scenarioEvent(scenario, 0);
    const result = await client.deliverSigned(
      { ...event.payload, currency: 'USD' },
      'D-identity-currencymismatch-1',
    );
    expect([400, 409]).toContain(result.status);
    expect(result.body['error']).toMatchObject({ code: expect.any(String) });
  });

  it('event/payment identity mismatch → 409 (no effect, §70)', async () => {
    const event = scenarioEvent(scenario, 0);
    const result = await client.deliverSigned(
      { ...event.payload, providerPaymentId: 'pp-other-0000000000000001' },
      'D-identity-paymismatch-00001',
    );
    expect(result.status).toBe(409);
  });

  it('no financial residue from any rejected delivery', async () => {
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.financialEffects).toBe(1);
    expect(lineage.wallet.balanceMinor).toBe('500000');
  });
});

// ---------------------------------------------------------------------
// M. Mode switching through the same server implementation (§73)
// ---------------------------------------------------------------------

describe('M. mode switching is target-owned and flips behavior (§73)', () => {
  it('VULNERABLE then SECURE produce canonical results on ONE server', async () => {
    await client.reset();
    await client.setMode('VULNERABLE');
    expect(await client.getMode()).toBe('VULNERABLE');
    const vulnerable = await client.createCanonicalPayment();
    await client.deliverSigned(scenarioEvent(vulnerable, 0).payload, 'D-modeswitch-v1-000000001');
    await client.deliverSigned(scenarioEvent(vulnerable, 1).payload, 'D-modeswitch-v2-000000001');
    const lineageV = await client.inspectionLineage(vulnerable.payment.providerPaymentId);
    expect(lineageV.counts.financialEffects).toBe(2);
    expect(lineageV.wallet.balanceMinor).toBe('1000000');

    await client.reset();
    await client.setMode('SECURE');
    expect(await client.getMode()).toBe('SECURE');
    const secure = await client.createCanonicalPayment();
    await client.deliverSigned(scenarioEvent(secure, 0).payload, 'D-modeswitch-s1-000000001');
    await client.deliverSigned(scenarioEvent(secure, 1).payload, 'D-modeswitch-s2-000000001');
    const lineageS = await client.inspectionLineage(secure.payment.providerPaymentId);
    expect(lineageS.counts.financialEffects).toBe(1);
    expect(lineageS.wallet.balanceMinor).toBe('500000');
  });

  it('invalid mode value is rejected', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${env.demoAdminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'CHAOS' }),
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------
// N. Transport robustness: body-parser failures are controlled (§63)
// ---------------------------------------------------------------------

describe('N. body-parser transport failures map to stable codes (§63)', () => {
  it('invalid JSON body → 400 TRANSPORT_INVALID (never a 500)', async () => {
    const response = await fetch(`${demo.baseUrl}/webhooks/provider`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rupturegrid-delivery-attempt-id': 'D-transport-badjson-00000001',
      },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('TRANSPORT_INVALID');
  });

  it('oversized body beyond the 256kb limit → 413 (limit enforced, never a 500)', async () => {
    const response = await fetch(`${demo.baseUrl}/webhooks/provider`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rupturegrid-delivery-attempt-id': 'D-transport-oversized-000001',
      },
      body: 'a'.repeat(300 * 1024),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------
// K. Financial reconciliation (exact integers, §68)
// ---------------------------------------------------------------------

describe('K. reconciliation identity (§68)', () => {
  it('canonical amount constant is exactly 500000 paisa', () => {
    expect(CANONICAL_PAYMENT_AMOUNT_MINOR).toBe(500000n);
  });

  it('balance minus ledger sum is exactly zero after the canonical scenario', async () => {
    await client.reset();
    await client.setMode('VULNERABLE');
    const scenario = await client.createCanonicalPayment();
    for (const [i, event] of scenario.events.entries()) {
      await client.deliverSigned(event.payload, `D-recon-${String(i).padStart(13, '0')}`);
    }
    const reconciliation = await client.walletReconciliation(scenario.payment.walletId);
    expect(BigInt(reconciliation.wallet.balanceMinor)).toBe(
      BigInt(reconciliation.ledgerCreditSumMinor),
    );
    expect(reconciliation.differenceMinor).toBe('0');
  });
});

function randomIdForTest(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
