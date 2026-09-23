// =====================================================================
// Unit — Phase 9 controlled-fault plan validation (the server-side
// security gate, R-14) + deterministic wave stagger
// =====================================================================
// Every rejection here is a fault-safety escape the engine must never
// perform: faults on production/staging targets, faults outside the
// registered delivery path, unbounded budgets, probabilistic
// activation, or free-form plan fields. This matrix is permanent
// (docs/controlled-faults.md §3, ADR-0014).

import { describe, expect, it } from 'vitest';
import { validateExperimentDocument, ExperimentValidationError } from './validate.js';
import { CONTROLLED_FAULT_PLAN_VERSION } from '@rupturegrid/shared';

const LOCAL_TARGET = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'demo-target',
  contractKind: 'DEMO_FINTECH_WEBHOOK',
  environment: 'LOCAL_DEVELOPMENT' as const,
  credentialRefs: ['DEMO_INSPECTION_TOKEN'],
  origins: [{ origin: 'http://127.0.0.1:45001' }],
};

function documentWithAction(action: Record<string, unknown>): unknown {
  return {
    steps: [
      {
        name: 'deliver-payment',
        action,
      },
    ],
  };
}

const MUTATING_ACTION_BASE = {
  method: 'POST',
  relativePath: '/webhooks/provider',
  mutation: 'MUTATING',
  contract: 'DEMO_FINTECH_WEBHOOK',
  headers: {
    'x-rupturegrid-delivery-attempt-id': 'DA-${deliveryAttemptId}',
  },
  body: JSON.stringify({ providerEventId: 'PE-1', providerPaymentId: 'PP-1' }),
};

function validFaultPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planVersion: CONTROLLED_FAULT_PLAN_VERSION,
    faultKind: 'PRE_MUTATION_REJECTION',
    activation: 'first_n_matching_deliveries',
    maxTriggers: 1,
    ...overrides,
  };
}

describe('phase 9 fault-plan validation gate', () => {
  it('accepts a valid fault plan on a LOCAL_DEVELOPMENT target delivery path', () => {
    const document = validateExperimentDocument({
      document: documentWithAction({ ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() }),
      target: LOCAL_TARGET,
    });
    expect(document.steps[0]?.action.faultPlan).toEqual({
      planVersion: CONTROLLED_FAULT_PLAN_VERSION,
      faultKind: 'PRE_MUTATION_REJECTION',
      activation: 'first_n_matching_deliveries',
      maxTriggers: 1,
    });
  });

  it('rejects a fault plan on a PRODUCTION target (R-14: server-side denial)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({ ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() }),
        target: { ...LOCAL_TARGET, environment: 'PRODUCTION' as const },
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects a fault plan on a STAGING target', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({ ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() }),
        target: { ...LOCAL_TARGET, environment: 'STAGING' as const },
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects a fault plan on a non-delivery path (no arbitrary fault targeting)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          relativePath: '/demo/admin/reset',
          faultPlan: validFaultPlan(),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects a fault plan on a non-mutating action', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          mutation: 'READ_ONLY',
          method: 'GET',
          faultPlan: validFaultPlan(),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects an unsupported plan version (older target never accepts a newer plan)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          faultPlan: validFaultPlan({ planVersion: 'controlled-fault/v2' }),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects unknown fault kinds (closed vocabulary, no free-form semantics)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          faultPlan: validFaultPlan({ faultKind: 'DROP_ALL_PACKETS' }),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects unsupported activation forms (determinism: no probability)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          faultPlan: validFaultPlan({ activation: 'random_percent_50' }),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects budgets above the blast-radius cap', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          faultPlan: validFaultPlan({ maxTriggers: 11 }),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects zero and non-integer budgets', () => {
    for (const maxTriggers of [0, -1, 1.5]) {
      expect(() =>
        validateExperimentDocument({
          document: documentWithAction({
            ...MUTATING_ACTION_BASE,
            faultPlan: validFaultPlan({ maxTriggers }),
          }),
          target: LOCAL_TARGET,
        }),
      ).toThrow(ExperimentValidationError);
    }
  });

  it('rejects a fault plan whose contract does not match the target', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({
          ...MUTATING_ACTION_BASE,
          contract: 'SOME_OTHER_CONTRACT',
          faultPlan: validFaultPlan(),
        }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects one faultKind declared on two steps of one document (docs/controlled-faults.md §2)', () => {
    const twoFaultSteps = {
      steps: [
        { name: 'deliver-a', action: { ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() } },
        {
          name: 'deliver-b',
          action: { ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() },
        },
      ],
    };
    expect(() =>
      validateExperimentDocument({ document: twoFaultSteps, target: LOCAL_TARGET }),
    ).toThrow(/duplicates faultKind/);
    // A DIFFERENT kind on a second step stays valid: the rule is per
    // faultKind, not one fault-bearing step per document.
    const twoDistinctKinds = {
      steps: [
        { name: 'deliver-a', action: { ...MUTATING_ACTION_BASE, faultPlan: validFaultPlan() } },
        {
          name: 'deliver-b',
          action: {
            ...MUTATING_ACTION_BASE,
            faultPlan: validFaultPlan({ faultKind: 'CRASH_MID_PROCESSING' }),
          },
        },
      ],
    };
    expect(() =>
      validateExperimentDocument({ document: twoDistinctKinds, target: LOCAL_TARGET }),
    ).not.toThrow();
  });
});

describe('phase 9 wave stagger validation', () => {
  it('accepts a bounded stagger with repeat >= 2', () => {
    const document = validateExperimentDocument({
      document: documentWithAction({ ...MUTATING_ACTION_BASE, repeat: 3, waveStaggerMs: 250 }),
      target: LOCAL_TARGET,
    });
    expect(document.steps[0]?.action.waveStaggerMs).toBe(250);
  });

  it('rejects a stagger without repeat >= 2 (no later wave to stagger)', () => {
    expect(() =>
      validateExperimentDocument({
        document: documentWithAction({ ...MUTATING_ACTION_BASE, waveStaggerMs: 250 }),
        target: LOCAL_TARGET,
      }),
    ).toThrow(ExperimentValidationError);
  });

  it('rejects negative and non-integer staggers', () => {
    for (const waveStaggerMs of [-1, 2.5]) {
      expect(() =>
        validateExperimentDocument({
          document: documentWithAction({
            ...MUTATING_ACTION_BASE,
            repeat: 2,
            waveStaggerMs,
          }),
          target: LOCAL_TARGET,
        }),
      ).toThrow(ExperimentValidationError);
    }
  });
});
