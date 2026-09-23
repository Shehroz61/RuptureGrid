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
  /** Phase 9: whole-wallet accepted-credit ledger sum (target's own reconciliation). */
  walletLedgerCreditSumMinor: string;
  /** Phase 9: balanceMinor − walletLedgerCreditSumMinor (target's own arithmetic). */
  walletBalanceDifferenceMinor: string;
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
    walletLedgerCreditSumMinor: str(
      raw['walletLedgerCreditSumMinor'],
      'walletLedgerCreditSumMinor',
    ),
    walletBalanceDifferenceMinor: str(
      raw['walletBalanceDifferenceMinor'],
      'walletBalanceDifferenceMinor',
    ),
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

// =====================================================================
// Phase 9 — Demo fault-status observation adapter
// (docs/controlled-faults.md §5: `demo-fintech-fault-status`)
// =====================================================================
// Captures the target's OWN view of its fault plans through the
// READ-ONLY inspection API (GET /inspection/faults). This is
// target-authored activation truth: "configured vs activated" is never
// inferred from error shapes — a triggerCount ≥ 1 in THIS observation
// is the persisted basis for "activated". Stored as a target_observation
// raw observation (redacted, hash-chained, provenance-recorded) exactly
// like every other observed fact; no new observation origin class.

/** The explicit Phase 9 adapter kind for fault-state observation. */
export const DEMO_FAULT_STATUS_ADAPTER_KIND = 'demo-fintech-fault-status';

export interface DemoFaultPlanState {
  readonly faultKind: string;
  readonly planVersion: string;
  readonly activation: string;
  readonly maxTriggers: number;
  readonly triggersUsed: number;
  readonly armedAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
}

export interface DemoFaultStatusPayload {
  readonly plans: readonly DemoFaultPlanState[];
}

export interface CapturedFaultStatus {
  readonly observationId: string;
  readonly observationHash: string;
  readonly chainIndex: number;
  readonly payload: DemoFaultStatusPayload;
}

/**
 * Shape-validates the fault-status inspection response. Structural
 * only; values are checked, never interpreted.
 */
export function validateFaultStatus(raw: unknown): DemoFaultStatusPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DemoAdapterError('fault status response must be a JSON object');
  }
  const plans = (raw as Record<string, unknown>)['plans'];
  if (!Array.isArray(plans)) {
    throw new DemoAdapterError('fault status response must contain a plans array');
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const str = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new DemoAdapterError(`fault status field ${field} must be a non-empty string`);
    }
    return value;
  };
  const int = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new DemoAdapterError(`fault status field ${field} must be a non-negative integer`);
    }
    return value;
  };
  const bool = (value: unknown, field: string): boolean => {
    if (typeof value !== 'boolean') {
      throw new DemoAdapterError(`fault status field ${field} must be a boolean`);
    }
    return value;
  };
  return {
    plans: plans.map((plan, index): DemoFaultPlanState => {
      if (!isRecord(plan)) {
        throw new DemoAdapterError(`fault status plans[${index}] must be an object`);
      }
      return {
        faultKind: str(plan['faultKind'], 'plan.faultKind'),
        planVersion: str(plan['planVersion'], 'plan.planVersion'),
        activation: str(plan['activation'], 'plan.activation'),
        maxTriggers: int(plan['maxTriggers'], 'plan.maxTriggers'),
        triggersUsed: int(plan['triggersUsed'], 'plan.triggersUsed'),
        armedAt: str(plan['armedAt'], 'plan.armedAt'),
        expiresAt: str(plan['expiresAt'], 'plan.expiresAt'),
        expired: bool(plan['expired'], 'plan.expired'),
      };
    }),
  };
}

/**
 * Fetches and captures the Demo target's own fault-status view. The
 * token exists only inside this call frame (ADR-0012); the payload is
 * stored redacted as a target_observation raw observation.
 */
export async function captureDemoFaultStatus(
  prisma: PrismaClient,
  input: {
    readonly runId: string;
    readonly stepRunId: string | null;
    readonly origin: string;
    readonly inspectionToken: string | null;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  },
): Promise<CapturedFaultStatus> {
  if (input.inspectionToken === null || input.inspectionToken === '') {
    throw new DemoAdapterError(
      'inspection credential is not available; fault-status observation cannot be captured',
    );
  }
  const url = `${input.origin}/inspection/faults`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${input.inspectionToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new DemoAdapterError(
      `fault-status fetch failed: HTTP ${response.status} (read-only adapter; no retry)`,
    );
  }
  const raw: unknown = await response.json();
  const payload = validateFaultStatus(raw);
  const store = new RawObservationStore(prisma);
  const appended = await store.appendTargetObservation({
    runId: input.runId,
    stepRunId: input.stepRunId,
    adapterKind: DEMO_FAULT_STATUS_ADAPTER_KIND,
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
