// =====================================================================
// Unit — executor destination address-class policy (security §5)
// =====================================================================
// Verifies the SSRF address-class denial: loopback, link-local, private
// (RFC 1918), CGNAT, unique-local (fc00::/7), and IPv4-mapped ranges
// are denied for non-LOCAL_DEVELOPMENT targets. Public addresses and
// LOCAL_DEVELOPMENT targets pass. These tests run offline — the policy
// function receives already-resolved addresses or literal IPs.
import { describe, expect, it } from 'vitest';
import { DestinationDeniedError, assertDestinationAllowed, isDeniedAddress } from './executor.js';

describe('destination address-class policy (security §5)', () => {
  it('denies loopback, private, link-local, CGNAT, and metadata-adjacent IPv4', () => {
    expect(isDeniedAddress('127.0.0.1')).toBe(true);
    expect(isDeniedAddress('10.1.2.3')).toBe(true);
    expect(isDeniedAddress('172.16.0.9')).toBe(true);
    expect(isDeniedAddress('172.31.255.1')).toBe(true);
    expect(isDeniedAddress('192.168.1.1')).toBe(true);
    expect(isDeniedAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isDeniedAddress('100.64.0.1')).toBe(true); // CGNAT
    // Boundary honesty: 172.15.x and 172.32.x are NOT RFC 1918.
    expect(isDeniedAddress('172.15.255.1')).toBe(false);
    expect(isDeniedAddress('172.32.0.1')).toBe(false);
    expect(isDeniedAddress('8.8.8.8')).toBe(false);
  });

  it('denies loopback, link-local, unique-local, and IPv4-mapped IPv6', () => {
    expect(isDeniedAddress('::1')).toBe(true);
    expect(isDeniedAddress('::')).toBe(true);
    expect(isDeniedAddress('fe80::1')).toBe(true);
    expect(isDeniedAddress('fc00::1')).toBe(true);
    expect(isDeniedAddress('fd12:3456::1')).toBe(true);
    expect(isDeniedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isDeniedAddress('::ffff:192.168.0.5')).toBe(true);
    expect(isDeniedAddress('64:ff9b::7f00:1')).toBe(true);
    expect(isDeniedAddress('2606:4700::1111')).toBe(false);
  });

  it('denies unparseable addresses (deny by default)', () => {
    expect(isDeniedAddress('not-an-address')).toBe(true);
  });

  it('LOCAL_DEVELOPMENT targets bypass the check entirely', async () => {
    await expect(
      assertDestinationAllowed(new URL('http://127.0.0.1:3002'), 'LOCAL_DEVELOPMENT'),
    ).resolves.toBeUndefined();
  });

  it('literal denied IP on a STAGING origin throws DestinationDeniedError', async () => {
    await expect(
      assertDestinationAllowed(new URL('http://127.0.0.1:9999'), 'STAGING'),
    ).rejects.toBeInstanceOf(DestinationDeniedError);
  });
});
