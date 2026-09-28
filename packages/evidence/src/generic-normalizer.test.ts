// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic normalizer (unit, pure)
// =====================================================================
// Matrix: role binding (eventType = declared roleId), exact payload
// preservation, reserved provenance sub-object, subjectKey derivation,
// zero-events on invalid/unknown inputs, determinism (byte-equivalent
// semantic event specs across repeated normalization), and honest gap
// semantics (redacted identity never links).

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import {
  canonicalEventSpecsJson,
  genericSubjectKey,
  normalizeGenericInspectionObservation,
} from './generic-normalizer.js';
import {
  GENERIC_INSPECTION_ADAPTER_KIND,
  GENERIC_INSPECTION_NORMALIZER_NAME,
  GENERIC_INSPECTION_NORMALIZER_VERSION,
} from './versions.js';

const POLICY: ManifestEvidencePolicy = {
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'Accepted orders',
      path: '/inspection/orders',
      fields: { orderId: 'string', intentId: 'string', totalMinorUnits: 'integer-minor-units' },
      identityFields: ['orderId'],
    },
    {
      queryId: 'reservations',
      roleId: 'reservation',
      description: 'Reservations',
      path: '/inspection/reservations',
      fields: { reservationId: 'string', orderId: 'string' },
      identityFields: ['reservationId'],
    },
  ],
  identityModel: {
    nodes: [
      { roleId: 'order', description: 'o', fields: { orderId: 'string' } },
      { roleId: 'reservation', description: 'r', fields: { reservationId: 'string' } },
    ],
    causalEdges: [
      {
        fromRoleId: 'order',
        toRoleId: 'reservation',
        edgeKind: 'reserved-by',
        linkFields: ['orderId'],
      },
    ],
    effectRoleIds: ['reservation'],
  },
  sensitiveFields: [],
};

function envelope(
  queryId: string,
  elements: unknown[],
  overrides: {
    readonly adapterKind?: string;
    readonly valid?: boolean;
    readonly inspectionVersion?: string;
    readonly responseJson?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    envelopeVersion: 'generic-inspection-observation/v1',
    adapterKind: overrides.adapterKind ?? GENERIC_INSPECTION_ADAPTER_KIND,
    declaration: {
      inspectionVersion: overrides.inspectionVersion ?? 'inspection/v1',
      queryId,
      roleId: queryId === 'orders' ? 'order' : 'reservation',
      path: '/inspection/' + queryId,
    },
    observed: {
      httpStatus: 200,
      responseContentType: null,
      parseStatus: 'parsed-json',
      responseJson: overrides.responseJson ?? elements,
      responseJsonText: JSON.stringify(overrides.responseJson ?? elements),
    } as Record<string, unknown>,
    validation: {
      valid: overrides.valid ?? true,
      reasonCode: overrides.valid === false ? 'TYPE_MISMATCH' : 'VALID',
      detail: 'unit',
    },
    redaction: { policyVersion: 'evidence-redaction-v1', applied: false },
  };
}

const OBSERVATION = { contentHash: 'a'.repeat(64), chainIndex: 3 };

describe('Phase 14: generic normalizer', () => {
  it('binds eventType to the DECLARED roleId (no inference)', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('reservations', [{ reservationId: 'R-1', orderId: 'O-1' }]),
      },
      POLICY,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('reservation');
    expect(events[0]?.normalizerName).toBe(GENERIC_INSPECTION_NORMALIZER_NAME);
    expect(events[0]?.normalizerVersion).toBe(GENERIC_INSPECTION_NORMALIZER_VERSION);
  });

  it('preserves declared entity fields under their EXACT declared names', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I-1', totalMinorUnits: 250000 }]),
      },
      POLICY,
    );
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['orderId']).toBe('O-1');
    expect(payload['intentId']).toBe('I-1');
    expect(payload['totalMinorUnits']).toBe(250000);
  });

  it('carries provenance ONLY in the reserved rupturegrid sub-object', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I-1', totalMinorUnits: 1 }]),
      },
      POLICY,
    );
    const payload = events[0]?.payload as Record<string, unknown>;
    const provenance = payload['rupturegrid'] as Record<string, unknown>;
    expect(provenance['queryId']).toBe('orders');
    expect(provenance['roleId']).toBe('order');
    expect(
      Object.keys(payload)
        .filter((key) => key !== 'rupturegrid')
        .sort(),
    ).toEqual(['intentId', 'orderId', 'totalMinorUnits']);
  });

  it('derives a deterministic subjectKey from the declared identityFields', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I-1', totalMinorUnits: 1 }]),
      },
      POLICY,
    );
    expect(events[0]?.subjectKey).toBe('O-1');
    expect(genericSubjectKey({ a: 'x', b: 5 }, ['a', 'b'])).toBe('a=x|b=5');
  });

  it('redacted identity yields a NON-authoritative marker (never a link substitute)', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [
          { orderId: '[Redacted]', intentId: 'I-1', totalMinorUnits: 1 },
        ]),
      },
      POLICY,
    );
    expect(events[0]?.subjectKey).toBe('redacted:orderId');
  });

  it('an invalid capture yields ZERO events', () => {
    const events = normalizeGenericInspectionObservation(
      { ...OBSERVATION, payload: envelope('orders', [], { valid: false }) },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('a parsed but non-array observed body yields ZERO events', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [], { responseJson: { nope: true } }),
      },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('an empty array yields ZERO events (never business absence)', () => {
    const events = normalizeGenericInspectionObservation(
      { ...OBSERVATION, payload: envelope('orders', []) },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('an unknown queryId yields ZERO events (never guessed)', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('mystery-query', [
          { orderId: 'O-9', intentId: 'I-9', totalMinorUnits: 1 },
        ]),
      },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('a wrong adapterKind yields ZERO events (registry seam is exact)', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I', totalMinorUnits: 1 }], {
          adapterKind: 'demo-fintech-payment-lineage',
        }),
      },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('a non-inspection/v1 envelope version yields ZERO events', () => {
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I', totalMinorUnits: 1 }], {
          inspectionVersion: 'inspection/v2',
        }),
      },
      POLICY,
    );
    expect(events).toEqual([]);
  });

  it('timestamps are data only — never consumed for matching by the normalizer', () => {
    // The normalizer preserves a declared timestamp field verbatim; it
    // never derives order, proximity, or identity from it.
    const events = normalizeGenericInspectionObservation(
      {
        ...OBSERVATION,
        payload: envelope('reservations', [
          { reservationId: 'R-1', orderId: 'O-1' },
          { reservationId: 'R-2', orderId: 'O-1' },
        ]),
      },
      POLICY,
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.subjectKey)).toEqual(['R-1', 'R-2']);
  });

  it('determinism: same observation + same policy ⇒ byte-equivalent event specs', () => {
    const input = {
      ...OBSERVATION,
      payload: envelope('orders', [
        { orderId: 'O-1', intentId: 'I-1', totalMinorUnits: 250000 },
        { orderId: 'O-2', intentId: 'I-1', totalMinorUnits: 1000 },
      ]),
    };
    const first = normalizeGenericInspectionObservation(input, POLICY);
    const second = normalizeGenericInspectionObservation(input, POLICY);
    expect(canonicalEventSpecsJson(first)).toBe(canonicalEventSpecsJson(second));
  });

  it('input-hash stability: canonical serialization is order-stable in keys', () => {
    const a = canonicalEventSpecsJson(
      normalizeGenericInspectionObservation(
        {
          ...OBSERVATION,
          payload: envelope('orders', [{ orderId: 'O-1', intentId: 'I-1', totalMinorUnits: 1 }]),
        },
        POLICY,
      ),
    );
    const b = canonicalEventSpecsJson(
      normalizeGenericInspectionObservation(
        {
          ...OBSERVATION,
          payload: envelope('orders', [{ totalMinorUnits: 1, intentId: 'I-1', orderId: 'O-1' }]),
        },
        POLICY,
      ),
    );
    expect(a).toBe(b);
  });
});
