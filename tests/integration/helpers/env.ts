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
  /** Demo-target credentials (Phase 2 suites). */
  readonly demoAdminToken: string;
  readonly demoInspectionToken: string;
  readonly demoProviderSigningSecret: string;
}

function requireValue(name: string, missing: string[]): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    missing.push(name);
    return '';
  }
  return value;
}

/**
 * Explicit Redis outage-control target for CI (portability repair).
 * GitHub Actions exports the CURRENT JOB's Redis service container ID
 * via ${{ job.services.redis.id }} (official job-context semantics);
 * the outage tests then control exactly that container and never any
 * other. Absent (local development), the shared redis-outage helper
 * resolves the repo's own compose project redis container by label.
 * Returns null when unset/empty so "explicit mode" is unambiguous.
 */
export function getTestRedisContainerId(): string | null {
  const value = process.env.RUPTUREGRID_TEST_REDIS_CONTAINER_ID;
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/**
 * Loads and returns the integration-test environment. Throws a clear
 * error if the required variables are missing so the failure is
 * actionable rather than mysterious.
 */
export function loadTestEnv(): TestEnv {
  loadEnvironment();
  const missing: string[] = [];
  const controlDatabaseUrl = requireValue('CONTROL_DATABASE_URL', missing);
  const demoDatabaseUrl = requireValue('DEMO_DATABASE_URL', missing);
  const redisUrl = requireValue('REDIS_URL', missing);
  const demoAdminToken = requireValue('DEMO_ADMIN_TOKEN', missing);
  const demoInspectionToken = requireValue('DEMO_INSPECTION_TOKEN', missing);
  const demoProviderSigningSecret = requireValue('DEMO_PROVIDER_SIGNING_SECRET', missing);
  const queuePrefix = process.env.QUEUE_PREFIX ?? 'rupturegrid';

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and run pnpm infra:up first.',
    );
  }

  return {
    controlDatabaseUrl,
    demoDatabaseUrl,
    redisUrl,
    queuePrefix,
    demoAdminToken,
    demoInspectionToken,
    demoProviderSigningSecret,
  };
}
