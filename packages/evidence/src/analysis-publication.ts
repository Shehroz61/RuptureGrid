// =====================================================================
// RuptureGrid Phase 17 — Checkpoint C: authoritative current-evaluation
// publication (ADR-0026 §13 Boundary A; §7 coverage truth; §14/§15 reads)
// =====================================================================
// ONE transaction publishes a run's analysis results:
//
//   1. acquire the SAME per-run transaction-scoped advisory lock the
//      append/provenance writers use — acquired FIRST;
//   2. re-read the composite watermark `Wcurrent = (C, P, D)` at READ
//      COMMITTED and require it to EXACTLY equal the pass's captured
//      `W0` in EVERY component (chain identity + provenance revision +
//      derivation generation). A mismatch publishes NOTHING;
//   3. require the run-level preconditions (terminal `COMPLETED` run) and
//      the AUTHORITATIVE derivation readiness of `run-evidence/v1` for the
//      current source — a partially built or marker-moved projection can
//      never authorize a publication (the C0 marker-race closing);
//   4. verify that every evaluation row a pointer will name actually
//      exists with exactly the run/invariant/evaluatorVersion/hash the
//      pass persisted (bounded indexed reads; no chain re-verification and
//      no external I/O while holding the lock);
//   5. atomically write ONE `run_eligibility_proof` row per bound key and
//      every `current_evaluation_pointer` row for ONE coherent
//      `analysisGeneration` (a single shared value, strictly greater than
//      the stored one), all carrying the SAME `W0` identity;
//   6. commit (releasing the lock).
//
// A confirmed evaluation REUSES its historical `InvariantEvaluation` row
// (rows are logically append-only and never rewritten) but its PROOF and
// POINTER watermarks ALWAYS advance to the new `W0` and the new
// `analysisGeneration` (ADR-0026 §13 "confirmed evaluation rows — reuse
// without stale watermarks"). Superseded pointers for subjects that are no
// longer current are removed in the SAME transaction — a pass publishes the
// COMPLETE current selection, never a merge with a previous selection.
//
// Everything written here is COORDINATION METADATA naming persisted
// analysis results: verdicts live ONLY in `analysis.invariant_evaluation`
// rows. Report and classifier READ proof rows + pointers (and their
// resolved evaluation rows); they never choose rows by timestamp, UUID, or
// row order (ADR-0026 §13/§18).

import type { Prisma, PrismaClient } from '@rupturegrid/control-db';
import {
  PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  PROVENANCE_TRANSACTION_TIMEOUT_MS,
  RUN_SCOPE_COVERAGE_MODE,
  acquireRunLock,
} from '@rupturegrid/engine';
import {
  DERIVATION_KIND_RUN_EVIDENCE,
  readDerivationReadiness,
  readTruthInputWatermark,
  serializeTruthInputWatermark,
} from './derivation-attempts.js';
import type { SerializedTruthInputWatermark, TruthInputWatermark } from './derivation-attempts.js';

/** Same bounded transaction protocol as every B1/B2 writer. */
const PUBLICATION_TX = {
  timeout: PROVENANCE_TRANSACTION_TIMEOUT_MS,
  maxWait: PROVENANCE_TRANSACTION_MAX_WAIT_MS,
} as const;

/** The frozen coverage-mode labels persisted on proof rows. */
export const PUBLICATION_MODE_STRICT = RUN_SCOPE_COVERAGE_MODE;
export const PUBLICATION_MODE_LEGACY = 'legacy-compat';

/** One subject the pass wants to publish as current. */
export interface PublicationSubject {
  readonly subjectKey: string;
  readonly evaluationId: string;
  readonly evidenceSetHash: string;
  readonly verdict: string;
}

/** The gated coverage/eligibility proof of one bound key (serialized). */
export interface PublicationCoverage {
  readonly scopeField: string;
  readonly generationField: string;
  readonly anchorState: string;
  readonly anchorReason: string;
  readonly anchor: unknown;
  readonly declared: readonly string[];
  readonly eligible: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly unknown[];
  readonly foreign: readonly unknown[];
  readonly indeterminate: readonly unknown[];
  readonly evidenceGaps: readonly unknown[];
  readonly coverageMode: string;
  readonly eligibilityVersion: string;
  readonly coverageStatement: string;
}

/** One bound key's publication input (proof row + its subject pointers). */
export interface PublicationKey {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly registryVersion: string;
  readonly eligibilityVersion: string;
  readonly mode: string;
  readonly subjects: readonly PublicationSubject[];
  /** Gated keys only. */
  readonly coverage: PublicationCoverage | null;
}

/** The outcome of ONE publication attempt (never a verdict). */
export interface PublicationAttemptResult {
  readonly published: boolean;
  readonly analysisGeneration: string | null;
  /** Machine-readable reason (bounded; never a business claim). */
  readonly reason: string;
  readonly detail: string;
  readonly changedComponents: readonly string[];
  /** The locked watermark the attempt was validated against. */
  readonly watermark: SerializedTruthInputWatermark | null;
}

const CHAIN_COMPONENTS = ['headContentHash', 'observationCount', 'lastChainIndex'] as const;

/** Names the watermark components that differ from the captured `W0`. */
function changedWatermarkComponents(
  current: TruthInputWatermark,
  captured: TruthInputWatermark,
): string[] {
  const changed: string[] = [];
  if (current.chain.headContentHash !== captured.chain.headContentHash) {
    changed.push(`chain.${CHAIN_COMPONENTS[0]}`);
  }
  if (current.chain.observationCount !== captured.chain.observationCount) {
    changed.push(`chain.${CHAIN_COMPONENTS[1]}`);
  }
  if (current.chain.lastChainIndex !== captured.chain.lastChainIndex) {
    changed.push(`chain.${CHAIN_COMPONENTS[2]}`);
  }
  if (current.provenanceRevision !== captured.provenanceRevision) {
    changed.push('provenanceRevision');
  }
  if (current.derivationGeneration !== captured.derivationGeneration) {
    changed.push('derivationGeneration');
  }
  return changed;
}

/**
 * Publishes one analysis generation for a run (ADR-0026 §13 Boundary A).
 * Idempotent ONLY when the complete stored publication already carries the
 * SAME composite watermark and the same version/selection identity.
 */
export async function publishAnalysisGeneration(
  prisma: PrismaClient,
  runId: string,
  w0: TruthInputWatermark,
  keys: readonly PublicationKey[],
): Promise<PublicationAttemptResult> {
  return prisma.$transaction(async (tx) => {
    // ---- 1. the SAME per-run lock the append/provenance writers use ----
    await acquireRunLock(tx, runId);

    // ---- 2. Wcurrent must EQUAL W0 in every component ----
    const current = await readTruthInputWatermark(tx, runId);
    const changed = changedWatermarkComponents(current, w0);
    if (changed.length > 0) {
      return {
        published: false,
        analysisGeneration: null,
        reason: 'TRUTH_INPUT_ADVANCED_BEFORE_PUBLICATION',
        detail:
          'the locked composite truth-input watermark no longer equals the pass capture; publish nothing and re-analyze over a fresh capture',
        changedComponents: changed,
        watermark: serializeTruthInputWatermark(current),
      };
    }

    // ---- 3. run-level preconditions ----
    const run = await tx.experimentRun.findUnique({
      where: { id: runId },
      select: { state: true },
    });
    if (run === null) {
      return {
        published: false,
        analysisGeneration: null,
        reason: 'RUN_NOT_FOUND',
        detail: `run ${runId} does not exist`,
        changedComponents: [],
        watermark: serializeTruthInputWatermark(current),
      };
    }
    if (run.state !== 'COMPLETED') {
      return {
        published: false,
        analysisGeneration: null,
        reason: 'RUN_NOT_TERMINAL',
        detail: `run state is ${run.state}; current-evaluation publication requires a terminal COMPLETED run`,
        changedComponents: [],
        watermark: serializeTruthInputWatermark(current),
      };
    }

    // ---- 3b. authoritative derivation readiness for the CURRENT source ----
    const readiness = await readDerivationReadiness(tx, runId, DERIVATION_KIND_RUN_EVIDENCE);
    if (!readiness.complete) {
      return {
        published: false,
        analysisGeneration: null,
        reason: `DERIVATION_NOT_READY:${readiness.reason}`,
        detail:
          'the derived projection is not proven complete for the current truth-input state; a partial or marker-moved projection never authorizes publication',
        changedComponents: [],
        watermark: serializeTruthInputWatermark(current),
      };
    }

    // ---- 4. every named evaluation row must be exactly what was persisted ----
    const evaluationIds = keys.flatMap((key) =>
      key.subjects.map((subject) => subject.evaluationId),
    );
    const evaluationRows =
      evaluationIds.length === 0
        ? []
        : await tx.invariantEvaluation.findMany({
            where: { id: { in: evaluationIds } },
            select: {
              id: true,
              runId: true,
              invariantKey: true,
              evaluatorVersion: true,
              subjectKey: true,
              evidenceSetHash: true,
            },
          });
    const byId = new Map(evaluationRows.map((row) => [row.id, row]));
    for (const key of keys) {
      for (const subject of key.subjects) {
        const row = byId.get(subject.evaluationId);
        if (
          row === undefined ||
          row.runId !== runId ||
          row.invariantKey !== key.invariantKey ||
          row.evaluatorVersion !== key.evaluatorVersion ||
          row.evidenceSetHash !== subject.evidenceSetHash
        ) {
          return {
            published: false,
            analysisGeneration: null,
            reason: 'EVALUATION_ROW_INCONSISTENT',
            detail: `pointer target ${subject.evaluationId} of ${key.invariantKey}/${subject.subjectKey} does not resolve to the persisted evaluation the pass produced`,
            changedComponents: [],
            watermark: serializeTruthInputWatermark(current),
          };
        }
      }
    }

    // ---- 5. one coherent generation, one atomic write set ----
    const max = await tx.runEligibilityProof.aggregate({
      where: { runId },
      _max: { analysisGeneration: true },
    });
    const analysisGeneration = (max._max.analysisGeneration ?? 0n) + 1n;
    const watermark = {
      integrityHeadHash: current.chain.headContentHash,
      integrityObservationCount: current.chain.observationCount,
      provenanceRevision: current.provenanceRevision,
      derivationGeneration: current.derivationGeneration,
    };

    for (const key of keys) {
      const subjectKeys = key.subjects.map((subject) => subject.subjectKey);
      // Superseded pointers of this key are removed in the SAME
      // transaction: publication writes the COMPLETE current selection.
      await tx.currentEvaluationPointer.deleteMany({
        where: {
          runId,
          invariantKey: key.invariantKey,
          evaluatorVersion: key.evaluatorVersion,
          ...(subjectKeys.length === 0 ? {} : { subjectKey: { notIn: subjectKeys } }),
        },
      });
      for (const subject of key.subjects) {
        await tx.currentEvaluationPointer.upsert({
          where: {
            runId_invariantKey_evaluatorVersion_subjectKey: {
              runId,
              invariantKey: key.invariantKey,
              evaluatorVersion: key.evaluatorVersion,
              subjectKey: subject.subjectKey,
            },
          },
          create: {
            runId,
            invariantKey: key.invariantKey,
            evaluatorVersion: key.evaluatorVersion,
            subjectKey: subject.subjectKey,
            currentEvaluationId: subject.evaluationId,
            evidenceHeadHash: subject.evidenceSetHash,
            eligibilityVersion: key.eligibilityVersion,
            analysisGeneration,
            ...watermark,
          },
          update: {
            currentEvaluationId: subject.evaluationId,
            evidenceHeadHash: subject.evidenceSetHash,
            eligibilityVersion: key.eligibilityVersion,
            analysisGeneration,
            ...watermark,
          },
        });
      }

      const coverage = key.coverage;
      // LEGACY-COMPAT proof rows carry the as-observed domain and NO
      // anchor/declared/coverage fields (ADR-0026 §13); the JSON keys are
      // omitted so the columns stay SQL NULL and no declared intent is
      // invented for a snapshot that froze none.
      const proofData = {
        eligibilityVersion: key.eligibilityVersion,
        mode: key.mode,
        coverageMode: RUN_SCOPE_COVERAGE_MODE,
        analysisGeneration,
        ...watermark,
        coverageStatement: coverage?.coverageStatement ?? LEGACY_COVERAGE_STATEMENT,
        ...(coverage === null
          ? {}
          : {
              anchor: coverage.anchor as object,
              declaredSubjectsJson: [...coverage.declared] as object,
              eligibleSubjectsJson: [...coverage.eligible] as object,
              missingSubjectsJson: [...coverage.missing] as object,
              unexpectedSubjects: [...coverage.unexpected] as object,
              foreignInventory: [...coverage.foreign] as object,
              evidenceGaps: [...coverage.evidenceGaps] as object,
            }),
      };
      await tx.runEligibilityProof.upsert({
        where: {
          runId_invariantKey_evaluatorVersion: {
            runId,
            invariantKey: key.invariantKey,
            evaluatorVersion: key.evaluatorVersion,
          },
        },
        create: {
          runId,
          invariantKey: key.invariantKey,
          evaluatorVersion: key.evaluatorVersion,
          ...proofData,
        },
        update: proofData,
      });
    }

    return {
      published: true,
      analysisGeneration: analysisGeneration.toString(),
      reason: 'PUBLISHED',
      detail: `published ${String(keys.length)} proof row(s) and ${String(
        keys.reduce((total, key) => total + key.subjects.length, 0),
      )} pointer(s) at analysis generation ${analysisGeneration.toString()}`,
      changedComponents: [],
      watermark: serializeTruthInputWatermark(current),
    };
  }, PUBLICATION_TX);
}

/**
 * The frozen coverage limitation statement of a LEGACY-COMPAT proof row
 * (ADR-0026 §13: legacy snapshots carry no declared intent to prove
 * coverage against, and the row states that limitation explicitly).
 */
export const LEGACY_COVERAGE_STATEMENT =
  'legacy-compat: this snapshot froze no runScope/v1 declaration, so no declared verification domain exists to prove coverage against; the published subject domain is the as-observed domain and no coverage claim beyond it is made.';

// ---------------------------------------------------------------------
// Checkpoint D read surface: persisted publication + consistency reads
// ---------------------------------------------------------------------

/** A persisted pointer with its resolved evaluation row. */
export interface CurrentEvaluationRead {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly currentEvaluationId: string;
  readonly verdict: string;
  readonly evidenceHeadHash: string;
  readonly eligibilityVersion: string;
  readonly analysisGeneration: string;
  readonly integrityHeadHash: string | null;
  readonly integrityObservationCount: number;
  readonly provenanceRevision: string;
  readonly derivationGeneration: string;
}

/** A persisted eligibility/coverage proof row (never recomputed). */
export interface EligibilityProofRead {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly eligibilityVersion: string;
  readonly mode: string;
  readonly coverageMode: string;
  readonly analysisGeneration: string;
  readonly integrityHeadHash: string | null;
  readonly integrityObservationCount: number;
  readonly provenanceRevision: string;
  readonly derivationGeneration: string;
  readonly anchor: unknown;
  readonly declaredSubjects: unknown;
  readonly eligibleSubjects: unknown;
  readonly missingSubjects: unknown;
  readonly unexpectedSubjects: unknown;
  readonly foreignInventory: unknown;
  readonly evidenceGaps: unknown;
  readonly coverageStatement: string;
}

/** The consistency state of a run's current publication. */
export type CurrentPublicationState =
  | 'CURRENT'
  | 'MISSING_PROOF'
  | 'CURRENT_POINTER_STALE'
  | 'GENERATION_MISMATCH'
  | 'MISSING_SUBJECT_POINTER'
  | 'DERIVATION_NOT_READY'
  | 'RUN_NOT_TERMINAL';

/**
 * The read surface of the authoritative publication read: usable
 * standalone AND inside a lock-scoped interactive transaction (the
 * Boundary B authorization transaction reads the publication while
 * holding the per-run advisory lock).
 */
export type PublicationReadDb = PrismaClient | Prisma.TransactionClient;

export interface CurrentEvaluationPublicationRead {
  readonly runId: string;
  readonly present: boolean;
  readonly state: CurrentPublicationState;
  readonly reason: string;
  readonly current: SerializedTruthInputWatermark;
  readonly analysisGeneration: string | null;
  readonly proofs: readonly EligibilityProofRead[];
  readonly pointers: readonly CurrentEvaluationRead[];
  /** Declared-and-eligible subjects that carry no current pointer. */
  readonly missingSubjectPointers: readonly {
    readonly invariantKey: string;
    readonly subjectKey: string;
  }[];
}

/**
 * READ-ONLY publication read for the report/classifier (Checkpoint D).
 * The caller reads proof rows + pointers — it never selects rows, never
 * recomputes eligibility, and never re-derives truth. `state` names any
 * consistency violation; every non-`CURRENT` state is a fail-closed
 * eligibility inconsistency for the caller (§14 rule 5 / §15).
 */
export async function readCurrentEvaluationPublication(
  prisma: PublicationReadDb,
  runId: string,
): Promise<CurrentEvaluationPublicationRead> {
  // SEQUENTIAL on purpose: this reader is also called INSIDE the per-run
  // lock transactions (publication finalization, Boundary B report
  // authorization), where concurrent statements would be pipelined onto
  // the transaction's single connection by the driver adapter. Every
  // read is bounded and indexed; no scan is added by the sequencing.
  const current = await readTruthInputWatermark(prisma, runId);
  const serializedCurrent = serializeTruthInputWatermark(current);
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { state: true },
  });
  const proofRows = await prisma.runEligibilityProof.findMany({
    where: { runId },
    orderBy: [{ invariantKey: 'asc' }, { analysisGeneration: 'asc' }],
  });
  const pointerRows = await prisma.currentEvaluationPointer.findMany({
    where: { runId },
    orderBy: [{ invariantKey: 'asc' }, { subjectKey: 'asc' }, { analysisGeneration: 'asc' }],
    include: {
      currentEvaluation: { select: { verdict: true, evaluatorVersion: true } },
    },
  });
  const readiness = await readDerivationReadiness(prisma, runId, DERIVATION_KIND_RUN_EVIDENCE);

  const proofs: EligibilityProofRead[] = proofRows.map((row) => ({
    invariantKey: row.invariantKey,
    evaluatorVersion: row.evaluatorVersion,
    eligibilityVersion: row.eligibilityVersion,
    mode: row.mode,
    coverageMode: row.coverageMode,
    analysisGeneration: row.analysisGeneration.toString(),
    integrityHeadHash: row.integrityHeadHash,
    integrityObservationCount: row.integrityObservationCount,
    provenanceRevision: row.provenanceRevision.toString(),
    derivationGeneration: row.derivationGeneration.toString(),
    anchor: row.anchor,
    declaredSubjects: row.declaredSubjectsJson,
    eligibleSubjects: row.eligibleSubjectsJson,
    missingSubjects: row.missingSubjectsJson,
    unexpectedSubjects: row.unexpectedSubjects,
    foreignInventory: row.foreignInventory,
    evidenceGaps: row.evidenceGaps,
    coverageStatement: row.coverageStatement,
  }));
  const pointers: CurrentEvaluationRead[] = pointerRows.map((row) => ({
    invariantKey: row.invariantKey,
    evaluatorVersion: row.evaluatorVersion,
    subjectKey: row.subjectKey,
    currentEvaluationId: row.currentEvaluationId,
    verdict: row.currentEvaluation.verdict,
    evidenceHeadHash: row.evidenceHeadHash,
    eligibilityVersion: row.eligibilityVersion,
    analysisGeneration: row.analysisGeneration.toString(),
    integrityHeadHash: row.integrityHeadHash,
    integrityObservationCount: row.integrityObservationCount,
    provenanceRevision: row.provenanceRevision.toString(),
    derivationGeneration: row.derivationGeneration.toString(),
  }));

  const base = {
    runId,
    current: serializedCurrent,
    proofs,
    pointers,
  } as const;

  if (run !== null && run.state !== 'COMPLETED') {
    return {
      ...base,
      present: proofs.length > 0,
      state: 'RUN_NOT_TERMINAL',
      reason: `run state is ${run.state}; no current publication authorizes a decision`,
      analysisGeneration: null,
      missingSubjectPointers: [],
    };
  }
  if (proofs.length === 0) {
    return {
      ...base,
      present: false,
      state: 'MISSING_PROOF',
      reason: 'no persisted eligibility proof exists for this run — fail closed',
      analysisGeneration: null,
      missingSubjectPointers: [],
    };
  }

  // The authoritative generation is the shared counter every current proof
  // and pointer must carry (§13: one coherent analysisGeneration). It is
  // chosen by the COUNTER, never by timestamps or row order.
  let authoritativeGeneration = 0n;
  for (const proof of proofRows) {
    if (proof.analysisGeneration > authoritativeGeneration) {
      authoritativeGeneration = proof.analysisGeneration;
    }
  }
  const generationMismatch = proofRows.some(
    (proof) => proof.analysisGeneration !== authoritativeGeneration,
  );
  // The authoritative version per key: the greatest generation's row.
  const proofsAtGeneration = proofRows.filter(
    (proof) => proof.analysisGeneration === authoritativeGeneration,
  );
  const pointerMismatch = pointerRows.some(
    (pointer) =>
      pointer.analysisGeneration !== authoritativeGeneration ||
      !proofsAtGeneration.some(
        (proof) =>
          proof.invariantKey === pointer.invariantKey &&
          proof.evaluatorVersion === pointer.evaluatorVersion,
      ) ||
      pointer.currentEvaluation.evaluatorVersion !== pointer.evaluatorVersion,
  );
  const proofWatermarkStale = proofsAtGeneration.some(
    (proof) =>
      proof.integrityHeadHash !== current.chain.headContentHash ||
      proof.integrityObservationCount !== current.chain.observationCount ||
      proof.provenanceRevision !== current.provenanceRevision ||
      proof.derivationGeneration !== current.derivationGeneration,
  );
  const pointerWatermarkStale = pointerRows.some(
    (pointer) =>
      pointer.integrityHeadHash !== current.chain.headContentHash ||
      pointer.integrityObservationCount !== current.chain.observationCount ||
      pointer.provenanceRevision !== current.provenanceRevision ||
      pointer.derivationGeneration !== current.derivationGeneration,
  );

  const missingSubjectPointers: Array<{ invariantKey: string; subjectKey: string }> = [];
  for (const proof of proofsAtGeneration) {
    if (proof.mode !== PUBLICATION_MODE_STRICT) {
      continue;
    }
    const eligible = Array.isArray(proof.eligibleSubjectsJson)
      ? (proof.eligibleSubjectsJson as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
    for (const subjectKey of eligible) {
      const hasPointer = pointerRows.some(
        (pointer) =>
          pointer.invariantKey === proof.invariantKey &&
          pointer.evaluatorVersion === proof.evaluatorVersion &&
          pointer.subjectKey === subjectKey,
      );
      if (!hasPointer) {
        missingSubjectPointers.push({ invariantKey: proof.invariantKey, subjectKey });
      }
    }
  }

  const analysisGeneration = authoritativeGeneration.toString();
  if (generationMismatch || pointerMismatch) {
    return {
      ...base,
      present: true,
      state: 'GENERATION_MISMATCH',
      reason:
        'proof rows or pointers disagree on the shared analysisGeneration (or a pointer does not resolve to its proof version) — mixed-generation read refused',
      analysisGeneration,
      missingSubjectPointers,
    };
  }
  if (!readiness.complete) {
    return {
      ...base,
      present: true,
      state: 'DERIVATION_NOT_READY',
      reason: `derivation readiness is ${readiness.state} (${readiness.reason}) — the persisted selection is not authorized`,
      analysisGeneration,
      missingSubjectPointers,
    };
  }
  if (proofWatermarkStale || pointerWatermarkStale) {
    return {
      ...base,
      present: true,
      state: 'CURRENT_POINTER_STALE',
      reason:
        'the persisted proof/pointer watermark no longer names the current composite truth-input state — bounded re-analysis required, fail closed if the bound is exhausted',
      analysisGeneration,
      missingSubjectPointers,
    };
  }
  if (missingSubjectPointers.length > 0) {
    return {
      ...base,
      present: true,
      state: 'MISSING_SUBJECT_POINTER',
      reason:
        'an eligible subject of the persisted coverage proof carries no current pointer — missing verdict, never a PASS',
      analysisGeneration,
      missingSubjectPointers,
    };
  }
  return {
    ...base,
    present: true,
    state: 'CURRENT',
    reason: 'the persisted proof rows and pointers are current and internally consistent',
    analysisGeneration,
    missingSubjectPointers,
  };
}

/** Convenience: the current pointers of one (key, version), sorted by subject. */
export function pointersFor(
  read: CurrentEvaluationPublicationRead,
  invariantKey: string,
): readonly CurrentEvaluationRead[] {
  return read.pointers.filter((pointer) => pointer.invariantKey === invariantKey);
}
