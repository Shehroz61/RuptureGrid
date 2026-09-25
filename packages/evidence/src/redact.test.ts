// =====================================================================
// RuptureGrid v1.0 — evidence redaction unit tests (Phase 4, §21–§24)
// =====================================================================
// Security contract: sensitive headers and credential-shaped values
// never survive redaction; the stored representation is the REDACTED
// representation and hashes are computed over it.

import { describe, expect, it } from 'vitest';
import {
  canonicalEvidenceHash,
  isRedactedHeader,
  redactBoundedText,
  redactHeaders,
  redactJson,
  REDACTED_MARKER,
} from './redact.js';

describe('redaction policy', () => {
  it('removes credential-bearing header values while keeping their presence', () => {
    const redacted = redactHeaders({
      authorization: 'Bearer canary-secret-value-123456',
      cookie: 'session=canary-secret-value-123456',
      'set-cookie': 'sid=canary-secret-value-123456',
      'proxy-authorization': 'Basic canary-secret-value-123456',
      'x-rupturegrid-provider-signature': 'aabbccddeeff00112233',
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(redacted['authorization']).toBe(REDACTED_MARKER);
    expect(redacted['cookie']).toBe(REDACTED_MARKER);
    expect(redacted['set-cookie']).toBe(REDACTED_MARKER);
    expect(redacted['proxy-authorization']).toBe(REDACTED_MARKER);
    expect(redacted['x-rupturegrid-provider-signature']).toBe(REDACTED_MARKER);
    expect(redacted['content-type']).toBe('application/json');
    expect(JSON.stringify(redacted)).not.toContain('canary-secret-value-123456');
  });

  it('flags exactly the credential header names', () => {
    expect(isRedactedHeader('Authorization')).toBe(true);
    expect(isRedactedHeader('AUTHORIZATION')).toBe(true);
    expect(isRedactedHeader('x-rupturegrid-provider-signature')).toBe(true);
    expect(isRedactedHeader('content-type')).toBe(false);
  });

  it('masks sensitive named fields deeply in JSON payloads', () => {
    const input = {
      nested: {
        adminToken: 'canary-secret-value-123456',
        password: 'hunter2canary',
        apiKey: 'key-canary-secret-value',
        keep: 'plain business value',
        deeper: [{ providerSigningSecret: 'sig-canary-secret-value' }],
      },
    };
    const redacted = redactJson(input) as Record<string, unknown>;
    const nested = redacted['nested'] as Record<string, unknown>;
    expect(nested['adminToken']).toBe(REDACTED_MARKER);
    expect(nested['password']).toBe(REDACTED_MARKER);
    expect(nested['apiKey']).toBe(REDACTED_MARKER);
    expect(nested['keep']).toBe('plain business value');
    const deeper = (nested['deeper'] as Array<Record<string, unknown>>)[0];
    expect(deeper?.['providerSigningSecret']).toBe(REDACTED_MARKER);
    expect(JSON.stringify(redacted)).not.toContain('canary-secret-value');
    expect(JSON.stringify(redacted)).not.toContain('hunter2canary');
  });

  it('masks credential SHAPES even under innocuous field names', () => {
    const input = {
      note: 'Bearer canary-secret-value-123456',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.canary-signature-value',
      dbUrl: 'postgres://user:canary-secret-value-123456@host:5432/db',
      safe: 'a normal sentence about wallets',
    };
    const redacted = redactJson(input) as Record<string, unknown>;
    expect(redacted['note']).toBe(REDACTED_MARKER);
    expect(redacted['jwt']).toBe(REDACTED_MARKER);
    expect(redacted['dbUrl']).toBe(REDACTED_MARKER);
    expect(redacted['safe']).toBe('a normal sentence about wallets');
  });

  it('never mutates the input structure', () => {
    const input = { token: 'canary-secret-value-123456' };
    const copy = JSON.parse(JSON.stringify(input));
    redactJson(input);
    expect(input).toEqual(copy);
  });

  it('redacts bounded JSON text and reports that redaction was applied', () => {
    const result = redactBoundedText(
      JSON.stringify({ authorization: 'Bearer canary-secret-value-123456', amountMinor: '500000' }),
      16_000,
    );
    expect(result.redactionApplied).toBe(true);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed['authorization']).toBe(REDACTED_MARKER);
    expect(parsed['amountMinor']).toBe('500000');
    expect(result.text).not.toContain('canary-secret-value-123456');
  });

  it('redacts a secret inside an over-cap JSON body before bounding (auditor regression: R-13)', () => {
    const large = { data: 'x'.repeat(10_000), authorization: 'Bearer canary-secret-value-123456' };
    const result = redactBoundedText(JSON.stringify(large), 8_000);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(8_000);
    expect(result.redactionApplied).toBe(true);
    expect(result.text).not.toContain('canary-secret-value-123456');
  });

  it('bounds non-JSON opaque text without redaction claims', () => {
    const result = redactBoundedText('opaque text'.repeat(1000), 100);
    expect(result.truncated).toBe(true);
    expect(result.redactionApplied).toBe(false);
    expect(result.text.length).toBe(100);
  });

  it('hashes the canonical stored representation deterministically', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    const ha = canonicalEvidenceHash(a);
    const hb = canonicalEvidenceHash(b);
    expect(ha.hash).toBe(hb.hash);
    expect(ha.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different redacted content', () => {
    const ha = canonicalEvidenceHash({ x: 1 });
    const hb = canonicalEvidenceHash({ x: 2 });
    expect(ha.hash).not.toBe(hb.hash);
  });
});
