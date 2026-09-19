#!/usr/bin/env node
// =====================================================================
// RuptureGrid v1.0 — one-command Incident Zero golden verifier (Phase 7)
// =====================================================================
// `pnpm incident-zero:verify` — the documented one-command proof of the
// canonical golden scenario (incident-zero.md §9; testing-strategy §8):
//
//   1. loads the validated worker/demo environment (R-15);
//   2. spawns one REAL compiled Demo Target per mode plus the REAL
//      worker process (auditor-owned children; exact PIDs printed;
//      SIGTERM cleanup — nothing outside this process's own children
//      is ever signalled);
//   3. ensures the per-mode target registrations (idempotent BY
//      ORIGIN, on the golden suite's env-overridable per-mode demo
//      ports) and verifies frozen scenario intent BEFORE execution;
//   4. executes the canonical mode(s) through the accepted pipeline
//      (runGoldenScenario: real BullMQ dispatch, real execution, real
//      Phase 4 analysis, real Phase 5 forensics);
//   5. asserts the canonical outcome split (APPLIED /
//      IDEMPOTENT_DUPLICATE), normalized entity identities, wallet,
//      INV-IZ-1 verdict, Finding count, and reproduction binding from
//      DURABLE Control-Plane truth — never from the runner's own
//      summary numbers alone (runner-asserts / engine-decides);
//   6. optionally scans every evidence store and child output for a
//      caller-provided canary value (RG_GOLDEN_CANARY) — zero
//      occurrences expected (R-13/ADR-0012). The canary value itself is
//      never printed; only leak locations are.
//
// Exit codes (classified, never a generic "failed"):
//   0  verification passed
//   1  canonical assertion mismatch (semantic verification failure)
//   2  prerequisite failure (config, spawn, registration, readiness)
//   3  timeout (execution or derivation did not materialize in time)
//
// Output: human text by default; `--json` prints the SAME verification
// report as one JSON object (single source of truth for both formats).
// No credential value is ever printed (ADR-0012).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigValidationError, loadDemoConfig, loadWorkerConfig } from '@rupturegrid/config';
import type { DemoConfig, WorkerConfig } from '@rupturegrid/config';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb, PrismaClient } from '@rupturegrid/control-db';
import { GOLDEN_SCENARIO_VERSION } from './contract.js';
import { GoldenRunError, ensureGoldenTargetRegistration, runGoldenScenario } from './run.js';
import type { GoldenMode, GoldenRunResult } from './run-types.js';
import {
  assertEq,
  classifyGoldenError,
  evaluationAssertions,
  EXPECTATIONS,
  frozenIntentAssertions,
} from './verify-core.js';
import type { AssertionResult, ModeCounts, ModeExpectation } from './verify-core.js';

const OUTCOME_EVENT_TYPE = 'demo.processing-attempt-observed';
const PROVIDER_EVENT_EVENT_TYPE = 'demo.provider-event-observed';
const WEBHOOK_DELIVERY_EVENT_TYPE = 'demo.webhook-delivery-observed';

// ---------------------------------------------------------------------
// Child processes — owned, tracked, cleaned up. Nothing outside this
// process's own spawned children is ever signalled.
// ---------------------------------------------------------------------

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
  // dist/cli.js → package root → packages/ → repository root.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

async function waitForCondition(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new GoldenRunError(`${what} did not materialize within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * One REAL Demo Target per mode, on the golden suite's env-overridable
 * ports (DEMO_P7_TEST_PORT / DEMO_P7S_TEST_PORT — the same convention
 * tests/integration/golden-incident-zero.test.ts uses). Per-mode
 * origins keep each mode's registration and experiment definition
 * separable under the engine's global origin authority, so repeated
 * verifications converge on the same frozen definitions on ANY
 * database state (fresh or previously exercised).
 */
const GOLDEN_MODE_PORTS: Record<GoldenMode, string> = {
  VULNERABLE: process.env.DEMO_P7_TEST_PORT ?? '3127',
  SECURE: process.env.DEMO_P7S_TEST_PORT ?? '3131',
};

async function startDemoChild(
  demoConfig: DemoConfig,
  mode: GoldenMode,
): Promise<{ process: OwnedProcess; origin: string }> {
  const port = Number(GOLDEN_MODE_PORTS[mode]);
  const child = spawnOwned(
    `demo-fintech(${mode})`,
    [join('apps', 'demo-fintech', 'dist', 'main.js')],
    {
      ...process.env,
      DEMO_HOST: demoConfig.DEMO_HOST,
      DEMO_PORT: String(port),
      DEMO_DATABASE_URL: demoConfig.DEMO_DATABASE_URL,
      DEMO_ADMIN_TOKEN: demoConfig.DEMO_ADMIN_TOKEN,
      DEMO_INSPECTION_TOKEN: demoConfig.DEMO_INSPECTION_TOKEN,
      DEMO_PROVIDER_SIGNING_SECRET: demoConfig.DEMO_PROVIDER_SIGNING_SECRET,
      NODE_ENV: demoConfig.NODE_ENV,
      LOG_LEVEL: 'warn',
    },
  );
  const origin = `http://${demoConfig.DEMO_HOST}:${port}`;
  try {
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
  } catch {
    await child.close();
    const detail = child.stderr().trim().split('\n').slice(-8).join('\n');
    throw new GoldenRunError(
      `Demo Target (${mode}) did not become live on ${origin} (is port ${port} already occupied? ` +
        `Set DEMO_P7_TEST_PORT / DEMO_P7S_TEST_PORT before verifying). Child stderr tail:\n${detail}`,
    );
  }
  return { process: child, origin };
}

async function startWorkerChild(workerConfig: WorkerConfig): Promise<OwnedProcess> {
  const child = spawnOwned('worker', [join('apps', 'worker', 'dist', 'main.js')], {
    ...process.env,
    CONTROL_DATABASE_URL: workerConfig.CONTROL_DATABASE_URL,
    REDIS_URL: workerConfig.REDIS_URL,
    QUEUE_PREFIX: workerConfig.QUEUE_PREFIX,
    WORKER_LEASE_DURATION_MS: String(workerConfig.WORKER_LEASE_DURATION_MS),
    WORKER_HEARTBEAT_INTERVAL_MS: String(workerConfig.WORKER_HEARTBEAT_INTERVAL_MS),
    WORKER_RECONCILE_INTERVAL_MS: String(workerConfig.WORKER_RECONCILE_INTERVAL_MS),
    WORKER_CONCURRENCY: String(workerConfig.WORKER_CONCURRENCY),
    DEMO_ADMIN_TOKEN: workerConfig.DEMO_ADMIN_TOKEN ?? '',
    DEMO_INSPECTION_TOKEN: workerConfig.DEMO_INSPECTION_TOKEN ?? '',
    DEMO_PROVIDER_SIGNING_SECRET: workerConfig.DEMO_PROVIDER_SIGNING_SECRET ?? '',
    NODE_ENV: workerConfig.NODE_ENV,
    LOG_LEVEL: 'info',
  });
  try {
    await waitForCondition(
      async () => child.stdout().includes('worker ready'),
      20_000,
      'worker readiness',
    );
  } catch {
    await child.close();
    const detail = child.stderr().trim().split('\n').slice(-8).join(' ');
    throw new GoldenRunError(`worker did not start. stderr tail:\n${detail}`);
  }
  return child;
}

// ---------------------------------------------------------------------
// Normalized-evidence outcome counts (durable truth, not summaries).
// ---------------------------------------------------------------------

async function countAttemptOutcomes(
  prisma: PrismaClient,
  runId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.normalizedEvent.findMany({
    where: { runId, eventType: OUTCOME_EVENT_TYPE },
    select: { payload: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const outcome = payload['outcome'];
    if (typeof outcome === 'string') {
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
  }
  return counts;
}

export interface ModeEvaluation {
  readonly mode: GoldenMode;
  readonly runId: string;
  readonly snapshotContentHash: string;
  readonly paymentId: string;
  readonly assertions: readonly AssertionResult[];
  readonly pass: boolean;
}

export async function evaluateModeAssertions(
  prisma: PrismaClient,
  result: GoldenRunResult,
): Promise<ModeEvaluation> {
  const expectation: ModeExpectation = EXPECTATIONS[result.mode];
  const outcomes = await countAttemptOutcomes(prisma, result.runId);
  const [providerEvents, webhookDeliveries, processingAttempts, findingCount] = await Promise.all([
    prisma.normalizedEvent.count({
      where: { runId: result.runId, eventType: PROVIDER_EVENT_EVENT_TYPE },
    }),
    prisma.normalizedEvent.count({
      where: { runId: result.runId, eventType: WEBHOOK_DELIVERY_EVENT_TYPE },
    }),
    prisma.normalizedEvent.count({ where: { runId: result.runId, eventType: OUTCOME_EVENT_TYPE } }),
    prisma.finding.count({ where: { runId: result.runId } }),
  ]);
  const counts: ModeCounts = {
    applied: outcomes.get('APPLIED') ?? 0,
    idempotentDuplicates: outcomes.get('IDEMPOTENT_DUPLICATE') ?? 0,
    providerEvents,
    webhookDeliveries,
    processingAttempts,
    findingCount,
  };
  const assertions = evaluationAssertions(result, expectation, counts);
  return {
    mode: result.mode,
    runId: result.runId,
    snapshotContentHash: result.snapshotContentHash,
    paymentId: result.payment.providerPaymentId,
    assertions,
    pass: assertions.every((assertion) => assertion.pass),
  };
}

// ---------------------------------------------------------------------
// Optional secret canary (R-13/ADR-0012). Scans every durable evidence
// store plus the spawned children's captured output. Leak LOCATIONS
// are reported; the canary VALUE itself is never printed.
// ---------------------------------------------------------------------

const CANARY_STORES: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: 'evidence.raw_observation', column: 'payload' },
  { table: 'evidence.normalized_event', column: 'payload' },
  { table: 'control.run_snapshot', column: 'content' },
  { table: 'analysis.invariant_evaluation', column: 'details' },
  { table: 'analysis.finding', column: 'details' },
  { table: 'analysis.finding', column: 'provenScope' },
  { table: 'analysis.finding', column: 'uncertainScope' },
  { table: 'analysis.forensic_timeline_entry', column: 'details' },
  { table: 'analysis.reproduction_definition', column: 'invariantBindings' },
  { table: 'analysis.reproduction_definition', column: 'acceptanceExpectations' },
];

async function scanForCanary(
  controlDb: ControlDb,
  canary: string,
  children: ReadonlyArray<OwnedProcess>,
): Promise<string[]> {
  const leaks: string[] = [];
  const pattern = `%${canary}%`;
  for (const store of CANARY_STORES) {
    const rows = (await controlDb.prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS hits FROM ${store.table} WHERE "${store.column}"::text LIKE $1`,
      pattern,
    )) as Array<{ hits: number }>;
    if ((rows[0]?.hits ?? 0) > 0) {
      leaks.push(`${store.table}.${store.column}`);
    }
  }
  for (const child of children) {
    if (child.stdout().includes(canary) || child.stderr().includes(canary)) {
      leaks.push(`process:${child.label}(pid ${child.pid})`);
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------
// Verification report — ONE object drives both human and JSON output.
// ---------------------------------------------------------------------

export interface GoldenVerificationReport {
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly scenarioVersion: string;
  readonly spawned: ReadonlyArray<{ readonly label: string; readonly pid: number }>;
  readonly registrations: ReadonlyArray<{
    readonly mode: GoldenMode;
    readonly created: boolean;
    readonly origin: string;
    readonly targetId: string;
  }>;
  readonly frozenIntent: {
    readonly pass: boolean;
    readonly assertions: readonly AssertionResult[];
  };
  readonly modes: ReadonlyArray<
    Pick<
      ModeEvaluation,
      'mode' | 'runId' | 'snapshotContentHash' | 'paymentId' | 'assertions' | 'pass'
    >
  >;
  readonly canary: { readonly scanned: boolean; readonly leaks: readonly string[] };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const json = argv.includes('--json');
  const modeArgs = argv.filter((arg) => arg.startsWith('--mode='));
  let modes: ReadonlyArray<GoldenMode> = ['VULNERABLE', 'SECURE'];
  if (modeArgs.length > 0) {
    const value = modeArgs[0]?.split('=')[1] ?? '';
    if (value === 'vulnerable') {
      modes = ['VULNERABLE'];
    } else if (value === 'secure') {
      modes = ['SECURE'];
    } else {
      process.stderr.write(`unknown --mode value "${value}" (expected vulnerable|secure)\n`);
      return 2;
    }
  }
  if (argv.some((arg) => !arg.startsWith('--') && arg !== 'verify')) {
    process.stderr.write('usage: incident-zero-verify [--mode=vulnerable|secure] [--json]\n');
    return 2;
  }

  const canary = process.env.RG_GOLDEN_CANARY;
  if (canary !== undefined && canary.length < 16) {
    process.stderr.write('RG_GOLDEN_CANARY must be at least 16 characters\n');
    return 2;
  }

  let controlDb: ControlDb | null = null;
  const demos = new Map<GoldenMode, { process: OwnedProcess; origin: string }>();
  let workerChild: OwnedProcess | null = null;
  try {
    // 1. Validated environment (R-15). Worker schema never exposes the
    // demo database; demo schema never exposes control/redis vars.
    const workerConfig = loadWorkerConfig();
    const demoConfig = loadDemoConfig();
    if (
      workerConfig.DEMO_ADMIN_TOKEN === undefined ||
      workerConfig.DEMO_INSPECTION_TOKEN === undefined ||
      workerConfig.DEMO_PROVIDER_SIGNING_SECRET === undefined
    ) {
      throw new ConfigValidationError([
        'DEMO_ADMIN_TOKEN / DEMO_INSPECTION_TOKEN / DEMO_PROVIDER_SIGNING_SECRET are required to verify',
      ]);
    }

    // 2. Own children: one real Demo Target per mode + real worker
    // (exact PIDs printed; all are this process's own children).
    for (const mode of modes) {
      demos.set(mode, await startDemoChild(demoConfig, mode));
    }
    workerChild = await startWorkerChild(workerConfig);
    const spawned = [
      ...[...demos.values()].map((demo) => ({ label: demo.process.label, pid: demo.process.pid })),
      ...(workerChild === null ? [] : [{ label: workerChild.label, pid: workerChild.pid }]),
    ];

    // 3. Durable store handle + per-mode registrations (idempotent BY
    // ORIGIN — one registration per mode's demo origin). Display names
    // are DETERMINISTIC so the same canonical config freezes the same
    // snapshot content hash on any fresh database (§50: generated
    // values never differentiate canonical intent).
    controlDb = createControlDb(workerConfig.CONTROL_DATABASE_URL);
    const registrations = new Map<
      GoldenMode,
      { created: boolean; origin: string; targetId: string }
    >();
    for (const mode of modes) {
      const demo = demos.get(mode);
      if (demo === undefined) {
        throw new GoldenRunError(`demo target for mode ${mode} is not running`);
      }
      registrations.set(
        mode,
        await ensureGoldenTargetRegistration(
          controlDb.prisma,
          demo.origin,
          `incident-zero-verify-${mode.toLowerCase()}`,
        ),
      );
    }
    const registrationRows = [...registrations].map(([mode, registration]) => ({
      mode,
      created: registration.created,
      origin: registration.origin,
      targetId: registration.targetId,
    }));

    // 4. Frozen intent — before ANY execution.
    const intentAssertions = frozenIntentAssertions();
    const intentPass = intentAssertions.every((assertion) => assertion.pass);
    if (!intentPass) {
      const report: GoldenVerificationReport = {
        ok: false,
        exitCode: 1,
        scenarioVersion: GOLDEN_SCENARIO_VERSION,
        spawned,
        registrations: registrationRows,
        frozenIntent: { pass: false, assertions: intentAssertions },
        modes: [],
        canary: { scanned: false, leaks: [] },
      };
      emit(report, json);
      return 1;
    }

    // 5. Canonical executions — accepted pipeline only; the mode is an
    // explicit option (never inferred from names or live state).
    const evaluations: ModeEvaluation[] = [];
    for (const mode of modes) {
      const registration = registrations.get(mode);
      if (registration === undefined) {
        throw new GoldenRunError(`no registration for mode ${mode}`);
      }
      const result = await runGoldenScenario({
        prisma: controlDb.prisma,
        redisUrl: workerConfig.REDIS_URL,
        queuePrefix: workerConfig.QUEUE_PREFIX,
        targetId: registration.targetId,
        mode,
      });
      evaluations.push(await evaluateModeAssertions(controlDb.prisma, result));
    }

    // Cross-run isolation: distinct logical payments per run (§59), and
    // distinct snapshot intents for distinct modes (§63).
    if (evaluations.length === 2) {
      const [first, second] = evaluations;
      if (first !== undefined && second !== undefined) {
        const crossRun: AssertionResult[] = [
          assertEq('cross-run.distinct-payments', true, first.paymentId !== second.paymentId),
          assertEq(
            'cross-mode.distinct-snapshots',
            true,
            first.snapshotContentHash !== second.snapshotContentHash,
          ),
        ];
        const failing = crossRun.filter((assertion) => !assertion.pass);
        evaluations[0] = {
          ...first,
          assertions: [...first.assertions, ...crossRun],
          pass: first.pass && failing.length === 0,
        };
      }
    }

    // 6. Optional canary scan across evidence + child output.
    const canaryLeaks =
      canary === undefined || controlDb === null
        ? []
        : await scanForCanary(
            controlDb,
            canary,
            [...demos.values()]
              .map((demo) => demo.process)
              .concat(workerChild === null ? [] : [workerChild]),
          );
    const canaryPass = canary === undefined || canaryLeaks.length === 0;

    const ok = intentPass && evaluations.every((evaluation) => evaluation.pass) && canaryPass;
    const report: GoldenVerificationReport = {
      ok,
      exitCode: ok ? 0 : 1,
      scenarioVersion: GOLDEN_SCENARIO_VERSION,
      spawned,
      registrations: registrationRows,
      frozenIntent: { pass: intentPass, assertions: intentAssertions },
      modes: evaluations,
      canary: { scanned: canary !== undefined, leaks: canaryLeaks },
    };
    emit(report, json);
    return report.exitCode;
  } catch (error) {
    const exitCode = classifyGoldenError(error);
    const label =
      exitCode === 2 ? 'PREREQUISITE FAILURE' : exitCode === 3 ? 'TIMEOUT' : 'VERIFICATION FAILURE';
    process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    return exitCode;
  } finally {
    if (workerChild !== null) {
      await workerChild.close();
    }
    for (const demo of demos.values()) {
      await demo.process.close();
    }
    if (controlDb !== null) {
      await controlDb.disconnect();
    }
  }
}

function emit(report: GoldenVerificationReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  lines.push(
    `RuptureGrid — Incident Zero golden verification (scenario ${report.scenarioVersion})`,
  );
  for (const child of report.spawned) {
    lines.push(`  spawned ${child.label} pid=${child.pid}`);
  }
  for (const registration of report.registrations) {
    lines.push(
      `  registration (${registration.mode}) ${registration.created ? 'created' : 'reused'} for origin ${registration.origin}`,
    );
  }
  const passed = (assertions: ReadonlyArray<AssertionResult>): number =>
    assertions.filter((assertion) => assertion.pass).length;
  lines.push(
    `  frozen intent: ${passed(report.frozenIntent.assertions)}/${report.frozenIntent.assertions.length} assertions ` +
      `${report.frozenIntent.pass ? 'pass' : 'FAIL'}`,
  );
  for (const assertion of report.frozenIntent.assertions) {
    if (!assertion.pass) {
      lines.push(
        `    ✗ ${assertion.name}: expected ${assertion.expected}, observed ${assertion.actual}`,
      );
    }
  }
  for (const mode of report.modes) {
    lines.push(
      `  ${mode.mode} run=${mode.runId} snapshot=${mode.snapshotContentHash.slice(0, 12)}… ` +
        `${passed(mode.assertions)}/${mode.assertions.length} assertions ${mode.pass ? 'pass' : 'FAIL'}`,
    );
    for (const assertion of mode.assertions) {
      if (!assertion.pass) {
        lines.push(
          `    ✗ ${assertion.name}: expected ${assertion.expected}, observed ${assertion.actual}`,
        );
      }
    }
  }
  if (report.canary.scanned) {
    lines.push(
      `  canary: ${report.canary.leaks.length === 0 ? '0 leaks' : `LEAKS at ${report.canary.leaks.join(', ')}`}`,
    );
  }
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
