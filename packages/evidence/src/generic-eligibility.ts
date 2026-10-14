// =====================================================================
// RuptureGrid Phase 17 — Checkpoint C: generic subject eligibility
// (ADR-0026 §4/§6 four-class partitioning; the F-3 root-cause repair)
// =====================================================================
// The exclusive fix for the audited F-3 defect: the evaluation domain is
// selected by the run-owned anchor BEFORE any grouping/convergence — a
// foreign-scope subject can never be evaluated as if it were this run's
// business truth, an undeclared same-scope subject can never be silently
// dropped, and an unidentifiable subject fails closed instead of being
// assumed foreign.
//
// This module is PURE over already-loaded evidence (the durable entities
// + contested set + ACTIVE graph) and the frozen runScope instance
// mapping; it performs no I/O. Classes (frozen, ADR-0026 §4):
//
//   A. Declared subject whose entities carry EXACTLY the anchor
//      `(scope, generation)` tuple — the only evaluable partition.
//   B. Undeclared subject in the run-owned scope/generation —
//      `COVERAGE_ANOMALY` (named), never evaluated, never exit 0.
//   C. Foreign subject in another scope/generation — inventory counts per
//      `(scope, generation)` only; never evaluated; never a finding; by
//      itself not a business failure.
//   D. Unidentifiable/contested/ambiguous evidence (missing or redacted
//      identity, scope, or generation; mixed scope/generation groups;
//      contested identity of an identity-bearing entity) — fail closed
//      via a named coverage anomaly; NEVER assumed foreign.
//
// Exactness rules (§6): both the scope and the generation compare with
// `===` semantics against the anchor; no string/number coercion exists in
// either direction. Declared subject identities are strings; an observed
// numeric identity is a DIFFERENT subject and can never match a declared
// string.
//
// The evaluator function itself is untouched; only its input domain is
// restricted to the eligible partition (the restriction is
// semantics-preserving: foreign entities could never satisfy the
// instance's own scope coherence against the anchor tuple).

import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import type { GenericEvidenceEntity } from './generic-invariant-evaluate.js';

const REDACTED = '[Redacted]';

/** One subject partition selected for evaluation. */
export interface EligibleSubjectPartition {
  readonly subjectKey: string;
  /** All partition entities (the evaluator's restricted universe). */
  readonly partitionEventIds: readonly string[];
  /** The identity-bearing subset (existing subjectEventIds semantics). */
  readonly subjectEventIds: readonly string[];
  readonly subjectPayload: Record<string, unknown>;
}

/** One named class-B unexpected same-scope subject. */
export interface UnexpectedSubject {
  readonly subjectKey: string;
  readonly scope: string;
  readonly generation: number;
}

/** One class-D coverage anomaly (fail closed; never assumed foreign). */
export interface IndeterminateEvidence {
  readonly kind: string;
  readonly detail: string;
}

export interface ForeignScopeCount {
  readonly scope: string;
  readonly generation: number;
  readonly subjectCount: number;
}

export interface GenericEligibilityResult {
  readonly eligible: readonly EligibleSubjectPartition[];
  readonly missing: readonly string[];
  readonly unexpected: readonly UnexpectedSubject[];
  readonly foreign: readonly ForeignScopeCount[];
  readonly indeterminate: readonly IndeterminateEvidence[];
  readonly gaps: ReadonlyArray<{ readonly kind: string; readonly detail: string }>;
  readonly observedSubjectCount: number;
}

export interface GenericInstanceSpec {
  readonly key: string;
  readonly kind: 'atMostOneAcceptedEffect' | 'resourceConservation';
  readonly params: Record<string, unknown>;
}

export interface GenericEligibilityInput {
  readonly instance: GenericInstanceSpec;
  readonly scopeField: string;
  readonly generationField: string;
  readonly declaredSubjects: readonly string[];
  readonly anchor: { readonly observedScope: string; readonly observedGeneration: number } | null;
  readonly anchorState: 'ESTABLISHED' | 'ANCHOR_UNPROVEN' | 'EVIDENCE_CONFLICT';
  readonly anchorReason: string;
  readonly entities: readonly GenericEvidenceEntity[];
  readonly contestedEventIds: ReadonlySet<string>;
}

interface IdentityGroup {
  readonly identityKey: string;
  readonly identityValue: string | number;
  readonly members: GenericEvidenceEntity[];
}

/**
 * Classifies every observed subject of one bound generic instance into
 * the frozen four classes and returns the evaluable partitions.
 */
export function selectEligibleSubjects(input: GenericEligibilityInput): GenericEligibilityResult {
  const { instance } = input;
  const params = instance.params;
  const identityField =
    instance.kind === 'atMostOneAcceptedEffect'
      ? (params['subjectIdentityField'] as string)
      : (params['resourceIdentityField'] as string);
  const subjectRole =
    instance.kind === 'atMostOneAcceptedEffect' ? (params['subjectRole'] as string) : null;
  const consumptionRole =
    instance.kind === 'resourceConservation' ? (params['consumptionEffectRole'] as string) : null;

  const gaps: Array<{ kind: string; detail: string }> = [];
  const indeterminate: IndeterminateEvidence[] = [];
  const unexpected: UnexpectedSubject[] = [];
  const foreignCounts = new Map<
    string,
    { scope: string; generation: number; subjects: Set<string> }
  >();

  // Identity-bearing roles for the contested-identity class-D rule:
  // atMostOne → the subject role; resource → every role except the
  // consumption effects (their contested identity is the evaluator's own
  // NE path inside an otherwise eligible partition).
  const isIdentityBearingRole = (roleId: string): boolean =>
    instance.kind === 'atMostOneAcceptedEffect'
      ? roleId === subjectRole
      : roleId !== consumptionRole;

  const declared = new Set(input.declaredSubjects);
  const groups = new Map<string, IdentityGroup>();
  for (const entity of input.entities) {
    const raw = entity.payload[identityField];
    if (raw === undefined) {
      continue; // Field not present on this surface: not an identity observation.
    }
    if (raw === null || raw === REDACTED || (typeof raw !== 'string' && typeof raw !== 'number')) {
      indeterminate.push({
        kind: 'subject-identity-indeterminate',
        detail: `event ${entity.eventId} (${entity.roleId}): ${identityField} is ${raw === null ? 'null' : raw === REDACTED ? 'redacted' : `a ${typeof raw}`} — fail closed`,
      });
      continue;
    }
    const identityKey = `${typeof raw}:${String(raw)}`;
    const group = groups.get(identityKey) ?? {
      identityKey,
      identityValue: raw,
      members: [],
    };
    group.members.push(entity);
    groups.set(identityKey, group);
  }

  const eligible: EligibleSubjectPartition[] = [];
  const declaredSeen = new Set<string>();
  let observedSubjectCount = 0;

  for (const group of [...groups.values()].sort((a, b) =>
    a.identityKey < b.identityKey ? -1 : 1,
  )) {
    observedSubjectCount += 1;
    const subjectKey = String(group.identityValue);
    // ---- Class D first: never assume foreign on ambiguity. ----
    let scopeIndeterminate = false;
    const pairs = new Set<string>();
    let pair: { scope: string; generation: number } | null = null;
    for (const member of group.members) {
      const scopeValue = member.payload[input.scopeField];
      const generationValue = member.payload[input.generationField];
      if (
        scopeValue === undefined ||
        scopeValue === null ||
        scopeValue === REDACTED ||
        generationValue === undefined ||
        generationValue === null ||
        generationValue === REDACTED ||
        typeof scopeValue !== 'string' ||
        typeof generationValue !== 'number' ||
        !Number.isSafeInteger(generationValue) ||
        generationValue < 0
      ) {
        scopeIndeterminate = true;
        break;
      }
      pairs.add(`${scopeValue}|${String(generationValue)}`);
      if (pair === null) {
        pair = { scope: scopeValue, generation: generationValue };
      }
    }
    if (scopeIndeterminate) {
      indeterminate.push({
        kind: 'scope-or-generation-indeterminate',
        detail: `subject ${subjectKey}: an entity carries a missing/redacted/type-invalid ${input.scopeField}/${input.generationField} — fail closed`,
      });
      continue;
    }
    if (pairs.size > 1) {
      indeterminate.push({
        kind: 'mixed-scope-generation-group',
        detail: `subject ${subjectKey}: entities disagree on (${input.scopeField}, ${input.generationField}) — fail closed (never merged across generations)`,
      });
      continue;
    }
    const memberPair = pair as { scope: string; generation: number };
    const contestedMember = group.members.some(
      (member) =>
        isIdentityBearingRole(member.roleId) && input.contestedEventIds.has(member.eventId),
    );
    if (contestedMember) {
      indeterminate.push({
        kind: 'contested-identity',
        detail: `subject ${subjectKey}: an identity-bearing entity is contested (ADR-0017 Decision 3) — fail closed`,
      });
      continue;
    }
    // ---- Anchor comparison. ----
    if (input.anchor === null || input.anchorState !== 'ESTABLISHED') {
      indeterminate.push({
        kind: 'anchor-not-established',
        detail: `subject ${subjectKey}: the run anchor is ${input.anchorState} (${input.anchorReason}) — no scope can be compared, fail closed`,
      });
      continue;
    }
    const matchesAnchor =
      memberPair.scope === input.anchor.observedScope &&
      memberPair.generation === input.anchor.observedGeneration;
    if (!matchesAnchor) {
      // Class C: foreign inventory (counts only; never a verdict).
      const key = `${memberPair.scope}|${String(memberPair.generation)}`;
      const entry = foreignCounts.get(key) ?? {
        scope: memberPair.scope,
        generation: memberPair.generation,
        subjects: new Set<string>(),
      };
      entry.subjects.add(subjectKey);
      foreignCounts.set(key, entry);
      continue;
    }
    if (typeof group.identityValue !== 'string' || !declared.has(group.identityValue)) {
      // Class B: undeclared same-scope subject — coverage anomaly.
      unexpected.push({
        subjectKey,
        scope: memberPair.scope,
        generation: memberPair.generation,
      });
      continue;
    }
    // Class A: eligible partition.
    declaredSeen.add(group.identityValue);
    const sorted = [...group.members].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const identityMembers =
      instance.kind === 'atMostOneAcceptedEffect'
        ? sorted.filter((member) => member.roleId === subjectRole)
        : sorted.filter((member) => member.roleId !== consumptionRole);
    const firstIdentity = identityMembers[0] ?? sorted[0];
    eligible.push({
      subjectKey: group.identityValue,
      partitionEventIds: sorted.map((member) => member.eventId),
      subjectEventIds: identityMembers.map((member) => member.eventId),
      subjectPayload: firstIdentity?.payload ?? {},
    });
  }

  const missing = input.declaredSubjects.filter((subject) => !declaredSeen.has(subject));
  if (input.anchorState !== 'ESTABLISHED') {
    gaps.push({
      kind:
        input.anchorState === 'EVIDENCE_CONFLICT' ? 'anchor-evidence-conflict' : 'anchor-unproven',
      detail: `the run anchor is ${input.anchorState} (${input.anchorReason}); every declared subject takes the missing/NOT_EVALUABLE path`,
    });
  }
  if (missing.length > 0) {
    gaps.push({
      kind: 'declared-subject-missing',
      detail: `${String(missing.length)} declared subject(s) have no anchor-bound partition: ${[...missing].sort().join(', ')}`,
    });
  }
  if (unexpected.length > 0) {
    gaps.push({
      kind: 'coverage-anomaly',
      detail: `${String(unexpected.length)} undeclared same-scope subject(s) observed: ${unexpected
        .map((entry) => entry.subjectKey)
        .sort()
        .join(', ')}`,
    });
  }
  if (indeterminate.length > 0) {
    gaps.push({
      kind: 'scope-or-subject-indeterminate',
      detail: `${String(indeterminate.length)} evidence group(s) cannot be safely classified`,
    });
  }

  return {
    eligible: eligible.sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1)),
    missing,
    unexpected: unexpected.sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1)),
    foreign: [...foreignCounts.values()]
      .map((entry) => ({
        scope: entry.scope,
        generation: entry.generation,
        subjectCount: entry.subjects.size,
      }))
      .sort((a, b) =>
        a.scope === b.scope ? a.generation - b.generation : a.scope < b.scope ? -1 : 1,
      ),
    indeterminate,
    gaps,
    observedSubjectCount,
  };
}

/**
 * The declared subject set of one frozen instance from the run's frozen
 * `runScopeBinding` — an empty array (which fails closed through the
 * missing path) when the binding or key is absent. Never invented.
 */
export function declaredSubjectsFor(
  binding: { readonly subjects: Readonly<Record<string, readonly string[]>> } | null,
  invariantKey: string,
): readonly string[] {
  if (binding === null) {
    return [];
  }
  const list = binding.subjects[invariantKey];
  return Array.isArray(list) ? list : [];
}

/** Re-exported for callers that need the entity shape (no runtime cost). */
export type { GenericEvidenceEntity, ManifestEvidencePolicy };
