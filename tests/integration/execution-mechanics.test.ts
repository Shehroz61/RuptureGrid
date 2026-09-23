// =====================================================================
// Integration — execution mechanics end to end (real infra, real HTTP)
// =====================================================================
// Real Control PostgreSQL, real Redis/BullMQ, real HTTP against a
// local fixture target (registered as LOCAL_DEVELOPMENT). Proves:
//   - durable creation + dispatch → claim → execute → terminal
//   - duplicate BullMQ delivery executes exactly once (§43)
//   - ordered chaining (later step only after predecessor SUCCEEDED)
//   - dependency failure stops the run safely (§47/§38)
//   - ambiguous mutating timeout → INDETERMINATE, never retried (§25)
//   - provable pre-send failure with SAFE policy retries (§26/§28)
//   - repeat/concurrency bounded and measured (§54–§56)

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
  registerTarget,
  runReconcileSweep,
  settleCancelledRun,
} from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import {
  getControlPrisma,
  registerLocalFixtureTarget,
  uniqueName,
  uniqueTestOrigin,
  waitFor,
} from './helpers/execution-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();

// ---------------------------------------------------------------------
// Fixture HTTP target: observable behavior for every scenario.
// ---------------------------------------------------------------------
interface FixtureState {
  hits: Map<string, number>;
  inFlight: number;
  maxInFlight: number;
  slowDelayMs: number;
  hangPaths: Set<string>;
  notFoundPaths: Set<string>;
}
const fixture: FixtureState = {
  hits: new Map(),
  inFlight: 0,
  maxInFlight: 0,
  slowDelayMs: 0,
  hangPaths: new Set(),
  notFoundPaths: new Set(),
};

let server: Server | null = null;
let baseUrl = '';
let fixtureTargetId = '';

beforeAll(async () => {
  fixture.notFoundPaths.add('/missing-endpoint-404');
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const key = `${req.method} ${url.pathname}`;
    fixture.hits.set(key, (fixture.hits.get(key) ?? 0) + 1);
    fixture.inFlight += 1;
    fixture.maxInFlight = Math.max(fixture.maxInFlight, fixture.inFlight);
    const finish = (): void => {
      fixture.inFlight -= 1;
    };
    if (fixture.hangPaths.has(url.pathname)) {
      // Never respond — the executor's timeout fires mid-flight.
      return;
    }
    if (fixture.notFoundPaths.has(url.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      finish();
      return;
    }
    if (fixture.slowDelayMs > 0) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: url.pathname }));
        finish();
      }, fixture.slowDelayMs);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: url.pathname, echo: url.search }));
    finish();
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  // The fixture origin is registered ONCE (origin authority is global).
  const fixtureTarget = await registerLocalFixtureTarget(
    prisma,
    uniqueName('mech-fixture-target'),
    baseUrl,
  );
  fixtureTargetId = fixtureTarget;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

// ---------------------------------------------------------------------
// Shared runtime: one StepProcessor + one BullMQ consumer, wired like
// the real worker (IDs-only payloads, chaining via dispatchNextStep).
// ---------------------------------------------------------------------
let controlDb: ControlDb;
let processor: StepProcessor;
let consumer: ExecutionWorkerHandle | null = null;
let queue: ReturnType<typeof createExecutionQueue>;

async function startConsumer(): Promise<void> {
  consumer = startExecutionWorker({
    redisUrl: env.redisUrl,
    prefix: env.queuePrefix,
    concurrency: 8,
    processJob: async (payload) => {
      await processor.processStep(payload.stepRunId);
    },
  });
}

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  processor = new StepProcessor({
    prisma: controlDb.prisma,
    config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
    credentials: { resolve: () => 'unused' },
    dispatchNextStep: async (runId, nextStepRunId) => {
      const step = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
        where: { id: nextStepRunId },
        select: { sequence: true },
      });
      await queue.enqueueStep({ runId, stepRunId: nextStepRunId, sequence: step.sequence });
    },
  });
});

afterAll(async () => {
  await consumer?.close();
  await queue.close();
  await controlDb.disconnect();
});

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------
async function setupExperiment(
  steps: readonly {
    name: string;
    action: {
      method: 'GET' | 'POST';
      relativePath: string;
      mutation: 'READ_ONLY' | 'MUTATING';
      contract: 'GENERIC_HTTP';
      retryPolicy?: 'NONE' | 'SAFE';
      repeat?: number;
      concurrency?: number;
      timeoutMs?: number;
      headers?: Record<string, string>;
      body?: string;
    };
  }[],
): Promise<{ runId: string; stepRunIds: string[] }> {
  const created = await createExperiment(controlDb.prisma, {
    name: uniqueName('mech-experiment'),
    targetId: fixtureTargetId,
    document: { steps: [...steps] },
  });
  const run = await createRun(controlDb.prisma, created.revisionId);
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

/** Dispatch + consume like the API/worker pair, and await terminal. */
async function dispatchAndRun(runId: string, firstStepId: string): Promise<string> {
  await startConsumer();
  try {
    await queue.enqueueStep({ runId, stepRunId: firstStepId, sequence: 0 });
    const terminal = await waitFor(async () => {
      const row = await controlDb.prisma.experimentStepRun.findUnique({
        where: { id: firstStepId },
        select: { state: true },
      });
      if (row?.state === 'SUCCEEDED' || row?.state === 'FAILED' || row?.state === 'CANCELLED') {
        return row.state;
      }
      return null;
    });
    return terminal;
  } finally {
    await consumer?.close();
    consumer = null;
  }
}

function hitsFor(method: string, path: string): number {
  return fixture.hits.get(`${method} ${path}`) ?? 0;
}

// ---------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------
describe('execution mechanics over real infrastructure', () => {
  it('dispatches durably, executes over real HTTP, chains ordered steps, and settles COMPLETED', async () => {
    fixture.slowDelayMs = 0;
    const made = await setupExperiment([
      {
        name: 'first',
        action: {
          method: 'GET',
          relativePath: '/one',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
      {
        name: 'second',
        action: {
          method: 'GET',
          relativePath: '/two',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
    ]);
    const [first, second] = made.stepRunIds as [string, string];

    // Mark DISPATCHING like the real API, then enqueue step 0.
    // The consumer stays UP until the CHAINED step reaches terminal:
    // the processor commits step-0's terminal state BEFORE calling
    // dispatchNextStep, so observing step-0 terminal and tearing the
    // consumer down immediately can strand the chained job in Redis
    // (a race the reconciler would recover in production, but which
    // this test asserts via the live path). Waiting on step-1 keeps
    // the window closed without weakening any assertion.
    await markRunDispatching(controlDb.prisma, made.runId);
    await startConsumer();
    let terminal: string;
    try {
      await queue.enqueueStep({ runId: made.runId, stepRunId: first, sequence: 0 });
      terminal = await waitFor(async () => {
        const row = await controlDb.prisma.experimentStepRun.findUnique({
          where: { id: second },
          select: { state: true },
        });
        if (row?.state === 'SUCCEEDED' || row?.state === 'FAILED' || row?.state === 'CANCELLED') {
          return row.state;
        }
        return null;
      });
    } finally {
      await consumer?.close();
      consumer = null;
    }
    expect(terminal).toBe('SUCCEEDED');

    const firstRow = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: first },
    });
    expect(firstRow.state).toBe('SUCCEEDED');

    // Chained step also reached the real target.
    expect(hitsFor('GET', '/two')).toBeGreaterThanOrEqual(1);
    const secondRow = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: second },
    });
    expect(secondRow.state).toBe('SUCCEEDED');
    expect(secondRow.fencingToken).toBe(1n);

    // Reconciler settles the run COMPLETED.
    await runReconcileSweep({
      prisma: controlDb.prisma,
      dispatchBatch: 10,
      settleBatch: 10,
      leaseRecoveryBatch: 10,
      enqueue: async () => {},
    });
    const run = await controlDb.prisma.experimentRun.findUniqueOrThrow({
      where: { id: made.runId },
    });
    expect(run.state).toBe('COMPLETED');
  });

  it('duplicate delivery of the same step executes exactly once (§43)', async () => {
    const made = await setupExperiment([
      {
        name: 'dup',
        action: {
          method: 'POST',
          relativePath: '/dup',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
          repeat: 1,
        },
      },
    ]);
    const [only] = made.stepRunIds as [string, string];
    const before = hitsFor('POST', '/dup');

    await startConsumer();
    try {
      // The SAME durable step delivered twice (deterministic jobId would
      // dedupe; here we force true duplicate delivery through the queue).
      await queue.enqueueStep({ runId: made.runId, stepRunId: only, sequence: 0 });
      await queue.enqueueStep({ runId: made.runId, stepRunId: only, sequence: 0 });
      await waitFor(async () => (hitsFor('POST', '/dup') - before >= 1 ? true : null));
      await waitFor(async () => {
        const row = await controlDb.prisma.experimentStepRun.findUnique({ where: { id: only } });
        return row?.state === 'SUCCEEDED' ? true : null;
      });
      // Give any duplicate delivery a chance to (wrongly) execute.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await consumer?.close();
      consumer = null;
    }
    expect(hitsFor('POST', '/dup') - before).toBe(1);
    const invocations = await controlDb.prisma.stepInvocation.count({ where: { stepRunId: only } });
    expect(invocations).toBe(1);
  });

  it('dependency failure stops the run: later steps CANCELLED, run FAILED (§47)', async () => {
    const made = await setupExperiment([
      {
        name: 'boom',
        action: {
          method: 'GET',
          relativePath: '/missing-endpoint-404',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
      {
        name: 'never',
        action: {
          method: 'GET',
          relativePath: '/never',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
    ]);
    const [first, second] = made.stepRunIds as [string, string];
    await markRunDispatching(controlDb.prisma, made.runId);
    const terminal = await dispatchAndRun(made.runId, first);
    expect(terminal).toBe('FAILED');

    await runReconcileSweep({
      prisma: controlDb.prisma,
      dispatchBatch: 10,
      settleBatch: 10,
      leaseRecoveryBatch: 10,
      enqueue: async () => {},
    });
    const secondRow = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: second },
    });
    expect(secondRow.state).toBe('CANCELLED');
    expect(secondRow.sideEffectKnowledge).toBe('KNOWN_ABSENT');
    const run = await controlDb.prisma.experimentRun.findUniqueOrThrow({
      where: { id: made.runId },
    });
    expect(run.state).toBe('FAILED');
    expect(run.failureReason).toContain('did not succeed');
  });

  it('ambiguous mutating timeout is INDETERMINATE and never retried (§25/§17)', async () => {
    fixture.hangPaths.add('/hang-mutation');
    try {
      const made = await setupExperiment([
        {
          name: 'hang',
          action: {
            method: 'POST',
            relativePath: '/hang-mutation',
            mutation: 'MUTATING',
            contract: 'GENERIC_HTTP',
            retryPolicy: 'SAFE',
            timeoutMs: 400,
          },
        },
      ]);
      const [only] = made.stepRunIds as [string, string];
      const terminal = await dispatchAndRun(made.runId, only);
      expect(terminal).toBe('FAILED');
      const row = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
        where: { id: only },
      });
      expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
      // Exactly ONE attempt: no automatic retry of ambiguity.
      const invocations = await controlDb.prisma.stepInvocation.findMany({
        where: { stepRunId: only },
      });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.sideEffectKnowledge).toBe('INDETERMINATE');
      expect(invocations[0]?.transportStage).toBe('REQUEST_SENT');
    } finally {
      fixture.hangPaths.delete('/hang-mutation');
    }
  });

  it('provable pre-send failure with SAFE policy retries within budget (§26/§28)', async () => {
    // Connection REFUSED on a closed port: the request provably never
    // left the executor → KNOWN_ABSENT, safe to retry under policy.
    const deadTarget = await registerTarget(controlDb.prisma, {
      displayName: uniqueName('dead-target'),
      environment: 'LOCAL_DEVELOPMENT',
      origins: [await uniqueTestOrigin(controlDb.prisma)],
      contractKind: 'GENERIC_HTTP',
    });
    const created = await createExperiment(controlDb.prisma, {
      name: uniqueName('dead-experiment'),
      targetId: deadTarget.targetId,
      document: {
        steps: [
          {
            name: 'refused',
            action: {
              method: 'GET',
              relativePath: '/x',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
              retryPolicy: 'SAFE',
            },
          },
        ],
      },
    });
    const run = await createRun(controlDb.prisma, created.revisionId);
    const terminal = await dispatchAndRun(run.runId, run.stepRunIds[0] as string);
    expect(terminal).toBe('FAILED');
    const row = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: run.stepRunIds[0] as string },
    });
    expect(row.sideEffectKnowledge).toBe('NOT_APPLICABLE'); // read-only: no side-effect dimension
    expect(row.attemptCount).toBeGreaterThanOrEqual(2); // SAFE retried
    expect(row.attemptCount).toBeLessThanOrEqual(3); // bounded budget
    const invocations = await controlDb.prisma.stepInvocation.count({
      where: { stepRunId: run.stepRunIds[0] as string },
    });
    expect(invocations).toBe(row.attemptCount);
  });

  it('repeat and concurrency are bounded and measured (§54–§56)', async () => {
    fixture.maxInFlight = 0;
    const made = await setupExperiment([
      {
        name: 'waves',
        action: {
          method: 'GET',
          relativePath: '/wave',
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
          repeat: 6,
          concurrency: 3,
          timeoutMs: 2000,
        },
      },
    ]);
    const [only] = made.stepRunIds as [string, string];
    const before = hitsFor('GET', '/wave');
    const terminal = await dispatchAndRun(made.runId, only);
    expect(terminal).toBe('SUCCEEDED');
    expect(hitsFor('GET', '/wave') - before).toBe(6);
    const invocations = await controlDb.prisma.stepInvocation.findMany({
      where: { stepRunId: only },
    });
    expect(invocations).toHaveLength(6);
    expect(fixture.maxInFlight).toBeGreaterThanOrEqual(2);
    expect(fixture.maxInFlight).toBeLessThanOrEqual(3); // configured cap respected
  });

  it('cancel before execution closes steps CANCELLED/KNOWN_ABSENT and run CANCELLED', async () => {
    const made = await setupExperiment([
      {
        name: 'cancelled-step',
        action: {
          method: 'GET',
          relativePath: '/cancelled',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
        },
      },
    ]);
    const [only] = made.stepRunIds as [string, string];
    await settleCancelledRun(controlDb.prisma, made.runId);
    const row = await controlDb.prisma.experimentStepRun.findUniqueOrThrow({ where: { id: only } });
    expect(row.state).toBe('CANCELLED');
    expect(row.sideEffectKnowledge).toBe('KNOWN_ABSENT');
    const run = await controlDb.prisma.experimentRun.findUniqueOrThrow({
      where: { id: made.runId },
    });
    expect(run.state).toBe('CANCELLED');
    // A cancelled step is not claimable: delivery exits safely.
    const claim = await processor.processStep(only);
    expect(claim).toBe('not-claimable');
  });
});
