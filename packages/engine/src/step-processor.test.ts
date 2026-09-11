// =====================================================================
// Unit — ${steps.…} response reference extraction (Phase 3 §72)
// =====================================================================
// Bounded syntax, no code execution, and NO prototype traversal:
// a reference path through `__proto__`/`constructor`/`prototype`
// resolves to nothing — it must never walk the object chain or reach
// anything that is not recorded response data.

import { describe, expect, it } from 'vitest';
import { extractJsonPath } from './step-processor.js';

const body = JSON.stringify({
  payment: { providerPaymentId: 'pp-123', events: [{ payload: { id: 'ev-0' } }] },
});

describe('extractJsonPath (§72 bounded reference mechanics)', () => {
  it('resolves dot paths, bracket indices, and nested objects', () => {
    expect(extractJsonPath(body, 'payment.providerPaymentId')).toBe('pp-123');
    expect(extractJsonPath(body, 'payment.events[0].payload.id')).toBe('ev-0');
    expect(extractJsonPath(body, 'payment.events.0.payload')).toBe('{"id":"ev-0"}');
  });

  it('returns null for unknown paths, non-JSON, and missing bodies', () => {
    expect(extractJsonPath(body, 'payment.missing')).toBeNull();
    expect(extractJsonPath(body, 'payment.events[5].payload')).toBeNull();
    expect(extractJsonPath('not-json', 'a')).toBeNull();
    expect(extractJsonPath(null, 'a')).toBeNull();
  });

  it('denies prototype traversal (no __proto__/constructor/prototype access)', () => {
    expect(extractJsonPath(body, '__proto__')).toBeNull();
    expect(extractJsonPath(body, 'payment.__proto__.polluted')).toBeNull();
    expect(extractJsonPath(body, 'constructor.prototype')).toBeNull();
    expect(extractJsonPath(body, 'payment.constructor.name')).toBeNull();
    expect(extractJsonPath(body, 'prototype.x')).toBeNull();
    // And nothing was polluted:
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
