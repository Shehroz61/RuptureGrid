// =====================================================================
// RuptureGrid v1.1 Phase 14 — frozen ManifestEvidencePolicy (unit)
// =====================================================================
// Proves: a manifest-declaring target freezes the ADDITIVE evidence
// policy (inspection declarations, identity model, sensitiveFields);
// the Phase 13 execution policy is untouched; legacy manifest-less
// snapshots carry NO evidence block (byte-identical v1.0 shape);
// corruption fails closed; no credential values in the policy; the
// frozen document is the only manifest data a run's analysis can use.

import { describe, expect, it } from 'vitest';
import { deriveEvidencePolicy, validateTargetManifest } from './manifest.js';
import { buildSnapshotDocument } from './snapshot.js';

const MANIFEST = {
  manifestVersion: 'target-manifest/v1',
  displayName: 'Foreign Commerce Fixture',
  environment: 'LOCAL_DEVELOPMENT',
  origins: ['http://127.0.0.1:9443'],
  credentialRefs: [],
  contract: { kind: 'GENERIC_HTTP' },
  inspection: [
    {
      queryId: 'accounts',
      roleId: 'account',
      description: 'Accounts',
      path: '/inspection/accounts',
      fields: { accountId: 'string', label: 'string' },
      identityFields: ['accountId'],
    },
    {
      queryId: 'operations',
      roleId: 'operation',
      description: 'Operations',
      path: '/inspection/operations',
      fields: { operationId: 'string', accountId: 'string' },
      identityFields: ['operationId'],
    },
  ],
  identityModel: {
    nodes: [
      { roleId: 'account', description: 'd', fields: { accountId: 'string' } },
      {
        roleId: 'operation',
        description: 'd',
        fields: { operationId: 'string', accountId: 'string' },
      },
    ],
    causalEdges: [
      {
        fromRoleId: 'account',
        toRoleId: 'operation',
        edgeKind: 'logged',
        linkFields: ['accountId'],
      },
    ],
    effectRoleIds: ['operation'],
  },
  sensitiveFields: ['customer.email'],
} as const;

const REVISION = {
  id: '00000000-0000-4000-8000-000000000001',
  revisionNumber: 1,
  stepsJson: {
    steps: [
      {
        name: 'probe',
        action: {
          method: 'GET',
          relativePath: '/accept',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
    ],
  },
};

const TARGET_BASE = {
  id: '00000000-0000-4000-8000-000000000002',
  displayName: 'Foreign Commerce Fixture',
  environment: 'LOCAL_DEVELOPMENT',
  contractKind: 'GENERIC_HTTP',
  credentialRefs: [] as string[],
  origins: [{ origin: 'http://127.0.0.1:9443' }],
};

describe('Phase 14: deriveEvidencePolicy', () => {
  it('freezes inspection declarations, identity model, and sensitiveFields', () => {
    const policy = deriveEvidencePolicy(MANIFEST);
    expect(policy).toBeDefined();
    expect(policy?.manifestVersion).toBe('target-manifest/v1');
    expect(policy?.inspection).toHaveLength(2);
    expect(policy?.inspection[0]).toMatchObject({
      queryId: 'accounts',
      roleId: 'account',
      path: '/inspection/accounts',
    });
    expect(policy?.identityModel.causalEdges[0]?.edgeKind).toBe('logged');
    expect(policy?.sensitiveFields).toEqual(['customer.email']);
  });

  it('copies (never references) the manifest structures', () => {
    const policy = deriveEvidencePolicy(MANIFEST);
    const manifest = validateTargetManifest(MANIFEST);
    expect(policy?.inspection[0]?.fields).not.toBe(manifest.inspection[0]?.fields);
    expect(policy?.identityModel.causalEdges[0]?.linkFields).not.toBe(
      manifest.identityModel.causalEdges[0]?.linkFields,
    );
  });

  it('returns undefined for a legacy manifest-less registration', () => {
    expect(deriveEvidencePolicy(null)).toBeUndefined();
    expect(deriveEvidencePolicy(undefined)).toBeUndefined();
  });

  it('fails closed on a manifest that no longer validates', () => {
    const corrupt = {
      ...MANIFEST,
      inspection: [{ ...MANIFEST.inspection[0], roleId: 'ghost-role' }],
    };
    expect(() => deriveEvidencePolicy(corrupt)).toThrow();
  });
});

describe('Phase 14: snapshot freezing of the evidence policy', () => {
  it('freezes manifestEvidencePolicy alongside the Phase 13 manifestPolicy', () => {
    const { document } = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: MANIFEST },
    });
    const policy = document.target.manifestEvidencePolicy;
    expect(policy).toBeDefined();
    expect(policy?.inspection.map((query) => query.queryId)).toEqual(['accounts', 'operations']);
    expect(document.target.manifestPolicy).toBeDefined();
    // Credential VALUES can never be present; reference names only,
    // and Phase 14 generic inspection freezes no credential surface.
    expect(JSON.stringify(document.target.manifestEvidencePolicy)).not.toMatch(
      /secret|token|password/i,
    );
  });

  it('legacy manifest-less snapshots carry NO evidence-policy block (v1.0 shape unchanged)', () => {
    const { document } = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: undefined },
    });
    expect('manifestEvidencePolicy' in document.target).toBe(false);
    expect('manifestPolicy' in document.target).toBe(false);
  });

  it('the frozen document is deterministic: identical input ⇒ identical hash', () => {
    const a = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: MANIFEST },
    });
    const b = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: MANIFEST },
    });
    expect(a.hash).toBe(b.hash);
    expect(a.canonical).toBe(b.canonical);
  });

  it('a later manifest change produces a DIFFERENT snapshot hash (frozen intent is per-freeze)', () => {
    const changed = {
      ...MANIFEST,
      inspection: [
        ...MANIFEST.inspection,
        {
          queryId: 'effects',
          roleId: 'effect',
          description: 'd',
          path: '/inspection/effects',
          fields: { effectId: 'string' },
          identityFields: ['effectId'],
        },
      ],
      identityModel: {
        ...MANIFEST.identityModel,
        nodes: [
          ...MANIFEST.identityModel.nodes,
          { roleId: 'effect', description: 'd', fields: { effectId: 'string' } },
        ],
      },
    };
    const a = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: MANIFEST },
    });
    const b = buildSnapshotDocument({
      revision: REVISION,
      definition: { id: '00000000-0000-4000-8000-000000000003', name: 'exp' },
      target: { ...TARGET_BASE, manifestJson: changed },
    });
    expect(a.hash).not.toBe(b.hash);
  });
});
