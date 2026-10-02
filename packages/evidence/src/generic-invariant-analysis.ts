// =====================================================================
// RuptureGrid v1.1 Phase 15 — generic analysis persistence adapter
// (ADR-0023 §11/§12; roadmap Phase 15)
// =====================================================================
// One additive seam inside the EXISTING analysis pipeline (never a
// competing pipeline): after legacy derivation/evaluation, evaluate
// every FROZEN generic invariant binding of the run and persist the
// resulting InvariantEvaluation rows idempotently.
//
// Frozen-definition source (§11): generic instances come ONLY from the
// run snapshot's invariant bindings (frozen execution intent,
// ADR-0010). The durable InvariantDefinition row is REGISTRY METADATA;
// it is ensured (validated, ALL-OR-NONE) but NEVER read as the
// evaluation authority. No live TargetRegistration.manifestJson is
// loaded; no target HTTP happens here; evaluation is offline over
// persisted evidence and reproducible after process restart.
//
// Persistence reuses InvariantDefinition / EvaluationBatch /
// InvariantEvaluation with the EXISTING idempotency discipline:
//   unique (runId, invariantKey, evaluatorVersion, subjectKey,
//   evidenceSetHash) — repeat analysis converges on ONE row; new
//   truth-relevant evidence appends a NEW row (history never
//   rewritten); concurrent passes converge via the unique key +
//   P2002 re-read.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import { canonicalInstanceParamsJson } from '@rupturegrid/engine';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { loadFrozenEvidencePolicy } from './derive.js';
import {
  BUSINESS_INVARIANT_REGISTRY_VERSION,
  validateGenericInvariantDefinition,
} from '@rupturegrid/engine';
import type { GenericInvariantInstance } from '@rupturegrid/engine';
import {
  buildGenericEvaluationInput,
  genericEvidenceSetHash,
  loadGenericEvaluationSubjects,
  loadGenericEventsAndActiveGraph,
  loadPersistedCaptureStatuses,
} from './generic-invariant-input.js';
import { evaluateGenericInvariant } from './generic-invariant-evaluate.js';

/** Explicit deterministic evaluator version for the generic evaluators. */
export const GENERIC_INVARIANT_EVALUATOR_VERSION = 'v1';

/**
 * The frozen snapshot block the engine freezes at snapshot time
 * (ADR-0010 invariant bindings; ADR-0023 §9/§11). Legacy snapshots
 * carry no such key and therefore evaluate zero generic invariants.
 */
const GENERIC_INVARIANT_BINDING_KEY = 'invariantBindings';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Loads the FROZEN generic invariant instances of a run from its
 * snapshot document (additive `target.invariantBindings`
 * block — the smallest backwards-compatible extension of the existing
 * snapshot-definition mechanism; legacy snapshots carry none and
 * therefore evaluate zero generic invariants). Every binding is
 * RE-VALIDATED here against the frozen evidence policy (fail-closed
 * definition-time discipline — a binding that no longer validates can
 * never silently become evaluation truth).
 */
export async function loadFrozenGenericInstances(
  prisma: PrismaClient,
  runId: string,
  policy: ManifestEvidencePolicy,
): Promise<readonly GenericInvariantInstance[]> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (run === null) {
    return [];
  }
  const target = (run.snapshot.content as { target?: Record<string, unknown> })['target'];
  if (!isRecord(target)) {
    return [];
  }
  const bindings = target[GENERIC_INVARIANT_BINDING_KEY];
  if (bindings === undefined || bindings === null) {
    return []; // Legacy snapshot: no generic bindings frozen.
  }
  if (!Array.isArray(bindings)) {
    throw new Error(`run ${runId}: frozen generic invariant bindings must be an array`);
  }
  const instances: GenericInvariantInstance[] = [];
  for (const binding of bindings) {
    const validated = validateGenericInvariantDefinition(binding, policy);
    if (validated.registryVersion !== BUSINESS_INVARIANT_REGISTRY_VERSION) {
      throw new Error(
        `run ${runId}: frozen generic binding ${validated.key} carries registry version ${validated.registryVersion}`,
      );
    }
    instances.push(validated);
  }
  // Deterministic order: by key.
  return [...instances].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Ensures the durable InvariantDefinition rows for the run's generic
 * instances exist (validated, ALL-OR-NONE). NEVER silently overwrites
 * the semantics of an existing invariantKey: if a row exists with
 * different generic metadata, this throws (append-only discipline for
 * historical evaluations). Legacy rows keep null metadata.
 */
export async function ensureGenericInvariantDefinitions(
  prisma: PrismaClient,
  instances: readonly GenericInvariantInstance[],
): Promise<void> {
  for (const instance of instances) {
    const existing = await prisma.invariantDefinition.findUnique({
      where: { invariantKey: instance.key },
      select: { kind: true, registryVersion: true, paramsJson: true },
    });
    const serializedParams = instance.params as object;
    if (existing === null) {
      await prisma.invariantDefinition.create({
        data: {
          invariantKey: instance.key,
          title: instance.key,
          description: `business-invariant/v1 ${instance.kind} instance (registry metadata; run truth is the frozen snapshot copy)`,
          kind: instance.kind,
          registryVersion: instance.registryVersion,
          paramsJson: serializedParams,
        },
        select: { id: true },
      });
      continue;
    }
    // The durable row is registry metadata; an existing row must carry
    // IDENTICAL generic metadata (never silently overwrite the
    // semantics of an existing invariantKey underneath historical
    // evaluations). Legacy rows (all-null triple) are refused for
    // generic registration.
    if (
      existing.kind === null ||
      existing.registryVersion === null ||
      existing.paramsJson === null
    ) {
      throw new Error(
        `invariant ${instance.key} already exists as a legacy definition; refusing to overwrite its semantics underneath historical evaluations`,
      );
    }
    // Canonical JSON comparison (key-order-independent): Postgres jsonb
    // does NOT preserve object key order, so a byte comparison of a
    // round-tripped params document false-positives. The canonical form
    // (canonicalizeJson) is the hash-input discipline used everywhere
    // else in the platform (ADR-0023 §6 hash input discipline).
    const same =
      existing.kind === instance.kind &&
      existing.registryVersion === instance.registryVersion &&
      canonicalInstanceParamsJson({
        ...instance,
        params: existing.paramsJson as unknown as GenericInvariantInstance['params'],
      }) === canonicalInstanceParamsJson(instance);
    if (!same) {
      throw new Error(
        `invariant ${instance.key} is already registered with different generic metadata; never silently overwrite existing semantics`,
      );
    }
  }
}

export interface GenericAnalysisResult {
  readonly batchIds: ReadonlyArray<{ readonly invariantKey: string; readonly id: string }>;
  readonly evaluations: Array<{
    readonly id: string;
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly verdict: string;
    readonly evidenceSetHash: string;
  }>;
}

/**
 * Runs the generic analysis pass for one run: loads the frozen policy
 * + frozen generic bindings, loads persisted capture statuses /
 * events / ACTIVE graph once, evaluates every (instance, subject),
 * and persists InvariantEvaluation rows idempotently. Returns the
 * persisted FAIL evaluations' identity for finding derivation (§41:
 * findings derive only from PERSISTED FAIL evaluations).
 */
export async function runGenericInvariantAnalysis(
  prisma: PrismaClient,
  runId: string,
  runContext: { readonly snapshotContentHash: string; readonly targetId: string },
): Promise<GenericAnalysisResult> {
  const policy = await loadFrozenEvidencePolicy(prisma, runId);
  if (policy === undefined) {
    return { batchIds: [], evaluations: [] }; // Legacy run: nothing generic.
  }
  const instances = await loadFrozenGenericInstances(prisma, runId, policy);
  if (instances.length === 0) {
    return { batchIds: [], evaluations: [] };
  }
  await ensureGenericInvariantDefinitions(prisma, instances);

  const captures = await loadPersistedCaptureStatuses(prisma, runId);
  const shared = await loadGenericEventsAndActiveGraph(prisma, runId, policy);
  const batchIds: Array<{ readonly invariantKey: string; readonly id: string }> = [];
  const evaluations: GenericAnalysisResult['evaluations'] = [];

  for (const instance of instances) {
    // Batch row: existing idempotency discipline (unique per
    // run + invariant + evaluatorVersion; P2002 re-read).
    const batchId = await ensureEvaluationBatch(prisma, runId, instance.key);
    batchIds.push({ invariantKey: instance.key, id: batchId });

    const subjects = await loadGenericEvaluationSubjects(prisma, runId, policy, {
      kind: instance.kind,
      params: instance.params as unknown as Record<string, unknown>,
    });
    for (const subject of subjects) {
      const input = buildGenericEvaluationInput({
        runId,
        snapshotContentHash: runContext.snapshotContentHash,
        targetId: runContext.targetId,
        instance: {
          key: instance.key,
          kind: instance.kind,
          registryVersion: instance.registryVersion,
          params: instance.params as unknown as Record<string, unknown>,
        },
        policy,
        captures,
        entities: shared.entities,
        contestedEventIds: shared.contestedEventIds,
        activeRelationships: shared.activeRelationships,
        subject,
      });
      const result = evaluateGenericInvariant(input);
      const captureHashes = [...captures.values()].flatMap((status) => [
        ...status.sourceObservationHashes,
      ]);
      const evidenceSetHash = genericEvidenceSetHash({
        registryVersion: instance.registryVersion,
        kind: instance.kind,
        evaluatorVersion: GENERIC_INVARIANT_EVALUATOR_VERSION,
        runId,
        snapshotContentHash: runContext.snapshotContentHash,
        targetId: runContext.targetId,
        subjectKey: subject.subjectKey,
        evidence: {
          captureHashes,
          eventIds: result.proofEventIds,
          relationshipIds: result.proofRelationshipIds,
          verdict: result.verdict,
          gap: result.gap,
          failureMechanism: result.failureMechanism,
        },
      });
      const persisted = await persistGenericEvaluation(prisma, {
        id: randomUUID(),
        batchId,
        runId,
        invariantKey: instance.key,
        evaluatorVersion: GENERIC_INVARIANT_EVALUATOR_VERSION,
        subjectKey: subject.subjectKey,
        verdict: result.verdict,
        reason: result.reason,
        evidenceSetHash,
        completenessBasis: result.completenessBasis,
        details: {
          ...result.details,
          registryVersion: instance.registryVersion,
          kind: instance.kind,
          evaluatorVersion: GENERIC_INVARIANT_EVALUATOR_VERSION,
          snapshotContentHash: runContext.snapshotContentHash,
        },
        sourceObservationHashes: [
          ...new Set([...result.proofObservationHashes, ...captureHashes]),
        ].sort(),
        normalizedEventIds: [...result.proofEventIds].sort(),
        causalRelationshipIds: [...result.proofRelationshipIds].sort(),
      });
      if (persisted !== null) {
        evaluations.push({
          id: persisted.id,
          invariantKey: instance.key,
          subjectKey: persisted.subjectKey,
          verdict: persisted.verdict,
          evidenceSetHash: persisted.evidenceSetHash,
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
  return { batchIds, evaluations };
}

async function ensureEvaluationBatch(
  prisma: PrismaClient,
  runId: string,
  invariantKey: string,
): Promise<string> {
  const where = {
    runId_invariantKey_evaluatorVersion: {
      runId,
      invariantKey,
      evaluatorVersion: GENERIC_INVARIANT_EVALUATOR_VERSION,
    },
  } as const;
  try {
    const batch = await prisma.evaluationBatch.upsert({
      where,
      create: {
        runId,
        invariantKey,
        evaluatorVersion: GENERIC_INVARIANT_EVALUATOR_VERSION,
      },
      update: {},
      select: { id: true },
    });
    return batch.id;
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') {
      throw error;
    }
    const existing = await prisma.evaluationBatch.findUnique({ where, select: { id: true } });
    if (existing === null) {
      throw error;
    }
    return existing.id;
  }
}

/**
 * Creates one InvariantEvaluation row unless the identical semantic
 * evaluation already exists — the EXISTING unique-key idempotency
 * (runId, invariantKey, evaluatorVersion, subjectKey, evidenceSetHash)
 * with P2002 re-read; concurrent analyses converge without duplicates.
 * Semantic content of a historical evaluation is never mutated.
 */
async function persistGenericEvaluation(
  prisma: PrismaClient,
  input: {
    readonly id: string;
    readonly batchId: string;
    readonly runId: string;
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly subjectKey: string;
    readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
    readonly reason: string;
    readonly evidenceSetHash: string;
    readonly completenessBasis: string;
    readonly details: Record<string, unknown>;
    readonly sourceObservationHashes: readonly string[];
    readonly normalizedEventIds: readonly string[];
    readonly causalRelationshipIds: readonly string[];
  },
): Promise<{ id: string; subjectKey: string; verdict: string; evidenceSetHash: string } | null> {
  try {
    const created = await prisma.invariantEvaluation.create({
      data: {
        id: input.id,
        batchId: input.batchId,
        runId: input.runId,
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        subjectKey: input.subjectKey.slice(0, 200),
        verdict: input.verdict,
        reason: input.reason.slice(0, 500),
        evidenceSetHash: input.evidenceSetHash,
        completenessBasis: input.completenessBasis.slice(0, 64),
        details: input.details as object,
        sourceObservationHashes: [...input.sourceObservationHashes],
        normalizedEventIds: [...input.normalizedEventIds],
        causalRelationshipIds: [...input.causalRelationshipIds],
      },
      select: { id: true, subjectKey: true, verdict: true, evidenceSetHash: true },
    });
    return created;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'P2002') {
      throw error;
    }
    const existing = await prisma.invariantEvaluation.findFirst({
      where: {
        runId: input.runId,
        invariantKey: input.invariantKey,
        evaluatorVersion: input.evaluatorVersion,
        subjectKey: input.subjectKey.slice(0, 200),
        evidenceSetHash: input.evidenceSetHash,
      },
      select: { id: true, subjectKey: true, verdict: true, evidenceSetHash: true },
    });
    return existing;
  }
}

export type { PersistedCaptureStatus } from './generic-invariant-input.js';
