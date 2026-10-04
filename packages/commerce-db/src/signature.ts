// =====================================================================
// Demo Commerce — checkout authenticity (HMAC-SHA256 over raw bytes)
// =====================================================================
// The Commerce target verifies checkout requests with its OWN signing
// secret (DEMO_COMMERCE_SIGNING_SECRET) — never the Fintech provider
// secret (docs/checkout-zero.md §2; prompt §33). Same accepted v1
// mechanism as the Demo contract: HMAC-SHA256, hex, over the EXACT raw
// body bytes; timing-safe comparison; no canonical serialization.
// The secret value never appears in errors or logs.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function checkoutSignatureHex(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies a hex HMAC-SHA256 signature against the exact raw bytes.
 * Returns false (never throws) for malformed hex or length mismatch.
 */
export function verifyCheckoutSignature(
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
  const actual = Buffer.from(checkoutSignatureHex(secret, rawBody), 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** Cryptographically random identity for target-assigned identifiers. */
export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}
