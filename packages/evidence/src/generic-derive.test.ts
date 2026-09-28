// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic causal derivation (unit, pure)
// =====================================================================
// Direct-edge matrix (exact equality only), ambiguity matrix (no
// guessed winners, deterministic diagnostics), and the identity-chain
// matrix (multi-hop reachability, cycle safety, determinism across
// input order, idempotence) over the frozen policy.

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { computeGenericDerivation } from './generic-derive.js';
import type { GenericEventRow } from './generic-derive.js';
import { GENERIC_IDENTITY_CHAIN_RELATION_KIND } from './versions.js';

const POLICY: ManifestEvidencePolicy = {
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
      { roleId: 'attempt', description: 'd', fields: { attemptId: 'string', intentId: 'string' } },
      { roleId: 'result', description: 'd', fields: { resultId: 'string', attemptId: 'string' } },
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

function prov(queryId: string): Record<string, unknown> {
  return { rupturegrid: { queryId, normalizerName: 'generic-inspection-normalizer' } };
}

function event(
  id: string,
  eventType: string,
  payloadFields: Record<string, unknown>,
  queryId = eventType,
): GenericEventRow {
  return {
    id,
    eventType,
    payload: { ...payloadFields, ...prov(queryId === eventType ? `${eventType}s` : queryId) },
    sourceObservationHashes: [`hash-${id}`],
  };
}

const DIRECT = (rows: ReturnType<typeof computeGenericDerivation>['relationships']) =>
  rows.filter((row) => row.basis === 'identity-direct');
const CHAIN = (rows: ReturnType<typeof computeGenericDerivation>['relationships']) =>
  rows.filter((row) => row.basis === 'identity-chain');

describe('Phase 14: generic direct derivation (exact equality only)', () => {
  it('links on an exact one-field match with direction and declared edgeKind preserved', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    const direct = DIRECT(result.relationships);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.fromEventId).toBe('e1');
    expect(direct[0]?.toEventId).toBe('e2');
    expect(direct[0]?.relationKind).toBe('attempted');
    expect(direct[0]?.evidence['matchedFields']).toEqual(['intentId']);
    expect(direct[0]?.evidence['matchedValues']).toEqual({ intentId: 'I-1' });
    expect(direct[0]?.evidence['edgeKind']).toBe('attempted');
  });

  it('links on an exact multi-field match (all fields required, declared on both roles)', () => {
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      inspection: [
        ...POLICY.inspection,
        {
          queryId: 'attempts2',
          roleId: 'attempt2',
          description: 'd',
          path: '/inspection/attempts2',
          fields: { attemptId: 'string', intentId: 'string', correlationId: 'string' },
          identityFields: ['attemptId'],
        },
      ],
      identityModel: {
        nodes: [
          ...POLICY.identityModel.nodes,
          {
            roleId: 'attempt2',
            description: 'd',
            fields: { attemptId: 'string', intentId: 'string', correlationId: 'string' },
          },
        ],
        causalEdges: [
          {
            fromRoleId: 'intent2',
            toRoleId: 'attempt2',
            edgeKind: 'attempted2',
            linkFields: ['intentId', 'correlationId'],
          },
        ],
        effectRoleIds: ['result'],
      },
    };
    // intent2 is an alias role sharing the intent query's shape.
    (policy.inspection as unknown as unknown[]).push({
      queryId: 'intents2',
      roleId: 'intent2',
      description: 'd',
      path: '/inspection/intents2',
      fields: { intentId: 'string', correlationId: 'string' },
      identityFields: ['intentId'],
    });
    (policy.identityModel.nodes as unknown[]).splice(0, 0, {
      roleId: 'intent2',
      description: 'd',
      fields: { intentId: 'string', correlationId: 'string' },
    });
    const events = [
      event('e1', 'intent2', { intentId: 'I-1', correlationId: 'C-1' }, 'intents2'),
      event(
        'e2',
        'attempt2',
        { attemptId: 'A-1', intentId: 'I-1', correlationId: 'C-1' },
        'attempts2',
      ),
      // One field right, one wrong ⇒ no edge.
      event(
        'e3',
        'attempt2',
        { attemptId: 'A-2', intentId: 'I-1', correlationId: 'C-9' },
        'attempts2',
      ),
    ];
    const direct = DIRECT(computeGenericDerivation(events, policy).relationships);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.fromEventId).toBe('e1');
    expect(direct[0]?.toEventId).toBe('e2');
    expect(direct[0]?.evidence['matchedFields']).toEqual(['intentId', 'correlationId']);
  });

  it('does NOT link when one link field mismatches', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'attempt', { attemptId: 'A-1', intentId: 'I-2' }, 'attempts'),
    ];
    expect(DIRECT(computeGenericDerivation(events, POLICY).relationships)).toHaveLength(0);
  });

  it('does NOT link when a link field is missing', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'attempt', { attemptId: 'A-1' }, 'attempts'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    expect(DIRECT(result.relationships)).toHaveLength(0);
    expect(result.diagnostics.map((gap) => gap.gapKind)).toContain('missing-link-field');
  });

  it('does NOT link when a link field value is redacted (no guessing)', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'attempt', { attemptId: 'A-1', intentId: '[Redacted]' }, 'attempts'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    expect(DIRECT(result.relationships)).toHaveLength(0);
    expect(result.diagnostics.map((gap) => gap.gapKind)).toContain('redacted-link-field');
  });

  it('same spelling with different declared types does NOT link (no coercion)', () => {
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      inspection: [
        ...POLICY.inspection,
        {
          queryId: 'results2',
          roleId: 'result2',
          description: 'd',
          path: '/inspection/results2',
          fields: { resultId: 'string', attemptId: 'string' },
          identityFields: ['resultId'],
        },
      ],
      identityModel: {
        nodes: [
          ...POLICY.identityModel.nodes,
          { roleId: 'result2', description: 'd', fields: { attemptId: 'integer-minor-units' } },
        ],
        causalEdges: [
          {
            fromRoleId: 'attempt',
            toRoleId: 'result2',
            edgeKind: 'produced2',
            linkFields: ['attemptId'],
          },
        ],
        effectRoleIds: ['result'],
      },
    };
    const events = [
      event('e2', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
      event('e3', 'result2', { attemptId: 'A-1' }, 'results2'),
    ];
    const result = computeGenericDerivation(events, policy);
    expect(DIRECT(result.relationships)).toHaveLength(0);
    expect(result.diagnostics.map((gap) => gap.gapKind)).toContain(
      'link-field-declared-type-mismatch',
    );
  });

  it('no substring / fuzzy / proximity fallback', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'attempt', { attemptId: 'A-1', intentId: 'I-1-extra' }, 'attempts'),
      event('e3', 'attempt', { attemptId: 'A-2', intentId: 'i-1' }, 'attempts'),
      event('e4', 'attempt', { attemptId: 'A-3', intentId: '1-I' }, 'attempts'),
    ];
    expect(DIRECT(computeGenericDerivation(events, POLICY).relationships)).toHaveLength(0);
  });
});

describe('Phase 14: ambiguity — contested identity (no guessed winners)', () => {
  it('duplicate identity with conflicting payloads derives NO winning edge and records the conflict', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e3', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
    ];
    // Make e2 conflict with e1 (same identity, different payload).
    const contested = events.map((row) =>
      row.id === 'e2' ? { ...row, payload: { ...row.payload, extraDeclared: 'different' } } : row,
    );
    const result = computeGenericDerivation(contested, POLICY);
    expect(DIRECT(result.relationships)).toHaveLength(0);
    const conflict = result.diagnostics.find((gap) => gap.gapKind === 'contested-identity');
    expect(conflict).toBeDefined();
    expect(conflict?.payload['affectedEventIds']).toEqual(['e1', 'e2']);
  });

  it('identical duplicate observations are NOT conflicts (convergent captures)', () => {
    const events = [
      event('e1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e2', 'intent', { intentId: 'I-1' }, 'intents'),
      event('e3', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
    ];
    const result = computeGenericDerivation(events, POLICY);
    expect(result.diagnostics.find((gap) => gap.gapKind === 'contested-identity')).toBeUndefined();
    // Every non-contested (from, to) pair links honestly — no winner is
    // picked and none is needed: the payloads agree.
    expect(DIRECT(result.relationships)).toHaveLength(2);
  });

  it('contested anchors produce deterministic output regardless of input ordering', () => {
    const base = [
      event('a', 'intent', { intentId: 'I-1' }, 'intents'),
      event('b', 'intent', { intentId: 'I-1' }, 'intents'),
      event('c', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
    ];
    const contested = base.map((row) =>
      row.id === 'b' ? { ...row, payload: { ...row.payload, extraDeclared: 'x' } } : row,
    );
    const forward = computeGenericDerivation(contested, POLICY);
    const reversed = computeGenericDerivation([...contested].reverse(), POLICY);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(DIRECT(forward.relationships)).toHaveLength(0);
  });
});

describe('Phase 14: identity-chain derivation (direct edges only)', () => {
  function chainEvents(): GenericEventRow[] {
    return [
      event('i1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('a1', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
      event('r1', 'result', { resultId: 'R-1', attemptId: 'A-1' }, 'results'),
    ];
  }

  it('derives a 2-hop identity-chain relationship over identity-direct edges', () => {
    const result = computeGenericDerivation(chainEvents(), POLICY);
    const direct = DIRECT(result.relationships);
    const chain = CHAIN(result.relationships);
    expect(direct).toHaveLength(2);
    expect(chain).toHaveLength(1);
    const row = chain[0]!;
    expect(row.relationKind).toBe(GENERIC_IDENTITY_CHAIN_RELATION_KIND);
    expect(row.fromEventId).toBe('i1');
    expect(row.toEventId).toBe('r1');
    expect(row.evidence['pathLength']).toBe(2);
    expect(row.evidence['mechanism']).toContain('identity-direct');
    const paths = row.evidence['paths'] as Array<{ eventIds: string[]; edgeKinds: string[][] }>;
    expect(paths[0]?.eventIds).toEqual(['i1', 'a1', 'r1']);
  });

  it('disconnected events stay disconnected (no transitive invention)', () => {
    const events = [...chainEvents(), event('i2', 'intent', { intentId: 'I-9' }, 'intents')];
    const result = computeGenericDerivation(events, POLICY);
    const chain = CHAIN(result.relationships);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.toEventId).not.toBe('i2');
    expect(chain[0]?.fromEventId).not.toBe('i2');
  });

  it('a 3-hop chain works with variable lengths (extra role)', () => {
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      inspection: [
        ...POLICY.inspection,
        {
          queryId: 'settlements',
          roleId: 'settlement',
          description: 'd',
          path: '/inspection/settlements',
          fields: { settlementId: 'string', resultId: 'string' },
          identityFields: ['settlementId'],
        },
      ],
      identityModel: {
        nodes: [
          ...POLICY.identityModel.nodes,
          {
            roleId: 'settlement',
            description: 'd',
            fields: { settlementId: 'string', resultId: 'string' },
          },
        ],
        causalEdges: [
          ...POLICY.identityModel.causalEdges,
          {
            fromRoleId: 'result',
            toRoleId: 'settlement',
            edgeKind: 'settled',
            linkFields: ['resultId'],
          },
        ],
        effectRoleIds: ['result', 'settlement'],
      },
    };
    const events = [
      ...chainEvents(),
      event('s1', 'settlement', { settlementId: 'S-1', resultId: 'R-1' }, 'settlements'),
    ];
    const result = computeGenericDerivation(events, policy);
    const chain = CHAIN(result.relationships);
    const i1s1 = chain.find((row) => row.fromEventId === 'i1' && row.toEventId === 's1');
    expect(i1s1).toBeDefined();
    expect(i1s1?.evidence['pathLength']).toBe(3);
  });

  it('is cycle-safe (a cyclic declared graph cannot loop forever)', () => {
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      identityModel: {
        ...POLICY.identityModel,
        causalEdges: [
          {
            fromRoleId: 'intent',
            toRoleId: 'attempt',
            edgeKind: 'attempted',
            linkFields: ['intentId'],
          },
          {
            fromRoleId: 'attempt',
            toRoleId: 'intent',
            edgeKind: 'reflected',
            linkFields: ['intentId'],
          },
        ],
      },
    };
    const events = [
      event('i1', 'intent', { intentId: 'I-1' }, 'intents'),
      event('a1', 'attempt', { attemptId: 'A-1', intentId: 'I-1' }, 'attempts'),
    ];
    const result = computeGenericDerivation(events, policy);
    // Both directions are single direct edges; no infinite chain rows.
    expect(DIRECT(result.relationships)).toHaveLength(2);
    expect(CHAIN(result.relationships)).toHaveLength(0);
  });

  it('determinism: same derivation regardless of event input order', () => {
    const events = [
      ...chainEvents(),
      event('i2', 'intent', { intentId: 'I-2' }, 'intents'),
      event('a2', 'attempt', { attemptId: 'A-2', intentId: 'I-2' }, 'attempts'),
      event('r2', 'result', { resultId: 'R-2', attemptId: 'A-2' }, 'results'),
    ];
    const forward = JSON.stringify(computeGenericDerivation(events, POLICY));
    const reversed = JSON.stringify(computeGenericDerivation([...events].reverse(), POLICY));
    const shuffled = JSON.stringify(
      computeGenericDerivation(
        [events[3]!, events[0]!, events[5]!, events[1]!, events[4]!, events[2]!],
        POLICY,
      ),
    );
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('idempotence: repeated computation yields identical relationships', () => {
    const events = chainEvents();
    const first = computeGenericDerivation(events, POLICY);
    const second = computeGenericDerivation(events, POLICY);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
