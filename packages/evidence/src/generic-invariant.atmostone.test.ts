// =====================================================================
// RuptureGrid v1.1 Phase 15 — atMostOneAcceptedEffect truth table
// (pure; ADR-0023 §15 mandatory rows 1–18 + adversarial additions)
// =====================================================================
// Every verdict below is a PURE function of the constructed input —
// the same tables the frozen ADR mandates as committed tests. No DB,
// no HTTP, no wall clock.

import { describe, expect, it } from 'vitest';
import { BUSINESS_INVARIANT_REGISTRY_VERSION, BUSINESS_INVARIANT_KINDS } from '@rupturegrid/engine';
import type { AtMostOneAcceptedEffectParams } from '@rupturegrid/engine';
import {
  evaluateAtMostOneAcceptedEffect,
  GENERIC_EVALUATION_GAPS,
} from './generic-invariant-evaluate.js';
import type {
  GenericActiveRelationship,
  GenericEvidenceEntity,
  GenericEvaluationInput,
} from './generic-invariant-evaluate.js';

const params: AtMostOneAcceptedEffectParams = {
  subjectRole: 'checkoutIntent',
  subjectIdentityField: 'checkoutIntentId',
  effectRole: 'order',
  effectIdentityField: 'orderId',
  acceptedMatch: { field: 'status', value: 'ACCEPTED' },
  equivalenceFields: ['checkoutIntentId', 'customerId', 'cartId', 'totalMinor', 'currency'],
  maxAcceptedEffects: 1,
  completenessProof: {
    kind: 'observed-total',
    queryId: 'acceptedOrders',
    subjectField: 'checkoutIntentId',
    totalField: 'acceptedOrderTotal',
  },
  scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
};

const SUBJECT_ID = 'CHK-001';
const SCOPE = 'scope-A';
const GENERATION = 'gen-1';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(seq += 1)}`;

/** A valid subject event (queryId bound; scope coherent). */
function subjectEvent(): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-subject'),
    roleId: 'checkoutIntent',
    queryId: 'checkoutIntents',
    payload: {
      checkoutIntentId: SUBJECT_ID,
      customerId: 'CUST-1',
      cartId: 'CART-1',
      totalMinor: 500000,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      rupturegrid: { queryId: 'checkoutIntents', roleId: 'checkoutIntent' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** An accepted, equivalent, coherent effect event (effect-role query surface). */
function acceptedEffect(
  orderId: string,
  overrides: Record<string, unknown> = {},
): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-order'),
    roleId: 'order',
    queryId: 'acceptedOrdersEntities',
    payload: {
      orderId,
      checkoutIntentId: SUBJECT_ID,
      customerId: 'CUST-1',
      cartId: 'CART-1',
      totalMinor: 500000,
      currency: 'PKR',
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'acceptedOrdersEntities', roleId: 'order' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** A valid summary entity bound to the subject/scope/generation. */
function summary(total: number, overrides: Record<string, unknown> = {}): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-summary'),
    roleId: 'acceptedOrdersSummary',
    queryId: 'acceptedOrders',
    payload: {
      checkoutIntentId: SUBJECT_ID,
      acceptedOrderTotal: total,
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'acceptedOrders', roleId: 'acceptedOrdersSummary' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

interface HarnessOverrides {
  readonly subject?: GenericEvidenceEntity;
  readonly entities?: readonly GenericEvidenceEntity[];
  readonly relationships?: readonly GenericActiveRelationship[];
  readonly captures?: ReadonlyMap<
    string,
    { valid: boolean; captured: boolean; reasonCode: string }
  >;
  readonly queriesByRole?: ReadonlyMap<string, readonly string[]>;
  readonly contestedEventIds?: ReadonlySet<string>;
}

function harness(overrides: HarnessOverrides = {}): GenericEvaluationInput {
  const subject = overrides.subject ?? subjectEvent();
  const entities = overrides.entities ?? [];
  const relationshipList = overrides.relationships ?? [];
  const queriesByRole =
    overrides.queriesByRole ??
    new Map<string, string[]>([
      ['checkoutIntent', ['checkoutIntents']],
      ['order', ['acceptedOrdersEntities', 'ordersArchive']],
    ]);
  const captures = new Map<
    string,
    GenericEvaluationInput['captures'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  const roleOf = (queryId: string): string => {
    for (const [roleId, ids] of queriesByRole) {
      if (ids.includes(queryId)) {
        return roleId;
      }
    }
    return 'acceptedOrdersSummary'; // The completeness query's role.
  };
  for (const queryId of [
    'checkoutIntents',
    'acceptedOrdersEntities',
    'ordersArchive',
    'acceptedOrders',
  ]) {
    captures.set(queryId, {
      queryId,
      roleId: roleOf(queryId),
      valid: true,
      captured: true,
      reasonCode: 'VALID',
      sourceObservationHashes: [`hash-${queryId}`],
    });
  }
  if (overrides.captures !== undefined) {
    for (const [queryId, status] of overrides.captures) {
      captures.set(queryId, {
        queryId,
        roleId: roleOf(queryId),
        sourceObservationHashes: [`hash-${queryId}`],
        ...status,
      });
    }
  }
  return {
    runId: 'run-1',
    snapshotContentHash: 'snap-hash',
    targetId: 'target-1',
    instance: {
      key: 'INV-CHK-1',
      kind: BUSINESS_INVARIANT_KINDS.atMostOneAcceptedEffect,
      registryVersion: BUSINESS_INVARIANT_REGISTRY_VERSION,
      params,
    },
    captures: captures as never,
    queriesByRole: queriesByRole as never,
    entities: [subject, ...entities],
    activeRelationships: relationshipList,
    subject: {
      subjectKey: SUBJECT_ID,
      subjectEventIds: [subject.eventId],
      subjectPayload: subject.payload,
    },
    contestedEventIds: overrides.contestedEventIds ?? new Set<string>(),
  };
}

/** A directed chain subject → requestAttempt → order (all identity-direct). */
function chain(
  subject: GenericEvidenceEntity,
  effect: GenericEvidenceEntity,
): GenericActiveRelationship[] {
  const attemptId = nextId('ev-attempt');
  const rel1 = nextId('rel');
  const rel2 = nextId('rel');
  return [
    {
      relationshipId: rel1,
      fromEventId: subject.eventId,
      toEventId: attemptId,
      relationKind: 'submitted-as',
      basis: 'identity-direct',
    },
    {
      relationshipId: rel2,
      fromEventId: attemptId,
      toEventId: effect.eventId,
      relationKind: 'produced-order',
      basis: 'identity-direct',
    },
  ];
}

function verdictOf(input: GenericEvaluationInput) {
  return evaluateAtMostOneAcceptedEffect(input);
}

describe('atMostOneAcceptedEffect — frozen truth table (ADR-0023 §15)', () => {
  it('row 1: 0 effects, no completeness summary ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const result = verdictOf(harness({ subject, entities: [] }));
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('row 2: 0 effects + observed total 0 bound to subject/scope/generation ⇒ PASS', () => {
    const subject = subjectEvent();
    const result = verdictOf(harness({ subject, entities: [summary(0)] }));
    expect(result.verdict).toBe('PASS');
    expect(result.details['observedCount']).toBe(0);
    expect(result.details['observedTotal']).toBe(0);
  });

  it('row 3: 1 complete attributable effect ⇒ PASS', () => {
    const subject = subjectEvent();
    const effect = acceptedEffect('ORD-1');
    const result = verdictOf(
      harness({ subject, entities: [effect, summary(1)], relationships: chain(subject, effect) }),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.details['observedCount']).toBe(1);
  });

  it('row 4: 1 effect, attribution ok, enumeration incomplete (foreign summary) ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const effect = acceptedEffect('ORD-1');
    // Summary bound to a DIFFERENT subject: satisfies nothing (§2.4).
    const foreign = summary(1, { checkoutIntentId: 'CHK-OTHER' });
    const result = verdictOf(
      harness({ subject, entities: [effect, foreign], relationships: chain(subject, effect) }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('row 5: 2 equivalent accepted effects, both attributed ⇒ FAIL (no completeness needed)', () => {
    const subject = subjectEvent();
    const e1 = acceptedEffect('ORD-1');
    const e2 = acceptedEffect('ORD-2');
    const result = verdictOf(
      harness({
        subject,
        entities: [e1, e2, summary(1)],
        relationships: [...chain(subject, e1), ...chain(subject, e2)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('TOO_MANY_ACCEPTED_EFFECTS');
    // Contradictory summary total 1 vs observed 2 did NOT convert the FAIL.
    expect(result.details['countedEffectIdentities']).toHaveLength(2);
  });

  it('row 6: attribution gap, attributable subset ≤ max ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const attributed = acceptedEffect('ORD-1');
    const orphan = acceptedEffect('ORD-2'); // no chain to subject
    const result = verdictOf(
      harness({
        subject,
        entities: [attributed, orphan, summary(2)],
        relationships: chain(subject, attributed),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });

  it('row 7: attribution gap but fully-attributable subset > max ⇒ FAIL (lower-bound-safe)', () => {
    const subject = subjectEvent();
    const e1 = acceptedEffect('ORD-1');
    const e2 = acceptedEffect('ORD-2');
    const orphan = acceptedEffect('ORD-3');
    const result = verdictOf(
      harness({
        subject,
        entities: [e1, e2, orphan, summary(1)],
        relationships: [...chain(subject, e1), ...chain(subject, e2)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('TOO_MANY_ACCEPTED_EFFECTS');
  });

  it('row 8: non-equivalent effects are never counted', () => {
    const subject = subjectEvent();
    const otherCustomer = acceptedEffect('ORD-9', { customerId: 'CUST-OTHER' });
    const wrongStatus = acceptedEffect('ORD-8', { status: 'REJECTED' });
    const result = verdictOf(
      harness({ subject, entities: [otherCustomer, wrongStatus, summary(0)] }),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.details['observedCount']).toBe(0);
  });

  it('row 9: contested subject identity ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const result = verdictOf(
      harness({ subject, entities: [summary(0)], contestedEventIds: new Set([subject.eventId]) }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.contestedEvidence);
  });

  it('row 10: stale/invalidated chain to an effect ⇒ attribution-gap semantics', () => {
    const subject = subjectEvent();
    const effect = acceptedEffect('ORD-1');
    // The relationship is EXCLUDED from the active set (stale row):
    // the effect becomes unattributable, and 1 unattributable
    // candidate with no lower-bound FAIL ⇒ NOT_EVALUABLE.
    const result = verdictOf(
      harness({ subject, entities: [effect, summary(1)], relationships: [] }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });

  it('row 11: scope or generation mismatch on any bound surface ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const mismatchedScope = acceptedEffect('ORD-1', { verificationScopeId: 'scope-OTHER' });
    const result = verdictOf(
      harness({
        subject,
        entities: [mismatchedScope, summary(1)],
        relationships: chain(subject, mismatchedScope),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    // The mismatched-scope effect is not a candidate; enumeration
    // cannot be proven complete ⇒ completeness gap.
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('row 11b: generation mismatch ⇒ NOT_EVALUABLE', () => {
    const subject = subjectEvent();
    const staleGeneration = acceptedEffect('ORD-1', { generationId: 'gen-0' });
    const result = verdictOf(
      harness({
        subject,
        entities: [staleGeneration, summary(1)],
        relationships: chain(subject, staleGeneration),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
  });

  it('row 12: summary total < observed count ⇒ EVIDENCE_CONFLICT, never PASS (lower-bound FAIL precedes)', () => {
    const subject = subjectEvent();
    const e1 = acceptedEffect('ORD-1');
    const e2 = acceptedEffect('ORD-2');
    // total 1 < observed 2, but the two effects already prove FAIL.
    const failResult = verdictOf(
      harness({
        subject,
        entities: [e1, e2, summary(1)],
        relationships: [...chain(subject, e1), ...chain(subject, e2)],
      }),
    );
    expect(failResult.verdict).toBe('FAIL');
    // With only ONE attributable effect, the contradiction is NOT
    // overruled: observed 1 > total-claim 0 would be conflict.
    const single = acceptedEffect('ORD-1');
    const conflict = verdictOf(
      harness({ subject, entities: [single, summary(0)], relationships: chain(subject, single) }),
    );
    expect(conflict.verdict).toBe('NOT_EVALUABLE');
    expect(conflict.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 13: negative/type-invalid total ⇒ EVIDENCE_CONFLICT, no PASS', () => {
    const subject = subjectEvent();
    const negative = verdictOf(harness({ subject, entities: [summary(-1)] }));
    expect(negative.verdict).toBe('NOT_EVALUABLE');
    expect(negative.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
    const float = verdictOf(harness({ subject, entities: [summary(1.5)] }));
    expect(float.verdict).toBe('NOT_EVALUABLE');
    expect(float.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 14: effect capture invalid/never ran ⇒ NOT_EVALUABLE (surface absent)', () => {
    const subject = subjectEvent();
    const captures = new Map<string, { valid: boolean; captured: boolean; reasonCode: string }>([
      ['acceptedOrdersEntities', { valid: false, captured: true, reasonCode: 'HTTP_NON_SUCCESS' }],
    ]);
    const result = verdictOf(harness({ subject, entities: [summary(0)], captures }));
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent);
  });

  it('row 15: two identical bound summaries CONVERGE to one fact', () => {
    const subject = subjectEvent();
    const result = verdictOf(harness({ subject, entities: [summary(0), summary(0)] }));
    expect(result.verdict).toBe('PASS');
    expect(result.details['observedTotal']).toBe(0);
  });

  it('row 16: two bound summaries, totals 1 vs 2 ⇒ EVIDENCE_CONFLICT (independent FAIL would precede)', () => {
    const subject = subjectEvent();
    const result = verdictOf(harness({ subject, entities: [summary(1), summary(2)] }));
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 17: 1 effect + a second effect-role query failed + total 1 ⇒ NOT_EVALUABLE, never PASS', () => {
    const subject = subjectEvent();
    const effect = acceptedEffect('ORD-1');
    const captures = new Map<string, { valid: boolean; captured: boolean; reasonCode: string }>([
      ['ordersArchive', { valid: false, captured: true, reasonCode: 'RESPONSE_TRUNCATED' }],
    ]);
    const result = verdictOf(
      harness({
        subject,
        entities: [effect, summary(1)],
        relationships: chain(subject, effect),
        captures,
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent);
  });

  it('row 18: 2 proof effects > max + another effect query failed ⇒ FAIL (lower-bound-safe)', () => {
    const subject = subjectEvent();
    const e1 = acceptedEffect('ORD-1');
    const e2 = acceptedEffect('ORD-2');
    const captures = new Map<string, { valid: boolean; captured: boolean; reasonCode: string }>([
      ['ordersArchive', { valid: false, captured: false, reasonCode: 'NO_RESPONSE_OBSERVED' }],
    ]);
    const result = verdictOf(
      harness({
        subject,
        entities: [e1, e2],
        relationships: [...chain(subject, e1), ...chain(subject, e2)],
        captures,
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('TOO_MANY_ACCEPTED_EFFECTS');
  });
});

describe('atMostOneAcceptedEffect — adversarial additions', () => {
  it('same semantic effect observed twice counts ONCE (convergent duplicate)', () => {
    const subject = subjectEvent();
    const effectA = acceptedEffect('ORD-1');
    // Same semantic identity, IDENTICAL declared payload — a second
    // observation of the same effect through the same valid query
    // (distinct event row, distinct source observation hash).
    const effectB: GenericEvidenceEntity = {
      ...acceptedEffect('ORD-1'),
      eventId: nextId('ev-order'),
      sourceObservationHashes: [nextId('hash')],
    };
    const result = verdictOf(
      harness({
        subject,
        entities: [effectA, effectB, summary(1)],
        relationships: [...chain(subject, effectA), ...chain(subject, effectB)],
      }),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.details['observedCount']).toBe(1);
  });

  it('conflicting same effect identity ⇒ contested, never two effects', () => {
    const subject = subjectEvent();
    const effectA = acceptedEffect('ORD-1');
    const effectB = acceptedEffect('ORD-1', { totalMinor: 999999 });
    const result = verdictOf(
      harness({
        subject,
        entities: [effectA, effectB, summary(1)],
        relationships: [...chain(subject, effectA), ...chain(subject, effectB)],
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.contestedEvidence);
  });

  it('acceptedMatch value is type-exact ("1" ≠ 1)', () => {
    const subject = subjectEvent();
    const stringStatus = acceptedEffect('ORD-1', { status: 1 as unknown as string });
    const result = verdictOf(harness({ subject, entities: [stringStatus, summary(0)] }));
    expect(result.verdict).toBe('PASS'); // Not a candidate; 0 counted.
    expect(result.details['observedCount']).toBe(0);
  });

  it('summary foreign generation ignored; foreign subject ignored', () => {
    const subject = subjectEvent();
    const foreignGeneration = summary(0, { generationId: 'gen-9' });
    const foreignSubject = summary(0, { checkoutIntentId: 'CHK-9' });
    const result = verdictOf(harness({ subject, entities: [foreignGeneration, foreignSubject] }));
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('valid [] vs failed capture: absent capture is never zero entities', () => {
    const subject = subjectEvent();
    // Valid [] effect captures + bound total 0 ⇒ PASS eligible.
    const pass = verdictOf(harness({ subject, entities: [summary(0)] }));
    expect(pass.verdict).toBe('PASS');
    // A FAILED capture of the SAME role is an ABSENT surface.
    const captures = new Map<string, { valid: boolean; captured: boolean; reasonCode: string }>([
      ['acceptedOrdersEntities', { valid: false, captured: true, reasonCode: 'HTTP_NON_SUCCESS' }],
    ]);
    const absent = verdictOf(harness({ subject, entities: [summary(0)], captures }));
    expect(absent.verdict).toBe('NOT_EVALUABLE');
  });

  it('required-capture union dedupes by queryId (one shared query counted once)', () => {
    const subject = subjectEvent();
    // The summary query also serves an effect-role query: the union is
    // deduped, so one valid capture of it satisfies both requirements.
    const queriesByRole = new Map<string, string[]>([
      ['checkoutIntent', ['checkoutIntents']],
      ['order', ['acceptedOrders']],
    ]);
    const captures = new Map<string, { valid: boolean; captured: boolean; reasonCode: string }>();
    const result = verdictOf(harness({ subject, entities: [summary(0)], captures, queriesByRole }));
    expect(result.verdict).toBe('PASS');
  });
});
