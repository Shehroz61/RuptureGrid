// =====================================================================
// RuptureGrid v1.1 Phase 17 — the five-way exit contract (ADR-0019 §2;
// Checkpoint D eligibility-aware multi-subject set reduction — ADR-0026
// §14/§15/§16)
// =====================================================================
// A pure, deterministic classifier over DURABLE, AUTHORIZED truth. It
// never reads target state, never interprets evidence, never consults
// scenario expectations, and never selects rows: the verdict domain is
// the frozen authorization state (current-evaluation pointers resolved
// under the Boundary B lock), keyed by (invariantKey, subjectKey) END TO
// END — the audited per-key `Map` collapse (EXIT-MAP-COLLAPSE) is GONE
// with no replacement shape. PASS never overwrites FAIL or
// NOT_EVALUABLE because verdicts are never collapsed across subjects:
// the sets are reduced independently in precedence order, so no row
// order or enumeration order can change the exit.
//
// Precedence is frozen (evaluated top-down; first match wins):
//
//   1. execution/integrity failure            → 3 EXECUTION_FAILURE
//      (evidence-integrity failure DOMINATES a persisted FAIL: a FAIL
//      resting on an unverifiable evidence chain cannot produce exit 1)
//   2. any bound eligible subject FAIL        → 1 INVARIANT_FAIL
//      (FAIL dominates NOT_EVALUABLE; the report lists every set)
//   3. NOT_EVALUABLE / missing verdict /
//      coverage or foreign anomaly /
//      authorization inconsistency           → 2 NOT_EVALUABLE
//   4. every bound key's eligible verdicts
//      PASS, with a complete bound domain     → 0 PASS
//      (never a vacuous pass: a bound key with zero current subjects is
//      a missing verdict, and a scenario binding zero invariants can
//      never pass)
//
// The reduction operates on BOUND keys — the invariant keys the FROZEN
// snapshot binds (ADR-0026 §14 rule 6; `boundInvariantKeysOf`). Keys the
// run evaluated without binding (e.g. the legacy INCIDENT-ZERO evaluators
// on a manifest-bound run) remain visible in the report's history
// surface but do not classify: the run's own declared domain is the
// domain whose completeness it must prove.
//
// Usage errors (invalid scenario/flags/selector) are rejected BEFORE
// execution and map to 4 USAGE_ERROR in the CLI layer — they never
// reach this classifier because no run exists.
//
// Scenario expectations are NOT an input: if an expectation says PASS
// but durable truth says FAIL, this classifier returns FAIL.

/**
 * The five exit classes (closed vocabulary, ADR-0019 §2).
 */
export const EXIT_CLASSES = {
  PASS: 'PASS',
  INVARIANT_FAIL: 'INVARIANT_FAIL',
  NOT_EVALUABLE: 'NOT_EVALUABLE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE',
  USAGE_ERROR: 'USAGE_ERROR',
} as const;
export type ExitClass = (typeof EXIT_CLASSES)[keyof typeof EXIT_CLASSES];

export const EXIT_CODES = {
  PASS: 0,
  INVARIANT_FAIL: 1,
  NOT_EVALUABLE: 2,
  EXECUTION_FAILURE: 3,
  USAGE_ERROR: 4,
} as const satisfies Record<ExitClass, number>;

/** The exit-code/class pairing is closed and consistent by construction. */
export function exitCodeFor(exitClass: ExitClass): number {
  return EXIT_CODES[exitClass];
}

export function exitClassFor(code: number): ExitClass | null {
  for (const [key, value] of Object.entries(EXIT_CODES)) {
    if (value === code) {
      return key as ExitClass;
    }
  }
  return null;
}

/** The frozen coverage-mode labels (ADR-0026 §13). */
export const EXIT_MODE_STRICT = 'strict-coverage/v1';
export const EXIT_MODE_LEGACY = 'legacy-compat';

/**
 * ONE current eligible subject verdict — the classifier's verdict
 * domain is a SET of these, keyed by (invariantKey, subjectKey) end to
 * end. Never collapsed per key.
 */
export interface SubjectVerdict {
  readonly invariantKey: string;
  readonly subjectKey: string;
  readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
  /** The key's authoritative publication mode (same for every subject). */
  readonly mode: string;
  readonly evaluatorVersion: string;
}

/**
 * One bound key's persisted domain (from its authoritative proof row).
 * `mode === null` means NO authoritative proof row exists for the bound
 * key — a missing verdict, never a pass.
 */
export interface BoundKeyDomain {
  readonly invariantKey: string;
  readonly mode: string | null;
  readonly evaluatorVersion: string | null;
  readonly declaredSubjects: readonly string[];
  readonly eligibleSubjects: readonly string[];
  readonly missingSubjects: readonly string[];
  readonly unexpectedSubjectCount: number;
  readonly evidenceGapCount: number;
}

/** One named authorization/consistency anomaly (never a verdict). */
export interface ExitAnomaly {
  readonly kind: string;
  readonly invariantKey: string | null;
  readonly subjectKey: string | null;
  readonly detail: string;
}

/** Inputs to the classifier — every field is durable, authorized truth. */
export interface ExitClassificationInput {
  /**
   * Terminal execution truth. `undefined` = the run never reached a
   * terminal state (e.g. wait timeout — itself an execution failure).
   */
  readonly runTerminalState?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | undefined;
  /** Why execution failed / timed out (bounded, secret-free), when it did. */
  readonly executionFailureReason?: string | undefined;
  /**
   * Evidence-chain verification result. `undefined` = verification
   * could not be performed (also an integrity failure — fail closed).
   */
  readonly evidenceIntegrityVerified?: boolean | undefined;
  /** Every current eligible subject verdict (bound keys only). */
  readonly subjectVerdicts: readonly SubjectVerdict[];
  /** The bound keys and their authoritative persisted domains. */
  readonly boundKeyDomains: readonly BoundKeyDomain[];
  /** Named anomalies from the authorization read (coverage/foreign/…). */
  readonly anomalies: readonly ExitAnomaly[];
  /**
   * The reason the publication could not be authorized at all (bounded
   * re-analysis exhaustion / eligibility inconsistency). Presence forces
   * NOT_EVALUABLE unless a higher-precedence rule matches.
   */
  readonly authorizationFailure?: string | undefined;
}

export interface ExitClassification {
  readonly exitClass: ExitClass;
  readonly exitCode: number;
  /** Deterministic, bounded human rationale (secret-free). */
  readonly reason: string;
  /** The rule (1–4) that produced the class — auditability metadata. */
  readonly precedenceRule: 1 | 2 | 3 | 4;
}

/**
 * Classifies the exit per the frozen precedence. Pure and total: every
 * input combination yields exactly one class. Set-based: no sorting,
 * insertion order, or enumeration order can change the outcome.
 */
export function classifyExit(input: ExitClassificationInput): ExitClassification {
  // ---- Rule 1: execution truth / evidence integrity failure → 3. ----
  if (input.runTerminalState === undefined) {
    return classified(
      EXIT_CLASSES.EXECUTION_FAILURE,
      input.executionFailureReason ??
        'the run did not reach a terminal state (no trusted execution truth exists)',
      1,
    );
  }
  if (input.runTerminalState !== 'COMPLETED') {
    return classified(
      EXIT_CLASSES.EXECUTION_FAILURE,
      input.executionFailureReason ?? `run terminal state is ${input.runTerminalState}`,
      1,
    );
  }
  if (input.evidenceIntegrityVerified !== true) {
    // Integrity failure DOMINATES business verdicts (ADR-0019 §2
    // precedence rule 1): a FAIL resting on an unverifiable evidence
    // chain cannot produce exit 1. The report surfaces persisted
    // evaluations as clearly untrusted.
    return classified(
      EXIT_CLASSES.EXECUTION_FAILURE,
      input.executionFailureReason ??
        'evidence-chain integrity verification failed or could not be performed',
      1,
    );
  }

  // ---- Rule 2: any BOUND eligible subject FAIL → 1 (§14 rule 4). ----
  const fails = input.subjectVerdicts
    .filter((verdict) => verdict.verdict === 'FAIL')
    .map((verdict) => `${verdict.invariantKey}/${verdict.subjectKey}`);
  if (fails.length > 0) {
    return classified(
      EXIT_CLASSES.INVARIANT_FAIL,
      `bound subject evaluation(s) FAIL: ${[...fails].sort().join(', ')}`,
      2,
    );
  }

  // ---- Rule 3: NE / missing / anomaly / inconsistency → 2 (§14 rule 5). ----
  const notEvaluableReasons: string[] = [];
  const domains = new Map(input.boundKeyDomains.map((domain) => [domain.invariantKey, domain]));
  for (const domain of input.boundKeyDomains) {
    if (domain.mode === null) {
      notEvaluableReasons.push(`bound invariant ${domain.invariantKey} has no authoritative proof`);
      continue;
    }
    if (domain.mode === EXIT_MODE_STRICT) {
      if (domain.declaredSubjects.length === 0) {
        notEvaluableReasons.push(
          `bound invariant ${domain.invariantKey} declares no subject (no covered domain exists)`,
        );
      }
      for (const subjectKey of domain.missingSubjects) {
        notEvaluableReasons.push(
          `bound invariant ${domain.invariantKey} is missing declared subject ${subjectKey}`,
        );
      }
      if (domain.unexpectedSubjectCount > 0) {
        notEvaluableReasons.push(
          `bound invariant ${domain.invariantKey} has ${String(domain.unexpectedSubjectCount)} undeclared same-scope subject(s) (coverage anomaly)`,
        );
      }
      if (domain.evidenceGapCount > 0) {
        notEvaluableReasons.push(
          `bound invariant ${domain.invariantKey} has ${String(domain.evidenceGapCount)} persisted eligibility evidence gap(s)`,
        );
      }
      for (const subjectKey of domain.eligibleSubjects) {
        const verdict = input.subjectVerdicts.find(
          (entry) => entry.invariantKey === domain.invariantKey && entry.subjectKey === subjectKey,
        );
        if (verdict === undefined) {
          notEvaluableReasons.push(
            `bound invariant ${domain.invariantKey} is missing a current verdict for eligible subject ${subjectKey}`,
          );
        }
      }
    }
    const keyVerdicts = input.subjectVerdicts.filter(
      (entry) => entry.invariantKey === domain.invariantKey,
    );
    if (keyVerdicts.length === 0) {
      // A bound key — legacy or strict — with ZERO current evaluations is
      // a missing verdict, never a vacuous pass (ADR-0026 §14 rule 6).
      // The reason states the persisted fact in the domain's own words:
      // the run has no persisted verdict for the key's subject domain.
      notEvaluableReasons.push(
        `bound invariant ${domain.invariantKey} has no persisted verdict for its subject domain (missing verdict = NOT_EVALUABLE, never a PASS)`,
      );
    }
    for (const verdict of keyVerdicts) {
      if (verdict.verdict === 'NOT_EVALUABLE') {
        notEvaluableReasons.push(
          `bound invariant ${domain.invariantKey} subject ${verdict.subjectKey} is NOT_EVALUABLE`,
        );
      }
    }
  }
  // A bound key with no domain entry at all is a missing domain.
  for (const verdict of input.subjectVerdicts) {
    if (!domains.has(verdict.invariantKey)) {
      notEvaluableReasons.push(
        `subject verdict names an unbound invariant ${verdict.invariantKey}`,
      );
    }
  }
  for (const anomaly of input.anomalies) {
    notEvaluableReasons.push(
      `${anomaly.kind}${anomaly.invariantKey === null ? '' : ` (${anomaly.invariantKey}${anomaly.subjectKey === null ? '' : `/${anomaly.subjectKey}`})`}: ${anomaly.detail}`,
    );
  }
  if (input.authorizationFailure !== undefined) {
    notEvaluableReasons.push(`publication not authorized: ${input.authorizationFailure}`);
  }
  if (notEvaluableReasons.length > 0) {
    return classified(
      EXIT_CLASSES.NOT_EVALUABLE,
      [...new Set(notEvaluableReasons)].sort().join('; ').slice(0, 500),
      3,
    );
  }

  // ---- Rule 4: the complete bound domain PASSes → 0 (§14 rule 6). ----
  if (input.boundKeyDomains.length === 0) {
    // Structural guard: a scenario binding zero invariants can never
    // produce a business PASS — there is no covered domain to prove.
    return classified(
      EXIT_CLASSES.NOT_EVALUABLE,
      'the scenario binds no invariants; no trusted verdict exists to classify',
      3,
    );
  }
  return classified(
    EXIT_CLASSES.PASS,
    `run COMPLETED, evidence chain verified, and every eligible subject of all ${String(input.boundKeyDomains.length)} bound invariant(s) PASS`,
    4,
  );
}

function classified(
  exitClass: ExitClass,
  reason: string,
  precedenceRule: 1 | 2 | 3 | 4,
): ExitClassification {
  return { exitClass, exitCode: EXIT_CODES[exitClass], reason, precedenceRule };
}
