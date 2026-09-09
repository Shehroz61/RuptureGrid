// =====================================================================
// Demo Fintech — provider webhook payload contract
// =====================================================================
// Validation happens BEFORE any business resolution or financial
// mutation (Phase 2 contract §56, §58). Everything is rejected, never
// coerced: fractional amounts, negative/zero amounts, unsafe integer
// representations, invalid currency, unknown event types, missing or
// malformed identities.
//
// The webhook references a REGISTERED logical payment. It may not
// rewrite amount, currency or wallet: the stored ProviderPayment is
// authoritative (contract §57). Consistency between payload and stored
// payment is enforced in the processing service, not here — this module
// only establishes syntactic/semantic well-formedness.

import { CANONICAL_CURRENCY, MoneyFormatError, parseAmountMinor } from './money.js';
import { isWellFormedIdentity } from './identifiers.js';

export type ProviderEventType = 'PAYMENT_CONFIRMED' | 'PAYMENT_SETTLED';

export const PROVIDER_EVENT_TYPES: readonly ProviderEventType[] = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_SETTLED',
] as const;

export interface WebhookPayload {
  providerPaymentId: string;
  providerEventId: string;
  eventType: ProviderEventType;
  /** Exact validated integer minor units — the raw string is rejected,
   * never carried. */
  amountMinor: bigint;
  currency: string;
}

/** Thrown when a webhook payload is not well-formed. */
export class WebhookPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WebhookPayloadError';
  }
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebhookPayloadError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validates the raw JSON object of a provider webhook into a typed
 * payload. Throws WebhookPayloadError with a safe, secret-free message
 * on any violation.
 */
export function parseWebhookPayload(input: unknown): WebhookPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WebhookPayloadError('payload must be a JSON object');
  }
  const payload = input as Record<string, unknown>;

  const providerPaymentId = requireString(payload, 'providerPaymentId');
  const providerEventId = requireString(payload, 'providerEventId');
  if (!isWellFormedIdentity(providerPaymentId)) {
    throw new WebhookPayloadError('providerPaymentId is malformed');
  }
  if (!isWellFormedIdentity(providerEventId)) {
    throw new WebhookPayloadError('providerEventId is malformed');
  }

  const eventTypeRaw = requireString(payload, 'eventType');
  if (!(PROVIDER_EVENT_TYPES as readonly string[]).includes(eventTypeRaw)) {
    throw new WebhookPayloadError(`unknown eventType: ${eventTypeRaw}`);
  }
  const eventType = eventTypeRaw as ProviderEventType;

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountMinor(payload.amountMinor);
  } catch (error) {
    if (error instanceof MoneyFormatError) {
      throw new WebhookPayloadError(`invalid amountMinor: ${error.message}`);
    }
    throw error;
  }
  if (amountMinor <= 0n) {
    throw new WebhookPayloadError('amountMinor must be positive');
  }

  const currency = requireString(payload, 'currency');
  if (currency !== CANONICAL_CURRENCY) {
    throw new WebhookPayloadError(`unsupported currency: ${currency}`);
  }

  return { providerPaymentId, providerEventId, eventType, amountMinor, currency };
}
