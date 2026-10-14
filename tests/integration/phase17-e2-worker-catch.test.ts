// =====================================================================
// Integration — Phase 17 Checkpoint E2: the ACTUAL BullMQ processJob
// catch (apps/worker/src/execution-worker.ts), proven over the real
// worker flow (ADR-0026 §29)
// =====================================================================
// This suite executes the PRODUCTION processJob callback — not the
// repair helper. A real worker child process (BullMQ consumer over real
// Redis, real Control PostgreSQL, real HTTP fixture target, isolated
// queue prefix) delivers one mutating step job; a controlled, one-shot,
// test-owned database fault fails the post-send persistence boundary
// AFTER the physical request was sent; the production catch derives the
// fenced emergency terminal and rethrows (BullMQ marks the job failed).
//
// THE FAULT (test-owned, no production backdoor). A BEFORE INSERT
// trigger on control.step_invocation raises exactly once (an armed-flag
// table consumed on fire) with all names prefixed `phase17_e2_`. It is
// created after the worker is idle and dropped in `finally`/afterAll.
// Production code has no branch that can reach it; the fault models a
// real post-send persistence failure (the F-1 case: the sent attempt
// leaves NO invocation row). The emergency repair path inserts no
// invocation row, so the fault cannot block the repair itself.
//
// PROOF THAT THE ACTUAL CATCH RAN (not a direct helper call):
//   1. the worker child's stderr carries the catch's own log line
//      `emergency step terminal` with INDETERMINATE (emitted ONLY in
//      execution-worker.ts's processJob catch — no helper logs it);
//   2. the durable step error carries the `step failed before terminal
//      state:` prefix written ONLY by the engine's emergency repair
//      (boundedEmergencyReason — no normal path writes it);
//   3. the physical send count is exactly 1 with no retry/duplicate;
//   4. the terminal is FAILED/INDETERMINATE/attemptCount 0 (the frozen
//      F-1 conservative outcome — never KNOWN_ABSENT, never a
//      fabricated KNOWN_OCCURRED).
// A direct in-test call to repairEmergencyStepTerminal cannot produce
// (1): the log is emitted by the worker process's catch block itself.
//
// EXPECTED WORKER SAFETY (all asserted from durable rows + the target):
// no false KNOWN_ABSENT, no fabricated KNOWN_OCCURRED, no stranded
// nonterminal step (fenced terminal lands), no stale overwrite (single
// fenced write; the live lease excludes the sweep), no duplicate
// physical side effect (exactly one hit, stable over a bounded window),
// emergency-terminal repair present, run settles FAILED.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';

import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb, PrismaClient } from '@rupturegrid/control-db';
import {
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
  settleRuns,
} from '@rupturegrid/engine';
import { createExecutionQueue } from '@rupturegrid/queue';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import { uniqueName } from './helpers/execution-harness.js';

const prisma = (): PrismaClient => controlDb!.prisma;

let controlDb: ControlDb | null = null;
let env: TestEnv;
let fixture: Server;
let baseUrl = '';
let targetId = '';
let worker: ChildProcess | null = null;
let workerStdout = '';
let workerStderr = '';
let queuePrefix = '';

let mutateHits = 0;

const TRIGGER_FUNCTION = 'phase17_e2_fail_once';
const TRIGGER_NAME = 'phase17_e2_step_invocation_fault';
const FLAG_TABLE = 'phase17_e2_fault_armed';

async function boundedWait(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('bounded wait exhausted before the durable condition held');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  env = loadTestEnv();
  controlDb = createControlDb(env.controlDatabaseUrl);
  queuePrefix = `e2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (req.method === 'POST' && url.pathname === '/mutate') {
      mutateHits += 1;
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mutated: true, echoBytes: body.length }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  for (let attempt = 0; ; attempt += 1) {
    await new Promise<void>((resolve) => {
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address() as AddressInfo;
    const candidate = `http://127.0.0.1:${String(address.port)}`;
    const taken = await prisma().targetOrigin.findUnique({
      where: { origin: candidate },
      select: { id: true },
    });
    if (taken === null) {
      baseUrl = candidate;
      break;
    }
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
    if (attempt >= 15) {
      throw new Error('no unregistered loopback origin for the Checkpoint E2 fixture');
    }
  }

  const displayName = uniqueName('phase17e2-fixture-target');
  const registered = await registerTarget(prisma(), {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
  });
  targetId = registered.targetId;

  worker = spawn(process.execPath, [join('apps', 'worker', 'dist', 'main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: queuePrefix,
      WORKER_CONCURRENCY: '1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_COMMERCE_SIGNING_SECRET: env.commerceSigningSecret,
      COMMERCE_ADMIN_TOKEN: env.commerceAdminToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout?.on('data', (chunk: Buffer) => {
    workerStdout += chunk.toString();
  });
  worker.stderr?.on('data', (chunk: Buffer) => {
    workerStderr += chunk.toString();
  });
  await boundedWait(async () => workerStdout.includes('ready'), 30_000).catch(() => {
    throw new Error(`worker did not start: ${workerStderr || workerStdout}`);
  });
}, 120_000);

afterAll(async () => {
  await dropFault().catch(() => undefined);
  worker?.kill();
  if (fixture !== undefined) {
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
  }
  await controlDb?.disconnect();
});

/** Installs the armed one-shot fault (test-owned; no production path). */
async function armFault(): Promise<void> {
  await prisma().$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${FLAG_TABLE}" (id int PRIMARY KEY, armed boolean NOT NULL)`,
  );
  await prisma().$executeRawUnsafe(
    `INSERT INTO "${FLAG_TABLE}" (id, armed) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET armed = true`,
  );
  await prisma().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${TRIGGER_FUNCTION}"()
    RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "${FLAG_TABLE}" WHERE id = 1 AND armed) THEN
        UPDATE "${FLAG_TABLE}" SET armed = false WHERE id = 1;
        RAISE EXCEPTION 'phase17-e2 controlled post-send persistence failure (test-owned one-shot trigger)';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await prisma().$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${TRIGGER_NAME}" ON "control"."step_invocation"`,
  );
  await prisma().$executeRawUnsafe(
    `CREATE TRIGGER "${TRIGGER_NAME}" BEFORE INSERT ON "control"."step_invocation" FOR EACH ROW EXECUTE FUNCTION "${TRIGGER_FUNCTION}"()`,
  );
}

async function dropFault(): Promise<void> {
  if (controlDb === null) {
    return;
  }
  await prisma().$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${TRIGGER_NAME}" ON "control"."step_invocation"`,
  );
  await prisma().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${TRIGGER_FUNCTION}"()`);
  await prisma().$executeRawUnsafe(`DROP TABLE IF EXISTS "${FLAG_TABLE}"`);
}

describe('E2 · the production processJob catch over the real worker flow', () => {
  it('post-send persistence failure → actual catch → fenced INDETERMINATE terminal, exactly one physical send', async () => {
    mutateHits = 0;
    const created = await createExperiment(prisma(), {
      name: uniqueName('phase17e2-experiment'),
      targetId,
      document: {
        steps: [
          {
            name: 'mutate-only',
            action: {
              method: 'POST',
              relativePath: '/mutate',
              mutation: 'MUTATING',
              contract: 'GENERIC_HTTP',
              body: JSON.stringify({ op: 'e2-mutate' }),
              repeat: 1,
              concurrency: 1,
              retryPolicy: 'NONE',
            },
          },
        ],
      } as never,
    });
    const run = await createRun(prisma(), created.revisionId);
    const runId = run.runId;
    await markRunDispatching(prisma(), runId);
    const stepRun = await prisma().experimentStepRun.findFirstOrThrow({
      where: { runId },
      select: { id: true, sequence: true },
    });

    // Arm the one-shot fault while the worker is idle, then deliver the
    // job over the isolated prefix through the REAL BullMQ queue.
    await armFault();
    try {
      const queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: queuePrefix });
      try {
        await queue.enqueueStep({ runId, stepRunId: stepRun.id, sequence: stepRun.sequence });
      } finally {
        await queue.close();
      }

      // The physical send is the deterministic barrier: the worker must
      // have crossed the send boundary before any persistence failure.
      await boundedWait(async () => mutateHits >= 1, 60_000);
      expect(mutateHits).toBe(1);

      // The fenced emergency terminal lands through the catch (bounded
      // wait on the durable row — never a sleep as evidence).
      await boundedWait(async () => {
        const row = await prisma().experimentStepRun.findUnique({
          where: { id: stepRun.id },
          select: { state: true },
        });
        return row?.state === 'FAILED';
      }, 60_000);

      const terminal = await prisma().experimentStepRun.findUniqueOrThrow({
        where: { id: stepRun.id },
        select: {
          state: true,
          intentOutcome: true,
          sideEffectKnowledge: true,
          attemptCount: true,
          error: true,
          leaseOwnerId: true,
          fencingToken: true,
        },
      });
      expect(terminal.state).toBe('FAILED');
      // F-1 conservative outcome: zero recorded attempts + executingAt
      // stamped ⇒ INDETERMINATE, never KNOWN_ABSENT, never a fabricated
      // KNOWN_OCCURRED.
      expect(terminal.sideEffectKnowledge).toBe('INDETERMINATE');
      expect(terminal.attemptCount).toBe(0);
      expect(terminal.error?.startsWith('step failed before terminal state:')).toBe(true);

      // The sent attempt left NO invocation row (the F-1 case): the
      // trigger aborted the only persistence of the sent attempt.
      const invocations = await prisma().stepInvocation.count({
        where: { stepRunId: stepRun.id },
      });
      expect(invocations).toBe(0);

      // No unsafe retry and no duplicate physical side effect: the hit
      // count is stable over a bounded observation window.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(mutateHits).toBe(1);

      // THE ACTUAL CATCH RAN: its own log line (emitted only in the
      // production processJob catch) names the emergency repair with
      // the INDETERMINATE outcome. No in-test helper call can emit it.
      // (The worker logger writes to stdout; assert on both streams.)
      const workerOutput = `${workerStdout}\n${workerStderr}`;
      expect(workerOutput).toContain('emergency step terminal');
      expect(workerOutput).toContain('INDETERMINATE');

      // No stale worker overwrote the fenced terminal: the row is
      // stable (single generation wrote it; the live lease excluded
      // the sweep for the whole test window).
      const stable = await prisma().experimentStepRun.findUniqueOrThrow({
        where: { id: stepRun.id },
        select: { state: true, sideEffectKnowledge: true, error: true },
      });
      expect(stable).toEqual({
        state: terminal.state,
        sideEffectKnowledge: terminal.sideEffectKnowledge,
        error: terminal.error,
      });

      // Final settled run outcome through the platform's own path.
      await settleRuns(prisma(), 200);
      const settled = await prisma().experimentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { state: true },
      });
      expect(settled.state).toBe('FAILED');
    } finally {
      await dropFault();
    }
    // The fault is fully removed: later suites observe no trigger.
    const triggers = (await prisma().$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = '${TRIGGER_NAME}'`,
    )) as Array<{ n: number }>;
    expect(triggers[0]?.n).toBe(0);
  }, 180_000);
});
