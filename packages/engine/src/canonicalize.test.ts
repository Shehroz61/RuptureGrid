// =====================================================================
// Unit — snapshot canonicalization (ADR-0010 known vectors)
// =====================================================================
// These vectors are PERMANENT: the canonicalization algorithm
// (CANONICALIZATION_ALGORITHM = rg-canonical-jcs-v1) must never change
// its output without a version bump and a migration of stored hashes.
// If any of these tests change value, snapshots minted before the
// change can no longer be interpreted byte-faithfully.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalizeJson,
  canonicalizeAndHash,
  CANONICALIZATION_ALGORITHM,
  CanonicalizationError,
} from './canonicalize.js';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('canonicalization rg-canonical-jcs-v1', () => {
  it('sorts object keys lexicographically regardless of insertion order', () => {
    const a = canonicalizeJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
    const b = canonicalizeJson({ m: { b: 2, y: 1 }, a: 2, z: 1 });
    expect(a).toBe('{"a":2,"m":{"b":2,"y":1},"z":1}');
    expect(a).toBe(b);
  });

  it('preserves array order (sorting is object keys only)', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalizeJson({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
  });

  it('encodes strings per RFC 8259 (escapes quotes, backslashes, control chars)', () => {
    expect(canonicalizeJson('quote"inside')).toBe('"quote\\"inside"');
    expect(canonicalizeJson('back\\slash')).toBe('"back\\\\slash"');
    expect(canonicalizeJson('line\nbreak')).toBe('"line\\nbreak"');
    expect(canonicalizeJson('tab\there')).toBe('"tab\\there"');
  });

  it('emits integers without fraction or exponent', () => {
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson(-7)).toBe('-7');
    expect(canonicalizeJson(0)).toBe('0');
  });

  it('emits booleans and null canonically', () => {
    expect(canonicalizeJson(true)).toBe('true');
    expect(canonicalizeJson(false)).toBe('false');
    expect(canonicalizeJson(null)).toBe('null');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalizeJson(NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(-Infinity)).toThrow(CanonicalizationError);
  });

  it('rejects bigints, functions, symbols, undefined values', () => {
    expect(() => canonicalizeJson(1n)).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(() => 1)).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(Symbol('x'))).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson([undefined])).toThrow(CanonicalizationError);
  });

  it('rejects non-plain objects (class instances, Maps, Dates)', () => {
    class Fake {}
    expect(() => canonicalizeJson(new Fake())).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(new Map())).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson(new Date())).toThrow(CanonicalizationError);
  });

  it('KNOWN VECTOR: snapshot-shaped document', () => {
    const doc = {
      engineVersion: 'phase3-execution-v1',
      target: { origin: 'http://127.0.0.1:3002', environment: 'LOCAL_DEVELOPMENT' },
      steps: [{ name: 'deliver', action: { method: 'POST', repeat: 20, concurrency: 8 } }],
    };
    const canonical = canonicalizeJson(doc);
    // Keys sorted at every level; array order preserved; compact separators.
    expect(canonical).toBe(
      '{"engineVersion":"phase3-execution-v1","steps":[{"action":{"concurrency":8,"method":"POST","repeat":20},"name":"deliver"}],"target":{"environment":"LOCAL_DEVELOPMENT","origin":"http://127.0.0.1:3002"}}',
    );
    const { hash } = canonicalizeAndHash(doc);
    expect(hash).toBe(sha256(canonical));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('KNOWN VECTOR: unicode escapes deterministically', () => {
    // U+00E9 has a direct UTF-8 encoding; the canonical form embeds it
    // literally (JSON.stringify semantics) — stable across engines.
    const canonical = canonicalizeJson({ é: 'x' });
    expect(canonical).toBe('{"é":"x"}');
    expect(canonicalizeAndHash({ é: 'x' }).hash).toBe(sha256(canonical));
  });

  it('hash is stable across key insertion orders (the whole point)', () => {
    const docA = { b: { d: 4, c: 3 }, a: [1, { z: 1, y: 2 }] };
    const docB = { a: [1, { y: 2, z: 1 }], b: { c: 3, d: 4 } };
    expect(canonicalizeAndHash(docA).hash).toBe(canonicalizeAndHash(docB).hash);
  });

  it('algorithm identifier is the pinned version', () => {
    expect(CANONICALIZATION_ALGORITHM).toBe('rg-canonical-jcs-v1');
  });
});
