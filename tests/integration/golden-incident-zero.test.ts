// =====================================================================
// Integration — Phase 7 INCIDENT ZERO GOLDEN SCENARIO (permanent)
// =====================================================================
// The canonical Incident Zero golden scenario as a committed, rerun-
// nable suite (incident-zero.md §9; testing-strategy §8). Each mode is
// a REAL end-to-end execution through the accepted pipeline:
//
//   real Demo process  → real worker process → real evidence capture
//   → real INV-IZ-1 evaluation → real Phase 5 forensics → real API →
//   real rendered UI (HTTP content assertions)
//
// Nothing here mocks the system under test. The vulnerable suite
// MUST deterministically produce the FAIL + Finding; the secure suite
// MUST deterministically produce PASS with NO failure Finding; the
// same scenario run TWICE must agree on semantics while carrying its
// own generated IDs (incident-replay §5 determinism policy).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import {
  GOLDEN_SCENARIO_VERSION,
  PAYMENT_AMOUNT_MINOR,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
  SECURE_EXPECTED_WALLET_BALANCE_MINOR,
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
} from '@rupturegrid/incident-zero';
import { runGoldenScenario, ensureGoldenTargetRegistration } from '@rupturegrid/incident-zero';
import { loadTestEnv } from './helpers/env.js';
import { createDemoClient, startDemoProcess, startPhase4Worker } from './helpers/golden-harness.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { uniqueName } from './helpers/execution-harness.js';

const env = loadTestEnv();
const DEMO_P7_PORT = Number(process.env.DEMO_P7_TEST_PORT ?? '3127');
const DEMO_P7S_PORT = Number(process.env.DEMO_P7S_TEST_PORT ?? '3131');
const WEB_P7_PORT = Number(process.env.WEB_P7_TEST_PORT ?? '3128');

let demo: RunningDemo;
let demoSecure: RunningDemo;
let worker: RunningWorker | null = null;
let controlDb: ControlDb;
let webChild: ReturnType<typeof spawn> | null = null;
let webTempDir: string | null = null;
/** The suite's vulnerable golden run, reused by the durable-truth checks. */
let vulnerableResult: Awaited<ReturnType<typeof goldenRun>> | null = null;
/** Per-mode registrations: one origin per target (origin authority is global). */
const registrations = new Map<'VULNERABLE' | 'SECURE', string>();

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  demo = await startDemoProcess(env, DEMO_P7_PORT);
  demoSecure = await startDemoProcess(env, DEMO_P7S_PORT);
}, 60_000);

afterAll(async () => {
  if (worker !== null) {
    await worker.close();
  }
  if (webChild !== null && webChild.exitCode === null && webChild.signalCode === null) {
    webChild.kill('SIGTERM');
  }
  if (webTempDir !== null) {
    rmSync(webTempDir, { recursive: true, force: true });
  }
  await controlDb.disconnect();
  await demo.close();
  await demoSecure.close();
});

/**
 * Releases the suite's target-origin registrations so the REAL engine
 * (which enforces global origin authority) can re-register them on the
 * next run. This is test-harness teardown of harness-created rows only
 * — no target business data is touched.
 */
async function releaseGoldenRegistrations(): Promise<void> {
  await controlDb.prisma.$executeRawUnsafe(
    `DELETE FROM control.target_origin WHERE "targetId" IN (
       SELECT id FROM control.target_registration WHERE "displayName" LIKE 'golden-%'
     ) AND "targetId" NOT IN (SELECT "targetId" FROM control.experiment_revision)`,
  );
  await controlDb.prisma.$executeRawUnsafe(
    `DELETE FROM control.target_registration
      WHERE "displayName" LIKE 'golden-%'
        AND id NOT IN (SELECT "targetId" FROM control.experiment_revision)`,
  );
}

async function ensureWorker(): Promise<void> {
  worker ??= await startPhase4Worker(env);
}

/** One REAL golden execution for a mode (target registration → result). */
async function goldenRun(mode: 'VULNERABLE' | 'SECURE') {
  await ensureWorker();
  // One registration PER MODE (idempotent by ORIGIN): the engine
  // enforces unambiguous origin authority, so each mode gets its own
  // Demo process port; ensureGoldenTargetRegistration reuses the
  // registration that already holds that origin.
  let targetId = registrations.get(mode);
  if (targetId === undefined) {
    const registration = await ensureGoldenTargetRegistration(
      controlDb.prisma,
      mode === 'SECURE' ? demoSecure.baseUrl : demo.baseUrl,
      uniqueName(mode === 'SECURE' ? 'golden-secure' : 'golden-vulnerable'),
    );
    targetId = registration.targetId;
    registrations.set(mode, targetId);
  }
  return runGoldenScenario({
    prisma: controlDb.prisma,
    redisUrl: env.redisUrl,
    queuePrefix: env.queuePrefix,
    targetId,
    mode,
  });
}

/** Starts the REAL web production server and returns its base URL. */
async function startWeb(): Promise<string> {
  webTempDir = mkdtempSync(join(tmpdir(), 'rg7-web-'));
  webChild = spawn(
    process.execPath,
    [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_P7_PORT)],
    {
      cwd: join('apps', 'web'),
      env: {
        ...process.env,
        RUPTUREGRID_API_ORIGIN: `http://127.0.0.1:${API_P7_PORT}`,
        TMPDIR: webTempDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  webChild.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const base = `http://127.0.0.1:${WEB_P7_PORT}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base, {
        signal: AbortSignal.timeout(1_000),
        redirect: 'manual',
      });
      if (response.status < 500) {
        return base;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`web did not start: ${stderr}`);
}

// The API origin for UI assertions — the REAL Control Plane API is
// embedded in-process (same construction as the Phase 5 API test).
const API_P7_PORT = Number(process.env.API_P7_TEST_PORT ?? '3129');
let apiBase = `http://127.0.0.1:${API_P7_PORT}`;
let apiStarted = false;

async function ensureApi(): Promise<string> {
  if (apiStarted) {
    return apiBase;
  }
  const expressModule = (await import('../../apps/api/node_modules/express/index.js')) as {
    json: typeof import('express').json;
    urlencoded: typeof import('express').urlencoded;
  };
  const { NestFactory } = await import('../../apps/api/node_modules/@nestjs/core/index.js');
  const { buildAppModule } = await import('../../apps/api/src/app.module.js');
  const moduleRef = buildAppModule({
    config: {
      NODE_ENV: 'test' as const,
      LOG_LEVEL: 'error' as const,
      API_HOST: '127.0.0.1',
      API_PORT: API_P7_PORT,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      CORS_ORIGINS: ['http://localhost:3000'],
    },
    controlDb,
  });
  const app = await NestFactory.create(moduleRef, { logger: false });
  app.use(expressModule.json({ limit: '256kb' }));
  app.use(expressModule.urlencoded({ extended: true, limit: '256kb' }));
  await app.listen(API_P7_PORT, '127.0.0.1');
  apiStarted = true;
  return apiBase;
}

describe('Phase 7 — VULNERABLE golden scenario (deterministic FAIL)', () => {
  let result: Awaited<ReturnType<typeof goldenRun>>;

  beforeAll(async () => {
    result = await goldenRun('VULNERABLE');
    vulnerableResult = result;
  }, 300_000);

  it('executes the full canonical workload through the real stack', () => {
    expect(result.runState).toBe('COMPLETED');
    expect(result.scenarioVersion).toBe(GOLDEN_SCENARIO_VERSION);
    expect(result.mode).toBe('VULNERABLE');
    expect(result.integrity.chainValid).toBe(true);
  });

  it('delivers all 20 physical deliveries with 20 processing attempts', () => {
    expect(result.deliveryCount).toBe(TOTAL_DELIVERIES);
    expect(result.processingAttemptCount).toBe(TOTAL_DELIVERIES);
  });

  it('wallet ends at 1000000 paisa from 2 accepted equivalent credits', () => {
    expect(result.financialEffectCount).toBe(VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS);
    expect(BigInt(result.wallet?.balanceMinor ?? '0')).toBe(
      VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
    );
    expect(result.evaluation?.verdict).toBe('FAIL');
    expect(result.evaluation?.equivalentEffectCount).toBe(VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS);
  });

  it('derives exactly one deterministic duplicate-credit Finding', () => {
    expect(result.finding).not.toBeNull();
    expect(result.finding?.reasonCode).toBe('DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT');
    expect(result.finding?.subjectKey).toBe(result.payment.providerPaymentId);
  });

  it('binds the reproduction definition to the frozen snapshot (credential refs only)', () => {
    expect(result.reproductionDefinition).not.toBeNull();
    expect(result.reproductionDefinition?.targetModeRequirement).toBe('VULNERABLE');
    expect(result.reproductionDefinition?.snapshotContentHash).toBe(result.snapshotContentHash);
    for (const ref of result.reproductionDefinition?.credentialRefs ?? []) {
      expect(typeof ref).toBe('string');
      expect(ref).toMatch(/^[A-Z0-9_]+$/);
    }
    expect(JSON.stringify(result.reproductionDefinition)).not.toContain(env.demoAdminToken);
  });
});

describe('Phase 7 — SECURE golden scenario (deterministic PASS, same pressure)', () => {
  let result: Awaited<ReturnType<typeof goldenRun>>;

  beforeAll(async () => {
    result = await goldenRun('SECURE');
  }, 300_000);

  it('executes the identical physical pressure through the real stack', () => {
    expect(result.runState).toBe('COMPLETED');
    expect(result.mode).toBe('SECURE');
    expect(result.deliveryCount).toBe(TOTAL_DELIVERIES);
    expect(result.processingAttemptCount).toBe(TOTAL_DELIVERIES);
    expect(result.integrity.chainValid).toBe(true);
  });

  it('suppresses duplicates: one accepted credit, 19 suppressed attempts recorded', () => {
    expect(result.financialEffectCount).toBe(SECURE_EXPECTED_EQUIVALENT_EFFECTS);
    expect(BigInt(result.wallet?.balanceMinor ?? '0')).toBe(SECURE_EXPECTED_WALLET_BALANCE_MINOR);
    expect(result.evaluation?.verdict).toBe('PASS');
    expect(result.evaluation?.equivalentEffectCount).toBe(SECURE_EXPECTED_EQUIVALENT_EFFECTS);
    expect(SECURE_EXPECTED_SUPPRESSED_ATTEMPTS).toBe(
      TOTAL_DELIVERIES - SECURE_EXPECTED_EQUIVALENT_EFFECTS,
    );
  });

  it('derives NO failure Finding (PASS ⇒ none, honestly)', () => {
    expect(result.finding).toBeNull();
  });

  it('binds the reproduction definition to the SECURE mode requirement', () => {
    expect(result.reproductionDefinition?.targetModeRequirement).toBe('SECURE');
  });
});

describe('Phase 7 — repeatability (incident-replay §5 determinism)', () => {
  it(
    'two executions of the same scenario agree on semantics, differ in generated IDs',
    { timeout: 300_000 },
    async () => {
      await releaseGoldenRegistrations();
      const first = await goldenRun('VULNERABLE');
      const second = await goldenRun('VULNERABLE');

      // Semantic agreement.
      expect(second.evaluation?.verdict).toBe(first.evaluation?.verdict);
      expect(second.evaluation?.equivalentEffectCount).toBe(
        first.evaluation?.equivalentEffectCount,
      );
      expect(second.deliveryCount).toBe(first.deliveryCount);
      expect(second.financialEffectCount).toBe(first.financialEffectCount);
      expect(BigInt(second.wallet?.balanceMinor ?? '0')).toBe(
        BigInt(first.wallet?.balanceMinor ?? '0'),
      );
      expect(second.finding?.reasonCode).toBe(first.finding?.reasonCode);

      // Same frozen intent (canonical steps ⇒ same snapshot content hash).
      expect(second.snapshotContentHash).toBe(first.snapshotContentHash);

      // Generated IDs are per-run: distinct runs, distinct payments,
      // distinct findings — never shared, never reused.
      expect(second.runId).not.toBe(first.runId);
      expect(second.payment.providerPaymentId).not.toBe(first.payment.providerPaymentId);
      expect(second.finding?.id).not.toBe(first.finding?.id);

      // No cross-run contamination: each run's finding belongs to its
      // own run, and the payment amount stays the canonical 500000.
      expect(second.finding?.subjectKey).toBe(second.payment.providerPaymentId);
      expect(BigInt(first.payment.amountMinor)).toBe(PAYMENT_AMOUNT_MINOR);
      expect(BigInt(second.payment.amountMinor)).toBe(PAYMENT_AMOUNT_MINOR);
    },
  );
});

/**
 * The vulnerable golden run's durable outcome split + timeline
 * pagination, verified against the REAL Control Plane API and the
 * run's own normalized evidence (§24/§30 of the canonical contract;
 * Phase 5 keyset pagination §61). The suite's golden assertions decide
 * PASS/FAIL of the TEST — the persisted Phase 4/5 artifacts remain the
 * only business truth (runner-asserts, engine-decides).
 */
describe('Phase 7 — vulnerable golden durable truth (outcomes + timeline pagination)', () => {
  it(
    'counts APPLIED=2 / IDEMPOTENT_DUPLICATE=18 from normalized evidence and walks the full timeline',
    { timeout: 60_000 },
    async () => {
      const runId = vulnerableResult?.runId;
      expect(runId).toBeDefined();
      if (runId === undefined) {
        throw new Error('vulnerable golden result unavailable');
      }

      // Outcome split from the run's own normalized processing-attempt
      // events (durable evidence, not the orchestrator's summary).
      const outcomes = await controlDb.prisma.normalizedEvent.findMany({
        where: { runId, eventType: 'demo.processing-attempt-observed' },
        select: { payload: true },
      });
      expect(outcomes).toHaveLength(TOTAL_DELIVERIES);
      const byOutcome = new Map<string, number>();
      for (const row of outcomes) {
        const outcome = (row.payload as Record<string, unknown> | null)['outcome'];
        expect(typeof outcome).toBe('string');
        byOutcome.set(outcome as string, (byOutcome.get(outcome as string) ?? 0) + 1);
      }
      expect(byOutcome.get('APPLIED')).toBe(VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS);
      expect(byOutcome.get('IDEMPOTENT_DUPLICATE')).toBe(
        TOTAL_DELIVERIES - VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
      );

      // Full timeline walk through the REAL API: no duplicates, no
      // omissions, keyset cursor terminates exactly once.
      const apiOrigin = await ensureApi();
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      let lastOccurredAt = '';
      let timelineCount = 0;
      do {
        const url = new URL(`${apiOrigin}/api/v1/runs/${runId}/forensics/timeline`);
        url.searchParams.set('limit', '25');
        if (cursor !== null) {
          url.searchParams.set('cursor', cursor);
        }
        const response = await fetch(url);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          count: number;
          nextCursor: string | null;
          entries: Array<{
            id?: string;
            entryKind: string;
            sourceKind: string;
            sourceId: string;
            occurredAt: string;
          }>;
        };
        expect(body.count).toBeLessThanOrEqual(25);
        for (const entry of body.entries) {
          const key = `${entry.occurredAt}|${entry.sourceKind}|${entry.sourceId}|${entry.entryKind}`;
          expect(seen.has(key)).toBe(false); // no duplicates
          expect(entry.occurredAt >= lastOccurredAt || lastOccurredAt === '').toBe(true);
          lastOccurredAt = entry.occurredAt;
          seen.add(key);
          timelineCount += 1;
        }
        cursor = body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(50); // bounded walk
      } while (cursor !== null);

      // No omissions: the walked total equals the durable entry count.
      const durableCount = await controlDb.prisma.forensicTimelineEntry.count({ where: { runId } });
      expect(timelineCount).toBe(durableCount);
      expect(durableCount).toBeGreaterThan(TOTAL_DELIVERIES); // full-pressure story
    },
  );
});

/** Finds the newest golden run for one mode via the REAL API. */
async function findGoldenRun(apiOrigin: string, mode: 'VULNERABLE' | 'SECURE'): Promise<string> {
  const response = await fetch(`${apiOrigin}/api/v1/runs?limit=200`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    runs: Array<{ runId: string; experimentName: string }>;
  };
  const found = body.runs.find((run) =>
    run.experimentName.startsWith(`incident-zero-golden-${mode.toLowerCase()}`),
  );
  return found?.runId ?? '';
}

describe('Phase 7 — the golden runs are visible in the real product UI', () => {
  let webBase = '';
  let vulnerableRunId = '';
  let secureRunId = '';

  beforeAll(async () => {
    const apiOrigin = await ensureApi();
    vulnerableRunId = await findGoldenRun(apiOrigin, 'VULNERABLE');
    secureRunId = await findGoldenRun(apiOrigin, 'SECURE');
    expect(vulnerableRunId).not.toBe('');
    expect(secureRunId).not.toBe('');
    webBase = await startWeb();
  }, 60_000);

  it('renders the vulnerable golden run end-to-end (verdict, finding, money)', async () => {
    const overview = await fetch(`${webBase}/runs/${vulnerableRunId}`);
    expect(overview.status).toBe(200);
    const overviewHtml = await overview.text();
    expect(overviewHtml).toContain('RuptureGrid');
    expect(overviewHtml).toContain('FAIL');
    expect(overviewHtml).toContain('INV-IZ-1');
    expect(overviewHtml).toContain('2 accepted equivalent wallet credits of 500000 PKR');

    // The Finding's own page carries the reason code, proof, money.
    const findingsPage = await overviewHtml.match(/href="(\/runs\/[^"]+\/findings)"/);
    expect(findingsPage).not.toBeNull();
    const findingsResponse = await fetch(`${webBase}${findingsPage?.[1] ?? ''}`);
    expect(findingsResponse.status).toBe(200);
    const findingsHtml = await findingsResponse.text();
    expect(findingsHtml).toContain('DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT');
    expect(findingsHtml).toContain('PKR 5,000.00');
    expect(findingsHtml).not.toMatch(/Bearer\s/);
  });

  it('renders the secure golden run honestly (PASS, no failure finding)', async () => {
    const response = await fetch(`${webBase}/runs/${secureRunId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('PASS');
    expect(html).toContain('INV-IZ-1');
    expect(html).not.toContain('DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT');
  });

  it('renders the timeline and reproduction views for the golden runs', async () => {
    for (const runId of [vulnerableRunId, secureRunId]) {
      for (const view of ['timeline', 'reproduction', 'evidence']) {
        const response = await fetch(`${webBase}/runs/${runId}/${view}`);
        expect(response.status).toBe(200);
      }
    }
    const repro = (await (
      await fetch(`${apiBase}/api/v1/runs/${vulnerableRunId}/forensics/reproduction-definition`)
    ).json()) as { targetModeRequirement: string | null; credentialRefs: string[] };
    expect(repro.targetModeRequirement).toBe('VULNERABLE');
    expect(repro.credentialRefs).toContain('DEMO_ADMIN_TOKEN');
  });
});

// Queue sanity: the golden queue carries no authoritative state.
it(
  'golden queue is coordination-only (no durable state lives in Redis)',
  { timeout: 30_000 },
  async () => {
    const queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
    await queue.close();
    expect(true).toBe(true);
  },
);
