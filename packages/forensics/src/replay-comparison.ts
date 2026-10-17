// =====================================================================
// RuptureGrid v1.1 Phase 18 — replay comparison (ADR-0019 Decision 4;
// incident-replay §6; ADR-0026 §13)
// =====================================================================
// Compares an original run with its same-snapshot replay run —
// COMPUTED ON READ from durable rows, never persisted (the Phase 5
// comparison discipline: persisting it would duplicate durable state
// whose inputs keep changing).
//
// Compared (all durable truth, nothing invented):
//   - snapshot hash + target/experiment identity (frozen snapshot blocks)
//   - invariant keys + evaluator versions (the bound domain)
//   - per-(invariantKey, subjectKey) verdicts from the PERSISTED
//     CURRENT-EVALUATION POINTERS (ADR-0026 §13 — never timestamp/UUID
//     ordering, never a per-key Map collapse: subjects stay distinct
//     end to end)
//   - effect counts read from the persisted evaluation details where
//     the evaluator recorded them (`attributableEffectCount` for
//     atMostOneAcceptedEffect, `acceptedReservedUnits` for
//     resourceConservation) — null when the evaluator recorded none,
//     never guessed
//   - findings (reason code, subject, evaluation linkage) + counts
//   - evidence references verified by the accepted chain verifier, then
//     authorized at each side's coherent C/P/D watermark by Boundary B
//   - execution uncertainty (side-effect knowledge summary incl. honest
//     INDETERMINATE counts; NOT_EVALUABLE reasons) + provenance
//     (analysis generation, eligibility versions, certified watermarks,
//     reproduction references)
//
// Refusals (fail closed, RunComparisonError):
//   - self-comparison; missing run; different snapshot content hashes;
//     unverified/stale/ineligible publication; foreign pointer targets;
//     incompatible authoritative evaluator/eligibility versions
//     (cross-intent comparisons are not meaningful — incident-replay
//     §6; the API already refuses them, this surface refuses too).
//
// Scheduling honesty (incident-replay §4–§5): runs are compared by
// durable verdicts and counts only. Exact thread interleavings are not
// guaranteed to repeat; the comparison fabricates no causal link
// between timing and verdicts and carries a fixed scheduling note to
// that effect. A same-hash verdict difference is a signal to investigate:
// target remediation can change real effects. The comparison alone does
// not establish a cause and never substitutes mode labels for evidence.
//
// A side without an authorized publication is refused. A published empty
// domain remains explicitly empty; there is no timestamp-ordered fallback.

import type { PrismaClient } from '@rupturegrid/control-db';
import { canonicalizeAndHash, frozenInvariantKeys } from '@rupturegrid/engine';
import type { RunSnapshotDocument } from '@rupturegrid/engine';
import { authorizeReportFinalization, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import type { AuthorizedReportState, SerializedTruthInputWatermark } from '@rupturegrid/evidence';
import { RunComparisonError } from './comparison.js';

/** Fixed scheduling-honesty note carried by every comparison. */
export const REPLAY_SCHEDULING_NOTE =
  'Scheduling variance is expected: wall-clock timing and exact thread interleavings are real per execution and are not guaranteed to repeat (incident-replay §4–§5). Same-hash verdict differences can reflect target remediation; this comparison reports durable verdicts and counts without establishing the cause of a difference.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ReplaySubjectComparison {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly baseVerdict: string;
  readonly replayVerdict: string;
  readonly verdictsDiffer: boolean;
  readonly baseEvaluationId: string;
  readonly replayEvaluationId: string;
  readonly baseEvidenceSetHash: string;
  readonly replayEvidenceSetHash: string;
  /** Null when the evaluator recorded no effect count for the subject. */
  readonly baseEffectCount: number | null;
  readonly replayEffectCount: number | null;
}

export interface ReplaySideSummary {
  readonly runId: string;
  readonly certifiedAsOf: SerializedTruthInputWatermark;
  readonly reproductionDefinitionId: string | null;
  readonly findingCount: number;
  readonly findings: ReadonlyArray<{
    readonly findingId: string;
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly reasonCode: string;
    readonly invariantEvaluationId: string;
  }>;
  readonly evidenceHeadHash: string | null;
  readonly observationCount: number | null;
  readonly sideEffectSummary: {
    readonly KNOWN_OCCURRED: number;
    readonly KNOWN_ABSENT: number;
    readonly INDETERMINATE: number;
    readonly NOT_APPLICABLE: number;
  };
  readonly notEvaluableReasons: readonly string[];
  readonly analysisGenerations: readonly string[];
  readonly eligibilityVersions: readonly string[];
  /** True when the run published no current-evaluation pointers. */
  readonly currentTruthAbsent: boolean;
}

export interface ReplayKeyComparison {
  readonly invariantKey: string;
  readonly baseEvaluatorVersion: string;
  readonly replayEvaluatorVersion: string;
  readonly evaluatorVersionsDiffer: boolean;
  /** Sorted distinct verdicts per side (subjects stay distinct below). */
  readonly baseVerdicts: readonly string[];
  readonly replayVerdicts: readonly string[];
  readonly baseSubjects: readonly string[];
  readonly replaySubjects: readonly string[];
  /**
   * True when both sides carry ≥ 1 current verdict and the verdict
   * SETS agree. Subjects may legitimately differ across runs (e.g.
   * per-run generated payment identities): agreement is about the
   * verdict domain per key, never about subject-identity equality.
   * A same-hash disagreement is the signal (incident-replay §6).
   */
  readonly agree: boolean;
}

export interface ReplayComparisonResult {
  readonly baseRunId: string;
  readonly replayRunId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly target: {
    readonly targetId: string;
    readonly displayName: string;
    readonly origin: string;
    readonly environment: string;
  };
  readonly experiment: {
    readonly definitionName: string;
    readonly revisionNumber: number;
  };
  readonly invariantKeys: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly registryVersion: string;
  }>;
  /** Per-key verdict-domain agreement (stable across subject rotation). */
  readonly keys: readonly ReplayKeyComparison[];
  /**
   * Observed but UNBOUND keys (evaluated without a frozen binding —
   * e.g. legacy rows on a generic run): disclosed, never silently
   * omitted, never part of the comparison domain (the report's
   * unboundCurrentEvaluations discipline). Empty for legacy-compat
   * snapshots, whose as-observed domain IS the comparison domain.
   */
  readonly unboundKeys: readonly ReplayKeyComparison[];
  readonly subjects: readonly ReplaySubjectComparison[];
  readonly base: ReplaySideSummary;
  readonly replay: ReplaySideSummary;
  readonly schedulingNote: typeof REPLAY_SCHEDULING_NOTE;
}

/** Reads one numeric effect count from persisted evaluation details. */
export function replayEffectCountOf(invariantKey: string, details: unknown): number | null {
  if (!isRecord(details)) {
    return null;
  }
  const attributable = details['attributableEffectCount'];
  if (typeof attributable === 'number' && Number.isSafeInteger(attributable) && attributable >= 0) {
    return attributable;
  }
  // The generic PASS branch records its complete attributed count as
  // observedCount (the FAIL branch uses attributableEffectCount).
  const observed = details['observedCount'];
  const identities = details['countedEffectIdentities'];
  if (
    details['kind'] === 'atMostOneAcceptedEffect' &&
    typeof observed === 'number' &&
    Number.isSafeInteger(observed) &&
    observed >= 0 &&
    details['observedTotal'] === observed &&
    Array.isArray(identities) &&
    identities.length === observed
  ) {
    return observed;
  }
  const reserved = details['acceptedReservedUnits'];
  if (typeof reserved === 'number' && Number.isSafeInteger(reserved) && reserved >= 0) {
    return reserved;
  }
  const equivalent = details['equivalentEffectCount'];
  if (
    invariantKey === 'INV-IZ-1' &&
    typeof equivalent === 'number' &&
    Number.isSafeInteger(equivalent) &&
    equivalent >= 0
  ) {
    return equivalent;
  }
  return null;
}

interface PointerEvaluation {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly evaluationId: string;
  readonly verdict: string;
  readonly reason: string;
  readonly evidenceSetHash: string;
  readonly effectCount: number | null;
}

/** A read-only comparison uses the SAME verified-prefix/Boundary B authority
 * as reports. It never repairs or re-analyzes stale input to hide a refusal. */
async function authorizeSide(prisma: PrismaClient, runId: string, document: RunSnapshotDocument) {
  const integrity = await verifyRunEvidenceChain(prisma, runId, { recordResult: false });
  if (!integrity.chainValid || !integrity.contentHashesValid) {
    throw new RunComparisonError(`run ${runId}: evidence integrity verification failed`);
  }
  const authorization = await authorizeReportFinalization(prisma, runId, {
    boundInvariantKeys: frozenInvariantKeys(document),
    integrityVerified: true,
    verifiedChain: {
      headContentHash: integrity.headContentHash,
      observationCount: integrity.observationCount,
      lastChainIndex: integrity.observationCount === 0 ? null : integrity.observationCount - 1,
    },
    loadFrozenInputs: async (db) => {
      // Explicit pointer-target identity check at this consumer's boundary.
      // A FK alone does not bind the row's run/key/subject/evidence identity.
      const pointers = await db.currentEvaluationPointer.findMany({
        where: { runId },
        include: { currentEvaluation: true },
      });
      const proofs = await db.runEligibilityProof.findMany({ where: { runId } });
      for (const pointer of pointers) {
        const row = pointer.currentEvaluation;
        const proof = proofs.find(
          (entry) =>
            entry.invariantKey === pointer.invariantKey &&
            entry.evaluatorVersion === pointer.evaluatorVersion,
        );
        if (
          row.runId !== runId ||
          row.invariantKey !== pointer.invariantKey ||
          row.subjectKey !== pointer.subjectKey ||
          row.evaluatorVersion !== pointer.evaluatorVersion ||
          row.evidenceSetHash !== pointer.evidenceHeadHash ||
          (proof !== undefined && proof.eligibilityVersion !== pointer.eligibilityVersion)
        ) {
          throw new RunComparisonError('foreign or superseded evaluation pointer identity');
        }
        const binding = document.target.invariantBindings?.find(
          (entry) => entry.key === row.invariantKey,
        );
        const details = isRecord(row.details) ? row.details : {};
        if (
          binding !== undefined &&
          (details['registryVersion'] !== binding.registryVersion ||
            details['kind'] !== binding.kind ||
            details['evaluatorVersion'] !== row.evaluatorVersion ||
            (proof?.mode === 'strict-coverage/v1' &&
              details['eligibilityVersion'] !== proof.eligibilityVersion))
        ) {
          throw new RunComparisonError(
            'evaluation does not match its frozen invariant binding/version',
          );
        }
      }
      // Sequential reads on Boundary B's single connection; freeze all side
      // metadata here instead of mixing live rows after authorization.
      const findings = await db.finding.findMany({ where: { runId }, orderBy: { id: 'asc' } });
      const grouped = await db.stepInvocation.groupBy({
        by: ['sideEffectKnowledge'],
        where: { stepRun: { runId } },
        _count: { _all: true },
      });
      const reproduction = await db.reproductionDefinition.findUnique({
        where: { runId },
        select: { id: true },
      });
      return { findings, grouped, reproduction };
    },
  });
  if (
    !authorization.authorized ||
    !authorization.state?.certified ||
    authorization.external === null
  ) {
    throw new RunComparisonError(`run ${runId}: comparison refused: ${authorization.reason}`);
  }
  // One generation is not enough: two versions of the SAME key at that
  // generation cannot both be its authoritative meaning. Never let a
  // first-row choice or a subject map conceal the other version.
  const authoritativeKeys = new Set<string>();
  for (const proof of authorization.state.keys) {
    if (authoritativeKeys.has(proof.invariantKey)) {
      throw new RunComparisonError(
        `ambiguous authoritative evaluator versions for ${proof.invariantKey}`,
      );
    }
    authoritativeKeys.add(proof.invariantKey);
  }
  return { state: authorization.state, external: authorization.external };
}

/**
 * Compares two runs of the SAME frozen intent (identical snapshot
 * content hash). Refuses cross-intent comparisons. Computed on read;
 * persists nothing.
 */
export async function compareReplayRuns(
  prisma: PrismaClient,
  baseRunId: string,
  replayRunId: string,
): Promise<ReplayComparisonResult> {
  if (baseRunId === replayRunId) {
    throw new RunComparisonError('a run cannot be compared with itself');
  }
  const runs = await prisma.experimentRun.findMany({
    where: { id: { in: [baseRunId, replayRunId] } },
    select: {
      id: true,
      snapshotId: true,
      snapshot: { select: { contentHash: true, content: true } },
    },
  });
  const baseRun = runs.find((run) => run.id === baseRunId);
  const replayRun = runs.find((run) => run.id === replayRunId);
  if (baseRun === undefined || replayRun === undefined) {
    throw new RunComparisonError('one or both runs do not exist');
  }
  if (baseRun.snapshot.contentHash !== replayRun.snapshot.contentHash) {
    throw new RunComparisonError(
      `runs have different snapshot content hashes (${baseRun.snapshot.contentHash.slice(0, 12)}… vs ${replayRun.snapshot.contentHash.slice(0, 12)}…) — cross-intent comparison is refused (incident-replay §6)`,
    );
  }
  for (const run of [baseRun, replayRun]) {
    if (canonicalizeAndHash(run.snapshot.content).hash !== run.snapshot.contentHash) {
      throw new RunComparisonError('snapshot canonical content does not match its stored hash');
    }
  }
  const content = baseRun.snapshot.content as unknown as Record<string, unknown>;
  const frozenTarget = (
    isRecord(content) && isRecord(content['target']) ? content['target'] : {}
  ) as Record<string, unknown>;
  const frozenExperiment = (
    isRecord(content) && isRecord(content['experiment']) ? content['experiment'] : {}
  ) as Record<string, unknown>;
  const frozenBindings = Array.isArray(frozenTarget['invariantBindings'])
    ? (frozenTarget['invariantBindings'] as unknown[])
    : [];
  const invariantKeys = frozenBindings
    .filter(
      (binding): binding is Record<string, unknown> =>
        isRecord(binding) && typeof binding['key'] === 'string',
    )
    .map((binding) => ({
      key: binding['key'] as string,
      kind: typeof binding['kind'] === 'string' ? (binding['kind'] as string) : 'unknown',
      registryVersion:
        typeof binding['registryVersion'] === 'string'
          ? (binding['registryVersion'] as string)
          : 'unknown',
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const baseSide = await authorizeSide(
    prisma,
    baseRunId,
    baseRun.snapshot.content as unknown as RunSnapshotDocument,
  );
  const replaySide = await authorizeSide(
    prisma,
    replayRunId,
    replayRun.snapshot.content as unknown as RunSnapshotDocument,
  );
  for (const baseProof of baseSide.state.keys) {
    const replayProof = replaySide.state.keys.find(
      (proof) => proof.invariantKey === baseProof.invariantKey,
    );
    if (
      replayProof !== undefined &&
      (baseProof.evaluatorVersion !== replayProof.evaluatorVersion ||
        baseProof.eligibilityVersion !== replayProof.eligibilityVersion ||
        baseProof.mode !== replayProof.mode)
    ) {
      throw new RunComparisonError(
        `incompatible evaluator/eligibility versions for ${baseProof.invariantKey}`,
      );
    }
  }
  const evaluationsOf = (state: AuthorizedReportState): PointerEvaluation[] =>
    state.evaluations.map((row) => ({
      ...row,
      effectCount: replayEffectCountOf(row.invariantKey, row.details),
    }));
  const baseEvaluations = evaluationsOf(baseSide.state);
  const replayEvaluations = evaluationsOf(replaySide.state);

  const replayBySubject = new Map(
    replayEvaluations.map((evaluation) => [
      JSON.stringify([evaluation.invariantKey, evaluation.subjectKey]),
      evaluation,
    ]),
  );
  const seen = new Set<string>();
  const subjects: ReplaySubjectComparison[] = [];
  for (const base of [...baseEvaluations, ...replayEvaluations].sort(
    (a, b) =>
      a.invariantKey.localeCompare(b.invariantKey) || a.subjectKey.localeCompare(b.subjectKey),
  )) {
    const key = JSON.stringify([base.invariantKey, base.subjectKey]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const baseSide = baseEvaluations.find(
      (evaluation) =>
        evaluation.invariantKey === base.invariantKey && evaluation.subjectKey === base.subjectKey,
    );
    const replaySide = replayBySubject.get(key);
    subjects.push({
      invariantKey: base.invariantKey,
      evaluatorVersion: (baseSide ?? replaySide)?.evaluatorVersion ?? '',
      subjectKey: base.subjectKey,
      baseVerdict: baseSide?.verdict ?? 'ABSENT',
      replayVerdict: replaySide?.verdict ?? 'ABSENT',
      verdictsDiffer: (baseSide?.verdict ?? 'ABSENT') !== (replaySide?.verdict ?? 'ABSENT'),
      baseEvaluationId: baseSide?.evaluationId ?? '',
      replayEvaluationId: replaySide?.evaluationId ?? '',
      baseEvidenceSetHash: baseSide?.evidenceSetHash ?? '',
      replayEvidenceSetHash: replaySide?.evidenceSetHash ?? '',
      baseEffectCount: baseSide?.effectCount ?? null,
      replayEffectCount: replaySide?.effectCount ?? null,
    });
  }

  // ---- Per-key verdict-domain agreement (stable across subject
  // rotation: generated per-run identities such as fintech payment ids
  // never match across runs, so agreement is about verdict SETS per
  // key, never about subject-identity equality). The comparison domain
  // mirrors the exit contract: explicit generic bindings or the known
  // legacy engine/contract's built-in domain. Unbound rows are disclosed
  // separately. Subject identities are never paired by their positions.
  const frozenBoundKeys = new Set(
    frozenInvariantKeys(baseRun.snapshot.content as unknown as RunSnapshotDocument),
  );
  const keySet = new Set([
    ...baseEvaluations.map((evaluation) => evaluation.invariantKey),
    ...replayEvaluations.map((evaluation) => evaluation.invariantKey),
  ]);
  const compareKey = (invariantKey: string): ReplayKeyComparison => {
    const baseForKey = baseEvaluations.filter(
      (evaluation) => evaluation.invariantKey === invariantKey,
    );
    const replayForKey = replayEvaluations.filter(
      (evaluation) => evaluation.invariantKey === invariantKey,
    );
    const baseVerdicts = [...new Set(baseForKey.map((evaluation) => evaluation.verdict))].sort();
    const replayVerdicts = [
      ...new Set(replayForKey.map((evaluation) => evaluation.verdict)),
    ].sort();
    const baseEvaluatorVersion = baseForKey[0]?.evaluatorVersion ?? '';
    const replayEvaluatorVersion = replayForKey[0]?.evaluatorVersion ?? '';
    return {
      invariantKey,
      baseEvaluatorVersion,
      replayEvaluatorVersion,
      evaluatorVersionsDiffer: baseEvaluatorVersion !== replayEvaluatorVersion,
      baseVerdicts,
      replayVerdicts,
      baseSubjects: [...new Set(baseForKey.map((evaluation) => evaluation.subjectKey))].sort(),
      replaySubjects: [...new Set(replayForKey.map((evaluation) => evaluation.subjectKey))].sort(),
      agree:
        baseVerdicts.length > 0 &&
        replayVerdicts.length > 0 &&
        baseVerdicts.length === replayVerdicts.length &&
        baseVerdicts.every((verdict, index) => verdict === replayVerdicts[index]),
    };
  };
  const observedKeys = [...keySet].sort().map(compareKey);
  const keys =
    frozenBoundKeys.size === 0
      ? observedKeys
      : observedKeys.filter((key) => frozenBoundKeys.has(key.invariantKey));
  const unboundKeys =
    frozenBoundKeys.size === 0
      ? []
      : observedKeys.filter((key) => !frozenBoundKeys.has(key.invariantKey));

  const summarize = async (
    runId: string,
    evaluations: PointerEvaluation[],
    side: Awaited<ReturnType<typeof authorizeSide>>,
  ): Promise<ReplaySideSummary> => {
    const { findings, grouped, reproduction } = side.external;
    const proofs = side.state.keys;
    const countOf = (knowledge: string): number =>
      grouped.find((entry) => entry.sideEffectKnowledge === knowledge)?._count._all ?? 0;
    return {
      runId,
      certifiedAsOf: side.state.watermark,
      reproductionDefinitionId: reproduction?.id ?? null,
      findingCount: findings.length,
      findings: findings.map((finding) => ({
        findingId: finding.id,
        invariantKey: finding.invariantKey,
        subjectKey: finding.subjectKey,
        reasonCode: finding.reasonCode,
        invariantEvaluationId: finding.invariantEvaluationId,
      })),
      evidenceHeadHash: side.state.watermark.chain.headContentHash,
      observationCount: side.state.watermark.chain.observationCount,
      sideEffectSummary: {
        KNOWN_OCCURRED: countOf('KNOWN_OCCURRED'),
        KNOWN_ABSENT: countOf('KNOWN_ABSENT'),
        INDETERMINATE: countOf('INDETERMINATE'),
        NOT_APPLICABLE: countOf('NOT_APPLICABLE'),
      },
      notEvaluableReasons: evaluations
        .filter((evaluation) => evaluation.verdict === 'NOT_EVALUABLE')
        .map(
          (evaluation) =>
            `${evaluation.invariantKey}/${evaluation.subjectKey}: ${evaluation.reason}`,
        )
        .sort(),
      analysisGenerations: [
        ...new Set(proofs.map((proof) => proof.analysisGeneration.toString())),
      ].sort(),
      eligibilityVersions: [...new Set(proofs.map((proof) => proof.eligibilityVersion))].sort(),
      currentTruthAbsent: evaluations.length === 0,
    };
  };

  return {
    baseRunId,
    replayRunId,
    snapshotId: baseRun.snapshotId,
    snapshotContentHash: baseRun.snapshot.contentHash,
    target: {
      targetId:
        typeof frozenTarget['targetId'] === 'string' ? (frozenTarget['targetId'] as string) : '',
      displayName:
        typeof frozenTarget['displayName'] === 'string'
          ? (frozenTarget['displayName'] as string)
          : '',
      origin: typeof frozenTarget['origin'] === 'string' ? (frozenTarget['origin'] as string) : '',
      environment:
        typeof frozenTarget['environment'] === 'string'
          ? (frozenTarget['environment'] as string)
          : '',
    },
    experiment: {
      definitionName:
        typeof frozenExperiment['definitionName'] === 'string'
          ? (frozenExperiment['definitionName'] as string)
          : '',
      revisionNumber:
        typeof frozenExperiment['revisionNumber'] === 'number'
          ? (frozenExperiment['revisionNumber'] as number)
          : 0,
    },
    invariantKeys,
    keys,
    unboundKeys,
    subjects,
    base: await summarize(baseRunId, baseEvaluations, baseSide),
    replay: await summarize(replayRunId, replayEvaluations, replaySide),
    schedulingNote: REPLAY_SCHEDULING_NOTE,
  };
}
