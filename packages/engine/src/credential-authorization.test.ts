// =====================================================================
// Unit — Phase 16 ADR-0024 platform credential authorization
// =====================================================================
// The frozen contract cases of ADR-0024 (§11 scenarios, §18 invariants,
// and the "Required implementation test matrix" items 2–8, 15–19, 21–27
// at the pure-policy level; registration- and snapshot-level cases run
// as integration tests over real PostgreSQL). This file is permanent.
//
// NOTHING here uses a naming heuristic: the signing classification and
// the grants are EXPLICIT platform data. Reference NAMES may appear in
// issues; secret VALUES can never (the policy layer carries names
// only — R-13/ADR-0012).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
  CredentialAuthorizationError,
  assertCredentialRefsAuthorized,
  authorizedRefsForTarget,
  resolveSignatureCredentialBinding,
  targetOriginCredentialPolicyIssues,
} from './credential-authorization.js';
import {
  EXECUTOR_CREDENTIAL_REFS,
  EXECUTOR_SIGNING_CREDENTIAL_REFS,
  assertSigningSubsetInvariant,
  parseTargetOriginCredentialGrants,
} from '@rupturegrid/config';

const PROVIDER_REF = 'DEMO_PROVIDER_SIGNING_SECRET';
const COMMERCE_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const ADMIN_REF = 'DEMO_ADMIN_TOKEN';

const ORIGIN_A = 'http://127.0.0.1:45001';
const ORIGIN_B = 'http://127.0.0.1:45002';

function policyFor(
  grants: Readonly<Record<string, readonly string[]>>,
  signingRefs: readonly string[] = EXECUTOR_SIGNING_CREDENTIAL_REFS,
) {
  return { signingCredentialRefs: [...signingRefs], originGrants: grants };
}

// ---------------------------------------------------------------------
// Configuration invariants (ADR-0024 §18)
// ---------------------------------------------------------------------

describe('platform credential configuration invariants (ADR-0024 §18)', () => {
  it('the shipped sets satisfy EXECUTOR_SIGNING ⊆ EXECUTOR (startup invariant holds)', () => {
    expect(() => assertSigningSubsetInvariant()).not.toThrow();
    for (const ref of EXECUTOR_SIGNING_CREDENTIAL_REFS) {
      expect(EXECUTOR_CREDENTIAL_REFS).toContain(ref);
    }
    expect(EXECUTOR_SIGNING_CREDENTIAL_REFS).toContain(PROVIDER_REF);
    expect(EXECUTOR_SIGNING_CREDENTIAL_REFS).toContain(COMMERCE_REF);
  });

  it('a signing ref outside the executor set FAILS FAST (matrix case 7)', () => {
    expect(() => assertSigningSubsetInvariant([PROVIDER_REF], ['SOME_SIGNING_REF'])).toThrow(
      /must be a subset of EXECUTOR_CREDENTIAL_REFS/,
    );
  });

  it('a grant naming a ref outside the executor set fails policy validation (matrix case 30)', () => {
    const issues = targetOriginCredentialPolicyIssues(
      policyFor({ [ORIGIN_A]: [PROVIDER_REF, 'STALE_REF'] }),
    );
    expect(
      issues.some(
        (issue) =>
          issue.includes('STALE_REF') && issue.includes('outside EXECUTOR_CREDENTIAL_REFS'),
      ),
    ).toBe(true);
  });

  it('a grant keyed by a non-normalized origin fails policy validation', () => {
    const issues = targetOriginCredentialPolicyIssues(policyFor({ 'HTTP://LOCALHOST:9000/': [] }));
    expect(issues.length).toBeGreaterThan(0);
  });

  it('duplicate refs within one grant fail policy validation', () => {
    const issues = targetOriginCredentialPolicyIssues(
      policyFor({ [ORIGIN_A]: [PROVIDER_REF, PROVIDER_REF] }),
    );
    expect(issues.some((issue) => issue.includes('duplicates'))).toBe(true);
  });

  it('the environment grant parser enforces the same content model', () => {
    expect(parseTargetOriginCredentialGrants(undefined)).toEqual({});
    expect(parseTargetOriginCredentialGrants('')).toEqual({});
    expect(parseTargetOriginCredentialGrants(`{"${ORIGIN_A}":["${PROVIDER_REF}"]}`)).toEqual({
      [ORIGIN_A]: [PROVIDER_REF],
    });
    expect(() => parseTargetOriginCredentialGrants('not json')).toThrow(/JSON object/);
    expect(() => parseTargetOriginCredentialGrants('[]')).toThrow(/JSON object/);
    expect(() => parseTargetOriginCredentialGrants(`{"${ORIGIN_A}":["STALE_REF"]}`)).toThrow(
      /outside EXECUTOR_CREDENTIAL_REFS/,
    );
    expect(() => parseTargetOriginCredentialGrants(`{"${ORIGIN_A}":"${PROVIDER_REF}"}`)).toThrow(
      /must be an array/,
    );
    // Non-normalized origin keys fail fast rather than being silently
    // normalized (grants are keyed by the exact stored authority).
    expect(() => parseTargetOriginCredentialGrants('{"http://LOCALHost:9000/x":[]}')).toThrow(
      /not in normalized form/,
    );
  });
});

// ---------------------------------------------------------------------
// Multi-origin authorization semantics (ADR-0024 §5–§6)
// ---------------------------------------------------------------------

describe('target-origin authorization (ADR-0024 §5–§6)', () => {
  it('intersection semantics: a ref granted for origin A only is NOT authorized for A+B (matrix case 26)', () => {
    const policy = policyFor({ [ORIGIN_A]: [PROVIDER_REF] });
    const authorized = authorizedRefsForTarget(policy, [ORIGIN_A, ORIGIN_B]);
    expect(authorized.has(PROVIDER_REF)).toBe(false);
    expect(() =>
      assertCredentialRefsAuthorized(policy, [ORIGIN_A, ORIGIN_B], [PROVIDER_REF]),
    ).toThrow(CredentialAuthorizationError);
  });

  it('intersection semantics: a ref granted for EVERY origin is authorized (matrix case 27)', () => {
    const policy = policyFor({
      [ORIGIN_A]: [PROVIDER_REF],
      [ORIGIN_B]: [PROVIDER_REF, COMMERCE_REF],
    });
    const authorized = authorizedRefsForTarget(policy, [ORIGIN_A, ORIGIN_B]);
    expect(authorized.has(PROVIDER_REF)).toBe(true);
    expect(authorized.has(COMMERCE_REF)).toBe(false);
    expect(() =>
      assertCredentialRefsAuthorized(policy, [ORIGIN_A, ORIGIN_B], [PROVIDER_REF]),
    ).not.toThrow();
  });

  it('an origin with NO grant entry contributes the empty set (fail closed)', () => {
    const policy = policyFor({ [ORIGIN_A]: [PROVIDER_REF] });
    expect(authorizedRefsForTarget(policy, [ORIGIN_A, 'http://127.0.0.1:49999']).size).toBe(0);
  });

  it('credential-less targets are vacuously legal with no grants (matrix case 25)', () => {
    expect(() =>
      assertCredentialRefsAuthorized(DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY, [ORIGIN_A], []),
    ).not.toThrow();
  });

  it('the deny-all default rejects every declared ref (registration cannot self-grant)', () => {
    expect(() =>
      assertCredentialRefsAuthorized(
        DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
        [ORIGIN_A],
        [PROVIDER_REF],
      ),
    ).toThrow(/not platform-authorized/);
  });

  it('globally allowed + signing-capable but origin-UNGRANTED refs are rejected (matrix cases 21–23)', () => {
    // Both signing refs are globally executable and signing-capable, but
    // the policy grants nothing for the Commerce-like origin: the
    // cross-target attacks fail closed.
    const policy = policyFor({ [ORIGIN_A]: [COMMERCE_REF] });
    expect(() => assertCredentialRefsAuthorized(policy, [ORIGIN_A], [PROVIDER_REF])).toThrow(
      /DEMO_PROVIDER_SIGNING_SECRET/,
    );
  });

  it('issues are name-only and never carry a value-shaped string (ADR-0024 §17)', () => {
    try {
      assertCredentialRefsAuthorized(policyFor({}), [ORIGIN_A], [PROVIDER_REF]);
      throw new Error('expected authorization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialAuthorizationError);
      const message = (error as CredentialAuthorizationError).message;
      expect(message).toContain('DEMO_PROVIDER_SIGNING_SECRET'); // the NAME is allowed
      // The development secret VALUES from .env.example must never appear.
      expect(message).not.toContain('demo-provider-signing-secret-0001');
      expect(message).not.toContain('demo-commerce-signing-secret-0001');
    }
  });
});

// ---------------------------------------------------------------------
// The two-stage signing pipeline (ADR-0024 §8)
// ---------------------------------------------------------------------

describe('the two-stage signing pipeline (ADR-0024 §8)', () => {
  it('Stage 1 rejects before Stage 2: an ungranted declared ref fails even with a valid seam (matrix case 24)', () => {
    // Equality-without-authorization shape: the manifest declares the
    // ref consistently, but the platform never granted it — Stage 1
    // rejects and no signing question is evaluated.
    const policy = policyFor({}); // no grants anywhere
    expect(() =>
      resolveSignatureCredentialBinding(policy, [ORIGIN_A], {
        signatureHeader: 'x-sig',
        credentialRefs: [PROVIDER_REF],
      }),
    ).toThrow(/not platform-authorized/);
  });

  it('header + exactly one authorized signing-capable ref → that ref is bound (matrix case 2)', () => {
    const binding = resolveSignatureCredentialBinding(
      policyFor({ [ORIGIN_A]: [COMMERCE_REF] }),
      [ORIGIN_A],
      { signatureHeader: 'x-commerce-signature', credentialRefs: [COMMERCE_REF] },
    );
    expect(binding).toEqual({
      signatureHeader: 'x-commerce-signature',
      signatureCredentialRef: COMMERCE_REF,
    });
  });

  it('header + zero authorized signing refs → rejected (matrix case 3)', () => {
    const policy = policyFor({ [ORIGIN_A]: [ADMIN_REF] });
    expect(() =>
      resolveSignatureCredentialBinding(policy, [ORIGIN_A], {
        signatureHeader: 'x-sig',
        credentialRefs: [ADMIN_REF],
      }),
    ).toThrow(
      /no declared credential reference is both platform-authorized .* and signing-capable/,
    );
  });

  it('header + two authorized signing refs → rejected as ambiguous; no heuristic (matrix case 4)', () => {
    const policy = policyFor({ [ORIGIN_A]: [PROVIDER_REF, COMMERCE_REF] });
    try {
      resolveSignatureCredentialBinding(policy, [ORIGIN_A], {
        signatureHeader: 'x-sig',
        credentialRefs: [PROVIDER_REF, COMMERCE_REF],
      });
      throw new Error('expected ambiguity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialAuthorizationError);
      expect((error as CredentialAuthorizationError).message).toMatch(/ambiguous/);
      expect((error as CredentialAuthorizationError).message).toMatch(/no selection heuristic/);
    }
  });

  it('a signing-capable ref that is globally configured but NOT declared is unavailable (matrix case 5)', () => {
    // COMMERCE_REF is signing-capable platform-wide, but the manifest
    // declares only PROVIDER_REF: the seam binds PROVIDER_REF, never an
    // undeclared (even signing-capable) alternative.
    const binding = resolveSignatureCredentialBinding(
      policyFor({ [ORIGIN_A]: [PROVIDER_REF, COMMERCE_REF] }),
      [ORIGIN_A],
      { signatureHeader: 'x-sig', credentialRefs: [PROVIDER_REF] },
    );
    expect(binding?.signatureCredentialRef).toBe(PROVIDER_REF);
  });

  it('a declared ref outside the executor allowlist cannot be authorized (matrix case 6)', () => {
    // Stage 1 answers from grants; a ref outside the global vocabulary
    // can never hold a grant (validated at configuration), so it is
    // rejected here with the same authorization error.
    expect(() =>
      resolveSignatureCredentialBinding(
        policyFor({ [ORIGIN_A]: ['SOME_OTHER_SECRET'] }),
        [ORIGIN_A],
        { signatureHeader: 'x-sig', credentialRefs: ['SOME_OTHER_SECRET'] },
      ),
    ).toThrow(/not platform-authorized/);
  });

  it('no signatureHeader → no binding, even when a signing-capable ref is declared (matrix case 8)', () => {
    const binding = resolveSignatureCredentialBinding(
      policyFor({ [ORIGIN_A]: [COMMERCE_REF] }),
      [ORIGIN_A],
      { credentialRefs: [COMMERCE_REF] },
    );
    expect(binding).toBeUndefined();
  });

  it('the pair invariant: a binding is emitted EXACTLY when the header is declared (matrix cases 18–19)', () => {
    // §9 pair invariant, asserted directly on the ONLY producer of the
    // binding: header absent → binding undefined (case 19: ref-present +
    // header-absent is impossible); header present + one authorized
    // signing ref → BOTH fields, never a bare ref (case 18: header-present
    // + ref-absent cannot be emitted by a NEW derivation).
    const policy = policyFor({ [ORIGIN_A]: [COMMERCE_REF] });
    expect(
      resolveSignatureCredentialBinding(policy, [ORIGIN_A], { credentialRefs: [COMMERCE_REF] }),
    ).toBeUndefined();
    const bound = resolveSignatureCredentialBinding(policy, [ORIGIN_A], {
      signatureHeader: 'x-commerce-signature',
      credentialRefs: [COMMERCE_REF],
    });
    expect(bound).toBeDefined();
    expect(Object.keys(bound ?? {}).sort()).toEqual(['signatureCredentialRef', 'signatureHeader']);
  });

  it('a declaration is rejected until the platform grants it (matrix case 29: grants enable, declarations do not)', () => {
    // Identical manifest bytes: rejected under the deny-all policy, then
    // accepted once the platform holds the exact origin grant. The
    // declaration never granted itself anything.
    const manifest = { signatureHeader: 'x-commerce-signature', credentialRefs: [COMMERCE_REF] };
    expect(() =>
      resolveSignatureCredentialBinding(
        DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
        [ORIGIN_A],
        manifest,
      ),
    ).toThrow(/not platform-authorized/);
    expect(
      resolveSignatureCredentialBinding(
        policyFor({ [ORIGIN_A]: [COMMERCE_REF] }),
        [ORIGIN_A],
        manifest,
      ),
    ).toEqual({ signatureHeader: 'x-commerce-signature', signatureCredentialRef: COMMERCE_REF });
  });
});

// ---------------------------------------------------------------------
// Grant-store hygiene (ADR-0024 §17, matrix case 30)
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Generic executor, no engine-known Commerce constant (ADR-0024 §20)
// ---------------------------------------------------------------------

describe('the engine is target-agnostic (ADR-0024 §20)', () => {
  it('no engine source file hard-codes a Commerce-specific credential branch or constant', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    // The only allowed textual mention of Commerce is inside COMMENTS;
    // an executable Commerce constant/branch would be a target-specific
    // engine leak. Assert no code line references the Commerce secret
    // reference NAME or a Commerce business identifier.
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const line of source.split('\n')) {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/\*/.test(line.trimStart().slice(0, 2))) {
          continue; // inside a block comment
        }
        expect(code, `${file}: ${line.trim()}`).not.toMatch(/DEMO_COMMERCE/);
      }
    }
  });
});

describe('grant-store hygiene (ADR-0024 §17)', () => {
  it('a valid grant is accepted and the policy object carries NAMES + origins only', () => {
    const policy = policyFor({ [ORIGIN_A]: [PROVIDER_REF, ADMIN_REF] });
    expect(targetOriginCredentialPolicyIssues(policy)).toEqual([]);
    // The policy is secret-free by construction: it is reference names
    // and normalized origin authorities, nothing else. A secret VALUE
    // can never enter it because no field accepts one.
    const serialized = JSON.stringify(policy);
    expect(serialized).not.toContain('demo-provider-signing-secret-0001');
    expect(serialized).not.toContain('demo-commerce-signing-secret-0001');
    expect(serialized).not.toContain('commerce-admin-dev-token-0001');
  });
});
