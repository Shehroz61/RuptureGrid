// =====================================================================
// Integration — REAL Demo Fintech target execution (Phase 3 §36, §57)
// =====================================================================
// The engine executes the Incident Zero TRANSPORT workload against the
// REAL compiled demo-fintech app over REAL TCP HTTP (§57: execution
// only — no invariant evaluation, no findings, no evidence engine).
//
// Proven here:
//   - admin (reset/mode) + provider (payment create) + webhook
//     deliveries executed by the WORKER as registered experiment
//     steps, with credential REFERENCES resolved at runtime (ADR-0012)
//   - webhook signing via the `${signature}` token over the FINAL body
//   - ${steps.<name>.response.…} variable references carry the
//     provider's dynamic payment/event identity into the delivery
//     steps (§59 — no general dataflow language)
//   - deliveryAttemptId per physical invocation, Executor-generated
//     (§63): the Demo persists it; lineage shows one processing
//     attempt per delivery
//   - VULNERABLE mode duplicate deliveries produce duplicate financial
//     effects (transport truth) — Phase 4 will turn this into evidence
//   - RuptureGrid NEVER touches Demo PostgreSQL: Demo state is read
//     back through the Demo's own inspection API only (R-05)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import {
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
} from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess, createDemoClient } from './helpers/demo-harness.js';
import type { DemoClient, RunningDemo } from './helpers/demo-harness.js';
import { getControlPrisma, uniqueName, waitFor } from './helpers/execution-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();

// The Phase 2 suite owns 3112; this suite uses an isolated port so the
// two can run in any order or parallel session.
const DEMO_EXEC_PORT = Number(process.env.DEMO_EXEC_TEST_PORT ?? '3118');

let demo: RunningDemo;
let client: DemoClient;
let controlDb: ControlDb;
let queue: ReturnType<typeof createExecutionQueue>;
let targetId = '';
let workerChild: import('node:child_process').ChildProcess | null = null;

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  demo = await startDemoProcess(env, DEMO_EXEC_PORT);
  client = createDemoClient(demo);

  // Register the REAL Demo target through the Control Plane (§11) with
  // credential REFERENCES only — the values live in the worker env.
  const registered = await registerTarget(prisma, {
    displayName: uniqueName('demo-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [demo.baseUrl],
    contractKind: 'DEMO_FINTECH_WEBHOOK',
    credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_INSPECTION_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'],
  }).catch(async () => {
    // Origin already registered by a previous run of this suite.
    const existing = await prisma.targetRegistration.findFirstOrThrow({
      where: { origins: { some: { origin: demo.baseUrl } } },
    });
    return { targetId: existing.id };
  });
  targetId = registered.targetId;
}, 60_000);

afterAll(async () => {
  if (workerChild !== null && workerChild.exitCode === null && workerChild.signalCode === null) {
    workerChild.kill('SIGKILL');
  }
  await queue.close();
  await controlDb.disconnect();
  await demo.close();
});

/**
 * Starts one REAL worker process with executor credentials in its
 * environment (the executor boundary, §55) and a short lease.
 */
async function startWorker(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      // Executor credential VALUES — worker-side only (ADR-0012).
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_INSPECTION_TOKEN: env.demoInspectionToken,
      DEMO_PROVIDER_SIGNING_SECRET: env.demoProviderSigningSecret,
      WORKER_LEASE_DURATION_MS: '10000',
      WORKER_HEARTBEAT_INTERVAL_MS: '2000',
      WORKER_RECONCILE_INTERVAL_MS: '1000',
      WORKER_CONCURRENCY: '4',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  workerChild = child;
  await waitFor(async () => (stdout.includes('ready') ? true : null), 20_000, 100).catch(() => {
    throw new Error(`worker did not start: ${stderr || stdout}`);
  });
}

/**
 * Creates experiment + run + dispatches the FIRST step via the real
 * dispatch path; the worker chains subsequent steps on success.
 */
async function runExperiment(
  name: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ runId: string; stepRunIds: string[] }> {
  const created = await createExperiment(prisma, {
    name: uniqueName(name),
    targetId,
    document: { steps } as never,
  });
  const run = await createRun(prisma, created.revisionId);
  await markRunDispatching(prisma, run.runId);
  const first = run.stepRunIds[0];
  if (first === undefined) {
    throw new Error('run has no steps');
  }
  await queue.enqueueStep({ runId: run.runId, stepRunId: first, sequence: 0 });
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

describe('execution against the REAL Demo Fintech target (§36/§57)', () => {
  it(
    'admin reset + VULNERABLE mode + payment create executed by the worker, then a signed webhook delivery with ${steps.…} identity flow',
    { timeout: 90_000 },
    async () => {
      await startWorker();
      await client.reset();

      const made = await runExperiment('exec-demo-full', [
        // 1. Admin reset — honestly MUTATING (it changes target state);
        //    credential reference in the pure Bearer form.
        {
          name: 'reset',
          action: {
            method: 'POST',
            relativePath: '/demo/admin/reset',
            headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            credentialRefs: ['DEMO_ADMIN_TOKEN'],
          },
        },
        // 2. VULNERABLE mode.
        {
          name: 'mode',
          action: {
            method: 'PUT',
            relativePath: '/demo/admin/mode',
            headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
            body: JSON.stringify({ mode: 'VULNERABLE' }),
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            credentialRefs: ['DEMO_ADMIN_TOKEN'],
          },
        },
        // 3. Create the canonical payment; capture the provider identity
        //    for the webhook steps via ${steps.…} references.
        {
          name: 'create-payment',
          action: {
            method: 'POST',
            relativePath: '/demo/provider/payments',
            headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            credentialRefs: ['DEMO_ADMIN_TOKEN'],
          },
        },
        // 4. Deliver the FIRST provider event, signed over the final
        //    body bytes, with the payload taken from step 3's response.
        {
          name: 'deliver-event-0',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            headers: {
              'x-rupturegrid-provider-signature': '${signature}',
            },
            body: '${steps.create-payment.response.events[0].payload}',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            retryPolicy: 'NONE',
            credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
          },
        },
      ]);

      // Run settles: all four steps terminal, run COMPLETED.
      await waitFor(
        async () => {
          const row = await prisma.experimentRun.findUnique({ where: { id: made.runId } });
          return row?.state === 'COMPLETED' || row?.state === 'FAILED' ? true : null;
        },
        80_000,
        500,
      );

      const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: made.runId } });
      expect(run.state).toBe('COMPLETED');

      // Every step succeeded.
      const steps = await prisma.experimentStepRun.findMany({
        where: { runId: made.runId },
        orderBy: { sequence: 'asc' },
      });
      expect(steps.map((step) => step.state)).toEqual([
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);

      // The mutation step's classification: 2xx on a mutating action →
      // KNOWN_OCCURRED (architecture §7.1).
      const delivery = steps[3];
      expect(delivery?.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
      expect(delivery?.intentOutcome).toBe('SUCCEEDED');

      // §63: a deliveryAttemptId per physical invocation was sent (the
      // executor generates it); the Demo APPLIED exactly one event.
      const invocation = await prisma.stepInvocation.findFirstOrThrow({
        where: { stepRunId: delivery?.id },
        orderBy: { sequence: 'asc' },
      });
      expect(invocation.invocationIdentity.length).toBeGreaterThanOrEqual(8);

      // Demo truth read back through the Demo's OWN inspection API —
      // never the Demo DB (R-05).
      const createInvocation = await prisma.stepInvocation.findFirstOrThrow({
        where: { stepRunId: steps[2]?.id },
        orderBy: { sequence: 'asc' },
      });
      const payment = JSON.parse(createInvocation.responseBody ?? '{}') as {
        payment?: { providerPaymentId?: string };
      };
      expect(payment.payment?.providerPaymentId).toBeTruthy();
      const lineage = await client.inspectionLineage(payment.payment?.providerPaymentId ?? '');
      // The canonical scenario itself creates TWO provider events
      // (confirmed + settled); this run delivered only the FIRST one.
      expect(lineage.counts.events).toBe(2);
      expect(lineage.counts.deliveries).toBe(1);
      expect(lineage.counts.processingAttempts).toBe(1);
      expect(lineage.deliveries[0]?.status).toBe('ACCEPTED');
      expect(lineage.counts.financialEffects).toBe(1);
    },
  );

  it(
    'repeated + distinct-event deliveries through the engine reproduce the canonical Incident Zero transport truth',
    { timeout: 90_000 },
    async () => {
      await client.reset();
      await client.setMode('VULNERABLE');
      const scenario = await client.createCanonicalPayment();
      const event0 = scenario.events[0];
      const event1 = scenario.events[1];

      const repeat = 5;
      const made = await runExperiment('exec-demo-repeat', [
        {
          // The SAME event repeated 5 times (experiment-declared repeat,
          // distinct deliveryAttemptIds per invocation — §7.2/§63).
          name: 'deliver-event-0',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            headers: { 'x-rupturegrid-provider-signature': '${signature}' },
            body: JSON.stringify(event0.payload),
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            repeat,
            concurrency: 1,
            retryPolicy: 'NONE',
            credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
          },
        },
        {
          // The DISTINCT second event — the duplicate-credit trigger.
          name: 'deliver-event-1',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            headers: { 'x-rupturegrid-provider-signature': '${signature}' },
            body: JSON.stringify(event1.payload),
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            retryPolicy: 'NONE',
            credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
          },
        },
      ]);

      await waitFor(
        async () => {
          const row = await prisma.experimentRun.findUnique({ where: { id: made.runId } });
          return row?.state === 'COMPLETED' || row?.state === 'FAILED' ? true : null;
        },
        80_000,
        500,
      );

      const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: made.runId } });
      expect(run.state).toBe('COMPLETED');

      // 6 physical invocations, 6 distinct deliveryAttemptIds.
      const invocations = await prisma.stepInvocation.findMany({
        where: { stepRunId: made.stepRunIds[0] },
        orderBy: { sequence: 'asc' },
      });
      expect(invocations).toHaveLength(repeat);
      const identities = new Set(invocations.map((row) => row.invocationIdentity));
      expect(identities.size).toBe(repeat);

      // Transport truth (canonical Incident Zero numbers): 6 deliveries
      // → 6 processing attempts → exactly 2 accepted equivalent credits
      // → balance 1,000.00 PKR (1000000 paisa, integer minor units —
      // R-06). Phase 3 records what physically happened; Phase 4 will
      // evaluate the business invariant.
      const lineage = await client.inspectionLineage(scenario.payment.providerPaymentId);
      expect(lineage.counts.deliveries).toBe(repeat + 1);
      expect(lineage.counts.processingAttempts).toBe(repeat + 1);
      expect(lineage.counts.financialEffects).toBe(2);
      expect(lineage.wallet.balanceMinor).toBe('1000000');
      expect(lineage.wallet.currency).toBe('PKR');
    },
  );
});
