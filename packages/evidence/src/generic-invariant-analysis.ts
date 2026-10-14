// =====================================================================
// RuptureGrid v1.1 Phase 15 — generic analysis persistence adapter
// (ADR-0023 §11/§12; ADR-0026 §4/§6/§7/§9 Checkpoint C gating)
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
// TWO MODES (ADR-0026 §13/§17, frozen):
//
//   * GATED (`strict-coverage/v1`) — the run's FROZEN snapshot carries a
//     `target.runScopeBinding`. The run-owned anchor is derived from
//     durable fenced setup evidence (`deriveRunAnchor`), every observed
//     subject is partitioned into the frozen four classes by
//     `selectEligibleSubjects` BEFORE any grouping/convergence, and only
//     class-A partitions are evaluated — each against the entities of its
//     own anchor-matched partition. Evaluations are stored under the
//     gated evaluator version `generic-invariant/v1` and their details
//     carry the anchor tuple + `eligibilityVersion`; the evidence-set
//     hash includes the anchor tuple and the eligibility version
//     (changed hash semantics can never hide under an old version).
//
//   * LEGACY-COMPAT — the frozen snapshot carries no `runScopeBinding`
//     (every accepted Phase 14–16 fixture, and manifest-less legacy
//     runs). The as-observed subject domain is used exactly as before,
//     under the frozen pre-gating version `v1` and the pre-gating hash
//     discipline (anchor/eligibility never enter a legacy hash). No
//     anchor is derived, no declared set is invented, no coverage
//     anomaly exists — there is no declared intent to prove coverage
//     against.
//
// CHECKPOINT C QUALITY BAR (ADR-0026 §7/§8/§15): a declared-subject PASS
// with an undeclared same-scope subject observed is a COVERAGE ANOMALY
// (class B) that is persisted in the eligibility proof — never silently
// dropped and never laundered into a global success; a foreign-scope
// subject (class C) is counted inventory only and can never become this
// run's business verdict; an indeterminate subject (class D) fails
// closed.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import {
  canonicalInstanceParamsJson,
  RUN_SCOPE_COVERAGE_MODE,
  RUN_SCOPE_ELIGIBILITY_VERSION,
} from '@rupturegrid/engine';
import type { ManifestEvidencePolicy, RunScopeDeclaration } from '@rupturegrid/engine';
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
import { deriveRunAnchor, loadFrozenRunScopeBinding } from './run-anchor.js';
import type { RunAnchor, RunAnchorGap, RunAnchorState } from './run-anchor.js';
import { declaredSubjectsFor, selectEligibleSubjects } from './generic-eligibility.js';
import type {
  ForeignScopeCount,
  IndeterminateEvidence,
  UnexpectedSubject,
} from './generic-eligibility.js';

/** The frozen pre-gating evaluator version (legacy-compat only). */
export const GENERIC_INVARIANT_EVALUATOR_VERSION = 'v1';

/**
 * The first eligibility-gated evaluator version (ADR-0026 §13). Gated
 * rows ALWAYS carry the triple `(registryVersion, evaluatorVersion,
 * eligibilityVersion)`; pre-gating `v1` rows are labeled history and are
 * never current truth for a gated run.
 */
export const GENERIC_INVARIANT_EVALUATOR_VERSION_GATED = 'generic-invariant/v1';

/** The frozen coverage-mode labels persisted on proof rows (§13). */
export const GENERIC_ANALYSIS_MODE_STRICT = RUN_SCOPE_COVERAGE_MODE;
export const GENERIC_ANALYSIS_MODE_LEGACY = 'legacy-compat';

/**
 * The frozen coverage limitation statement (ADR-0026 §7, exact text).
 */
export const COVERAGE_LIMITATION_STATEMENT =
  'PASS is claimed only over the declared, evidence-verified verification domain named in this report; ' +
  'it proves nothing about other scopes, other subjects, other generations, or target state outside the verified domain.';

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

/** One persisted evaluation reference of this pass (for publication). */
export interface GenericPersistedEvaluation {
  readonly id: string;
  readonly invariantKey: string;
  readonly subjectKey: string;
  readonly verdict: string;
  readonly evidenceSetHash: string;
}

/**
 * The persisted coverage/eligibility proof of one bound generic key
 * (gated mode only). Every field is derived from durable evidence; the
 * publication transaction serializes it into `run_eligibility_proof`.
 */
export interface GenericCoverageProof {
  readonly mode: string;
  readonly coverageMode: string;
  readonly eligibilityVersion: string;
  readonly scopeField: string;
  readonly generationField: string;
  readonly anchorState: RunAnchorState;
  readonly anchorReason: string;
  readonly anchor: RunAnchor | null;
  readonly declared: readonly string[];
  readonly eligible: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly UnexpectedSubject[];
  readonly foreign: readonly ForeignScopeCount[];
  readonly indeterminate: readonly IndeterminateEvidence[];
  readonly evidenceGaps: readonly RunAnchorGap[];
  readonly coverageStatement: string;
}

/** One bound generic key's analysis result (publication input). */
export interface GenericKeyAnalysisResult {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly eligibilityVersion: string;
  readonly mode: string;
  readonly batchId: string;
  readonly evaluatorVersionTriple: {
    readonly registryVersion: string;
    readonly evaluatorVersion: string;
    readonly eligibilityVersion: string;
  };
  readonly subjects: readonly GenericPersistedEvaluation[];
  /** Gated mode only; `null` in legacy-compat mode. */
  readonly coverage: GenericCoverageProof | null;
}

export interface GenericAnalysisResult {
  readonly batchIds: ReadonlyArray<{ readonly invariantKey: string; readonly id: string }>;
  readonly evaluations: GenericPersistedEvaluation[];
  /** Checkpoint C: per-key publication input (proof rows + pointers). */
  readonly keys: readonly GenericKeyAnalysisResult[];
}

const EMPTY_GENERIC_ANALYSIS: GenericAnalysisResult = {
  batchIds: [],
  evaluations: [],
  keys: [],
};

/**
 * Runs the generic analysis pass for one run: loads the frozen policy
 * + frozen generic bindings + the frozen `runScopeBinding`, derives the
 * run-owned anchor when gated, selects the eligible partitions, loads
 * persisted capture statuses / events / ACTIVE graph once, evaluates
 * every eligible (instance, subject), and persists InvariantEvaluation
 * rows idempotently. Returns the persisted evaluations plus the
 * per-key coverage proof for the publication transaction.
 */
export async function runGenericInvariantAnalysis(
  prisma: PrismaClient,
  runId: string,
  runContext: { readonly snapshotContentHash: string; readonly targetId: string },
): Promise<GenericAnalysisResult> {
  const policy = await loadFrozenEvidencePolicy(prisma, runId);
  if (policy === undefined) {
    return EMPTY_GENERIC_ANALYSIS; // Legacy run: nothing generic.
  }
  const instances = await loadFrozenGenericInstances(prisma, runId, policy);
  if (instances.length === 0) {
    return EMPTY_GENERIC_ANALYSIS;
  }
  await ensureGenericInvariantDefinitions(prisma, instances);

  const runScopeBinding = await loadFrozenRunScopeBinding(prisma, runId);
  const gated = runScopeBinding !== null;
  // Gated runs derive the run-owned anchor ONCE, from durable fenced
  // evidence, before any subject discovery (ADR-0026 §5/§11). A pure
  // read: repeat calls on the same durable state return the same result.
  const anchorResult = gated
    ? await deriveRunAnchor(prisma, runId, runScopeBinding as RunScopeDeclaration)
    : null;

  const captures = await loadPersistedCaptureStatuses(prisma, runId);
  const shared = await loadGenericEventsAndActiveGraph(prisma, runId, policy);
  const batchIds: Array<{ readonly invariantKey: string; readonly id: string }> = [];
  const evaluations: GenericPersistedEvaluation[] = [];
  const keys: GenericKeyAnalysisResult[] = [];

  for (const instance of instances) {
    const evaluatorVersion = gated
      ? GENERIC_INVARIANT_EVALUATOR_VERSION_GATED
      : GENERIC_INVARIANT_EVALUATOR_VERSION;
    // Batch row: existing idempotency discipline (unique per
    // run + invariant + evaluatorVersion; P2002 re-read).
    const batchId = await ensureEvaluationBatch(prisma, runId, instance.key, evaluatorVersion);
    batchIds.push({ invariantKey: instance.key, id: batchId });
    const subjects: GenericPersistedEvaluation[] = [];
    let coverage: GenericCoverageProof | null = null;

    if (!gated) {
      // ---- LEGACY-COMPAT (as-observed domain, pre-gating hash) ----
      const legacySubjects = await loadGenericEvaluationSubjects(prisma, runId, policy, {
        kind: instance.kind,
        params: instance.params as unknown as Record<string, unknown>,
      });
      for (const subject of legacySubjects) {
        const persisted = await evaluateAndPersist(prisma, {
          runId,
          snapshotContentHash: runContext.snapshotContentHash,
          targetId: runContext.targetId,
          instance,
          policy,
          captures,
          shared,
          subject,
          entities: shared.entities,
          activeRelationships: shared.activeRelationships,
          batchId,
          evaluatorVersion,
          anchor: null,
          declaredScope: null,
          eligibilityVersion: null,
        });
        if (persisted !== null) {
          subjects.push(persisted);
          evaluations.push(persisted);
        }
      }
    } else {
      // ---- GATED (strict-coverage/v1) ----
      const anchored = anchorResult as Awaited<ReturnType<typeof deriveRunAnchor>>;
      const scopeBinding = (
        instance.params as {
          scopeBinding?: { fields?: readonly string[]; generationField?: string };
        }
      ).scopeBinding;
      const scopeField = Array.isArray(scopeBinding?.fields) ? scopeBinding?.fields[0] : undefined;
      const generationField = scopeBinding?.generationField;
      const declared = declaredSubjectsFor(runScopeBinding, instance.key);
      const scopeComparable = typeof scopeField === 'string' && typeof generationField === 'string';
      const eligibility = scopeComparable
        ? selectEligibleSubjects({
            instance: {
              key: instance.key,
              kind: instance.kind,
              params: instance.params as unknown as Record<string, unknown>,
            },
            scopeField,
            generationField,
            declaredSubjects: declared,
            anchor: anchored.anchor,
            anchorState: anchored.state,
            anchorReason: anchored.reason,
            entities: shared.entities,
            contestedEventIds: shared.contestedEventIds,
          })
        : null;

      for (const partition of eligibility?.eligible ?? []) {
        const partitionSet = new Set(partition.partitionEventIds);
        const partitionEntities = shared.entities.filter((entity) =>
          partitionSet.has(entity.eventId),
        );
        const partitionRelationships = shared.activeRelationships.filter(
          (relationship) =>
            partitionSet.has(relationship.fromEventId) && partitionSet.has(relationship.toEventId),
        );
        const persisted = await evaluateAndPersist(prisma, {
          runId,
          snapshotContentHash: runContext.snapshotContentHash,
          targetId: runContext.targetId,
          instance,
          policy,
          captures,
          shared,
          subject: {
            subjectKey: partition.subjectKey,
            subjectEventIds: partition.subjectEventIds,
            subjectPayload: partition.subjectPayload,
          },
          entities: partitionEntities,
          activeRelationships: partitionRelationships,
          batchId,
          evaluatorVersion,
          anchor: anchored.anchor,
          declaredScope: (runScopeBinding as RunScopeDeclaration).declaredScope,
          eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
        });
        if (persisted !== null) {
          subjects.push(persisted);
          evaluations.push(persisted);
        }
      }

      const evidenceGaps: RunAnchorGap[] = [...anchored.gaps];
      if (eligibility !== null) {
        for (const gap of eligibility.gaps) {
          evidenceGaps.push({ kind: gap.kind, detail: gap.detail });
        }
      } else {
        evidenceGaps.push({
          kind: 'instance-scope-binding-unusable',
          detail: `invariant ${instance.key} declares no single usable scopeBinding field pair; every declared subject fails closed`,
        });
      }
      coverage = {
        mode: GENERIC_ANALYSIS_MODE_STRICT,
        coverageMode: RUN_SCOPE_COVERAGE_MODE,
        eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
        scopeField: typeof scopeField === 'string' ? scopeField : '',
        generationField: typeof generationField === 'string' ? generationField : '',
        anchorState: anchored.state,
        anchorReason: anchored.reason,
        anchor: anchored.anchor,
        declared,
        eligible: subjects.map((subject) => subject.subjectKey).sort(),
        missing: eligibility === null ? [...declared].sort() : [...eligibility.missing].sort(),
        unexpected: eligibility?.unexpected ?? [],
        foreign: eligibility?.foreign ?? [],
        indeterminate: eligibility?.indeterminate ?? [],
        evidenceGaps,
        coverageStatement: COVERAGE_LIMITATION_STATEMENT,
      };
    }

    const evaluationCount = await prisma.invariantEvaluation.count({ where: { batchId } });
    await prisma.evaluationBatch.update({
      where: { id: batchId },
      data: { completedAt: new Date(), evaluationCount },
    });
    keys.push({
      invariantKey: instance.key,
      evaluatorVersion,
      eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
      mode: gated ? GENERIC_ANALYSIS_MODE_STRICT : GENERIC_ANALYSIS_MODE_LEGACY,
      batchId,
      evaluatorVersionTriple: {
        registryVersion: instance.registryVersion,
        evaluatorVersion,
        eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
      },
      subjects,
      coverage,
    });
  }
  return { batchIds, evaluations, keys };
}

/**
 * Builds the pure evaluator input for one (instance, subject), evaluates
 * it, and persists the row idempotently. `entities`/`activeRelationships`
 * are the (possibly partition-restricted) universe the evaluator sees;
 * for gated rows the anchor tuple + eligibility version enter the
 * evidence-set hash and the anchor enters the persisted details
 * (ADR-0026 §4/§13).
 */
async function evaluateAndPersist(
  prisma: PrismaClient,
  options: {
    readonly runId: string;
    readonly snapshotContentHash: string;
    readonly targetId: string;
    readonly instance: GenericInvariantInstance;
    readonly policy: ManifestEvidencePolicy;
    readonly captures: Awaited<ReturnType<typeof loadPersistedCaptureStatuses>>;
    readonly shared: Awaited<ReturnType<typeof loadGenericEventsAndActiveGraph>>;
    readonly subject: {
      readonly subjectKey: string;
      readonly subjectEventIds: readonly string[];
      readonly subjectPayload: Record<string, unknown>;
    };
    readonly entities: readonly Awaited<
      ReturnType<typeof loadGenericEventsAndActiveGraph>
    >['entities'][number][];
    readonly activeRelationships: readonly Awaited<
      ReturnType<typeof loadGenericEventsAndActiveGraph>
    >['activeRelationships'][number][];
    readonly batchId: string;
    readonly evaluatorVersion: string;
    readonly anchor: RunAnchor | null;
    /** The frozen `runScope.declaredScope` (gated rows only). */
    readonly declaredScope: string | null;
    readonly eligibilityVersion: string | null;
  },
): Promise<GenericPersistedEvaluation | null> {
  const { instance } = options;
  const input = buildGenericEvaluationInput({
    runId: options.runId,
    snapshotContentHash: options.snapshotContentHash,
    targetId: options.targetId,
    instance: {
      key: instance.key,
      kind: instance.kind,
      registryVersion: instance.registryVersion,
      params: instance.params as unknown as Record<string, unknown>,
    },
    policy: options.policy,
    captures: options.captures,
    entities: options.entities,
    contestedEventIds: options.shared.contestedEventIds,
    activeRelationships: options.activeRelationships,
    subject: options.subject,
  });
  const result = evaluateGenericInvariant(input);
  const captureHashes = [...options.captures.values()].flatMap((status) => [
    ...status.sourceObservationHashes,
  ]);
  const evidenceSetHash = genericEvidenceSetHash({
    registryVersion: instance.registryVersion,
    kind: instance.kind,
    evaluatorVersion: options.evaluatorVersion,
    runId: options.runId,
    snapshotContentHash: options.snapshotContentHash,
    targetId: options.targetId,
    subjectKey: options.subject.subjectKey,
    evidence: {
      captureHashes,
      eventIds: result.proofEventIds,
      relationshipIds: result.proofRelationshipIds,
      verdict: result.verdict,
      gap: result.gap,
      failureMechanism: result.failureMechanism,
    },
    // Legacy-compat keeps the pre-gating hash inputs ABSENT (frozen
    // history discipline, ADR-0026 §13/§17).
    ...(options.anchor === null || options.eligibilityVersion === null
      ? {}
      : {
          anchor: {
            observedScope: options.anchor.observedScope,
            observedGeneration: options.anchor.observedGeneration,
          },
          eligibilityVersion: options.eligibilityVersion,
        }),
  });
  const details: Record<string, unknown> = {
    ...result.details,
    registryVersion: instance.registryVersion,
    kind: instance.kind,
    evaluatorVersion: options.evaluatorVersion,
    snapshotContentHash: options.snapshotContentHash,
  };
  if (options.anchor !== null && options.eligibilityVersion !== null) {
    details['eligibilityVersion'] = options.eligibilityVersion;
    details['runScopeAnchor'] = {
      declaredScope: options.declaredScope ?? '',
      observedScope: options.anchor.observedScope,
      observedGeneration: options.anchor.observedGeneration,
      setupStep: options.anchor.setupStep,
      setupStepRunId: options.anchor.setupStepRunId,
      setupObservationHashes: [...options.anchor.setupObservationHashes],
      corroboratingSubmissionHashes: [...options.anchor.corroboratingSubmissionHashes],
      anchorFencing: {
        leaseOwnerId: options.anchor.anchorFencing.leaseOwnerId,
        fencingToken: options.anchor.anchorFencing.fencingToken,
      },
    };
  }
  const persisted = await persistGenericEvaluation(prisma, {
    id: randomUUID(),
    batchId: options.batchId,
    runId: options.runId,
    invariantKey: instance.key,
    evaluatorVersion: options.evaluatorVersion,
    subjectKey: options.subject.subjectKey,
    verdict: result.verdict,
    reason: result.reason,
    evidenceSetHash,
    completenessBasis: result.completenessBasis,
    details,
    sourceObservationHashes: [
      ...new Set([...result.proofObservationHashes, ...captureHashes]),
    ].sort(),
    normalizedEventIds: [...result.proofEventIds].sort(),
    causalRelationshipIds: [...result.proofRelationshipIds].sort(),
  });
  if (persisted === null) {
    return null;
  }
  return {
    id: persisted.id,
    invariantKey: instance.key,
    subjectKey: persisted.subjectKey,
    verdict: persisted.verdict,
    evidenceSetHash: persisted.evidenceSetHash,
  };
}

async function ensureEvaluationBatch(
  prisma: PrismaClient,
  runId: string,
  invariantKey: string,
  evaluatorVersion: string,
): Promise<string> {
  const where = {
    runId_invariantKey_evaluatorVersion: {
      runId,
      invariantKey,
      evaluatorVersion,
    },
  } as const;
  try {
    const batch = await prisma.evaluationBatch.upsert({
      where,
      create: {
        runId,
        invariantKey,
        evaluatorVersion,
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
