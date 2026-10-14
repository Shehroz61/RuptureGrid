// =====================================================================
// RuptureGrid v1.0 — Phase 17 B1 emergency step-truth derivation
// (ADR-0008 §7.1, ADR-0009 §10, architecture §7)
// =====================================================================
// A `processJob`-level exception can escape `StepProcessor.processStep`
// while the step is CLAIMED/EXECUTING. The worker must still terminate
// the step durably (no hang; the lease sweep stays the safety net), but
// the terminal `sideEffectKnowledge` must be DERIVED FROM DURABLE
// INVOCATION TRUTH — never asserted KNOWN_ABSENT merely because an
// exception was thrown (Phase 17 audit finding B1 —
// WORKER-POST-SEND-KNOWN-ABSENT: the old catch blanket-wrote
// KNOWN_ABSENT on every exception while CLAIMED/EXECUTING, so a
// mutating request that DID cross the send boundary was falsified).
//
// Final-audit repair F-1 (a second, deeper defect in the first repair):
// a persisted invocation set is NOT a closed world. `recordInvocation`
// runs AFTER the physical send; when it throws (post-send persistence
// failure), the sent attempt has NO row. So "every persisted row is
// KNOWN_ABSENT" does NOT prove "every attempted mutation was
// KNOWN_ABSENT". The counterexample: `repeat = 2`, slot 1 recorded
// KNOWN_ABSENT (pre-send), slot 2 SENT but its `recordInvocation`
// threw before persistence — the old derivation read the single
// KNOWN_ABSENT row and falsified the step as KNOWN_ABSENT.
//
// Frozen rules (R-02/R-03; final-audit mandate §4–§8 — one truth model):
//   - KNOWN_ABSENT is claimable ONLY from an INDEPENDENT, durable proof
//     that the step never crossed the send boundary. The proof the
//     platform actually has is `experiment_step_run.executingAt IS NULL`:
//     `markExecuting` (which stamps `executingAt`) runs BEFORE any
//     request is prepared, and no state-write ever clears it, so a null
//     value proves no action request was ever prepared for this step.
//   - A persisted invocation row set (partial OR coincidentally equal to
//     `repeat`) is NEVER such a proof — an unpersisted send may exist.
//     Absence of a row is never proof of absence of a send.
//   - a KNOWN_OCCURRED or INDETERMINATE invocation is NEVER downgraded
//     on the step row: post-send uncertainty stays INDETERMINATE — the
//     same dominance the accepted wave aggregation applies (an
//     INDETERMINATE outcome dominates the aggregate), not a new
//     precedence system.
//   - READ_ONLY actions keep the platform's established NOT_APPLICABLE
//     semantics (no new enum invented).
//   - attemptCount is the honest durable invocation count; 0 only when
//     no row exists. For a mutating step whose send-boundary position is
//     unknown (executingAt stamped, or zero recorded attempts), the
//     conservative aggregate is INDETERMINATE — the same conclusion the
//     lease sweep would reach, never a fabricated KNOWN_ABSENT.
//
// Invocation rows carry writer provenance, but their side-effect facts
// are honest per-writer records (ADR-0009 §10): fencing governs durable
// STATE, not recorded reality, so ALL invocations of the affected step
// are inputs here.
//
// The emergency write itself is fencing-safe: it persists through the
// same owner-token-conditional write-once predicate as every other
// terminal state write. A zero-row result (already-terminal step or a
// superseded generation) writes NOTHING — newer durable truth is never
// overwritten (repair mandate §9) — and the lease sweep remains the
// safety net.

import type { PrismaClient } from '@rupturegrid/control-db';
import { writeTerminalState } from './transitions.js';
import type { FencingContext } from './transitions.js';
import { LeaseLostError } from './claim.js';

/** The v1 mutation classification vocabulary (no new enum values). */
export type EmergencyMutationClassification = 'MUTATING' | 'READ_ONLY';

export interface EmergencyStepTruth {
  readonly terminalState: 'FAILED';
  readonly intentOutcome: 'FAILED';
  readonly sideEffectKnowledge:
    'KNOWN_ABSENT' | 'INDETERMINATE' | 'KNOWN_OCCURRED' | 'NOT_APPLICABLE';
  readonly attemptCount: number;
}

/**
 * Durable invocation facts for ONE step (whatever its writers
 * observed — append-only, attributed records, ADR-0009 §10) PLUS the
 * independent pre-send proof.
 */
export interface EmergencyInvocationFacts {
  /** What each recorded physical invocation classified. */
  readonly knowledge: readonly string[];
  /** The step action's mutation classification (from the frozen snapshot). */
  readonly mutation: EmergencyMutationClassification;
  /**
   * Independent, durable proof that NO mutation attempt crossed the send
   * boundary: `experiment_step_run.executingAt IS NULL`. This is the ONLY
   * completeness proof the platform has (final-audit mandate §6). It is
   * NEVER inferred from the exception, from an empty result set, or from
   * an invocation count.
   */
  readonly preSendProven: boolean;
}

/**
 * Conservative, deterministic derivation of the emergency terminal
 * knowledge from durable invocation truth:
 *
 *   MUTATING:
 *     any invocation KNOWN_OCCURRED or INDETERMINATE → INDETERMINATE
 *     (mixed repeat outcomes included — the KNOWN occasionally/
 *     all-or-worst aggregation family; uncertainty dominates)
 *     every invocation KNOWN_ABSENT AND pre-send proven → KNOWN_ABSENT
 *     (independent durable transport truth: no attempt could have crossed
 *     the send boundary)
 *     every invocation KNOWN_ABSENT but send boundary NOT proven →
 *     INDETERMINATE (an unpersisted sent attempt may exist — F-1)
 *     no invocation recorded                        → INDETERMINATE
 *     (post-catch the send boundary is unknown; the sweep's
 *     conservative mutating default applies — never KNOWN_ABSENT)
 *
 *   READ_ONLY: NOT_APPLICABLE always (established read-only step
 *   semantics — preservation, not a new classification).
 */
export function deriveEmergencyStepTruth(facts: EmergencyInvocationFacts): EmergencyStepTruth {
  const attemptCount = facts.knowledge.length;
  if (facts.mutation === 'READ_ONLY') {
    return {
      terminalState: 'FAILED',
      intentOutcome: 'FAILED',
      sideEffectKnowledge: 'NOT_APPLICABLE',
      attemptCount,
    };
  }
  const knownOnward = facts.knowledge.some(
    (knowledge) => knowledge === 'INDETERMINATE' || knowledge === 'KNOWN_OCCURRED',
  );
  if (knownOnward) {
    return {
      terminalState: 'FAILED',
      intentOutcome: 'FAILED',
      sideEffectKnowledge: 'INDETERMINATE',
      attemptCount,
    };
  }
  // Every persisted row (if any) is KNOWN_ABSENT. That is NOT proof that
  // every attempted mutation was pre-send (F-1: an unpersisted sent
  // attempt may exist). Require the independent durable pre-send proof.
  if (!facts.preSendProven || attemptCount === 0) {
    return {
      terminalState: 'FAILED',
      intentOutcome: 'FAILED',
      sideEffectKnowledge: 'INDETERMINATE',
      attemptCount,
    };
  }
  return {
    terminalState: 'FAILED',
    intentOutcome: 'FAILED',
    sideEffectKnowledge: 'KNOWN_ABSENT',
    attemptCount,
  };
}

export interface EmergencyTerminalWrite {
  /** Whether a fenced write was attempted. */
  readonly attempted: boolean;
  /** Whether the fenced write landed (false on stale/terminal step). */
  readonly written: boolean;
  /** What was (or would have been) derived, for honest logging. */
  readonly truth: EmergencyStepTruth | null;
}

/**
 * Writes the emergency terminal row FENCED, derived from the step's
 * durable invocation facts (loaded by the caller — the worker catch —
 * from `step_invocation` + the step row). Ownership-conditional (owner +
 * fencing token + still non-terminal): an already-terminal step or a
 * superseded generation writes NOTHING and returns written=false — newer
 * durable truth is never overwritten. The lease sweep remains the safety
 * net when ownership is unavailable or the write fails.
 */
export async function writeEmergencyStepTerminal(options: {
  readonly prisma: PrismaClient;
  readonly stepRunId: string;
  /** Owner + fencing token of the generation writing (null: skip). */
  readonly ctx: FencingContext | null;
  /** The step action's mutation classification (frozen snapshot). */
  readonly mutation: EmergencyMutationClassification | null;
  /** Every recorded invocation's sideEffectKnowledge for this step. */
  readonly invocationKnowledge: readonly string[];
  /** Independent durable pre-send proof (executingAt IS NULL). */
  readonly preSendProven: boolean;
  /** Bounded, secret-free failure reason for the durable error field. */
  readonly reason: string;
}): Promise<EmergencyTerminalWrite> {
  if (options.ctx === null || options.mutation === null) {
    return { attempted: false, written: false, truth: null };
  }
  const truth = deriveEmergencyStepTruth({
    knowledge: options.invocationKnowledge,
    mutation: options.mutation,
    preSendProven: options.preSendProven,
  });
  try {
    await writeTerminalState(
      options.prisma,
      options.stepRunId,
      {
        state: truth.terminalState,
        intentOutcome: truth.intentOutcome,
        sideEffectKnowledge: truth.sideEffectKnowledge,
        attemptCount: truth.attemptCount,
        error: options.reason,
      },
      options.ctx,
    );
    return { attempted: true, written: true, truth };
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // Zero rows: the step was already terminal or re-owned. The
      // durable truth that exists is newer; nothing is rewritten (the
      // stale attempt is durably recorded by writeTerminalState).
      return { attempted: true, written: false, truth };
    }
    // The emergency write itself failed to persist: the lease sweep
    // remains the safety net (never fabricate, never retry blind).
    return { attempted: true, written: false, truth };
  }
}

/**
 * The durable emergency context for ONE claimed step: the step's CURRENT
 * ownership, its FROZEN mutation classification from the run snapshot,
 * every recorded invocation's side-effect knowledge (append-only records
 * of what each writer observed — ADR-0009 §10), and the independent
 * pre-send proof (`executingAt IS NULL`). Returns null when the step is
 * not CLAIMED/EXECUTING (already terminal or re-owned elsewhere: never
 * overwritten — the newer durable truth stands).
 *
 * This is production code: the worker's `processJob` catch calls
 * `repairEmergencyStepTerminal`, which calls this function. Committed
 * tests exercise exactly this path (final-audit mandate §10–§11).
 */
export async function loadEmergencyContext(
  prisma: PrismaClient,
  ownerId: string,
  stepRunId: string,
): Promise<{
  readonly ctx: { readonly ownerId: string; readonly fencingToken: string };
  readonly mutation: EmergencyMutationClassification;
  readonly invocationKnowledge: readonly string[];
  readonly preSendProven: boolean;
} | null> {
  const step = await prisma.experimentStepRun.findUnique({
    where: { id: stepRunId },
    select: {
      runId: true,
      sequence: true,
      state: true,
      leaseOwnerId: true,
      fencingToken: true,
      executingAt: true,
    } as const,
  });
  if (step === null || step.fencingToken === null) {
    return null;
  }
  if (step.state !== 'CLAIMED' && step.state !== 'EXECUTING') {
    return null; // Terminal or re-owned: newer durable truth stands.
  }
  // Ownership note: the fenced write matches only when THIS generation
  // still owns the lease — writing through the observed token is the
  // conditional predicate, and a zero-row result means the step was
  // re-owned (nothing written, nothing overwritten).
  const run = await prisma.experimentRun.findUnique({
    where: { id: step.runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (run === null) {
    return null;
  }
  // The FROZEN snapshot is the mutation authority (same rule the
  // reconciler's isMutatingStep applies; conservative default MUTATING).
  const content = run.snapshot.content as { steps?: Array<{ action?: { mutation?: string } }> };
  const frozenStep = content.steps?.[step.sequence];
  const mutation = frozenStep?.action?.mutation === 'READ_ONLY' ? 'READ_ONLY' : 'MUTATING';
  const invocations = await prisma.stepInvocation.findMany({
    where: { stepRunId },
    select: { sideEffectKnowledge: true },
    orderBy: { sequence: 'asc' },
  });
  const invocationKnowledge = invocations.map((invocation) =>
    invocation.sideEffectKnowledge === null ? 'NOT_APPLICABLE' : invocation.sideEffectKnowledge,
  );
  // The independent pre-send proof: `markExecuting` stamps `executingAt`
  // BEFORE any action request is prepared and nothing ever clears it. A
  // null value therefore proves no mutation attempt could have crossed
  // the send boundary; a non-null value means the send boundary MAY have
  // been crossed (even with zero/mostly-KNOWN_ABSENT invocation rows) —
  // F-1. NO other row-based inference is permitted here.
  const preSendProven = step.executingAt === null;
  return {
    ctx: { ownerId, fencingToken: String(step.fencingToken) },
    mutation,
    invocationKnowledge,
    preSendProven,
  };
}

/** Bounded, secret-free failure detail for the durable error field. */
function boundedEmergencyReason(error: unknown): string {
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
  return `step failed before terminal state: ${message}`;
}

export interface EmergencyRepairDeps {
  readonly prisma: PrismaClient;
  /** The worker generation that claimed the step. */
  readonly ownerId: string;
  readonly stepRunId: string;
  /** The exception that escaped `processStep`. */
  readonly error: unknown;
}

/**
 * The PRODUCTION worker emergency-repair step: the exact function the
 * `processJob` catch calls. It re-loads the durable emergency context
 * (frozen mutation classification + append-only invocation facts +
 * independent pre-send proof) and writes the terminal row FENCED.
 * Extracted so committed tests exercise the same function the production
 * worker calls (final-audit mandate §10–§11) with no test-only bypass in
 * production code.
 */
export async function repairEmergencyStepTerminal(
  deps: EmergencyRepairDeps,
): Promise<EmergencyTerminalWrite> {
  const context = await loadEmergencyContext(deps.prisma, deps.ownerId, deps.stepRunId);
  return writeEmergencyStepTerminal({
    prisma: deps.prisma,
    stepRunId: deps.stepRunId,
    ctx: context?.ctx ?? null,
    mutation: context?.mutation ?? null,
    invocationKnowledge: context?.invocationKnowledge ?? [],
    preSendProven: context?.preSendProven ?? false,
    reason: boundedEmergencyReason(deps.error),
  });
}
