#!/usr/bin/env node
// =====================================================================
// RuptureGrid v1.1 Phase 17 — the headless CLI entrypoint (ADR-0019)
// =====================================================================
// SOURCE-ONLY, BY CONTRACT (ADR-0019 §5): this CLI runs from a
// RuptureGrid checkout via the root `pnpm rupturegrid …` scripts.
// v1.1 does NOT publish an npm / Docker / binary CLI — public
// distribution is deferred and requires its own release-policy ADR.
// This help text IS the honesty surface.
//
// Commands (Phase 17):
//   rupturegrid scenarios validate <scenario.json>
//       Closed-schema validation ONLY. Nothing executes: no run, no
//       revision, no target HTTP request. Invalid input → exit 4.
//
//   rupturegrid run <scenario.json> --wait --timeout <duration>
//                    --report <file> [--json]
//       The full audited flow (see orchestrator.ts): validate →
//       resolve target → engine-validate → revision → snapshot →
//       dispatch → bounded poll → idempotent analysis → integrity →
//       report → exit class. `--wait` is required for `run` in v1
//       (headless semantics are the only semantics).
//
//   rupturegrid schemas emit
//       (Re)writes the published JSON Schema files (development
//       utility; the committed copies under packages/cli/schemas are
//       authoritative).
//
//   rupturegrid replay --reproduction <id> --report <file> [--json]
//                    [--timeout <duration>]
//       A NEW run from the SAME hash-pinned snapshot the reproduction
//       definition binds (ADR-0019 Decision 4; incident-replay §3):
//       validate binding → create run on the stored snapshot →
//       dispatch → bounded poll → idempotent analysis → integrity →
//       report → exit class. The original run's history is never
//       modified. Binding failures (missing reproduction, rotated or
//       missing credentials, mismatched bindings, unavailable versions,
//       unauthorized destinations) fail closed before execution.
//
//   rupturegrid compare <runId> <otherRunId> [--json] [--report <file>]
//       Computed-on-read comparison of two runs of the SAME frozen
//       intent (incident-replay §6): snapshot hash, target/experiment
//       identity, invariant keys + versions, per-subject verdicts,
//       effect counts, findings, evidence references, uncertainty and
//       provenance. Cross-intent pairs are refused (exit 4).
//
// Exit codes (the five-way contract, ADR-0019 §2):
//   0 PASS · 1 INVARIANT_FAIL · 2 NOT_EVALUABLE · 3 EXECUTION_FAILURE
//   4 USAGE_ERROR
//
// Output discipline (§43/§44): `--json` writes machine-parseable JSON
// ONLY to stdout (the report object, or a documented safe machine
// error object when no report exists); human mode writes a concise
// summary; diagnostics go to stderr. No secret value is ever printed
// (ADR-0012) — reference NAMES only. No AI interpretation anywhere.

import { writeFile, rename, unlink, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { EXECUTOR_SIGNING_CREDENTIAL_REFS, loadCliConfig } from '@rupturegrid/config';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { ScenarioValidationError, parseScenarioFile } from './scenario.js';
import {
  authoritativeCredentialPolicyFromConfig,
  validateScenarioAuthoritative,
} from './validate-scenario-authoritative.js';
import { TargetResolutionError } from './validate-scenario-authoritative.js';
import {
  executeScenario,
  executeReplay,
  AnalysisTimeoutError,
  TargetRegistrationError,
  ReplayRequestError,
  ReplayValidationError,
} from './orchestrator.js';
import type { RunOutcome } from './orchestrator.js';
import { compareReplayRuns, RunComparisonError } from '@rupturegrid/forensics';
import type { ReplayComparisonResult } from '@rupturegrid/forensics';
import { ExperimentValidationError, RunCreationError } from '@rupturegrid/engine';
import { exitCodeFor } from './exit-code.js';
import { buildReport, ReportEmitterError } from './report.js';
import { validateReportAgainstSchema, ReportSchemaValidationError } from './schema-validate.js';
import { emitSchemas } from './schema-emit.js';
import { loadTestExitOverrides } from './cli-config-overrides.js';

const USAGE = `rupturegrid — RuptureGrid v1.1 headless CLI (Phase 17)

RUNS FROM A RUPTUREGRID SOURCE CHECKOUT. v1.1 does NOT publish an
npm / Docker / binary CLI; public distribution is deferred (ADR-0019 §5).

Commands:
  scenarios validate <scenario.json>
      Validate a rupturegrid-scenario/v1 document (closed schema).
      Nothing executes: no run is created, no target request occurs.
      Exit 4 on any invalid input.

  run <scenario.json> --wait --timeout <duration> --report <file> [--json]
      Execute the scenario headlessly and emit rupturegrid-report/v1.
        --wait              required in v1: bounded-poll durable run state
        --timeout <ms|s|m>  bounded wait ceiling for terminal execution
        --report <file>     rupturegrid-report/v1 JSON artifact path
        --json              stdout is machine-parseable JSON only
      Exit codes: 0 PASS · 1 INVARIANT_FAIL · 2 NOT_EVALUABLE ·
                  3 EXECUTION_FAILURE · 4 USAGE_ERROR

  replay --reproduction <id> --report <file> [--json] [--timeout <duration>]
      Execute a NEW run from the SAME hash-pinned snapshot bound by the
      durable reproduction definition <id>, and emit rupturegrid-report/v1.
        --reproduction <id> the durable reproduction definition to replay
        --report <file>     rupturegrid-report/v1 JSON artifact path
        --json              stdout is machine-parseable JSON only
        --timeout <ms|s|m>  bounded wait ceiling (default 120s)
      The original run's observations, evaluations, and findings are
      never modified. Exit codes: same five-way contract as run.

  compare <runId> <otherRunId> [--json] [--report <file>]
      Compare two runs of the SAME frozen intent from durable truth.
      Cross-intent pairs (different snapshot hashes) are refused.
      Read-only: nothing executes, nothing durable is written.

  schemas emit
      (Re)write the published JSON Schemas under packages/cli/schemas.

Scenario expectations are NEVER truth: the exit code and report are
computed from durable Control-Plane truth only.
`;

interface RunFlags {
  readonly scenarioPath: string;
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly reportPath: string | null;
  readonly json: boolean;
}

interface ReplayFlags {
  readonly reproductionId: string;
  readonly timeoutMs: number;
  readonly reportPath: string | null;
  readonly json: boolean;
}

/** The default bounded wait ceiling for replay (documented in help). */
export const REPLAY_DEFAULT_TIMEOUT_MS = 120_000;

/** Parses `replay` flags. Returns the flags or an error message string. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReplayArgs(args: readonly string[]): ReplayFlags | string {
  let reproductionId: string | null = null;
  let json = false;
  let timeoutRaw: string | null = null;
  let reportPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--reproduction') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--reproduction requires a reproduction definition id';
      }
      reproductionId = next;
      index += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--reproduction=')) {
      reproductionId = (arg.split('=')[1] ?? '').trim() || null;
    } else if (arg === '--timeout') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--timeout requires a duration value (e.g. 120s)';
      }
      timeoutRaw = next;
      index += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--timeout=')) {
      timeoutRaw = (arg.split('=')[1] ?? '').trim() || null;
    } else if (arg === '--report') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--report requires a file path';
      }
      reportPath = next;
      index += 1;
    } else if (arg?.startsWith('--report=')) {
      reportPath = (arg.split('=')[1] ?? '').trim() || null;
    } else if (arg === '--force-production' || arg === '--unsafe' || arg === '--skip-security') {
      // §65: production targeting stays denied; no hidden override exists.
      return `unknown or forbidden flag "${arg}" (production targeting is denied in v1; no unsafe override exists)`;
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      return `unknown flag "${arg}"`;
    } else if (arg !== undefined) {
      return `unexpected positional argument "${arg}" (replay takes --reproduction <id>)`;
    }
  }
  if (reproductionId === null || reproductionId === '') {
    return 'replay requires --reproduction <id> (the durable reproduction definition to replay)';
  }
  const timeoutMs =
    timeoutRaw === null ? REPLAY_DEFAULT_TIMEOUT_MS : parseTimeoutDuration(timeoutRaw);
  if (timeoutMs === null) {
    return `malformed timeout "${timeoutRaw ?? ''}" (expected forms: 30000, 30s, 5m; bounded 1ms..1h)`;
  }
  if (!UUID_PATTERN.test(reproductionId)) {
    return 'reproduction definition id must be a UUID';
  }
  return { reproductionId, timeoutMs, reportPath, json };
}

interface CompareFlags {
  readonly baseRunId: string;
  readonly otherRunId: string;
  readonly reportPath: string | null;
  readonly json: boolean;
}

/** Parses `compare` flags. Returns the flags or an error message string. */
export function parseCompareArgs(args: readonly string[]): CompareFlags | string {
  const positional: string[] = [];
  let json = false;
  let reportPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--report') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--report requires a file path';
      }
      reportPath = next;
      index += 1;
    } else if (arg?.startsWith('--report=')) {
      reportPath = (arg.split('=')[1] ?? '').trim() || null;
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      return `unknown flag "${arg}"`;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length !== 2 || positional[0] === undefined || positional[1] === undefined) {
    return 'compare requires exactly two run ids: compare <runId> <otherRunId>';
  }
  if (positional.some((id) => !UUID_PATTERN.test(id))) {
    return 'compare run ids must be UUIDs';
  }
  return { baseRunId: positional[0], otherRunId: positional[1], reportPath, json };
}

/** Parses a bounded duration (ms | s | m) — malformed input is usage error. */
export function parseTimeoutDuration(raw: string): number | null {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const ms = unit === 'ms' ? value : unit === 's' ? value * 1000 : value * 60_000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 3_600_000) {
    return null;
  }
  return ms;
}

/** Parses `run` flags. Returns the flags or an error message string. */
export function parseRunArgs(args: readonly string[]): RunFlags | string {
  const positional: string[] = [];
  let wait = false;
  let json = false;
  let timeoutRaw: string | null = null;
  let reportPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--wait') {
      wait = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--timeout') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--timeout requires a duration value (e.g. 120s)';
      }
      timeoutRaw = next;
      index += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--timeout=')) {
      timeoutRaw = (arg.split('=')[1] ?? '').trim() || null;
    } else if (arg === '--report') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return '--report requires a file path';
      }
      reportPath = next;
      index += 1;
    } else if (arg?.startsWith('--report=')) {
      reportPath = (arg.split('=')[1] ?? '').trim() || null;
    } else if (arg === '--force-production' || arg === '--unsafe' || arg === '--skip-security') {
      // §65: production targeting stays denied; no hidden override exists.
      return `unknown or forbidden flag "${arg}" (production targeting is denied in v1; no unsafe override exists)`;
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      return `unknown flag "${arg}"`;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    return 'run requires exactly one scenario file argument';
  }
  if (!wait) {
    return 'run requires --wait (bounded-poll headless semantics are the only v1 semantics)';
  }
  if (timeoutRaw === null) {
    return 'run requires --timeout <duration> (the bounded wait ceiling)';
  }
  const timeoutMs = parseTimeoutDuration(timeoutRaw);
  if (timeoutMs === null) {
    return `malformed timeout "${timeoutRaw}" (expected forms: 30000, 30s, 5m; bounded 1ms..1h)`;
  }
  return {
    scenarioPath: positional[0] as string,
    wait,
    timeoutMs,
    reportPath,
    json,
  };
}

/** Safe machine error object (documented, secret-free, §70). */
interface MachineError {
  readonly error: {
    readonly code: 'USAGE_ERROR' | 'EXECUTION_FAILURE';
    readonly message: string;
    readonly runId: string | null;
    readonly report: null;
  };
}

function machineError(
  code: 'USAGE_ERROR' | 'EXECUTION_FAILURE',
  message: string,
  runId: string | null = null,
): MachineError {
  return { error: { code, message, runId, report: null } };
}

function boundedMessage(error: unknown): string {
  // Bounded, safe, secret-free (no stack traces for expected errors).
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 600 ? `${message.slice(0, 600)}…` : message;
}

export interface CliDeps {
  readonly argv: readonly string[];
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Test seam: override the process exit code instead of exiting. */
  readonly exit: (code: number) => void;
  /** Test seam: overrides for env-derived behavior. */
  readonly overrides?: {
    readonly runTimeoutMs?: number;
    readonly analysisTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly controlDatabaseUrl?: string;
    readonly redisUrl?: string;
    readonly queuePrefix?: string;
  };
}

export async function cliMain(deps: CliDeps): Promise<void> {
  const [command, ...rest] = deps.argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    deps.stdout(USAGE);
    deps.exit(command === undefined ? 4 : 0);
    return;
  }

  if (command === 'replay') {
    const parsed = parseReplayArgs(rest);
    if (typeof parsed === 'string') {
      deps.stderr(`error: ${parsed}\n`);
      deps.stderr(
        'usage: rupturegrid replay --reproduction <id> --report <file> [--json] [--timeout <duration>] (Phase 18 replay lifecycle)\n',
      );
      deps.exit(4);
      return;
    }
    await replayCommand(deps, parsed);
    return;
  }

  if (command === 'compare') {
    const parsed = parseCompareArgs(rest);
    if (typeof parsed === 'string') {
      deps.stderr(`error: ${parsed}\n`);
      deps.stderr('usage: rupturegrid compare <runId> <otherRunId> [--json] [--report <file>]\n');
      deps.exit(4);
      return;
    }
    await compareCommand(deps, parsed);
    return;
  }

  if (command === 'schemas') {
    if (rest[0] !== 'emit') {
      deps.stderr('error: schemas requires "emit"\n');
      deps.exit(4);
      return;
    }
    const written = await emitSchemas();
    deps.stdout(`wrote:\n  ${written.join('\n  ')}\n`);
    deps.exit(0);
    return;
  }

  if (command === 'scenarios') {
    const scenarioPath = rest[1];
    if (rest[0] !== 'validate' || scenarioPath === undefined || scenarioPath.startsWith('-')) {
      deps.stderr('usage: rupturegrid scenarios validate <scenario.json>\n');
      deps.exit(4);
      return;
    }
    try {
      const scenario = await parseScenarioFile(scenarioPath);
      // ---- B3 repair: AUTHORITATIVE validation, not envelope-only. ----
      // The validate command performs the SAME steps the run path
      // performs before anything durable: closed-envelope validation →
      // registered-target lookup (read-only) → the CURRENT SERVER-OWNED
      // grant policy → the engine's OWN
      // validateExperimentDocument (steps + credential refs + invariant
      // bindings against the target's frozen manifest policy). No
      // durable write happens (no definition, revision, snapshot, run,
      // or step row), no target HTTP request, no queue dispatch (§18).
      const config = loadCliConfig();
      const controlUrl = loadTestExitOverrides()?.controlDatabaseUrl ?? config.CONTROL_DATABASE_URL;
      const validationDb = createControlDb(controlUrl);
      try {
        const validated = await validateScenarioAuthoritative({
          prisma: validationDb.prisma,
          scenario,
          credentialPolicy: authoritativeCredentialPolicyFromConfig(config),
        });
        deps.stdout(
          `scenario "${scenario.name}" is a valid ${scenario.schemaVersion} document — ` +
            `authoritative engine validation passed against registered target ` +
            `"${validated.targetDisplayName}" (no durable write; nothing executed)\n`,
        );
        deps.exit(0);
      } finally {
        await validationDb.disconnect();
      }
      return;
    } catch (error) {
      if (
        error instanceof ScenarioValidationError ||
        error instanceof ExperimentValidationError ||
        error instanceof TargetResolutionError ||
        error instanceof TargetRegistrationError
      ) {
        deps.stderr(`${boundedMessage(error)}\n`);
        deps.exit(4); // USAGE_ERROR — nothing durable happened (§18/§19).
        return;
      }
      // Any other failure (e.g. the Control DB is unreachable) is still
      // usage-class refused at the command surface: validation could
      // not be completed HONESTLY, so nothing is valid-by-assertion.
      deps.stderr(`error: ${boundedMessage(error)}\n`);
      deps.exit(4);
      return;
    }
  }

  if (command === 'run') {
    const parsed = parseRunArgs(rest);
    if (typeof parsed === 'string') {
      deps.stderr(`error: ${parsed}\n`);
      deps.stderr(
        'usage: rupturegrid run <scenario.json> --wait --timeout <duration> --report <file> [--json]\n',
      );
      deps.exit(4);
      return;
    }
    await runCommand(deps, parsed);
    return;
  }

  deps.stderr(`error: unknown command "${command}"\n`);
  deps.stdout(USAGE);
  deps.exit(4);
}

async function runCommand(deps: CliDeps, flags: RunFlags): Promise<void> {
  let controlDb: ControlDb | null = null;
  let runId: string | null = null;
  try {
    // ---- 1./2./3. load → parse → closed-schema validate (pure). ----
    const scenario = await parseScenarioFile(flags.scenarioPath);

    // ---- Config + durable store handle. ----
    const overrides = loadTestExitOverrides();
    const config = loadCliConfig();
    controlDb = createControlDb(
      deps.overrides?.controlDatabaseUrl ??
        overrides?.controlDatabaseUrl ??
        config.CONTROL_DATABASE_URL,
    );
    const redisUrl = deps.overrides?.redisUrl ?? config.REDIS_URL;
    const queuePrefix = deps.overrides?.queuePrefix ?? config.QUEUE_PREFIX;

    // ---- 4.–14. the audited flow. ----
    const outcome = await executeScenario(controlDb.prisma, scenario, {
      redisUrl,
      queuePrefix,
      // The SERVER-OWNED platform grant policy (validated config) —
      // the same policy object the API consults; a scenario can never
      // grant authority (ADR-0024 §4). The signing-capable
      // classification is the PLATFORM constant (EXECUTOR_SIGNING_
      // CREDENTIAL_REFS), never a per-call decision.
      credentialPolicy: {
        signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
        originGrants: config.TARGET_ORIGIN_CREDENTIAL_GRANTS as Record<string, readonly string[]>,
      },
      runTimeoutMs: deps.overrides?.runTimeoutMs ?? flags.timeoutMs,
      analysisTimeoutMs: deps.overrides?.analysisTimeoutMs ?? Math.max(flags.timeoutMs, 60_000),
      pollIntervalMs: deps.overrides?.pollIntervalMs ?? 250,
    });
    runId = outcome.runId;
    await emitOutcome(deps, flags, outcome);
  } catch (error) {
    failCommand(deps, flags.json, error, runId);
  } finally {
    if (controlDb !== null) {
      await controlDb.disconnect();
    }
  }
}

/**
 * The Phase 18 replay command (ADR-0019 Decision 4): a NEW run from
 * the SAME hash-pinned snapshot bound by a durable reproduction
 * definition. Report emission, exit mapping, and output discipline
 * are IDENTICAL to `run` (emitOutcome/failCommand below) — replay
 * differs only in how the run is created (executeReplay), never in
 * how truth is reported.
 */
async function replayCommand(deps: CliDeps, flags: ReplayFlags): Promise<void> {
  let controlDb: ControlDb | null = null;
  let runId: string | null = null;
  try {
    // ---- Config + durable store handle (no scenario file exists for
    // replay: the frozen snapshot IS the intent — ADR-0010). ----
    const overrides = loadTestExitOverrides();
    const config = loadCliConfig();
    controlDb = createControlDb(
      deps.overrides?.controlDatabaseUrl ??
        overrides?.controlDatabaseUrl ??
        config.CONTROL_DATABASE_URL,
    );
    const redisUrl = deps.overrides?.redisUrl ?? config.REDIS_URL;
    const queuePrefix = deps.overrides?.queuePrefix ?? config.QUEUE_PREFIX;

    // ---- Validate binding → new run on the stored snapshot → drive. ----
    const outcome = await executeReplay(controlDb.prisma, flags.reproductionId, {
      redisUrl,
      queuePrefix,
      // The SERVER-OWNED platform grant policy (validated config) —
      // identical to `run`: a reproduction can never grant authority
      // (ADR-0024 §4). Rotated or removed grants fail closed here.
      credentialPolicy: {
        signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
        originGrants: config.TARGET_ORIGIN_CREDENTIAL_GRANTS as Record<string, readonly string[]>,
      },
      runTimeoutMs: deps.overrides?.runTimeoutMs ?? flags.timeoutMs,
      analysisTimeoutMs: deps.overrides?.analysisTimeoutMs ?? Math.max(flags.timeoutMs, 60_000),
      pollIntervalMs: deps.overrides?.pollIntervalMs ?? 250,
    });
    runId = outcome.runId;
    await emitOutcome(deps, flags, outcome);
  } catch (error) {
    failCommand(deps, flags.json, error, runId);
  } finally {
    if (controlDb !== null) {
      await controlDb.disconnect();
    }
  }
}

/**
 * The Phase 18 comparison command (incident-replay §6): computed-on-
 * read comparison of two runs of the SAME frozen intent. Read-only —
 * nothing executes, nothing durable is written. Cross-intent pairs
 * are refused (exit 4).
 */
async function compareCommand(deps: CliDeps, flags: CompareFlags): Promise<void> {
  let controlDb: ControlDb | null = null;
  try {
    const overrides = loadTestExitOverrides();
    const config = loadCliConfig();
    controlDb = createControlDb(
      deps.overrides?.controlDatabaseUrl ??
        overrides?.controlDatabaseUrl ??
        config.CONTROL_DATABASE_URL,
    );
    const comparison = await compareReplayRuns(controlDb.prisma, flags.baseRunId, flags.otherRunId);
    if (flags.reportPath !== null) {
      await mkdir(dirname(flags.reportPath), { recursive: true });
      const tempPath = `${flags.reportPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tempPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
        await rename(tempPath, flags.reportPath);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    if (flags.json) {
      deps.stdout(`${JSON.stringify(comparison, null, 2)}\n`);
    } else {
      deps.stdout(humanComparisonSummary(comparison));
    }
    deps.exit(0);
  } catch (error) {
    if (error instanceof RunComparisonError) {
      if (flags.json) {
        deps.stdout(
          `${JSON.stringify(machineError('USAGE_ERROR', boundedMessage(error)), null, 2)}\n`,
        );
      } else {
        deps.stderr(`${boundedMessage(error)}\n`);
      }
      deps.exit(exitCodeFor('USAGE_ERROR'));
      return;
    }
    if (flags.json) {
      deps.stdout(
        `${JSON.stringify(machineError('EXECUTION_FAILURE', boundedMessage(error)), null, 2)}\n`,
      );
    } else {
      deps.stderr(`EXECUTION_FAILURE: ${boundedMessage(error)}\n`);
    }
    deps.exit(exitCodeFor('EXECUTION_FAILURE'));
  } finally {
    if (controlDb !== null) {
      await controlDb.disconnect();
    }
  }
}

/** The shared report-emission tail of `run` and `replay` (§11/§44). */
async function emitOutcome(
  deps: CliDeps,
  flags: { readonly reportPath: string | null; readonly json: boolean },
  outcome: RunOutcome,
): Promise<void> {
  const runId = outcome.runId;
  // ---- 15.–17. build → schema-validate → atomic write. ----
  if (outcome.reportInput === null || outcome.integrity === null) {
    // A run was created but the flow could not reach normal report
    // completion (timeout / terminal failure with no report input).
    // Preserve run truth (§78); emit the machine error surface.
    const message = outcome.classification.reason;
    if (flags.json) {
      deps.stdout(
        `${JSON.stringify(machineError('EXECUTION_FAILURE', message, runId), null, 2)}\n`,
      );
    } else {
      deps.stderr(`EXECUTION_FAILURE: ${message}\n${runId === null ? '' : `run: ${runId}\n`}`);
    }
    deps.exit(exitCodeFor('EXECUTION_FAILURE'));
    return;
  }

  // Construct → validate → write → atomic rename (§11): the report is
  // built EXCLUSIVELY from values the Boundary B authorization froze
  // under the lock; reportId/generatedAt are the only post-commit
  // envelope metadata. A write failure never exits 0.
  const report = buildReport(outcome.reportInput, outcome.integrity, outcome.classification);
  // §41: every emitted report validates against the published schema.
  validateReportAgainstSchema(report);

  if (flags.reportPath !== null) {
    await mkdir(dirname(flags.reportPath), { recursive: true });
    const tempPath = `${flags.reportPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await rename(tempPath, flags.reportPath);
    } catch (error) {
      // No partial artifact may become visible (temp + rename): a
      // failed write removes its temp file and surfaces a delivery
      // failure (EXECUTION_FAILURE, exit 3) — never a successful exit.
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // ---- 18. emit human/JSON output. ----
  if (flags.json) {
    deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    deps.stdout(humanSummary(report));
  }

  // ---- 19. exit with the exact class. ----
  deps.exit(report.exit.code);
}

/** The shared error mapping of `run` and `replay` (§70). */
function failCommand(deps: CliDeps, json: boolean, error: unknown, runId: string | null): void {
  // ---- Error mapping (§70). ----
  if (error instanceof ScenarioValidationError || error instanceof ExperimentValidationError) {
    if (json) {
      deps.stdout(
        `${JSON.stringify(machineError('USAGE_ERROR', boundedMessage(error)), null, 2)}\n`,
      );
    } else {
      deps.stderr(`${boundedMessage(error)}\n`);
    }
    deps.exit(exitCodeFor('USAGE_ERROR'));
    return;
  }
  if (
    error instanceof TargetResolutionError ||
    error instanceof RunCreationError ||
    error instanceof ReplayRequestError ||
    error instanceof ReplayValidationError ||
    error instanceof RangeError ||
    (error instanceof Error && error.name === 'TargetRegistrationError')
  ) {
    // Replay binding failures (missing reproduction, rotated/missing
    // credentials, mismatched bindings, unavailable versions,
    // unauthorized destinations) are refused BEFORE anything durable
    // happens — exit 4, exactly like unknown targets for `run`.
    if (json) {
      deps.stdout(
        `${JSON.stringify(machineError('USAGE_ERROR', boundedMessage(error)), null, 2)}\n`,
      );
    } else {
      deps.stderr(`${boundedMessage(error)}\n`);
    }
    deps.exit(exitCodeFor('USAGE_ERROR'));
    return;
  }
  // Report generation itself failed after execution began → exit 3
  // (§45). Run truth is preserved (§78); reference the run id where
  // safe.
  if (
    error instanceof ReportEmitterError ||
    error instanceof ReportSchemaValidationError ||
    error instanceof AnalysisTimeoutError
  ) {
    if (json) {
      deps.stdout(
        `${JSON.stringify(machineError('EXECUTION_FAILURE', boundedMessage(error), runId), null, 2)}\n`,
      );
    } else {
      deps.stderr(
        `EXECUTION_FAILURE: ${boundedMessage(error)}${runId === null ? '' : `\nrun: ${runId}`}\n`,
      );
    }
    deps.exit(exitCodeFor('EXECUTION_FAILURE'));
    return;
  }
  // Unexpected internal error: execution began (a run may exist) →
  // exit 3 with a bounded safe message; nothing secret is echoed.
  if (json) {
    deps.stdout(
      `${JSON.stringify(machineError('EXECUTION_FAILURE', boundedMessage(error), runId), null, 2)}\n`,
    );
  } else {
    deps.stderr(
      `EXECUTION_FAILURE: ${boundedMessage(error)}${runId === null ? '' : `\nrun: ${runId}`}\n`,
    );
  }
  deps.exit(exitCodeFor('EXECUTION_FAILURE'));
}

/** Concise human comparison summary (no secrets, no AI interpretation). */
function humanComparisonSummary(comparison: ReplayComparisonResult): string {
  const lines: string[] = [];
  lines.push(`replay comparison  base=${comparison.baseRunId} replay=${comparison.replayRunId}`);
  lines.push(
    `snapshot: ${comparison.snapshotContentHash.slice(0, 12)}… (same frozen intent; cross-intent pairs are refused)`,
  );
  lines.push(
    `target: ${comparison.target.displayName} (${comparison.target.environment}) ${comparison.target.origin}`,
  );
  lines.push(
    `experiment: ${comparison.experiment.definitionName} revision ${String(comparison.experiment.revisionNumber)}`,
  );
  lines.push(
    `invariant keys: ${comparison.invariantKeys.map((key) => `${key.key}@${key.registryVersion}`).join(', ')}`,
  );
  for (const key of comparison.keys) {
    lines.push(
      `  ${key.invariantKey}: base=[${key.baseVerdicts.join(', ')}] replay=[${key.replayVerdicts.join(', ')}]${key.agree ? '' : ' (DISAGREE)'}${key.evaluatorVersionsDiffer ? ' (version drift)' : ''}`,
    );
  }
  for (const key of comparison.unboundKeys) {
    lines.push(
      `  ${key.invariantKey}: unbound (observed, not bound) base=[${key.baseVerdicts.join(', ')}] replay=[${key.replayVerdicts.join(', ')}]`,
    );
  }
  for (const subject of comparison.subjects) {
    lines.push(
      `  ${subject.invariantKey} [${subject.subjectKey}]: base=${subject.baseVerdict} replay=${subject.replayVerdict}${subject.verdictsDiffer ? ' (DIFFER)' : ''} effects base=${subject.baseEffectCount === null ? 'n/a' : String(subject.baseEffectCount)} replay=${subject.replayEffectCount === null ? 'n/a' : String(subject.replayEffectCount)}`,
    );
  }
  for (const [label, side] of [
    ['base', comparison.base],
    ['replay', comparison.replay],
  ] as const) {
    lines.push(
      `${label}: findings=${String(side.findingCount)} observations=${side.observationCount === null ? 'n/a' : String(side.observationCount)} head=${side.evidenceHeadHash?.slice(0, 12) ?? 'none'}… INDETERMINATE=${String(side.sideEffectSummary.INDETERMINATE)} reproduction=${side.reproductionDefinitionId ?? 'absent'}`,
    );
  }
  lines.push(comparison.schedulingNote);
  return lines.join('\n');
}

/** Concise human summary (no secrets, no AI interpretation, §44). */
function humanSummary(report: Awaited<ReturnType<typeof buildReport>>): string {
  const lines: string[] = [];
  lines.push(`rupturegrid-report/v1  ${report.reportId}`);
  lines.push(
    `target: ${report.target.displayName} (${report.target.environment}) ${report.target.origins.join(', ')}`,
  );
  lines.push(
    `run: ${report.run.runId} state=${report.run.terminalState} snapshot=${report.run.snapshotContentHash.slice(0, 12)}…`,
  );
  lines.push(
    `side effects: KNOWN_OCCURRED=${String(report.sideEffectSummary.KNOWN_OCCURRED)} KNOWN_ABSENT=${String(report.sideEffectSummary.KNOWN_ABSENT)} INDETERMINATE=${String(report.sideEffectSummary.INDETERMINATE)} NOT_APPLICABLE=${String(report.sideEffectSummary.NOT_APPLICABLE)}`,
  );
  lines.push(
    `evidence integrity: ${report.evidenceIntegrity.verified ? 'verified' : 'FAILED'} observations=${String(report.evidenceIntegrity.observationCount)} head=${report.evidenceIntegrity.chainHeadHash?.slice(0, 12) ?? 'none'}…`,
  );
  for (const evaluation of report.invariantEvaluations) {
    lines.push(
      `  ${evaluation.invariantKey} [${evaluation.subjectKey}]: ${evaluation.verdict} — ${evaluation.reason}`,
    );
  }
  lines.push(`findings: ${String(report.findings.length)}`);
  lines.push(`exit: ${String(report.exit.code)} ${report.exit.class} — ${report.exit.reason}`);
  return lines.join('\n');
}

// Prevent Node from keeping the process alive for the tmp-unlink path.
void unlink;

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  void cliMain({
    argv: process.argv.slice(2),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    exit: (code) => {
      process.exitCode = code;
    },
  }).catch((error: unknown) => {
    process.stderr.write(`internal error: ${boundedMessage(error)}\n`);
    process.exitCode = 3;
  });
}
