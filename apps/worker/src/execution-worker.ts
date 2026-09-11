// =====================================================================
// RuptureGrid v1.0 — Phase 3 execution worker runtime
// =====================================================================
// Owns: Control PostgreSQL, Redis/BullMQ, executor credentials (by
// validated config). Consumes execution jobs (IDs only), loads
// authoritative state from PostgreSQL, claims with lease+fencing,
// executes against the registered target over HTTP, and runs the
// bounded reconciler loop that recovers undispatched durable work
// after Redis recovery without operator repair.

import { loadWorkerConfig } from '@rupturegrid/config';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createLogger } from '@rupturegrid/logger';
import { createExecutionQueue, startExecutionWorker, executionJobId } from '@rupturegrid/queue';
import type { ExecutionJobPayload } from '@rupturegrid/queue';
import {
  StepProcessor,
  createDemoCredentialResolver,
  runReconcileSweep,
  reconcileExpiredLeases,
  markRunDispatching,
  settleCancelledRun,
} from '@rupturegrid/engine';

export interface ExecutionWorkerRuntime {
  readonly ready: Promise<void>;
  readonly workerId: string;
  /** Drives one reconcile sweep now (tests/runtime verification). */
  readonly sweep: () => Promise<{ requeued: number; settled: number; leaseRecoveries: number }>;
  shutdown(): Promise<void>;
}

export async function startExecutionWorkerRuntime(): Promise<ExecutionWorkerRuntime> {
  const config = loadWorkerConfig();
  const logger = createLogger({
    service: 'rupturegrid-worker',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const controlDb: ControlDb = createControlDb(config.CONTROL_DATABASE_URL);
  // Durable next-step dispatch used by ordered chaining: enqueue via
  // BullMQ, then mark DISPATCHED. Failures leave the step RECONCILE;
  // the reconciler recovers it (ADR-0003).
  const dispatchNextStep = async (runId: string, nextStepRunId: string): Promise<void> => {
    const queue = createExecutionQueue({
      redisUrl: config.REDIS_URL,
      prefix: config.QUEUE_PREFIX,
    });
    try {
      const step = await controlDb.prisma.experimentStepRun.findUnique({
        where: { id: nextStepRunId },
        select: { sequence: true },
      });
      if (step === null) {
        return;
      }
      await queue.enqueueStep({ runId, stepRunId: nextStepRunId, sequence: step.sequence });
    } finally {
      await queue.close();
    }
  };
  const processor = new StepProcessor({
    prisma: controlDb.prisma,
    config: {
      WORKER_LEASE_DURATION_MS: config.WORKER_LEASE_DURATION_MS,
      WORKER_HEARTBEAT_INTERVAL_MS: config.WORKER_HEARTBEAT_INTERVAL_MS,
    },
    credentials: createDemoCredentialResolver(config),
    dispatchNextStep,
  });

  // ---- Reconciler loop (bounded, interval-driven) ----
  let sweeping = false;
  const sweep = async (): Promise<{
    requeued: number;
    settled: number;
    leaseRecoveries: number;
  }> => {
    if (sweeping) {
      return { requeued: 0, settled: 0, leaseRecoveries: 0 };
    }
    sweeping = true;
    try {
      const queue = createExecutionQueue({
        redisUrl: config.REDIS_URL,
        prefix: config.QUEUE_PREFIX,
      });
      try {
        const result = await runReconcileSweep({
          prisma: controlDb.prisma,
          dispatchBatch: 100,
          settleBatch: 50,
          leaseRecoveryBatch: 50,
          enqueue: async (stepRunId, runId, sequence) => {
            await queue.enqueueStep({ runId, stepRunId, sequence });
          },
        });
        const lease = await reconcileExpiredLeases(controlDb.prisma, 50);
        logger.info('reconcile sweep', { ...result, ...lease });
        return { ...result, leaseRecoveries: lease.indeterminate + lease.requeue };
      } finally {
        await queue.close();
      }
    } finally {
      sweeping = false;
    }
  };
  const reconcileTimer = setInterval(() => {
    void sweep().catch((error: unknown) => {
      logger.error('reconcile sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.WORKER_RECONCILE_INTERVAL_MS);

  const ready = (async () => {
    await controlDb.ping();
    logger.info('execution worker ready', {
      queuePrefix: config.QUEUE_PREFIX,
      queueName: 'experiment-execution',
      concurrency: config.WORKER_CONCURRENCY,
      leaseDurationMs: config.WORKER_LEASE_DURATION_MS,
      heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
      reconcileIntervalMs: config.WORKER_RECONCILE_INTERVAL_MS,
    });
  })();

  const handle = startExecutionWorker({
    redisUrl: config.REDIS_URL,
    prefix: config.QUEUE_PREFIX,
    concurrency: config.WORKER_CONCURRENCY,
    // Stalled-job checks sized from the lease: a job is only ever
    // re-delivered after its PostgreSQL lease could have expired. The
    // 5s floor keeps recovery responsive with short test leases while
    // production (30s lease) still checks at 30s.
    stalledIntervalMs: Math.max(config.WORKER_LEASE_DURATION_MS, 5_000),
    processJob: async (payload: ExecutionJobPayload) => {
      const outcome = await processor.processStep(payload.stepRunId);
      if (outcome === 'not-claimable') {
        // Duplicate delivery, live lease elsewhere, terminal, or
        // cancelled run — exit safely without executing.
        logger.info('step job skipped', {
          stepRunId: payload.stepRunId,
          runId: payload.runId,
          reason: 'not-claimable',
        });
      }
    },
  });

  return {
    ready,
    workerId: processor.id,
    sweep,
    async shutdown() {
      clearInterval(reconcileTimer);
      await handle.close();
      await controlDb.disconnect();
      logger.info('execution worker shutdown complete');
    },
  };
}

/**
 * Marks a run DISPATCHING and enqueues its dispatchable frontier
 * step(s). For ordered runs this is exactly the FIRST step; the worker
 * chains later steps after each predecessor SUCCEEDS.
 */
export async function dispatchRun(
  controlDb: ControlDb,
  queue: { enqueueStep(payload: ExecutionJobPayload): Promise<void> },
  runId: string,
): Promise<{ enqueued: number; failed: number }> {
  await markRunDispatching(controlDb.prisma, runId);
  const steps = (await controlDb.prisma.$queryRaw`
    SELECT s."id", s."sequence"
      FROM "control"."experiment_step_run" s
     WHERE s."runId" = ${runId}::uuid
       AND s."state" IN ('PENDING', 'DISPATCHED')
       AND s."dispatchState" IN ('PENDING', 'RECONCILE')
       AND NOT EXISTS (
         SELECT 1 FROM "control"."experiment_step_run" prior
          WHERE prior."runId" = s."runId"
            AND prior."sequence" < s."sequence"
            AND prior."state" <> 'SUCCEEDED'
       )
     ORDER BY s."sequence" ASC
  `) as Array<{ id: string; sequence: number }>;
  let enqueued = 0;
  let failed = 0;
  for (const step of steps) {
    try {
      await queue.enqueueStep({ runId, stepRunId: step.id, sequence: step.sequence });
      await controlDb.prisma.experimentStepRun.updateMany({
        where: { id: step.id, dispatchState: 'PENDING' },
        data: { dispatchState: 'DISPATCHED', dispatchedAt: new Date() },
      });
      enqueued += 1;
    } catch {
      failed += 1;
      await controlDb.prisma.experimentStepRun.updateMany({
        where: { id: step.id },
        data: { lastDispatchError: 'enqueue failed (Redis unavailable)' },
      });
    }
  }
  return { enqueued, failed };
}

export { settleCancelledRun, executionJobId };
