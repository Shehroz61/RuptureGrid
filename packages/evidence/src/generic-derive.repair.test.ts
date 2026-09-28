// =====================================================================
// Phase 14 blocker repair — B-3 cross-query same-role conflicts and
// B-2 stale-relationship invalidation provenance (unit, pure)
// =====================================================================
// B-3: contested-identity grouping is ROLE-scoped. Two queries bound
// to the SAME role with the SAME declared identityFields group across
// queries; a conflicting payload can no longer hide behind a different
// queryId. Identical entities across queries are convergent
// observations — NOT conflicts. The outcome is independent of input
// order.
//
// B-2: derivation output carries `contestedEventIds` (the ACTIVE-graph
// exclusion set) and bounded, versioned `invalidations` (durable
// provenance). Direct edges anchored on contested events and chains
// routed through contested nodes are excluded; prior persisted rows
// are never deleted by the derivation (logically append-only) — the
// durable tombstones are persisted by the derive pipeline, proven in
// the integration suite.

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { computeGenericDerivation } from './generic-derive.js';
import type { GenericEventRow } from './generic-derive.js';
import { GENERIC_IDENTITY_CHAIN_RELATION_KIND } from './versions.js';

const POLICY: ManifestEvidencePolicy = {
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'membersPrimary',
      roleId: 'member',
      description: 'Primary member registry',
      path: '/inspection/members',
      fields: { memberId: 'string', cardStatus: 'string' },
      identityFields: ['memberId'],
    },
    {
      queryId: 'membersArchive',
      roleId: 'member',
      description: 'Archive member registry (same role, same identity)',
      path: '/inspection/members-archive',
      fields: { memberId: 'string', cardStatus: 'string' },
      identityFields: ['memberId'],
    },
    {
      queryId: 'loans',
      roleId: 'loan',
      description: 'Loans',
      path: '/inspection/loans',
      fields: { loanId: 'string', memberId: 'string' },
      identityFields: ['loanId'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'member',
        description: 'A member',
        fields: { memberId: 'string', cardStatus: 'string' },
      },
      { roleId: 'loan', description: 'A loan', fields: { loanId: 'string', memberId: 'string' } },
    ],
    causalEdges: [
      { fromRoleId: 'member', toRoleId: 'loan', edgeKind: 'took-out', linkFields: ['memberId'] },
    ],
    effectRoleIds: ['loan'],
  },
  sensitiveFields: [],
};

function prov(queryId: string): Record<string, unknown> {
  return { queryId, normalizerName: 'generic-inspection-normalizer' };
}

function event(
  id: string,
  eventType: string,
  payloadFields: Record<string, unknown>,
  queryId: string,
): GenericEventRow {
  return {
    id,
    eventType,
    payload: { ...payloadFields, rupturegrid: prov(queryId) },
    sourceObservationHashes: [`hash-${id}`],
  };
}

describe('B-3: cross-query same-role conflict detection', () => {
  it('detects a conflict when two queries bound to the SAME role disagree', () => {
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('m2', 'member', { memberId: 'MEM-1', cardStatus: 'suspended' }, 'membersArchive'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    const contested = result.diagnostics.filter(
      (diagnostic) => diagnostic.gapKind === 'contested-identity',
    );
    expect(contested).toHaveLength(1);
    expect([...result.contestedEventIds].sort()).toEqual(['m1', 'm2']);
  });

  it('a queryId barrier no longer hides the conflict (regression for the audited bug)', () => {
    // Order-independence variant: the SAME identity observed by both
    // queries in reverse input order is still contested.
    const a = event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary');
    const b = event(
      'm2',
      'member',
      { memberId: 'MEM-1', cardStatus: 'suspended' },
      'membersArchive',
    );
    const forward = computeGenericDerivation([a, b], POLICY);
    const reverse = computeGenericDerivation([b, a], POLICY);
    expect([...forward.contestedEventIds].sort()).toEqual(['m1', 'm2']);
    expect([...reverse.contestedEventIds].sort()).toEqual(['m1', 'm2']);
    expect(forward.diagnostics.map((diagnostic) => diagnostic.subjectKey)).toEqual(
      reverse.diagnostics.map((diagnostic) => diagnostic.subjectKey),
    );
  });

  it('identical entities across queries are convergent observations, NOT conflicts', () => {
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('m2', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersArchive'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    expect(result.diagnostics.filter((d) => d.gapKind === 'contested-identity')).toHaveLength(0);
    expect(result.contestedEventIds).toEqual([]);
  });

  it('queries bound to the same role with DIFFERENT declared identityFields never collide', () => {
    // The identityFields NAME SET is part of the role-scoped key: two
    // different identity declarations under one role name different
    // subjects even when a raw value coincides.
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      inspection: [
        POLICY.inspection[0] as (typeof POLICY.inspection)[number],
        {
          queryId: 'membersByCard',
          roleId: 'member',
          description: 'Card-indexed registry',
          path: '/inspection/members-by-card',
          fields: { memberId: 'string', cardStatus: 'string' },
          identityFields: ['cardStatus'],
        },
      ],
    };
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('m2', 'member', { memberId: 'MEM-2', cardStatus: 'active' }, 'membersByCard'),
    ];
    const result = computeGenericDerivation(events, policy);
    expect(result.diagnostics.filter((d) => d.gapKind === 'contested-identity')).toHaveLength(0);
  });

  it('queryId remains provenance on the diagnostic-adjacent events (not a grouping key)', () => {
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('m2', 'member', { memberId: 'MEM-1', cardStatus: 'suspended' }, 'membersArchive'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    const contested = result.diagnostics.find((d) => d.gapKind === 'contested-identity');
    expect(contested?.payload['roleId']).toBe('member');
    expect((contested?.payload['affectedEventIds'] as string[]).sort()).toEqual(['m1', 'm2']);
  });
});

describe('B-2: contested anchors exclude edges; invalidation provenance is durable-shaped', () => {
  it('excludes direct edges anchored on contested events and emits invalidation specs', () => {
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('m2', 'member', { memberId: 'MEM-1', cardStatus: 'suspended' }, 'membersArchive'),
      event('l1', 'loan', { loanId: 'LOAN-1', memberId: 'MEM-1' }, 'loans'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    // LOAN-1's member is contested — NO took-out edge may exist in the
    // active graph, and no edge spec carries a contested anchor.
    expect(result.relationships).toHaveLength(0);
    expect(result.invalidations).toHaveLength(1);
    expect(result.invalidations[0]?.reason).toBe('identity-contested');
    expect(result.invalidations[0]?.roleId).toBe('member');
    expect((result.invalidations[0]?.payload['invalidatedEventIds'] as string[]).sort()).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('keeps legitimate edges when no identity is contested (no over-exclusion)', () => {
    const events: GenericEventRow[] = [
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('l1', 'loan', { loanId: 'LOAN-1', memberId: 'MEM-1' }, 'loans'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]?.relationKind).toBe('took-out');
    expect(result.invalidations).toHaveLength(0);
    expect(result.contestedEventIds).toEqual([]);
  });

  it('refuses to route identity chains THROUGH contested nodes', () => {
    // Chain policy: intent → attempt → result (attempt contested ⇒
    // intent→result reachability must not survive).
    const policy: ManifestEvidencePolicy = {
      manifestVersion: 'target-manifest/v1',
      inspection: [
        {
          queryId: 'intents',
          roleId: 'intent',
          description: 'd',
          path: '/inspection/intents',
          fields: { intentId: 'string' },
          identityFields: ['intentId'],
        },
        {
          queryId: 'attempts',
          roleId: 'attempt',
          description: 'd',
          path: '/inspection/attempts',
          fields: { attemptId: 'string', intentId: 'string' },
          identityFields: ['attemptId'],
        },
        {
          queryId: 'results',
          roleId: 'result',
          description: 'd',
          path: '/inspection/results',
          fields: { resultId: 'string', attemptId: 'string' },
          identityFields: ['resultId'],
        },
      ],
      identityModel: {
        nodes: [
          { roleId: 'intent', description: 'd', fields: { intentId: 'string' } },
          {
            roleId: 'attempt',
            description: 'd',
            fields: { attemptId: 'string', intentId: 'string' },
          },
          {
            roleId: 'result',
            description: 'd',
            fields: { resultId: 'string', attemptId: 'string' },
          },
        ],
        causalEdges: [
          {
            fromRoleId: 'intent',
            toRoleId: 'attempt',
            edgeKind: 'attempted',
            linkFields: ['intentId'],
          },
          {
            fromRoleId: 'attempt',
            toRoleId: 'result',
            edgeKind: 'produced',
            linkFields: ['attemptId'],
          },
        ],
        effectRoleIds: ['result'],
      },
      sensitiveFields: [],
    };
    const events: GenericEventRow[] = [
      event('i1', 'intent', { intentId: 'INT-1' }, 'intents'),
      event('i2', 'intent', { intentId: 'INT-1', note: 'duplicate-disagreement' }, 'intents'),
      event('a1', 'attempt', { attemptId: 'ATT-1', intentId: 'INT-1' }, 'attempts'),
      event('r1', 'result', { resultId: 'RES-1', attemptId: 'ATT-1' }, 'results'),
    ];
    const result = computeGenericDerivation(events, policy);
    // The intent identity is contested ⇒ the intent→attempt direct edge
    // is suppressed AND the intent→result chain (routed THROUGH the
    // contested node) is excluded. The attempt→result edge survives:
    // its endpoints are not contested (exclusion is anchored, not
    // blanket).
    expect(result.relationships.map((spec) => `${spec.fromEventId}->${spec.toEventId}`)).toEqual([
      'a1->r1',
    ]);
    expect([...result.contestedEventIds].sort()).toEqual(['i1', 'i2']);
  });

  it('the chain relation kind is still used for uncontested multi-hop reachability', () => {
    const policy: ManifestEvidencePolicy = {
      manifestVersion: 'target-manifest/v1',
      inspection: [
        {
          queryId: 'intents',
          roleId: 'intent',
          description: 'd',
          path: '/inspection/intents',
          fields: { intentId: 'string' },
          identityFields: ['intentId'],
        },
        {
          queryId: 'attempts',
          roleId: 'attempt',
          description: 'd',
          path: '/inspection/attempts',
          fields: { attemptId: 'string', intentId: 'string' },
          identityFields: ['attemptId'],
        },
        {
          queryId: 'results',
          roleId: 'result',
          description: 'd',
          path: '/inspection/results',
          fields: { resultId: 'string', attemptId: 'string' },
          identityFields: ['resultId'],
        },
      ],
      identityModel: {
        nodes: [
          { roleId: 'intent', description: 'd', fields: { intentId: 'string' } },
          {
            roleId: 'attempt',
            description: 'd',
            fields: { attemptId: 'string', intentId: 'string' },
          },
          {
            roleId: 'result',
            description: 'd',
            fields: { resultId: 'string', attemptId: 'string' },
          },
        ],
        causalEdges: [
          {
            fromRoleId: 'intent',
            toRoleId: 'attempt',
            edgeKind: 'attempted',
            linkFields: ['intentId'],
          },
          {
            fromRoleId: 'attempt',
            toRoleId: 'result',
            edgeKind: 'produced',
            linkFields: ['attemptId'],
          },
        ],
        effectRoleIds: ['result'],
      },
      sensitiveFields: [],
    };
    const events: GenericEventRow[] = [
      event('i1', 'intent', { intentId: 'INT-1' }, 'intents'),
      event('a1', 'attempt', { attemptId: 'ATT-1', intentId: 'INT-1' }, 'attempts'),
      event('r1', 'result', { resultId: 'RES-1', attemptId: 'ATT-1' }, 'results'),
    ];
    const result = computeGenericDerivation(events, policy);
    const chain = result.relationships.find(
      (spec) => spec.relationKind === GENERIC_IDENTITY_CHAIN_RELATION_KIND,
    );
    expect(chain).toBeDefined();
    expect(chain?.fromEventId).toBe('i1');
    expect(chain?.toEventId).toBe('r1');
  });

  it('repeat computation with unchanged input is idempotent (same contested set, same invalidations)', () => {
    const events: GenericEventRow[] = [
      event('m2', 'member', { memberId: 'MEM-1', cardStatus: 'suspended' }, 'membersArchive'),
      event('m1', 'member', { memberId: 'MEM-1', cardStatus: 'active' }, 'membersPrimary'),
      event('l1', 'loan', { loanId: 'LOAN-1', memberId: 'MEM-1' }, 'loans'),
    ];
    const first = computeGenericDerivation(events, POLICY);
    const second = computeGenericDerivation([...events].reverse(), POLICY);
    expect(first.contestedEventIds).toEqual(second.contestedEventIds);
    expect(first.invalidations).toEqual(second.invalidations);
    expect(first.relationships).toEqual(second.relationships);
  });
});
