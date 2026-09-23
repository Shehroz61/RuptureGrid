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

import { randomUUID } from 'node:crypto';
import type { PrismaClient, InvariantVerdict } from '@rupturegrid/control-db';
import { deriveRunEvidence } from './derive.js';
import { computeEvidenceSetFingerprint } from './derive.js';
import { evaluateInvDf1, evaluateInvDf2, evaluateInvIz1 } from './invariants.js';
import type { InvariantEvidenceGraph } from './invariants.js';
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

/** Creates every invariant definition row if absent (idempotent). */
export async function ensureInvariantDefinitions(prisma: PrismaClient): Promise<void> {
  for (const definition of [
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
  ] as const) {
    await prisma.invariantDefinition.upsert({
      where: { invariantKey: definition.invariantKey },
      create: {
        invariantKey: definition.invariantKey,
        title: definition.title,
        description: definition.description,
      },
      update: {},
    });
  }
}

export interface PersistedEvaluation {
  readonly id: string;
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
}

/**
 * Runs the full deterministic analysis for one run: derivation,
 * evaluation, idempotent persistence. Throws AnalysisError when the
 * run does not exist. Never mutates execution history (control-schema
 * tables are read-only here) and never rewrites earlier evaluations.
 */
export async function runRunAnalysis(
  prisma: PrismaClient,
  runId: string,
): Promise<AnalysisRunResult> {
  await ensureInvariantDefinitions(prisma);

  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (run === null) {
    throw new AnalysisError(`run ${runId} does not exist`);
  }

  // 1. Derivation (idempotent; converges on the same rows).
  const derived = await deriveRunEvidence(prisma, runId);

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

  return {
    batchId: batches[0]?.id ?? '',
    evaluatorVersion: INV_IZ_1_EVALUATOR_VERSION,
    evidenceSetFingerprint: fingerprint.fingerprint,
    evaluations,
    derivedEventCount: derived.events.length,
    derivedRelationshipCount: derived.relationships.length,
  };
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
