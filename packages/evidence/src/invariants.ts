// =====================================================================
// RuptureGrid v1.0 — deterministic invariant evaluation (Phase 4, §7)
// =====================================================================
// INV-IZ-1 (incident-zero §5): for every confirmed logical provider
// payment P, the number of accepted equivalent wallet-credit financial
// effects causally attributable to P must be ≤ 1.
//
// Determinism contract (evidence-model §7): same inputs (same evidence
// set + same target-state verification + same evaluator version) ⇒
// same verdict, always. The evaluator is a PURE function over the
// persisted evidence graph. AI artifacts can never be inputs
// (ADR-0007); uncertainty is never converted into certainty.
//
// Verdicts (incident-zero §5, exactly):
//   PASS          — ≤ 1 accepted equivalent effect attributed to P
//   FAIL          — ≥ 2 accepted equivalent effects, EVERY counted
//                   duplicate attributed with basis ≥ identity-chain
//   NOT_EVALUABLE — effects exist but attribution is insufficient, or
//                   the verification surface is incomplete
//
// Attribution bases (evidence-model §6):
//   identity-direct | identity-chain | temporal-correlation
// temporal-correlation can never produce a FAIL (§6.2): this evaluator
// only walks identity-backed relationships — timestamps are not inputs.

import { INV_IZ_1_EVALUATOR_VERSION, INV_IZ_1_KEY } from './versions.js';

/** The evidence graph snapshot the evaluator reads (all DERIVED). */
export interface InvariantEvidenceGraph {
  readonly runId: string;
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly eventType: string;
    readonly subjectKey: string | null;
    readonly payload: Record<string, unknown>;
    readonly inputHash: string;
  }>;
  readonly relationships: ReadonlyArray<{
    readonly id: string;
    readonly fromEventId: string;
    readonly toEventId: string;
    readonly relationKind: string;
    readonly basis: string;
    readonly evidenceJson: Record<string, unknown>;
  }>;
}

export type InvariantVerdictValue = 'PASS' | 'FAIL' | 'NOT_EVALUABLE';

export interface EvaluationSubjectResult {
  readonly subjectKey: string;
  readonly verdict: InvariantVerdictValue;
  readonly reason: string;
  readonly completenessBasis: string;
  readonly details: Record<string, unknown>;
}

/** The completeness bases (bounded vocabulary, §16/§18). */
export const COMPLETENESS_BASES = {
  lineageComplete: 'lineage-complete',
  deliveryAttributable: 'delivery-attributable',
  incomplete: 'incomplete',
} as const;

export interface EvaluatorVersion {
  readonly key: string;
  readonly version: string;
}

export const INV_IZ_1: EvaluatorVersion = {
  key: INV_IZ_1_KEY,
  version: INV_IZ_1_EVALUATOR_VERSION,
};

/** Relationship kinds produced by the derivation pipeline. */
const RELATION = {
  describesPayment: 'describes-payment',
  deliveredAs: 'delivered-as',
  processedAs: 'processed-as',
  producedEffect: 'produced-effect',
  recordedAsEntry: 'recorded-as-entry',
} as const;

/**
 * The pure INV-IZ-1 evaluator. Subjects = every confirmed logical
 * payment the evidence names (from target-state verification and/or
 * delivery observations). Each subject is evaluated INDEPENDENTLY:
 * two distinct legitimate payments can never be conflated.
 */
export function evaluateInvIz1(graph: InvariantEvidenceGraph): EvaluationSubjectResult[] {
  const results: EvaluationSubjectResult[] = [];

  const paymentEvents = graph.events.filter(
    (event) => event.eventType === 'demo.provider-payment-observed',
  );
  const effectEvents = graph.events.filter(
    (event) => event.eventType === 'demo.financial-effect-observed',
  );
  const deliveryNamedPayments = new Set<string>();
  for (const event of graph.events) {
    if (
      (event.eventType === 'demo.payment-delivery-observed' ||
        event.eventType === 'demo.webhook-delivery-observed') &&
      typeof event.payload['providerPaymentId'] === 'string'
    ) {
      deliveryNamedPayments.add(event.payload['providerPaymentId']);
    }
  }

  // Adjacency for identity-chain walking (every hop identity-direct).
  type Relationship = InvariantEvidenceGraph['relationships'][number];
  const relsByTo = new Map<string, Relationship[]>();
  for (const rel of graph.relationships) {
    if (rel.basis !== 'identity-direct') {
      continue; // Only identity-backed hops may be walked (§6).
    }
    const list = relsByTo.get(rel.toEventId) ?? [];
    list.push(rel);
    relsByTo.set(rel.toEventId, list);
  }

  const evaluateSubject = (paymentEvent: {
    readonly id: string;
    readonly subjectKey: string | null;
    readonly payload: Record<string, unknown>;
  }): EvaluationSubjectResult => {
    const subjectKey = paymentEvent.subjectKey ?? '';
    const amountMinor = paymentEvent.payload['amountMinor'];
    const currency = paymentEvent.payload['currency'];
    const walletId = paymentEvent.payload['walletId'];

    // Equivalence tuple (incident-zero §5): payment identity, wallet,
    // effect type, amount, currency. Non-matching effects are recorded
    // as nonEquivalent (distinct business actions), never counted.
    const effectsForPayment = effectEvents.filter(
      (event) => event.payload['providerPaymentId'] === subjectKey,
    );
    const equivalent = effectsForPayment.filter(
      (event) =>
        event.payload['effectType'] === 'WALLET_CREDIT' &&
        event.payload['currency'] === currency &&
        event.payload['amountMinor'] === amountMinor &&
        event.payload['walletId'] === walletId,
    );
    const nonEquivalentCount = effectsForPayment.length - equivalent.length;

    // Attribution: an effect is chain-attributed when the identity
    // chain payment ← event ← delivery ← attempt ← effect is walkable
    // through identity-direct relationships.
    const attributed = new Set<string>();
    for (const effect of equivalent) {
      const attemptRels = (relsByTo.get(effect.id) ?? []).filter(
        (rel) => rel.relationKind === RELATION.producedEffect,
      );
      let chainFound = false;
      for (const attemptRel of attemptRels) {
        const deliveryRels = (relsByTo.get(attemptRel.fromEventId) ?? []).filter(
          (rel) => rel.relationKind === RELATION.processedAs,
        );
        for (const deliveryRel of deliveryRels) {
          const logicalEventRels = (relsByTo.get(deliveryRel.fromEventId) ?? []).filter(
            (rel) => rel.relationKind === RELATION.deliveredAs,
          );
          for (const logicalEventRel of logicalEventRels) {
            const paymentRels = (relsByTo.get(logicalEventRel.fromEventId) ?? []).filter(
              (rel) => rel.relationKind === RELATION.describesPayment,
            );
            if (paymentRels.some((rel) => rel.fromEventId === paymentEvent.id)) {
              chainFound = true;
            }
          }
        }
      }
      if (chainFound) {
        attributed.add(effect.id);
      }
    }
    const unattributable = equivalent.filter((effect) => !attributed.has(effect.id));

    // NOT_EVALUABLE first: attribution is insufficient (§6.4) — the
    // gap is reported honestly, never assumed away.
    if (unattributable.length > 0) {
      return {
        subjectKey,
        verdict: 'NOT_EVALUABLE',
        reason:
          `${unattributable.length} accepted equivalent effect(s) cannot be attributed to the ` +
          `payment via the identity chain; attribution gap reported honestly (evidence-model §6.4)`,
        completenessBasis: COMPLETENESS_BASES.incomplete,
        details: {
          equivalentEffectCount: equivalent.length,
          attributedEffectCount: attributed.size,
          unattributableEffectIds: unattributable.map((effect) => effect.id),
          nonEquivalentEffects: nonEquivalentCount,
          attributionBasisRequired: 'identity-chain',
          paymentEventId: paymentEvent.id,
          amountMinor: amountMinor ?? null,
          currency: currency ?? null,
        },
      };
    }
    if (equivalent.length >= 2) {
      return {
        subjectKey,
        verdict: 'FAIL',
        reason:
          `${equivalent.length} accepted equivalent wallet credits of ` +
          `${String(amountMinor)} ${String(currency)} attributed to one confirmed logical ` +
          `payment (basis: identity-chain, every counted effect chain-attributed)`,
        completenessBasis: COMPLETENESS_BASES.lineageComplete,
        details: {
          equivalentEffectCount: equivalent.length,
          attributedEffectCount: attributed.size,
          attributionBasis: 'identity-chain',
          paymentEventId: paymentEvent.id,
          walletId: walletId ?? null,
          amountMinor: amountMinor ?? null,
          currency: currency ?? null,
          nonEquivalentEffects: nonEquivalentCount,
        },
      };
    }
    // PASS: 0 or 1 accepted equivalent effects, verification surface
    // complete (the payment's own lineage was observed). 0 ≤ 1 — the
    // invariant is satisfied; a missing credit is a different invariant.
    return {
      subjectKey,
      verdict: 'PASS',
      reason:
        equivalent.length === 1
          ? `exactly one accepted equivalent wallet credit of ${String(amountMinor)} ` +
            `${String(currency)} attributed to the confirmed logical payment (basis: identity-chain)`
          : 'no accepted equivalent effect recorded by the target for this payment; 0 ≤ 1, invariant satisfied',
      completenessBasis: COMPLETENESS_BASES.lineageComplete,
      details: {
        equivalentEffectCount: equivalent.length,
        attributedEffectCount: attributed.size,
        attributionBasis: 'identity-chain',
        paymentEventId: paymentEvent.id,
        walletId: walletId ?? null,
        amountMinor: amountMinor ?? null,
        currency: currency ?? null,
        nonEquivalentEffects: nonEquivalentCount,
      },
    };
  };

  // Subjects WITH target-state verification (payment events).
  const evaluated = new Set<string>();
  for (const paymentEvent of paymentEvents) {
    const subjectKey = paymentEvent.subjectKey ?? '';
    if (subjectKey === '') {
      continue;
    }
    evaluated.add(subjectKey);
    results.push(evaluateSubject(paymentEvent));
  }

  // Payments named ONLY by delivery evidence (no lineage captured for
  // them): verification surface incomplete → NOT_EVALUABLE (§7 inputs
  // require target-state verification; absence is honest, §18/§41).
  for (const subjectKey of deliveryNamedPayments) {
    if (evaluated.has(subjectKey)) {
      continue;
    }
    results.push({
      subjectKey,
      verdict: 'NOT_EVALUABLE',
      reason:
        'payment observed in delivery evidence but target business-state verification ' +
        '(inspection lineage) was not captured for it; the invariant cannot be evaluated',
      completenessBasis: COMPLETENESS_BASES.deliveryAttributable,
      details: {
        verificationSurface: 'absent',
        deliveryEvidenceOnly: true,
      },
    });
  }
  return results;
}
