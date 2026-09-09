// =====================================================================
// Demo Fintech — JSON-safe integer envelope
// =====================================================================
// Phase 2 amounts are stored as exact bigint. The HTTP boundary accepts
// decimal integer STRINGS (no implicit precision), so the envelope
// exists to bound input absurdity, not to fix a JSON.parse limitation.
// It mirrors the IEEE-754 double-integer range as a familiar bound.

/** 2^53 - 1 — the largest integer exactly representable as a JS double. */
export const BIGINT_SAFE_ABS_MAX = 9007199254740991n;

/** True when a non-negative bigint fits the accepted envelope. */
export function isSafeBigInt(value: bigint): boolean {
  return value >= 0n && value <= BIGINT_SAFE_ABS_MAX;
}

/** Thrown when a bigint value cannot be represented safely for HTTP. */
export class UnsafeBigIntError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsafeBigIntError';
  }
}

/** Converts a non-negative bigint to its canonical decimal DTO string. */
export function bigintToString(value: bigint): string {
  if (!isSafeBigInt(value)) {
    throw new UnsafeBigIntError(`value ${value.toString()} exceeds the JSON-safe envelope`);
  }
  return value.toString(10);
}
