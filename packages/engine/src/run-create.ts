// =====================================================================
// RuptureGrid v1.0 — durable run creation
// =====================================================================
// One transaction creates: the run (CREATED), the frozen snapshot pin
// (SNAPSHOT_PINNED), one step row per snapshot step (PENDING, dispatch
// PENDING), and the dispatch intent. If BullMQ is unreachable the
// transaction has ALREADY COMMITTED — the run stays DISPATCHING in
// PostgreSQL and the reconciler recovers it (ADR-0003 §9; Phase 3 §40).
// Production-classified targets are DENIED at creation (ADR-0011).

import type { PrismaClient } from '@rupturegrid/control-db';
import type { TargetEnvironment } from '@rupturegrid/shared';
import type { RunSnapshotDocument } from './types.js';
import { freezeSnapshot } from './snapshot.js';
import type { FrozenSnapshot } from './snapshot.js';

export class RunCreationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunCreationError';
  }
}

export interface CreatedRun {
  readonly runId: string;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly stepRunIds: readonly string[];
}

/**
 * Creates a durable run from an experiment revision:
 *   1. freeze/pin the snapshot (content-addressed, immutable)
 *   2. enforce environment authorization (production DENIED in v1)
 *   3. insert run + step rows in ONE transaction
 * The run ends in SNAPSHOT_PINNED with all steps PENDING/PENDING.
 * Dispatch intent is durable by construction (the step rows exist);
 * marking DISPATCHING and enqueueing are the caller's next step.
 */
export async function createRun(prisma: PrismaClient, revisionId: string): Promise<CreatedRun> {
  const frozen: FrozenSnapshot = await freezeSnapshot(prisma, revisionId);
  const document = frozen.document;

  // Environment authorization at run creation (ADR-0011). Enforced
  // again by the worker before execution (defense in depth).
  const environment: TargetEnvironment = document.target.environment;
  if (environment === 'PRODUCTION') {
    throw new RunCreationError(
      'production-classified targets are denied for experiment execution in v1 (ADR-0011)',
    );
  }

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.experimentRun.create({
      data: {
        snapshotId: frozen.snapshotId,
        state: 'SNAPSHOT_PINNED',
      },
    });
    await tx.experimentStepRun.createMany({
      data: document.steps.map((step, sequence) => ({
        runId: run.id,
        sequence,
        name: step.name,
        state: 'PENDING',
        dispatchState: 'PENDING',
      })),
    });
    return run.id;
  });

  const stepRuns = await prisma.experimentStepRun.findMany({
    where: { runId },
    orderBy: { sequence: 'asc' },
    select: { id: true },
  });

  return {
    runId,
    snapshotId: frozen.snapshotId,
    contentHash: frozen.contentHash,
    stepRunIds: stepRuns.map((step) => step.id),
  };
}

/**
 * Marks the run DISPATCHING durably. Called before enqueueing; on
 * enqueue failure the run REMAINS here and reconciliation recovers.
 */
export async function markRunDispatching(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.experimentRun.updateMany({
    where: { id: runId, state: 'SNAPSHOT_PINNED' },
    data: { state: 'DISPATCHING' },
  });
}

/** Loads a snapshot document by run id (worker-side authoritative load). */
export async function loadRunSnapshot(
  prisma: PrismaClient,
  runId: string,
): Promise<{
  run: { id: string; state: string; cancelRequestedAt: Date | null };
  document: RunSnapshotDocument;
  contentHash: string;
}> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    include: { snapshot: true },
  });
  if (run === null) {
    throw new RunCreationError(`run ${runId} does not exist`);
  }
  const document = run.snapshot.content as unknown as RunSnapshotDocument;
  return {
    run: { id: run.id, state: run.state, cancelRequestedAt: run.cancelRequestedAt },
    document,
    contentHash: run.snapshot.contentHash,
  };
}
