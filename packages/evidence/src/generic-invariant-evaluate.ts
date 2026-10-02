// =====================================================================
// RuptureGrid v1.1 Phase 15 — generic business-invariant evaluators
// (PURE; ADR-0018 + ADR-0023 §8; roadmap Phase 15)
// =====================================================================
// Deterministic, PURE evaluation of the two closed business-invariant/v1
// kinds over a NORMALIZED EVALUATION INPUT built by the loader
// (generic-invariant-input.ts) from persisted evidence, the FROZEN
// ManifestEvidencePolicy, and the FROZEN instance params. No Prisma, no
// I/O, no wall clock, no AI inside these functions (ADR-0007) — the
// input contains exactly the facts/provenance needed to reproduce the
// verdict.
//
// Normative verdict algorithms (ADR-0023 §8 — order of rules binding):
//
// atMostOneAcceptedEffect, per subject:
//   1. gather candidate effects (exact acceptedMatch + exact
//      equivalence tuple + coherent scope/generation; distinct by
//      effectIdentityField; convergent duplicates collapse; conflicting
//      payloads ⇒ contested ⇒ NOT_EVALUABLE inputs)
//   2. attribute each candidate over the ACTIVE generic causal graph
//      (identity-direct/identity-chain reachability, no contested
//      endpoints) — unattributable candidates ⇒ NOT_EVALUABLE
//      (ATTRIBUTION_GAP) except rule 3
//   3. FAIL (TOO_MANY_ACCEPTED_EFFECTS) when fully attributable
//      candidates > maxAcceptedEffects — even without completeness
//   4. contradictory evidence (negative/conflicting totals,
//      observedCount > observedTotal) ⇒ NOT_EVALUABLE (EVIDENCE_CONFLICT)
//   5. PASS requires: rule 3 not fired, no attribution gap, coherent
//      scope/generation, the COMPLETE required capture set (all
//      queriesForRole(subjectRole+effectRole) + completenessProof.queryId
//      valid), AND completeness proven (observedCount == observedTotal),
//      then observedCount ≤ max ⇒ PASS
//   6. everything else ⇒ NOT_EVALUABLE with the named gap
//
// resourceConservation, per resource: baseline authority first
//   (ALL queriesForRole(baselineRole) valid for the bound resource/scope,
//   convergent; never first/last/earliest/latest/DB order), then
//   Case A (sum of DISTINCT accepted attributable consumption units >
//   baseline ⇒ FAIL; enumeration completeness NOT required), then
//   Case B (authoritative converged remaining surface < 0 ⇒ FAIL;
//   baseline/consumption not required), then Case C (remaining !=
//   initial − acceptedReservedUnits ⇒ FAIL ONLY with complete capture
//   set + proven-complete enumeration + full attribution), then PASS
//   (no earlier FAIL, no attribution gap, complete capture set,
//   authoritative baseline + remaining, completeness proven,
//   remaining == initial − sum AND sum ≤ initial AND remaining ≥ 0),
//   else NOT_EVALUABLE with the named gap. Failure priority A > B > C
//   is frozen (never JavaScript iteration order).
//
// Capture validity (BS-2): a capture is usable only with OBSERVED
// origin + 2xx + non-truncated + valid shape/schema per the accepted
// Phase 14 contract; valid `[]` is a REAL empty capture while
// no-observation / non-2xx / truncated / invalid are ABSENT/INVALID
// surfaces — never zero entities.

import type {
  AtMostOneAcceptedEffectParams,
  GenericInvariantInstance,
  ResourceConservationParams,
} from '@rupturegrid/engine';

// ---------------------------------------------------------------------
// Deterministic gap vocabulary (bounded, closed)
// ---------------------------------------------------------------------

export const GENERIC_EVALUATION_GAPS = {
  attributionGap: 'ATTRIBUTION_GAP',
  enumerationCompletenessGap: 'ENUMERATION_COMPLETENESS_GAP',
  scopeIncoherent: 'SCOPE_INCOHERENT',
  evidenceConflict: 'EVIDENCE_CONFLICT',
  captureInvalidOrAbsent: 'CAPTURE_INVALID_OR_ABSENT',
  evaluationSurfaceAbsent: 'EVALUATION_SURFACE_ABSENT',
  baselineMissing: 'BASELINE_MISSING',
  remainingMissing: 'REMAINING_MISSING',
  contestedEvidence: 'CONTESTED_IDENTITY',
  resourceMissing: 'RESOURCE_MISSING',
} as const;

export type GenericEvaluationGap =
  (typeof GENERIC_EVALUATION_GAPS)[keyof typeof GENERIC_EVALUATION_GAPS];

export type GenericInvariantVerdict = 'PASS' | 'FAIL' | 'NOT_EVALUABLE';

/** A candidate effect/summary entity with its minimal provenance. */
export interface GenericEvidenceEntity {
  readonly eventId: string;
  /** The event type IS the declared roleId (Phase 14 rule). */
  readonly roleId: string;
  readonly queryId: string;
  /** The DECLARED business payload (never RuptureGrid provenance). */
  readonly payload: Record<string, unknown>;
  readonly sourceObservationHashes: readonly string[];
  /** True when this row is in a contested identity group (derivation B-2/B-3). */
  readonly contested: boolean;
}

/** One ACTIVE causal relationship (Phase 14 active-graph semantics). */
export interface GenericActiveRelationship {
  readonly relationshipId: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly relationKind: string;
  readonly basis: 'identity-direct' | 'identity-chain';
}

/** Phase 14 capture provenance for one declared queryId. */
export interface GenericCaptureStatus {
  readonly queryId: string;
  readonly roleId: string;
  readonly valid: boolean;
  readonly captured: boolean;
  /** Deterministic reason when invalid/absent (platform vocabulary). */
  readonly reasonCode: string;
  readonly sourceObservationHashes: readonly string[];
}

export interface GenericEvaluationSubject {
  readonly subjectKey: string;
  readonly subjectEventIds: readonly string[];
  readonly subjectPayload: Record<string, unknown>;
}

/** The complete PURE evaluation input for one (run, instance, subject). */
export interface GenericEvaluationInput {
  readonly runId: string;
  readonly snapshotContentHash: string;
  readonly targetId: string;
  readonly instance: GenericInvariantInstance;
  /** Capture status for EVERY declared query (by queryId). */
  readonly captures: ReadonlyMap<string, GenericCaptureStatus>;
  /** Declared queries grouped by roleId (queriesForRole). */
  readonly queriesByRole: ReadonlyMap<string, readonly string[]>;
  /** All valid, normalized generic role events (contested flags included). */
  readonly entities: readonly GenericEvidenceEntity[];
  /** The ACTIVE generic causal graph of the run. */
  readonly activeRelationships: readonly GenericActiveRelationship[];
  /** The subject(s) this evaluation covers (exact identity binding). */
  readonly subject: GenericEvaluationSubject;
  /**
   * Event ids carrying a CONTESTED identity for the subject's role —
   * derivation-gap provenance that marks the surface incoherent.
   */
  readonly contestedEventIds: ReadonlySet<string>;
}

export interface GenericEvaluationResult {
  readonly verdict: GenericInvariantVerdict;
  /** Deterministic bounded human-readable reason (never target prose). */
  readonly reason: string;
  /** The closed gap vocabulary value when NOT_EVALUABLE. */
  readonly gap: GenericEvaluationGap | null;
  /** The frozen failure mechanism for FAIL (one deterministic primary). */
  readonly failureMechanism:
    | 'TOO_MANY_ACCEPTED_EFFECTS'
    | 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE'
    | 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING'
    | 'RESOURCE_CONSERVATION_MISMATCH'
    | null;
  /** The closed completeness basis (bounded; ≤ 64 chars per DB column). */
  readonly completenessBasis: string;
  /** Secret-free deterministic structured details (audit/recompute). */
  readonly details: Record<string, unknown>;
  /** Minimal actual proof/uncertainty provenance (deterministic). */
  readonly proofEventIds: readonly string[];
  readonly proofRelationshipIds: readonly string[];
  readonly proofObservationHashes: readonly string[];
}

/** The existing completeness bases stay bounded (DB VarChar(64)). */
export const GENERIC_COMPLETENESS_BASES = {
  observedTotal: 'observed-total',
  incomplete: 'incomplete',
} as const;

const REDACTED = '[Redacted]';

/** True when a scope/generation value can never be an equality proof. */
function isNonProvableValue(value: unknown): boolean {
  return value === undefined || value === null || value === REDACTED;
}

function declaredValue(entity: GenericEvidenceEntity, field: string): unknown {
  return entity.payload[field];
}

/**
 * Provenance-redaction guard: NEVER reads the `rupturegrid`
 * provenance sub-object as target business data (§15).
 */
function stripProvenance(entity: GenericEvidenceEntity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity.payload)) {
    if (key !== 'rupturegrid') {
      out[key] = value;
    }
  }
  return out;
}

/** Exact-equality on all bound scope/generation fields across surfaces. */
function coherentScope(
  values: Array<{ surface: string; payload: Record<string, unknown> }>,
  scope: { fields: readonly string[]; generationField?: string },
): {
  readonly coherent: boolean;
  readonly gap: GenericEvaluationGap | null;
  readonly detail: Record<string, unknown>;
} {
  for (const field of scope.fields) {
    let reference: { readonly surface: string; readonly value: unknown } | null = null;
    for (const entry of values) {
      const value = entry.payload[field];
      if (isNonProvableValue(value)) {
        return {
          coherent: false,
          gap: GENERIC_EVALUATION_GAPS.scopeIncoherent,
          detail: {
            field,
            surface: entry.surface,
            problem: value === undefined || value === null ? 'missing' : 'redacted',
          },
        };
      }
      if (reference === null) {
        reference = { surface: entry.surface, value };
        continue;
      }
      if (typeof reference.value !== typeof value || reference.value !== value) {
        return {
          coherent: false,
          gap: GENERIC_EVALUATION_GAPS.scopeIncoherent,
          detail: {
            field,
            surface: entry.surface,
            problem: 'mismatch',
          },
        };
      }
    }
  }
  if (scope.generationField !== undefined) {
    const field = scope.generationField;
    let reference: unknown = null;
    for (const entry of values) {
      const value = entry.payload[field];
      if (isNonProvableValue(value)) {
        return {
          coherent: false,
          gap: GENERIC_EVALUATION_GAPS.scopeIncoherent,
          detail: { field, surface: entry.surface, problem: 'missing-or-redacted-generation' },
        };
      }
      if (reference === null) {
        reference = value;
        continue;
      }
      if (typeof reference !== typeof value || reference !== value) {
        return {
          coherent: false,
          gap: GENERIC_EVALUATION_GAPS.scopeIncoherent,
          detail: { field, surface: entry.surface, problem: 'generation-mismatch' },
        };
      }
    }
  }
  return { coherent: true, gap: null, detail: {} };
}

/**
 * §2.4/§19/§25 summary/value convergence: ZERO ⇒ absent; ONE ⇒ usable;
 * MULTIPLE IDENTICAL ⇒ ONE converged fact (never summed, never
 * selected by order); MULTIPLE CONFLICTING ⇒ contradiction.
 */
function convergeValues(
  values: ReadonlyArray<{ readonly surface: string; readonly value: unknown }>,
): { readonly state: 'absent' | 'one' | 'conflict'; readonly value: unknown } {
  if (values.length === 0) {
    return { state: 'absent', value: undefined };
  }
  const first = values[0];
  if (first === undefined) {
    return { state: 'absent', value: undefined };
  }
  for (const entry of values.slice(1)) {
    if (typeof first.value !== typeof entry.value || first.value !== entry.value) {
      return { state: 'conflict', value: undefined };
    }
  }
  return { state: 'one', value: first.value };
}

/** Active-graph reachability: identity-backed directed path (§7). */
function attributable(
  fromEventId: string,
  toEventId: string,
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly GenericActiveRelationship[]>>,
): { readonly path: readonly GenericActiveRelationship[] } | null {
  if (fromEventId === toEventId) {
    return { path: [] };
  }
  const visited = new Set<string>([fromEventId]);
  const queue: Array<{ readonly id: string; readonly path: readonly GenericActiveRelationship[] }> =
    [{ id: fromEventId, path: [] }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const neighbors = adjacency.get(current.id);
    if (neighbors === undefined) {
      continue;
    }
    for (const [next, rels] of [...neighbors.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (visited.has(next)) {
        continue;
      }
      const rel = rels[0];
      if (rel === undefined) {
        continue;
      }
      const path = [...current.path, rel];
      if (next === toEventId) {
        return { path };
      }
      visited.add(next);
      queue.push({ id: next, path });
    }
  }
  return null;
}

function adjacencyOf(
  relationships: readonly GenericActiveRelationship[],
): Map<string, Map<string, GenericActiveRelationship[]>> {
  const adjacency = new Map<string, Map<string, GenericActiveRelationship[]>>();
  for (const rel of relationships) {
    const toMap = adjacency.get(rel.fromEventId) ?? new Map<string, GenericActiveRelationship[]>();
    const list = toMap.get(rel.toEventId) ?? [];
    list.push(rel);
    toMap.set(rel.toEventId, list);
    adjacency.set(rel.fromEventId, toMap);
  }
  return adjacency;
}

/** Capture-set validity helpers (BS-2 — no evaluator discretion). */
function captureInvalid(
  input: GenericEvaluationInput,
  queryIds: readonly string[],
): { readonly invalid: ReadonlyArray<{ readonly queryId: string; readonly reasonCode: string }> } {
  const invalid: Array<{ readonly queryId: string; readonly reasonCode: string }> = [];
  for (const queryId of queryIds) {
    const status = input.captures.get(queryId);
    if (status === undefined || !status.captured || !status.valid) {
      invalid.push({
        queryId,
        reasonCode: status === undefined ? 'NO_CAPTURE_PRESENT' : status.reasonCode,
      });
    }
  }
  return { invalid };
}

function queriesForRole(input: GenericEvaluationInput, roleId: string): readonly string[] {
  const ids = input.queriesByRole.get(roleId);
  return ids === undefined ? [] : [...ids].sort();
}

function gapResult(
  gap: GenericEvaluationGap,
  reason: string,
  extras: Record<string, unknown>,
  proof: {
    readonly eventIds?: readonly string[];
    readonly relationshipIds?: readonly string[];
    readonly observationHashes?: readonly string[];
  } = {},
): GenericEvaluationResult {
  return {
    verdict: 'NOT_EVALUABLE',
    reason,
    gap,
    failureMechanism: null,
    completenessBasis: GENERIC_COMPLETENESS_BASES.incomplete,
    details: { gap, ...extras },
    proofEventIds: proof.eventIds ?? [],
    proofRelationshipIds: proof.relationshipIds ?? [],
    proofObservationHashes: proof.observationHashes ?? [],
  };
}

// ---------------------------------------------------------------------
// atMostOneAcceptedEffect
// ---------------------------------------------------------------------

/**
 * The pure atMostOneAcceptedEffect evaluator (ADR-0023 §8 normative
 * order; rows 1–18 of the frozen truth table).
 */
export function evaluateAtMostOneAcceptedEffect(
  input: GenericEvaluationInput,
): GenericEvaluationResult {
  const params = input.instance.params as AtMostOneAcceptedEffectParams;
  const { subject } = input;
  const proofEventIds = new Set<string>(subject.subjectEventIds);
  const proofRelationshipIds = new Set<string>();
  const proofObservationHashes = new Set<string>();

  // ---- 0. Capture surfaces (BS-2): required sets are verdict-dependent.
  const subjectQueryIds = queriesForRole(input, params.subjectRole);
  const effectQueryIds = queriesForRole(input, params.effectRole);
  const summaryQueryIds = [params.completenessProof.queryId];
  const requiredForPass = [
    ...new Set([...subjectQueryIds, ...effectQueryIds, ...summaryQueryIds]),
  ].sort();
  const passCaptures = captureInvalid(input, requiredForPass);
  const summaryCapture = input.captures.get(params.completenessProof.queryId);

  // ---- 1. Gather candidate effects (exact match + equivalence + scope).
  const subjectIdentityValue = subject.subjectPayload[params.subjectIdentityField];
  if (isNonProvableValue(subjectIdentityValue)) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.scopeIncoherent,
      `the subject identity value on field "${params.subjectIdentityField}" is missing or redacted; the subject cannot be bound exactly`,
      { subjectKey: subject.subjectKey, subjectIdentityField: params.subjectIdentityField },
      { eventIds: [...proofEventIds] },
    );
  }
  const scopeCheckSubject = coherentScope(
    [{ surface: 'subject', payload: subject.subjectPayload }],
    params.scopeBinding,
  );
  if (!scopeCheckSubject.coherent) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.scopeIncoherent,
      `the subject surface is not scope/generation-coherent`,
      { subjectKey: subject.subjectKey, ...scopeCheckSubject.detail },
      { eventIds: [...proofEventIds] },
    );
  }

  const equivalenceFields = params.equivalenceFields;
  const subjectEquivalence = equivalenceFields.map((field) => ({
    field,
    value: subject.subjectPayload[field],
  }));
  if (subjectEquivalence.some((entry) => isNonProvableValue(entry.value))) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.scopeIncoherent,
      `the subject equivalence tuple carries a missing/redacted value; equivalence cannot be established exactly`,
      { subjectKey: subject.subjectKey },
      { eventIds: [...proofEventIds] },
    );
  }

  const effectEvents = input.entities.filter(
    (entity) => entity.roleId === params.effectRole && !entity.contested,
  );
  // Derivation-contested events (B-2/B-3) on the effect-role surface are
  // honored (§4): a contested identity on a bound surface marks the
  // surface incoherent. Their identity keys are forced into the
  // contested set even when their own payload appears convergent — the
  // derivation saw an identity conflict the payload alone may not show.
  // A contested event whose identity is not provable cannot be proven
  // foreign to this subject ⇒ the surface is incoherent unconditionally.
  let contestedUnidentifiableEffect = false;
  const derivationContestedEffectIdentities = new Set<string>();
  const derivationContestedEventsByIdentity = new Map<string, GenericEvidenceEntity[]>();
  const isEffectContested = (event: GenericEvidenceEntity): boolean =>
    event.roleId === params.effectRole && event.contested;
  for (const event of input.entities) {
    if (isEffectContested(event)) {
      proofEventIds.add(event.eventId);
      const identity = declaredValue(event, params.effectIdentityField);
      if (isNonProvableValue(identity)) {
        contestedUnidentifiableEffect = true;
      } else {
        const key = `${typeof identity}:${String(identity)}`;
        derivationContestedEffectIdentities.add(key);
        const list = derivationContestedEventsByIdentity.get(key) ?? [];
        list.push(event);
        derivationContestedEventsByIdentity.set(key, list);
      }
    }
  }

  // Semantic identity: effectIdentityField exact value (§16). Same
  // identity + same declared payload ⇒ CONVERGENT (count ONCE); same
  // identity + conflicting payload ⇒ CONTESTED (no guessed winner).
  const byEffectIdentity = new Map<string, GenericEvidenceEntity[]>();
  for (const event of effectEvents) {
    const identity = declaredValue(event, params.effectIdentityField);
    if (isNonProvableValue(identity)) {
      continue; // No semantic identity: never counted.
    }
    const key = `${typeof identity}:${String(identity)}`;
    const list = byEffectIdentity.get(key) ?? [];
    list.push(event);
    byEffectIdentity.set(key, list);
  }
  const distinctCandidates: Array<{
    readonly identity: string;
    readonly entity: GenericEvidenceEntity;
  }> = [];
  const contestedEffectIdentities: string[] = [];
  for (const [key, group] of [...byEffectIdentity.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const conflict = group
      .slice(1)
      .some(
        (event) =>
          JSON.stringify(stripProvenance(event)) !== JSON.stringify(stripProvenance(first)),
      );
    if (conflict) {
      contestedEffectIdentities.push(key);
      for (const event of group) {
        proofEventIds.add(event.eventId);
      }
      continue;
    }
    if (derivationContestedEffectIdentities.has(key)) {
      // B-2/B-3 contested this identity (identity-level conflict the
      // payload comparison cannot see); never counted.
      contestedEffectIdentities.push(key);
      for (const event of group) {
        proofEventIds.add(event.eventId);
      }
      continue;
    }
    distinctCandidates.push({ identity: key, entity: first });
  }
  // Derivation-contested identities with NO convergent group are still
  // contested inputs (their events were never grouped because the
  // contested flag excluded them); they must not vanish silently.
  for (const key of derivationContestedEffectIdentities) {
    if (!byEffectIdentity.has(key) && !contestedEffectIdentities.includes(key)) {
      contestedEffectIdentities.push(key);
    }
  }

  // Candidate filter: exact acceptedMatch, exact equivalence tuple,
  // coherent scope/generation with the subject (normative order 1).
  const candidates: Array<{ readonly identity: string; readonly entity: GenericEvidenceEntity }> =
    [];
  const nonEquivalentCount = { rejected: 0, scopeMismatch: 0 };
  for (const candidate of distinctCandidates) {
    if (
      declaredValue(candidate.entity, params.acceptedMatch.field) !== params.acceptedMatch.value ||
      typeof declaredValue(candidate.entity, params.acceptedMatch.field) !==
        typeof params.acceptedMatch.value
    ) {
      nonEquivalentCount.rejected += 1;
      continue; // Not accepted: never counted (row 8 / acceptedMatch exact).
    }
    let equivalent = true;
    for (const entry of subjectEquivalence) {
      const value = declaredValue(candidate.entity, entry.field);
      if (
        isNonProvableValue(value) ||
        typeof value !== typeof entry.value ||
        value !== entry.value
      ) {
        equivalent = false;
        break;
      }
    }
    if (!equivalent) {
      nonEquivalentCount.rejected += 1;
      continue;
    }
    const scopeCheckEffect = coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'effect', payload: candidate.entity.payload },
      ],
      params.scopeBinding,
    );
    if (!scopeCheckEffect.coherent) {
      nonEquivalentCount.scopeMismatch += 1;
      proofEventIds.add(candidate.entity.eventId);
      continue; // Foreign-scope effects are not candidates (§18).
    }
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    proofEventIds.add(candidate.entity.eventId);
    for (const hash of candidate.entity.sourceObservationHashes) {
      proofObservationHashes.add(hash);
    }
  }

  // ---- 2. Attribution via the ACTIVE graph (normative order 2, §7).
  const adjacency = adjacencyOf(input.activeRelationships);
  for (const rel of input.activeRelationships) {
    proofRelationshipIds.add(rel.relationshipId);
  }
  const attributed: Array<{
    readonly identity: string;
    readonly entity: GenericEvidenceEntity;
    readonly path: readonly GenericActiveRelationship[];
  }> = [];
  const unattributed: GenericEvidenceEntity[] = [];
  for (const candidate of candidates) {
    let found: { readonly path: readonly GenericActiveRelationship[] } | null = null;
    for (const subjectEventId of subject.subjectEventIds) {
      found = attributable(subjectEventId, candidate.entity.eventId, adjacency);
      if (found !== null) {
        for (const rel of found.path) {
          proofRelationshipIds.add(rel.relationshipId);
        }
        break;
      }
    }
    if (found === null) {
      unattributed.push(candidate.entity);
    } else {
      attributed.push({ identity: candidate.identity, entity: candidate.entity, path: found.path });
    }
  }

  // ---- 3. LOWER-BOUND FAIL (normative order 3): fully attributable
  // distinct candidates > max ⇒ FAIL, even without completeness. Every
  // counted proof effect has valid evidence, identity, attribution,
  // scope (guaranteed by construction above).
  if (attributed.length > params.maxAcceptedEffects) {
    // Deterministic minimal violating subset: canonical sorted effect
    // identity (NOT DB order); max+1 effects prove count > max.
    const sortedAttributed = [...attributed].sort((a, b) => (a.identity < b.identity ? -1 : 1));
    const violatingSubset = sortedAttributed.slice(0, params.maxAcceptedEffects + 1);
    const unitsByProof = violatingSubset.map((entry) => entry.identity);
    // N-6 (frozen detail shape): each minimal proof effect is ONE intact
    // tuple (identity + event id + per-effect attribution + source
    // provenance), canonically ordered by effect identity — never a
    // separately sorted identity list.
    const minimalProofEffects = violatingSubset.map((entry) => ({
      effectIdentity: entry.identity,
      eventId: entry.entity.eventId,
      relationshipIds: entry.path.map((rel) => rel.relationshipId).sort(),
      observationHashes: [...entry.entity.sourceObservationHashes].sort(),
    }));
    // Contradiction precedence (§23): if the conflict undermines the
    // proof basis (contested subject/effect identity), it is NOT a
    // FAIL — but contested SUBJECT identity is checked below; a
    // contested effect identity that was EXCLUDED from candidates
    // cannot undermine this proof (those events never entered the
    // candidate set). If the SUBJECT identity is contested, fall to
    // NOT_EVALUABLE (checked here explicitly, not by branch order).
    if (input.contestedEventIds.has(subject.subjectEventIds[0] ?? '')) {
      return gapResult(
        GENERIC_EVALUATION_GAPS.contestedEvidence,
        `the subject identity is contested; a lower-bound FAIL cannot rest on a contradicted subject identity`,
        { subjectKey: subject.subjectKey },
        { eventIds: [...proofEventIds] },
      );
    }
    const sortedEventIds = [...proofEventIds].sort();
    const sortedRelIds = [...proofRelationshipIds].sort();
    const sortedHashes = [...proofObservationHashes].sort();
    return {
      verdict: 'FAIL',
      reason: `${String(attributed.length)} distinct accepted equivalent effects attributed to subject ${subject.subjectKey} exceed maxAcceptedEffects=${String(params.maxAcceptedEffects)} (lower-bound-safe; basis: active identity graph)`,
      gap: null,
      failureMechanism: 'TOO_MANY_ACCEPTED_EFFECTS',
      completenessBasis: GENERIC_COMPLETENESS_BASES.incomplete,
      details: {
        failureMechanism: 'TOO_MANY_ACCEPTED_EFFECTS',
        registryVersion: input.instance.registryVersion,
        kind: input.instance.kind,
        subjectKey: subject.subjectKey,
        subjectIdentityField: params.subjectIdentityField,
        maxAcceptedEffects: params.maxAcceptedEffects,
        attributableEffectCount: attributed.length,
        countedEffectIdentities: unitsByProof,
        minimalProofEffects,
        allAttributableEffectIdentities: sortedAttributed.map((entry) => entry.identity),
        completenessProofQueryId: params.completenessProof.queryId,
        captureInvalid: passCaptures.invalid,
        contestedEffectIdentities,
      },
      proofEventIds: sortedEventIds,
      proofRelationshipIds: sortedRelIds,
      proofObservationHashes: sortedHashes,
    };
  }

  // ---- Subject identity contested ⇒ NOT_EVALUABLE (row 9). A
  // contested subject identity can never support a FAIL either (the
  // lower-bound branch above checks it explicitly, §23).
  if (input.contestedEventIds.has(subject.subjectEventIds[0] ?? '')) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.contestedEvidence,
      `the subject identity is contested (conflicting identity payloads); no verdict can rest on a contradicted subject`,
      { subjectKey: subject.subjectKey },
      { eventIds: [...proofEventIds] },
    );
  }
  if (contestedUnidentifiableEffect) {
    // A derivation-contested effect event whose semantic identity is not
    // provable cannot be proven foreign to this subject ⇒ the effect
    // surface is incoherent unconditionally (§4). Never guessed around.
    return gapResult(
      GENERIC_EVALUATION_GAPS.contestedEvidence,
      `a derivation-contested effect event carries no provable semantic identity; the effect surface is incoherent and no winner is guessed`,
      { subjectKey: subject.subjectKey },
      { eventIds: [...proofEventIds] },
    );
  }
  if (contestedEffectIdentities.length > 0) {
    // Contested same-identity groups are NOT_EVALUABLE inputs (§8 rule
    // 1: "conflicting payloads ⇒ contested ⇒ NOT_EVALUABLE inputs")
    // whenever ANY observed payload of the contested identity would
    // have entered the candidate set for this subject (acceptedMatch +
    // equivalence + coherent scope). The identity affects the verdict
    // precisely because no member is counted while a winner cannot be
    // guessed; groups that could never become candidates for this
    // subject (wrong acceptedMatch, foreign equivalence/scope) do not
    // affect the verdict and are not gaps.
    const affectingContested: string[] = [];
    for (const key of contestedEffectIdentities) {
      const group = [
        ...(byEffectIdentity.get(key) ?? []),
        ...(derivationContestedEventsByIdentity.get(key) ?? []),
      ];
      if (group.length === 0) {
        continue;
      }
      const candidateWorthy = group.some((event) => {
        if (
          declaredValue(event, params.acceptedMatch.field) !== params.acceptedMatch.value ||
          typeof declaredValue(event, params.acceptedMatch.field) !==
            typeof params.acceptedMatch.value
        ) {
          return false;
        }
        for (const entry of subjectEquivalence) {
          const value = declaredValue(event, entry.field);
          if (
            isNonProvableValue(value) ||
            typeof value !== typeof entry.value ||
            value !== entry.value
          ) {
            return false;
          }
        }
        return coherentScope(
          [
            { surface: 'subject', payload: subject.subjectPayload },
            { surface: 'effect', payload: event.payload },
          ],
          params.scopeBinding,
        ).coherent;
      });
      if (candidateWorthy) {
        affectingContested.push(key);
      }
    }
    if (affectingContested.length > 0) {
      return gapResult(
        GENERIC_EVALUATION_GAPS.contestedEvidence,
        `a semantic effect identity appears with conflicting payloads (contested); no winning record is guessed (ADR-0017 Decision 3)`,
        { subjectKey: subject.subjectKey, contestedEffectIdentities: affectingContested.sort() },
        { eventIds: [...proofEventIds] },
      );
    }
  }

  // ---- Normative rule 2 (attribution gap, no lower-bound FAIL):
  // unattributable candidates with attributable ≤ max ⇒ NOT_EVALUABLE
  // (ATTRIBUTION_GAP) — never silently dropped to manufacture a lower
  // count and never PASSed over.
  if (unattributed.length > 0) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.attributionGap,
      `${String(unattributed.length)} accepted equivalent effect(s) cannot be attributed to the subject via the active identity graph; the gap is reported honestly (never dropped, never guessed around)`,
      {
        subjectKey: subject.subjectKey,
        unattributableEffectEventIds: unattributed.map((entity) => entity.eventId).sort(),
        attributableEffectCount: attributed.length,
      },
      { eventIds: [...proofEventIds] },
    );
  }

  // ---- 4. Contradictory completeness evidence (normative order 4).
  if (summaryCapture === undefined || !summaryCapture.captured || !summaryCapture.valid) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent,
      `the completeness summary query "${params.completenessProof.queryId}" capture is absent or invalid; a missing/failed capture is never an empty enumeration`,
      {
        subjectKey: subject.subjectKey,
        completenessProofQueryId: params.completenessProof.queryId,
        captureReason: summaryCapture?.reasonCode ?? 'NO_CAPTURE_PRESENT',
      },
      { eventIds: [...proofEventIds] },
    );
  }
  if (passCaptures.invalid.length > 0) {
    // Required capture set (all subject-role + effect-role queries +
    // the summary query) is not fully valid ⇒ never PASS.
    // Lower-bound FAIL already fired above when provable; here the
    // remaining paths cannot PASS on a partial surface.
    return gapResult(
      GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent,
      `the required capture set for PASS is incomplete; an absent/invalid surface is never interpreted as empty (rows 14/17/18 capture-set rule)`,
      {
        subjectKey: subject.subjectKey,
        invalidQueries: passCaptures.invalid,
        requiredQueryIds: requiredForPass,
      },
      { eventIds: [...proofEventIds] },
    );
  }

  // Bound summaries: subjectField exact-equality to the subject
  // identity, plus scope/generation exact-equality (§4/§2.4).
  const summaryEntities = input.entities.filter(
    (entity) => input.captures.get(entity.queryId)?.queryId === params.completenessProof.queryId,
  );
  const boundSummaries: Array<{ readonly entity: GenericEvidenceEntity; readonly total: unknown }> =
    [];
  // Foreign = bound to a DIFFERENT subject/scope/generation (§2.4):
  // such summaries are not candidates for this binding — subject-field
  // mismatch OR scope/generation incoherence with the subject.
  const foreignSummaries: number = summaryEntities.filter((entity) => {
    const subjectValue = declaredValue(entity, params.completenessProof.subjectField);
    if (
      typeof subjectValue !== typeof subjectIdentityValue ||
      subjectValue !== subjectIdentityValue
    ) {
      return true;
    }
    return !coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'summary', payload: entity.payload },
      ],
      params.scopeBinding,
    ).coherent;
  }).length;
  for (const entity of summaryEntities) {
    const subjectValue = declaredValue(entity, params.completenessProof.subjectField);
    if (
      typeof subjectValue !== typeof subjectIdentityValue ||
      subjectValue !== subjectIdentityValue
    ) {
      continue; // Foreign subject: not a candidate for THIS binding (§2.4).
    }
    const scopeCheckSummary = coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'summary', payload: entity.payload },
      ],
      params.scopeBinding,
    );
    if (!scopeCheckSummary.coherent) {
      // §2.4 (frozen): a summary bound to a DIFFERENT scope/generation
      // does not satisfy this subject's completeness proof and is not
      // a winner/loser candidate for this binding — it is skipped
      // exactly like a foreign-subject summary. Zero matching
      // summaries then leaves completeness unproven
      // (ENUMERATION_COMPLETENESS_GAP), never SCOPE_INCOHERENT.
      continue;
    }
    if (entity.contested) {
      return gapResult(
        GENERIC_EVALUATION_GAPS.contestedEvidence,
        `the bound completeness summary is contested; contradictory summaries are never resolved by selection`,
        { subjectKey: subject.subjectKey, summaryEventId: entity.eventId },
        { eventIds: [...proofEventIds, entity.eventId] },
      );
    }
    boundSummaries.push({
      entity,
      total: declaredValue(entity, params.completenessProof.totalField),
    });
    proofEventIds.add(entity.eventId);
    for (const hash of entity.sourceObservationHashes) {
      proofObservationHashes.add(hash);
    }
  }

  // ---- Cardinality (BS-1): ZERO absent; MULTIPLE IDENTICAL converge;
  // MULTIPLE CONFLICTING ⇒ EVIDENCE_CONFLICT (no sum/first/last/newest).
  const totals = boundSummaries.map((entry) => ({
    surface: entry.entity.eventId,
    value: entry.total,
  }));
  const converged = convergeValues(totals);
  if (converged.state === 'conflict') {
    // Contradiction confined to enumeration-total evidence cannot undo
    // an already-proven lower-bound FAIL (fired above) — reached only
    // when no FAIL was proven, so NOT_EVALUABLE.
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `bound completeness summaries disagree on the observed total (no winner is selected; §2.4)`,
      {
        subjectKey: subject.subjectKey,
        summaryTotals: totals.map((entry) => entry.value),
        conflictingSummaryEventIds: boundSummaries.map((entry) => entry.entity.eventId).sort(),
      },
      { eventIds: [...proofEventIds] },
    );
  }
  if (converged.state === 'absent' || converged.value === undefined) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.enumerationCompletenessGap,
      `no valid bound completeness summary exists for this subject/scope; a valid [] capture is a REAL empty capture but proves completeness only through a bound total=0 summary`,
      {
        subjectKey: subject.subjectKey,
        completenessProofQueryId: params.completenessProof.queryId,
        foreignSummaries,
      },
      { eventIds: [...proofEventIds] },
    );
  }
  const observedTotal = converged.value;
  if (
    typeof observedTotal !== 'number' ||
    !Number.isInteger(observedTotal) ||
    !Number.isSafeInteger(observedTotal)
  ) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `the observed total is negative or type-invalid; a count is always a non-negative safe integer (§2/§19)`,
      { subjectKey: subject.subjectKey, observedTotal },
      { eventIds: [...proofEventIds] },
    );
  }
  if (observedTotal < 0) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `the observed total is negative; a negative total is contradictory evidence, never a count`,
      { subjectKey: subject.subjectKey, observedTotal },
      { eventIds: [...proofEventIds] },
    );
  }

  // observedCount = DISTINCT effect identities satisfying ALL filters
  // (§20) — the attributed candidate count above.
  const observedCount = attributed.length;
  if (observedCount > observedTotal) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `observedCount > observedTotal: more matching effects were observed than the summary claims (contradiction; MUST NOT PASS)`,
      {
        subjectKey: subject.subjectKey,
        observedCount,
        observedTotal,
        countedEffectIdentities: attributed.map((entry) => entry.identity).sort(),
      },
      { eventIds: [...proofEventIds], relationshipIds: [...proofRelationshipIds] },
    );
  }

  // ---- 5. PASS requires completeness proven: observedCount ==
  // observedTotal — then count ≤ max ⇒ PASS. observedCount <
  // observedTotal ⇒ ENUMERATION_COMPLETENESS_GAP.
  if (observedCount !== observedTotal) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.enumerationCompletenessGap,
      `enumeration incomplete: observedCount (${String(observedCount)}) != observedTotal (${String(observedTotal)}); uncertainty is never converted into PASS`,
      { subjectKey: subject.subjectKey, observedCount, observedTotal },
      { eventIds: [...proofEventIds], relationshipIds: [...proofRelationshipIds] },
    );
  }
  if (observedCount > params.maxAcceptedEffects) {
    // Unreachable (rule 3 fired earlier), kept as a closed-form guard:
    // never PASS above max.
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `the proven count exceeds maxAcceptedEffects`,
      {
        subjectKey: subject.subjectKey,
        observedCount,
        maxAcceptedEffects: params.maxAcceptedEffects,
      },
      { eventIds: [...proofEventIds] },
    );
  }
  const sortedEventIds = [...proofEventIds].sort();
  const sortedRelIds = [...proofRelationshipIds].sort();
  const sortedHashes = [...proofObservationHashes].sort();
  return {
    verdict: 'PASS',
    reason:
      observedCount === 0
        ? `zero matching accepted effects observed and the bound summary proves observedTotal=0 for the same subject/scope/generation; 0 ≤ ${String(params.maxAcceptedEffects)} (§3 zero-effect completeness)`
        : `exactly ${String(observedCount)} accepted equivalent effect(s) attributed and enumeration proven complete (observedCount == observedTotal == ${String(observedTotal)}; ≤ ${String(params.maxAcceptedEffects)})`,
    gap: null,
    failureMechanism: null,
    completenessBasis: GENERIC_COMPLETENESS_BASES.observedTotal,
    details: {
      registryVersion: input.instance.registryVersion,
      kind: input.instance.kind,
      subjectKey: subject.subjectKey,
      subjectIdentityField: params.subjectIdentityField,
      maxAcceptedEffects: params.maxAcceptedEffects,
      observedCount,
      observedTotal,
      countedEffectIdentities: attributed.map((entry) => entry.identity).sort(),
      completenessProof: {
        kind: params.completenessProof.kind,
        queryId: params.completenessProof.queryId,
        subjectField: params.completenessProof.subjectField,
        totalField: params.completenessProof.totalField,
      },
      requiredQueryIds: requiredForPass,
      foreignSummaries,
      contestedEffectIdentities,
    },
    proofEventIds: sortedEventIds,
    proofRelationshipIds: sortedRelIds,
    proofObservationHashes: sortedHashes,
  };
}

// ---------------------------------------------------------------------
// resourceConservation
// ---------------------------------------------------------------------

/** One converged integer fact with its provenance surfaces. */
interface IntegerFact {
  readonly value: number;
  readonly eventIds: readonly string[];
  readonly observationHashes: readonly string[];
}

/**
 * The pure resourceConservation evaluator (ADR-0023 §8 normative order;
 * rows 1–20 of the frozen truth table). Failure priority A > B > C is
 * implemented explicitly, never by iteration order.
 */
export function evaluateResourceConservation(
  input: GenericEvaluationInput,
): GenericEvaluationResult {
  const params = input.instance.params as ResourceConservationParams;
  const { subject } = input;
  const proofEventIds = new Set<string>(subject.subjectEventIds);
  const proofRelationshipIds = new Set<string>();
  const proofObservationHashes = new Set<string>();

  const resourceIdentityValue = subject.subjectPayload[params.resourceIdentityField];
  if (isNonProvableValue(resourceIdentityValue)) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.scopeIncoherent,
      `the resource identity value on field "${params.resourceIdentityField}" is missing or redacted`,
      { subjectKey: subject.subjectKey, resourceIdentityField: params.resourceIdentityField },
      { eventIds: [...proofEventIds] },
    );
  }
  if (input.contestedEventIds.has(subject.subjectEventIds[0] ?? '')) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.contestedEvidence,
      `the resource identity is contested (conflicting resource payloads); no verdict can rest on a contradicted resource identity`,
      { subjectKey: subject.subjectKey },
      { eventIds: [...proofEventIds] },
    );
  }

  const baselineQueryIds = queriesForRole(input, params.baselineRole);
  const remainingQueryIds = queriesForRole(input, params.remainingRole);
  const consumptionQueryIds = queriesForRole(input, params.consumptionEffectRole);
  const summaryQueryIds = [params.completenessProof.queryId];
  const requiredForAuthorityOrPass = [
    ...new Set([
      ...baselineQueryIds,
      ...remainingQueryIds,
      ...consumptionQueryIds,
      ...summaryQueryIds,
    ]),
  ].sort();

  // ---- 1. Baseline authority (frozen: ALL queriesForRole(baselineRole)
  // valid for the bound resource/scope; converged; never order/selection).
  // B-1/B-2 (frozen, ADR-0023 §8): a baseline gap/conflict is RECORDED
  // here — it voids baseline authority (Case A/C/PASS) but NEVER
  // terminates the verdict before Case B. Termination happens only at
  // rule 9, after Case A and Case B had their independent-proof
  // opportunities.
  const baselineInvalid = captureInvalid(input, baselineQueryIds);
  let baselineFact: IntegerFact | null = null;
  let baselineConflict: {
    readonly code: string;
    readonly problem: string;
    readonly baselineValue?: unknown;
    readonly baselineValues?: readonly unknown[];
    readonly baselineEventIds: readonly string[];
  } | null = null;
  // §4: a derivation-contested baseline marks the baseline surface
  // incoherent — its fact can never be an authoritative proof basis.
  const contestedBaseline = input.entities.some(
    (entity) => entity.roleId === params.baselineRole && entity.contested,
  );
  if (baselineInvalid.invalid.length > 0) {
    // Baseline authority NOT established. Case A can never fire without
    // it (ADR-0023 §8: still required). Baseline missing ⇒ named gap.
  } else {
    const boundBaselines: Array<{
      readonly entity: GenericEvidenceEntity;
      readonly value: unknown;
    }> = [];
    for (const entity of input.entities) {
      if (entity.roleId !== params.baselineRole || entity.contested) {
        continue;
      }
      const identityValue = declaredValue(entity, params.resourceIdentityField);
      if (
        typeof identityValue !== typeof resourceIdentityValue ||
        identityValue !== resourceIdentityValue
      ) {
        continue;
      }
      const scopeCheck = coherentScope(
        [
          { surface: 'subject', payload: subject.subjectPayload },
          { surface: 'baseline', payload: entity.payload },
        ],
        params.scopeBinding,
      );
      if (!scopeCheck.coherent) {
        continue; // Foreign scope: not a candidate (never compared).
      }
      boundBaselines.push({ entity, value: declaredValue(entity, params.baselineUnitsField) });
      proofEventIds.add(entity.eventId);
      for (const hash of entity.sourceObservationHashes) {
        proofObservationHashes.add(hash);
      }
    }
    const converged = convergeValues(
      boundBaselines.map((entry) => ({ surface: entry.entity.eventId, value: entry.value })),
    );
    if (converged.state === 'conflict') {
      // B-1/B-2 (frozen): a conflicting baseline is contradictory business
      // evidence — recorded, never authoritative (Case A/C/PASS), and
      // never terminal against an independent Case B proof (ADR-0023 §8).
      baselineConflict = {
        code: 'EVIDENCE_CONFLICT',
        problem: 'conflicting-baseline-values',
        baselineValues: boundBaselines.map((entry) => entry.value),
        baselineEventIds: boundBaselines.map((entry) => entry.entity.eventId).sort(),
      };
    }
    if (converged.state === 'one') {
      const value = converged.value;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        // B-2 (frozen): a baseline MUST be a non-negative safe integer to
        // serve as an authoritative business fact; a negative (or
        // type-invalid) baseline is contradictory business evidence —
        // recorded, never used by Case A/C/PASS, and never terminal
        // against an independent Case B proof (ADR-0023 §8).
        baselineConflict = {
          code: 'EVIDENCE_CONFLICT',
          problem:
            typeof value === 'number' && value < 0
              ? 'negative-baseline-units'
              : 'type-invalid-baseline-units',
          baselineValue: value,
          baselineEventIds: boundBaselines.map((entry) => entry.entity.eventId).sort(),
        };
      } else {
        baselineFact = {
          value,
          eventIds: boundBaselines.map((entry) => entry.entity.eventId).sort(),
          observationHashes: boundBaselines.flatMap((entry) => [
            ...entry.entity.sourceObservationHashes,
          ]),
        };
      }
    }
  }
  if (contestedBaseline) {
    // Case A/C/PASS all rest on the baseline as proof basis; a
    // contested baseline identity undermines them (§8 rule 1:
    // "coherent authoritative baseline (§5)" is still required).
    baselineFact = null;
  }

  // ---- 2. Candidate consumption effects: exact match + exact resource
  // identity + coherent scope; distinct by consumptionEffectIdentityField;
  // convergent duplicates collapse; conflicting payloads ⇒ contested.
  const consumptionEvents = input.entities.filter(
    (entity) => entity.roleId === params.consumptionEffectRole && !entity.contested,
  );
  // Derivation-contested consumption events (B-2/B-3) on the bound
  // surface are honored (§4): their identities are forced into the
  // contested set even when their payload appears convergent, and an
  // unidentifiable contested reservation can never be proven foreign.
  let contestedUnidentifiableConsumption = false;
  const derivationContestedConsumptionIdentities = new Set<string>();
  const derivationContestedConsumptionEventsByIdentity = new Map<string, GenericEvidenceEntity[]>();
  for (const event of input.entities) {
    if (event.roleId === params.consumptionEffectRole && event.contested) {
      proofEventIds.add(event.eventId);
      const identity = declaredValue(event, params.consumptionEffectIdentityField);
      if (isNonProvableValue(identity)) {
        contestedUnidentifiableConsumption = true;
      } else {
        const key = `${typeof identity}:${String(identity)}`;
        derivationContestedConsumptionIdentities.add(key);
        const list = derivationContestedConsumptionEventsByIdentity.get(key) ?? [];
        list.push(event);
        derivationContestedConsumptionEventsByIdentity.set(key, list);
      }
    }
  }
  const byConsumptionIdentity = new Map<string, GenericEvidenceEntity[]>();
  for (const event of consumptionEvents) {
    const identity = declaredValue(event, params.consumptionEffectIdentityField);
    if (isNonProvableValue(identity)) {
      continue;
    }
    const identityValue = declaredValue(event, params.resourceIdentityField);
    if (
      typeof identityValue !== typeof resourceIdentityValue ||
      identityValue !== resourceIdentityValue
    ) {
      continue; // Exact resource filtering: foreign resources never contribute.
    }
    const key = `${typeof identity}:${String(identity)}`;
    const list = byConsumptionIdentity.get(key) ?? [];
    list.push(event);
    byConsumptionIdentity.set(key, list);
  }
  const distinctConsumption: Array<{
    readonly identity: string;
    readonly entity: GenericEvidenceEntity;
  }> = [];
  const contestedConsumptionIdentities: string[] = [];
  for (const [key, group] of [...byConsumptionIdentity.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const conflict = group
      .slice(1)
      .some(
        (event) =>
          JSON.stringify(stripProvenance(event)) !== JSON.stringify(stripProvenance(first)),
      );
    if (conflict) {
      contestedConsumptionIdentities.push(key);
      for (const event of group) {
        proofEventIds.add(event.eventId);
      }
      continue;
    }
    if (derivationContestedConsumptionIdentities.has(key)) {
      // B-2/B-3 contested this reservation identity (identity-level
      // conflict the payload comparison cannot see); never counted.
      contestedConsumptionIdentities.push(key);
      for (const event of group) {
        proofEventIds.add(event.eventId);
      }
      continue;
    }
    distinctConsumption.push({ identity: key, entity: first });
  }
  // Derivation-contested identities with NO convergent group are still
  // contested inputs (their events were excluded from grouping); they
  // must not vanish silently — otherwise a contested reservation could
  // be silently dropped into a false complete-enumeration PASS.
  for (const key of derivationContestedConsumptionIdentities) {
    if (!byConsumptionIdentity.has(key) && !contestedConsumptionIdentities.includes(key)) {
      contestedConsumptionIdentities.push(key);
    }
  }

  const acceptedConsumption: Array<{
    readonly identity: string;
    readonly entity: GenericEvidenceEntity;
    readonly units: number;
  }> = [];
  const consumptionScopeMismatch: string[] = [];
  const consumptionTypeInvalid: string[] = [];
  // B-2 (frozen): accepted consumption effects whose units are negative —
  // contradictory business evidence, excluded from the conservation sum.
  const consumptionNegativeUnits: Array<{
    readonly identity: string;
    readonly units: number;
  }> = [];
  for (const candidate of distinctConsumption) {
    const payload = candidate.entity.payload;
    const matchValue = declaredValue(candidate.entity, params.consumptionAcceptedMatch.field);
    if (
      matchValue !== params.consumptionAcceptedMatch.value ||
      typeof matchValue !== typeof params.consumptionAcceptedMatch.value
    ) {
      continue; // Not accepted: never counted.
    }
    const units = declaredValue(candidate.entity, params.consumptionUnitsField);
    if (typeof units !== 'number' || !Number.isInteger(units) || !Number.isSafeInteger(units)) {
      // A float/numeric-string unit value can never enter through the
      // capture seam; a stored violation is contradictory evidence.
      consumptionTypeInvalid.push(candidate.identity);
      proofEventIds.add(candidate.entity.eventId);
      continue;
    }
    if (units < 0) {
      // B-2 (frozen): a counted accepted consumption effect's units MUST
      // be a non-negative safe integer; a negative unit value is
      // contradictory business evidence — never summed, never
      // reinterpreted as release/restock, never coerced (ADR-0018/ADR-0023
      // §8 business-unit sign discipline). It is excluded from
      // acceptedReservedUnits and blocks Case C/PASS unless an
      // independent Case A/B FAIL already fired.
      consumptionNegativeUnits.push({ identity: candidate.identity, units });
      proofEventIds.add(candidate.entity.eventId);
      continue;
    }
    const scopeCheck = coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'consumption', payload },
      ],
      params.scopeBinding,
    );
    if (!scopeCheck.coherent) {
      consumptionScopeMismatch.push(candidate.identity);
      proofEventIds.add(candidate.entity.eventId);
      continue;
    }
    acceptedConsumption.push({ identity: candidate.identity, entity: candidate.entity, units });
    proofEventIds.add(candidate.entity.eventId);
    for (const hash of candidate.entity.sourceObservationHashes) {
      proofObservationHashes.add(hash);
    }
  }

  // ---- 3. Attribution over the ACTIVE graph (§7): each counted
  // reservation must be attributable from a non-consumption-role
  // ancestor carrying the resource/subject identity basis.
  const adjacency = adjacencyOf(input.activeRelationships);
  for (const rel of input.activeRelationships) {
    proofRelationshipIds.add(rel.relationshipId);
  }
  const attributedConsumption: typeof acceptedConsumption = [];
  const unattributedConsumption: string[] = [];
  for (const candidate of acceptedConsumption) {
    let found = false;
    // Walk from declared NON-consumption-role ancestors: subject-role
    // events and any role that is not the consumption role.
    const subjectEventIds = subject.subjectEventIds;
    for (const subjectEventId of subjectEventIds) {
      const path = attributable(subjectEventId, candidate.entity.eventId, adjacency);
      if (path !== null) {
        found = true;
        for (const step of path.path) {
          proofRelationshipIds.add(step.relationshipId);
        }
        break;
      }
    }
    if (found) {
      attributedConsumption.push(candidate);
    } else {
      unattributedConsumption.push(candidate.identity);
      proofEventIds.add(candidate.entity.eventId);
    }
  }

  // Distinct accepted attributable sum (§24): SUM(units) over DISTINCT
  // identities — duplicate observations never double-sum.
  const acceptedReservedUnits = attributedConsumption.reduce(
    (total, entry) => total + entry.units,
    0,
  );

  // ---- 4. Remaining-state evidence (observed; authority judged below).
  const remainingInvalid = captureInvalid(input, remainingQueryIds);
  const boundRemaining: Array<{ readonly entity: GenericEvidenceEntity; readonly value: unknown }> =
    [];
  // §4: a derivation-contested remaining surface is incoherent — its
  // fact is never authoritative and can never prove Case B.
  const contestedRemaining = input.entities.some(
    (entity) => entity.roleId === params.remainingRole && entity.contested,
  );
  for (const entity of input.entities) {
    if (entity.roleId !== params.remainingRole || entity.contested) {
      continue;
    }
    const identityValue = declaredValue(entity, params.resourceIdentityField);
    if (
      typeof identityValue !== typeof resourceIdentityValue ||
      identityValue !== resourceIdentityValue
    ) {
      continue;
    }
    const scopeCheck = coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'remaining', payload: entity.payload },
      ],
      params.scopeBinding,
    );
    if (!scopeCheck.coherent) {
      continue; // Not bound to THIS resource/scope ⇒ never FAIL material.
    }
    boundRemaining.push({ entity, value: declaredValue(entity, params.remainingUnitsField) });
    proofEventIds.add(entity.eventId);
    for (const hash of entity.sourceObservationHashes) {
      proofObservationHashes.add(hash);
    }
  }
  const convergedRemaining = convergeValues(
    boundRemaining.map((entry) => ({ surface: entry.entity.eventId, value: entry.value })),
  );
  let remainingFact: number | null = null;
  let remainingContradiction: unknown = null;
  if (convergedRemaining.state === 'conflict') {
    remainingContradiction = boundRemaining.map((entry) => entry.value);
  } else if (convergedRemaining.state === 'one') {
    const value = convergedRemaining.value;
    if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) {
      remainingFact = value; // NEGATIVE allowed — that is exactly Case B (§32).
    } else {
      remainingContradiction = value;
    }
  }
  if (contestedRemaining) {
    remainingFact = null; // Case B can never fire on a contradicted surface.
  }

  // ---- Remaining-surface authority (Case B gate, §8/§26): ALL declared
  // remaining-role queries must be valid before authority is established.
  const remainingSurfaceAuthoritative = remainingInvalid.invalid.length === 0;
  const negativeRemainingProven =
    remainingSurfaceAuthoritative && remainingFact !== null && remainingFact < 0;

  // ---- 5. CASE A (priority 1): sum of DISTINCT accepted attributable
  // consumption units > baseline ⇒ FAIL. Requires coherent authoritative
  // baseline + exact identity + coherent scope + valid counted evidence;
  // does NOT require complete consumption enumeration or remaining state.
  if (baselineFact !== null && attributedConsumption.length > 0) {
    // A contested/invalid unit value that could INCREASE the sum would
    // undermine the lower bound only if the proof needs it — it does
    // not: the proven sum uses only valid attributable effects, and
    // additional unseen consumption can never undo the violation. But
    // if the contradiction touches the resource identity or required
    // scope/generation, the proof is not independent (§23). Contested
    // consumption identities here carry the SAME resource identity and
    // scope filter, so they cannot undermine identity/scope; they are
    // recorded honestly in details.
    if (acceptedReservedUnits > baselineFact.value) {
      const sortedByUnits = [...attributedConsumption].sort((a, b) =>
        a.identity < b.identity ? -1 : 1,
      );
      // Minimal proof subset: canonically ordered effects whose running
      // sum first exceeds the baseline (deterministic, NOT DB order).
      const minimal: typeof sortedByUnits = [];
      let running = 0;
      for (const entry of sortedByUnits) {
        if (running > baselineFact.value) {
          break;
        }
        minimal.push(entry);
        running += entry.units;
      }
      // N-6 (frozen detail shape): each minimal proof effect is ONE
      // intact tuple — identity, units, event id, and provenance never
      // separated, so no consumer can mispair an amount with an
      // identity. The running sum above uses each tuple's OWN units.
      const minimalProofEffects = minimal.map((entry) => ({
        effectIdentity: entry.identity,
        units: entry.units,
        eventId: entry.entity.eventId,
        relationshipIds:
          attributable(subject.subjectEventIds[0] ?? '', entry.entity.eventId, adjacency)
            ?.path.map((rel) => rel.relationshipId)
            .sort() ?? [],
        observationHashes: [...entry.entity.sourceObservationHashes].sort(),
      }));
      const sortedEventIds = [...proofEventIds].sort();
      const sortedRelIds = [...proofRelationshipIds].sort();
      const sortedHashes = [...proofObservationHashes].sort();
      return {
        verdict: 'FAIL',
        reason: `accepted attributable consumption (${String(acceptedReservedUnits)} units over ${String(attributedConsumption.length)} distinct effect(s)) exceeds the authoritative baseline (${String(baselineFact.value)} units) for resource ${subject.subjectKey} (Case A, lower-bound-safe)`,
        gap: null,
        failureMechanism: 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE',
        completenessBasis: GENERIC_COMPLETENESS_BASES.incomplete,
        details: {
          failureMechanism: 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE',
          registryVersion: input.instance.registryVersion,
          kind: input.instance.kind,
          subjectKey: subject.subjectKey,
          resourceIdentityField: params.resourceIdentityField,
          baselineValue: baselineFact.value,
          acceptedReservedUnits,
          consumptionEffectIdentities: attributedConsumption.map((entry) => entry.identity).sort(),
          consumptionUnitValues: attributedConsumption
            .map((entry) => entry.units)
            .sort((a, b) => a - b),
          minimalProofEffectIdentities: minimal.map((entry) => entry.identity),
          minimalProofEffects,
          unattributedConsumptionIdentities: unattributedConsumption.sort(),
          contestedConsumptionIdentities,
          contestedConsumptionUnderminesProof: false,
          // B-2: recorded negative-unit conflicts — additional anomalies
          // that never change the primary FAIL mechanism.
          consumptionNegativeUnits: [...consumptionNegativeUnits].sort((a, b) =>
            a.identity < b.identity ? -1 : 1,
          ),
          caseB: {
            remainingSurfaceAuthoritative,
            negativeRemainingProven,
          },
        },
        proofEventIds: sortedEventIds,
        proofRelationshipIds: sortedRelIds,
        proofObservationHashes: sortedHashes,
      };
    }
  }

  // ---- 6. CASE B (priority 2): authoritative converged remaining < 0 ⇒
  // FAIL. Baseline and consumption completeness are NOT required merely
  // to prove the negative authoritative remaining fact (row 17).
  if (negativeRemainingProven && remainingFact !== null) {
    const sortedEventIds = [...proofEventIds].sort();
    const sortedRelIds = [...proofRelationshipIds].sort();
    const sortedHashes = [...proofObservationHashes].sort();
    return {
      verdict: 'FAIL',
      reason: `the authoritative remaining state is ${String(remainingFact)} units for resource ${subject.subjectKey} (Case B: an authoritative negative remaining state proves the violation directly)`,
      gap: null,
      failureMechanism: 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING',
      completenessBasis: GENERIC_COMPLETENESS_BASES.incomplete,
      details: {
        failureMechanism: 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING',
        registryVersion: input.instance.registryVersion,
        kind: input.instance.kind,
        subjectKey: subject.subjectKey,
        resourceIdentityField: params.resourceIdentityField,
        remainingValue: remainingFact,
        remainingQueryIds: remainingQueryIds,
        // N-1 (frozen detail shape): the authoritative negative
        // remaining-state events, their source observations, and the
        // resource-identity proof events — the exact minimal Case-B
        // proof surface the finding rule cites (never the whole run).
        remainingEventIds: boundRemaining.map((entry) => entry.entity.eventId).sort(),
        remainingObservationHashes: [
          ...new Set(boundRemaining.flatMap((entry) => [...entry.entity.sourceObservationHashes])),
        ].sort(),
        resourceProofEventIds: [...subject.subjectEventIds].sort(),
        // B-1/B-2 (§5): the recorded baseline anomaly — a contradictory
        // baseline fact, an invalid baseline capture, or plain baseline
        // absence — is retained here as an additional gap/anomaly; it
        // never changes the primary FAIL verdict or the finding reason.
        baselineConflict:
          baselineConflict ??
          (baselineFact === null
            ? (() => {
                // A captured-but-invalid baseline surface is contradictory
                // evidence; a never-captured one is plain absence.
                const capturedInvalidBaseline = baselineQueryIds.some((queryId) => {
                  const status = input.captures.get(queryId);
                  return status !== undefined && status.captured && !status.valid;
                });
                return capturedInvalidBaseline
                  ? {
                      code: 'EVIDENCE_CONFLICT',
                      problem: 'baseline-capture-invalid',
                      baselineEventIds: [] as string[],
                    }
                  : {
                      code: 'BASELINE_MISSING',
                      problem: 'baseline-authority-absent',
                      baselineEventIds: [] as string[],
                    };
              })()
            : null),
        baselineRequired: false,
        consumptionNegativeUnits: [...consumptionNegativeUnits].sort((a, b) =>
          a.identity < b.identity ? -1 : 1,
        ),
      },
      proofEventIds: sortedEventIds,
      proofRelationshipIds: sortedRelIds,
      proofObservationHashes: sortedHashes,
    };
  }

  // ---- 7. CASE C (priority 3): remaining != initial − acceptedReserved
  // ⇒ FAIL ONLY with: authoritative coherent baseline + remaining,
  // complete consumption capture surface, proven-complete enumeration,
  // all counted effects distinct/accepted/attributable, same
  // resource/scope/generation (§8/§29). Without completeness ⇒ NOT_EVALUABLE.
  const passCaptures = captureInvalid(input, requiredForAuthorityOrPass);
  const consumptionCaptureInvalid = captureInvalid(input, consumptionQueryIds);
  const summaryCaptureValid = (() => {
    const status = input.captures.get(params.completenessProof.queryId);
    return status !== undefined && status.captured && status.valid;
  })();

  // Completeness enumeration: bound summaries (subject/scope/generation
  // exact) → convergence → observedCount == observedTotal.
  const summaryEntities = input.entities.filter(
    (entity) => input.captures.get(entity.queryId)?.queryId === params.completenessProof.queryId,
  );
  const boundSummaries: Array<{ readonly entity: GenericEvidenceEntity; readonly total: unknown }> =
    [];
  for (const entity of summaryEntities) {
    const subjectValue = declaredValue(entity, params.completenessProof.subjectField);
    if (
      typeof subjectValue !== typeof resourceIdentityValue ||
      subjectValue !== resourceIdentityValue
    ) {
      // Foreign-scope summaries are skipped as unbound (ADR-0023 §2.4):
      // they neither converge into the observed total nor raise a gap.
      continue;
    }
    const scopeCheck = coherentScope(
      [
        { surface: 'subject', payload: subject.subjectPayload },
        { surface: 'summary', payload: entity.payload },
      ],
      params.scopeBinding,
    );
    if (!scopeCheck.coherent) {
      continue;
    }
    if (entity.contested) {
      return gapResult(
        GENERIC_EVALUATION_GAPS.contestedEvidence,
        `the bound completeness summary is contested; contradictory summaries are never resolved by selection`,
        { subjectKey: subject.subjectKey, summaryEventId: entity.eventId },
        { eventIds: [...proofEventIds, entity.eventId] },
      );
    }
    boundSummaries.push({
      entity,
      total: declaredValue(entity, params.completenessProof.totalField),
    });
    proofEventIds.add(entity.eventId);
    for (const hash of entity.sourceObservationHashes) {
      proofObservationHashes.add(hash);
    }
  }
  const convergedSummaries = convergeValues(
    boundSummaries.map((entry) => ({ surface: entry.entity.eventId, value: entry.total })),
  );
  let observedTotal: number | null = null;
  let summaryConflict = false;
  if (convergedSummaries.state === 'conflict') {
    summaryConflict = true;
  } else if (convergedSummaries.state === 'one') {
    const value = convergedSummaries.value;
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      observedTotal = value;
    } else {
      summaryConflict = true; // Negative/type-invalid total ⇒ contradiction.
    }
  }
  const observedCount = attributedConsumption.length;
  const completenessProven = observedTotal !== null && observedCount === observedTotal;

  if (
    baselineFact !== null &&
    remainingFact !== null &&
    !summaryConflict &&
    completenessProven &&
    summaryCaptureValid &&
    consumptionCaptureInvalid.invalid.length === 0 &&
    remainingInvalid.invalid.length === 0 &&
    unattributedConsumption.length === 0 &&
    contestedConsumptionIdentities.length === 0 &&
    consumptionTypeInvalid.length === 0 &&
    consumptionNegativeUnits.length === 0 &&
    consumptionScopeMismatch.length === 0
  ) {
    const expected = baselineFact.value - acceptedReservedUnits;
    if (remainingFact !== expected) {
      const sortedEventIds = [...proofEventIds].sort();
      const sortedRelIds = [...proofRelationshipIds].sort();
      const sortedHashes = [...proofObservationHashes].sort();
      return {
        verdict: 'FAIL',
        reason: `conservation mismatch for resource ${subject.subjectKey}: remaining (${String(remainingFact)}) != initial (${String(baselineFact.value)}) − acceptedReservedUnits (${String(acceptedReservedUnits)}) with enumeration proven complete (Case C)`,
        gap: null,
        failureMechanism: 'RESOURCE_CONSERVATION_MISMATCH',
        completenessBasis: GENERIC_COMPLETENESS_BASES.observedTotal,
        details: {
          failureMechanism: 'RESOURCE_CONSERVATION_MISMATCH',
          registryVersion: input.instance.registryVersion,
          kind: input.instance.kind,
          subjectKey: subject.subjectKey,
          resourceIdentityField: params.resourceIdentityField,
          baselineValue: baselineFact.value,
          acceptedReservedUnits,
          remainingValue: remainingFact,
          expectedRemaining: expected,
          observedCount,
          observedTotal,
          consumptionEffectIdentities: attributedConsumption.map((entry) => entry.identity).sort(),
          completenessProof: {
            kind: params.completenessProof.kind,
            queryId: params.completenessProof.queryId,
            subjectField: params.completenessProof.subjectField,
            totalField: params.completenessProof.totalField,
          },
        },
        proofEventIds: sortedEventIds,
        proofRelationshipIds: sortedRelIds,
        proofObservationHashes: sortedHashes,
      };
    }
  }

  // ---- 8. PASS requires (§30): no earlier FAIL; no attribution gap;
  // complete required capture set; authoritative baseline; authoritative
  // remaining; complete consumption enumeration; coherent scope;
  // remaining == initial − sum AND sum ≤ initial AND remaining ≥ 0.
  if (
    baselineFact !== null &&
    remainingFact !== null &&
    !summaryConflict &&
    completenessProven &&
    summaryCaptureValid &&
    passCaptures.invalid.length === 0 &&
    unattributedConsumption.length === 0 &&
    contestedConsumptionIdentities.length === 0 &&
    consumptionTypeInvalid.length === 0 &&
    consumptionNegativeUnits.length === 0 &&
    consumptionScopeMismatch.length === 0 &&
    remainingFact === baselineFact.value - acceptedReservedUnits &&
    acceptedReservedUnits <= baselineFact.value &&
    remainingFact >= 0
  ) {
    const sortedEventIds = [...proofEventIds].sort();
    const sortedRelIds = [...proofRelationshipIds].sort();
    const sortedHashes = [...proofObservationHashes].sort();
    return {
      verdict: 'PASS',
      reason: `stock conserved for resource ${subject.subjectKey}: remaining (${String(remainingFact)}) == initial (${String(baselineFact.value)}) − acceptedReservedUnits (${String(acceptedReservedUnits)}), sum ≤ initial, remaining ≥ 0, enumeration complete (exact integer arithmetic, R-06)`,
      gap: null,
      failureMechanism: null,
      completenessBasis: GENERIC_COMPLETENESS_BASES.observedTotal,
      details: {
        registryVersion: input.instance.registryVersion,
        kind: input.instance.kind,
        subjectKey: subject.subjectKey,
        resourceIdentityField: params.resourceIdentityField,
        baselineValue: baselineFact.value,
        acceptedReservedUnits,
        remainingValue: remainingFact,
        observedCount,
        observedTotal,
        consumptionEffectIdentities: attributedConsumption.map((entry) => entry.identity).sort(),
        consumptionUnitValues: attributedConsumption
          .map((entry) => entry.units)
          .sort((a, b) => a - b),
        requiredQueryIds: requiredForAuthorityOrPass,
        completenessProof: {
          kind: params.completenessProof.kind,
          queryId: params.completenessProof.queryId,
          subjectField: params.completenessProof.subjectField,
          totalField: params.completenessProof.totalField,
        },
      },
      proofEventIds: sortedEventIds,
      proofRelationshipIds: sortedRelIds,
      proofObservationHashes: sortedHashes,
    };
  }

  // ---- 9. Everything else ⇒ NOT_EVALUABLE with the specific named gap
  // (normative rule 6). Gap precedence is deterministic and explicit:
  // capture invalidity → contested consumption identity → baseline
  // missing → remaining missing → completeness gap → evidence conflict →
  // attribution gap.
  const sortedEventIds = [...proofEventIds].sort();
  const sortedRelIds = [...proofRelationshipIds].sort();
  const sortedHashes = [...proofObservationHashes].sort();
  const caseAProven =
    baselineFact !== null &&
    attributedConsumption.length > 0 &&
    acceptedReservedUnits > baselineFact.value;
  if (contestedConsumptionIdentities.length > 0 || contestedUnidentifiableConsumption) {
    // Row 13: a contested consumption identity marks the bound surface
    // incoherent (§4); no winning record is guessed and no verdict
    // rests on the contradicted identity. A lower-bound-safe Case A
    // that did not need the contested identity already fired above.
    return gapResult(
      GENERIC_EVALUATION_GAPS.contestedEvidence,
      `a consumption effect identity appears with conflicting payloads (contested); no winning record is guessed (ADR-0017 Decision 3)`,
      {
        subjectKey: subject.subjectKey,
        contestedConsumptionIdentities: contestedConsumptionIdentities.slice().sort(),
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (consumptionTypeInvalid.length > 0) {
    // Row 12 analog: a float/numeric-string unit value that reached the
    // evaluator is contradictory evidence — it can never enter the
    // arithmetic (R-06) and is never silently dropped.
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `a consumption effect carries a type-invalid unit value; exact safe-integer units are required and contradiction is never coerced`,
      {
        subjectKey: subject.subjectKey,
        consumptionIdentities: consumptionTypeInvalid.slice().sort(),
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (consumptionNegativeUnits.length > 0) {
    // B-2 (frozen): negative accepted consumption units are contradictory
    // business evidence — excluded from the conservation sum, never
    // reinterpreted as release/restock. With no independent Case A/B FAIL
    // already proven above, the honest verdict is NOT_EVALUABLE, and the
    // conflict always blocks Case C and PASS.
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `an accepted consumption effect carries a negative unit value; conservation units are non-negative by contract (ADR-0018/ADR-0023 §8) and contradiction is never coerced`,
      {
        subjectKey: subject.subjectKey,
        negativeUnitEffects: [...consumptionNegativeUnits].sort((a, b) =>
          a.identity < b.identity ? -1 : 1,
        ),
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (consumptionScopeMismatch.length > 0) {
    // Row 11 analog: a bound-consumption candidate outside this
    // subject's scope/generation is skipped as a non-candidate (§4);
    // with no complete matching enumeration the verdict is honestly
    // scope-incoherent rather than silently re-scoped.
    return gapResult(
      GENERIC_EVALUATION_GAPS.scopeIncoherent,
      `a bound consumption effect is not scope/generation-coherent with the resource; foreign-scope effects are never counted and the surface is not re-scoped`,
      {
        subjectKey: subject.subjectKey,
        consumptionIdentities: consumptionScopeMismatch.slice().sort(),
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (baselineFact === null) {
    if (baselineConflict !== null) {
      // B-1/B-2 (frozen): the recorded baseline conflict terminates the
      // verdict ONLY here — after Case A and Case B had their
      // independent-proof opportunities. The conflict code wins over the
      // generic baseline-missing name because the baseline surface was
      // observed and contradicted, not merely absent.
      return gapResult(
        GENERIC_EVALUATION_GAPS.evidenceConflict,
        `the baseline surface is contradictory business evidence for the bound resource/scope; it can never support Case A/C/PASS and no independent Case A/B FAIL was proven`,
        { subjectKey: subject.subjectKey, baselineConflict, caseAProven },
        {
          eventIds: sortedEventIds,
          relationshipIds: sortedRelIds,
          observationHashes: sortedHashes,
        },
      );
    }
    return gapResult(
      GENERIC_EVALUATION_GAPS.baselineMissing,
      `no authoritative converged baseline observation exists for the bound resource/scope; initial capacity is NEVER inferred (R-02/ADR-0018)`,
      {
        subjectKey: subject.subjectKey,
        baselineQueryIds,
        baselineInvalidQueries: baselineInvalid.invalid,
        baselineContested: contestedBaseline,
        caseAProven,
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (contestedRemaining) {
    // Row 13: a contested bound surface is NOT_EVALUABLE with the
    // contested-identity gap — never silently re-read and never a
    // Case B FAIL (the negative fact is not authoritative).
    return gapResult(
      GENERIC_EVALUATION_GAPS.contestedEvidence,
      `the remaining-state surface is derivation-contested (conflicting remaining identity payloads); no verdict rests on a contradicted surface (§4)`,
      { subjectKey: subject.subjectKey },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (remainingContradiction !== null) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `remaining-state observations conflict (or are type-invalid) for the bound resource/scope; a negative observation on an incomplete surface is never authoritative`,
      {
        subjectKey: subject.subjectKey,
        remainingQueryIds,
        remainingInvalidQueries: remainingInvalid.invalid,
        remainingSurfaceAuthoritative,
        remainingValues: Array.isArray(remainingContradiction)
          ? remainingContradiction
          : [remainingContradiction],
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (remainingFact === null) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.remainingMissing,
      `no coherent remaining-state observation is bound to this resource/scope/generation`,
      {
        subjectKey: subject.subjectKey,
        remainingQueryIds,
        remainingSurfaceAuthoritative,
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (passCaptures.invalid.length > 0) {
    // Generic capture-set gap fires only AFTER the specific surface
    // gaps above: when baseline/remaining authority is the missing
    // piece, the honest name is BASELINE_MISSING / REMAINING_MISSING
    // (ADR-0023 §8 rule 6 vocabulary), not the generic capture gap.
    return gapResult(
      GENERIC_EVALUATION_GAPS.captureInvalidOrAbsent,
      `the required capture set is incomplete (an absent/invalid surface is never interpreted as empty)`,
      {
        subjectKey: subject.subjectKey,
        invalidQueries: passCaptures.invalid,
        requiredQueryIds: requiredForAuthorityOrPass,
        baselineEstablished: baselineFact !== null,
        remainingSurfaceAuthoritative,
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (summaryConflict) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.evidenceConflict,
      `bound completeness summaries conflict (or the total is negative/type-invalid); contradiction is never resolved by selection`,
      { subjectKey: subject.subjectKey, observedCount, observedTotalBound: null },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (unattributedConsumption.length > 0) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.attributionGap,
      `${String(unattributedConsumption.length)} accepted consumption effect(s) cannot be attributed via the active identity graph; the gap is reported honestly (never dropped to lower the count, never guessed around)`,
      {
        subjectKey: subject.subjectKey,
        unattributedConsumptionIdentities: unattributedConsumption.sort(),
        acceptedReservedUnitsSoFar: acceptedReservedUnits,
      },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  if (observedTotal === null || observedCount !== observedTotal) {
    return gapResult(
      GENERIC_EVALUATION_GAPS.enumerationCompletenessGap,
      `consumption enumeration completeness is not proven (required for PASS and Case C); observedCount (${String(observedCount)}) vs observedTotal (${String(observedTotal ?? 'absent')})`,
      { subjectKey: subject.subjectKey, observedCount, observedTotal },
      { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
    );
  }
  return gapResult(
    GENERIC_EVALUATION_GAPS.evaluationSurfaceAbsent,
    `the evaluation surface does not establish a verdict under the frozen rules; reported honestly rather than guessed`,
    { subjectKey: subject.subjectKey },
    { eventIds: sortedEventIds, relationshipIds: sortedRelIds, observationHashes: sortedHashes },
  );
}

// ---------------------------------------------------------------------
// Dispatch (closed registry — one authoritative entry point)
// ---------------------------------------------------------------------

/**
 * Evaluates one frozen instance over one normalized evaluation input.
 * The kind dispatch comes from the SAME closed registry the validator
 * uses — never a switch spread across unrelated files.
 */
export function evaluateGenericInvariant(input: GenericEvaluationInput): GenericEvaluationResult {
  switch (input.instance.kind) {
    case 'atMostOneAcceptedEffect':
      return evaluateAtMostOneAcceptedEffect(input);
    case 'resourceConservation':
      return evaluateResourceConservation(input);
    default: {
      // Unreachable: the validator rejects unknown kinds; fail closed.
      return gapResult(
        GENERIC_EVALUATION_GAPS.evaluationSurfaceAbsent,
        `unknown invariant kind "${String((input.instance as { kind?: unknown }).kind)}"`,
        {},
      );
    }
  }
}
