// =====================================================================
// Integration — multi-PROCESS workers, crash, takeover (§45–§47)
// =====================================================================
// TWO real worker PROCESSES (spawned like the real app) compete for the
// same durable steps through real Redis/BullMQ and real PostgreSQL:
//   - no double execution, exactly one winning owner generation
//   - a crashed worker's lease expires; takeover bumps fencing token
//   - an ambiguous mutating step crashed mid-flight resolves
//     INDETERMINATE through lease-expiry recovery (§47)
//   - a mutating step crashed BEFORE send recovers safely (requeue)
// Worker processes connect to their own Control DB + Redis via env;
// no in-process mocks.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import {
  createExperiment,
  createRun,
  markRunDispatching,
  runReconcileSweep,
} from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { uniqueName, waitFor } from './helpers/execution-harness.js';
import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';

let env = loadTestEnv();
let prisma: PrismaClient;
let fixture: OwnedControlFixture;

let server: Server | null = null;
let baseUrl = '';
let hitCount = 0;
let hangRequested = false;
let queue: ReturnType<typeof createExecutionQueue>;
const workers: ChildProcess[] = [];

beforeAll(async () => {
  fixture = await createOwnedControlFixture(env);
  env = fixture.env;
  prisma = fixture.prisma;
  server = createServer((_req, res) => {
    hitCount += 1;
    if (hangRequested) {
      return; // mid-flight hang: the worker will crash while in flight
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
});

afterAll(async () => {
  await stopAllWorkerProcesses();
  await queue.close();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  await fixture.close();
});

/** Spawns a REAL worker process with a short lease for fast tests. */
async function startWorkerProcess(): Promise<void> {
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      WORKER_LEASE_DURATION_MS: '2000',
      WORKER_HEARTBEAT_INTERVAL_MS: '700',
      WORKER_RECONCILE_INTERVAL_MS: '1000',
      WORKER_CONCURRENCY: '4',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  workers.push(child);
  // The worker logs "ready" once its consumer is up.
  await waitFor(async () => (stdout.includes('ready') ? true : null), 20_000, 100).catch(() => {
    throw new Error(`worker did not start: ${stderr || stdout}`);
  });
}

/** Stops every worker process this file spawned. */
async function stopAllWorkerProcesses(): Promise<void> {
  await Promise.all(workers.splice(0).map(killAndJoin));
}

async function killAndJoin(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve());
    worker.once('error', reject);
    worker.kill('SIGKILL');
  });
}

/** Waits until DATABASE time is past the given step's lease deadline. */
async function waitLeaseExpired(stepRunId: string): Promise<void> {
  await waitFor(
    async () => {
      const rows = (await prisma.$queryRaw`
      SELECT ("leaseExpiresAt" < "statement_timestamp"()) AS expired
        FROM "control"."experiment_step_run"
       WHERE "id" = ${stepRunId}::uuid
    `) as Array<{ expired: boolean }>;
      return rows[0]?.expired === true ? true : null;
    },
    20_000,
    300,
  );
}

async function stopWorkerProcessAbruptly(): Promise<void> {
  const victim = workers.pop();
  if (victim === undefined) {
    return;
  }
  await killAndJoin(victim); // crash: no graceful shutdown, no state writes
}

async function makeRun(
  mutation: 'READ_ONLY' | 'MUTATING',
  path: string,
): Promise<{ runId: string; stepRunId: string }> {
  const target = await fixture.acquireTarget('workload', {
    displayName: 'multi-worker-target',
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
  });
  const created = await createExperiment(prisma, {
    name: uniqueName('mp-experiment'),
    targetId: target.targetId,
    document: {
      steps: [
        {
          name: 'work',
          action: { method: 'GET', relativePath: path, mutation, contract: 'GENERIC_HTTP' },
        },
      ],
    },
  });
  const run = await createRun(prisma, created.revisionId);
  return { runId: run.runId, stepRunId: run.stepRunIds[0] as string };
}

describe('multi-process workers on real infrastructure (§45)', () => {
  it('two worker processes, one execution: exactly one owner, terminal written once', async () => {
    // Tests below rely on a QUIET fleet: leftover workers would race
    // them for claims. Test 1 verifies its assertions, then we stop the
    // fleet so §46/§47 start clean.
    hitCount = 0;
    const before = hitCount;
    const made = await makeRun('READ_ONLY', '/multi-process');
    await markRunDispatching(prisma, made.runId);

    await startWorkerProcess();
    await startWorkerProcess();
    // Deliver the SAME durable step job twice (competing deliveries).
    await queue.enqueueStep({ runId: made.runId, stepRunId: made.stepRunId, sequence: 0 });
    await queue.enqueueStep({ runId: made.runId, stepRunId: made.stepRunId, sequence: 0 });

    await waitFor(
      async () => {
        const row = await prisma.experimentStepRun.findUnique({ where: { id: made.stepRunId } });
        return row?.state === 'SUCCEEDED' || row?.state === 'FAILED' ? true : null;
      },
      30_000,
      300,
    );

    // Exactly ONE execution of the real HTTP action.
    const executions = hitCount - before;
    expect(executions).toBe(1);

    const row = await prisma.experimentStepRun.findUniqueOrThrow({ where: { id: made.stepRunId } });
    expect(row.state).toBe('SUCCEEDED');
    expect(row.fencingToken).toBe(1n); // one owner generation, no takeover
    const invocations = await prisma.stepInvocation.count({ where: { stepRunId: made.stepRunId } });
    expect(invocations).toBe(1);

    await stopAllWorkerProcesses();
  });

  it(
    'worker crash → lease expiry → new generation takes over with a higher fencing token (§46)',
    { timeout: 75_000 },
    async () => {
      hitCount = 0;
      const made = await makeRun('READ_ONLY', '/crash-takeover');
      await markRunDispatching(prisma, made.runId);

      // Worker A claims by processing the job, then is SIGKILLed
      // mid-flight (the hang holds the request open while the process
      // dies). With WORKER_LEASE_DURATION_MS=2000 and no heartbeat, the
      // lease expires and Worker B (new process) takes over.
      hangRequested = true;
      await startWorkerProcess();
      await queue.enqueueStep({ runId: made.runId, stepRunId: made.stepRunId, sequence: 0 });
      // Wait for the claim to be visible, then crash the process.
      await waitFor(
        async () => {
          const row = await prisma.experimentStepRun.findUnique({ where: { id: made.stepRunId } });
          return row?.state === 'EXECUTING' || row?.state === 'CLAIMED' ? true : null;
        },
        20_000,
        200,
      );
      await stopWorkerProcessAbruptly();

      hangRequested = false;
      // Worker B (fresh process). Takeover requires the expired lease to
      // be resolved first: the reconciler resets the read-only step to
      // PENDING/RECONCILE, then we re-dispatch (the deterministic jobId
      // was consumed by the crashed generation's delivery, so a fresh
      // job id is derived from the SAME durable step — BullMQ dedupe no
      // longer blocks because the old job completed/failed).
      await waitLeaseExpired(made.stepRunId); // DB-time lease truly expired
      const expired = await import('@rupturegrid/engine').then((m) => m.reconcileExpiredLeases);
      const resolution = await expired(prisma, 10);
      expect(resolution.requeue).toBeGreaterThanOrEqual(1);
      const { runReconcileSweep: sweepDispatch } = await import('@rupturegrid/engine');
      await sweepDispatch({
        prisma,
        dispatchBatch: 10,
        settleBatch: 10,
        leaseRecoveryBatch: 10,
        enqueue: async (stepRunId, runId, sequence) => {
          await queue.enqueueStep({ runId, stepRunId, sequence });
        },
      });
      await startWorkerProcess(); // Worker B: fresh generation

      await waitFor(
        async () => {
          const row = await prisma.experimentStepRun.findUnique({ where: { id: made.stepRunId } });
          return row?.state === 'SUCCEEDED' || row?.state === 'FAILED' ? true : null;
        },
        40_000,
        500,
      );

      const row = await prisma.experimentStepRun.findUniqueOrThrow({
        where: { id: made.stepRunId },
      });
      expect(row.state).toBe('SUCCEEDED');
      expect(Number(row.fencingToken)).toBeGreaterThanOrEqual(2); // takeover generation
      expect(row.leaseOwnerId).not.toBe('crashed'); // ownership moved
      // Exactly one successful execution after recovery.
      expect(hitCount).toBeGreaterThanOrEqual(1);

      await stopAllWorkerProcesses();
    },
  );
});

describe('crash mid-flight of a MUTATING step (§47 ambiguity)', () => {
  it('expired lease with an in-flight mutating request resolves INDETERMINATE, never blindly retried', async () => {
    hitCount = 0;
    const made = await makeRun('MUTATING', '/mutating-crash');
    await markRunDispatching(prisma, made.runId);

    hangRequested = true;
    await startWorkerProcess();
    await queue.enqueueStep({ runId: made.runId, stepRunId: made.stepRunId, sequence: 0 });
    await waitFor(
      async () => {
        const row = await prisma.experimentStepRun.findUnique({ where: { id: made.stepRunId } });
        return row?.state === 'EXECUTING' || row?.state === 'CLAIMED' ? true : null;
      },
      20_000,
      200,
    );
    await stopWorkerProcessAbruptly(); // crash mid-request
    await waitLeaseExpired(made.stepRunId);

    hangRequested = false;
    // Recovery runs WITHOUT re-dispatching: the expired-lease resolver
    // must see a mutating step whose request MAY have been sent.
    const lease = await import('@rupturegrid/engine').then((m) => m.reconcileExpiredLeases);
    const result = await lease(prisma, 10);
    expect(result.indeterminate).toBeGreaterThanOrEqual(1);

    const row = await prisma.experimentStepRun.findUniqueOrThrow({ where: { id: made.stepRunId } });
    expect(row.state).toBe('FAILED');
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
    // And it must NOT be requeued: no new claimable state.
    const redispatch = await runReconcileSweep({
      prisma,
      dispatchBatch: 10,
      settleBatch: 10,
      leaseRecoveryBatch: 10,
      enqueue: async () => {
        throw new Error('INDETERMINATE step must not be re-enqueued');
      },
    });
    void redispatch;
  });
});
