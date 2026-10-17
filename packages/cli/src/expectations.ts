// =====================================================================
// RuptureGrid v1.1 Phase 18 — acceptance-expectation assertions
// (ADR-0019 Decision 4; incident-replay §1.6)
// =====================================================================
// Expectations are NEVER truth: they never influence evaluation,
// findings, report truth, or exit classification (the classifier in
// exit-code.ts never sees them). This module is the explicit,
// committed assertion surface that regression suites (and CI recipes)
// use AFTER the report exists: it compares the FINISHED report's exit
// class and per-(invariantKey, subjectKey) verdicts against the
// declared acceptance expectations and reports mismatches.
//
// Two expectation shapes exist in durable truth and both normalize to
// the same assertion input:
//   - scenario documents (`expectations: { exitClass?,
//     invariantVerdicts?: { [key]: verdict } }` — scenario.ts), and
//   - reproduction definitions (`acceptanceExpectations: { expectations:
//     [{ invariantKey, evaluatorVersion, expectedVerdicts }] }` —
//     the original run's own verdict classes per bound invariant).
// The assertion is pure and total: every input yields exactly one
// matched/mismatched result with bounded, secret-free mismatch text.

import type { EXPECTED_EXIT_CLASSES, EXPECTED_VERDICTS } from './scenario.js';

export type ExpectedExitClassName = (typeof EXPECTED_EXIT_CLASSES)[number];
export type ExpectedVerdictName = (typeof EXPECTED_VERDICTS)[number];

/** Normalized acceptance expectations (never truth — assertion only). */
export interface AcceptanceExpectations {
  /** Unsupported input is visible and prevents an assertion from matching. */
  readonly normalizationIssues?: readonly string[] | undefined;
  readonly exitClass?: ExpectedExitClassName | undefined;
  readonly invariantVerdicts?: Readonly<Record<string, ExpectedVerdictName>> | undefined;
}

/** The finished-report surface the assertion reads (no evaluation here). */
export interface ExpectationReportView {
  readonly exitClass: string;
  readonly invariantEvaluations: ReadonlyArray<{
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly verdict: string;
  }>;
}

export interface ExpectationAssertion {
  readonly matched: boolean;
  /** Bounded, secret-free mismatch lines (empty when matched). */
  readonly mismatches: readonly string[];
}

/**
 * Normalizes a scenario `expectations` block to assertion input.
 * Unknown fields are ignored here (the closed-schema validator owns
 * rejection); absent blocks normalize to "expect nothing".
 */
export function expectationsFromScenario(raw: unknown): AcceptanceExpectations {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { normalizationIssues: ['scenario expectations are malformed'] };
  }
  const record = raw as Record<string, unknown>;
  const out: {
    exitClass?: ExpectedExitClassName;
    invariantVerdicts?: Record<string, ExpectedVerdictName>;
  } = {};
  const issues: string[] = [];
  if (typeof record['exitClass'] === 'string') {
    out.exitClass = record['exitClass'] as ExpectedExitClassName;
    if (
      !['PASS', 'INVARIANT_FAIL', 'NOT_EVALUABLE', 'EXECUTION_FAILURE', 'USAGE_ERROR'].includes(
        record['exitClass'],
      )
    ) {
      issues.push('scenario expectation has an unsupported exit class');
    }
  } else if (record['exitClass'] !== undefined) {
    issues.push('scenario expectation has an unsupported exit class');
  }
  const verdicts = record['invariantVerdicts'];
  if (typeof verdicts === 'object' && verdicts !== null && !Array.isArray(verdicts)) {
    const map: Record<string, ExpectedVerdictName> = Object.create(null) as Record<
      string,
      ExpectedVerdictName
    >;
    for (const [key, verdict] of Object.entries(verdicts as Record<string, unknown>)) {
      if (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'NOT_EVALUABLE') {
        map[key] = verdict;
      } else {
        issues.push('scenario invariant expectation has an unsupported verdict');
      }
    }
    out.invariantVerdicts = map;
  } else if (verdicts !== undefined) {
    issues.push('scenario invariant expectations are malformed');
  }
  return { ...out, ...(issues.length === 0 ? {} : { normalizationIssues: issues }) };
}

/**
 * Normalizes a reproduction definition's `acceptanceExpectations`
 * (`{ expectations: [{ invariantKey, expectedVerdicts }] }` — the
 * original run's own verdict classes) to assertion input. An invariant
 * with exactly one expected verdict asserts it; unsupported shapes
 * produce explicit issues which prevent a successful assertion.
 * Exit-class expectations never live in
 * reproduction rows (they are scenario intent); callers pass the
 * scenario's exitClass separately when they have one.
 */
export function expectationsFromReproduction(
  raw: unknown,
  exitClass?: ExpectedExitClassName | undefined,
): AcceptanceExpectations {
  const map: Record<string, ExpectedVerdictName> = Object.create(null) as Record<
    string,
    ExpectedVerdictName
  >;
  const issues: string[] = [];
  const seen = new Set<string>();
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const list = (raw as Record<string, unknown>)['expectations'];
    if (Array.isArray(list)) {
      if (list.length === 0) {
        issues.push('reproduction expectations list is empty');
      }
      for (const [index, entry] of list.entries()) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          issues.push(`reproduction expectation ${String(index)} is malformed`);
          continue;
        }
        const record = entry as Record<string, unknown>;
        const key = record['invariantKey'];
        const verdicts = record['expectedVerdicts'];
        if (typeof key !== 'string' || !Array.isArray(verdicts) || verdicts.length !== 1) {
          issues.push(
            `reproduction expectation ${String(index)} requires a key and exactly one supported verdict`,
          );
          continue;
        }
        if (seen.has(key)) {
          issues.push(`reproduction expectation ${String(index)} duplicates an invariant key`);
          continue;
        }
        seen.add(key);
        const verdict = verdicts[0];
        if (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'NOT_EVALUABLE') {
          map[key] = verdict;
        } else {
          issues.push(`reproduction expectation ${String(index)} has an unsupported verdict`);
        }
      }
    } else {
      issues.push('reproduction expectations list is missing or malformed');
    }
  } else {
    issues.push('reproduction expectations are missing or malformed');
  }
  return {
    ...(exitClass === undefined ? {} : { exitClass }),
    ...(Object.keys(map).length === 0 ? {} : { invariantVerdicts: map }),
    ...(issues.length === 0 ? {} : { normalizationIssues: issues.slice(0, 20) }),
  };
}

/**
 * Asserts normalized expectations against a finished report. Pure:
 * reads the report's exit class and per-subject verdicts only. A
 * per-key expectation requires EVERY reported evaluation of that key
 * to carry the expected verdict (subjects stay distinct — a key with
 * mixed verdicts mismatches honestly rather than collapsing). Keys
 * with no reported evaluation mismatch as missing (never a vacuous
 * pass). Unknown expectation keys (not bound/reported) mismatch as
 * unbound (never silently dropped).
 */
export function assertAcceptanceExpectations(
  report: ExpectationReportView,
  expected: AcceptanceExpectations,
): ExpectationAssertion {
  const mismatches: string[] = [...(expected.normalizationIssues ?? [])];
  if (
    expected.exitClass === undefined &&
    Object.keys(expected.invariantVerdicts ?? {}).length === 0 &&
    mismatches.length === 0
  ) {
    mismatches.push('no acceptance expectations were declared; an empty assertion never matches');
  }
  if (expected.exitClass !== undefined && report.exitClass !== expected.exitClass) {
    mismatches.push(
      `exit class is ${report.exitClass}; expected ${expected.exitClass} (expectations never change truth — the report stands)`,
    );
  }
  const byKey = new Map<string, string[]>();
  for (const evaluation of report.invariantEvaluations) {
    const list = byKey.get(evaluation.invariantKey) ?? [];
    list.push(evaluation.verdict);
    byKey.set(evaluation.invariantKey, list);
  }
  for (const [key, verdict] of Object.entries(expected.invariantVerdicts ?? {})) {
    const observed = byKey.get(key);
    if (observed === undefined || observed.length === 0) {
      mismatches.push(
        `invariant ${key} has no reported evaluation; expected ${verdict} (missing verdicts never pass silently)`,
      );
      continue;
    }
    const divergent = [...new Set(observed)].sort();
    if (divergent.length !== 1 || divergent[0] !== verdict) {
      mismatches.push(
        `invariant ${key} verdicts [${divergent.join(', ')}] do not all equal expected ${verdict}`,
      );
    }
  }
  return {
    matched: mismatches.length === 0,
    mismatches: mismatches.sort().slice(0, 20),
  };
}
