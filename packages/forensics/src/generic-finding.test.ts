// =====================================================================
// RuptureGrid v1.1 Phase 15 — generic finding-rule registry tests
// (N-1 minimal Case-B proof; N-6 intact proof tuples; fail-closed)
// =====================================================================
// The finding layer NEVER re-evaluates business truth: it consumes a
// PERSISTED FAIL evaluation and selects the minimal deterministic proof
// references from the evaluator's own persisted detail shapes. These
// tests pin exactly that contract, including the adversarial ordering
// case where independently sorting identities and unit amounts would
// pair the wrong amount with the wrong effect.

import { describe, expect, it } from 'vitest';
import {
  deriveGenericFindingFromEvaluation,
  GENERIC_FINDING_REASON_CODES,
  GENERIC_FINDING_RULE_VERSION,
} from './generic-finding.js';
import type { GenericFindingEvaluationInput } from './generic-finding.js';

function baseInput(
  overrides: Partial<GenericFindingEvaluationInput> = {},
): GenericFindingEvaluationInput {
  return {
    id: 'eval-1',
    runId: 'run-1',
    invariantKey: 'INV-INV-1',
    evaluatorVersion: 'v1',
    subjectKey: 'SKU-001',
    verdict: 'FAIL',
    completenessBasis: 'incomplete',
    evidenceSetHash: 'a'.repeat(64),
    sourceObservationHashes: [],
    normalizedEventIds: [],
    causalRelationshipIds: [],
    details: {},
    ...overrides,
  };
}

describe('N-1: Case-B finding cites ONLY the minimal authoritative remaining proof', () => {
  const caseBDetails = {
    failureMechanism: 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING',
    registryVersion: 'business-invariant/v1',
    kind: 'resourceConservation',
    subjectKey: 'SKU-001',
    resourceIdentityField: 'sku',
    remainingValue: -1,
    remainingQueryIds: ['stockRemaining'],
    // The authoritative negative remaining surface + resource proof:
    remainingEventIds: ['ev-rem-1'],
    remainingObservationHashes: ['hash-rem-1'],
    resourceProofEventIds: ['ev-sku-1'],
    // A recorded baseline anomaly must NEVER enter the finding proof:
    baselineConflict: { code: 'BASELINE_MISSING', problem: 'baseline-authority-absent' },
    baselineRequired: false,
    consumptionNegativeUnits: [],
  };

  it('derives RESOURCE_CONSERVATION_NEGATIVE_REMAINING with the exact minimal proof set', () => {
    const derivation = deriveGenericFindingFromEvaluation(
      baseInput({
        invariantKey: 'INV-INV-1',
        details: caseBDetails,
        // Unrelated provenance that must NOT leak into the proof set:
        sourceObservationHashes: ['hash-rem-1', 'hash-unrelated'],
        normalizedEventIds: ['ev-rem-1', 'ev-sku-1', 'ev-sneaky-unrelated'],
      }),
    );
    expect(derivation.finding).not.toBeNull();
    expect(derivation.finding?.reasonCode).toBe(
      GENERIC_FINDING_REASON_CODES.resourceConservationNegativeRemaining,
    );
    expect(derivation.finding?.findingRuleVersion).toBe(GENERIC_FINDING_RULE_VERSION);
    const eventRefs = derivation.proofReferences.filter(
      (ref) => ref.subject === 'NORMALIZED_EVENT',
    );
    // Exactly the remaining observation + the resource proof — never
    // unrelated evaluation events (ev-sneaky-unrelated stays out).
    expect(eventRefs.map((ref) => ref.sourceId).sort()).toEqual(['ev-rem-1', 'ev-sku-1']);
    const hashRefs = derivation.proofReferences.filter((ref) => ref.subject === 'RAW_OBSERVATION');
    // Only the authoritative remaining surface's observations.
    expect(hashRefs.map((ref) => ref.sourceId)).toEqual(['hash-rem-1']);
    expect(derivation.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same persisted evaluation yields the identical fingerprint', () => {
    const input = baseInput({
      details: caseBDetails,
      sourceObservationHashes: ['hash-rem-1'],
      normalizedEventIds: ['ev-rem-1', 'ev-sku-1'],
    });
    const first = deriveGenericFindingFromEvaluation(input);
    const second = deriveGenericFindingFromEvaluation(input);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
  });

  it('fails closed when the persisted minimal remaining proof is absent (no full-proof-set fallback)', () => {
    const brokenDetails = { ...caseBDetails } as Record<string, unknown>;
    delete brokenDetails['remainingEventIds'];
    expect(() =>
      deriveGenericFindingFromEvaluation(
        baseInput({
          verdict: 'FAIL',
          details: brokenDetails,
          // The legacy fallback would have used these:
          normalizedEventIds: ['ev-anything'],
        }),
      ),
    ).toThrow(/minimal remaining-state proof|remainingEventIds/i);
  });
});

describe('N-6: Case-A finding consumes intact identity+units tuples (never positional pairing)', () => {
  const caseATuples = [
    {
      effectIdentity: 'RES-A',
      units: 1,
      eventId: 'ev-a',
      relationshipIds: ['rel-a1', 'rel-a2'],
      observationHashes: ['hash-a'],
    },
    {
      effectIdentity: 'RES-B',
      units: 100,
      eventId: 'ev-b',
      relationshipIds: ['rel-b1'],
      observationHashes: ['hash-b'],
    },
  ];
  const caseADetails = {
    failureMechanism: 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE',
    registryVersion: 'business-invariant/v1',
    kind: 'resourceConservation',
    subjectKey: 'SKU-001',
    resourceIdentityField: 'sku',
    baselineValue: 10,
    acceptedReservedUnits: 101,
    // Deliberately NOT aligned with the tuple order, to prove the rule
    // no longer pairs identities and amounts positionally:
    consumptionEffectIdentities: ['RES-B', 'RES-A'],
    consumptionUnitValues: [100, 1],
    minimalProofEffectIdentities: ['RES-A', 'RES-B'],
    minimalProofEffects: caseATuples,
  };

  it('derives the Case-A reason with proof references from the exact minimal tuples', () => {
    const derivation = deriveGenericFindingFromEvaluation(
      baseInput({
        details: caseADetails,
        sourceObservationHashes: ['hash-a', 'hash-b'],
        normalizedEventIds: ['ev-a', 'ev-b'],
        causalRelationshipIds: ['rel-a1', 'rel-a2', 'rel-b1'],
      }),
    );
    expect(derivation.finding?.reasonCode).toBe(
      GENERIC_FINDING_REASON_CODES.resourceConservationExceededBaseline,
    );
    expect(derivation.finding?.details['minimalProofEffectIdentities']).toEqual(['RES-A', 'RES-B']);
    expect(derivation.finding?.details['minimalProofEffects']).toEqual(caseATuples);
    const eventRefs = derivation.proofReferences
      .filter((ref) => ref.subject === 'NORMALIZED_EVENT')
      .map((ref) => ref.sourceId)
      .sort();
    expect(eventRefs).toEqual(['ev-a', 'ev-b']);
    const relRefs = derivation.proofReferences
      .filter((ref) => ref.subject === 'CAUSAL_RELATIONSHIP')
      .map((ref) => ref.sourceId)
      .sort();
    expect(relRefs).toEqual(['rel-a1', 'rel-a2', 'rel-b1']);
  });

  it('refuses a Finding when the tuple set is missing (fail closed, no positional substitute)', () => {
    const broken = { ...caseADetails } as Record<string, unknown>;
    delete broken['minimalProofEffects'];
    expect(() => deriveGenericFindingFromEvaluation(baseInput({ details: broken }))).toThrow(
      /minimalProofEffects|untraceable/i,
    );
  });

  it('refuses a Finding whose minimal tuples do not prove sum > baseline', () => {
    const contradicting = {
      ...caseADetails,
      minimalProofEffects: [caseATuples[0]], // 1 unit ≤ 10
    };
    expect(() => deriveGenericFindingFromEvaluation(baseInput({ details: contradicting }))).toThrow(
      /≤ baseline|contradicts the evaluation/i,
    );
  });
});

describe('N-6: atMostOne finding consumes the persisted max+1 proof tuples', () => {
  const atMostOneDetails = {
    failureMechanism: 'TOO_MANY_ACCEPTED_EFFECTS',
    registryVersion: 'business-invariant/v1',
    kind: 'atMostOneAcceptedEffect',
    subjectKey: 'CHK-001',
    maxAcceptedEffects: 1,
    attributableEffectCount: 2,
    countedEffectIdentities: ['ORD-B', 'ORD-A'],
    minimalProofEffectIdentities: ['ORD-A', 'ORD-B'],
    minimalProofEffects: [
      {
        effectIdentity: 'ORD-A',
        eventId: 'ev-ord-a',
        relationshipIds: ['rel-ord-a'],
        observationHashes: ['hash-ord-a'],
      },
      {
        effectIdentity: 'ORD-B',
        eventId: 'ev-ord-b',
        relationshipIds: ['rel-ord-b'],
        observationHashes: ['hash-ord-b'],
      },
    ],
  };

  it('cites exactly max+1 effect events from the tuples — never a positional slice of the full proof set', () => {
    const derivation = deriveGenericFindingFromEvaluation(
      baseInput({
        invariantKey: 'INV-CHK-1',
        subjectKey: 'CHK-001',
        details: atMostOneDetails,
        // Extra evaluation events the legacy positional slice would
        // have wrongly cited (slice(0, 2) of a sorted list):
        normalizedEventIds: ['ev-attempt', 'ev-ord-a', 'ev-ord-b'],
        causalRelationshipIds: ['rel-ord-a', 'rel-ord-b'],
        sourceObservationHashes: ['hash-ord-a', 'hash-ord-b'],
      }),
    );
    expect(derivation.finding?.reasonCode).toBe(
      GENERIC_FINDING_REASON_CODES.tooManyAcceptedEffects,
    );
    const eventRefs = derivation.proofReferences
      .filter((ref) => ref.subject === 'NORMALIZED_EVENT')
      .map((ref) => ref.sourceId)
      .sort();
    expect(eventRefs).toEqual(['ev-ord-a', 'ev-ord-b']);
  });

  it('fails closed when the tuple count does not equal maxAcceptedEffects+1', () => {
    const broken = {
      ...atMostOneDetails,
      minimalProofEffects: [atMostOneDetails.minimalProofEffects[0]],
    };
    expect(() => deriveGenericFindingFromEvaluation(baseInput({ details: broken }))).toThrow(
      /maxAcceptedEffects\+1|untraceable/i,
    );
  });
});

describe('finding layer honesty guards', () => {
  it('PASS and NOT_EVALUABLE produce no Finding', () => {
    for (const verdict of ['PASS', 'NOT_EVALUABLE'] as const) {
      const derivation = deriveGenericFindingFromEvaluation(
        baseInput({
          verdict,
          details: { registryVersion: 'business-invariant/v1', kind: 'resourceConservation' },
        }),
      );
      expect(derivation.finding).toBeNull();
    }
  });

  it('a FAIL without a persisted failure mechanism fails closed', () => {
    expect(() =>
      deriveGenericFindingFromEvaluation(
        baseInput({
          verdict: 'FAIL',
          details: { registryVersion: 'business-invariant/v1', kind: 'resourceConservation' },
        }),
      ),
    ).toThrow(/failureMechanism|untraceable/i);
  });

  it('a FAIL with an unknown mechanism fails closed (never guessed)', () => {
    expect(() =>
      deriveGenericFindingFromEvaluation(
        baseInput({
          verdict: 'FAIL',
          details: {
            registryVersion: 'business-invariant/v1',
            kind: 'resourceConservation',
            failureMechanism: 'SOMETHING_ELSE',
          },
        }),
      ),
    ).toThrow(/unknown failure mechanism/i);
  });
});
