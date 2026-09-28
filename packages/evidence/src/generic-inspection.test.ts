// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic inspection shape validation (unit)
// =====================================================================
// Unit matrix for ADR-0021 §3–§5 shape validation: JSON-array grammar,
// exact declared field sets, declared primitive types with NO
// coercion, one-invalid-element whole-capture invalidation, and `[]`
// as a valid empty capture. Pure functions — no infrastructure.

import { describe, expect, it } from 'vitest';
import { validateGenericInspectionCapture } from './generic-inspection.js';

const FIELDS = {
  orderId: 'string',
  totalMinorUnits: 'integer-minor-units',
  accepted: 'boolean',
  createdAt: 'timestamp',
} as const;

const validEntity = {
  orderId: 'ORD-1',
  totalMinorUnits: 250000,
  accepted: true,
  createdAt: '2026-09-27T01:00:00Z',
};

describe('Phase 14: generic inspection capture shape validation (ADR-0021)', () => {
  it('accepts a valid array with one entity', () => {
    const verdict = validateGenericInspectionCapture([validEntity], { fields: FIELDS });
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCode).toBe('VALID');
  });

  it('accepts a valid array with multiple entities', () => {
    const verdict = validateGenericInspectionCapture(
      [validEntity, { ...validEntity, orderId: 'ORD-2' }],
      { fields: FIELDS },
    );
    expect(verdict.valid).toBe(true);
  });

  it('accepts the empty array as a valid empty capture', () => {
    const verdict = validateGenericInspectionCapture([], { fields: FIELDS });
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCode).toBe('VALID');
  });

  it('rejects a non-array response', () => {
    expect(validateGenericInspectionCapture({ items: [] }, { fields: FIELDS }).reasonCode).toBe(
      'RESPONSE_NOT_ARRAY',
    );
    expect(validateGenericInspectionCapture(null, { fields: FIELDS }).reasonCode).toBe(
      'RESPONSE_NOT_ARRAY',
    );
    expect(validateGenericInspectionCapture('[]', { fields: FIELDS }).reasonCode).toBe(
      'RESPONSE_NOT_ARRAY',
    );
  });

  it('rejects a primitive array member', () => {
    const verdict = validateGenericInspectionCapture([validEntity, 'nope'], { fields: FIELDS });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('ELEMENT_NOT_OBJECT');
    expect(verdict.detail).toContain('element 1');
  });

  it('rejects a missing declared field', () => {
    const partial: Record<string, unknown> = { ...validEntity };
    delete partial['createdAt'];
    const verdict = validateGenericInspectionCapture([partial], { fields: FIELDS });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('MISSING_FIELD');
    expect(verdict.detail).toContain('createdAt');
  });

  it('rejects an unknown field', () => {
    const verdict = validateGenericInspectionCapture([{ ...validEntity, mystery: 'x' }], {
      fields: FIELDS,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('UNKNOWN_FIELD');
    expect(verdict.detail).toContain('mystery');
  });

  it('rejects a wrong string type', () => {
    const verdict = validateGenericInspectionCapture([{ ...validEntity, orderId: 7 }], {
      fields: FIELDS,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('TYPE_MISMATCH');
    expect(verdict.detail).toContain('orderId');
  });

  it('rejects a wrong boolean type (no coercion)', () => {
    const verdict = validateGenericInspectionCapture([{ ...validEntity, accepted: 'true' }], {
      fields: FIELDS,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('TYPE_MISMATCH');
    expect(verdict.detail).toContain('accepted');
  });

  it('rejects a wrong integer-minor-units representation (no coercion, R-06)', () => {
    // Numeric string is NOT an integer.
    expect(
      validateGenericInspectionCapture([{ ...validEntity, totalMinorUnits: '250000' }], {
        fields: FIELDS,
      }).valid,
    ).toBe(false);
    // Fractional number is NOT an integer.
    expect(
      validateGenericInspectionCapture([{ ...validEntity, totalMinorUnits: 250000.5 }], {
        fields: FIELDS,
      }).valid,
    ).toBe(false);
    // Boolean is NOT an integer.
    expect(
      validateGenericInspectionCapture([{ ...validEntity, totalMinorUnits: true }], {
        fields: FIELDS,
      }).valid,
    ).toBe(false);
  });

  it('rejects a wrong timestamp representation (no Date parsing, no epoch numbers)', () => {
    expect(
      validateGenericInspectionCapture([{ ...validEntity, createdAt: 'not-a-timestamp' }], {
        fields: FIELDS,
      }).valid,
    ).toBe(false);
    expect(
      validateGenericInspectionCapture([{ ...validEntity, createdAt: 1727380000 }], {
        fields: FIELDS,
      }).valid,
    ).toBe(false);
    // A valid ISO-8601 date-only string with a time and offset passes.
    expect(
      validateGenericInspectionCapture(
        [{ ...validEntity, createdAt: '2026-09-27T01:00:00+05:00' }],
        {
          fields: FIELDS,
        },
      ).valid,
    ).toBe(true);
  });

  it('invalidates the WHOLE capture when one element fails (no partial salvage)', () => {
    const verdict = validateGenericInspectionCapture(
      [validEntity, { ...validEntity, orderId: 99 }, { ...validEntity, orderId: 'ORD-3' }],
      { fields: FIELDS },
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('TYPE_MISMATCH');
    expect(verdict.detail).toContain('element 1');
  });

  it('validation is deterministic across repeated runs', () => {
    const capture = [validEntity, { ...validEntity, orderId: 'ORD-2' }];
    const first = validateGenericInspectionCapture(capture, { fields: FIELDS });
    const second = validateGenericInspectionCapture(capture, { fields: FIELDS });
    expect(first).toEqual(second);
  });
});
