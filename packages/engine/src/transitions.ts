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

export interface FencingContext {
  readonly ownerId: string;
  readonly fencingToken: string;
}

/** Marks the step EXECUTING (from CLAIMED), fenced. */
export async function markExecuting(
  prisma: PrismaClient,
  stepRunId: string,
  ctx: FencingContext,
): Promise<void> {
  const count = await prisma.experimentStepRun.updateMany({
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
    await recordStaleWriter(
      prisma,
      stepRunId,
      ctx,
      'mark-executing (not owner/token, or step not CLAIMED)',
    );
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
  const maxAttempts = 64;
  let sequence = record.sequence;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const created = await prisma.stepInvocation.create({
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
      return { invocationId: created.id, sequence: created.sequence };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const lastAttempt = attempt === maxAttempts - 1;
      if (code !== 'P2002' || lastAttempt) {
        throw error;
      }
      const current = await prisma.stepInvocation.aggregate({
        where: { stepRunId },
        _max: { sequence: true },
      });
      sequence = (current._max.sequence ?? 0) + 1;
    }
  }
  // Unreachable: the bounded loop above returns or throws. Satisfies
  // the compiler for the no-implicit-return rule without fabricating a
  // record.
  throw new Error('recordInvocation: exhausted bounded sequence-allocation retries');
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
  const count = await prisma.experimentStepRun.updateMany({
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
    await recordStaleWriter(prisma, stepRunId, ctx, `terminal ${write.state}`);
    throw new LeaseLostError(stepRunId, ctx.ownerId);
  }
  return 'written';
}

/** Records a stale-writer attempt durably (append-only). */
export async function recordStaleWriter(
  prisma: PrismaClient,
  stepRunId: string,
  ctx: FencingContext,
  detail: string,
): Promise<void> {
  await prisma.staleWriterEvent.create({
    data: {
      stepRunId,
      attemptedBy: ctx.ownerId,
      fencingToken: BigInt(ctx.fencingToken),
      detail: detail.slice(0, 500),
    },
  });
}
