// =====================================================================
// Demo Commerce — Prisma configuration
// =====================================================================
// Owned by the Demo Commerce application (Phase 16, ADR-0020). The
// target database is a SEPARATE PostgreSQL instance from RuptureGrid
// Control AND from the Demo Fintech target (ADR-0002); its credentials
// are never provided to RuptureGrid applications.

import { loadEnvironment } from '@rupturegrid/config';
import { defineConfig, env } from 'prisma/config';

loadEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('COMMERCE_DATABASE_URL'),
    // Prisma 7 requires a shadow database for `migrate dev` and for
    // migration-vs-schema diffs (R-12). Docker compose does NOT create
    // it (`pnpm db:migrate` = `migrate deploy` needs no shadow); CI
    // creates it with an explicit CREATE DATABASE, and a local
    // developer creates it once with psql (see the
    // COMMERCE_SHADOW_DATABASE_URL comment in .env.example).
    shadowDatabaseUrl: env('COMMERCE_SHADOW_DATABASE_URL'),
  },
});
