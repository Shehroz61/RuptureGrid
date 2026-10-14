// =====================================================================
// Integration — Phase 17 Checkpoint B1: provenance revision `P`
// =====================================================================
// The composite truth-input watermark `W = (C, P, D)` (ADR-0026 §13),
// `P` only. REAL PostgreSQL throughout (R-08): every case inspects the
// durable `control.run_truth_input_head` row together with the actual
// business row state, and locking is proven by REAL PostgreSQL
// advisory-lock contention observed through controlled barriers — never
// by mocks, never by timing-sleep heuristics.
//
// The invariant under test (ADR-0026 §13 writer protocol):
//   for every truth-bearing non-chain write of a run, in ONE PostgreSQL
//   transaction — per-run advisory lock FIRST, the write, then
//   `provenanceRevision = provenanceRevision + 1`, then commit.
// Therefore: a committed write always advanced `P` by exactly 1, a
// rolled-back or rejected write advanced it by 0, and never by 2.
//
// Deliberately NOT here (later checkpoints): derivation generation `D`
// (B2 — asserted to remain 0: the column exists, no writer advances it),
// the eligibility selector/proof publication (C), report authorization
// (D), and the adversarial E2E plus full-suite verification (E/F).
//
// The API cases drive the REAL working-tree `ExecutionController`
// (`apps/api/src/execution/execution.controller.ts`, Nest decorators
// loaded through the api package's own `reflect-metadata`), so the
// platform's real cancellation/dispatch mutations are exercised — not a
// re-implementation of them. The enqueue is pointed at a PRIVATE queue
// prefix so no shared worker consumes a leftover probe job.

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import {
  DEFAULT_RUN_LOCK_TIMEOUT_MS,
  LeaseLostError,
  acquireRunLock,
  advanceProvenanceRevision,
  claimStep,
  createExperiment,
  createRun,
  heartbeatStep,
  markExecuting,
  markRunDispatching,
  readTruthInputHead,
  recordInvocation,
  recordStaleWriter,
  registerTarget,
  resolveRunIdOfStep,
  resolveExpiredLease,
  settleCancelledRun,
  settleRuns,
  writeTerminalState,
} from '@rupturegrid/engine';
import type { FencingContext, RunLockedTx } from '@rupturegrid/engine';
import { RawObservationStore, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import {
  getControlPrisma,
  testTargetOriginCredentialPolicy,
  uniqueName,
  uniqueTestOrigin,
} from './helpers/execution-harness.js';
import { loadTestEnv } from './helpers/env.js';

const prisma = getControlPrisma();
const store = new RawObservationStore(prisma);
const LEASE_MS = 30_000;
/** A drain bound well above any realistic shared-dev-DB backlog. */
const SETTLEMENT_DRAIN_LIMIT = 1000;

/**
 * Every run this suite creates. The suite deliberately leaves runs
 * MID-FLIGHT (CLAIMED / EXECUTING / DISPATCHED) to prove the writer
 * protocol, and a finished-but-unsettled run is exactly what the
 * reconciler's settlement sweep is supposed to close. Because that sweep
 * is a BOUNDED batch over the SHARED dev database, the suite drains what
 * it leaves behind (see the `afterAll` below) rather than handing a later
 * suite a settlement backlog it never asked for.
 */
const createdRunIds: string[] = [];

/** The run's durable `P`. Missing head row ⇒ 0n (the frozen default). */
async function readP(runId: string): Promise<bigint> {
  return (await readTruthInputHead(prisma, runId)).provenanceRevision;
}

/** The run's durable `D` — asserted 0 everywhere in B1 (no B2 writer). */
async function readD(runId: string): Promise<bigint> {
  return (await readTruthInputHead(prisma, runId)).derivationGeneration;
}

interface StepHarness {
  readonly runId: string;
  readonly stepRunIds: readonly string[];
}

/** Registers one target + experiment + run (real engine path). */
async function makeRun(
  stepCount: number,
  action: Record<string, unknown> = MUTATING_ACTION,
  namePrefix = 'b1-prov',
): Promise<StepHarness> {
  const target = await registerTarget(prisma, {
    displayName: uniqueName(`${namePrefix}-target`),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [await uniqueTestOrigin(prisma)],
    contractKind: 'GENERIC_HTTP',
  });
  const experiment = await createExperiment(prisma, {
    name: uniqueName(`${namePrefix}-experiment`),
    targetId: target.targetId,
    document: {
      steps: Array.from({ length: stepCount }, (_, index) => ({
        name: `step-${index}`,
        action: { ...action },
      })),
    },
  });
  const run = await createRun(prisma, experiment.revisionId);
  createdRunIds.push(run.runId);
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

const MUTATING_ACTION: Record<string, unknown> = {
  method: 'POST',
  relativePath: '/counter/increment',
  body: '{}',
  mutation: 'MUTATING',
  contract: 'GENERIC_HTTP',
};

/** Claims a step as an isolated test worker generation (P advances). */
async function claimAs(
  stepRunId: string,
  owner: string,
  leaseDurationMs: number = LEASE_MS,
): Promise<FencingContext> {
  const claim = await claimStep(prisma, stepRunId, { ownerId: owner, leaseDurationMs });
  if (claim === null) {
    throw new Error(`test pre-condition failed: ${stepRunId} was not claimable by ${owner}`);
  }
  return { ownerId: owner, fencingToken: claim.fencingToken };
}

/** A truthful post-send invocation record (the executor's own shape). */
function invocationRecord(
  knowledge: 'KNOWN_ABSENT' | 'INDETERMINATE' | 'KNOWN_OCCURRED' | 'NOT_APPLICABLE',
  sequence = 1,
  stage: 'CONNECTING' | 'REQUEST_SENT' = 'REQUEST_SENT',
): Parameters<typeof recordInvocation>[2] {
  return {
    sequence,
    waveIndex: 0,
    invocationIdentity: randomUUID(),
    transportStage: stage,
    httpStatus: stage === 'REQUEST_SENT' ? 200 : null,
    requestBytes: 12,
    responseBytes: stage === 'REQUEST_SENT' ? 24 : 0,
    responseBody: null,
    durationMs: 7,
    outcome: knowledge === 'KNOWN_ABSENT' ? 'FAILED' : 'SUCCEEDED',
    sideEffectKnowledge: knowledge,
    error: null,
  };
}

/** Bounded poll on the REAL database lease expiry condition. */
async function waitForLeaseExpiry(stepRunId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = (await prisma.$queryRaw`
      SELECT (now() >= "leaseExpiresAt") AS expired
        FROM "control"."experiment_step_run"
       WHERE "id" = ${stepRunId}::uuid
    `) as Array<{ expired: boolean }>;
    if (rows[0]?.expired === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('lease did not expire in the database within 10s');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------
// Controlled barriers (never timing sleeps): a real interactive
// transaction holds the run's advisory lock until the test releases it.
// ---------------------------------------------------------------------

class Barrier {
  private released = false;
  private readonly gate: Promise<void>;
  private open!: () => void;

  public constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.open = () => {
        this.released = true;
        resolve();
      };
    });
  }

  public wait(): Promise<void> {
    return this.gate;
  }

  public release(): void {
    if (!this.released) {
      this.open();
    }
  }
}

/**
 * Holds `runId`'s per-run advisory lock inside a REAL interactive
 * transaction. `held` resolves only after the lock is demonstrably
 * acquired, so a contender started afterwards is contending for a lock
 * that is provably held — no sleeps.
 */
async function holdRunLock(
  runId: string,
  /**
   * Runs INSIDE the holder's transaction after the barrier is released
   * (the holder's own truth-bearing write, if any), so a test can prove
   * that only the lock owner committed.
   */
  onRelease?: (tx: RunLockedTx) => Promise<void>,
): Promise<{ release: () => void; held: Promise<void>; done: Promise<void> }> {
  const barrier = new Barrier();
  let signal!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      await acquireRunLock(tx, runId);
      signal();
      await barrier.wait();
      if (onRelease !== undefined) {
        await onRelease(tx);
      }
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
  await acquired;
  return { release: () => barrier.release(), held: acquired, done };
}

/** The EXACT lock statement the chain-append primitive executes (see
 * `packages/evidence/src/raw-observation-store.ts` line 279) — used to
 * prove the two protocols serialize on the same per-run lock key. */
async function probeLockWithTimeout(
  runId: string,
  lockTimeoutMs: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await prisma.$transaction(async (tx) => {
      await acquireRunLock(tx, runId, lockTimeoutMs);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Bounded wait for a REAL, not-yet-granted advisory-lock wait on this
 * run's key, observed in `pg_locks`. `pg_advisory_xact_lock(hashtext
 * (runId::text))` is keyed on the sign-extended 32-bit hash: PostgreSQL
 * stores it as classid = high 32 bits, objid = low 32 bits, objsubid 1.
 * Seeing a waiting lock with that exact key proves the claimer is
 * BLOCKED IN POSTGRESQL on the same run — not merely "pending in JS".
 */
async function waitForRunLockWait(runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = (await prisma.$queryRaw`
      WITH key AS (SELECT hashtext(${runId}::text)::bigint AS k)
      SELECT count(*)::int AS waiting
        FROM pg_locks l, key
       WHERE l.locktype = 'advisory'
         AND NOT l.granted
         AND l.objsubid = 1
         AND l.classid = ((key.k >> 32) & 4294967295)::oid
         AND l.objid = (key.k & 4294967295)::oid
    `) as Array<{ waiting: number }>;
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('no advisory-lock wait on the run key appeared within 10s');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------
// The real API controller (working-tree source, api package's own
// reflect-metadata). Structural surface only: the test asserts durable
// effects, not Nest internals.
// ---------------------------------------------------------------------

interface ApiControllerLike {
  createRunEndpoint(body: unknown): Promise<{ runId: string; stepRunIds: readonly string[] }>;
  dispatch(runId: string): Promise<{ enqueued: number; enqueueFailures: number }>;
  cancel(runId: string): Promise<{ runId: string; state: string; note?: string | null }>;
}

let controllerDb: ControlDb | null = null;

async function createApiController(queuePrefix: string): Promise<ApiControllerLike> {
  // `reflect-metadata` is resolvable through the api package's OWN
  // dependency set (never invented, never vendored into the test).
  const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  apiRequire('reflect-metadata');
  const loaded = (await import('../../apps/api/src/execution/execution.controller.js')) as {
    ExecutionController: new (options: unknown) => ApiControllerLike;
  };
  const env = loadTestEnv();
  controllerDb = createControlDb(env.controlDatabaseUrl);
  return new loaded.ExecutionController({
    controlDb: controllerDb,
    redisUrl: env.redisUrl,
    // A PRIVATE prefix: the enqueue is genuinely executed against real
    // Redis, but no shared worker listens on it, so a leftover probe job
    // can never be consumed by another suite's worker.
    queuePrefix,
    credentialPolicy: testTargetOriginCredentialPolicy({}),
  });
}

/** One experiment revision that the API can create a run from. */
async function makeRevision(): Promise<string> {
  const target = await registerTarget(prisma, {
    displayName: uniqueName('b1-api-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [await uniqueTestOrigin(prisma)],
    contractKind: 'GENERIC_HTTP',
  });
  const experiment = await createExperiment(prisma, {
    name: uniqueName('b1-api-experiment'),
    targetId: target.targetId,
    document: { steps: [{ name: 'api-step-0', action: { ...MUTATING_ACTION } }] },
  });
  return experiment.revisionId;
}

afterAll(async () => {
  if (controllerDb !== null) {
    await controllerDb.disconnect();
  }
  // Rows persist: integration tests share the real DB, and run/step/P
  // rows are honest execution state (unique names prevent collisions).
  //
  // HYGIENE, not cleanup-for-cosmetics: a finished run left RUNNING is a
  // SETTLEABLE run, and `settleRuns(prisma, batch)` is a BOUNDED batch
  // with no ORDER BY. Verified in this session: with a settleable backlog
  // larger than a later suite's batch, that suite's own finished run is
  // NOT settled by its reconcile sweep (an `execution-mechanics` failure
  // reproduced deterministically by seeding 15 settleable runs). So this
  // suite DRAINS the shared backlog through the platform's OWN settlement
  // path — the same `settleRuns` call the worker's reconcile loop makes —
  // and then proves it left nothing settleable among ITS runs.
  await settleRuns(prisma, SETTLEMENT_DRAIN_LIMIT);

  let settleableStragglers = 0;
  for (const runId of createdRunIds) {
    const rows = (await prisma.$queryRaw`
      SELECT count(*)::int AS n
        FROM "control"."experiment_run" r
       WHERE r."id" = ${runId}::uuid
         AND r."state" = 'RUNNING'
         AND EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id")
         AND NOT EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('CLAIMED','EXECUTING'))
         AND (NOT EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('PENDING','DISPATCHED'))
              OR EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('FAILED','CANCELLED')))
    `) as Array<{ n: number }>;
    settleableStragglers += rows[0]?.n ?? 0;
  }
  expect(settleableStragglers).toBe(0);
});

// =====================================================================
// P-01 … P-02 — the atomic revision itself
// =====================================================================

describe('B1 · P-01: one truth-bearing write advances P exactly once', () => {
  it('advances +1 per committed writer transaction (never 0, never 2) and never advances D', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;

    // createRun: the run row + its step rows commit in ONE transaction.
    expect(await readP(runId)).toBe(1n);
    expect(await readD(runId)).toBe(0n);

    // markRunDispatching: SNAPSHOT_PINNED → DISPATCHING.
    await markRunDispatching(prisma, runId);
    expect(await readP(runId)).toBe(2n);

    // The claim writes step state, lease fields, fencing token and the
    // run's dispatch marker in ONE transaction → exactly one advance.
    const ctx = await claimAs(stepRunId, 'p01-worker');
    expect(await readP(runId)).toBe(3n);

    // markExecuting: CLAIMED → EXECUTING.
    await markExecuting(prisma, stepRunId, ctx);
    expect(await readP(runId)).toBe(4n);

    // The terminal write.
    await writeTerminalState(
      prisma,
      stepRunId,
      {
        state: 'SUCCEEDED',
        intentOutcome: 'SUCCEEDED',
        sideEffectKnowledge: 'KNOWN_OCCURRED',
        attemptCount: 1,
        error: null,
      },
      ctx,
    );
    expect(await readP(runId)).toBe(5n);

    // The head row is real durable state with one row per run.
    const head = await prisma.runTruthInputHead.findUniqueOrThrow({
      where: { runId },
      select: { provenanceRevision: true, derivationGeneration: true, updatedAt: true },
    });
    expect(head.provenanceRevision).toBe(5n);
    expect(head.derivationGeneration).toBe(0n); // B2 territory: no writer yet.
    expect(head.updatedAt).toBeInstanceOf(Date);
  });

  it('treats a missing head row as the deterministic initial (0, 0)', async () => {
    const { runId } = await makeRun(1);
    // Delete the head to model a legacy/accepted-tag run created before
    // the B1 writer protocol existed (lazy creation must be deterministic).
    await prisma.runTruthInputHead.delete({ where: { runId } });
    expect(await readP(runId)).toBe(0n);
    expect(await readD(runId)).toBe(0n);

    await markRunDispatching(prisma, runId);
    expect(await readP(runId)).toBe(1n);
    expect(await readD(runId)).toBe(0n);
  });
});

describe('B1 · P-02: a failed transaction advances neither the row nor P', () => {
  it('rolls back an invocation write and the revision together', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    await claimAs(stepRunId, 'p02-worker');
    const before = await readP(runId);
    const identity = randomUUID();
    const invocationsBefore = await prisma.stepInvocation.count({ where: { stepRunId } });

    await expect(
      prisma.$transaction(async (tx) => {
        await acquireRunLock(tx, runId);
        await tx.stepInvocation.create({
          data: {
            stepRunId,
            sequence: 1,
            invocationIdentity: identity,
            transportStage: 'REQUEST_SENT',
            outcome: 'SUCCEEDED',
            sideEffectKnowledge: 'KNOWN_OCCURRED',
          },
        });
        await advanceProvenanceRevision(tx, runId);
        throw new Error('controlled rollback');
      }),
    ).rejects.toThrow('controlled rollback');

    expect(await readP(runId)).toBe(before);
    expect(await prisma.stepInvocation.count({ where: { stepRunId } })).toBe(invocationsBefore);
    expect(
      await prisma.stepInvocation.findFirst({ where: { stepRunId, invocationIdentity: identity } }),
    ).toBeNull();
  });

  it('rolls back a business-state write and the revision together (P-11: database-level failure)', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p02-worker-b');
    await markExecuting(prisma, stepRunId, ctx);
    const before = await readP(runId);
    const stepBefore = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, attemptCount: true, terminalAt: true, intentOutcome: true },
    });

    // A REAL database-level failure inside the writer transaction: the
    // terminal write's `attemptCount` is an int4 column, so a value
    // beyond the range aborts the UPDATE — AFTER the per-run lock was
    // taken and after `P` was staged in the same transaction.
    await expect(
      writeTerminalState(
        prisma,
        stepRunId,
        {
          state: 'SUCCEEDED',
          intentOutcome: 'SUCCEEDED',
          sideEffectKnowledge: 'KNOWN_OCCURRED',
          attemptCount: 2_147_483_648,
          error: null,
        },
        ctx,
      ),
    ).rejects.toThrow();

    // Neither the terminal truth nor the revision moved.
    expect(await readP(runId)).toBe(before);
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, attemptCount: true, terminalAt: true, intentOutcome: true },
    });
    expect(step.state).toBe(stepBefore.state);
    expect(step.state).toBe('EXECUTING');
    expect(step.attemptCount).toBe(stepBefore.attemptCount);
    expect(step.terminalAt).toBeNull();
    expect(step.intentOutcome).toBeNull();
  });
});

// =====================================================================
// P-03 … P-04, P-12, P-13 — the shared per-run lock
// =====================================================================

describe('B1 · P-03: two concurrent writers on the same run serialize', () => {
  it('a contender cannot acquire the run lock while another writer holds it', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p03-worker');
    const before = await readP(runId);

    const holder = await holdRunLock(runId, async (tx) => {
      await advanceProvenanceRevision(tx, runId);
    });
    try {
      // The lock is provably held (the holder resolved only after
      // acquiring it). A same-run contender with a bounded lock wait
      // must FAIL to acquire it — REAL PostgreSQL contention.
      const blocked = await probeLockWithTimeout(runId, 400);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.message).toMatch(/lock timeout|canceling statement/i);
      }
      // Nothing was written and nothing advanced by the failed contender:
      // the holder's advance is still UNCOMMITTED (not visible outside).
      expect(await readP(runId)).toBe(before);
    } finally {
      holder.release();
      await holder.done;
    }

    // Only the holder's transaction advanced, and exactly once.
    expect(await readP(runId)).toBe(before + 1n);

    // With the lock free, the same write succeeds (serialized, not lost).
    await markExecuting(prisma, stepRunId, ctx);
    expect(await readP(runId)).toBe(before + 2n);
  });
});

describe('B1 · P-04: different runs are not unnecessarily serialized', () => {
  it('a write on another run proceeds while this run lock is held', async () => {
    const first = await makeRun(1);
    const second = await makeRun(1);
    const p1 = await readP(first.runId);
    const p2 = await readP(second.runId);

    const holder = await holdRunLock(first.runId, async (tx) => {
      await advanceProvenanceRevision(tx, first.runId);
    });
    try {
      // Same bounded lock wait as the blocked contender in P-03, but for
      // a DIFFERENT run: it must succeed immediately (per-run scope).
      const other = await probeLockWithTimeout(second.runId, 400);
      expect(other).toEqual({ ok: true });

      await prisma.$transaction(async (tx) => {
        await acquireRunLock(tx, second.runId, 400);
        await advanceProvenanceRevision(tx, second.runId);
      });
      // The second run's write COMMITTED while the first run's lock is
      // still held — no cross-run serialization.
      expect(await readP(second.runId)).toBe(p2 + 1n);
      expect(await readP(first.runId)).toBe(p1);
    } finally {
      holder.release();
      await holder.done;
    }

    expect(await readP(first.runId)).toBe(p1 + 1n);
    expect(await readP(second.runId)).toBe(p2 + 1n);
  });
});

describe('B1 · P-13: the run-lock timeout fails safely', () => {
  it('a timed-out writer commits nothing (no row, no revision advance)', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    await claimAs(stepRunId, 'p13-worker');
    const before = await readP(runId);
    const invocationsBefore = await prisma.stepInvocation.count({ where: { stepRunId } });

    const holder = await holdRunLock(runId);
    let caught: unknown = null;
    try {
      await prisma.$transaction(async (tx) => {
        await acquireRunLock(tx, runId, 300);
        await tx.stepInvocation.create({
          data: {
            stepRunId,
            sequence: 1,
            transportStage: 'REQUEST_SENT',
            outcome: 'SUCCEEDED',
            sideEffectKnowledge: 'KNOWN_OCCURRED',
          },
        });
        await advanceProvenanceRevision(tx, runId);
      });
    } catch (error) {
      caught = error;
    } finally {
      holder.release();
      await holder.done;
    }

    // The failure SURFACED (never swallowed, never retried blind) …
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/lock timeout|canceling statement/i);
    // … and it left no partial truth behind.
    expect(await readP(runId)).toBe(before);
    expect(await prisma.stepInvocation.count({ where: { stepRunId } })).toBe(invocationsBefore);

    // `DEFAULT_RUN_LOCK_TIMEOUT_MS` is the shared bound (bounded hold).
    expect(DEFAULT_RUN_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('B1 · P-12: the raw-evidence chain (C) and provenance (P) serialize compatibly', () => {
  it('holds the SAME per-run advisory lock the chain-append primitive takes', async () => {
    const { runId } = await makeRun(1);
    const holder = await holdRunLock(runId);
    try {
      // `RawObservationStore.appendChainObservation` executes exactly
      // `SELECT pg_advisory_xact_lock(hashtext(<runId>::text))`. A probe
      // running that same statement cannot acquire it while the
      // provenance holder owns it — one lock, both protocols.
      const blocked = await probeLockWithTimeout(runId, 400);
      expect(blocked.ok).toBe(false);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it('the chain-append primitive genuinely BLOCKS on the held run lock (pg_locks evidence)', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const holder = await holdRunLock(runId, async (tx) => {
      await advanceProvenanceRevision(tx, runId);
    });
    const before = await readP(runId);
    let appendSettled = false;
    const appendPromise = store
      .appendTargetObservation({
        runId,
        stepRunId,
        adapterKind: 'b1-test-read-only-probe',
        observedAt: new Date(),
        payload: { probe: 'p12-blocked-append' },
        writerOwnerId: 'b1-test-writer',
        writerFencingToken: null,
        provenanceIdentity: `p12-blocked-${randomUUID()}`,
      })
      .then((appended) => {
        appendSettled = true;
        return appended;
      });

    try {
      // A REAL PostgreSQL wait on THIS run's advisory lock appears …
      await waitForRunLockWait(runId);
      // … and the append therefore cannot have completed: it is held at
      // the very statement our provenance writer owns.
      expect(appendSettled).toBe(false);
      // The blocked append has not advanced anything.
      expect(await readP(runId)).toBe(before);
    } finally {
      holder.release();
      await holder.done;
    }

    const appended = await appendPromise;
    expect(appended.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The holder committed (P +1) and the chain append landed afterwards.
    expect(await readP(runId)).toBe(before + 1n);
    const report = await verifyRunEvidenceChain(prisma, runId);
    expect(report.problems).toEqual([]);
    expect(report.chainValid).toBe(true);
  });

  it('a concurrent chain append and provenance write both land, and the chain stays hash-valid', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p12-worker');
    const before = await readP(runId);

    const provenanceIdentity = `phase17-b1-concurrent-${randomUUID()}`;
    const [appended] = await Promise.all([
      store.appendTargetObservation({
        runId,
        stepRunId,
        adapterKind: 'b1-test-read-only-probe',
        observedAt: new Date(),
        payload: { probe: 'concurrent-chain-append' },
        writerOwnerId: 'b1-test-writer',
        writerFencingToken: null,
        provenanceIdentity,
      }),
      // A real provenance writer racing the chain append for the SAME run.
      markExecuting(prisma, stepRunId, ctx),
    ]);

    // The chain append is durable and the provenance writer advanced P
    // exactly once — the two protocols did not stomp each other.
    expect(appended.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(appended.chainIndex).toBeGreaterThanOrEqual(0);
    expect(await readP(runId)).toBe(before + 1n);

    // The chain remains hash-valid (C untouched by the P protocol).
    const report = await verifyRunEvidenceChain(prisma, runId);
    expect(report.problems).toEqual([]);
    expect(report.chainValid).toBe(true);
    expect(report.contentHashesValid).toBe(true);
    expect(report.guarantee).toBe(
      'append-only chain intact: stored observations match their hashes and links',
    );
    expect(report.observationCount).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================
// P-05, P-07, P-10 — truthful (unfenced) invocation records
// =====================================================================

describe('B1 · P-05: a truthful stale StepInvocation persists and advances P', () => {
  it('keeps a superseded generation’s post-send record, attributed, and refuses to fence it', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;

    // Generation 1 claims with a SHORT lease and then loses it.
    const stale = await claimAs(stepRunId, 'p05-worker-1', 150);
    expect(stale.fencingToken).toBe('1');
    await waitForLeaseExpiry(stepRunId);
    // Generation 2 takes over (token 2 — fenced ownership moved on).
    const current = await claimAs(stepRunId, 'p05-worker-2', LEASE_MS);
    expect(current.fencingToken).toBe('2');
    const before = await readP(runId);

    // The STALE generation still reports truthfully what it observed
    // after its send. `recordInvocation` is deliberately UNFENCED
    // (ADR-0009 §10 / ADR-0026 §13): observation fencing ≠ state fencing.
    const recorded = await recordInvocation(
      prisma,
      stepRunId,
      invocationRecord('KNOWN_OCCURRED', 1),
      stale,
    );

    const row = await prisma.stepInvocation.findUniqueOrThrow({
      where: { id: recorded.invocationId },
      select: {
        sequence: true,
        writtenByOwner: true,
        writtenByFencingToken: true,
        sideEffectKnowledge: true,
        transportStage: true,
      },
    });
    expect(row.writtenByOwner).toBe('p05-worker-1');
    expect(row.writtenByFencingToken).toBe(1n);
    expect(row.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
    expect(row.transportStage).toBe('REQUEST_SENT');

    // The honest record advanced the run's provenance exactly once …
    expect(await readP(runId)).toBe(before + 1n);
    // … and it did NOT resurrect the stale generation's ownership.
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, leaseOwnerId: true, fencingToken: true },
    });
    expect(step.state).toBe('CLAIMED');
    expect(step.leaseOwnerId).toBe('p05-worker-2');
    expect(step.fencingToken).toBe(2n);
  });
});

describe('B1 · P-07: an idempotent duplicate invocation never duplicates a record', () => {
  it('re-sequences a duplicate (stepRunId, sequence) slot and advances P once per real row', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p07-worker');
    const before = await readP(runId);

    const first = await recordInvocation(
      prisma,
      stepRunId,
      invocationRecord('KNOWN_ABSENT', 1),
      ctx,
    );
    // The SAME planned slot again (bounded-retry semantics): the durable
    // record is never dropped and never aliased onto the first row.
    const second = await recordInvocation(
      prisma,
      stepRunId,
      invocationRecord('KNOWN_ABSENT', 1),
      ctx,
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.invocationId).not.toBe(first.invocationId);

    const rows = await prisma.stepInvocation.findMany({
      where: { stepRunId },
      select: { sequence: true, id: true },
      orderBy: { sequence: 'asc' },
    });
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    // Exactly one advance per durable row — never 0, never a bonus
    // advance for the rejected slot allocation.
    expect(await readP(runId)).toBe(before + 2n);
  });
});

describe('B1 · P-10: a late invocation after a terminal SUCCEEDED is durable and advances P', () => {
  it('records the late post-send observation without rewriting terminal truth', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p10-worker');
    await markExecuting(prisma, stepRunId, ctx);
    await writeTerminalState(
      prisma,
      stepRunId,
      {
        state: 'SUCCEEDED',
        intentOutcome: 'SUCCEEDED',
        sideEffectKnowledge: 'KNOWN_OCCURRED',
        attemptCount: 1,
        error: null,
      },
      ctx,
    );
    const before = await readP(runId);
    const terminal = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, intentOutcome: true, sideEffectKnowledge: true, terminalAt: true },
    });

    // A late (post-terminal) observation of the same physical step.
    const late = await recordInvocation(
      prisma,
      stepRunId,
      invocationRecord('KNOWN_OCCURRED', 3),
      ctx,
    );

    expect(await readP(runId)).toBe(before + 1n);
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, intentOutcome: true, sideEffectKnowledge: true, terminalAt: true },
    });
    expect(step.state).toBe('SUCCEEDED');
    expect(step.intentOutcome).toBe('SUCCEEDED');
    expect(step.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
    expect(step.terminalAt).toEqual(terminal.terminalAt);
    // The late row is durable, attributed, and append-only.
    const row = await prisma.stepInvocation.findUniqueOrThrow({
      where: { id: late.invocationId },
      select: { sequence: true, writtenByOwner: true, outcome: true },
    });
    expect(row.writtenByOwner).toBe('p10-worker');
    expect(row.outcome).toBe('SUCCEEDED');
  });
});

// =====================================================================
// P-06, P-15 — fencing and stale-worker semantics preserved
// =====================================================================

describe('B1 · P-06: a rejected fenced terminal write changes no terminal truth', () => {
  it('records the stale attempt (P +1) without writing a terminal state or a second advance', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const stale = await claimAs(stepRunId, 'p06-worker-1', 150);
    await waitForLeaseExpiry(stepRunId);
    const current = await claimAs(stepRunId, 'p06-worker-2', LEASE_MS);
    expect(current.fencingToken).toBe('2');
    const before = await readP(runId);
    const eventsBefore = await prisma.staleWriterEvent.count({ where: { stepRunId } });

    await expect(
      writeTerminalState(
        prisma,
        stepRunId,
        {
          state: 'FAILED',
          intentOutcome: 'FAILED',
          sideEffectKnowledge: 'KNOWN_ABSENT',
          attemptCount: 1,
          error: 'stale terminal attempt',
        },
        stale,
      ),
    ).rejects.toThrow(LeaseLostError);

    // No terminal truth was written by the stale generation …
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: {
        state: true,
        intentOutcome: true,
        sideEffectKnowledge: true,
        terminalAt: true,
        leaseOwnerId: true,
        fencingToken: true,
      },
    });
    expect(step.state).toBe('CLAIMED');
    expect(step.intentOutcome).toBeNull();
    expect(step.sideEffectKnowledge).toBeNull();
    expect(step.terminalAt).toBeNull();
    expect(step.leaseOwnerId).toBe('p06-worker-2');
    // … the attempt itself is durably recorded (append-only) …
    expect(await prisma.staleWriterEvent.count({ where: { stepRunId } })).toBe(eventsBefore + 1);
    // … and P advanced EXACTLY once for that recorded attempt — never as
    // if the rejected terminal write had succeeded.
    expect(await readP(runId)).toBe(before + 1n);
  });
});

describe('B1 · P-15: the existing worker lease/fencing rules are preserved', () => {
  it('keeps claims atomic, tokens monotone, live leases unstealable, and stale writes at 0 rows', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;

    // A lease long enough to exercise the live-lease and heartbeat checks,
    // short enough to reach REAL database-time expiry within the test.
    const first = await claimAs(stepRunId, 'p15-worker-A', 5_000);
    expect(first.fencingToken).toBe('1');
    const afterClaim = await readP(runId);

    // A live lease cannot be stolen — and a rejected claim advances NOTHING.
    const stolen = await claimStep(prisma, stepRunId, {
      ownerId: 'p15-worker-B',
      leaseDurationMs: LEASE_MS,
    });
    expect(stolen).toBeNull();
    expect(await readP(runId)).toBe(afterClaim);

    // A heartbeat from a non-owner is fenced (DATABASE-time predicate).
    await expect(
      heartbeatStep(prisma, stepRunId, {
        ownerId: 'p15-worker-B',
        fencingToken: '1',
        leaseDurationMs: LEASE_MS,
      }),
    ).rejects.toThrow(LeaseLostError);
    expect(await readP(runId)).toBe(afterClaim);

    // Takeover after real (database-time) lease expiry increments the token.
    await waitForLeaseExpiry(stepRunId);
    const second = await claimAs(stepRunId, 'p15-worker-B', LEASE_MS);
    expect(second.fencingToken).toBe('2');
    expect(await readP(runId)).toBe(afterClaim + 1n);

    // A stale generation's STATE write affects 0 rows and is recorded.
    const before = await readP(runId);
    await expect(markExecuting(prisma, stepRunId, first)).rejects.toThrow(LeaseLostError);
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, leaseOwnerId: true, fencingToken: true },
    });
    expect(step.state).toBe('CLAIMED');
    expect(step.leaseOwnerId).toBe('p15-worker-B');
    expect(step.fencingToken).toBe(2n);
    expect(await readP(runId)).toBe(before + 1n);

    // A rejected guarded transition (already-EXECUTING) writes no state
    // change, yet honestly records the attempt: P advances once only.
    await markExecuting(prisma, stepRunId, second);
    const afterExecuting = await readP(runId);
    await expect(markExecuting(prisma, stepRunId, second)).rejects.toThrow(LeaseLostError);
    expect(await readP(runId)).toBe(afterExecuting + 1n);
  });
});

// =====================================================================
// P-08, P-09 — recovery, settlement, and the real API mutations
// =====================================================================

describe('B1 · P-08: recovery and settlement mutations advance P', () => {
  it('advances P on expired-lease resolution and on run settlement, and stays idempotent', async () => {
    // Expired lease → INDETERMINATE (conservative, never retried).
    const recovering = await makeRun(1);
    const recoveringStep = recovering.stepRunIds[0] as string;
    await claimAs(recoveringStep, 'p08-worker-1', 150);
    await waitForLeaseExpiry(recoveringStep);
    const beforeResolve = await readP(recovering.runId);

    const resolution = await resolveExpiredLease(prisma, recoveringStep, 'MUTATING', true);
    expect(resolution).toBe('indeterminate');
    expect(await readP(recovering.runId)).toBe(beforeResolve + 1n);
    const recovered = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: recoveringStep },
      select: { state: true, sideEffectKnowledge: true },
    });
    expect(recovered.state).toBe('FAILED');
    expect(recovered.sideEffectKnowledge).toBe('INDETERMINATE');

    // Run settlement: FAILED step ⇒ remaining run settles.
    const settling = await makeRun(1);
    const settlingStep = settling.stepRunIds[0] as string;
    await markRunDispatching(prisma, settling.runId);
    const ctx = await claimAs(settlingStep, 'p08-worker-2');
    await markExecuting(prisma, settlingStep, ctx);
    await writeTerminalState(
      prisma,
      settlingStep,
      {
        state: 'FAILED',
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'KNOWN_ABSENT',
        attemptCount: 1,
        error: 'controlled failure',
      },
      ctx,
    );
    const running = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: settling.runId },
      select: { state: true },
    });
    expect(running.state).toBe('RUNNING');
    const beforeSettle = await readP(settling.runId);

    await settleRuns(prisma, 50);
    const settled = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: settling.runId },
      select: { state: true, failureReason: true },
    });
    expect(settled.state).toBe('FAILED');
    expect(settled.failureReason).toContain('1 step(s) did not succeed');
    expect(await readP(settling.runId)).toBe(beforeSettle + 1n);

    // Idempotent re-settlement writes nothing and advances nothing.
    await settleRuns(prisma, 50);
    expect(await readP(settling.runId)).toBe(beforeSettle + 1n);

    // Idempotent cancellation of an already-cancelled run: no advance.
    const cancelling = await makeRun(1);
    const beforeCancel = await readP(cancelling.runId);
    await settleCancelledRun(prisma, cancelling.runId);
    expect(await readP(cancelling.runId)).toBe(beforeCancel + 1n);
    await settleCancelledRun(prisma, cancelling.runId);
    expect(await readP(cancelling.runId)).toBe(beforeCancel + 1n);
  });
});

describe('B1 · P-09: API cancellation and dispatch mutations advance P', () => {
  it('drives the real ExecutionController create/dispatch/cancel routes and inspects durable P', async () => {
    const controller = await createApiController(`b1-api-probe-${randomUUID()}`);

    // POST /runs → createRun (run + step rows, ONE transaction).
    const created = await controller.createRunEndpoint({ revisionId: await makeRevision() });
    const runId = created.runId;
    createdRunIds.push(runId);
    expect(await readP(runId)).toBe(1n);

    // POST /runs/:id/dispatch → markRunDispatching (+1) and the first
    // step's dispatch marker (+1), whether the enqueue lands or not.
    const dispatched = await controller.dispatch(runId);
    expect(dispatched.enqueued + dispatched.enqueueFailures).toBe(1);
    expect(await readP(runId)).toBe(3n);

    const stepRunId = (
      await prisma.experimentStepRun.findFirstOrThrow({
        where: { runId },
        select: { id: true },
      })
    ).id;
    await claimAs(stepRunId, 'p09-worker');
    const running = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { state: true },
    });
    expect(running.state).toBe('RUNNING');

    // POST /runs/:id/cancel on a RUNNING run → cooperative cancel request.
    const beforeCancelRequest = await readP(runId);
    const requested = await controller.cancel(runId);
    expect(requested.state).toBe('RUNNING');
    expect(await readP(runId)).toBe(beforeCancelRequest + 1n);
    const cancelMarker = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    expect(cancelMarker.cancelRequestedAt).toBeInstanceOf(Date);

    // POST /runs/:id/cancel on a never-dispatched run → settles at once.
    const early = await controller.createRunEndpoint({ revisionId: await makeRevision() });
    createdRunIds.push(early.runId);
    const beforeEarly = await readP(early.runId);
    const settled = await controller.cancel(early.runId);
    expect(settled.state).toBe('CANCELLED');
    expect(await readP(early.runId)).toBe(beforeEarly + 1n);
    // Re-cancelling a terminal run is an idempotent no-op: no advance.
    const again = await controller.cancel(early.runId);
    expect(again.state).toBe('CANCELLED');
    expect(await readP(early.runId)).toBe(beforeEarly + 1n);
  });
});

// =====================================================================
// P-14 — the existing raw-evidence chain is untouched by the P protocol
// =====================================================================

describe('B1 · P-14: the existing raw evidence chain remains hash-valid', () => {
  it('stays intact after a full provenance-driven lifecycle', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p14-worker');
    await markExecuting(prisma, stepRunId, ctx);

    // Two real chain observations (the C side) interleaved with the
    // provenance writers (the P side).
    await store.appendTargetObservation({
      runId,
      stepRunId,
      adapterKind: 'b1-test-read-only-probe',
      observedAt: new Date(),
      payload: { probe: 'p14', index: 1 },
      writerOwnerId: 'b1-test-writer',
      writerFencingToken: null,
      provenanceIdentity: `p14-1-${randomUUID()}`,
    });
    await writeTerminalState(
      prisma,
      stepRunId,
      {
        state: 'SUCCEEDED',
        intentOutcome: 'SUCCEEDED',
        sideEffectKnowledge: 'KNOWN_OCCURRED',
        attemptCount: 1,
        error: null,
      },
      ctx,
    );
    await store.appendTargetObservation({
      runId,
      stepRunId,
      adapterKind: 'b1-test-read-only-probe',
      observedAt: new Date(),
      payload: { probe: 'p14', index: 2 },
      writerOwnerId: 'b1-test-writer',
      writerFencingToken: null,
      provenanceIdentity: `p14-2-${randomUUID()}`,
    });
    await recordStaleWriter(
      prisma,
      stepRunId,
      { ownerId: 'p14-stale', fencingToken: '99' },
      'p14 probe',
    );

    const report = await verifyRunEvidenceChain(prisma, runId);
    expect(report.problems).toEqual([]);
    expect(report.chainValid).toBe(true);
    expect(report.contentHashesValid).toBe(true);
    expect(report.guarantee).toBe(
      'append-only chain intact: stored observations match their hashes and links',
    );
    expect(report.observationCount).toBe(2);

    const head = await prisma.evidenceIntegrityHead.findUniqueOrThrow({
      where: { runId },
      select: { lastChainIndex: true, observationCount: true },
    });
    expect(head.observationCount).toBe(2);
    expect(head.lastChainIndex).toBe(1);
  });

  it('keeps the chain-append primitive compatible with the writer protocol on a real run', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    const stepRunId = stepRunIds[0] as string;
    const ctx = await claimAs(stepRunId, 'p14-worker-b');
    const before = await readP(runId);

    await store.appendTargetObservation({
      runId,
      stepRunId,
      adapterKind: 'b1-test-read-only-probe',
      observedAt: new Date(),
      payload: { probe: 'p14-b' },
      writerOwnerId: 'b1-test-writer',
      writerFencingToken: null,
      provenanceIdentity: `p14-b-${randomUUID()}`,
    });

    // The chain append advances C (the integrity head), never P.
    expect(await readP(runId)).toBe(before);
    await markExecuting(prisma, stepRunId, ctx);
    expect(await readP(runId)).toBe(before + 1n);

    const head = await prisma.evidenceIntegrityHead.findUniqueOrThrow({
      where: { runId },
      select: { observationCount: true },
    });
    expect(head.observationCount).toBe(1);
    const report = await verifyRunEvidenceChain(prisma, runId);
    expect(report.problems).toEqual([]);
  });
});

// =====================================================================
// Helper primitives — the shared lock/revision surface itself
// =====================================================================

describe('B1 · helper primitives', () => {
  it('resolves a step to its run, and returns null for an unknown step', async () => {
    const { runId, stepRunIds } = await makeRun(1);
    expect(await resolveRunIdOfStep(prisma, stepRunIds[0] as string)).toBe(runId);
    expect(await resolveRunIdOfStep(prisma, randomUUID())).toBeNull();
  });

  it('advanceProvenanceRevision is monotone by exactly 1 per call in one transaction', async () => {
    const { runId } = await makeRun(1);
    const before = await readP(runId);
    await prisma.$transaction(async (tx) => {
      await acquireRunLock(tx, runId);
      await advanceProvenanceRevision(tx, runId);
      await advanceProvenanceRevision(tx, runId);
      await advanceProvenanceRevision(tx, runId);
    });
    expect(await readP(runId)).toBe(before + 3n);
    // D is never advanced by the P protocol.
    expect(await readD(runId)).toBe(0n);
  });
});
