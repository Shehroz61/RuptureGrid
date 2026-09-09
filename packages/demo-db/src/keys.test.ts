// =====================================================================
// Unit — idempotency scopes (the deterministic heart of Incident Zero)
// =====================================================================

import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey } from './keys.js';

const BASE = {
  providerPaymentId: 'pp-demo-0000000000000001',
  providerEventId: 'pe-demo-0000000000000001',
  walletId: '11111111-1111-1111-1111-111111111111',
};

describe('deriveIdempotencyKey', () => {
  it('VULNERABLE scope keys by logical provider EVENT', () => {
    const key = deriveIdempotencyKey({ mode: 'VULNERABLE', ...BASE });
    expect(key).toBe(`wallet-credit:event:${BASE.providerEventId}:${BASE.walletId}`);
  });

  it('SECURE scope keys by logical PAYMENT', () => {
    const key = deriveIdempotencyKey({ mode: 'SECURE', ...BASE });
    expect(key).toBe(`wallet-credit:payment:${BASE.providerPaymentId}:${BASE.walletId}`);
  });

  it('is deterministic for identical inputs', () => {
    const a = deriveIdempotencyKey({ mode: 'VULNERABLE', ...BASE });
    const b = deriveIdempotencyKey({ mode: 'VULNERABLE', ...BASE });
    expect(a).toBe(b);
  });

  it('VULNERABLE: a second event for the SAME payment yields a DIFFERENT key — that is the bug', () => {
    const eventA = deriveIdempotencyKey({
      mode: 'VULNERABLE',
      ...BASE,
      providerEventId: 'pe-demo-00000000000000aa',
    });
    const eventB = deriveIdempotencyKey({
      mode: 'VULNERABLE',
      ...BASE,
      providerEventId: 'pe-demo-00000000000000bb',
    });
    expect(eventA).not.toBe(eventB);
  });

  it('SECURE: every event of the same payment yields the SAME key — that is the fix', () => {
    const eventA = deriveIdempotencyKey({
      mode: 'SECURE',
      ...BASE,
      providerEventId: 'pe-demo-00000000000000aa',
    });
    const eventB = deriveIdempotencyKey({
      mode: 'SECURE',
      ...BASE,
      providerEventId: 'pe-demo-00000000000000bb',
    });
    expect(eventA).toBe(eventB);
  });

  it('SECURE: two legitimate DIFFERENT payments never collide — no wallet-global suppression', () => {
    const paymentA = deriveIdempotencyKey({
      mode: 'SECURE',
      ...BASE,
      providerPaymentId: 'pp-demo-0000000000000001',
    });
    const paymentB = deriveIdempotencyKey({
      mode: 'SECURE',
      ...BASE,
      providerPaymentId: 'pp-demo-0000000000000002',
    });
    expect(paymentA).not.toBe(paymentB);
  });
});
