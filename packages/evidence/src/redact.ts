// =====================================================================
// RuptureGrid v1.0 — evidence redaction policy (Phase 4)
// =====================================================================
// Redaction happens BEFORE durable persistence (security-boundaries
// §7, ADR-0012, evidence-model §5). The stored representation is the
// REDACTED representation; content hashes are computed over it. This
// means evidence supports SEMANTIC reproduction, not byte-for-byte
// reproduction of everything that crossed the wire. Security wins
// over literal fidelity — and `redactionApplied` records honestly
// that redaction transformed the captured data (prompt §24).
//
// Two layers:
//   1. Header-level: credential-bearing headers are fully removed.
//   2. JSON-level: sensitive NAMED fields are masked deeply; known
//      bearer/JWT/connection-string value SHAPES are masked even when
//      the field name is innocuous (names are not trustworthy).

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';

/** Bumped only when redaction semantics change (versioned, §4). */
export const REDACTION_POLICY_VERSION = 'evidence-redaction-v1';

/** Canonical stored-representation hashing algorithm (SHA-256). */
export const EVIDENCE_HASH_ALGORITHM = 'sha256';

/**
 * Headers whose values are credential material in ANY form. The header
 * is REMOVED entirely (name recorded, value never persisted).
 */
const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-rupturegrid-provider-signature',
]);

/** Header names whose presence is recorded without any value. */
export function isRedactedHeader(name: string): boolean {
  return REDACTED_HEADERS.has(name.toLowerCase());
}

const SENSITIVE_NAME_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)/i;

/**
 * Value SHAPES that are sensitive regardless of field name: bearer
 * tokens, JWTs, and URL-embedded credentials. Never persisted raw.
 */
function looksLikeSecret(value: string): boolean {
  return (
    /^Bearer\s+[A-Za-z0-9\-._~+/]+=*$/i.test(value) ||
    /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/.test(value) ||
    (value.includes('://') && value.includes('@') && /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
  );
}

/** The single replacement marker for redacted values. */
export const REDACTED_MARKER = '[Redacted]';

/**
 * Deep redaction of a JSON-like value. Returns a new structure; the
 * input is never mutated. Sensitive KEYS and secret-SHAPED strings are
 * masked. Unknown object shapes pass through structurally.
 */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_NAME_PATTERN.test(key) ? REDACTED_MARKER : redactJson(item);
    }
    return out;
  }
  if (typeof value === 'string' && looksLikeSecret(value)) {
    return REDACTED_MARKER;
  }
  return value;
}

/**
 * Redacts a header map (lowercased names by convention). Redacted
 * headers are replaced with the marker so their PRESENCE remains
 * honest evidence while their VALUES never persist.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = isRedactedHeader(name) ? REDACTED_MARKER : value;
  }
  return out;
}

/**
 * Bounded JSON string: if `raw` is parseable JSON it is redacted
 * (deep) then re-serialized; otherwise it is stored as a bounded
 * opaque string. Returns the stored text plus whether redaction
 * actually changed anything.
 */
export function redactBoundedText(
  raw: string,
  maxChars: number,
): { text: string; redactionApplied: boolean; truncated: boolean } {
  let truncated = raw.length > maxChars;
  let redactionApplied = false;
  try {
    // Redact the FULL raw text before any bounding: a secret must never
    // survive persistence merely because the body exceeded the storage
    // cap and a size-bounded prefix no longer parses as JSON (auditor
    // correction — redaction-before-persistence is unconditional,
    // security-boundaries §7 / AGENTS R-13).
    const parsed: unknown = JSON.parse(raw);
    const redacted = redactJson(parsed);
    if (JSON.stringify(redacted) !== JSON.stringify(parsed)) {
      redactionApplied = true;
    }
    let candidate = JSON.stringify(redacted);
    // Re-serialization can exceed the cap (escaping); bound the
    // REDACTED representation and keep the truncation flag honest.
    if (candidate.length > maxChars) {
      candidate = candidate.slice(0, maxChars);
      truncated = true;
    }
    return { text: candidate, redactionApplied, truncated };
  } catch {
    // Not JSON: stored as a bounded opaque string (no structure to
    // redact; value-shape masking applies at the JSON layer only).
    return { text: truncated ? raw.slice(0, maxChars) : raw, redactionApplied, truncated };
  }
}

/**
 * Canonical stored representation: the REDACTED payload document is
 * canonicalized (sorted keys, RFC 8259 encoding — same algorithm as
 * snapshots) and hashed with SHA-256. The hash is over the stored
 * representation, never over secret-bearing raw bytes.
 */
export function canonicalEvidenceHash(payload: unknown): { canonical: string; hash: string } {
  const canonical = canonicalizeJson(payload);
  const hash = createHash(EVIDENCE_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return { canonical, hash };
}
