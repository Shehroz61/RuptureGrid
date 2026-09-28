// =====================================================================
// RuptureGrid v1.1 Phase 14 — generic manifest-driven causal derivation
// (ADR-0017 Decisions 2–3; roadmap Phase 14; evidence-model §6)
// =====================================================================
// A PURE deterministic computation over the run's generic normalized
// events and the run's FROZEN ManifestEvidencePolicy:
//
//   DIRECT EDGES — for each declared causal edge, an identity-direct
//   relationship exists ONLY when EVERY declared linkField exists on
//   both payloads, is not redacted/missing, carries the SAME declared
//   primitive type on both endpoint roles, and matches by EXACT
//   equality. No trim, no lowercase normalization, no fuzzy similarity,
//   no substring, no timestamp proximity, no nearest/first row, no
//   ordering heuristic, no queryId heuristic, no subjectKey fallback.
//   relationKind IS the declared edgeKind; direction is preserved.
//
//   IDENTITY CHAIN — multi-hop attribution is derived deterministically
//   by walking identity-direct edges only (ADR-0017 Decision 2). Every
//   persisted chain row uses the platform-owned relationKind
//   `identity-chain-reachability` with basis `identity-chain` and
//   evidence naming the exact event path(s) that prove it. All minimal
//   paths are recorded (capped) — never one silent winner. Cycle-safe,
//   idempotent, independent of input order.
//
//   AMBIGUITY — contested identities (the same declared identity under
//   one role with CONFLICTING declared payloads) derive NO guessed
//   winning edge: no first/newest/oldest/closest/lexical/random winner
//   exists. The conflict is persisted as bounded, versioned,
//   RuptureGrid-owned derivation-gap diagnostics (NOT target events,
//   NOT findings, NOT Phase 15 verdicts) so Phase 15 can honestly
//   evaluate NOT_EVALUABLE where its invariants require the contested
//   edge. Redacted/missing identity or link fields are likewise honest
//   gaps — never guessed around.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { GENERIC_IDENTITY_CHAIN_RELATION_KIND } from './versions.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The literal marker every redacted value carries after persistence. */
const REDACTED_VALUE = '[Redacted]';

/** Bounded output caps (deterministic; never a semantic claim). */
export const GENERIC_DERIVATION_CAPS = {
  maxDirectRelationships: 10_000,
  maxChainRelationships: 10_000,
  maxPathsPerChainPair: 8,
  maxDiagnostics: 100,
  maxAffectedEventIdsPerDiagnostic: 20,
  /**
   * B-2: bounded invalidation-provenance rows per derivation pass. The
   * ACTIVE-graph exclusion itself is NEVER capped (it is recomputed
   * from the contested-event set every pass); only the durable
   * per-group provenance rows are bounded, with an honest flag.
   */
  maxInvalidationProvenanceRows: 100,
  maxInvalidatedRelationshipIdsPerRow: 50,
} as const;

/** A generic normalized event row (as persisted) — derivation input. */
export interface GenericEventRow {
  readonly id: string;
  /** The declared roleId (the event type IS the role). */
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly sourceObservationHashes: readonly string[];
}

/** A computed causal relationship ready for persistence. */
export interface GenericRelationshipSpec {
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly relationKind: string;
  readonly basis: 'identity-direct' | 'identity-chain';
  /**
   * B-2 (defense in depth; normally false for specs inside
   * `relationships`): true when this edge is anchored on contested
   * events and must NOT join the ACTIVE graph. Direct specs marked
   * invalidated are excluded by the caller; chain routing already
   * refuses to traverse contested nodes.
   */
  readonly invalidated: boolean;
  readonly evidence: Record<string, unknown>;
}

/** Bounded deterministic gap kinds (platform vocabulary — RuptureGrid-owned). */
export type GenericDerivationGapKind =
  | 'contested-identity'
  | 'redacted-identity-field'
  | 'redacted-link-field'
  | 'missing-link-field'
  | 'link-field-declared-type-mismatch';

/** A derivation-gap diagnostic, ready to persist as a versioned event. */
export interface GenericDerivationDiagnosticSpec {
  readonly gapKind: GenericDerivationGapKind;
  /** Bounded deterministic subject key (≤ 200 chars, secret-free). */
  readonly subjectKey: string;
  /** Semantic input: the observation hashes this gap rests on. */
  readonly sourceObservationHashes: readonly string[];
  /** Versioned diagnostic document (deterministic, bounded). */
  readonly payload: Record<string, unknown>;
}

export interface GenericDerivationComputation {
  readonly relationships: readonly GenericRelationshipSpec[];
  readonly diagnostics: readonly GenericDerivationDiagnosticSpec[];
  /**
   * B-2 (additive): every event id that sits in a CONTESTED identity
   * group this pass. Uncapped and deterministic (sorted, deduped): the
   * caller uses it to exclude stale persisted relationships from the
   * ACTIVE causal graph and to persist durable invalidation
   * provenance — prior rows are physically preserved (logically
   * append-only), never deleted.
   */
  readonly contestedEventIds: readonly string[];
  /**
   * B-2 (additive): one bounded, versioned invalidation-provenance
   * spec per contested identity group (capped with an honest flag).
   * Persisted as RuptureGrid-owned diagnostic events naming the
   * invalidated relationship/event ids — a tombstone in evidence, not
   * a deletion.
   */
  readonly invalidations: readonly GenericInvalidationSpec[];
  /** Honest boundedness flags (caps are safety valves, not semantics). */
  readonly caps: {
    readonly directRelationshipsTruncated: boolean;
    readonly chainRelationshipsTruncated: boolean;
    readonly diagnosticsTruncated: boolean;
    readonly invalidationsTruncated: boolean;
  };
}

/** A durable invalidation-provenance spec (B-2), ready to persist. */
export interface GenericInvalidationSpec {
  /** Deterministic, versioned reason (bounded platform vocabulary). */
  readonly reason: 'identity-contested';
  readonly roleId: string;
  readonly identityTupleHash: string;
  /** Semantic input: the observation hashes this invalidation rests on. */
  readonly sourceObservationHashes: readonly string[];
  /** Bounded deterministic document (references ids; secret-free). */
  readonly payload: Record<string, unknown>;
}

interface InternalEvent {
  readonly id: string;
  readonly roleId: string;
  readonly queryId: string | null;
  readonly identityFields: readonly string[];
  readonly payload: Record<string, unknown>;
  readonly sourceObservationHashes: readonly string[];
  /**
   * B-3: the ROLE-scoped identity key — declared identityFields (name
   * set) + the canonical identity-values tuple. queryId is PROVENANCE
   * ONLY and is never a grouping barrier: two queries bound to the
   * same role with the same declared identityFields group together so
   * a cross-query conflict is detected.
   */
  readonly roleIdentityTuple: string;
  readonly contested: boolean;
}

/** Extracts the declared (non-provenance) payload of a generic event. */
function declaredPayload(event: InternalEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (key !== 'rupturegrid') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Runs the full generic derivation computation. PURE: same events +
 * same policy ⇒ same output, independent of input order (all
 * order-sensitive structures are sorted before use; output is a set).
 */
export function computeGenericDerivation(
  events: readonly GenericEventRow[],
  policy: ManifestEvidencePolicy,
): GenericDerivationComputation {
  const diagnostics: GenericDerivationDiagnosticSpec[] = [];
  let diagnosticsTruncated = false;
  const recordDiagnostic = (spec: GenericDerivationDiagnosticSpec): void => {
    if (diagnostics.length >= GENERIC_DERIVATION_CAPS.maxDiagnostics) {
      diagnosticsTruncated = true;
      return;
    }
    diagnostics.push(spec);
  };

  const nodeFields = new Map<string, Record<string, string>>();
  for (const node of policy.identityModel.nodes) {
    nodeFields.set(node.roleId, node.fields);
  }
  const queryById = new Map<string, ManifestEvidencePolicy['inspection'][number]>();
  for (const query of policy.inspection) {
    queryById.set(query.queryId, query);
  }

  // Only declared roles participate (unknown roles derive nothing).
  const byRole = new Map<string, InternalEvent[]>();
  for (const event of events) {
    if (!nodeFields.has(event.eventType)) {
      continue;
    }
    const queryId =
      isRecord(event.payload['rupturegrid']) &&
      typeof (event.payload['rupturegrid'] as Record<string, unknown>)['queryId'] === 'string'
        ? ((event.payload['rupturegrid'] as Record<string, unknown>)['queryId'] as string)
        : null;
    const query = queryId === null ? undefined : queryById.get(queryId);
    // An event whose query is not in the frozen policy can never exist
    // through the real seam (the normalizer refuses unknown queries);
    // skip defensively — nothing is guessed about it.
    if (query === undefined) {
      continue;
    }
    // B-3: the identity key is ROLE-SCOPED. The declared identityFields
    // (name set) + canonical values tuple identify the subject across
    // ALL queries of this role; queryId stays on the event as provenance
    // only. Two queries bound to the same role with DIFFERENT declared
    // identityFields can never collide (the name set is part of the
    // key) — their identity declarations simply name different subjects.
    const identityTuple = canonicalizeJson(
      query.identityFields.map((field) => event.payload[field] ?? null),
    );
    const roleIdentityTuple = `${JSON.stringify([...query.identityFields].sort())}\u0000${identityTuple}`;
    const list = byRole.get(event.eventType) ?? [];
    list.push({
      id: event.id,
      roleId: event.eventType,
      queryId: query.queryId,
      identityFields: query.identityFields,
      payload: event.payload,
      sourceObservationHashes: event.sourceObservationHashes,
      roleIdentityTuple,
      contested: false,
    });
    byRole.set(event.eventType, list);
  }

  // ---- Identity conflicts (ADR-0017 Decision 3: no guessed winners) ----
  // The same declared identity under one role with CONFLICTING declared
  // payloads is a contested identity. Deterministic: tuples are
  // canonical JSON; conflicting groups are recorded with sorted event
  // ids; identical-payload duplicates (convergent observations) are NOT
  // conflicts.
  //
  // B-3 repair: groups are keyed by the ROLE-SCOPED identity tuple —
  // the queryId is NOT part of the grouping key, so two queries bound
  // to the SAME role with the SAME declared identityFields group
  // together and a cross-query conflict is detected (a conflicting
  // payload can no longer hide behind a different queryId). Groups are
  // iterated in sorted-key order and members in sorted id order: the
  // outcome is independent of input order.
  const contestedEventIds = new Set<string>();
  const invalidations: GenericInvalidationSpec[] = [];
  let invalidationsTruncated = false;
  for (const [roleId, roleEvents] of [...byRole.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const groups = new Map<string, InternalEvent[]>();
    for (const event of roleEvents) {
      const list = groups.get(event.roleIdentityTuple) ?? [];
      list.push(event);
      groups.set(event.roleIdentityTuple, list);
    }
    for (const [tuple, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (group.length < 2) {
        continue;
      }
      const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1));
      const first = declaredPayload(sorted[0] as InternalEvent);
      const conflict = sorted.slice(1).find((event) => {
        return (
          JSON.stringify(canonicalizeJson(declaredPayload(event))) !==
          JSON.stringify(canonicalizeJson(first))
        );
      });
      if (conflict === undefined) {
        continue; // Convergent duplicate observations: not a conflict.
      }
      for (const event of sorted) {
        (event as { contested: boolean }).contested = true;
        contestedEventIds.add(event.id);
      }
      const tupleHash = stableHash(tuple);
      const observationHashes = [
        ...new Set(sorted.flatMap((event) => [...event.sourceObservationHashes])),
      ].sort();
      const affectedIds = sorted
        .slice(0, GENERIC_DERIVATION_CAPS.maxAffectedEventIdsPerDiagnostic)
        .map((event) => event.id);
      recordDiagnostic({
        gapKind: 'contested-identity',
        subjectKey: `role:${roleId}:identity:${tupleHash}`.slice(0, 200),
        sourceObservationHashes: observationHashes,
        payload: {
          diagnosticVersion: 'generic-derivation-diagnostic/v1',
          gapKind: 'contested-identity',
          roleId,
          identityTupleHash: tupleHash,
          affectedEventIds: affectedIds,
          affectedEventCount: sorted.length,
          reason:
            'the same declared identity appears under this role with conflicting declared payloads; no winning record is guessed (ADR-0017 Decision 3)',
        },
      });
      // ---- B-2: durable invalidation provenance ----
      // A contested identity invalidates the causal graph AROUND it:
      // direct edges anchored on contested events and chains routed
      // through contested nodes are excluded from the ACTIVE graph this
      // pass (below). This bounded, versioned provenance row records
      // WHICH persisted relationships/cause-events that exclusion
      // covers — a durable tombstone in evidence. Prior relationship
      // rows are never deleted (logically append-only); repeat passes
      // converge on the same deterministic rows.
      if (invalidations.length >= GENERIC_DERIVATION_CAPS.maxInvalidationProvenanceRows) {
        invalidationsTruncated = true;
        continue;
      }
      invalidations.push({
        reason: 'identity-contested',
        roleId,
        identityTupleHash: tupleHash,
        sourceObservationHashes: observationHashes,
        payload: {
          invalidationVersion: 'generic-derivation-invalidation/v1',
          reason: 'identity-contested',
          roleId,
          identityTupleHash: tupleHash,
          invalidatedEventIds: affectedIds,
          affectedEventCount: sorted.length,
          note: 'direct edges anchored on these contested events and identity-chain reachabilities routed through them are excluded from the ACTIVE causal graph; prior relationship rows are physically preserved (logically append-only), never deleted',
        },
      });
    }
  }

  // ---- Direct edges (declared exact-equality only) ----
  const relationships: GenericRelationshipSpec[] = [];
  let directTruncated = false;
  const directPairKeys = new Set<string>();
  // Bounded per-(edge, role, field) gap dedupe.
  const linkGapSeen = new Set<string>();

  const adjacency = new Map<string, Map<string, Set<string>>>();

  for (const edge of policy.identityModel.causalEdges) {
    const fromEvents = (byRole.get(edge.fromRoleId) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const toEvents = (byRole.get(edge.toRoleId) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const fromFields = nodeFields.get(edge.fromRoleId) ?? {};
    const toFields = nodeFields.get(edge.toRoleId) ?? {};

    // Declared-type compatibility: a link field must carry the SAME
    // declared primitive type on BOTH endpoint roles; otherwise exact
    // equality is meaningless and the edge is structurally
    // non-derivable (an honest gap, never a coerced match).
    const typeMismatched = edge.linkFields.filter(
      (field: string) => fromFields[field] !== toFields[field],
    );
    if (typeMismatched.length > 0) {
      const gapKey = `type-mismatch\u0000${edge.fromRoleId}\u0000${edge.toRoleId}\u0000${edge.edgeKind}`;
      if (!linkGapSeen.has(gapKey)) {
        linkGapSeen.add(gapKey);
        recordDiagnostic({
          gapKind: 'link-field-declared-type-mismatch',
          subjectKey: `edge:${edge.edgeKind}:fields:${typeMismatched.join('+')}`.slice(0, 200),
          sourceObservationHashes: [],
          payload: {
            diagnosticVersion: 'generic-derivation-diagnostic/v1',
            gapKind: 'link-field-declared-type-mismatch',
            edgeKind: edge.edgeKind,
            fromRoleId: edge.fromRoleId,
            toRoleId: edge.toRoleId,
            fields: typeMismatched,
            reason:
              'the declared link field carries different declared primitive types on the two endpoint roles; exact equality cannot be established',
          },
        });
      }
      continue;
    }

    for (const from of fromEvents) {
      for (const to of toEvents) {
        // Contested anchors derive NO guessed edge (ADR-0017 §3).
        if (from.contested || to.contested) {
          continue;
        }
        let matched = true;
        const matchedFields: string[] = [];
        const matchedValues: Record<string, unknown> = {};
        for (const field of edge.linkFields as readonly string[]) {
          const fromValue = from.payload[field];
          const toValue = to.payload[field];
          const present =
            field in from.payload && field in to.payload && fromValue !== null && toValue !== null;
          if (!present) {
            matched = false;
            const gapKey = `missing\u0000${edge.edgeKind}\u0000${edge.fromRoleId}/${edge.toRoleId}\u0000${field}`;
            if (!linkGapSeen.has(gapKey)) {
              linkGapSeen.add(gapKey);
              recordDiagnostic({
                gapKind: 'missing-link-field',
                subjectKey: `edge:${edge.edgeKind}:field:${field}`.slice(0, 200),
                sourceObservationHashes: [],
                payload: {
                  diagnosticVersion: 'generic-derivation-diagnostic/v1',
                  gapKind: 'missing-link-field',
                  edgeKind: edge.edgeKind,
                  fromRoleId: edge.fromRoleId,
                  toRoleId: edge.toRoleId,
                  field,
                  affectedEventIds: [
                    ...new Set(
                      [...fromEvents, ...toEvents]
                        .filter(
                          (event) => !(field in event.payload) || event.payload[field] === null,
                        )
                        .map((event) => event.id),
                    ),
                  ]
                    .sort()
                    .slice(0, GENERIC_DERIVATION_CAPS.maxAffectedEventIdsPerDiagnostic),
                  reason:
                    'a declared link field is missing/null on candidate events of this edge; no linkage is guessed from absence',
                },
              });
            }
            break;
          }
          if (fromValue === REDACTED_VALUE || toValue === REDACTED_VALUE) {
            matched = false;
            const gapKey = `redacted\u0000${edge.edgeKind}\u0000${edge.fromRoleId}/${edge.toRoleId}\u0000${field}`;
            if (!linkGapSeen.has(gapKey)) {
              linkGapSeen.add(gapKey);
              recordDiagnostic({
                gapKind: 'redacted-link-field',
                subjectKey: `edge:${edge.edgeKind}:field:${field}`.slice(0, 200),
                sourceObservationHashes: [],
                payload: {
                  diagnosticVersion: 'generic-derivation-diagnostic/v1',
                  gapKind: 'redacted-link-field',
                  edgeKind: edge.edgeKind,
                  fromRoleId: edge.fromRoleId,
                  toRoleId: edge.toRoleId,
                  field,
                  affectedEventIds: [
                    ...new Set(
                      [...fromEvents, ...toEvents]
                        .filter(
                          (event) => event.payload[field] === REDACTED_VALUE && !event.contested,
                        )
                        .map((event) => event.id),
                    ),
                  ]
                    .sort()
                    .slice(0, GENERIC_DERIVATION_CAPS.maxAffectedEventIdsPerDiagnostic),
                  reason:
                    'a declared link field value was redacted before persistence; the linkage gap remains an honest gap (never guessed)',
                },
              });
            }
            break;
          }
          // Exact equality, no coercion: 5 !== "5", true !== "true",
          // string !== number. Same spelling with a different primitive
          // type never matches.
          if (typeof fromValue !== typeof toValue || fromValue !== toValue) {
            matched = false;
            break;
          }
          matchedFields.push(field);
          matchedValues[field] = fromValue;
        }
        if (!matched || matchedFields.length !== edge.linkFields.length) {
          continue;
        }
        if (from.id === to.id) {
          continue;
        }
        const pairKey = `${from.id}\u0000${to.id}\u0000${edge.edgeKind}`;
        if (directPairKeys.has(pairKey)) {
          continue;
        }
        if (relationships.length >= GENERIC_DERIVATION_CAPS.maxDirectRelationships) {
          directTruncated = true;
          break;
        }
        directPairKeys.add(pairKey);
        relationships.push({
          fromEventId: from.id,
          toEventId: to.id,
          relationKind: edge.edgeKind,
          basis: 'identity-direct',
          invalidated: from.contested || to.contested,
          evidence: {
            derivation: 'generic-manifest/v1',
            edgeKind: edge.edgeKind,
            fromRoleId: edge.fromRoleId,
            toRoleId: edge.toRoleId,
            matchedFields,
            // The values come from STORED REDACTED payloads — safe by
            // construction; a value redaction could never match (the
            // marker is excluded above), so nothing is reintroduced.
            matchedValues,
            fromEventId: from.id,
            toEventId: to.id,
          },
        });
        const toMap = adjacency.get(from.id) ?? new Map<string, Set<string>>();
        const kinds = toMap.get(to.id) ?? new Set<string>();
        kinds.add(edge.edgeKind);
        toMap.set(to.id, kinds);
        adjacency.set(from.id, toMap);
      }
    }
  }

  // ---- Identity-chain reachability (walks identity-direct ONLY) ----
  const chainSpecs: GenericRelationshipSpec[] = [];
  let chainTruncated = false;
  const sortedSources = [...adjacency.keys()].sort();
  for (const source of sortedSources) {
    // Level-by-level BFS carrying ALL minimal paths per node (capped).
    // `visited` makes the walk cycle-safe; path caps bound output.
    const minimalPaths = new Map<string, Array<{ eventIds: string[]; edgeKinds: string[][] }>>();
    let frontier: Array<{ id: string; path: string[]; edgeKinds: string[][] }> = [
      { id: source, path: [source], edgeKinds: [] },
    ];
    const visited = new Set<string>([source]);
    while (frontier.length > 0) {
      const nextFrontier: Array<{ id: string; path: string[]; edgeKinds: string[][] }> = [];
      for (const node of frontier) {
        const neighbors = adjacency.get(node.id);
        if (neighbors === undefined) {
          continue;
        }
        for (const to of [...neighbors.keys()].sort()) {
          if (visited.has(to) || contestedEventIds.has(to)) {
            continue;
          }
          const kinds = [...(neighbors.get(to) ?? new Set<string>())].sort();
          const extendedPaths = (
            minimalPaths.get(node.id) ?? [{ eventIds: node.path, edgeKinds: node.edgeKinds }]
          )
            .map((prefix) => ({
              eventIds: [...prefix.eventIds, to],
              edgeKinds: [...prefix.edgeKinds, kinds],
            }))
            .slice(0, GENERIC_DERIVATION_CAPS.maxPathsPerChainPair);
          const existing = minimalPaths.get(to) ?? [];
          minimalPaths.set(
            to,
            [...existing, ...extendedPaths].slice(0, GENERIC_DERIVATION_CAPS.maxPathsPerChainPair),
          );
          for (const extended of extendedPaths) {
            nextFrontier.push({ id: to, path: extended.eventIds, edgeKinds: extended.edgeKinds });
          }
          visited.add(to);
        }
      }
      frontier = nextFrontier;
    }
    for (const target of [...minimalPaths.keys()].sort()) {
      const paths = minimalPaths.get(target) ?? [];
      if (paths.length === 0) {
        continue;
      }
      const pathLength = (paths[0]?.eventIds.length ?? 0) - 1;
      if (pathLength < 2) {
        continue; // Only multi-hop reachability is a CHAIN.
      }
      if (directPairKeys.has(`${source}\u0000${target}`)) {
        continue; // A direct edge already proves this pair.
      }
      if (chainSpecs.length >= GENERIC_DERIVATION_CAPS.maxChainRelationships) {
        chainTruncated = true;
        break;
      }
      const sourceEvent = source;
      const fromRole = roleOfEvent(events, sourceEvent);
      const toRole = roleOfEvent(events, target);
      chainSpecs.push({
        fromEventId: source,
        toEventId: target,
        relationKind: GENERIC_IDENTITY_CHAIN_RELATION_KIND,
        basis: 'identity-chain',
        invalidated: false,
        evidence: {
          derivation: 'generic-manifest/v1',
          mechanism: 'reachability over identity-direct edges only (no temporal input)',
          fromRoleId: fromRole,
          toRoleId: toRole,
          pathLength,
          paths,
          pathsTruncated: paths.length >= GENERIC_DERIVATION_CAPS.maxPathsPerChainPair,
        },
      });
    }
  }

  return {
    relationships: [...relationships, ...chainSpecs],
    diagnostics,
    contestedEventIds: [...contestedEventIds].sort(),
    invalidations,
    caps: {
      directRelationshipsTruncated: directTruncated,
      chainRelationshipsTruncated: chainTruncated,
      diagnosticsTruncated,
      invalidationsTruncated,
    },
  };
}

function roleOfEvent(events: readonly GenericEventRow[], id: string): string | null {
  return events.find((event) => event.id === id)?.eventType ?? null;
}

function stableHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
