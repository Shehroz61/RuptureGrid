// =====================================================================
// Phase 14 blocker repair G — secret-shape masking in unstructured
// (non-JSON) stored bodies
// =====================================================================
// A non-JSON body has no structure to walk, so before this hardening a
// bearer token, JWT, or URL-embedded credential inside a malformed /
// plaintext / truncated body was stored opaque — raw. Secrets never
// persist (security-boundaries §7, AGENTS R-13): the stored text now
// carries the secret-shape mask, with redactionApplied honest about
// the transformation.

import { describe, expect, it } from 'vitest';
import { redactBoundedText, REDACTED_SECRET_SHAPE_MARKER } from './redact.js';

describe('G: unstructured-body redaction (malformed JSON / plaintext / truncated)', () => {
  it('masks a bearer token in a malformed-JSON body (raw secret absent)', () => {
    const raw = '{"orderId": "ORD-1", "authorization": Bearer sk-canary-1234567890';
    const result = redactBoundedText(raw, 16_000);
    expect(result.redactionApplied).toBe(true);
    expect(result.text).not.toContain('sk-canary-1234567890');
    expect(result.text).toContain(REDACTED_SECRET_SHAPE_MARKER);
  });

  it('masks JWT and URL-embedded credentials in a plaintext body', () => {
    const raw =
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk ' +
      'conn=postgres://admin:hunter2canary@db.example/main';
    const result = redactBoundedText(raw, 16_000);
    expect(result.redactionApplied).toBe(true);
    expect(result.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result.text).not.toContain('hunter2canary');
  });

  it('masks BEFORE bounding: a size-cut prefix never carries a raw secret', () => {
    const raw = `Bearer sk-canary-truncated-secret\n${'x'.repeat(4_000)}`;
    const result = redactBoundedText(raw, 1_000);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('sk-canary-truncated-secret');
    expect(result.text).toContain(REDACTED_SECRET_SHAPE_MARKER);
  });

  it('leaves genuinely non-secret opaque text unmasked and honest', () => {
    const result = redactBoundedText('plain text, no secrets here', 100);
    expect(result.redactionApplied).toBe(false);
    expect(result.text).toBe('plain text, no secrets here');
  });
});
