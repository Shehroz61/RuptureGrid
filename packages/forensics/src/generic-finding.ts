// =====================================================================
// RuptureGrid v1.1 Phase 15 — generic finding-rule registry
// (ADR-0023 §10; roadmap Phase 15)
// =====================================================================
// Exactly TWO generic finding-rule families, corresponding to the two
// closed business-invariant/v1 kinds (ADR-0018 Decision 4). The rule
// consumes an ALREADY-PERSISTED FAIL InvariantEvaluation:
//
//   - it NEVER re-evaluates raw business truth (one business truth
//     engine); it may inspect the evaluation's own persisted
//     details/provenance ONLY to select the minimal proof references
//     the FAIL prescribes;
//   - PASS and NOT_EVALUABLE produce NO Finding (uncertainty and
//     correctness are never converted into defects);
//   - verdicts are never decided here: a non-FAIL verdict returns
//     no Finding; malformed/incompatible FAIL details fail CLOSED —
//     an untraceable Finding is never manufactured and the evaluation
//     is never "corrected";
//   - exactly the four new reason codes; one evaluation ⇒ one
//     deterministic primary reason; resource priority A > B > C is
//     frozen (read from the persisted primary failure mechanism,
//     never recomputed or reordered);
//   - fixed bounded templates; no AI prose, no target-supplied prose
//     (ADR-0007); summaries derive from persisted numerical/count
//     details only;
//   - minimal sufficient proof sets with typed roles (the v1.0
//     finding discipline): too-many-effects cites the minimal
//     violating subset selected by canonical sorted effect identity
//     (NOT DB order); Case A cites baseline + the minimal canonical
//     running-sum subset; Case B cites the authoritative negative
//     remaining proof only; Case C cites baseline + complete
//     consumption proof + completeness summary + remaining state;
//   - deterministic fingerprint: rule version + persisted evaluation
//     identity/content + reason mechanism + ordered proof refs. No
//     wall clock. Repeated derivation ⇒ the same Finding.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';

/** Rule version for the Phase 15 generic finding rules. */
export const GENERIC_FINDING_RULE_VERSION = 'generic-finding-rule/v1';

/** The four Phase 15 reason codes (exactly; ADR-0023 §10). */
export const GENERIC_FINDING_REASON_CODES = {
  tooManyAcceptedEffects: 'TOO_MANY_ACCEPTED_EFFECTS',
  resourceConservationExceededBaseline: 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE',
  resourceConservationNegativeRemaining: 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING',
  resourceConservationMismatch: 'RESOURCE_CONSERVATION_MISMATCH',
} as const;

export type GenericFindingReasonCode =
  (typeof GENERIC_FINDING_REASON_CODES)[keyof typeof GENERIC_FINDING_REASON_CODES];

/** Typed proof-reference roles for generic findings (bounded). */
export const GENERIC_PROOF_ROLES = {
  invariantEvaluation: 'invariant-evaluation',
  subjectEvent: 'subject-event',
  countedEffect: 'counted-effect',
  attributionRelationship: 'attribution-relationship',
  sourceObservation: 'source-observation',
  completenessSummary: 'completeness-summary',
} as const;

/** Fixed bounded titles (ADR-0023 §10: deterministic, within DB limits). */
export const GENERIC_FINDING_TITLES = {
  tooManyAcceptedEffects: 'Too many accepted effects',
  resourceConservationExceededBaseline: 'Accepted consumption exceeded resource baseline',
  resourceConservationNegativeRemaining: 'Resource remaining units became negative',
  resourceConservationMismatch: 'Resource conservation mismatch',
} as const;

/** The persisted evaluation input one generic rule consumes. */
export interface GenericFindingEvaluationInput {
  readonly id: string;
  readonly runId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly verdict: string;
  readonly completenessBasis: string;
  readonly evidenceSetHash: string;
  readonly sourceObservationHashes: readonly string[];
  readonly normalizedEventIds: readonly string[];
  readonly causalRelationshipIds: readonly string[];
  readonly details: Record<string, unknown>;
}

export interface GenericFindingProofReference {
  readonly subject:
    'INVARIANT_EVALUATION' | 'NORMALIZED_EVENT' | 'CAUSAL_RELATIONSHIP' | 'RAW_OBSERVATION';
  readonly sourceId: string;
  readonly role: string;
}

export interface GenericFindingDerivation {
  /** null ⇒ no Finding exists (PASS / NOT_EVALUABLE). */
  readonly finding: {
    readonly findingRuleVersion: string;
    readonly subjectKey: string;
    readonly reasonCode: GenericFindingReasonCode;
    readonly title: string;
    readonly summary: string;
    readonly details: Record<string, unknown>;
    readonly provenScope: Record<string, unknown>;
    readonly uncertainScope: Record<string, unknown>;
  } | null;
  readonly proofReferences: readonly GenericFindingProofReference[];
  readonly inputFingerprint: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;
const asStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null;

/**
 * N-6 (frozen detail shape): one minimal proof effect is ONE intact
 * tuple — the effect identity and its units/event/attribution/provenance
 * are never separated, so no consumer can pair an amount with the wrong
 * identity. The evaluator persists exactly this shape.
 */
interface ProofEffectTuple {
  readonly effectIdentity: string;
  readonly units: number;
  readonly eventId: string;
  readonly relationshipIds: readonly string[];
  readonly observationHashes: readonly string[];
}

function parseProofEffectTuples(value: unknown): ProofEffectTuple[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const tuples: ProofEffectTuple[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const effectIdentity = asString(entry['effectIdentity']);
    const units = asNumber(entry['units']);
    const eventId = asString(entry['eventId']);
    const relationshipIds = asStringArray(entry['relationshipIds']);
    const observationHashes = asStringArray(entry['observationHashes']);
    if (
      effectIdentity === null ||
      eventId === null ||
      relationshipIds === null ||
      observationHashes === null
    ) {
      return null;
    }
    // units is REQUIRED for Case-A tuples (the running sum needs it);
    // atMostOne tuples may omit it (count-based proof).
    tuples.push({
      effectIdentity,
      units: units ?? Number.NaN,
      eventId,
      relationshipIds,
      observationHashes,
    });
  }
  return tuples;
}

/** Fail-closed detail extraction: a FAIL must carry its named mechanism. */
function failClosed(input: GenericFindingEvaluationInput): string {
  const mechanism = asString(input.details['failureMechanism']);
  if (mechanism === null) {
    throw new Error(
      `evaluation ${input.id} is FAIL but its persisted details do not carry a valid ` +
        `failureMechanism; refusing to derive an untraceable Finding`,
    );
  }
  return mechanism;
}

/**
 * The generic finding-rule registry entry point. Dispatch is by the
 * persisted evaluation's own details (registryVersion + kind + failure
 * mechanism) — never by re-deriving business truth. One evaluation ⇒
 * one deterministic primary reason (the persisted one).
 */
export function deriveGenericFindingFromEvaluation(
  input: GenericFindingEvaluationInput,
): GenericFindingDerivation {
  if (input.verdict !== 'FAIL' && input.verdict !== 'PASS' && input.verdict !== 'NOT_EVALUABLE') {
    throw new Error(`unknown invariant verdict: ${String(input.verdict)}`);
  }
  if (input.verdict !== 'FAIL') {
    // PASS and NOT_EVALUABLE never produce findings (§41/§55).
    return { finding: null, proofReferences: [], inputFingerprint: fingerprintOf(input, []) };
  }
  const kind = asString(input.details['kind']);
  const mechanism = failClosed(input);
  if (kind === 'atMostOneAcceptedEffect') {
    if (mechanism !== 'TOO_MANY_ACCEPTED_EFFECTS') {
      throw new Error(
        `evaluation ${input.id} is a FAIL of kind atMostOneAcceptedEffect but carries failure mechanism ${mechanism}; refusing to derive a mismatched Finding`,
      );
    }
    return deriveTooManyAcceptedEffects(input);
  }
  if (kind === 'resourceConservation') {
    return deriveResourceConservationFinding(input, mechanism);
  }
  // Malformed/incompatible evaluation details: fail closed (§55).
  throw new Error(
    `evaluation ${input.id} is a generic FAIL but its persisted details do not carry a valid business-invariant/v1 kind; refusing to derive an untraceable Finding`,
  );
}

// ---------------------------------------------------------------------
// atMostOneAcceptedEffect → TOO_MANY_ACCEPTED_EFFECTS
// ---------------------------------------------------------------------

function deriveTooManyAcceptedEffects(
  input: GenericFindingEvaluationInput,
): GenericFindingDerivation {
  const details = input.details;
  const maxAcceptedEffects = asNumber(details['maxAcceptedEffects']);
  const attributableCount = asNumber(details['attributableEffectCount']);
  const countedIdentities = asStringArray(details['countedEffectIdentities']);
  if (
    maxAcceptedEffects === null ||
    attributableCount === null ||
    countedIdentities === null ||
    countedIdentities.length === 0
  ) {
    throw new Error(
      `evaluation ${input.id} is FAIL but its persisted details do not carry a valid ` +
        `maxAcceptedEffects/attributableEffectCount/countedEffectIdentities set; refusing to derive an untraceable Finding`,
    );
  }
  if (attributableCount <= maxAcceptedEffects) {
    throw new Error(
      `evaluation ${input.id} is FAIL with attributableEffectCount ${String(attributableCount)} ≤ maxAcceptedEffects ${String(maxAcceptedEffects)}; refusing to derive a Finding that contradicts the evaluation`,
    );
  }

  // Minimal sufficient proof subset: the evaluator's persisted intact
  // proof tuples (identity + event + attribution + provenance, N-6),
  // already the canonical max+1 subset by effect identity. Fail closed
  // when the persisted shape is missing — an untraceable Finding is
  // never manufactured from a positional slice.
  const minimalTuples = parseProofEffectTuples(details['minimalProofEffects']);
  if (minimalTuples === null || minimalTuples.length !== maxAcceptedEffects + 1) {
    throw new Error(
      `evaluation ${input.id} is FAIL but its persisted details do not carry a valid ` +
        `minimalProofEffects tuple set of exactly maxAcceptedEffects+1 effects; refusing to derive an untraceable Finding`,
    );
  }
  const minimalIdentities = minimalTuples.map((tuple) => tuple.effectIdentity);

  // Proof events: exactly the minimal proof tuples' event ids (never a
  // positional slice of the full proof set).
  const proofEventIds = minimalTuples.map((tuple) => tuple.eventId).sort();
  const proofRelationshipIds = [
    ...new Set(minimalTuples.flatMap((tuple) => [...tuple.relationshipIds])),
  ].sort();
  const proofObservationHashes = [
    ...new Set(minimalTuples.flatMap((tuple) => [...tuple.observationHashes])),
  ].sort();
  const proofReferences: GenericFindingProofReference[] = [
    {
      subject: 'INVARIANT_EVALUATION',
      sourceId: input.id,
      role: GENERIC_PROOF_ROLES.invariantEvaluation,
    },
    ...proofEventIds.map((eventId) => ({
      subject: 'NORMALIZED_EVENT' as const,
      sourceId: eventId,
      role: GENERIC_PROOF_ROLES.countedEffect,
    })),
    ...proofRelationshipIds.map((relationshipId) => ({
      subject: 'CAUSAL_RELATIONSHIP' as const,
      sourceId: relationshipId,
      role: GENERIC_PROOF_ROLES.attributionRelationship,
    })),
    ...proofObservationHashes.map((hash) => ({
      subject: 'RAW_OBSERVATION' as const,
      sourceId: hash,
      role: GENERIC_PROOF_ROLES.sourceObservation,
    })),
  ];

  const summary =
    `Invariant ${input.invariantKey} (${input.evaluatorVersion}) FAILED for subject ` +
    `${input.subjectKey}: ${String(attributableCount)} distinct accepted equivalent effects were ` +
    `attributed to it (basis: active identity graph), exceeding maxAcceptedEffects=` +
    `${String(maxAcceptedEffects)}.`;

  return {
    finding: {
      findingRuleVersion: GENERIC_FINDING_RULE_VERSION,
      subjectKey: input.subjectKey,
      reasonCode: GENERIC_FINDING_REASON_CODES.tooManyAcceptedEffects,
      title: GENERIC_FINDING_TITLES.tooManyAcceptedEffects,
      summary: summary.slice(0, 500),
      details: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        registryVersion: asString(details['registryVersion']),
        kind: 'atMostOneAcceptedEffect',
        maxAcceptedEffects,
        attributableEffectCount: attributableCount,
        countedEffectIdentities: countedIdentities.sort(),
        minimalProofEffectIdentities: minimalIdentities,
        evidenceSetHash: input.evidenceSetHash,
      },
      provenScope: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        verdict: 'FAIL',
        attributableEffectCount: attributableCount,
        maxAcceptedEffects,
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis,
      },
      uncertainScope: {
        // Lower-bound-safe FAIL: additional unseen effects could exist;
        // enumeration completeness is intentionally not required (§8).
        enumerationComplete: false,
        lowerBoundSafe: true,
      },
    },
    proofReferences,
    inputFingerprint: fingerprintOf(input, proofReferences),
  };
}

// ---------------------------------------------------------------------
// resourceConservation → Case A / Case B / Case C (priority A > B > C,
// read from the persisted primary failure mechanism — never reordered)
// ---------------------------------------------------------------------

function deriveResourceConservationFinding(
  input: GenericFindingEvaluationInput,
  mechanism: string,
): GenericFindingDerivation {
  switch (mechanism) {
    case 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE':
      return deriveCaseA(input);
    case 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING':
      return deriveCaseB(input);
    case 'RESOURCE_CONSERVATION_MISMATCH':
      return deriveCaseC(input);
    default:
      throw new Error(
        `evaluation ${input.id} is a resourceConservation FAIL with unknown failure mechanism ${mechanism}; refusing to derive a Finding`,
      );
  }
}

function deriveCaseA(input: GenericFindingEvaluationInput): GenericFindingDerivation {
  const details = input.details;
  const baseline = asNumber(details['baselineValue']);
  const sum = asNumber(details['acceptedReservedUnits']);
  const identities = asStringArray(details['consumptionEffectIdentities']);
  if (
    baseline === null ||
    sum === null ||
    identities === null ||
    identities.length === 0 ||
    sum <= baseline
  ) {
    throw new Error(
      `evaluation ${input.id} is Case A FAIL but its persisted details do not prove sum > baseline; refusing to derive an untraceable Finding`,
    );
  }
  // Minimal proof subset: the evaluator's persisted intact consumption
  // tuples (N-6) — identity, units, event, attribution, provenance in
  // ONE object, already the canonical running-sum minimal set selected
  // by the evaluator. Units are never re-sorted independently of their
  // identities, so a mispaired amount is structurally impossible.
  const minimalTuples = parseProofEffectTuples(details['minimalProofEffects']);
  if (minimalTuples === null || minimalTuples.some((tuple) => !Number.isInteger(tuple.units))) {
    throw new Error(
      `evaluation ${input.id} is Case A FAIL but its persisted details do not carry a valid ` +
        `minimalProofEffects tuple set (intact identity+units pairs); refusing to derive an untraceable Finding`,
    );
  }
  const tupleSum = minimalTuples.reduce((total, tuple) => total + tuple.units, 0);
  if (tupleSum <= baseline) {
    throw new Error(
      `evaluation ${input.id} is Case A FAIL but its minimal proof tuples sum to ${String(tupleSum)} ≤ baseline ${String(baseline)}; refusing to derive a Finding that contradicts the evaluation`,
    );
  }
  const minimalIdentities = minimalTuples.map((tuple) => tuple.effectIdentity);

  // Proof references: exactly the minimal tuples' events, per-effect
  // attribution relationships, and source observations — the exact
  // effects whose units establish the violation, never the whole run.
  const proofEventIds = minimalTuples.map((tuple) => tuple.eventId).sort();
  const proofRelationshipIds = [
    ...new Set(minimalTuples.flatMap((tuple) => [...tuple.relationshipIds])),
  ].sort();
  const proofObservationHashes = [
    ...new Set(minimalTuples.flatMap((tuple) => [...tuple.observationHashes])),
  ].sort();
  const proofReferences: GenericFindingProofReference[] = [
    {
      subject: 'INVARIANT_EVALUATION',
      sourceId: input.id,
      role: GENERIC_PROOF_ROLES.invariantEvaluation,
    },
    ...proofEventIds.map((eventId) => ({
      subject: 'NORMALIZED_EVENT' as const,
      sourceId: eventId,
      role: GENERIC_PROOF_ROLES.countedEffect,
    })),
    ...proofRelationshipIds.map((relationshipId) => ({
      subject: 'CAUSAL_RELATIONSHIP' as const,
      sourceId: relationshipId,
      role: GENERIC_PROOF_ROLES.attributionRelationship,
    })),
    ...proofObservationHashes.map((hash) => ({
      subject: 'RAW_OBSERVATION' as const,
      sourceId: hash,
      role: GENERIC_PROOF_ROLES.sourceObservation,
    })),
  ];

  const summary =
    `Invariant ${input.invariantKey} (${input.evaluatorVersion}) FAILED for resource ` +
    `${input.subjectKey}: accepted attributable consumption (${String(sum)} units over ` +
    `${String(identities.length)} distinct effect(s)) exceeded the baseline (${String(baseline)} units) ` +
    `(Case A, lower-bound-safe).`;

  return {
    finding: {
      findingRuleVersion: GENERIC_FINDING_RULE_VERSION,
      subjectKey: input.subjectKey,
      reasonCode: GENERIC_FINDING_REASON_CODES.resourceConservationExceededBaseline,
      title: GENERIC_FINDING_TITLES.resourceConservationExceededBaseline,
      summary: summary.slice(0, 500),
      details: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        registryVersion: asString(details['registryVersion']),
        kind: 'resourceConservation',
        case: 'A',
        baselineValue: baseline,
        acceptedReservedUnits: sum,
        consumptionEffectIdentities: [...identities].sort(),
        minimalProofEffectIdentities: minimalIdentities,
        minimalProofEffects: minimalTuples,
        evidenceSetHash: input.evidenceSetHash,
      },
      provenScope: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        verdict: 'FAIL',
        baselineValue: baseline,
        acceptedReservedUnits: sum,
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis,
      },
      uncertainScope: {
        enumerationComplete: false,
        lowerBoundSafe: true,
      },
    },
    proofReferences,
    inputFingerprint: fingerprintOf(input, proofReferences),
  };
}

function deriveCaseB(input: GenericFindingEvaluationInput): GenericFindingDerivation {
  const details = input.details;
  const remaining = asNumber(details['remainingValue']);
  if (remaining === null || remaining >= 0) {
    throw new Error(
      `evaluation ${input.id} is Case B FAIL but its persisted details do not prove a negative authoritative remaining state; refusing to derive an untraceable Finding`,
    );
  }
  // N-1 (frozen detail shape): the authoritative Case-B proof is the
  // persisted minimal remaining-state surface — the negative remaining
  // observation event(s), their source observations, and the resource
  // identity proof. Baseline and consumption evidence are deliberately
  // NOT cited (ADR-0023 §10); a missing persisted shape fails CLOSED —
  // the fallback to the full evaluation proof set was removed with the
  // audit's N-1 finding.
  const remainingEventIds = asStringArray(details['remainingEventIds']);
  const remainingObservationHashes = asStringArray(details['remainingObservationHashes']);
  const resourceProofEventIds = asStringArray(details['resourceProofEventIds']);
  if (
    remainingEventIds === null ||
    remainingEventIds.length === 0 ||
    remainingObservationHashes === null ||
    resourceProofEventIds === null
  ) {
    throw new Error(
      `evaluation ${input.id} is Case B FAIL but its persisted details do not carry the minimal ` +
        `remaining-state proof (remainingEventIds/remainingObservationHashes/resourceProofEventIds); refusing to derive an untraceable Finding`,
    );
  }

  // Source observations: only the authoritative remaining surface's
  // observations that belong to the evaluation's own provenance set.
  const evaluationHashes = new Set(input.sourceObservationHashes);
  const proofObservationHashes = remainingObservationHashes.filter((hash) =>
    evaluationHashes.has(hash),
  );
  const proofReferences: GenericFindingProofReference[] = [
    {
      subject: 'INVARIANT_EVALUATION',
      sourceId: input.id,
      role: GENERIC_PROOF_ROLES.invariantEvaluation,
    },
    ...remainingEventIds
      .slice()
      .sort()
      .map((eventId) => ({
        subject: 'NORMALIZED_EVENT' as const,
        sourceId: eventId,
        role: GENERIC_PROOF_ROLES.countedEffect,
      })),
    ...resourceProofEventIds
      .slice()
      .sort()
      .map((eventId) => ({
        subject: 'NORMALIZED_EVENT' as const,
        sourceId: eventId,
        role: GENERIC_PROOF_ROLES.subjectEvent,
      })),
    ...proofObservationHashes.map((hash) => ({
      subject: 'RAW_OBSERVATION' as const,
      sourceId: hash,
      role: GENERIC_PROOF_ROLES.sourceObservation,
    })),
  ];

  const summary =
    `Invariant ${input.invariantKey} (${input.evaluatorVersion}) FAILED for resource ` +
    `${input.subjectKey}: the authoritative remaining state is ${String(remaining)} units ` +
    `(Case B: an authoritative negative remaining state proves the violation directly).`;

  return {
    finding: {
      findingRuleVersion: GENERIC_FINDING_RULE_VERSION,
      subjectKey: input.subjectKey,
      reasonCode: GENERIC_FINDING_REASON_CODES.resourceConservationNegativeRemaining,
      title: GENERIC_FINDING_TITLES.resourceConservationNegativeRemaining,
      summary: summary.slice(0, 500),
      details: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        registryVersion: asString(details['registryVersion']),
        kind: 'resourceConservation',
        case: 'B',
        remainingValue: remaining,
        remainingQueryIds: asStringArray(details['remainingQueryIds']) ?? [],
        minimalProofEventIds: [...new Set([...remainingEventIds, ...resourceProofEventIds])].sort(),
        evidenceSetHash: input.evidenceSetHash,
      },
      provenScope: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        verdict: 'FAIL',
        remainingValue: remaining,
        remainingSurfaceAuthoritative: true,
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis,
      },
      uncertainScope: {
        baselineRequired: false,
        consumptionEnumerationComplete: false,
      },
    },
    proofReferences,
    inputFingerprint: fingerprintOf(input, proofReferences),
  };
}

function deriveCaseC(input: GenericFindingEvaluationInput): GenericFindingDerivation {
  const details = input.details;
  const baseline = asNumber(details['baselineValue']);
  const sum = asNumber(details['acceptedReservedUnits']);
  const remaining = asNumber(details['remainingValue']);
  const expected = asNumber(details['expectedRemaining']);
  const observedCount = asNumber(details['observedCount']);
  const observedTotal = asNumber(details['observedTotal']);
  const identities = asStringArray(details['consumptionEffectIdentities']);
  if (
    baseline === null ||
    sum === null ||
    remaining === null ||
    expected === null ||
    observedCount === null ||
    observedTotal === null ||
    identities === null ||
    remaining === expected
  ) {
    throw new Error(
      `evaluation ${input.id} is Case C FAIL but its persisted details do not prove the conservation mismatch with proven-complete enumeration; refusing to derive an untraceable Finding`,
    );
  }
  const proofEventIds = [...input.normalizedEventIds].sort();
  const proofReferences: GenericFindingProofReference[] = [
    {
      subject: 'INVARIANT_EVALUATION',
      sourceId: input.id,
      role: GENERIC_PROOF_ROLES.invariantEvaluation,
    },
    ...proofEventIds.map((eventId) => ({
      subject: 'NORMALIZED_EVENT' as const,
      sourceId: eventId,
      role: GENERIC_PROOF_ROLES.countedEffect,
    })),
    ...[...input.causalRelationshipIds].sort().map((relationshipId) => ({
      subject: 'CAUSAL_RELATIONSHIP' as const,
      sourceId: relationshipId,
      role: GENERIC_PROOF_ROLES.attributionRelationship,
    })),
    ...[...input.sourceObservationHashes].sort().map((hash) => ({
      subject: 'RAW_OBSERVATION' as const,
      sourceId: hash,
      role: GENERIC_PROOF_ROLES.sourceObservation,
    })),
  ];

  const summary =
    `Invariant ${input.invariantKey} (${input.evaluatorVersion}) FAILED for resource ` +
    `${input.subjectKey}: remaining (${String(remaining)}) != initial (${String(baseline)}) − ` +
    `acceptedReservedUnits (${String(sum)}) with enumeration proven complete ` +
    `(${String(observedCount)}/${String(observedTotal)}) (Case C).`;

  return {
    finding: {
      findingRuleVersion: GENERIC_FINDING_RULE_VERSION,
      subjectKey: input.subjectKey,
      reasonCode: GENERIC_FINDING_REASON_CODES.resourceConservationMismatch,
      title: GENERIC_FINDING_TITLES.resourceConservationMismatch,
      summary: summary.slice(0, 500),
      details: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        registryVersion: asString(details['registryVersion']),
        kind: 'resourceConservation',
        case: 'C',
        baselineValue: baseline,
        acceptedReservedUnits: sum,
        remainingValue: remaining,
        expectedRemaining: expected,
        observedCount,
        observedTotal,
        consumptionEffectIdentities: [...identities].sort(),
        evidenceSetHash: input.evidenceSetHash,
      },
      provenScope: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        verdict: 'FAIL',
        baselineValue: baseline,
        acceptedReservedUnits: sum,
        remainingValue: remaining,
        observedCount,
        observedTotal,
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis,
      },
      uncertainScope: {
        enumerationComplete: true,
      },
    },
    proofReferences,
    inputFingerprint: fingerprintOf(input, proofReferences),
  };
}

/**
 * SHA-256 over the canonical semantic input tuple: rule version, the
 * persisted evaluation identity/content, the reason mechanism, and the
 * ordered proof-reference set. Wall clock never enters. Repeated or
 * concurrent derivation over the same persisted evaluation always
 * yields the same fingerprint (one Finding row under the unique key).
 */
function fingerprintOf(
  input: GenericFindingEvaluationInput,
  proof: readonly GenericFindingProofReference[],
): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        findingRuleVersion: GENERIC_FINDING_RULE_VERSION,
        sourceEvaluation: {
          id: input.id,
          runId: input.runId,
          invariantKey: input.invariantKey,
          evaluatorVersion: input.evaluatorVersion,
          subjectKey: input.subjectKey,
          verdict: input.verdict,
          completenessBasis: input.completenessBasis,
          evidenceSetHash: input.evidenceSetHash,
          details: input.details,
        },
        proofReferences: proof.map((reference) => ({
          subject: reference.subject,
          sourceId: reference.sourceId,
          role: reference.role,
        })),
      }),
    )
    .digest('hex');
}

/**
 * True when the evaluation row belongs to the Phase 15 generic
 * registry (its details carry the frozen registry identity). The
 * legacy INV-IZ-1 rule stays the ONLY rule for legacy evaluations.
 */
export function isGenericEvaluation(
  evaluation: Pick<GenericFindingEvaluationInput, 'details'>,
): boolean {
  return (
    isRecord(evaluation.details) &&
    evaluation.details['registryVersion'] === 'business-invariant/v1' &&
    (evaluation.details['kind'] === 'atMostOneAcceptedEffect' ||
      evaluation.details['kind'] === 'resourceConservation')
  );
}
