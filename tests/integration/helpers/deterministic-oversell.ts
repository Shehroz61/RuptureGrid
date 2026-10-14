// =====================================================================
// Test-only helper — deterministic vulnerable-race oversell barrier
// (Phase 17 CI repair; E3 port of the accepted phase17-cli protocol)
// =====================================================================
// The VULNERABLE target's naive check-then-act race is genuine (no
// artificial delay): two submissions oversell only if both READ the
// single remaining unit BEFORE either write transaction commits. Under
// CI/full-suite load that overlap is probabilistic (CI run 38615681588
// missed it: one ACCEPTED + one STOCK_UNAVAILABLE → honest exit 0
// where the suite requires a genuine exit-1 baseline). This barrier
// makes the overlap DETERMINISTIC at a test-controlled execution
// boundary using PostgreSQL's own lock semantics — the exact protocol
// audited in tests/integration/phase17-cli.test.ts
// (`runCliWithDeterministicOversell`, Addendum XIII), ported here so
// in-process `executeScenario` dispatches (which have no CLI child to
// wrap) get the same guarantee. The accepted CLI-suite barrier is NOT
// refactored to use this file and stays byte-untouched.
//
//   holder  — takes `FOR UPDATE` on the suite SKU row BEFORE dispatch:
//             the run's establish step queues on it.
//   waiter  — issues the SAME `FOR UPDATE` only after the establish
//             request is observed queued, so PostgreSQL grants it the
//             row lock ATOMICALLY the moment the establish transaction
//             commits (lock-queue order), i.e. before the two submit
//             requests (dispatched only after establish completes) can
//             write.
//   read    — both submissions' MVCC reads (SELECT) are never blocked
//             by the row lock: both genuinely read the stale stock.
//   write   — both write transactions queue behind the waiter until
//             the test releases it, then both commit against their own
//             stale read — the real oversell, produced by the target's
//             own vulnerable logic.
//
// Safety properties (same as the audited CLI protocol):
// test-owned scheduling only (a row lock is not a write); real target
// HTTP requests and real Commerce transactions; holder READY before
// dispatch; dedicated autocommit observer; establish queue observed
// before holder release; sequential waiter queueing; waiter release
// only after both submit writes are genuinely queued; the real 5s
// Commerce transaction timeout is respected by design (observe and
// release in milliseconds); every exit path rolls back locks, closes
// clients, and awaits dispatch; establishment failure throws loudly
// with diagnostics instead of falling back to timing luck.

import { Client as PgClient } from 'pg';
import type { PrismaClient } from '@rupturegrid/control-db';
import { expect } from 'vitest';
import { waitFor } from './execution-harness.js';
import type { CommerceClient } from './commerce-harness.js';

const BARRIER_SKU_SQL = 'SELECT "id" FROM skus WHERE "sku" = $1 FOR UPDATE';

/**
 * Commerce backends currently WAITING on this database (PostgreSQL's
 * own wait evidence), observed through a DEDICATED autocommit observer
 * — never through a connection holding the barrier lock. Counts ANY
 * wait (`wait_event IS NOT NULL`) with a Commerce-business query
 * shape, excluding the barrier's own backends by pid; idle pool
 * connections (`state <> 'active'`, e.g. Client/ClientRead with stale
 * query text) never count.
 */
async function blockedCommerceBackends(
  observer: PgClient,
  excludePids: readonly number[] = [],
): Promise<number> {
  const result = await observer.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event IS NOT NULL
        AND pid <> pg_backend_pid()
        AND (array_length($1::int[], 1) IS NULL OR NOT (pid = ANY ($1::int[])))
        AND query ILIKE ANY (ARRAY['%skus%', '%verification%', '%orders%', '%reservations%', '%commerce_settings%', '%checkout%'])`,
    [excludePids.length === 0 ? null : [...excludePids]],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Lock-only count (diagnostic companion to the any-wait detector). */
async function lockBlockedCommerceBackends(observer: PgClient): Promise<number> {
  const result = await observer.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Diagnostic snapshot of this database's client backends. */
async function commerceBackendSnapshot(observer: PgClient): Promise<string> {
  const result = await observer.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string | null;
  }>(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 200) AS query
       FROM pg_stat_activity WHERE datname = current_database() ORDER BY backend_start`,
  );
  return result.rows
    .map(
      (row) =>
        `  pid=${String(row.pid)} [${row.state ?? '?'}/${row.wait_event_type ?? '-'}:${row.wait_event ?? '-'}] ${(row.query ?? '').replace(/\s+/g, ' ')}`,
    )
    .join('\n');
}

/**
 * Seeds the suite SKU row through the target's OWN admin API when a
 * shuffled-first test runs before any establish step created it (a
 * legitimate fixture pre-step; the run's establish reset then
 * re-baselines the row in its own context).
 */
export async function ensureSuiteSkuRow(input: {
  readonly commerceDatabaseUrl: string;
  readonly commerceClient: CommerceClient;
  readonly suiteSku: string;
  readonly suiteScopeToken: string;
}): Promise<void> {
  const probe = new PgClient({ connectionString: input.commerceDatabaseUrl });
  await probe.connect();
  try {
    const existing = await probe.query('SELECT 1 FROM skus WHERE "sku" = $1', [input.suiteSku]);
    if (existing.rowCount === 0) {
      await input.commerceClient.resetScenario({
        scopeToken: input.suiteScopeToken,
        sku: input.suiteSku,
        initialAvailableUnits: 1,
        mode: 'VULNERABLE',
      });
    }
  } finally {
    await probe.end().catch(() => undefined);
  }
}

export interface DeterministicOversellInput<T> {
  /** Throwaway Commerce database URL (the barrier's holder/waiter/observer). */
  readonly commerceDatabaseUrl: string;
  /** The suite-stable SKU every rebound scenario names. */
  readonly suiteSku: string;
  /** The suite-stable scope every rebound scenario names. */
  readonly suiteScopeToken: string;
  /** Rebound scenario file path (fixture identity is verified from it). */
  readonly scenarioPath: string;
  /** Starts the run; invoked only after the holder reports READY. */
  readonly dispatch: () => Promise<T>;
  /** Real target process logs for failure diagnostics (optional). */
  readonly appLogs?: () => { stdout: string; stderr: string };
}

/**
 * Runs `dispatch` with the deterministic oversell barrier armed around
 * the run's establish→submit sequence. Returns dispatch's own result;
 * every durable effect stays the target's own. Throws a loud
 * fixture-setup error (never a business assertion) when the barrier
 * cannot establish genuine overlap.
 */
export async function runWithDeterministicOversell<T>(
  input: DeterministicOversellInput<T>,
): Promise<T> {
  const holder = new PgClient({ connectionString: input.commerceDatabaseUrl });
  const waiter = new PgClient({ connectionString: input.commerceDatabaseUrl });
  const observer = new PgClient({ connectionString: input.commerceDatabaseUrl });
  await Promise.all([holder.connect(), waiter.connect(), observer.connect()]);
  const pidOf = async (client: PgClient): Promise<number> => {
    const row = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return Number(row.rows[0]?.pid ?? 0);
  };
  const holderPid = await pidOf(holder);
  const waiterPid = await pidOf(waiter);
  const observerPid = await pidOf(observer);
  const barrierPids = [holderPid, waiterPid, observerPid].filter((pid) => pid !== 0);
  // 1. Fixture/target identity verified BEFORE the barrier exists: the
  //    rebound scenario must name exactly this suite's scope and SKU.
  //    A mismatch fails fast — never a silent fallback.
  const { readFile } = await import('node:fs/promises');
  const scenarioRaw = await readFile(input.scenarioPath, 'utf8').catch(() => '<unreadable>');
  if (scenarioRaw !== '<unreadable>') {
    const parsed = JSON.parse(scenarioRaw) as Record<string, unknown>;
    const steps = (parsed['experiment'] as Record<string, unknown>)['steps'] as Array<
      Record<string, unknown>
    >;
    const establish = steps.find((step) => step['name'] === 'establish-scenario');
    const body = JSON.parse(
      ((establish?.['action'] as Record<string, unknown>)?.['body'] as string) ?? '{}',
    ) as Record<string, unknown>;
    if (body['sku'] !== input.suiteSku || body['scopeToken'] !== input.suiteScopeToken) {
      throw new Error(
        `deterministic-oversell barrier setup failed: fixture identity mismatch (scenario sku=${String(body['sku'])} scope=${String(body['scopeToken'])} vs suite sku=${input.suiteSku} scope=${input.suiteScopeToken})`,
      );
    }
  }
  let armed: Promise<void> | null = null;
  let dispatchPromise: Promise<T> | null = null;
  let maxBlocked = 0;
  let maxLockBlocked = 0;
  const barrierCreatedAt = Date.now();
  await holder.query('BEGIN');
  await holder.query(BARRIER_SKU_SQL, [input.suiteSku]);
  // 2-3. READY: the row lock is held — only now is the run dispatched.
  const holderLockedAt = Date.now();
  try {
    dispatchPromise = input.dispatch();
    // 4-5. The run's establish step queues on the barrier row. The
    //      dedicated observer counts ANY Commerce-business wait every
    //      20ms, so a blocked establish is observed in milliseconds and
    //      released long before the target's 5s transaction timeout.
    //      The 90s window is a busy-machine dispatch margin, never a
    //      fallback: observe the real queue or fail honestly.
    const armedFrom = Date.now();
    for (;;) {
      const blocked = await blockedCommerceBackends(observer, barrierPids);
      const lockBlocked = await lockBlockedCommerceBackends(observer).catch(() => 0);
      if (blocked > maxBlocked) {
        maxBlocked = blocked;
      }
      if (lockBlocked > maxLockBlocked) {
        maxLockBlocked = lockBlocked;
      }
      if (blocked >= 1) {
        break;
      }
      if (Date.now() - armedFrom > 90_000) {
        throw new Error(
          'deterministic-oversell barrier setup failed (phase 1): the establish step never queued on the barrier row',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 6-7. Release the holder FIRST, then queue the waiter
    //      SEQUENTIALLY (never concurrently: a concurrent FOR UPDATE
    //      can acquire ahead of the blocked multi-statement establish
    //      transaction). Either the waiter queues behind the still
    //      running establish (correct FIFO) or it takes the free lock
    //      within milliseconds while the submits still need the worker
    //      chain (~100ms+) before their first write.
    await holder.query('ROLLBACK');
    armed = (async () => {
      await waiter.query('BEGIN');
      await waiter.query(BARRIER_SKU_SQL, [input.suiteSku]);
    })();
    await armed;
    // 8. Both submissions read the stale stock, then queue behind the
    //    waiter. Release ONLY after the required overlap (two queued
    //    writes) is actually established.
    await waitFor(
      async () => {
        const blocked = await blockedCommerceBackends(observer, barrierPids);
        const lockBlocked = await lockBlockedCommerceBackends(observer).catch(() => 0);
        if (blocked > maxBlocked) {
          maxBlocked = blocked;
        }
        if (lockBlocked > maxLockBlocked) {
          maxLockBlocked = lockBlocked;
        }
        return blocked >= 2 ? true : null;
      },
      90_000,
      20,
    ).catch(async () => {
      const snapshot = await commerceBackendSnapshot(observer).catch(() => '<unavailable>');
      throw new Error(
        `deterministic-oversell barrier setup failed (phase 2): the two concurrent submissions never queued behind the barrier\nbackends:\n${snapshot}`,
      );
    });
    // 9. Release: both transactions commit against their own stale read.
    await waiter.query('ROLLBACK');
    return await dispatchPromise;
  } catch (error) {
    await holder.query('ROLLBACK').catch(() => undefined);
    await waiter.query('ROLLBACK').catch(() => undefined);
    await armed?.catch(() => undefined);
    const finished = dispatchPromise === null ? null : await dispatchPromise.catch(() => null);
    const snapshot = await commerceBackendSnapshot(observer).catch(() => '<unavailable>');
    const skus = await observer
      .query('SELECT "sku", "scopeId" FROM skus ORDER BY "sku"')
      .then((result) => JSON.stringify(result.rows))
      .catch((queryError: unknown) =>
        queryError instanceof Error ? queryError.message : String(queryError),
      );
    const logs = input.appLogs?.() ?? { stdout: '', stderr: '' };
    throw new Error(
      `the deterministic-oversell barrier failed: ${
        error instanceof Error ? error.message : String(error)
      }\nmaxBlockedObserved=${String(maxBlocked)} maxLockBlockedObserved=${String(maxLockBlocked)}\nelapsedMs=${String(Date.now() - barrierCreatedAt)} holderLockedMs=${String(holderLockedAt - barrierCreatedAt)}\nholderPid=${String(holderPid)} waiterPid=${String(waiterPid)} observerPid=${String(observerPid)}\nsuiteSku=${input.suiteSku}\nsuiteScopeToken=${input.suiteScopeToken}\nskus=${skus}\napp stderr:\n${logs.stderr.slice(-2000)}\napp stdout:\n${logs.stdout.slice(-3000)}\nbackends:\n${snapshot}${finished === null ? '' : `\ndispatch settled while barrier failed (result omitted)`}`,
      { cause: error },
    );
  } finally {
    await holder.end().catch(() => undefined);
    await waiter.end().catch(() => undefined);
    await observer.end().catch(() => undefined);
  }
}

interface TargetOrderRow {
  readonly orderId: string;
  readonly checkoutIntentId: string;
  readonly status: string;
}

interface TargetReservationRow {
  readonly reservationId: string;
  readonly sku: string;
  readonly reservedUnits: number;
  readonly status: string;
}

interface TargetRemainingRow {
  readonly sku: string;
  readonly remainingAvailableUnits: number;
}

interface TargetRequestAttemptRow {
  readonly requestAttemptId: string;
  readonly checkoutIntentId: string;
}

interface TargetProcessingAttemptRow {
  readonly requestAttemptId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Asserts the genuine-oversell business truth of one barrier-driven
 * VULNERABLE run from DURABLE Control-Plane rows plus the target's
 * read-only inspection surface: exactly two physical submit attempts
 * (repeat 2 / concurrency 2 / retry NONE — never a retry), two
 * ACCEPTED orders and reservations for the run's OWN intent/SKU,
 * remaining stock −1, and genuine overlap from target-persisted
 * timestamps. Every run resets the suite scope first, so the target
 * holds exactly this run's business rows.
 */
export async function expectDeterministicOversellTruth(input: {
  readonly prisma: PrismaClient;
  readonly commerceClient: CommerceClient;
  readonly runId: string;
  readonly ownIntent: string;
  readonly ownSku: string;
}): Promise<void> {
  const steps = await input.prisma.experimentStepRun.findMany({
    where: { runId: input.runId },
    orderBy: { sequence: 'asc' },
  });
  const submit = steps.find((step) => step.name === 'checkout-submit');
  expect(submit).toBeDefined();
  const submitId = (submit?.id ?? '') as string;
  expect(submit?.state).toBe('SUCCEEDED');
  expect(submit?.attemptCount).toBe(2);
  expect(await input.prisma.stepInvocation.count({ where: { stepRunId: submitId } })).toBe(2);

  const orders = await input.commerceClient.inspection<TargetOrderRow>('/inspection/orders');
  const ownOrders = orders.filter(
    (order) => order.checkoutIntentId === input.ownIntent && order.status === 'ACCEPTED',
  );
  expect(ownOrders).toHaveLength(2);
  expect(new Set(ownOrders.map((order) => order.orderId)).size).toBe(2);

  const reservations = await input.commerceClient.inspection<TargetReservationRow>(
    '/inspection/reservations',
  );
  const ownReservations = reservations.filter(
    (reservation) => reservation.sku === input.ownSku && reservation.status === 'ACCEPTED',
  );
  expect(ownReservations).toHaveLength(2);
  for (const reservation of ownReservations) {
    expect(reservation.reservedUnits).toBe(1);
  }

  const remaining = await input.commerceClient.inspection<TargetRemainingRow>(
    '/inspection/sku-remaining',
  );
  expect(remaining.find((row) => row.sku === input.ownSku)?.remainingAvailableUnits).toBe(-1);

  const requestAttempts = await input.commerceClient.inspection<TargetRequestAttemptRow>(
    '/inspection/request-attempts',
  );
  const ownRequestIds = new Set(
    requestAttempts
      .filter((attempt) => attempt.checkoutIntentId === input.ownIntent)
      .map((attempt) => attempt.requestAttemptId),
  );
  expect(ownRequestIds.size).toBe(2);
  const processingAttempts = (
    await input.commerceClient.inspection<TargetProcessingAttemptRow>(
      '/inspection/processing-attempts',
    )
  ).filter((attempt) => ownRequestIds.has(attempt.requestAttemptId));
  expect(processingAttempts).toHaveLength(2);
  const [a, b] = [...processingAttempts].sort((x, y) =>
    x.requestAttemptId < y.requestAttemptId ? -1 : 1,
  );
  if (a === undefined || b === undefined) {
    throw new Error('expected two processing attempts');
  }
  expect(a.requestAttemptId).not.toBe(b.requestAttemptId);
  expect(new Date(a.startedAt).getTime()).toBeLessThan(new Date(b.finishedAt).getTime());
  expect(new Date(b.startedAt).getTime()).toBeLessThan(new Date(a.finishedAt).getTime());
}
