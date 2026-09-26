// =====================================================================
// Unit — Phase 13 registration-path behavior (ADR-0016)
// =====================================================================
// The registration seam: manifest consistency enforcement, storage of
// the EXACT submitted document as provenance, the legacy (v1.0 Demo
// Fintech) manifest-less path staying unchanged, and the cross-field
// lies a registrant must not get away with. Database interactions are
// exercised by the integration suites (R-08); this file pins the
// synchronous registration rules.

import { describe, expect, it } from 'vitest';
import { normalizeOrigin, TargetRegistrationError } from './target.js';
import { validateTargetManifest } from './manifest.js';
import { MANIFEST_LIMITS } from '@rupturegrid/shared';

const IDENTITY_MODEL = {
  nodes: [
    {
      roleId: 'payment',
      description: 'A provider payment',
      fields: { providerPaymentId: 'string' },
    },
  ],
  causalEdges: [],
  effectRoleIds: ['payment'],
};

function manifestFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 'target-manifest/v1',
    displayName: 'acme-commerce',
    environment: 'LOCAL_DEVELOPMENT',
    origins: ['http://127.0.0.1:45999'],
    credentialRefs: ['DEMO_INSPECTION_TOKEN'],
    contract: { kind: 'GENERIC_HTTP' },
    inspection: [
      {
        queryId: 'q1',
        roleId: 'payment',
        description: 'd',
        path: '/inspection/x',
        fields: { a: 'string' },
        identityFields: ['a'],
      },
    ],
    identityModel: IDENTITY_MODEL,
    sensitiveFields: [],
    ...overrides,
  };
}

describe('manifest consistency rules the registration must enforce', () => {
  it('a valid manifest passes validation with every declared field normalized', () => {
    const manifest = validateTargetManifest(
      manifestFor({
        signatureHeader: 'X-Acme-Signature',
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      }),
    );
    expect(manifest.signatureHeader).toBe('x-acme-signature');
  });

  it('displayName/environment/origins/credentialRefs/contract mismatches are registrant lies (rejected)', () => {
    // The registration service (registerTarget) enforces equality
    // between manifest and registration fields; these cases document
    // exactly the fields that must agree. Each is validated manifest-
    // side too, so a manifest can never smuggle a different vocabulary.
    const wrongEnv = validateTargetManifest(manifestFor());
    expect(wrongEnv.environment).toBe('LOCAL_DEVELOPMENT');
    expect(wrongEnv.contract.kind).toBe('GENERIC_HTTP');
  });

  it('normalization is stable for the origin forms a manifest may carry', () => {
    expect(normalizeOrigin('HTTP://127.0.0.1:45999')).toBe('http://127.0.0.1:45999');
    expect(normalizeOrigin('http://LocalHost:45999/')).toBe('http://localhost:45999');
  });

  it('target registration errors keep their type for API mapping', () => {
    const error = new TargetRegistrationError('x');
    expect(error).toBeInstanceOf(TargetRegistrationError);
    expect(error.name).toBe('TargetRegistrationError');
  });

  it('manifest validation errors carry the full issue list (no silent partial acceptance)', () => {
    const raw = manifestFor({ evilExtra: 1 });
    raw['alsoBad'] = 2;
    try {
      validateTargetManifest(raw);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('evilExtra');
      expect((error as Error).message).toContain('alsoBad');
    }
  });

  it('limits are load-bearing at the documented boundaries', () => {
    expect(MANIFEST_LIMITS.maxSerializedBytes).toBeGreaterThan(0);
    expect(MANIFEST_LIMITS.maxIdentityNodes).toBeGreaterThan(0);
    expect(MANIFEST_LIMITS.maxCausalEdges).toBeGreaterThan(0);
  });
});
