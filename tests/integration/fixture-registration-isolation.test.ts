// Real PostgreSQL acceptance tests for fixture ownership. The normalized
// origin remains the production authorization principal; these runtime
// objects only determine which test may reuse a successfully created ID.
import { setImmediate } from 'node:timers/promises';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
  TargetRegistrationError,
  registerTarget,
} from '@rupturegrid/engine';
import type { RegisterTargetInput } from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';

const fixtures = new Set<OwnedControlFixture>();
const input: RegisterTargetInput = {
  displayName: 'owned-fixture-target',
  environment: 'LOCAL_DEVELOPMENT',
  contractKind: 'GENERIC_HTTP',
  origins: ['https://fixture.invalid'],
};

async function owner() {
  const fixture = await createOwnedControlFixture(loadTestEnv());
  fixtures.add(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all([...fixtures].map((fixture) => fixture.close()));
  fixtures.clear();
});

describe('fixture registration ownership on real PostgreSQL', () => {
  it('concurrent same-owner acquisitions share one real writer and one registration', async () => {
    const fixture = await owner();
    const holder = new Client({ connectionString: fixture.env.controlDatabaseUrl });
    const observer = new Client({ connectionString: fixture.env.controlDatabaseUrl });
    let pending: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await holder.connect();
      await observer.connect();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "control"."target_registration" IN SHARE MODE');
      const acquisitions = Array.from({ length: 8 }, () =>
        fixture.acquireTarget('workload', input),
      );
      pending = Promise.allSettled(acquisitions);
      const deadline = Date.now() + 10_000;
      let blocked = 0;
      while (blocked !== 1) {
        const locks = await observer.query<{ blocked: number }>(
          `SELECT count(*)::int AS blocked FROM pg_locks
           WHERE locktype = 'relation'
             AND relation = 'control.target_registration'::regclass
             AND NOT granted AND mode = 'RowExclusiveLock'`,
        );
        blocked = locks.rows[0]?.blocked ?? 0;
        if (Date.now() >= deadline) throw new Error(`registration writers at barrier: ${blocked}`);
        await setImmediate();
      }
      expect(blocked).toBe(1);
      expect(await fixture.prisma.targetRegistration.count()).toBe(0);
      await holder.query('ROLLBACK');
      const registered = await Promise.all(acquisitions);
      expect(new Set(registered.map((result) => result.targetId)).size).toBe(1);
      expect(await fixture.prisma.targetRegistration.count()).toBe(1);
      expect(await fixture.prisma.targetOrigin.count()).toBe(1);
      // Returned data cannot mutate the runtime's ownership receipt.
      (registered[0] as { displayName: string }).displayName = 'caller-mutation';
      expect((await fixture.acquireTarget('workload', input)).displayName).toBe(input.displayName);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await pending;
      await holder.end();
      await observer.end();
    }
  });

  it('same owner reuses the exact ID across normalized-origin spellings', async () => {
    const fixture = await owner();
    const first = await fixture.acquireTarget('workload', input);
    const again = await fixture.acquireTarget('workload', {
      ...input,
      origins: ['https://FIXTURE.invalid:443/'],
    });
    expect(again.targetId).toBe(first.targetId);
    expect(again.origins).toEqual(['https://fixture.invalid']);
    expect(await fixture.prisma.targetRegistration.count()).toBe(1);
  });

  it.each([
    ['origin', { ...input, origins: ['https://another.invalid'] }],
    ['environment', { ...input, environment: 'STAGING' as const }],
    ['credential references', { ...input, credentialRefs: ['DEMO_ADMIN_TOKEN'] }],
  ])('refuses a different %s on an already acquired owner/key', async (_label, changed) => {
    const fixture = await owner();
    const first = await fixture.acquireTarget('workload', input);
    const row = await fixture.prisma.targetRegistration.findUniqueOrThrow({
      where: { id: first.targetId },
      include: { origins: true },
    });
    await expect(fixture.acquireTarget('workload', changed)).rejects.toThrow(
      'different registration authority',
    );
    expect(
      await fixture.prisma.targetRegistration.findUniqueOrThrow({
        where: { id: first.targetId },
        include: { origins: true },
      }),
    ).toEqual(row);
  });

  it('refuses a changed platform grant policy on an already acquired owner/key', async () => {
    const fixture = await owner();
    await fixture.acquireTarget('workload', input);
    await expect(
      fixture.acquireTarget('workload', input, {
        ...DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
        originGrants: { 'https://fixture.invalid': ['DEMO_ADMIN_TOKEN'] },
      }),
    ).rejects.toThrow('different registration authority');
    expect(await fixture.prisma.targetRegistration.count()).toBe(1);
  });

  it('another key cannot adopt the owned origin, even with identical metadata', async () => {
    const fixture = await owner();
    const first = await fixture.acquireTarget('workload', input);
    const attempts = await Promise.allSettled([
      fixture.acquireTarget('foreign', input),
      fixture.acquireTarget('foreign', input),
    ]);
    expect(attempts.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of attempts) {
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(TargetRegistrationError);
    }
    expect(await fixture.prisma.targetRegistration.count()).toBe(1);
    expect((await fixture.acquireTarget('workload', input)).targetId).toBe(first.targetId);
  });

  it('an existing foreign registration remains untouched and acquisition stays rejected', async () => {
    const fixture = await owner();
    const foreign = await registerTarget(fixture.prisma, input);
    const row = await fixture.prisma.targetRegistration.findUniqueOrThrow({
      where: { id: foreign.targetId },
      include: { origins: true },
    });
    const first = fixture.acquireTarget('workload', input);
    await expect(first).rejects.toBeInstanceOf(TargetRegistrationError);
    const again = fixture.acquireTarget('workload', input);
    await expect(again).rejects.toBeInstanceOf(TargetRegistrationError);
    expect(await again.catch((error: unknown) => error)).toBe(
      await first.catch((error: unknown) => error),
    );
    expect(await fixture.prisma.targetRegistration.count()).toBe(1);
    expect(await fixture.prisma.experimentRun.count()).toBe(0);
    expect(
      await fixture.prisma.targetRegistration.findUniqueOrThrow({
        where: { id: foreign.targetId },
        include: { origins: true },
      }),
    ).toEqual(row);
  });

  it('refuses altered owned metadata without repairing or replacing it', async () => {
    const fixture = await owner();
    const first = await fixture.acquireTarget('workload', input);
    // Deliberately corrupt this isolated Control fixture, never target business state.
    const changed = await fixture.prisma.targetRegistration.update({
      where: { id: first.targetId },
      data: { displayName: 'changed-outside-owner' },
    });
    await expect(fixture.acquireTarget('workload', input)).rejects.toThrow(
      'registration changed after acquisition',
    );
    expect(
      await fixture.prisma.targetRegistration.findUniqueOrThrow({ where: { id: first.targetId } }),
    ).toEqual(changed);
    expect(await fixture.prisma.targetRegistration.count()).toBe(1);
  });

  it('cleanup of one owner leaves another same-origin owner and the source environment intact', async () => {
    const source = loadTestEnv();
    const left = await owner();
    const right = await owner();
    const [a, b] = await Promise.all([
      left.acquireTarget('workload', input),
      right.acquireTarget('workload', input),
    ]);
    expect(a.targetId).not.toBe(b.targetId);
    expect(left.env.queuePrefix).not.toBe(right.env.queuePrefix);
    expect(left.env.controlDatabaseUrl === source.controlDatabaseUrl).toBe(false);
    expect(right.env.controlDatabaseUrl === source.controlDatabaseUrl).toBe(false);
    await Promise.all([left.close(), left.close()]);
    await expect(left.acquireTarget('workload', input)).rejects.toThrow('fixture is closed');
    expect((await right.acquireTarget('workload', input)).targetId).toBe(b.targetId);
    expect(await right.prisma.targetRegistration.count()).toBe(1);
    const databases = await right.prisma.$queryRaw<Array<{ datname: string }>>`
      SELECT datname FROM pg_database WHERE datname IN (${left.databaseName}, ${right.databaseName})
    `;
    expect(databases.map((row) => row.datname)).toEqual([right.databaseName]);
    expect(loadTestEnv().controlDatabaseUrl === source.controlDatabaseUrl).toBe(true);
    expect(loadTestEnv().queuePrefix).toBe(source.queuePrefix);
  });
});
