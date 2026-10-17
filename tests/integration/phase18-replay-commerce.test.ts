// =====================================================================
// Integration — Phase 18: Replay/regression lifecycle on Demo Commerce
// (ADR-0019 Decision 4; incident-replay §3; roadmap Phase 18)
// =====================================================================
// The REAL compiled CLI process (packages/cli/dist/cli.js) drives the
// REAL Commerce target on REAL TCP, through the REAL queue + REAL
// worker process + REAL Control PostgreSQL. Assertions come from the
// CLI's observable interface (exit code, stdout, written report) and
// from DURABLE Control-Plane truth — never from test-side simulation.
//
// Honest scope of this suite (ADR-0027, PROPOSED): the canonical
// Checkout Zero setup step pins the processing mode inside the frozen
// snapshot, and the target's own scenario reset applies that mode
// atomically — so a same-hash replay of the VULNERABLE snapshot
// deterministically reproduces FAIL (regression: the bug is still
// present). Post-fix verification is the SECURE scenario (a different
// hash — stated, never hidden) yielding PASS after a genuine
// target-side mode switch through the target's own admin API. What
// this suite proves on real infrastructure:
//   - vulnerable ⇒ genuine FAIL + Findings (exit 1), with target-
//     persisted orders/reservations/stock and attributed observations;
//   - same-hash replay ⇒ independently computed FAIL (exit 1), the
//     original FAIL and its historical evidence byte-unchanged;
//   - comparison of the same-hash pair (exit 0 from `compare`);
//   - secure ⇒ PASS + zero Findings (exit 0) after a real fix;
//   - cross-intent comparison refused (exit 4, SNAPSHOT_MISMATCH);
//   - credential mismatch / unknown reproduction fail closed (exit 4)
//     with no new run created;
//   - response-loss ⇒ INDETERMINATE persisted, zero retries, exit 3;
//   - every emitted report validates against rupturegrid-report/v1 and
//     is canary-clean (no secret values).
// The suite reuses the committed deterministic-oversell barrier helper
// (test-owned scheduling only — every durable effect stays the
// target's own) so the vulnerable race is deterministic under load,
// never timing luck (R-07).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import type { Prisma } from '@rupturegrid/control-db';

import {
  assertAcceptanceExpectations,
  expectationsFromReproduction,
  expectationsFromScenario,
} from '@rupturegrid/cli';
import { compareReplayRuns, RunComparisonError } from '@rupturegrid/forensics';
import { registerTarget } from '@rupturegrid/engine';
import { canonicalizeAndHash, createRunFromSnapshot } from '@rupturegrid/engine';
import { TargetRegistrationError } from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import {
  getControlPrisma,
  testTargetOriginCredentialPolicy,
  waitFor,
} from './helpers/execution-harness.js';
import {
  createCommerceClient,
  loadCommerceManifest,
  startCommerceProcess,
} from './helpers/commerce-harness.js';
import type { RunningCommerce } from './helpers/commerce-harness.js';
import { provisionThrowawayCommerceDb } from './helpers/commerce-db-provision.js';
import type { ProvisionedCommerceDb } from './helpers/commerce-db-provision.js';
import {
  ensureSuiteSkuRow,
  expectDeterministicOversellTruth,
  runWithDeterministicOversell,
} from './helpers/deterministic-oversell.js';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';

const prisma = getControlPrisma();
const COMMERCE_SIGNING_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const COMMERCE_ADMIN_REF = 'COMMERCE_ADMIN_TOKEN';
const CLI_ENTRY = join('packages', 'cli', 'dist', 'cli.js');
const GOLDEN_SCENARIOS = join('packages', 'cli', 'scenarios');

let env: TestEnv;
let running: RunningCommerce;
let throwawayDb: ProvisionedCommerceDb | null = null;
let worker: ChildProcess | null = null;
let workerStdout = '';
let workerStderr = '';
let workDir = '';
let e2eTargetName = '';
let credentialPolicy: TargetOriginCredentialPolicy;
let grantJson = '';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns the REAL compiled CLI process with the real child environment. */
async function runCli(
  args: readonly string[],
  options: { readonly grants?: string } = {},
  timeoutMs = 150_000,
): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      TARGET_ORIGIN_CREDENTIAL_GRANTS: options.grants ?? grantJson,
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
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out after ${String(timeoutMs)}ms: ${stderr || stdout}`));
    }, timeoutMs);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? -1);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { code, stdout, stderr };
}

interface ReboundScenario {
  readonly path: string;
  readonly checkoutIntentId: string;
  readonly responseLossCheckoutIntentId: string;
  readonly sku: string;
}
let scenarioRunCounter = 0;
// Unique across suite RUNS (the dev database persists definitions).
const suiteToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// ONE suite scope and ONE suite SKU for every scenario file (the Phase 17
// F-3 repair): each run's establish step resets this scope through the
// target's OWN admin API, so every run starts from a genuinely clean
// logical context no matter which test ran before it. Rebinding is
// STRUCTURAL (parsed bodies + runScope), never string surgery.
const suiteScopeToken = `checkout-zero-p18-${suiteToken}`;
const suiteSku = `SKU-P18-${suiteToken}`;
async function scenarioFile(
  sourceName: string,
  fileBody?: (document: Record<string, unknown>) => void,
): Promise<ReboundScenario> {
  const raw = await readFile(join(GOLDEN_SCENARIOS, sourceName), 'utf8');
  const document = JSON.parse(raw) as Record<string, unknown>;
  const target = document['target'] as Record<string, unknown>;
  target['displayName'] = e2eTargetName;
  const perFileToken = `${suiteToken}-${String(scenarioRunCounter + 1)}`;
  const intentFor = (canonical: string): string =>
    canonical === 'CHK-RL-001' ? `CHKRL-${perFileToken}` : `CHK-${perFileToken}`;
  const experiment = document['experiment'] as Record<string, unknown>;
  const steps = experiment['steps'] as Array<Record<string, unknown>>;
  for (const step of steps) {
    const action = step['action'] as Record<string, unknown>;
    if (typeof action['body'] !== 'string') {
      continue;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(action['body'] as string) as Record<string, unknown>;
    } catch {
      continue;
    }
    let reboundBody = false;
    if (typeof body['scopeToken'] === 'string') {
      body['scopeToken'] = suiteScopeToken;
      reboundBody = true;
    }
    if (typeof body['sku'] === 'string') {
      body['sku'] = suiteSku;
      reboundBody = true;
    }
    if (typeof body['checkoutIntentId'] === 'string') {
      body['checkoutIntentId'] = intentFor(body['checkoutIntentId'] as string);
      reboundBody = true;
    }
    if (reboundBody) {
      action['body'] = JSON.stringify(body);
    }
    // The establish step is deliberately blocked on the barrier row in
    // barrier-driven runs; the executor's default per-invocation HTTP
    // timeout (30s) would abort a slow-under-load dispatch before the
    // barrier can observe and release it — so the rebound (test-owned,
    // never canonical) establish step carries the platform-maximum 60s
    // timeout. The Commerce target's own 5s Prisma transaction timeout
    // still bounds the blocked DB transaction.
    if (step['name'] === 'establish-scenario' && action['timeoutMs'] === undefined) {
      action['timeoutMs'] = 60_000;
    }
  }
  const runScope = experiment['runScope'] as Record<string, unknown> | undefined;
  if (runScope !== undefined && runScope !== null) {
    runScope['declaredScope'] = suiteScopeToken;
    const declaredSubjects = runScope['subjects'] as Record<string, string[]> | undefined;
    for (const [invariantKey, subjects] of Object.entries(declaredSubjects ?? {})) {
      declaredSubjects![invariantKey] = subjects.map((subject) =>
        subject === 'SKU-001' ? suiteSku : subject.startsWith('CHK') ? intentFor(subject) : subject,
      );
    }
  }
  const rebound = document;
  const baseName = typeof rebound['name'] === 'string' ? rebound['name'] : sourceName;
  scenarioRunCounter += 1;
  rebound['name'] = `${baseName}-p18-${suiteToken}-${String(scenarioRunCounter)}`;
  fileBody?.(rebound);
  const path = join(workDir, `${sourceName}-p18-${String(scenarioRunCounter)}`);
  await writeFile(path, JSON.stringify(rebound, null, 2), 'utf8');
  const reboundSteps = (rebound['experiment'] as Record<string, unknown>)['steps'] as Array<
    Record<string, unknown>
  >;
  const submitBody = reboundSteps.find((step) => step['name'] === 'checkout-submit')?.['action'] as
    Record<string, unknown> | undefined;
  let submitBodyJson: Record<string, unknown>;
  try {
    submitBodyJson = JSON.parse((submitBody?.['body'] as string) ?? '{}') as Record<
      string,
      unknown
    >;
  } catch {
    submitBodyJson = {};
  }
  const submitIntent =
    typeof submitBodyJson['checkoutIntentId'] === 'string'
      ? (submitBodyJson['checkoutIntentId'] as string)
      : `CHK-${perFileToken}`;
  const isResponseLossSubmit = submitIntent.startsWith('CHKRL-');
  return {
    path,
    checkoutIntentId: isResponseLossSubmit ? `CHK-${perFileToken}` : submitIntent,
    responseLossCheckoutIntentId: isResponseLossSubmit ? submitIntent : `CHKRL-${perFileToken}`,
    sku: suiteSku,
  };
}

beforeAll(async () => {
  env = loadTestEnv();
  let port = 34000 + Math.floor(Math.random() * 5000);
  const commerceHostPort = Number((env.commerceDatabaseUrl.match(/:(\d+)\//) ?? [])[1] ?? 5445);
  throwawayDb = await provisionThrowawayCommerceDb({
    adminUrl: `postgresql://commerce:${env.commercePostgresPassword}@127.0.0.1:${commerceHostPort}/postgres`,
    password: env.commercePostgresPassword,
    port: commerceHostPort,
  });
  const hermeticEnv: TestEnv = { ...env, commerceDatabaseUrl: throwawayDb.databaseUrl };
  e2eTargetName = `checkout-zero-p18-${Date.now().toString(36)}`;
  for (let attempt = 0; ; attempt += 1) {
    running = await startCommerceProcess(hermeticEnv, port);
    credentialPolicy = testTargetOriginCredentialPolicy({
      [running.baseUrl]: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
    });
    try {
      await registerTarget(
        prisma,
        {
          displayName: e2eTargetName,
          environment: 'LOCAL_DEVELOPMENT',
          origins: [running.baseUrl],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
          manifest: loadCommerceManifest(e2eTargetName, running.baseUrl),
        },
        credentialPolicy,
      );
      break;
    } catch (error) {
      await running.close();
      if (!(error instanceof TargetRegistrationError) || attempt >= 2) {
        throw error;
      }
      port = 34000 + Math.floor(Math.random() * 5000);
    }
  }
  grantJson = JSON.stringify({
    [running.baseUrl]: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
  });
  worker = spawn(process.execPath, [join('apps', 'worker', 'dist', 'main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      WORKER_CONCURRENCY: '2',
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
  await waitFor(async () => (workerStdout.includes('ready') ? true : null), 30_000, 100).catch(
    () => {
      throw new Error(`worker did not start: ${workerStderr || workerStdout}`);
    },
  );
  workDir = await mkdtemp(join(tmpdir(), 'rg-phase18-commerce-'));
  const uninitialized = await adminJson('/demo/admin/scenario-context', 'POST', {
    scopeToken: suiteScopeToken,
    sku: suiteSku,
    initialAvailableUnits: 1,
  });
  expect(uninitialized.status).toBe(409);
  expect(uninitialized.body).toMatchObject({ error: { code: 'PROCESSING_NOT_INITIALIZED' } });
  // Seed the suite SKU row through the target's OWN admin API so the
  // barrier can lock it even if this file's vulnerable test runs first.
  await ensureSuiteSkuRow({
    commerceDatabaseUrl: throwawayDb.databaseUrl,
    commerceClient: createCommerceClient(running),
    suiteSku,
    suiteScopeToken,
  });
}, 90_000);

afterAll(async () => {
  worker?.kill();
  await running.close();
  await throwawayDb?.close();
  await rm(workDir, { recursive: true, force: true });
});

// Shared lifecycle state (file-ordered; no shuffle configured).
let vulnerableRunId = '';
let vulnerableScenarioPath = '';
let vulnerableSnapshotHash = '';
let vulnerableReproId = '';
let replayRunId = '';
let secureRunId = '';
let secureSnapshotHash = '';

interface ReportShape {
  readonly run: {
    readonly runId: string;
    readonly snapshotContentHash: string;
    readonly terminalState: string;
  };
  readonly exit: { readonly code: number; readonly class: string; readonly reason: string };
  readonly invariantEvaluations: Array<{
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly verdict: string;
    readonly reason: string;
  }>;
  readonly findings: Array<{
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly reasonCode: string;
  }>;
  readonly evidenceIntegrity: { readonly verified: boolean; readonly observationCount: number };
  readonly reproductionReference: {
    readonly reproductionDefinitionId?: string;
    readonly snapshotContentHash?: string;
    readonly targetModeRequirement?: string | null;
    readonly credentialRefs?: readonly string[];
  };
}

function checkNoSecrets(reportJson: string): void {
  // Canary scan (R-13): no secret VALUE may appear in any report.
  expect(reportJson).not.toContain(env.commerceAdminToken);
  expect(reportJson).not.toContain(env.commerceSigningSecret);
  expect(reportJson).not.toContain(env.demoAdminToken);
}

describe('Phase 18 commerce: discovered failure → reproduction → replay → fix → PASS', () => {
  it('discovers a genuine vulnerable failure (exit 1) with target-persisted proof', async () => {
    const scenario = await scenarioFile('checkout-zero-vulnerable.scenario.json');
    vulnerableScenarioPath = scenario.path;
    const reportPath = join(workDir, 'vulnerable-report.json');
    const result = await runWithDeterministicOversell({
      commerceDatabaseUrl: throwawayDb?.databaseUrl ?? '',
      suiteSku,
      suiteScopeToken,
      scenarioPath: scenario.path,
      dispatch: () =>
        runCli([
          'run',
          scenario.path,
          '--wait',
          '--timeout',
          '120s',
          '--report',
          reportPath,
          '--json',
        ]),
      appLogs: () => ({ stdout: running.stdout(), stderr: running.stderr() }),
    });
    if (result.code !== 1) {
      throw new Error(
        `expected OS exit 1 (INVARIANT_FAIL), got ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(1);
    checkNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout) as ReportShape;
    expect(report.exit.class).toBe('INVARIANT_FAIL');
    expect(report.run.terminalState).toBe('COMPLETED');
    expect(report.evidenceIntegrity.verified).toBe(true);
    const verdictOf = (key: string): string =>
      report.invariantEvaluations.find((evaluation) => evaluation.invariantKey === key)?.verdict ??
      'ABSENT';
    expect(verdictOf('INV-CHK-1')).toBe('FAIL');
    expect(verdictOf('INV-INV-1')).toBe('FAIL');
    // Genuine findings: every FAIL evaluation is backed by a finding row —
    // the report's finding list is one-for-one with durable truth.
    const ownFindings = await prisma.finding.findMany({
      where: { runId: report.run.runId },
      select: { invariantKey: true, subjectKey: true, reasonCode: true },
    });
    expect(ownFindings).toHaveLength(report.findings.length);
    expect(ownFindings.map((finding) => finding.invariantKey).sort()).toEqual([
      'INV-CHK-1',
      'INV-INV-1',
    ]);
    // Acceptance expectations (scenario intent) assert — without ever
    // influencing the verdicts above (classifier never saw them).
    const scenarioDoc = JSON.parse(await readFile(scenario.path, 'utf8')) as Record<
      string,
      unknown
    >;
    const assertion = assertAcceptanceExpectations(
      { exitClass: report.exit.class, invariantEvaluations: report.invariantEvaluations },
      expectationsFromScenario(scenarioDoc['expectations']),
    );
    expect(assertion.matched).toBe(true);
    // Business truth from the target's read-only surface + durable rows.
    await expectDeterministicOversellTruth({
      prisma,
      commerceClient: createCommerceClient(running),
      runId: report.run.runId,
      ownIntent: scenario.checkoutIntentId,
      ownSku: scenario.sku,
    });
    // The durable reproduction definition: the replay handle.
    const reproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
      where: { runId: report.run.runId },
    });
    expect(reproduction.snapshotContentHash).toBe(report.run.snapshotContentHash);
    expect(reproduction.targetModeRequirement).toBe('VULNERABLE');
    expect([...reproduction.credentialRefs].sort()).toEqual(
      [COMMERCE_ADMIN_REF, COMMERCE_SIGNING_REF].sort(),
    );
    expect(report.reproductionReference.reproductionDefinitionId).toBe(reproduction.id);
    expect(report.reproductionReference.snapshotContentHash).toBe(reproduction.snapshotContentHash);
    vulnerableRunId = report.run.runId;
    vulnerableSnapshotHash = report.run.snapshotContentHash;
    vulnerableReproId = reproduction.id;
  }, 240_000);

  it('replays from the SAME snapshot hash: independently computed FAIL, history preserved', async () => {
    expect(vulnerableRunId).not.toBe('');
    // Snapshot the original run's historical truth for preservation proof.
    const before = {
      observations: await prisma.rawObservation.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, contentHash: true },
        orderBy: { chainIndex: 'asc' },
      }),
      evaluations: await prisma.invariantEvaluation.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, verdict: true, reason: true, evidenceSetHash: true },
        orderBy: { id: 'asc' },
      }),
      findings: await prisma.finding.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, reasonCode: true },
        orderBy: { id: 'asc' },
      }),
      runs: await prisma.experimentRun.count(),
    };
    const scenarioPath = vulnerableScenarioPath;
    expect(scenarioPath).not.toBe('');
    const reportPath = join(workDir, 'replay-report.json');
    const result = await runWithDeterministicOversell({
      commerceDatabaseUrl: throwawayDb?.databaseUrl ?? '',
      suiteSku,
      suiteScopeToken,
      scenarioPath,
      dispatch: () =>
        runCli(['replay', '--reproduction', vulnerableReproId, '--report', reportPath, '--json']),
      appLogs: () => ({ stdout: running.stdout(), stderr: running.stderr() }),
    });
    if (result.code !== 1) {
      throw new Error(
        `expected OS exit 1 (INVARIANT_FAIL) from same-hash replay, got ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(1);
    checkNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout) as ReportShape;
    replayRunId = report.run.runId;
    // A NEW run from the SAME hash-pinned snapshot — never merged history.
    expect(replayRunId).not.toBe(vulnerableRunId);
    expect(report.run.snapshotContentHash).toBe(vulnerableSnapshotHash);
    expect(report.exit.class).toBe('INVARIANT_FAIL');
    const verdictOf = (key: string): string =>
      report.invariantEvaluations.find((evaluation) => evaluation.invariantKey === key)?.verdict ??
      'ABSENT';
    expect(verdictOf('INV-CHK-1')).toBe('FAIL');
    expect(verdictOf('INV-INV-1')).toBe('FAIL');
    // Independently computed: distinct evaluation rows with distinct ids.
    const replayEvaluations = await prisma.invariantEvaluation.findMany({
      where: { runId: replayRunId },
      select: { id: true },
    });
    const beforeIds = new Set(before.evaluations.map((evaluation) => evaluation.id));
    for (const evaluation of replayEvaluations) {
      expect(beforeIds.has(evaluation.id)).toBe(false);
    }
    // The replay's own reproduction definition binds the same hash.
    const replayReproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
      where: { runId: replayRunId },
    });
    expect(replayReproduction.snapshotContentHash).toBe(vulnerableSnapshotHash);
    expect(report.reproductionReference.snapshotContentHash).toBe(vulnerableSnapshotHash);
    // Reproduction acceptance expectations (the original run's own
    // verdicts) assert determinism: FAIL reproduces FAIL. Scoped to the
    // scenario's BOUND domain: the reproduction row honestly records the
    // run's FULL evaluation domain (including unbound legacy rows such
    // as INV-DF-2), while the report — like the exit classifier —
    // serializes the bound domain only. Unbound rows are disclosed in
    // the report's eligibility block, never silently dropped.
    const originalReproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
      where: { id: vulnerableReproId },
    });
    const replayScenarioDoc = JSON.parse(await readFile(vulnerableScenarioPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const boundKeys = new Set(
      (
        ((replayScenarioDoc['experiment'] as Record<string, unknown>)['invariantBindings'] as Array<
          Record<string, unknown>
        >) ?? []
      ).map((binding) => String(binding['key'])),
    );
    const normalized = expectationsFromReproduction(
      originalReproduction.acceptanceExpectations,
      'INVARIANT_FAIL',
    );
    const scopedVerdicts = Object.fromEntries(
      Object.entries(normalized.invariantVerdicts ?? {}).filter(([key]) => boundKeys.has(key)),
    );
    const determinism = assertAcceptanceExpectations(
      { exitClass: report.exit.class, invariantEvaluations: report.invariantEvaluations },
      {
        exitClass: normalized.exitClass,
        invariantVerdicts: scopedVerdicts,
        normalizationIssues: normalized.normalizationIssues,
      },
    );
    expect(determinism.matched).toBe(true);
    // Historical evidence preservation: the original run's rows are
    // byte-unchanged (same ids, same hashes, same verdicts/reasons).
    const after = {
      observations: await prisma.rawObservation.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, contentHash: true },
        orderBy: { chainIndex: 'asc' },
      }),
      evaluations: await prisma.invariantEvaluation.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, verdict: true, reason: true, evidenceSetHash: true },
        orderBy: { id: 'asc' },
      }),
      findings: await prisma.finding.findMany({
        where: { runId: vulnerableRunId },
        select: { id: true, reasonCode: true },
        orderBy: { id: 'asc' },
      }),
    };
    expect(after.observations).toEqual(before.observations);
    expect(after.evaluations).toEqual(before.evaluations);
    expect(after.findings).toEqual(before.findings);
    expect(await prisma.experimentRun.count()).toBe(before.runs + 1);
  }, 240_000);

  it('compares original and replay from durable truth (same intent)', async () => {
    expect(vulnerableRunId).not.toBe('');
    expect(replayRunId).not.toBe('');
    const result = await runCli(['compare', vulnerableRunId, replayRunId, '--json']);
    expect(result.code).toBe(0);
    const comparison = JSON.parse(result.stdout) as {
      snapshotContentHash: string;
      invariantKeys: Array<{ key: string; registryVersion: string }>;
      keys: unknown;
      unboundKeys: unknown;
      subjects: Array<{
        invariantKey: string;
        subjectKey: string;
        baseVerdict: string;
        replayVerdict: string;
        verdictsDiffer: boolean;
        baseEffectCount: number | null;
        replayEffectCount: number | null;
      }>;
      base: {
        findingCount: number;
        observationCount: number;
        evidenceHeadHash: string;
        reproductionDefinitionId: string;
      };
      replay: {
        findingCount: number;
        observationCount: number;
        evidenceHeadHash: string;
        reproductionDefinitionId: string;
      };
      schedulingNote: string;
    };
    expect(comparison.snapshotContentHash).toBe(vulnerableSnapshotHash);
    expect(comparison.invariantKeys.map((key) => key.key).sort()).toEqual([
      'INV-CHK-1',
      'INV-INV-1',
    ]);
    // Same-hash determinism: no verdict differs; effect counts agree.
    // Per-key domains agree AND per-subject rows agree (declared stable
    // subjects CHK-*/SKU-* are identical across same-hash runs).
    const keyAgreement = comparison.keys as Array<{
      invariantKey: string;
      baseVerdicts: string[];
      replayVerdicts: string[];
      agree: boolean;
    }>;
    expect(keyAgreement.map((key) => key.invariantKey).sort()).toEqual(['INV-CHK-1', 'INV-INV-1']);
    for (const key of keyAgreement) {
      expect(key.agree).toBe(true);
    }
    // Unbound legacy rows (INV-DF-2) are disclosed, never silently
    // omitted and never part of the bound comparison domain.
    const unbound = comparison.unboundKeys as Array<{ invariantKey: string }>;
    expect(unbound.map((key) => key.invariantKey)).toContain('INV-DF-2');
    for (const subject of comparison.subjects) {
      expect(subject.verdictsDiffer).toBe(false);
      expect(subject.baseEffectCount).toBe(subject.replayEffectCount);
    }
    expect(
      comparison.subjects.find((subject) => subject.invariantKey === 'INV-CHK-1')?.baseEffectCount,
    ).toBe(2);
    expect(
      comparison.subjects.find((subject) => subject.invariantKey === 'INV-INV-1')?.baseEffectCount,
    ).toBe(2);
    // New execution evidence (new observation chain head), same findings.
    // Observation counts are asserted as present and positive on both
    // sides — never equated by assumption (scheduling variance in
    // observation capture is honest, incident-replay §4).
    expect(comparison.base.observationCount).toBeGreaterThan(0);
    expect(comparison.replay.observationCount).toBeGreaterThan(0);
    expect(comparison.replay.evidenceHeadHash).not.toBe(comparison.base.evidenceHeadHash);
    expect(comparison.replay.findingCount).toBe(comparison.base.findingCount);
    expect(comparison.base.reproductionDefinitionId).not.toBe('');
    expect(comparison.replay.reproductionDefinitionId).not.toBe('');
    expect(comparison.schedulingNote).toMatch(/Scheduling variance is expected/);
    // The in-process surface agrees with the CLI surface (same durable truth).
    const direct = await compareReplayRuns(prisma, vulnerableRunId, replayRunId);
    expect(direct.snapshotContentHash).toBe(vulnerableSnapshotHash);
    expect(direct.subjects.every((subject) => !subject.verdictsDiffer)).toBe(true);
  }, 120_000);

  it('applies a genuine target-side fix and verifies PASS (secure scenario, different hash stated)', async () => {
    // The legitimate fix interface: the target's own admin API switches
    // the durable processing mode (R-05 — no backdoor state edits).
    const client = createCommerceClient(running);
    expect(await client.setMode('SECURE')).toBe('SECURE');
    expect(await client.getMode()).toBe('SECURE');
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    const reportPath = join(workDir, 'secure-report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '120s',
      '--report',
      reportPath,
      '--json',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `expected OS exit 0 (PASS) after the target-side fix, got ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(0);
    checkNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout) as ReportShape;
    secureRunId = report.run.runId;
    secureSnapshotHash = report.run.snapshotContentHash;
    expect(report.exit.class).toBe('PASS');
    expect(report.evidenceIntegrity.verified).toBe(true);
    for (const evaluation of report.invariantEvaluations) {
      expect(evaluation.verdict).toBe('PASS');
    }
    // PASS produces zero findings (finding rule registry: only FAIL finds).
    expect(report.findings).toHaveLength(0);
    expect(await prisma.finding.count({ where: { runId: secureRunId } })).toBe(0);
    const scenarioDoc = JSON.parse(await readFile(scenario.path, 'utf8')) as Record<
      string,
      unknown
    >;
    const assertion = assertAcceptanceExpectations(
      { exitClass: report.exit.class, invariantEvaluations: report.invariantEvaluations },
      expectationsFromScenario(scenarioDoc['expectations']),
    );
    expect(assertion.matched).toBe(true);
    // The secure scenario is a DIFFERENT frozen intent (its setup pins
    // SECURE) — stated here, never hidden (ADR-0027).
    expect(secureSnapshotHash).not.toBe(vulnerableSnapshotHash);
    // The original FAIL and its history are untouched by the fix run.
    const preserved = await prisma.invariantEvaluation.findMany({
      where: { runId: vulnerableRunId, invariantKey: 'INV-CHK-1' },
      select: { verdict: true },
    });
    expect(preserved.some((row) => row.verdict === 'FAIL')).toBe(true);
  }, 240_000);

  it('refuses cross-intent comparison (vulnerable vs secure)', async () => {
    expect(vulnerableRunId).not.toBe('');
    expect(secureRunId).not.toBe('');
    const result = await runCli(['compare', vulnerableRunId, secureRunId, '--json']);
    expect(result.code).toBe(4);
    expect(result.stdout).toMatch(/SNAPSHOT_MISMATCH|cross-intent|different snapshot/i);
    await expect(compareReplayRuns(prisma, vulnerableRunId, secureRunId)).rejects.toBeInstanceOf(
      RunComparisonError,
    );
    // Self-comparison is refused too.
    await expect(
      compareReplayRuns(prisma, vulnerableRunId, vulnerableRunId),
    ).rejects.toBeInstanceOf(RunComparisonError);
  }, 120_000);

  it('fails closed on credential mismatch with no new run created', async () => {
    const runsBefore = await prisma.experimentRun.count();
    // The platform grant for the admin credential is removed: the frozen
    // COMMERCE_ADMIN_TOKEN ref is no longer authorized for the origin.
    const revokedGrants = JSON.stringify({ [running.baseUrl]: [COMMERCE_SIGNING_REF] });
    const result = await runCli(
      [
        'replay',
        '--reproduction',
        vulnerableReproId,
        '--report',
        join(workDir, 'revoked.json'),
        '--json',
      ],
      { grants: revokedGrants },
    );
    expect(result.code).toBe(4);
    expect(result.stdout).toMatch(/credential|authorized|fail closed/i);
    expect(await prisma.experimentRun.count()).toBe(runsBefore);
  }, 120_000);

  it('fails closed on an unknown reproduction id with nothing executed', async () => {
    const runsBefore = await prisma.experimentRun.count();
    const result = await runCli([
      'replay',
      '--reproduction',
      '00000000-0000-4000-8000-000000000000',
      '--report',
      join(workDir, 'unknown.json'),
      '--json',
    ]);
    expect(result.code).toBe(4);
    expect(await prisma.experimentRun.count()).toBe(runsBefore);
  }, 120_000);

  it('response-loss keeps INDETERMINATE knowledge with zero retries (exit 3)', async () => {
    const scenario = await scenarioFile('checkout-zero-response-loss.scenario.json');
    const reportPath = join(workDir, 'response-loss-report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '120s',
      '--report',
      reportPath,
      '--json',
    ]);
    expect(result.code).toBe(3);
    // No report artifact: there is no evaluated-truth report to give.
    await expect(readFile(reportPath, 'utf8')).rejects.toThrow();
    // The truncated delivery is honestly INDETERMINATE (sent-but-unknown),
    // attempted EXACTLY once — never automatically retried (R-10).
    const runId = (JSON.parse(result.stdout) as { error: { runId: string | null } }).error.runId;
    expect(runId).not.toBe(null);
    const steps = await prisma.experimentStepRun.findMany({
      where: { runId: runId ?? '' },
      orderBy: { sequence: 'asc' },
    });
    const submit = steps.find((step) => step.name === 'checkout-submit');
    expect(submit?.state).toBe('FAILED');
    expect(submit?.attemptCount).toBe(1);
    const invocations = await prisma.stepInvocation.findMany({
      where: { stepRunId: submit?.id ?? '' },
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.sideEffectKnowledge).toBe('INDETERMINATE');
    // Execution failure never becomes an invariant outcome: the CLI
    // emitted exit 3 with no evaluated-truth report (no report file
    // above), so no PASS/FAIL verdict launders the ambiguity.
    // The mutation objectively committed on the TARGET (read-only
    // inspection — R-05 respected) under this run's rebound identity.
    const orders =
      await createCommerceClient(running).inspection<Record<string, unknown>>('/inspection/orders');
    expect(
      orders.some(
        (order) =>
          order['checkoutIntentId'] === scenario.responseLossCheckoutIntentId &&
          order['status'] === 'ACCEPTED',
      ),
    ).toBe(true);
  }, 240_000);
});

// Full row sets, not just selected verdicts/counts: replay must preserve
// the original run's durable execution, evidence and analysis identities.
async function historicalFrame(runId: string): Promise<string> {
  const frame = await Promise.all([
    prisma.experimentRun.findUniqueOrThrow({ where: { id: runId }, include: { snapshot: true } }),
    prisma.experimentStepRun.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.stepInvocation.findMany({ where: { stepRun: { runId } }, orderBy: { id: 'asc' } }),
    prisma.rawObservation.findMany({ where: { runId }, orderBy: { chainIndex: 'asc' } }),
    prisma.normalizedEvent.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.causalRelationship.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.evaluationBatch.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.invariantEvaluation.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.finding.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.findingEvidenceReference.findMany({
      where: { finding: { runId } },
      orderBy: { id: 'asc' },
    }),
    prisma.forensicTimelineEntry.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.forensicDerivation.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.derivationAttempt.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.staleWriterEvent.findMany({ where: { stepRun: { runId } }, orderBy: { id: 'asc' } }),
    prisma.reproductionDefinition.findUnique({ where: { runId } }),
    prisma.currentEvaluationPointer.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.runEligibilityProof.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    prisma.runTruthInputHead.findUnique({ where: { runId } }),
    prisma.evidenceIntegrityHead.findUnique({ where: { runId } }),
  ]);
  return JSON.stringify(frame, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

interface ConfigurationFact {
  readonly mode: string;
  readonly processingRevision: string;
  readonly targetInstanceId: string;
}

async function adminJson(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${running.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.commerceAdminToken}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function capturedConfiguration(
  runId: string,
  expectedMode: string,
): Promise<ConfigurationFact> {
  const observations = await prisma.rawObservation.findMany({
    where: { runId },
    orderBy: { chainIndex: 'asc' },
  });
  const facts: ConfigurationFact[] = [];
  for (const row of observations) {
    const payload = row.payload as unknown as {
      http?: { relativePath: string; responseBody: string | null };
    };
    if (
      payload.http === undefined ||
      !['/demo/admin/status', '/demo/admin/scenario-context', '/checkout/submit'].includes(
        payload.http.relativePath,
      )
    )
      continue;
    expect(row.truncated).toBe(false);
    expect(payload.http.responseBody).not.toBeNull();
    facts.push(JSON.parse(payload.http.responseBody ?? '{}') as ConfigurationFact);
  }
  // Before + setup + two physical submissions + after, all from raw
  // captured HTTP, never the StepInvocation response projection.
  expect(facts).toHaveLength(5);
  for (const fact of facts) {
    expect(fact.mode).toBe(expectedMode);
    expect(fact.processingRevision).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(fact.targetInstanceId).toBe(facts[0]?.targetInstanceId);
    expect(fact.processingRevision).toBe(facts[0]?.processingRevision);
  }
  return facts[0]!;
}

async function expectCurrentTruth(runId: string, verdict: 'FAIL' | 'PASS'): Promise<void> {
  const pointers = await prisma.currentEvaluationPointer.findMany({
    where: { runId },
    include: { currentEvaluation: true },
  });
  const bound = pointers.filter(
    (p) => p.invariantKey === 'INV-CHK-1' || p.invariantKey === 'INV-INV-1',
  );
  expect(bound).toHaveLength(2);
  const proofs = await prisma.runEligibilityProof.findMany({ where: { runId } });
  const head = await prisma.evidenceIntegrityHead.findUniqueOrThrow({ where: { runId } });
  const truth = await prisma.runTruthInputHead.findUniqueOrThrow({ where: { runId } });
  for (const pointer of bound) {
    expect(pointer.currentEvaluation.runId).toBe(runId);
    expect(pointer.currentEvaluation.verdict).toBe(verdict);
    expect(pointer.integrityHeadHash).toBe(head.headContentHash);
    expect(pointer.integrityObservationCount).toBe(head.observationCount);
    expect(pointer.provenanceRevision).toBe(truth.provenanceRevision);
    expect(pointer.derivationGeneration).toBe(truth.derivationGeneration);
    const proof = proofs.find(
      (p) =>
        p.invariantKey === pointer.invariantKey && p.evaluatorVersion === pointer.evaluatorVersion,
    );
    expect(proof).toBeDefined();
    expect(proof!.analysisGeneration).toBe(pointer.analysisGeneration);
    expect(proof!.integrityHeadHash).toBe(pointer.integrityHeadHash);
    expect(proof!.integrityObservationCount).toBe(pointer.integrityObservationCount);
    expect(proof!.provenanceRevision).toBe(pointer.provenanceRevision);
    expect(proof!.derivationGeneration).toBe(pointer.derivationGeneration);
  }
}

describe('Phase 18 approved mode-preserving amendment', () => {
  it('same reproduction and stored snapshot: real FAIL → target fix → independently evaluated PASS', async () => {
    const scenario = await scenarioFile('checkout-zero-post-fix.scenario.json');
    expect((await adminJson('/demo/admin/mode', 'PUT', { mode: 'VULNERABLE' })).status).toBe(200);
    const originalFile = join(workDir, 'mode-neutral-fail.json');
    const validation = await runCli(['scenarios', 'validate', scenario.path]);
    expect(validation.code, validation.stderr || validation.stdout).toBe(0);
    const dispatchWithOverlap = async (args: readonly string[]) => {
      let cliResult: CliResult | undefined;
      try {
        return await runWithDeterministicOversell({
          commerceDatabaseUrl: throwawayDb!.databaseUrl,
          suiteSku,
          suiteScopeToken,
          scenarioPath: scenario.path,
          dispatch: async () => {
            cliResult = await runCli(args);
            return cliResult;
          },
          appLogs: () => ({ stdout: running.stdout(), stderr: running.stderr() }),
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : 'overlap failed'}\nCLI outcome: ${cliResult?.stdout ?? ''}\n${cliResult?.stderr ?? ''}`,
          { cause: error },
        );
      }
    };
    const first = await dispatchWithOverlap([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '120s',
      '--report',
      originalFile,
      '--json',
    ]);
    expect(first.code, first.stderr || first.stdout).toBe(1);
    checkNoSecrets(first.stdout);
    const original = JSON.parse(first.stdout) as ReportShape;
    await expectDeterministicOversellTruth({
      prisma,
      commerceClient: createCommerceClient(running),
      runId: original.run.runId,
      ownIntent: scenario.checkoutIntentId,
      ownSku: scenario.sku,
    });
    await expectCurrentTruth(original.run.runId, 'FAIL');
    const originalConfig = await capturedConfiguration(original.run.runId, 'VULNERABLE');
    const reproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
      where: { runId: original.run.runId },
    });
    expect(reproduction.targetModeRequirement).toBeNull();
    const snapshot = await prisma.runSnapshot.findUniqueOrThrow({
      where: { id: reproduction.snapshotId },
    });
    expect(canonicalizeAndHash(snapshot.content).hash).toBe(snapshot.contentHash);
    const findings = await prisma.finding.findMany({
      where: { runId: original.run.runId },
      include: { evidenceRefs: true },
    });
    expect(findings).toHaveLength(2);
    for (const finding of findings) expect(finding.evidenceRefs.length).toBeGreaterThan(0);
    const originalBefore = await historicalFrame(original.run.runId);
    checkNoSecrets(originalBefore);
    const originalBytes = await readFile(originalFile, 'utf8');

    // Negative control: preserving mode without a fix reproduces FAIL
    // under the same measured overlap. This is a fresh execution of R.
    const control = await dispatchWithOverlap([
      'replay',
      '--reproduction',
      reproduction.id,
      '--report',
      join(workDir, 'no-fix.json'),
      '--json',
    ]);
    expect(control.code, control.stderr || control.stdout).toBe(1);
    expect((JSON.parse(control.stdout) as ReportShape).run.snapshotContentHash).toBe(
      snapshot.contentHash,
    );
    expect(await historicalFrame(original.run.runId)).toBe(originalBefore);

    const fix = await adminJson('/demo/admin/mode', 'PUT', { mode: 'SECURE' });
    expect(fix.status).toBe(200);
    expect(fix.body['mode']).toBe('SECURE');
    expect(fix.body['targetInstanceId']).toBe(originalConfig.targetInstanceId);
    expect(BigInt(fix.body['processingRevision'] as string)).toBe(
      BigInt(originalConfig.processingRevision) + 1n,
    );
    const snapshotsBefore = await prisma.runSnapshot.count();
    const replayFile = join(workDir, 'mode-neutral-pass.json');
    const fixed = await dispatchWithOverlap([
      'replay',
      '--reproduction',
      reproduction.id,
      '--report',
      replayFile,
      '--json',
    ]);
    expect(fixed.code, fixed.stderr || fixed.stdout).toBe(0);
    checkNoSecrets(fixed.stdout);
    const replay = JSON.parse(fixed.stdout) as ReportShape;
    expect(replay.run.runId).not.toBe(original.run.runId);
    expect(replay.run.snapshotContentHash).toBe(snapshot.contentHash);
    expect(replay.run.terminalState).toBe('COMPLETED');
    expect(replay.evidenceIntegrity.verified).toBe(true);
    expect(replay.findings).toHaveLength(0);
    const replayRun = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: replay.run.runId },
    });
    expect(replayRun.snapshotId).toBe(snapshot.id);
    expect(await prisma.runSnapshot.count()).toBe(snapshotsBefore);
    expect(await prisma.runSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).toEqual(
      snapshot,
    );
    await expectCurrentTruth(replay.run.runId, 'PASS');
    const priorExpectations = expectationsFromReproduction(reproduction.acceptanceExpectations);
    const unchangedExpectations = assertAcceptanceExpectations(
      { exitClass: replay.exit.class, invariantEvaluations: replay.invariantEvaluations },
      priorExpectations,
    );
    expect(unchangedExpectations.matched).toBe(false);
    expect(unchangedExpectations.mismatches.join(' ')).toContain('INV-CHK-1 verdicts [PASS]');
    const replayConfig = await capturedConfiguration(replay.run.runId, 'SECURE');
    expect(replayConfig.processingRevision).toBe(fix.body['processingRevision']);
    expect(replayConfig.targetInstanceId).toBe(originalConfig.targetInstanceId);

    const db = new PgClient({ connectionString: throwawayDb!.databaseUrl });
    await db.connect();
    try {
      await db.query('BEGIN READ ONLY');
      const targetOrders = await db.query(
        'SELECT o.* FROM orders o JOIN checkout_intents i ON i.id=o."intentId" WHERE i."checkoutIntentId"=$1 AND o.status=\'ACCEPTED\'',
        [scenario.checkoutIntentId],
      );
      const targetReservations = await db.query(
        'SELECT r.* FROM reservations r JOIN orders o ON o.id=r."orderId" JOIN checkout_intents i ON i.id=o."intentId" WHERE i."checkoutIntentId"=$1 AND r.status=\'ACCEPTED\'',
        [scenario.checkoutIntentId],
      );
      const stock = await db.query(
        'SELECT "initialAvailableUnits", "remainingAvailableUnits" FROM skus WHERE sku=$1',
        [suiteSku],
      );
      const attempts = await db.query<{
        processingModeUsed: string;
        processingRevisionUsed: string;
        targetInstanceIdUsed: string;
        startedAt: Date;
        finishedAt: Date;
        outcome: string;
      }>(
        'SELECT p.* FROM processing_attempts p JOIN request_attempts r ON r.id=p."requestAttemptId" JOIN checkout_intents i ON i.id=r."intentId" WHERE i."checkoutIntentId"=$1',
        [scenario.checkoutIntentId],
      );
      expect(targetOrders.rowCount).toBe(1);
      expect(targetReservations.rowCount).toBe(1);
      expect(targetReservations.rows[0]?.reservedUnits).toBe(1);
      expect(stock.rows).toEqual([{ initialAvailableUnits: 1, remainingAvailableUnits: 0 }]);
      expect(attempts.rows).toHaveLength(2);
      expect(attempts.rows.map((a) => a.outcome).sort()).toEqual([
        'ACCEPTED',
        'INTENT_ALREADY_ACCEPTED',
      ]);
      for (const attempt of attempts.rows) {
        expect(attempt.processingModeUsed).toBe('SECURE');
        expect(attempt.processingRevisionUsed).toBe(replayConfig.processingRevision);
        expect(attempt.targetInstanceIdUsed).toBe(replayConfig.targetInstanceId);
      }
      const [a, b] = attempts.rows;
      expect(a!.startedAt.getTime()).toBeLessThan(b!.finishedAt.getTime());
      expect(b!.startedAt.getTime()).toBeLessThan(a!.finishedAt.getTime());
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
    for (const load of [
      (runId: string) => prisma.rawObservation.findMany({ where: { runId }, select: { id: true } }),
      (runId: string) =>
        prisma.invariantEvaluation.findMany({ where: { runId }, select: { id: true } }),
      (runId: string) =>
        prisma.stepInvocation.findMany({ where: { stepRun: { runId } }, select: { id: true } }),
    ]) {
      const oldIds = new Set((await load(original.run.runId)).map((row) => row.id));
      const newRows = await load(replay.run.runId);
      expect(newRows.length).toBeGreaterThan(0);
      for (const row of newRows) expect(oldIds.has(row.id)).toBe(false);
    }
    expect(await historicalFrame(original.run.runId)).toBe(originalBefore);
    expect(await readFile(originalFile, 'utf8')).toBe(originalBytes);
    checkNoSecrets(await historicalFrame(replay.run.runId));
    checkNoSecrets(workerStdout + workerStderr + running.stdout() + running.stderr());
    const comparison = await runCli(['compare', original.run.runId, replay.run.runId, '--json']);
    expect(comparison.code).toBe(0);
    const compared = await compareReplayRuns(prisma, original.run.runId, replay.run.runId);
    expect(JSON.parse(comparison.stdout)).toEqual(compared);
    for (const key of ['INV-CHK-1', 'INV-INV-1']) {
      const row = compared.subjects.find((s) => s.invariantKey === key);
      expect(row).toMatchObject({
        baseVerdict: 'FAIL',
        replayVerdict: 'PASS',
        baseEffectCount: 2,
        replayEffectCount: 1,
        verdictsDiffer: true,
      });
    }
    expect(compared.base.findingCount).toBe(2);
    expect(compared.replay.findingCount).toBe(0);
    expect(compared.snapshotContentHash).toBe(snapshot.contentHash);
    expect(await historicalFrame(original.run.runId)).toBe(originalBefore);
    const invalid = await runCli(['replay', '--reproduction', 'malformed', '--json']);
    expect(invalid.code).toBe(4);
    const invalidCompare = await runCli(['compare', 'malformed', replay.run.runId, '--json']);
    expect(invalidCompare.code).toBe(4);
    const refusedRuns = await prisma.experimentRun.count();
    const targetRequestsBefore = await createCommerceClient(running).inspection(
      '/inspection/request-attempts',
    );
    const refusedSteps = await prisma.experimentStepRun.count();
    const refusedObservations = await prisma.rawObservation.count();
    // Corrupt configuration fixtures are NEW snapshot rows, never edits
    // to the genuine failure's frozen intent or historical evidence.
    const fixtureCases: Array<{
      name: string;
      change: (document: Record<string, unknown>) => void;
      error: RegExp;
      tamper?: boolean;
    }> = [
      {
        name: 'content-tampering',
        change: (d) => {
          d['engineVersion'] = 'changed-without-rehash';
        },
        error: /canonical hash/,
        tamper: true,
      },
      {
        name: 'target-binding',
        change: (d) => {
          (d['target'] as Record<string, unknown>)['targetId'] = randomUUID();
        },
        error: /refuses to rebind/,
      },
      {
        name: 'destination',
        change: (d) => {
          (d['target'] as Record<string, unknown>)['origin'] = 'http://unauthorized.invalid';
        },
        error: /unauthorized destination/,
      },
      {
        name: 'production',
        change: (d) => {
          (d['target'] as Record<string, unknown>)['environment'] = 'PRODUCTION';
        },
        error: /environment|production/i,
      },
      {
        name: 'missing-invariant-version',
        change: (d) => {
          const t = d['target'] as Record<string, unknown>;
          delete (t['invariantBindings'] as Array<Record<string, unknown>>)[0]!['registryVersion'];
        },
        error: /unavailable registry version/,
      },
      {
        name: 'unsupported-invariant-version',
        change: (d) => {
          const t = d['target'] as Record<string, unknown>;
          (t['invariantBindings'] as Array<Record<string, unknown>>)[0]!['registryVersion'] =
            'business-invariant/unavailable';
        },
        error: /unavailable registry version/,
      },
    ];
    for (const fixture of fixtureCases) {
      const content = JSON.parse(JSON.stringify(snapshot.content)) as Record<string, unknown>;
      fixture.change(content);
      const row = await prisma.runSnapshot.create({
        data: {
          revisionId: snapshot.revisionId,
          canonicalization: snapshot.canonicalization,
          content: content as Prisma.InputJsonValue,
          contentHash: fixture.tamper
            ? createHash('sha256').update(randomUUID()).digest('hex')
            : canonicalizeAndHash(content).hash,
        },
      });
      await expect(
        createRunFromSnapshot(prisma, row.id, credentialPolicy),
        fixture.name,
      ).rejects.toThrow(fixture.error);
    }
    const revoked = await runCli(
      [
        'replay',
        '--reproduction',
        reproduction.id,
        '--report',
        join(workDir, 'refused-grant.json'),
        '--json',
      ],
      { grants: JSON.stringify({ [running.baseUrl]: [COMMERCE_SIGNING_REF] }) },
    );
    expect(revoked.code).toBe(4);
    expect(await prisma.experimentRun.count()).toBe(refusedRuns);
    expect(await prisma.experimentStepRun.count()).toBe(refusedSteps);
    expect(await prisma.rawObservation.count()).toBe(refusedObservations);
    expect(await createCommerceClient(running).inspection('/inspection/request-attempts')).toEqual(
      targetRequestsBefore,
    );
    expect(await historicalFrame(original.run.runId)).toBe(originalBefore);
    // Output is actual durable evidence for the implementation report.
    const proof = {
      reproductionId: reproduction.id,
      snapshotId: snapshot.id,
      snapshotContentHash: snapshot.contentHash,
      originalRunId: original.run.runId,
      replayRunId: replay.run.runId,
      replaySnapshotId: replayRun.snapshotId,
      originalEvidenceHead: compared.base.evidenceHeadHash,
      replayEvidenceHead: compared.replay.evidenceHeadHash,
      originalMode: originalConfig,
      replayMode: replayConfig,
      originalFrameHash: createHash('sha256').update(originalBefore).digest('hex'),
      preservedFrameHash: createHash('sha256')
        .update(await historicalFrame(original.run.runId))
        .digest('hex'),
      comparison: compared.subjects.filter((s) =>
        ['INV-CHK-1', 'INV-INV-1'].includes(s.invariantKey),
      ),
    };
    const serializedProof = JSON.stringify(proof, null, 2);
    checkNoSecrets(serializedProof);
    console.info('PHASE18_SAME_SNAPSHOT_PROOF', serializedProof);
    const artifactDirectory = process.env['RUPTUREGRID_TEST_ARTIFACT_DIR'];
    if (artifactDirectory !== undefined) {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, `phase18-proof-${replay.run.runId}.json`),
        serializedProof,
        { flag: 'wx' },
      );
    }
  }, 360_000);

  it('protects mode-preserving setup, enforces its closed request contract and leaves mode unchanged', async () => {
    const unauthorized = await fetch(`${running.baseUrl}/demo/admin/scenario-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    const before = await adminJson('/demo/admin/status');
    for (const body of [
      {},
      { scopeToken: suiteScopeToken, sku: suiteSku, initialAvailableUnits: 1, mode: 'VULNERABLE' },
      { scopeToken: suiteScopeToken, sku: suiteSku, initialAvailableUnits: 1.5 },
      {
        scopeToken: suiteScopeToken,
        sku: suiteSku,
        initialAvailableUnits: Number.MAX_SAFE_INTEGER,
      },
    ]) {
      expect((await adminJson('/demo/admin/scenario-context', 'POST', body)).status).toBe(400);
    }
    const reset = await adminJson('/demo/admin/scenario-context', 'POST', {
      scopeToken: suiteScopeToken,
      sku: suiteSku,
      initialAvailableUnits: 1,
    });
    expect(reset.status).toBe(200);
    for (const key of ['mode', 'processingRevision', 'targetInstanceId'])
      expect(reset.body[key]).toBe(before.body[key]);
    const foreign = await adminJson('/demo/admin/scenario-context', 'POST', {
      scopeToken: `foreign-${suiteToken}`,
      sku: suiteSku,
      initialAvailableUnits: 1,
    });
    expect(foreign.status).toBe(409);
    expect((await adminJson('/demo/admin/status')).body).toEqual(before.body);
  });

  it('failed mode-preserving setup blocks delivery and preserves ambiguous execution semantics', async () => {
    const scenario = await scenarioFile('checkout-zero-post-fix.scenario.json', (document) => {
      const steps = (document['experiment'] as Record<string, unknown>)['steps'] as Array<
        Record<string, unknown>
      >;
      const action = steps.find((s) => s['name'] === 'establish-scenario')!['action'] as Record<
        string,
        unknown
      >;
      const body = JSON.parse(action['body'] as string) as Record<string, unknown>;
      body['mode'] = 'VULNERABLE';
      action['body'] = JSON.stringify(body);
    });
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '120s',
      '--report',
      join(workDir, 'failed-context.json'),
      '--json',
    ]);
    expect(result.code).toBe(3);
    const runId = (JSON.parse(result.stdout) as { error: { runId: string } }).error.runId;
    const steps = await prisma.experimentStepRun.findMany({
      where: { runId },
      include: { invocations: true },
    });
    const setup = steps.find((s) => s.name === 'establish-scenario')!;
    expect(setup.state).toBe('FAILED');
    expect(setup.invocations).toHaveLength(1);
    expect(setup.invocations[0]!.sideEffectKnowledge).toBe('INDETERMINATE');
    expect(steps.find((s) => s.name === 'checkout-submit')!.invocations).toHaveLength(0);
  }, 120_000);
});
