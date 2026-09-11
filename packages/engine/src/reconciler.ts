// =====================================================================
// RuptureGrid v1.0 — reconciler service (bounded, idempotent)
// =====================================================================
// Wraps recovery.ts primitives in a bounded sweep suitable for a
// background loop (Phase 3 §41): discover durable undispatched work,
// hand it to the caller for enqueueing, settle finished runs, and
// resolve expired leases conservatively. Idempotency: discovery is a
// pure DB predicate; enqueueing is idempotent (deterministic jobId);
// terminal writes are write-once. Running it twice cannot create
// duplicate business executions.

import type { PrismaClient } from '@rupturegrid/control-db';
import { findUndispatchedSteps, settleRuns, resolveExpiredLease } from './recovery.js';

export interface ReconcilerSweepDeps {
  readonly prisma: PrismaClient;
  /** Batch sizes for one sweep (bounded work per tick). */
  readonly dispatchBatch: number;
  readonly settleBatch: number;
  readonly leaseRecoveryBatch: number;
  /** Called by the sweep for each step that should be (re)enqueued. */
  readonly enqueue: (stepRunId: string, runId: string, sequence: number) => Promise<void>;
}

export interface SweepResult {
  readonly requeued: number;
  readonly settled: number;
  readonly leaseRecoveries: number;
}

/**
 * Runs ONE bounded reconciliation sweep. Steps found undispatched are
 * enqueued through the provided callback; the durable dispatch marker
 * flips to DISPATCHED only after a successful enqueue (the caller's
 * responsibility, via markDispatched below).
 */
export async function runReconcileSweep(deps: ReconcilerSweepDeps): Promise<SweepResult> {
  const { prisma } = deps;
  let requeued = 0;

  const steps = await findUndispatchedSteps(prisma, deps.dispatchBatch);
  for (const step of steps) {
    try {
      await deps.enqueue(step.stepRunId, step.runId, step.sequence);
      await prisma.experimentStepRun.updateMany({
        where: {
          id: step.stepRunId,
          dispatchState: { in: ['PENDING', 'RECONCILE'] },
          state: { in: ['PENDING', 'DISPATCHED'] },
        },
        data: {
          dispatchState: 'DISPATCHED',
          dispatchedAt: new Date(),
          lastDispatchError: null,
        },
      });
      requeued += 1;
    } catch (error) {
      await prisma.experimentStepRun.updateMany({
        where: { id: step.stepRunId, dispatchState: { in: ['PENDING', 'RECONCILE'] } },
        data: {
          lastDispatchError:
            error instanceof Error ? error.message.slice(0, 500) : 'enqueue failed',
        },
      });
    }
  }

  const settled = await settleRuns(prisma, deps.settleBatch);
  return { requeued, settled, leaseRecoveries: 0 };
}

/**
 * Resolves expired leases for the given step ids with the supplied
 * classification knowledge. Called by the worker's reconcile loop
 * AFTER dispatch recovery, bounded by leaseRecoveryBatch.
 */
export async function reconcileExpiredLeases(
  prisma: PrismaClient,
  batch: number,
): Promise<{ indeterminate: number; requeue: number }> {
  const expired = (await prisma.$queryRaw`
    SELECT s."id",
           s."name"
      FROM "control"."experiment_step_run" s
     WHERE s."state" IN ('CLAIMED', 'EXECUTING')
       AND s."leaseExpiresAt" < "statement_timestamp"()
     LIMIT ${batch}
  `) as Array<{ id: string; name: string }>;
  let indeterminate = 0;
  let requeue = 0;
  for (const step of expired) {
    // Phase 3 executor knowledge: if the executor recorded any
    // REQUEST_SENT-or-later invocation for this step, the mutation MAY
    // have reached the target. Without a stored invocation stage we
    // conservatively assume the ambiguous case for MUTATING steps.
    const sentInvocation = await prisma.stepInvocation.findFirst({
      where: {
        stepRunId: step.id,
        transportStage: { in: ['REQUEST_SENT', 'RESPONSE_HEADERS', 'RESPONSE_COMPLETE'] },
      },
      select: { id: true },
    });
    const stepRow = await prisma.experimentStepRun.findUnique({
      where: { id: step.id },
      select: { name: true },
    });
    const mutating = await isMutatingStep(prisma, step.id);
    void stepRow;
    const result = await resolveExpiredLease(
      prisma,
      step.id,
      mutating ? 'MUTATING' : 'READ_ONLY',
      mutating && sentInvocation !== null ? true : mutating,
    );
    if (result === 'indeterminate') {
      indeterminate += 1;
    } else if (result === 'requeue') {
      requeue += 1;
    }
  }
  return { indeterminate, requeue };
}

/**
 * Reads the mutation classification from the run's snapshot for the
 * step. The snapshot is the frozen authority (ADR-0010).
 */
async function isMutatingStep(prisma: PrismaClient, stepRunId: string): Promise<boolean> {
  const row = (await prisma.$queryRaw`
    SELECT rs."content" AS steps, s."sequence"
      FROM "control"."experiment_step_run" s
      JOIN "control"."experiment_run" r ON r."id" = s."runId"
      JOIN "control"."run_snapshot" rs ON rs."id" = r."snapshotId"
     WHERE s."id" = ${stepRunId}::uuid
  `) as Array<{ steps: unknown; sequence: number }>;
  const row0 = row[0];
  if (row0 === undefined) {
    return true; // Conservative default.
  }
  const doc = row0.steps as { steps?: Array<{ action?: { mutation?: string } }> };
  const step = doc.steps?.[row0.sequence];
  return step?.action?.mutation !== 'READ_ONLY';
}
