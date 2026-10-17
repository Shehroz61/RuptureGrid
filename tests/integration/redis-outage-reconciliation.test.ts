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
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue, startExecutionWorker } from '@rupturegrid/queue';
import type { ExecutionWorkerHandle } from '@rupturegrid/queue';
import {
  StepProcessor,
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
  runReconcileSweep,
  ManifestValidationError,
  TargetRegistrationError,
} from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';
import { redisOutageControl } from './helpers/redis-outage.js';
import { uniqueName, waitFor } from './helpers/execution-harness.js';

let env = loadTestEnv();
const prisma = () => controlDb.prisma;
let queuePrefix = '';

let server: Server | null = null;
let baseUrl = '';
let controlDb: ControlDb;
let ownedFixture: OwnedControlFixture | null = null;
let processor: StepProcessor;
let consumer: ExecutionWorkerHandle | null = null;
let queue: ReturnType<typeof createExecutionQueue>;
let outage: ReturnType<typeof redisOutageControl>;

beforeAll(async () => {
  // TCP ports recycle independently of durable origin registrations. Own
  // the registration namespace and every client/reconciler using it;
  // never adopt a registration from the persistent developer database.
  ownedFixture = await createOwnedControlFixture(env);
  env = ownedFixture.env;
  queuePrefix = env.queuePrefix;
  controlDb = ownedFixture.controlDb;
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
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: queuePrefix });
  processor = new StepProcessor({
    prisma: controlDb.prisma,
    config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
    credentials: { resolve: () => 'unused' },
    dispatchNextStep: async () => {},
  });
});

afterAll(async () => {
  try {
    await consumer?.close();
    await queue?.close();
  } finally {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
    } finally {
      await ownedFixture?.close();
    }
  }
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
  it('refuses a foreign origin owner and its incompatible stored manifest before durable execution', async () => {
    const foreignUrl = new URL(baseUrl);
    foreignUrl.hostname = 'localhost';
    const origin = foreignUrl.origin;
    // Historical manifests can predate ADR-0021's required role binding.
    // Seed this exact invalid shape only in our migrated, owned Control DB.
    const foreign = await prisma().targetRegistration.create({
      data: {
        displayName: uniqueName('foreign-outage-target'),
        environment: 'LOCAL_DEVELOPMENT',
        contractKind: 'GENERIC_HTTP',
        credentialRefs: [],
        origins: { create: { origin } },
        manifestJson: {
          manifestVersion: 'target-manifest/v1',
          displayName: 'historical-foreign-target',
          environment: 'LOCAL_DEVELOPMENT',
          origins: [origin],
          credentialRefs: [],
          contract: { kind: 'GENERIC_HTTP' },
          inspection: [
            {
              queryId: 'records',
              description: 'Historical records without a declared role',
              path: '/inspection/records',
              fields: { recordId: 'string' },
              identityFields: ['recordId'],
            },
          ],
          sensitiveFields: [],
        },
      },
      include: { origins: true },
    });
    const definitionsBefore = await prisma().experimentDefinition.count();
    const runsBefore = await prisma().experimentRun.count();
    await expect(
      registerTarget(prisma(), {
        displayName: uniqueName('outage-target'),
        environment: 'LOCAL_DEVELOPMENT',
        origins: [origin],
        contractKind: 'GENERIC_HTTP',
      }),
    ).rejects.toBeInstanceOf(TargetRegistrationError);
    const attempt = createExperiment(prisma(), {
      name: uniqueName('foreign-outage-experiment'),
      targetId: foreign.id,
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
    await expect(attempt).rejects.toBeInstanceOf(ManifestValidationError);
    await expect(attempt).rejects.toThrow(/inspection\[0\]\.roleId/);
    expect(await prisma().experimentDefinition.count()).toBe(definitionsBefore);
    expect(await prisma().experimentRun.count()).toBe(runsBefore);
    expect(
      await prisma().targetRegistration.findUniqueOrThrow({
        where: { id: foreign.id },
        include: { origins: true },
      }),
    ).toEqual(foreign);
  });

  it('survives Redis down at creation, recovers via reconciler, completes without operator repair', async () => {
    // --- 0. Fixture target (registered BEFORE the outage) ---
    const displayName = uniqueName('outage-target');
    const registered = await ownedFixture!.acquireTarget('outage', {
      displayName,
      environment: 'LOCAL_DEVELOPMENT',
      origins: [baseUrl],
      contractKind: 'GENERIC_HTTP',
    });
    const targetId = registered.targetId;
    const owned = await prisma().targetRegistration.findUniqueOrThrow({
      where: { id: targetId },
      include: { origins: true },
    });
    expect(owned.displayName).toBe(displayName);
    expect(owned.origins.map((entry) => entry.origin)).toEqual([new URL(baseUrl).origin]);
    expect(owned.credentialRefs).toEqual([]);
    expect(owned.manifestJson).toBeNull();
    const created = await createExperiment(prisma(), {
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

    let ourRunId = '';
    try {
      // --- 2. Durable creation + failed enqueue (like the API pair) ---
      const run = await createRun(prisma(), created.revisionId);
      ourRunId = run.runId;
      expect(run.stepRunIds).toHaveLength(1);
      await markRunDispatching(prisma(), run.runId);
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
      const persisted = await prisma().experimentRun.findUniqueOrThrow({
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
            const probe = createExecutionQueue({ redisUrl: env.redisUrl, prefix: queuePrefix });
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
      prefix: queuePrefix,
      concurrency: 2,
      processJob: async (payload) => {
        await processor.processStep(payload.stepRunId);
      },
    });

    // --- 7. Run completes without operator repair ---
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
        const row = await prisma().experimentRun.findUniqueOrThrow({ where: { id: ourRunId } });
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
    const finalRun = await prisma().experimentRun.findUniqueOrThrow({
      where: { id: ourRunId },
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
