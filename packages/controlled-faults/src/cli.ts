#!/usr/bin/env node
// =====================================================================
// RuptureGrid v1.0 — one-command controlled-faults verifier (Phase 9)
// =====================================================================
// `pnpm controlled-faults:verify` — the documented Phase 9 proof
// (docs/controlled-faults.md §8):
//
//   1. loads the validated worker/demo environment (R-15);
//   2. spawns one REAL compiled Demo Target and the REAL worker
//      process (auditor-owned children; SIGTERM cleanup);
//   3. ensures the Demo target registration (idempotent by origin);
//   4. executes BOTH crown-jewel scenarios — PRE_MUTATION_REJECTION
//      and POST_MUTATION response-loss (RESPONSE_TRUNCATION) — EACH
//      TWICE (repeatability), through the real pipeline;
//   5. verifies, from DURABLE Control-Plane truth and target-authored
//      fault-status observations: configured/activated counts,
//      transport outcome classification, sideEffectKnowledge, retry
//      counts, target inspection effect counts, invariant verdicts,
//      Finding counts, timeline CONFIGURED/ACTIVATED entries, evidence
//      chain integrity, and the frozen reproduction fault intent;
//   6. verifies NO cross-run fault leakage (no stale armed plan).
//
// Every wait is bounded. Exit codes (classified):
//   0  verification passed
//   1  assertion mismatch (semantic verification failure)
//   2  prerequisite failure (config, spawn, registration)
//   3  timeout
//
// Output: human text by default; `--json` prints the SAME report as
// one JSON object. No credential value is ever printed (ADR-0012).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigValidationError, loadDemoConfig, loadWorkerConfig } from '@rupturegrid/config';
import type { DemoConfig, WorkerConfig } from '@rupturegrid/config';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { registerTarget } from '@rupturegrid/engine';
import { runRunAnalysis } from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import {
  CONTROLLED_FAULTS_CONTRACT_VERSION,
  PRE_MUTATION_STEPS,
  RESPONSE_LOSS_STEPS,
} from './contract.js';
import { ControlledFaultsRunError, executeScenario } from './runner.js';
import { preMutationAssertions, responseLossAssertions } from './verify-core.js';
import type { AssertionResult } from './verify-core.js';

const DEMO_PORT = Number(process.env.DEMO_P9_TEST_PORT ?? '3135');
const SCENARIO_TIMEOUT_MS = Number(process.env.RG_CF_SCENARIO_TIMEOUT_MS ?? '180_000');
const RUNS_PER_SCENARIO = 2;

interface OwnedProcess {
  readonly pid: number;
  readonly label: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  close(): Promise<void>;
}

function spawnOwned(
  label: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): OwnedProcess {
  const child: ChildProcess = spawn(process.execPath, [...args], {
    cwd: repoRoot(),
    env,
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
  return {
    pid: child.pid ?? -1,
    label,
    stdout: () => stdout,
    stderr: () => stderr,
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

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

async function waitForCondition(
  probe: () => Promise<boolean> | boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new ControlledFaultsRunError(`${what} did not materialize within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface ScenarioEvaluation {
  readonly scenario: string;
  readonly iteration: number;
  readonly runId: string;
  readonly finalState: string;
  readonly pass: boolean;
  readonly assertions: readonly AssertionResult[];
  /** Diagnostics only (never credentials): worker stderr tail on failure. */
  readonly diagnostics?: string;
}

interface FaultsVerificationReport {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly contractVersion: string;
  readonly spawned: Array<{ pid: number; label: string }>;
  readonly scenarios: ScenarioEvaluation[];
  readonly leakageCheck: { pass: boolean; detail: string };
}

async function main(argv: ReadonlyArray<string>): Promise<0 | 1 | 2 | 3> {
  const json = argv.includes('--json');
  let controlDb: ControlDb | null = null;
  let demoChild: OwnedProcess | null = null;
  let workerChild: OwnedProcess | null = null;
  const spawned: Array<{ pid: number; label: string }> = [];
  try {
    // ---- 1. Validated environment (R-15) ----
    let demoConfig: DemoConfig;
    let workerConfig: WorkerConfig;
    try {
      demoConfig = loadDemoConfig();
      workerConfig = loadWorkerConfig();
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw new ControlledFaultsRunError(`configuration invalid: ${error.message}`);
      }
      throw error;
    }
    const origin = `http://${demoConfig.DEMO_HOST}:${DEMO_PORT}`;

    // ---- 2. Real children (owned, cleaned up) ----
    demoChild = spawnOwned('demo-fintech', [join('apps', 'demo-fintech', 'dist', 'main.js')], {
      ...process.env,
      DEMO_HOST: demoConfig.DEMO_HOST,
      DEMO_PORT: String(DEMO_PORT),
      DEMO_DATABASE_URL: demoConfig.DEMO_DATABASE_URL,
      DEMO_ADMIN_TOKEN: demoConfig.DEMO_ADMIN_TOKEN,
      DEMO_INSPECTION_TOKEN: demoConfig.DEMO_INSPECTION_TOKEN,
      DEMO_PROVIDER_SIGNING_SECRET: demoConfig.DEMO_PROVIDER_SIGNING_SECRET,
      NODE_ENV: demoConfig.NODE_ENV,
      LOG_LEVEL: 'warn',
    });
    spawned.push({ pid: demoChild.pid, label: demoChild.label });
    workerChild = spawnOwned('worker', [join('apps', 'worker', 'dist', 'main.js')], {
      ...process.env,
      CONTROL_DATABASE_URL: workerConfig.CONTROL_DATABASE_URL,
      REDIS_URL: workerConfig.REDIS_URL,
      QUEUE_PREFIX: workerConfig.QUEUE_PREFIX,
      WORKER_LEASE_DURATION_MS: String(workerConfig.WORKER_LEASE_DURATION_MS),
      WORKER_HEARTBEAT_INTERVAL_MS: String(workerConfig.WORKER_HEARTBEAT_INTERVAL_MS),
      WORKER_RECONCILE_INTERVAL_MS: String(workerConfig.WORKER_RECONCILE_INTERVAL_MS),
      WORKER_CONCURRENCY: '2',
      DEMO_ADMIN_TOKEN: workerConfig.DEMO_ADMIN_TOKEN ?? '',
      DEMO_INSPECTION_TOKEN: workerConfig.DEMO_INSPECTION_TOKEN ?? '',
      DEMO_PROVIDER_SIGNING_SECRET: workerConfig.DEMO_PROVIDER_SIGNING_SECRET ?? '',
      NODE_ENV: workerConfig.NODE_ENV,
      LOG_LEVEL: 'info',
    });
    spawned.push({ pid: workerChild.pid, label: workerChild.label });

    await waitForCondition(
      async () => {
        try {
          const response = await fetch(`${origin}/health/live`, {
            signal: AbortSignal.timeout(1_000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      20_000,
      `Demo Target ${origin}/health/live`,
    );
    await waitForCondition(
      () => workerChild !== null && workerChild.stdout().includes('worker ready'),
      20_000,
      'worker readiness',
    );

    // ---- 3. Registration (idempotent by origin) ----
    controlDb = createControlDb(workerConfig.CONTROL_DATABASE_URL);
    await controlDb.ping();
    let targetId: string;
    try {
      const registered = await registerTarget(controlDb.prisma, {
        displayName: `controlled-faults-verify-${randomUUID().slice(0, 8)}`,
        environment: 'LOCAL_DEVELOPMENT',
        origins: [origin],
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: [
          'DEMO_ADMIN_TOKEN',
          'DEMO_INSPECTION_TOKEN',
          'DEMO_PROVIDER_SIGNING_SECRET',
        ],
      });
      targetId = registered.targetId;
    } catch {
      const existing = await controlDb.prisma.targetRegistration.findFirstOrThrow({
        where: { origins: { some: { origin } } },
      });
      targetId = existing.id;
    }

    // ---- 4. Both scenarios, each twice (repeatability) ----
    const evaluations: ScenarioEvaluation[] = [];
    const scenarios: Array<{
      name: string;
      steps: () => Array<Record<string, unknown>>;
      assert: (prisma: ControlDb['prisma'], runId: string) => Promise<AssertionResult[]>;
    }> = [
      { name: 'PRE_MUTATION_REJECTION', steps: PRE_MUTATION_STEPS, assert: preMutationAssertions },
      { name: 'RESPONSE_LOSS', steps: RESPONSE_LOSS_STEPS, assert: responseLossAssertions },
    ];
    for (const scenario of scenarios) {
      for (let iteration = 1; iteration <= RUNS_PER_SCENARIO; iteration += 1) {
        const result = await executeScenario(controlDb.prisma, {
          redisUrl: workerConfig.REDIS_URL,
          queuePrefix: workerConfig.QUEUE_PREFIX,
          targetId,
          scenarioName: `controlled-faults-${scenario.name.toLowerCase()}-i${iteration}-${randomUUID().slice(0, 8)}`,
          steps: scenario.steps(),
          runTimeoutMs: SCENARIO_TIMEOUT_MS,
        });
        // Phase 4 + Phase 5 derivation for THIS run (idempotent).
        await runRunAnalysis(controlDb.prisma, result.runId);
        await deriveRunForensics(controlDb.prisma, result.runId);
        const assertions = await scenario.assert(controlDb.prisma, result.runId);
        const pass = assertions.every((assertion) => assertion.pass);
        evaluations.push({
          scenario: scenario.name,
          iteration,
          runId: result.runId,
          finalState: result.finalState,
          pass,
          assertions,
          ...(pass || workerChild === null
            ? {}
            : {
                diagnostics: workerChild.stderr().trim().split('\n').slice(-6).join('\n'),
              }),
        });
      }
    }

    // ---- 5. Cross-run leakage: the target must hold no live plan ----
    let leakagePass = true;
    let leakageDetail = '';
    try {
      const response = await fetch(`${origin}/inspection/faults`, {
        headers: { authorization: `Bearer ${demoConfig.DEMO_INSPECTION_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { plans?: Array<{ expired?: boolean }> };
      const live = (body.plans ?? []).filter((plan) => plan.expired !== true);
      leakagePass = live.length === 0;
      leakageDetail = leakagePass
        ? 'no live (unexpired) armed plan remains'
        : `live plans remain: ${live.length}`;
    } catch (error) {
      leakagePass = false;
      leakageDetail = `leakage probe failed: ${error instanceof Error ? error.message : 'unknown'}`;
    }

    const ok = evaluations.every((evaluation) => evaluation.pass) && leakagePass;
    const report: FaultsVerificationReport = {
      ok,
      exitCode: ok ? 0 : 1,
      contractVersion: CONTROLLED_FAULTS_CONTRACT_VERSION,
      spawned,
      scenarios: evaluations,
      leakageCheck: { pass: leakagePass, detail: leakageDetail },
    };
    emit(report, json);
    return report.exitCode;
  } catch (error) {
    if (
      error instanceof ControlledFaultsRunError &&
      /did not materialize|did not reach/.test(error.message)
    ) {
      process.stderr.write(`TIMEOUT: ${error.message}\n`);
      return 3;
    }
    process.stderr.write(
      `PREREQUISITE/VERIFICATION FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    if (workerChild !== null) {
      await workerChild.close();
    }
    if (demoChild !== null) {
      await demoChild.close();
    }
    if (controlDb !== null) {
      await controlDb.disconnect();
    }
  }
}

function emit(report: FaultsVerificationReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  lines.push(`RuptureGrid — Phase 9 controlled-faults verification (${report.contractVersion})`);
  for (const child of report.spawned) {
    lines.push(`  spawned ${child.label} pid=${child.pid}`);
  }
  for (const scenario of report.scenarios) {
    const passed = scenario.assertions.filter((assertion) => assertion.pass).length;
    lines.push(
      `  ${scenario.scenario} #${scenario.iteration} run=${scenario.runId} state=${scenario.finalState} ` +
        `${passed}/${scenario.assertions.length} assertions ${scenario.pass ? 'pass' : 'FAIL'}`,
    );
    for (const assertion of scenario.assertions) {
      if (!assertion.pass) {
        lines.push(
          `    ✗ ${assertion.name}: expected ${assertion.expected}, observed ${assertion.actual}`,
        );
      }
    }
    if (!scenario.pass && scenario.diagnostics !== undefined && scenario.diagnostics.length > 0) {
      lines.push('    [worker stderr tail]');
      for (const line of scenario.diagnostics.split('\n')) {
        lines.push(`      ${line}`);
      }
    }
  }
  lines.push(
    `  leakage: ${report.leakageCheck.pass ? 'none' : `FAIL — ${report.leakageCheck.detail}`}`,
  );
  lines.push(`RESULT: ${report.ok ? 'PASS' : 'FAIL'} (exit ${report.exitCode})`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
