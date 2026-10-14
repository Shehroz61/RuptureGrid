// =====================================================================
// RuptureGrid v1.0 — fenced state transitions (ADR-0009, §8, §10)
// =====================================================================
// Every worker-generation state write is CONDITIONAL on
// (owner, fencing token) and rejects:
//   - writes from a superseded generation (stale writer → 0 rows)
//   - resurrection of terminal states (write-once terminals)
// A zero-row result is a LeaseLostError for the caller. Stale-writer
// attempts are recorded durably (stale_writer_event) — recorded
// reality, never silently discarded.

import type { PrismaClient, SideEffectKnowledge, IntentOutcome } from '@rupturegrid/control-db';
import { LeaseLostError } from './claim.js';
import {
  acquireRunLock,
  advanceProvenanceRevision,
  resolveRunIdOfStep,
  PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  PROVENANCE_TRANSACTION_TIMEOUT_MS,
  type RunLockedTx,
} from './truth-input-head.js';

export interface FencingContext {
  readonly ownerId: string;
  readonly fencingToken: string;
}

/** The provenance-writer transaction bounds (bounded lock/statement hold). */
const PROVENANCE_TX = {
  timeout: PROVENANCE_TRANSACTION_TIMEOUT_MS,
  maxWait: PROVENANCE_TRANSACTION_MAX_WAIT_MS,
} as const;

/**
 * Marks the step EXECUTING (from CLAIMED), fenced. The guarded state
 * write and the `P` revision advance commit in ONE transaction under the
 * shared per-run advisory lock (ADR-0026 §13 writer protocol). A rejected
 * transition (0 rows) changes no step state; its durably-recorded
 * `stale_writer_event` is itself a truth-bearing row, so `P` still
 * advances exactly once — never as if the state write had succeeded.
 */
export async function markExecuting(
  prisma: PrismaClient,
  stepRunId: string,
  ctx: FencingContext,
): Promise<void> {
  const runId = await resolveRunIdOfStep(prisma, stepRunId);
  const rejected = await prisma.$transaction(async (tx) => {
    if (runId !== null) {
      await acquireRunLock(tx, runId);
    }
    const count = await tx.experimentStepRun.updateMany({
      where: {
        id: stepRunId,
        leaseOwnerId: ctx.ownerId,
        fencingToken: BigInt(ctx.fencingToken),
        state: 'CLAIMED',
      },
      data: { state: 'EXECUTING', executingAt: new Date() },
    });
    if (count.count === 0) {
      // A rejected transition is recorded reality (architecture §10):
      // the attempt happened; the authoritative state was NOT changed.
      await recordStaleWriterInTx(
        tx,
        stepRunId,
        ctx,
        'mark-executing (not owner/token, or step not CLAIMED)',
      );
      if (runId !== null) {
        await advanceProvenanceRevision(tx, runId);
      }
      return true;
    }
    if (runId !== null) {
      await advanceProvenanceRevision(tx, runId);
    }
    return false;
  }, PROVENANCE_TX);
  if (rejected) {
    throw new LeaseLostError(stepRunId, ctx.ownerId);
  }
}

export interface InvocationRecord {
  readonly sequence: number;
  readonly waveIndex: number;
  readonly invocationIdentity: string | null;
  readonly transportStage: string | null;
  readonly httpStatus: number | null;
  readonly requestBytes: number | null;
  readonly responseBytes: number | null;
  readonly responseBody: string | null;
  readonly durationMs: number | null;
  readonly outcome: IntentOutcome;
  readonly sideEffectKnowledge: SideEffectKnowledge;
  readonly error: string | null;
}

/**
 * Appends one physical invocation record. Invocation rows are honest
 * records of what the writer generation observed (architecture §10:
 * attributed to the invocation and writer; append-only, never
 * rewritten or dropped). The write itself is NOT fenced — a stale
 * worker still genuinely observed what it observed — but it carries
 * the writer identity so analysis can attribute or discount it.
 *
 * Cross-generation recovery: a prior generation may already have
 * recorded an invocation for the same planned slot (crash after the
 * invocation, before the terminal write). Those rows are honest
 * records and are never deleted, so the (stepRunId, sequence) unique
 * key disambiguates by allocating the next free sequence for the step
 * (bounded retries; concurrent slots converge because each conflict
 * re-reads the current maximum).
 */
export interface RecordedInvocation {
  /** The created StepInvocation row's durable id (evidence linkage). */
  readonly invocationId: string;
  /** The sequence ACTUALLY used (may differ from the planned one). */
  readonly sequence: number;
}

export async function recordInvocation(
  prisma: PrismaClient,
  stepRunId: string,
  record: InvocationRecord,
  ctx: FencingContext,
): Promise<RecordedInvocation> {
  const runId = await resolveRunIdOfStep(prisma, stepRunId);
  const maxAttempts = 64;
  // ONE transaction: the per-run advisory lock (so concurrent invocation
  // writers and evidence appenders serialize), the attributed row, and
  // the `P` advance — or nothing at all (ADR-0026 §13). The post-send
  // send itself already happened outside this transaction; the lock is
  // never held across network I/O.
  return prisma.$transaction(async (tx) => {
    if (runId !== null) {
      await acquireRunLock(tx, runId);
    }
    let sequence = record.sequence;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Pre-check the (stepRunId, sequence) slot rather than relying on a
      // raised unique violation: under PostgreSQL a failed statement
      // aborts the whole transaction, so the retry must be a lookup. The
      // per-run lock makes this check reliable (no concurrent writer for
      // this run can be allocating slots at the same time).
      const occupied = await tx.stepInvocation.findUnique({
        where: { stepRunId_sequence: { stepRunId, sequence } },
        select: { id: true },
      });
      if (occupied !== null) {
        const current = await tx.stepInvocation.aggregate({
          where: { stepRunId },
          _max: { sequence: true },
        });
        sequence = (current._max.sequence ?? 0) + 1;
        continue;
      }
      const created = await tx.stepInvocation.create({
        data: {
          stepRunId,
          sequence,
          waveIndex: record.waveIndex,
          invocationIdentity: record.invocationIdentity,
          transportStage: record.transportStage as never,
          httpStatus: record.httpStatus,
          requestBytes: record.requestBytes,
          responseBytes: record.responseBytes,
          responseBody: record.responseBody,
          durationMs: record.durationMs,
          outcome: record.outcome,
          sideEffectKnowledge: record.sideEffectKnowledge,
          error: record.error === null ? null : record.error.slice(0, 500),
          writtenByOwner: ctx.ownerId,
          writtenByFencingToken: BigInt(ctx.fencingToken),
        },
        select: { id: true, sequence: true },
      });
      if (runId !== null) {
        await advanceProvenanceRevision(tx, runId);
      }
      return { invocationId: created.id, sequence: created.sequence };
    }
    // Unreachable under the bound: the loop above returns or the bounded
    // allocation keep hitting occupied slots. Never fabricate a record.
    throw new Error('recordInvocation: exhausted bounded sequence-allocation retries');
  }, PROVENANCE_TX);
}

export interface TerminalWrite {
  readonly state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly intentOutcome: IntentOutcome;
  readonly sideEffectKnowledge: SideEffectKnowledge;
  readonly attemptCount: number;
  readonly error: string | null;
}

/**
 * Writes the terminal step state ONCE, fenced on owner+token and
 * rejected for any already-terminal step (write-once terminals).
 * A zero-row update means the caller was stale, the step was taken
 * over, or was already terminal → LeaseLostError (and the stale
 * attempt is recorded).
 */
export async function writeTerminalState(
  prisma: PrismaClient,
  stepRunId: string,
  write: TerminalWrite,
  ctx: FencingContext,
): Promise<'written' | 'stale-writer'> {
  const runId = await resolveRunIdOfStep(prisma, stepRunId);
  const rejected = await prisma.$transaction(async (tx) => {
    if (runId !== null) {
      await acquireRunLock(tx, runId);
    }
    const count = await tx.experimentStepRun.updateMany({
      where: {
        id: stepRunId,
        leaseOwnerId: ctx.ownerId,
        fencingToken: BigInt(ctx.fencingToken),
        state: { in: ['CLAIMED', 'EXECUTING'] },
      },
      data: {
        state: write.state,
        intentOutcome: write.intentOutcome,
        sideEffectKnowledge: write.sideEffectKnowledge,
        attemptCount: write.attemptCount,
        error: write.error === null ? null : write.error.slice(0, 500),
        terminalAt: new Date(),
      },
    });
    if (count.count === 0) {
      // Rejected: no terminal truth changed. The durably-recorded stale
      // attempt is the only truth-bearing row, so `P` advances exactly
      // once (never as if the terminal write had succeeded).
      await recordStaleWriterInTx(tx, stepRunId, ctx, `terminal ${write.state}`);
      if (runId !== null) {
        await advanceProvenanceRevision(tx, runId);
      }
      return true;
    }
    if (runId !== null) {
      await advanceProvenanceRevision(tx, runId);
    }
    return false;
  }, PROVENANCE_TX);
  if (rejected) {
    throw new LeaseLostError(stepRunId, ctx.ownerId);
  }
  return 'written';
}

/** Records a stale-writer attempt durably (append-only), advancing `P`. */
export async function recordStaleWriter(
  prisma: PrismaClient,
  stepRunId: string,
  ctx: FencingContext,
  detail: string,
): Promise<void> {
  const runId = await resolveRunIdOfStep(prisma, stepRunId);
  await prisma.$transaction(async (tx) => {
    if (runId !== null) {
      await acquireRunLock(tx, runId);
    }
    await recordStaleWriterInTx(tx, stepRunId, ctx, detail);
    if (runId !== null) {
      await advanceProvenanceRevision(tx, runId);
    }
  }, PROVENANCE_TX);
}

/**
 * The in-transaction stale-writer record (append-only). Callers that
 * already hold the per-run lock reuse their transaction rather than
 * nesting a second Prisma transaction.
 */
async function recordStaleWriterInTx(
  tx: RunLockedTx & {
    staleWriterEvent: { create(args: unknown): Promise<unknown> };
  },
  stepRunId: string,
  ctx: FencingContext,
  detail: string,
): Promise<void> {
  await tx.staleWriterEvent.create({
    data: {
      stepRunId,
      attemptedBy: ctx.ownerId,
      fencingToken: BigInt(ctx.fencingToken),
      detail: detail.slice(0, 500),
    },
  });
}
