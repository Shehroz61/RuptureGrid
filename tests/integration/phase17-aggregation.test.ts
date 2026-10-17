// =====================================================================
// Integration — Phase 17 final audit §9: step-level knowledge aggregation
// =====================================================================
// The final audit observed a potentially older flaw in the NORMAL
// (non-emergency) path: the wave aggregation was last-outcome-wins, so a
// later sibling invocation's KNOWN_ABSENT could overwrite an earlier
// committed KNOWN_OCCURRED — denying a real effect (an evidence-truth
// violation). The repair aggregates MONOTONICALLY:
//   NOT_APPLICABLE < KNOWN_ABSENT < KNOWN_OCCURRED < INDETERMINATE
// so uncertainty and definite occurrence are never overwritten.
//
// These tests drive the REAL StepProcessor against a REAL HTTP server
// (R-08) and read the REAL durable step row + invocation rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@rupturegrid/control-db';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  StepProcessor,
  createExperiment,
  createRun,
  markRunDispatching,
} from '@rupturegrid/engine';
import { uniqueName } from './helpers/execution-harness.js';
import { loadTestEnv } from './helpers/env.js';
import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';

let prisma: PrismaClient;
let ownedFixture: OwnedControlFixture;

beforeAll(async () => {
  ownedFixture = await createOwnedControlFixture(loadTestEnv());
  prisma = ownedFixture.prisma;
});

const servers: Server[] = [];

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await ownedFixture.close();
});

interface StepHarness {
  readonly runId: string;
  readonly stepRunId: string;
  readonly origin: string;
}

/** The fixture owns the Control namespace; the OS reserves each live port. */
async function listenOnUnregisteredOrigin(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function makeHarness(options: {
  readonly repeat: number;
  readonly concurrency: number;
  readonly origin: string;
}): Promise<StepHarness> {
  const { targetId } = await ownedFixture.acquireTarget(options.origin, {
    displayName: uniqueName('aggregation-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [options.origin],
    contractKind: 'GENERIC_HTTP',
  });
  const created = await createExperiment(prisma, {
    name: uniqueName('aggregation-experiment'),
    targetId,
    document: {
      steps: [
        {
          name: 'mutate',
          action: {
            method: 'POST',
            relativePath: '/checkout/submit',
            headers: { 'content-type': 'application/json' },
            body: '{"checkoutIntentId":"CHK-AGG-1"}',
            mutation: 'MUTATING',
            retryPolicy: 'NONE',
            repeat: options.repeat,
            concurrency: options.concurrency,
            contract: 'GENERIC_HTTP',
          },
        },
      ],
    },
  });
  const run = await createRun(prisma, created.revisionId);
  await markRunDispatching(prisma, run.runId);
  return { runId: run.runId, stepRunId: run.stepRunIds[0] as string, origin: options.origin };
}

function buildProcessor(): StepProcessor {
  return new StepProcessor({
    prisma,
    config: { WORKER_LEASE_DURATION_MS: 30_000, WORKER_HEARTBEAT_INTERVAL_MS: 5_000 },
    credentials: { resolve: () => 'unused' },
  });
}

describe('Phase 17 §9: monotone step-knowledge aggregation (real StepProcessor + real HTTP)', () => {
  it('a later pre-send KNOWN_ABSENT never overwrites an earlier committed KNOWN_OCCURRED', async () => {
    // The server answers the FIRST request (200) and then closes so every
    // later connection is refused (a provably pre-send failure). With
    // concurrency 1 the slots are sequential: slot 0 commits a real
    // effect (KNOWN_OCCURRED), slot 1 fails pre-send (KNOWN_ABSENT).
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end('{"status":"ACCEPTED"}');
      server.close();
      server.closeAllConnections();
    });
    servers.push(server);
    const origin = await listenOnUnregisteredOrigin(server);

    const harness = await makeHarness({ repeat: 2, concurrency: 1, origin });
    const processor = buildProcessor();
    const outcome = await processor.processStep(harness.stepRunId);
    expect(outcome).toBe('FAILED');

    const row = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: harness.stepRunId },
      select: { state: true, sideEffectKnowledge: true, attemptCount: true },
    });
    expect(row.state).toBe('FAILED');
    expect(row.attemptCount).toBe(2);
    // The committed effect is NEVER denied. (last-outcome-wins would have
    // produced KNOWN_ABSENT here.)
    expect(row.sideEffectKnowledge).not.toBe('KNOWN_ABSENT');
    expect(['KNOWN_OCCURRED', 'INDETERMINATE']).toContain(row.sideEffectKnowledge);

    const invocations = await prisma.stepInvocation.findMany({
      where: { stepRunId: harness.stepRunId },
      orderBy: { sequence: 'asc' },
      select: { sideEffectKnowledge: true },
    });
    // Exactly two honest attempts in slot order: slot 0 committed an
    // effect, slot 1 was provably pre-send. This is the exact mixed wave
    // the old last-outcome-wins aggregation falsified as KNOWN_ABSENT.
    expect(invocations.map((invocation) => invocation.sideEffectKnowledge)).toEqual([
      'KNOWN_OCCURRED',
      'KNOWN_ABSENT',
    ]);
    expect(row.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
  }, 60_000);

  it('all slots committed → SUCCEEDED / KNOWN_OCCURRED (baseline unchanged)', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ACCEPTED"}');
    });
    servers.push(server);
    const origin = await listenOnUnregisteredOrigin(server);

    const harness = await makeHarness({ repeat: 2, concurrency: 2, origin });
    const processor = buildProcessor();
    expect(await processor.processStep(harness.stepRunId)).toBe('SUCCEEDED');
    const row = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: harness.stepRunId },
      select: { state: true, sideEffectKnowledge: true, attemptCount: true },
    });
    expect(row.state).toBe('SUCCEEDED');
    expect(row.sideEffectKnowledge).toBe('KNOWN_OCCURRED');
    expect(row.attemptCount).toBe(2);
  }, 60_000);

  it('a single post-send ambiguity → FAILED / INDETERMINATE (never collapsed)', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"status":"ERROR"}');
    });
    servers.push(server);
    const origin = await listenOnUnregisteredOrigin(server);

    const harness = await makeHarness({ repeat: 1, concurrency: 1, origin });
    const processor = buildProcessor();
    expect(await processor.processStep(harness.stepRunId)).toBe('FAILED');
    const row = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: harness.stepRunId },
      select: { sideEffectKnowledge: true },
    });
    expect(row.sideEffectKnowledge).toBe('INDETERMINATE');
  }, 60_000);
});
