// =====================================================================
// RuptureGrid v1.0 — golden verifier checker semantics (Phase 7)
// =====================================================================
// The PURE verification core of the one-command golden verifier:
// assertion primitives, the canonical per-mode expectations, frozen-
// intent (input-parity) checks, and exit-code classification. No
// runtime dependencies beyond the canonical contract module — unit
// tests exercise this core without any infrastructure or prior build
// (testing-strategy: pure-function semantics are unit-testable; real
// end-to-end behavior is the committed integration suite and the live
// verifier).
//
// The verifier ASSERTS persisted truth; it never decides it. A
// semantic mismatch here is a named canonical assertion failure —
// never silently passed, never rewritten into alternate business
// truth.

import {
  DELIVERY_CONCURRENCY,
  DELIVERIES_PER_EVENT,
  INVARIANT_KEY,
  LOGICAL_EVENT_COUNT,
  PAYMENT_AMOUNT_CURRENCY,
  PAYMENT_AMOUNT_MINOR,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
  SECURE_EXPECTED_WALLET_BALANCE_MINOR,
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
  goldenScenarioSteps,
} from './contract.js';
import type { GoldenMode, GoldenRunResult } from './run-types.js';

export interface AssertionResult {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

export function assertEq(name: string, expected: unknown, actual: unknown): AssertionResult {
  const expectedText = String(expected);
  const actualText = String(actual);
  return { name, expected: expectedText, actual: actualText, pass: expectedText === actualText };
}

export interface ModeExpectation {
  readonly mode: GoldenMode;
  readonly label: string;
  readonly acceptedEffects: number;
  readonly walletBalanceMinor: bigint;
  readonly verdict: 'PASS' | 'FAIL';
  readonly findings: number;
  readonly applied: number;
  readonly idempotentDuplicates: number;
}

/** Canonical per-mode expectations, transcribed from the accepted contracts. */
export const EXPECTATIONS: Record<GoldenMode, ModeExpectation> = {
  VULNERABLE: {
    mode: 'VULNERABLE',
    label: 'VULNERABLE',
    acceptedEffects: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
    walletBalanceMinor: VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
    verdict: 'FAIL',
    findings: 1,
    applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
    idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  },
  SECURE: {
    mode: 'SECURE',
    label: 'SECURE',
    acceptedEffects: SECURE_EXPECTED_EQUIVALENT_EFFECTS,
    walletBalanceMinor: SECURE_EXPECTED_WALLET_BALANCE_MINOR,
    verdict: 'PASS',
    findings: 0,
    applied: SECURE_EXPECTED_EQUIVALENT_EFFECTS,
    idempotentDuplicates: SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
  },
};

// ---------------------------------------------------------------------
// Frozen-intent self-check: the scenario document that WILL be frozen
// into the run snapshot must still be the canonical contract, and the
// two modes must be input-identical except the declared mode.
// ---------------------------------------------------------------------

export function frozenIntentAssertions(): AssertionResult[] {
  const vulnerable = goldenScenarioSteps('VULNERABLE');
  const secure = goldenScenarioSteps('SECURE');
  const results: AssertionResult[] = [];

  const deliverySteps = vulnerable.filter((step) =>
    String(step['name']).startsWith('deliver-event'),
  );
  results.push(assertEq('frozen-intent.delivery-steps', LOGICAL_EVENT_COUNT, deliverySteps.length));

  const repeats = new Set(
    deliverySteps.map((step) => (step['action'] as Record<string, unknown>)['repeat']),
  );
  results.push(
    assertEq(
      'frozen-intent.deliveries-per-event',
      DELIVERIES_PER_EVENT,
      repeats.size === 1 ? [...repeats][0] : `<mixed:${repeats.size}>`,
    ),
  );

  const concurrencies = new Set(
    deliverySteps.map((step) => (step['action'] as Record<string, unknown>)['concurrency']),
  );
  results.push(
    assertEq(
      'frozen-intent.delivery-concurrency',
      DELIVERY_CONCURRENCY,
      concurrencies.size === 1 ? [...concurrencies][0] : `<mixed:${concurrencies.size}>`,
    ),
  );

  results.push(
    assertEq(
      'frozen-intent.total-deliveries',
      TOTAL_DELIVERIES,
      DELIVERIES_PER_EVENT * LOGICAL_EVENT_COUNT,
    ),
  );

  // Input parity: the two mode documents must be byte-identical except
  // the declared mode itself (the only occurrence of the mode tokens is
  // the mode step's body — masked here to make the equality readable).
  const mask = (steps: ReturnType<typeof goldenScenarioSteps>): string =>
    JSON.stringify(steps).replaceAll('VULNERABLE', '*').replaceAll('SECURE', '*');
  results.push(assertEq('frozen-intent.input-parity', mask(vulnerable), mask(secure)));

  return results;
}

// ---------------------------------------------------------------------
// Per-mode semantic evaluation — assertions over the orchestrator's
// durable-truth result plus normalized-entity outcome counts the CLI
// queries. The expectations are CONSTANTS; the observed values come
// only from persisted artifacts.
// ---------------------------------------------------------------------

export interface ModeCounts {
  readonly applied: number;
  readonly idempotentDuplicates: number;
  readonly providerEvents: number;
  readonly webhookDeliveries: number;
  readonly processingAttempts: number;
  readonly findingCount: number;
}

export function evaluationAssertions(
  result: GoldenRunResult,
  expectation: ModeExpectation,
  counts: ModeCounts,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const push = (name: string, expected: unknown, actual: unknown): void => {
    results.push(assertEq(name, expected, actual));
  };

  push('execution.state', 'COMPLETED', result.runState);
  push('evidence.integrity-chain-valid', 'true', result.integrity.chainValid);
  push('evidence.normalized-webhook-deliveries', TOTAL_DELIVERIES, counts.webhookDeliveries);
  push('evidence.normalized-processing-attempts', TOTAL_DELIVERIES, counts.processingAttempts);
  push('evidence.normalized-provider-events', LOGICAL_EVENT_COUNT, counts.providerEvents);
  push('workload.deliveries', TOTAL_DELIVERIES, result.deliveryCount);
  push('workload.processing-attempts', TOTAL_DELIVERIES, result.processingAttemptCount);
  push('outcomes.APPLIED', expectation.applied, counts.applied);
  push(
    'outcomes.IDEMPOTENT_DUPLICATE',
    expectation.idempotentDuplicates,
    counts.idempotentDuplicates,
  );
  push('effects.accepted-equivalent', expectation.acceptedEffects, result.financialEffectCount);
  push(
    'wallet.balance-minor',
    expectation.walletBalanceMinor.toString(),
    result.wallet === null ? 'null' : BigInt(result.wallet.balanceMinor).toString(),
  );
  push('wallet.currency', PAYMENT_AMOUNT_CURRENCY, result.wallet?.currency ?? 'null');
  push(`${INVARIANT_KEY}.verdict`, expectation.verdict, result.evaluation?.verdict ?? 'null');
  push(
    `${INVARIANT_KEY}.equivalent-effect-count`,
    expectation.acceptedEffects,
    result.evaluation?.equivalentEffectCount ?? 'null',
  );
  push('findings.failure-count', expectation.findings, counts.findingCount);
  push('payment.amount-minor', PAYMENT_AMOUNT_MINOR.toString(), result.payment.amountMinor);
  push('payment.currency', PAYMENT_AMOUNT_CURRENCY, result.payment.currency);

  if (expectation.findings > 0) {
    push(
      'finding.reason-code',
      'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
      result.finding?.reasonCode ?? 'null',
    );
    push(
      'finding.subject-key',
      result.payment.providerPaymentId,
      result.finding?.subjectKey ?? 'null',
    );
  }

  // Reproduction definition: real, snapshot-bound, mode-required,
  // credential REFERENCES only (names — never values; ADR-0012).
  push(
    'reproduction.definition-present',
    'true',
    result.reproductionDefinition === null ? 'false' : 'true',
  );
  if (result.reproductionDefinition !== null) {
    push(
      'reproduction.mode-requirement',
      expectation.mode,
      result.reproductionDefinition.targetModeRequirement ?? 'null',
    );
    push(
      'reproduction.snapshot-binding',
      result.snapshotContentHash,
      result.reproductionDefinition.snapshotContentHash,
    );
    const refsAreNames = (result.reproductionDefinition.credentialRefs ?? []).every((ref) =>
      /^[A-Z0-9_]+$/.test(ref),
    );
    push('reproduction.credential-refs-only', 'true', refsAreNames);
  }

  return results;
}

// ---------------------------------------------------------------------
// Exit-code classification — error classes carry honest, stable `name`
// values (ReadinessError, ConfigValidationError, GoldenRunError), so
// classification stays a pure function without importing runtime-heavy
// modules.
// ---------------------------------------------------------------------

export function classifyGoldenError(error: unknown): 1 | 2 | 3 {
  const name = error instanceof Error ? error.name : '';
  if (name === 'ConfigValidationError' || name === 'ReadinessError') {
    return 2;
  }
  if (name === 'GoldenRunError' && error instanceof Error) {
    if (/not (materialize|met) within \d+ms/.test(error.message)) {
      return 3;
    }
    if (/did not (become live|start)/.test(error.message)) {
      return 2;
    }
  }
  return 1;
}
