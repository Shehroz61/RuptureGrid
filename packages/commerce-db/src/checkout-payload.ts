// =====================================================================
// Demo Commerce — checkout payload contract (typed, closed)
// =====================================================================
// The legitimate checkout submission contract (docs/checkout-zero.md
// §4): one logical intent identity, the equivalence tuple, and the
// resource. Money-like fields arrive as decimal integer STRINGS
// (no implicit precision; R-06/ADR-0004) and are parsed into exact
// bigint with explicit currency. Nothing is coerced, defaulted, or
// guessed: an invalid payload is rejected with a bounded, secret-free
// message.

import { isWellFormedIdentity } from './identifiers.js';

export class CheckoutPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CheckoutPayloadError';
  }
}

export interface CheckoutPayload {
  /** The logical checkout intent (stable across duplicate submissions). */
  readonly checkoutIntentId: string;
  /** Equivalence-tuple fields (ADR-0020 Decision 4). */
  readonly customerId: string;
  readonly cartId: string;
  /** Order total in integer minor units (exact bigint). */
  readonly totalMinor: bigint;
  readonly currency: string;
  /** The resource the checkout draws from. */
  readonly sku: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** 2^53 − 1: the JSON-safe integer envelope (mirrors the demo boundary). */
const SAFE_ABS_MAX = 9007199254740991n;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isWellFormedIdentity(value)) {
    throw new CheckoutPayloadError(`${field} must be a bounded identifier string`);
  }
  return value;
}

function parseMinorUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new CheckoutPayloadError(
      'totalMinor must be a decimal integer string in minor units (never a float, R-06)',
    );
  }
  const parsed = BigInt(value);
  if (parsed > SAFE_ABS_MAX) {
    throw new CheckoutPayloadError('totalMinor exceeds the accepted JSON-safe envelope');
  }
  return parsed;
}

/** Parses and validates one checkout submission payload. */
export function parseCheckoutPayload(raw: unknown): CheckoutPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CheckoutPayloadError('checkout payload must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set([
    'checkoutIntentId',
    'customerId',
    'cartId',
    'totalMinor',
    'currency',
    'sku',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CheckoutPayloadError(`unknown checkout payload field "${key}"`);
    }
  }
  const currencyRaw = record['currency'];
  if (typeof currencyRaw !== 'string' || !CURRENCY_PATTERN.test(currencyRaw)) {
    throw new CheckoutPayloadError('currency must be an ISO-4217 alpha-3 code');
  }
  return {
    checkoutIntentId: requireString(record['checkoutIntentId'], 'checkoutIntentId'),
    customerId: requireString(record['customerId'], 'customerId'),
    cartId: requireString(record['cartId'], 'cartId'),
    totalMinor: parseMinorUnits(record['totalMinor']),
    currency: currencyRaw,
    sku: requireString(record['sku'], 'sku'),
  };
}
