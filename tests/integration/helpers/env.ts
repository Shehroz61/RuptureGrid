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
  /** Demo Commerce target (Phase 16 suites). */
  readonly commerceDatabaseUrl: string;
  readonly commerceAdminToken: string;
  readonly commerceSigningSecret: string;
  /**
   * The commerce instance's provisioner password (compose initdb
   * identity). Test-harness-only: used by the Phase 17 E2E to create
   * a throwaway commerce database per suite run. Never a RuptureGrid
   * Control-Plane credential (ADR-0002/R-05 — the platform never
   * receives it).
   */
  readonly commercePostgresPassword: string;
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
  // Phase 16: the Demo Commerce family is NEW — a developer's existing
  // .env predates it. The harness therefore uses the DOCUMENTED
  // compose/.env.example development defaults explicitly when the
  // variables are absent (clearly non-production demo values, identical
  // to the committed template; CI copies .env.example verbatim, so the
  // same values arrive through the environment there). No secret is
  // invented, and nothing is silently guessed: these are the documented
  // local defaults.
  const commerceDatabaseUrl =
    process.env.COMMERCE_DATABASE_URL ??
    'postgresql://commerce:commerce_dev_password@127.0.0.1:5445/demo_commerce';
  const commerceAdminToken = process.env.COMMERCE_ADMIN_TOKEN ?? 'commerce-admin-dev-token-0001';
  const commerceSigningSecret =
    process.env.DEMO_COMMERCE_SIGNING_SECRET ?? 'demo-commerce-signing-secret-0001';
  // The instance provisioner password (compose initdb identity) for the
  // Phase 17 throwaway-database helper — same documented dev default.
  const commercePostgresPassword =
    process.env.COMMERCE_POSTGRES_PASSWORD ?? 'commerce_dev_password';
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
    commerceDatabaseUrl,
    commerceAdminToken,
    commerceSigningSecret,
    commercePostgresPassword,
  };
}
