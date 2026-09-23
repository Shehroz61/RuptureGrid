// =====================================================================
// Unit — Phase 9 lineage normalizer v1→v2 compatibility (evidence-model §2)
// =====================================================================
// Same stored observation + same normalizer version ⇒ same events,
// always. v2 ADDS the target's whole-wallet reconciliation fields to
// wallet-state events; a v1-era payload (without those fields) still
// normalizes — the new fields are null, never guessed. Historical rows
// are never reinterpreted: a changed semantics = a NEW version row.

import { describe, expect, it } from 'vitest';
import { validateLineage, DemoAdapterError } from './demo-adapter.js';
import {
  normalizeDemoLineageObservation,
  normalizeDemoFaultStatusObservation,
} from './normalize.js';
import { DEMO_LINEAGE_NORMALIZER_VERSION } from './versions.js';

function lineagePayload(withReconciliation: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    payment: {
      providerPaymentId: 'PP-1',
      walletId: 'w-1',
      amountMinor: '500000',
      currency: 'PKR',
      status: 'CONFIRMED',
    },
    events: [{ providerEventId: 'PE-1', providerPaymentId: 'PP-1', eventType: 'PAYMENT_CREDITED' }],
    deliveries: [{ deliveryAttemptId: 'DA-1', providerEventId: 'PE-1', status: 'ACCEPTED' }],
    processingAttempts: [
      { processingAttemptId: 'PA-1', deliveryAttemptId: 'DA-1', outcome: 'APPLIED' },
    ],
    financialEffects: [
      {
        financialEffectId: 'FE-1',
        providerPaymentId: 'PP-1',
        processingAttemptId: 'PA-1',
        walletId: 'w-1',
        effectType: 'WALLET_CREDIT',
        amountMinor: '500000',
        currency: 'PKR',
        createdAt: '2026-09-21T00:00:00.000Z',
      },
    ],
    ledgerEntries: [
      {
        financialEffectId: 'FE-1',
        walletId: 'w-1',
        entryType: 'WALLET_CREDIT',
        amountMinor: '500000',
        currency: 'PKR',
        idempotencyKey: 'key-1',
        createdAt: '2026-09-21T00:00:00.000Z',
      },
    ],
    wallet: { walletId: 'w-1', balanceMinor: '1000000', currency: 'PKR' },
    counts: {
      events: 1,
      deliveries: 1,
      processingAttempts: 1,
      financialEffects: 1,
      ledgerEntries: 1,
    },
    processingMode: 'VULNERABLE',
  };
  if (withReconciliation) {
    base['walletLedgerCreditSumMinor'] = '1000000';
    base['walletBalanceDifferenceMinor'] = '0';
  }
  return base;
}

describe('lineage normalizer v1→v2 compatibility', () => {
  it('pins the Phase 9 version bump', () => {
    expect(DEMO_LINEAGE_NORMALIZER_VERSION).toBe('v2');
  });

  it('normalizes a v1-era payload (no reconciliation fields) with honest nulls', () => {
    // The v1-era payload fails ADAPTER validation (the live target now
    // always sends the fields) — that is the target-boundary contract.
    // The NORMALIZER (which also replays already-stored v1-era rows)
    // accepts the stored shape with null reconciliation fields.
    const events = normalizeDemoLineageObservation({
      contentHash: 'a'.repeat(64),
      chainIndex: 0,
      payload: lineagePayload(false),
    });
    const wallet = events.find((event) => event.eventType === 'demo.wallet-state-observed');
    expect(wallet).toBeDefined();
    expect(wallet?.payload['walletLedgerCreditSumMinor']).toBeNull();
    expect(wallet?.payload['walletBalanceDifferenceMinor']).toBeNull();
  });

  it('normalizes a v2 payload carrying the reconciliation fields verbatim', () => {
    const payload = validateLineage(lineagePayload(true));
    const events = normalizeDemoLineageObservation({
      contentHash: 'b'.repeat(64),
      chainIndex: 1,
      payload,
    });
    const wallet = events.find((event) => event.eventType === 'demo.wallet-state-observed');
    expect(wallet?.payload['walletLedgerCreditSumMinor']).toBe('1000000');
    expect(wallet?.payload['walletBalanceDifferenceMinor']).toBe('0');
    expect(wallet?.normalizerVersion).toBe('v2');
  });

  it('adapter validation rejects a live payload missing the reconciliation fields', () => {
    // A LIVE response without them is an adapter reality (an older demo
    // binary), not silently normalized: the adapter refuses and the
    // capture fails loudly — honest incompleteness, never invention.
    expect(() => validateLineage(lineagePayload(false))).toThrow(DemoAdapterError);
  });
});

describe('fault-status normalizer (configured vs activated)', () => {
  it('derives per-plan state events with the target-owned trigger accounting', () => {
    const events = normalizeDemoFaultStatusObservation({
      contentHash: 'c'.repeat(64),
      chainIndex: 2,
      payload: {
        plans: [
          {
            faultKind: 'PRE_MUTATION_REJECTION',
            planVersion: 'controlled-fault/v1',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 1,
            triggersUsed: 1,
            armedAt: '2026-09-21T10:00:00.000Z',
            expiresAt: '2026-09-21T10:15:00.000Z',
            expired: false,
          },
          {
            faultKind: 'CRASH_MID_PROCESSING',
            planVersion: 'controlled-fault/v1',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 3,
            triggersUsed: 0,
            armedAt: '2026-09-21T10:00:00.000Z',
            expiresAt: '2026-09-21T10:15:00.000Z',
            expired: false,
          },
        ],
      },
    });
    expect(events).toHaveLength(2);
    const triggered = events.find((event) => event.subjectKey === 'PRE_MUTATION_REJECTION');
    expect(triggered?.payload['triggersUsed']).toBe(1); // activation basis
    const configuredOnly = events.find((event) => event.subjectKey === 'CRASH_MID_PROCESSING');
    expect(configuredOnly?.payload['triggersUsed']).toBe(0); // configured, never activated
  });

  it('emits nothing for a malformed payload (no meaning invented)', () => {
    expect(
      normalizeDemoFaultStatusObservation({
        contentHash: 'd'.repeat(64),
        chainIndex: 0,
        payload: { nope: true },
      }),
    ).toEqual([]);
    expect(
      normalizeDemoFaultStatusObservation({
        contentHash: 'd'.repeat(64),
        chainIndex: 0,
        payload: 'not an object',
      }),
    ).toEqual([]);
  });
});
