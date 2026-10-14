// =====================================================================
// RuptureGrid Phase 17 — Checkpoint D: Boundary B report authorization
// (ADR-0026 §13 finalization contract; §14/§15/§18 read discipline)
// =====================================================================
// ONE short DB-only transaction authorizes ONE report decision:
//
//   1. acquire the SAME per-run transaction-scoped advisory lock the
//      append/provenance/publication writers use — acquired FIRST, READ
//      COMMITTED (no isolation override: a REPEATABLE READ snapshot
//      taken before the lock could exclude an append that committed
//      while waiting for the lock);
//   2. read the run's authoritative publication through Checkpoint C's
//      OWN read API (`readCurrentEvaluationPublication`) and the locked
//      composite truth-input watermark `W = (C, P, D)` — ONE eligibility
//      selector exists in the platform, and this transaction calls it
//      instead of re-deriving a second one. The read supplies the
//      per-key proof rows at the shared authoritative generation, the
//      current-evaluation pointers with their resolved verdicts, the
//      missing-subject-pointer set, and the named consistency state
//      (missing proof / generation mismatch / stale watermark /
//      derivation not ready / non-terminal run);
//   3. require the LOCKED chain identity to EQUAL the identity the
//      OUT-OF-LOCK chain verification covered (`(lastChainIndex,
//      headContentHash, observationCount)`) — a verification of a
//      different identity authorizes nothing; if the head advanced
//      while waiting for the lock, the disposition is `RETRY`
//      (re-verify + re-analyze within the frozen bound);
//   4. require every BOUND key to carry an authoritative proof row, and
//      apply the frozen coverage rules for the bound domain: declared
//      subjects with no eligible evidence, undeclared same-scope
//      subjects, persisted eligibility evidence gaps, pointers naming
//      subjects outside the authoritative eligible set;
//   5. apply the §15 foreign-row rule: a persisted evaluation row at a
//      STRICT BOUND key's authoritative version whose subject is outside
//      the run-owned domain is a consistency anomaly (exit 2) — never a
//      business FAIL, and never silently omitted;
//   6. resolve every database-resident report input the caller needs
//      (target/run identity, findings, reproduction reference, version
//      surfaces) INSIDE the lock through the caller's `loadFrozenInputs`
//      seam — DB-local bounded reads only;
//   7. commit (releasing the lock) and hand the caller FROZEN values.
//      Output is built strictly AFTER the commit from those values;
//      only `reportId`/`generatedAt` may be generated later.
//
// Dispositions (never a business verdict; the CLI's classifier owns the
// five-way reduction over the returned rows):
//   AUTHORIZED        — the publication is current and coherent, and the
//                       state is certified (integrity verified);
//   RETRY             — the locked state cannot authorize a decision
//                       *yet* (no/stale publication, moved verified
//                       identity, derivation marker unresolved): the
//                       caller re-analyzes (Boundary A) and retries
//                       within the frozen bound; exhaustion is
//                       classified fail-closed by the caller (exit 2 for
//                       business staleness);
//   NOT_EVALUABLE     — a persisted inconsistency that re-analysis
//                       cannot repair (generation/version mismatch,
//                       missing eligible pointer, missing declared
//                       subject, coverage/foreign anomalies): exit 2;
//   EXECUTION_FAILURE — the decision cannot be performed at all (run
//                       not terminal/missing, lock/statement timeout,
//                       unbound report inputs): exit 3.
//
// Every BUSINESS disposition (`RETRY` exhaustion, `NOT_EVALUABLE`)
// returns the SAME frozen AS-OF dataset `AUTHORIZED` returns — the
// locked watermark, the persisted publication state and the named
// anomalies — with `certified: false`. The caller therefore emits a
// schema-valid, explicitly UNCERTIFIED report and exits 2 (§11: business
// NOT_EVALUABLE is never an infrastructure failure). Only a disposition
// that could not complete the DB-only protocol at all (missing/non-
// terminal run, lock or statement timeout, unresolvable frozen inputs)
// returns no dataset and exits 3.
//
// An INTEGRITY-FAILED run (the caller's verification did not pass) is
// still frozen under the lock so the EXECUTION_FAILURE report can carry
// its audit surface — but `certified` is FALSE, no freshness gate is
// asserted (there is no business certification at issue), and the
// caller's rule-2 precedence guarantees exit 3. A report NEVER claims
// perpetual freshness: the returned watermark is the authorized AS-OF
// state; later evidence/provenance/derivation belongs to a newer
// analysis state.
//
// READ DISCIPLINE: every query this transaction issues is SEQUENTIAL.
// Concurrent Prisma calls inside an interactive transaction are batched
// onto the transaction's single connection by the driver adapter, which
// is exactly what `pg`'s "client is already executing a query"
// deprecation measures — a per-run lock transaction must never pipeline
// statements on its one connection. Nothing but bounded, indexed,
// DB-local reads happens here: no filesystem, no stdout, no network, no
// O(N) chain verification, no business evaluation.

import type { Prisma, PrismaClient } from '@rupturegrid/control-db';
import {
  DEFAULT_RUN_LOCK_TIMEOUT_MS,
  PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  PROVENANCE_TRANSACTION_TIMEOUT_MS,
  acquireRunLock,
} from '@rupturegrid/engine';
import {
  chainIdentitiesEqual,
  readTruthInputWatermark,
  serializeTruthInputWatermark,
} from './derivation-attempts.js';
import type { ChainIdentity, SerializedTruthInputWatermark } from './derivation-attempts.js';
import {
  PUBLICATION_MODE_STRICT,
  readCurrentEvaluationPublication,
} from './analysis-publication.js';
import type {
  CurrentEvaluationPublicationRead,
  EligibilityProofRead,
} from './analysis-publication.js';

/** The read surface accepted by every report-input loader (lock-scoped). */
export type ReportReadDb = PrismaClient | Prisma.TransactionClient;

/** Named, bounded authorization findings (never business verdicts). */
export type ReportAuthorizationAnomalyKind =
  | 'MISSING_PROOF'
  | 'GENERATION_MISMATCH'
  | 'WATERMARK_STALE'
  | 'VERIFIED_IDENTITY_ADVANCED'
  | 'DERIVATION_NOT_READY'
  | 'MISSING_SUBJECT_POINTER'
  | 'MISSING_DECLARED_SUBJECT'
  | 'COVERAGE_ANOMALY'
  | 'FOREIGN_ROW_ANOMALY'
  | 'EVALUATION_NOT_RESOLVED'
  | 'INTEGRITY_UNVERIFIED'
  | 'RUN_NOT_TERMINAL';

export interface ReportAuthorizationAnomaly {
  readonly kind: ReportAuthorizationAnomalyKind;
  readonly invariantKey: string | null;
  readonly subjectKey: string | null;
  readonly detail: string;
}

/** One authoritative proof row (greatest shared generation, per key). */
export interface AuthorizedKeyProof {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly eligibilityVersion: string;
  readonly mode: string;
  readonly coverageMode: string;
  readonly analysisGeneration: string;
  readonly declaredSubjects: readonly string[];
  readonly eligibleSubjects: readonly string[];
  readonly missingSubjects: readonly string[];
  readonly unexpectedSubjects: readonly unknown[];
  readonly foreignInventory: readonly unknown[];
  readonly evidenceGaps: readonly unknown[];
  readonly anchor: unknown;
  readonly coverageStatement: string;
}

/** One current-evaluation pointer with its resolved verdict row. */
export interface AuthorizedPointer {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly evaluationId: string;
  readonly verdict: string;
  readonly evidenceSetHash: string;
  readonly analysisGeneration: string;
}

/** One current evaluation row's full serializable content. */
export interface AuthorizedEvaluation {
  readonly evaluationId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly verdict: string;
  readonly reason: string;
  readonly evidenceSetHash: string;
  readonly details: Record<string, unknown>;
}

/** The frozen authorized state — every report byte derives from this. */
export interface AuthorizedReportState {
  readonly runId: string;
  readonly watermark: SerializedTruthInputWatermark;
  readonly analysisGeneration: string;
  /** Authoritative proof rows (shared generation), sorted by key. */
  readonly keys: readonly AuthorizedKeyProof[];
  readonly pointers: readonly AuthorizedPointer[];
  readonly evaluations: readonly AuthorizedEvaluation[];
  readonly anomalies: readonly ReportAuthorizationAnomaly[];
  /** TRUE only when the state was fully verified under the lock. */
  readonly certified: boolean;
}

export type ReportAuthorizationDisposition =
  'AUTHORIZED' | 'RETRY' | 'NOT_EVALUABLE' | 'EXECUTION_FAILURE';

export interface ReportAuthorizationResult<TFrozen> {
  readonly disposition: ReportAuthorizationDisposition;
  readonly authorized: boolean;
  /** Bounded machine-readable reason (never a business claim). */
  readonly reason: string;
  readonly anomalies: readonly ReportAuthorizationAnomaly[];
  /** Frozen publication state (present on AUTHORIZED and NE failures). */
  readonly state: AuthorizedReportState | null;
  /** Frozen non-publication inputs resolved under the lock. */
  readonly external: TFrozen | null;
}

export interface AuthorizeReportOptions<TFrozen> {
  /** The invariant keys the FROZEN snapshot binds (the required domain). */
  readonly boundInvariantKeys: readonly string[];
  /** The identity the OUT-OF-LOCK chain verification actually covered. */
  readonly verifiedChain: ChainIdentity;
  /** The verifier's result (`chainValid && contentHashesValid`). */
  readonly integrityVerified: boolean;
  /**
   * Resolves every database-resident report input the caller needs
   * (target/run identity, findings, reproduction reference, version
   * surfaces) INSIDE the authorization transaction. DB-local bounded
   * reads only — no filesystem, stdout, network, or chain scan.
   */
  readonly loadFrozenInputs: (db: ReportReadDb) => Promise<TFrozen>;
  /** Bounded wait for the per-run advisory lock (infrastructure bound). */
  readonly lockTimeoutMs?: number;
  /** Bounded transaction hold (the ADR's frozen 15 s provenance bound). */
  readonly transactionTimeoutMs?: number;
  readonly maxWaitMs?: number;
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const unknownArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One proof row in the frozen report vocabulary. */
function toAuthorizedKey(proof: EligibilityProofRead): AuthorizedKeyProof {
  return {
    invariantKey: proof.invariantKey,
    evaluatorVersion: proof.evaluatorVersion,
    eligibilityVersion: proof.eligibilityVersion,
    mode: proof.mode,
    coverageMode: proof.coverageMode,
    analysisGeneration: proof.analysisGeneration,
    declaredSubjects: stringArray(proof.declaredSubjects),
    eligibleSubjects: stringArray(proof.eligibleSubjects),
    missingSubjects: stringArray(proof.missingSubjects),
    unexpectedSubjects: unknownArray(proof.unexpectedSubjects),
    foreignInventory: unknownArray(proof.foreignInventory),
    evidenceGaps: unknownArray(proof.evidenceGaps),
    anchor: proof.anchor,
    coverageStatement: proof.coverageStatement,
  };
}

/**
 * Authorizes one report decision under the shared per-run lock
 * (ADR-0026 §13 Boundary B). See the header for the exact checklist.
 */
export async function authorizeReportFinalization<TFrozen>(
  prisma: PrismaClient,
  runId: string,
  options: AuthorizeReportOptions<TFrozen>,
): Promise<ReportAuthorizationResult<TFrozen>> {
  const txOptions = {
    timeout: options.transactionTimeoutMs ?? PROVENANCE_TRANSACTION_TIMEOUT_MS,
    maxWait: options.maxWaitMs ?? PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  };
  return prisma.$transaction(async (tx) => {
    // ---- 1. the SAME per-run lock; acquired FIRST. -------------------
    await acquireRunLock(tx, runId, options.lockTimeoutMs ?? DEFAULT_RUN_LOCK_TIMEOUT_MS);

    const refuse = (
      disposition: ReportAuthorizationDisposition,
      reason: string,
      anomalies: readonly ReportAuthorizationAnomaly[] = [],
    ): ReportAuthorizationResult<TFrozen> => ({
      disposition,
      authorized: false,
      reason,
      anomalies,
      state: null,
      external: null,
    });

    const freezeExternal = async (): Promise<
      | { readonly value: TFrozen; readonly error: null }
      | { readonly value: null; readonly error: ReportAuthorizationResult<TFrozen> }
    > => {
      try {
        return { value: await options.loadFrozenInputs(tx), error: null };
      } catch (error) {
        return {
          value: null,
          error: refuse(
            'EXECUTION_FAILURE',
            `the authorized report inputs could not be resolved under the lock: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        };
      }
    };

    // ---- 2. the LOCKED composite watermark + the authoritative
    //         publication read (Checkpoint C's ONE selector). Sequential
    //         statements only: this transaction owns one connection. ----
    const current = await readTruthInputWatermark(tx, runId);
    const lockedChain = current.chain;
    const watermark = serializeTruthInputWatermark(current);
    const publication: CurrentEvaluationPublicationRead = await readCurrentEvaluationPublication(
      tx,
      runId,
    );
    const authoritativeGeneration = publication.analysisGeneration ?? '0';

    // Every evaluation row the current pointers name, resolved once, so
    // the report carries the persisted reason/hash/details verbatim.
    const evaluationIds = [
      ...new Set(publication.pointers.map((entry) => entry.currentEvaluationId)),
    ];
    const evaluationRows =
      evaluationIds.length === 0
        ? []
        : await tx.invariantEvaluation.findMany({ where: { id: { in: evaluationIds } } });
    const evaluationById = new Map(evaluationRows.map((row) => [row.id, row]));

    /** Assembles the frozen state from the authoritative read. */
    const assembleState = (input: {
      readonly certified: boolean;
      readonly anomalies: readonly ReportAuthorizationAnomaly[];
    }): AuthorizedReportState => {
      const keys = publication.proofs
        .filter((proof) => proof.analysisGeneration === authoritativeGeneration)
        .map(toAuthorizedKey)
        .sort((a, b) => a.invariantKey.localeCompare(b.invariantKey));
      const pointers: AuthorizedPointer[] = [];
      const evaluations: AuthorizedEvaluation[] = [];
      for (const pointer of publication.pointers) {
        const row = evaluationById.get(pointer.currentEvaluationId);
        if (row === undefined) {
          continue;
        }
        pointers.push({
          invariantKey: pointer.invariantKey,
          evaluatorVersion: pointer.evaluatorVersion,
          subjectKey: pointer.subjectKey,
          evaluationId: row.id,
          verdict: row.verdict,
          evidenceSetHash: row.evidenceSetHash,
          analysisGeneration: pointer.analysisGeneration,
        });
        evaluations.push({
          evaluationId: row.id,
          invariantKey: row.invariantKey,
          evaluatorVersion: row.evaluatorVersion,
          subjectKey: row.subjectKey,
          verdict: row.verdict,
          reason: row.reason,
          evidenceSetHash: row.evidenceSetHash,
          details: (row.details ?? {}) as Record<string, unknown>,
        });
      }
      const bySubject = (
        a: { invariantKey: string; subjectKey: string },
        b: { invariantKey: string; subjectKey: string },
      ): number =>
        a.invariantKey.localeCompare(b.invariantKey) || a.subjectKey.localeCompare(b.subjectKey);
      return {
        runId,
        watermark,
        analysisGeneration: authoritativeGeneration,
        keys,
        pointers: pointers.sort(bySubject),
        evaluations: evaluations.sort(bySubject),
        anomalies: input.anomalies,
        certified: input.certified,
      };
    };

    /**
     * A BUSINESS refusal (`RETRY`/`NOT_EVALUABLE`): the decision cannot
     * be taken, but the run still owes an auditable AS-OF artifact. The
     * locked watermark, the persisted publication state and the named
     * anomalies are frozen together with the non-publication report
     * inputs, so the caller emits an explicitly UNCERTIFIED report at
     * exit 2 (ADR-0026 §13; §11: business NE ≠ infrastructure failure).
     * If the frozen inputs cannot be resolved the refusal degrades to
     * the honest infrastructure failure (exit 3).
     */
    const businessRefuse = async (
      disposition: 'RETRY' | 'NOT_EVALUABLE',
      reason: string,
      anomalies: readonly ReportAuthorizationAnomaly[],
    ): Promise<ReportAuthorizationResult<TFrozen>> => {
      const state = assembleState({ certified: false, anomalies });
      const frozen = await freezeExternal();
      if (frozen.error !== null) {
        return frozen.error;
      }
      return {
        disposition,
        authorized: false,
        reason,
        anomalies,
        state,
        external: frozen.value,
      };
    };

    // ---- Integrity-failed freeze (exit-3 audit surface only). ---------
    // No freshness claim is asserted here: the decision is rule-2
    // EXECUTION_FAILURE regardless of which prefix is visible, so the
    // audit surface is frozen without a certification statement.
    if (!options.integrityVerified) {
      const anomalies: ReportAuthorizationAnomaly[] = [
        {
          kind: 'INTEGRITY_UNVERIFIED',
          invariantKey: null,
          subjectKey: null,
          detail: 'integrity-unverified freeze: no certified business decision is taken',
        },
      ];
      const state = assembleState({ certified: false, anomalies });
      const frozen = await freezeExternal();
      if (frozen.error !== null) {
        return frozen.error;
      }
      return {
        disposition: 'AUTHORIZED',
        authorized: true,
        reason:
          'integrity-unverified freeze: the report decision is EXECUTION_FAILURE by precedence',
        anomalies: [],
        state,
        external: frozen.value,
      };
    }

    // ---- 3. terminal execution truth (rule 1). ------------------------
    if (publication.state === 'RUN_NOT_TERMINAL') {
      return refuse('EXECUTION_FAILURE', `RUN_NOT_TERMINAL: ${publication.reason}`, [
        {
          kind: 'RUN_NOT_TERMINAL',
          invariantKey: null,
          subjectKey: null,
          detail: publication.reason,
        },
      ]);
    }

    // ---- 4. the publication's own consistency state (C's selector). ----
    const missingBoundKeys = [...new Set(options.boundInvariantKeys)].filter(
      (key) => !publication.proofs.some((proof) => proof.invariantKey === key),
    );
    if (publication.state === 'MISSING_PROOF') {
      return await businessRefuse(
        'RETRY',
        `MISSING_PROOF: ${publication.reason} — a completed analysis publication is required before a decision${
          missingBoundKeys.length === 0
            ? ''
            : `; bound key(s) without an authoritative publication: ${missingBoundKeys.sort().join(', ')}`
        }`,
        [
          {
            kind: 'MISSING_PROOF',
            invariantKey: null,
            subjectKey: null,
            detail: 'no run_eligibility_proof row exists for the run',
          },
          ...missingBoundKeys.map((key) => ({
            kind: 'MISSING_PROOF' as const,
            invariantKey: key,
            subjectKey: null,
            detail: 'a bound invariant key has no authoritative proof row',
          })),
        ],
      );
    }
    if (missingBoundKeys.length > 0) {
      return await businessRefuse(
        'RETRY',
        `MISSING_PROOF: bound invariant key(s) without an authoritative publication: ${missingBoundKeys.sort().join(', ')}`,
        missingBoundKeys.map((key) => ({
          kind: 'MISSING_PROOF' as const,
          invariantKey: key,
          subjectKey: null,
          detail: 'a bound invariant key has no authoritative proof row',
        })),
      );
    }
    if (publication.state === 'GENERATION_MISMATCH') {
      return await businessRefuse('NOT_EVALUABLE', `GENERATION_MISMATCH: ${publication.reason}`, [
        {
          kind: 'GENERATION_MISMATCH',
          invariantKey: null,
          subjectKey: null,
          detail: publication.reason,
        },
      ]);
    }
    if (publication.state === 'DERIVATION_NOT_READY') {
      return await businessRefuse(
        'RETRY',
        `DERIVATION_NOT_READY: ${publication.reason} — the derived projection is not proven complete for the locked source`,
        [
          {
            kind: 'DERIVATION_NOT_READY',
            invariantKey: null,
            subjectKey: null,
            detail: publication.reason,
          },
        ],
      );
    }
    if (publication.state === 'CURRENT_POINTER_STALE') {
      return await businessRefuse(
        'RETRY',
        'WATERMARK_STALE: the persisted proof/pointer watermark does not name the locked composite truth-input state — bounded re-analysis required',
        [
          {
            kind: 'WATERMARK_STALE',
            invariantKey: null,
            subjectKey: null,
            detail: publication.reason,
          },
        ],
      );
    }
    if (publication.state === 'MISSING_SUBJECT_POINTER') {
      return await businessRefuse(
        'NOT_EVALUABLE',
        `MISSING_SUBJECT_POINTER: ${publication.reason}`,
        publication.missingSubjectPointers.map((entry) => ({
          kind: 'MISSING_SUBJECT_POINTER' as const,
          invariantKey: entry.invariantKey,
          subjectKey: entry.subjectKey,
          detail: 'an eligible subject of the persisted coverage proof carries no current pointer',
        })),
      );
    }

    const anomalies: ReportAuthorizationAnomaly[] = [];

    // ---- 5. verified-prefix binding (the locked chain identity). -------
    if (!chainIdentitiesEqual(lockedChain, options.verifiedChain)) {
      // The head moved while waiting for the lock: the verification did
      // not cover the locked prefix. Re-verification is required — this
      // is a bounded RETRY, never a decision against an unverified head.
      return await businessRefuse(
        'RETRY',
        'VERIFIED_IDENTITY_ADVANCED: the locked chain identity no longer equals the identity the evidence verification covered — re-verify and re-analyze within the bound',
        [
          {
            kind: 'VERIFIED_IDENTITY_ADVANCED',
            invariantKey: null,
            subjectKey: null,
            detail: `locked count=${String(lockedChain.observationCount)} hash=${lockedChain.headContentHash ?? 'none'}; verified count=${String(options.verifiedChain.observationCount)} hash=${options.verifiedChain.headContentHash ?? 'none'}`,
          },
        ],
      );
    }

    // ---- 6. coverage rules for the BOUND domain (§14/§15). ------------
    const proofsAtGeneration = publication.proofs.filter(
      (proof) => proof.analysisGeneration === authoritativeGeneration,
    );
    for (const proof of proofsAtGeneration) {
      const bound = options.boundInvariantKeys.includes(proof.invariantKey);
      // A current pointer whose evaluation row the database no longer
      // resolves is an unreadable publication (never silently dropped).
      for (const pointer of publication.pointers) {
        if (
          pointer.invariantKey === proof.invariantKey &&
          evaluationById.get(pointer.currentEvaluationId) === undefined
        ) {
          anomalies.push({
            kind: 'EVALUATION_NOT_RESOLVED',
            invariantKey: pointer.invariantKey,
            subjectKey: pointer.subjectKey,
            detail: 'a current pointer does not resolve to a readable evaluation row',
          });
        }
      }
      if (proof.mode !== PUBLICATION_MODE_STRICT || !bound) {
        continue;
      }
      const eligible = stringArray(proof.eligibleSubjects);
      const missing = stringArray(proof.missingSubjects);
      const unexpected = unknownArray(proof.unexpectedSubjects);
      const gaps = unknownArray(proof.evidenceGaps);
      for (const subjectKey of missing) {
        anomalies.push({
          kind: 'MISSING_DECLARED_SUBJECT',
          invariantKey: proof.invariantKey,
          subjectKey,
          detail: 'a declared subject has no eligible evidence (missing verdict, never a PASS)',
        });
      }
      for (const [index, entry] of unexpected.entries()) {
        anomalies.push({
          kind: 'COVERAGE_ANOMALY',
          invariantKey: proof.invariantKey,
          subjectKey:
            isRecord(entry) && typeof entry['subjectKey'] === 'string' ? entry['subjectKey'] : null,
          detail: `undeclared same-scope subject observed (class B) at index ${String(index)}`,
        });
      }
      for (const [index] of gaps.entries()) {
        anomalies.push({
          kind: 'COVERAGE_ANOMALY',
          invariantKey: proof.invariantKey,
          subjectKey: null,
          detail: `eligibility evidence gap persisted at index ${String(index)}`,
        });
      }
      // A current pointer for a subject OUTSIDE the authoritative
      // eligible set is a publication inconsistency (never folded in).
      for (const pointer of publication.pointers) {
        if (pointer.invariantKey === proof.invariantKey && !eligible.includes(pointer.subjectKey)) {
          anomalies.push({
            kind: 'COVERAGE_ANOMALY',
            invariantKey: proof.invariantKey,
            subjectKey: pointer.subjectKey,
            detail: 'a current pointer names a subject outside the authoritative eligible set',
          });
        }
      }
    }

    // Foreign persisted rows at the authoritative version of a STRICT
    // BOUND key: subjects outside the declared/eligible/missing domain.
    // The rule is scoped to the authoritative version (§15): pre-gating
    // `v1` rows and other-version history are labeled history, never
    // anomalies.
    const strictBoundProofs = proofsAtGeneration.filter(
      (proof) =>
        proof.mode === PUBLICATION_MODE_STRICT &&
        options.boundInvariantKeys.includes(proof.invariantKey),
    );
    for (const proof of strictBoundProofs) {
      const expected = new Set([
        ...stringArray(proof.declaredSubjects),
        ...stringArray(proof.eligibleSubjects),
        ...stringArray(proof.missingSubjects),
      ]);
      const rows = await tx.invariantEvaluation.findMany({
        where: {
          runId,
          invariantKey: proof.invariantKey,
          evaluatorVersion: proof.evaluatorVersion,
        },
        select: { subjectKey: true },
        distinct: ['subjectKey'],
      });
      for (const row of rows) {
        if (!expected.has(row.subjectKey)) {
          anomalies.push({
            kind: 'FOREIGN_ROW_ANOMALY',
            invariantKey: proof.invariantKey,
            subjectKey: row.subjectKey,
            detail:
              'a persisted evaluation row at the authoritative version names a subject outside the run-owned domain — consistency anomaly, never a business failure',
          });
        }
      }
    }

    if (anomalies.length > 0) {
      return await businessRefuse(
        'NOT_EVALUABLE',
        `ELIGIBILITY_INCONSISTENCY: ${[...new Set(anomalies.map((anomaly) => anomaly.kind))].join(', ')}`,
        anomalies,
      );
    }

    // ---- 7. freeze the stable state + all DB-resident report inputs. ---
    const state = assembleState({ certified: true, anomalies: [] });
    const frozen = await freezeExternal();
    if (frozen.error !== null) {
      return frozen.error;
    }
    return {
      disposition: 'AUTHORIZED',
      authorized: true,
      reason: `authorized at analysisGeneration ${authoritativeGeneration} over ${String(state.keys.length)} proof row(s) and ${String(state.pointers.length)} current pointer(s)`,
      anomalies: [],
      state,
      external: frozen.value,
    };
  }, txOptions);
}
