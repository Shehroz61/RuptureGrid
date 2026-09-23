// =====================================================================
// Integration — Phase 9 controlled faults on the REAL stack (R-08)
// =====================================================================
// Real Control PostgreSQL, real Demo PostgreSQL, real Redis, real
// worker process (production wiring), real Demo HTTP. Fault activation
// is TARGET-AUTHORED truth read from the run's own captured fault-status
// observations (captured post-terminal, pre-disarm) — never inferred
// from error shapes. Scenarios run twice (repeatability); fault state
// must not leak between runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@rupturegrid/control-db';
import { createControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import type { ExecutionQueue } from '@rupturegrid/queue';
import { CONTROLLED_FAULT_PLAN_VERSION } from '@rupturegrid/shared';
import { runRunAnalysis, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import { validateExperimentDocument } from '@rupturegrid/engine';
import type { TestEnv } from './helpers/env.js';
import { loadTestEnv } from './helpers/env.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import { startDemoProcess } from './helpers/demo-harness.js';
import {
  createAndDispatchRun,
  registerDemoTarget,
  startPhase4Worker,
} from './helpers/phase4-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { waitFor, uniqueName } from './helpers/execution-harness.js';

const SCENARIO_TIMEOUT = 240_000;

let env: TestEnv;
let prisma: PrismaClient;
let disconnect: () => Promise<void>;
let demo: RunningDemo;
let worker: RunningWorker;
let queue: ExecutionQueue;
let targetId: string;

beforeAll(async () => {
  env = loadTestEnv();
  const control = createControlDb(env.controlDatabaseUrl);
  prisma = control.prisma;
  disconnect = control.disconnect;
  demo = await startDemoProcess(env, 45901);
  worker = await startPhase4Worker(env);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  const registered = await registerDemoTarget(prisma, demo, 'phase9-faults-target');
  targetId = registered.targetId;
}, 60_000);

afterAll(async () => {
  await queue.close().catch(() => undefined);
  await worker.close().catch(() => undefined);
  await demo.close().catch(() => undefined);
  await disconnect().catch(() => undefined);
});

async function runToTerminal(runId: string): Promise<string> {
  return waitFor(
    async () => {
      const run = await prisma.experimentRun.findUnique({
        where: { id: runId },
        select: { state: true },
      });
      if (run === null) {
        return null;
      }
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state) ? run.state : null;
    },
    SCENARIO_TIMEOUT,
    500,
  );
}

function faultDeliveryStep(
  faultPlan: Record<string, unknown>,
  withAdapter = false,
): Record<string, unknown> {
  return {
    name: 'deliver-with-fault',
    action: {
      method: 'POST',
      relativePath: '/webhooks/provider',
      headers: { 'x-rupturegrid-provider-signature': '${signature}' },
      body: '${steps.create-payment.response.events[0].payload}',
      mutation: 'MUTATING',
      contract: 'DEMO_FINTECH_WEBHOOK',
      credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      faultPlan,
      // Response-loss proof: the fault-bearing step declares the
      // explicit adapter; the engine captures the target's committed
      // business state AFTER the step's FAILED terminal write without
      // rewriting the INDETERMINATE invocation (docs/controlled-faults.md
      // §4.2 — later inspection is separate evidence).
      ...(withAdapter
        ? {
            evidenceAdapter: {
              kind: 'demo-fintech-payment-lineage',
              providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
            },
          }
        : {}),
    },
  };
}

const SETUP_STEPS: Array<Record<string, unknown>> = [
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
  {
    name: 'mode',
    action: {
      method: 'PUT',
      relativePath: '/demo/admin/mode',
      headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
      body: JSON.stringify({ mode: 'SECURE' }),
      mutation: 'MUTATING',
      contract: 'DEMO_FINTECH_WEBHOOK',
      credentialRefs: ['DEMO_ADMIN_TOKEN'],
    },
  },
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
];

const LINEAGE_CAPTURE_STEP: Record<string, unknown> = {
  name: 'capture-lineage',
  action: {
    method: 'GET',
    relativePath: '/health/live',
    mutation: 'READ_ONLY',
    contract: 'DEMO_FINTECH_WEBHOOK',
    evidenceAdapter: {
      kind: 'demo-fintech-payment-lineage',
      providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
    },
  },
};

async function dispatchRun(name: string, steps: Array<Record<string, unknown>>): Promise<string> {
  const { runId } = await createAndDispatchRun(prisma, queue, targetId, uniqueName(name), steps);
  return runId;
}

interface FaultPlanStatus {
  readonly faultKind: string;
  readonly planVersion: string;
  readonly activation: string;
  readonly maxTriggers: number;
  readonly triggersUsed: number;
  readonly expired: boolean;
}

/** Reads the run's OWN captured fault-status observations (target-authored). */
async function runFaultStatus(runId: string): Promise<FaultPlanStatus[]> {
  const observations = await prisma.rawObservation.findMany({
    where: { runId, kind: 'target_observation', adapterKind: 'demo-fintech-fault-status' },
    orderBy: { chainIndex: 'desc' },
    take: 1,
  });
  const latest = observations[0];
  expect(latest, 'run has a captured fault-status observation').toBeDefined();
  const payload = latest?.payload as { plans?: FaultPlanStatus[] };
  return payload.plans ?? [];
}

async function liveFaultStatus(): Promise<{ plans: FaultPlanStatus[] }> {
  const response = await fetch(`${demo.baseUrl}/demo/admin/faults`, {
    headers: { authorization: `Bearer ${env.demoAdminToken}` },
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { plans: FaultPlanStatus[] };
}

describe('phase 9 controlled faults (real stack)', () => {
  it('denies fault plans on PRODUCTION targets at definition time (server-side gate)', () => {
    const productionTarget = {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'prod-lookalike',
      contractKind: 'DEMO_FINTECH_WEBHOOK',
      environment: 'PRODUCTION' as const,
      credentialRefs: ['DEMO_ADMIN_TOKEN'],
      origins: [{ origin: demo.baseUrl }],
    };
    const document = {
      steps: [
        {
          name: 'deliver',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            body: '{}',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            faultPlan: {
              planVersion: CONTROLLED_FAULT_PLAN_VERSION,
              faultKind: 'PRE_MUTATION_REJECTION',
              activation: 'first_n_matching_deliveries',
              maxTriggers: 1,
            },
          },
        },
      ],
    };
    expect(() => validateExperimentDocument({ document, target: productionTarget })).toThrow(
      /LOCAL_DEVELOPMENT/,
    );
  }, 20_000);

  it('rejects invalid fault plans (bad version / kind / budget) before any run exists', () => {
    const localTarget = {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'local-lookalike',
      contractKind: 'DEMO_FINTECH_WEBHOOK',
      environment: 'LOCAL_DEVELOPMENT' as const,
      credentialRefs: ['DEMO_ADMIN_TOKEN'],
      origins: [{ origin: demo.baseUrl }],
    };
    const action = (faultPlan: Record<string, unknown>): unknown => ({
      steps: [
        {
          name: 'deliver',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            body: '{}',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            faultPlan,
          },
        },
      ],
    });
    const validPlan = {
      planVersion: CONTROLLED_FAULT_PLAN_VERSION,
      faultKind: 'PRE_MUTATION_REJECTION',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
    };
    expect(() =>
      validateExperimentDocument({ document: action(validPlan), target: localTarget }),
    ).not.toThrow();
    expect(() =>
      validateExperimentDocument({
        document: action({ ...validPlan, planVersion: 'controlled-fault/v9' }),
        target: localTarget,
      }),
    ).toThrow(/planVersion/);
    expect(() =>
      validateExperimentDocument({
        document: action({ ...validPlan, faultKind: 'DROP_TABLES' }),
        target: localTarget,
      }),
    ).toThrow(/faultKind/);
    expect(() =>
      validateExperimentDocument({
        document: action({ ...validPlan, maxTriggers: 99 }),
        target: localTarget,
      }),
    ).toThrow(/maxTriggers/);
  }, 20_000);

  it(
    'pre-mutation rejection: KNOWN_ABSENT, one-shot budget, target recovers (run twice)',
    async () => {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const runId = await dispatchRun(`phase9-pre-mutation-${iteration}`, [
          ...SETUP_STEPS,
          faultDeliveryStep({
            planVersion: CONTROLLED_FAULT_PLAN_VERSION,
            faultKind: 'PRE_MUTATION_REJECTION',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 1,
          }),
        ]);
        const terminal = await runToTerminal(runId);
        // The fault-bearing step FAILS (definitive target rejection).
        expect(terminal).toBe('FAILED');

        const steps = await prisma.experimentStepRun.findMany({
          where: { runId },
          orderBy: { sequence: 'asc' },
        });
        const faultStep = steps.find((step) => step.state === 'FAILED');
        expect(faultStep).toBeDefined();
        // Definitive 4xx under the Demo contract ⇒ no effect ⇒ KNOWN_ABSENT
        // (the accepted Phase 3 classification table — not fault-specific).
        expect(faultStep?.sideEffectKnowledge).toBe('KNOWN_ABSENT');
        expect(faultStep?.attemptCount).toBe(1);

        // REAL activation, target-authored: exactly one trigger consumed
        // (one-shot budget) — read from the run's captured observation.
        const plans = await runFaultStatus(runId);
        const plan = plans.find((entry) => entry.faultKind === 'PRE_MUTATION_REJECTION');
        expect(plan?.triggersUsed).toBe(1);
        expect(plan?.maxTriggers).toBe(1);

        // Evidence chain integrity holds for the fault run.
        const integrity = await verifyRunEvidenceChain(prisma, runId);
        expect(integrity.chainValid).toBe(true);
      }

      // After both runs: no leakage. The armed plans were disarmed; the
      // target resumes normal behavior (a clean run succeeds below).
      const live = await liveFaultStatus();
      expect(
        live.plans.find((entry) => entry.faultKind === 'PRE_MUTATION_REJECTION'),
      ).toBeUndefined();

      const cleanRunId = await dispatchRun('phase9-pre-mutation-clean', [
        ...SETUP_STEPS,
        {
          name: 'deliver-normal',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            headers: { 'x-rupturegrid-provider-signature': '${signature}' },
            body: '${steps.create-payment.response.events[0].payload}',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
          },
        },
      ]);
      expect(await runToTerminal(cleanRunId)).toBe('COMPLETED');
    },
    SCENARIO_TIMEOUT * 2,
  );

  it(
    'post-mutation response loss: commits, INDETERMINATE, no auto retry, later evidence proves the effect',
    async () => {
      const runId = await dispatchRun('phase9-response-loss', [
        ...SETUP_STEPS,
        // Lineage captured BEFORE the fault step: the run's evidence then
        // contains the wallet state the INV-DF evaluators read.
        LINEAGE_CAPTURE_STEP,
        // The ambiguous delivery itself declares the adapter: its FAILED
        // terminal still captures the post-mutation committed truth.
        faultDeliveryStep(
          {
            planVersion: CONTROLLED_FAULT_PLAN_VERSION,
            faultKind: 'RESPONSE_TRUNCATION',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 1,
          },
          true,
        ),
      ]);
      const terminal = await runToTerminal(runId);
      expect(terminal).toBe('FAILED');

      const steps = await prisma.experimentStepRun.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
      });
      const faultStep = steps.find((step) => step.state === 'FAILED');
      expect(faultStep).toBeDefined();
      // Sent ⇒ response lost ⇒ INDETERMINATE; NEVER auto-retried.
      expect(faultStep?.sideEffectKnowledge).toBe('INDETERMINATE');
      expect(faultStep?.attemptCount).toBe(1);

      // The invocation row keeps INDETERMINATE even though later
      // inspection proves the effect: knowledge-at-execution-time and
      // later evidence are separate facts (ADR-0008) — the engine never
      // rewrites the invocation retroactively.
      const invocation = await prisma.stepInvocation.findFirst({
        where: { stepRunId: faultStep?.id },
        orderBy: { sequence: 'desc' },
      });
      expect(invocation?.sideEffectKnowledge).toBe('INDETERMINATE');
      expect(invocation?.outcome).toBe('FAILED');

      // REAL activation (target-authored): one-shot consumed.
      const plans = await runFaultStatus(runId);
      const plan = plans.find((entry) => entry.faultKind === 'RESPONSE_TRUNCATION');
      expect(plan?.triggersUsed).toBe(1);

      // Evidence chain integrity holds for the ambiguous run.
      const integrity = await verifyRunEvidenceChain(prisma, runId);
      expect(integrity.chainValid).toBe(true);

      // Deterministic analysis over the run's evidence: the wallet-state
      // event carries the target's own whole-wallet reconciliation, so
      // INV-DF-1 (conservation) and INV-DF-2 (no negative balance) both
      // evaluate PASS — the mutation's occurrence is proven by the
      // target's own captured state, never by rewriting the invocation.
      await runRunAnalysis(prisma, runId);
      for (const key of ['INV-DF-1', 'INV-DF-2']) {
        const evaluations = await prisma.invariantEvaluation.findMany({
          where: { runId, invariantKey: key },
        });
        expect(evaluations.length, key).toBeGreaterThanOrEqual(1);
        for (const evaluation of evaluations) {
          expect(evaluation.verdict, key).toBe('PASS');
        }
      }
    },
    SCENARIO_TIMEOUT,
  );

  it('no stale fault survives a completed scenario (cross-run contamination check)', async () => {
    const live = await liveFaultStatus();
    // Every leftover plan, if any, must be expired (disarmed by
    // definition) with no budget left to trigger.
    for (const plan of live.plans) {
      expect(plan.expired).toBe(true);
    }
  }, 30_000);

  it(
    'fault-status capture failure leaves execution truth and evidence honest (no fake activation, no fake Finding)',
    async () => {
      // A worker whose INSPECTION credential is broken can arm and run
      // the step but can never capture the fault-status observation:
      // exactly the post-terminal capture-failure scenario. The shared
      // worker (correct credentials) must NOT be consuming while this
      // scenario runs — it would legitimately capture the observation
      // and defeat the proof — so it is stopped and restored after.
      await worker.close();
      const brokenWorker = await startPhase4Worker(env, {
        extraEnv: { DEMO_INSPECTION_TOKEN: 'definitely-not-the-real-inspection-token' },
      });
      try {
        const runId = await dispatchRun('phase9-capture-failure', [
          ...SETUP_STEPS,
          faultDeliveryStep({
            planVersion: CONTROLLED_FAULT_PLAN_VERSION,
            faultKind: 'PRE_MUTATION_REJECTION',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 1,
          }),
        ]);
        expect(await runToTerminal(runId)).toBe('FAILED');

        // The REAL fault activation happened (the step failed with the
        // definitive contract rejection) and execution truth is intact.
        const steps = await prisma.experimentStepRun.findMany({
          where: { runId },
          orderBy: { sequence: 'asc' },
        });
        const faultStep = steps.find((step) => step.state === 'FAILED');
        expect(faultStep?.sideEffectKnowledge).toBe('KNOWN_ABSENT');
        expect(faultStep?.attemptCount).toBe(1);

        // No fault-status observation could be captured — the run's own
        // evidence contains NO fault-plan-state observation at all, so
        // no activation may be claimed from this run.
        const faultObservations = await prisma.rawObservation.findMany({
          where: {
            runId,
            kind: 'target_observation',
            adapterKind: 'demo-fintech-fault-status',
          },
        });
        expect(faultObservations).toHaveLength(0);

        // The derived event cannot exist without the observation; the
        // timeline must contain NO fault-plan entries (no fake ACTIVATED).
        await runRunAnalysis(prisma, runId);
        const faultEvents = await prisma.normalizedEvent.findMany({
          where: { runId, eventType: 'demo.fault-plan-state-observed' },
        });
        expect(faultEvents).toHaveLength(0);
        const faultTimelineEntries = await prisma.forensicTimelineEntry.findMany({
          where: {
            runId,
            entryKind: { in: ['FAULT_PLAN_CONFIGURED', 'FAULT_PLAN_ACTIVATED'] },
          },
        });
        expect(faultTimelineEntries).toHaveLength(0);

        // The evidence chain stays valid; verdicts that need the missing
        // surface are honestly NOT_EVALUABLE, and no Finding was derived
        // (Findings remain INV-IZ-1-only in Phase 9).
        const integrity = await verifyRunEvidenceChain(prisma, runId);
        expect(integrity.chainValid).toBe(true);
        const findings = await prisma.finding.findMany({ where: { runId } });
        expect(findings).toHaveLength(0);
      } finally {
        await brokenWorker.close();
        // Restore the shared (correctly-configured) worker for the
        // remaining suites / afterAll lifecycle.
        worker = await startPhase4Worker(env);
      }
    },
    SCENARIO_TIMEOUT,
  );
});
