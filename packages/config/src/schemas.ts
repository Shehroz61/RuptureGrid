// =====================================================================
// RuptureGrid v1.0 — per-application environment schemas
// =====================================================================
// Each schema declares exactly the variables that application OWNS
// (ADR-0002). loadConfig strips every other variable, so the validated
// config object contains only the owning application's credentials —
// a foreign family's credentials can never reach application code.
// This design accommodates a shared development .env that documents
// all families (compose service variables included).

import { DEFAULT_QUEUE_PREFIX } from '@rupturegrid/shared';
import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['debug', 'info', 'warn', 'error']).default('info');
const tcpPort = z.coerce.number().int().min(1).max(65535);
const databaseUrl = z
  .string()
  .min(1, 'must not be empty')
  .refine(isParseableUrl, 'must be a valid URL');
const redisUrl = z
  .string()
  .min(1, 'must not be empty')
  .refine(isParseableUrl, 'must be a valid URL');
const queuePrefix = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/, 'must match [a-zA-Z0-9_-]+')
  .default(DEFAULT_QUEUE_PREFIX);

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * RuptureGrid Control Plane API (apps/api).
 * Owns: Control PostgreSQL, Redis, its own HTTP listener, CORS origins.
 * Deliberately does NOT declare any DEMO_* variable.
 */
export const apiConfigSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: tcpPort.default(3001),
  CONTROL_DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: queuePrefix,
  CORS_ORIGINS: z
    .string()
    .min(1)
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  /**
   * Phase 16 (ADR-0024 §4): the SERVER-OWNED target-origin credential
   * grant policy. Platform configuration, maintained OUTSIDE the
   * target-registration request path — a registration request can
   * never grant itself credentials. JSON object mapping each
   * normalized origin authority to the credential reference NAMES
   * authorized for it. Names and origins only; every name must be a
   * member of EXECUTOR_CREDENTIAL_REFS (stale grants fail startup —
   * ADR-0024 §18). Empty = no grants anywhere (fail-closed default:
   * credential-declaring manifest registrations are rejected).
   */
  TARGET_ORIGIN_CREDENTIAL_GRANTS: z
    .string()
    .default('')
    .transform((raw, ctx) => {
      try {
        return parseTargetOriginCredentialGrants(raw);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'invalid grant policy',
        });
        return {} as TargetOriginCredentialGrants;
      }
    }),
});

const positiveIntMs = z.coerce.number().int().min(250).max(600_000);

/**
 * A Demo Fintech credential the executor may resolve at execution time.
 * Optional: only targets that declare the corresponding reference name
 * need the value present. Never logged, never persisted (ADR-0012).
 */
const demoSecretOptional = z
  .string()
  .min(16, 'must be at least 16 characters when present')
  .max(256)
  .optional();

/**
 * RuptureGrid worker (apps/worker) — the Phase 3 execution worker.
 * Same ownership family as the API: Control PostgreSQL + Redis.
 *
 * Credential references: the worker is the EXECUTOR, so it legitimately
 * holds the target-credential VALUES for the credential reference names
 * experiments may declare (ADR-0012; security-boundaries §7). Values are
 * resolved at execution time only, never logged, never persisted. The
 * Demo Fintech DATABASE URL is deliberately NOT declared here — the
 * worker reaches the Demo target over HTTP only (ADR-0002, Phase 3 §7).
 */
export const workerConfigSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    CONTROL_DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: queuePrefix,
    /** Durable lease duration for a claimed step (PostgreSQL time). */
    WORKER_LEASE_DURATION_MS: positiveIntMs.default(30_000),
    /** Heartbeat interval; must be well inside the lease window. */
    WORKER_HEARTBEAT_INTERVAL_MS: positiveIntMs.default(10_000),
    /** Bounded reconciliation sweep interval. */
    WORKER_RECONCILE_INTERVAL_MS: positiveIntMs.default(10_000),
    /** BullMQ worker concurrency (in-flight step jobs per process). */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    // ---- Executor credential values, keyed by credential REF NAME ----
    // Target registrations declare which of these names their steps may
    // use. A missing value fails that step's execution fast, with no
    // secret material in the error.
    DEMO_ADMIN_TOKEN: demoSecretOptional,
    DEMO_INSPECTION_TOKEN: demoSecretOptional,
    DEMO_PROVIDER_SIGNING_SECRET: demoSecretOptional,
    /**
     * Phase 16 (ADR-0024 §20): the Demo Commerce signing secret value,
     * resolvable by REF NAME at execution time for manifest-derived
     * snapshot policies whose frozen signatureCredentialRef names it.
     * Optional: only runs whose frozen policy names the reference need
     * the value present; a missing value fails that step pre-send
     * (CredentialResolutionError — no fallback, no environment reveal).
     */
    DEMO_COMMERCE_SIGNING_SECRET: demoSecretOptional,
  })
  .refine((config) => config.WORKER_HEARTBEAT_INTERVAL_MS * 2 <= config.WORKER_LEASE_DURATION_MS, {
    message: 'WORKER_HEARTBEAT_INTERVAL_MS must be at most half of WORKER_LEASE_DURATION_MS',
    path: ['WORKER_HEARTBEAT_INTERVAL_MS'],
  });

/**
 * A Demo Fintech bearer credential (admin / inspection / provider
 * signing secret). Development-only values; never logged, never
 * persisted (AGENTS R-13).
 */
const demoSecret = z
  .string()
  .min(16, 'must be at least 16 characters')
  .max(256)
  .refine((value) => value.trim().length >= 16, 'must not be whitespace-padded');

/**
 * Demo Fintech target (apps/demo-fintech).
 * Owns ONLY its own PostgreSQL plus its own demo credentials. Must
 * never receive CONTROL_* or REDIS_* variables — the target is external
 * to RuptureGrid (ADR-0002).
 */
export const demoConfigSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  DEMO_HOST: z.string().min(1).default('127.0.0.1'),
  DEMO_PORT: tcpPort.default(3002),
  DEMO_DATABASE_URL: databaseUrl,
  /** Admin credential for target-owned reset/mode/simulator routes. */
  DEMO_ADMIN_TOKEN: demoSecret,
  /** Read-only credential for the inspection API. */
  DEMO_INSPECTION_TOKEN: demoSecret,
  /** HMAC-SHA256 secret binding provider webhooks to their payload bytes. */
  DEMO_PROVIDER_SIGNING_SECRET: demoSecret,
});

/**
 * A Demo Commerce credential (admin / checkout signing secret).
 * Development-only values; never logged, never persisted (R-13).
 */
const commerceSecret = z
  .string()
  .min(16, 'must be at least 16 characters')
  .max(256)
  .refine((value) => value.trim().length >= 16, 'must not be whitespace-padded');

/**
 * Demo Commerce target (apps/demo-commerce) — Phase 16 (ADR-0020).
 * A genuinely separate external application with its OWN PostgreSQL:
 * it must never receive CONTROL_/ REDIS_/ or DEMO_ family variables,
 * and no RuptureGrid application may ever receive COMMERCE_DATABASE_URL
 * (ADR-0002, R-05).
 *
 * Inspection credentials: NONE. The Phase 14 generic inspection
 * adapter is credential-free by contract (no Authorization header is
 * ever attached to an inspection/v1 request), so the Commerce
 * inspection surface accepts no bearer token either — read-only by
 * construction and only ever exposed by a local/authorized target.
 */
export const commerceConfigSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  COMMERCE_HOST: z.string().min(1).default('127.0.0.1'),
  COMMERCE_PORT: tcpPort.default(3003),
  COMMERCE_DATABASE_URL: databaseUrl,
  /** Admin credential for target-owned scenario/mode/fault routes. */
  COMMERCE_ADMIN_TOKEN: commerceSecret,
  /** HMAC-SHA256 secret binding checkout requests to their payload bytes. */
  DEMO_COMMERCE_SIGNING_SECRET: commerceSecret,
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type DemoConfig = z.infer<typeof demoConfigSchema>;
export type CommerceConfig = z.infer<typeof commerceConfigSchema>;

/**
 * Credential reference names the Phase 3 executor can resolve from its
 * validated environment. Target registrations may only declare refs
 * from this list (server-side allowlist, security-boundaries §7).
 */
// ---------------------------------------------------------------------
// Phase 16 (ADR-0024) — platform credential policy, frozen apart
// ---------------------------------------------------------------------
// Three DISTINCT platform-owned concepts (ADR-0024 §2); collapsing any
// two of them recreates the audited Phase 13 NB-1 blocker:
//
// A. GLOBAL EXECUTOR CAPABILITY — EXECUTOR_CREDENTIAL_REFS: the
//    credential reference names this deployment can potentially
//    resolve. This authorizes NOBODY.
// B. TARGET-ORIGIN CREDENTIAL GRANTS — the per-destination
//    authorization policy (TARGET_ORIGIN_CREDENTIAL_GRANTS on the API
//    schema below). ONLY this grants target access (ADR-0024 §4–§6).
// C. SIGNING CAPABILITY — EXECUTOR_SIGNING_CREDENTIAL_REFS: the
//    platform-owned SUBSET of A whose values may serve as ${signature}
//    HMAC keys. A classification of credentials; grants access to
//    nothing by itself. No naming heuristic ever derives it.

export const EXECUTOR_CREDENTIAL_REFS = [
  'DEMO_ADMIN_TOKEN',
  'DEMO_INSPECTION_TOKEN',
  'DEMO_PROVIDER_SIGNING_SECRET',
  'DEMO_COMMERCE_SIGNING_SECRET',
] as const;
export type ExecutorCredentialRef = (typeof EXECUTOR_CREDENTIAL_REFS)[number];

/**
 * Signing-capable credential references (ADR-0024 §2.C, §7): the
 * platform EXPLICITLY defines this set — no `contains("SIGNING")`, no
 * suffix/prefix checks, no first-credential or environment-scan
 * heuristic may ever classify a credential as signing-capable.
 * Seeded with exactly the two references whose targets require HMAC
 * signing (Demo Fintech provider webhooks; Demo Commerce checkouts).
 */
export const EXECUTOR_SIGNING_CREDENTIAL_REFS = [
  'DEMO_PROVIDER_SIGNING_SECRET',
  'DEMO_COMMERCE_SIGNING_SECRET',
] as const;
export type ExecutorSigningCredentialRef = (typeof EXECUTOR_SIGNING_CREDENTIAL_REFS)[number];

/**
 * Fails fast when the frozen platform invariant
 *   EXECUTOR_SIGNING_CREDENTIAL_REFS ⊆ EXECUTOR_CREDENTIAL_REFS
 *   (ADR-0024 §2, §18)
 * is violated. Called at module load for the shipped constants and
 * directly by platform-policy tests; a violating configuration is
 * platform misconfiguration and must refuse to start.
 */
export function assertSigningSubsetInvariant(
  executorRefs: readonly string[] = EXECUTOR_CREDENTIAL_REFS,
  signingRefs: readonly string[] = EXECUTOR_SIGNING_CREDENTIAL_REFS,
): void {
  const executorSet = new Set(executorRefs);
  const outside = signingRefs.filter((ref) => !executorSet.has(ref));
  if (outside.length > 0) {
    throw new Error(
      `invalid platform credential policy: EXECUTOR_SIGNING_CREDENTIAL_REFS must be a subset of EXECUTOR_CREDENTIAL_REFS; signing refs outside the executor set: ${outside.join(', ')} (ADR-0024 §18)`,
    );
  }
}

// Fail fast at configuration load — the shipped sets must satisfy the
// frozen invariant (ADR-0024 §18). Requests never rediscover this.
assertSigningSubsetInvariant();

/**
 * A validated target-origin credential grant entry: one normalized
 * origin authority and the credential reference NAMES authorized for
 * it. Names and origins ONLY — secret values are structurally
 * impossible here (R-13, ADR-0012, ADR-0024 §4/§17).
 */
export type TargetOriginCredentialGrants = Readonly<Record<string, readonly string[]>>;

/**
 * Validates one grant map entry (name-only, referentially closed).
 * Returns the issue list (empty = valid); bounded, secret-free.
 */
function targetOriginGrantIssues(origin: string, refs: readonly unknown[]): string[] {
  const issues: string[] = [];
  // The grant key must be an already-NORMALIZED origin authority
  // (scheme://host[:port], lowercase host, explicit port preserved —
  // the exact canonical form registration stores and the executor
  // compares). Non-normalized keys fail fast rather than being
  // silently normalized here.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    issues.push(`grant origin "${origin.slice(0, 80)}" is not a valid URL`);
    return issues;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    issues.push(`grant origin "${origin.slice(0, 80)}" must not contain userinfo`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    issues.push(`grant origin "${origin.slice(0, 80)}" must not include a path`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    issues.push(`grant origin "${origin.slice(0, 80)}" must not include query or fragment`);
  }
  const scheme = parsed.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') {
    issues.push(`grant origin "${origin.slice(0, 80)}" has unsupported scheme: ${scheme}`);
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;
  const normalized = port !== '' ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
  if (normalized !== origin) {
    issues.push(
      `grant origin "${origin.slice(0, 80)}" is not in normalized form (expected "${normalized}")`,
    );
  }
  const executorSet = new Set<string>(EXECUTOR_CREDENTIAL_REFS);
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string') {
      issues.push(`grant for "${origin.slice(0, 80)}" carries a non-string credential reference`);
      continue;
    }
    if (!executorSet.has(ref)) {
      issues.push(
        `grant for "${origin.slice(0, 80)}" names "${ref}", which is outside EXECUTOR_CREDENTIAL_REFS (stale grants fail configuration validation — ADR-0024 §18)`,
      );
    }
    if (seen.has(ref)) {
      issues.push(`grant for "${origin.slice(0, 80)}" duplicates "${ref}"`);
    }
    seen.add(ref);
  }
  return issues;
}

/**
 * Parses and validates the platform-owned target-origin credential
 * grant policy from its JSON environment encoding (TARGET_ORIGIN_
 * CREDENTIAL_GRANTS). Shape: { "<normalized origin>": ["<REF>", …] }.
 * Reference NAMES and normalized origins only; every named ref must
 * be a member of EXECUTOR_CREDENTIAL_REFS (ADR-0024 §4, §18). A
 * secret-looking VALUE is indistinguishable from an unknown ref name
 * here — both are rejected because they are outside the allowlist.
 */
export function parseTargetOriginCredentialGrants(
  raw: string | undefined,
): TargetOriginCredentialGrants {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'TARGET_ORIGIN_CREDENTIAL_GRANTS must be a JSON object mapping normalized origins to credential reference-name arrays',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'TARGET_ORIGIN_CREDENTIAL_GRANTS must be a JSON object mapping normalized origins to credential reference-name arrays',
    );
  }
  const grants: Record<string, string[]> = {};
  const issues: string[] = [];
  for (const [origin, refs] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(refs)) {
      issues.push(`grant for "${origin.slice(0, 80)}" must be an array of reference names`);
      continue;
    }
    const entryIssues = targetOriginGrantIssues(origin, refs);
    if (entryIssues.length > 0) {
      issues.push(...entryIssues);
      continue;
    }
    grants[origin] = refs as string[];
  }
  if (issues.length > 0) {
    throw new Error(
      `invalid TARGET_ORIGIN_CREDENTIAL_GRANTS platform policy:\n  - ${issues.join('\n  - ')}`,
    );
  }
  return grants;
}
