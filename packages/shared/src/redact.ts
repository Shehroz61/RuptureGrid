// =====================================================================
// RuptureGrid v1.0 — redaction primitives
// =====================================================================
// Used by the logger and config packages so sensitive values are masked
// before they reach logs (AGENTS R-13, ADR-0012).

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

/** True when a field name should be treated as sensitive. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Masks a value that must never be logged. */
export function maskValue(_value: unknown): string {
  return '[Redacted]';
}

/**
 * Masks the password portion of a URL (e.g. a PostgreSQL/Redis
 * connection string) so the URL can be logged safely.
 */
export function redactUrlPassword(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    // Not parseable as a URL — mask anything that looks like userinfo.
    return url.replace(/\/\/[^@/]+@/, '//***@');
  }
}

/**
 * Redacts credential-bearing URL strings (connection strings) wherever
 * they appear in a value tree. Plain strings without URL userinfo are
 * returned unchanged.
 */
export function redactUrlLikeStrings(value: string): string {
  // A URL with credentials must contain an authority with userinfo:
  // scheme://…@… . The '://' guard keeps ordinary strings untouched.
  if (value.includes('://') && value.includes('@')) {
    return redactUrlPassword(value);
  }
  return value;
}

/**
 * Deep-masks sensitive fields in a value. Returns a new structure;
 * the input is never mutated. Sensitive keys are masked by name and
 * credential-bearing URL strings are redacted wherever they appear.
 */
export function maskSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveFields(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? maskValue(item) : maskSensitiveFields(item);
    }
    return out;
  }
  if (typeof value === 'string') {
    return redactUrlLikeStrings(value);
  }
  return value;
}
