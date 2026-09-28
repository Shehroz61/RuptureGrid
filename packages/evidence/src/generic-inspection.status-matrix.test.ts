// =====================================================================
// Phase 14 blocker repair B-5 — HTTP status gates business normalization
// =====================================================================
// The status matrix: business normalization is eligible ONLY for
// 2xx. Every actually observed HTTP response remains an HONEST
// persisted observation; but a shape-valid JSON array body from a
// 3xx/4xx/5xx (or a 204 with no body) can never become business
// events. Zero events is the only outcome for every non-2xx status.
//
// The unit layer proves the normalization gate (the pure seam the
// derivation consumes); the integration layer proves the same matrix
// through real HTTP + real PostgreSQL.

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';
import {
  GENERIC_INSPECTION_NORMALIZER_NAME,
  GENERIC_INSPECTION_NORMALIZER_VERSION,
} from './versions.js';
import { normalizeGenericInspectionObservation } from './generic-normalizer.js';

const POLICY: ManifestEvidencePolicy = {
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'Orders',
      path: '/inspection/orders',
      fields: { orderId: 'string', totalMinorUnits: 'integer-minor-units' },
      identityFields: ['orderId'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'order',
        description: 'An order',
        fields: { orderId: 'string', totalMinorUnits: 'integer-minor-units' },
      },
    ],
    causalEdges: [],
    effectRoleIds: ['order'],
  },
  sensitiveFields: [],
};

const VALID_ARRAY = [{ orderId: 'ORD-1', totalMinorUnits: 500000 }];

function envelopeFor(httpStatus: number | null, body: string | null, parsed: unknown) {
  const parseStatus =
    body === null ? 'not-attempted' : parsed !== undefined ? 'parsed-json' : 'invalid-json';
  return {
    envelopeVersion: 'generic-inspection-observation/v1' as const,
    adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
    declaration: {
      inspectionVersion: 'inspection/v1' as const,
      queryId: 'orders',
      roleId: 'order',
      path: '/inspection/orders',
    },
    observed: {
      httpStatus,
      responseContentType: null,
      parseStatus,
      truncated: false,
      responseJsonText: parseStatus === 'parsed-json' ? JSON.stringify(parsed) : null,
      ...(parseStatus === 'parsed-json' ? { responseJson: parsed } : {}),
      ...(parseStatus === 'not-attempted'
        ? {
            opaqueBody: {
              placeholder: '[Opaque body omitted]',
              reasonCode: 'NO_RESPONSE_BODY_OBSERVED',
              observedBodyBytes: 0,
            },
          }
        : {}),
    },
    validation: { valid: true, reasonCode: 'VALID', detail: 'capture matches the declared schema' },
    redaction: { policyVersion: 'evidence-redaction-v1', applied: false },
  };
}

function normalize(envelope: ReturnType<typeof envelopeFor>) {
  return normalizeGenericInspectionObservation(
    {
      contentHash: 'hash-status-matrix',
      chainIndex: 0,
      payload: envelope,
    },
    POLICY,
  );
}

function envelopeFromCapture(
  httpStatus: number | null,
  responseText: string | null,
  parsedJson: unknown,
) {
  // Build the envelope the way the capture path would — then prove the
  // normalization gate refuses non-2xx captures EVEN IF a buggy writer
  // had marked them valid.
  const env = envelopeFor(httpStatus, responseText, parsedJson);
  return env;
}

describe('B-5: 2xx valid arrays normalize into business events', () => {
  it('200 with a valid array yields the declared role events', () => {
    const events = normalize(envelopeFromCapture(200, JSON.stringify(VALID_ARRAY), VALID_ARRAY));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('order');
    expect(events[0]?.normalizerName).toBe(GENERIC_INSPECTION_NORMALIZER_NAME);
    expect(events[0]?.normalizerVersion).toBe(GENERIC_INSPECTION_NORMALIZER_VERSION);
  });

  it('201/202 with valid arrays still normalize (the 2xx window is [200,300))', () => {
    for (const status of [201, 202, 299]) {
      const events = normalize(
        envelopeFromCapture(status, JSON.stringify(VALID_ARRAY), VALID_ARRAY),
      );
      expect(events).toHaveLength(1);
    }
  });
});

describe('B-5: non-2xx with shape-valid array bodies yield ZERO events', () => {
  it('301 (redirect observed, never followed)', () => {
    expect(normalize(envelopeFromCapture(301, JSON.stringify(VALID_ARRAY), VALID_ARRAY))).toEqual(
      [],
    );
  });

  it('400 with a valid-array error body', () => {
    expect(normalize(envelopeFromCapture(400, JSON.stringify(VALID_ARRAY), VALID_ARRAY))).toEqual(
      [],
    );
  });

  it('404 with a valid-array body', () => {
    expect(normalize(envelopeFromCapture(404, JSON.stringify(VALID_ARRAY), VALID_ARRAY))).toEqual(
      [],
    );
  });

  it('500 with a valid-array body', () => {
    expect(normalize(envelopeFromCapture(500, JSON.stringify(VALID_ARRAY), VALID_ARRAY))).toEqual(
      [],
    );
  });

  it('503 with a valid-array body', () => {
    expect(normalize(envelopeFromCapture(503, JSON.stringify(VALID_ARRAY), VALID_ARRAY))).toEqual(
      [],
    );
  });

  it('every non-2xx status in the matrix yields zero events', () => {
    for (const status of [301, 302, 400, 401, 404, 409, 429, 500, 502, 503]) {
      expect(
        normalize(envelopeFromCapture(status, JSON.stringify(VALID_ARRAY), VALID_ARRAY)),
      ).toEqual([]);
    }
  });

  it('a missing status (transport failure) yields zero events', () => {
    expect(normalize(envelopeFromCapture(null, null, undefined))).toEqual([]);
  });
});

describe('B-5: 204 / empty-body 2xx', () => {
  it('204 (no body) yields zero events — inspection/v1 requires a JSON array body', () => {
    expect(normalize(envelopeFromCapture(204, '', undefined))).toEqual([]);
  });

  it('200 with an empty body is not a valid array (honest observation, zero events)', () => {
    expect(normalize(envelopeFromCapture(200, '', undefined))).toEqual([]);
  });
});

describe('B-5: truncation gate (B-1 provenance, defense in depth)', () => {
  it('a truncated capture never normalizes, even if marked valid', () => {
    const env = envelopeFromCapture(200, JSON.stringify(VALID_ARRAY), VALID_ARRAY);
    (env.observed as { truncated: boolean }).truncated = true;
    expect(normalize(env)).toEqual([]);
  });
});
