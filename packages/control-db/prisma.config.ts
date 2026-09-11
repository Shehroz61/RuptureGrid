// =====================================================================
// RuptureGrid Control — Prisma configuration
// =====================================================================
// The connection URL comes from the environment (CONTROL_DATABASE_URL),
// loaded from the repository-root .env by the config package.
// RuptureGrid PostgreSQL owns the control/evidence/analysis schemas;
// the Demo Fintech database is a SEPARATE instance (ADR-0002).

import { loadEnvironment } from '@rupturegrid/config';
import { defineConfig, env } from 'prisma/config';

loadEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('CONTROL_DATABASE_URL'),
    // Prisma 7 requires a shadow database for `migrate dev` and for
    // `migrate diff --from-migrations` (migration verification).
    // RuptureGrid PostgreSQL owns it; created alongside the main DB.
    shadowDatabaseUrl: env('CONTROL_SHADOW_DATABASE_URL'),
  },
});
