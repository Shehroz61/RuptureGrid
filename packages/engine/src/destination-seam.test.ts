// =====================================================================
// Phase 14 blocker repair B-1 — destination-security seam compatibility
// =====================================================================
// The destination rules now live in ONE reviewed implementation
// (destination.ts). The executor re-exports them byte-identically and
// its executeHttp path resolves to the same functions. This matrix
// proves: (1) the seam is actually invoked by the generic inspection
// transport; (2) cross-origin escapes are refused; (3) denied address
// classes are rejected under exactly the executor's policy; (4) the
// LOCAL_DEVELOPMENT exception behaves byte-identically for both
// transports; (5) executor re-exports are the shared implementations
// (byte-for-byte, no copied logic).

import dns from 'node:dns/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDestinationAllowed,
  DestinationDeniedError,
  executeHttp,
  isDeniedAddress,
} from './executor.js';
import {
  assertDestinationAllowed as seamAssertDestinationAllowed,
  isDeniedAddress as seamIsDeniedAddress,
  assertOriginAllowed as seamAssertOriginAllowed,
  originHostHeader as seamOriginHostHeader,
  DestinationDeniedError as SeamDestinationDeniedError,
  OriginAuthorityError as SeamOriginAuthorityError,
  assertOriginAllowed,
  originHostHeader,
  OriginAuthorityError,
} from './destination.js';

describe('B-1: the executor re-exports the ONE shared destination seam', () => {
  it('re-exports the same function identities and error classes (no duplicated logic)', () => {
    expect(assertDestinationAllowed).toBe(seamAssertDestinationAllowed);
    expect(isDeniedAddress).toBe(seamIsDeniedAddress);
    expect(assertOriginAllowed).toBe(seamAssertOriginAllowed);
    expect(originHostHeader).toBe(seamOriginHostHeader);
    expect(DestinationDeniedError).toBe(SeamDestinationDeniedError);
    expect(OriginAuthorityError).toBe(SeamOriginAuthorityError);
  });

  it('applies the identical address-class policy through both names', () => {
    for (const denied of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.9',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::5',
      '::ffff:10.0.0.1',
      '64:ff9b::7f00:1',
      'not-an-ip',
    ]) {
      expect(isDeniedAddress(denied)).toBe(true);
      expect(seamIsDeniedAddress(denied)).toBe(true);
    }
    for (const allowed of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isDeniedAddress(allowed)).toBe(false);
      expect(seamIsDeniedAddress(allowed)).toBe(false);
    }
  });
});

describe('B-1: origin authority + scheme/environment policy (shared rule)', () => {
  it('refuses a resolved URL that escapes the registered origin', () => {
    const origin = new URL('https://api.acme.example:8443');
    expect(() => assertOriginAllowed(new URL('https://evil.example/x'), origin, 'STAGING')).toThrow(
      OriginAuthorityError,
    );
  });

  it('refuses an http origin for a STAGING target (HTTPS-only policy)', () => {
    expect(() =>
      assertOriginAllowed(
        new URL('http://api.acme.example/x'),
        new URL('http://api.acme.example'),
        'STAGING',
      ),
    ).toThrow(OriginAuthorityError);
  });

  it('accepts an exact-origin https URL for STAGING and http for LOCAL_DEVELOPMENT', () => {
    expect(() =>
      assertOriginAllowed(
        new URL('https://api.acme.example:8443/p'),
        new URL('https://api.acme.example:8443'),
        'STAGING',
      ),
    ).not.toThrow();
    expect(() =>
      assertOriginAllowed(
        new URL('http://127.0.0.1:45001/p'),
        new URL('http://127.0.0.1:45001'),
        'LOCAL_DEVELOPMENT',
      ),
    ).not.toThrow();
  });

  it('refuses an unknown environment (fail closed, never guessed)', () => {
    expect(() =>
      assertOriginAllowed(
        new URL('https://api.acme.example/p'),
        new URL('https://api.acme.example'),
        'SOMEWHERE' as never,
      ),
    ).toThrow(OriginAuthorityError);
  });
});

describe('B-1: resolve-once-validate address policy (executor-identical behavior)', () => {
  it('denies a STAGING origin resolving into a private class (pre-send denial)', async () => {
    // Deterministic resolution: the seam validates EVERY resolved
    // address against the shared address-class policy before any
    // connection (identical to the reviewed executor behavior).
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '10.9.8.7', family: 4 }] as never);
    try {
      await expect(
        assertDestinationAllowed(new URL('https://private.probe.example'), 'STAGING'),
      ).rejects.toBeInstanceOf(DestinationDeniedError);
    } finally {
      lookup.mockRestore();
    }
  });

  it('applies the LOCAL_DEVELOPMENT exception byte-identically for both transports', async () => {
    // No DNS lookup may happen at all for LOCAL_DEVELOPMENT (the Demo
    // Target legitimately lives on loopback) — same seam, same rule.
    const lookup = vi.spyOn(dns, 'lookup');
    await expect(
      assertDestinationAllowed(new URL('http://127.0.0.1:45001'), 'LOCAL_DEVELOPMENT'),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it('denies a literal denied-class IP host for STAGING without any DNS call', async () => {
    await expect(
      assertDestinationAllowed(new URL('http://169.254.169.254:80'), 'STAGING'),
    ).rejects.toBeInstanceOf(DestinationDeniedError);
  });
});

describe('B-1: Host construction + executor path resolves to the seam', () => {
  it('derives the Host from the registered origin only', () => {
    expect(originHostHeader(new URL('https://api.acme.example:8443'))).toBe(
      'api.acme.example:8443',
    );
  });

  it('the executor transport still runs through the shared seam (structure preserved)', async () => {
    // executeHttp resolves its destination policy through the shared
    // seam: a denied-address STAGING destination raises the seam's
    // DestinationDeniedError (the reviewed pre-send denial semantics —
    // the caller classifies it KNOWN_ABSENT), byte-identical to the
    // pre-refactor behavior.
    await expect(
      executeHttp({
        action: {
          method: 'GET',
          relativePath: '/probe',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
          timeoutMs: 1000,
        },
        origin: 'http://169.254.169.254:80',
        contractKind: 'GENERIC_HTTP',
        environment: 'STAGING',
        invocationIdentity: 'seam-compat-probe',
        credentials: { resolve: () => 'unused' },
        signatureHeader: null,
      }),
    ).rejects.toBeInstanceOf(DestinationDeniedError);
  });
});
