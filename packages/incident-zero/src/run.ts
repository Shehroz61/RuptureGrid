// =====================================================================
// RuptureGrid v1.0 — golden scenario orchestration (Phase 7)
// =====================================================================
// The smallest orchestration surface that makes Incident Zero a ONE-
// COMMAND, end-to-end, repeatable golden run through the accepted
// pipeline. This is NOT a new truth engine (§9 hard non-scope):
//
//   Phase 3 engine      — registers target, creates experiment,
//                         pins the snapshot, dispatches the run
//   Phase 3 worker      — real execution (leases/fencing; unchanged)
//   Phase 4 evidence    — real capture + analysis (worker-driven)
//   Phase 4 evaluator   — INV-IZ-1 verdict (unchanged)
//   Phase 5 forensics   — Finding/timeline/reproduction (unchanged)
//
// This module only: verifies readiness → ensures the registration →
// creates the definition + run → dispatches → BOUNDED POLLS durable
// Control-Plane state → triggers Phase 4/5 derivation through the
// accepted packages → returns a SAFE RESULT STRUCTURE (generated IDs
// only; no secret values anywhere; ADR-0012).
//
// Repeatability (incident-replay §5): verdicts are stable across runs;
// generated IDs (runs, payments, findings) are per-run by design.
// Cross-run contamination is impossible: the first step RESETS the
// target's logical context through the target's own admin interface.

import type { PrismaClient } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import {
  createExperiment,
  createRun,
  markRunDispatching,
  registerTarget,
} from '@rupturegrid/engine';
import { runRunAnalysis, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import {
  GOLDEN_SCENARIO_VERSION,
  SECURE_EXPERIMENT_NAME,
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
  VULNERABLE_EXPERIMENT_NAME,
  goldenScenarioSteps,
} from './contract.js';
import { verifyGoldenReadiness } from './readiness.js';
import type {
  GoldenEvaluation,
  GoldenFinding,
  GoldenMode,
  GoldenPaymentIdentity,
  GoldenRunResult,
  GoldenTargetRegistration,
  GoldenWalletState,
} from './run-types.js';
export type {
  GoldenEvaluation,
  GoldenFinding,
  GoldenMode,
  GoldenPaymentIdentity,
  GoldenRunResult,
  GoldenTargetRegistration,
  GoldenWalletState,
} from './run-types.js';

export class GoldenRunError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GoldenRunError';
  }
}

/** Options — every value is environment-driven by the caller (R-15). */
export interface GoldenRunOptions {
  readonly prisma: PrismaClient;
  /** Validated worker-style config surface the engine/queue need. */
  readonly redisUrl: string;
  readonly queuePrefix: string;
  /** Pre-registered target id (see ensureGoldenTargetRegistration). */
  readonly targetId: string;
  /**
   * The canonical scenario mode — EXPLICIT, never inferred from names
   * or live target state. The frozen snapshot declares the intent.
   */
  readonly mode: GoldenMode;
  /** Bounded poll ceiling for the whole run (ms) — never a fixed sleep. */
  readonly runTimeoutMs?: number;
  /** Bounded poll ceiling for Phase 4/5 derivation (ms). */
  readonly derivationTimeoutMs?: number;
  /** Poll interval (ms) against durable state. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_RUN_TIMEOUT_MS = 180_000;
const DEFAULT_DERIVATION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Registers the Demo Target for the golden scenario against ONE
 * origin. Credential REFERENCES only (ADR-0012); LOCAL_DEVELOPMENT
 * only (R-14); the same contract kind the accepted Phase 3/4/5 suites
 * use. Idempotent: if ANY registration already holds this origin it
 * is reused (origin authority is global in the engine, so re-register
 * the same origin under a new name is refused BY DESIGN — callers
 * give each mode its own demo origin/port); otherwise a new
 * registration is created with the given display name.
 */
export async function ensureGoldenTargetRegistration(
  prisma: PrismaClient,
  origin: string,
  displayName: string,
): Promise<GoldenTargetRegistration> {
  const existingByOrigin = await prisma.targetRegistration.findFirst({
    where: { origins: { some: { origin } } },
    select: { id: true },
  });
  if (existingByOrigin !== null) {
    return { targetId: existingByOrigin.id, origin, created: false };
  }
  const registered = await registerTarget(prisma, {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [origin],
    contractKind: 'DEMO_FINTECH_WEBHOOK',
    credentialRefs: ['DEMO_ADMIN_TOKEN', 'DEMO_INSPECTION_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'],
  });
  return { targetId: registered.targetId, origin, created: true };
}

/** Bounded polling against durable persisted state (testing-strategy §6). */
async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new GoldenRunError(`${label}: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function loadPaymentIdentity(
  prisma: PrismaClient,
  runId: string,
): Promise<GoldenPaymentIdentity> {
  const rows = (await prisma.$queryRaw`
    SELECT i."responseBody" AS body
      FROM "control"."step_invocation" i
      JOIN "control"."experiment_step_run" s ON s."id" = i."stepRunId"
     WHERE s."runId" = ${runId}::uuid
       AND s."name" = 'create-payment'
       AND i."responseBody" IS NOT NULL
     ORDER BY i."sequence" ASC
     LIMIT 1
  `) as Array<{ body: string }>;
  const parsed: unknown = JSON.parse(rows[0]?.body ?? '{}');
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['payment'] !== 'object'
  ) {
    throw new GoldenRunError(
      `run ${runId}: the create-payment step recorded no provider payment identity`,
    );
  }
  const payment = (parsed as { payment: Record<string, unknown> })['payment'];
  const walletUnknown = (parsed as Record<string, unknown>)['wallet'];
  const providerPaymentId = payment['providerPaymentId'];
  const amountMinor = payment['amountMinor'];
  const currency = payment['currency'];
  const walletId = isRecord(walletUnknown) ? walletUnknown['walletId'] : undefined;
  if (
    typeof providerPaymentId !== 'string' ||
    typeof amountMinor !== 'string' ||
    typeof currency !== 'string'
  ) {
    throw new GoldenRunError(
      `run ${runId}: create-payment response lacks the payment identity fields`,
    );
  }
  return {
    providerPaymentId,
    walletId: typeof walletId === 'string' ? walletId : '',
    amountMinor,
    currency,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadWalletStateFromEvidence(
  prisma: PrismaClient,
  runId: string,
): Promise<GoldenWalletState | null> {
  const observation = await prisma.rawObservation.findFirst({
    where: { runId, kind: 'target_observation' },
    orderBy: { chainIndex: 'desc' },
    select: { payload: true },
  });
  if (observation === null) {
    return null;
  }
  const payload = (observation.payload ?? {}) as Record<string, unknown>;
  const wallet = payload['wallet'];
  if (!isRecord(wallet)) {
    return null;
  }
  const walletId = wallet['walletId'];
  const balanceMinor = wallet['balanceMinor'];
  const currency = wallet['currency'];
  if (
    typeof walletId !== 'string' ||
    typeof balanceMinor !== 'string' ||
    typeof currency !== 'string'
  ) {
    return null;
  }
  return { walletId, balanceMinor, currency };
}

async function loadEvaluation(
  prisma: PrismaClient,
  runId: string,
  subjectKey: string,
): Promise<GoldenEvaluation | null> {
  const row = await prisma.invariantEvaluation.findFirst({
    where: { runId, subjectKey },
    orderBy: { createdAt: 'desc' },
    select: { id: true, subjectKey: true, verdict: true, reason: true, details: true },
  });
  if (row === null) {
    return null;
  }
  const details = (row.details ?? {}) as Record<string, unknown>;
  const count = details['equivalentEffectCount'];
  return {
    id: row.id,
    subjectKey: row.subjectKey,
    verdict: row.verdict,
    reason: row.reason,
    equivalentEffectCount: typeof count === 'number' ? count : null,
  };
}

async function loadFinding(prisma: PrismaClient, runId: string): Promise<GoldenFinding | null> {
  const row = await prisma.finding.findFirst({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, reasonCode: true, subjectKey: true },
  });
  return row === null ? null : row;
}

/**
 * Executes the FULL canonical golden scenario for one mode, end to
 * end, through the accepted systems. Throws GoldenRunError (with
 * honest, secret-free messages) on any prerequisite or pipeline
 * failure. The mode is a REQUIRED explicit option — the snapshot must
 * declare the intent; it is never inferred from names or live state.
 */
export async function runGoldenScenario(options: GoldenRunOptions): Promise<GoldenRunResult> {
  const {
    prisma,
    redisUrl,
    queuePrefix,
    targetId,
    mode,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    derivationTimeoutMs = DEFAULT_DERIVATION_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  // ---- 0. Readiness (real state; fail before any execution). ----
  const target = await prisma.targetRegistration.findUniqueOrThrow({
    where: { id: targetId },
    include: { origins: true },
  });
  const origin = [...target.origins].map((entry) => entry.origin).sort()[0] as string;
  await verifyGoldenReadiness(prisma, { targetId, origin, redisUrl });

  // ---- 1. Definition + run creation through the Phase 3 Control Plane. ----
  // Repeatability (incident-replay §5): every run of a mode must share
  // ONE frozen intent. Definitions are UNIQUELY NAMED, so the first
  // call creates (name, revision 1); later calls reuse it. The latest
  // revision is always the canonical scenario document for the mode,
  // so ALL runs of a mode pin the SAME snapshot content hash — while
  // each run still gets its own generated IDs.
  const name = mode === 'SECURE' ? SECURE_EXPERIMENT_NAME : VULNERABLE_EXPERIMENT_NAME;
  let definitionId: string | undefined;
  let revisionId: string;
  try {
    const created = await createExperiment(prisma, {
      name,
      targetId,
      document: { steps: goldenScenarioSteps(mode) } as never,
    });
    revisionId = created.revisionId;
    definitionId = created.definitionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existing = await prisma.experimentDefinition.findUnique({
      where: { name },
      select: {
        id: true,
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          take: 1,
          select: { id: true, targetId: true },
        },
      },
    });
    if (
      existing === null ||
      existing.revisions[0] === undefined ||
      existing.revisions[0].targetId !== targetId
    ) {
      throw new GoldenRunError(
        `golden experiment "${name}" could not be created and no matching definition exists: ${message}`,
      );
    }
    definitionId = existing.id;
    revisionId = existing.revisions[0].id;
  }
  const run = await createRun(prisma, revisionId);
  const runRow = await prisma.experimentRun.findUniqueOrThrow({
    where: { id: run.runId },
    select: { snapshot: { select: { id: true, contentHash: true } } },
  });

  // ---- 2. Dispatch through the real queue (IDs only; ADR-0003). ----
  await markRunDispatching(prisma, run.runId);
  const firstStep = await prisma.experimentStepRun.findFirstOrThrow({
    where: { runId: run.runId },
    orderBy: { sequence: 'asc' },
    select: { id: true, sequence: true },
  });
  const queue = createExecutionQueue({ redisUrl, prefix: queuePrefix });
  try {
    await queue.enqueueStep({
      runId: run.runId,
      stepRunId: firstStep.id,
      sequence: firstStep.sequence,
    });
  } finally {
    await queue.close();
  }

  // ---- 3. Bounded poll: terminal run state from PostgreSQL. ----
  const terminal = await waitFor(
    async () => {
      const row = await prisma.experimentRun.findUnique({
        where: { id: run.runId },
        select: { state: true },
      });
      if (row === null) {
        throw new GoldenRunError(`run ${run.runId} vanished from the durable store`);
      }
      return row.state === 'COMPLETED' || row.state === 'FAILED' || row.state === 'CANCELLED'
        ? row.state
        : null;
    },
    runTimeoutMs,
    pollIntervalMs,
    `golden run ${run.runId}`,
  );
  if (terminal !== 'COMPLETED') {
    throw new GoldenRunError(`golden run ${run.runId} ended in state ${terminal}`);
  }

  // ---- 4. Phase 4 analysis + Phase 5 forensics (accepted engines). ----
  await runRunAnalysis(prisma, run.runId);
  await waitFor(
    async () => {
      const batch = await prisma.evaluationBatch.findFirst({
        where: { runId: run.runId, completedAt: { not: null } },
        select: { id: true },
      });
      return batch === null ? null : true;
    },
    derivationTimeoutMs,
    pollIntervalMs,
    'Phase 4 evaluation batch',
  );
  await deriveRunForensics(prisma, run.runId);

  // ---- 5. Assemble the safe result structure from durable truth. ----
  const payment = await loadPaymentIdentity(prisma, run.runId);
  const [wallet, evaluation, finding, integrity, timelineEntryCount, reproduction] =
    await Promise.all([
      loadWalletStateFromEvidence(prisma, run.runId),
      loadEvaluation(prisma, run.runId, payment.providerPaymentId),
      loadFinding(prisma, run.runId),
      verifyRunEvidenceChain(prisma, run.runId),
      prisma.forensicTimelineEntry.count({ where: { runId: run.runId } }),
      prisma.reproductionDefinition.findUnique({
        where: { runId: run.runId },
        select: {
          snapshotContentHash: true,
          targetModeRequirement: true,
          credentialRefs: true,
        },
      }),
    ]);

  // Target-side physical counts from the RUN'S OWN lineage observation
  // (Phase 4 evidence — not a live re-read; the run's story is its own).
  const lineageObservation = await prisma.rawObservation.findFirst({
    where: { runId: run.runId, kind: 'target_observation' },
    orderBy: { chainIndex: 'desc' },
    select: { payload: true },
  });
  const lineagePayload = (lineageObservation?.payload ?? {}) as Record<string, unknown>;
  const counts = isRecord(lineagePayload['counts']) ? lineagePayload['counts'] : {};

  return {
    scenarioVersion: GOLDEN_SCENARIO_VERSION,
    mode,
    runId: run.runId,
    experimentId: definitionId,
    revisionId,
    snapshotId: runRow.snapshot.id,
    snapshotContentHash: runRow.snapshot.contentHash,
    targetId,
    targetOrigin: origin,
    runState: terminal,
    payment,
    wallet,
    evaluation,
    finding,
    integrity: {
      observationCount: integrity.observationCount,
      chainValid: integrity.chainValid,
    },
    timelineEntryCount,
    reproductionDefinition:
      reproduction === null
        ? null
        : {
            snapshotContentHash: reproduction.snapshotContentHash,
            targetModeRequirement: reproduction.targetModeRequirement,
            credentialRefs: reproduction.credentialRefs,
          },
    deliveryCount: typeof counts['deliveries'] === 'number' ? counts['deliveries'] : 0,
    processingAttemptCount:
      typeof counts['processingAttempts'] === 'number' ? counts['processingAttempts'] : 0,
    financialEffectCount:
      typeof counts['financialEffects'] === 'number' ? counts['financialEffects'] : 0,
  };
}

export {
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
};
