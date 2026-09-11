// =====================================================================
// Unit — relative-path policy (security-boundaries §3, Phase 3 §16)
// =====================================================================
// Every rejected form here is an authority escape the executor must
// never be able to perform. This matrix is permanent.

import { describe, expect, it } from 'vitest';
import { validateRelativePath, PathPolicyError } from './validate.js';

describe('relative path policy', () => {
  it('accepts plain relative paths and normalizes a leading slash', () => {
    expect(validateRelativePath('/webhooks/provider')).toBe('/webhooks/provider');
    expect(validateRelativePath('webhooks/provider')).toBe('/webhooks/provider');
    expect(validateRelativePath('/demo/admin/reset')).toBe('/demo/admin/reset');
  });

  it('accepts paths with query strings and single-letter segments', () => {
    expect(validateRelativePath('/inspection/wallets/w-1/reconciliation?full=true')).toBe(
      '/inspection/wallets/w-1/reconciliation?full=true',
    );
  });

  it('rejects absolute http/https URLs in any case form', () => {
    expect(() => validateRelativePath('http://evil.example/x')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('https://evil.example/x')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('HTTP://EVIL.EXAMPLE')).toThrow(PathPolicyError);
  });

  it('rejects scheme-relative //host forms', () => {
    expect(() => validateRelativePath('//evil.example/x')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('//evil.example')).toThrow(PathPolicyError);
  });

  it('rejects embedded schemes and protocol tricks', () => {
    expect(() => validateRelativePath('ftp://evil.example')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('javascript:alert(1)')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('/x?url=https://evil.example')).not.toThrow(
      // a query param VALUE is not an authority escape
    );
  });

  it('rejects any authority-like // inside the path', () => {
    expect(() => validateRelativePath('/a//evil.example')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('/a//b')).toThrow(PathPolicyError);
  });

  it('rejects CR/LF/NUL injection', () => {
    expect(() => validateRelativePath('/x\r\nHost: evil.example')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('/x\n')).toThrow(PathPolicyError);
    expect(() => validateRelativePath('/x\0')).toThrow(PathPolicyError);
  });

  it('rejects empty paths', () => {
    expect(() => validateRelativePath('')).toThrow(PathPolicyError);
  });

  it('rejects paths starting with @', () => {
    expect(() => validateRelativePath('@evil')).toThrow(PathPolicyError);
  });

  it('round-trip probe catches encoded authority escapes', () => {
    // Encodes to "//evil.example/..." after percent-decoding.
    expect(() => validateRelativePath('/%2f%2fevil.example/x')).toThrow(PathPolicyError);
  });
});
