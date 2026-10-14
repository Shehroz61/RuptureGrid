// =====================================================================
// RuptureGrid v1.1 Phase 17 — durable report inputs (report-input.ts)
// =====================================================================
// Loads the report's truth-bearing fields EXCLUSIVELY from durable
// rows (Control / Evidence / Analysis). This module performs NO
// evaluation, NO target HTTP, NO recomputation of verdicts — the
// persisted rows are the only source. Every loader below is read-only
// and deterministic; collections are sorted before returning so the
// emitter's ordering never relies on PostgreSQL implicit row order
// (§38).
//
// CHECKPOINT D: every loader runs INSIDE the Boundary B authorization
// transaction (the caller passes the lock-scoped client), so the
// resolved values are frozen at the authorized linearization point.
// The loaders therefore accept both the standalone client and an
// interactive `$transaction` client. NO current-truth selection lives
// here: evaluations are serialized from pointer-resolved frozen rows
// (ADR-0026 §13 — timestamp/row-order selection is withdrawn in full).
//
// BigInt fencing values are serialized EXACTLY as decimal strings —
// never coerced through JS Number (§39). Money fields remain integer
// minor units end to end.

import type { ReportReadDb } from '@rupturegrid/evidence';
import type { ReportInput, ReportFinding, ReportReproductionReference } from './report.js';

export class ReportInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReportInputError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Loads target identity from the durable registration (sorted origins). */
export async function loadReportTarget(
  prisma: ReportReadDb,
  targetId: string,
): Promise<ReportInput['target']> {
  const row = await prisma.targetRegistration.findUnique({
    where: { id: targetId },
    include: { origins: true },
  });
  if (row === null) {
    throw new ReportInputError(`target ${targetId} is not registered`);
  }
  return {
    targetId: row.id,
    displayName: row.displayName,
    environment: row.environment,
    origins: row.origins.map((origin) => origin.origin).sort(),
  };
}

/** Loads run identity truth (experiment/revision/snapshot/terminal). */
export async function loadReportRun(
  prisma: ReportReadDb,
  runId: string,
): Promise<ReportInput['run'] & { readonly targetId: string }> {
  const row = await prisma.experimentRun.findUnique({
    where: { id: runId },
    include: {
      snapshot: {
        include: {
          revision: {
            include: { definition: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (row === null) {
    throw new ReportInputError(`run ${runId} does not exist`);
  }
  return {
    runId: row.id,
    experimentName: row.snapshot.revision.definition.name,
    experimentDefinitionId: row.snapshot.revision.definition.id,
    revisionId: row.snapshot.revision.id,
    revisionNumber: row.snapshot.revision.revisionNumber,
    snapshotId: row.snapshot.id,
    snapshotContentHash: row.snapshot.contentHash,
    terminalState: row.state,
    engineVersion: isRecord(row.snapshot.content)
      ? String((row.snapshot.content as Record<string, unknown>)['engineVersion'] ?? 'unknown')
      : 'unknown',
    targetId: row.snapshot.revision.targetId,
  };
}

/**
 * Side-effect knowledge summary counts from the durable invocation
 * rows (honest counts; INDETERMINATE first-class — §36).
 */
export async function loadSideEffectSummary(
  prisma: ReportReadDb,
  runId: string,
): Promise<ReportInput['sideEffectSummary']> {
  const grouped = await prisma.stepInvocation.groupBy({
    by: ['sideEffectKnowledge'],
    where: { stepRun: { runId } },
    _count: { _all: true },
  });
  const countOf = (knowledge: string): number =>
    grouped.find((entry) => entry.sideEffectKnowledge === knowledge)?._count._all ?? 0;
  return {
    KNOWN_OCCURRED: countOf('KNOWN_OCCURRED'),
    KNOWN_ABSENT: countOf('KNOWN_ABSENT'),
    INDETERMINATE: countOf('INDETERMINATE'),
    NOT_APPLICABLE: countOf('NOT_APPLICABLE'),
  };
}

/**
 * Loads ALL persisted findings of the run (one-for-one with durable
// Finding rows — the report can neither invent nor omit one, §57).
 */
export async function loadReportFindings(
  prisma: ReportReadDb,
  runId: string,
): Promise<ReportFinding[]> {
  const rows = await prisma.finding.findMany({
    where: { runId },
    include: { evidenceRefs: { orderBy: { position: 'asc' } } },
  });
  return rows
    .map((row) => ({
      findingId: row.id,
      invariantEvaluationId: row.invariantEvaluationId,
      invariantKey: row.invariantKey,
      evaluatorVersion: row.evaluatorVersion,
      findingRuleVersion: row.findingRuleVersion,
      reasonCode: row.reasonCode,
      subjectKey: row.subjectKey,
      title: row.title,
      summary: row.summary,
      proofReferences: row.evidenceRefs.map((reference) => ({
        subject: reference.subject,
        sourceId: reference.sourceId,
        role: reference.role,
        position: reference.position,
      })),
      provenScope: (row.provenScope ?? {}) as Record<string, unknown>,
      uncertainScope: (row.uncertainScope ?? {}) as Record<string, unknown>,
      details: (row.details ?? {}) as Record<string, unknown>,
    }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
}

/** Loads the run's durable reproduction definition (reference only). */
export async function loadReportReproduction(
  prisma: ReportReadDb,
  runId: string,
): Promise<ReportReproductionReference | null> {
  const row = await prisma.reproductionDefinition.findUnique({ where: { runId } });
  if (row === null) {
    return null;
  }
  return {
    reproductionDefinitionId: row.id,
    snapshotId: row.snapshotId,
    snapshotContentHash: row.snapshotContentHash,
    targetModeRequirement: row.targetModeRequirement,
    credentialRefs: [...row.credentialRefs].sort(),
    invariantBindings: (row.invariantBindings ?? {}) as Record<string, unknown>,
    acceptanceExpectations: (row.acceptanceExpectations ?? {}) as Record<string, unknown>,
  };
}

/**
 * The distinct normalizer identities that actually produced evidence
 * rows for THIS run (durable normalized_event rows — §36). Read-only;
 * never a compiled-in constant: an empty run honestly yields an empty
 * list.
 */
export async function loadNormalizerVersions(
  prisma: ReportReadDb,
  runId: string,
): Promise<ReadonlyArray<{ name: string; version: string }>> {
  const rows = await prisma.normalizedEvent.findMany({
    where: { runId },
    select: { normalizerName: true, normalizerVersion: true },
    distinct: ['normalizerName', 'normalizerVersion'],
  });
  return rows
    .map((row) => ({ name: row.normalizerName, version: row.normalizerVersion }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The distinct (invariantKey, evaluatorVersion) pairs persisted for
 * the run's bound invariants — report truth-sourcing metadata (§36).
 */
export async function loadInvariantEvaluatorVersions(
  prisma: ReportReadDb,
  runId: string,
  boundInvariantKeys: readonly string[],
): Promise<ReadonlyArray<{ invariantKey: string; evaluatorVersion: string }>> {
  const rows = await prisma.invariantEvaluation.findMany({
    where: { runId, invariantKey: { in: [...new Set(boundInvariantKeys)] } },
    select: { invariantKey: true, evaluatorVersion: true },
    distinct: ['invariantKey', 'evaluatorVersion'],
  });
  return rows
    .map((row) => ({ invariantKey: row.invariantKey, evaluatorVersion: row.evaluatorVersion }))
    .sort(
      (a, b) =>
        a.invariantKey.localeCompare(b.invariantKey) ||
        a.evaluatorVersion.localeCompare(b.evaluatorVersion),
    );
}
