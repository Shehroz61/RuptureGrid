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
import {
  createEngineEvidenceSink,
  captureDemoPaymentLineage,
  captureDemoFaultStatus,
  runRunAnalysis,
  DEMO_LINEAGE_ADAPTER_KIND,
} from '@rupturegrid/evidence';
import { createLoggerTelemetry } from '@rupturegrid/engine';

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
  // Phase 4: durable evidence capture — every real invocation
  // observation is redacted, hashed, and hash-chained per run. Capture
  // failure never blocks execution (honest incompleteness is logged).
  const evidenceSink = createEngineEvidenceSink(controlDb.prisma);

  // Phase 9: fault-control credential (request-time only, R-13). The
  // Demo admin token is already in validated worker config for demo
  // operations; fault arming reuses that SAME credential class — no new
  // secret is introduced.
  const demoAdminToken = config.DEMO_ADMIN_TOKEN ?? '';

  // Phase 4: EXPLICIT target-evidence adapter (§28/§29). Only steps
  // whose frozen action declares evidenceAdapter.kind trigger this.
  // The inspection credential is resolved from validated config at
  // request time and exists only inside this call frame (ADR-0012).
  const captureEvidenceAdapter = async (input: {
    readonly runId: string;
    readonly stepRunId: string;
    readonly origin: string;
    readonly adapterKind: 'demo-fintech-payment-lineage';
    readonly providerPaymentId: string;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }): Promise<void> => {
    if (input.adapterKind !== DEMO_LINEAGE_ADAPTER_KIND) {
      logger.warn('unknown evidence adapter kind requested', {
        adapterKind: input.adapterKind,
      });
      return;
    }
    await captureDemoPaymentLineage(controlDb.prisma, {
      runId: input.runId,
      stepRunId: input.stepRunId,
      origin: input.origin,
      inspectionToken: config.DEMO_INSPECTION_TOKEN ?? null,
      providerPaymentId: input.providerPaymentId,
      writerOwnerId: input.writerOwnerId,
      writerFencingToken: input.writerFencingToken,
    });
  };

  // Phase 9 controlled-fault control port (ADR-0014): the engine owns
  // WHEN to arm/disarm; this adapter owns HOW — the Demo Target's own
  // admin API over HTTP with the admin credential from validated config.
  // The credential exists only inside this call frame and is never
  // logged, persisted, or attached to evidence (R-13). Arming failure is
  // a hard precondition inside the engine; disarm is best-effort. The
  // origin is the FROZEN registered target origin from the snapshot —
  // no target can be faulted other than the one the step already
  // executes against.
  //
  // Fault-path transport rules mirror the executor's (security-
  // boundaries §3–§6): redirects are NEVER followed (redirect:'manual';
  // a 3xx is a failure), the final response origin must still be the
  // registered target origin, and every call is bounded by a timeout.
  // The fault path therefore cannot be used to bypass the SSRF/
  // registered-origin rules that gate step execution.
  const faultControlFetch = async (
    origin: string,
    path: string,
    init: {
      readonly method: 'PUT' | 'DELETE';
      readonly body?: string;
    },
  ): Promise<Response> => {
    const response = await fetch(`${origin}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${demoAdminToken}`, // R-13: request-time only
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'manual', // security-boundaries §6: never follow.
      signal: AbortSignal.timeout(10_000),
    });
    const responseOrigin = new URL(response.url).origin;
    if (responseOrigin !== new URL(origin).origin) {
      throw new Error(
        `fault-control response origin ${responseOrigin} does not match the registered target origin`,
      );
    }
    return response;
  };

  const controlledFaults = {
    arm: async (input: {
      readonly faultPlan: unknown;
      readonly runId: string;
      readonly stepRunId: string;
      readonly origin: string;
    }): Promise<void> => {
      const plan = input.faultPlan as {
        faultKind: string;
        planVersion: string;
        activation: string;
        maxTriggers: number;
      };
      const response = await faultControlFetch(
        input.origin,
        `/demo/admin/faults/${encodeURIComponent(plan.faultKind)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            planVersion: plan.planVersion,
            activation: plan.activation,
            maxTriggers: plan.maxTriggers,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `fault arming failed for ${plan.faultKind}: target responded ${String(response.status)}`,
        );
      }
    },
    disarm: async (input: {
      readonly faultKind: string;
      readonly runId: string;
      readonly stepRunId: string;
      readonly origin: string;
    }): Promise<void> => {
      await faultControlFetch(
        input.origin,
        `/demo/admin/faults/${encodeURIComponent(input.faultKind)}`,
        { method: 'DELETE' },
      ).catch(() => undefined); // best-effort by contract
    },
  };

  // Phase 9: explicit fault-status observation capture (docs/
  // controlled-faults.md §5) — the target's read-only inspection API
  // with the inspection credential (request-time only, ADR-0012).
  const captureFaultStatusAdapter = async (input: {
    readonly runId: string;
    readonly stepRunId: string;
    readonly origin: string;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }): Promise<void> => {
    await captureDemoFaultStatus(controlDb.prisma, {
      runId: input.runId,
      stepRunId: input.stepRunId,
      origin: input.origin,
      inspectionToken: config.DEMO_INSPECTION_TOKEN ?? null,
      writerOwnerId: input.writerOwnerId,
      writerFencingToken: input.writerFencingToken,
    });
  };

  const processor = new StepProcessor({
    prisma: controlDb.prisma,
    config: {
      WORKER_LEASE_DURATION_MS: config.WORKER_LEASE_DURATION_MS,
      WORKER_HEARTBEAT_INTERVAL_MS: config.WORKER_HEARTBEAT_INTERVAL_MS,
    },
    credentials: createDemoCredentialResolver(config),
    dispatchNextStep,
    evidenceSink,
    captureEvidenceAdapter,
    controlledFaults,
    captureFaultStatusAdapter,
    telemetry: createLoggerTelemetry(logger),
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
        // Phase 4: deterministic analysis for settled runs. Runs whose
        // steps are all terminal and that have evidence but no complete
        // evaluation batch are analyzed idempotently here (PostgreSQL-
        // driven, survives Redis outages; repeat passes converge). A
        // settled run with NO evidence produces the honest empty
        // result; analysis never blocks or delays reconciliation.
        let analyzed = 0;
        try {
          analyzed = await analyzeSettledRuns(controlDb.prisma, 10);
        } catch (error) {
          logger.warn('analysis pass failed (retry next sweep)', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        logger.info('reconcile sweep', { ...result, ...lease, analyzed });
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

  /**
   * Finds settled runs (all steps terminal) that have raw evidence but
   * no evaluation batch yet, and runs the deterministic analysis for
   * each. Bounded per sweep; idempotent — repeat passes converge.
   */
  const analyzeSettledRuns = async (
    prisma: ControlDb['prisma'],
    batch: number,
  ): Promise<number> => {
    const candidates = (await prisma.$queryRaw`
      SELECT r."id" AS "runId"
        FROM "control"."experiment_run" r
       WHERE r."state" IN ('COMPLETED', 'FAILED')
         AND EXISTS (SELECT 1 FROM "evidence"."raw_observation" o WHERE o."runId" = r."id")
         AND NOT EXISTS (
           SELECT 1 FROM "analysis"."evaluation_batch" b
            WHERE b."runId" = r."id" AND b."completedAt" IS NOT NULL
         )
       LIMIT ${batch}
    `) as Array<{ runId: string }>;
    let count = 0;
    for (const candidate of candidates) {
      try {
        await runRunAnalysis(prisma, candidate.runId);
        count += 1;
      } catch (error) {
        logger.warn('run analysis failed (will retry next sweep)', {
          runId: candidate.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return count;
  };

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
