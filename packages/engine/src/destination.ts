// =====================================================================
// RuptureGrid v1.1 — the ONE reviewed destination-security seam
// (security-boundaries §3–§6; Phase 14 blocker repair B-1)
// =====================================================================
// Every outbound RuptureGrid HTTP request — executor actions AND the
// Phase 14 generic inspection adapter — passes through the policy in
// this module. There is exactly ONE implementation of each rule:
//
//   - registered frozen origin authority (the URL is built ONLY from
//     the snapshot's registered origin + a validated relative path);
//   - scheme/environment policy (validated at registration; re-checked
//     here with the closed v1 vocabulary — no absolute/scheme-relative
//     escape can exist because no absolute URL is ever an input);
//   - safe Host construction (derived from the registered origin,
//     never from request-supplied headers);
//   - address-class policy (loopback, link-local, private RFC 1918,
//     unique-local, CGNAT, IPv4/IPv6 translation prefix, cloud-
//     metadata ranges DENIED unless the target is classified
//     LOCAL_DEVELOPMENT — the Demo Target is exactly that);
//   - resolve-once-validate (DNS resolution checked against the
//     address-class policy BEFORE any connection is attempted).
//
// The executor keeps the credential/signature/body seams (which a
// credential-free read-only inspection never touches); this module
// owns the DESTINATION rules both transports share. Security policy
// lives in ONE place: packages/evidence imports THIS seam — it never
// re-implements or re-weakenes it.
//
// Behavior is byte-identical to the reviewed Phase 3 executor logic:
// executor.ts re-exports these exact functions, so the executor's
// call sites resolve to the same implementations as before.

import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import type { TargetEnvironment } from '@rupturegrid/shared';

export class DestinationDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DestinationDeniedError';
  }
}

export class OriginAuthorityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OriginAuthorityError';
  }
}

/** The closed v1 environment vocabulary (never guessed, fail closed). */
const TARGET_ENVIRONMENTS = ['LOCAL_DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;

/**
 * The safe framing Host for one request to a REGISTERED origin:
 * derived from the origin authority — never from request-supplied
 * headers or response URLs (security-boundaries §3.5). Executor and
 * inspection requests carry the same Host discipline.
 */
export function originHostHeader(origin: URL | string): string {
  return (typeof origin === 'string' ? new URL(origin) : origin).host;
}

/**
 * Asserts the origin carries an allowed scheme for its environment and
 * that the resolved URL stays within the registered origin authority
 * (origin equality). STAGING is HTTPS-only (security-boundaries §3.1,
 * ADR-0016 §5); LOCAL_DEVELOPMENT may use http or https. The URL is
 * built ONLY from the registered origin + validated relative path, so
 * an absolute/scheme-relative escape cannot even be constructed —
 * the equality check is defense in depth, enforced identically for
 * every transport that asks this seam.
 */
export function assertOriginAllowed(
  resolvedUrl: URL,
  origin: URL,
  environment: TargetEnvironment,
): void {
  if (!(TARGET_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new OriginAuthorityError(`unknown target environment: ${String(environment)}`);
  }
  if (environment === 'STAGING' && origin.protocol !== 'https:') {
    throw new OriginAuthorityError(
      `STAGING targets are HTTPS-only (security-boundaries §3.1); origin scheme is ${origin.protocol}`,
    );
  }
  if (resolvedUrl.origin !== origin.origin) {
    throw new OriginAuthorityError('resolved URL origin does not match the registered origin');
  }
}

/**
 * Address-class policy (security-boundaries §5 — Phase 3 control).
 * Loopback, link-local, private (RFC 1918), CGNAT, unique-local
 * (fc00::/7), IPv4/IPv6 translation prefixes, and cloud-metadata
 * ranges are DENIED unless the target is explicitly classified
 * LOCAL_DEVELOPMENT (the Demo Target is exactly that). STAGING/
 * PRODUCTION targets must be reachable only by public address.
 */
export function isDeniedAddress(ip: string): boolean {
  const v4 = isIP(ip) === 4 ? ip.split('.').map((part) => Number(part)) : null;
  if (v4 !== null) {
    if (v4[0] === 10 || v4[0] === 127) return true; // private, loopback
    if (v4[0] === 169 && v4[1] === 254) return true; // link-local
    if (v4[0] === 172 && (v4[1] ?? 0) >= 16 && (v4[1] ?? 0) <= 31) return true;
    if (v4[0] === 192 && v4[1] === 168) return true;
    if (v4[0] === 100 && (v4[1] ?? 0) >= 64 && (v4[1] ?? 0) <= 127) return true;
    // CGNAT (shared address space)
    if (v4[0] === 169 && v4[1] === 254) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback, unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped: evaluate the embedded IPv4 address.
      return isDeniedAddress(lower.slice(7));
    }
    // IPv4/IPv6 translation + well-known prefix (64:ff9b::/96).
    if (lower.startsWith('64:ff9b:')) return true;
    return false;
  }
  return true; // unparseable → deny
}

/**
 * Resolve-once-validate (security-boundaries §5): resolves the
 * registered host and verifies every returned address against the
 * address-class policy BEFORE any connection is attempted. Failure is
 * a pre-send denial (KNOWN_ABSENT class) — the request provably never
 * left the process. DNS rebinding cannot be fully eliminated here
 * (docs §5); network egress isolation remains the primary control.
 */
export async function assertDestinationAllowed(
  origin: URL,
  environment: TargetEnvironment,
): Promise<void> {
  if (environment === 'LOCAL_DEVELOPMENT') {
    return; // Demo/local targets legitimately run on loopback/private nets.
  }
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  const addresses: readonly string[] =
    isIP(host) !== 0
      ? [host]
      : (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  const denied = addresses.find((address) => isDeniedAddress(address));
  if (denied !== undefined) {
    throw new DestinationDeniedError(
      `registered target resolves to a denied address class for environment ${environment}`,
    );
  }
}
