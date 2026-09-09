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
