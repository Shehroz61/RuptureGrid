// =====================================================================
// Integration helpers — Phase 4 full-stack harness
// =====================================================================
// Boots the REAL compiled worker process (with evidence capture,
// adapter capture, and analysis wired exactly as production) against
// real Control PostgreSQL, real Redis, and the real Demo Fintech app
// over real TCP HTTP (R-08). Creates runs through the REAL Control
// Plane path (registerTarget → createExperiment → createRun →
// markRunDispatching → enqueue).
//
// Canary secrets: helpers generate UNIQUE canary strings that exercise
// credential-bearing locations. Assertions prove those canaries never
// reached any Phase 4 durable store.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { ExecutionQueue } from '@rupturegrid/queue';
import {
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
} from '@rupturegrid/engine';
import type { TestEnv } from './env.js';
import type { RunningDemo } from './demo-harness.js';
import { uniqueName } from './execution-harness.js';

export interface RunningWorker {
  readonly process: ChildProcess;
  close(): Promise<void>;
}

/** Starts the REAL compiled worker process with production wiring. */
export async function startPhase4Worker(
  env: TestEnv,
  options: { leaseMs?: number; extraEnv?: Record<string, string | undefined> } = {},
): Promise<RunningWorker> {
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      // Executor credential VALUES (worker-side only, ADR-0012).
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_INSPECTION_TOKEN: env.demoInspectionToken,
      DEMO_PROVIDER_SIGNING_SECRET: env.demoProviderSigningSecret,
      WORKER_LEASE_DURATION_MS: String(options.leaseMs ?? 10_000),
      WORKER_HEARTBEAT_INTERVAL_MS: '2000',
      WORKER_RECONCILE_INTERVAL_MS: '1000',
      WORKER_CONCURRENCY: '4',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      // Scenario-specific overrides (e.g. breaking ONLY the fault-status
      // inspection credential to prove capture-failure honesty).
      ...options.extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 20_000;
  while (!stdout.includes('ready')) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`worker did not start: ${stderr || stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    process: child,
    async close(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

export interface RegisteredDemoTarget {
  readonly targetId: string;
}

/**
 * Registers the REAL demo target (idempotent by origin) with
 * credential REFERENCES only. A displayName may be supplied (golden
 * suites pass unique names; the golden RUNNER's mode is always an
 * explicit option, never a name convention);
 * a unique default keeps older suites unchanged.
 */
export async function registerDemoTarget(
  prisma: PrismaClient,
  demo: RunningDemo,
  displayName?: string,
): Promise<RegisteredDemoTarget> {
  try {
    const registered = await registerTarget(prisma, {
      displayName: displayName ?? uniqueName('phase4-target'),
      environment: 'LOCAL_DEVELOPMENT',
      origins: [demo.baseUrl],
      contractKind: 'DEMO_FINTECH_WEBHOOK',
      credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_INSPECTION_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'],
    });
    return { targetId: registered.targetId };
  } catch {
    const existing = await prisma.targetRegistration.findFirstOrThrow({
      where: { origins: { some: { origin: demo.baseUrl } } },
    });
    return { targetId: existing.id };
  }
}

export interface FullStackRun {
  readonly runId: string;
  readonly stepRunIds: string[];
}

/**
 * Creates experiment + run through the REAL Control Plane path and
 * enqueues the first step via the real queue.
 */
export async function createAndDispatchRun(
  prisma: PrismaClient,
  queue: ExecutionQueue,
  targetId: string,
  name: string,
  steps: Array<Record<string, unknown>>,
): Promise<FullStackRun> {
  const created = await createExperiment(prisma, {
    name: uniqueName(name),
    targetId,
    document: { steps } as never,
  });
  const run = await createRun(prisma, created.revisionId);
  await markRunDispatching(prisma, run.runId);
  const first = run.stepRunIds[0];
  if (first === undefined) {
    throw new Error('run has no steps');
  }
  await queue.enqueueStep({ runId: run.runId, stepRunId: first, sequence: 0 });
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

/**
 * Standard Incident Zero experiment steps (admin reset, mode, canonical
 * payment create, BOTH provider events delivered signed — confirmed
 * AND settled, the canonical duplicate-credit pressure — and the
 * explicit read-only lineage-capture step). `captureLineage` controls
 * the EXPLICIT evidence adapter declaration (§28/§29).
 */
export function incidentZeroSteps(options: {
  readonly mode: 'VULNERABLE' | 'SECURE';
  readonly repeat?: number;
  readonly concurrency?: number;
  readonly captureLineage?: boolean;
}): Array<Record<string, unknown>> {
  return [
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
    {
      name: 'mode',
      action: {
        method: 'PUT',
        relativePath: '/demo/admin/mode',
        headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
        body: JSON.stringify({ mode: options.mode }),
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_ADMIN_TOKEN'],
      },
    },
    {
      name: 'create-payment',
      action: {
        method: 'POST',
        relativePath: '/demo/provider/payments',
        headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_ADMIN_TOKEN'],
      },
    },
    {
      // Confirmed event under duplicate-delivery pressure.
      name: 'deliver-event-0',
      action: {
        method: 'POST',
        relativePath: '/webhooks/provider',
        headers: { 'x-rupturegrid-provider-signature': '${signature}' },
        body: '${steps.create-payment.response.events[0].payload}',
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      },
    },
    {
      // Settled event once — canonical canonical-payment lineage.
      name: 'deliver-event-1',
      action: {
        method: 'POST',
        relativePath: '/webhooks/provider',
        headers: { 'x-rupturegrid-provider-signature': '${signature}' },
        body: '${steps.create-payment.response.events[1].payload}',
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      },
    },
    {
      // EXPLICIT evidence adapter step (§28/§29): read-only capture of
      // the target's own lineage for the logical payment, identity from
      // the provider's own response via the SAME reference mechanism.
      name: 'capture-lineage',
      action: {
        method: 'GET',
        relativePath: '/health/live',
        mutation: 'READ_ONLY',
        contract: 'DEMO_FINTECH_WEBHOOK',
        ...(options.captureLineage === false
          ? {}
          : {
              evidenceAdapter: {
                kind: 'demo-fintech-payment-lineage' as const,
                providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
              },
            }),
      },
    },
  ];
}
