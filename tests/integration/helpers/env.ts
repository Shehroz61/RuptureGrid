// =====================================================================
// Integration test helpers — environment
// =====================================================================
// Integration tests read the developer's own environment (repo-root
// .env). They never create databases or credentials themselves; the
// Docker services and their credentials come from compose.yaml/.env.

import { loadEnvironment } from '@rupturegrid/config';

export interface TestEnv {
  readonly controlDatabaseUrl: string;
  readonly demoDatabaseUrl: string;
  readonly redisUrl: string;
  readonly queuePrefix: string;
}

/**
 * Loads and returns the integration-test environment. Throws a clear
 * error if the required variables are missing so the failure is
 * actionable rather than mysterious.
 */
export function loadTestEnv(): TestEnv {
  loadEnvironment();
  const control = process.env.CONTROL_DATABASE_URL;
  const demo = process.env.DEMO_DATABASE_URL;
  const redis = process.env.REDIS_URL;
  const prefix = process.env.QUEUE_PREFIX ?? 'rupturegrid';

  const missing: string[] = [];
  if (control === undefined || control === '') missing.push('CONTROL_DATABASE_URL');
  if (demo === undefined || demo === '') missing.push('DEMO_DATABASE_URL');
  if (redis === undefined || redis === '') missing.push('REDIS_URL');
  if (missing.length > 0) {
    throw new Error(
      `Integration tests require environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and run pnpm infra:up first.',
    );
  }

  return {
    controlDatabaseUrl: control,
    demoDatabaseUrl: demo,
    redisUrl: redis,
    queuePrefix: prefix,
  };
}
