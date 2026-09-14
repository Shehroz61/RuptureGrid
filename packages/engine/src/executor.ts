// =====================================================================
// RuptureGrid v1.0 — controlled HTTP executor (security-boundaries §3–§8)
// =====================================================================
// One action type: controlled HTTP against a REGISTERED origin.
// Enforced here, per invocation, server-side:
//   - URL built ONLY from the snapshot's registered origin + validated
//     relative path (absolute/scheme-relative forms cannot exist here:
//     the snapshot carries normalized paths)
//   - Host header derived from the origin, never from step headers
//   - redirects NOT followed (redirect: 'manual'); a 3xx is returned
//     as an observation — no authority escape
//   - bounded request/response sizes, per-invocation timeout
//   - credentials resolved from validated executor env by REF NAME at
//     request time; values never logged, never persisted (ADR-0012)
//   - transport-stage tracking (§50) for side-effect classification

import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { EXECUTION_LIMITS } from '@rupturegrid/shared';
import type { TargetEnvironment } from '@rupturegrid/shared';
import type { ContractKind } from './target.js';
import type { HttpActionTemplate } from './types.js';

export type TransportStage =
  'PREPARED' | 'CONNECTING' | 'REQUEST_SENT' | 'RESPONSE_HEADERS' | 'RESPONSE_COMPLETE';

export interface CredentialResolver {
  /**
   * Resolves a credential REFERENCE NAME to its value at request time.
   * Implementations own the values (executor env); the value must
   * never be logged or persisted (ADR-0012).
   */
  resolve(ref: string): string;
}

export class ExecutorSecurityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExecutorSecurityError';
  }
}

export class CredentialResolutionError extends Error {
  public constructor(refName: string) {
    super(
      `credential reference "${refName}" is not available in the executor environment; ` +
        `execution cannot proceed (no secret material is exposed)`,
    );
    this.name = 'CredentialResolutionError';
  }
}

export interface ExecutorOutcome {
  readonly intentOutcome: 'SUCCEEDED' | 'FAILED';
  readonly transportStage: TransportStage;
  readonly httpStatus: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly responseBody: string | null;
  /** Response header map as actually received (observation only). */
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly durationMs: number;
  /** Bounded, redaction-safe error detail (no headers, no URLs with secrets). */
  readonly error: string | null;
  readonly headersSent: Readonly<Record<string, string>>;
  /** True when the buffered response exceeded the executor cap and was cut. */
  readonly responseTruncated: boolean;
}

export interface ExecuteInput {
  readonly action: HttpActionTemplate;
  /** Normalized registered origin from the FROZEN snapshot. */
  readonly origin: string;
  readonly contractKind: ContractKind;
  /** Registered target environment (frozen in the snapshot; §12). */
  readonly environment: TargetEnvironment;
  /** Per-invocation identity (e.g. deliveryAttemptId), already generated. */
  readonly invocationIdentity: string;
  readonly credentials: CredentialResolver;
  /**
   * Resolved variable references for THIS invocation (`${steps.…}`),
   * supplied by the step processor from prior invocation results
   * (Phase 3 §59: one small typed mechanism — no general dataflow).
   */
  readonly resolvedBody?: string;
}

/**
 * Address-class policy (security-boundaries §5 — Phase 3 control).
 * Loopback, link-local, private (RFC 1918), unique-local (fc00::/7),
 * and cloud-metadata ranges are DENIED unless the target is explicitly
 * classified LOCAL_DEVELOPMENT (the Demo Target is exactly that).
 * STAGING/PRODUCTION targets must be reachable only by public address.
 */
export class DestinationDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DestinationDeniedError';
  }
}

export function isDeniedAddress(ip: string): boolean {
  const v4 = isIP(ip) === 4 ? ip.split('.').map((part) => Number(part)) : null;
  if (v4 !== null) {
    if (v4[0] === 10 || v4[0] === 127) return true; // private, loopback
    if (v4[0] === 169 && v4[1] === 254) return true; // link-local
    if (v4[0] === 172 && (v4[1] ?? 0) >= 16 && (v4[1] ?? 0) <= 31) return true;
    if (v4[0] === 192 && v4[1] === 168) return true;
    if (v4[0] === 100 && (v4[1] ?? 0) >= 64 && (v4[1] ?? 0) <= 127) return true;
    // CGNAT (shared address space)
    if (v4[0] === 169 && v4[1] === 254) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback, unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped: evaluate the embedded IPv4 address.
      return isDeniedAddress(lower.slice(7));
    }
    // IPv4/IPv6 translation + well-known prefix (64:ff9b::/96).
    if (lower.startsWith('64:ff9b:')) return true;
    return false;
  }
  return true; // unparseable → deny
}

/**
 * Resolve-once-validate (security-boundaries §5): resolves the
 * registered host and verifies every returned address against the
 * address-class policy BEFORE any connection is attempted. Failure is
 * a pre-send denial (KNOWN_ABSENT class) — the request provably never
 * left the executor. DNS rebinding cannot be fully eliminated here
 * (docs §5); network egress isolation remains the primary control.
 */
export async function assertDestinationAllowed(
  origin: URL,
  environment: TargetEnvironment,
): Promise<void> {
  if (environment === 'LOCAL_DEVELOPMENT') {
    return; // Demo/local targets legitimately run on loopback/private nets.
  }
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  const addresses: readonly string[] =
    isIP(host) !== 0
      ? [host]
      : (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  const denied = addresses.find((address) => isDeniedAddress(address));
  if (denied !== undefined) {
    throw new DestinationDeniedError(
      `registered target resolves to a denied address class for environment ${environment}`,
    );
  }
}

const SERVER_AGENT = 'rupturegrid-executor/1.0';
/** Header token that expands to the Demo provider signature of the final body. */
export const SIGNATURE_TOKEN = '${signature}';

/**
 * Maps a fetch failure to its transport stage, CONSERVATIVELY
 * (Phase 3 §25/§50). Once fetch() is invoked the request bytes may
 * already be on the wire; an abort or socket failure during the
 * in-flight window can never PROVE non-send. Only failures that
 * clearly occur before any connection (refused, DNS, TLS trust,
 * connect abort) are provably pre-send:
 *   - provably pre-send          → CONNECTING (classification: KNOWN_ABSENT)
 *   - aborted / ambiguous socket → REQUEST_SENT (classification: INDETERMINATE
 *                                  for mutations — never laundered)
 */
function failureStage(error: unknown, aborted: boolean): { stage: TransportStage; detail: string } {
  if (aborted) {
    return {
      stage: 'REQUEST_SENT',
      detail:
        'request aborted by timeout while in flight; send state unknown (conservatively treated as may-have-sent)',
    };
  }
  const cause = (error as { cause?: unknown })?.cause;
  const code = (cause as { code?: string })?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  const provablyUnsent =
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNABORTED' ||
    code.startsWith('CERT_') ||
    code.startsWith('ERR_TLS_');
  if (provablyUnsent) {
    return {
      stage: 'CONNECTING',
      detail: `connection failed before any request was sent (${code || message.slice(0, 120)})`,
    };
  }
  return {
    stage: 'REQUEST_SENT',
    detail: `request failed in flight; send state unknown (${message.slice(0, 120)})`,
  };
}

/**
 * Builds the headers for one invocation: allowlisted step headers,
 * credential-reference substitution, and the per-invocation identity.
 * Host is ALWAYS derived from the registered origin — step headers
 * cannot set it (validation forbids it; the executor re-derives it).
 *
 * The Demo contract's provider-signature header may carry the literal
 * token `${signature}`: it is computed here over the FINAL body bytes
 * with the resolved signing secret (the secret exists only inside
 * this call frame — ADR-0012).
 */
function buildHeaders(
  action: HttpActionTemplate,
  origin: string,
  invocationIdentity: string,
  credentials: CredentialResolver,
  finalBody: string | undefined,
): Record<string, string> {
  const originUrl = new URL(origin);
  const headers: Record<string, string> = {
    // Executor-owned framing headers (security-boundaries §3.5).
    host: originUrl.host,
    'user-agent': SERVER_AGENT,
    'x-rupturegrid-delivery-attempt-id': invocationIdentity,
  };
  const stepHeaders = action.headers ?? {};
  for (const [name, rawValue] of Object.entries(stepHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'x-rupturegrid-delivery-attempt-id') {
      continue; // Executor-owned identity — never step-overridden.
    }
    if (lower === 'x-rupturegrid-provider-signature' && rawValue === SIGNATURE_TOKEN) {
      if (finalBody === undefined) {
        throw new ExecutorSecurityError(
          '${signature} token requires a request body (Demo webhook contract)',
        );
      }
      const secret = credentials.resolve('DEMO_PROVIDER_SIGNING_SECRET');
      headers[lower] = signDemoWebhookBody(finalBody, secret);
      continue;
    }
    headers[lower] = substituteCredentials(rawValue, credentials);
  }
  if (finalBody !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

/**
 * Substitutes `${credential.<REF>}` tokens in a header value with the
 * resolved runtime value. A token naming an unavailable reference
 * fails the invocation BEFORE any request is prepared (fail fast, no
 * secret material in the error).
 */
export function substituteCredentials(rawValue: string, credentials: CredentialResolver): string {
  return rawValue.replace(/\$\{credential\.([A-Z0-9_]+)\}/g, (_match, ref: string) =>
    credentials.resolve(ref),
  );
}

/**
 * Executes one physical HTTP invocation with stage tracking.
 * The AbortController fires ONLY on timeout; response size is capped
 * by buffered reading with an explicit over-cap flag in the error.
 */
export async function executeHttp(input: ExecuteInput): Promise<ExecutorOutcome> {
  const started = Date.now();
  const origin = new URL(input.origin);
  const timeoutMs = Math.min(
    input.action.timeoutMs ?? EXECUTION_LIMITS.defaultTimeoutMs,
    EXECUTION_LIMITS.maxTimeoutMs,
  );
  // The effective body: an explicitly resolved body (variable
  // references already substituted from prior step outputs) wins over
  // the template body. This is the single place body bytes exist.
  const body = input.resolvedBody ?? input.action.body;
  const bodyBytes = body === undefined ? 0 : Buffer.byteLength(body, 'utf8');
  if (bodyBytes > EXECUTION_LIMITS.maxRequestBodyBytes) {
    return {
      intentOutcome: 'FAILED',
      transportStage: 'PREPARED',
      httpStatus: null,
      requestBytes: bodyBytes,
      responseBytes: 0,
      responseBody: null,
      responseHeaders: null,
      durationMs: 0,
      error: `request body ${bodyBytes}B exceeds maxRequestBodyBytes`,
      headersSent: {},
      responseTruncated: false,
    };
  }

  const headers = buildHeaders(
    input.action,
    input.origin,
    input.invocationIdentity,
    input.credentials,
    body,
  );
  // Address-class policy BEFORE any connection attempt (security-
  // boundaries §5). A denial here is provably pre-send.
  await assertDestinationAllowed(origin, input.environment);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // The URL is origin + validated relative path — no user-supplied
    // absolute URL exists in the snapshot to even construct.
    const url = new URL(input.action.relativePath, origin);
    if (url.origin !== origin.origin) {
      throw new ExecutorSecurityError('resolved URL origin does not match the registered origin');
    }

    const response = await fetch(url, {
      method: input.action.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual', // security-boundaries §6: never follow.
      signal: controller.signal,
      // No cache, no cookies by default in undici; credentials are
      // attached only to the registered origin by construction.
    });
    const status = response.status;

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > 0 && declaredLength > EXECUTION_LIMITS.maxResponseBytes) {
      void response.body?.cancel();
      return {
        intentOutcome: 'FAILED',
        transportStage: 'RESPONSE_HEADERS',
        httpStatus: status,
        requestBytes: bodyBytes,
        responseBytes: declaredLength,
        responseBody: null,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started,
        error: `response content-length ${declaredLength}B exceeds maxResponseBytes`,
        headersSent: headers,
        responseTruncated: false,
      };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > EXECUTION_LIMITS.maxResponseBytes) {
      return {
        intentOutcome: 'FAILED',
        transportStage: 'RESPONSE_COMPLETE',
        httpStatus: status,
        requestBytes: bodyBytes,
        responseBytes: buffer.byteLength,
        responseBody: null,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started,
        error: `response ${buffer.byteLength}B exceeds maxResponseBytes`,
        headersSent: headers,
        responseTruncated: false,
      };
    }
    const responseBytes = buffer.byteLength;
    const text = new TextDecoder().decode(buffer);

    const intentOutcome = status >= 200 && status < 300 ? 'SUCCEEDED' : 'FAILED';
    // Bounded stored body. Phase 4: the bound is an executor capture
    // limit; redaction happens in the evidence layer (before durable
    // persistence), and the truncation fact travels with the outcome.
    const BODY_CAPTURE_CHARS = 4096;
    const responseTruncated = text.length > BODY_CAPTURE_CHARS;
    const responseBody = responseTruncated ? text.slice(0, BODY_CAPTURE_CHARS) : text;
    const finalStage: TransportStage = 'RESPONSE_COMPLETE';
    return {
      intentOutcome,
      transportStage: finalStage,
      httpStatus: status,
      requestBytes: bodyBytes,
      responseBytes,
      responseBody,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      durationMs: Date.now() - started,
      error: intentOutcome === 'FAILED' ? `target returned HTTP ${status}` : null,
      headersSent: headers,
      responseTruncated,
    };
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === 'AbortError' || controller.signal.aborted);
    // §25/§50: the stage at failure time decides KNOWN_ABSENT vs
    // INDETERMINATE. A timeout/abort during the in-flight fetch window
    // CANNOT prove non-send → conservative REQUEST_SENT. Failures that
    // clearly precede any connection → CONNECTING.
    const failure = failureStage(error, isAbort);
    const stage = failure.stage;
    return {
      intentOutcome: 'FAILED',
      transportStage: stage,
      httpStatus: null,
      requestBytes: bodyBytes,
      responseBytes: 0,
      responseBody: null,
      responseHeaders: null,
      durationMs: Date.now() - started,
      error: failure.detail,
      headersSent: headers,
      responseTruncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Re-exported for the contract-specific signing helper below.
export { createHmac };

/**
 * Signs the exact body bytes with the resolved provider signing
 * secret (Demo contract: HMAC-SHA256 hex over the raw UTF-8 bytes).
 * The secret exists only inside this call frame — never stored,
 * never logged.
 */
export function signDemoWebhookBody(body: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(body, 'utf8').digest('hex');
}
