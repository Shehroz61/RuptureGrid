// =====================================================================
// Unit — deterministic Finding rule (finding.ts)
// =====================================================================
// FAIL may produce exactly one Finding (§10); PASS/NOT_EVALUABLE must
// NOT (§40/§41); unknown shapes are refused, never guessed (§90).
// The proof set is minimal, typed, deterministically ordered (§29);
// the input fingerprint is stable and wall-clock free (§32); the
// confidence scope states what is proven vs uncertain (evidence-model
// §8) — INDETERMINATE outcomes included, never smoothed over.

import { describe, expect, it } from 'vitest';
import {
  deriveFindingFromEvaluation,
  FINDING_REASON_CODES,
  PROOF_ROLES,
  PROOF_SUBJECTS,
  FINDING_RULE_VERSION,
  DUPLICATE_CREDIT_TITLE_TEMPLATE,
} from './index.js';
import type { FindingEvaluationInput } from './index.js';

function failEvaluation(overrides: Partial<FindingEvaluationInput> = {}): FindingEvaluationInput {
  return {
    id: '0f0e0d0c-0000-4000-8000-000000000001',
    runId: '0f0e0d0c-0000-4000-8000-000000000002',
    invariantKey: 'INV-IZ-1',
    evaluatorVersion: 'v1',
    subjectKey: 'pay_vuln_001',
    verdict: 'FAIL',
    completenessBasis: 'lineage-complete',
    evidenceSetHash: 'a'.repeat(64),
    sourceObservationHashes: ['h3', 'h1', 'h2'],
    normalizedEventIds: [
      '0f0e0d0c-0000-4000-8000-0000000000aa',
      '0f0e0d0c-0000-4000-8000-0000000000bb',
    ],
    causalRelationshipIds: ['0f0e0d0c-0000-4000-8000-0000000000cc'],
    details: {
      equivalentEffectCount: 2,
      attributedEffectCount: 2,
      attributionBasis: 'identity-chain',
      paymentEventId: '0f0e0d0c-0000-4000-8000-0000000000aa',
      walletId: 'wallet_7',
      amountMinor: 500000,
      currency: 'PKR',
      nonEquivalentEffects: 0,
    },
    executionUncertainty: { indeterminateInvocationIds: [] },
    ...overrides,
  };
}

describe('Finding rule — creation rules (§10/§40/§41)', () => {
  it('FAIL produces exactly one duplicate-credit Finding', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    expect(derivation.finding).not.toBeNull();
    expect(derivation.finding?.reasonCode).toBe(
      FINDING_REASON_CODES.duplicateEquivalentFinancialEffect,
    );
    expect(derivation.finding?.subjectKey).toBe('pay_vuln_001');
    expect(derivation.finding?.title).toBe(DUPLICATE_CREDIT_TITLE_TEMPLATE);
  });

  it('PASS produces NO Finding', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation({ verdict: 'PASS' }));
    expect(derivation.finding).toBeNull();
    expect(derivation.proofReferences).toEqual([]);
  });

  it('NOT_EVALUABLE produces NO failure Finding', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation({ verdict: 'NOT_EVALUABLE' }));
    expect(derivation.finding).toBeNull();
  });

  it('an unknown verdict is refused, never guessed into a Finding', () => {
    expect(() =>
      deriveFindingFromEvaluation(failEvaluation({ verdict: 'MAYBE' as never })),
    ).toThrow(/unknown invariant verdict/);
  });

  it('a FAIL for an invariant with no rule is refused (no invented Findings)', () => {
    expect(() => deriveFindingFromEvaluation(failEvaluation({ invariantKey: 'INV-XX-9' }))).toThrow(
      /no finding rule/,
    );
  });

  it('a FAIL evaluation without a valid counted-duplicate detail set is refused', () => {
    expect(() => deriveFindingFromEvaluation(failEvaluation({ details: {} }))).toThrow(
      /refusing to derive an untraceable Finding/,
    );
    expect(() =>
      deriveFindingFromEvaluation(
        failEvaluation({ details: { ...failEvaluation().details, equivalentEffectCount: 1 } }),
      ),
    ).toThrow(/refusing to derive an untraceable Finding/);
  });
});

describe('Finding rule — provenance fidelity (§37/§96)', () => {
  it('copies amounts and counts from the evaluation, never recomputes', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    expect(derivation.finding?.details).toMatchObject({
      equivalentEffectCount: 2,
      amountMinor: 500000,
      currency: 'PKR',
      walletId: 'wallet_7',
      attributionBasis: 'identity-chain',
    });
  });

  it('summary names the invariant version, subject, count, amount and basis', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    expect(derivation.finding?.summary).toContain('INV-IZ-1 (v1)');
    expect(derivation.finding?.summary).toContain('pay_vuln_001');
    expect(derivation.finding?.summary).toContain('2 accepted equivalent wallet-credit');
    expect(derivation.finding?.summary).toContain('500000');
    expect(derivation.finding?.summary).toContain('identity-chain');
  });
});

describe('Finding rule — minimal proof set (§29)', () => {
  it('cites evaluation, counted effects, attribution relationships, source observations', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    const subjects = derivation.proofReferences.map((reference) => reference.subject);
    expect(subjects).toContain(PROOF_SUBJECTS.invariantEvaluation);
    expect(subjects).toContain(PROOF_SUBJECTS.normalizedEvent);
    expect(subjects).toContain(PROOF_SUBJECTS.causalRelationship);
    expect(subjects).toContain(PROOF_SUBJECTS.rawObservation);
    // Uniqueness is per (subject, sourceId, role) — the DB constraint
    // (findingId, sourceId, role) mirrors this exactly.
    const pairs = derivation.proofReferences.map(
      (reference) => `${reference.subject}|${reference.sourceId}|${reference.role}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('orders the proof set deterministically by role group then id', () => {
    const a = deriveFindingFromEvaluation(failEvaluation());
    const b = deriveFindingFromEvaluation(failEvaluation());
    expect(a.proofReferences).toEqual(b.proofReferences);
    const subjects = a.proofReferences.map((reference) => reference.subject);
    expect(subjects[0]).toBe(PROOF_SUBJECTS.invariantEvaluation);
    // Within each subject group, sourceIds are ascending.
    for (let i = 1; i < a.proofReferences.length; i++) {
      const previous = a.proofReferences[i - 1];
      const current = a.proofReferences[i];
      if (previous.subject === current.subject) {
        expect(current.sourceId >= previous.sourceId).toBe(true);
      }
    }
    // Group order is fixed: evaluation, effects, relationships,
    // observations.
    const groupOrder = [
      PROOF_SUBJECTS.invariantEvaluation,
      PROOF_SUBJECTS.normalizedEvent,
      PROOF_SUBJECTS.causalRelationship,
      PROOF_SUBJECTS.rawObservation,
    ];
    const seenGroups = [...new Set(subjects)];
    expect(seenGroups).toEqual(groupOrder);
  });

  it('prefers the evaluation-named effect event ids when present', () => {
    const derivation = deriveFindingFromEvaluation(
      failEvaluation({
        details: {
          ...failEvaluation().details,
          equivalentEffectEventIds: ['evt-B', 'evt-A'],
        },
      }),
    );
    const effects = derivation.proofReferences.filter(
      (reference) => reference.role === PROOF_ROLES.countedEffect,
    );
    expect(effects.map((reference) => reference.sourceId)).toEqual(['evt-A', 'evt-B']);
  });
});

describe('Finding rule — confidence scope (evidence-model §8)', () => {
  it('proven scope states the verdict, counts, basis and evidence hash', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    expect(derivation.finding?.provenScope).toMatchObject({
      verdict: 'FAIL',
      equivalentEffectCount: 2,
      attributedEffectCount: 2,
      attributionBasis: 'identity-chain',
      completenessBasis: 'lineage-complete',
      evidenceSetHash: 'a'.repeat(64),
    });
  });

  it('uncertain scope lists INDETERMINATE invocations and disclaims scheduling order', () => {
    const derivation = deriveFindingFromEvaluation(
      failEvaluation({
        executionUncertainty: {
          indeterminateInvocationIds: ['inv-2', 'inv-1'],
        },
      }),
    );
    expect(derivation.finding?.uncertainScope).toMatchObject({
      indeterminateInvocationCount: 2,
      indeterminateInvocationIds: ['inv-1', 'inv-2'],
      schedulingOrderAsserted: false,
      attributionBelowIdentityChain: 0,
    });
  });
});

describe('Finding rule — identity determinism (§31/§32)', () => {
  it('the same evaluation always yields the same input fingerprint', () => {
    const a = deriveFindingFromEvaluation(failEvaluation());
    const b = deriveFindingFromEvaluation(failEvaluation());
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(a.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the fingerprint never depends on wall-clock or derivation call count', () => {
    const before = deriveFindingFromEvaluation(failEvaluation());
    const after = deriveFindingFromEvaluation(failEvaluation());
    expect(before.inputFingerprint).toBe(after.inputFingerprint);
  });

  it('a different evidence set changes the fingerprint', () => {
    const a = deriveFindingFromEvaluation(failEvaluation());
    const b = deriveFindingFromEvaluation(failEvaluation({ evidenceSetHash: 'b'.repeat(64) }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it('a different subject changes the fingerprint (subject isolation, §43)', () => {
    const a = deriveFindingFromEvaluation(failEvaluation());
    const b = deriveFindingFromEvaluation(failEvaluation({ subjectKey: 'pay_vuln_002' }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it('the rule version is stamped into the derivation', () => {
    const derivation = deriveFindingFromEvaluation(failEvaluation());
    expect(derivation.finding?.findingRuleVersion).toBe(FINDING_RULE_VERSION);
  });
});
