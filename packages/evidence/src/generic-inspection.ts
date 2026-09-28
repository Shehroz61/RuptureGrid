// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic inspection/v1 evidence adapter
// (ADR-0016/ADR-0017/ADR-0021/ADR-0022; roadmap Phase 14)
// =====================================================================
// The GENERIC, manifest-driven evidence adapter. Everything it does is
// declared by the run's FROZEN ManifestEvidencePolicy:
//
//   - the adapter executes GET <frozen origin><declared literal path>
//     (ADR-0022: zero runtime URL binding, no ${…}, no interpolation —
//     the validator already rejected template syntax at registration
//     and the path was re-validated when the manifest was re-validated
//     to freeze the policy);
//   - the response MUST be a JSON array whose elements each carry
//     EXACTLY the declared fields with the declared primitive types
//     (ADR-0021); one invalid element invalidates the WHOLE capture
//     (no partial salvage); and an unparseable (opaque) body — a
//     truncated, malformed, or non-JSON body — is NEVER persisted:
//     structural redaction cannot be proven over free text, so the
//     stored observation carries only safe bounded metadata (status,
//     observed byte count, truncated flag, parse status, deterministic
//     reason code) and the fixed placeholder `[Opaque body omitted]` —
//     no hash/fingerprint of the unsafe body exists anywhere (R-13:
//     secrets never persist — security wins over literal fidelity);
//   - an invalid or non-array response is STILL AN OBSERVATION: it is
//     persisted honestly in a versioned envelope with bounded,
//     deterministic validation provenance — and it yields NO events;
//   - the payload is redacted (built-in denylist + the target's
//     declared sensitiveFields) BEFORE the content hash and BEFORE
//     persistence (security-boundaries §7, ADR-0012) — and ONLY a
//     successfully parsed JSON body is persisted at all, as its
//     REDACTED structured representation. An OPAQUE body — never
//     arrived, truncated, malformed, text/plain, text/html, or any
//     other unparseable body — is NEVER persisted: no raw text, no
//     hash or fingerprint derived from it. Only safe bounded metadata
//     (status, content type, observed byte count, truncated flag,
//     parse status, deterministic reason code) and the fixed
//     placeholder `[Opaque body omitted]` are stored — regex scanning
//     free text can mask KNOWN secret shapes but can never PROVE
//     arbitrary opaque text secret-free, and security wins over
//     literal fidelity (R-13, security-boundaries §7);
//   - each query's capture identity is stable within the run:
//     `manifest-inspection:<queryId>` — re-capturing the same query
//     with identical stored content is idempotent; with DIFFERENT
//     stored content it is an explicit EvidenceIntegrityConflictError
//     (never overwrite, never two contradictory "final" captures);
//   - NO credentials exist on this path. The manifest has no generic
//     inspection-auth mapping, so none is invented: no Authorization,
//     no cookie, no DEMO_* token is ever attached or inferred
//     (Phase 13 NB-1 stays separate and untouched).
//   - the HTTP transport resolves its DESTINATION security through the
//     engine's ONE reviewed destination seam (B-1 repair): origin
//     authority + scheme/environment policy, resolve-once-validate
//     address-class denial, safe Host construction, redirect: 'manual'
//     — byte-identical to the executor's policy because it IS the
//     executor's implementation (@rupturegrid/engine destination.ts).
//
// The adapter NEVER touches execution truth: it writes target_
// observations on the separate evidence plane only.

import type { PrismaClient } from '@rupturegrid/control-db';
import type { ManifestEvidencePolicy, ManifestInspectionQuery } from '@rupturegrid/engine';
import {
  assertDestinationAllowed,
  assertOriginAllowed,
  DestinationDeniedError,
  OriginAuthorityError,
  originHostHeader,
} from '@rupturegrid/engine';
import { redactJsonWithSensitiveFields, REDACTION_POLICY_VERSION } from './redact.js';
import { RawObservationStore, EvidenceIntegrityConflictError } from './raw-observation-store.js';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';

export { EvidenceIntegrityConflictError };

// ---------------------------------------------------------------------
// Adapter registry (Phase 14: an explicit bounded registry — never
// selection by URL substring, response shape, displayName, field
// names, contract-kind guessing, or timestamps)
// ---------------------------------------------------------------------

/**
 * The kinds of target-observation adapters this platform ships. The
 * registry is explicit platform code: two legacy Demo adapters and the
 * Phase 14 generic manifest-inspection adapter. No plugin loader, no
 * dynamic imports from target data, no eval, no target-provided code.
 * Adapter selection is EXPLICIT — the worker names the kind it is
 * invoking; nothing infers an adapter from a response.
 */
export const EVIDENCE_ADAPTER_KINDS = {
  legacyDemoPaymentLineage: 'demo-fintech-payment-lineage',
  legacyDemoFaultStatus: 'demo-fintech-fault-status',
  genericInspection: GENERIC_INSPECTION_ADAPTER_KIND,
} as const;

/** True when `adapterKind` is a known, explicit platform adapter kind. */
export function isKnownEvidenceAdapterKind(adapterKind: string): boolean {
  return Object.values(EVIDENCE_ADAPTER_KINDS).includes(
    adapterKind as (typeof EVIDENCE_ADAPTER_KINDS)[keyof typeof EVIDENCE_ADAPTER_KINDS],
  );
}

// ---------------------------------------------------------------------
// HTTP safety bounds (security-boundaries §8 discipline)
// ---------------------------------------------------------------------

/** Per-query inspection timeout (ms) — bounded, never client-trusted. */
export const GENERIC_INSPECTION_TIMEOUT_MS = 10_000;
/** Maximum response body bytes buffered per inspection query. */
export const GENERIC_INSPECTION_MAX_RESPONSE_BYTES = 256_000;
/** Maximum stored response-text representation (characters). */
export const GENERIC_INSPECTION_MAX_RESPONSE_CHARS = 16_000;
/** Maximum stored error text (characters). */
export const GENERIC_INSPECTION_MAX_ERROR_CHARS = 300;

// ---------------------------------------------------------------------
// The versioned generic observation envelope
// ---------------------------------------------------------------------

/** Envelope schema version (bumped only when semantics change). */
export const GENERIC_INSPECTION_ENVELOPE_VERSION = 'generic-inspection-observation/v1';

/** Bounded deterministic shape-validation outcome for one capture. */
export interface GenericInspectionValidation {
  readonly valid: boolean;
  /** Deterministic bounded reason code (platform vocabulary). */
  readonly reasonCode: string;
  /** Bounded deterministic detail (≤ 300 chars, secret-free). */
  readonly detail: string;
}

/**
 * The persisted generic target_observation payload. DECLARATION
 * PROVENANCE, OBSERVED REALITY, and VALIDATION PROVENANCE are clearly
 * separated; the target response is the observed portion and target
 * data is never mixed into declaration metadata. Deterministic:
 * replaying the same stored observation through the same normalizer
 * version yields the same events (capture timestamps are NOT inside
 * the envelope — observedAt remains raw-observation metadata only).
 */
export interface GenericInspectionObservationEnvelope {
  readonly envelopeVersion: typeof GENERIC_INSPECTION_ENVELOPE_VERSION;
  readonly adapterKind: typeof GENERIC_INSPECTION_ADAPTER_KIND;
  /** DECLARATION PROVENANCE — from the frozen evidence policy. */
  readonly declaration: {
    readonly inspectionVersion: 'inspection/v1';
    readonly queryId: string;
    readonly roleId: string;
    /** The literal declared path (ADR-0022) — provenance, not truth. */
    readonly path: string;
  };
  /** OBSERVED REALITY — what the target actually returned. */
  readonly observed: {
    /** HTTP status when a response was actually observed. */
    readonly httpStatus: number | null;
    /**
     * Bounded content-type header metadata when a response was
     * observed (a header value, never body content).
     */
    readonly responseContentType: string | null;
    /** Structural parse status of the response body. */
    readonly parseStatus: 'not-attempted' | 'parsed-json' | 'invalid-json';
    /**
     * The parsed JSON value when parseStatus is 'parsed-json' — the
     * REDACTED deep copy of the parsed response (arrays preserved).
     */
    readonly responseJson?: unknown;
    /**
     * When parseStatus is 'parsed-json': the canonical serialization
     * of the REDACTED responseJson above. When the body was opaque
     * (never arrived, truncated, or unparseable): null — the raw
     * opaque body text is NEVER persisted (opaque-body security rule).
     */
    readonly responseJsonText: string | null;
    /**
     * Present exactly when the body was opaque: safe bounded metadata
     * about what was omitted — never body content, never a hash or
     * fingerprint derived from the body's bytes.
     */
    readonly opaqueBody?: GenericOpaqueBodyMetadata;
    /**
     * Honest B-1 transport provenance: true exactly when the streamed
     * wire read was cut at the inspection byte cap. A truncated
     * response is persisted honestly and is NEVER parsed — it always
     * yields ZERO normalized business events.
     */
    readonly truncated: boolean;
  };
  /** VALIDATION PROVENANCE — deterministic, bounded. */
  readonly validation: GenericInspectionValidation;
  /** Redaction provenance (policy version; applied flag). */
  readonly redaction: {
    readonly policyVersion: string;
    readonly applied: boolean;
  };
}

/**
 * The fixed placeholder persisted in place of an OPAQUE (unparseable)
 * response body. Security-boundaries §7 / R-13 closure (post-repair
 * re-audit): if the body cannot be parsed into the JSON structure the
 * structural redaction walks, its raw text can never be proven
 * secret-free — so the raw text is never persisted, never hashed, and
 * never fingerprinted. The placeholder is a fixed, deterministic,
 * content-free marker: it carries no information derived from the
 * body's bytes (R-18: it names WHAT was omitted, never what it was).
 */
export const GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER = '[Opaque body omitted]';

/**
 * Safe bounded metadata persisted for an opaque body — everything
 * observed about the response that is NOT the body's content, plus the
 * fixed placeholder. Every field is either platform-vocabulary or a
 * count; none is derived from the body's bytes.
 */
export interface GenericOpaqueBodyMetadata {
  /** Fixed content-free placeholder (never a body-derived value). */
  readonly placeholder: typeof GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER;
  /** Deterministic reason the raw body was omitted. */
  readonly reasonCode:
    | 'TRUNCATED_BODY_NOT_PERSISTED'
    | 'INVALID_JSON_BODY_NOT_PERSISTED'
    | 'BODY_READ_FAILED_NOT_PERSISTED'
    | 'OVER_CAP_BODY_NOT_PERSISTED'
    | 'NO_RESPONSE_BODY_OBSERVED';
  /** Honest observed byte count (a number, never body content). */
  readonly observedBodyBytes: number;
}

// ---------------------------------------------------------------------
// ADR-0021 shape validation — exact, whole-capture, zero salvage
// ---------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Exact primitive check for a declared field. NO coercion, ever:
 * "5" is not 5, 5 is not "5", "true" is not true. Declared wire
 * representations (the narrowest conventions already used across
 * RuptureGrid):
 *   - string:               JSON string
 *   - boolean:              JSON boolean
 *   - integer-minor-units:  JSON number that is a SAFE INTEGER (R-06:
 *                           money is integer minor units; a JSON
 *                           number equal to 5.0 IS the integer 5 and
 *                           is accepted — a fractional or
 *                           non-integer number, a numeric string, or
 *                           a boolean is rejected)
 *   - timestamp:            JSON string (ISO-8601 shape; NOT parsed
 *                           into a Date — values are checked, never
 *                           interpreted; the string form is the
 *                           target's declared data)
 */
function checkPrimitive(
  value: unknown,
  declaredType: string,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  switch (declaredType) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, detail: `expected string, got ${describeType(value)}` };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, detail: `expected boolean, got ${describeType(value)}` };
    case 'integer-minor-units':
      return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)
        ? { ok: true }
        : {
            ok: false,
            detail: `expected integer-minor-units (safe JSON integer), got ${describeType(value)}`,
          };
    case 'timestamp':
      return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value)
        ? { ok: true }
        : { ok: false, detail: `expected timestamp (ISO-8601 string), got ${describeType(value)}` };
    default:
      // Unreachable against a validated manifest (closed type
      // vocabulary), but fail CLOSED rather than guess.
      return { ok: false, detail: `unknown declared type "${declaredType}"` };
  }
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return typeof value;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Validates one response capture against ONE frozen declaration
 * (ADR-0021 §3–§5): the body must be a JSON array; every element must
 * be an object carrying EXACTLY the declared field set — no unknown
 * fields, no missing fields, declared primitive types checked with no
 * coercion. One invalid element invalidates the WHOLE capture (no
 * partial salvage). `[]` is a valid empty capture. Returns the first
 * failure (deterministic element order) — bounded and secret-free.
 */
export function validateGenericInspectionCapture(
  parsed: unknown,
  query: Pick<ManifestInspectionQuery, 'fields'>,
): GenericInspectionValidation {
  if (!Array.isArray(parsed)) {
    return {
      valid: false,
      reasonCode: 'RESPONSE_NOT_ARRAY',
      detail: `inspection/v1 response must be a JSON array (ADR-0021); got ${describeType(parsed)}`,
    };
  }
  const declaredNames = Object.keys(query.fields);
  for (let index = 0; index < parsed.length; index += 1) {
    const element = parsed[index];
    if (!isRecord(element)) {
      return {
        valid: false,
        reasonCode: 'ELEMENT_NOT_OBJECT',
        detail: `array element ${index} is ${describeType(element)}; every element must be an entity object`,
      };
    }
    const elementNames = Object.keys(element);
    const unknownField = elementNames.find((name) => !(name in query.fields));
    if (unknownField !== undefined) {
      return {
        valid: false,
        reasonCode: 'UNKNOWN_FIELD',
        detail: `array element ${index} carries undeclared field "${unknownField}" (the entity schema is exactly the declared field set)`,
      };
    }
    const missingField = declaredNames.find((name) => !(name in element));
    if (missingField !== undefined) {
      return {
        valid: false,
        reasonCode: 'MISSING_FIELD',
        detail: `array element ${index} is missing declared field "${missingField}"`,
      };
    }
    for (const [name, declaredType] of Object.entries(query.fields)) {
      const verdict = checkPrimitive(element[name], declaredType);
      if (!verdict.ok) {
        return {
          valid: false,
          reasonCode: 'TYPE_MISMATCH',
          detail: `array element ${index} field "${name}": ${verdict.detail} (no coercion is performed)`,
        };
      }
    }
  }
  return { valid: true, reasonCode: 'VALID', detail: 'capture matches the declared schema' };
}

// ---------------------------------------------------------------------
// The generic inspection capture call
// ---------------------------------------------------------------------

export class GenericInspectionAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GenericInspectionAdapterError';
  }
}

/**
 * The stable per-query provenance identity within a run (§12): the
 * same logical query is ONE capture slot. Keep it ≤ 120 chars — the
 * queryId is validated ≤ 64 chars at registration, so the combined
 * form always fits.
 */
export function genericInspectionProvenanceIdentity(queryId: string): string {
  return `manifest-inspection:${queryId}`;
}

/** Deterministic reason codes for non-2xx statuses (B-5 repair). */
const HTTP_NON_SUCCESS = 'HTTP_NON_SUCCESS';

export interface CaptureGenericInspectionQueryInput {
  /** The run this evidence plane observation belongs to. */
  readonly runId: string;
  readonly stepRunId: string | null;
  /** The FROZEN registered target origin (from the run snapshot). */
  readonly origin: string;
  /** The FROZEN registered target environment (from the run snapshot). */
  readonly environment: 'LOCAL_DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  /** The FROZEN ManifestEvidencePolicy (from the run snapshot). */
  readonly policy: ManifestEvidencePolicy;
  /** The queryId to capture — must resolve to a frozen declaration. */
  readonly queryId: string;
  readonly writerOwnerId: string;
  readonly writerFencingToken: string | null;
}

export interface CapturedGenericInspection {
  readonly observationId: string;
  readonly observationHash: string;
  readonly chainIndex: number;
  readonly adapterKind: typeof GENERIC_INSPECTION_ADAPTER_KIND;
  readonly queryId: string;
  readonly valid: boolean;
}

/** Result of one bounded HTTP GET against the frozen literal path. */
interface QueryHttpResponse {
  readonly httpStatus: number | null;
  /**
   * Whether a body actually arrived on the wire (200 with zero bytes
   * is an observed EMPTY body — honest `observedBodyBytes: 0` — not a
   * non-response). Storage of that body is governed separately by the
   * opaque-body rule: only a successfully parsed JSON body is ever
   * persisted (as its redacted representation).
   */
  readonly bodyObserved: boolean;
  /**
   * The decoded body text — used ONLY to attempt the JSON parse inside
   * this frame (and for the honest observed byte count). NEVER returned
   * to the persistence layer: a body that does not parse is opaque
   * (the opaque-body rule) and its text is never persisted or hashed.
   */
  readonly bodyText: string | null;
  /** Honest observed wire byte count (0 when no body arrived). */
  readonly observedBodyBytes: number;
  /** Bounded content-type header metadata (null when no response). */
  readonly responseContentType: string | null;
  /** Honest B-1 provenance: the wire read was cut at the byte cap. */
  readonly truncated: boolean;
  readonly errorMessage: string | null;
}

/**
 * The ONE HTTP transport for the generic inspection adapter. It asks
 * the engine's reviewed destination seam for every protection the
 * executor applies — there is no second (weaker) policy here:
 *
 *   - `assertDestinationAllowed` — scheme/environment policy +
 *     resolve-once-validate address-class denial BEFORE any connection
 *     (LOCAL_DEVELOPMENT exception byte-identical to the executor's);
 *   - `assertOriginAllowed` — origin authority/equality (a rejected
 *     absolute/scheme-relative escape can never even be constructed:
 *     the URL is origin + validated literal path, checked for origin
 *     equality exactly as the executor does);
 *   - `originHostHeader` — Host derived from the registered origin;
 *   - `redirect: 'manual'` — a 3xx is an OBSERVED status, never a
 *     destination escape (security-boundaries §6);
 *   - no credentials of any kind are attached (credential-free seam).
 */
async function fetchViaSharedDestinationSeam(
  origin: string,
  relativePath: string,
  environment: CaptureGenericInspectionQueryInput['environment'],
): Promise<QueryHttpResponse> {
  let response: Response;
  try {
    const originUrl = new URL(origin);
    // Address-class policy BEFORE any connection attempt (the exact
    // executor seam; a denial is provably pre-send).
    await assertDestinationAllowed(originUrl, environment);
    // The URL is ONLY the frozen registered origin + the validated
    // literal declared path (ADR-0022); origin equality is asserted
    // through the shared seam (defense in depth, identical rule).
    const url = new URL(relativePath, originUrl);
    assertOriginAllowed(url, originUrl, environment);
    response = await fetch(url, {
      method: 'GET',
      headers: {
        host: originHostHeader(originUrl),
        accept: 'application/json',
      },
      // security-boundaries §6: a conservative policy identical to the
      // executor — redirects are NEVER followed on this seam; a 3xx is
      // an observed HTTP status, never a destination escape.
      redirect: 'manual',
      signal: AbortSignal.timeout(GENERIC_INSPECTION_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof DestinationDeniedError ||
      error instanceof OriginAuthorityError ||
      (error instanceof Error && error.name === 'DestinationDeniedError') ||
      (error instanceof Error && error.name === 'OriginAuthorityError')
    ) {
      // Destination policy denial: no response was observed, the request
      // never became business evidence, and the denial detail is honest,
      // bounded, secret-free.
      const detail = error instanceof Error ? error.message : String(error);
      return {
        httpStatus: null,
        bodyObserved: false,
        bodyText: null,
        observedBodyBytes: 0,
        responseContentType: null,
        truncated: false,
        errorMessage: `destination denied by the shared engine policy: ${detail}`.slice(
          0,
          GENERIC_INSPECTION_MAX_ERROR_CHARS,
        ),
      };
    }
    const isAbort =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      httpStatus: null,
      bodyObserved: false,
      bodyText: null,
      observedBodyBytes: 0,
      responseContentType: null,
      truncated: false,
      errorMessage: isAbort
        ? `inspection request timed out after ${GENERIC_INSPECTION_TIMEOUT_MS}ms (bounded)`
        : `inspection request failed before a response was observed: ${(error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, GENERIC_INSPECTION_MAX_ERROR_CHARS)}`,
    };
  }
  // Bounded content-type header metadata: a header VALUE, never body
  // content, and bounded because every target-controlled string is
  // bounded (security-boundaries §8).
  const responseContentType = (response.headers.get('content-type') ?? '').slice(0, 200) || null;
  // Streamed read with a hard byte cap: an attacker-controlled response
  // can never balloon memory or storage (security-boundaries §8).
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return {
      httpStatus: response.status,
      bodyObserved: false,
      bodyText: null,
      observedBodyBytes: 0,
      responseContentType,
      truncated: false,
      errorMessage: null,
    };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    let done: boolean;
    let next: { done: boolean; value?: Uint8Array } | undefined;
    try {
      next = await reader.read();
      done = next.done;
    } catch (error) {
      return {
        httpStatus: response.status,
        bodyObserved: received > 0,
        bodyText: null,
        observedBodyBytes: received,
        responseContentType,
        truncated,
        errorMessage: `inspection response body read failed: ${(error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, GENERIC_INSPECTION_MAX_ERROR_CHARS)}`,
      };
    }
    if (done || next === undefined) {
      break;
    }
    const chunk = next.value;
    if (chunk === undefined) {
      continue;
    }
    if (received + chunk.byteLength > GENERIC_INSPECTION_MAX_RESPONSE_BYTES) {
      const remaining = GENERIC_INSPECTION_MAX_RESPONSE_BYTES - received;
      if (remaining > 0) {
        chunks.push(chunk.slice(0, remaining));
        received += remaining;
      }
      truncated = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    received += chunk.byteLength;
  }
  // Decode ONLY to attempt the parse (below). The decoded text is the
  // unredact-able raw body: it is used inside this frame for JSON
  // parsing and for the honest observed byte count, and is NEVER
  // returned to the persistence layer (the opaque-body rule — a
  // non-parsed body's text can never be proven secret-free).
  const text = new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks, received));
  return {
    httpStatus: response.status,
    bodyObserved: true,
    truncated: truncated,
    observedBodyBytes: received,
    bodyText: text,
    responseContentType,
    errorMessage: null,
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Performs the REAL HTTP GET for one declared query, builds the honest
 * envelope, applies redaction (built-ins + the frozen target
 * sensitiveFields) BEFORE hashing/persistence, and appends the
 * target_observation with the stable per-query provenance identity.
 *
 * Idempotency (§12): the same query re-captured with identical stored
 * content resolves to the SAME row; the same query re-captured with
 * DIFFERENT stored content throws EvidenceIntegrityConflictError —
 * evidence is never overwritten and two contradictory "final" captures
 * can never coexist.
 */
export async function captureGenericInspectionQuery(
  prisma: PrismaClient,
  input: CaptureGenericInspectionQueryInput,
): Promise<CapturedGenericInspection> {
  // The query MUST resolve to the FROZEN declaration — never guessed,
  // never defaulted (ADR-0021: unknown query ⇒ zero events, honest
  // adapter failure here).
  const query: ManifestInspectionQuery | undefined = input.policy.inspection.find(
    (entry: ManifestInspectionQuery) => entry.queryId === input.queryId,
  );
  if (query === undefined) {
    throw new GenericInspectionAdapterError(
      `queryId "${input.queryId}" does not resolve to a declared inspection query in the frozen evidence policy (never guessed)`,
    );
  }

  // The request is exactly the frozen origin + the validated literal
  // path (ADR-0022), dispatched through the SHARED reviewed destination
  // seam (B-1) — there is no second HTTP policy in this package. No
  // interpolation of any kind exists on this path; the manifest
  // validator rejected template syntax at registration and
  // deriveEvidencePolicy re-validated the manifest before freezing.
  const response = await fetchViaSharedDestinationSeam(input.origin, query.path, input.environment);

  //
  // B-5 repair: business normalization is eligible ONLY for 2xx. A
  // non-2xx status (3xx/4xx/5xx) is still an honest persisted
  // observation, but its validation is INVALID with the deterministic
  // reason code `HTTP_NON_SUCCESS` — a target's error payload can
  // never become business events merely by carrying a shape-valid JSON
  // array. 204 (no body) is likewise ZERO events: inspection/v1
  // requires a JSON array body.
  const statusSuccess =
    response.httpStatus !== null && response.httpStatus >= 200 && response.httpStatus < 300;
  let parsedJson: unknown;
  let parseStatus: GenericInspectionObservationEnvelope['observed']['parseStatus'] =
    'not-attempted';
  let opaqueBody: GenericOpaqueBodyMetadata | null = null;
  if (response.truncated) {
    // OPAQUE-BODY RULE (security closure): a truncated capture is never
    // parsed (B-1 — the stored bytes would be a bounded PREFIX of the
    // response) and its raw text is NEVER persisted or hashed. Safe
    // bounded metadata only; no body-derived fingerprint exists.
    parseStatus = 'not-attempted';
    opaqueBody = {
      placeholder: GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
      reasonCode: 'TRUNCATED_BODY_NOT_PERSISTED',
      observedBodyBytes: response.observedBodyBytes,
    };
  } else if (
    response.bodyObserved &&
    response.bodyText !== null &&
    response.errorMessage === null
  ) {
    try {
      parsedJson = JSON.parse(response.bodyText);
      parseStatus = 'parsed-json';
      // Valid parsed JSON: stored as its REDACTED structured
      // representation (the redaction walk below) — the raw body text
      // itself never persists in either path.
    } catch {
      parseStatus = 'invalid-json';
      opaqueBody = {
        placeholder: GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
        reasonCode:
          response.observedBodyBytes === 0
            ? 'NO_RESPONSE_BODY_OBSERVED'
            : 'INVALID_JSON_BODY_NOT_PERSISTED',
        observedBodyBytes: response.observedBodyBytes,
      };
    }
  } else {
    opaqueBody = {
      placeholder: GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
      reasonCode: !response.bodyObserved
        ? 'NO_RESPONSE_BODY_OBSERVED'
        : response.errorMessage === null
          ? 'INVALID_JSON_BODY_NOT_PERSISTED'
          : 'BODY_READ_FAILED_NOT_PERSISTED',
      observedBodyBytes: response.observedBodyBytes,
    };
  }
  const validation: GenericInspectionValidation = !statusSuccess
    ? {
        valid: false,
        reasonCode: response.errorMessage === null ? HTTP_NON_SUCCESS : 'NO_RESPONSE_OBSERVED',
        detail:
          response.errorMessage ??
          `target returned HTTP ${String(response.httpStatus)}; inspection/v1 business normalization is eligible only for 2xx responses`,
      }
    : response.truncated
      ? {
          valid: false,
          reasonCode: 'RESPONSE_TRUNCATED',
          detail:
            'the response exceeded the inspection byte cap and was cut; a truncated prefix is never parsed into business events',
        }
      : parseStatus === 'parsed-json'
        ? validateGenericInspectionCapture(parsedJson, query)
        : {
            valid: false,
            reasonCode: response.errorMessage === null ? 'INVALID_JSON' : 'NO_RESPONSE_OBSERVED',
            detail:
              response.errorMessage ??
              'the response body was not a parseable JSON array; its raw text is never persisted (opaque-body rule) — safe bounded metadata only',
          };

  const envelope: GenericInspectionObservationEnvelope = {
    envelopeVersion: GENERIC_INSPECTION_ENVELOPE_VERSION,
    adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
    declaration: {
      inspectionVersion: 'inspection/v1',
      queryId: query.queryId,
      roleId: query.roleId,
      path: query.path,
    },
    observed: {
      httpStatus: response.httpStatus,
      responseContentType: response.responseContentType,
      parseStatus,
      truncated: response.truncated,
      ...(parseStatus === 'parsed-json' ? { responseJson: parsedJson } : {}),
      responseJsonText: null,
      ...(opaqueBody === null ? {} : { opaqueBody }),
    },
    validation,
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      applied: false,
    },
  };

  // Redaction BEFORE persistence and BEFORE hashing (security-
  // boundaries §7): built-in denylist + the frozen target-declared
  // sensitiveFields — additively, never weakening built-ins. The WHOLE
  // envelope (declaration metadata, observed reality, validation
  // provenance) is redacted; the unredacted capture never leaves this
  // frame.
  //
  // OPAQUE-BODY SECURITY RULE: only a successfully parsed JSON body is
  // ever persisted, and it persists ONLY as its REDACTED structured
  // representation — observed.responseJson (the redacted deep copy) and
  // observed.responseJsonText (the canonical serialization OF THAT
  // REDACTED value; the raw pre-redaction bytes never persist). An
  // opaque body — never arrived, truncated, malformed, text/plain,
  // text/html, or any other unparseable error body — persists NO body
  // text whatsoever: no raw bytes, no hash or fingerprint derived from
  // those bytes, only the safe bounded metadata in observed.opaqueBody
  // and the fixed placeholder. Regex-scanning free text (the earlier
  // hardening) can mask KNOWN secret shapes but can never PROVE
  // arbitrary opaque text secret-free — so the raw text is not stored
  // at all. Security wins over literal fidelity (R-13, security-
  // boundaries §7); contentHash is computed over exactly this final
  // safe stored representation.
  const redactedEnvelope = redactJsonWithSensitiveFields(
    envelope,
    input.policy.sensitiveFields,
  ) as GenericInspectionObservationEnvelope;
  // Bounded stored TEXT representation (parity with the pre-closure
  // semantics): the REDACTED structured serialization must fit the
  // storage cap to persist as text. An over-cap representation's TEXT
  // is NOT persisted — not even a cut prefix — and the omission is
  // honestly marked. The REDACTED responseJson (the structural truth,
  // exactly as persisted before this closure) is kept: the cap has
  // always bounded the stored TEXT, never the redacted structure.
  const redactedJsonText =
    redactedEnvelope.observed.parseStatus === 'parsed-json' &&
    redactedEnvelope.observed.responseJson !== undefined
      ? JSON.stringify(redactedEnvelope.observed.responseJson)
      : null;
  const overStorageCap =
    redactedJsonText !== null && redactedJsonText.length > GENERIC_INSPECTION_MAX_RESPONSE_CHARS;
  const storedResponseJsonText = overStorageCap ? null : redactedJsonText;
  const overCapBodyMetadata: GenericOpaqueBodyMetadata = {
    placeholder: GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
    reasonCode: 'OVER_CAP_BODY_NOT_PERSISTED',
    observedBodyBytes: response.observedBodyBytes,
  };
  const redactionApplied = JSON.stringify(redactedEnvelope) !== JSON.stringify(envelope);
  const storedEnvelope: GenericInspectionObservationEnvelope = {
    ...redactedEnvelope,
    observed: {
      ...redactedEnvelope.observed,
      responseJsonText: storedResponseJsonText,
      ...(overStorageCap ? { opaqueBody: overCapBodyMetadata } : {}),
    },
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      applied: redactionApplied || overStorageCap,
    },
  };
  // Integrity assertion: the final document re-redacts to itself (no
  // redactable material can remain) and is the EXACT representation
  // that will be hashed and persisted.
  const reRedacted = redactJsonWithSensitiveFields(storedEnvelope, input.policy.sensitiveFields);
  if (JSON.stringify(reRedacted) !== JSON.stringify(storedEnvelope)) {
    throw new GenericInspectionAdapterError(
      'internal redaction inconsistency: the stored representation still contains redactable material',
    );
  }

  const store = new RawObservationStore(prisma);
  const appended = await store.appendTargetObservation({
    runId: input.runId,
    stepRunId: input.stepRunId,
    adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
    observedAt: new Date(),
    payload: storedEnvelope,
    writerOwnerId: input.writerOwnerId,
    writerFencingToken: input.writerFencingToken,
    provenanceIdentity: genericInspectionProvenanceIdentity(query.queryId),
    // Honest B-1 transport provenance on the ROW as well as the
    // envelope: the wire read was cut at the byte cap.
    truncated: response.truncated,
  });
  return {
    observationId: appended.id,
    observationHash: appended.contentHash,
    chainIndex: appended.chainIndex,
    adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
    queryId: query.queryId,
    valid: storedEnvelope.validation.valid,
  };
}

/**
 * Captures a declared query set (default: EVERY declared inspection
 * query of the frozen policy) sequentially. Each query is its own
 * honest observation; one query's transport failure never blocks the
 * others (honest incompleteness — the failed query persists its own
 * NO_RESPONSE_OBSERVED envelope when a response was never observed).
 */
export async function captureGenericInspectionSet(
  prisma: PrismaClient,
  input: Omit<CaptureGenericInspectionQueryInput, 'queryId'> & {
    readonly queryIds?: readonly string[];
  },
): Promise<CapturedGenericInspection[]> {
  const declaredIds = input.policy.inspection.map((query) => query.queryId);
  const requested = input.queryIds ?? declaredIds;
  const results: CapturedGenericInspection[] = [];
  for (const queryId of requested) {
    results.push(await captureGenericInspectionQuery(prisma, { ...input, queryId }));
  }
  return results;
}
