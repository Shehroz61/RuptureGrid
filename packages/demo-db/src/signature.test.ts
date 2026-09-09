// =====================================================================
// Unit — provider signature (HMAC-SHA256 over exact raw bytes)
// =====================================================================
// Proves the signature binds payload CONTENT: mutate a single byte and
// the signature no longer verifies (Phase 2 §106).

import { describe, expect, it } from 'vitest';
import { providerSignatureHex, randomId, verifyProviderSignature } from './signature.js';

const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const BODY_A = Buffer.from(
  JSON.stringify({
    providerPaymentId: 'pp-demo-0000000000000001',
    providerEventId: 'pe-demo-0000000000000001',
    eventType: 'PAYMENT_CONFIRMED',
    amountMinor: '500000',
    currency: 'PKR',
  }),
  'utf8',
);

describe('provider signature', () => {
  it('verifies a signature generated over the exact body bytes', () => {
    const sig = providerSignatureHex(SECRET, BODY_A);
    expect(verifyProviderSignature(SECRET, BODY_A, sig)).toBe(true);
  });

  it('binds payload content: any mutation invalidates the signature', () => {
    const sig = providerSignatureHex(SECRET, BODY_A);
    const tampered = Buffer.from(
      JSON.stringify({
        providerPaymentId: 'pp-demo-0000000000000001',
        providerEventId: 'pe-demo-0000000000000001',
        eventType: 'PAYMENT_CONFIRMED',
        amountMinor: '999999',
        currency: 'PKR',
      }),
      'utf8',
    );
    expect(verifyProviderSignature(SECRET, tampered, sig)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const sig = providerSignatureHex('another-secret-entirely-0123456789ab', BODY_A);
    expect(verifyProviderSignature(SECRET, BODY_A, sig)).toBe(false);
  });

  it('rejects missing, empty, and malformed signatures', () => {
    expect(verifyProviderSignature(SECRET, BODY_A, '')).toBe(false);
    expect(verifyProviderSignature(SECRET, BODY_A, 'not-hex!')).toBe(false);
    expect(verifyProviderSignature(SECRET, BODY_A, 'abc')).toBe(false);
    expect(verifyProviderSignature(SECRET, BODY_A, 'zz'.repeat(32))).toBe(false);
  });

  it('rejects when the body differs in a single byte', () => {
    const sig = providerSignatureHex(SECRET, BODY_A);
    const oneByteDifferent = Buffer.from(BODY_A);
    oneByteDifferent[oneByteDifferent.length - 3] = 0x30; // '0' -> '1'-adjacent byte
    expect(verifyProviderSignature(SECRET, oneByteDifferent, sig)).toBe(false);
  });
});

describe('randomId', () => {
  it('produces prefixed, sufficiently long unique identifiers', () => {
    const a = randomId('pa');
    const b = randomId('pa');
    expect(a.startsWith('pa-')).toBe(true);
    expect(b.startsWith('pa-')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
