// =====================================================================
// Unit — reproduction definitions (reproduction.ts)
// =====================================================================
// The definition is derived from the run's FROZEN snapshot + its own
// verdicts (incident-replay §1): mode requirement from the snapshot's
// own mode-step body, credential REFERENCES only (ADR-0012), invariant
// bindings + acceptance expectations from persisted verdicts. Nothing
// is guessed; unknown shapes are honestly absent.

import { describe, expect, it } from 'vitest';
import { deriveReproductionDefinition, extractTargetModeRequirement } from './index.js';

function snapshotDocument(mode: 'VULNERABLE' | 'SECURE' | null): unknown {
  return {
    engineVersion: 'v1',
    target: {
      targetId: 'target-1',
      environment: 'LOCAL_DEVELOPMENT',
      origin: 'http://127.0.0.1:3000',
      credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'],
    },
    steps: [
      {
        name: 'reset',
        action: { method: 'POST', relativePath: '/demo/admin/reset', mutation: 'MUTATING' },
      },
      ...(mode === null
        ? []
        : [
            {
              name: 'mode',
              action: {
                method: 'PUT',
                relativePath: '/demo/admin/mode',
                body: JSON.stringify({ mode }),
                mutation: 'MUTATING',
              },
            },
          ]),
    ],
  };
}

const EVALUATIONS = [{ invariantKey: 'INV-IZ-1', evaluatorVersion: 'v1', verdict: 'FAIL' }];

describe('reproduction — target mode requirement (incident-replay §1.2)', () => {
  it('extracts the mode from the snapshot mode-step body', () => {
    expect(extractTargetModeRequirement(snapshotDocument('VULNERABLE'))).toBe('VULNERABLE');
    expect(extractTargetModeRequirement(snapshotDocument('SECURE'))).toBe('SECURE');
  });

  it('is honestly absent when no mode step exists or the shape is unknown', () => {
    expect(extractTargetModeRequirement(snapshotDocument(null))).toBeNull();
    expect(extractTargetModeRequirement(null)).toBeNull();
    expect(extractTargetModeRequirement({ steps: 'nope' })).toBeNull();
  });
});

describe('reproduction — derivation content', () => {
  it('binds run to snapshot with credential REFERENCES only', () => {
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: {
        id: 'snap-1',
        contentHash: 'h'.repeat(64),
        document: snapshotDocument('VULNERABLE'),
      },
      evaluations: EVALUATIONS,
    });
    expect(derived.snapshotId).toBe('snap-1');
    expect(derived.snapshotContentHash).toBe('h'.repeat(64));
    expect(derived.targetModeRequirement).toBe('VULNERABLE');
    expect(derived.credentialRefs).toEqual(['DEMO_ADMIN_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET']);
    for (const ref of derived.credentialRefs) {
      expect(ref.startsWith('${')).toBe(false);
      expect(ref.includes('sk-')).toBe(false);
    }
  });

  it('carries invariant bindings and the run-own acceptance expectations', () => {
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: {
        id: 'snap-1',
        contentHash: 'h'.repeat(64),
        document: snapshotDocument('VULNERABLE'),
      },
      evaluations: EVALUATIONS,
    });
    const bindings = derived.invariantBindings['invariants'] as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ invariantKey: 'INV-IZ-1', evaluatorVersion: 'v1' });
    const expectations = derived.acceptanceExpectations['expectations'] as Array<
      Record<string, unknown>
    >;
    expect(expectations[0]).toMatchObject({
      invariantKey: 'INV-IZ-1',
      expectedVerdicts: ['FAIL'],
    });
  });

  it('is deterministic: identical inputs, identical output', () => {
    const input = {
      runId: 'run-1',
      snapshot: { id: 'snap-1', contentHash: 'h'.repeat(64), document: snapshotDocument('SECURE') },
      evaluations: [...EVALUATIONS].reverse(),
    };
    const a = deriveReproductionDefinition(input);
    const b = deriveReproductionDefinition(input);
    expect(a).toEqual(b);
  });

  it('an evaluation for an undocumented invariant gets no invented metadata', () => {
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: { id: 'snap-1', contentHash: 'h'.repeat(64), document: snapshotDocument('SECURE') },
      evaluations: [{ invariantKey: 'INV-UNKNOWN', evaluatorVersion: 'v9', verdict: 'PASS' }],
    });
    const bindings = derived.invariantBindings['invariants'] as Array<Record<string, unknown>>;
    expect(bindings[0]).toMatchObject({ title: null, description: null });
  });

  it('a snapshot without fault plans carries a null fault intent (honestly absent)', () => {
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: { id: 'snap-1', contentHash: 'h'.repeat(64), document: snapshotDocument('SECURE') },
      evaluations: EVALUATIONS,
    });
    expect(derived.faultIntent).toBeNull();
  });

  it('freezes the controlled-fault intent with typed fields and credential REFERENCES only', () => {
    const document = {
      steps: [
        {
          name: 'deliver-with-fault',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
            faultPlan: {
              planVersion: 'controlled-fault/v1',
              faultKind: 'PRE_MUTATION_REJECTION',
              activation: 'first_n_matching_deliveries',
              maxTriggers: 1,
            },
          },
        },
      ],
    };
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: { id: 'snap-1', contentHash: 'h'.repeat(64), document },
      evaluations: [],
    });
    expect(derived.faultIntent).not.toBeNull();
    const steps = derived.faultIntent?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      stepName: 'deliver-with-fault',
      planVersion: 'controlled-fault/v1',
      faultKind: 'PRE_MUTATION_REJECTION',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
      waveStaggerMs: null,
      credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
    });
    // Credential REFERENCE NAMES only — never values (ADR-0012/R-13).
    const serialized = JSON.stringify(derived.faultIntent);
    expect(serialized?.includes('sk-')).toBe(false);
    expect(serialized?.includes('Bearer ')).toBe(false);
  });

  it('freezes the wave stagger alongside the plan when declared', () => {
    const document = {
      steps: [
        {
          name: 'staggered-fault',
          action: {
            method: 'POST',
            relativePath: '/webhooks/provider',
            mutation: 'MUTATING',
            contract: 'DEMO_FINTECH_WEBHOOK',
            faultPlan: {
              planVersion: 'controlled-fault/v1',
              faultKind: 'CRASH_MID_PROCESSING',
              activation: 'first_n_matching_deliveries',
              maxTriggers: 2,
            },
            waveStaggerMs: 250,
          },
        },
      ],
    };
    const derived = deriveReproductionDefinition({
      runId: 'run-1',
      snapshot: { id: 'snap-1', contentHash: 'h'.repeat(64), document },
      evaluations: [],
    });
    expect(derived.faultIntent?.steps[0]).toMatchObject({
      faultKind: 'CRASH_MID_PROCESSING',
      maxTriggers: 2,
      waveStaggerMs: 250,
    });
  });
});
