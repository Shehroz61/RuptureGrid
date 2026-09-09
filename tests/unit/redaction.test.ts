import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  maskSensitiveFields,
  maskValue,
  redactUrlPassword,
  redactUrlLikeStrings,
} from '@rupturegrid/shared';

describe('redaction — sensitive keys', () => {
  it('treats password-like keys as sensitive', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('POSTGRES_PASSWORD')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('Cookie')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('client_secret')).toBe(true);
  });

  it('treats ordinary keys as non-sensitive', () => {
    expect(isSensitiveKey('host')).toBe(false);
    expect(isSensitiveKey('port')).toBe(false);
    expect(isSensitiveKey('service')).toBe(false);
  });

  it('maskValue never reveals the original', () => {
    expect(maskValue('super-secret')).toBe('[Redacted]');
  });
});

describe('redaction — URL passwords', () => {
  it('masks the password in a PostgreSQL URL', () => {
    const redacted = redactUrlPassword('postgresql://user:secret@db:5432/mydb');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('postgresql://user:***@db:5432/mydb');
  });

  it('masks the password in a Redis URL', () => {
    const redacted = redactUrlPassword('redis://:hunter2@redis:6380');
    expect(redacted).not.toContain('hunter2');
  });

  it('leaves credential-free URLs unchanged', () => {
    const url = 'redis://127.0.0.1:6380';
    expect(redactUrlPassword(url)).toBe(url);
  });

  it('handles unparseable strings safely', () => {
    const out = redactUrlPassword('not a url but has //user:pass@host');
    expect(out).not.toContain('pass');
  });
});

describe('redaction — log payload masking', () => {
  it('masks sensitive fields in nested objects', () => {
    const payload = {
      service: 'rupturegrid-api',
      config: {
        CONTROL_DATABASE_URL: 'postgresql://user:secret@db:5432/db',
        password: 'hunter2',
        nested: { apiKey: 'key-123' },
      },
    };
    const masked = maskSensitiveFields(payload) as Record<string, unknown>;
    const config = masked.config as Record<string, unknown>;
    expect(config.CONTROL_DATABASE_URL).toBe('postgresql://user:***@db:5432/db');
    expect(config.password).toBe('[Redacted]');
    const nested = config.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[Redacted]');
    expect(masked.service).toBe('rupturegrid-api');
  });

  it('redacts URL-like strings in arbitrary positions', () => {
    const masked = maskSensitiveFields({
      note: 'connect using postgresql://admin:topsecret@db/internal',
    }) as { note: string };
    expect(masked.note).not.toContain('topsecret');
    expect(masked.note).toContain('***');
  });

  it('leaves ordinary strings untouched', () => {
    const masked = maskSensitiveFields({ msg: 'hello world' }) as { msg: string };
    expect(masked.msg).toBe('hello world');
  });

  it('handles arrays and nulls', () => {
    const masked = maskSensitiveFields({ items: [{ token: 't' }, null, 'plain'] }) as {
      items: unknown[];
    };
    expect(masked.items[0]).toEqual({ token: '[Redacted]' });
    expect(masked.items[1]).toBeNull();
    expect(masked.items[2]).toBe('plain');
  });
});
