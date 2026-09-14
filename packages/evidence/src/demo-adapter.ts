// =====================================================================
// RuptureGrid v1.0 — Demo Fintech target observation adapter (Phase 4)
// =====================================================================
// EXPLICIT target evidence adapter for Demo Fintech v1 (prompt §28):
// the ONLY Phase 4 adapter. It fetches the target-authored read-only
// inspection lineage for ONE logical payment over HTTP with the
// inspection credential, validates the response shape, and captures it
// as a raw target_observation (chain-appended, redacted before
// hashing). Selection is EXPLICIT — an explicit adapter call with the
// recorded adapter kind; semantic interpretation is never selected by
// path substring matching (§29): a JSON body that happens to contain
// "wallet"/"payment" fields is NEVER interpreted as business truth.

import type { PrismaClient } from '@rupturegrid/control-db';
import { RawObservationStore } from './raw-observation-store.js';

/** The single explicitly supported adapter kind in Phase 4. */
export const DEMO_LINEAGE_ADAPTER_KIND = 'demo-fintech-payment-lineage';

export class DemoAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DemoAdapterError';
  }
}

export interface DemoAdapterConfig {
  /** Registered origin of the Demo target (scheme://host:port). */
  readonly origin: string;
  /** Inspection credential VALUE (resolved at request time, ADR-0012). */
  readonly inspectionToken: string | null;
}

export interface DemoLineagePayload {
  payment: {
    providerPaymentId: string;
    walletId: string;
    amountMinor: string;
    currency: string;
    status: string;
  };
  events: Array<{ providerEventId: string; providerPaymentId: string; eventType: string }>;
  deliveries: Array<{ deliveryAttemptId: string; providerEventId: string; status: string }>;
  processingAttempts: Array<{
    processingAttemptId: string;
    deliveryAttemptId: string;
    outcome: string | null;
  }>;
  financialEffects: Array<{
    financialEffectId: string;
    providerPaymentId: string;
    processingAttemptId: string;
    walletId: string;
    effectType: string;
    amountMinor: string;
    currency: string;
    createdAt: string;
  }>;
  ledgerEntries: Array<{
    financialEffectId: string;
    walletId: string;
    entryType: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string | null;
    createdAt: string;
  }>;
  wallet: { walletId: string; balanceMinor: string; currency: string };
  counts: {
    events: number;
    deliveries: number;
    processingAttempts: number;
    financialEffects: number;
    ledgerEntries: number;
  };
  processingMode: string;
}

export interface CapturedLineage {
  readonly observationId: string;
  readonly observationHash: string;
  readonly chainIndex: number;
  readonly payload: DemoLineagePayload;
}

/**
 * Shape-validates the inspection lineage response. Validation is
 * structural and secret-free: values are checked, never interpreted.
 * Throws DemoAdapterError on any mismatch (an unusable response is
 * adapter reality, not silently normalized).
 */
export function validateLineage(raw: unknown): DemoLineagePayload {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const str = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new DemoAdapterError(`lineage field ${field} must be a non-empty string`);
    }
    return value;
  };
  const int = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new DemoAdapterError(`lineage field ${field} must be a non-negative integer`);
    }
    return value;
  };

  if (!isRecord(raw)) {
    throw new DemoAdapterError('lineage response must be a JSON object');
  }
  const payment = isRecord(raw['payment']) ? raw['payment'] : null;
  if (payment === null) {
    throw new DemoAdapterError('lineage.payment must be an object');
  }
  const wallet = isRecord(raw['wallet']) ? raw['wallet'] : null;
  if (wallet === null) {
    throw new DemoAdapterError('lineage.wallet must be an object');
  }
  const counts = isRecord(raw['counts']) ? raw['counts'] : null;
  if (counts === null) {
    throw new DemoAdapterError('lineage.counts must be an object');
  }
  const asRecordArray = (value: unknown, field: string): Record<string, unknown>[] => {
    if (!Array.isArray(value)) {
      throw new DemoAdapterError(`lineage.${field} must be an array`);
    }
    return value.map((item, index) => {
      if (!isRecord(item)) {
        throw new DemoAdapterError(`lineage.${field}[${index}] must be an object`);
      }
      return item;
    });
  };

  const events = asRecordArray(raw['events'], 'events');
  const deliveries = asRecordArray(raw['deliveries'], 'deliveries');
  const processingAttempts = asRecordArray(raw['processingAttempts'], 'processingAttempts');
  const financialEffects = asRecordArray(raw['financialEffects'], 'financialEffects');
  const ledgerEntries = asRecordArray(raw['ledgerEntries'], 'ledgerEntries');

  const lineage: DemoLineagePayload = {
    payment: {
      providerPaymentId: str(payment['providerPaymentId'], 'payment.providerPaymentId'),
      walletId: str(payment['walletId'], 'payment.walletId'),
      amountMinor: str(payment['amountMinor'], 'payment.amountMinor'),
      currency: str(payment['currency'], 'payment.currency'),
      status: str(payment['status'], 'payment.status'),
    },
    events: events.map((event) => ({
      providerEventId: str(event['providerEventId'], 'event.providerEventId'),
      providerPaymentId: str(event['providerPaymentId'], 'event.providerPaymentId'),
      eventType: str(event['eventType'], 'event.eventType'),
    })),
    deliveries: deliveries.map((delivery) => ({
      deliveryAttemptId: str(delivery['deliveryAttemptId'], 'delivery.deliveryAttemptId'),
      providerEventId: str(delivery['providerEventId'], 'delivery.providerEventId'),
      status: str(delivery['status'], 'delivery.status'),
    })),
    processingAttempts: processingAttempts.map((attempt) => ({
      processingAttemptId: str(attempt['processingAttemptId'], 'attempt.processingAttemptId'),
      deliveryAttemptId: str(attempt['deliveryAttemptId'], 'attempt.deliveryAttemptId'),
      outcome: attempt['outcome'] === null ? null : str(attempt['outcome'], 'attempt.outcome'),
    })),
    financialEffects: financialEffects.map((effect) => ({
      financialEffectId: str(effect['financialEffectId'], 'effect.financialEffectId'),
      providerPaymentId: str(effect['providerPaymentId'], 'effect.providerPaymentId'),
      processingAttemptId: str(effect['processingAttemptId'], 'effect.processingAttemptId'),
      walletId: str(effect['walletId'], 'effect.walletId'),
      effectType: str(effect['effectType'], 'effect.effectType'),
      amountMinor: str(effect['amountMinor'], 'effect.amountMinor'),
      currency: str(effect['currency'], 'effect.currency'),
      createdAt: str(effect['createdAt'], 'effect.createdAt'),
    })),
    ledgerEntries: ledgerEntries.map((entry) => ({
      financialEffectId: str(entry['financialEffectId'], 'ledger.financialEffectId'),
      walletId: str(entry['walletId'], 'ledger.walletId'),
      entryType: str(entry['entryType'], 'ledger.entryType'),
      amountMinor: str(entry['amountMinor'], 'ledger.amountMinor'),
      currency: str(entry['currency'], 'ledger.currency'),
      idempotencyKey:
        entry['idempotencyKey'] === null
          ? null
          : str(entry['idempotencyKey'], 'ledger.idempotencyKey'),
      createdAt: str(entry['createdAt'], 'ledger.createdAt'),
    })),
    wallet: {
      walletId: str(wallet['walletId'], 'wallet.walletId'),
      balanceMinor: str(wallet['balanceMinor'], 'wallet.balanceMinor'),
      currency: str(wallet['currency'], 'wallet.currency'),
    },
    counts: {
      events: int(counts['events'], 'counts.events'),
      deliveries: int(counts['deliveries'], 'counts.deliveries'),
      processingAttempts: int(counts['processingAttempts'], 'counts.processingAttempts'),
      financialEffects: int(counts['financialEffects'], 'counts.financialEffects'),
      ledgerEntries: int(counts['ledgerEntries'], 'counts.ledgerEntries'),
    },
    processingMode: str(raw['processingMode'], 'processingMode'),
  };
  return lineage;
}

/**
 * Fetches and captures the inspection lineage for one logical payment.
 * The lineage payload is stored REDACTED as a target_observation raw
 * observation (chain-appended). The returned payload is the stored
 * (redacted) document — the normalizer's input. The inspection token
 * exists only inside this call frame (ADR-0012).
 */
export async function captureDemoPaymentLineage(
  prisma: PrismaClient,
  input: {
    readonly runId: string;
    readonly stepRunId: string | null;
    readonly origin: string;
    readonly inspectionToken: string | null;
    readonly providerPaymentId: string;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  },
): Promise<CapturedLineage> {
  if (input.inspectionToken === null || input.inspectionToken === '') {
    throw new DemoAdapterError(
      'inspection credential is not available; target observation cannot be captured',
    );
  }
  const url = `${input.origin}/inspection/provider-payments/${encodeURIComponent(input.providerPaymentId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${input.inspectionToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new DemoAdapterError(
      `inspection lineage fetch failed: HTTP ${response.status} (read-only adapter; no retry)`,
    );
  }
  const raw: unknown = await response.json();
  const payload = validateLineage(raw);
  const store = new RawObservationStore(prisma);
  const appended = await store.appendTargetObservation({
    runId: input.runId,
    stepRunId: input.stepRunId,
    adapterKind: DEMO_LINEAGE_ADAPTER_KIND,
    observedAt: new Date(),
    payload,
    writerOwnerId: input.writerOwnerId,
    writerFencingToken: input.writerFencingToken,
  });
  return {
    observationId: appended.id,
    observationHash: appended.contentHash,
    chainIndex: appended.chainIndex,
    payload,
  };
}
