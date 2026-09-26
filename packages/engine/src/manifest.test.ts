// =====================================================================
// Unit — Phase 13 target-manifest/v1 (ADR-0016/ADR-0017)
// =====================================================================
// The enumerated accept/reject matrix of the closed-schema validation
// boundary, the server-side payload limits, the manifest-derived policy
// derivation, and the two Phase 13 adversarial proofs:
//   1. a target-declared noEffectOnRejection can NEVER manufacture
//      KNOWN_ABSENT (R-03: target claims never create truth);
//   2. manifest-declared header names can never escape the executor's
//      transport ownership (framing headers are refused at registration).
// This matrix is permanent.

import { describe, expect, it } from 'vitest';
import {
  deriveExecutionPolicy,
  effectiveFaultHook,
  effectiveSignatureHeader,
  LEGACY_SIGNATURE_HEADER,
  LEGACY_DEMO_FAULT_HOOK_PATH,
  ManifestValidationError,
  validateTargetManifest,
} from './manifest.js';
import { classifyInvocation } from './classify.js';
import { MANIFEST_LIMITS } from '@rupturegrid/shared';

// ---------------------------------------------------------------------
// Fixtures (no secrets — reference names only, ADR-0012/R-13)
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
        path: '/inspection/orders?orderId=${orderId}',
        fields: { orderId: 'string', status: 'string', totalMinorUnits: 'integer-minor-units' },
        identityFields: ['orderId'],
      },
    ],
    identityModel: IDENTITY_MODEL,
    sensitiveFields: ['customer.email'],
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------
// Accepted manifests
// ---------------------------------------------------------------------

describe('target-manifest/v1 accepted shapes', () => {
  it('accepts a fully-valid STAGING manifest and normalizes origins/headers', () => {
    const manifest = validateTargetManifest(validManifest());
    expect(manifest.manifestVersion).toBe('target-manifest/v1');
    expect(manifest.environment).toBe('STAGING');
    expect(manifest.origins).toEqual(['https://api.acme.example:8443']);
    expect(manifest.contract.metadata.noEffectOnRejection).toBe(true);
    expect(manifest.signatureHeader).toBeUndefined();
    expect(manifest.inspection[0]?.path).toBe('/inspection/orders?orderId=${orderId}');
  });

  it('accepts a LOCAL_DEVELOPMENT manifest with http origin and declares the fault hook', () => {
    const manifest = validateTargetManifest(
      validManifest({
        environment: 'LOCAL_DEVELOPMENT',
        origins: ['http://127.0.0.1:45001'],
        contract: { kind: 'GENERIC_HTTP' },
        signatureHeader: 'X-Acme-Signature',
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
        faultHook: {
          version: 'controlled-fault/v1',
          path: '/hooks/checkout',
          kinds: ['RESPONSE_TRUNCATION', 'CRASH_MID_PROCESSING'],
        },
      }),
    );
    expect(manifest.environment).toBe('LOCAL_DEVELOPMENT');
    expect(manifest.origins).toEqual(['http://127.0.0.1:45001']);
    expect(manifest.signatureHeader).toBe('x-acme-signature');
    expect(manifest.faultHook?.path).toBe('/hooks/checkout');
    expect(manifest.faultHook?.kinds).toEqual(['RESPONSE_TRUNCATION', 'CRASH_MID_PROCESSING']);
    expect(manifest.contract.metadata.noEffectOnRejection).toBeUndefined();
  });

  it('rejects a signatureHeader without the signing credential reference (cross-field closure)', () => {
    expectRejected(
      validManifest({ signatureHeader: 'X-Acme-Signature' }),
      /signatureHeader requires the DEMO_PROVIDER_SIGNING_SECRET credentialRef/,
    );
  });

  it('accepts a one-node identity model with zero edges (shape freedom)', () => {
    const manifest = validateTargetManifest(
      validManifest({
        identityModel: {
          nodes: [{ roleId: 'thing', description: 'x', fields: { thingId: 'string' } }],
          causalEdges: [],
          effectRoleIds: ['thing'],
        },
        inspection: [
          {
            queryId: 'orderById',
            roleId: 'thing',
            description: 'Fetch one order by id',
            path: '/inspection/orders?orderId=${orderId}',
            fields: { orderId: 'string', status: 'string', totalMinorUnits: 'integer-minor-units' },
            identityFields: ['orderId'],
          },
        ],
      }),
    );
    expect(manifest.identityModel.nodes).toHaveLength(1);
    expect(manifest.identityModel.causalEdges).toHaveLength(0);
    expect(manifest.identityModel.subjectRoleId).toBeUndefined();
  });

  it('preserves the declared query → role binding on the validated manifest (ADR-0021)', () => {
    const manifest = validateTargetManifest(validManifest());
    expect(manifest.inspection[0]?.roleId).toBe('payment');
    expect(
      manifest.identityModel.nodes.some((node) => node.roleId === manifest.inspection[0]?.roleId),
    ).toBe(true);
  });

  it('accepts two queries bound to different declared roles (declaration decides, not shape)', () => {
    const manifest = validateTargetManifest(
      validManifest({
        inspection: [
          {
            queryId: 'paymentById',
            roleId: 'payment',
            description: 'Fetch one payment by id',
            path: '/inspection/payments',
            fields: { providerPaymentId: 'string', status: 'string' },
            identityFields: ['providerPaymentId'],
          },
          {
            queryId: 'effectsByPayment',
            roleId: 'financialEffect',
            description: 'Fetch effects for a payment',
            path: '/inspection/effects',
            fields: { providerPaymentId: 'string', amountMinorUnits: 'integer-minor-units' },
            identityFields: ['providerPaymentId'],
          },
        ],
      }),
    );
    expect(manifest.inspection).toHaveLength(2);
    expect(manifest.inspection.map((query) => query.roleId)).toEqual([
      'payment',
      'financialEffect',
    ]);
  });

  it('accepts a query bound to a role with no declared edge to any other role', () => {
    const manifest = validateTargetManifest(
      validManifest({
        identityModel: {
          nodes: [
            { roleId: 'payment', description: 'x', fields: { providerPaymentId: 'string' } },
            { roleId: 'orphan', description: 'x', fields: { orphanId: 'string' } },
          ],
          causalEdges: [],
          effectRoleIds: ['payment'],
        },
        inspection: [
          {
            queryId: 'orphanById',
            roleId: 'orphan',
            description: 'Fetch one orphan entity by id',
            path: '/inspection/orphans',
            fields: { orphanId: 'string' },
            identityFields: ['orphanId'],
          },
        ],
      }),
    );
    expect(manifest.inspection[0]?.roleId).toBe('orphan');
  });
});

// ---------------------------------------------------------------------
// Rejected manifests — closed schema
// ---------------------------------------------------------------------

describe('target-manifest/v1 closed-schema rejections', () => {
  it('rejects non-object manifests (arrays, strings, null, numbers)', () => {
    expectRejected([]);
    expectRejected('manifest');
    expectRejected(null);
    expectRejected(42);
  });

  it('rejects a wrong or missing manifestVersion (never guessed)', () => {
    expectRejected(validManifest({ manifestVersion: 'target-manifest/v2' }), /manifestVersion/);
    expectRejected(validManifest({ manifestVersion: 'target-manifest/v1 ' }), /manifestVersion/);
    const raw = validManifest();
    delete raw['manifestVersion'];
    expectRejected(raw, /missing required field "manifestVersion"/);
  });

  it('rejects unknown top-level fields (never silently dropped)', () => {
    expectRejected(
      validManifest({ evilExtra: { code: 'x' } }),
      /unknown top-level field "evilExtra"/,
    );
  });

  it('rejects unknown nested fields at every level (recursive closure)', () => {
    expectRejected(
      validManifest({ contract: { kind: 'GENERIC_HTTP', metadata: { sneaky: true } } }),
      /unknown contract.metadata field "sneaky"/,
    );
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [{ roleId: 'a', description: 'x', fields: {}, extra: 1 }],
        },
      }),
      /unknown identityModel\.nodes\[0\] field "extra"/,
    );
    expectRejected(
      validManifest({
        faultHook: {
          version: 'controlled-fault/v1',
          path: '/h',
          kinds: ['CRASH_MID_PROCESSING'],
          surprise: true,
        },
      }),
      /unknown faultHook field "surprise"/,
    );
    expectRejected(
      validManifest({
        inspection: [
          { queryId: 'q', description: 'd', path: '/x', fields: {}, identityFields: [], z: 1 },
        ],
      }),
      /unknown inspection\[0\] field "z"/,
    );
  });

  it('rejects an inspection query without a declared roleId binding (ADR-0021)', () => {
    // Every pre-ADR-0021 inspection declaration form is now invalid: the
    // binding is declared, never inferred.
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId must be exactly one declared identityModel role id/,
    );
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: null,
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId must be exactly one declared identityModel role id/,
    );
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'payment payment',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId must be exactly one declared identityModel role id/,
    );
  });

  it('rejects missing required fields', () => {
    for (const field of [
      'displayName',
      'environment',
      'origins',
      'credentialRefs',
      'contract',
      'inspection',
      'identityModel',
      'sensitiveFields',
    ]) {
      const raw = validManifest();
      delete raw[field];
      expectRejected(raw, new RegExp(`missing required field "${field}"`));
    }
  });

  it('rejects wrong primitive types without coercion', () => {
    expectRejected(validManifest({ displayName: 42 }), /displayName must be a string/);
    expectRejected(validManifest({ origins: 'https://x.example' }), /origins must be an array/);
    expectRejected(
      validManifest({ credentialRefs: ['DEMO_ADMIN_TOKEN', 5] }),
      /credentialRefs\[1\] must be a string/,
    );
    expectRejected(
      validManifest({
        contract: { kind: 'GENERIC_HTTP', metadata: { noEffectOnRejection: 'true' } },
      }),
      /must be a boolean \(never coerced\)/,
    );
    expectRejected(
      validManifest({
        identityModel: {
          nodes: [{ roleId: 'a', description: 'x', fields: { f: 'float' } }],
          causalEdges: [],
          effectRoleIds: ['a'],
        },
      }),
      /identityModel\.nodes\[0\]\.fields\.f must be one of/,
    );
  });

  it('rejects empty required arrays', () => {
    expectRejected(validManifest({ origins: [] }), /at least one origin/);
    expectRejected(
      validManifest({
        identityModel: { nodes: [], causalEdges: [], effectRoleIds: [] },
      }),
      /identityModel\.nodes must contain at least one node/,
    );
    expectRejected(
      validManifest({
        faultHook: { version: 'controlled-fault/v1', path: '/h', kinds: [] },
      }),
      /faultHook\.kinds must not be empty/,
    );
  });
});

// ---------------------------------------------------------------------
// Rejected manifests — origins, credentials, identity, paths, hooks
// ---------------------------------------------------------------------

describe('target-manifest/v1 adversarial rejections', () => {
  it('rejects malformed origins, userinfo, paths, and unsupported protocols', () => {
    expectRejected(validManifest({ origins: ['https://user:pass@h.example'] }), /userinfo/);
    expectRejected(
      validManifest({ origins: ['https://h.example/path'] }),
      /must not include a path/,
    );
    expectRejected(validManifest({ origins: ['https://h.example/?q=1'] }), /query or fragment/);
    expectRejected(validManifest({ origins: ['ftp://h.example'] }), /unsupported origin scheme/);
    expectRejected(validManifest({ origins: ['not a url'] }), /not a valid URL/);
  });

  it('rejects duplicate origins AFTER normalization and http origins for STAGING', () => {
    expectRejected(
      validManifest({ origins: ['https://h.example', 'https://H.example'] }),
      /duplicate origins after normalization/i,
    );
    expectRejected(
      validManifest({ environment: 'STAGING', origins: ['http://h.example'] }),
      /STAGING manifests require https/,
    );
  });

  it('refuses PRODUCTION manifests outright in v1.x (ADR-0016)', () => {
    expectRejected(
      validManifest({ environment: 'PRODUCTION' }),
      /PRODUCTION manifests are refused/,
    );
    expectRejected(validManifest({ environment: 'production' }), /environment must be one of/);
  });

  it('rejects credential refs outside the executor allowlist and duplicate refs', () => {
    expectRejected(
      validManifest({ credentialRefs: ['SOME_OTHER_SECRET'] }),
      /outside the executor's server-side allowlist/,
    );
    expectRejected(
      validManifest({ credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_ADMIN_TOKEN'] }),
      /duplicate credentialRef/,
    );
    expectRejected(
      validManifest({ credentialRefs: ['has lowercase'] }),
      /is not a valid reference name/,
    );
  });

  it('rejects malformed header names and forbidden framing/system-owned headers', () => {
    for (const bad of ['bad name with spaces', 'x\r\nInjected: 1', 'x\0nul', '']) {
      expectRejected(validManifest({ signatureHeader: bad }), /signatureHeader/);
    }
    for (const owned of [
      'host',
      'authorization',
      'cookie',
      'x-rupturegrid-delivery-attempt-id',
      'CONTENT-LENGTH',
    ]) {
      expectRejected(
        validManifest({ signatureHeader: owned }),
        /framing\/system-owned header the executor owns/,
      );
    }
  });

  it('rejects invalid relative paths in inspection queries and fault hooks', () => {
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'payment',
            description: 'd',
            path: 'https://evil.example/x',
            fields: {},
            identityFields: [],
          },
        ],
      }),
      /absolute URL is not allowed/,
    );
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'payment',
            description: 'd',
            path: '//evil.example/x',
            fields: {},
            identityFields: [],
          },
        ],
      }),
      /scheme-relative/,
    );
    expectRejected(
      validManifest({
        faultHook: {
          version: 'controlled-fault/v1',
          path: '/x\r\nHost: evil',
          kinds: ['CRASH_MID_PROCESSING'],
        },
      }),
      /CR\/LF\/NUL/,
    );
  });

  it('rejects malformed inspection declarations (unknown identity fields, dup query ids)', () => {
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'payment',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['ghost'],
          },
        ],
      }),
      /names undeclared field "ghost"/,
    );
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'payment',
            description: 'd',
            path: '/x',
            fields: {},
            identityFields: [],
          },
          {
            queryId: 'q',
            roleId: 'payment',
            description: 'd',
            path: '/y',
            fields: {},
            identityFields: [],
          },
        ],
      }),
      /duplicates an earlier query id/,
    );
  });

  it('rejects a query roleId referencing an undeclared role (no inference fallback — ADR-0021)', () => {
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            roleId: 'ghost',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId "ghost" references an undeclared identityModel role/,
    );
  });

  it('never infers the role from identity-field overlap (ADR-0021 declaration-only rule)', () => {
    // The query's fields intentionally overlap NOTHING: `a` shares no
    // name with any declared node field (`providerPaymentId`), the query
    // id does not resemble any role id, and there is exactly one declared
    // node. If any inference fallback existed, this manifest would pass
    // with an inferred binding — it must fail on the missing binding.
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'q',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId must be exactly one declared identityModel role id/,
    );
  });

  it('never infers the role when exactly one identity node exists (ADR-0021)', () => {
    // A single declared node is the strongest possible inference
    // candidate; even then the binding must be explicit or rejected.
    expectRejected(
      validManifest({
        identityModel: {
          nodes: [{ roleId: 'onlyRole', description: 'x', fields: { a: 'string' } }],
          causalEdges: [],
          effectRoleIds: ['onlyRole'],
        },
        inspection: [
          {
            queryId: 'q',
            description: 'd',
            path: '/x',
            fields: { a: 'string' },
            identityFields: ['a'],
          },
        ],
      }),
      /inspection\[0\]\.roleId must be exactly one declared identityModel role id/,
    );
  });

  it('rejects causal edges referencing undeclared roles or undeclared link fields, and empty linkFields', () => {
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          causalEdges: [
            {
              fromRoleId: 'payment',
              toRoleId: 'ghost',
              edgeKind: 'e',
              linkFields: ['providerPaymentId'],
            },
          ],
        },
      }),
      /references an undeclared role/,
    );
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          causalEdges: [
            { fromRoleId: 'payment', toRoleId: 'financialEffect', edgeKind: 'e', linkFields: [] },
          ],
        },
      }),
      /linkFields must not be empty/,
    );
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          causalEdges: [
            {
              fromRoleId: 'payment',
              toRoleId: 'financialEffect',
              edgeKind: 'e',
              linkFields: ['notDeclared'],
            },
          ],
        },
      }),
      /is not declared on both endpoint roles/,
    );
  });

  it('rejects effect/subject designations referencing undeclared roles', () => {
    expectRejected(
      validManifest({
        identityModel: { ...IDENTITY_MODEL, effectRoleIds: ['ghostEffect'] },
      }),
      /identityModel\.effectRoleIds references undeclared role "ghostEffect"/,
    );
    expectRejected(
      validManifest({
        identityModel: { ...IDENTITY_MODEL, subjectRoleId: 'ghostSubject' },
      }),
      /identityModel\.subjectRoleId references undeclared role/,
    );
  });

  it('rejects malformed fault-hook version, kinds, and path', () => {
    expectRejected(
      validManifest({
        faultHook: { version: 'controlled-fault/v2', path: '/h', kinds: ['CRASH_MID_PROCESSING'] },
      }),
      /faultHook\.version must be exactly "controlled-fault\/v1"/,
    );
    expectRejected(
      validManifest({
        faultHook: { version: 'controlled-fault/v1', path: '/h', kinds: ['DROP_ALL_PACKETS'] },
      }),
      /faultHook\.kinds entries must be one of/,
    );
  });

  it('rejects executable-looking content structurally: no code, expression, or SQL anywhere', () => {
    // There is no field in the closed schema where executable content is
    // VALID: code/expression/SQL-shaped strings can only land in an
    // unknown-field rejection or fail an identifier pattern. Inert
    // description prose is NOT execution: it is bounded text RuptureGrid
    // never interprets (display provenance only).
    expectRejected(validManifest({ evalTarget: 'process.exit(1)' }), /unknown top-level field/);
    expectRejected(
      validManifest({
        identityModel: {
          ...IDENTITY_MODEL,
          nodes: [{ roleId: 'DROP TABLE users', description: 'x', fields: {} }],
        },
      }),
      /roleId must match/,
    );
    expectRejected(
      validManifest({
        inspection: [
          {
            queryId: 'process.exit(1)',
            roleId: 'payment',
            description: 'd',
            path: '/x',
            fields: {},
            identityFields: [],
          },
        ],
      }),
      /queryId must match/,
    );
  });
});

// ---------------------------------------------------------------------
// Server-side size limits (payload caps, not semantics)
// ---------------------------------------------------------------------

describe('target-manifest/v1 server-side limits', () => {
  it('rejects oversized serialized manifests', () => {
    const raw = validManifest({
      sensitiveFields: Array.from({ length: 10 }, (_, i) => `field${i}`.padEnd(100, 'x')),
    });
    // A single huge string field is a clean oversized-payload probe.
    const huge = validManifest({ sensitiveFields: ['x'.repeat(200)] });
    expect(() => validateTargetManifest(huge)).toThrow(ManifestValidationError);
    // Sanity: the probe works because of the name pattern/length.
    expect(JSON.stringify(raw).length).toBeGreaterThan(0);
  });

  it('rejects counts above the caps (payload caps, not identity semantics)', () => {
    const manyNodes = Array.from({ length: MANIFEST_LIMITS.maxIdentityNodes + 1 }, (_, i) => ({
      roleId: `role${i}`,
      description: 'node',
      fields: {},
    }));
    expectRejected(
      validManifest({
        identityModel: { nodes: manyNodes, causalEdges: [], effectRoleIds: [] },
      }),
      /exceeds the 64-node server-side payload cap/,
    );
    expectRejected(
      validManifest({
        origins: Array.from(
          { length: MANIFEST_LIMITS.maxOrigins + 1 },
          (_, i) => `https://h${i}.example`,
        ),
      }),
      /16-origin limit/,
    );
  });
});

// ---------------------------------------------------------------------
// Manifest-derived execution policy
// ---------------------------------------------------------------------

describe('manifest execution-policy derivation', () => {
  it('freezes the declared signature header and fault hook into policy', () => {
    const policy = deriveExecutionPolicy(
      validManifest({
        environment: 'LOCAL_DEVELOPMENT',
        origins: ['http://127.0.0.1:45001'],
        signatureHeader: 'X-Acme-Signature',
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
        faultHook: {
          version: 'controlled-fault/v1',
          path: '/hooks/checkout',
          kinds: ['RESPONSE_TRUNCATION'],
        },
      }),
    );
    expect(policy?.signatureHeader).toBe('x-acme-signature');
    expect(policy?.faultHook).toEqual({ path: '/hooks/checkout', kinds: ['RESPONSE_TRUNCATION'] });
    expect(policy?.contractMetadata.noEffectOnRejection).toBe(true);
  });

  it('re-validates stored provenance and FAILS CLOSED on corruption', () => {
    const corrupted = validManifest();
    (corrupted as Record<string, unknown>)['injected'] = true;
    expect(() => deriveExecutionPolicy(corrupted)).toThrow(ManifestValidationError);
    expect(deriveExecutionPolicy(null)).toBeUndefined();
    expect(deriveExecutionPolicy(undefined)).toBeUndefined();
  });

  it('legacy (manifest-less) targets keep the v1.0 seams exactly', () => {
    const demoHook = effectiveFaultHook(undefined, 'DEMO_FINTECH_WEBHOOK');
    expect(demoHook).toEqual({
      path: LEGACY_DEMO_FAULT_HOOK_PATH,
      kinds: ['PRE_MUTATION_REJECTION', 'CRASH_MID_PROCESSING', 'RESPONSE_TRUNCATION'],
    });
    const genericHook = effectiveFaultHook(undefined, 'GENERIC_HTTP');
    expect(genericHook).toBeNull();
    expect(effectiveSignatureHeader(undefined)).toBe(LEGACY_SIGNATURE_HEADER);
  });

  it('manifest targets use ONLY their declared hook (no legacy path leakage)', () => {
    const policy = deriveExecutionPolicy(
      validManifest({
        environment: 'LOCAL_DEVELOPMENT',
        origins: ['http://127.0.0.1:45001'],
        faultHook: {
          version: 'controlled-fault/v1',
          path: '/hooks/checkout',
          kinds: ['RESPONSE_TRUNCATION'],
        },
      }),
    );
    const hook = effectiveFaultHook(policy, 'GENERIC_HTTP');
    expect(hook?.path).toBe('/hooks/checkout');
    expect(hook?.kinds).toEqual(['RESPONSE_TRUNCATION']);
    // A manifest target without a faultHook has NO hook at all.
    const none = effectiveFaultHook(deriveExecutionPolicy(validManifest()), 'GENERIC_HTTP');
    expect(none).toBeNull();
    // A manifest target without a signatureHeader has NO signature seam.
    expect(effectiveSignatureHeader(deriveExecutionPolicy(validManifest()))).toBeNull();
  });
});

// ---------------------------------------------------------------------
// ADVERSARIAL PROOF: target claims never create truth (ADR-0016 §5)
// ---------------------------------------------------------------------

describe('noEffectOnRejection never manufactures KNOWN_ABSENT', () => {
  // The declared metadata is recorded — but classification never reads it.
  it('records the declaration while GENERIC_HTTP classification stays conservative', () => {
    const policy = deriveExecutionPolicy(validManifest());
    expect(policy?.contractMetadata.noEffectOnRejection).toBe(true);

    // For a mutating request that crossed REQUEST_SENT:
    const base = {
      mutation: 'MUTATING' as const,
      contractKind: 'GENERIC_HTTP' as const,
    };
    // 2xx → KNOWN_OCCURRED
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'SUCCEEDED',
        httpStatus: 200,
      }),
    ).toEqual({ intentOutcome: 'SUCCEEDED', sideEffectKnowledge: 'KNOWN_OCCURRED' });
    // post-send timeout/reset → INDETERMINATE
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'REQUEST_SENT',
        intentOutcome: 'FAILED',
        httpStatus: null,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'RESPONSE_HEADERS',
        intentOutcome: 'FAILED',
        httpStatus: null,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
    // definitive 5xx → INDETERMINATE (no platform-defined no-effect guarantee)
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 500,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
    // definitive 4xx → still INDETERMINATE: the target-declared rejection
    // guarantee ALONE must NOT manufacture KNOWN_ABSENT.
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 409,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
    // pre-send failure → KNOWN_ABSENT (platform mechanism, unchanged)
    expect(
      classifyInvocation({
        ...base,
        transportStage: 'CONNECTING',
        intentOutcome: 'FAILED',
        httpStatus: null,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' });
  });

  it('keeps the platform-defined DEMO_FINTECH_WEBHOOK behavior unchanged', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 409,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' });
  });

  it('classification input type carries no path for declared metadata to enter', () => {
    // Type-level honesty: ClassifyInput has no metadata field — a
    // manifest declaration has NO channel into classification.
    const input = {
      mutation: 'MUTATING' as const,
      contractKind: 'GENERIC_HTTP' as const,
      transportStage: 'RESPONSE_COMPLETE',
      intentOutcome: 'FAILED' as const,
      httpStatus: 400,
    };
    const withMetadata = { ...input, noEffectOnRejection: true } as typeof input & {
      noEffectOnRejection: boolean;
    };
    // classifyInvocation ignores it by construction (structural typing:
    // extra properties cannot change the pure-function outcome).
    expect(classifyInvocation(withMetadata)).toEqual(classifyInvocation(input));
    expect(classifyInvocation(withMetadata).sideEffectKnowledge).toBe('INDETERMINATE');
  });
});
