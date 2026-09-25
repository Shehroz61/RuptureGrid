// =====================================================================
// RuptureGrid v1.0 — INV-IZ-1 pure evaluator unit tests (§7, §36–§44)
// =====================================================================
// Deterministic verdicts over synthetic evidence graphs:
//   two attributed equivalent effects ⇒ FAIL
//   one attributed equivalent effect  ⇒ PASS
//   unattributable effect             ⇒ NOT_EVALUABLE (never silent pass)
//   delivery-only evidence            ⇒ NOT_EVALUABLE
//   two distinct payments             ⇒ independent PASS

import { describe, expect, it } from 'vitest';
import { evaluateInvIz1, INV_IZ_1 } from './invariants.js';
import type { InvariantEvidenceGraph } from './invariants.js';

let seq = 0;
const id = (prefix: string): string => `${prefix}-${(seq += 1).toString().padStart(4, '0')}`;

interface GraphBuilder {
  readonly graph: InvariantEvidenceGraph;
  payment(subjectKey: string, amountMinor?: string): { id: string };
  deliveryObserved(providerPaymentId: string, deliveryAttemptId: string): { id: string };
  deliveryRecorded(
    subjectKey: string,
    providerEventId: string,
    deliveryAttemptId: string,
  ): { id: string };
  attempt(
    subjectKey: string,
    deliveryAttemptId: string,
    processingAttemptId: string,
  ): { id: string };
  effect(input: {
    subjectKey: string;
    processingAttemptId: string;
    walletId: string;
    amountMinor: string;
  }): { id: string };
  relate(fromEventId: string, toEventId: string, relationKind: string): void;
}

function builder(): GraphBuilder {
  const events: InvariantEvidenceGraph['events'][number][] = [];
  const relationships: InvariantEvidenceGraph['relationships'][number][] = [];
  const push = (
    eventType: string,
    subjectKey: string,
    payload: Record<string, unknown>,
  ): { id: string } => {
    const row = { id: id('ev'), eventType, subjectKey, payload, inputHash: id('hash') };
    events.push(row);
    return row;
  };
  return {
    graph: { runId: 'run-unit', events, relationships },
    payment(subjectKey, amountMinor = '500000') {
      return push('demo.provider-payment-observed', subjectKey, {
        providerPaymentId: subjectKey,
        walletId: 'w-1',
        amountMinor,
        currency: 'PKR',
        status: 'CONFIRMED',
      });
    },
    deliveryObserved(providerPaymentId, deliveryAttemptId) {
      return push('demo.payment-delivery-observed', providerPaymentId, {
        providerPaymentId,
        deliveryAttemptId,
      });
    },
    deliveryRecorded(subjectKey, providerEventId, deliveryAttemptId) {
      return push('demo.webhook-delivery-observed', subjectKey, {
        providerEventId,
        deliveryAttemptId,
      });
    },
    attempt(subjectKey, deliveryAttemptId, processingAttemptId) {
      return push('demo.processing-attempt-observed', subjectKey, {
        deliveryAttemptId,
        processingAttemptId,
      });
    },
    effect({ subjectKey, processingAttemptId, walletId, amountMinor }) {
      return push('demo.financial-effect-observed', subjectKey, {
        providerPaymentId: subjectKey,
        processingAttemptId,
        walletId,
        effectType: 'WALLET_CREDIT',
        amountMinor,
        currency: 'PKR',
      });
    },
    relate(fromEventId, toEventId, relationKind) {
      relationships.push({
        id: id('rel'),
        fromEventId,
        toEventId,
        relationKind,
        basis: 'identity-direct',
        evidenceJson: {},
      });
    },
  };
}

/** Builds one fully chain-attributed payment lineage; returns event ids. */
function attributedLineage(
  g: GraphBuilder,
  subjectKey: string,
  effectCount: number,
): { paymentId: string } {
  const payment = g.payment(subjectKey);
  const providerEvent = { id: 'pe' } as { id: string };
  const gAny = g as unknown as {
    graph: InvariantEvidenceGraph;
    relate: GraphBuilder['relate'];
  };
  // provider event observed (subject = payment)
  const pe = {
    id: id('ev-pe'),
    eventType: 'demo.provider-event-observed',
    subjectKey,
    payload: { providerEventId: providerEvent.id, providerPaymentId: subjectKey },
    inputHash: id('hash'),
  };
  // The synthetic builder appends into the graph's (readonly-typed) event
  // list; the mutable alias is test construction, not production mutation.
  (gAny.graph.events as Array<typeof pe>).push(pe);
  g.relate(payment.id, pe.id, 'describes-payment');

  let lastAttemptId: { id: string } | null = null;
  for (let index = 0; index < effectCount; index += 1) {
    const deliveryAttemptId = `D-${subjectKey}-${index}`;
    const processingAttemptId = `PA-${subjectKey}-${index}`;
    const observed = g.deliveryObserved(subjectKey, deliveryAttemptId);
    const recorded = g.deliveryRecorded(
      subjectKey,
      pe.payload['providerEventId'] as string,
      deliveryAttemptId,
    );
    g.relate(pe.id, recorded.id, 'delivered-as');
    g.relate(observed.id, recorded.id, 'executor-delivery-matches-target');
    const attempt = g.attempt(subjectKey, deliveryAttemptId, processingAttemptId);
    g.relate(recorded.id, attempt.id, 'processed-as');
    const effect = g.effect({
      subjectKey,
      processingAttemptId,
      walletId: 'w-1',
      amountMinor: '500000',
    });
    g.relate(attempt.id, effect.id, 'produced-effect');
    lastAttemptId = attempt;
  }
  void lastAttemptId;
  return { paymentId: payment.id };
}

describe('INV-IZ-1 evaluator', () => {
  it('carries the versioned identity', () => {
    expect(INV_IZ_1.key).toBe('INV-IZ-1');
    expect(INV_IZ_1.version).toMatch(/^v\d+$/);
  });

  it('FAILs when two equivalent effects are identity-chain attributed', () => {
    const g = builder();
    attributedLineage(g, 'PP-fail-0000000001', 2);
    const results = evaluateInvIz1(g.graph);
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.subjectKey).toBe('PP-fail-0000000001');
    expect(result?.verdict).toBe('FAIL');
    expect(result?.completenessBasis).toBe('lineage-complete');
    expect(result?.details['equivalentEffectCount']).toBe(2);
    expect(result?.details['attributionBasis']).toBe('identity-chain');
  });

  it('PASSes with exactly one attributed effect', () => {
    const g = builder();
    attributedLineage(g, 'PP-pass-0000000001', 1);
    const results = evaluateInvIz1(g.graph);
    expect(results[0]?.verdict).toBe('PASS');
    expect(results[0]?.details['equivalentEffectCount']).toBe(1);
  });

  it('is deterministic: same graph ⇒ same verdicts', () => {
    const g1 = builder();
    attributedLineage(g1, 'PP-det-00000000001', 2);
    const g2 = builder();
    attributedLineage(g2, 'PP-det-00000000001', 2);
    // Verdicts/reasons are identical; row ids are storage identity, not
    // evaluation semantics, so they are excluded from the comparison
    // (paymentEventId and the counted effect ids are both graph-local
    // identity, not evaluation semantics).
    const strip = (results: ReturnType<typeof evaluateInvIz1>) =>
      results.map((result) => ({
        subjectKey: result.subjectKey,
        verdict: result.verdict,
        reason: result.reason,
        completenessBasis: result.completenessBasis,
        details: {
          ...result.details,
          paymentEventId: '<id>',
          equivalentEffectEventIds: '<ids>',
        },
      }));
    expect(strip(evaluateInvIz1(g1.graph))).toEqual(strip(evaluateInvIz1(g2.graph)));
  });

  it('returns NOT_EVALUABLE when an equivalent effect cannot be chain-attributed', () => {
    const g = builder();
    attributedLineage(g, 'PP-gap-00000000001', 1);
    // An orphan effect claiming the payment: no identity chain reaches it.
    g.effect({
      subjectKey: 'PP-gap-00000000001',
      processingAttemptId: 'PA-orphan',
      walletId: 'w-1',
      amountMinor: '500000',
    });
    const results = evaluateInvIz1(g.graph);
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
    expect(String(results[0]?.reason)).toContain('cannot be attributed');
    expect(results[0]?.completenessBasis).toBe('incomplete');
  });

  it('evaluates two distinct payments independently (no conflation)', () => {
    const g = builder();
    attributedLineage(g, 'PP-alpha-0000000001', 1);
    attributedLineage(g, 'PP-beta-00000000001', 1);
    const results = evaluateInvIz1(g.graph);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result?.verdict).toBe('PASS');
      expect(result?.details['equivalentEffectCount']).toBe(1);
    }
  });

  it('does NOT fail on temporal proximity alone (adversarial)', () => {
    const g = builder();
    attributedLineage(g, 'PP-time-0000000001', 1);
    // A second effect that is NOT chain-attributable but "happens" to
    // sit temporally adjacent. The evaluator has NO timestamp inputs at
    // all — an unattributed effect yields NOT_EVALUABLE, never FAIL.
    g.effect({
      subjectKey: 'PP-time-0000000001',
      processingAttemptId: 'PA-unrelated',
      walletId: 'w-1',
      amountMinor: '500000',
    });
    const results = evaluateInvIz1(g.graph);
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
    expect(results[0]?.verdict).not.toBe('FAIL');
  });

  it('treats non-equivalent effects as distinct business actions (not duplicates)', () => {
    const g = builder();
    attributedLineage(g, 'PP-mixed-000000001', 1);
    // A different-amount effect: not equivalent, never counted.
    const attempt = g.attempt('PP-mixed-000000001', 'D-x', 'PA-diff-amount');
    const effect = g.effect({
      subjectKey: 'PP-mixed-000000001',
      processingAttemptId: 'PA-diff-amount',
      walletId: 'w-1',
      amountMinor: '777777',
    });
    g.relate(attempt.id, effect.id, 'produced-effect');
    const results = evaluateInvIz1(g.graph);
    expect(results[0]?.verdict).toBe('PASS');
    expect(results[0]?.details['nonEquivalentEffects']).toBe(1);
  });

  it('returns NOT_EVALUABLE for payments known only from delivery evidence', () => {
    const g = builder();
    g.deliveryObserved('PP-deliveryonly-0001', 'D-solo');
    const results = evaluateInvIz1(g.graph);
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
    expect(results[0]?.completenessBasis).toBe('delivery-attributable');
  });

  it('returns no subjects for an empty graph', () => {
    const g = builder();
    expect(evaluateInvIz1(g.graph)).toEqual([]);
  });
});
