// =====================================================================
// Unit — Incident Zero golden verifier checker semantics (Phase 7)
// =====================================================================
// The golden verifier's mismatch semantics are product surface: a
// semantic mismatch MUST be classified as a canonical assertion
// failure (never silently passed), frozen-intent parity MUST be exact,
// and exit-code classification MUST distinguish prerequisite and
// timeout failures from assertion mismatches. Negative examples here
// use clearly-labeled synthetic input (prefix "synthetic-"); nothing
// here touches real infrastructure (R-08: these are pure-function
// semantics — the real end-to-end behavior is the committed
// integration suite and the live one-command verifier).

import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from '@rupturegrid/config';
import {
  INVARIANT_KEY,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
  SECURE_EXPECTED_WALLET_BALANCE_MINOR,
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
} from './contract.js';
import { ReadinessError } from './readiness.js';
import { GoldenRunError } from './run.js';
import type { GoldenRunResult } from './run-types.js';
import {
  classifyGoldenError,
  evaluationAssertions,
  frozenIntentAssertions,
} from './verify-core.js';
import type { ModeCounts, ModeExpectation } from './verify-core.js';

/** A fully canonical SYNTHETIC vulnerable-mode result (never a real run). */
function syntheticVulnerableResult(overrides: Partial<GoldenRunResult> = {}): GoldenRunResult {
  const snapshotHash = 'a'.repeat(64);
  return {
    scenarioVersion: 'v1',
    mode: 'VULNERABLE',
    runId: '00000000-0000-4000-8000-000000000001',
    experimentId: '00000000-0000-4000-8000-000000000002',
    revisionId: '00000000-0000-4000-8000-000000000003',
    snapshotId: '00000000-0000-4000-8000-000000000004',
    snapshotContentHash: snapshotHash,
    targetId: '00000000-0000-4000-8000-000000000005',
    targetOrigin: 'http://127.0.0.1:3127',
    runState: 'COMPLETED',
    payment: {
      providerPaymentId: 'pp-synthetic-0000000000000000000000000001',
      walletId: 'w-synthetic-0000000000000000000000000001',
      amountMinor: '500000',
      currency: 'PKR',
    },
    wallet: {
      walletId: 'w-synthetic-0000000000000000000000000001',
      balanceMinor: '1000000',
      currency: 'PKR',
    },
    evaluation: {
      id: '00000000-0000-4000-8000-000000000006',
      subjectKey: 'pp-synthetic-0000000000000000000000000001',
      verdict: 'FAIL',
      reason: 'synthetic canonical vulnerable outcome',
      equivalentEffectCount: 2,
    },
    finding: {
      id: '00000000-0000-4000-8000-000000000007',
      reasonCode: 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
      subjectKey: 'pp-synthetic-0000000000000000000000000001',
    },
    integrity: { observationCount: 25, chainValid: true },
    timelineEntryCount: 149,
    reproductionDefinition: {
      snapshotContentHash: snapshotHash,
      targetModeRequirement: 'VULNERABLE',
      credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_INSPECTION_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'],
    },
    deliveryCount: TOTAL_DELIVERIES,
    processingAttemptCount: TOTAL_DELIVERIES,
    financialEffectCount: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
    ...overrides,
  };
}

const CANONICAL_VULNERABLE_COUNTS: ModeCounts = {
  applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  providerEvents: 2,
  webhookDeliveries: TOTAL_DELIVERIES,
  processingAttempts: TOTAL_DELIVERIES,
  findingCount: 1,
};

describe('golden verifier — evaluation assertions (checker semantics)', () => {
  it('accepts the canonical vulnerable outcome as a full pass', () => {
    const evaluation = evaluationAssertions(
      syntheticVulnerableResult(),
      {
        mode: 'VULNERABLE',
        label: 'VULNERABLE',
        acceptedEffects: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        walletBalanceMinor: VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
        verdict: 'FAIL',
        findings: 1,
        applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
      },
      CANONICAL_VULNERABLE_COUNTS,
    );
    expect(evaluation.every((assertion) => assertion.pass)).toBe(true);
  });

  it('flags an INV-IZ-1 verdict mismatch as a named canonical assertion failure', () => {
    const evaluation = evaluationAssertions(
      syntheticVulnerableResult({
        evaluation: {
          id: '00000000-0000-4000-8000-000000000006',
          subjectKey: 'pp-synthetic-0000000000000000000000000001',
          verdict: 'PASS',
          reason: 'synthetic wrong verdict',
          equivalentEffectCount: 2,
        },
      }),
      {
        mode: 'VULNERABLE',
        label: 'VULNERABLE',
        acceptedEffects: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        walletBalanceMinor: VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
        verdict: 'FAIL',
        findings: 1,
        applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
      },
      CANONICAL_VULNERABLE_COUNTS,
    );
    const failures = evaluation.filter((assertion) => !assertion.pass);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe(`${INVARIANT_KEY}.verdict`);
    expect(failures[0]?.expected).toBe('FAIL');
    expect(failures[0]?.actual).toBe('PASS');
  });

  it('flags a wrong APPLIED/IDEMPOTENT_DUPLICATE outcome split', () => {
    const evaluation = evaluationAssertions(
      syntheticVulnerableResult(),
      {
        mode: 'VULNERABLE',
        label: 'VULNERABLE',
        acceptedEffects: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        walletBalanceMinor: VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
        verdict: 'FAIL',
        findings: 1,
        applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
      },
      { ...CANONICAL_VULNERABLE_COUNTS, applied: 3, idempotentDuplicates: 17 },
    );
    const failures = evaluation.filter((assertion) => !assertion.pass);
    expect(failures.map((assertion) => assertion.name).sort()).toEqual([
      'outcomes.APPLIED',
      'outcomes.IDEMPOTENT_DUPLICATE',
    ]);
  });

  it('flags a wrong secure-mode wallet balance and suppression split', () => {
    const evaluation = evaluationAssertions(
      syntheticVulnerableResult({
        mode: 'SECURE',
        wallet: {
          walletId: 'w-synthetic-0000000000000000000000000001',
          balanceMinor: '1000000',
          currency: 'PKR',
        },
        financialEffectCount: 2,
        evaluation: {
          id: '00000000-0000-4000-8000-000000000006',
          subjectKey: 'pp-synthetic-0000000000000000000000000001',
          verdict: 'PASS',
          reason: 'synthetic canonical secure outcome',
          equivalentEffectCount: 1,
        },
        finding: null,
        reproductionDefinition: {
          snapshotContentHash: 'a'.repeat(64),
          targetModeRequirement: 'SECURE',
          credentialRefs: [
            'DEMO_ADMIN_TOKEN',
            'DEMO_INSPECTION_TOKEN',
            'DEMO_PROVIDER_SIGNING_SECRET',
          ],
        },
      }),
      {
        mode: 'SECURE',
        label: 'SECURE',
        acceptedEffects: SECURE_EXPECTED_EQUIVALENT_EFFECTS,
        walletBalanceMinor: SECURE_EXPECTED_WALLET_BALANCE_MINOR,
        verdict: 'PASS',
        findings: 0,
        applied: SECURE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
      },
      {
        applied: SECURE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
        providerEvents: 2,
        webhookDeliveries: TOTAL_DELIVERIES,
        processingAttempts: TOTAL_DELIVERIES,
        findingCount: 0,
      },
    );
    const failures = evaluation.filter((assertion) => !assertion.pass);
    expect(failures.map((assertion) => assertion.name).sort()).toEqual([
      'effects.accepted-equivalent',
      'wallet.balance-minor',
    ]);
  });

  it('flags a reproduction definition that is not snapshot-bound or carries credential VALUES', () => {
    const evaluation = evaluationAssertions(
      syntheticVulnerableResult({
        reproductionDefinition: {
          snapshotContentHash: 'b'.repeat(64),
          targetModeRequirement: 'SECURE',
          credentialRefs: ['DEMO_ADMIN_TOKEN'],
        },
      }),
      {
        mode: 'VULNERABLE',
        label: 'VULNERABLE',
        acceptedEffects: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        walletBalanceMinor: VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
        verdict: 'FAIL',
        findings: 1,
        applied: VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
        idempotentDuplicates: TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
      },
      CANONICAL_VULNERABLE_COUNTS,
    );
    const failures = evaluation.filter((assertion) => !assertion.pass);
    expect(failures.map((assertion) => assertion.name).sort()).toEqual([
      'reproduction.mode-requirement',
      'reproduction.snapshot-binding',
    ]);
  });
});

describe('golden verifier — frozen-intent assertions (canonical contract)', () => {
  it('holds for the canonical contract: parity, pressure, concurrency', () => {
    const assertions = frozenIntentAssertions();
    expect(assertions.length).toBeGreaterThanOrEqual(5);
    expect(assertions.every((assertion) => assertion.pass)).toBe(true);
    const byName = new Map(assertions.map((assertion) => [assertion.name, assertion]));
    expect(byName.get('frozen-intent.deliveries-per-event')?.expected).toBe('10');
    expect(byName.get('frozen-intent.delivery-concurrency')?.expected).toBe('8');
    expect(byName.get('frozen-intent.total-deliveries')?.expected).toBe('20');
    expect(byName.get('frozen-intent.input-parity')?.pass).toBe(true);
  });
});

describe('golden verifier — exit-code classification', () => {
  it('classifies prerequisite failures as exit 2', () => {
    expect(classifyGoldenError(new ReadinessError('Demo Target is not reachable'))).toBe(2);
    expect(classifyGoldenError(new ConfigValidationError(['DEMO_ADMIN_TOKEN is missing']))).toBe(2);
    expect(classifyGoldenError(new GoldenRunError('worker did not start. stderr tail:\n…'))).toBe(
      2,
    );
    expect(
      classifyGoldenError(
        new GoldenRunError('Demo Target (VULNERABLE) did not become live on http://x'),
      ),
    ).toBe(2);
  });

  it('classifies bounded-timeout failures as exit 3', () => {
    expect(
      classifyGoldenError(new GoldenRunError('golden run x: condition not met within 180000ms')),
    ).toBe(3);
    expect(
      classifyGoldenError(
        new GoldenRunError('Phase 4 evaluation batch: condition not met within 60000ms'),
      ),
    ).toBe(3);
    expect(
      classifyGoldenError(
        new GoldenRunError('worker readiness did not materialize within 20000ms'),
      ),
    ).toBe(3);
  });

  it('classifies everything else as a canonical verification failure (exit 1)', () => {
    expect(classifyGoldenError(new GoldenRunError('golden run x ended in state FAILED'))).toBe(1);
    expect(classifyGoldenError(new Error('unexpected'))).toBe(1);
  });
});
