// =====================================================================
// RuptureGrid v1.1 Phase 16 — the `${credential.<REF>}` token grammar
// =====================================================================
// The ONE grammar for ordinary credential-reference substitution
// (ADR-0012). Both definition-time validation (validate.ts) and the
// executor substitution seam (executor.ts) parse header values through
// THIS module, so a token the executor would substitute can never be a
// token validation fails to see — and vice versa. There is no second,
// looser parser: the reference-name character class is shared, and no
// naming heuristic exists anywhere (ADR-0024 §19).
//
// A token is exactly `${credential.<REF>}` with <REF> matching
// [A-Z0-9_]+ (the same environment-variable-style name grammar the
// reference allowlist already validates). Literal text that merely
// resembles a token but does not match is left untouched by both the
// extractor and the substituter — identical behavior by construction.

const CREDENTIAL_TOKEN_SOURCE = '\\$\\{credential\\.([A-Z0-9_]+)\\}';

/** A fresh, global matcher for `${credential.<REF>}` tokens. */
export function credentialTokenPattern(): RegExp {
  return new RegExp(CREDENTIAL_TOKEN_SOURCE, 'g');
}

/**
 * Extracts every `${credential.<REF>}` reference NAME from a header
 * value, in document order. Repeated tokens are returned repeatedly
 * (callers dedupe deterministically); a value with no valid token
 * yields an empty list. No heuristic, no looser grammar.
 */
export function credentialTokenRefs(value: string): string[] {
  const refs: string[] = [];
  for (const match of value.matchAll(credentialTokenPattern())) {
    const ref = match[1];
    if (ref !== undefined) {
      refs.push(ref);
    }
  }
  return refs;
}
