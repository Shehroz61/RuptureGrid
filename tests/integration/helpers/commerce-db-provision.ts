// =====================================================================
// Integration helper — throwaway Demo Commerce database (Phase 17)
// =====================================================================
// The golden scenarios' invariant evaluation consumes the target's
// COMPLETE declared collections (generic inspection — ADR-0022). On a
// persistent dev database, historical rows from earlier suite runs or
// manual demos honestly surface in every later run's evidence as
// foreign-scope/contested identities (ADR-0017 Decision 3: no winning
// record is guessed). CI on a fresh database gets hermetic evidence
// for free; local E2E gets the same guarantee here: ONE throwaway
// commerce database per suite run, schema = the COMMITTED migrations
// (R-12 — the migration history is the schema; no shadow copy of the
// dev database), dropped on teardown.
//
// Uses plain `pg` against the commerce instance's provisioner identity
// (the instance's superuser, like compose initdb). The RuptureGrid
// Control Plane never receives any of these credentials (ADR-0002);
// this helper is test-harness-only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export interface ProvisionedCommerceDb {
  readonly databaseUrl: string;
  readonly databaseName: string;
  close(): Promise<void>;
}

const COMMERCE_MIGRATIONS = [
  join(
    'packages',
    'commerce-db',
    'prisma',
    'migrations',
    '20261002_phase16_commerce_domain',
    'migration.sql',
  ),
  join(
    'packages',
    'commerce-db',
    'prisma',
    'migrations',
    '20261003_phase16_scoped_logical_identity',
    'migration.sql',
  ),
];

export async function provisionThrowawayCommerceDb(input: {
  readonly adminUrl: string;
  readonly password: string;
  readonly port: number;
  readonly host?: string;
}): Promise<ProvisionedCommerceDb> {
  const databaseName = `rg17_e2e_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const admin = new Pool({ connectionString: input.adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const targetUrl = `postgresql://commerce:${input.password}@${input.host ?? '127.0.0.1'}:${input.port}/${databaseName}`;
    const target = new Pool({ connectionString: targetUrl, max: 1 });
    try {
      for (const path of COMMERCE_MIGRATIONS) {
        const sql = readFileSync(path, 'utf8');
        await target.query(sql);
      }
    } catch (error) {
      await target.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
      throw error;
    }
    await target.end();
    return {
      databaseUrl: targetUrl,
      databaseName,
      async close(): Promise<void> {
        const cleanup = new Pool({ connectionString: input.adminUrl, max: 1 });
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        } finally {
          await cleanup.end().catch(() => undefined);
        }
      },
    };
  } finally {
    await admin.end().catch(() => undefined);
  }
}
