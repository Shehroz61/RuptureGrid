// =====================================================================
// RuptureGrid v1.0 — golden verifier bridge (Phase 8)
// =====================================================================
// The showcase's ONLY source of execution truth is the accepted
// Phase 7 verifier, run in its machine-readable mode:
//
//     node packages/incident-zero/dist/cli.js --json
//
// (this is exactly what `pnpm incident-zero:verify -- --json` invokes
// — the root script runs `pnpm build && node packages/incident-zero/
// dist/cli.js`). The bridge:
//   - spawns the verifier as a child of THIS process (exact PID
//     recorded, bounded timeout, SIGTERM on timeout — the Phase 7
//     ownership model, never a weaker one, §56);
//   - requires exit code 0 (§52: any verifier failure STOPS the
//     showcase — no artifacts from partial data);
//   - parses the verifier's own JSON report (never scraping prose,
//     §8) and derives the session's REAL run/finding IDs from it.
//
// Nothing here re-implements, re-checks, or re-decides any golden
// semantics: if the verifier did not assert it, the showcase cannot
// show it.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldenVerificationReport } from './types.js';

/**
 * The verifier invocation recorded in the manifest (§10): the EXACT
 * command this bridge spawns. It is the execution step of the accepted
 * root script `incident-zero:verify` (`pnpm build && node
 * packages/incident-zero/dist/cli.js`) — the workspace is already
 * built by the showcase's own build step, so the bridge runs the
 * verifier binary directly and records exactly that.
 */
export const GOLDEN_VERIFIER_COMMAND = 'node packages/incident-zero/dist/cli.js --json';

/** The repository root, resolved from this compiled module's location. */
export function repoRoot(): string {
  // dist/verifier.js → package root → packages/ → repository root.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Path to the accepted verifier's compiled CLI entrypoint. */
export function verifierCliPath(): string {
  return join(repoRoot(), 'packages', 'incident-zero', 'dist', 'cli.js');
}

export interface VerifierRun {
  readonly pid: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the accepted golden verifier with a bounded timeout. The child
 * is owned: only this process's own child is ever signalled, and only
 * on timeout (the verifier manages its own children otherwise).
 */
export function runGoldenVerifier(timeoutMs: number): Promise<VerifierRun> {
  return new Promise<VerifierRun>((resolve, reject) => {
    const child = spawn(process.execPath, [verifierCliPath(), '--json'], {
      cwd: repoRoot(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid ?? -1;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill('SIGTERM');
              reject(
                new Error(
                  `golden verifier (pid ${pid}) did not finish within ${timeoutMs}ms — showcase generation stopped`,
                ),
              );
            }
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error: Error) => {
      if (!settled) {
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        reject(new Error(`golden verifier could not be started: ${error.message}`));
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve({ pid, exitCode: code ?? -1, stdout, stderr });
      }
    });
  });
}

/** Raised when the verifier did not produce a passing canonical result. */
export class VerifierFailureError extends Error {
  public readonly exitCode: number;
  public readonly detail: string;

  public constructor(exitCode: number, detail: string) {
    super(
      `golden verifier failed (exit ${exitCode}) — no showcase artifacts were produced: ${detail}`,
    );
    this.name = 'VerifierFailureError';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

/** The per-mode slice of the verifier's JSON report the showcase needs. */
export interface VerifiedMode {
  readonly mode: string;
  readonly runId: string;
  readonly snapshotContentHash: string;
  readonly paymentId: string;
  readonly pass: boolean;
  readonly assertions: ReadonlyArray<{
    readonly name: string;
    readonly expected: string;
    readonly actual: string;
    readonly pass: boolean;
  }>;
}

function assertionValue(mode: VerifiedMode, name: string): string | null {
  const found = mode.assertions.find((assertion) => assertion.name === name);
  return found?.actual ?? null;
}

/**
 * Reads one assertion's ACTUAL value from a verified mode (null when
 * the verifier did not assert it). Run-facts presented by the showcase
 * (run state, INV-IZ-1 verdict) are transcribed from here — never
 * hard-coded — so the manifest can only restate what the verifier
 * itself observed (§9).
 */
export function modeAssertionActual(mode: VerifiedMode, name: string): string | null {
  return assertionValue(mode, name);
}

/**
 * Resolves the durable finding-row UUID for a verified vulnerable run.
 * Wired by the orchestrator (which owns the control-DB handle built
 * from the verifier's own environment); the bridge itself never opens
 * a second database contract and never invents an ID.
 */
let findingIdResolver: ((runId: string) => Promise<string>) | null = null;

/** Registers (or clears) the durable finding-ID resolver. */
export function setFindingIdResolver(resolver: ((runId: string) => Promise<string>) | null): void {
  findingIdResolver = resolver;
}

/**
 * Extracts the showcase session's REAL identifiers from the verifier's
 * own report. The report asserts the vulnerable finding's reason code;
 * the finding ROW's UUID is resolved through the wired resolver (which
 * reads the durable row the verifier just asserted). Non-passing or
 * incomplete reports are refused — never partially consumed.
 */
export async function extractVerifiedSession(report: GoldenVerificationReport): Promise<{
  vulnerable: VerifiedMode & { findingId: string };
  secure: VerifiedMode;
}> {
  const vulnerable = report.modes.find((mode) => mode.mode === 'VULNERABLE');
  const secure = report.modes.find((mode) => mode.mode === 'SECURE');
  if (vulnerable === undefined || secure === undefined) {
    throw new VerifierFailureError(
      report.exitCode,
      'verifier report does not contain both VULNERABLE and SECURE mode evaluations',
    );
  }
  if (report.ok !== true || vulnerable.pass !== true || secure.pass !== true) {
    throw new VerifierFailureError(
      report.exitCode,
      `verifier report is not a passing result (ok=${String(report.ok)})`,
    );
  }
  const reasonCode = assertionValue(vulnerable, 'finding.reason-code');
  if (reasonCode !== 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT') {
    throw new VerifierFailureError(
      report.exitCode,
      `vulnerable mode did not assert the canonical failure Finding (observed: ${reasonCode ?? 'null'})`,
    );
  }
  if (findingIdResolver === null) {
    throw new VerifierFailureError(
      report.exitCode,
      'no durable finding resolver wired — refusing to invent a finding ID',
    );
  }
  const findingId = await findingIdResolver(vulnerable.runId);
  if (findingId === null || findingId === '') {
    throw new VerifierFailureError(
      report.exitCode,
      `durable finding row for run ${vulnerable.runId} not found — refusing to invent an ID`,
    );
  }
  return { vulnerable: { ...vulnerable, findingId }, secure };
}

/**
 * Convenience: runs the verifier, enforces exit 0, parses its JSON
 * report, and returns the verified session truth.
 */
export async function obtainVerifiedSession(options: { readonly timeoutMs: number }): Promise<{
  pid: number;
  report: GoldenVerificationReport;
  vulnerable: VerifiedMode & { findingId: string };
  secure: VerifiedMode;
}> {
  const run = await runGoldenVerifier(options.timeoutMs);
  if (run.exitCode !== 0) {
    throw new VerifierFailureError(run.exitCode, summarizeFailure(run));
  }
  let report: GoldenVerificationReport;
  try {
    report = JSON.parse(run.stdout) as GoldenVerificationReport;
  } catch {
    throw new VerifierFailureError(
      run.exitCode,
      'verifier stdout is not a parsable JSON report (unexpected verifier behavior)',
    );
  }
  if (report.ok !== true) {
    throw new VerifierFailureError(run.exitCode, 'verifier JSON report is not a passing result');
  }
  const session = await extractVerifiedSession(report);
  return { pid: run.pid, report, ...session };
}

function summarizeFailure(run: VerifierRun): string {
  const tail = (text: string): string => {
    const lines = text
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '');
    return lines.slice(-6).join('\n');
  };
  return `stdout tail:\n${tail(run.stdout)}\nstderr tail:\n${tail(run.stderr)}`;
}
