// =====================================================================
// RuptureGrid v1.1 Phase 17 — runScope freezing into RunSnapshot (unit)
// =====================================================================
// Proves (ADR-0026 §3/§10): the declared runScope intent freezes into
// `target.runScopeBinding`, participates deterministically in
// `snapshotContentHash`, carries NO observed generation / run id / wall
// clock, and legacy documents (no runScope) keep their exact v1.0 shape.

import { describe, expect, it } from 'vitest';
import { ExperimentValidationError } from './types.js';
import { buildSnapshotDocument } from './snapshot.js';
import { validateExperimentDocument } from './validate.js';

const MANIFEST = {
  manifestVersion: 'target-manifest/v1',
  displayName: 'Run-Scope Fixture',
  environment: 'LOCAL_DEVELOPMENT',
  origins: ['http://127.0.0.1:9444'],
  credentialRefs: [],
  contract: { kind: 'GENERIC_HTTP' },
  inspection: [
    {
      queryId: 'checkoutIntents',
      roleId: 'checkoutIntent',
      description: 'Intents',
      path: '/inspection/checkout-intents',
      fields: {
        checkoutIntentId: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'integer-minor-units',
      },
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'Orders',
      path: '/inspection/orders',
      fields: {
        orderId: 'string',
        checkoutIntentId: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'integer-minor-units',
      },
      identityFields: ['orderId'],
    },
    {
      queryId: 'ordersSummary',
      roleId: 'ordersSummary',
      description: 'Per-intent totals',
      path: '/inspection/orders-summary',
      fields: {
        checkoutIntentId: 'string',
        acceptedOrderTotal: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'integer-minor-units',
      },
      identityFields: ['checkoutIntentId'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'checkoutIntent',
        description: 'd',
        fields: {
          checkoutIntentId: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'integer-minor-units',
        },
      },
      {
        roleId: 'order',
        description: 'd',
        fields: {
          orderId: 'string',
          checkoutIntentId: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'integer-minor-units',
        },
      },
      {
        roleId: 'ordersSummary',
        description: 'd',
        fields: {
          checkoutIntentId: 'string',
          acceptedOrderTotal: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'integer-minor-units',
        },
      },
    ],
    causalEdges: [],
    effectRoleIds: ['order'],
    subjectRoleId: 'checkoutIntent',
  },
  sensitiveFields: [],
} as const;

const BINDING = {
  key: 'INV-CHK-1',
  kind: 'atMostOneAcceptedEffect',
  registryVersion: 'business-invariant/v1',
  params: {
    subjectRole: 'checkoutIntent',
    subjectIdentityField: 'checkoutIntentId',
    effectRole: 'order',
    effectIdentityField: 'orderId',
    acceptedMatch: { field: 'status', value: 'ACCEPTED' },
    equivalenceFields: ['checkoutIntentId'],
    maxAcceptedEffects: 1,
    completenessProof: {
      kind: 'observed-total',
      queryId: 'ordersSummary',
      subjectField: 'checkoutIntentId',
      totalField: 'acceptedOrderTotal',
    },
    scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
  },
} as const;

const RUN_SCOPE = {
  version: 'run-scope/v1',
  setupStep: 'establish-scenario',
  declaredScope: 'checkout-zero',
  // The anchor field name is the real, READABLE surface field (a
  // `*token*`-named field is redacted to the marker before persistence and
  // can never anchor a run — rejected at declaration validation).
  scopeField: 'verificationScopeId',
  generationField: 'generationId',
  subjects: { 'INV-CHK-1': ['CHK-001'] },
} as const;

const STEPS = [
  {
    name: 'establish-scenario',
    action: {
      method: 'POST',
      relativePath: '/demo/admin/scenario',
      mutation: 'MUTATING',
      contract: 'GENERIC_HTTP',
      repeat: 1,
      concurrency: 1,
      retryPolicy: 'NONE',
    },
  },
];

const revisionWith = (extra: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000001',
  revisionNumber: 1,
  stepsJson: { steps: STEPS, invariantBindings: [BINDING], ...extra },
});

const DEFINITION = { id: '00000000-0000-4000-8000-000000000003', name: 'exp' };
const TARGET = {
  id: '00000000-0000-4000-8000-000000000002',
  displayName: 'Run-Scope Fixture',
  environment: 'LOCAL_DEVELOPMENT',
  contractKind: 'GENERIC_HTTP',
  credentialRefs: [] as string[],
  origins: [{ origin: 'http://127.0.0.1:9444' }],
  manifestJson: MANIFEST,
};

const build = (extra: Record<string, unknown>) =>
  buildSnapshotDocument({ revision: revisionWith(extra), definition: DEFINITION, target: TARGET });

describe('Phase 17: runScope freezing (ADR-0026 §3/§10)', () => {
  it('freezes the validated runScope declaration into target.runScopeBinding', () => {
    const { document } = build({ runScope: RUN_SCOPE });
    expect(document.target.runScopeBinding).toEqual({
      version: 'run-scope/v1',
      setupStep: 'establish-scenario',
      declaredScope: 'checkout-zero',
      // The anchor field name is the real, READABLE surface field (a
      // `*token*`-named field is redacted to the marker before persistence and
      // can never anchor a run — rejected at declaration validation).
      scopeField: 'verificationScopeId',
      generationField: 'generationId',
      subjects: { 'INV-CHK-1': ['CHK-001'] },
    });
  });

  it('legacy documents (no runScope) freeze NO binding and keep the v1.0 shape', () => {
    const { document } = build({});
    expect('runScopeBinding' in document.target).toBe(false);
  });

  it('identical intent ⇒ identical snapshot hash (deterministic)', () => {
    expect(build({ runScope: RUN_SCOPE }).hash).toBe(build({ runScope: RUN_SCOPE }).hash);
  });

  it('the frozen binding participates in snapshotContentHash', () => {
    const withoutScope = build({}).hash;
    const withScope = build({ runScope: RUN_SCOPE }).hash;
    expect(withScope).not.toBe(withoutScope);
    const changedScope = build({ runScope: { ...RUN_SCOPE, declaredScope: 'other-scope' } }).hash;
    expect(changedScope).not.toBe(withScope);
    const changedSubjects = build({
      runScope: { ...RUN_SCOPE, subjects: { 'INV-CHK-1': ['CHK-999'] } },
    }).hash;
    expect(changedSubjects).not.toBe(withScope);
  });

  it('the frozen binding carries intent only — no observed generation, run id, or clock', () => {
    const { document, canonical } = build({ runScope: RUN_SCOPE });
    const serialized = JSON.stringify(document.target.runScopeBinding);
    expect(serialized).not.toMatch(/observed|generationId"\s*:\s*\d|runId|createdAt|Timestamp/i);
    void canonical;
  });

  it('rejects runScope without generic invariantBindings (no dead config)', () => {
    const target = {
      id: TARGET.id,
      displayName: TARGET.displayName,
      environment: TARGET.environment,
      contractKind: TARGET.contractKind,
      credentialRefs: [],
      origins: TARGET.origins,
      manifestJson: MANIFEST,
    };
    expect(() =>
      validateExperimentDocument({
        document: { steps: STEPS, runScope: RUN_SCOPE },
        target: target as never,
      }),
    ).toThrow(ExperimentValidationError);
    expect(() =>
      validateExperimentDocument({
        document: { steps: STEPS, runScope: RUN_SCOPE },
        target: target as never,
      }),
    ).toThrow(/invariantBindings/);
  });

  it('rejects an invalid runScope at definition time with a named issue', () => {
    const target = {
      id: TARGET.id,
      displayName: TARGET.displayName,
      environment: TARGET.environment,
      contractKind: TARGET.contractKind,
      credentialRefs: [],
      origins: TARGET.origins,
      manifestJson: MANIFEST,
    };
    expect(() =>
      validateExperimentDocument({
        document: {
          steps: STEPS,
          invariantBindings: [BINDING],
          runScope: { ...RUN_SCOPE, version: 'run-scope/v2' },
        },
        target: target as never,
      }),
    ).toThrow(/RUN_SCOPE_UNKNOWN_VERSION/);
  });
});
