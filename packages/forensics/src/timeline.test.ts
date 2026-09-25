// =====================================================================
// Unit — forensic timeline derivation (timeline.ts)
// =====================================================================
// Ordering must be time-primary with deterministic tie-breakers (§22);
// time semantics must stay distinct (§21); logical vs physical actions
// stay distinct (§24); events from one target-state capture are an
// unordered_overlap sibling group (evidence-model §9); causal claims
// come only from relationships (§23).

import { describe, expect, it } from 'vitest';
import {
  deriveTimeline,
  findingTimelineEntry,
  compareTimelineEntries,
  timelineInputFingerprint,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_ORDERING_BASES,
  TIMELINE_SOURCE_KINDS,
} from './index.js';
import type { TimelineDerivationInput, TimelineEntrySpec } from './index.js';

const RUN_ID = '0f0e0d0c-0000-4000-8000-00000000abcd';

function baseInput(overrides: Partial<TimelineDerivationInput> = {}): TimelineDerivationInput {
  return {
    run: { id: RUN_ID, state: 'COMPLETED', terminalAt: new Date(1000) },
    steps: [
      {
        id: 'step-1',
        sequence: 0,
        name: 'reset',
        state: 'SUCCEEDED',
        intentOutcome: 'SUCCEEDED',
        sideEffectKnowledge: 'NOT_APPLICABLE',
        terminalAt: new Date(1500),
      },
    ],
    invocations: [
      {
        id: 'inv-1',
        stepRunId: 'step-1',
        sequence: 0,
        invocationIdentity: 'inv-identity-1',
        outcome: 'SUCCEEDED',
        sideEffectKnowledge: 'KNOWN_OCCURRED',
        httpStatus: 200,
        createdAt: new Date(1200),
        finishedAt: new Date(1300),
      },
      {
        id: 'inv-2',
        stepRunId: 'step-1',
        sequence: 1,
        invocationIdentity: 'inv-identity-2',
        outcome: 'FAILED',
        sideEffectKnowledge: 'INDETERMINATE',
        httpStatus: null,
        createdAt: new Date(1400),
        finishedAt: null,
      },
    ],
    observations: [
      {
        contentHash: 'obs-hash-1',
        chainIndex: 0,
        kind: 'invocation',
        adapterKind: null,
        observedAt: new Date(1305),
        invocationIdentity: 'inv-identity-1',
        payload: {
          http: { method: 'POST', relativePath: '/webhooks/provider', responseStatus: 200 },
        },
      },
      {
        contentHash: 'obs-hash-2',
        chainIndex: 7,
        kind: 'target_observation',
        adapterKind: 'demo-fintech-payment-lineage',
        observedAt: new Date(5000),
        invocationIdentity: null,
        payload: { payment: { providerPaymentId: 'pay_1' } },
      },
    ],
    events: [
      {
        id: 'evt-payment',
        eventType: 'demo.provider-payment-observed',
        subjectKey: 'pay_1',
        payload: {
          providerPaymentId: 'pay_1',
          sourceObservation: {
            kind: 'target_observation',
            contentHash: 'obs-hash-2',
            chainIndex: 7,
          },
        },
        createdAt: new Date(5100),
      },
      {
        id: 'evt-effect-1',
        eventType: 'demo.financial-effect-observed',
        subjectKey: 'pay_1',
        payload: {
          financialEffectId: 'fx_1',
          amountMinor: 500000,
          sourceObservation: {
            kind: 'target_observation',
            contentHash: 'obs-hash-2',
            chainIndex: 7,
          },
        },
        createdAt: new Date(5101),
      },
      {
        id: 'evt-effect-2',
        eventType: 'demo.financial-effect-observed',
        subjectKey: 'pay_1',
        payload: {
          financialEffectId: 'fx_2',
          amountMinor: 500000,
          sourceObservation: {
            kind: 'target_observation',
            contentHash: 'obs-hash-2',
            chainIndex: 7,
          },
        },
        createdAt: new Date(5102),
      },
      {
        id: 'evt-delivery',
        eventType: 'demo.payment-delivery-observed',
        subjectKey: 'pay_1',
        payload: {
          providerPaymentId: 'pay_1',
          sourceObservation: { kind: 'invocation', contentHash: 'obs-hash-1', chainIndex: 0 },
        },
        createdAt: new Date(1306),
      },
    ],
    relationships: [
      {
        id: 'rel-1',
        fromEventId: 'evt-delivery',
        toEventId: 'evt-effect-1',
        relationKind: 'produced-effect',
        basis: 'identity-direct',
      },
    ],
    evaluations: [
      {
        id: 'eval-1',
        invariantKey: 'INV-IZ-1',
        evaluatorVersion: 'v1',
        subjectKey: 'pay_1',
        verdict: 'FAIL',
        createdAt: new Date(6000),
      },
    ],
    ...overrides,
  };
}

function kindsOf(entries: readonly TimelineEntrySpec[]): string[] {
  return entries.map((entry) => entry.entryKind);
}

describe('timeline derivation — taxonomy and source citations (§20/§47)', () => {
  it('emits run/step/invocation/http/target-state/event/evaluation entries with typed sources', () => {
    const result = deriveTimeline(baseInput());
    const kinds = kindsOf(result.entries);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.runTerminalState);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.stepTerminalState);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.invocationExecuted);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.httpRequestObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.httpResponseObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.executorErrorObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.targetStateObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.providerPaymentObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.financialEffectObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.paymentDeliveryObserved);
    expect(kinds).toContain(TIMELINE_ENTRY_KINDS.invariantEvaluated);
    for (const entry of result.entries) {
      expect(Object.values(TIMELINE_SOURCE_KINDS)).toContain(entry.sourceKind);
      expect(entry.sourceId.length).toBeGreaterThan(0);
    }
    expect(result.causalClaimCount).toBe(1);
  });

  it('marks the INDETERMINATE invocation as a first-class executor-error entry (§9)', () => {
    const result = deriveTimeline(baseInput());
    const errorEntry = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.executorErrorObserved,
    );
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.details).toMatchObject({
      outcome: 'FAILED',
      sideEffectKnowledge: 'INDETERMINATE',
    });
  });
});

describe('timeline derivation — time semantics (§21)', () => {
  it('events carry their source observation capture time with observedAt meaning', () => {
    const result = deriveTimeline(baseInput());
    const payment = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.providerPaymentObserved,
    );
    expect(payment?.occurredAt.getTime()).toBe(5000); // the observation's observedAt
    expect(payment?.timeMeaning).toBe('observedAt');
  });

  it('invocations carry execution time; evaluations carry derivedAt', () => {
    const result = deriveTimeline(baseInput());
    const invocation = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.invocationExecuted,
    );
    expect(invocation?.timeMeaning).toBe('execution');
    expect(invocation?.occurredAt.getTime()).toBe(1300);
    const evaluation = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.invariantEvaluated,
    );
    expect(evaluation?.timeMeaning).toBe('derivedAt');
  });

  it('falls back to derivedAt when the source observation is unknown to this run', () => {
    const input = baseInput();
    (input.events[0] as { payload: Record<string, unknown> }).payload = { providerPaymentId: 'p' };
    const result = deriveTimeline(input);
    const payment = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.providerPaymentObserved,
    );
    expect(payment?.timeMeaning).toBe('derivedAt');
    expect(payment?.occurredAt.getTime()).toBe(5100);
  });
});

describe('timeline derivation — logical vs physical (§24/§25)', () => {
  it('two equivalent effects stay two distinct entries (never flattened)', () => {
    const result = deriveTimeline(baseInput());
    const effects = result.entries.filter(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.financialEffectObserved,
    );
    expect(effects).toHaveLength(2);
    expect(new Set(effects.map((entry) => entry.sourceId)).size).toBe(2);
  });
});

describe('timeline derivation — unordered overlap siblings (evidence-model §9)', () => {
  it('events from one target-state capture are unordered_overlap', () => {
    const result = deriveTimeline(baseInput());
    const fromCapture = result.entries.filter(
      (entry) =>
        entry.sourceKind === TIMELINE_SOURCE_KINDS.normalizedEvent && entry.sequenceNumber === 7,
    );
    expect(fromCapture.length).toBeGreaterThanOrEqual(3);
    for (const entry of fromCapture) {
      expect(entry.orderingBasis).toBe(TIMELINE_ORDERING_BASES.unorderedOverlap);
    }
  });

  it('an invocation-derived event keeps wall_clock (single sibling)', () => {
    const result = deriveTimeline(baseInput());
    const delivery = result.entries.find(
      (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.paymentDeliveryObserved,
    );
    expect(delivery?.orderingBasis).toBe(TIMELINE_ORDERING_BASES.wallClock);
  });
});

describe('timeline ordering — time-primary with deterministic ties (§22)', () => {
  it('sorts primarily by time, then basis, source kind, source id, entry kind', () => {
    const result = deriveTimeline(baseInput());
    const ordered = [...result.entries].sort(compareTimelineEntries);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous === undefined || current === undefined) {
        throw new Error('ordered entry unexpectedly missing');
      }
      const keyPair = (entry: TimelineEntrySpec): string =>
        [
          entry.occurredAt.getTime(),
          entry.orderingBasis,
          entry.sourceKind,
          entry.sourceId,
          entry.entryKind,
        ].join('|');
      expect(keyPair(current) >= keyPair(previous)).toBe(true);
    }
  });

  it('is insertion-order independent for tied timestamps', () => {
    const tied = (id: string, kind: string): TimelineEntrySpec => ({
      entryKind: kind,
      sourceKind: TIMELINE_SOURCE_KINDS.normalizedEvent,
      sourceId: id,
      orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
      sequenceNumber: 0,
      occurredAt: new Date(1000),
      timeMeaning: 'observedAt',
      subjectKey: null,
      details: {},
    });
    const forward = [tied('a', 'A'), tied('b', 'B'), tied('c', 'C')].sort(compareTimelineEntries);
    const backward = [tied('c', 'C'), tied('b', 'B'), tied('a', 'A')].sort(compareTimelineEntries);
    expect(forward.map((entry) => entry.sourceId)).toEqual(backward.map((entry) => entry.sourceId));
  });

  it('two entries with identical identity are equal (idempotent derivation)', () => {
    const a = findingTimelineEntry({
      findingId: 'f1',
      runId: RUN_ID,
      subjectKey: 'pay_1',
      reasonCode: 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
      invariantKey: 'INV-IZ-1',
      createdAt: new Date(42),
    });
    const b = findingTimelineEntry({
      findingId: 'f1',
      runId: RUN_ID,
      subjectKey: 'pay_1',
      reasonCode: 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
      invariantKey: 'INV-IZ-1',
      createdAt: new Date(42),
    });
    expect(compareTimelineEntries(a, b)).toBe(0);
  });
});

describe('timeline fingerprint (§33)', () => {
  it('is stable across identical inputs and changes when inputs change', () => {
    const a = timelineInputFingerprint(baseInput());
    const b = timelineInputFingerprint(baseInput());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const changed = baseInput();
    (changed.events[0] as { id: string }).id = 'evt-other';
    expect(timelineInputFingerprint(changed)).not.toBe(a);
  });
});
