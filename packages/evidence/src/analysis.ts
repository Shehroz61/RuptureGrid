// =====================================================================
// RuptureGrid v1.0 — analysis orchestration (Phase 4, §18–§21)
// =====================================================================
// One deterministic pipeline pass per (run, invariant):
//   1. derive: raw observations → normalized events → relationships
//      (idempotent; evidence-model §1/§6)
//   2. evaluate: INV-IZ-1 over the evidence graph (pure, §7)
//   3. persist: evaluation rows are idempotent by evidence-set hash —
//      repeat processing with UNCHANGED evidence returns the SAME
//      rows (no duplicates); NEW evidence produces NEW rows on the
//      SAME batch (history never rewritten); concurrent passes
//      converge via the unique key + P2002 tolerance.
//
// The evaluation input is the canonical evidence-set fingerprint
// (every observation hash + event input hash + relationship id):
// same evidence state ⇒ same fingerprint ⇒ same verdict persisted once.
//
// CHECKPOINT C — BOUNDARY A (ADR-0026 §13). The pass is now a two-stage
// capture with a bounded re-analysis policy:
//
//   stage 1 — before ANY business-evidence read, capture `(C1, P1)`
//             under the per-run lock;
//   derive  — run the canonical derivation (each committed derived row
//             advances `D` under the same lock);
//   stage 2 — under the lock, re-capture `W0 = (C0, P0, D0)`. If
//             `C0 ≠ C1` or `P0 ≠ P1` the pass's own derivation raced a
//             newer truth-input state: the pass restarts with a FRESH
//             stage-1 capture (bounded; never reinterpreted);
//   analyze — every evaluation-facing read (subject eligibility, anchor,
//             evaluator inputs, coverage proofs) happens AFTER stage 2;
//   publish — the proof rows + current-evaluation pointers are written in
//             ONE transaction that takes the same per-run lock, requires
//             `Wcurrent == W0` in EVERY component (chain + provenance +
//             derivation generation) and the authoritative derivation
//             readiness, then commits one shared `analysisGeneration`.
//
// A publication mismatch writes NOTHING; the pass consumes one unit of the
// frozen bound and re-analyzes over a fresh capture. Bound exhaustion fails
// closed (the stored selection is never advanced to stale results).

import { randomUUID } from 'node:crypto';
import type { PrismaClient, InvariantVerdict } from '@rupturegrid/control-db';
import { RUN_SCOPE_ELIGIBILITY_VERSION } from '@rupturegrid/engine';
import { deriveRunEvidence, loadFrozenEvidencePolicy } from './derive.js';
import { computeEvidenceSetFingerprint } from './derive.js';
import { evaluateInvDf1, evaluateInvDf2, evaluateInvIz1 } from './invariants.js';
import type { InvariantEvidenceGraph } from './invariants.js';
import {
  GENERIC_ANALYSIS_MODE_LEGACY,
  runGenericInvariantAnalysis,
} from './generic-invariant-analysis.js';
import type {
  GenericAnalysisResult,
  GenericKeyAnalysisResult,
} from './generic-invariant-analysis.js';
import { captureStage1Source, captureStage2Watermark } from './derivation-attempts.js';
import type { TruthInputWatermark } from './derivation-attempts.js';
import { publishAnalysisGeneration } from './analysis-publication.js';
import type { PublicationKey } from './analysis-publication.js';
import {
  INV_IZ_1_DESCRIPTION,
  INV_IZ_1_KEY,
  INV_IZ_1_TITLE,
  INV_IZ_1_EVALUATOR_VERSION,
  INV_DF_1_DESCRIPTION,
  INV_DF_1_KEY,
  INV_DF_1_TITLE,
  INV_DF_1_EVALUATOR_VERSION,
  INV_DF_2_DESCRIPTION,
  INV_DF_2_KEY,
  INV_DF_2_TITLE,
  INV_DF_2_EVALUATOR_VERSION,
} from './versions.js';

export class AnalysisError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** Creates absent definitions atomically; concurrent first-use callers converge. */
export async function ensureInvariantDefinitions(prisma: PrismaClient): Promise<void> {
  // PostgreSQL INSERT ... ON CONFLICT DO NOTHING arbitrates uniqueness in
  // the database. A client-side upsert with an empty update can race between
  // its absent-row read and insert when worker and foreground analysis start.
  // Existing definitions retain their exact identity and content.
  await prisma.invariantDefinition.createMany({
    skipDuplicates: true,
    data: [
      {
        invariantKey: INV_IZ_1_KEY,
        title: INV_IZ_1_TITLE,
        description: INV_IZ_1_DESCRIPTION,
      },
      {
        invariantKey: INV_DF_1_KEY,
        title: INV_DF_1_TITLE,
        description: INV_DF_1_DESCRIPTION,
      },
      {
        invariantKey: INV_DF_2_KEY,
        title: INV_DF_2_TITLE,
        description: INV_DF_2_DESCRIPTION,
      },
    ],
  });
}

export interface PersistedEvaluation {
  readonly id: string;
  readonly invariantKey: string;
  readonly subjectKey: string;
  readonly verdict: InvariantVerdict;
  readonly reason: string;
  readonly evidenceSetHash: string;
  readonly evaluatorVersion: string;
  readonly createdAt: Date;
}

export interface AnalysisRunResult {
  readonly batchId: string;
  readonly evaluatorVersion: string;
  readonly evidenceSetFingerprint: string;
  readonly evaluations: PersistedEvaluation[];
  readonly derivedEventCount: number;
  readonly derivedRelationshipCount: number;
  /**
   * Phase 15 (additive): count of persisted generic business-invariant/
   * v1 evaluations in this pass (0 for legacy runs).
   */
  readonly genericEvaluatedCount: number;
  /** Phase 15: the generic invariant keys evaluated (frozen bindings). */
  readonly genericInvariantKeys: readonly string[];
  /** Checkpoint C: the authoritative publication outcome (never a verdict). */
  readonly publication: AnalysisPublicationSummary;
}

/**
 * The frozen bounded re-analysis constant (ADR-0026 §13): a single-digit
 * number of COMPLETE cycles, each beginning with a fresh capture.
 */
export const RUN_ANALYSIS_MAX_CYCLES = 3;

export type AnalysisPublicationState =
  'PUBLISHED' | 'NOT_APPLICABLE' | 'BOUND_EXHAUSTED' | 'ANALYSIS_INFRASTRUCTURE_STALE';

export interface AnalysisPublicationSummary {
  readonly published: boolean;
  readonly state: AnalysisPublicationState;
  /** The shared generation every current proof/pointer now carries. */
  readonly analysisGeneration: string | null;
  /** Complete analysis cycles this pass consumed (≥ 1). */
  readonly cycles: number;
  /** Machine-readable reason (bounded; never a business claim). */
  readonly reason: string;
}

/**
 * Runs the full deterministic analysis for one run: derivation,
 * evaluation, idempotent persistence. Throws AnalysisError when the
 * run does not exist. Never mutates execution history (control-schema
 * tables are read-only here) and never rewrites earlier evaluations.
 */
/** The result of ONE complete pass over the captured `W0`. */
interface AnalysisPassResult {
  readonly result: Omit<AnalysisRunResult, 'publication'>;
  /** Checkpoint C publication input (proof rows + subject pointers). */
  readonly keys: readonly GenericKeyAnalysisResult[];
}

/**
 * Runs the full deterministic analysis for one run under Boundary A
 * (ADR-0026 §13): two-stage truth-input capture, canonical derivation,
 * evaluation, and AUTHORITATIVE publication of the current-evaluation
 * pointers + eligibility proofs — or, when the composite watermark moves
 * or the derived projection is not proven complete, a bounded re-analysis
 * with a FRESH capture. Exhaustion fails closed: the stored selection is
 * never advanced to stale results.
 *
 * Throws AnalysisError when the run does not exist. Never mutates
 * execution history (control-schema tables are read-only here) and never
 * rewrites earlier evaluations.
 */
export async function runRunAnalysis(
  prisma: PrismaClient,
  runId: string,
): Promise<AnalysisRunResult> {
  await ensureInvariantDefinitions(prisma);

  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { id: true, state: true },
  });
  if (run === null) {
    throw new AnalysisError(`run ${runId} does not exist`);
  }
  // Current-evaluation publication requires a terminal COMPLETED run
  // (ADR-0026 §13 step 4). A pass over a non-terminal run still evaluates
  // and persists rows (history), but publishes nothing: without a frozen
  // terminal truth there is no current selection to authorize.
  const publishable = run.state === 'COMPLETED';
  const maxCycles = publishable ? RUN_ANALYSIS_MAX_CYCLES : 1;
  let last: AnalysisPassResult | null = null;
  let cycles = 0;
  let lastReason = 'NO_COMPLETE_CYCLE';
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    cycles = cycle;
    // ---- Stage 1 (before-read): capture (C1, P1) under the lock. ----
    const stage1 = await captureStage1Source(prisma, runId);
    // ---- Derivation under the writer protocol (each commit advances D). ----
    const derived = await deriveRunEvidence(prisma, runId);
    // ---- Stage 2 (final capture): W0 = (C0, P0, D0). ----
    const stage2 = await captureStage2Watermark(prisma, runId, stage1);
    if (stage2.raced) {
      // The pass's own derivation raced a newer truth-input state: restart
      // with a FRESH stage-1 capture (never reinterpret the difference).
      lastReason = 'SOURCE_ADVANCED_DURING_DERIVATION';
      continue;
    }
    const w0 = stage2.watermark;
    const pass = await runAnalysisPass(prisma, runId, w0, derived);
    last = pass;
    if (!publishable) {
      return {
        ...pass.result,
        publication: {
          published: false,
          state: 'NOT_APPLICABLE',
          analysisGeneration: null,
          cycles,
          reason:
            'RUN_NOT_TERMINAL: current-evaluation publication requires a terminal COMPLETED run',
        },
      };
    }
    const published = await publishAnalysisGeneration(
      prisma,
      runId,
      w0,
      buildPublicationKeys(pass),
    );
    if (published.published) {
      return {
        ...pass.result,
        publication: {
          published: true,
          state: 'PUBLISHED',
          analysisGeneration: published.analysisGeneration,
          cycles,
          reason: published.detail,
        },
      };
    }
    lastReason = `${published.reason}${
      published.changedComponents.length === 0 ? '' : `:${published.changedComponents.join('+')}`
    }`;
  }
  const fallback: Omit<AnalysisRunResult, 'publication'> = last?.result ?? {
    batchId: '',
    evaluatorVersion: INV_IZ_1_EVALUATOR_VERSION,
    evidenceSetFingerprint: '',
    evaluations: [],
    derivedEventCount: 0,
    derivedRelationshipCount: 0,
    genericEvaluatedCount: 0,
    genericInvariantKeys: [],
  };
  return {
    ...fallback,
    publication: {
      published: false,
      state: 'BOUND_EXHAUSTED',
      analysisGeneration: null,
      cycles,
      reason: `BOUNDED_RE_ANALYSIS_EXHAUSTED:${lastReason}`,
    },
  };
}

/**
 * The publication input for one pass: every bound key's proof row plus its
 * current subject pointers. Legacy keys (INV-IZ-1, INV-DF-1/2) and generic
 * keys on snapshots without a `runScopeBinding` publish as
 * `legacy-compat` rows over the as-observed subject domain (ADR-0026 §13).
 */
function buildPublicationKeys(pass: AnalysisPassResult): readonly PublicationKey[] {
  const keys: PublicationKey[] = [];
  const grouped = new Map<
    string,
    { invariantKey: string; evaluatorVersion: string; subjects: PublicationKey['subjects'] }
  >();
  for (const evaluation of pass.result.evaluations) {
    const entry = grouped.get(evaluation.invariantKey) ?? {
      invariantKey: evaluation.invariantKey,
      evaluatorVersion: evaluation.evaluatorVersion,
      subjects: [],
    };
    entry.subjects = [
      ...entry.subjects,
      {
        subjectKey: evaluation.subjectKey,
        evaluationId: evaluation.id,
        evidenceSetHash: evaluation.evidenceSetHash,
        verdict: evaluation.verdict,
      },
    ];
    grouped.set(evaluation.invariantKey, entry);
  }
  for (const entry of grouped.values()) {
    keys.push({
      invariantKey: entry.invariantKey,
      evaluatorVersion: entry.evaluatorVersion,
      registryVersion: '',
      eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
      mode: GENERIC_ANALYSIS_MODE_LEGACY,
      subjects: entry.subjects,
      coverage: null,
    });
  }
  for (const key of pass.keys) {
    keys.push({
      invariantKey: key.invariantKey,
      evaluatorVersion: key.evaluatorVersion,
      registryVersion: key.evaluatorVersionTriple.registryVersion,
      eligibilityVersion: key.eligibilityVersion,
      mode: key.mode,
      subjects: key.subjects.map((subject) => ({
        subjectKey: subject.subjectKey,
        evaluationId: subject.id,
        evidenceSetHash: subject.evidenceSetHash,
        verdict: subject.verdict,
      })),
      coverage:
        key.coverage === null
          ? null
          : {
              scopeField: key.coverage.scopeField,
              generationField: key.coverage.generationField,
              anchorState: key.coverage.anchorState,
              anchorReason: key.coverage.anchorReason,
              anchor: key.coverage.anchor,
              declared: key.coverage.declared,
              eligible: key.coverage.eligible,
              missing: key.coverage.missing,
              unexpected: key.coverage.unexpected,
              foreign: key.coverage.foreign,
              indeterminate: key.coverage.indeterminate,
              evidenceGaps: key.coverage.evidenceGaps,
              coverageMode: key.coverage.coverageMode,
              eligibilityVersion: key.coverage.eligibilityVersion,
              coverageStatement: key.coverage.coverageStatement,
            },
    });
  }
  return keys;
}

/**
 * ONE complete analysis pass over the captured `W0 = (C0, P0, D0)`. Every
 * business-evidence read happens AFTER stage 2, so every result is a result
 * ABOUT `W0` (ADR-0026 §13).
 */
async function runAnalysisPass(
  prisma: PrismaClient,
  runId: string,
  w0: TruthInputWatermark,
  derived: Awaited<ReturnType<typeof deriveRunEvidence>>,
): Promise<AnalysisPassResult> {
  void w0;
  // Phase 15 seam gate: generic analysis runs ONLY when the run's
  // FROZEN snapshot carries a manifest evidence policy (legacy
  // manifest-less snapshots never evaluate generic invariants).
  const frozenGenericPolicy = await loadFrozenEvidencePolicy(prisma, runId);

  // 2. Evidence graph snapshot (ALL derived rows of the run).
  const [eventRows, relationshipRows, fingerprint] = await Promise.all([
    prisma.normalizedEvent.findMany({
      where: { runId },
      select: {
        id: true,
        eventType: true,
        subjectKey: true,
        payload: true,
        inputHash: true,
      },
    }),
    prisma.causalRelationship.findMany({
      where: { runId },
      select: {
        id: true,
        fromEventId: true,
        toEventId: true,
        relationKind: true,
        basis: true,
        evidenceJson: true,
      },
    }),
    computeEvidenceSetFingerprint(prisma, runId),
  ]);
  const graph: InvariantEvidenceGraph = {
    runId,
    events: eventRows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      subjectKey: row.subjectKey,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      inputHash: row.inputHash,
    })),
    relationships: relationshipRows.map((row) => ({
      id: row.id,
      fromEventId: row.fromEventId,
      toEventId: row.toEventId,
      relationKind: row.relationKind,
      basis: row.basis,
      evidenceJson: (row.evidenceJson ?? {}) as Record<string, unknown>,
    })),
  };

  // 3. Deterministic evaluation: every registered invariant over the
  // SAME evidence graph (one business truth engine; each evaluator
  // pure + versioned; Phase 9 adds INV-DF-1/INV-DF-2, docs/
  // controlled-faults.md §6).
  const evaluationSets = [
    {
      invariantKey: INV_IZ_1_KEY,
      evaluatorVersion: INV_IZ_1_EVALUATOR_VERSION,
      results: evaluateInvIz1(graph),
    },
    {
      invariantKey: INV_DF_1_KEY,
      evaluatorVersion: INV_DF_1_EVALUATOR_VERSION,
      results: evaluateInvDf1(graph),
    },
    {
      invariantKey: INV_DF_2_KEY,
      evaluatorVersion: INV_DF_2_EVALUATOR_VERSION,
      results: evaluateInvDf2(graph),
    },
  ] as const;

  // 4. Idempotent persistence. Batch row: unique per
  // (run, invariant, evaluatorVersion) — concurrent passes converge.
  // (Prisma upsert is select-then-insert under the hood, so a concurrent
  // insert can surface as P2002; the re-fetch then converges.)
  const batches: Array<{ invariantKey: string; id: string }> = [];
  for (const set of evaluationSets) {
    try {
      const batch = await prisma.evaluationBatch.upsert({
        where: {
          runId_invariantKey_evaluatorVersion: {
            runId,
            invariantKey: set.invariantKey,
            evaluatorVersion: set.evaluatorVersion,
          },
        },
        create: {
          runId,
          invariantKey: set.invariantKey,
          evaluatorVersion: set.evaluatorVersion,
        },
        update: {},
        select: { id: true },
      });
      batches.push({ invariantKey: set.invariantKey, id: batch.id });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') {
        throw error;
      }
      const existing = await prisma.evaluationBatch.findUnique({
        where: {
          runId_invariantKey_evaluatorVersion: {
            runId,
            invariantKey: set.invariantKey,
            evaluatorVersion: set.evaluatorVersion,
          },
        },
        select: { id: true },
      });
      if (existing === null) {
        throw error;
      }
      batches.push({ invariantKey: set.invariantKey, id: existing.id });
    }
  }

  // Traceability sets (evidence-model §8 provenance): observations are
  // run-wide; events/relationships are the full derived set evaluated.
  const sourceObservationHashes = fingerprint.observationHashes;

  const evaluations: PersistedEvaluation[] = [];
  for (const set of evaluationSets) {
    const batchId = batches.find((batch) => batch.invariantKey === set.invariantKey)?.id;
    if (batchId === undefined) {
      throw new AnalysisError(`batch row missing for ${set.invariantKey}`);
    }
    for (const result of set.results) {
      const created = await persistEvaluation(prisma, {
        id: randomUUID(),
        batchId,
        invariantKey: set.invariantKey,
        evaluatorVersion: set.evaluatorVersion,
        runId,
        subjectKey: result.subjectKey,
        verdict: result.verdict,
        reason: result.reason.slice(0, 500),
        evidenceSetHash: fingerprint.fingerprint,
        completenessBasis: result.completenessBasis.slice(0, 64),
        details: {
          ...result.details,
          evaluatorVersion: set.evaluatorVersion,
          invariantKey: set.invariantKey,
          evidenceSetFingerprint: fingerprint.fingerprint,
        },
        sourceObservationHashes,
        normalizedEventIds: fingerprint.eventIds,
        causalRelationshipIds: fingerprint.relationshipIds,
      });
      if (created !== null) {
        evaluations.push({
          id: created.id,
          invariantKey: set.invariantKey,
          subjectKey: created.subjectKey,
          verdict: created.verdict,
          reason: created.reason,
          evidenceSetHash: created.evidenceSetHash,
          evaluatorVersion: created.evaluatorVersion,
          createdAt: created.createdAt,
        });
      }
    }
    const evaluationCount = await prisma.invariantEvaluation.count({
      where: { batchId },
    });
    await prisma.evaluationBatch.update({
      where: { id: batchId },
      data: { completedAt: new Date(), evaluationCount },
    });
  }

  // 5. Phase 15 (additive): generic business-invariant/v1 evaluation
  // over the FROZEN snapshot bindings + persisted Phase 14 evidence.
  // Legacy analysis above is untouched; this seam adds evaluation rows
  // ONLY for runs whose frozen snapshot carries generic bindings
  // (legacy snapshots evaluate zero generic invariants). Same
  // idempotency discipline; same tables; no target HTTP; no AI.
  let generic: GenericAnalysisResult = { batchIds: [], evaluations: [], keys: [] };
  if (frozenGenericPolicy !== undefined) {
    generic = await runGenericInvariantAnalysis(prisma, runId, {
      snapshotContentHash: await loadRunSnapshotContentHash(prisma, runId),
      targetId: await loadRunTargetId(prisma, runId),
    });
  }

  return {
    result: {
      batchId: batches[0]?.id ?? '',
      evaluatorVersion: INV_IZ_1_EVALUATOR_VERSION,
      evidenceSetFingerprint: fingerprint.fingerprint,
      evaluations,
      derivedEventCount: derived.events.length,
      derivedRelationshipCount: derived.relationships.length,
      genericEvaluatedCount: generic.evaluations.length,
      genericInvariantKeys: generic.batchIds.map((batch) => batch.invariantKey),
    },
    keys: generic.keys,
  };
}

/** The run's frozen snapshot content hash (platform identity input). */
async function loadRunSnapshotContentHash(prisma: PrismaClient, runId: string): Promise<string> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { contentHash: true } } },
  });
  if (run === null) {
    throw new AnalysisError(`run ${runId} does not exist`);
  }
  return run.snapshot.contentHash;
}

/** The run's declared target id (platform identity input, never comparand data). */
async function loadRunTargetId(prisma: PrismaClient, runId: string): Promise<string> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: {
      snapshot: {
        select: { revision: { select: { targetId: true } } },
      },
    },
  });
  if (run === null) {
    throw new AnalysisError(`run ${runId} does not exist`);
  }
  return run.snapshot.revision.targetId;
}

/**
 * Creates one evaluation row unless the identical (subject, evidence
 * set) evaluation already exists — unique-key idempotency with P2002
 * tolerance so concurrent passes cannot duplicate a verdict.
 */
async function persistEvaluation(
  prisma: PrismaClient,
  input: {
    readonly id: string;
    readonly batchId: string;
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly runId: string;
    readonly subjectKey: string;
    readonly verdict: InvariantVerdict;
    readonly reason: string;
    readonly evidenceSetHash: string;
    readonly completenessBasis: string;
    readonly details: Record<string, unknown>;
    readonly sourceObservationHashes: string[];
    readonly normalizedEventIds: string[];
    readonly causalRelationshipIds: string[];
  },
): Promise<{
  id: string;
  subjectKey: string;
  verdict: InvariantVerdict;
  reason: string;
  evidenceSetHash: string;
  evaluatorVersion: string;
  createdAt: Date;
} | null> {
  try {
    return await prisma.invariantEvaluation.create({
      data: {
        id: input.id,
        batchId: input.batchId,
        runId: input.runId,
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        subjectKey: input.subjectKey.slice(0, 200),
        verdict: input.verdict,
        reason: input.reason,
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis,
        details: input.details as object,
        sourceObservationHashes: input.sourceObservationHashes,
        normalizedEventIds: input.normalizedEventIds,
        causalRelationshipIds: input.causalRelationshipIds,
      },
      select: {
        id: true,
        subjectKey: true,
        verdict: true,
        reason: true,
        evidenceSetHash: true,
        evaluatorVersion: true,
        createdAt: true,
      },
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'P2002') {
      throw error;
    }
    // Identical evaluation already persisted: return it (idempotent).
    const existing = await prisma.invariantEvaluation.findFirst({
      where: {
        runId: input.runId,
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        subjectKey: input.subjectKey.slice(0, 200),
        evidenceSetHash: input.evidenceSetHash,
      },
      select: {
        id: true,
        subjectKey: true,
        verdict: true,
        reason: true,
        evidenceSetHash: true,
        evaluatorVersion: true,
        createdAt: true,
      },
    });
    return existing;
  }
}
