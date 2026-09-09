// =====================================================================
// Demo Fintech — exact integer money (AGENTS R-06, ADR-0004)
// =====================================================================
// Money is ALWAYS an integer number of minor units (paisa for PKR).
// Floating-point arithmetic is categorically absent: this module only
// ever converts validated decimal integer STRINGS to bigint.
//
// Canonical HTTP representation (documented contract, tested):
//
//   amountMinor: "500000"   — decimal integer string
//
// Strings are used because they carry no implicit precision and cannot
// silently round. Fractional, exponent-notation, whitespace, sign and
// unsafe-magnitude values are REJECTED, never coerced. Currency always
// travels with the amount.

import { BIGINT_SAFE_ABS_MAX } from './bigint-safe.js';

/** Canonical currency for Incident Zero. */
export const CANONICAL_CURRENCY = 'PKR';

/**
 * Parses a decimal integer minor-unit amount to exact bigint.
 * Rejects: non-strings, empty strings, signs, whitespace, fractional
 * digits, exponent notation, and magnitudes beyond the JSON-safe
 * envelope. Never rounds, never coerces.
 */
export function parseAmountMinor(input: unknown): bigint {
  if (typeof input !== 'string') {
    throw new MoneyFormatError('amountMinor must be a decimal integer string (e.g. "500000")');
  }
  if (!/^[0-9]+$/.test(input)) {
    throw new MoneyFormatError('amountMinor must be a plain decimal integer string');
  }
  if (input.length > 1 && input[0] === '0') {
    throw new MoneyFormatError('amountMinor must not carry leading zeros');
  }
  const value = BigInt(input);
  if (value > BIGINT_SAFE_ABS_MAX) {
    throw new MoneyFormatError(
      `amountMinor exceeds the accepted magnitude (${BIGINT_SAFE_ABS_MAX})`,
    );
  }
  return value;
}

/** Thrown for any malformed money representation. */
export class MoneyFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MoneyFormatError';
  }
}

/** True when `a` and `b` are the same currency AND exact same amount. */
export function sameMoney(
  a: { amountMinor: bigint; currency: string },
  b: {
    amountMinor: bigint;
    currency: string;
  },
): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}

/** Serializes an exact integer amount into its canonical DTO string. */
export function amountMinorToString(amountMinor: bigint): string {
  return amountMinor.toString(10);
}
