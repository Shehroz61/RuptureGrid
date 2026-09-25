// =====================================================================
// Unit — Phase 9 timeline derivation (docs/controlled-faults.md §6)
// =====================================================================
// Configured vs activated are SEPARATE facts and stay SEPARATE
// FAULT_PLAN_CONFIGURED / FAULT_PLAN_ACTIVATED entries. Both derive
// ONLY from the persisted demo.fault-plan-state-observed
// NormalizedEvents (sourced from the target's own fault-status
// observations); ACTIVATED requires the target's OWN trigger
// accounting (triggersUsed ≥ 1) — never error shapes, never timestamp
// adjacency. Adjacency asserts no causality; unknown event types are
// never invented into entries.

import { describe, expect, it } from 'vitest';
import { deriveTimeline, faultPlanEntryKindsFor, TIMELINE_ENTRY_KINDS } from './timeline.js';
import type { TimelineDerivationInput } from './timeline.js';
import { TIMELINE_DERIVATION_VERSION } from './versions.js';

// A locally-mutable view of the derivation input: tests assemble fixtures
// incrementally; deriveTimeline only needs the readonly contract.
type MutableTimelineInput = Omit<TimelineDerivationInput, 'events'> & {
  events: Array<TimelineDerivationInput['events'][number]>;
};

function baseInput(): MutableTimelineInput {
  return {
    run: { id: 'r-1', state: 'COMPLETED', terminalAt: null },
    steps: [],
    invocations: [],
    observations: [
      {
        contentHash: 'h-fault',
        chainIndex: 7,
        kind: 'target_observation' as const,
        adapterKind: 'demo-fintech-fault-status',
        observedAt: new Date('2026-09-21T10:05:00Z'),
        invocationIdentity: null,
        payload: {},
      },
    ],
    events: [],
    relationships: [],
    evaluations: [],
  };
}

function faultEvent(
  id: string,
  subjectKey: string,
  triggersUsed: number | null,
  inputHash: string,
): TimelineDerivationInput['events'][number] {
  return {
    id,
    eventType: 'demo.fault-plan-state-observed',
    subjectKey,
    payload: {
      faultKind: subjectKey,
      ...(triggersUsed === null ? {} : { triggersUsed }),
      maxTriggers: 1,
      sourceObservation: { kind: 'target_observation', contentHash: 'h-fault', chainIndex: 7 },
    },
    inputHash,
    createdAt: new Date('2026-09-21T10:06:00Z'),
    // createdAt is the DERIVATION instant; occurredAt must be the
    // SOURCE OBSERVATION's capture time (observedAt), not derivedAt.
  } as TimelineDerivationInput['events'][number];
}

describe('phase 9 fault-plan timeline entries (configured vs activated)', () => {
  it('derivation is versioned v2 with the split vocabulary', () => {
    expect(TIMELINE_DERIVATION_VERSION).toBe('v2');
    expect(TIMELINE_ENTRY_KINDS.faultPlanConfigured).toBe('FAULT_PLAN_CONFIGURED');
    expect(TIMELINE_ENTRY_KINDS.faultPlanActivated).toBe('FAULT_PLAN_ACTIVATED');
    // The collapsed kind must NOT exist anywhere in the vocabulary.
    expect(Object.values(TIMELINE_ENTRY_KINDS)).not.toContain('FAULT_PLAN_STATE_OBSERVED');
  });

  it('emits BOTH configured and activated for an observed trigger consumption', () => {
    const input = baseInput();
    input.events.push(faultEvent('ev-fault-1', 'PRE_MUTATION_REJECTION', 1, 'ih-1'));
    const result = deriveTimeline(input);
    const kinds = result.entries
      .filter((candidate) => candidate.sourceId === 'ev-fault-1')
      .map((candidate) => candidate.entryKind)
      .sort();
    expect(kinds).toEqual(['FAULT_PLAN_ACTIVATED', 'FAULT_PLAN_CONFIGURED']);
    for (const entry of result.entries.filter((c) => c.sourceId === 'ev-fault-1')) {
      expect(entry.sourceKind).toBe('NORMALIZED_EVENT');
      expect(entry.timeMeaning).toBe('observedAt');
      expect(entry.occurredAt.getTime()).toBe(new Date('2026-09-21T10:05:00Z').getTime());
      expect(entry.subjectKey).toBe('PRE_MUTATION_REJECTION');
      const details = entry.details as Record<string, unknown>;
      expect((details['businessIdentities'] as Record<string, unknown>)['faultKind']).toBe(
        'PRE_MUTATION_REJECTION',
      );
      expect((details['businessIdentities'] as Record<string, unknown>)['triggersUsed']).toBe(1);
    }
  });

  it('configured-but-never-triggered yields CONFIGURED ONLY (no activation invented)', () => {
    const input = baseInput();
    input.events.push(faultEvent('ev-fault-2', 'RESPONSE_TRUNCATION', 0, 'ih-2'));
    const result = deriveTimeline(input);
    const kinds = result.entries
      .filter((candidate) => candidate.sourceId === 'ev-fault-2')
      .map((candidate) => candidate.entryKind);
    expect(kinds).toEqual([TIMELINE_ENTRY_KINDS.faultPlanConfigured]);
  });

  it('a plan missing the trigger field is configured only — activation is never assumed', () => {
    const input = baseInput();
    input.events.push(faultEvent('ev-fault-3', 'CRASH_MID_PROCESSING', null, 'ih-3'));
    const result = deriveTimeline(input);
    const kinds = result.entries
      .filter((candidate) => candidate.sourceId === 'ev-fault-3')
      .map((candidate) => candidate.entryKind);
    expect(kinds).toEqual([TIMELINE_ENTRY_KINDS.faultPlanConfigured]);
  });

  it('faultPlanEntryKindsFor never derives activation from non-integer or negative counts', () => {
    expect(faultPlanEntryKindsFor({ triggersUsed: 0.5 })).toEqual([
      TIMELINE_ENTRY_KINDS.faultPlanConfigured,
    ]);
    expect(faultPlanEntryKindsFor({ triggersUsed: -1 })).toEqual([
      TIMELINE_ENTRY_KINDS.faultPlanConfigured,
    ]);
    expect(faultPlanEntryKindsFor({ triggersUsed: '1' })).toEqual([
      TIMELINE_ENTRY_KINDS.faultPlanConfigured,
    ]);
    expect(faultPlanEntryKindsFor({ triggersUsed: 3 })).toEqual([
      TIMELINE_ENTRY_KINDS.faultPlanConfigured,
      TIMELINE_ENTRY_KINDS.faultPlanActivated,
    ]);
  });

  it('never invents entries from unknown event types', () => {
    const input = baseInput();
    input.events.push({
      id: 'ev-unknown',
      eventType: 'demo.something-new',
      subjectKey: null,
      payload: {},
      inputHash: 'ih-x',
      createdAt: new Date(),
    } as TimelineDerivationInput['events'][number]);
    const result = deriveTimeline(input);
    expect(result.entries.find((candidate) => candidate.sourceId === 'ev-unknown')).toBeUndefined();
  });
});
