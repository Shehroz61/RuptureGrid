// =====================================================================
// RuptureGrid v1.0 — deterministic snapshot canonicalization (ADR-0010)
// =====================================================================
// The Phase 0 deferred question ("snapshot storage format details and
// canonicalization algorithm — Phase 3; must be stable and testable")
// is resolved here. The contract, documented permanently:
//
// 1. Object keys are sorted lexicographically by UTF-16 code unit
//    (JavaScript's default string comparison — stable across engines
//    and platforms for the identifier set used in snapshots).
// 2. Arrays preserve their order.
// 3. Strings are JSON-encoded (which escapes control characters and
//    the quote character deterministically per RFC 8259 §7).
// 4. Numbers: integers are emitted without fraction/exponent; all
//    other numbers use their shortest round-tripping representation
//    (Number.prototype.toString, IEEE-754 binary64). Snapshots are
//    built from JSON documents, so -0, NaN, Infinity never occur.
// 5. `null` emits as `null`; booleans as `true`/`false`.
// 6. Unsupported values (functions, symbols, bigints, undefined in
//    arrays, non-plain objects) are REJECTED, never coerced — an
//    object that survives canonicalization is exactly representable.
// 7. The canonical form is a UTF-8 byte sequence; the snapshot hash
//    is SHA-256 over those bytes.
//
// JSON.stringify on an arbitrary object does NOT satisfy this
// contract (key order is insertion order). Known-vector tests pin
// this behavior permanently (packages/engine/src/canonicalize.test.ts).

import { createHash } from 'node:crypto';

export const CANONICALIZATION_ALGORITHM = 'rg-canonical-jcs-v1';

export class CanonicalizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number cannot be canonicalized: ${value}`);
  }
}

function canonicalizeNumber(value: number): string {
  assertJsonNumber(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    return String(value);
  }
  // Shortest round-tripping representation for non-integers.
  return String(value);
}

function canonicalize(value: unknown, path: string): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalizeNumber(value);
    case 'bigint':
      throw new CanonicalizationError(
        `bigint cannot be canonicalized (convert to string first) at ${path}`,
      );
    case 'undefined':
      throw new CanonicalizationError(`undefined cannot be canonicalized at ${path}`);
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} cannot be canonicalized at ${path}`);
    case 'object': {
      if (value === null) {
        return 'null';
      }
      if (Array.isArray(value)) {
        const items = value.map((item, index) => canonicalize(item, `${path}[${index}]`));
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalizationError(
          `non-plain object of constructor [${(value as object).constructor?.name ?? 'unknown'}] ` +
            `cannot be canonicalized at ${path}`,
        );
      }
      const keys = Object.keys(value).sort();
      const entries = keys.map((key) => {
        const fieldValue = value[key];
        if (fieldValue === undefined) {
          throw new CanonicalizationError(
            `property "${key}" is undefined; drop the key instead at ${path}.${key}`,
          );
        }
        return `${JSON.stringify(key)}:${canonicalize(fieldValue, `${path}.${key}`)}`;
      });
      return `{${entries.join(',')}}`;
    }
    default: {
      throw new CanonicalizationError(`unsupported value of type ${typeof value} at ${path}`);
    }
  }
}

/**
 * Produces the canonical JSON string for an input document.
 * Deterministic across processes and platforms: key order is sorted,
 * array order preserved, primitives encoded per RFC 8259, unsupported
 * values rejected. Throws CanonicalizationError on any
 * non-representable input.
 */
export function canonicalizeJson(input: unknown): string {
  return canonicalize(input, '$');
}

/**
 * Canonicalizes and hashes the input in one step.
 * Returns the canonical string and its SHA-256 hex digest.
 */
export function canonicalizeAndHash(input: unknown): {
  canonical: string;
  hash: string;
} {
  const canonical = canonicalizeJson(input);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { canonical, hash };
}
