// =====================================================================
// Integration — Phase 4 evidence capture, redaction, chaining (§16–§24)
// =====================================================================
// REAL full-stack: the compiled worker executes Incident Zero steps
// against the real Demo Fintech app; every invocation observation is
// captured through the production evidence path. Proven here:
//   - raw observations exist for every physical invocation (§12)
//   - the per-run hash chain is gap-free, linked, content-hashed (§20)
//   - credential-bearing material never reaches durable storage (§23)
//   - observation truth rows are append-only at the DATABASE level (§17)
//   - capture failures do not block execution (§12)
//   - the EXPLICIT evidence adapter captures target lineage (§28/§29)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import { canonicalEvidenceHash, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess, createDemoClient } from './helpers/demo-harness.js';
import type { DemoClient, RunningDemo } from './helpers/demo-harness.js';
import { getControlPrisma, requireId, waitFor } from './helpers/execution-harness.js';
import {
  createAndDispatchRun,
  incidentZeroSteps,
  registerDemoTarget,
  startPhase4Worker,
} from './helpers/phase4-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();
const DEMO_P4_PORT = Number(process.env.DEMO_P4_TEST_PORT ?? '3119');

let demo: RunningDemo;
let client: DemoClient;
let controlDb: ControlDb;
let queue: ReturnType<typeof createExecutionQueue>;
let targetId = '';
let worker: Awaited<ReturnType<typeof startPhase4Worker>> | null = null;

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  demo = await startDemoProcess(env, DEMO_P4_PORT);
  client = createDemoClient(demo);
  targetId = (await registerDemoTarget(prisma, demo)).targetId;
}, 60_000);

afterAll(async () => {
  if (worker !== null) {
    await worker.close();
  }
  await queue.close();
  await controlDb.disconnect();
  await demo.close();
});

async function runAndWait(
  name: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ runId: string; stepRunIds: string[] }> {
  worker ??= await startPhase4Worker(env);
  const made = await createAndDispatchRun(prisma, queue, targetId, name, steps);
  await waitFor(
    async () => {
      const row = await prisma.experimentRun.findUnique({ where: { id: made.runId } });
      return row?.state === 'COMPLETED' || row?.state === 'FAILED' ? true : null;
    },
    90_000,
    500,
  );
  const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: made.runId } });
  expect(run.state).toBe('COMPLETED');
  return made;
}

describe('Phase 4 evidence capture (real full stack)', () => {
  it(
    'captures hash-chained, redacted observations for every physical invocation; integrity verifies',
    { timeout: 150_000 },
    async () => {
      await client.reset();
      const made = await runAndWait(
        'p4-capture',
        incidentZeroSteps({ mode: 'SECURE', captureLineage: true }),
      );

      // One observation per invocation: 6 step invocations (reset, mode,
      // create, deliver×2, lineage capture) + the adapter's
      // target_observation.
      const observations = await prisma.rawObservation.findMany({
        where: { runId: made.runId },
        orderBy: { chainIndex: 'asc' },
      });
      expect(observations.length).toBeGreaterThanOrEqual(7);
      expect(observations.every((observation) => observation.origin === 'OBSERVED')).toBe(true);

      // Content hashes are SHA-256 hex over the canonical stored payload.
      for (const observation of observations) {
        expect(observation.contentHash).toMatch(/^[0-9a-f]{64}$/);
        const { hash } = canonicalEvidenceHash(observation.payload);
        expect(hash).toBe(observation.contentHash);
      }

      // Chain: gap-free indices, prev links, head row matches.
      const report = await verifyRunEvidenceChain(prisma, made.runId);
      expect(report.chainValid).toBe(true);
      expect(report.contentHashesValid).toBe(true);
      expect(report.problems).toEqual([]);
      expect(report.guarantee).toContain('intact');

      // Writer provenance: every observation carries the writer owner
      // and a positive fencing token.
      for (const observation of observations) {
        expect(observation.writerOwnerId.length).toBeGreaterThan(0);
        expect(observation.writerFencingToken ?? 0n).toBeGreaterThan(0n);
      }

      // The EXPLICIT adapter captured the target's lineage as a
      // target_observation with the declared adapter kind (§28/§29).
      const lineage = observations.find(
        (observation) =>
          observation.kind === 'target_observation' &&
          observation.adapterKind === 'demo-fintech-payment-lineage',
      );
      expect(lineage).toBeDefined();
      expect(JSON.stringify(lineage?.payload)).toContain('providerPaymentId');
    },
  );

  it(
    'never persists credential-bearing material (REAL credentials through the REAL path)',
    { timeout: 150_000 },
    async () => {
      await client.reset();
      const made = await runAndWait(
        'p4-canary',
        incidentZeroSteps({ mode: 'VULNERABLE', captureLineage: true }),
      );

      const observations = await prisma.rawObservation.findMany({ where: { runId: made.runId } });
      const events = await prisma.normalizedEvent.findMany({ where: { runId: made.runId } });
      const relationships = await prisma.causalRelationship.findMany({
        where: { runId: made.runId },
      });
      const evaluations = await prisma.invariantEvaluation.findMany({
        where: { runId: made.runId },
      });
      const invocations = await prisma.stepInvocation.findMany({
        where: { stepRun: { runId: made.runId } },
      });

      // The REAL credential values from the REAL worker env must appear
      // in NONE of the durable Phase 4 stores (nor Phase 3 rows).
      for (const secret of [
        env.demoAdminToken,
        env.demoInspectionToken,
        env.demoProviderSigningSecret,
      ]) {
        const haystacks = [
          JSON.stringify(observations.map((row) => row.payload)),
          JSON.stringify(events.map((row) => row.payload)),
          JSON.stringify(relationships.map((row) => row.evidenceJson)),
          JSON.stringify(evaluations.map((row) => row.details)),
          JSON.stringify(invocations.map((row) => row.responseBody)),
        ];
        for (const haystack of haystacks) {
          expect(haystack).not.toContain(secret);
        }
      }

      // The Authorization header value was replaced by the marker.
      const withAuth = observations.find((observation) =>
        JSON.stringify(observation.payload).includes('authorization'),
      );
      expect(withAuth).toBeDefined();
      const payload = withAuth?.payload as {
        http?: { requestHeaders?: Record<string, string> };
      };
      expect(payload.http?.requestHeaders?.['authorization']).toBe('[Redacted]');
    },
  );

  it('observation truth rows are append-only AT THE DATABASE LEVEL (triggers)', async () => {
    // Created WITHOUT dispatch: no worker runs, so the only observation
    // in this run is the one appended below (deterministic assertions).
    const { createExperiment, createRun } = await import('@rupturegrid/engine');
    const { RawObservationStore } = await import('@rupturegrid/evidence');
    const created = await createExperiment(prisma, {
      name: `p4-appendonly-${Date.now()}`,
      targetId,
      document: {
        steps: [
          {
            name: 'only',
            action: {
              method: 'GET',
              relativePath: '/health/live',
              mutation: 'READ_ONLY',
              contract: 'DEMO_FINTECH_WEBHOOK',
            },
          },
        ],
      } as never,
    });
    const made = await createRun(prisma, created.revisionId);
    const store = new RawObservationStore(prisma);
    const observation = {
      runId: made.runId,
      stepRunId: requireId(made.stepRunIds[0], 'first step run'),
      invocationId: null,
      invocationIdentity: `D-appendonly-${Date.now()}`,
      sequence: 0,
      waveIndex: 0,
      method: 'GET' as const,
      relativePath: '/health/live',
      requestHeaders: {},
      requestBody: null,
      transportStage: 'RESPONSE_COMPLETE',
      httpStatus: 200,
      responseHeaders: null,
      responseBody: null,
      responseTruncated: false,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
      outcome: 'SUCCEEDED' as const,
      error: null,
      observedAt: new Date(),
    };
    await store.appendInvocationObservation({
      observation,
      writerOwnerId: `writer-appendonly-${Date.now()}`,
      writerFencingToken: '1',
    });
    const row = await prisma.rawObservation.findFirstOrThrow({
      where: { runId: made.runId },
    });
    // UPDATE of truth columns must be rejected by the DB trigger.
    await expect(
      prisma.rawObservation.update({
        where: { id: row.id },
        data: { payload: { tampered: true } },
      }),
    ).rejects.toThrow();
    // DELETE must be rejected as well.
    await expect(prisma.rawObservation.delete({ where: { id: row.id } })).rejects.toThrow();
    // The row is untouched.
    const after = await prisma.rawObservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.contentHash).toBe(row.contentHash);
  });

  it('capture failure never blocks execution (honest incompleteness)', async () => {
    await client.reset();
    // A broken sink must not prevent the step from completing. The run
    // is created WITHOUT dispatch (no queue claim race); the step is
    // processed in-process through the real StepProcessor.
    const { createExperiment, createRun, StepProcessor, createDemoCredentialResolver } =
      await import('@rupturegrid/engine');
    const processor = new StepProcessor({
      prisma,
      config: { WORKER_LEASE_DURATION_MS: 10_000, WORKER_HEARTBEAT_INTERVAL_MS: 2_000 },
      credentials: createDemoCredentialResolver({
        DEMO_ADMIN_TOKEN: env.demoAdminToken,
        DEMO_INSPECTION_TOKEN: env.demoInspectionToken,
        DEMO_PROVIDER_SIGNING_SECRET: env.demoProviderSigningSecret,
      }),
      evidenceSink: {
        async captureInvocation() {
          throw new Error('simulated evidence outage');
        },
      },
    });
    const created = await createExperiment(prisma, {
      name: `p4-capturefail-${Date.now()}`,
      targetId,
      document: {
        steps: [
          {
            name: 'reset',
            action: {
              method: 'POST',
              relativePath: '/demo/admin/reset',
              headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
              mutation: 'MUTATING',
              contract: 'DEMO_FINTECH_WEBHOOK',
              credentialRefs: ['DEMO_ADMIN_TOKEN'],
            },
          },
        ],
      } as never,
    });
    const run = await createRun(prisma, created.revisionId);
    const stepRunId = run.stepRunIds[0];
    if (stepRunId === undefined) {
      throw new Error('run has no steps');
    }
    // Execute IN-PROCESS with the failing sink.
    await processor.processStep(stepRunId);
    const step = await prisma.experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
    });
    expect(step.state).toBe('SUCCEEDED');
  });
});
