// =====================================================================
// RuptureGrid v1.0 — environment loading and validation
// =====================================================================
// Configuration is environment-driven and validated at process startup.
// Applications never scatter direct process.env lookups (AGENTS R-15,
// engineering-rules §6).
//
// Ownership model (ADR-0002): each application schema declares exactly
// the environment variables that application owns. The validated config
// object therefore contains ONLY the owning application's variables —
// foreign-family credentials (e.g. DEMO_DATABASE_URL inside the API
// process) can never reach application code, even though a shared
// development .env legitimately documents all families. Variable names
// are distinct per family by design; there is no generic DATABASE_URL.

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

/**
 * Raised when environment configuration is missing or invalid.
 * The message lists every issue so startup fails fast and clearly.
 */
export class ConfigValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Environment variable families RuptureGrid owns. Everything else in
 * the process environment (PATH, system variables, …) is ignored.
 */ const RUPTUREGRID_ENV_PREFIX = /^(CONTROL_|DEMO_|REDIS_|QUEUE_|API_|LOG_|NODE_ENV|CORS_)/;

/** Returns only the RuptureGrid-owned variables from an environment. */
export function pickRuptureGridEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && RUPTUREGRID_ENV_PREFIX.test(key)) {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * Loads the repository-root `.env` file (if present) into the process
 * environment. Real environment variables always win over the file
 * (dotenv default). Walks up from the process working directory so the
 * same code works no matter which package directory a command runs in.
 */
export function loadEnvironment(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  if (error.issues.length > 0) {
    return error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
  }
  return [error.message];
}

/**
 * Validates an environment object against a per-app schema and returns
 * the typed config. The schema declares exactly the variables that
 * application owns; everything else is stripped, so the returned
 * config object never carries another family's credentials.
 */
export function loadConfig<T>(
  schema: z.ZodType<T>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const picked = pickRuptureGridEnv(env);
  const result = schema.safeParse(picked);
  if (!result.success) {
    throw new ConfigValidationError(formatZodIssues(result.error));
  }
  return result.data;
}
