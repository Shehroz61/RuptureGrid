// =====================================================================
// Demo Fintech — Prisma configuration
// =====================================================================
// Owned by the Demo Fintech application. The target database is a
// SEPARATE PostgreSQL instance from RuptureGrid Control (ADR-0002);
// its credentials are never provided to RuptureGrid applications.

import { loadEnvironment } from '@rupturegrid/config';
import { defineConfig, env } from 'prisma/config';

loadEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DEMO_DATABASE_URL'),
    // Prisma 7 requires a shadow database for `migrate dev` and for
    // migration-vs-schema diffs — the reviewable-migration check for
    // Phase 9 fault-control schema (R-12). Created by docker compose.
    shadowDatabaseUrl: env('DEMO_SHADOW_DATABASE_URL'),
  },
});
