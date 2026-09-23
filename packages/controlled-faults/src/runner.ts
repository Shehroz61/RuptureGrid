// =====================================================================
// RuptureGrid v1.0 — controlled-faults scenario runner (Phase 9)
// =====================================================================
// Executes ONE scenario end-to-end against the REAL stack (real
// BullMQ dispatch, real worker process wiring, real Demo Target,
// real PostgreSQL/Redis) and returns the durable facts an evaluator
// needs. Every wait is bounded; no fact is invented.

import type { PrismaClient } from '@rupturegrid/control-db';
import { createExperiment, createRun, markRunDispatching } from '@rupturegrid/engine';
import { createExecutionQueue } from '@rupturegrid/queue';

export class ControlledFaultsRunError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlledFaultsRunError';
  }
}

export interface ScenarioRunResult {
  readonly runId: string;
  readonly stepRunIds: readonly string[];
  readonly finalState: string;
}

/** Bounded polling for a terminal run state (never a fixed sleep). */
export async function waitForTerminalState(
  prisma: PrismaClient,
  runId: string,
  timeoutMs: number,
  intervalMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { state: true },
    });
    const state = run?.state ?? null;
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') {
      return state;
    }
    if (Date.now() > deadline) {
      throw new ControlledFaultsRunError(
        `run ${runId} did not reach a terminal state within ${timeoutMs}ms (last state: ${String(state)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Creates and executes one scenario through the REAL Control Plane
 * path (createExperiment → createRun → markRunDispatching → real
 * BullMQ enqueue). The caller's worker processes the steps exactly as
 * production does.
 */
export async function executeScenario(
  prisma: PrismaClient,
  input: {
    readonly redisUrl: string;
    readonly queuePrefix: string;
    readonly targetId: string;
    readonly scenarioName: string;
    readonly steps: Array<Record<string, unknown>>;
    readonly runTimeoutMs: number;
  },
): Promise<ScenarioRunResult> {
  const created = await createExperiment(prisma, {
    name: input.scenarioName,
    targetId: input.targetId,
    document: { steps: input.steps } as never,
  });
  const run = await createRun(prisma, created.revisionId);
  await markRunDispatching(prisma, run.runId);
  const first = run.stepRunIds[0];
  if (first === undefined) {
    throw new ControlledFaultsRunError('scenario run has no steps');
  }
  const queue = createExecutionQueue({
    redisUrl: input.redisUrl,
    prefix: input.queuePrefix,
  });
  try {
    await queue.enqueueStep({ runId: run.runId, stepRunId: first, sequence: 0 });
  } finally {
    await queue.close();
  }
  const finalState = await waitForTerminalState(prisma, run.runId, input.runTimeoutMs);
  return {
    runId: run.runId,
    stepRunIds: [...run.stepRunIds],
    finalState,
  };
}
