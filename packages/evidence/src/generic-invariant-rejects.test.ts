// =====================================================================
// RuptureGrid v1.1 Phase 15 — definition-time reject matrix (ADR-0023 §9)
// =====================================================================
// Every rejection below is deterministic, named, and emitted BEFORE any
// evaluation: a definition that cannot shape an honest proof is refused,
// never guessed around.

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import {
  BUSINESS_INVARIANT_KINDS,
  BUSINESS_INVARIANT_REGISTRY_VERSION,
  GenericInvariantDefinitionError,
  parseGenericMetadataTriple,
  validateGenericInvariantDefinition,
} from '@rupturegrid/engine';

/**
 * A minimal frozen ManifestEvidencePolicy carrying both kinds' surfaces:
 * checkoutIntent/order roles (atMostOne) and sku/skuBaseline/skuRemaining/
 * reservation roles (resourceConservation).
 */
const POLICY: ManifestEvidencePolicy = {
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'checkoutIntents',
      roleId: 'checkoutIntent',
      description: 'Checkout intents',
      path: '/inspection/checkout-intents',
      fields: {
        checkoutIntentId: 'string',
        customerId: 'string',
        cartId: 'string',
        totalMinor: 'integer-minor-units',
        currency: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'acceptedOrdersEntities',
      roleId: 'order',
      description: 'Accepted orders',
      path: '/inspection/orders',
      fields: {
        orderId: 'string',
        checkoutIntentId: 'string',
        customerId: 'string',
        cartId: 'string',
        totalMinor: 'integer-minor-units',
        currency: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['orderId'],
    },
    {
      queryId: 'acceptedOrders',
      roleId: 'acceptedOrdersSummary',
      description: 'Per-subject accepted-order summary',
      path: '/inspection/accepted-orders-summary',
      fields: {
        checkoutIntentId: 'string',
        acceptedOrderTotal: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'skuEntities',
      roleId: 'sku',
      description: 'SKU registry',
      path: '/inspection/skus',
      fields: {
        sku: 'string',
        title: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'stockBaseline',
      roleId: 'skuBaseline',
      description: 'Stock baseline',
      path: '/inspection/stock-baseline',
      fields: {
        sku: 'string',
        initialAvailableUnits: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'stockRemaining',
      roleId: 'skuRemaining',
      description: 'Stock remaining state',
      path: '/inspection/stock-remaining',
      fields: {
        sku: 'string',
        remainingAvailableUnits: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'reservationEvents',
      roleId: 'reservation',
      description: 'Reservations',
      path: '/inspection/reservations',
      fields: {
        reservationId: 'string',
        sku: 'string',
        reservedUnits: 'integer-minor-units',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['reservationId'],
    },
    {
      queryId: 'acceptedReservations',
      roleId: 'acceptedReservationsSummary',
      description: 'Per-resource accepted-reservation summary',
      path: '/inspection/accepted-reservations-summary',
      fields: {
        sku: 'string',
        acceptedReservationTotal: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'checkoutIntent',
        description: 'A checkout intent',
        fields: {
          checkoutIntentId: 'string',
          customerId: 'string',
          cartId: 'string',
          totalMinor: 'integer-minor-units',
          currency: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'order',
        description: 'An order',
        fields: {
          orderId: 'string',
          checkoutIntentId: 'string',
          customerId: 'string',
          cartId: 'string',
          totalMinor: 'integer-minor-units',
          currency: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'acceptedOrdersSummary',
        description: 'A per-subject summary row',
        fields: {
          checkoutIntentId: 'string',
          acceptedOrderTotal: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'sku',
        description: 'A stocked resource',
        fields: {
          sku: 'string',
          title: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'skuBaseline',
        description: 'A baseline fact',
        fields: {
          sku: 'string',
          initialAvailableUnits: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'skuRemaining',
        description: 'A remaining fact',
        fields: {
          sku: 'string',
          remainingAvailableUnits: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'reservation',
        description: 'A reservation effect',
        fields: {
          reservationId: 'string',
          sku: 'string',
          reservedUnits: 'integer-minor-units',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'acceptedReservationsSummary',
        description: 'A per-resource summary row',
        fields: {
          sku: 'string',
          acceptedReservationTotal: 'integer-minor-units',
          validityProbe: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
    ],
    causalEdges: [
      {
        fromRoleId: 'checkoutIntent',
        toRoleId: 'order',
        edgeKind: 'produced',
        linkFields: ['checkoutIntentId'],
      },
      {
        fromRoleId: 'sku',
        toRoleId: 'reservation',
        edgeKind: 'reserved-from',
        linkFields: ['sku'],
      },
    ],
    effectRoleIds: ['order', 'reservation'],
  },
  sensitiveFields: [],
};

const VALID_AT_MOST_ONE = {
  key: 'INV-CHK-1',
  kind: BUSINESS_INVARIANT_KINDS.atMostOneAcceptedEffect,
  params: {
    subjectRole: 'checkoutIntent',
    subjectIdentityField: 'checkoutIntentId',
    effectRole: 'order',
    effectIdentityField: 'orderId',
    acceptedMatch: { field: 'status', value: 'ACCEPTED' },
    equivalenceFields: ['checkoutIntentId', 'customerId', 'cartId', 'totalMinor', 'currency'],
    maxAcceptedEffects: 1,
    completenessProof: {
      kind: 'observed-total',
      queryId: 'acceptedOrders',
      subjectField: 'checkoutIntentId',
      totalField: 'acceptedOrderTotal',
    },
    scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
  },
};

const VALID_RESOURCE = {
  key: 'INV-INV-1',
  kind: BUSINESS_INVARIANT_KINDS.resourceConservation,
  params: {
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
  },
};

function codesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof GenericInvariantDefinitionError) {
      return error.issues.map((entry) => entry.code);
    }
    throw error;
  }
  return [];
}

function expectReject(raw: unknown, expectedCodes: readonly string[]): void {
  const codes = codesOf(() => validateGenericInvariantDefinition(raw, POLICY));
  for (const code of expectedCodes) {
    expect(codes, `expected issue ${code}; got ${codes.join(', ') || 'NO ISSUES'}`).toContain(code);
  }
}

describe('definition-time reject matrix (ADR-0023 §9 — all rejections before evaluation)', () => {
  it('both v1.1 reference instances VALIDATE (positive control)', () => {
    expect(() => validateGenericInvariantDefinition(VALID_AT_MOST_ONE, POLICY)).not.toThrow();
    expect(() => validateGenericInvariantDefinition(VALID_RESOURCE, POLICY)).not.toThrow();
  });

  it('no third kind exists: unknown kind is rejected with the closed vocabulary', () => {
    expectReject({ ...VALID_AT_MOST_ONE, kind: 'someThirdKind' }, [
      'UNKNOWN_INVARIANT_KIND',
      'UNKNOWN_PARAMS_KEY',
    ]);
    expect(BUSINESS_INVARIANT_KINDS && Object.keys(BUSINESS_INVARIANT_KINDS)).toEqual([
      'atMostOneAcceptedEffect',
      'resourceConservation',
    ]);
  });

  it('no user expressions: a predicate-looking params key is an unknown-key rejection', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, where: 'totalMinor > 5' },
      },
      ['UNKNOWN_PARAMS_KEY'],
    );
  });

  it('unknown registryVersion is refused, never guessed', () => {
    expectReject({ ...VALID_AT_MOST_ONE, registryVersion: 'business-invariant/v2' }, [
      'UNKNOWN_REGISTRY_VERSION',
    ]);
  });

  it('unknown params keys are rejected (exact closed shape)', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, arbitrary: 1 },
      },
      ['UNKNOWN_PARAMS_KEY'],
    );
    expectReject(
      {
        ...VALID_RESOURCE,
        params: { ...VALID_RESOURCE.params, filter: 'anything' },
      },
      ['UNKNOWN_PARAMS_KEY'],
    );
  });

  it('undeclared role and undeclared field are rejections', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, subjectRole: 'notARole' },
      },
      ['UNDECLARED_ROLE'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, effectIdentityField: 'noSuchField' },
      },
      ['FIELD_NOT_DECLARED_ON_ROLE'],
    );
  });

  it('undeclared completeness queryId is a rejection', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          completenessProof: {
            ...VALID_AT_MOST_ONE.params.completenessProof,
            queryId: 'noSuchQuery',
          },
        },
      },
      ['UNDECLARED_QUERY_ID'],
    );
  });

  it('completenessProof.kind must be exactly observed-total (the only v1 mechanism)', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          completenessProof: {
            ...VALID_AT_MOST_ONE.params.completenessProof,
            kind: 'enumerationComplete-boolean',
          },
        },
      },
      ['COMPLETENESS_KIND_NOT_OBSERVED_TOTAL'],
    );
  });

  it('total/units fields must be the declared integer primitive (integer-minor-units)', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          completenessProof: {
            ...VALID_AT_MOST_ONE.params.completenessProof,
            totalField: 'checkoutIntentId',
          },
        },
      },
      ['FIELD_TYPE_MISMATCH'],
    );
    expectReject(
      {
        ...VALID_RESOURCE,
        params: { ...VALID_RESOURCE.params, baselineUnitsField: 'sku' },
      },
      ['FIELD_TYPE_MISMATCH'],
    );
  });

  it('maxAcceptedEffects: float / negative / numeric-string are rejections (no coercion)', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, maxAcceptedEffects: 1.5 },
      },
      ['MAX_ACCEPTED_EFFECTS_NOT_INTEGER'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, maxAcceptedEffects: '1' },
      },
      ['MAX_ACCEPTED_EFFECTS_NOT_INTEGER'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, maxAcceptedEffects: -1 },
      },
      ['MAX_ACCEPTED_EFFECTS_NEGATIVE_OR_UNSAFE'],
    );
  });

  it('acceptedMatch value type must match the declared field type (no coercion)', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          acceptedMatch: { field: 'status', value: 5 },
        },
      },
      ['ACCEPTED_MATCH_VALUE_TYPE_MISMATCH'],
    );
  });

  it('acceptedMatch field must NOT overlap identity/equivalence/scope/generation/total fields', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          acceptedMatch: { field: 'orderId', value: 'ACCEPTED' },
        },
      },
      ['ACCEPTED_MATCH_OVERLAPS_FORBIDDEN_ROLE'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          acceptedMatch: { field: 'generationId', value: 'gen-1' },
        },
      },
      ['ACCEPTED_MATCH_OVERLAPS_FORBIDDEN_ROLE'],
    );
  });

  it('equivalenceFields: empty / duplicate / undeclared-on-effect rejections', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, equivalenceFields: [] },
      },
      ['EMPTY_EQUIVALENCE_FIELDS'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, equivalenceFields: ['customerId', 'customerId'] },
      },
      ['DUPLICATE_EQUIVALENCE_FIELD'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: {
          ...VALID_AT_MOST_ONE.params,
          equivalenceFields: ['customerId', 'notDeclaredAnywhere'],
        },
      },
      ['FIELD_NOT_DECLARED_ON_ROLE'],
    );
  });

  it('scopeBinding is required; empty fields are rejections', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, scopeBinding: undefined },
      },
      ['MALFORMED_SCOPE_BINDING'],
    );
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params, scopeBinding: { fields: [] } },
      },
      ['EMPTY_SCOPE_FIELDS'],
    );
  });

  it('metadata triple is ALL-OR-NONE (ADR-0023 §6): partial hybrid is a rejection', () => {
    expectReject(
      {
        ...VALID_AT_MOST_ONE,
        params: { ...VALID_AT_MOST_ONE.params },
        registryVersion: BUSINESS_INVARIANT_REGISTRY_VERSION,
      },
      [],
    ); // full triple present ⇒ valid (control)
    const codes = codesOf(() =>
      parseGenericMetadataTriple(
        {
          kind: BUSINESS_INVARIANT_KINDS.atMostOneAcceptedEffect,
          registryVersion: null,
          paramsJson: null,
        },
        POLICY,
      ),
    );
    expect(codes).toContain('PARTIAL_GENERIC_METADATA');
    const codes2 = codesOf(() =>
      parseGenericMetadataTriple(
        {
          kind: null,
          registryVersion: BUSINESS_INVARIANT_REGISTRY_VERSION,
          paramsJson: { any: 1 },
        },
        POLICY,
      ),
    );
    expect(codes2).toContain('PARTIAL_GENERIC_METADATA');
    // Legacy all-null carrier parses to null, semantics untouched.
    expect(
      parseGenericMetadataTriple({ kind: null, registryVersion: null, paramsJson: null }, POLICY),
    ).toBeNull();
  });
});
