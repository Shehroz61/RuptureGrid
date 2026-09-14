// =====================================================================
// RuptureGrid v1.0 — deterministic normalization (Phase 4, §25–§27)
// =====================================================================
// A NormalizedEvent is DETERMINISTIC DERIVED evidence (evidence-model
// §1/§2): same normalizer version + same stored observation input ⇒
// same event semantic content, always. This module is PURE:
//   - no Math.random, no LLM, no wall-clock business derivation
//   - no network lookups, no mutable global state
// Only stored REDACTED observation payloads are interpreted. Bodies
// that do not parse as the documented Demo shapes produce NO events —
// unknown structure is never guessed into business meaning.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import {
  DEMO_LINEAGE_NORMALIZER_NAME,
  DEMO_LINEAGE_NORMALIZER_VERSION,
  INVOCATION_NORMALIZER_NAME,
  INVOCATION_NORMALIZER_VERSION,
} from './versions.js';

export interface NormalizedEventSpec {
  readonly eventType: string;
  readonly subjectKey: string | null;
  readonly payload: unknown;
  readonly normalizerName: string;
  readonly normalizerVersion: string;
  readonly sourceObservationHashes: readonly string[];
  readonly primaryObservationIndex: number | null;
}

/**
 * SHA-256 of the canonical derivation input — the idempotency key.
 * The input covers BOTH the source observation content hashes AND the
 * event's semantic payload: one lineage observation normalizes into
 * MANY distinct events (six deliveries, two effects, …), and each is
 * its own deterministic row keyed by its own meaning. Deriving the
 * same event from the same input always yields the same hash
 * (idempotent); deriving an event with different meaning yields a
 * different hash (its own row) — never a silent collapse.
 */
export function eventInputHash(
  sourceObservationHashes: readonly string[],
  payload?: unknown,
): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        sources: [...sourceObservationHashes].sort(),
        ...(payload === undefined ? {} : { payload }),
      }),
    )
    .digest('hex');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------
// Invocation observations → delivery-observed events
// ---------------------------------------------------------------------

/**
 * Normalizes ONE stored invocation observation (executor evidence).
 * Emits a `demo.payment-delivery-observed` event only when the stored
 * request body parses as the Demo webhook payload shape — the Demo
 * contract's documented body. Admin/mode/other invocations yield no
 * events (not business events; honestly absent rather than invented).
 */
export function normalizeInvocationObservation(input: {
  readonly contentHash: string;
  readonly chainIndex: number;
  readonly payload: unknown;
}): NormalizedEventSpec[] {
  if (!isRecord(input.payload)) {
    return [];
  }
  const http = input.payload['http'];
  if (!isRecord(http)) {
    return [];
  }
  const bodyText = http['requestBody'];
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    return [];
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return []; // Not a JSON body: no business meaning is invented.
  }
  if (!isRecord(body)) {
    return [];
  }
  const providerPaymentId = body['providerPaymentId'];
  const providerEventId = body['providerEventId'];
  const eventType = body['eventType'];
  const amountMinor = body['amountMinor'];
  const currency = body['currency'];
  if (
    typeof providerPaymentId !== 'string' ||
    typeof providerEventId !== 'string' ||
    typeof eventType !== 'string' ||
    typeof amountMinor !== 'string' ||
    typeof currency !== 'string'
  ) {
    return []; // Not the Demo webhook payload shape.
  }
  // The stored response body carries the target's own processing
  // outcome (from the webhook HTTP response captured by the executor).
  const responseText = http['responseBody'];
  let processingAttemptId: string | null = null;
  let deliveryOutcome: string | null = null;
  let financialEffectId: string | null = null;
  if (typeof responseText === 'string' && responseText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (isRecord(parsed)) {
        processingAttemptId =
          typeof parsed['processingAttemptId'] === 'string' ? parsed['processingAttemptId'] : null;
        deliveryOutcome = typeof parsed['outcome'] === 'string' ? parsed['outcome'] : null;
        financialEffectId =
          typeof parsed['financialEffectId'] === 'string' ? parsed['financialEffectId'] : null;
      }
    } catch {
      // Response not JSON: outcome fields stay null (honest).
    }
  }

  const payload = {
    providerPaymentId,
    providerEventId,
    eventType,
    amountMinor,
    currency,
    deliveryAttemptId: null as string | null,
    processingAttemptId,
    deliveryOutcome,
    financialEffectId,
    sourceObservation: {
      kind: 'invocation',
      contentHash: input.contentHash,
      chainIndex: input.chainIndex,
    },
  };
  return [
    {
      eventType: 'demo.payment-delivery-observed',
      subjectKey: providerPaymentId,
      payload,
      normalizerName: INVOCATION_NORMALIZER_NAME,
      normalizerVersion: INVOCATION_NORMALIZER_VERSION,
      sourceObservationHashes: [input.contentHash],
      primaryObservationIndex: input.chainIndex,
    },
  ];
}

// ---------------------------------------------------------------------
// Target observations (Demo lineage) → entity events
// ---------------------------------------------------------------------

/**
 * Normalizes ONE stored Demo inspection-lineage observation into typed
 * entity events. Every entity the target itself recorded becomes an
 * event whose payload preserves the EXPLICIT identity chain
 * (providerPaymentId → providerEventId → deliveryAttemptId →
 * processingAttemptId → financialEffectId) — target-owned truth,
 * read through the target's own read-only API.
 */
export function normalizeDemoLineageObservation(input: {
  readonly contentHash: string;
  readonly chainIndex: number;
  readonly payload: unknown;
}): NormalizedEventSpec[] {
  if (!isRecord(input.payload)) {
    return [];
  }
  const payment = input.payload['payment'];
  if (!isRecord(payment)) {
    return [];
  }
  const providerPaymentId = payment['providerPaymentId'];
  if (typeof providerPaymentId !== 'string') {
    return [];
  }
  const source = {
    kind: 'target_observation',
    contentHash: input.contentHash,
    chainIndex: input.chainIndex,
  };
  const hashes = [input.contentHash];
  const events: NormalizedEventSpec[] = [];

  const push = (eventType: string, subjectKey: string, payload: Record<string, unknown>): void => {
    events.push({
      eventType,
      subjectKey,
      payload: { ...payload, sourceObservation: source },
      normalizerName: DEMO_LINEAGE_NORMALIZER_NAME,
      normalizerVersion: DEMO_LINEAGE_NORMALIZER_VERSION,
      sourceObservationHashes: hashes,
      primaryObservationIndex: input.chainIndex,
    });
  };

  push('demo.provider-payment-observed', providerPaymentId, {
    providerPaymentId,
    walletId: payment['walletId'] ?? null,
    amountMinor: payment['amountMinor'] ?? null,
    currency: payment['currency'] ?? null,
    status: payment['status'] ?? null,
  });

  if (Array.isArray(input.payload['events'])) {
    for (const event of input.payload['events']) {
      if (!isRecord(event) || typeof event['providerEventId'] !== 'string') {
        continue;
      }
      push('demo.provider-event-observed', providerPaymentId, {
        providerEventId: event['providerEventId'],
        providerPaymentId,
        eventType: event['eventType'] ?? null,
      });
    }
  }
  if (Array.isArray(input.payload['deliveries'])) {
    for (const delivery of input.payload['deliveries']) {
      if (!isRecord(delivery) || typeof delivery['deliveryAttemptId'] !== 'string') {
        continue;
      }
      push('demo.webhook-delivery-observed', providerPaymentId, {
        deliveryAttemptId: delivery['deliveryAttemptId'],
        providerEventId: delivery['providerEventId'] ?? null,
        status: delivery['status'] ?? null,
      });
    }
  }
  if (Array.isArray(input.payload['processingAttempts'])) {
    for (const attempt of input.payload['processingAttempts']) {
      if (!isRecord(attempt) || typeof attempt['processingAttemptId'] !== 'string') {
        continue;
      }
      push('demo.processing-attempt-observed', providerPaymentId, {
        processingAttemptId: attempt['processingAttemptId'],
        deliveryAttemptId: attempt['deliveryAttemptId'] ?? null,
        outcome: attempt['outcome'] ?? null,
      });
    }
  }
  if (Array.isArray(input.payload['financialEffects'])) {
    for (const effect of input.payload['financialEffects']) {
      if (!isRecord(effect) || typeof effect['financialEffectId'] !== 'string') {
        continue;
      }
      push('demo.financial-effect-observed', providerPaymentId, {
        financialEffectId: effect['financialEffectId'],
        providerPaymentId: effect['providerPaymentId'] ?? null,
        processingAttemptId: effect['processingAttemptId'] ?? null,
        walletId: effect['walletId'] ?? null,
        effectType: effect['effectType'] ?? null,
        amountMinor: effect['amountMinor'] ?? null,
        currency: effect['currency'] ?? null,
        createdAt: effect['createdAt'] ?? null,
      });
    }
  }
  if (Array.isArray(input.payload['ledgerEntries'])) {
    for (const entry of input.payload['ledgerEntries']) {
      if (!isRecord(entry) || typeof entry['financialEffectId'] !== 'string') {
        continue;
      }
      push('demo.ledger-entry-observed', providerPaymentId, {
        financialEffectId: entry['financialEffectId'],
        walletId: entry['walletId'] ?? null,
        entryType: entry['entryType'] ?? null,
        amountMinor: entry['amountMinor'] ?? null,
        currency: entry['currency'] ?? null,
        idempotencyKey: entry['idempotencyKey'] ?? null,
      });
    }
  }
  const wallet = input.payload['wallet'];
  if (isRecord(wallet) && typeof wallet['walletId'] === 'string') {
    push('demo.wallet-state-observed', providerPaymentId, {
      walletId: wallet['walletId'],
      balanceMinor: wallet['balanceMinor'] ?? null,
      currency: wallet['currency'] ?? null,
    });
  }
  return events;
}
