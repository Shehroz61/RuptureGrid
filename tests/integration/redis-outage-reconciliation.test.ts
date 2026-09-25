// =====================================================================
// Integration — Redis outage: durable creation + reconciliation (§40)
// =====================================================================
// PHASE 3 ACCEPTANCE SCENARIO, end to end on real infrastructure:
//   1. Redis UNAVAILABLE
//   2. run created durably (createRun commits; enqueue fails visibly)
//   3. durable run remains in DISPATCHING with dispatch intent intact
//   4. Redis RECOVERS (container start)
//   5. reconciler discovers undispatched durable work by DB predicate
//   6. work is enqueued; worker executes over real HTTP
//   7. run reaches COMPLETED without operator repair
// Also proves a duplicate reconciler sweep enqueues nothing new
// (idempotency — no duplicate business executions).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue, startExecutionWorker } from '@rupturegrid/queue';
import type { ExecutionWorkerHandle } from '@rupturegrid/queue';
import {
  StepProcessor,
  createExperiment,
  createRun,
  markRunDispatching,
  runReconcileSweep,
} from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { redisOutageControl } from './helpers/redis-outage.js';
import {
  getControlPrisma,
  registerLocalFixtureTarget,
  uniqueName,
  waitFor,
} from './helpers/execution-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();

let server: Server | null = null;
let baseUrl = '';
let controlDb: ControlDb;
let processor: StepProcessor;
let consumer: ExecutionWorkerHandle | null = null;
let queue: ReturnType<typeof createExecutionQueue>;
let outage: ReturnType<typeof redisOutageControl>;

beforeAll(async () => {
  outage = redisOutageControl();
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: new URL(req.url ?? '/', 'http://f').pathname }));
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  controlDb = createControlDb(env.controlDatabaseUrl);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  processor = new StepProcessor({
    prisma: controlDb.prisma,
    config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
    credentials: { resolve: () => 'unused' },
    dispatchNextStep: async () => {},
  });
});

afterAll(async () => {
  await consumer?.close();
  await queue.close();
  await controlDb.disconnect();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

function redisContainerStop(): void {
  // Shared outage-control abstraction: exact resolved target only —
  // CI job service container (explicit ID) or the repo's own compose
  // redis container (label-resolved). Never a guessed container name.
  outage.stop();
}

function redisContainerStart(): void {
  outage.start();
}

function redisReachable(): boolean {
  return outage.reachable();
}

describe('Redis outage → durable creation → reconciliation recovery (§40)', () => {
  it('survives Redis down at creation, recovers via reconciler, completes without operator repair', async () => {
    // --- 0. Fixture target (registered BEFORE the outage) ---
    const targetId = await registerLocalFixtureTarget(prisma, uniqueName('outage-target'), baseUrl);
    const created = await createExperiment(prisma, {
      name: uniqueName('outage-experiment'),
      targetId,
      document: {
        steps: [
          {
            name: 'solo',
            action: {
              method: 'GET',
              relativePath: '/recovered',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });

    // --- 1. Redis UNAVAILABLE ---
    redisContainerStop();
    expect(redisReachable()).toBe(false);

    try {
      // --- 2. Durable creation + failed enqueue (like the API pair) ---
      const run = await createRun(prisma, created.revisionId);
      expect(run.stepRunIds).toHaveLength(1);
      await markRunDispatching(prisma, run.runId);
      let enqueueFailed = false;
      try {
        await queue.enqueueStep({
          runId: run.runId,
          stepRunId: run.stepRunIds[0] as string,
          sequence: 0,
        });
      } catch {
        enqueueFailed = true; // visible failure, not silent buffering
      }
      expect(enqueueFailed).toBe(true);

      // --- 3. The durable run REMAINS (PostgreSQL authority, ADR-0003) ---
      const persisted = await prisma.experimentRun.findUniqueOrThrow({
        where: { id: run.runId },
        include: { steps: true },
      });
      expect(persisted.state).toBe('DISPATCHING');
      expect(persisted.steps[0]?.dispatchState).toBe('PENDING');
      expect(persisted.steps[0]?.state).toBe('PENDING');

      // --- 4. Redis RECOVERS ---
      redisContainerStart();
      const recovered = await waitFor(() => Promise.resolve(redisReachable()), 30_000, 500);
      expect(recovered).toBe(true);
      // Wait until the producer connection inside the queue can actually
      // reach Redis again (enableOfflineQueue:false rejects until ready).
      await waitFor(
        async () => {
          try {
            const probe = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
            try {
              await probe.enqueueStep({
                runId: '00000000-0000-0000-0000-000000000000',
                stepRunId: '00000000-0000-0000-0000-000000000001',
                sequence: 0,
              });
            } finally {
              await probe.close();
            }
            return true;
          } catch {
            return null;
          }
        },
        30_000,
        1_000,
      );
    } finally {
      // Safety: never leave the shared Redis down for other suites.
      if (!redisReachable()) {
        redisContainerStart();
      }
    }

    // --- 5. Reconciler discovers undispatched durable work ---
    const sweep = await runReconcileSweep({
      prisma: controlDb.prisma,
      dispatchBatch: 100,
      settleBatch: 50,
      leaseRecoveryBatch: 50,
      enqueue: async (stepRunId, runId, sequence) => {
        await queue.enqueueStep({ runId, stepRunId, sequence });
      },
    });
    expect(sweep.requeued).toBeGreaterThanOrEqual(1);

    // --- 6. Worker executes over real HTTP ---
    consumer = startExecutionWorker({
      redisUrl: env.redisUrl,
      prefix: env.queuePrefix,
      concurrency: 2,
      processJob: async (payload) => {
        await processor.processStep(payload.stepRunId);
      },
    });

    // --- 7. Run completes without operator repair ---
    const ourRunId = (
      await prisma.experimentRun.findFirstOrThrow({
        where: {
          snapshot: { revision: { definition: { name: { startsWith: 'outage-experiment-' } } } },
        },
        orderBy: { createdAt: 'desc' },
      })
    ).id;
    // Settle via a sweep once the worker finished the step (loop until
    // the sweep reports our run settled).
    await waitFor(
      async () => {
        await runReconcileSweep({
          prisma: controlDb.prisma,
          dispatchBatch: 100,
          settleBatch: 50,
          leaseRecoveryBatch: 50,
          enqueue: async (stepRunId, rId, sequence) => {
            await queue.enqueueStep({ runId: rId, stepRunId, sequence });
          },
        });
        const row = await prisma.experimentRun.findUniqueOrThrow({ where: { id: ourRunId } });
        return row.state === 'COMPLETED' || row.state === 'FAILED' ? row.state : null;
      },
      30_000,
      1_000,
    );
    // Settle via a second sweep (worker finished the step).
    await runReconcileSweep({
      prisma: controlDb.prisma,
      dispatchBatch: 100,
      settleBatch: 50,
      leaseRecoveryBatch: 50,
      enqueue: async () => {},
    });
    const finalRun = await prisma.experimentRun.findFirstOrThrow({
      where: {
        snapshot: { revision: { definition: { name: { startsWith: 'outage-experiment-' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(finalRun.state).toBe('COMPLETED');

    // Idempotency: a duplicate sweep enqueues nothing (all dispatched).
    const secondSweep = await runReconcileSweep({
      prisma: controlDb.prisma,
      dispatchBatch: 100,
      settleBatch: 50,
      leaseRecoveryBatch: 50,
      enqueue: async () => {
        throw new Error('duplicate sweep must not re-enqueue dispatched work');
      },
    });
    expect(secondSweep.requeued).toBe(0);
  });
});
