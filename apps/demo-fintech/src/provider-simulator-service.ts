// =====================================================================
// Demo Fintech — provider simulator service
// =====================================================================
// A small TARGET-OWNED provider simulation interface for deterministic
// demo scenarios (Phase 2 §28). It is NOT an experiment engine: no
// concurrency configuration, no repeat plans, no fault injection, no
// run tracking (§89). It creates the legitimate provider-side business
// entities — the logical payment and its logical events — and returns
// the delivery envelope for each event. It deliberately does NOT assign
// deliveryAttemptId: that identity belongs to each physical delivery
// and is supplied by the executor/test harness (§29).
//
// Signatures returned by the simulator are generated with the SAME
// secret the webhook verifies, over the canonical JSON serialization of
// the event payload — the exact contract the receiver checks.

import type { DemoDb } from '@rupturegrid/demo-db';
import {
  CANONICAL_CUSTOMER_REFERENCE,
  CANONICAL_CURRENCY,
  CANONICAL_PAYMENT_AMOUNT_MINOR,
  providerSignatureHex,
  randomId,
} from '@rupturegrid/demo-db';

export interface SimulatedEventEnvelope {
  providerEventId: string;
  eventType: 'PAYMENT_CONFIRMED' | 'PAYMENT_SETTLED';
  /** Exact values the executor should transmit as the JSON body. */
  payload: {
    providerPaymentId: string;
    providerEventId: string;
    eventType: string;
    amountMinor: string;
    currency: string;
  };
  /** HMAC-SHA256 (hex) over the canonical JSON of payload. */
  signature: string;
}

export interface SimulatedScenario {
  payment: {
    providerPaymentId: string;
    amountMinor: string;
    currency: string;
    walletId: string;
  };
  events: SimulatedEventEnvelope[];
}

export interface ProviderSimulatorService {
  createCanonicalPaymentScenario(): Promise<SimulatedScenario>;
}

export function createProviderSimulatorService(options: {
  db: DemoDb;
  signingSecret: string;
}): ProviderSimulatorService {
  const { db, signingSecret } = options;

  async function requireCanonicalWalletId(): Promise<string> {
    const customer = await db.client.customer.findUnique({
      where: { customerReference: CANONICAL_CUSTOMER_REFERENCE },
      include: { wallets: true },
    });
    const wallet = customer?.wallets[0];
    if (wallet === null || wallet === undefined) {
      throw new Error('canonical scenario missing: reset the demo scenario first');
    }
    return wallet.id;
  }

  return {
    /**
     * Creates one canonical logical payment (PKR 500000 paisa,
     * CONFIRMED) for the canonical wallet plus its two logical provider
     * events (confirmed + settled). Deterministic amounts/semantics;
     * identity values are unique per call.
     */
    async createCanonicalPaymentScenario(): Promise<SimulatedScenario> {
      const walletId = await requireCanonicalWalletId();
      const providerPaymentId = randomId('pp');

      const payment = await db.client.providerPayment.create({
        data: {
          providerPaymentId,
          amountMinor: CANONICAL_PAYMENT_AMOUNT_MINOR,
          currency: CANONICAL_CURRENCY,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          walletId,
        },
      });

      const events: SimulatedEventEnvelope[] = [];
      for (const eventType of ['PAYMENT_CONFIRMED', 'PAYMENT_SETTLED'] as const) {
        const providerEventId = randomId('pe');
        await db.client.providerEvent.create({
          data: {
            providerEventId,
            eventType,
            paymentId: payment.id,
          },
        });
        const payload = {
          providerPaymentId: payment.providerPaymentId,
          providerEventId,
          eventType,
          amountMinor: payment.amountMinor.toString(10),
          currency: payment.currency,
        };
        events.push({
          providerEventId,
          eventType,
          payload,
          signature: providerSignatureHex(
            signingSecret,
            Buffer.from(JSON.stringify(payload), 'utf8'),
          ),
        });
      }

      return {
        payment: {
          providerPaymentId: payment.providerPaymentId,
          amountMinor: payment.amountMinor.toString(10),
          currency: payment.currency,
          walletId: payment.walletId,
        },
        events,
      };
    },
  };
}
