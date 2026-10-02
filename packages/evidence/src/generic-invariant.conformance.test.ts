// =====================================================================
// RuptureGrid v1.1 Phase 15 — INV-IZ-1 conformance (ADR-0023 §13)
// =====================================================================
// The frozen evaluateInvIz1 is NOT modified (asserted by the frozen
// invariants.test.ts suite). This suite proves the generic
// atMostOneAcceptedEffect evaluator AGREES with it on the canonical
// Incident Zero cases (PASS / FAIL / NOT_EVALUABLE attribution gap)
// for equivalent evidence semantics. Conformance compares verdicts
// only — never reason strings. Where the legacy PASS implicitly treats
// the Demo lineage inspection as complete, the fixture supplies the
// equivalent EXPLICIT completeness provenance (an observed-total
// summary bound to the payment subject and scope); the new
// completeness requirement is never weakened to make fixtures match.

import { describe, expect, it } from 'vitest';
import { evaluateInvIz1, INV_IZ_1 } from './invariants.js';
import type { InvariantEvidenceGraph } from './invariants.js';
import { BUSINESS_INVARIANT_KINDS, BUSINESS_INVARIANT_REGISTRY_VERSION } from '@rupturegrid/engine';
import { evaluateGenericInvariant, GENERIC_EVALUATION_GAPS } from './generic-invariant-evaluate.js';
import type {
  GenericActiveRelationship,
  GenericEvidenceEntity,
  GenericEvaluationInput,
} from './generic-invariant-evaluate.js';
import type { AtMostOneAcceptedEffectParams } from '@rupturegrid/engine';

// ---------------------------------------------------------------------
// The generic instance mirroring INV-IZ-1's semantics (§13): the
// equivalence tuple (payment identity, wallet, amount, currency) with
// the accepted-effect discriminator (effectType = WALLET_CREDIT) as the
// acceptedMatch; effect identity = processingAttemptId (distinct
// attempts are distinct effects, exactly as the legacy evaluator counts
// them); scope binding over the single declared scope field (the
// legacy Demo lineage carries no generation mechanism, so
// generationField is absent — the optional path).
// ---------------------------------------------------------------------
const params: AtMostOneAcceptedEffectParams = {
  subjectRole: 'payment',
  subjectIdentityField: 'providerPaymentId',
  effectRole: 'financialEffect',
  effectIdentityField: 'processingAttemptId',
  acceptedMatch: { field: 'effectType', value: 'WALLET_CREDIT' },
  equivalenceFields: ['providerPaymentId', 'walletId', 'amountMinor', 'currency'],
  maxAcceptedEffects: 1,
  completenessProof: {
    kind: 'observed-total',
    queryId: 'financialEffectsSummary',
    subjectField: 'providerPaymentId',
    totalField: 'acceptedEffectTotal',
  },
  scopeBinding: { fields: ['verificationScopeId'] },
};

const SCOPE_IZ = 'scope-incident-zero';
const AMOUNT = '500000'; // Legacy Demo lineage amountMinor is a string.

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(seq += 1)}`;

function paymentEvent(providerPaymentId = 'PAY-1'): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-payment'),
    roleId: 'payment',
    queryId: 'payments',
    payload: {
      providerPaymentId,
      walletId: 'w-1',
      amountMinor: AMOUNT,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE_IZ,
      rupturegrid: { queryId: 'payments', roleId: 'payment' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

function effectEvent(
  processingAttemptId: string,
  providerPaymentId = 'PAY-1',
): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-effect'),
    roleId: 'financialEffect',
    queryId: 'financialEffects',
    payload: {
      processingAttemptId,
      providerPaymentId,
      walletId: 'w-1',
      effectType: 'WALLET_CREDIT',
      amountMinor: AMOUNT,
      currency: 'PKR',
      verificationScopeId: SCOPE_IZ,
      rupturegrid: { queryId: 'financialEffects', roleId: 'financialEffect' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

function summary(total: number, providerPaymentId = 'PAY-1'): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-summary'),
    roleId: 'financialEffectsSummary',
    queryId: 'financialEffectsSummary',
    payload: {
      providerPaymentId,
      acceptedEffectTotal: total,
      verificationScopeId: SCOPE_IZ,
      rupturegrid: { queryId: 'financialEffectsSummary', roleId: 'financialEffectsSummary' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

function harness(
  entities: readonly GenericEvidenceEntity[],
  relationships: readonly GenericActiveRelationship[],
): GenericEvaluationInput {
  const subject = entities[0];
  if (subject === undefined || subject.roleId !== 'payment') {
    throw new Error('conformance fixtures always evaluate exactly one payment subject');
  }
  const queriesByRole = new Map<string, string[]>([
    ['payment', ['payments']],
    ['financialEffect', ['financialEffects']],
  ]);
  const captures = new Map(
    ['payments', 'financialEffects', 'financialEffectsSummary'].map((queryId) => [
      queryId,
      {
        queryId,
        roleId:
          queryId === 'payments'
            ? 'payment'
            : queryId === 'financialEffects'
              ? 'financialEffect'
              : 'financialEffectsSummary',
        valid: true,
        captured: true,
        reasonCode: 'VALID',
        sourceObservationHashes: [`hash-${queryId}`],
      },
    ]),
  );
  return {
    runId: 'run-conf',
    snapshotContentHash: 'snap-conf',
    targetId: 'target-demo',
    instance: {
      key: 'INV-IZ-1-CONFORMANCE',
      kind: BUSINESS_INVARIANT_KINDS.atMostOneAcceptedEffect,
      registryVersion: BUSINESS_INVARIANT_REGISTRY_VERSION,
      params,
    },
    captures,
    queriesByRole: queriesByRole as never,
    entities,
    activeRelationships: relationships,
    subject: {
      subjectKey: 'PAY-1',
      subjectEventIds: [subject.eventId],
      subjectPayload: subject.payload,
    },
    contestedEventIds: new Set<string>(),
  };
}

/** Identity-backed chain payment → delivery → attempt → effect. */
function lineageChain(
  subject: GenericEvidenceEntity,
  effect: GenericEvidenceEntity,
): GenericActiveRelationship[] {
  const deliveryId = nextId('ev-delivery');
  const attemptId = nextId('ev-attempt');
  return [
    {
      relationshipId: nextId('rel'),
      fromEventId: subject.eventId,
      toEventId: deliveryId,
      relationKind: 'delivered-as',
      basis: 'identity-direct',
    },
    {
      relationshipId: nextId('rel'),
      fromEventId: deliveryId,
      toEventId: attemptId,
      relationKind: 'processed-as',
      basis: 'identity-direct',
    },
    {
      relationshipId: nextId('rel'),
      fromEventId: attemptId,
      toEventId: effect.eventId,
      relationKind: 'produced-effect',
      basis: 'identity-direct',
    },
  ];
}

// ---------------------------------------------------------------------
// The FROZEN legacy evaluator, driven over the same semantic cases
// (builder mirrors invariants.test.ts without modifying anything).
// ---------------------------------------------------------------------
function legacyGraphWithEffects(effectCount: number, breakChain: boolean): InvariantEvidenceGraph {
  const events: InvariantEvidenceGraph['events'][number][] = [];
  const relationships: InvariantEvidenceGraph['relationships'][number][] = [];
  let localSeq = 0;
  const id = (prefix: string): string => `${prefix}-${(localSeq += 1)}`;
  const push = (
    eventType: string,
    subjectKey: string,
    payload: Record<string, unknown>,
  ): string => {
    const rowId = id('ev');
    (
      events as Array<{
        id: string;
        eventType: string;
        subjectKey: string | null;
        payload: Record<string, unknown>;
        inputHash: string;
      }>
    ).push({
      id: rowId,
      eventType,
      subjectKey,
      payload,
      inputHash: id('hash'),
    });
    return rowId;
  };
  const relate = (fromEventId: string, toEventId: string, relationKind: string): void => {
    (
      relationships as Array<{
        id: string;
        fromEventId: string;
        toEventId: string;
        relationKind: string;
        basis: string;
        evidenceJson: Record<string, unknown>;
      }>
    ).push({
      id: id('rel'),
      fromEventId,
      toEventId,
      relationKind,
      basis: 'identity-direct',
      evidenceJson: {},
    });
  };
  const paymentId = push('demo.provider-payment-observed', 'PAY-1', {
    providerPaymentId: 'PAY-1',
    walletId: 'w-1',
    amountMinor: AMOUNT,
    currency: 'PKR',
    status: 'CONFIRMED',
  });
  const peId = push('demo.provider-event-observed', 'PAY-1', {
    providerEventId: 'pe-1',
    providerPaymentId: 'PAY-1',
  });
  relate(paymentId, peId, 'describes-payment');
  for (let index = 0; index < effectCount; index += 1) {
    const deliveryAttemptId = `D-PAY-1-${index}`;
    const processingAttemptId = `PA-PAY-1-${index}`;
    const observedId = push('demo.payment-delivery-observed', 'PAY-1', {
      providerPaymentId: 'PAY-1',
      deliveryAttemptId,
    });
    const recordedId = push('demo.webhook-delivery-observed', 'PAY-1', {
      providerEventId: 'pe-1',
      deliveryAttemptId,
    });
    relate(observedId, recordedId, 'executor-delivery-matches-target');
    relate(peId, recordedId, 'delivered-as');
    const attemptId = push('demo.processing-attempt-observed', 'PAY-1', {
      deliveryAttemptId,
      processingAttemptId,
    });
    relate(recordedId, attemptId, 'processed-as');
    const effectId = push('demo.financial-effect-observed', 'PAY-1', {
      providerPaymentId: 'PAY-1',
      processingAttemptId,
      walletId: 'w-1',
      effectType: 'WALLET_CREDIT',
      amountMinor: AMOUNT,
      currency: 'PKR',
    });
    if (!breakChain) {
      relate(attemptId, effectId, 'produced-effect');
    }
  }
  return { runId: 'run-conf-legacy', events, relationships };
}

const legacyVerdict = (graph: InvariantEvidenceGraph): string => {
  const results = evaluateInvIz1(graph);
  expect(results).toHaveLength(1);
  return results[0]?.verdict ?? 'MISSING';
};

describe('INV-IZ-1 conformance (ADR-0023 §13) — legacy vs generic verdict agreement', () => {
  it('the frozen legacy evaluator identity is untouched', () => {
    expect(INV_IZ_1.key).toBe('INV-IZ-1');
    expect(typeof INV_IZ_1.version).toBe('string');
    expect(INV_IZ_1.version.length).toBeGreaterThan(0);
  });

  it('canonical PASS: one chain-attributed effect ⇒ both PASS', () => {
    // Legacy: implicitly complete lineage ⇒ PASS.
    expect(legacyVerdict(legacyGraphWithEffects(1, false))).toBe('PASS');
    // Generic: same semantics + EXPLICIT completeness provenance (§13).
    const subject = paymentEvent();
    const effect = effectEvent('PA-PAY-1-0');
    const result = evaluateGenericInvariant(
      harness([subject, effect, summary(1)], lineageChain(subject, effect)),
    );
    expect(result.verdict).toBe('PASS');
  });

  it('canonical FAIL: two chain-attributed equivalent effects ⇒ both FAIL (no completeness needed)', () => {
    expect(legacyVerdict(legacyGraphWithEffects(2, false))).toBe('FAIL');
    const subject = paymentEvent();
    const e1 = effectEvent('PA-PAY-1-0');
    const e2 = effectEvent('PA-PAY-1-1');
    const result = evaluateGenericInvariant(
      harness([subject, e1, e2], [...lineageChain(subject, e1), ...lineageChain(subject, e2)]),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('TOO_MANY_ACCEPTED_EFFECTS');
  });

  it('canonical NOT_EVALUABLE: equivalent effect with a broken attribution chain ⇒ both NOT_EVALUABLE', () => {
    expect(legacyVerdict(legacyGraphWithEffects(1, true))).toBe('NOT_EVALUABLE');
    const subject = paymentEvent();
    const effect = effectEvent('PA-PAY-1-0');
    const result = evaluateGenericInvariant(harness([subject, effect, summary(1)], []));
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });

  it('non-equivalent effects are distinct business actions in BOTH evaluators (never FAIL on two distinct credits of different amounts)', () => {
    // Legacy: second effect with a different amountMinor is non-equivalent.
    const legacyGraph = legacyGraphWithEffects(1, false);
    const extraEffectId = `ev-extra-${legacyGraph.events.length}`;
    (
      legacyGraph.events as Array<{
        id: string;
        eventType: string;
        subjectKey: string | null;
        payload: Record<string, unknown>;
        inputHash: string;
      }>
    ).push({
      id: extraEffectId,
      eventType: 'demo.financial-effect-observed',
      subjectKey: 'PAY-1',
      payload: {
        providerPaymentId: 'PAY-1',
        processingAttemptId: 'PA-PAY-1-9',
        walletId: 'w-1',
        effectType: 'WALLET_CREDIT',
        amountMinor: '999999',
        currency: 'PKR',
      },
      inputHash: 'hash-extra',
    });
    expect(legacyVerdict(legacyGraph)).toBe('PASS');
    // Generic: the 999999-amount effect is not equivalent (equivalence
    // tuple differs) ⇒ never a candidate; PASS holds with total 1.
    const subject = paymentEvent();
    const e1 = effectEvent('PA-PAY-1-0');
    const e2 = effectEvent('PA-PAY-1-9', 'PAY-1');
    e2.payload['amountMinor'] = '999999';
    const result = evaluateGenericInvariant(
      harness(
        [subject, e1, e2, summary(1)],
        [...lineageChain(subject, e1), ...lineageChain(subject, e2)],
      ),
    );
    expect(result.verdict).toBe('PASS');
  });

  it('two distinct payments are independent subjects in BOTH evaluators (no conflation)', () => {
    // Legacy: two payments, one effect each ⇒ two PASS results.
    const legacyGraph = legacyGraphWithEffects(1, false);
    (
      legacyGraph.events as Array<{
        id: string;
        eventType: string;
        subjectKey: string | null;
        payload: Record<string, unknown>;
        inputHash: string;
      }>
    ).push(
      {
        id: 'ev-pay-2',
        eventType: 'demo.provider-payment-observed',
        subjectKey: 'PAY-2',
        payload: {
          providerPaymentId: 'PAY-2',
          walletId: 'w-1',
          amountMinor: AMOUNT,
          currency: 'PKR',
          status: 'CONFIRMED',
        },
        inputHash: 'hash-pay2',
      },
      {
        id: 'ev-pe-2',
        eventType: 'demo.provider-event-observed',
        subjectKey: 'PAY-2',
        payload: { providerEventId: 'pe-2', providerPaymentId: 'PAY-2' },
        inputHash: 'hash-pe2',
      },
      {
        id: 'ev-dobs-2',
        eventType: 'demo.payment-delivery-observed',
        subjectKey: 'PAY-2',
        payload: { providerPaymentId: 'PAY-2', deliveryAttemptId: 'D-2' },
        inputHash: 'hash-dobs2',
      },
      {
        id: 'ev-drec-2',
        eventType: 'demo.webhook-delivery-observed',
        subjectKey: 'PAY-2',
        payload: { providerEventId: 'pe-2', deliveryAttemptId: 'D-2' },
        inputHash: 'hash-drec2',
      },
      {
        id: 'ev-att-2',
        eventType: 'demo.processing-attempt-observed',
        subjectKey: 'PAY-2',
        payload: { deliveryAttemptId: 'D-2', processingAttemptId: 'PA-PAY-2-0' },
        inputHash: 'hash-att2',
      },
      {
        id: 'ev-eff-2',
        eventType: 'demo.financial-effect-observed',
        subjectKey: 'PAY-2',
        payload: {
          providerPaymentId: 'PAY-2',
          processingAttemptId: 'PA-PAY-2-0',
          walletId: 'w-1',
          effectType: 'WALLET_CREDIT',
          amountMinor: AMOUNT,
          currency: 'PKR',
        },
        inputHash: 'hash-eff2',
      },
    );
    (
      legacyGraph.relationships as Array<{
        id: string;
        fromEventId: string;
        toEventId: string;
        relationKind: string;
        basis: string;
        evidenceJson: Record<string, unknown>;
      }>
    ).push(
      {
        id: 'rel-2a',
        fromEventId: 'ev-pay-2',
        toEventId: 'ev-pe-2',
        relationKind: 'describes-payment',
        basis: 'identity-direct',
        evidenceJson: {},
      },
      {
        id: 'rel-2b',
        fromEventId: 'ev-dobs-2',
        toEventId: 'ev-drec-2',
        relationKind: 'executor-delivery-matches-target',
        basis: 'identity-direct',
        evidenceJson: {},
      },
      {
        id: 'rel-2c',
        fromEventId: 'ev-pe-2',
        toEventId: 'ev-drec-2',
        relationKind: 'delivered-as',
        basis: 'identity-direct',
        evidenceJson: {},
      },
      {
        id: 'rel-2d',
        fromEventId: 'ev-drec-2',
        toEventId: 'ev-att-2',
        relationKind: 'processed-as',
        basis: 'identity-direct',
        evidenceJson: {},
      },
      {
        id: 'rel-2e',
        fromEventId: 'ev-att-2',
        toEventId: 'ev-eff-2',
        relationKind: 'produced-effect',
        basis: 'identity-direct',
        evidenceJson: {},
      },
    );
    const legacyResults = evaluateInvIz1(legacyGraph);
    expect(legacyResults.map((entry) => entry.verdict).sort()).toEqual(['PASS', 'PASS']);

    // Generic: PAY-2's evidence never enters PAY-1's evaluation.
    const subject = paymentEvent();
    const effect = effectEvent('PA-PAY-1-0');
    const otherPaymentEffect = effectEvent('PA-PAY-2-0', 'PAY-2');
    const result = evaluateGenericInvariant(
      harness([subject, effect, summary(1), otherPaymentEffect], lineageChain(subject, effect)),
    );
    expect(result.verdict).toBe('PASS'); // PAY-2's effect is filtered by exact resource identity.
  });

  it('the generic evaluator never weakens completeness to match the legacy implicit PASS', () => {
    // Same one-attributed-effect lineage as the PASS case, but WITHOUT
    // the explicit bound summary ⇒ the generic verdict is honest
    // NOT_EVALUABLE, never PASS. This is the §13 asymmetry: conformance
    // adds provenance to old PASS fixtures; it never removes checks.
    const subject = paymentEvent();
    const effect = effectEvent('PA-PAY-1-0');
    const input = harness([subject, effect], lineageChain(subject, effect));
    const captures = new Map(input.captures);
    captures.set('financialEffectsSummary', {
      queryId: 'financialEffectsSummary',
      roleId: 'financialEffectsSummary',
      valid: false,
      captured: false,
      reasonCode: 'NO_CAPTURE_PRESENT',
      sourceObservationHashes: [],
    });
    const result = evaluateGenericInvariant({ ...input, captures });
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent);
  });
});
