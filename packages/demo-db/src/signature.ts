// =====================================================================
// Demo Fintech — provider authenticity (HMAC-SHA256 over raw bytes)
// =====================================================================
// Resolves the Phase 0 deferred question (ADR-0005): provider webhook
// authenticity is a real HMAC-SHA256 over the EXACT raw request bytes,
// hex-encoded, carried in x-rupturegrid-provider-signature. Verification
// uses timingSafeEqual to avoid leaking the signature through comparison
// timing. The signing secret never appears in errors or logs.
//
// Canonical serialization contract: NONE — the signature binds the raw
// bytes exactly as transmitted, so no property-ordering assumptions
// exist at all (Phase 2 contract §27).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function providerSignatureHex(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies a hex HMAC-SHA256 signature against the exact raw bytes.
 * Returns false (never throws) for malformed hex or length mismatch.
 */
export function verifyProviderSignature(
  secret: string,
  rawBody: Buffer,
  signatureHex: string,
): boolean {
  if (typeof signatureHex !== 'string' || signatureHex.length === 0) {
    return false;
  }
  const normalized = signatureHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return false;
  }
  const expected = Buffer.from(normalized, 'hex');
  const actual = Buffer.from(providerSignatureHex(secret, rawBody), 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** Cryptographically random identity for target-assigned identifiers. */
export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}
