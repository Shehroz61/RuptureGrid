// =====================================================================
// RuptureGrid Phase 17 — Checkpoint B2: derivation generation `D`,
// derivation-attempt completeness, and the derived-projection writer
// protocol (ADR-0026 §13 "Derived projection — completeness, not
// optimism"; adversarial cases 64/67)
// =====================================================================
// The composite truth-input watermark is `W = (C, P, D)`:
//
//   C — the raw-evidence chain identity (`EvidenceIntegrityHead`, or the
//       empty-chain marker), advanced only by `appendChainObservation`
//       under the per-run advisory lock;
//   P — the provenance revision (Checkpoint B1), advanced by +1 in the
//       SAME transaction as every truth-bearing non-chain write;
//   D — the derivation generation (THIS checkpoint), advanced by +1 in
//       the SAME transaction as every committed derived-projection
//       commit of the run — nothing else.
//
// WHY ATTEMPTS EXIST (the defect this closes). `evidence.normalized_event`,
// `evidence.causal_relationship`, derivation diagnostics and invalidation
// tombstones are DETERMINISTIC functions of (chain prefix + frozen policy
// + normalizer versions), but the SET of derivation commits that have run
// is NOT derivable from the chain: a crash between derived writes leaves a
// partially built projection with no trace in the raw evidence. A reader
// could otherwise observe events written, relationships missing, tombstones
// absent — and certify one of those states as complete. This module makes
// the projection's completeness a DURABLE, PROVABLE fact:
//
//   * every derivation pass makes itself durable (IN_PROGRESS) BEFORE its
//     first truth-bearing derived write, capturing the source watermark it
//     derives from;
//   * every derived write commits under the B1 run lock WITH its `D`
//     advance in the same transaction (`advanceDerivationGeneration`);
//   * a pass publishes COMPLETE only after its completeness checks pass,
//     under the same lock, against the source it captured;
//   * a crash/failure leaves IN_PROGRESS/FAILED — never COMPLETE;
//   * a reader uses `readDerivationReadiness` and fails closed unless an
//     AUTHORITATIVE COMPLETE proof covers the CURRENT source watermark.
//
// ATTEMPT STATE MACHINE (per `(runId, derivationKind)`; NOT_STARTED is the
// absence of any attempt row):
//
//   IN_PROGRESS → COMPLETE    (completeness checks passed, source stable)
//   IN_PROGRESS → INCOMPLETE  (proven incomplete: source advanced during
//                              the pass, or a completeness check failed)
//   IN_PROGRESS → FAILED      (the pass raised; best-effort marker)
//   IN_PROGRESS → ABANDONED   (explicit administrative supersession only —
//                              never written automatically; see below)
//
// OVERLAPPING ATTEMPTS (ADR-0026 §26 case 65 discipline; auditor note).
// Attempts are separately tracked rows, never a single boolean:
//   * begin   — only the pass itself, under the run lock; generation =
//               max+1 for the pair, so two attempts are distinguishable
//               and a retry never reuses an identity;
//   * finish  — ONLY the attempt that holds the row in IN_PROGRESS may
//               finish it; the completion update is status-guarded
//               (`updateMany WHERE status = 'IN_PROGRESS'`), so a newer
//               pass can never clear or overwrite an older pass's state,
//               and an older still-running pass keeps its own durable row;
//   * authoritative — the COMPLETE attempt with the largest
//               `committedDerivationGeneration` (tie: largest generation)
//               whose captured source equals the CURRENT `(C, P)`.
//               Completeness additionally requires
//               `currentD == proof.committedDerivationGeneration`: because
//               EVERY committed derived mutation advances `D` by exactly
//               one, equality PROVES that no derived commit happened after
//               the proof — a later write by an older still-running pass,
//               or by an untracked writer that advances `D`, invalidates
//               the proof (fail closed) instead of silently disappearing;
//   * stale/failed — historical rows; they never block a NEWER proven
//               complete pass (a later full derivation re-establishes
//               completeness), and they are always reported by
//               `readDerivationReadiness` (nothing is hidden).
//   * unresolved newer (Checkpoint C0) — an IN_PROGRESS attempt NEWER
//               than the authoritative proof fails readiness closed
//               (`NEWER_ATTEMPT_IN_PROGRESS`): its marker state can
//               change while `W = (C, P, D)` is still byte-identical
//               (the completeness-marked kind never advances `D`), so a
//               reader must never certify completeness while a newer
//               pass is unresolved. An OLDER unresolved attempt is
//               historical: any commit it makes still invalidates the
//               newer proof through `D` (UNATTRIBUTED), which is why
//               D-15's older-still-running pass does not block a newer
//               proven-complete pass.
//
// SOURCE BINDING (ADR-0026 §13 two-stage Boundary A). A derivation is
// performed against a PARTICULAR source state. The attempt captures
// `(C, P, D)` BEFORE its first input read; completion re-reads the head
// under the lock and refuses COMPLETE when the source moved
// (`SOURCE_ADVANCED_DURING_DERIVATION` for `C`/`P`; for a non-`D`-advancing
// kind — see below — any `D` movement counts identically). Already
// persisted truthful rows are preserved: an incomplete pass is never
// "fixed" by deleting them, and no historical rewriting turns a test green.
//
// KIND POLICY (the full derived-writer inventory).
//   * `run-evidence/v1`  — D-PARTICIPATING. Every committed derived row
//     (`normalized_event`, `causal_relationship`, derivation diagnostics
//     and invalidation tombstones) advances `D` in its own transaction.
//   * `run-forensics/v1` — COMPLETENESS-MARKED ONLY (class B, explicit
//     grounded exclusion): `deriveRunForensics` consumes already-covered
//     inputs (chain `C`, provenance `P`, the `D`-covered projection, and
//     persisted evaluations) and writes `finding`,
//     `finding_evidence_reference`, `forensic_timeline_entry`,
//     `reproduction_definition`, and the `forensic_derivation` record.
//     NO evaluation/eligibility/anchor/completeness read path reads those
//     tables (the evaluator input loaders read raw observations and the
//     normalized/derived graph only), so a partial forensic projection
//     CANNOT alter a verdict — and advancing `D` for report-facing
//     projections would make every current-evaluation pointer stale on
//     every report emission (endless re-analysis churn). Its completeness
//     is therefore proven per source watermark by the SAME attempt
//     protocol, and report/reproduction surfaces must consult
//     `readDerivationReadiness(runId, 'run-forensics/v1')` and fail closed.
//   The execution dependency is explicit: the CLI/E2E pipeline derives
//   forensics AFTER evaluation; the marker is what makes the ordering
//   honest (a marker that covers the current source is required before
//   findings/timeline bytes may be treated as complete).
//
// TRUST BOUNDARY (non-participating writers; honest residual). The
// protocol's guarantees hold for writes that go through the supported
// application entry points (`deriveRunEvidence`, `deriveRunForensics`).
// Two classes are DETECTABLE and fail closed: (a) a projection with rows
// but no attempt row (`UNTRACKED`), and (b) a `D` advance not covered by an
// authoritative COMPLETE proof (`UNATTRIBUTED`). A direct row write that
// neither creates an attempt nor advances `D` is OUTSIDE the protocol and
// cannot be detected by an application-level lock — this module claims
// exactly the coverage above and no protection from arbitrary DBA
// mutation (R-18; recorded as a residual blocker in the B2 self-audit).
//
// Everything here is COORDINATION METADATA about what has been derived —
// never business truth, never a verdict, never a second truth engine.

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@rupturegrid/control-db';
import {
  PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  PROVENANCE_TRANSACTION_TIMEOUT_MS,
  acquireRunLock,
  readTruthInputHead,
} from '@rupturegrid/engine';

/** The canonical run-evidence derivation family (D-participating). */
export const DERIVATION_KIND_RUN_EVIDENCE = 'run-evidence/v1';
/** The forensic derivation family (completeness-marked only; see header). */
export const DERIVATION_KIND_RUN_FORENSICS = 'run-forensics/v1';

export type DerivationKind =
  typeof DERIVATION_KIND_RUN_EVIDENCE | typeof DERIVATION_KIND_RUN_FORENSICS;

/**
 * Kind policy table — the ONE place that decides whether a derivation
 * family advances `D`. Adding a kind without an entry is a type error.
 */
export const DERIVATION_KIND_POLICY: Readonly<
  Record<DerivationKind, { readonly advancesDerivationGeneration: boolean }>
> = {
  [DERIVATION_KIND_RUN_EVIDENCE]: { advancesDerivationGeneration: true },
  [DERIVATION_KIND_RUN_FORENSICS]: { advancesDerivationGeneration: false },
};

/** Same bounded transaction protocol as every B1 provenance writer. */
const ATTEMPT_TX = {
  timeout: PROVENANCE_TRANSACTION_TIMEOUT_MS,
  maxWait: PROVENANCE_TRANSACTION_MAX_WAIT_MS,
} as const;

/** The bounded reason column's maximum length (`VarChar(500)`). */
const REASON_MAX_CHARS = 500;
/** `derivationKind` is `VarChar(64)`. */
const KIND_MAX_CHARS = 64;

/**
 * A read surface usable both standalone and INSIDE a lock-scoped
 * transaction (Checkpoint C: the publication/authorization transactions
 * evaluate readiness while holding the per-run advisory lock, exactly as
 * the C0 marker-race closing requires). The generated `PrismaClient` and
 * an interactive `$transaction` client are both assignable.
 */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The `C` component: the run's raw-evidence chain identity. A missing
 * head row IS the empty chain (count 0, no head hash, no last index) —
 * the frozen `appendChainObservation` semantics, reused verbatim.
 */
export interface ChainIdentity {
  readonly headContentHash: string | null;
  readonly observationCount: number;
  readonly lastChainIndex: number | null;
}

/** The run's composite truth-input watermark `W = (C, P, D)`. */
export interface TruthInputWatermark {
  readonly chain: ChainIdentity;
  readonly provenanceRevision: bigint;
  readonly derivationGeneration: bigint;
}

/** The source state one attempt derives from (captured before its reads). */
export interface DerivationSourceWatermark {
  readonly chain: ChainIdentity;
  readonly provenanceRevision: bigint;
  readonly derivationGeneration: bigint;
}

/** A begun (durable, IN_PROGRESS) derivation attempt. */
export interface DerivationAttemptHandle {
  readonly attemptId: string;
  readonly runId: string;
  readonly derivationKind: DerivationKind;
  readonly attemptGeneration: bigint;
  readonly source: DerivationSourceWatermark;
}

/**
 * The terminal resolution a completing pass published for its attempt.
 *
 * Generation identities are DECIMAL STRINGS here, deliberately: this
 * object flows into `DerivationResult`/`ForensicDerivationResult` and is
 * serialized (API responses, CLI/report JSON), and a `bigint` field makes
 * `JSON.stringify` throw. A decimal string is exact — it names the
 * durable `bigint` column verbatim, never a float (R-06 applies the same
 * discipline to any exact integer crossing a boundary). The protocol
 * functions (`beginDerivationAttempt` etc.) keep `bigint` internally.
 */
export type DerivationAttemptResolution =
  | {
      readonly status: 'COMPLETE';
      readonly attemptGeneration: string;
      readonly committedDerivationGeneration: string;
      readonly reason: null;
    }
  | {
      readonly status: 'INCOMPLETE';
      readonly attemptGeneration: string;
      readonly committedDerivationGeneration: null;
      readonly reason: string;
    }
  | {
      readonly status: 'NOT_APPLIED';
      readonly attemptGeneration: string;
      readonly committedDerivationGeneration: null;
      readonly reason: string;
    };

/** Reads the run's chain identity (`C`); missing head ⇒ empty chain. */
export async function readChainIdentity(
  db: Pick<PrismaClient, 'evidenceIntegrityHead'>,
  runId: string,
): Promise<ChainIdentity> {
  const head = await db.evidenceIntegrityHead.findUnique({
    where: { runId },
    select: { headContentHash: true, observationCount: true, lastChainIndex: true },
  });
  if (head === null) {
    return { headContentHash: null, observationCount: 0, lastChainIndex: null };
  }
  return {
    headContentHash: head.headContentHash,
    observationCount: head.observationCount,
    lastChainIndex: head.lastChainIndex,
  };
}

/** Chain-identity equality across all three fields (ADR-0026 §13). */
export function chainIdentitiesEqual(a: ChainIdentity, b: ChainIdentity): boolean {
  return (
    a.headContentHash === b.headContentHash &&
    a.observationCount === b.observationCount &&
    a.lastChainIndex === b.lastChainIndex
  );
}

/**
 * Reads the current composite watermark `W = (C, P, D)` as ONE identity.
 * Bounded indexed reads only; it does not verify the chain.
 */
export async function readTruthInputWatermark(
  prisma: Db,
  runId: string,
): Promise<TruthInputWatermark> {
  // SEQUENTIAL on purpose: this reader is called inside the per-run
  // lock transaction (Boundary B), where concurrent statements would be
  // pipelined onto the transaction's single connection.
  const chain = await readChainIdentity(prisma, runId);
  const head = await readTruthInputHead(prisma, runId);
  return {
    chain,
    provenanceRevision: head.provenanceRevision,
    derivationGeneration: head.derivationGeneration,
  };
}

/**
 * BEGINS one derivation pass: under the per-run lock, captures the source
 * watermark and makes the attempt durable as IN_PROGRESS — BEFORE any
 * derived write of the pass. The lock is held only over this DB-local
 * transaction; nothing external ever runs under it.
 */
export async function beginDerivationAttempt(
  prisma: PrismaClient,
  runId: string,
  derivationKind: DerivationKind,
): Promise<DerivationAttemptHandle> {
  const kind = derivationKind.slice(0, KIND_MAX_CHARS);
  return prisma.$transaction(async (tx) => {
    await acquireRunLock(tx, runId);
    const chain = await readChainIdentity(tx, runId);
    const head = await readTruthInputHead(tx, runId);
    const max = await tx.derivationAttempt.aggregate({
      where: { runId, derivationKind: kind },
      _max: { attemptGeneration: true },
    });
    const attemptGeneration = (max._max.attemptGeneration ?? 0n) + 1n;
    const row = await tx.derivationAttempt.create({
      data: {
        id: randomUUID(),
        runId,
        derivationKind: kind,
        attemptGeneration,
        status: 'IN_PROGRESS',
        sourceChainHeadHash: chain.headContentHash,
        sourceChainObservationCount: chain.observationCount,
        sourceChainLastIndex: chain.lastChainIndex,
        sourceProvenanceRevision: head.provenanceRevision,
        sourceDerivationGeneration: head.derivationGeneration,
      },
      select: { id: true },
    });
    return {
      attemptId: row.id,
      runId,
      derivationKind: kind as DerivationKind,
      attemptGeneration,
      source: {
        chain,
        provenanceRevision: head.provenanceRevision,
        derivationGeneration: head.derivationGeneration,
      },
    };
  }, ATTEMPT_TX);
}

export interface CompleteDerivationAttemptInput {
  /** Rows this pass observed/committed (diagnostics only — never a verdict). */
  readonly projectionCounts?: Record<string, number>;
  /**
   * Completeness checks the pass requires BEFORE publishing COMPLETE
   * (run inside the completion transaction, under the lock). Each entry
   * is a named predicate; the first false result marks the attempt
   * INCOMPLETE with that name. Absent ⇒ no extra checks (the source
   * binding is always checked).
   */
  readonly completenessChecks?: ReadonlyArray<{
    readonly check: (tx: Prisma.TransactionClient) => Promise<boolean>;
    readonly name: string;
  }>;
}

/**
 * PUBLISHES the attempt's terminal state — COMPLETE only when the source
 * binding still holds and every completeness check passed; otherwise
 * INCOMPLETE with a named reason. Runs under the per-run lock in ONE
 * transaction; the update is status-guarded, so only THIS attempt (while
 * it is still IN_PROGRESS) can finish its own row.
 *
 * For a D-advancing kind the `(C, P)` source must be unchanged (the pass's
 * own derived commits legitimately advanced `D`); for a completeness-marked
 * kind the captured `D` must ALSO be unchanged, because its inputs include
 * the derived projection. `committedDerivationGeneration` is the `D`
 * observed under this lock — the generation the proof covers.
 */
export async function completeDerivationAttempt(
  prisma: PrismaClient,
  handle: DerivationAttemptHandle,
  input: CompleteDerivationAttemptInput = {},
): Promise<DerivationAttemptResolution> {
  const advancesD = DERIVATION_KIND_POLICY[handle.derivationKind].advancesDerivationGeneration;
  return prisma.$transaction(async (tx) => {
    await acquireRunLock(tx, handle.runId);
    const chain = await readChainIdentity(tx, handle.runId);
    const head = await readTruthInputHead(tx, handle.runId);
    const chainMoved = !chainIdentitiesEqual(chain, handle.source.chain);
    const provenanceMoved = head.provenanceRevision !== handle.source.provenanceRevision;
    const generationMoved =
      !advancesD && head.derivationGeneration !== handle.source.derivationGeneration;

    const finish = async (
      status: 'COMPLETE' | 'INCOMPLETE',
      reason: string | null,
      committed: bigint | null,
    ): Promise<DerivationAttemptResolution> => {
      const applied = await tx.derivationAttempt.updateMany({
        where: { id: handle.attemptId, status: 'IN_PROGRESS' },
        data: {
          status,
          ...(reason === null ? {} : { reason: reason.slice(0, REASON_MAX_CHARS) }),
          committedDerivationGeneration: committed,
          ...(input.projectionCounts === undefined
            ? {}
            : { projectionCounts: input.projectionCounts as object }),
          completedAt: new Date(),
        },
      });
      if (applied.count !== 1) {
        // The attempt was already terminal (administrative supersession or
        // a concurrent finisher): never overwrite another writer's verdict.
        return {
          status: 'NOT_APPLIED',
          attemptGeneration: handle.attemptGeneration.toString(),
          committedDerivationGeneration: null,
          reason: 'ATTEMPT_NOT_IN_PROGRESS',
        };
      }
      if (status === 'COMPLETE') {
        return {
          status: 'COMPLETE',
          attemptGeneration: handle.attemptGeneration.toString(),
          committedDerivationGeneration: (committed ?? 0n).toString(),
          reason: null,
        };
      }
      return {
        status: 'INCOMPLETE',
        attemptGeneration: handle.attemptGeneration.toString(),
        committedDerivationGeneration: null,
        reason: reason ?? 'INCOMPLETE',
      };
    };

    if (chainMoved || provenanceMoved || generationMoved) {
      return finish('INCOMPLETE', 'SOURCE_ADVANCED_DURING_DERIVATION', null);
    }
    for (const check of input.completenessChecks ?? []) {
      const passed = await check.check(tx);
      if (!passed) {
        return finish('INCOMPLETE', `COMPLETENESS_CHECK_FAILED:${check.name}`, null);
      }
    }
    return finish('COMPLETE', null, head.derivationGeneration);
  }, ATTEMPT_TX);
}

/**
 * Marks a failed pass FAILED (best effort). A marker-write failure is
 * deliberately swallowed: the fail-closed default (the row stays
 * IN_PROGRESS) is safe, and this call must never mask the pass's own
 * error. No other attempt's state is touched (status-guarded).
 */
export async function failDerivationAttempt(
  prisma: PrismaClient,
  handle: DerivationAttemptHandle,
  error: unknown,
): Promise<void> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(
    0,
    REASON_MAX_CHARS,
  );
  try {
    await prisma.derivationAttempt.updateMany({
      where: { id: handle.attemptId, status: 'IN_PROGRESS' },
      data: { status: 'FAILED', reason, completedAt: new Date() },
    });
  } catch {
    // Best effort only: the durable IN_PROGRESS row already fails closed.
  }
}

/**
 * Explicit administrative supersession — NEVER automatic. An operator (or
 * a future lease-aware sweeper) may abandon an attempt that is provably
 * dead (its process is gone) so a retry can publish a fresh proof without
 * touching the old row's identity. The attempt's row is preserved; nothing
 * is cleared. Until this is invoked, an abandoned IN_PROGRESS attempt is
 * simply a non-authoritative historical row: a LATER proven-complete pass
 * supersedes it, and any commit it makes still invalidates the newer proof
 * through `D` (it can never disappear from the completeness proof).
 */
export async function abandonDerivationAttempt(
  prisma: PrismaClient,
  runId: string,
  attemptGeneration: bigint,
  derivationKind: DerivationKind,
  reason: string,
): Promise<boolean> {
  const applied = await prisma.derivationAttempt.updateMany({
    where: {
      runId,
      derivationKind,
      attemptGeneration,
      status: 'IN_PROGRESS',
    },
    data: {
      status: 'ABANDONED',
      reason: reason.slice(0, REASON_MAX_CHARS),
      completedAt: new Date(),
    },
  });
  return applied.count === 1;
}

/** Readiness verdicts — every one except COMPLETE fails closed. */
export type DerivationReadinessState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'FAILED'
  | 'STALE'
  | 'UNATTRIBUTED'
  | 'UNTRACKED';

/**
 * JSON-safe view of a watermark: the two revision counters are DECIMAL
 * STRINGS (exact, never floats) so a readiness/proof object can be
 * serialized into an API response or report byte-for-byte.
 */
export interface SerializedTruthInputWatermark {
  readonly chain: ChainIdentity;
  readonly provenanceRevision: string;
  readonly derivationGeneration: string;
}

/**
 * JSON-safe serialization of a `(C, P, D)` watermark: the two revision
 * counters are DECIMAL STRINGS (exact, never floats). Exported so the
 * Checkpoint C publication/read surfaces serialize the SAME identity.
 */
export function serializeTruthInputWatermark(
  source: TruthInputWatermark | DerivationSourceWatermark,
): SerializedTruthInputWatermark {
  return {
    chain: source.chain,
    provenanceRevision: source.provenanceRevision.toString(),
    derivationGeneration: source.derivationGeneration.toString(),
  };
}

function serializeSource(source: DerivationSourceWatermark): SerializedTruthInputWatermark {
  return serializeTruthInputWatermark(source);
}

/** True when two watermarks agree in EVERY component (ADR-0026 §13). */
export function truthInputWatermarksEqual(a: TruthInputWatermark, b: TruthInputWatermark): boolean {
  return (
    chainIdentitiesEqual(a.chain, b.chain) &&
    a.provenanceRevision === b.provenanceRevision &&
    a.derivationGeneration === b.derivationGeneration
  );
}

export interface DerivationReadiness {
  readonly runId: string;
  readonly derivationKind: DerivationKind;
  /** TRUE only when an authoritative COMPLETE proof covers the CURRENT state. */
  readonly complete: boolean;
  readonly state: DerivationReadinessState;
  /** Machine-readable reason (never a verdict, never a business claim). */
  readonly reason: string;
  /** The current durable watermark this readiness was evaluated against. */
  readonly current: SerializedTruthInputWatermark;
  /** The authoritative proof attempt, when one exists. */
  readonly proof: {
    readonly attemptGeneration: string;
    readonly committedDerivationGeneration: string;
    readonly source: SerializedTruthInputWatermark;
    readonly completedAt: Date | null;
  } | null;
  /**
   * Every still-unresolved (IN_PROGRESS) attempt of this kind. They are
   * REPORTED, never hidden: the authoritative rule above stays sound
   * because any commit an unresolved pass makes advances `D` and
   * invalidates the proof (UNATTRIBUTED) instead of silently vanishing.
   */
  readonly unresolvedAttempts: ReadonlyArray<{
    readonly attemptGeneration: string;
    readonly startedAt: Date;
  }>;
  readonly detail: string;
}

/** The projection tables each kind owns (for the UNTRACKED check). */
async function hasProjectionRows(
  prisma: Db,
  runId: string,
  derivationKind: DerivationKind,
): Promise<boolean> {
  // SEQUENTIAL on purpose: reachable from the per-run lock transaction
  // (readiness is re-read there), and a lock transaction's single
  // connection must never carry pipelined statements.
  if (derivationKind === DERIVATION_KIND_RUN_EVIDENCE) {
    const events = await prisma.normalizedEvent.count({ where: { runId } });
    if (events > 0) {
      return true;
    }
    const relationships = await prisma.causalRelationship.count({ where: { runId } });
    return relationships > 0;
  }
  const findings = await prisma.finding.count({ where: { runId } });
  const entries = await prisma.forensicTimelineEntry.count({ where: { runId } });
  const derivations = await prisma.forensicDerivation.count({ where: { runId } });
  const reproductions = await prisma.reproductionDefinition.count({ where: { runId } });
  return findings > 0 || entries > 0 || derivations > 0 || reproductions > 0;
}

/**
 * THE READINESS / PROOF API (ADR-0026 §13; consolidated by the B2 checkpoint).
 * A reader evaluating a run (or a report claiming findings/timeline bytes)
 * calls this and proceeds ONLY when `complete === true`. Every other state
 * fails closed, with the exact durable reason. Never a verdict, never a
 * substitute for the C-checkpoint publication validation.
 *
 * Checkpoint C: accepts BOTH the standalone client and a transaction
 * client, so the SAME readiness evaluation can run inside the lock-scoped
 * publication transaction (and, for Checkpoint D, the report
 * authorization transaction) — the marker state and `W` are then read as
 * one consistent committed state.
 */
export async function readDerivationReadiness(
  prisma: Db,
  runId: string,
  derivationKind: DerivationKind,
): Promise<DerivationReadiness> {
  const currentWatermark = await readTruthInputWatermark(prisma, runId);
  const current = serializeSource(currentWatermark);
  const attempts = await prisma.derivationAttempt.findMany({
    where: { runId, derivationKind },
    orderBy: { attemptGeneration: 'asc' },
    select: {
      attemptGeneration: true,
      status: true,
      reason: true,
      sourceChainHeadHash: true,
      sourceChainObservationCount: true,
      sourceChainLastIndex: true,
      sourceProvenanceRevision: true,
      sourceDerivationGeneration: true,
      committedDerivationGeneration: true,
      completedAt: true,
      startedAt: true,
    },
  });
  const unresolvedAttempts = attempts
    .filter((attempt) => attempt.status === 'IN_PROGRESS')
    .map((attempt) => ({
      attemptGeneration: attempt.attemptGeneration.toString(),
      startedAt: attempt.startedAt,
    }));

  if (attempts.length === 0) {
    const untracked = await hasProjectionRows(prisma, runId, derivationKind);
    return {
      runId,
      derivationKind,
      complete: false,
      state: untracked ? 'UNTRACKED' : 'NOT_STARTED',
      reason: untracked ? 'PROJECTION_ROWS_WITHOUT_ATTEMPT' : 'NO_DERIVATION_ATTEMPT',
      current,
      proof: null,
      unresolvedAttempts,
      detail: untracked
        ? 'derived rows exist for this kind but no derivation attempt records their completeness — fail closed'
        : 'no derivation attempt has ever run for this kind — fail closed',
    };
  }

  const sourceFor = (attempt: (typeof attempts)[number]): DerivationSourceWatermark => ({
    chain: {
      headContentHash: attempt.sourceChainHeadHash,
      observationCount: attempt.sourceChainObservationCount,
      lastChainIndex: attempt.sourceChainLastIndex,
    },
    provenanceRevision: attempt.sourceProvenanceRevision,
    derivationGeneration: attempt.sourceDerivationGeneration,
  });

  // Authoritative proof: a COMPLETE attempt for the CURRENT chain+P,
  // ranked by the D it covers (tie: attempt generation).
  const candidates = attempts.filter(
    (attempt) =>
      attempt.status === 'COMPLETE' &&
      attempt.committedDerivationGeneration !== null &&
      attempt.sourceChainHeadHash === current.chain.headContentHash &&
      attempt.sourceChainObservationCount === current.chain.observationCount &&
      attempt.sourceChainLastIndex === current.chain.lastChainIndex &&
      attempt.sourceProvenanceRevision.toString() === current.provenanceRevision,
  );
  candidates.sort((a, b) => {
    const committed =
      (a.committedDerivationGeneration ?? 0n) - (b.committedDerivationGeneration ?? 0n);
    if (committed !== 0n) {
      return committed > 0n ? 1 : -1;
    }
    return a.attemptGeneration === b.attemptGeneration
      ? 0
      : a.attemptGeneration > b.attemptGeneration
        ? 1
        : -1;
  });
  const authoritative = candidates[candidates.length - 1];

  if (authoritative === undefined) {
    const newest = attempts[attempts.length - 1];
    if (newest === undefined) {
      // Unreachable (attempts.length > 0 above); kept for type totality.
      throw new Error(`derivation readiness: no attempt rows for run ${runId}`);
    }
    const completeForOlderSource =
      newest.status === 'COMPLETE' && newest.committedDerivationGeneration !== null;
    const state: DerivationReadinessState = completeForOlderSource
      ? 'STALE'
      : newest.status === 'IN_PROGRESS'
        ? 'IN_PROGRESS'
        : newest.status === 'FAILED'
          ? 'FAILED'
          : 'INCOMPLETE';
    return {
      runId,
      derivationKind,
      complete: false,
      state,
      reason: completeForOlderSource
        ? 'SOURCE_WATERMARK_ADVANCED_SINCE_PROOF'
        : newest.status === 'IN_PROGRESS'
          ? 'ATTEMPT_IN_PROGRESS'
          : `ATTEMPT_${newest.status}${newest.reason === null ? '' : `:${newest.reason}`}`,
      current,
      proof: null,
      unresolvedAttempts,
      detail: completeForOlderSource
        ? 'the newest complete proof derives from an older source watermark than the current truth input — fail closed; a later full derivation re-establishes completeness'
        : 'no authoritative complete proof covers the current source watermark — fail closed',
    };
  }

  const committedDerivationGeneration = authoritative.committedDerivationGeneration ?? 0n;
  const proof = {
    attemptGeneration: authoritative.attemptGeneration.toString(),
    committedDerivationGeneration: committedDerivationGeneration.toString(),
    source: serializeSource(sourceFor(authoritative)),
    completedAt: authoritative.completedAt,
  };
  if (current.derivationGeneration !== committedDerivationGeneration.toString()) {
    return {
      runId,
      derivationKind,
      complete: false,
      state: 'UNATTRIBUTED',
      reason: 'DERIVATION_GENERATION_ADVANCED_AFTER_PROOF',
      current,
      proof,
      unresolvedAttempts,
      detail:
        'a derived commit advanced D after the authoritative proof — the current projection is not covered by it; fail closed until a full derivation proves completeness again',
    };
  }
  // C0 (marker-only readiness race): an attempt NEWER than the
  // authoritative proof that is still IN_PROGRESS may already be
  // changing the projection. For the completeness-marked kind those
  // writes do NOT advance `D`, so `W` can remain byte-identical while
  // readiness changes — readiness therefore fails CLOSED until the
  // newer attempt resolves. An OLDER unresolved attempt is history: the
  // proof above is newer, and any commit the older pass makes still
  // advances `D` and invalidates it (UNATTRIBUTED) instead of silently
  // disappearing.
  const newerUnresolved = unresolvedAttempts.filter(
    (attempt) => BigInt(attempt.attemptGeneration) > authoritative.attemptGeneration,
  );
  if (newerUnresolved.length > 0) {
    return {
      runId,
      derivationKind,
      complete: false,
      state: 'IN_PROGRESS',
      reason: 'NEWER_ATTEMPT_IN_PROGRESS',
      current,
      proof,
      unresolvedAttempts,
      detail:
        'a newer derivation attempt is still IN_PROGRESS and can change the projection without advancing W — fail closed until it resolves and completeness is proven again',
    };
  }
  return {
    runId,
    derivationKind,
    complete: true,
    state: 'COMPLETE',
    reason: 'DERIVATION_COMPLETE_FOR_CURRENT_SOURCE',
    current,
    proof,
    unresolvedAttempts,
    detail:
      'an authoritative complete derivation proof covers the current chain, provenance revision, and derivation generation',
  };
}

// ---------------------------------------------------------------------
// Two-stage Boundary A helpers (ADR-0026 §13) — B2 foundation; the
// publication/pointer transaction itself belongs to Checkpoint C.
// ---------------------------------------------------------------------

/**
 * Stage 1 (before-read): captures `(C1, P1)` (and the `D` at capture, for
 * diagnostics) under the per-run lock in one short DB-only transaction.
 * MUST run BEFORE any derivation or business-evidence read of the pass.
 */
export async function captureStage1Source(
  prisma: PrismaClient,
  runId: string,
): Promise<TruthInputWatermark> {
  return prisma.$transaction(async (tx) => {
    await acquireRunLock(tx, runId);
    return {
      chain: await readChainIdentity(tx, runId),
      ...(await readTruthInputHead(tx, runId)),
    } satisfies TruthInputWatermark;
  }, ATTEMPT_TX);
}

/**
 * Stage 2 (final capture): under the lock, re-reads the COMPLETE watermark
 * `W0 = (C0, P0, D0)` — including the pass's own derivation and any foreign
 * derived commit that landed before this capture (case 67: those rows are
 * part of `D0` and every evaluation-facing read AFTER this point observes
 * them). `raced` is true when `C0 ≠ C1` or `P0 ≠ P1`: the pass's own
 * derivation raced a newer truth-input state, and the pass restarts under
 * the frozen bounded policy with a FRESH stage-1 capture — it never
 * reinterprets the difference or adopts the newer state.
 */
export async function captureStage2Watermark(
  prisma: PrismaClient,
  runId: string,
  stage1: TruthInputWatermark,
): Promise<{ readonly watermark: TruthInputWatermark; readonly raced: boolean }> {
  const watermark = await captureStage1Source(prisma, runId);
  const raced =
    !chainIdentitiesEqual(watermark.chain, stage1.chain) ||
    watermark.provenanceRevision !== stage1.provenanceRevision;
  return { watermark, raced };
}

/**
 * Publication validation primitive (ADR-0026 §13): under the SAME per-run
 * lock, compares a captured `W0` against the current composite watermark
 * in EVERY component and names the changed ones. Acquired-first, READ
 * COMMITTED (the caller's transaction default), so no statement can be
 * served from a snapshot predating the lock grant. A publication attempt
 * with `matches === false` must write NOTHING (Checkpoint C).
 */
export async function validateWatermarkCurrent(
  prisma: PrismaClient,
  runId: string,
  captured: TruthInputWatermark,
): Promise<{
  readonly current: TruthInputWatermark;
  readonly matches: boolean;
  readonly changedComponents: readonly string[];
}> {
  const current = await prisma.$transaction(async (tx) => {
    await acquireRunLock(tx, runId);
    return {
      chain: await readChainIdentity(tx, runId),
      ...(await readTruthInputHead(tx, runId)),
    } satisfies TruthInputWatermark;
  }, ATTEMPT_TX);
  const changedComponents: string[] = [];
  if (current.chain.headContentHash !== captured.chain.headContentHash) {
    changedComponents.push('chainHeadHash');
  }
  if (current.chain.observationCount !== captured.chain.observationCount) {
    changedComponents.push('chainObservationCount');
  }
  if (current.chain.lastChainIndex !== captured.chain.lastChainIndex) {
    changedComponents.push('chainLastChainIndex');
  }
  if (current.provenanceRevision !== captured.provenanceRevision) {
    changedComponents.push('provenanceRevision');
  }
  if (current.derivationGeneration !== captured.derivationGeneration) {
    changedComponents.push('derivationGeneration');
  }
  return { current, matches: changedComponents.length === 0, changedComponents };
}
