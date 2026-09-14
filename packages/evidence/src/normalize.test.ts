// =====================================================================
// RuptureGrid v1.0 — deterministic normalization unit tests (§25–§27)
// =====================================================================
// Same normalizer version + same stored observation input ⇒ the same
// event semantic content, always. Unknown structure produces NO events
// (never guessed into business meaning).

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import {
  eventInputHash,
  normalizeDemoLineageObservation,
  normalizeInvocationObservation,
} from './normalize.js';
import { validateLineage } from './demo-adapter.js';

const lineagePayload = validateLineage({
  payment: {
    providerPaymentId: 'PP-canary-payment-000001',
    walletId: 'w-0001',
    amountMinor: '500000',
    currency: 'PKR',
    status: 'CONFIRMED',
  },
  events: [
    {
      providerEventId: 'PE-canary-event-0000001',
      providerPaymentId: 'PP-canary-payment-000001',
      eventType: 'payment.confirmed',
    },
  ],
  deliveries: [
    {
      deliveryAttemptId: 'D-canary-delivery-000001',
      providerEventId: 'PE-canary-event-0000001',
      status: 'ACCEPTED',
    },
    {
      deliveryAttemptId: 'D-canary-delivery-000002',
      providerEventId: 'PE-canary-event-0000001',
      status: 'ACCEPTED',
    },
  ],
  processingAttempts: [
    {
      processingAttemptId: 'PA-0001',
      deliveryAttemptId: 'D-canary-delivery-000001',
      outcome: 'COMPLETED',
    },
    {
      processingAttemptId: 'PA-0002',
      deliveryAttemptId: 'D-canary-delivery-000002',
      outcome: 'COMPLETED',
    },
  ],
  financialEffects: [
    {
      financialEffectId: 'FE-0001',
      providerPaymentId: 'PP-canary-payment-000001',
      processingAttemptId: 'PA-0001',
      walletId: 'w-0001',
      effectType: 'WALLET_CREDIT',
      amountMinor: '500000',
      currency: 'PKR',
      createdAt: '2026-09-13T00:00:00.000Z',
    },
    {
      financialEffectId: 'FE-0002',
      providerPaymentId: 'PP-canary-payment-000001',
      processingAttemptId: 'PA-0002',
      walletId: 'w-0001',
      effectType: 'WALLET_CREDIT',
      amountMinor: '500000',
      currency: 'PKR',
      createdAt: '2026-09-13T00:00:01.000Z',
    },
  ],
  ledgerEntries: [
    {
      financialEffectId: 'FE-0001',
      walletId: 'w-0001',
      entryType: 'WALLET_CREDIT',
      amountMinor: '500000',
      currency: 'PKR',
      idempotencyKey: 'key-0001',
      createdAt: '2026-09-13T00:00:00.000Z',
    },
  ],
  wallet: { walletId: 'w-0001', balanceMinor: '1000000', currency: 'PKR' },
  counts: {
    events: 1,
    deliveries: 2,
    processingAttempts: 2,
    financialEffects: 2,
    ledgerEntries: 1,
  },
  processingMode: 'VULNERABLE',
});

describe('invocation normalizer', () => {
  const observation = {
    contentHash: 'a'.repeat(64),
    chainIndex: 3,
    payload: {
      kind: 'invocation',
      http: {
        method: 'POST',
        relativePath: '/webhooks/provider',
        requestBody: JSON.stringify({
          providerPaymentId: 'PP-canary-payment-000001',
          providerEventId: 'PE-canary-event-0000001',
          eventType: 'payment.confirmed',
          amountMinor: '500000',
          currency: 'PKR',
          walletRef: 'demo-customer-001',
        }),
        responseStatus: 200,
        responseBody: JSON.stringify({
          deliveryAttemptId: 'D-canary-delivery-000001',
          processingAttemptId: 'PA-0001',
          outcome: 'ACCEPTED',
        }),
      },
    },
  };

  it('derives exactly one delivery-observed event from a Demo webhook invocation', () => {
    const events = normalizeInvocationObservation(observation);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('demo.payment-delivery-observed');
    expect(events[0]?.subjectKey).toBe('PP-canary-payment-000001');
    expect(events[0]?.normalizerName).toBe('executor-invocation-normalizer');
    expect(events[0]?.normalizerVersion).toBe('v1');
    expect(events[0]?.sourceObservationHashes).toEqual(['a'.repeat(64)]);
  });

  it('is deterministic: same input ⇒ identical event payloads and hashes', () => {
    const first = normalizeInvocationObservation(observation);
    const second = normalizeInvocationObservation(observation);
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
    expect(eventInputHash(first[0]!.sourceObservationHashes)).toBe(
      eventInputHash(second[0]!.sourceObservationHashes),
    );
  });

  it('emits NO events for non-webhook bodies (nothing is invented)', () => {
    const admin = {
      contentHash: 'b'.repeat(64),
      chainIndex: 4,
      payload: {
        kind: 'invocation',
        http: {
          method: 'GET',
          relativePath: '/admin/healthz',
          requestBody: null,
        },
      },
    };
    expect(normalizeInvocationObservation(admin)).toEqual([]);
    const malformed = {
      ...observation,
      payload: {
        kind: 'invocation',
        http: { method: 'POST', relativePath: '/x', requestBody: 'not-json' },
      },
    };
    expect(normalizeInvocationObservation(malformed)).toEqual([]);
  });
});

describe('lineage normalizer', () => {
  it('derives typed entity events preserving the identity chain', () => {
    const events = normalizeDemoLineageObservation({
      contentHash: 'c'.repeat(64),
      chainIndex: 9,
      payload: lineagePayload,
    });
    const types = events.map((event) => event.eventType).sort();
    expect(types).toContain('demo.provider-payment-observed');
    expect(types).toContain('demo.provider-event-observed');
    expect(types).toContain('demo.webhook-delivery-observed');
    expect(types).toContain('demo.processing-attempt-observed');
    expect(types).toContain('demo.financial-effect-observed');
    expect(types).toContain('demo.ledger-entry-observed');
    expect(types).toContain('demo.wallet-state-observed');
    for (const event of events) {
      expect(event.subjectKey).toBe('PP-canary-payment-000001');
      expect(event.originNote).toBeUndefined();
    }
    const effect = events.find((event) => event.eventType === 'demo.financial-effect-observed');
    expect(effect?.payload['providerPaymentId']).toBe('PP-canary-payment-000001');
    expect(effect?.payload['processingAttemptId']).toBe('PA-0001');
    expect(effect?.payload['amountMinor']).toBe('500000');
  });

  it('is deterministic across repeated runs', () => {
    const input = { contentHash: 'c'.repeat(64), chainIndex: 9, payload: lineagePayload };
    const first = normalizeDemoLineageObservation(input);
    const second = normalizeDemoLineageObservation(input);
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });
});

describe('eventInputHash', () => {
  it('is order-insensitive and content-sensitive', () => {
    const a = eventInputHash(['h1', 'h2']);
    const b = eventInputHash(['h2', 'h1']);
    const c = eventInputHash(['h1', 'h3']);
    // Same sources, DIFFERENT semantic payload ⇒ different event key.
    const d = eventInputHash(['h1', 'h2'], { deliveryAttemptId: 'D-1' });
    const e = eventInputHash(['h1', 'h2'], { deliveryAttemptId: 'D-2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(d).not.toBe(e);
    expect(d).not.toBe(a);
    // Reference form: canonical JSON of {sources:[…]} sorted.
    expect(a).toBe(
      createHash('sha256')
        .update(canonicalizeJson({ sources: ['h1', 'h2'] }))
        .digest('hex'),
    );
  });
});
