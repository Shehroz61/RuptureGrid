// Test-only isolation for fixtures with globally unique target origins.
// Apply the real committed migrations; never weaken origin authority or
// delete registrations belonging to a developer or another suite.
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

export async function provisionThrowawayControlDb(sourceUrl: string) {
  const databaseName = `rg_test_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(sourceUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  let created = false;
  const drop = async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const target = new Pool({ connectionString: databaseUrl.href, max: 1 });
    try {
      const directory = join('packages', 'control-db', 'prisma', 'migrations');
      const migrations = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const migration of migrations) {
        await target.query(await readFile(join(directory, migration, 'migration.sql'), 'utf8'));
      }
    } finally {
      await target.end();
    }
  } catch (error) {
    try {
      if (created) {
        await drop();
      }
    } finally {
      await admin.end();
    }
    throw error;
  }
  return {
    databaseUrl: databaseUrl.href,
    databaseName,
    async close() {
      try {
        await drop();
      } finally {
        await admin.end();
      }
    },
  };
}
