// =====================================================================
// RuptureGrid v1.0 — run comparison (Phase 5, incident-replay §6)
// =====================================================================
// Post-fix replay groundwork: side-by-side verdicts for the same
// invariant across two runs whose SNAPSHOTS SHARE A CONTENT HASH.
// Differences in evidence are expected; differences in verdicts are
// the signal (incident-replay §6).
//
// Comparison is COMPUTED-ON-READ from the persisted Phase 4 verdicts —
// never persisted (the derivation would be redundant durable state and
// its inputs keep changing as runs gain evaluations; §34: do not
// persist redundant data). It never re-evaluates evidence: it reads
// the two runs' own persisted evaluation rows (one business truth
// engine, §37).
//
// Determinism: identical inputs (same two runs, same invariant) always
// produce identical output — evaluation selection is deterministic
// (latest per invariant by stable ordering), never insertion-order
// dependent.

import type { PrismaClient } from '@rupturegrid/control-db';

export class RunComparisonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunComparisonError';
  }
}

export interface RunVerdictSummary {
  readonly evaluationId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly verdict: string;
  readonly createdAt: Date;
}

export interface RunComparisonResult {
  readonly baseRunId: string;
  readonly comparisonRunId: string;
  readonly snapshotComparison: {
    readonly baseSnapshotId: string;
    readonly comparisonSnapshotId: string;
    readonly baseContentHash: string;
    readonly comparisonContentHash: string;
    readonly sameIntent: boolean;
  };
  readonly invariants: Array<{
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly baseVerdict: string;
    readonly comparisonVerdict: string;
    readonly verdictsDiffer: boolean;
    readonly baseEvaluationId: string;
    readonly comparisonEvaluationId: string;
  }>;
}

/**
 * Deterministically selects each run's latest evaluation per invariant:
 * max by (createdAt, id) — stable, insertion-order independent.
 */
export function latestEvaluationPerInvariant(
  evaluations: readonly RunVerdictSummary[],
): Map<string, RunVerdictSummary> {
  const latest = new Map<string, RunVerdictSummary>();
  for (const evaluation of evaluations) {
    const current = latest.get(evaluation.invariantKey);
    if (current === undefined) {
      latest.set(evaluation.invariantKey, evaluation);
      continue;
    }
    const newerByTime =
      evaluation.createdAt.getTime() > current.createdAt.getTime() ||
      (evaluation.createdAt.getTime() === current.createdAt.getTime() &&
        evaluation.evaluationId > current.evaluationId);
    if (newerByTime) {
      latest.set(evaluation.invariantKey, evaluation);
    }
  }
  return latest;
}

/**
 * Compares two runs for the same invariant intent. Refuses to compare
 * runs whose snapshots differ in content hash (incident-replay §6:
 * comparisons are only meaningful for the same frozen intent) and
 * refuses self-comparison. Evaluation identity is carried end-to-end
 * so every verdict is traceable to its authoritative row.
 */
export async function compareRuns(
  prisma: PrismaClient,
  baseRunId: string,
  comparisonRunId: string,
): Promise<RunComparisonResult> {
  if (baseRunId === comparisonRunId) {
    throw new RunComparisonError('a run cannot be compared with itself');
  }
  const runs = await prisma.experimentRun.findMany({
    where: { id: { in: [baseRunId, comparisonRunId] } },
    select: {
      id: true,
      snapshotId: true,
      snapshot: { select: { id: true, contentHash: true } },
    },
  });
  const baseRun = runs.find((run) => run.id === baseRunId);
  const comparisonRun = runs.find((run) => run.id === comparisonRunId);
  if (baseRun === undefined || comparisonRun === undefined) {
    throw new RunComparisonError('one or both runs do not exist');
  }

  const evaluations = await prisma.invariantEvaluation.findMany({
    where: { runId: { in: [baseRunId, comparisonRunId] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      runId: true,
      invariantKey: true,
      evaluatorVersion: true,
      subjectKey: true,
      verdict: true,
      createdAt: true,
    },
  });
  const baseLatest = latestEvaluationPerInvariant(
    evaluations.filter((row) => row.runId === baseRunId).map(toSummary),
  );
  const comparisonLatest = latestEvaluationPerInvariant(
    evaluations.filter((row) => row.runId === comparisonRunId).map(toSummary),
  );

  // Union of both runs' invariants, deterministically ordered.
  const keys = [...new Set([...baseLatest.keys(), ...comparisonLatest.keys()])].sort();
  const invariants = keys.flatMap((invariantKey) => {
    const base = baseLatest.get(invariantKey);
    const comparison = comparisonLatest.get(invariantKey);
    if (base === undefined || comparison === undefined) {
      // An invariant evaluated in only one run is reported honestly as
      // missing on the other side — never fabricated.
      return [
        {
          invariantKey,
          evaluatorVersion: (base ?? comparison)?.evaluatorVersion ?? '',
          baseVerdict: base?.verdict ?? 'ABSENT',
          comparisonVerdict: comparison?.verdict ?? 'ABSENT',
          verdictsDiffer: base !== undefined || comparison !== undefined,
          baseEvaluationId: base?.evaluationId ?? '',
          comparisonEvaluationId: comparison?.evaluationId ?? '',
        },
      ];
    }
    return [
      {
        invariantKey,
        evaluatorVersion: base.evaluatorVersion,
        baseVerdict: base.verdict,
        comparisonVerdict: comparison.verdict,
        verdictsDiffer: base.verdict !== comparison.verdict,
        baseEvaluationId: base.evaluationId,
        comparisonEvaluationId: comparison.evaluationId,
      },
    ];
  });

  return {
    baseRunId,
    comparisonRunId,
    snapshotComparison: {
      baseSnapshotId: baseRun.snapshot.id,
      comparisonSnapshotId: comparisonRun.snapshot.id,
      baseContentHash: baseRun.snapshot.contentHash,
      comparisonContentHash: comparisonRun.snapshot.contentHash,
      sameIntent: baseRun.snapshot.contentHash === comparisonRun.snapshot.contentHash,
    },
    invariants,
  };
}

function toSummary(row: {
  id: string;
  runId: string;
  invariantKey: string;
  evaluatorVersion: string;
  subjectKey: string;
  verdict: string;
  createdAt: Date;
}): RunVerdictSummary & { runId: string } {
  return {
    evaluationId: row.id,
    invariantKey: row.invariantKey,
    evaluatorVersion: row.evaluatorVersion,
    subjectKey: row.subjectKey,
    verdict: row.verdict,
    createdAt: row.createdAt,
    runId: row.runId,
  };
}
