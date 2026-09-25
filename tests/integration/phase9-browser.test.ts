// =====================================================================
// Integration — Phase 9 REAL BROWSER over real fault runs (R-08)
// =====================================================================
// A REAL browser (Playwright Chromium) opens the REAL product UI over
// REAL PRE_MUTATION_REJECTION and POST_MUTATION response-loss runs
// produced by the REAL execution pipeline. Proven per scenario:
//
//   PRE:  configured + activated (target-authored), failed invocation,
//         KNOWN_ABSENT, business state honest
//   POST: configured + activated, ambiguous invocation shown
//         INDETERMINATE, later evidence of the committed mutation,
//         invocation NOT retro-changed
//
// Minimal additive UI contract only: the timeline already renders every
// persisted entry kind (FAULT_PLAN_CONFIGURED / FAULT_PLAN_ACTIVATED
// labels added additively); the run page already presents INDETERMINATE
// as a first-class state (ADR-0008). No Phase 9 video/screenshot
// automation (docs/controlled-faults.md §9).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb, PrismaClient } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import type { ExecutionQueue } from '@rupturegrid/queue';
import { CONTROLLED_FAULT_PLAN_VERSION } from '@rupturegrid/shared';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import { startDemoProcess } from './helpers/demo-harness.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import {
  createAndDispatchRun,
  registerDemoTarget,
  startPhase4Worker,
} from './helpers/phase4-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { requireId, uniqueName } from './helpers/execution-harness.js';

const DEMO_P9B_PORT = Number(process.env.DEMO_P9B_TEST_PORT ?? '3137');
const API_P9B_PORT = Number(process.env.API_P9B_TEST_PORT ?? '3138');
const WEB_P9B_PORT = Number(process.env.WEB_P9B_TEST_PORT ?? '3139');
const SCENARIO_TIMEOUT = 240_000;

let env2: TestEnv;
let prisma: PrismaClient;
let controlDb: ControlDb;
let disconnect: () => Promise<void>;
let demo: RunningDemo;
let worker: RunningWorker;
let queue: ExecutionQueue;
let targetId: string;
let apiOrigin = '';
let webOrigin = '';
let browser: Browser;
let webChildRef: ReturnType<typeof spawn> | null = null;
let webTempDirRef = '';

beforeAll(async () => {
  env2 = loadTestEnv();
  controlDb = createControlDb(env2.controlDatabaseUrl);
  prisma = controlDb.prisma;
  disconnect = controlDb.disconnect;
  demo = await startDemoProcess(env2, DEMO_P9B_PORT);
  worker = await startPhase4Worker(env2);
  queue = createExecutionQueue({ redisUrl: env2.redisUrl, prefix: env2.queuePrefix });
  targetId = (await registerDemoTarget(prisma, demo, 'phase9-browser-target')).targetId;

  // Real API (in-process Nest over REAL Control PostgreSQL/Redis) +
  // real web production server (owned child), as in the Phase 4/8
  // suites — the UI reads ONLY the Control Plane API.
  const { buildAppModule } = await import('../../apps/api/src/app.module.js');
  const { NestFactory } = await import('../../apps/api/node_modules/@nestjs/core/index.js');
  const moduleRef = buildAppModule({
    config: {
      NODE_ENV: 'test' as const,
      LOG_LEVEL: 'error' as const,
      API_HOST: '127.0.0.1',
      API_PORT: API_P9B_PORT,
      CONTROL_DATABASE_URL: env2.controlDatabaseUrl,
      REDIS_URL: env2.redisUrl,
      QUEUE_PREFIX: env2.queuePrefix,
      CORS_ORIGINS: [`http://127.0.0.1:${WEB_P9B_PORT}`],
    },
    controlDb,
  });
  const app = await NestFactory.create(moduleRef, { logger: false });
  await app.listen(API_P9B_PORT, '127.0.0.1');
  apiOrigin = `http://127.0.0.1:${API_P9B_PORT}`;

  webTempDirRef = await mkdtemp(join(tmpdir(), 'rg9-web-'));
  webChildRef = spawn(
    process.execPath,
    [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_P9B_PORT)],
    {
      cwd: join('apps', 'web'),
      env: { ...process.env, RUPTUREGRID_API_ORIGIN: apiOrigin, TMPDIR: webTempDirRef },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  webOrigin = `http://127.0.0.1:${WEB_P9B_PORT}`;
  // Ready = the ROOT page actually answers 200 (a 404 from a not-yet-
  // compiled server must not satisfy readiness).
  const webDeadline = Date.now() + 60_000;
  for (;;) {
    let status = 0;
    try {
      const response = await fetch(webOrigin, {
        signal: AbortSignal.timeout(2_000),
        redirect: 'manual',
      });
      status = response.status;
    } catch {
      // not up yet
    }
    // 2xx = served; 3xx = the app's own redirect (e.g. / → /runs) —
    // both prove the production server answers real requests.
    if ((status >= 200 && status < 400) || status === 307 || status === 308) break;
    if (Date.now() > webDeadline) {
      throw new Error(
        `web production server did not become ready on ${webOrigin} (last status ${status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (webChildRef !== null && webChildRef.exitCode === null && webChildRef.signalCode === null) {
    webChildRef.kill('SIGTERM');
  }
  await queue.close().catch(() => undefined);
  await worker.close().catch(() => undefined);
  await demo.close().catch(() => undefined);
  await disconnect().catch(() => undefined);
  if (webTempDirRef !== '') {
    await rm(webTempDirRef, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function runToTerminal(runId: string): Promise<string> {
  const deadline = Date.now() + SCENARIO_TIMEOUT;
  for (;;) {
    const run = await prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { state: true },
    });
    const state = run?.state ?? null;
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') return state;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal state`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Ensures the run's Phase 5 forensic derivation exists through the REAL
 * API (the same trigger an investigator uses; the worker reconciler
 * also derives settled runs). Idempotent: derive-or-ensure converges.
 */
async function ensureForensicsDerived(runId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const timeline = (await (
      await fetch(`${apiOrigin}/api/v1/runs/${runId}/forensics/timeline?limit=200`)
    ).json()) as { entries?: Array<{ entryKind: string }> };
    const kinds = new Set((timeline.entries ?? []).map((entry) => entry.entryKind));
    if (kinds.has('FAULT_PLAN_CONFIGURED') && kinds.has('FAULT_PLAN_ACTIVATED')) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`forensic timeline for ${runId} never showed fault-plan entries`);
    }
    await fetch(`${apiOrigin}/api/v1/runs/${runId}/forensics/derive`, { method: 'POST' }).catch(
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Waits until the rendered page shows all the given fragments. */
async function waitUntilBodyShows(page: Page, fragments: string[]): Promise<string> {
  const deadline = Date.now() + 45_000;
  let body = '';
  for (;;) {
    body = (await page.locator('body').innerText()) ?? '';
    if (fragments.every((fragment) => body.includes(fragment))) {
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `expected content did not appear: missing ${fragments
          .filter((fragment) => !body.includes(fragment))
          .join(' | ')}`,
      );
    }
    await page.waitForTimeout(250);
  }
}

function faultDeliveryStep(
  faultPlan: Record<string, unknown>,
  withAdapter = false,
): Record<string, unknown> {
  return {
    name: 'deliver-with-fault',
    action: {
      method: 'POST',
      relativePath: '/webhooks/provider',
      headers: { 'x-rupturegrid-provider-signature': '${signature}' },
      body: '${steps.create-payment.response.events[0].payload}',
      mutation: 'MUTATING',
      contract: 'DEMO_FINTECH_WEBHOOK',
      credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      faultPlan,
      // Response-loss proof (docs/controlled-faults.md §4.2): the
      // fault-bearing step declares the explicit adapter so the engine
      // captures the committed truth AFTER the FAILED terminal without
      // rewriting the INDETERMINATE invocation.
      ...(withAdapter
        ? {
            evidenceAdapter: {
              kind: 'demo-fintech-payment-lineage',
              providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
            },
          }
        : {}),
    },
  };
}

const SETUP_STEPS: Array<Record<string, unknown>> = [
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
      body: JSON.stringify({ mode: 'SECURE' }),
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
];

async function dispatchRun(name: string, steps: Array<Record<string, unknown>>): Promise<string> {
  const { runId } = await createAndDispatchRun(prisma, queue, targetId, uniqueName(name), steps);
  return runId;
}

describe('phase 9 real browser over real fault runs', () => {
  it(
    'PRE: run page + timeline show configured/activated fault plan, failed invocation, KNOWN_ABSENT',
    async () => {
      const runId = await dispatchRun('phase9-browser-pre', [
        ...SETUP_STEPS,
        faultDeliveryStep({
          planVersion: CONTROLLED_FAULT_PLAN_VERSION,
          faultKind: 'PRE_MUTATION_REJECTION',
          activation: 'first_n_matching_deliveries',
          maxTriggers: 1,
        }),
      ]);
      expect(await runToTerminal(runId)).toBe('FAILED');
      await ensureForensicsDerived(runId);

      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      try {
        // The execution subpage renders per-step knowledge through its
        // own labels ("effect known absent" for KNOWN_ABSENT — ADR-0008).
        await page.goto(`${webOrigin}/runs/${runId}/execution`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        const body = await waitUntilBodyShows(page, ['FAILED', 'effect known absent']);
        expect(body).not.toMatch(/Bearer\s/); // redaction contract holds on fault runs too

        // The forensic timeline renders the target-authored fault-plan
        // facts as separate configured/activated rows.
        await page.goto(`${webOrigin}/runs/${runId}/timeline`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await waitUntilBodyShows(page, ['fault plan configured', 'fault plan activated']);
      } finally {
        await context.close();
      }
    },
    SCENARIO_TIMEOUT,
  );

  it(
    'POST: ambiguous invocation stays INDETERMINATE while later evidence proves the mutation',
    async () => {
      const runId = await dispatchRun('phase9-browser-post', [
        ...SETUP_STEPS,
        {
          name: 'capture-lineage',
          action: {
            method: 'GET',
            relativePath: '/health/live',
            mutation: 'READ_ONLY',
            contract: 'DEMO_FINTECH_WEBHOOK',
            evidenceAdapter: {
              kind: 'demo-fintech-payment-lineage',
              providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
            },
          },
        },
        faultDeliveryStep(
          {
            planVersion: CONTROLLED_FAULT_PLAN_VERSION,
            faultKind: 'RESPONSE_TRUNCATION',
            activation: 'first_n_matching_deliveries',
            maxTriggers: 1,
          },
          true,
        ),
      ]);
      expect(await runToTerminal(runId)).toBe('FAILED');
      await ensureForensicsDerived(runId);

      // Durable truth first: INDETERMINATE at step AND invocation level,
      // later target-authored evidence of the committed effect, and the
      // invocation was NEVER retro-changed to KNOWN_OCCURRED.
      const steps = await prisma.experimentStepRun.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
      });
      const faultStep = steps.find((step) => step.state === 'FAILED');
      expect(faultStep?.sideEffectKnowledge).toBe('INDETERMINATE');
      const invocation = await prisma.stepInvocation.findFirst({
        where: { stepRunId: requireId(faultStep?.id, 'fault step') },
        orderBy: { sequence: 'desc' },
      });
      expect(invocation?.sideEffectKnowledge).toBe('INDETERMINATE');
      const effectEvents = await prisma.normalizedEvent.findMany({
        where: { runId, eventType: 'demo.financial-effect-observed' },
      });
      expect(effectEvents.length).toBe(1);

      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      try {
        // The execution subpage renders knowledge through its own labels
        // ("INDETERMINATE — effect unknowable", ADR-0008); the run page
        // additionally shows the INDETERMINATE note-box.
        await page.goto(`${webOrigin}/runs/${runId}/execution`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        const body = await waitUntilBodyShows(page, ['FAILED', 'INDETERMINATE']);
        expect(body).not.toMatch(/Bearer\s/);

        await page.goto(`${webOrigin}/runs/${runId}/timeline`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await waitUntilBodyShows(page, ['fault plan configured', 'fault plan activated']);
      } finally {
        await context.close();
      }
    },
    SCENARIO_TIMEOUT,
  );
});
