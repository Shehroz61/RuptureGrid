// =====================================================================
// RuptureGrid v1.1 Phase 14 — target sensitiveFields redaction (unit)
// =====================================================================
// Proves: target-declared sensitive fields are ADDITIVE to the
// built-in denylist (never weakening it), redaction-before-hash is
// the stored representation, and redacted identity never links.

import { describe, expect, it } from 'vitest';
import {
  canonicalEvidenceHash,
  isTargetSensitiveField,
  redactJsonWithSensitiveFields,
} from './redact.js';

describe('Phase 14: target sensitiveFields redaction', () => {
  it('masks a target-declared sensitive field (dot-qualified)', () => {
    const redacted = redactJsonWithSensitiveFields(
      { customer: { email: 'user@example.com', name: 'Visible' } },
      ['customer.email'],
    ) as Record<string, unknown>;
    const customer = redacted['customer'] as Record<string, unknown>;
    expect(customer['email']).toBe('[Redacted]');
    expect(customer['name']).toBe('Visible');
  });

  it('masks values under a declared field path (descendant rule)', () => {
    const redacted = redactJsonWithSensitiveFields(
      { customer: { email: { value: 'secret-value' } } },
      ['customer.email'],
    );
    expect(JSON.stringify(redacted)).toContain('[Redacted]');
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
  });

  it('masks inside arrays of entities', () => {
    const redacted = redactJsonWithSensitiveFields(
      [{ customer: { email: 'a@b.c' } }, { customer: { email: 'd@e.f' } }],
      ['customer.email'],
    );
    expect(JSON.stringify(redacted)).not.toContain('a@b.c');
    expect(JSON.stringify(redacted)).not.toContain('d@e.f');
  });

  it('built-in sensitive-name masking still applies (additive, never weakened)', () => {
    const redacted = redactJsonWithSensitiveFields(
      { apiToken: 'tok_123', password: 'pw', note: 'keep' },
      [],
    ) as Record<string, unknown>;
    expect(redacted['apiToken']).toBe('[Redacted]');
    expect(redacted['password']).toBe('[Redacted]');
    expect(redacted['note']).toBe('keep');
  });

  it('built-in secret-SHAPE masking still applies regardless of field name', () => {
    const redacted = redactJsonWithSensitiveFields({ hint: 'Bearer abcdef123456' }, []) as Record<
      string,
      unknown
    >;
    expect(redacted['hint']).toBe('[Redacted]');
  });

  it('target fields and built-ins apply together', () => {
    const redacted = redactJsonWithSensitiveFields(
      { customer: { email: 'a@b.c' }, providerSecret: 's3cr3t' },
      ['customer.email'],
    ) as Record<string, unknown>;
    const customer = redacted['customer'] as Record<string, unknown>;
    expect(customer['email']).toBe('[Redacted]');
    expect(redacted['providerSecret']).toBe('[Redacted]');
  });

  it('matching is exact-name/descendant, not substring', () => {
    expect(isTargetSensitiveField('customer.email', ['customer.email'])).toBe(true);
    expect(isTargetSensitiveField('customer.email.value', ['customer.email'])).toBe(true);
    expect(isTargetSensitiveField('customer.emailHash', ['customer.email'])).toBe(false);
  });

  it('the content hash is computed over the REDACTED representation', () => {
    const raw = { customer: { email: 'a@b.c' } };
    const redacted = redactJsonWithSensitiveFields(raw, ['customer.email']);
    const hashRedacted = canonicalEvidenceHash(redacted).hash;
    const hashRaw = canonicalEvidenceHash(raw).hash;
    expect(hashRedacted).not.toBe(hashRaw);
    // The redacted hash is stable and equals a hash of the masked doc.
    expect(hashRedacted).toBe(canonicalEvidenceHash({ customer: { email: '[Redacted]' } }).hash);
  });
});
