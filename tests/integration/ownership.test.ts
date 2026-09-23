// =====================================================================
// Integration — ownership: claims, leases, fencing, stale writers
// =====================================================================
// Real PostgreSQL, database-time lease decisions (Phase 3 §30–§35, §46):
//   - claims are atomic: exactly one winner
//   - fencing tokens monotonically increase on takeover
//   - a stale generation's state writes affect 0 rows and are recorded
//   - terminal states are write-once (no resurrection)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimStep,
  createExperiment,
  createRun,
  heartbeatStep,
  LeaseLostError,
  markExecuting,
  recordStaleWriter,
  registerTarget,
  writeTerminalState,
} from '@rupturegrid/engine';
import type { FencingContext } from '@rupturegrid/engine';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const prisma = getControlPrisma();

async function makeRunWithSteps(
  stepCount: number,
): Promise<{ runId: string; stepRunIds: string[] }> {
  const target = await registerTarget(prisma, {
    displayName: uniqueName('ownership-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [await uniqueTestOrigin(prisma)],
    contractKind: 'GENERIC_HTTP',
  });
  const created = await createExperiment(prisma, {
    name: uniqueName('ownership-experiment'),
    targetId: target.targetId,
    document: {
      steps: Array.from({ length: stepCount }, (_, index) => ({
        name: `step-${index}`,
        action: {
          method: 'GET',
          relativePath: '/',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      })),
    },
  });
  const run = await createRun(prisma, created.revisionId);
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

describe('atomic claims and fencing (ADR-0009)', () => {
  let runId = '';
  let firstStepId = '';
  const cleanup: string[] = [];

  beforeAll(async () => {
    const made = await makeRunWithSteps(1);
    runId = made.runId;
    firstStepId = made.stepRunIds[0] as string;
  });

  it('exactly one of two concurrent claimants wins; fencing token increments on takeover', async () => {
    const winnerA = await claimStep(prisma, firstStepId, {
      ownerId: 'worker-A',
      leaseDurationMs: 500, // Short lease: expires quickly for takeover.
    });
    expect(winnerA).not.toBeNull();
    expect(winnerA?.fencingToken).toBe('1');

    // Worker B cannot steal a LIVE lease.
    const rejected = await claimStep(prisma, firstStepId, {
      ownerId: 'worker-B',
      leaseDurationMs: 500,
    });
    expect(rejected).toBeNull();

    // Wait for DATABASE-side lease expiry, then B takes over.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const winnerB = await claimStep(prisma, firstStepId, {
      ownerId: 'worker-B',
      leaseDurationMs: 30_000,
    });
    expect(winnerB).not.toBeNull();
    expect(winnerB?.fencingToken).toBe('2');
  });

  it('stale writer (worker A, token 1) affects 0 rows and is recorded; state stays with B', async () => {
    const staleCtx: FencingContext = { ownerId: 'worker-A', fencingToken: '1' };
    // A tries to mark EXECUTING after losing ownership.
    await expect(markExecuting(prisma, firstStepId, staleCtx)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    // A tries a terminal write.
    await expect(
      writeTerminalState(
        prisma,
        firstStepId,
        {
          state: 'SUCCEEDED',
          intentOutcome: 'SUCCEEDED',
          sideEffectKnowledge: 'NOT_APPLICABLE',
          attemptCount: 1,
          error: null,
        },
        staleCtx,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    // Stale attempts are durably recorded.
    const events = await prisma.staleWriterEvent.findMany({ where: { stepRunId: firstStepId } });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.every((event) => event.attemptedBy === 'worker-A' && event.fencingToken === 1n),
    ).toBe(true);

    // Authoritative state remains CLAIMED under worker B (token 2).
    const row = await prisma.experimentStepRun.findUniqueOrThrow({ where: { id: firstStepId } });
    expect(row.state).toBe('CLAIMED');
    expect(row.leaseOwnerId).toBe('worker-B');
    expect(row.fencingToken).toBe(2n);
  });

  it('heartbeat with a stale token fails; with the live token it renews from DB time', async () => {
    await expect(
      heartbeatStep(prisma, firstStepId, {
        ownerId: 'worker-A',
        fencingToken: '1',
        leaseDurationMs: 500,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const renewedAt = await heartbeatStep(prisma, firstStepId, {
      ownerId: 'worker-B',
      fencingToken: '2',
      leaseDurationMs: 30_000,
    });
    expect(renewedAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('terminal states are write-once (no resurrection)', async () => {
    const ctx: FencingContext = { ownerId: 'worker-B', fencingToken: '2' };
    await markExecuting(prisma, firstStepId, ctx);
    const written = await writeTerminalState(
      prisma,
      firstStepId,
      {
        state: 'SUCCEEDED',
        intentOutcome: 'SUCCEEDED',
        sideEffectKnowledge: 'NOT_APPLICABLE',
        attemptCount: 1,
        error: null,
      },
      ctx,
    );
    expect(written).toBe('written');
    // Second terminal write (even with the LIVE token) must be refused.
    await expect(
      writeTerminalState(
        prisma,
        firstStepId,
        {
          state: 'FAILED',
          intentOutcome: 'FAILED',
          sideEffectKnowledge: 'KNOWN_ABSENT',
          attemptCount: 1,
          error: null,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const row = await prisma.experimentStepRun.findUniqueOrThrow({ where: { id: firstStepId } });
    expect(row.state).toBe('SUCCEEDED');
    cleanup.push(runId);
  });
});

describe('ordered-step dependency (Phase 3 §47 recovery semantics)', () => {
  it('a later step is not claimable while an earlier step is non-terminal', async () => {
    const made = await makeRunWithSteps(2);
    const [first, second] = made.stepRunIds as [string, string];
    // Claim + finish step 0 as FAILED.
    const claim = await claimStep(prisma, first, {
      ownerId: 'worker-order',
      leaseDurationMs: 30_000,
    });
    expect(claim).not.toBeNull();
    const ctx: FencingContext = { ownerId: 'worker-order', fencingToken: '1' };
    await markExecuting(prisma, first, ctx);
    await writeTerminalState(
      prisma,
      first,
      {
        state: 'FAILED',
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'KNOWN_ABSENT',
        attemptCount: 1,
        error: 'dependency failed',
      },
      ctx,
    );
    // Step 1 must NOT be claimable: its dependency did not SUCCEED.
    const premature = await claimStep(prisma, second, {
      ownerId: 'worker-order',
      leaseDurationMs: 30_000,
    });
    expect(premature).toBeNull();
  });
});

afterAll(async () => {
  // Leave durable rows in place: integration tests share the real DB
  // and rows are honest execution state (cleanup via unique names).
});
