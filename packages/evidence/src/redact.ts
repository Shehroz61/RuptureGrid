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

// ---------------------------------------------------------------------
// Phase 14 — target-declared sensitive fields (security-boundaries §7:
// "a secret registry per target declares sensitive fields")
// ---------------------------------------------------------------------
// The target manifest's `sensitiveFields` (frozen into the run's
// ManifestEvidencePolicy) are ADDITIONAL redaction-registry entries for
// generic inspection captures. They never weaken the built-in layers:
// the sensitive-NAME pattern and the secret-SHAPE masking above still
// apply to every value. Redaction happens BEFORE persistence and
// BEFORE the content hash — the stored representation is the redacted
// representation (ADR-0012).

/**
 * True when `path` names (or lives under) one of the declared target
 * sensitive fields. Declared names are ENTITY-LEVEL declarations, so
 * they match at ANY depth inside a captured structure — the path must
 * equal the declared name, start with it (descendant), or end with it
 * (a nested entity's field under array/object wrappers). Built-in
 * denylist semantics are untouched — this is purely additive.
 */
export function isTargetSensitiveField(path: string, sensitiveFields: readonly string[]): boolean {
  if (sensitiveFields.length === 0) {
    return false;
  }
  const normalized = path.toLowerCase();
  return sensitiveFields.some((declared) => {
    const target = declared.toLowerCase();
    return (
      normalized === target ||
      normalized.startsWith(`${target}.`) ||
      normalized.endsWith(`.${target}`) ||
      normalized.includes(`.${target}.`)
    );
  });
}

/**
 * Deep redaction with the target's declared sensitive fields ADDED to
 * the built-in denylist. Returns a new structure; the input is never
 * mutated. Key matching is per-KEY (flat key or dot-qualified
 * descendant path); built-in name/shape masking applies everywhere.
 */
export function redactJsonWithSensitiveFields(
  value: unknown,
  sensitiveFields: readonly string[],
): unknown {
  if (sensitiveFields.length === 0) {
    return redactJson(value);
  }
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, path));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        // Built-in denylist FIRST (never weakened), then the target's
        // declared sensitive fields — both mask before persistence.
        out[key] =
          SENSITIVE_NAME_PATTERN.test(key) || isTargetSensitiveField(childPath, sensitiveFields)
            ? REDACTED_MARKER
            : walk(item, childPath);
      }
      return out;
    }
    if (typeof node === 'string' && looksLikeSecret(node)) {
      return REDACTED_MARKER;
    }
    return node;
  };
  return walk(value, '');
}

/**
 * The replacement for a secret-shaped value removed from an
 * unstructured (non-JSON) stored body. Distinct from the JSON-layer
 * marker so provenance stays honest: this records that a VALUE SHAPE —
 * not a named field — was masked in free text.
 */
export const REDACTED_SECRET_SHAPE_MARKER = '[Redacted-Secret-Shape]';

/**
 * Phase 14 hardening (blocker-repair redaction matrix): masks
 * secret-SHAPED values embedded in UNSTRUCTURED (non-JSON) body text.
 * A non-JSON body has no structure to walk, so the JSON-layer shape
 * mask cannot see into it — but a bearer token, JWT, or URL-embedded
 * credential inside a malformed/plaintext/truncated body is still a
 * secret, and secrets never persist (security-boundaries §7, AGENTS
 * R-13). Bounded: the scan is a single linear pass (global regexes),
 * so an adversarial body cannot trigger pathological behavior.
 */
function maskSecretShapesInText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, REDACTED_SECRET_SHAPE_MARKER)
    .replace(
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
      REDACTED_SECRET_SHAPE_MARKER,
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*@[^\s"'<>]*/gi, REDACTED_SECRET_SHAPE_MARKER);
}

/**
 * Bounded JSON string: if `raw` is parseable JSON it is redacted
 * (deep) then re-serialized; otherwise it is stored as a bounded
 * opaque string — WITH secret-shaped values still masked (Phase 14
 * hardening: malformed/plaintext/truncated bodies can never carry a
 * raw secret into durable persistence). Returns the stored text plus
 * whether redaction actually changed anything.
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
    // Not JSON: stored as a bounded opaque string, but STILL
    // secret-scanned first (Phase 14 hardening). A secret hidden in
    // unstructured text is masked by value SHAPE; redactionApplied is
    // honest about the transformation. Bounding happens after masking,
    // so a size-cut prefix can never carry a masked-away secret's raw
    // form either.
    const masked = maskSecretShapesInText(raw);
    redactionApplied = masked !== raw;
    if (masked.length > maxChars) {
      truncated = true;
    }
    return { text: masked.slice(0, maxChars), redactionApplied, truncated };
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
