// =====================================================================
// RuptureGrid v1.0 — experiment document validation
// =====================================================================
// Validation is the server-side security gate (R-14): absolute URLs,
// scheme-relative forms, userinfo tricks, and non-allowlisted headers
// are REJECTED here, before any run exists. The same checks are
// re-derived at execution time (defense in depth) — validation never
// trusts that a revision was validated earlier.

import type { PrismaClient } from '@rupturegrid/control-db';
import { EXECUTION_LIMITS } from '@rupturegrid/shared';
import type { TargetRegistration } from './prisma-types.js';
import type {
  ExperimentDocument,
  ExperimentStep,
  HttpMethod,
  MutationClassification,
} from './types.js';
import { ExperimentValidationError, HTTP_METHODS, MUTATION_CLASSIFICATIONS } from './types.js';

/** Header names experiments may set. Host is pinned by the executor. */
export const ALLOWED_HEADER_NAMES = new Set([
  'content-type',
  'accept',
  'user-agent',
  'x-rupturegrid-delivery-attempt-id',
  // Demo provider-signature header; the only allowed VALUE form for it
  // is the literal `${signature}` token (signed by the executor over
  // the final body bytes — the secret never enters the document).
  'x-rupturegrid-provider-signature',
  // Bearer authentication, ONLY in the pure reference form
  // `Bearer ${credential.<REF>}` — literal values are rejected.
  'authorization',
  'idempotency-key',
]);

/** Host is derived from the registered origin, never from headers. */
export const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'expect',
  'upgrade',
]);

export class PathPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

/**
 * Validates a relative path for an HTTP action. The registered origin
 * is the ONLY authority; the path must be relative (security-
 * boundaries §3.4): no scheme, no authority, no userinfo tricks.
 * Returns the normalized path (always starts with '/').
 */
export function validateRelativePath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new PathPolicyError('relativePath must be a non-empty string');
  }
  if (rawPath.includes('\r') || rawPath.includes('\n') || rawPath.includes('\0')) {
    throw new PathPolicyError('relativePath must not contain CR/LF/NUL (CRLF injection)');
  }
  if (/^https?:\/\//i.test(rawPath)) {
    throw new PathPolicyError(
      `absolute URL is not allowed: steps execute against the registered origin only (got "${rawPath.slice(0, 60)}")`,
    );
  }
  if (rawPath.startsWith('//')) {
    throw new PathPolicyError(`scheme-relative URL is not allowed (got "${rawPath.slice(0, 60)}")`);
  }
  // Embedded scheme in the PATH portion (a "://" inside a query VALUE
  // is legitimate — e.g. ?redirect=https://… — and is not an escape).
  const rawQueryIndex = rawPath.search(/[?#]/);
  const rawPathPart = rawQueryIndex === -1 ? rawPath : rawPath.slice(0, rawQueryIndex);
  if (rawPathPart.includes('://')) {
    throw new PathPolicyError(`embedded scheme is not allowed (got "${rawPath.slice(0, 60)}")`);
  }
  // Percent-encoded authority escapes: decode once (safely) and re-run
  // the structural checks on the DECODED form, so %2f%2f trickery is
  // caught before any URL construction downstream.
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new PathPolicyError('relativePath contains invalid percent-encoding');
  }
  // The decoded checks scope to the decoded PATH portion: a `://` or
  // `//` inside a query VALUE (e.g. ?url=https://evil.example) is data,
  // not an authority escape.
  const decodedPathOnly =
    decoded.search(/[?#]/) === -1 ? decoded : decoded.slice(0, decoded.search(/[?#]/));
  if (
    /^https?:\/\//i.test(decoded) ||
    decoded.startsWith('//') ||
    decodedPathOnly.includes('://') ||
    decodedPathOnly.includes('//')
  ) {
    throw new PathPolicyError(
      `percent-encoded authority escape is not allowed (got "${rawPath.slice(0, 60)}")`,
    );
  }
  // Any authority component (a "//" after a leading segment) is an
  // authority escape: reject unconditionally for v1.
  const queryIndex = rawPath.search(/[?#]/);
  const pathPart = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  if (pathPart.includes('//')) {
    throw new PathPolicyError(
      `authority-like "//" in path is not allowed (got "${rawPath.slice(0, 60)}")`,
    );
  }
  // Pseudo-scheme lead ("javascript:…", "mailto:…", "data:…"): if a
  // colon appears anywhere BEFORE the first '/' of the path portion
  // (query excluded), the string reads as a scheme to lenient URL
  // parsers and is rejected. `ftp://…` and `javascript:alert(1)` both
  // fall here; `/x?url=…` does not (colon is inside the query).
  const decodedQueryIndex = decoded.search(/[?#]/);
  const decodedPathPart = decodedQueryIndex === -1 ? decoded : decoded.slice(0, decodedQueryIndex);
  const firstSlash = decodedPathPart.indexOf('/');
  const beforeFirstSlash =
    firstSlash === -1 ? decodedPathPart : decodedPathPart.slice(0, firstSlash);
  if (beforeFirstSlash.includes(':')) {
    throw new PathPolicyError(`pseudo-scheme path is not allowed (got "${rawPath.slice(0, 60)}")`);
  }
  // userinfo in a relative path would only matter with an authority —
  // already rejected above — but reject '@' at the path start for
  // clarity.
  if (rawPath.startsWith('@')) {
    throw new PathPolicyError('relativePath must not start with "@"');
  }
  const normalized = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  // Parse round-trip: prove the final URL host equals the origin host
  // for a representative origin, and that the URL parses at all (an
  // unparseable form must be a PathPolicyError, not a TypeError).
  let probe: URL;
  try {
    probe = new URL(normalized, 'http://registered-origin.test');
  } catch {
    throw new PathPolicyError(`relativePath is not a usable path (got "${rawPath.slice(0, 60)}")`);
  }
  if (probe.hostname !== 'registered-origin.test') {
    throw new PathPolicyError(
      `path escapes the registered origin (resolved host: ${probe.hostname})`,
    );
  }
  if (probe.protocol !== 'http:') {
    throw new PathPolicyError('path escapes the registered scheme');
  }
  return normalized;
}

export interface ValidateExperimentInput {
  readonly document: unknown;
  readonly target: TargetRegistration & { origins: { origin: string }[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an experiment document against the registered target and
 * Phase 3 blast-radius limits. Returns the normalized document.
 * Throws ExperimentValidationError with every issue listed.
 */
export function validateExperimentDocument(input: ValidateExperimentInput): ExperimentDocument {
  const issues: string[] = [];
  const raw = input.document;
  if (!isRecord(raw)) {
    throw new ExperimentValidationError(['document must be a JSON object']);
  }
  const rawSteps = raw['steps'];
  if (!Array.isArray(rawSteps)) {
    throw new ExperimentValidationError(['document.steps must be an array']);
  }
  if (rawSteps.length === 0) {
    issues.push('document.steps must contain at least one step');
  }
  if (rawSteps.length > EXECUTION_LIMITS.maxStepsPerExperiment) {
    issues.push(
      `document.steps exceeds maxStepsPerExperiment (${EXECUTION_LIMITS.maxStepsPerExperiment})`,
    );
  }

  const targetContract = input.target.contractKind;
  const targetRefs = new Set(input.target.credentialRefs);
  const seenNames = new Set<string>();

  const steps: ExperimentDocument['steps'] = rawSteps.map((rawStep, index) => {
    const stepIssuesBefore = issues.length;
    if (!isRecord(rawStep)) {
      issues.push(`steps[${index}] must be an object`);
      return placeholderStep(index);
    }
    const name = rawStep['name'];
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
      issues.push(
        `steps[${index}].name must match [a-z][a-z0-9-]{0,62} (referenced by variable references)`,
      );
      return placeholderStep(index);
    }
    if (seenNames.has(name)) {
      issues.push(`steps[${index}].name duplicates an earlier step name`);
    }
    seenNames.add(name);

    const rawAction = rawStep['action'];
    if (!isRecord(rawAction)) {
      issues.push(`steps[${index}].action must be an object`);
      return placeholderStep(index);
    }
    const method = rawAction['method'];
    if (typeof method !== 'string' || !(HTTP_METHODS as readonly string[]).includes(method)) {
      issues.push(`steps[${index}].action.method must be one of: ${HTTP_METHODS.join(', ')}`);
    }
    const rawPath = rawAction['relativePath'];
    let normalizedPath = '';
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      issues.push(`steps[${index}].action.relativePath must be a non-empty string`);
    } else {
      try {
        normalizedPath = validateRelativePath(rawPath);
      } catch (error) {
        issues.push(
          `steps[${index}].action.relativePath: ${error instanceof Error ? error.message : 'invalid'}`,
        );
      }
    }

    // ---- Headers ----
    const rawHeaders = rawAction['headers'];
    const headers: Record<string, string> = {};
    if (rawHeaders !== undefined) {
      if (!isRecord(rawHeaders)) {
        issues.push(`steps[${index}].action.headers must be an object`);
      } else {
        const entries = Object.entries(rawHeaders);
        if (entries.length > EXECUTION_LIMITS.maxHeaders) {
          issues.push(
            `steps[${index}].action.headers exceeds maxHeaders (${EXECUTION_LIMITS.maxHeaders})`,
          );
        }
        for (const [headerName, headerValue] of entries) {
          const lower = headerName.toLowerCase();
          if (FORBIDDEN_HEADER_NAMES.has(lower)) {
            issues.push(
              `steps[${index}].action.headers["${headerName}"] is forbidden (host/content framing is executor-owned)`,
            );
            continue;
          }
          if (!ALLOWED_HEADER_NAMES.has(lower)) {
            issues.push(
              `steps[${index}].action.headers["${headerName}"] is not in the allowlist (${[...ALLOWED_HEADER_NAMES].join(', ')})`,
            );
            continue;
          }
          // The provider-signature header may ONLY carry the literal
          // ${signature} token (executor signs over the final bytes).
          if (lower === 'x-rupturegrid-provider-signature' && headerValue !== '${signature}') {
            issues.push(
              `steps[${index}].action.headers["x-rupturegrid-provider-signature"] must be the literal "\${signature}" token (the executor computes it)`,
            );
            continue;
          }
          if (typeof headerValue !== 'string') {
            issues.push(`steps[${index}].action.headers["${headerName}"] must be a string`);
            continue;
          }
          if (headerValue.includes('\r') || headerValue.includes('\n')) {
            issues.push(
              `steps[${index}].action.headers["${headerName}"] must not contain CR/LF (header injection)`,
            );
            continue;
          }
          // Bearer credentials: the ONLY permitted form is the pure
          // reference `Bearer ${credential.<REF>}`. A literal secret in
          // a definition would violate R-13 (secrets never persist).
          if (lower === 'authorization') {
            if (!/^Bearer \$\{credential\.[A-Z0-9_]+\}$/.test(headerValue)) {
              issues.push(
                `steps[${index}].action.headers["authorization"] must be exactly "Bearer \${credential.<REF>}" (no literal credentials)`,
              );
              continue;
            }
          }
          headers[lower] = headerValue;
        }
      }
    }

    // ---- Body ----
    const rawBody = rawAction['body'];
    let body: string | undefined;
    if (rawBody !== undefined) {
      if (typeof rawBody !== 'string') {
        issues.push(`steps[${index}].action.body must be a string`);
      } else if (Buffer.byteLength(rawBody, 'utf8') > EXECUTION_LIMITS.maxRequestBodyBytes) {
        issues.push(
          `steps[${index}].action.body exceeds maxRequestBodyBytes (${EXECUTION_LIMITS.maxRequestBodyBytes})`,
        );
      } else {
        body = rawBody;
      }
      if ((method === 'GET' || method === 'HEAD') && body !== undefined && body.length > 0) {
        issues.push(`steps[${index}].action.body is not allowed for ${method} requests`);
      }
    }

    // ---- Mutation / contract ----
    const mutation = rawAction['mutation'];
    if (
      typeof mutation !== 'string' ||
      !(MUTATION_CLASSIFICATIONS as readonly string[]).includes(mutation)
    ) {
      issues.push(
        `steps[${index}].action.mutation must be one of: ${MUTATION_CLASSIFICATIONS.join(', ')}`,
      );
    }
    const contract = rawAction['contract'];
    if (typeof contract !== 'string' || contract !== targetContract) {
      issues.push(
        `steps[${index}].action.contract must equal the target's contractKind (${targetContract})`,
      );
    }
    if (
      mutation === 'READ_ONLY' &&
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    ) {
      // A read-only POST is contradictory in v1; force honesty at
      // definition time instead of interpreting later.
      issues.push(
        `steps[${index}].action.mutation=READ_ONLY is only valid for GET/HEAD-style requests (got ${method})`,
      );
    }

    // ---- Numeric limits ----
    const repeat = rawAction['repeat'] ?? 1;
    if (
      typeof repeat !== 'number' ||
      !Number.isInteger(repeat) ||
      repeat < 1 ||
      repeat > EXECUTION_LIMITS.maxRepeat
    ) {
      issues.push(
        `steps[${index}].action.repeat must be an integer in [1, ${EXECUTION_LIMITS.maxRepeat}]`,
      );
    }
    const concurrency = rawAction['concurrency'] ?? 1;
    if (
      typeof concurrency !== 'number' ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > EXECUTION_LIMITS.maxConcurrency
    ) {
      issues.push(
        `steps[${index}].action.concurrency must be an integer in [1, ${EXECUTION_LIMITS.maxConcurrency}]`,
      );
    }
    const timeoutMs = rawAction['timeoutMs'] ?? EXECUTION_LIMITS.defaultTimeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > EXECUTION_LIMITS.maxTimeoutMs
    ) {
      issues.push(
        `steps[${index}].action.timeoutMs must be an integer in [1, ${EXECUTION_LIMITS.maxTimeoutMs}]`,
      );
    }
    const retryPolicy = rawAction['retryPolicy'] ?? 'NONE';
    if (retryPolicy !== 'NONE' && retryPolicy !== 'SAFE') {
      issues.push(`steps[${index}].action.retryPolicy must be NONE or SAFE`);
    }

    // ---- Credential refs ----
    const rawRefs = rawAction['credentialRefs'];
    const credentialRefs: string[] = [];
    if (rawRefs !== undefined) {
      if (!Array.isArray(rawRefs) || rawRefs.some((ref) => typeof ref !== 'string')) {
        issues.push(`steps[${index}].action.credentialRefs must be an array of strings`);
      } else {
        for (const ref of rawRefs as string[]) {
          if (!targetRefs.has(ref)) {
            issues.push(
              `steps[${index}].action.credentialRefs["${ref}"] is not registered on the target`,
            );
          } else {
            credentialRefs.push(ref);
          }
        }
      }
    }

    // ---- Explicit evidence adapter (Phase 4, §28/§29) ----
    const rawAdapter = rawAction['evidenceAdapter'];
    let evidenceAdapter: ExperimentStep['action']['evidenceAdapter'];
    if (rawAdapter !== undefined) {
      if (!isRecord(rawAdapter)) {
        issues.push(`steps[${index}].action.evidenceAdapter must be an object`);
      } else {
        const kind = rawAdapter['kind'];
        if (kind !== 'demo-fintech-payment-lineage') {
          issues.push(
            `steps[${index}].action.evidenceAdapter.kind must be "demo-fintech-payment-lineage" (the only Phase 4 adapter)`,
          );
        }
        const from = rawAdapter['providerPaymentIdFrom'];
        const validFrom =
          typeof from === 'string' &&
          (/^\$\{steps\.[a-z][a-z0-9-]{0,62}\.response\.[A-Za-z0-9_.[\]]+\}$/.test(from) ||
            /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(from));
        if (!validFrom) {
          issues.push(
            `steps[${index}].action.evidenceAdapter.providerPaymentIdFrom must be a "\${steps.<name>.response.<path>}" reference or a literal identity`,
          );
        }
        if (kind === 'demo-fintech-payment-lineage' && validFrom) {
          evidenceAdapter = {
            kind: 'demo-fintech-payment-lineage',
            providerPaymentIdFrom: from as string,
          };
        }
      }
    }

    if (issues.length > stepIssuesBefore) {
      return placeholderStep(index);
    }
    const action: ExperimentStep['action'] = {
      method: method as HttpMethod,
      relativePath: normalizedPath,
      mutation: mutation as MutationClassification,
      retryPolicy: retryPolicy as 'NONE' | 'SAFE',
      repeat: repeat as number,
      concurrency: concurrency as number,
      timeoutMs: timeoutMs as number,
      contract: contract as ExperimentStep['action']['contract'],
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(credentialRefs.length > 0 ? { credentialRefs } : {}),
      ...(evidenceAdapter !== undefined ? { evidenceAdapter } : {}),
    };
    return { name, action };
  });

  if (issues.length > 0) {
    throw new ExperimentValidationError(issues);
  }
  return { steps };
}

function placeholderStep(index: number): ExperimentStep {
  return {
    name: `__invalid_${index}__`,
    action: {
      method: 'GET',
      relativePath: '/__invalid__',
      mutation: 'READ_ONLY',
      retryPolicy: 'NONE',
      repeat: 1,
      concurrency: 1,
      timeoutMs: EXECUTION_LIMITS.defaultTimeoutMs,
      contract: 'GENERIC_HTTP',
    },
  };
}

/** Creates a definition + first immutable revision in one transaction. */
export async function createExperiment(
  prisma: PrismaClient,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly targetId: string;
    readonly document: unknown;
  },
): Promise<{ definitionId: string; revisionId: string; revisionNumber: number }> {
  if (typeof input.name !== 'string' || input.name.trim().length < 3) {
    throw new ExperimentValidationError(['name must be at least 3 characters']);
  }
  const target = await prisma.targetRegistration.findUnique({
    where: { id: input.targetId },
    include: { origins: true },
  });
  if (target === null) {
    throw new ExperimentValidationError([`target ${input.targetId} is not registered`]);
  }
  const document = validateExperimentDocument({ document: input.document, target });
  return prisma.$transaction(async (tx) => {
    const definition = await tx.experimentDefinition.create({
      data: {
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
    const revision = await tx.experimentRevision.create({
      data: {
        definitionId: definition.id,
        revisionNumber: 1,
        targetId: input.targetId,
        stepsJson: JSON.parse(JSON.stringify(document)) as object,
      },
    });
    return {
      definitionId: definition.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
    };
  });
}
