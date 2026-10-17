// =====================================================================
// RuptureGrid v1.1 Phase 17 — headless run orchestration (ADR-0019 §1)
// =====================================================================
// The CLI `run` flow, auditable as (§77):
//   1.  load file → 2. parse JSON → 3. closed-schema validate
//   4.  resolve registered target (displayName lookup)
//   5.  validate the embedded experiment against target + platform
//       policy (the ENGINE is authoritative — no re-implementation)
//   6.  create immutable experiment revision
//   7.  create/pin snapshot (ADR-0010)
//   8.  dispatch durable run
//   9.  bounded-poll terminal execution (durable run state; no sleeps
//       as correctness proofs — testing-strategy §6)
//   10. capture/complete required generic evidence (the worker-owned
//       Phase 14 generic inspection seam, driven GENERALLY from the
//       frozen manifest evidence policy — no Commerce branch)
//   11. run idempotent analysis (derivation + evaluation + findings;
//       existing Phase 14/15 idempotency — no new tables)
//   12. verify evidence integrity
//   13. read persisted evaluations/findings
//   14. classify exit (frozen precedence)
//   15. build rupturegrid-report/v1 → 16. validate schema →
//   17. write report → 18. emit output → 19. exit with the exact class
//
// NO ALTERNATE TRUTH ENGINE (§8): this module owns orchestration and
// serialization only. It never computes invariant truth, never parses
// a target database, never creates findings from raw state, never
// interprets evidence, and never retries a dispatch (§79 — CLI polls
// durable state; reconciliation is engine-owned).
//
// Usage errors (invalid scenario/flags/unknown target) are rejected
// BEFORE anything durable happens (exit 4 — nothing executes; no run,
// no revision, no target request).

import type { PrismaClient } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import {
  createExperiment,
  createRun,
  createRunFromSnapshot,
  loadRunSnapshot,
  markRunDispatching,
  getTarget,
  validateReplayBinding,
  TargetRegistrationError,
  ExperimentValidationError,
  RunCreationError,
  ReplayValidationError,
  frozenInvariantKeys,
} from '@rupturegrid/engine';
import type { RunSnapshotDocument, TargetOriginCredentialPolicy } from '@rupturegrid/engine';
import {
  RUN_ANALYSIS_MAX_CYCLES,
  authorizeReportFinalization,
  captureGenericInspectionSet,
  runRunAnalysis,
  verifyRunEvidenceChain,
} from '@rupturegrid/evidence';
import type {
  AuthorizedReportState,
  ChainIdentity,
  IntegrityReport,
  ReportAuthorizationResult,
  ReportReadDb,
} from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import type { ScenarioDocument } from './scenario.js';
import { scenarioExperimentDocument, ScenarioValidationError } from './scenario.js';
import { classifyExit, EXIT_CLASSES, EXIT_MODE_STRICT } from './exit-code.js';
import type { ExitClassification } from './exit-code.js';
import type {
  ReportEvaluation,
  ReportFinding,
  ReportInput,
  ReportReproductionReference,
  ReportRunIdentity,
  ReportTargetIdentity,
} from './report.js';
import { FRESHNESS_STATEMENT } from './report.js';
import {
  loadInvariantEvaluatorVersions,
  loadNormalizerVersions,
  loadReportFindings,
  loadReportReproduction,
  loadReportRun,
  loadReportTarget,
  loadSideEffectSummary,
  ReportInputError,
} from './report-input.js';
import type { BoundKeyDomain, ExitAnomaly, SubjectVerdict } from './exit-code.js';

export class TargetResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

export class AnalysisTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AnalysisTimeoutError';
  }
}

/** Resolves the scenario's displayName selector to the registration. */
export async function resolveTargetByDisplayName(
  prisma: PrismaClient,
  displayName: string,
): Promise<{ targetId: string; displayName: string }> {
  // displayName is unique by registration (target_registration).
  // Lookup convenience ONLY — the resolved row is the whole authority
  // (ADR-0024 §3: displayName is never a security principal).
  const row = await prisma.targetRegistration.findUnique({
    where: { displayName },
    select: { id: true, displayName: true },
  });
  if (row === null) {
    throw new TargetResolutionError(
      `no registered target with displayName "${displayName}" — the scenario cannot bind (nothing was executed)`,
    );
  }
  return { targetId: row.id, displayName: row.displayName };
}

export interface WaitForRunOptions {
  readonly runTimeoutMs: number;
  readonly pollIntervalMs: number;
}

/**
 * Bounded polling of DURABLE run state until terminal (§30). No fixed
 * correctness sleep: the poll interval is scheduling cadence only.
 * On timeout the run is NOT mutated — terminal truth stays engine-
 * owned; the CLI honestly reports EXECUTION_FAILURE with the timeout.
 */
export async function waitForRunTerminal(
  prisma: PrismaClient,
  runId: string,
  options: WaitForRunOptions,
): Promise<{ terminal: 'COMPLETED' | 'FAILED' | 'CANCELLED' } | { timedOut: true }> {
  const deadline = Date.now() + options.runTimeoutMs;
  for (;;) {
    const row = await prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { state: true },
    });
    if (row === null) {
      throw new AnalysisTimeoutError(`run ${runId} vanished from the durable store`);
    }
    if (row.state === 'COMPLETED' || row.state === 'FAILED' || row.state === 'CANCELLED') {
      return { terminal: row.state };
    }
    if (Date.now() > deadline) {
      return { timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

/**
 * Bounded polling for the analysis pass to reach a stable completed
 * state (§56): every bound invariant key has at least one COMPLETED
 * evaluation batch. No "wait 500ms and assume".
 */
export async function waitForAnalysisComplete(
  prisma: PrismaClient,
  runId: string,
  boundInvariantKeys: readonly string[],
  analysisTimeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + analysisTimeoutMs;
  for (;;) {
    const completed = await prisma.evaluationBatch.count({
      where: { runId, invariantKey: { in: [...boundInvariantKeys] }, completedAt: { not: null } },
    });
    if (completed >= boundInvariantKeys.length) {
      return;
    }
    if (Date.now() > deadline) {
      throw new AnalysisTimeoutError(
        `analysis for ${String(boundInvariantKeys.length)} bound invariant(s) did not complete within ${String(analysisTimeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface RunOutcome {
  readonly runId: string | null;
  readonly snapshotId: string | null;
  readonly snapshotContentHash: string | null;
  readonly integrity: IntegrityReport | null;
  readonly classification: ExitClassification;
  /** Assembled durable report input (null when no run was created). */
  readonly reportInput: ReportInput | null;
}

export interface RunFlowOptions {
  readonly redisUrl: string;
  readonly queuePrefix: string;
  readonly credentialPolicy: TargetOriginCredentialPolicy;
  readonly runTimeoutMs: number;
  readonly analysisTimeoutMs: number;
  readonly pollIntervalMs: number;
}

/**
 * Dispatches a durably created run through the real queue (IDs only;
 * ADR-0003): marks DISPATCHING durably, then enqueues the first step.
 * Shared by the `run` and `replay` flows — dispatch is identical
 * because a replay run's step rows come from the same frozen steps.
 */
export async function dispatchRun(
  prisma: PrismaClient,
  runId: string,
  options: Pick<RunFlowOptions, 'redisUrl' | 'queuePrefix'>,
): Promise<void> {
  await markRunDispatching(prisma, runId);
  const firstStep = await prisma.experimentStepRun.findFirstOrThrow({
    where: { runId },
    orderBy: { sequence: 'asc' },
    select: { id: true, sequence: true },
  });
  const queue = createExecutionQueue({ redisUrl: options.redisUrl, prefix: options.queuePrefix });
  try {
    await queue.enqueueStep({
      runId,
      stepRunId: firstStep.id,
      sequence: firstStep.sequence,
    });
  } finally {
    await queue.close();
  }
}

/** A replay request that is refused before anything durable happens. */
export class ReplayRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReplayRequestError';
  }
}

/**
 * Drives an already-dispatched run to its exit classification plus the
 * assembled report input — the shared Phase 17 pipeline (bounded-poll
 * wait → generic capture → idempotent analysis → forensic derivation →
 * integrity verification → Boundary B authorization → classification),
 * used VERBATIM by both `run` and `replay`. Nothing here invents
 * truth: evaluations/findings/integrity are read from durable rows
 * after the accepted pipelines ran. Expectations never enter: the
 * classifier reads durable truth only.
 */
export async function driveRunToReport(
  prisma: PrismaClient,
  runId: string,
  targetId: string,
  snapshotId: string,
  snapshotContentHash: string,
  options: RunFlowOptions,
): Promise<RunOutcome> {
  // ---- 9. Bounded poll of durable run state. ----
  const waited = await waitForRunTerminal(prisma, runId, {
    runTimeoutMs: options.runTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });

  // ---- 10. Generic evidence capture (audited flow step 10). The v1
  // worker performs NO timed automatic capture; the headless CLI owns
  // the invocation point for the runs it drives: post-terminal, once
  // per run, GENERAL (driven by the FROZEN manifestEvidencePolicy — no
  // Commerce branch). These are read-only observation requests against
  // the target's declared inspection endpoints (R-05: no business
  // state is ever written). Capture failure is honest evidence
  // incompleteness — it never rewrites execution truth; the generic
  // evaluators turn missing captures into NOT_EVALUABLE, and the exit
  // contract says so (never a silent pass).

  // ---- 11. Idempotent analysis (existing pipeline; worker sweeps also
  // converge here — repeat passes never duplicate rows). ----
  const boundKeys = await boundInvariantKeysOf(prisma, runId);

  // Timeout: execution truth is NOT mutated (§30). Honest EXECUTION_FAILURE.
  if ('timedOut' in waited) {
    const classification = classifyExit({
      runTerminalState: undefined,
      executionFailureReason: `bounded wait timeout after ${String(options.runTimeoutMs)}ms: the run did not reach a terminal state (run truth was not mutated)`,
      subjectVerdicts: [],
      boundKeyDomains: [],
      anomalies: [],
    });
    return {
      runId,
      snapshotId,
      snapshotContentHash,
      integrity: null,
      classification,
      reportInput: null,
    };
  }

  // A FAILED/CANCELLED run is honest EXECUTION_FAILURE: no evaluation
  // surface exists to report (a step failed mid-flight; the report's
  // truth fields would be empty decoration). Preserve run truth, emit
  // the machine error surface, exit 3 (§78).
  if (waited.terminal !== 'COMPLETED') {
    await runRunAnalysis(prisma, runId).catch(() => undefined);
    const integrity = await verifyRunEvidenceChain(prisma, runId).catch(() => null);
    const classification = classifyExit({
      runTerminalState: waited.terminal,
      executionFailureReason: `run ended in terminal state ${waited.terminal}`,
      subjectVerdicts: [],
      boundKeyDomains: [],
      anomalies: [],
    });
    return {
      runId,
      snapshotId,
      snapshotContentHash,
      integrity,
      classification,
      reportInput: null,
    };
  }

  // ---- COMPLETED run: capture → analyze → classify → report. ----
  // ---- 10. Generic evidence capture (post-terminal, once per run,
  // GENERAL over the frozen manifestEvidencePolicy — see step 10
  // above). ----
  await captureRunGenericInspections(prisma, runId, 'rupturegrid-cli').catch(() => undefined);

  // ---- 11. analysis: run + wait for stable completed batches per
  // bound key. ----
  await runRunAnalysis(prisma, runId);
  await waitForAnalysisComplete(
    prisma,
    runId,
    boundKeys,
    options.analysisTimeoutMs,
    options.pollIntervalMs,
  );

  // ---- 11b. Forensic derivation: findings + timeline + the durable
  // reproduction definition (existing idempotent engines; PASS/
  // NOT_EVALUABLE never produce findings). ----
  await deriveRunForensics(prisma, runId);

  // ---- 12. Evidence integrity verification (O(N), OUTSIDE the lock).
  // The identity this verification covers is the ONLY identity the
  // authorization may certify (verified-prefix binding, ADR-0026 §13).
  let integrity = await verifyRunEvidenceChain(prisma, runId);
  let verifiedChain = chainIdentityOf(integrity);

  // ---- 13./14. Boundary B: authorize ONE report decision under the
  // shared per-run lock, over the FROZEN publication state. Stale
  // proof/pointers trigger bounded re-analysis (Boundary A republishes
  // at the now-current composite W); the SAME frozen bound constant
  // governs both boundaries. The classification is a pure set
  // reduction over the authorized values (never a per-key collapse).
  let authorization: ReportAuthorizationResult<FrozenReportInputs> | null = null;
  let authorizationError: string | null = null;
  try {
    for (let cycle = 1; cycle <= RUN_ANALYSIS_MAX_CYCLES; cycle += 1) {
      authorization = await authorizeReportFinalization(prisma, runId, {
        boundInvariantKeys: boundKeys,
        verifiedChain,
        integrityVerified: integrity.chainValid && integrity.contentHashesValid,
        loadFrozenInputs: (db: ReportReadDb) =>
          loadFrozenReportInputs(db, runId, targetId, boundKeys),
      });
      if (authorization.disposition !== 'RETRY') {
        break;
      }
      // Boundary A: re-analysis over the now-current truth input, then
      // re-verify the (possibly advanced) chain and retry.
      await runRunAnalysis(prisma, runId);
      integrity = await verifyRunEvidenceChain(prisma, runId);
      verifiedChain = chainIdentityOf(integrity);
    }
  } catch (error) {
    // A lock/statement timeout or database failure means verification
    // could not be performed (exit 3) — never a stale PASS and never a
    // decision against an unverified head.
    authorizationError = error instanceof Error ? error.message : String(error);
  }

  if (authorizationError !== null || authorization === null) {
    const classification = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: undefined,
      executionFailureReason: `the report authorization could not be performed: ${authorizationError ?? 'no authorization result'}`,
      subjectVerdicts: [],
      boundKeyDomains: [],
      anomalies: [],
    });
    return {
      runId,
      snapshotId,
      snapshotContentHash,
      integrity,
      classification,
      reportInput: null,
    };
  }

  if (authorization.disposition === 'EXECUTION_FAILURE') {
    const classification = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: undefined,
      executionFailureReason: authorization.reason,
      subjectVerdicts: [],
      boundKeyDomains: boundKeyDomains(authorization.state, boundKeys),
      anomalies: authorization.anomalies,
    });
    return {
      runId,
      snapshotId,
      snapshotContentHash,
      integrity,
      classification,
      reportInput: null,
    };
  }

  const classification = classifyExit({
    runTerminalState: 'COMPLETED',
    evidenceIntegrityVerified: integrity.chainValid && integrity.contentHashesValid,
    subjectVerdicts: boundSubjectVerdicts(authorization.state, boundKeys),
    boundKeyDomains: boundKeyDomains(authorization.state, boundKeys),
    anomalies: authorization.anomalies,
    ...(authorization.authorized
      ? {}
      : {
          authorizationFailure:
            authorization.disposition === 'RETRY'
              ? `bounded re-analysis exhausted after ${String(RUN_ANALYSIS_MAX_CYCLES)} cycle(s): ${authorization.reason}`
              : authorization.reason,
        }),
  });
  const reportInput =
    authorization.state !== null && authorization.external !== null
      ? assembleReportInput(authorization.state, authorization.external, boundKeys)
      : null;
  return {
    runId,
    snapshotId,
    snapshotContentHash,
    integrity,
    classification,
    reportInput,
  };
}

/**
 * Executes the Phase 18 replay flow for one durable reproduction
 * definition (ADR-0019 Decision 4; incident-replay §3):
 *   1. load the reproduction row (missing id → ReplayRequestError,
 *      exit 4 — nothing executed);
 *   2. refuse history tamper (the row's `snapshotContentHash` must
 *      equal the stored snapshot's hash);
 *   3. fail-closed binding validation (target binding, credential
 *      REFERENCE authorization under the CURRENT server-owned policy,
 *      invariant-version availability — ReplayValidationError, exit 4,
 *      nothing durable);
 *   4. create a NEW run from the SAME stored snapshot (no new
 *      snapshot row — the same `snapshotContentHash`; the original
 *      run's observations, evaluations, and findings are structurally
 *      unreachable — every write is keyed by the new run id);
 *   5. dispatch + drive the shared pipeline (five-way exits, ADR-0026
 *      eligibility, C/P/D watermarking, evidence integrity, and
 *      conservative INDETERMINATE handling identical to `run`).
 * Never automatically retries ambiguous mutations: the frozen
 * retryPolicy (NONE on the canonical scenarios) executes unchanged,
 * and INDETERMINATE outcomes follow the accepted classifier rules.
 */
export async function executeReplay(
  prisma: PrismaClient,
  reproductionId: string,
  options: RunFlowOptions,
): Promise<RunOutcome> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reproductionId)) {
    throw new ReplayRequestError('reproduction definition id must be a UUID');
  }
  const reproduction = await prisma.reproductionDefinition.findUnique({
    where: { id: reproductionId },
    select: {
      id: true,
      runId: true,
      snapshotId: true,
      snapshotContentHash: true,
      invariantBindings: true,
    },
  });
  if (reproduction === null) {
    throw new ReplayRequestError(
      `reproduction definition ${reproductionId} does not exist — nothing was executed`,
    );
  }
  const sourceRun = await prisma.experimentRun.findUnique({
    where: { id: reproduction.runId },
    select: { snapshotId: true, snapshot: { select: { content: true } } },
  });
  if (sourceRun?.snapshotId !== reproduction.snapshotId) {
    throw new ReplayRequestError('reproduction snapshot does not match its original run binding');
  }
  // Fail-closed binding validation BEFORE anything durable happens.
  const binding = await validateReplayBinding(
    prisma,
    reproduction.snapshotId,
    options.credentialPolicy,
  );
  if (
    reproduction.snapshotContentHash !== binding.snapshotContentHash ||
    reproduction.snapshotId !== binding.snapshotId
  ) {
    throw new ReplayRequestError(
      `reproduction definition ${reproductionId} is bound to snapshot hash ${reproduction.snapshotContentHash} but the stored snapshot carries ${binding.snapshotContentHash} — history may have been tampered with; replay is refused`,
    );
  }
  const document = sourceRun.snapshot.content as unknown as RunSnapshotDocument;
  if (
    document.target.contractKind === 'DEMO_FINTECH_WEBHOOK' &&
    document.target.manifestEvidencePolicy === undefined
  ) {
    const raw = reproduction.invariantBindings as { invariants?: unknown };
    const invariants = Array.isArray(raw?.invariants)
      ? (raw.invariants as Array<{ invariantKey?: unknown; evaluatorVersion?: unknown }>)
      : [];
    // The known legacy engine's built-ins are v1; reproduction metadata
    // must corroborate that contract, never override or widen it.
    if (
      invariants.length !== binding.invariantKeys.length ||
      binding.invariantKeys.some(
        (key) =>
          invariants.filter(
            (entry) => entry?.invariantKey === key && entry.evaluatorVersion === 'v1',
          ).length !== 1,
      )
    ) {
      throw new ReplayRequestError(
        'legacy reproduction has missing or unsupported frozen invariant bindings — replay refuses evaluator substitution',
      );
    }
  }
  const created = await createRunFromSnapshot(prisma, binding.snapshotId, options.credentialPolicy);
  await dispatchRun(prisma, created.runId, options);
  return driveRunToReport(
    prisma,
    created.runId,
    binding.targetId,
    created.snapshotId,
    created.contentHash,
    options,
  );
}

/**
 * Executes the full audited flow for one validated scenario and
 * returns the exit classification plus the assembled report input.
 * The caller (cli.ts) serializes the report and maps errors to exit
 * classes. Nothing here invents truth: evaluations/findings/integrity
 * are read from durable rows after the accepted pipelines ran.
 */
export async function executeScenario(
  prisma: PrismaClient,
  scenario: ScenarioDocument,
  options: RunFlowOptions,
): Promise<RunOutcome> {
  // ---- 4. Resolve the registered target (before anything durable). ----
  const resolved = await resolveTargetByDisplayName(prisma, scenario.target.displayName);
  const target = await getTarget(prisma, resolved.targetId);

  // ---- 5. Engine validation of the embedded experiment (authoritative).
  // Any ExperimentValidationError here is a usage error surface — it
  // throws BEFORE any durable write (createExperiment validates first).
  // ---- 6./7. Immutable revision + snapshot happen inside createRun's
  // freeze path (createExperiment → revision 1; createRun pins the
  // snapshot before any execution — ADR-0010).
  let created: { definitionId: string; revisionId: string; revisionNumber: number };
  try {
    created = await createExperiment(
      prisma,
      {
        name: scenario.name,
        ...(scenario.description !== '' ? { description: scenario.description } : {}),
        targetId: target.id,
        document: scenarioExperimentDocument(scenario),
      },
      options.credentialPolicy,
    );
  } catch (error) {
    if (error instanceof ExperimentValidationError || error instanceof ScenarioValidationError) {
      throw error; // Usage error — nothing durable was created.
    }
    throw error;
  }

  // ---- 7. Snapshot pin + 8. durable run creation. ----
  const run = await createRun(prisma, created.revisionId, options.credentialPolicy);
  const runRow = await prisma.experimentRun.findUniqueOrThrow({
    where: { id: run.runId },
    select: { snapshot: { select: { id: true, contentHash: true } } },
  });
  const snapshotId: string = runRow.snapshot.id;
  const snapshotContentHash: string = runRow.snapshot.contentHash;

  // ---- 8. Dispatch through the real queue (IDs only; ADR-0003). ----
  await dispatchRun(prisma, run.runId, options);

  // ---- 9.–14. The shared drive-to-report pipeline (verbatim for `run`
  // and `replay` — five-way exits, eligibility, watermarking, integrity,
  // and INDETERMINATE handling identical in both flows). ----
  return driveRunToReport(prisma, run.runId, target.id, snapshotId, snapshotContentHash, options);
}

/** The frozen identity an out-of-lock chain verification covered. */
function chainIdentityOf(integrity: IntegrityReport): ChainIdentity {
  return {
    headContentHash: integrity.recomputedHeadHash,
    observationCount: integrity.observationCount,
    lastChainIndex: integrity.observationCount === 0 ? null : integrity.observationCount - 1,
  };
}

/** Every non-publication input the report needs, resolved under the lock. */
export interface FrozenReportInputs {
  readonly target: ReportTargetIdentity;
  readonly run: ReportRunIdentity;
  readonly sideEffectSummary: ReportInput['sideEffectSummary'];
  readonly findings: readonly ReportFinding[];
  readonly reproduction: ReportReproductionReference | null;
  readonly invariantEvaluatorVersions: ReadonlyArray<{
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
  }>;
  readonly normalizerVersions: ReadonlyArray<{ readonly name: string; readonly version: string }>;
}

/**
 * Resolves EVERY database-resident report input INSIDE the Boundary B
 * authorization transaction (the lock is held; bounded indexed reads
 * only). Post-commit emission performs no live reads that could change
 * an authorized field.
 */
export async function loadFrozenReportInputs(
  db: ReportReadDb,
  runId: string,
  targetId: string,
  boundKeys: readonly string[],
): Promise<FrozenReportInputs> {
  // SEQUENTIAL on purpose: these reads run inside the per-run lock
  // transaction (Boundary B), and concurrent statements inside one
  // interactive transaction are pipelined onto its single connection by
  // the driver adapter. Bounded indexed reads only; no filesystem,
  // stdout, network, or evidence scan takes place under the lock.
  const target = await loadReportTarget(db, targetId);
  const runRow = await loadReportRun(db, runId);
  const sideEffectSummary = await loadSideEffectSummary(db, runId);
  const findings = await loadReportFindings(db, runId);
  const reproduction = await loadReportReproduction(db, runId);
  const evaluatorVersions = await loadInvariantEvaluatorVersions(db, runId, boundKeys);
  const normalizers = await loadNormalizerVersions(db, runId);
  // Explicit projection (never a rest-destructure): the frozen run
  // identity is exactly these fields — the loader's join key
  // (`targetId`) is not report truth.
  const run: ReportRunIdentity = {
    runId: runRow.runId,
    experimentName: runRow.experimentName,
    experimentDefinitionId: runRow.experimentDefinitionId,
    revisionId: runRow.revisionId,
    revisionNumber: runRow.revisionNumber,
    snapshotId: runRow.snapshotId,
    snapshotContentHash: runRow.snapshotContentHash,
    terminalState: runRow.terminalState,
    engineVersion: runRow.engineVersion,
  };
  return {
    target,
    run,
    sideEffectSummary,
    findings,
    reproduction,
    invariantEvaluatorVersions: evaluatorVersions,
    normalizerVersions: normalizers,
  };
}

/** The BOUND key domains of an authorized state (missing proof ⇒ mode null). */
function boundKeyDomains(
  state: AuthorizedReportState | null,
  boundKeys: readonly string[],
): BoundKeyDomain[] {
  return boundKeys.map((invariantKey) => {
    const proof = state?.keys.find((key) => key.invariantKey === invariantKey);
    return {
      invariantKey,
      mode: proof?.mode ?? null,
      evaluatorVersion: proof?.evaluatorVersion ?? null,
      declaredSubjects: proof?.declaredSubjects ?? [],
      eligibleSubjects: proof?.eligibleSubjects ?? [],
      missingSubjects: proof?.missingSubjects ?? [],
      unexpectedSubjectCount: proof?.unexpectedSubjects.length ?? 0,
      evidenceGapCount: proof?.evidenceGaps.length ?? 0,
    };
  });
}

/**
 * The current ELIGIBLE subject verdicts of the BOUND domain (ADR-0026
 * §14 rule 4 / §15): a STRICT key contributes only the pointers whose
 * subject is inside its authoritative eligible set — a pointer naming an
 * undeclared/foreign subject is a coverage anomaly (rule 5), never a
 * business FAIL of this run. A LEGACY-COMPAT key has no declared domain:
 * its as-observed pointers ARE the domain, so every pointer counts.
 */
function boundSubjectVerdicts(
  state: AuthorizedReportState | null,
  boundKeys: readonly string[],
): SubjectVerdict[] {
  const bound = new Set(boundKeys);
  const verdicts: SubjectVerdict[] = [];
  for (const pointer of state?.pointers ?? []) {
    if (!bound.has(pointer.invariantKey)) {
      continue;
    }
    const proof = state?.keys.find((key) => key.invariantKey === pointer.invariantKey);
    if (proof !== undefined && proof.mode === EXIT_MODE_STRICT) {
      if (!proof.eligibleSubjects.includes(pointer.subjectKey)) {
        continue;
      }
    }
    verdicts.push({
      invariantKey: pointer.invariantKey,
      subjectKey: pointer.subjectKey,
      verdict: asVerdict(pointer.verdict),
      mode: proof?.mode ?? 'legacy-compat',
      evaluatorVersion: pointer.evaluatorVersion,
    });
  }
  return verdicts;
}

function asVerdict(value: string): 'PASS' | 'FAIL' | 'NOT_EVALUABLE' {
  if (value === 'PASS' || value === 'FAIL' || value === 'NOT_EVALUABLE') {
    return value;
  }
  throw new ReportInputError(
    `persisted verdict "${value}" is not one of the closed verdict values`,
  );
}

/**
 * Assembles the frozen report input from the authorized state + the
 * inputs resolved under the lock. `invariantEvaluations` serializes the
 * BOUND keys' current evaluations; unbound current evaluations are
 * NEVER silently omitted — they are disclosed (with their verdicts) in
 * the eligibility block.
 */
function assembleReportInput(
  state: AuthorizedReportState,
  external: FrozenReportInputs,
  boundKeys: readonly string[],
): ReportInput {
  const bound = new Set(boundKeys);
  const modeByKey = new Map(state.keys.map((key) => [key.invariantKey, key.mode]));
  const evaluations: ReportEvaluation[] = state.evaluations
    .filter((evaluation) => bound.has(evaluation.invariantKey))
    .map((evaluation) => ({
      invariantKey: evaluation.invariantKey,
      evaluatorVersion: evaluation.evaluatorVersion,
      subjectKey: evaluation.subjectKey,
      verdict: asVerdict(evaluation.verdict),
      reason: evaluation.reason,
      evidenceSetHash: evaluation.evidenceSetHash,
      details: evaluation.details,
      mode: modeByKey.get(evaluation.invariantKey) ?? null,
    }));
  return {
    target: external.target,
    run: external.run,
    sideEffectSummary: external.sideEffectSummary,
    evaluations,
    findings: external.findings,
    reproduction: external.reproduction,
    invariantEvaluatorVersions: external.invariantEvaluatorVersions,
    normalizerVersions: external.normalizerVersions,
    eligibility: {
      eligibilityVersions: [
        ...new Set(
          state.keys
            .filter((key) => bound.has(key.invariantKey))
            .map((key) => key.eligibilityVersion),
        ),
      ].sort(),
      analysisGeneration: state.analysisGeneration,
      certified: state.certified,
      certifiedAsOf: {
        headContentHash: state.watermark.chain.headContentHash,
        observationCount: state.watermark.chain.observationCount,
        lastChainIndex: state.watermark.chain.lastChainIndex,
        provenanceRevision: state.watermark.provenanceRevision,
        derivationGeneration: state.watermark.derivationGeneration,
      },
      boundKeys: state.keys
        .filter((key) => bound.has(key.invariantKey))
        .map((key) => ({
          invariantKey: key.invariantKey,
          mode: key.mode,
          evaluatorVersion: key.evaluatorVersion,
          declaredSubjects: key.declaredSubjects,
          eligibleSubjects: key.eligibleSubjects,
          missingSubjects: key.missingSubjects,
          unexpectedSubjectCount: key.unexpectedSubjects.length,
          foreignInventoryCount: key.foreignInventory.length,
          evidenceGapCount: key.evidenceGaps.length,
        })),
      unboundCurrentEvaluations: state.evaluations
        .filter((evaluation) => !bound.has(evaluation.invariantKey))
        .map((evaluation) => ({
          invariantKey: evaluation.invariantKey,
          subjectKey: evaluation.subjectKey,
          verdict: evaluation.verdict,
        }))
        .sort(
          (a, b) =>
            a.invariantKey.localeCompare(b.invariantKey) ||
            a.subjectKey.localeCompare(b.subjectKey),
        ),
      anomalies: state.anomalies as ExitAnomaly[],
      coverageLimitation:
        [
          ...new Set(
            state.keys
              .filter((key) => bound.has(key.invariantKey))
              .map((key) => key.coverageStatement)
              .filter((statement) => statement.length > 0),
          ),
        ]
          .sort()
          .join(' | ') || null,
      freshnessStatement: FRESHNESS_STATEMENT,
    },
  };
}

/**
 * The bound invariant keys from the run's FROZEN snapshot (never live
 * definition rows — ADR-0010). The exit contract is over exactly these.
 */
export async function boundInvariantKeysOf(prisma: PrismaClient, runId: string): Promise<string[]> {
  const row = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (row === null) {
    return [];
  }
  return frozenInvariantKeys(row.snapshot.content as unknown as RunSnapshotDocument);
}

/**
 * Captures the frozen manifest's declared inspection query set for a
 * COMPLETED run (worker-owned Phase 14 seam invoked by the CLI — ADR-0019
 * audited flow step 10). GENERAL: driven entirely by the FROZEN
 * snapshot's manifestEvidencePolicy; targets without a declared generic
 * evidence policy get zero captures (legacy runs — nothing guessed).
 * Post-terminal, once per run, read-only, credential-free (generic
 * inspection is credential-free by contract; NB-1 stays separate).
 * Capture failure is honest evidence incompleteness — it never rewrites
 * execution truth; evaluators turn missing captures into NOT_EVALUABLE.
 */
export async function captureRunGenericInspections(
  prisma: PrismaClient,
  runId: string,
  writerOwnerId: string,
): Promise<{ captured: number; valid: number } | null> {
  const { document } = await loadRunSnapshot(prisma, runId);
  const policy = document.target.manifestEvidencePolicy;
  if (policy === undefined) {
    // Legacy/manifest-less run: no frozen generic policy exists —
    // nothing is captured, nothing is guessed.
    return null;
  }
  const captured = await captureGenericInspectionSet(prisma, {
    runId,
    stepRunId: null,
    origin: document.target.origin,
    environment: document.target.environment,
    policy,
    writerOwnerId,
    // The CLI drives no worker lease; capture is an honest attributed
    // observation (owner + null fencing token — raw observations stay
    // append-only records of what was observed, R-10).
    writerFencingToken: null,
  });
  return { captured: captured.length, valid: captured.filter((entry) => entry.valid).length };
}

// Re-exported for the CLI's error mapping (single source of truth for
// usage-error classification of engine validation failures).
export {
  TargetRegistrationError,
  RunCreationError,
  ReportInputError,
  ReplayValidationError,
  EXIT_CLASSES,
};
