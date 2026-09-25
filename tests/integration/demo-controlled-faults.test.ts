// =====================================================================
// Integration — Phase 9 controlled faults against the REAL Demo target
// (real process, real TCP HTTP, real Demo PostgreSQL)
// =====================================================================
// Low-level socket proof (docs/controlled-faults.md §4):
//   - PRE_MUTATION_REJECTION: 409 CONTROLLED_FAULT_REJECTION, zero
//     business residue, exactly one trigger consumed.
//   - RESPONSE_TRUNCATION: the business mutation COMMITS (verified via
//     the read-only inspection API), then the connection is destroyed
//     MID-BODY — the client sees a real transport error (not a normal
//     success or JSON error), and the demo process stays healthy for
//     unrelated requests.
//   - CRASH_MID_PROCESSING: no response bytes at all; mutation commits.
//   - Budget exhaustion resumes normal behavior; arming is admin-gated.
// Fault plans are armed ONLY through the target's own admin API —
// no direct DB mutation anywhere (§105).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import { createDemoClient, scenarioEvent, startDemoProcess } from './helpers/demo-harness.js';
import type { DemoClient, RunningDemo } from './helpers/demo-harness.js';
import { CONTROLLED_FAULT_PLAN_VERSION } from '@rupturegrid/shared';

const DEMO_TEST_PORT = Number(process.env.DEMO_TEST_PORT_9 ?? '3119');

let env: TestEnv;
let demo: RunningDemo;
let client: DemoClient;

type FaultKind = 'PRE_MUTATION_REJECTION' | 'CRASH_MID_PROCESSING' | 'RESPONSE_TRUNCATION';

async function armFault(kind: FaultKind, maxTriggers: number): Promise<void> {
  const response = await fetch(`${demo.baseUrl}/demo/admin/faults/${kind}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.demoAdminToken}`,
    },
    body: JSON.stringify({
      planVersion: CONTROLLED_FAULT_PLAN_VERSION,
      activation: 'first_n_matching_deliveries',
      maxTriggers,
    }),
  });
  expect(response.ok, `arming ${kind} failed: ${response.status}`).toBe(true);
}

async function disarmFault(kind: FaultKind): Promise<void> {
  await fetch(`${demo.baseUrl}/demo/admin/faults/${kind}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.demoAdminToken}` },
  }).catch(() => undefined);
}

async function faultStatus(): Promise<
  Array<{ faultKind: string; triggersUsed: number; expired: boolean }>
> {
  const response = await fetch(`${demo.baseUrl}/demo/admin/faults`, {
    headers: { authorization: `Bearer ${env.demoAdminToken}` },
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    plans: Array<{ faultKind: string; triggersUsed: number; expired: boolean }>;
  };
  return body.plans;
}

/** Raw delivery with a socket-level outcome (no body parsing). */
interface RawOutcome {
  readonly error: string | null; // transport error name/message, null on clean response
  readonly status: number | null;
  readonly completeBody: boolean;
}

async function deliverRawSocketOutcome(
  payload: unknown,
  deliveryAttemptId: string,
  signature: string,
): Promise<RawOutcome> {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    const response = await fetch(`${demo.baseUrl}/webhooks/provider`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rupturegrid-delivery-attempt-id': deliveryAttemptId,
        'x-rupturegrid-provider-signature': signature,
      },
      body: new Uint8Array(raw),
    });
    // Draining the body is where a mid-body destroy surfaces.
    const text = await response.text();
    return { error: null, status: response.status, completeBody: text.length > 0 };
  } catch (error) {
    return {
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
      status: null,
      completeBody: false,
    };
  }
}

beforeAll(async () => {
  env = loadTestEnv();
  demo = await startDemoProcess(env, DEMO_TEST_PORT);
  client = createDemoClient(demo);
  await client.reset();
  await client.setMode('SECURE');
});

afterAll(async () => {
  await demo?.close();
});

describe('phase 9 demo fault hooks (real TCP sockets)', () => {
  it('fault control requires the admin credential', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/faults/PRE_MUTATION_REJECTION`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-000000x',
      },
      body: JSON.stringify({
        planVersion: CONTROLLED_FAULT_PLAN_VERSION,
        activation: 'first_n_matching_deliveries',
        maxTriggers: 1,
      }),
    });
    expect(response.status).toBe(401);
  });

  it('the read-only fault inspection endpoint rejects the admin token boundary', async () => {
    // Inspection routes take the INSPECTION token only.
    const adminResponse = await fetch(`${demo.baseUrl}/inspection/faults`, {
      headers: { authorization: `Bearer ${env.demoAdminToken}` },
    });
    expect(adminResponse.status).toBe(401);
    const inspectionResponse = await fetch(`${demo.baseUrl}/inspection/faults`, {
      headers: { authorization: `Bearer ${env.demoInspectionToken}` },
    });
    expect(inspectionResponse.status).toBe(200);
    const body = (await inspectionResponse.json()) as { plans: unknown[] };
    expect(Array.isArray(body.plans)).toBe(true);
  });

  it('an unsupported plan version is refused at the target boundary', async () => {
    const response = await fetch(`${demo.baseUrl}/demo/admin/faults/PRE_MUTATION_REJECTION`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.demoAdminToken}`,
      },
      body: JSON.stringify({
        planVersion: 'controlled-fault/v99',
        activation: 'first_n_matching_deliveries',
        maxTriggers: 1,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FAULT_PLAN_UNSUPPORTED_VERSION');
  });

  it('PRE_MUTATION_REJECTION: definitive 409, zero business residue, one-shot budget', async () => {
    // Clean baseline: fault scenarios assert ABSOLUTE business state,
    // so each owns its reset (target-owned, admin API — §105).
    await client.reset();
    await client.setMode('SECURE');
    const scenario = await client.createCanonicalPayment();
    await armFault('PRE_MUTATION_REJECTION', 1);

    const outcome = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 0).payload,
      'D-p9-pre-00000001',
      scenarioEvent(scenario, 0).signature,
    );
    // Clean, definitive contract rejection — not a transport error.
    expect(outcome.error).toBeNull();
    expect(outcome.status).toBe(409);

    // Zero business residue for the rejected delivery.
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(0);
    expect(lineage.counts.processingAttempts).toBe(0);
    expect(lineage.counts.financialEffects).toBe(0);
    expect(lineage.wallet.balanceMinor).toBe('0');

    // Exactly one trigger consumed (one-shot).
    const plans = await faultStatus();
    const plan = plans.find((entry) => entry.faultKind === 'PRE_MUTATION_REJECTION');
    expect(plan?.triggersUsed).toBe(1);

    // Budget exhausted: the next identical delivery succeeds normally.
    const second = await client.deliverSigned(
      scenarioEvent(scenario, 0).payload,
      'D-p9-pre-00000002',
    );
    expect(second.status).toBe(200);

    await disarmFault('PRE_MUTATION_REJECTION');
  }, 60_000);

  it('RESPONSE_TRUNCATION: mutation commits, connection destroyed mid-body, process stays healthy', async () => {
    await client.reset();
    await client.setMode('SECURE');
    const scenario = await client.createCanonicalPayment();
    await armFault('RESPONSE_TRUNCATION', 1);

    const outcome = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 0).payload,
      'D-p9-trunc-00000001',
      scenarioEvent(scenario, 0).signature,
    );
    // The client observes a REAL transport failure — never a normal
    // success or a JSON error response.
    expect(outcome.error).not.toBeNull();

    // The mutation objectively COMMITTED: the read-only inspection API
    // (a different, unrelated request) proves one accepted effect.
    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.deliveries).toBe(1);
    expect(lineage.counts.financialEffects).toBe(1);
    expect(lineage.wallet.balanceMinor).toBe('500000');
    expect(lineage.processingAttempts[0]?.outcome).toBe('APPLIED');

    // Exactly one trigger consumed.
    const plans = await faultStatus();
    expect(plans.find((entry) => entry.faultKind === 'RESPONSE_TRUNCATION')?.triggersUsed).toBe(1);

    // The demo process survived and serves unrelated requests.
    const health = await fetch(`${demo.baseUrl}/health/ready`);
    expect(health.status).toBe(200);
    const unrelated = await client.getMode();
    expect(unrelated).toBe('SECURE');

    await disarmFault('RESPONSE_TRUNCATION');
  }, 60_000);

  it('CRASH_MID_PROCESSING: no response bytes, mutation commits, process stays healthy', async () => {
    await client.reset();
    await client.setMode('SECURE');
    const scenario = await client.createCanonicalPayment();
    await armFault('CRASH_MID_PROCESSING', 1);

    const outcome = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 0).payload,
      'D-p9-crash-00000001',
      scenarioEvent(scenario, 0).signature,
    );
    expect(outcome.error).not.toBeNull();

    const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
    expect(lineage.counts.financialEffects).toBe(1);
    expect(lineage.wallet.balanceMinor).toBe('500000');

    const health = await fetch(`${demo.baseUrl}/health/ready`);
    expect(health.status).toBe(200);

    await disarmFault('CRASH_MID_PROCESSING');
  }, 60_000);

  it('multi-trigger budget: the first N deliveries fault, then normal behavior resumes', async () => {
    await client.reset();
    await client.setMode('SECURE');
    const scenario = await client.createCanonicalPayment();
    await armFault('PRE_MUTATION_REJECTION', 2);

    const first = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 0).payload,
      'D-p9-budget-00000001',
      scenarioEvent(scenario, 0).signature,
    );
    expect(first.status).toBe(409);

    // A duplicate deliveryAttemptId would be a contract conflict, so
    // the second trigger uses the OTHER logical event's payload.
    const second = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 1).payload,
      'D-p9-budget-00000002',
      scenarioEvent(scenario, 1).signature,
    );
    expect(second.status).toBe(409);

    const third = await deliverRawSocketOutcome(
      scenarioEvent(scenario, 0).payload,
      'D-p9-budget-00000003',
      scenarioEvent(scenario, 0).signature,
    );
    expect(third.status).toBe(200);

    const plans = await faultStatus();
    const plan = plans.find((entry) => entry.faultKind === 'PRE_MUTATION_REJECTION');
    expect(plan?.triggersUsed).toBe(2);

    await disarmFault('PRE_MUTATION_REJECTION');
  }, 60_000);

  it('a configured-but-never-triggered plan leaves zero activation evidence', async () => {
    await armFault('RESPONSE_TRUNCATION', 3);
    // No deliveries occur while armed.
    const plans = await faultStatus();
    const plan = plans.find((entry) => entry.faultKind === 'RESPONSE_TRUNCATION');
    expect(plan?.triggersUsed).toBe(0);
    await disarmFault('RESPONSE_TRUNCATION');
    const after = await faultStatus();
    expect(after.find((entry) => entry.faultKind === 'RESPONSE_TRUNCATION')).toBeUndefined();
  });
});
