// Permanent reproduction of the independent audit's first-use race. No
// worker priming: four real initializers reach the same empty-table write
// barrier before PostgreSQL is allowed to arbitrate their unique inserts.
import { setImmediate } from 'node:timers/promises';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import { ensureInvariantDefinitions } from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import { provisionThrowawayControlDb } from './helpers/control-db-provision.js';

it('Phase 18 initialization: concurrent first-use analysis preserves all definitions', async () => {
  const fixture = await provisionThrowawayControlDb(loadTestEnv().controlDatabaseUrl);
  const db = createControlDb(fixture.databaseUrl);
  const holder = new Client({ connectionString: fixture.databaseUrl });
  const observer = new Client({ connectionString: fixture.databaseUrl });
  let pending: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await holder.connect();
    await observer.connect();
    expect(await db.prisma.invariantDefinition.count()).toBe(0);
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE "analysis"."invariant_definition" IN SHARE MODE');
    pending = Promise.allSettled(
      Array.from({ length: 4 }, () => ensureInvariantDefinitions(db.prisma)),
    );
    const deadline = Date.now() + 10_000;
    let blocked = 0;
    while (blocked !== 4) {
      const locks = await observer.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_locks
         WHERE locktype = 'relation'
           AND relation = 'analysis.invariant_definition'::regclass
           AND NOT granted AND mode = 'RowExclusiveLock'`,
      );
      blocked = locks.rows[0]?.blocked ?? 0;
      if (Date.now() >= deadline)
        throw new Error(`only ${String(blocked)} initializers at barrier`);
      await setImmediate();
    }
    expect(blocked).toBe(4);
    await holder.query('ROLLBACK');
    expect((await pending).map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const definitions = await db.prisma.invariantDefinition.findMany({
      orderBy: { invariantKey: 'asc' },
    });
    expect(definitions.map((row) => row.invariantKey)).toEqual([
      'INV-DF-1',
      'INV-DF-2',
      'INV-IZ-1',
    ]);
    await Promise.all(Array.from({ length: 4 }, () => ensureInvariantDefinitions(db.prisma)));
    expect(
      await db.prisma.invariantDefinition.findMany({ orderBy: { invariantKey: 'asc' } }),
    ).toEqual(definitions);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await pending;
    await holder.end();
    await observer.end();
    await db.disconnect();
    await fixture.close();
  }
});
