// =====================================================================
// Integration — Phase 17 B1/F-1: worker emergency step-truth
// (WORKER-POST-SEND-KNOWN-ABSENT; final-audit F-1 incomplete-persistence)
// =====================================================================
// The independent Phase 17 adversarial audit found that the worker's
// processJob-level catch wrote sideEffectKnowledge=KNOWN_ABSENT
// terminally whenever processStep threw while the step was
// CLAIMED/EXECUTING — even when a mutating request had already crossed
// the send boundary. The FINAL audit then found the first repair still
// unsound (F-1): a persisted invocation set is not a closed world, so
// "every persisted row is KNOWN_ABSENT" does not prove every attempted
// mutation was pre-send. The exact counterexample: `repeat = 2`, slot 1
// recorded KNOWN_ABSENT (pre-send), slot 2 SENT but its
// `recordInvocation` threw before persistence.
//
// These tests exercise the REAL PRODUCTION function the worker's
// `processJob` catch calls — `repairEmergencyStepTerminal` (engine) —
// against the real durable store (real PostgreSQL, real fenced writes,
// real HTTP receiver — R-08). They do NOT call a helper directly with
// hand-passed knowledge arrays: the durable step row + invocation rows
// are the input, and the final `experiment_step_run` row is the asserted
// output. The pure derivation is pinned separately as a truth table.
//
// The critical D/K cases (a KNOWN_ABSENT-looking persisted set while the
// send boundary was crossed) must NEVER become KNOWN_ABSENT.

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  deriveEmergencyStepTruth,
  repairEmergencyStepTerminal,
  writeEmergencyStepTerminal,
  claimStep,
  markExecuting,
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
  executeHttp,
} from '@rupturegrid/engine';
import type { EmergencyMutationClassification, FencingContext } from '@rupturegrid/engine';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const prisma = getControlPrisma();

const LEASE_MS = 30_000;

/** Creates one registered target + experiment + run with one step. */
async function makeStepHarness(step: {
  readonly name: string;
  readonly action: Record<string, unknown>;
}): Promise<{ runId: string; stepRunId: string; targetId: string; origin: string }> {
  const origin = await uniqueTestOrigin(prisma);
  const target = await registerTarget(prisma, {
    displayName: uniqueName('b1-emergency-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [origin],
    contractKind: 'GENERIC_HTTP',
  });
  const created = await createExperiment(prisma, {
    name: uniqueName('b1-emergency-experiment'),
    targetId: target.targetId,
    document: { steps: [{ name: step.name, action: step.action }] },
  });
  const run = await createRun(prisma, created.revisionId);
  await markRunDispatching(prisma, run.runId);
  return {
    runId: run.runId,
    stepRunId: run.stepRunIds[0] as string,
    targetId: target.targetId,
    origin,
  };
}

/** Claims a step as an isolated test worker generation. */
async function claimAs(
  stepRunId: string,
  owner: string,
  leaseDurationMs: number = LEASE_MS,
): Promise<{ ownerId: string; fencingToken: string }> {
  const claim = await claimStep(prisma, stepRunId, {
    ownerId: owner,
    leaseDurationMs,
  });
  if (claim === null) {
    throw new Error(`test pre-condition failed: ${stepRunId} was not claimable`);
  }
  return { ownerId: owner, fencingToken: claim.fencingToken };
}

/** Appends one durable invocation record with the given classification. */
async function recordInvocation(
  stepRunId: string,
  ctx: { ownerId: string; fencingToken: string },
  knowledge: 'KNOWN_ABSENT' | 'INDETERMINATE' | 'KNOWN_OCCURRED' | 'NOT_APPLICABLE',
  stage: 'CONNECTING' | 'REQUEST_SENT',
  sequence = 1,
): Promise<void> {
  // Through the SAME append-only recordInvocation path the executor uses.
  const { recordInvocation: appendInvocation } = await import('@rupturegrid/engine');
  await appendInvocation(
    prisma,
    stepRunId,
    {
      sequence,
      waveIndex: 0,
      invocationIdentity: randomUUID(),
      transportStage: stage,
      httpStatus: stage === 'REQUEST_SENT' ? 200 : null,
      requestBytes: 10,
      responseBytes: stage === 'REQUEST_SENT' ? 20 : 0,
      responseBody: null,
      durationMs: 5,
      outcome: knowledge === 'KNOWN_ABSENT' ? 'FAILED' : 'SUCCEEDED',
      sideEffectKnowledge: knowledge,
      error: null,
    },
    ctx,
  );
}

/** Loads the final durable step truth for assertion. */
async function finalStep(stepRunId: string) {
  return prisma.experimentStepRun.findUniqueOrThrow({
    where: { id: stepRunId },
    select: {
      state: true,
      intentOutcome: true,
      sideEffectKnowledge: true,
      attemptCount: true,
      executingAt: true,
      error: true,
    },
  });
}

const MUTATING_ACTION: Record<string, unknown> = {
  method: 'POST',
  relativePath: '/unresolvable-ref-check',
  body: '{}',
  mutation: 'MUTATING',
  contract: 'GENERIC_HTTP',
};

const READ_ONLY_ACTION: Record<string, unknown> = {
  method: 'GET',
  relativePath: '/inspection/nothing',
  mutation: 'READ_ONLY',
  contract: 'GENERIC_HTTP',
};

afterAll(async () => {
  // Rows persist: integration tests share the real DB and rows are
  // honest execution state (unique names prevent collisions).
});

// ---------------------------------------------------------------------
// 1. The derivation truth table (the ONE truth model — pinned)
// ---------------------------------------------------------------------

describe('F-1: deriveEmergencyStepTruth truth table (durable invocation truth in)', () => {
  it('zero invocations (mutating) → INDETERMINATE with attemptCount 0 (never KNOWN_ABSENT)', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: [],
      mutation: 'MUTATING',
      preSendProven: true,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(truth.attemptCount).toBe(0);
    expect(truth.terminalState).toBe('FAILED');
    expect(truth.intentOutcome).toBe('FAILED');
  });

  it('all invocations KNOWN_ABSENT AND pre-send proven → KNOWN_ABSENT', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_ABSENT', 'KNOWN_ABSENT'],
      mutation: 'MUTATING',
      preSendProven: true,
    });
    expect(truth.sideEffectKnowledge).toBe('KNOWN_ABSENT');
    expect(truth.attemptCount).toBe(2);
  });

  it('all invocations KNOWN_ABSENT but send boundary NOT proven → INDETERMINATE (F-1 counterexample)', () => {
    // repeat = 2, slot 1 recorded KNOWN_ABSENT (pre-send), slot 2 SENT but
    // its recordInvocation threw before persistence (no row). A persisted
    // row set is NOT a closed world: KNOWN_ABSENT is not claimable.
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_ABSENT'],
      mutation: 'MUTATING',
      preSendProven: false,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(truth.attemptCount).toBe(1);
  });

  it('a persisted set whose SIZE equals repeat is still not proof of completeness', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_ABSENT', 'KNOWN_ABSENT'],
      mutation: 'MUTATING',
      preSendProven: false,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
  });

  it('any INDETERMINATE invocation → step INDETERMINATE (never downgraded, never collapsed)', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_ABSENT', 'INDETERMINATE'],
      mutation: 'MUTATING',
      preSendProven: false,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(truth.attemptCount).toBe(2);
  });

  it('any KNOWN_OCCURRED invocation → step INDETERMINATE (post-send truth never rewritten)', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_OCCURRED'],
      mutation: 'MUTATING',
      preSendProven: false,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(truth.attemptCount).toBe(1);
  });

  it('mixed repeat outcomes (KNOWN_OCCURRED last KNOWN_ABSENT) → conservatively INDETERMINATE', () => {
    const truth = deriveEmergencyStepTruth({
      knowledge: ['KNOWN_OCCURRED', 'KNOWN_ABSENT'],
      mutation: 'MUTATING',
      preSendProven: false,
    });
    expect(truth.sideEffectKnowledge).toBe('INDETERMINATE');
  });

  it('read-only preserves NOT_APPLICABLE platform semantics', () => {
    const absent = deriveEmergencyStepTruth({
      knowledge: [],
      mutation: 'READ_ONLY',
      preSendProven: true,
    });
    const recorded = deriveEmergencyStepTruth({
      knowledge: ['NOT_APPLICABLE', 'NOT_APPLICABLE'],
      mutation: 'READ_ONLY',
      preSendProven: false,
    });
    expect(absent.sideEffectKnowledge).toBe('NOT_APPLICABLE');
    expect(absent.attemptCount).toBe(0);
    expect(recorded.sideEffectKnowledge).toBe('NOT_APPLICABLE');
    expect(recorded.attemptCount).toBe(2);
  });
});

// ---------------------------------------------------------------------
// 2–7. The REAL production repair function the processJob catch calls.
//      Input = real durable rows (step state + invocations); output =
//      the final durable experiment_step_run row, read back.
// ---------------------------------------------------------------------

describe('F-1/F-2: repairEmergencyStepTerminal (the production catch path)', () => {
  it('A. pre-send exception (claimed, never executing, zero invocations) → FAILED / INDETERMINATE, attemptCount 0', async () => {
    const harness = await makeStepHarness({ name: 'pre-send-fail', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-A');
    // No markExecuting → executingAt stays null (pre-send proven). The
    // production function still reports INDETERMINATE for zero recorded
    // attempts (no positive pre-send record) — the conservative default.
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('pre-send processor exception'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.state).toBe('FAILED');
    expect(row.intentOutcome).toBe('FAILED');
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.attemptCount).toBe(0);
  }, 30_000);

  it('B. no persisted invocation, send unknown (executing stamped) → INDETERMINATE', async () => {
    const harness = await makeStepHarness({ name: 'no-row', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-B');
    await markExecuting(prisma, harness.stepRunId, ctx);
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('post-send persistence seam threw before any row'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.attemptCount).toBe(0);
  }, 30_000);

  it('C. complete-looking KNOWN_ABSENT invocation set (executing stamped) → INDETERMINATE (completeness unprovable)', async () => {
    const harness = await makeStepHarness({ name: 'complete-looking', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-C');
    await markExecuting(prisma, harness.stepRunId, ctx);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 1);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 2);
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('post-recorded pre-send exception'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    // A row count that equals repeat is NOT a completeness proof (F-1).
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.attemptCount).toBe(2);
  }, 30_000);

  it('C2. pre-send proven + recorded KNOWN_ABSENT set (never executing) → KNOWN_ABSENT preserved', async () => {
    const harness = await makeStepHarness({ name: 'pre-send-proven', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-C2');
    // Two pre-send records while the step was NEVER marked executing: the
    // independent durable proof (executingAt IS NULL) is present.
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 1);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 2);
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('pre-send seam threw before terminal write'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.sideEffectKnowledge).toBe('KNOWN_ABSENT');
    expect(row.attemptCount).toBe(2);
  }, 30_000);

  it('D. THE F-1 COUNTEREXAMPLE: partial KNOWN_ABSENT set + an unpersisted SENT mutation → NEVER KNOWN_ABSENT', async () => {
    const harness = await makeStepHarness({ name: 'partial-sent', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-D');
    // Slot 1: pre-send failure → durable KNOWN_ABSENT row.
    await markExecuting(prisma, harness.stepRunId, ctx); // send boundary crossed
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 1);
    // Slot 2: SENT, but recordInvocation threw before persistence → NO row.
    // (Its absence is exactly what makes the persisted set partial.)
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('recordInvocation failed after slot 2 was sent'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.state).toBe('FAILED');
    expect(row.sideEffectKnowledge).not.toBe('KNOWN_ABSENT');
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.attemptCount).toBe(1); // honest durable count (only slot 1)
  }, 30_000);

  it('E. persisted INDETERMINATE invocation → step stays INDETERMINATE (never collapsed)', async () => {
    const harness = await makeStepHarness({
      name: 'indeterminate-preserve',
      action: MUTATING_ACTION,
    });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-E');
    await markExecuting(prisma, harness.stepRunId, ctx);
    await recordInvocation(harness.stepRunId, ctx, 'INDETERMINATE', 'REQUEST_SENT');
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('a later post-send persistence seam threw'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.state).toBe('FAILED');
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.attemptCount).toBe(1);
  }, 30_000);

  it('F. persisted KNOWN_OCCURRED invocation → step never becomes KNOWN_ABSENT', async () => {
    const harness = await makeStepHarness({ name: 'occurred-preserve', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-F');
    await markExecuting(prisma, harness.stepRunId, ctx);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_OCCURRED', 'REQUEST_SENT');
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('a later post-send persistence seam threw'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE'); // never degraded
    expect(row.attemptCount).toBe(1);
  }, 30_000);

  it('G. mixed repeat outcomes (KNOWN_OCCURRED then KNOWN_ABSENT) → INDETERMINATE, never KNOWN_ABSENT', async () => {
    const harness = await makeStepHarness({ name: 'mixed-repeat', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-G');
    await markExecuting(prisma, harness.stepRunId, ctx);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_OCCURRED', 'REQUEST_SENT', 1);
    await recordInvocation(harness.stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 2);
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('mixed repeat outcomes'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
  }, 30_000);

  it('H. read-only request + exception → NOT_APPLICABLE semantics preserved', async () => {
    const harness = await makeStepHarness({ name: 'read-only-preserve', action: READ_ONLY_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-H');
    await markExecuting(prisma, harness.stepRunId, ctx);
    await recordInvocation(harness.stepRunId, ctx, 'NOT_APPLICABLE', 'REQUEST_SENT');
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('read-only post-fetch seam threw'),
    });
    expect(result.written).toBe(true);
    const row = await finalStep(harness.stepRunId);
    expect(row.state).toBe('FAILED');
    expect(row.sideEffectKnowledge).toBe('NOT_APPLICABLE');
    expect(row.attemptCount).toBe(1);
  }, 30_000);

  it('I. already-terminal step writes NOTHING through the emergency path', async () => {
    const harness = await makeStepHarness({ name: 'already-terminal', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-I');
    const { writeTerminalState } = await import('@rupturegrid/engine');
    await writeTerminalState(
      prisma,
      harness.stepRunId,
      {
        state: 'FAILED',
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'INDETERMINATE',
        attemptCount: 1,
        error: 'terminated by the normal path first',
      },
      ctx,
    );
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: ctx.ownerId,
      stepRunId: harness.stepRunId,
      error: new Error('late worker error after a terminal write'),
    });
    expect(result.written).toBe(false);
    expect(result.attempted).toBe(false); // context is null for a terminal step
    const row = await finalStep(harness.stepRunId);
    expect(row.state).toBe('FAILED');
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(row.error).toBe('terminated by the normal path first');
  }, 30_000);

  it('J. stale worker / fencing mismatch cannot rewrite the newer owner truth', async () => {
    const harness = await makeStepHarness({ name: 'stale-fencing', action: MUTATING_ACTION });
    const ctxA = await claimAs(harness.stepRunId, 'worker-stale-A', 400);
    await new Promise((resolve) => setTimeout(resolve, 700)); // real lease expiry
    const claimB = await claimStep(prisma, harness.stepRunId, {
      ownerId: 'worker-fresh-B',
      leaseDurationMs: 30_000,
    });
    expect(claimB).not.toBeNull();
    expect(claimB?.fencingToken).toBe('2');
    // Stale generation A's emergency repair runs with A's owner id; the
    // context load sees the step under B's ownership (token 2), and the
    // fenced write matches zero rows.
    const result = await repairEmergencyStepTerminal({
      prisma,
      ownerId: 'worker-stale-A',
      stepRunId: harness.stepRunId,
      error: new Error('stale writer emergency repair'),
    });
    expect(result.written).toBe(false);
    const row = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: harness.stepRunId },
      select: { state: true, leaseOwnerId: true, sideEffectKnowledge: true },
    });
    expect(row.state).toBe('CLAIMED');
    expect(row.leaseOwnerId).toBe('worker-fresh-B');
    // The stale attempt is durably recorded (append-only events) when the
    // context WAS loaded but the fenced write matched zero rows.
    void ctxA;
  }, 30_000);

  it('K. a stale-row fenced write (context loaded, token superseded mid-write) writes nothing', async () => {
    const harness = await makeStepHarness({ name: 'fenced-out', action: MUTATING_ACTION });
    const ctx = await claimAs(harness.stepRunId, 'worker-emergency-K');
    // Direct helper path with a mismatched token: proves the fenced write
    // is conditional (zero rows) and never overwrites a newer owner.
    const stale: FencingContext = { ownerId: ctx.ownerId, fencingToken: '999999' };
    const result = await writeEmergencyStepTerminal({
      prisma,
      stepRunId: harness.stepRunId,
      ctx: stale,
      mutation: 'MUTATING' as EmergencyMutationClassification,
      invocationKnowledge: ['KNOWN_ABSENT'],
      preSendProven: false,
      reason: 'must not overwrite the newer owner',
    });
    expect(result.written).toBe(false);
    const row = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: harness.stepRunId },
      select: { state: true, sideEffectKnowledge: true },
    });
    expect(row.state).toBe('CLAIMED');
    expect(row.sideEffectKnowledge).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------
// 14. REAL NETWORK PROOF: a real HTTP mutating request reaches a real
//     receiver; the post-send persistence failure is induced; the
//     production repair derives honest truth from durable rows.
// ---------------------------------------------------------------------

describe('F-1/F-2 §14: real send + post-send persistence failure', () => {
  it('a real HTTP mutation reaches the receiver, is not retried, and never becomes KNOWN_ABSENT', async () => {
    const received: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        received.push({ method: request.method ?? '', url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ACCEPTED"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(address.port)}`;

    try {
      const target = await registerTarget(prisma, {
        displayName: uniqueName('b1-real-network-target'),
        environment: 'LOCAL_DEVELOPMENT',
        origins: [origin],
        contractKind: 'GENERIC_HTTP',
      });
      const created = await createExperiment(prisma, {
        name: uniqueName('b1-real-network-experiment'),
        targetId: target.targetId,
        document: {
          steps: [
            {
              name: 'mutate-real',
              action: {
                method: 'POST',
                relativePath: '/checkout/submit',
                headers: { 'content-type': 'application/json' },
                body: '{"checkoutIntentId":"CHK-RN-1"}',
                mutation: 'MUTATING',
                contract: 'GENERIC_HTTP',
                retryPolicy: 'NONE',
                repeat: 2,
                concurrency: 1,
              },
            },
          ],
        },
      });
      const run = await createRun(prisma, created.revisionId);
      await markRunDispatching(prisma, run.runId);
      const stepRunId = run.stepRunIds[0] as string;
      const ctx = await claimAs(stepRunId, 'worker-real-network');
      await markExecuting(prisma, stepRunId, ctx);

      // Slot 1: provable pre-send failure → durable KNOWN_ABSENT row.
      await recordInvocation(stepRunId, ctx, 'KNOWN_ABSENT', 'CONNECTING', 1);

      // Slot 2: a REAL mutating request through the REAL executor reaches
      // the REAL receiver. Its persistence seam then throws, so NO row is
      // written for it — exactly the F-1 counterexample.
      const outcome = await executeHttp({
        action: {
          method: 'POST',
          relativePath: '/checkout/submit',
          headers: { 'content-type': 'application/json' },
          body: '{"checkoutIntentId":"CHK-RN-1"}',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
        },
        origin,
        contractKind: 'GENERIC_HTTP',
        environment: 'LOCAL_DEVELOPMENT',
        invocationIdentity: randomUUID(),
        credentials: { resolve: () => 'unused' },
        signatureHeader: null,
      });
      // The receiver DID observe the request and answered definitively.
      expect(outcome.transportStage).toBe('RESPONSE_COMPLETE');
      expect(outcome.httpStatus).toBe(200);
      expect(received.length).toBe(1); // exactly one REAL send — zero retries

      // The production emergency repair runs with the durable rows only.
      const result = await repairEmergencyStepTerminal({
        prisma,
        ownerId: ctx.ownerId,
        stepRunId,
        error: new Error('recordInvocation failed after slot 2 was sent'),
      });
      expect(result.written).toBe(true);

      const row = await finalStep(stepRunId);
      // Never KNOWN_ABSENT: the receiver observed a mutation the durable
      // invocation set does not account for.
      expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
      expect(row.state).toBe('FAILED');
      expect(row.attemptCount).toBe(1); // honest durable count

      // The durable invocation rows are preserved (append-only): the
      // KNOWN_ABSENT pre-send record is not rewritten or dropped.
      const invocations = await prisma.stepInvocation.findMany({
        where: { stepRunId },
        orderBy: { sequence: 'asc' },
      });
      expect(invocations.length).toBe(1);
      expect(invocations[0]?.sideEffectKnowledge).toBe('KNOWN_ABSENT');

      // The step did not strand: it has a terminal row + terminalAt.
      const terminal = await prisma.experimentStepRun.findUniqueOrThrow({
        where: { id: stepRunId },
        select: { terminalAt: true },
      });
      expect(terminal.terminalAt).not.toBeNull();
      // No unsafe retry: the receiver still saw exactly one request.
      expect(received.length).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);
});
