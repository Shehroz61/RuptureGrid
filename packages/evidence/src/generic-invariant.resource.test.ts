// =====================================================================
// RuptureGrid v1.1 Phase 15 — resourceConservation truth table
// (pure; ADR-0023 §15 mandatory rows 1–20 + adversarial additions)
// =====================================================================
// Every verdict below is a PURE function of the constructed input —
// the same tables the frozen ADR mandates as committed tests. No DB,
// no HTTP, no wall clock.

import { describe, expect, it } from 'vitest';
import { BUSINESS_INVARIANT_REGISTRY_VERSION, BUSINESS_INVARIANT_KINDS } from '@rupturegrid/engine';
import type { ResourceConservationParams } from '@rupturegrid/engine';
import {
  evaluateResourceConservation,
  GENERIC_EVALUATION_GAPS,
} from './generic-invariant-evaluate.js';
import type {
  GenericActiveRelationship,
  GenericEvidenceEntity,
  GenericEvaluationInput,
} from './generic-invariant-evaluate.js';

const params: ResourceConservationParams = {
  resourceIdentityField: 'sku',
  baselineRole: 'skuBaseline',
  baselineUnitsField: 'initialAvailableUnits',
  remainingRole: 'skuRemaining',
  remainingUnitsField: 'remainingAvailableUnits',
  consumptionEffectRole: 'reservation',
  consumptionEffectIdentityField: 'reservationId',
  consumptionUnitsField: 'reservedUnits',
  consumptionAcceptedMatch: { field: 'status', value: 'ACCEPTED' },
  completenessProof: {
    kind: 'observed-total',
    queryId: 'acceptedReservations',
    subjectField: 'sku',
    totalField: 'acceptedReservationTotal',
  },
  scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
};

const RESOURCE_ID = 'SKU-001';
const SCOPE = 'scope-A';
const GENERATION = 'gen-1';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(seq += 1)}`;

/** A valid resource (subject) event. */
function resourceEvent(): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-sku'),
    roleId: 'sku',
    queryId: 'skuEntities',
    payload: {
      sku: RESOURCE_ID,
      title: 'Widget',
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      rupturegrid: { queryId: 'skuEntities', roleId: 'sku' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** A coherent bound baseline observation. */
function baseline(units: number, overrides: Record<string, unknown> = {}): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-baseline'),
    roleId: 'skuBaseline',
    queryId: 'stockBaseline',
    payload: {
      sku: RESOURCE_ID,
      initialAvailableUnits: units,
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'stockBaseline', roleId: 'skuBaseline' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** A coherent bound remaining-state observation. */
function remaining(units: number, overrides: Record<string, unknown> = {}): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-remaining'),
    roleId: 'skuRemaining',
    queryId: 'stockRemaining',
    payload: {
      sku: RESOURCE_ID,
      remainingAvailableUnits: units,
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'stockRemaining', roleId: 'skuRemaining' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** An accepted, coherent, bound reservation (consumption effect). */
function reservation(
  reservationId: string,
  units: number,
  overrides: Record<string, unknown> = {},
): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-res'),
    roleId: 'reservation',
    queryId: 'reservationEvents',
    payload: {
      reservationId,
      sku: RESOURCE_ID,
      reservedUnits: units,
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'reservationEvents', roleId: 'reservation' },
    },
    sourceObservationHashes: [nextId('hash')],
    contested: false,
  };
}

/** A valid completeness summary bound to resource/scope/generation. */
function summary(total: number, overrides: Record<string, unknown> = {}): GenericEvidenceEntity {
  return {
    eventId: nextId('ev-summary'),
    roleId: 'acceptedReservationsSummary',
    queryId: 'acceptedReservations',
    payload: {
      sku: RESOURCE_ID,
      acceptedReservationTotal: total,
      verificationScopeId: SCOPE,
      generationId: GENERATION,
      ...overrides,
      rupturegrid: { queryId: 'acceptedReservations', roleId: 'acceptedReservationsSummary' },
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
  const subject = overrides.subject ?? resourceEvent();
  const entities = overrides.entities ?? [];
  const relationshipList = overrides.relationships ?? [];
  const queriesByRole =
    overrides.queriesByRole ??
    new Map<string, string[]>([
      ['skuBaseline', ['stockBaseline']],
      ['skuRemaining', ['stockRemaining']],
      ['reservation', ['reservationEvents']],
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
    return queryId === 'acceptedReservations' ? 'acceptedReservationsSummary' : 'sku';
  };
  const allQueryIds = new Set<string>([
    'skuEntities',
    'stockBaseline',
    'stockRemaining',
    'reservationEvents',
    'acceptedReservations',
  ]);
  for (const [roleId, ids] of queriesByRole) {
    for (const id of ids) {
      allQueryIds.add(id);
      if (roleOf(id) !== roleId) {
        // unreachable in these fixtures
      }
    }
  }
  for (const queryId of allQueryIds) {
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
      key: 'INV-INV-1',
      kind: BUSINESS_INVARIANT_KINDS.resourceConservation,
      registryVersion: BUSINESS_INVARIANT_REGISTRY_VERSION,
      params,
    },
    captures: captures as never,
    queriesByRole: queriesByRole as never,
    entities: [subject, ...entities],
    activeRelationships: relationshipList,
    subject: {
      subjectKey: RESOURCE_ID,
      subjectEventIds: [subject.eventId],
      subjectPayload: subject.payload,
    },
    contestedEventIds: overrides.contestedEventIds ?? new Set<string>(),
  };
}

/** Directed chain subject → goodsReceipt → reservation (identity-direct). */
function chain(
  subject: GenericEvidenceEntity,
  effect: GenericEvidenceEntity,
): GenericActiveRelationship[] {
  const receiptId = nextId('ev-receipt');
  return [
    {
      relationshipId: nextId('rel'),
      fromEventId: subject.eventId,
      toEventId: receiptId,
      relationKind: 'stocked-as',
      basis: 'identity-direct',
    },
    {
      relationshipId: nextId('rel'),
      fromEventId: receiptId,
      toEventId: effect.eventId,
      relationKind: 'reserved-from',
      basis: 'identity-direct',
    },
  ];
}

function verdictOf(input: GenericEvaluationInput) {
  return evaluateResourceConservation(input);
}

describe('resourceConservation — frozen truth table (ADR-0023 §15)', () => {
  it('row 1: missing baseline ⇒ NOT_EVALUABLE (BASELINE_MISSING; never inferred)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [res, remaining(8), summary(1)],
        relationships: chain(subject, res),
        captures: new Map([
          ['stockBaseline', { valid: true, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.baselineMissing);
  });

  it('row 2: missing remaining, no independent FAIL ⇒ NOT_EVALUABLE', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), res, summary(1)],
        relationships: chain(subject, res),
        captures: new Map([
          ['stockRemaining', { valid: true, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.remainingMissing); // The specific named gap (§8 rule 6): no bound remaining fact exists.
  });

  it('row 3: missing remaining BUT attributable consumption > baseline ⇒ FAIL Case A', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 12);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), res, summary(1)],
        relationships: chain(subject, res),
        captures: new Map([
          ['stockRemaining', { valid: true, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    expect(result.completenessBasis).toBe('incomplete');
  });

  it('row 4: initial 10, attributable consumption 11 ⇒ FAIL Case A (no completeness needed)', () => {
    const subject = resourceEvent();
    const r1 = reservation('RES-1', 6);
    const r2 = reservation('RES-2', 5);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), r1, r2, summary(2)],
        relationships: [...chain(subject, r1), ...chain(subject, r2)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    expect(result.gap).toBeNull();
  });

  it('row 4b: convergent duplicate observations of one reservation count ONCE (10+10dup ⇒ still Case A, not double-sum)', () => {
    const subject = resourceEvent();
    const r1 = reservation('RES-1', 11);
    const r1Duplicate = reservation('RES-1', 11);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), r1, r1Duplicate, summary(1)],
        relationships: [...chain(subject, r1), ...chain(subject, r1Duplicate)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    const details = result.details as { acceptedReservedUnits: number };
    expect(details.acceptedReservedUnits).toBe(11); // NEVER 22.
  });

  it('row 5: remaining −1, coherent + bound to R ⇒ FAIL Case B', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });

  it('row 6: remaining −1 incoherent/unbound scope ⇒ NOT_EVALUABLE, never FAIL', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [
          baseline(10),
          remaining(-1, { verificationScopeId: 'scope-OTHER' }),
          res,
          summary(1),
        ],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.remainingMissing); // The unbound −1 is never FAIL material and never binds.
  });

  it('row 6b: generation-mismatched negative remaining ⇒ NOT_EVALUABLE, never FAIL', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1, { generationId: 'gen-0' }), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
  });

  it('row 7: initial 10, complete consumption 2, remaining 5 ⇒ FAIL Case C', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(5), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_MISMATCH');
    expect(result.completenessBasis).toBe('observed-total');
  });

  it('row 8: initial 10, INCOMPLETE consumption 2, remaining 5 ⇒ NOT_EVALUABLE (completeness gap), never FAIL', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(5), res, summary(3)], // total 3 ≠ observed 1
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
    expect(result.failureMechanism).toBeNull();
  });

  it('row 9: initial 10, complete consumption 2, remaining 8 ⇒ PASS', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.failureMechanism).toBeNull();
    expect(result.gap).toBeNull();
    expect(result.completenessBasis).toBe('observed-total');
  });

  it('row 10: initial 1, complete consumption 1, remaining 0 ⇒ PASS (zero floor)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 1);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(1), remaining(0), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('PASS');
  });

  it('row 11: mismatched scope on any bound surface ⇒ NOT_EVALUABLE', () => {
    const subject = resourceEvent();
    const foreignRes = reservation('RES-1', 2, { verificationScopeId: 'scope-OTHER' });
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), foreignRes, summary(1)],
        relationships: chain(subject, foreignRes),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
  });

  it('row 11b: generation mismatch on consumption ⇒ NOT_EVALUABLE (SCOPE_INCOHERENT surface, never re-scoped)', () => {
    const subject = resourceEvent();
    const stale = reservation('RES-1', 2, { generationId: 'gen-0' });
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), stale, summary(1)],
        relationships: chain(subject, stale),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.scopeIncoherent);
  });

  it('row 12: float/numeric-string units are capture-rejected; a stored violation ⇒ EVIDENCE_CONFLICT (never coerced)', () => {
    const subject = resourceEvent();
    // At the seam, a float unit is rejected; the pure evaluator's defense
    // in depth treats a stored violation as contradictory evidence.
    const bad = reservation('RES-1', 1.5 as unknown as number);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), bad, summary(1)],
        relationships: chain(subject, bad),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 13: contested consumption attribution path ⇒ NOT_EVALUABLE', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const resConflict = reservation('RES-1', 7); // same identity, different payload
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, resConflict, summary(1)],
        relationships: [...chain(subject, res), ...chain(subject, resConflict)],
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.contestedEvidence);
  });

  it('row 13b: derivation-contested reservation (no convergent group) ⇒ NOT_EVALUABLE, never a silent PASS', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    // reservation() constructs an uncontested payload; the contested twin
    // below is what makes the identity surface incoherent.
    const contestedTwin = { ...reservation('RES-1', 2), contested: true };
    // The derivation contested RES-1; the identity surface is incoherent
    // even though the surviving payload looks convergent.
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, contestedTwin, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.contestedEvidence);
  });

  it('row 13c: contested baseline ⇒ baseline authority gone ⇒ NOT_EVALUABLE (BASELINE_MISSING), never FAIL/PASS', () => {
    const subject = resourceEvent();
    const contestedBase = { ...baseline(10), contested: true };
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [contestedBase, remaining(8), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.baselineMissing);
  });

  it('row 13d: contested remaining ⇒ authoritative −1 is NOT Case B ⇒ CONTESTED_IDENTITY', () => {
    const subject = resourceEvent();
    const contestedRem = { ...remaining(-1), contested: true };
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), contestedRem, res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.contestedEvidence);
  });

  it('row 14: conflicting remaining values for one R/scope/generation ⇒ EVIDENCE_CONFLICT', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), remaining(3), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 14b: conflicting baseline values ⇒ EVIDENCE_CONFLICT, never first/last/earliest/latest', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), baseline(12), remaining(8), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 15: Case A already proven; another consumption-role query missing ⇒ still FAIL (lower-bound-safe)', () => {
    const subject = resourceEvent();
    const r1 = reservation('RES-1', 11);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), r1, summary(1)],
        relationships: chain(subject, r1),
        queriesByRole: new Map<string, string[]>([
          ['skuBaseline', ['stockBaseline']],
          ['skuRemaining', ['stockRemaining']],
          ['reservation', ['reservationEvents', 'reservationArchive']],
        ]),
        captures: new Map([
          [
            'reservationArchive',
            { valid: false, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' },
          ],
        ]),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
  });

  it('row 16: remaining −1 from one query; another required remaining query missing ⇒ NOT_EVALUABLE (Case B never on partial surface)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), res, summary(1)],
        relationships: chain(subject, res),
        queriesByRole: new Map<string, string[]>([
          ['skuBaseline', ['stockBaseline']],
          ['skuRemaining', ['stockRemaining', 'stockRemainingMirror']],
          ['reservation', ['reservationEvents']],
        ]),
        captures: new Map([
          [
            'stockRemainingMirror',
            { valid: false, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' },
          ],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
  });

  it('row 16b (regression): Case C arithmetic mismatch with an invalid remaining-role capture ⇒ NOT_EVALUABLE, never FAIL', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(5), res, summary(1)], // 5 != 10-2 ⇒ would-be Case C
        relationships: chain(subject, res),
        captures: new Map([
          ['stockRemaining', { valid: false, captured: true, reasonCode: 'NON_2XX' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
  });

  it('row 17: remaining-role queries all valid and converged on −1 ⇒ FAIL Case B (baseline/consumption completeness not required)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({
        subject,
        entities: [remaining(-1), summary(0)],
        queriesByRole: new Map<string, string[]>([
          ['skuBaseline', ['stockBaseline']],
          ['skuRemaining', ['stockRemaining', 'stockRemainingMirror']],
          ['reservation', ['reservationEvents']],
        ]),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });

  it('row 18: baseline-role observations conflict ⇒ EVIDENCE_CONFLICT / NOT_EVALUABLE (no authority selection)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(9), baseline(10), remaining(8), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('row 19: Case C arithmetic mismatch but one consumption-role query invalid ⇒ NOT_EVALUABLE, never FAIL', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(5), res, summary(1)],
        relationships: chain(subject, res),
        captures: new Map([
          ['reservationEvents', { valid: false, captured: true, reasonCode: 'TRUNCATED_BODY' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.failureMechanism).toBeNull();
  });

  it('row 20: PASS arithmetic correct but any required query invalid ⇒ NOT_EVALUABLE, never PASS', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    for (const invalidQuery of [
      'stockBaseline',
      'stockRemaining',
      'reservationEvents',
      'acceptedReservations',
    ]) {
      const result = verdictOf(
        harness({
          subject,
          entities: [baseline(10), remaining(8), res, summary(1)],
          relationships: chain(subject, res),
          captures: new Map([
            [invalidQuery, { valid: false, captured: true, reasonCode: 'NON_2XX' }],
          ]),
        }),
      );
      expect(result.verdict, `with invalid ${invalidQuery}`).toBe('NOT_EVALUABLE');
    }
  });

  it('precedence: Case A outranks Case B — consumption 12 over baseline 10 with authoritative −5 ⇒ EXCEEDED_BASELINE', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 12);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-5), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    const details = result.details as { caseB: { negativeRemainingProven: boolean } };
    expect(details.caseB.negativeRemainingProven).toBe(true);
  });

  it('precedence: Case B outranks Case C — consumption 2 complete, remaining −1 ⇒ NEGATIVE_REMAINING', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });

  it('unattributable consumption (no active path) with 2 ≤ baseline ⇒ NOT_EVALUABLE (ATTRIBUTION_GAP), never silent PASS', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1)],
        relationships: [], // no active path subject → reservation
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });

  it('unattributed consumption that WOULD complete Case C cannot convert to Case C FAIL — gap honesty', () => {
    const subject = resourceEvent();
    const r1 = reservation('RES-1', 2);
    const r2 = reservation('RES-2', 20);
    // r2 unattributed; observedCount 1 ≠ total 2 anyway; must be a named
    // gap, and never a Case C FAIL built on the attributed subset only.
    // Attribution-gap precedence: the unattributable candidate is the
    // first honest blocker reported (rule-9 determinism).
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(5), r1, r2, summary(2)],
        relationships: chain(subject, r1),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });

  it('foreign-scope summary is skipped as unbound (§2.4): completeness unproven ⇒ ENUMERATION_COMPLETENESS_GAP, never SCOPE_INCOHERENT', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1, { generationId: 'gen-OTHER' })],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('foreign-resource summary is skipped: another SKU total never proves this SKU completeness', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1, { sku: 'SKU-OTHER' })],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.enumerationCompletenessGap);
  });

  it('convergent duplicate summaries are ONE fact (§2.4): two identical totals ⇒ evaluation proceeds (PASS)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1), summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('PASS');
    const details = result.details as { observedTotal: number };
    expect(details.observedTotal).toBe(1); // Never summed to 2.
  });

  it('conflicting summary totals (1 vs 2) ⇒ EVIDENCE_CONFLICT (row 16 analog of the atMostOne table)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1), summary(2)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
  });

  it('unaccepted reservation (status REJECTED) is never counted (exact acceptedMatch)', () => {
    const subject = resourceEvent();
    const rejected = reservation('RES-1', 30, { status: 'REJECTED' });
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), rejected, summary(0)],
        relationships: chain(subject, rejected),
      }),
    );
    // N-3 (pinned): observedCount 0 == observedTotal 0 ⇒ enumeration is
    // proven complete; the required capture set is valid; so the Case C
    // gate is fully established and 8 != 10 − 0 is exactly a proven
    // conservation mismatch. One deterministic verdict, never two.
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_MISMATCH');
    expect(result.gap).toBeNull();
  });

  it('B-2/B-3 stale-edge exclusion: invalidated relationship cannot attribute (row 10 analog via empty active graph)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(8), res, summary(1)],
        // Active graph EXCLUDES the stale edge — only the unrelated
        // receipt edge remains, so attribution cannot reach the reservation.
        relationships: [
          {
            relationshipId: nextId('rel'),
            fromEventId: subject.eventId,
            toEventId: nextId('ev-receipt'),
            relationKind: 'stocked-as',
            basis: 'identity-direct',
          },
        ],
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.attributionGap);
  });
});

// ---------------------------------------------------------------------
// B-1 repair tests — Case B direct proof vs baseline gap ordering
// (frozen normative order: fact authority first, termination last;
// ADR-0023 §8 rule 1 as amended + ADR-0018 Decision 3).
// ---------------------------------------------------------------------
describe('B-1: Case B fires without baseline; baseline gaps are recorded, never terminal before Case B', () => {
  it('A: baseline completely absent + authoritative remaining −1 + consumption absent ⇒ FAIL Case B (gap recorded in details)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({
        subject,
        entities: [remaining(-1), summary(0)],
        captures: new Map([
          ['stockBaseline', { valid: true, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
    expect(result.gap).toBeNull();
    const details = result.details as {
      baselineConflict: { code: string } | null;
      remainingEventIds: string[];
    };
    expect(details.baselineConflict).not.toBeNull();
    expect(details.baselineConflict?.code).toBe('BASELINE_MISSING');
    expect(details.remainingEventIds.length).toBeGreaterThan(0);
  });

  it('B: baseline capture INVALID + authoritative remaining −1 ⇒ Case B direct proof remains eligible (recorded conflict)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({
        subject,
        entities: [remaining(-1), summary(0)],
        captures: new Map([
          ['stockBaseline', { valid: false, captured: true, reasonCode: 'NON_2XX' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
    const details = result.details as {
      baselineConflict: { code: string } | null;
    };
    expect(details.baselineConflict).not.toBeNull();
    expect(details.baselineConflict?.code).toBe('EVIDENCE_CONFLICT');
  });

  it('C: baseline absent + remaining +5 + no independent Case A/B ⇒ NOT_EVALUABLE BASELINE_MISSING (gap terminates only now)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({
        subject,
        entities: [remaining(5), summary(0)],
        captures: new Map([
          ['stockBaseline', { valid: true, captured: false, reasonCode: 'NO_CAPTURE_PRESENT' }],
        ]),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.baselineMissing);
    expect(result.failureMechanism).toBeNull();
  });

  it('D: authoritative baseline + Case A true + remaining −1 ⇒ primary Case A (A > B, deterministic)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 12);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
  });

  it('E: baseline present + Case A false (sum ≤ baseline) + remaining −1 (Case C would also mismatch) ⇒ primary Case B (B > C)', () => {
    const subject = resourceEvent();
    const res = reservation('RES-1', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), res, summary(1)],
        relationships: chain(subject, res),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });
});

// ---------------------------------------------------------------------
// B-2 repair tests — non-negative baseline/consumption sign discipline
// (ADR-0018/ADR-0023 §8 as amended; remaining MAY be negative — Case B).
// ---------------------------------------------------------------------
describe('B-2: negative baseline/consumption units are contradictory evidence; remaining negativity stays legitimate', () => {
  it('1: baseline −1 + remaining 0 + no independent Case B ⇒ NOT_EVALUABLE EVIDENCE_CONFLICT (never an authoritative baseline)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({ subject, entities: [baseline(-1), remaining(0), summary(0)] }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
    expect(result.failureMechanism).toBeNull();
  });

  it('2: baseline −1 + authoritative remaining −1 ⇒ FAIL Case B with the baseline conflict recorded (never primary)', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({ subject, entities: [baseline(-1), remaining(-1), summary(0)] }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
    const details = result.details as {
      baselineConflict: { code: string; problem: string } | null;
    };
    expect(details.baselineConflict).not.toBeNull();
    expect(details.baselineConflict?.code).toBe('EVIDENCE_CONFLICT');
    expect(details.baselineConflict?.problem).toBe('negative-baseline-units');
  });

  it('3: baseline 10 + accepted consumption −2 + remaining 12 + complete enumeration ⇒ NOT_EVALUABLE EVIDENCE_CONFLICT — MUST NOT PASS', () => {
    const subject = resourceEvent();
    const negative = reservation('RES-NEG', -2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(12), negative, summary(1)],
        relationships: chain(subject, negative),
      }),
    );
    expect(result.verdict).toBe('NOT_EVALUABLE');
    expect(result.gap).toBe(GENERIC_EVALUATION_GAPS.evidenceConflict);
    expect(result.failureMechanism).toBeNull();
    const details = result.details as {
      negativeUnitEffects: Array<{ identity: string; units: number }>;
    };
    expect(details.negativeUnitEffects).toHaveLength(1);
    expect(details.negativeUnitEffects[0]?.units).toBe(-2);
  });

  it('4: Case A proven from valid 6+5 subset; another accepted effect carries −2 ⇒ Case A stands (conflict recorded, never undoes the lower bound)', () => {
    const subject = resourceEvent();
    const r1 = reservation('RES-1', 6);
    const r2 = reservation('RES-2', 5);
    const negative = reservation('RES-NEG', -2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(3), r1, r2, negative, summary(3)],
        relationships: [...chain(subject, r1), ...chain(subject, r2), ...chain(subject, negative)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    const details = result.details as {
      acceptedReservedUnits: number;
      consumptionNegativeUnits: Array<{ identity: string; units: number }>;
    };
    // The negative-unit effect NEVER entered the sum (11 = 6 + 5).
    expect(details.acceptedReservedUnits).toBe(11);
    expect(details.consumptionNegativeUnits).toHaveLength(1);
    expect(details.consumptionNegativeUnits[0]?.units).toBe(-2);
  });

  it('5: baseline 10 + accepted consumption −2 + authoritative remaining −1 ⇒ Case B stands (negative consumption conflict recorded)', () => {
    const subject = resourceEvent();
    const negative = reservation('RES-NEG', -2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(-1), negative, summary(1)],
        relationships: chain(subject, negative),
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
    const details = result.details as {
      consumptionNegativeUnits: Array<{ identity: string; units: number }>;
    };
    expect(details.consumptionNegativeUnits).toHaveLength(1);
  });

  it('6: remaining −1 itself remains valid Case-B evidence — never rejected merely for being negative', () => {
    const subject = resourceEvent();
    const result = verdictOf(
      harness({ subject, entities: [baseline(10), remaining(-1), summary(0)] }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });
});

// ---------------------------------------------------------------------
// N-6 repair test — minimal proof tuples keep identity+units intact
// (adversarial ordering: identities A,B,C with units 1,100,2 — an
// independent identity/unit sort would mispair the amounts).
// ---------------------------------------------------------------------
describe('N-6: Case A minimal proof effects are intact identity+units tuples (no positional mispairing)', () => {
  it('minimal running-sum subset pairs each effect with ITS OWN units; deterministic by canonical identity', () => {
    const subject = resourceEvent();
    const ra = reservation('RES-A', 1);
    const rb = reservation('RES-B', 100);
    const rc = reservation('RES-C', 2);
    const result = verdictOf(
      harness({
        subject,
        entities: [baseline(10), remaining(93), ra, rb, rc, summary(3)],
        relationships: [...chain(subject, ra), ...chain(subject, rb), ...chain(subject, rc)],
      }),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.failureMechanism).toBe('RESOURCE_CONSERVATION_EXCEEDED_BASELINE');
    const details = result.details as {
      minimalProofEffects: Array<{ effectIdentity: string; units: number; eventId: string }>;
    };
    // Canonical identity order A, B; running sum 1 → 101 > 10 stops at B.
    // A mispaired positional sort would have made A=1,B=2 (sum 3 ≤ 10)
    // and kept accumulating — the tuple shape makes that impossible.
    expect(details.minimalProofEffects).toHaveLength(2);
    expect(details.minimalProofEffects[0]?.effectIdentity).toContain('RES-A');
    expect(details.minimalProofEffects[0]?.units).toBe(1);
    expect(details.minimalProofEffects[1]?.effectIdentity).toContain('RES-B');
    expect(details.minimalProofEffects[1]?.units).toBe(100);
    expect(details.minimalProofEffects[0]?.eventId).toBe(ra.eventId);
    expect(details.minimalProofEffects[1]?.eventId).toBe(rb.eventId);
  });
});
