// =====================================================================
// RuptureGrid v1.0 — forensics derivation service (Phase 5, §30–§41)
// =====================================================================
// Loads the persisted Phase 3 execution truth + Phase 4 evidence/
// evaluation truth, derives Findings and timeline entries determinis-
// tically, and persists them idempotently:
//
//   - Finding identity is a DATABASE constraint (§64):
//     unique (invariantEvaluationId, findingRuleVersion). Repeat and
//     concurrent derivations converge on ONE row; P2002 is matched
//     PRECISELY on that constraint's target fields (§70) — never
//     swallowed generically. Convergence re-fetches OUTSIDE any
//     aborted transaction (§71).
//   - Timeline identity: unique (runId, derivationVersion, sourceKind,
//     sourceId, entryKind) — same source under the same derivation
//     version is ONE entry (§65).
//   - Phase 4 evidence and Phase 3 execution history are READ-ONLY
//     here (§35/§36): this module issues only creates and batch
//     counter updates on Phase 5's own tables.
//   - Derivation failure leaves Phase 4 truth intact; retry converges
//     (§72).
//   - Offline derivation (§77/§78): inputs come exclusively from
//     durable Control-DB rows — no Demo call, no target network.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { InvariantEvaluationModel } from '@rupturegrid/control-db';
import {
  deriveFindingFromEvaluation,
  FINDING_REASON_CODES,
  PROOF_ROLES,
  PROOF_SUBJECTS,
} from './finding.js';
import type {
  FindingEvaluationInput,
  FindingExecutionScope,
  FindingProofReference,
} from './finding.js';
import {
  compareTimelineEntries,
  deriveTimeline,
  findingTimelineEntry,
  timelineInputFingerprint,
} from './timeline.js';
import type { TimelineEntrySpec, TimelineDerivationInput } from './timeline.js';
import { isUniqueConstraint } from './p2002.js';
import { deriveReproductionDefinition, persistReproductionDefinition } from './reproduction.js';
import { TIMELINE_DERIVATION_VERSION, FINDING_RULE_VERSION } from './versions.js';

export class ForensicDerivationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ForensicDerivationError';
  }
}

export interface DerivedFindingSummary {
  readonly id: string;
  readonly runId: string;
  readonly invariantEvaluationId: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly created: boolean;
}

export interface ForensicDerivationResult {
  readonly runId: string;
  readonly derivationVersion: string;
  readonly inputFingerprint: string;
  readonly findings: DerivedFindingSummary[];
  readonly timelineEntryCount: number;
  readonly derived: boolean;
}

/**
 * The precise P2002 matchers live in `p2002.ts` (§70), shared with the
 * reproduction-definition persistence path so every Phase 5 persistence
 * converges identically.
 */

function toEvaluationInput(
  row: InvariantEvaluationModel,
  executionUncertainty: FindingExecutionScope,
): FindingEvaluationInput {
  return {
    id: row.id,
    runId: row.runId,
    invariantKey: row.invariantKey,
    evaluatorVersion: row.evaluatorVersion,
    subjectKey: row.subjectKey,
    verdict: row.verdict,
    completenessBasis: row.completenessBasis,
    evidenceSetHash: row.evidenceSetHash,
    sourceObservationHashes: row.sourceObservationHashes,
    normalizedEventIds: row.normalizedEventIds,
    causalRelationshipIds: row.causalRelationshipIds,
    details: (row.details ?? {}) as Record<string, unknown>,
    executionUncertainty,
  };
}

/**
 * Persists one Finding with its proof references. P2002 on the
 * semantic key (invariantEvaluationId, findingRuleVersion) converges
 * on the existing row — precise constraint matching, re-fetch outside
 * any failed transaction (§70/§71). Proof-reference conflicts converge
 * identically (same finding + same source + same role is ONE row).
 */
async function persistFinding(
  prisma: PrismaClient,
  input: {
    readonly runId: string;
    readonly evaluationId: string;
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly subjectKey: string;
    readonly reasonCode: string;
    readonly title: string;
    readonly summary: string;
    readonly inputFingerprint: string;
    readonly details: Record<string, unknown>;
    readonly provenScope: Record<string, unknown>;
    readonly uncertainScope: Record<string, unknown>;
    readonly proofReferences: readonly FindingProofReference[];
  },
): Promise<{ id: string; created: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.finding.create({
        data: {
          id: randomUUID(),
          runId: input.runId,
          invariantEvaluationId: input.evaluationId,
          invariantKey: input.invariantKey,
          evaluatorVersion: input.evaluatorVersion,
          findingRuleVersion: FINDING_RULE_VERSION,
          subjectKey: input.subjectKey.slice(0, 200),
          reasonCode: input.reasonCode as never,
          title: input.title.slice(0, 200),
          summary: input.summary.slice(0, 500),
          inputFingerprint: input.inputFingerprint,
          details: input.details as object,
          provenScope: input.provenScope as object,
          uncertainScope: input.uncertainScope as object,
        },
        select: { id: true },
      });
      let position = 0;
      for (const reference of input.proofReferences) {
        await tx.findingEvidenceReference.create({
          data: {
            findingId: created.id,
            subject: reference.subject as never,
            sourceId: reference.sourceId.slice(0, 200),
            role: reference.role.slice(0, 64),
            position: position + 1,
            id: randomUUID(),
          },
        });
        position += 1;
      }
      return { id: created.id, created: true };
    });
  } catch (error) {
    if (
      !isUniqueConstraint(
        error,
        ['invariantEvaluationId', 'findingRuleVersion'],
        'finding_invariantEvaluationId_findingRuleVersion_key',
      )
    ) {
      throw error;
    }
    // The identical semantic Finding already exists (repeat/concurrent
    // derivation): converge on the winner's row (§69).
    const existing = await prisma.finding.findFirst({
      where: {
        invariantEvaluationId: input.evaluationId,
        findingRuleVersion: FINDING_RULE_VERSION,
      },
      select: { id: true },
    });
    if (existing === null) {
      throw error;
    }
    return { id: existing.id, created: false };
  }
}

/** Persists one timeline entry; P2002 on the entry identity converges. */
async function persistTimelineEntry(
  prisma: PrismaClient,
  runId: string,
  spec: TimelineEntrySpec,
): Promise<boolean> {
  try {
    await prisma.forensicTimelineEntry.create({
      data: {
        id: randomUUID(),
        runId,
        derivationVersion: TIMELINE_DERIVATION_VERSION,
        entryKind: spec.entryKind as never,
        sourceKind: spec.sourceKind as never,
        sourceId: spec.sourceId.slice(0, 200),
        orderingBasis: spec.orderingBasis as never,
        sequenceNumber: spec.sequenceNumber,
        occurredAt: spec.occurredAt,
        timeMeaning: spec.timeMeaning.slice(0, 40),
        ...(spec.subjectKey === null ? {} : { subjectKey: spec.subjectKey.slice(0, 200) }),
        details: spec.details as object,
      },
      select: { id: true },
    });
    return true;
  } catch (error) {
    if (
      !isUniqueConstraint(
        error,
        ['runId', 'derivationVersion', 'sourceKind', 'sourceId', 'entryKind'],
        'forensic_timeline_entry_runId_derivationVersion_sourceKind__key',
      )
    ) {
      throw error;
    }
    return false; // Already persisted by this or a concurrent pass (§68).
  }
}

/**
 * Deterministic forensic derivation for one run. Throws
 * ForensicDerivationError when the run does not exist. Never mutates
 * Phase 3 execution rows or Phase 4 evidence/evaluation rows.
 */
export async function deriveRunForensics(
  prisma: PrismaClient,
  runId: string,
): Promise<ForensicDerivationResult> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { id: true, state: true, terminalAt: true },
  });
  if (run === null) {
    throw new ForensicDerivationError(`run ${runId} does not exist`);
  }

  // ---- Load the persisted Phase 3 execution truth (read-only). ----
  const [steps, invocations, observations, events, relationships, evaluations] = await Promise.all([
    prisma.experimentStepRun.findMany({
      where: { runId },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        sequence: true,
        name: true,
        state: true,
        intentOutcome: true,
        sideEffectKnowledge: true,
        terminalAt: true,
      },
    }),
    prisma.stepInvocation.findMany({
      where: { stepRun: { runId } },
      orderBy: [{ stepRunId: 'asc' }, { sequence: 'asc' }],
      select: {
        id: true,
        stepRunId: true,
        sequence: true,
        invocationIdentity: true,
        outcome: true,
        sideEffectKnowledge: true,
        httpStatus: true,
        createdAt: true,
        finishedAt: true,
      },
    }),
    prisma.rawObservation.findMany({
      where: { runId },
      orderBy: { chainIndex: 'asc' },
      select: {
        contentHash: true,
        chainIndex: true,
        kind: true,
        adapterKind: true,
        observedAt: true,
        invocationIdentity: true,
        payload: true,
      },
    }),
    prisma.normalizedEvent.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, eventType: true, subjectKey: true, payload: true, createdAt: true },
    }),
    prisma.causalRelationship.findMany({
      where: { runId },
      select: { id: true, fromEventId: true, toEventId: true, relationKind: true, basis: true },
    }),
    prisma.invariantEvaluation.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // ---- Findings: derive from EVERY persisted evaluation (§37). ----
  // Execution uncertainty (evidence-model §8): the run's own INDETERMINATE
  // invocation outcomes feed every Finding's confidence scope.
  const executionUncertainty: FindingExecutionScope = {
    indeterminateInvocationIds: invocations
      .filter((invocation) => invocation.sideEffectKnowledge === 'INDETERMINATE')
      .map((invocation) => invocation.id),
  };
  const findings: DerivedFindingSummary[] = [];
  for (const evaluation of evaluations) {
    const derivation = deriveFindingFromEvaluation(
      toEvaluationInput(evaluation, executionUncertainty),
    );
    if (derivation.finding === null) {
      continue; // PASS / NOT_EVALUABLE: no failure Finding (§40/§41).
    }
    const persisted = await persistFinding(prisma, {
      runId,
      evaluationId: evaluation.id,
      invariantKey: evaluation.invariantKey,
      evaluatorVersion: evaluation.evaluatorVersion,
      subjectKey: derivation.finding.subjectKey,
      reasonCode: derivation.finding.reasonCode,
      title: derivation.finding.title,
      summary: derivation.finding.summary,
      inputFingerprint: derivation.inputFingerprint,
      details: derivation.finding.details,
      provenScope: derivation.finding.provenScope,
      uncertainScope: derivation.finding.uncertainScope,
      proofReferences: derivation.proofReferences,
    });
    findings.push({
      id: persisted.id,
      runId,
      invariantEvaluationId: evaluation.id,
      subjectKey: derivation.finding.subjectKey,
      reasonCode: derivation.finding.reasonCode,
      created: persisted.created,
    });

    // FINDING_DERIVED timeline entry (source: the Finding row).
    await persistTimelineEntry(
      prisma,
      runId,
      findingTimelineEntry({
        findingId: persisted.id,
        runId,
        subjectKey: derivation.finding.subjectKey,
        reasonCode: derivation.finding.reasonCode,
        invariantKey: evaluation.invariantKey,
        createdAt: new Date(),
      }),
    );
  }

  // ---- Timeline: derive over the full Phase 3/4 truth. ----
  const timelineInput: TimelineDerivationInput = {
    run: { id: run.id, state: run.state, terminalAt: run.terminalAt },
    steps: steps.map((row) => ({ ...row, terminalAt: row.terminalAt ?? null })),
    invocations,
    observations: observations.map((row) => ({
      ...row,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    })),
    events: events.map((row) => ({
      ...row,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    })),
    relationships,
    evaluations: evaluations.map((row) => ({
      id: row.id,
      invariantKey: row.invariantKey,
      evaluatorVersion: row.evaluatorVersion,
      subjectKey: row.subjectKey,
      verdict: row.verdict,
      createdAt: row.createdAt,
    })),
  };
  const derived = deriveTimeline(timelineInput);
  const ordered = [...derived.entries].sort(compareTimelineEntries);
  for (const spec of ordered) {
    await persistTimelineEntry(prisma, runId, spec);
  }

  // ---- Reproduction definition (incident-replay §1): bound to the
  // ---- run's frozen snapshot + its own verdicts. Converges on the
  // ---- existing row on repeat derivation; a snapshot rebind is
  // ---- refused — the definition, once created, is append-only.
  const runWithSnapshot = await prisma.experimentRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      snapshotId: true,
      snapshot: { select: { id: true, contentHash: true, content: true } },
    },
  });
  const reproduction = deriveReproductionDefinition({
    runId,
    snapshot: {
      id: runWithSnapshot.snapshot.id,
      contentHash: runWithSnapshot.snapshot.contentHash,
      document: runWithSnapshot.snapshot.content,
    },
    evaluations: evaluations.map((row) => ({
      invariantKey: row.invariantKey,
      evaluatorVersion: row.evaluatorVersion,
      verdict: row.verdict,
    })),
  });
  await persistReproductionDefinition(prisma, reproduction);

  // ---- Derivation record (§33): versioned + input-fingerprinted. ----
  const fingerprint = timelineInputFingerprint(timelineInput);
  const totalEntries = await prisma.forensicTimelineEntry.count({ where: { runId } });
  try {
    await prisma.forensicDerivation.create({
      data: {
        id: randomUUID(),
        runId,
        derivationVersion: TIMELINE_DERIVATION_VERSION,
        inputFingerprint: fingerprint,
        completedAt: new Date(),
        findingCount: findings.length,
        timelineEntryCount: totalEntries,
      },
      select: { id: true },
    });
  } catch (error) {
    if (
      !isUniqueConstraint(
        error,
        ['runId', 'derivationVersion', 'inputFingerprint'],
        'forensic_derivation_runId_derivationVersion_inputFingerprin_key',
      )
    ) {
      throw error;
    }
    // Identical inputs already recorded — convergence (§68).
  }

  return {
    runId,
    derivationVersion: TIMELINE_DERIVATION_VERSION,
    inputFingerprint: fingerprint,
    findings,
    timelineEntryCount: totalEntries,
    derived: true,
  };
}

/**
 * Loads one Finding with its complete proof (detail API input, §54):
 * evaluation identity, rule identity, subject, reason code, summary,
 * proof references (resolvable to rows), and the input fingerprint.
 */
export async function loadFindingProof(prisma: PrismaClient, findingId: string) {
  const finding = await prisma.finding.findUnique({
    where: { id: findingId },
    include: {
      evaluation: {
        select: {
          id: true,
          runId: true,
          invariantKey: true,
          evaluatorVersion: true,
          subjectKey: true,
          verdict: true,
          reason: true,
          evidenceSetHash: true,
          completenessBasis: true,
          details: true,
          sourceObservationHashes: true,
          normalizedEventIds: true,
          causalRelationshipIds: true,
        },
      },
      evidenceRefs: { orderBy: { position: 'asc' } },
    },
  });
  return finding;
}

export { FINDING_REASON_CODES, PROOF_ROLES, PROOF_SUBJECTS };
export {
  deriveReproductionDefinition,
  extractTargetModeRequirement,
  persistReproductionDefinition,
  ReproductionDefinitionError,
} from './reproduction.js';
export type { DerivedReproductionDefinition, ReproductionDerivationInput } from './reproduction.js';
export { compareRuns, latestEvaluationPerInvariant, RunComparisonError } from './comparison.js';
export type { RunComparisonResult, RunVerdictSummary } from './comparison.js';
