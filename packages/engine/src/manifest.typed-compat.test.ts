// =====================================================================
// Phase 14 blocker repair B-4 — typed manifest declaration compatibility
// =====================================================================
// B-4A: every identityModel node field of a bound role must exist in
// the bound inspection query's declared fields with EXACTLY the same
// ManifestFieldType (extra inspection-only fields stay legitimate).
// B-4B: every causal linkField must carry the SAME declared primitive
// type on BOTH endpoint roles. Both fail REGISTRATION with named
// issues — malformed typed declarations never become permanent runtime
// attribution gaps.
//
// The single-node ADR-0021 no-inference fixture also becomes B-4A
// compatible (the query must carry the role's declared field).

import { describe, expect, it } from 'vitest';
import {
  deriveEvidencePolicy,
  ManifestValidationError,
  validateTargetManifest,
} from './manifest.js';

// ---------------------------------------------------------------------
// Self-contained B-4 fixture (mirrors the base manifest.test.ts shape;
// deliberately not imported from the test file — importing a test
// module would re-execute its suites).
// ---------------------------------------------------------------------

const IDENTITY_MODEL = {
  nodes: [
    {
      roleId: 'payment',
      description: 'A provider payment',
      fields: { providerPaymentId: 'string' },
    },
    {
      roleId: 'financialEffect',
      description: 'A posted effect',
      fields: { providerPaymentId: 'string', amountMinorUnits: 'integer-minor-units' },
    },
  ],
  causalEdges: [
    {
      fromRoleId: 'payment',
      toRoleId: 'financialEffect',
      edgeKind: 'produced-effect',
      linkFields: ['providerPaymentId'],
    },
  ],
  effectRoleIds: ['financialEffect'],
  subjectRoleId: 'payment',
};

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 'target-manifest/v1',
    displayName: 'acme-commerce',
    environment: 'STAGING',
    origins: ['https://api.acme.example:8443'],
    credentialRefs: ['DEMO_INSPECTION_TOKEN'],
    contract: { kind: 'GENERIC_HTTP', metadata: { noEffectOnRejection: true } },
    inspection: [
      {
        queryId: 'orderById',
        roleId: 'payment',
        description: 'Fetch one order by id',
        path: '/inspection/orders?state=accepted',
        fields: {
          providerPaymentId: 'string',
          orderId: 'string',
          status: 'string',
          totalMinorUnits: 'integer-minor-units',
        },
        identityFields: ['orderId'],
      },
    ],
    identityModel: IDENTITY_MODEL,
    sensitiveFields: ['customer.email'],
    ...overrides,
  };
}

describe('B-4A: inspection query ↔ bound-role typed schema compatibility', () => {
  it('rejects a query that omits a field declared on the bound role', () => {
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'orderById',
            roleId: 'payment',
            description: 'Fetch one order by id',
            path: '/inspection/orders',
            // The role declares providerPaymentId — omitted here.
            fields: { orderId: 'string', status: 'string' },
            identityFields: ['orderId'],
          },
        ],
      }),
      /inspection\[0\]\.fields is missing "providerPaymentId", which the bound role "payment" declares as string/,
    );
  });

  it('rejects a query that redefines a role field with another primitive type', () => {
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'orderById',
            roleId: 'payment',
            description: 'Fetch one order by id',
            path: '/inspection/orders',
            fields: { providerPaymentId: 'timestamp' },
            identityFields: ['providerPaymentId'],
          },
        ],
      }),
      /inspection\[0\]\.fields\."providerPaymentId" is timestamp, but the bound role "payment" declares string/,
    );
  });

  it('rejects a missing role field on the exact audit example (role order vs query order types)', () => {
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [{ roleId: 'order', description: 'An order', fields: { orderId: 'string' } }],
          causalEdges: [],
          effectRoleIds: ['order'],
        },
        inspection: [
          {
            queryId: 'orders',
            roleId: 'order',
            description: 'Orders',
            path: '/inspection/orders',
            fields: { orderId: 'timestamp' },
            identityFields: ['orderId'],
          },
        ],
      }),
      /is timestamp, but the bound role "order" declares string/,
    );
  });

  it('rejects a role schema that the query cannot actually carry (checkoutIntentId omitted)', () => {
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [
            {
              roleId: 'order',
              description: 'An order',
              fields: { orderId: 'string', checkoutIntentId: 'string' },
            },
          ],
          causalEdges: [],
          effectRoleIds: ['order'],
        },
        inspection: [
          {
            queryId: 'orders',
            roleId: 'order',
            description: 'Orders',
            path: '/inspection/orders',
            fields: { orderId: 'string' },
            identityFields: ['orderId'],
          },
        ],
      }),
      /is missing "checkoutIntentId"/,
    );
  });

  it('accepts a compatible superset (extra inspection-only business fields stay legitimate)', () => {
    const manifest = validateTargetManifest(validManifest());
    expect(manifest.inspection[0]?.fields['providerPaymentId']).toBe('string');
    expect(manifest.inspection[0]?.fields['status']).toBe('string');
  });

  it('accepts equal-type role fields regardless of declaration order', () => {
    const manifest = validateTargetManifest(
      validManifest({
        inspection: [
          {
            queryId: 'orderById',
            roleId: 'payment',
            description: 'Fetch one order by id',
            path: '/inspection/orders',
            fields: { providerPaymentId: 'string' },
            identityFields: ['providerPaymentId'],
          },
        ],
      }),
    );
    expect(manifest.inspection[0]?.roleId).toBe('payment');
  });

  it('the compatibility rule is frozen into the derived evidence policy (derive fails closed)', () => {
    const policy = deriveEvidencePolicy(validManifest());
    expect(policy?.inspection[0]?.fields['providerPaymentId']).toBe('string');
  });
});

describe('B-4B: causal linkField declared-type equality', () => {
  it('rejects a one-field linkField declared with different types on the endpoints', () => {
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          causalEdges: [
            {
              fromRoleId: 'payment',
              toRoleId: 'financialEffect',
              edgeKind: 'produced-effect',
              linkFields: ['requestId'],
            },
          ],
          nodes: [
            {
              roleId: 'payment',
              description: 'A provider payment',
              fields: { providerPaymentId: 'string', requestId: 'string' },
            },
            {
              roleId: 'financialEffect',
              description: 'A posted effect',
              fields: {
                providerPaymentId: 'string',
                amountMinorUnits: 'integer-minor-units',
                requestId: 'timestamp',
              },
            },
          ],
        },
      }),
      /linkFields names "requestId", which is declared as string on role "payment" but timestamp on role "financialEffect"/,
    );
  });

  it('rejects a multi-field edge where exactly one field differs in type', () => {
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [
            {
              roleId: 'payment',
              description: 'A provider payment',
              fields: {
                providerPaymentId: 'string',
                walletId: 'string',
                eventAt: 'timestamp',
              },
            },
            {
              roleId: 'financialEffect',
              description: 'A posted effect',
              fields: {
                providerPaymentId: 'string',
                amountMinorUnits: 'integer-minor-units',
                walletId: 'string',
                eventAt: 'boolean',
              },
            },
          ],
          causalEdges: [
            {
              fromRoleId: 'payment',
              toRoleId: 'financialEffect',
              edgeKind: 'produced-effect',
              linkFields: ['walletId', 'eventAt'],
            },
          ],
        },
      }),
      /declared as timestamp on role "payment" but boolean on role "financialEffect"/,
    );
  });

  it('accepts a multi-field edge whose linkFields match in type on both endpoints', () => {
    const manifest = validateTargetManifest(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [
            {
              roleId: 'payment',
              description: 'A provider payment',
              fields: { providerPaymentId: 'string', walletId: 'string' },
            },
            {
              roleId: 'financialEffect',
              description: 'A posted effect',
              fields: {
                providerPaymentId: 'string',
                amountMinorUnits: 'integer-minor-units',
                walletId: 'string',
              },
            },
          ],
          causalEdges: [
            {
              fromRoleId: 'payment',
              toRoleId: 'financialEffect',
              edgeKind: 'produced-effect',
              linkFields: ['providerPaymentId', 'walletId'],
            },
          ],
        },
        // B-4A: the query must carry the role's (now extended) schema.
        inspection: [
          {
            queryId: 'orderById',
            roleId: 'payment',
            description: 'Fetch one order by id',
            path: '/inspection/orders?state=accepted',
            fields: {
              providerPaymentId: 'string',
              walletId: 'string',
              orderId: 'string',
              status: 'string',
              totalMinorUnits: 'integer-minor-units',
            },
            identityFields: ['orderId'],
          },
        ],
      }),
    );
    expect(manifest.identityModel.causalEdges[0]?.linkFields).toEqual([
      'providerPaymentId',
      'walletId',
    ]);
  });
});

// The runtime DEFENSIVE declared-type check (second layer of defense
// in depth for stored evidence derived under earlier validators) is
// proven in packages/evidence/src/generic-derive.test.ts
// ('link-field-declared-type-mismatch' gap) — it stays, unchanged.

function expectRejected(raw: unknown, pattern?: RegExp): void {
  try {
    validateTargetManifest(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    if (pattern !== undefined) {
      expect((error as ManifestValidationError).message).toMatch(pattern);
    }
    return;
  }
  throw new Error(`expected manifest to be rejected: ${JSON.stringify(raw).slice(0, 120)}`);
}
