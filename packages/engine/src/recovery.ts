// =====================================================================
// RuptureGrid v1.0 — reconciliation and recovery (ADR-0003 §9, §8)
// =====================================================================
// The reconciler is a BOUNDED, idempotent sweep over DURABLE
// predicates (never a Redis scan):
//   1. steps whose dispatch intent exists but whose BullMQ
//      coordination may be missing (DISPATCHING runs, PENDING/
//      DISPATCHED steps past any grace window)
//   2. CLAIMED/EXECUTING steps whose lease expired (owner dead)
//      — resolved conservatively: mutating steps with an in-flight
//      request become INDETERMINATE; a RECONCILE dispatch state gates
//      requeueing exactly once.
// Reconciliation NEVER creates duplicate business executions: steps
// with a live lease are invisible to it, and RECONCILE steps are
// requeued once, their state only moved by a fresh claim.

import type { PrismaClient } from '@rupturegrid/control-db';

export interface ReconcileSweepResult {
  /** Steps whose dispatch was re-attempted (caller enqueues these). */
  readonly requeue: readonly {
    readonly stepRunId: string;
    readonly runId: string;
    readonly sequence: number;
  }[];
  /** Expired-lease steps resolved to INDETERMINATE (mutating). */
  readonly resolvedIndeterminate: number;
  /** Expired-lease steps reset for requeue (provably not sent). */
  readonly resolvedRetryable: number;
  /** Runs moved to terminal state by this sweep. */
  readonly runsSettled: number;
}

/**
 * Finds dispatchable work: steps of runs in DISPATCHING (or RUNNING
 * with a failed enqueue marker) whose dispatch intent is PENDING or
 * RECONCILE, with no live lease, not terminal. Pure discovery — the
 * caller performs the enqueue and marks DISPATCHED.
 */
export async function findUndispatchedSteps(
  prisma: PrismaClient,
  limit: number,
): Promise<readonly { stepRunId: string; runId: string; sequence: number }[]> {
  return (await prisma.$queryRaw`
    SELECT s."id" AS "stepRunId", s."runId" AS "runId", s."sequence"
      FROM "control"."experiment_step_run" s
      JOIN "control"."experiment_run" r ON r."id" = s."runId"
     WHERE r."state" IN ('DISPATCHING', 'RUNNING')
       AND s."state" IN ('PENDING', 'DISPATCHED')
       AND s."dispatchState" IN ('PENDING', 'RECONCILE')
       AND (s."leaseOwnerId" IS NULL OR s."leaseExpiresAt" < "statement_timestamp"())
       AND (s."lastDispatchError" IS NULL OR s."lastDispatchError" <> 'enqueue-pending')
       -- Ordered-step dependency: never re-dispatch past a step that
       -- is not SUCCEEDED yet (only the current frontier may run).
       AND NOT EXISTS (
         SELECT 1 FROM "control"."experiment_step_run" prior
          WHERE prior."runId" = s."runId"
            AND prior."sequence" < s."sequence"
            AND prior."state" <> 'SUCCEEDED'
       )
     ORDER BY s."createdAt"
     LIMIT ${limit}
  `) as Array<{ stepRunId: string; runId: string; sequence: number }>;
}

/**
 * Resolves an expired lease. Classification is CONSERVATIVE
 * (architecture §7.1, ADR-0008): without executor knowledge the
 * mutating request MAY have been sent — the recovery record is
 * INDETERMINATE, the step FAILED, and it is NOT retried.
 * For steps whose transport stage proves the request was never sent
 * (or read-only steps), the step is reset to PENDING for requeue.
 * Returns 'indeterminate' | 'requeue' | null (already re-owned).
 */
export async function resolveExpiredLease(
  prisma: PrismaClient,
  stepRunId: string,
  mutationClassification: 'READ_ONLY' | 'MUTATING',
  maybeSent: boolean,
): Promise<'indeterminate' | 'requeue' | null> {
  return prisma.$transaction(async (tx) => {
    const step = await tx.experimentStepRun.findFirst({
      where: {
        id: stepRunId,
        state: { in: ['CLAIMED', 'EXECUTING'] },
      },
      select: { id: true, leaseExpiresAt: true, attemptCount: true },
    });
    if (step === null) {
      return null; // Already terminal or re-owned by a fresh claim.
    }
    // Only resolve if the lease REALLY expired in DATABASE time.
    const expired = (await tx.$queryRaw`
      SELECT ("leaseExpiresAt" < "statement_timestamp"()) AS ok
        FROM "control"."experiment_step_run"
       WHERE "id" = ${stepRunId}::uuid
    `) as Array<{ ok: boolean }>;
    if (expired[0]?.ok !== true) {
      return null; // A heartbeat renewed it; live lease — invisible.
    }

    if (mutationClassification === 'MUTATING' && maybeSent) {
      await tx.experimentStepRun.update({
        where: { id: stepRunId },
        data: {
          state: 'FAILED',
          intentOutcome: 'FAILED',
          sideEffectKnowledge: 'INDETERMINATE',
          error: 'lease expired mid-flight; mutation outcome not safely known (ADR-0008)',
          terminalAt: new Date(),
        },
      });
      return 'indeterminate';
    }
    // Read-only, or provably pre-send: safe to hand to another owner.
    await tx.experimentStepRun.update({
      where: { id: stepRunId },
      data: {
        state: 'PENDING',
        leaseOwnerId: null,
        leaseExpiresAt: null,
        dispatchState: 'RECONCILE',
      },
    });
    return 'requeue';
  });
}

/**
 * Settles runs whose step execution semantics are settled:
 *   - every step terminal AND no failure   → COMPLETED
 *   - some step FAILED/CANCELLED           → remaining PENDING steps
 *     are CANCELLED (their dependency can never SUCCEED now — the
 *     ordered claim guard blocks them forever), then the run FAILED.
 * Conditional predicate: only RUNNING runs are touched, and a run with
 * an actively CLAIMED/EXECUTING step is never settled (§38: no
 * terminal run while step execution is active or ambiguous).
 * Returns the number of runs settled.
 */
export async function settleRuns(prisma: PrismaClient, limit: number): Promise<number> {
  const runs = (await prisma.$queryRaw`
    SELECT r."id",
           EXISTS (
             SELECT 1 FROM "control"."experiment_step_run" s
              WHERE s."runId" = r."id" AND s."state" IN ('FAILED', 'CANCELLED')
           ) AS has_failure,
           EXISTS (
             SELECT 1 FROM "control"."experiment_step_run" s
              WHERE s."runId" = r."id" AND s."state" IN ('PENDING', 'DISPATCHED', 'CLAIMED', 'EXECUTING')
           ) AS has_open
      FROM "control"."experiment_run" r
     WHERE r."state" = 'RUNNING'
       AND EXISTS (
         SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id"
       )
       AND NOT EXISTS (
         SELECT 1 FROM "control"."experiment_step_run" s
          WHERE s."runId" = r."id" AND s."state" IN ('CLAIMED', 'EXECUTING')
       )
       AND (
         NOT EXISTS (
           SELECT 1 FROM "control"."experiment_step_run" s
            WHERE s."runId" = r."id" AND s."state" IN ('PENDING', 'DISPATCHED')
         )
         OR EXISTS (
           SELECT 1 FROM "control"."experiment_step_run" s
            WHERE s."runId" = r."id" AND s."state" IN ('FAILED', 'CANCELLED')
         )
       )
     LIMIT ${limit}
  `) as Array<{ id: string; has_failure: boolean; has_open: boolean }>;
  let settled = 0;
  for (const run of runs) {
    if (run.has_failure && run.has_open) {
      // Steps blocked behind a failure can never execute: close them
      // honestly as CANCELLED with KNOWN_ABSENT (never sent).
      await prisma.experimentStepRun.updateMany({
        where: { runId: run.id, state: { in: ['PENDING', 'DISPATCHED'] } },
        data: {
          state: 'CANCELLED',
          intentOutcome: 'CANCELLED',
          sideEffectKnowledge: 'KNOWN_ABSENT',
          terminalAt: new Date(),
          error: 'dependency step failed; ordered execution stopped before this step',
        },
      });
    }
    const failed = await prisma.experimentStepRun.count({
      where: { runId: run.id, state: { in: ['FAILED', 'CANCELLED'] } },
    });
    const indeterminate = await prisma.stepInvocation.count({
      where: { stepRun: { runId: run.id }, sideEffectKnowledge: 'INDETERMINATE' },
    });
    const reason =
      failed > 0
        ? `${failed} step(s) did not succeed${indeterminate > 0 ? `; ${indeterminate} invocation(s) INDETERMINATE` : ''}`
        : null;
    const updated = await prisma.experimentRun.updateMany({
      where: { id: run.id, state: 'RUNNING' },
      data: {
        state: failed > 0 ? 'FAILED' : 'COMPLETED',
        terminalAt: new Date(),
        ...(reason === null ? {} : { failureReason: reason }),
      },
    });
    settled += updated.count;
  }
  return settled;
}

/**
 * Settles a cancelled run: marks all non-terminal steps CANCELLED
 * (KNOWN_ABSENT — never dispatched to the target), then the run
 * CANCELLED. Idempotent.
 */
export async function settleCancelledRun(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.experimentStepRun.updateMany({
      where: {
        runId,
        state: { in: ['PENDING', 'DISPATCHED', 'CLAIMED', 'EXECUTING'] },
      },
      data: {
        state: 'CANCELLED',
        intentOutcome: 'CANCELLED',
        sideEffectKnowledge: 'KNOWN_ABSENT',
        terminalAt: new Date(),
        error: 'run cancelled before execution reached this step',
      },
    });
    await tx.experimentRun.updateMany({
      where: { id: runId, state: { in: ['CREATED', 'SNAPSHOT_PINNED', 'DISPATCHING', 'RUNNING'] } },
      data: { state: 'CANCELLED', terminalAt: new Date() },
    });
  });
}
