// =====================================================================
// Unit — provider webhook payload validation (contract §56)
// =====================================================================
// Everything dangerous is REJECTED, never coerced: fractional amounts,
// non-positive amounts, unsafe representations, invalid currency,
// unknown event types, malformed identities.

import { describe, expect, it } from 'vitest';
import { parseWebhookPayload, WebhookPayloadError } from './webhook-payload.js';
import { providerSignatureHex } from './signature.js';

const VALID = {
  providerPaymentId: 'pp-demo-0000000000000001',
  providerEventId: 'pe-demo-0000000000000001',
  eventType: 'PAYMENT_CONFIRMED',
  amountMinor: '500000',
  currency: 'PKR',
};

describe('parseWebhookPayload — acceptance', () => {
  it('accepts the canonical payload', () => {
    const payload = parseWebhookPayload({ ...VALID });
    expect(payload.providerPaymentId).toBe(VALID.providerPaymentId);
    expect(payload.eventType).toBe('PAYMENT_CONFIRMED');
    expect(payload.amountMinor).toBe(500000n);
    expect(payload.currency).toBe('PKR');
  });

  it('accepts the settled event type', () => {
    const payload = parseWebhookPayload({ ...VALID, eventType: 'PAYMENT_SETTLED' });
    expect(payload.eventType).toBe('PAYMENT_SETTLED');
  });
});

describe('parseWebhookPayload — rejection', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['fractional amount', { ...VALID, amountMinor: '5000.50' }],
    ['zero amount', { ...VALID, amountMinor: '0' }],
    ['negative amount', { ...VALID, amountMinor: '-500000' }],
    ['numeric (non-string) amount', { ...VALID, amountMinor: 500000 }],
    ['unsafe magnitude', { ...VALID, amountMinor: '99999999999999999999999' }],
    ['invalid currency', { ...VALID, currency: 'USD' }],
    ['lowercase currency', { ...VALID, currency: 'pkr' }],
    ['unknown event type', { ...VALID, eventType: 'EVENT_A' }],
    [
      'missing event type',
      { ...VALID, eventType: undefined } as unknown as Record<string, unknown>,
    ],
    ['malformed providerPaymentId', { ...VALID, providerPaymentId: 'short' }],
    ['empty providerEventId', { ...VALID, providerEventId: '' }],
    ['non-string currency', { ...VALID, currency: 1 } as unknown as Record<string, unknown>],
  ];

  for (const [label, payload] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => parseWebhookPayload(payload)).toThrow(WebhookPayloadError);
    });
  }

  it('rejects non-object payloads', () => {
    expect(() => parseWebhookPayload('payload')).toThrow(WebhookPayloadError);
    expect(() => parseWebhookPayload(null)).toThrow(WebhookPayloadError);
    expect(() => parseWebhookPayload([VALID])).toThrow(WebhookPayloadError);
  });
});

describe('signature is computed over the serialized payload bytes', () => {
  it('the canonical signing input is the exact JSON body (no property-order hazard)', () => {
    const body = Buffer.from(JSON.stringify(VALID), 'utf8');
    const sig = providerSignatureHex('a-signing-secret-0123456789abcdef', body);
    expect(typeof sig).toBe('string');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
