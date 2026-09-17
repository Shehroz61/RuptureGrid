// =====================================================================
// RuptureGrid v1.0 — deterministic Finding rule (Phase 5, §9–§18)
// =====================================================================
// A Finding is an investigator-facing DETERMINISTIC statement derived
// from an ALREADY-PERSISTED InvariantEvaluation (evidence-model §8):
//
//   FAIL may produce a Finding (§10) — exactly one per (evaluation,
//   rule version); PASS must NOT produce a failure Finding (§40);
//   NOT_EVALUABLE must NOT produce a failure Finding (§41).
//
// The Finding NEVER re-evaluates evidence and never contradicts the
// evaluation (one business truth engine, §37): every number it exposes
// (effect count, amounts, basis) is copied from the evaluation's own
// persisted details. Reason codes are a bounded vocabulary (§14); the
// title/summary come from fixed templates (§15) — no AI prose anywhere
// (ADR-0007). The proof-reference set is the MINIMAL SUFFICIENT set
// (§29): the evaluated subject, the counted equivalent-effect events,
// the identity-chain relationships that attribute them, the source
// observations, and the evaluation's run/step/invocation trace.
//
// Determinism (§31): the same persisted evaluation always produces the
// same semantic Finding, the same proof set, and the same input
// fingerprint — independent of insertion order, wall clock, or call
// count (creation timestamps never enter semantic identity, §32).

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import { FINDING_RULE_VERSION, DUPLICATE_CREDIT_TITLE_TEMPLATE } from './versions.js';

/** Bounded reason-code vocabulary (§14). One rule in Phase 5. */
export const FINDING_REASON_CODES = {
  duplicateEquivalentFinancialEffect: 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
} as const;

export type FindingReasonCodeValue =
  (typeof FINDING_REASON_CODES)[keyof typeof FINDING_REASON_CODES];

/** Bounded proof-reference roles (§29). */
export const PROOF_ROLES = {
  invariantEvaluation: 'invariant-evaluation',
  countedEffect: 'counted-equivalent-effect',
  attributionRelationship: 'attribution-relationship',
  sourceObservation: 'source-observation',
  executionTrace: 'execution-trace',
} as const;

/**
 * Execution-side uncertainty facts the pipeline feeds into the pure
 * rule (evidence-model §8: the Finding's confidence scope must
 * explicitly list INDETERMINATE outcomes). Built from the run's own
 * persisted execution rows — never guessed.
 */
export interface FindingExecutionScope {
  /** Invocations whose side-effect knowledge is INDETERMINATE. */
  readonly indeterminateInvocationIds: readonly string[];
}

/**
 * Confidence scope emitted with the Finding (evidence-model §8):
 * `provenScope` states what the evidence proves; `uncertainScope`
 * states what remains uncertain — INDETERMINATE invocation outcomes,
 * non-counted business actions, and the (absent) temporal-correlation
 * dependencies. Deterministic over the evaluation + execution rows.
 */
export interface FindingConfidenceScope {
  readonly proven: Record<string, unknown>;
  readonly uncertain: Record<string, unknown>;
}

/** Typed source reference (§47/§63): the durable row a proof cites. */
export const PROOF_SUBJECTS = {
  invariantEvaluation: 'INVARIANT_EVALUATION',
  normalizedEvent: 'NORMALIZED_EVENT',
  causalRelationship: 'CAUSAL_RELATIONSHIP',
  rawObservation: 'RAW_OBSERVATION',
  stepRun: 'STEP_RUN',
  invocation: 'INVOCATION',
} as const;

export interface FindingProofReference {
  /** Typed subject kind (DB enum value). */
  readonly subject: string;
  /** Durable row id, or the observation contentHash for raw evidence. */
  readonly sourceId: string;
  /** Bounded role of this reference in the proof. */
  readonly role: string;
}

/** The shape of one persisted InvariantEvaluation row (Phase 4). */
export interface FindingEvaluationInput {
  readonly id: string;
  readonly runId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly verdict: string;
  /** The evaluation's own completeness claim (Phase 4 column). */
  readonly completenessBasis: string;
  readonly evidenceSetHash: string;
  readonly sourceObservationHashes: readonly string[];
  readonly normalizedEventIds: readonly string[];
  readonly causalRelationshipIds: readonly string[];
  readonly details: Record<string, unknown>;
  /** Run execution uncertainty (INDETERMINATE invocations). */
  readonly executionUncertainty: FindingExecutionScope;
}

/** Pure derivation output for one evaluation. */
export interface FindingDerivation {
  /** null ⇒ no Finding exists for this evaluation (PASS/NOT_EVALUABLE). */
  readonly finding: {
    readonly findingRuleVersion: string;
    readonly subjectKey: string;
    readonly reasonCode: FindingReasonCodeValue;
    readonly title: string;
    readonly summary: string;
    readonly details: Record<string, unknown>;
    readonly provenScope: Record<string, unknown>;
    readonly uncertainScope: Record<string, unknown>;
  } | null;
  readonly proofReferences: readonly FindingProofReference[];
  /** SHA-256 over the canonical semantic input tuple (§32/§135). */
  readonly inputFingerprint: string;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asStringOrNumber = (value: unknown): string | number | null =>
  typeof value === 'string' || typeof value === 'number' ? value : null;
const asStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null;

/**
 * The one deterministic finding rule (Phase 5 scope): a FAILed
 * INV-IZ-1 evaluation yields exactly one duplicate-credit Finding for
 * its subject. PASS and NOT_EVALUABLE yield NO Finding — uncertainty
 * and correctness are never converted into a defect (§10/§40/§41).
 * Anything other than the known invariant/version/verdict shapes is
 * refused (raised), never guessed into a Finding.
 */
export function deriveFindingFromEvaluation(input: FindingEvaluationInput): FindingDerivation {
  // The evaluation IS the authority: only its own verdict decides
  // whether a Finding exists (§37/§89). No recomputation, no override.
  const verdict = input.verdict;
  if (verdict !== 'FAIL' && verdict !== 'PASS' && verdict !== 'NOT_EVALUABLE') {
    throw new Error(`unknown invariant verdict: ${String(verdict)}`);
  }
  if (verdict !== 'FAIL') {
    return {
      finding: null,
      proofReferences: [],
      inputFingerprint: fingerprintOf(input, []),
    };
  }
  if (input.invariantKey !== 'INV-IZ-1') {
    throw new Error(`no finding rule is defined for invariant ${input.invariantKey}`);
  }

  // Every exposed number is COPIED from the evaluation's persisted
  // details (§96: effect count comes from the evaluation, never from
  // attempts; §95: money stays exact minor-unit integers).
  const details = input.details;
  const effectCount = details['equivalentEffectCount'];
  if (typeof effectCount !== 'number' || !Number.isInteger(effectCount) || effectCount < 2) {
    // A FAIL evaluation must carry a counted-duplicate detail set. A
    // missing/inconsistent detail set is a derivation failure (§90) —
    // an untraceable Finding is never manufactured.
    throw new Error(
      `evaluation ${input.id} is FAIL but its persisted details do not carry a valid ` +
        `equivalentEffectCount; refusing to derive an untraceable Finding`,
    );
  }
  // Echoed exactly as the evaluation persisted them (string or number,
  // never converted — provenance fidelity, §96; money stays the exact
  // minor-unit value, R-06).
  const amountMinor = asStringOrNumber(details['amountMinor']);
  const currency = asString(details['currency']);
  const walletId = asString(details['walletId']);
  const attributionBasis = asString(details['attributionBasis']);
  const attributedEffectCount = details['attributedEffectCount'];
  const nonEquivalentEffects = details['nonEquivalentEffects'];

  // Confidence scope (evidence-model §8) — deterministic over the
  // evaluation's own persisted facts plus the run's execution truth.
  // proven: exactly what the evidence establishes. uncertain: every
  // honest residual (INDETERMINATE outcomes, uncounted actions, and
  // the explicit absence of any sub-identity attribution dependency).
  const indeterminateIds = [...input.executionUncertainty.indeterminateInvocationIds].sort();
  const provenScope: Record<string, unknown> = {
    invariantKey: input.invariantKey,
    evaluatorVersion: input.evaluatorVersion,
    verdict: 'FAIL',
    equivalentEffectCount: effectCount,
    attributedEffectCount: typeof attributedEffectCount === 'number' ? attributedEffectCount : null,
    attributionBasis: attributionBasis ?? null,
    evidenceSetHash: input.evidenceSetHash,
    completenessBasis: input.completenessBasis,
  };
  const uncertainScope: Record<string, unknown> = {
    indeterminateInvocationCount: indeterminateIds.length,
    indeterminateInvocationIds: indeterminateIds,
    nonEquivalentEffects: typeof nonEquivalentEffects === 'number' ? nonEquivalentEffects : null,
    // Attribution counted ONLY identity-chain-attributable effects;
    // no temporal-correlation dependency was relied upon.
    attributionBelowIdentityChain: 0,
    // Relative concurrency order is observed, never asserted (§5
    // determinism policy); the Finding does not depend on it.
    schedulingOrderAsserted: false,
  };

  // Deterministic summary from fixed templates over normalized values
  // (§15/§98: no free-form prose, no secret-bearing content — the
  // evaluation details were built from redacted, safe facts).
  const summary =
    `Invariant ${input.invariantKey} (${input.evaluatorVersion}) FAILED for confirmed logical ` +
    `payment ${input.subjectKey}: ${effectCount} accepted equivalent wallet-credit effects of ` +
    `${String(amountMinor ?? 'unknown')} ${currency ?? ''} were attributed to it (basis: ` +
    `${attributionBasis ?? 'unknown'}).`.trim();

  // ---- Minimal sufficient proof set (§29) — deterministically ordered.
  const proof: Array<{ subject: string; sourceId: string; role: string; order: string }> = [];
  // 1. The authoritative evaluation itself.
  proof.push({
    subject: PROOF_SUBJECTS.invariantEvaluation,
    sourceId: input.id,
    role: PROOF_ROLES.invariantEvaluation,
    order: `0:${input.id}`,
  });
  // 2. The counted equivalent effects (identity-backed normalized
  //    events). When the evaluation's details name them explicitly,
  //    cite exactly those; otherwise the evaluation's normalizedEventIds
  //    ARE the derivation input — cite them (the minimal sufficient set
  //    the evaluator itself used). Deterministic: sorted.
  const effectEventIds = asStringArray(details['equivalentEffectEventIds']);
  const citedEventIds = effectEventIds ?? [...input.normalizedEventIds];
  for (const id of [...citedEventIds].sort()) {
    proof.push({
      subject: PROOF_SUBJECTS.normalizedEvent,
      sourceId: id,
      role: PROOF_ROLES.countedEffect,
      order: `1:${id}`,
    });
  }
  // 3. The identity-chain relationships that attribute the counted
  //    effects (§13: Finding → evaluation → relationships).
  for (const id of [...input.causalRelationshipIds].sort()) {
    proof.push({
      subject: PROOF_SUBJECTS.causalRelationship,
      sourceId: id,
      role: PROOF_ROLES.attributionRelationship,
      order: `2:${id}`,
    });
  }
  // 4. The raw observations (by stable contentHash — the durable raw
  //    handle Phase 4 exposes; hashes never contain secrets, §8/§13).
  for (const hash of [...input.sourceObservationHashes].sort()) {
    proof.push({
      subject: PROOF_SUBJECTS.rawObservation,
      sourceId: hash,
      role: PROOF_ROLES.sourceObservation,
      order: `3:${hash}`,
    });
  }

  const proofReferences: FindingProofReference[] = proof
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map((entry) => ({ subject: entry.subject, sourceId: entry.sourceId, role: entry.role }));
  return {
    finding: {
      findingRuleVersion: FINDING_RULE_VERSION,
      subjectKey: input.subjectKey,
      reasonCode: FINDING_REASON_CODES.duplicateEquivalentFinancialEffect,
      title: DUPLICATE_CREDIT_TITLE_TEMPLATE,
      summary: summary.slice(0, 500),
      // Deterministic detail copied from the evaluation (§50/§96/§97).
      details: {
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        equivalentEffectCount: effectCount,
        amountMinor: amountMinor ?? null,
        currency: currency ?? null,
        walletId: walletId ?? null,
        attributionBasis: attributionBasis ?? null,
        evidenceSetHash: input.evidenceSetHash,
      },
      provenScope,
      uncertainScope,
    },
    proofReferences,
    inputFingerprint: fingerprintOf(input, proofReferences),
  };
}

/**
 * SHA-256 over the canonical semantic input tuple (§32/§135): rule
 * version, evaluation semantic identity, subject, and the ordered
 * proof set. Wall-clock creation time NEVER enters — recomputing this
 * over the same persisted evaluation always yields the same value.
 */
function fingerprintOf(
  input: FindingEvaluationInput,
  proof: readonly FindingProofReference[],
): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        findingRuleVersion: FINDING_RULE_VERSION,
        sourceEvaluation: {
          id: input.id,
          runId: input.runId,
          invariantKey: input.invariantKey,
          evaluatorVersion: input.evaluatorVersion,
          subjectKey: input.subjectKey,
          verdict: input.verdict,
          completenessBasis: input.completenessBasis,
          evidenceSetHash: input.evidenceSetHash,
        },
        confidenceScopeInputs: {
          indeterminateInvocationIds: [
            ...input.executionUncertainty.indeterminateInvocationIds,
          ].sort(),
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
