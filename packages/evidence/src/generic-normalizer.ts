// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic inspection normalizer (pure)
// (ADR-0017 Decision 1/2; ADR-0021 §4–§5; roadmap Phase 14)
// =====================================================================
// A PURE deterministic normalizer over STORED REDACTED generic
// inspection observations:
//
//   same stored observation + same frozen declaration + same
//   normalizer version ⇒ byte-equivalent semantic event specs,
//   always.
//
// Rules enforced here (nothing inferred, nothing guessed):
//   - the adapter kind must be exactly generic-inspection/v1;
//   - the envelope's queryId must resolve to the frozen declaration —
//     an unknown queryId yields ZERO events (never a guessed event);
//   - the declaration's roleId is the ONLY event role; the event type
//     IS the roleId (target-scoped by the run's frozen target — no
//     hashes, truncation schemes, displayName slugs, or prefixes);
//   - the payload preserves the target-declared entity fields under
//     their EXACT declared names, exactly as stored/redacted;
//   - RuptureGrid provenance lives only under the reserved
//     `rupturegrid` sub-object and never masquerades as target data;
//   - an invalid capture yields ZERO events (the honest raw
//     observation is the evidence of what was seen — ADR-0021 §4);
//   - business normalization is eligible ONLY for 2xx responses
//     (blocker B-5): a 3xx/4xx/5xx status — even with a shape-valid
//     JSON array body — can never become business events; the reason
//     code `HTTP_NON_SUCCESS` marks the honest observation. 204 (no
//     body) is a non-array observed reality ⇒ ZERO events;
//   - a truncated capture (B-1 provenance) is NEVER normalized: the
//     stored bytes are a bounded prefix of the response, and a prefix
//     is never parsed into business meaning ⇒ ZERO events;
//   - `[]` is a valid empty capture ⇒ zero events (never business
//     absence — ADR-0021 §5);
//   - timestamps are DATA only: they are never causal matching input
//     unless a manifest explicitly names that exact field as a
//     linkField — and then only exact declared equality, never
//     proximity.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';
import {
  GENERIC_INSPECTION_NORMALIZER_NAME,
  GENERIC_INSPECTION_NORMALIZER_VERSION,
} from './versions.js';
import type { NormalizedEventSpec } from './normalize.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deterministic subjectKey (index/convenience — NEVER causal
 * authority; causal truth comes only from declared payload fields +
 * causal edges). Derived from the query's declared identityFields:
 *
 *   - exactly one identityField with a bounded primitive value ⇒ its
 *     stable string representation;
 *   - multiple identityFields ⇒ a canonical deterministic tuple with
 *     field names (never ambiguous bare concatenation), bounded to
 *     the 200-char subjectKey column;
 *   - a redacted/missing identity value ⇒ a non-authoritative
 *     `redacted:<field>` / `missing:<field>` marker. Causal
 *     derivation NEVER treats such a subjectKey as a linkage
 *     substitute (the marker embeds the field name and the exact
 *     redaction marker, so it can never equal a real identity).
 */
export function genericSubjectKey(
  payload: Readonly<Record<string, unknown>>,
  identityFields: readonly string[],
): string | null {
  if (identityFields.length === 0) {
    return null;
  }
  const stable = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return value.length <= 180 ? value : `sha256:${stableHash(value)}`;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    return null;
  };
  if (identityFields.length === 1) {
    const field = identityFields[0] as string;
    if (!(field in payload)) {
      return null; // Missing identity: no subject key is invented.
    }
    const value = payload[field];
    if (value === REDACTED_VALUE) {
      return `redacted:${field}`;
    }
    const stableValue = stable(value);
    return stableValue === null ? null : stableValue;
  }
  // Multiple identity fields: canonical name-qualified tuple. Every
  // component carries its field name — no ambiguous concatenation, no
  // array-order identity. Bounded to the 200-char column; the full
  // exact identity tuple always remains in the event payload.
  const parts: string[] = [];
  for (const field of identityFields) {
    const value = payload[field];
    if (value === undefined) {
      return null; // A missing declared identity field is not subject material.
    }
    parts.push(
      `${field}=${value === REDACTED_VALUE ? REDACTED_VALUE : (stable(value) ?? JSON.stringify(value))}`,
    );
  }
  const joined = parts.join('|');
  if (joined.length <= 200) {
    return joined;
  }
  return `sha256:${stableHash(joined)}`;
}

const REDACTED_VALUE = '[Redacted]';

function stableHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalizes ONE stored REDACTED generic inspection observation into
 * typed role events. Pure: no wall clock, no randomness, no I/O.
 */
export function normalizeGenericInspectionObservation(
  input: {
    readonly contentHash: string;
    readonly chainIndex: number;
    /** The STORED REDACTED payload (the envelope as persisted). */
    readonly payload: unknown;
  },
  /** The run's FROZEN ManifestEvidencePolicy. */
  policy: ManifestEvidencePolicy,
): NormalizedEventSpec[] {
  if (!isRecord(input.payload)) {
    return [];
  }
  // 1. Adapter kind must be exact (no shape guessing, no kind
  //    inference — the registry seam names the adapter explicitly).
  if (input.payload['adapterKind'] !== GENERIC_INSPECTION_ADAPTER_KIND) {
    return [];
  }
  const declaration = input.payload['declaration'];
  const observed = input.payload['observed'];
  const validation = input.payload['validation'];
  if (!isRecord(declaration) || !isRecord(observed) || !isRecord(validation)) {
    return [];
  }
  // 2. The envelope must carry the accepted inspection version.
  if (declaration['inspectionVersion'] !== 'inspection/v1') {
    return [];
  }
  // 3. Invalid captures yield ZERO events — the stored observation is
  //    the honest evidence of what was seen (ADR-0021 §4).
  if (validation['valid'] !== true) {
    return [];
  }
  // 3b. B-5 (status gate, defense in depth): business normalization is
  //     eligible ONLY for 2xx responses. The adapter already refuses
  //     to mark non-2xx captures valid; a stored envelope claiming a
  //     valid capture from a non-2xx status cannot exist through the
  //     real seam — and if it somehow did, it is refused here too.
  const httpStatus = observed['httpStatus'];
  if (typeof httpStatus !== 'number' || httpStatus < 200 || httpStatus >= 300) {
    return [];
  }
  // 3c. B-1 (truncation gate, defense in depth): a truncated capture
  //     is never normalized — the stored bytes are a bounded PREFIX of
  //     the response, and a prefix is never business evidence.
  if (observed['truncated'] === true) {
    return [];
  }
  const responseJson = observed['responseJson'];
  if (!Array.isArray(responseJson)) {
    return []; // A valid capture is a JSON array by contract.
  }
  // 4. The queryId must resolve to the FROZEN declaration — unknown
  //    query ⇒ zero events, never guessed (ADR-0021 §7).
  const queryId = declaration['queryId'];
  if (typeof queryId !== 'string') {
    return [];
  }
  const query = policy.inspection.find((entry: { queryId: string }) => entry.queryId === queryId);
  if (query === undefined) {
    return [];
  }
  // 5. The declaration's roleId is the ONLY event role; the event type
  //    IS the roleId (target-scoped by the run/snapshot target
  //    boundary). No prefixes, hashes, slugs, or heuristics exist.
  const eventType = query.roleId;

  const source = {
    kind: 'target_observation',
    adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
    contentHash: input.contentHash,
    chainIndex: input.chainIndex,
  };

  const events: NormalizedEventSpec[] = [];
  for (const element of responseJson) {
    if (!isRecord(element)) {
      return []; // Whole-capture invalidation is exact (ADR-0021 §4).
    }
    // 6. The payload preserves the declared entity fields under their
    //    EXACT declared names, exactly as stored/redacted. Provenance
    //    lives under the reserved `rupturegrid` key and is clearly
    //    platform-owned — never masquerading as target data.
    const payload: Record<string, unknown> = {};
    for (const fieldName of Object.keys(query.fields)) {
      payload[fieldName] = element[fieldName] ?? null;
    }
    payload['rupturegrid'] = {
      observation: source,
      queryId: query.queryId,
      roleId: query.roleId,
      normalizerName: GENERIC_INSPECTION_NORMALIZER_NAME,
      normalizerVersion: GENERIC_INSPECTION_NORMALIZER_VERSION,
    };
    events.push({
      eventType,
      subjectKey: genericSubjectKey(payload, query.identityFields),
      payload,
      normalizerName: GENERIC_INSPECTION_NORMALIZER_NAME,
      normalizerVersion: GENERIC_INSPECTION_NORMALIZER_VERSION,
      sourceObservationHashes: [input.contentHash],
      primaryObservationIndex: input.chainIndex,
    });
  }
  return events;
}

/**
 * Canonical re-serialization check helper for determinism tests:
 * two event-spec arrays are semantically identical iff their
 * canonical JSON forms are byte-identical (order-sensitive per the
 * array semantics of the capture; object keys canonicalized).
 */
export function canonicalEventSpecsJson(specs: readonly NormalizedEventSpec[]): string {
  return canonicalizeJson(
    specs.map((spec) => ({
      eventType: spec.eventType,
      subjectKey: spec.subjectKey,
      payload: spec.payload,
      normalizerName: spec.normalizerName,
      normalizerVersion: spec.normalizerVersion,
      sourceObservationHashes: spec.sourceObservationHashes,
      primaryObservationIndex: spec.primaryObservationIndex,
    })),
  );
}
