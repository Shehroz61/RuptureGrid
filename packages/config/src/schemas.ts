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

/** RuptureGrid worker (apps/worker). Same ownership family as the API. */
export const workerConfigSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  CONTROL_DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: queuePrefix,
});

/**
 * Demo Fintech target (apps/demo-fintech).
 * Owns ONLY its own PostgreSQL. Must never receive CONTROL_* or REDIS_*
 * variables — the target is external to RuptureGrid (ADR-0002).
 */
export const demoConfigSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  DEMO_HOST: z.string().min(1).default('127.0.0.1'),
  DEMO_PORT: tcpPort.default(3002),
  DEMO_DATABASE_URL: databaseUrl,
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type DemoConfig = z.infer<typeof demoConfigSchema>;
