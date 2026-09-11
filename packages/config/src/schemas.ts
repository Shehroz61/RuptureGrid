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

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type DemoConfig = z.infer<typeof demoConfigSchema>;

/**
 * Credential reference names the Phase 3 executor can resolve from its
 * validated environment. Target registrations may only declare refs
 * from this list (server-side allowlist, security-boundaries §7).
 */
export const EXECUTOR_CREDENTIAL_REFS = [
  'DEMO_ADMIN_TOKEN',
  'DEMO_INSPECTION_TOKEN',
  'DEMO_PROVIDER_SIGNING_SECRET',
] as const;
export type ExecutorCredentialRef = (typeof EXECUTOR_CREDENTIAL_REFS)[number];
