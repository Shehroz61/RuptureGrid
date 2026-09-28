// =====================================================================
// Phase 14 opaque-body security closure — unparseable bodies never
// persist raw text, hashes, or fingerprints (unit)
// =====================================================================
// The rule (security-boundaries §7, R-13, post-repair re-audit): for
// the GENERIC inspection path, if the response body cannot be parsed
// into the JSON structure the structural redaction walks, its raw
// opaque text is NEVER persisted and NEVER fingerprinted. The stored
// observation carries only safe bounded metadata (status, content
// type, observed byte count, truncated flag, parse status,
// deterministic reason code) and the fixed placeholder
// `[Opaque body omitted]`. No `password=`/`secret=`/`token=` regex
// guessing exists anywhere — security wins over literal fidelity.
//
// These tests exercise the REAL capture seam end to end at the unit
// boundary (a local HTTP fixture + a real in-memory-shaped store call
// through captureGenericInspectionQuery), asserting on the exact
// payload document that would be handed to durable persistence.

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import {
  captureGenericInspectionQuery,
  GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
} from './generic-inspection.js';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';

// Raw secret values that must appear NOWHERE in the persisted payload.
const SECRETS = [
  'supersecret',
  'password=supersecret',
  'my-secret-value',
  'apiKey=my-secret-value',
  'VERY_SECRET_TOKEN',
  'Bearer VERY_SECRET_TOKEN',
];

const POLICY: ManifestEvidencePolicy = {
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'probe',
      roleId: 'probe-role',
      description: 'Opaque-body probe surface',
      path: '/probe',
      fields: { probeId: 'string', state: 'string' },
      identityFields: ['probeId'],
    },
  ],
  identityModel: {
    nodes: [{ roleId: 'probe-role', description: 'A probe', fields: { probeId: 'string' } }],
    causalEdges: [],
    effectRoleIds: ['probe-role'],
  },
  sensitiveFields: [],
};

interface PersistedCapture {
  readonly payload: unknown;
  readonly contentHash: string;
}

/**
 * Drives the REAL capture path against a local fixture and intercepts
 * the exact payload document + content hash at the persistence
 * boundary (the RawObservationStore seam). The raw body text never
 * reaches this harness except through the payload under test.
 */
async function captureFromBody(
  status: number,
  contentType: string | null,
  body: string | null,
): Promise<PersistedCapture> {
  const fixture = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://fixture').pathname !== '/probe') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (contentType !== null) {
      res.writeHead(status, { 'content-type': contentType });
    } else {
      res.writeHead(status);
    }
    res.end(body ?? undefined);
  });
  await new Promise<void>((resolve) => {
    fixture.listen(0, '127.0.0.1', () => resolve());
  });
  const address = fixture.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const captured: { value: PersistedCapture | null } = { value: null };
    // Type-level seam: a capture whose payload contains ANY raw body
    // text would surface here verbatim and fail the assertions below.
    const stubTx = {
      $executeRaw: async () => 0,
      rawObservation: {
        findUnique: async () => null,
        create: async (input: { data: { payload: unknown; contentHash: string } }) => {
          captured.value = { payload: input.data.payload, contentHash: input.data.contentHash };
          return { id: 'stub-id', contentHash: input.data.contentHash, chainIndex: 0 };
        },
      },
      evidenceIntegrityHead: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
    };
    const stubPrisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stubTx),
    };
    await captureGenericInspectionQuery(stubPrisma as never, {
      runId: '00000000-0000-4000-8000-000000000000',
      stepRunId: null,
      origin,
      environment: 'LOCAL_DEVELOPMENT',
      policy: POLICY,
      queryId: 'probe',
      writerOwnerId: 'opaque-body-unit',
      writerFencingToken: null,
    });
    if (captured.value === null) {
      throw new Error('capture never reached the persistence boundary');
    }
    return captured.value;
  } finally {
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
  }
}

function observedOf(capture: { payload: unknown }): Record<string, unknown> {
  return (capture.payload as Record<string, unknown>)['observed'] as Record<string, unknown>;
}

describe('opaque-body security rule: unparseable bodies persist NO body content', () => {
  it('malformed JSON containing a secret persists no raw text, no fingerprint, only safe metadata', async () => {
    const capture = await captureFromBody(
      200,
      'application/json',
      '{"probeId": "P-1", "password": supersecret',
    );
    const json = JSON.stringify(capture.payload);
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toContain('supersecret');
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
    expect(observedOf(capture)['parseStatus']).toBe('invalid-json');
    const opaqueBody = observedOf(capture)['opaqueBody'] as Record<string, unknown>;
    expect(opaqueBody['reasonCode']).toBe('INVALID_JSON_BODY_NOT_PERSISTED');
    expect(opaqueBody['observedBodyBytes']).toBeGreaterThan(0);
    expect(typeof opaqueBody['observedBodyBytes']).toBe('number');
    // No property anywhere in the stored document carries a value
    // derived from the body's bytes (placeholder is fixed content-free).
    expect(JSON.stringify(Object.values(observedOf(capture)))).not.toMatch(
      /supersecret|my-secret-value|VERY_SECRET_TOKEN/,
    );
  });

  it('text/plain key=value bodies persist no raw text and no key/value regex salvage', async () => {
    const capture = await captureFromBody(
      200,
      'text/plain',
      'password=supersecret\napiKey=my-secret-value\nnote=hello',
    );
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('supersecret');
    expect(json).not.toContain('my-secret-value');
    expect(json).not.toContain('password=');
    expect(json).not.toContain('apiKey=');
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
    expect(observedOf(capture)['parseStatus']).toBe('invalid-json');
    expect((observedOf(capture)['opaqueBody'] as Record<string, unknown>)['reasonCode']).toBe(
      'INVALID_JSON_BODY_NOT_PERSISTED',
    );
  });

  it('text/html error bodies persist no markup and no embedded secrets', async () => {
    const capture = await captureFromBody(
      500,
      'text/html',
      '<html><body>error: supersecret in page</body></html>',
    );
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('supersecret');
    expect(json).not.toContain('<html>');
    expect(json).not.toContain('<body>');
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
    // Honest bounded metadata survived: status + content type.
    expect(observedOf(capture)['responseContentType']).toContain('text/html');
    expect((capture.payload as Record<string, unknown>)['adapterKind']).toBe(
      GENERIC_INSPECTION_ADAPTER_KIND,
    );
  });

  it('a plaintext bearer-token body persists no token', async () => {
    const capture = await captureFromBody(200, 'text/plain', 'Bearer VERY_SECRET_TOKEN');
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('VERY_SECRET_TOKEN');
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
  });

  it('a truncated over-cap body persists NO prefix of its bytes', async () => {
    const capture = await captureFromBody(
      200,
      'text/plain',
      `prefix-canary-NEVER-PERSIST${'x'.repeat(400_000)}`,
    );
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('prefix-canary-NEVER-PERSIST');
    expect(observedOf(capture)['truncated']).toBe(true);
    expect(observedOf(capture)['parseStatus']).toBe('not-attempted');
    const opaqueBody = observedOf(capture)['opaqueBody'] as Record<string, unknown>;
    expect(opaqueBody['reasonCode']).toBe('TRUNCATED_BODY_NOT_PERSISTED');
    // The honest observed byte count is the capped wire read.
    expect(opaqueBody['observedBodyBytes'] as number).toBeGreaterThan(0);
  });

  it('a parsed body whose REDACTED text exceeds the storage cap persists the redacted structure but NO cut text prefix', async () => {
    // Parity with the pre-closure cap semantics: the 16k bound applies
    // to the stored TEXT. An over-cap REDACTED serialization is not
    // persisted as text in any form (never a cut prefix), while the
    // REDACTED structured value — exactly what the pre-closure path
    // persisted — remains the durable truth, and the ADR-0021 verdict
    // is unchanged. A sensitive named value is masked BEFORE bounding.
    const big = {
      probeId: 'P-1',
      state: 'y'.repeat(40_000),
      password: 'supersecret',
    };
    const capture = await captureFromBody(200, 'application/json', JSON.stringify([big]));
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('supersecret');
    const observed = observedOf(capture);
    expect(observed['parseStatus']).toBe('parsed-json');
    expect(observed['responseJsonText']).toBeNull();
    expect((observed['opaqueBody'] as Record<string, unknown>)['reasonCode']).toBe(
      'OVER_CAP_BODY_NOT_PERSISTED',
    );
    // The redacted structured value persists in full (never a prefix).
    const responseJson = observed['responseJson'] as Array<Record<string, unknown>>;
    expect(responseJson[0]?.['password']).toBe('[Redacted]');
    expect((responseJson[0]?.['state'] as string).length).toBe(40_000);
  });

  it('non-2xx opaque responses persist honest status + provenance and NO body', async () => {
    const capture = await captureFromBody(
      503,
      'text/plain',
      'service unavailable: password=supersecret',
    );
    const json = JSON.stringify(capture.payload);
    expect(json).not.toContain('supersecret');
    expect(observedOf(capture)['responseContentType']).toContain('text/plain');
    const validation = (capture.payload as Record<string, unknown>)['validation'] as Record<
      string,
      unknown
    >;
    expect(validation['valid']).toBe(false);
    expect(validation['reasonCode']).toBe('HTTP_NON_SUCCESS');
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
  });

  it('a 204 (no body) persists the honest empty observation with the placeholder', async () => {
    const capture = await captureFromBody(204, null, '');
    const json = JSON.stringify(capture.payload);
    const observed = observedOf(capture);
    expect(observed['httpStatus']).toBe(204);
    expect(observed['parseStatus']).toBe('not-attempted');
    const opaqueBody = observed['opaqueBody'] as Record<string, unknown>;
    expect(opaqueBody['reasonCode']).toBe('NO_RESPONSE_BODY_OBSERVED');
    expect(opaqueBody['observedBodyBytes']).toBe(0);
    expect(json).toContain(GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER);
  });

  it('a transport failure persists NO_RESPONSE_OBSERVED and no body content', async () => {
    const fixture = createServer();
    await new Promise<void>((resolve) => {
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
    // Nothing is listening: a connection error — never a fabricated
    // response, never body content.
    const captured: { value: PersistedCapture | null } = { value: null };
    const stubTx = {
      $executeRaw: async () => 0,
      rawObservation: {
        findUnique: async () => null,
        create: async (input: { data: { payload: unknown; contentHash: string } }) => {
          captured.value = { payload: input.data.payload, contentHash: input.data.contentHash };
          return { id: 'stub-id', contentHash: input.data.contentHash, chainIndex: 0 };
        },
      },
      evidenceIntegrityHead: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
    };
    const stubPrisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stubTx),
    };
    await captureGenericInspectionQuery(stubPrisma as never, {
      runId: '00000000-0000-4000-8000-000000000001',
      stepRunId: null,
      origin,
      environment: 'LOCAL_DEVELOPMENT',
      policy: POLICY,
      queryId: 'probe',
      writerOwnerId: 'opaque-body-unit',
      writerFencingToken: null,
    });
    expect(captured.value).not.toBeNull();
    const payload = captured.value?.payload as Record<string, unknown> | undefined;
    const json = JSON.stringify(payload);
    expect((payload?.['observed'] as Record<string, unknown>)['httpStatus']).toBeNull();
    expect((payload?.['validation'] as Record<string, unknown>)['reasonCode']).toBe(
      'NO_RESPONSE_OBSERVED',
    );
    expect(json).not.toContain('supersecret');
  });

  it('valid parsed JSON still persists its REDACTED structured representation', async () => {
    const capture = await captureFromBody(
      200,
      'application/json',
      JSON.stringify([{ probeId: 'P-1', state: 'ok' }]),
    );
    const observed = observedOf(capture);
    expect(observed['parseStatus']).toBe('parsed-json');
    expect(observed['responseJson']).toEqual([{ probeId: 'P-1', state: 'ok' }]);
    expect(observed['responseJsonText']).toBe(JSON.stringify([{ probeId: 'P-1', state: 'ok' }]));
    expect(observed['opaqueBody']).toBeUndefined();
    expect((capture.payload as Record<string, unknown>)['validation']).toMatchObject({
      valid: true,
      reasonCode: 'VALID',
    });
  });

  it('valid JSON with declared-sensitive values redacts BEFORE the stored text and hash', async () => {
    const policy: ManifestEvidencePolicy = {
      ...POLICY,
      sensitiveFields: ['state'],
    };
    const fixture = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ probeId: 'P-1', state: '42 Secret Lane' }]));
    });
    await new Promise<void>((resolve) => {
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address() as AddressInfo;
    try {
      const captured: { value: PersistedCapture | null } = { value: null };
      const stubTx = {
        $executeRaw: async () => 0,
        rawObservation: {
          findUnique: async () => null,
          create: async (input: { data: { payload: unknown; contentHash: string } }) => {
            captured.value = { payload: input.data.payload, contentHash: input.data.contentHash };
            return { id: 'stub-id', contentHash: input.data.contentHash, chainIndex: 0 };
          },
        },
        evidenceIntegrityHead: { findUnique: async () => null, upsert: async () => ({}) },
      };
      const stubPrisma = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stubTx),
      };
      await captureGenericInspectionQuery(stubPrisma as never, {
        runId: '00000000-0000-4000-8000-000000000002',
        stepRunId: null,
        origin: `http://127.0.0.1:${address.port}`,
        environment: 'LOCAL_DEVELOPMENT',
        policy,
        queryId: 'probe',
        writerOwnerId: 'opaque-body-unit',
        writerFencingToken: null,
      });
      const json = JSON.stringify(captured.value?.payload);
      expect(json).not.toContain('42 Secret Lane');
      expect(json).toContain('[Redacted]');
      expect(observedOf(captured.value as PersistedCapture)['responseJsonText']).not.toContain(
        '42 Secret Lane',
      );
    } finally {
      await new Promise<void>((resolve) => {
        fixture.close(() => resolve());
      });
    }
  });
});
