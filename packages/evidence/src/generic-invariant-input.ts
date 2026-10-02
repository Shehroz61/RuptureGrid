// =====================================================================
// RuptureGrid v1.1 Phase 15 — persisted-evidence evaluation input
// loader/adapter + deterministic evidence-set hashing
// (ADR-0023 §12 analysis wiring; roadmap Phase 15)
// =====================================================================
// Builds the PURE evaluator input (generic-invariant-evaluate.ts) from
// PERSISTED truth only:
//
//   - the run's FROZEN snapshot (policy + target identity — ADR-0010);
//   - the FROZEN ManifestEvidencePolicy (never live registration);
//   - FROZEN invariant instance params (from the snapshot's invariant
//     bindings — the durable InvariantDefinition row is registry
//     metadata only, never a live evaluation authority);
//   - persisted Phase 14 RawObservations (capture validity per
//     ADR-0021: OBSERVED origin + 2xx + non-truncated + valid shape);
//   - persisted NormalizedEvents (declared business payload only — the
//     `rupturegrid` provenance sub-object is never read as target data);
//   - the ACTIVE Phase 14 causal graph (contested/invalidated edges
//     excluded; prior stale rows physically remain but are never
//     attribution inputs);
//   - platform run/snapshot/target identity (never comparand data).
//
// Analysis must stay reproducible after process restart: every input
// comes from durable rows — no in-memory dependency, no timestamps as
// identity/coherence, no target HTTP, no AI.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import type { PrismaClient } from '@rupturegrid/control-db';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';
import type {
  GenericEvidenceEntity,
  GenericEvaluationSubject,
  GenericActiveRelationship,
  evaluateGenericInvariant,
} from './generic-invariant-evaluate.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One Phase 14 generic inspection capture's persisted provenance. */
export interface PersistedCaptureStatus {
  readonly queryId: string;
  readonly roleId: string;
  readonly valid: boolean;
  readonly captured: boolean;
  readonly reasonCode: string;
  readonly sourceObservationHashes: readonly string[];
}

/**
 * Reads the durable Phase 14 capture provenance for one run: one
 * entry per generic-inspection RawObservation. Capture validity is
 * derived EXACTLY from the persisted envelope (§13) — never from the
 * existence of normalized events:
 *
 *   usable capture = target_observation of the generic adapter
 *     + OBSERVED origin
 *     + successful 2xx eligibility (observed.httpStatus in 2xx)
 *     + non-truncated (observed.truncated === false AND row.truncated
 *       false)
 *     + JSON/shape/schema valid (validation.valid === true)
 *
 * A valid `[]` capture IS valid (observed empty enumeration); a
 * non-2xx, truncated, malformed, never-captured, or shape-invalid
 * surface is ABSENT/INVALID — never zero entities.
 */
export async function loadPersistedCaptureStatuses(
  prisma: PrismaClient,
  runId: string,
): Promise<ReadonlyMap<string, PersistedCaptureStatus>> {
  const rows = await prisma.rawObservation.findMany({
    where: { runId, kind: 'target_observation', adapterKind: GENERIC_INSPECTION_ADAPTER_KIND },
    orderBy: { chainIndex: 'asc' },
    select: { contentHash: true, truncated: true, origin: true, payload: true },
  });
  const byQuery = new Map<string, PersistedCaptureStatus>();
  for (const row of rows) {
    const payload = isRecord(row.payload) ? row.payload : {};
    const declaration = isRecord(payload['declaration'])
      ? (payload['declaration'] as Record<string, unknown>)
      : {};
    const observed = isRecord(payload['observed'])
      ? (payload['observed'] as Record<string, unknown>)
      : {};
    const validation = isRecord(payload['validation'])
      ? (payload['validation'] as Record<string, unknown>)
      : {};
    const queryId = typeof declaration['queryId'] === 'string' ? declaration['queryId'] : null;
    const roleId = typeof declaration['roleId'] === 'string' ? declaration['roleId'] : '';
    if (queryId === null) {
      continue; // No declared query provenance: never guessed into a surface.
    }
    const observedOrigin = row.origin === 'OBSERVED';
    const httpStatus = typeof observed['httpStatus'] === 'number' ? observed['httpStatus'] : null;
    const status2xx = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const nonTruncated = observed['truncated'] !== true && row.truncated !== true;
    const shapeValid = validation['valid'] === true;
    const valid = observedOrigin && status2xx && nonTruncated && shapeValid;
    const reasonCode =
      typeof validation['reasonCode'] === 'string'
        ? validation['reasonCode']
        : valid
          ? 'VALID'
          : 'CAPTURE_INVALID_OR_ABSENT';
    // First capture per queryId wins the slot (the capture seam is
    // idempotent per queryId within a run — a second capture with
    // different content raises an integrity conflict, so at most one
    // distinct capture exists per queryId).
    if (!byQuery.has(queryId)) {
      byQuery.set(queryId, {
        queryId,
        roleId,
        valid,
        captured: true,
        reasonCode,
        sourceObservationHashes: [row.contentHash],
      });
    }
  }
  return byQuery;
}

/**
 * Loads the generic role events of a run (declared roles only), their
 * contested-identity set, and the ACTIVE generic causal graph —
 * exactly the Phase 14 artifacts, filtered by the frozen policy.
 * Loaded ONCE per analysis pass and reused across subjects.
 */
export async function loadGenericEventsAndActiveGraph(
  prisma: PrismaClient,
  runId: string,
  policy: ManifestEvidencePolicy,
): Promise<{
  readonly entities: readonly GenericEvidenceEntity[];
  readonly contestedEventIds: ReadonlySet<string>;
  readonly activeRelationships: readonly GenericActiveRelationship[];
}> {
  const declaredRoles = new Set(policy.identityModel.nodes.map((node) => node.roleId));
  const eventRows = await prisma.normalizedEvent.findMany({
    where: { runId, eventType: { in: [...declaredRoles] } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      eventType: true,
      payload: true,
      sourceObservationHashes: true,
      normalizerName: true,
    },
  });
  const entities: GenericEvidenceEntity[] = [];
  for (const row of eventRows) {
    // Only events produced by the generic inspection normalizer are
    // role events of the frozen policy — platform-owned diagnostic and
    // invalidation events can never masquerade as target role events.
    if (row.normalizerName !== 'generic-inspection-normalizer') {
      continue;
    }
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    entities.push({
      eventId: row.id,
      roleId: row.eventType,
      // queryId provenance comes from the reserved provenance object.
      queryId:
        isRecord(payload['rupturegrid']) &&
        typeof (payload['rupturegrid'] as Record<string, unknown>)['queryId'] === 'string'
          ? ((payload['rupturegrid'] as Record<string, unknown>)['queryId'] as string)
          : '',
      payload,
      sourceObservationHashes: [...row.sourceObservationHashes],
      contested: false, // Resolved below from derivation diagnostics.
    });
  }

  // Contested identities: derivation-gap diagnostic events name the
  // affected event ids per role; contested subjects never anchor or
  // receive attribution (ADR-0017 Decision 3, B-2/B-3).
  const contestedEventIds = new Set<string>();
  const diagnosticRows = await prisma.normalizedEvent.findMany({
    where: { runId, eventType: 'rupturegrid.derivation-gap-observed' },
    select: { payload: true },
  });
  for (const row of diagnosticRows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const gapKind = payload['gapKind'];
    if (gapKind !== 'contested-identity') {
      continue;
    }
    const affected = payload['affectedEventIds'];
    if (Array.isArray(affected)) {
      for (const id of affected) {
        if (typeof id === 'string') {
          contestedEventIds.add(id);
        }
      }
    }
  }

  // ACTIVE graph: recompute the exclusion exactly as the accepted Phase
  // 14 derivation does — direct edges anchored on contested events and
  // chains routed through contested nodes are NOT attribution inputs,
  // even though prior stale rows physically remain in the store.
  const relationshipRows = await prisma.causalRelationship.findMany({
    where: { runId, basis: { in: ['identity-direct', 'identity-chain'] } },
    orderBy: { id: 'asc' },
    select: { id: true, fromEventId: true, toEventId: true, relationKind: true, basis: true },
  });
  const genericEventIds = new Set(entities.map((entity) => entity.eventId));
  const eventRoleById = new Map(entities.map((entity) => [entity.eventId, entity.roleId]));
  const activeRelationships: GenericActiveRelationship[] = [];
  for (const row of relationshipRows) {
    if (!genericEventIds.has(row.fromEventId) || !genericEventIds.has(row.toEventId)) {
      continue; // Demo-lineage edges are not generic attribution inputs.
    }
    if (contestedEventIds.has(row.fromEventId) || contestedEventIds.has(row.toEventId)) {
      continue; // Stale/invalidated: never an active proof (§17).
    }
    // Chains may not be ROUTED through contested intermediate nodes —
    // the persisted chain evidence names its path; any contested hop
    // disqualifies the row.
    if (row.basis === 'identity-chain') {
      const chainEvidence = await prisma.causalRelationship.findUnique({
        where: { id: row.id },
        select: { evidenceJson: true },
      });
      const paths = isRecord(chainEvidence?.evidenceJson)
        ? (chainEvidence?.evidenceJson as Record<string, unknown>)['paths']
        : undefined;
      if (Array.isArray(paths)) {
        const routesThroughContested = paths.some(
          (path) =>
            isRecord(path) &&
            Array.isArray((path as Record<string, unknown>)['eventIds']) &&
            ((path as Record<string, unknown>)['eventIds'] as unknown[]).some(
              (id) => typeof id === 'string' && contestedEventIds.has(id),
            ),
        );
        if (routesThroughContested) {
          continue;
        }
      }
    }
    // Chain rows must carry the platform-owned reachability kind.
    if (row.basis === 'identity-chain' && row.relationKind !== 'identity-chain-reachability') {
      continue;
    }
    void eventRoleById;
    activeRelationships.push({
      relationshipId: row.id,
      fromEventId: row.fromEventId,
      toEventId: row.toEventId,
      relationKind: row.relationKind,
      basis: row.basis as 'identity-direct' | 'identity-chain',
    });
  }
  return { entities, contestedEventIds, activeRelationships };
}

/**
 * Resolves the evaluation subjects for one frozen instance: exact
 * identity binding on the declared subject/resource identity field.
 * Subject events are grouped by their exact identity VALUE — two
 * events with the same value are convergent observations of ONE
 * subject; conflicting payloads on the same value surface as the
 * contested set (checked by the evaluator).
 */
export async function loadGenericEvaluationSubjects(
  prisma: PrismaClient,
  runId: string,
  policy: ManifestEvidencePolicy,
  instance: { readonly kind: string; readonly params: Record<string, unknown> },
): Promise<readonly GenericEvaluationSubject[]> {
  const { entities, contestedEventIds } = await loadGenericEventsAndActiveGraph(
    prisma,
    runId,
    policy,
  );
  const subjectRole =
    instance.kind === 'atMostOneAcceptedEffect' ? (instance.params['subjectRole'] as string) : null;
  const identityField =
    instance.kind === 'atMostOneAcceptedEffect'
      ? (instance.params['subjectIdentityField'] as string)
      : (instance.params['resourceIdentityField'] as string);
  const consumptionRole =
    instance.kind === 'resourceConservation'
      ? (instance.params['consumptionEffectRole'] as string)
      : null;
  const REDACTED = '[Redacted]';
  const byIdentity = new Map<string, GenericEvidenceEntity[]>();
  for (const entity of entities) {
    if (subjectRole !== null) {
      if (entity.roleId !== subjectRole) {
        continue;
      }
    } else if (consumptionRole !== null && entity.roleId === consumptionRole) {
      continue;
    }
    const value = entity.payload[identityField];
    if (value === undefined || value === null || value === REDACTED) {
      continue; // No exact binding: never a subject.
    }
    const key = `${typeof value}:${String(value)}`;
    const list = byIdentity.get(key) ?? [];
    list.push(entity);
    byIdentity.set(key, list);
  }
  const subjects: GenericEvaluationSubject[] = [];
  for (const [key, group] of [...byIdentity.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...group].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const first = sorted[0];
    if (first === undefined) {
      continue;
    }
    subjects.push({
      subjectKey: key.startsWith('string:') ? key.slice('string:'.length) : key,
      subjectEventIds: sorted.map((entity) => entity.eventId),
      subjectPayload: first.payload,
    });
  }
  void contestedEventIds;
  return subjects;
}

/**
 * Builds the complete PURE evaluator input for one (run, instance,
 * subject) from persisted truth only. The caller supplies the frozen
 * instance (from the run snapshot's invariant bindings), the frozen
 * policy, and the pre-loaded events/graph (loaded once per run and
 * reused across subjects).
 */
export function buildGenericEvaluationInput(options: {
  readonly runId: string;
  readonly snapshotContentHash: string;
  readonly targetId: string;
  readonly instance: {
    readonly key: string;
    readonly kind: 'atMostOneAcceptedEffect' | 'resourceConservation';
    readonly registryVersion: string;
    readonly params: Record<string, unknown>;
  };
  readonly policy: ManifestEvidencePolicy;
  readonly captures: ReadonlyMap<string, PersistedCaptureStatus>;
  readonly entities: readonly GenericEvidenceEntity[];
  readonly contestedEventIds: ReadonlySet<string>;
  readonly activeRelationships: readonly GenericActiveRelationship[];
  readonly subject: GenericEvaluationSubject;
  // Parameters<> is used deliberately here: the evaluator's input shape is the
  // contract, and the two evaluators accept the same discriminated union.
}): Parameters<typeof evaluateGenericInvariant>[0] {
  const queriesByRole = new Map<string, string[]>();
  for (const query of options.policy.inspection) {
    const list = queriesByRole.get(query.roleId) ?? [];
    list.push(query.queryId);
    queriesByRole.set(query.roleId, list);
  }
  const captureStatuses = new Map(
    [...options.captures.entries()].map(([queryId, status]) => [
      queryId,
      {
        queryId: status.queryId,
        roleId: status.roleId,
        valid: status.valid,
        captured: status.captured,
        reasonCode: status.reasonCode,
        sourceObservationHashes: status.sourceObservationHashes,
      },
    ]),
  );
  // Add ABSENT entries for declared queries that were never captured:
  // the evaluator must see declared-but-absent surfaces, not discover
  // them as `undefined`.
  for (const query of options.policy.inspection) {
    if (!captureStatuses.has(query.queryId)) {
      captureStatuses.set(query.queryId, {
        queryId: query.queryId,
        roleId: query.roleId,
        valid: false,
        captured: false,
        reasonCode: 'NO_CAPTURE_PRESENT',
        sourceObservationHashes: [],
      });
    }
  }
  return {
    runId: options.runId,
    snapshotContentHash: options.snapshotContentHash,
    targetId: options.targetId,
    instance: {
      key: options.instance.key,
      kind: options.instance.kind,
      registryVersion: options.instance.registryVersion,
      params: options.instance.params,
    },
    captures: captureStatuses,
    queriesByRole,
    entities: options.entities,
    activeRelationships: options.activeRelationships,
    subject: options.subject,
    contestedEventIds: options.contestedEventIds,
  } as never;
}

/**
 * Deterministic generic evidence-set hash (§37): SHA-256 over the
 * canonical semantic input/proof set — only truth-relevant persisted
 * identities/facts, all unordered sets sorted. No wall clock, no DB
 * insertion order, no random ids, no evaluation createdAt. Same
 * semantic evidence ⇒ same hash; new truth-relevant evidence ⇒ new
 * hash under the existing append-only evaluation discipline.
 */
export function genericEvidenceSetHash(input: {
  readonly registryVersion: string;
  readonly kind: string;
  readonly evaluatorVersion: string;
  readonly runId: string;
  readonly snapshotContentHash: string;
  readonly targetId: string;
  readonly subjectKey: string;
  readonly evidence: {
    readonly captureHashes: readonly string[];
    readonly eventIds: readonly string[];
    readonly relationshipIds: readonly string[];
    readonly verdict: string;
    readonly gap: string | null;
    readonly failureMechanism: string | null;
  };
}): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        registryVersion: input.registryVersion,
        kind: input.kind,
        evaluatorVersion: input.evaluatorVersion,
        runId: input.runId,
        snapshotContentHash: input.snapshotContentHash,
        targetId: input.targetId,
        subjectKey: input.subjectKey,
        captureHashes: [...input.evidence.captureHashes].sort(),
        eventIds: [...input.evidence.eventIds].sort(),
        relationshipIds: [...input.evidence.relationshipIds].sort(),
        verdict: input.evidence.verdict,
        gap: input.evidence.gap,
        failureMechanism: input.evidence.failureMechanism,
      }),
    )
    .digest('hex');
}
