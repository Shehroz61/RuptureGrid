// =====================================================================
// RuptureGrid v1.0 — showcase orchestrator (Phase 8)
// =====================================================================
// The maintainable automation entrypoint library (§12). One session:
//
//   1. prerequisite validation (environment, control DB reachable);
//   2. run the accepted golden verifier (exit 0 REQUIRED — §52);
//   3. start the REAL Control-Plane API and REAL web production
//      server as OWNED child processes (exact PIDs, §55) bound to
//      showcase ports (env-overridable), never the verifier's
//      golden-suite ports;
//   4. prove service identity (§54): the API must serve THIS
//      session's verifier-created runIds before any capture;
//   5. capture the full plan in a real browser with bounded,
//      content-asserted waits (§23/§24);
//   6. write the manifest + sidecar into the ignored output directory;
//   7. validate artifacts (§46/§47/§48); optional video (§34);
//   8. stop owned processes, clean the owned browser profile.
//
// There is no second truth engine: run IDs, verdicts, counts, wallet,
// and finding identity come from the verifier's report and the durable
// rows that report just asserted.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createServer } from 'node:net';
import {
  GOLDEN_SCENARIO_VERSION,
  INVARIANT_KEY,
  TOTAL_DELIVERIES,
} from '@rupturegrid/incident-zero';
import { loadEnvironment, loadWorkerConfig, ConfigValidationError } from '@rupturegrid/config';
import type { WorkerConfig } from '@rupturegrid/config';
import {
  GOLDEN_VERIFIER_COMMAND,
  obtainVerifiedSession,
  modeAssertionActual,
  setFindingIdResolver,
  VerifierFailureError,
} from './verifier.js';
import { SHOWCASE_DEVICE_SCALE, SHOWCASE_VIEWPORT } from './capture-plan.js';
import type { ShowcaseIdentifiers } from './capture-plan.js';
import { startBrowser, startCaptureSession, captureAll, writeMetadataSidecar } from './browser.js';
import { validateSessionArtifacts, validateVideo } from './validate.js';
import { generateVideo } from './video.js';
import { safeOutputDir, removeStaleVideo } from './output-safety.js';
import type {
  ShowcaseManifest,
  ShowcaseModeStory,
  ShowcaseVideoMetadata,
  GoldenVerificationReport,
} from './types.js';

/** Showcase package version — recorded in every manifest (§10). */
export const SHOWCASE_VERSION = 'v1';

/** Ports (env-overridable; occupancy checked before capture, §57). */
const API_SHOWCASE_PORT = Number(process.env['SHOWCASE_API_PORT'] ?? '3231');
const WEB_SHOWCASE_PORT = Number(process.env['SHOWCASE_WEB_PORT'] ?? '3232');

/** Bounded stage timeouts (§78) — integer env parsing (no separators). */
const VERIFIER_TIMEOUT_MS = Number(process.env['SHOWCASE_VERIFIER_TIMEOUT_MS'] ?? '600000');
const CONTENT_TIMEOUT_MS = Number(process.env['SHOWCASE_CONTENT_TIMEOUT_MS'] ?? '30000');
if (!Number.isInteger(VERIFIER_TIMEOUT_MS) || VERIFIER_TIMEOUT_MS <= 0) {
  throw new Error(
    `SHOWCASE_VERIFIER_TIMEOUT_MS must be a positive integer (got: ${process.env['SHOWCASE_VERIFIER_TIMEOUT_MS'] ?? 'unset'})`,
  );
}
if (!Number.isInteger(CONTENT_TIMEOUT_MS) || CONTENT_TIMEOUT_MS <= 0) {
  throw new Error(
    `SHOWCASE_CONTENT_TIMEOUT_MS must be a positive integer (got: ${process.env['SHOWCASE_CONTENT_TIMEOUT_MS'] ?? 'unset'})`,
  );
}

// ---------------------------------------------------------------------
// Owned child processes (§55/§56 — the Phase 7 ownership model)
// ---------------------------------------------------------------------

interface OwnedChild {
  readonly label: string;
  readonly pid: number;
  readonly close: () => Promise<void>;
}

function spawnOwned(
  label: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): { readonly owned: OwnedChild; readonly child: ChildProcess } {
  const child: ChildProcess = spawn(process.execPath, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    owned: {
      label,
      pid: child.pid ?? -1,
      close: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((resolveClose) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolveClose();
            }, 5_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolveClose();
            });
          });
        }
      },
    },
    child,
  };
}

/**
 * Fails clearly when a showcase port is already occupied (§57): the
 * showcase never silently talks to an unknown process. The probe is a
 * bind test on the same interface the owned service will use — if the
 * bind fails, something is listening. The operator either stops the
 * conflicting service or selects an alternate port via
 * SHOWCASE_API_PORT / SHOWCASE_WEB_PORT.
 */
export async function assertPortFree(port: number, label: 'api' | 'web'): Promise<void> {
  const occupied = await new Promise<boolean>((resolveProbe) => {
    const probe = createServer();
    probe.once('error', () => resolveProbe(true));
    probe.once('listening', () => {
      probe.close(() => resolveProbe(false));
    });
    probe.listen(port, '127.0.0.1');
  });
  if (occupied) {
    throw new Error(
      `showcase port ${port} (${label}) is already in use — refusing to capture against an ` +
        `unknown service (§57). Stop the conflicting service, or set ` +
        `${label === 'api' ? 'SHOWCASE_API_PORT' : 'SHOWCASE_WEB_PORT'} to a free port.`,
    );
  }
}

/**
 * Confirms an owned child is still the process serving the port: a
 * child that died (e.g. EADDRINUSE it lost to a foreign service) must
 * never be mistaken for a ready service (§55/§57).
 */
function assertChildAlive(child: ChildProcess, label: string, detail: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `owned ${label} process (pid ${child.pid ?? 'unknown'}) exited before becoming ready ` +
        `(${detail}) — refusing to capture against whatever now answers the port`,
    );
  }
}

/** Waits (bounded) until an HTTP endpoint answers (any status). */
async function waitForHttp(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return { ok: true, status: response.status };
    } catch {
      if (Date.now() > deadline) {
        return { ok: false, status: null };
      }
      await new Promise((wait) => setTimeout(wait, 300));
    }
  }
}

// ---------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------

export interface Prerequisites {
  readonly ok: boolean;
  readonly problem: string | null;
  readonly controlDb: ControlDb | null;
  readonly workerConfig: WorkerConfig | null;
}

export async function checkPrerequisites(): Promise<Prerequisites> {
  loadEnvironment();
  let workerConfig: WorkerConfig;
  try {
    workerConfig = loadWorkerConfig();
  } catch (error) {
    return {
      ok: false,
      problem: `environment validation failed: ${
        error instanceof ConfigValidationError ? error.message : String(error)
      }`,
      controlDb: null,
      workerConfig: null,
    };
  }
  let controlDb: ControlDb;
  try {
    controlDb = createControlDb(workerConfig.CONTROL_DATABASE_URL);
    await controlDb.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    return {
      ok: false,
      problem: `control database unreachable: ${error instanceof Error ? error.message : String(error)}`,
      controlDb: null,
      workerConfig: null,
    };
  }
  return { ok: true, problem: null, controlDb, workerConfig };
}

// ---------------------------------------------------------------------
// Service identity (§54): only THIS session's services may be captured
// ---------------------------------------------------------------------

/**
 * Confirms the API at the given origin serves the session's REAL run:
 * the verifier created these runs moments ago in the same database.
 * A stale API pointed at another database would fail this probe.
 */
export async function assertApiServesSessionRuns(
  apiBaseUrl: string,
  ids: ShowcaseIdentifiers,
): Promise<void> {
  for (const runId of [ids.vulnerableRunId, ids.secureRunId]) {
    const response = await fetch(`${apiBaseUrl}/api/v1/runs/${runId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(
        `service identity check failed: API at ${apiBaseUrl} does not serve run ${runId} (HTTP ${response.status}) — refusing to capture a stale or foreign service`,
      );
    }
    const body = (await response.json()) as { runId?: string };
    if (body.runId !== runId) {
      throw new Error(
        `service identity check failed: API at ${apiBaseUrl} returned a different run body for ${runId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------

export interface ShowcaseSessionOptions {
  readonly outputDir: string;
  readonly withVideo: boolean;
}

export interface ShowcaseSessionResult {
  readonly manifest: ShowcaseManifest;
  readonly summary: string;
}

// Output-path safety (`safeOutputDir`, `removeStaleVideo`) lives in
// ./output-safety.js with its own unit tests.

export async function runShowcaseSession(
  options: ShowcaseSessionOptions,
): Promise<ShowcaseSessionResult> {
  const startedAt = Date.now();
  const outputDir = safeOutputDir(options.outputDir, repoRootForChildren());
  const problems: string[] = [];

  // A session that does not generate the video must not leave an
  // EARLIER session's MP4 in the active output directory (§55/§56):
  // the only video an output directory may contain is this session's.
  await removeStaleVideo(outputDir);

  // --- 1. Prerequisites -------------------------------------------------
  const prerequisites = await checkPrerequisites();
  if (
    !prerequisites.ok ||
    prerequisites.controlDb === null ||
    prerequisites.workerConfig === null
  ) {
    throw new Error(`showcase prerequisites failed: ${prerequisites.problem ?? 'unknown'}`);
  }
  const controlDb: ControlDb = prerequisites.controlDb;

  try {
    // --- 2. Golden verifier (§52) — the ONLY execution-truth source ---
    setFindingIdResolver(async (runId: string) => {
      const row = await controlDb.prisma.finding.findFirst({
        where: { runId, reasonCode: 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return row?.id ?? '';
    });
    const verified = await obtainVerifiedSession({ timeoutMs: VERIFIER_TIMEOUT_MS });
    const report: GoldenVerificationReport = verified.report;
    const ids: ShowcaseIdentifiers = {
      vulnerableRunId: verified.vulnerable.runId,
      secureRunId: verified.secure.runId,
      vulnerableFindingId: verified.vulnerable.findingId,
    };

    // Run-facts presented by the showcase are transcribed from the
    // verifier's own assertion actuals — never hard-coded (§8/§9). A
    // report that did not observe them cannot be presented.
    const executionStates = new Map<string, string | null>([
      ['VULNERABLE', modeAssertionActual(verified.vulnerable, 'execution.state')],
      ['SECURE', modeAssertionActual(verified.secure, 'execution.state')],
    ]);
    const verdictsByMode = new Map<string, string | null>([
      ['VULNERABLE', modeAssertionActual(verified.vulnerable, `${INVARIANT_KEY}.verdict`)],
      ['SECURE', modeAssertionActual(verified.secure, `${INVARIANT_KEY}.verdict`)],
    ]);
    for (const mode of ['VULNERABLE', 'SECURE'] as const) {
      if (executionStates.get(mode) !== 'COMPLETED') {
        throw new VerifierFailureError(
          report.exitCode,
          `verifier report did not observe execution.state=COMPLETED for ${mode} ` +
            `(observed: ${executionStates.get(mode) ?? 'null'}) — showcase presents completed runs only`,
        );
      }
      const verdict = verdictsByMode.get(mode);
      if (verdict !== 'FAIL' && verdict !== 'PASS') {
        throw new VerifierFailureError(
          report.exitCode,
          `verifier report did not observe an INV-IZ-1 verdict for ${mode} (observed: ${verdict ?? 'null'})`,
        );
      }
    }
    const sessionVerdicts = {
      VULNERABLE: verdictsByMode.get('VULNERABLE') as 'FAIL' | 'PASS',
      SECURE: verdictsByMode.get('SECURE') as 'FAIL' | 'PASS',
    };
    const executionState = executionStates.get('VULNERABLE') as string;

    // --- 3. Owned REAL services (API + web production server) ---------
    const children: Array<{ readonly owned: OwnedChild }> = [];
    let apiChild: { readonly owned: OwnedChild; readonly child: ChildProcess } | null = null;
    let webChild: { readonly owned: OwnedChild; readonly child: ChildProcess } | null = null;
    try {
      const apiPort = API_SHOWCASE_PORT;
      const apiOrigin = `http://127.0.0.1:${apiPort}`;
      await assertPortFree(apiPort, 'api');
      apiChild = spawnOwned('api', [join('apps', 'api', 'dist', 'main.js')], {
        cwd: repoRootForChildren(),
        env: {
          ...process.env,
          API_HOST: '127.0.0.1',
          API_PORT: String(apiPort),
          CONTROL_DATABASE_URL: prerequisites.workerConfig.CONTROL_DATABASE_URL,
          REDIS_URL: prerequisites.workerConfig.REDIS_URL,
          QUEUE_PREFIX: prerequisites.workerConfig.QUEUE_PREFIX,
          NODE_ENV: 'development',
          LOG_LEVEL: 'warn',
        },
      });
      children.push(apiChild);

      const apiReady = await waitForHttp(`${apiOrigin}/health/ready`, 30_000);
      if (!apiReady.ok) {
        throw new Error(
          `Control Plane API (owned pid ${apiChild.owned.pid}) did not become ready within 30000ms on ${apiOrigin}`,
        );
      }
      assertChildAlive(apiChild.child, 'api', 'Control Plane API');

      const webPort = WEB_SHOWCASE_PORT;
      const webOrigin = `http://127.0.0.1:${webPort}`;
      await assertPortFree(webPort, 'web');
      webChild = spawnOwned(
        'web',
        [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(webPort)],
        {
          cwd: join(repoRootForChildren(), 'apps', 'web'),
          env: {
            ...process.env,
            RUPTUREGRID_API_ORIGIN: apiOrigin,
            NODE_ENV: 'development',
          },
        },
      );
      children.push(webChild);
      const webReady = await waitForHttp(webOrigin, 30_000);
      if (!webReady.ok) {
        throw new Error(
          `web production server (owned pid ${webChild.owned.pid}) did not become ready within 30000ms on ${webOrigin}`,
        );
      }
      assertChildAlive(webChild.child, 'web', 'web production server');

      // --- 4. Service identity (§54) — MUST hold before capture ------
      await assertApiServesSessionRuns(apiOrigin, ids);

      // --- 5. Capture -------------------------------------------------
      await mkdir(outputDir, { recursive: true });
      const browserProfileDir = join(outputDir, 'browser-profile');
      const browser = await startBrowser({ profileDir: browserProfileDir });
      let artifacts: Awaited<ReturnType<typeof captureAll>> = [];
      try {
        const session = await startCaptureSession(browser);
        try {
          artifacts = await captureAll({
            session,
            webBaseUrl: webOrigin,
            ids,
            verdicts: sessionVerdicts,
            outputDir,
            contentTimeoutMs: CONTENT_TIMEOUT_MS,
          });
        } finally {
          await session.close();
        }
      } finally {
        await browser.close();
        // Owned browser profile cleanup (§67/§68).
        await rm(browserProfileDir, { recursive: true, force: true });
      }

      // --- 6. Stories + manifest --------------------------------------
      const vulnerable: ShowcaseModeStory = {
        mode: 'VULNERABLE',
        runId: verified.vulnerable.runId,
        paymentId: verified.vulnerable.paymentId,
        findingId: verified.vulnerable.findingId,
        snapshotContentHash: verified.vulnerable.snapshotContentHash,
        verdict: sessionVerdicts.VULNERABLE,
        runState: executionState,
      };
      const secure: ShowcaseModeStory = {
        mode: 'SECURE',
        runId: verified.secure.runId,
        paymentId: verified.secure.paymentId,
        findingId: null,
        snapshotContentHash: verified.secure.snapshotContentHash,
        verdict: sessionVerdicts.SECURE,
        runState: executionState,
      };

      // Optional video from THIS session's screenshots (§35).
      let video: ShowcaseVideoMetadata | null = null;
      if (options.withVideo) {
        const videoResult = await generateVideo({
          outputDir,
          artifacts,
          vulnerable,
          secure,
          facts: {
            deliveries: TOTAL_DELIVERIES,
            attempts: TOTAL_DELIVERIES,
            invariant: INVARIANT_KEY.replace('INV-', ''),
          },
        });
        if (videoResult !== null) {
          const videoValidation = await validateVideo({
            filePath: join(outputDir, videoResult.filename),
            expectedWidth: videoResult.width,
            expectedHeight: videoResult.height,
          });
          if (!videoValidation.valid) {
            problems.push(`video validation failed: ${videoValidation.detail}`);
          }
          video = {
            ...videoResult,
            durationSeconds: videoValidation.durationSeconds ?? videoResult.durationSeconds,
          };
        }
      }

      // Sidecar + manifest (§10/§11/§31).
      await writeMetadataSidecar(outputDir, artifacts);
      const sessionValidation = await validateSessionArtifacts({ outputDir, artifacts });
      problems.push(...sessionValidation.problems);

      const manifest: ShowcaseManifest = {
        showcaseVersion: SHOWCASE_VERSION,
        generatedAt: new Date().toISOString(),
        phase7Commit: await readPhase7Commit(),
        goldenScenarioVersion: GOLDEN_SCENARIO_VERSION,
        vulnerable,
        secure,
        webBaseUrl: webOrigin,
        apiBaseUrl: apiOrigin,
        goldenVerifier: {
          command: GOLDEN_VERIFIER_COMMAND,
          exitCode: 0,
          report,
        },
        artifacts,
        video,
        durationMs: Date.now() - startedAt,
        validation: { pass: problems.length === 0, problems },
      };
      const manifestPath = join(outputDir, 'showcase-manifest.json');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const summary = renderSummary(manifest);
      return { manifest, summary };
    } finally {
      // Owned process cleanup (§55): only these children, never others.
      for (const entry of children) {
        await entry.owned.close();
      }
      await controlDb.disconnect();
    }
  } catch (error) {
    await controlDb.disconnect();
    throw error;
  }
}

function repoRootForChildren(): string {
  // dist/orchestrator.js → package root → packages/ → repository root.
  return join(import.meta.dirname ?? '.', '..', '..', '..');
}

/**
 * The phase-7 accepted commit this showcase presents (§11), read from
 * git at runtime — never hard-coded in source (R-15). `phase-7-accepted`
 * is an annotated tag, so the ref is peeled to the commit it tags
 * (`^{commit}`) — the manifest records the commit SHA the checkpoint
 * names, not the tag object's own SHA. execFile passes the argument
 * verbatim (no shell), so the brace syntax is safe cross-platform.
 */
async function readPhase7Commit(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync('git', ['rev-parse', 'phase-7-accepted^{commit}'], {
      cwd: repoRootForChildren(),
      timeout: 10_000,
    });
    return result.stdout.trim();
  } catch {
    return 'phase-7-accepted (unresolved)';
  }
}

/** The concise human-readable story summary (§61). */
export function renderSummary(manifest: ShowcaseManifest): string {
  const lines: string[] = [];
  lines.push('RuptureGrid showcase session');
  lines.push(
    `  verifier: ${manifest.goldenVerifier.command} (exit ${manifest.goldenVerifier.exitCode})`,
  );
  lines.push(
    `  VULNERABLE run ${manifest.vulnerable.runId} — ${manifest.vulnerable.runState}, INV-IZ-1 ${manifest.vulnerable.verdict}, finding ${manifest.vulnerable.findingId ?? 'none'}`,
  );
  lines.push(
    `  SECURE run ${manifest.secure.runId} — ${manifest.secure.runState}, INV-IZ-1 ${manifest.secure.verdict}, no failure findings`,
  );
  lines.push(
    `  screenshots: ${manifest.artifacts.length} (viewport ${SHOWCASE_VIEWPORT.width}x${SHOWCASE_VIEWPORT.height} @${SHOWCASE_DEVICE_SCALE}x)`,
  );
  lines.push(`  video: ${manifest.video === null ? 'skipped' : manifest.video.filename}`);
  lines.push(
    `  validation: ${manifest.validation.pass ? 'pass' : `FAIL (${manifest.validation.problems.length} problems)`}`,
  );
  lines.push(`  manifest: showcase-manifest.json in the session output directory`);
  return lines.join('\n');
}
