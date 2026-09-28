// =====================================================================
// RuptureGrid v1.0 — derivation pipeline (Phase 4, §14/§15)
// =====================================================================
// Persists NormalizedEvents and CausalRelationships derived from the
// run's raw observations. Deterministic and idempotent by input hash:
// re-running derivation on the same observations produces the same
// events; repeat/concurrent runs converge on the SAME rows (unique
// (run, normalizer, version, inputHash)). Causality follows the
// identity chain ONLY (evidence-model §6): providerPaymentId /
// providerEventId / deliveryAttemptId / processingAttemptId carried in
// payloads — never timestamp proximity.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { ManifestEvidencePolicy } from '@rupturegrid/engine';
import { canonicalizeJson } from '@rupturegrid/engine';
import { eventInputHash } from './normalize.js';
import type { NormalizedEventSpec } from './normalize.js';
import { GENERIC_INSPECTION_NORMALIZER_NAME } from './versions.js';
import type { GenericDerivationDiagnosticSpec, GenericInvalidationSpec } from './generic-derive.js';
import {
  GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_NAME,
  GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_VERSION,
  GENERIC_DERIVATION_DIAGNOSTIC_EVENT_TYPE,
  GENERIC_DERIVATION_INVALIDATION_NORMALIZER_NAME,
  GENERIC_DERIVATION_INVALIDATION_NORMALIZER_VERSION,
  GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
} from './versions.js';
import {
  normalizeDemoFaultStatusObservation,
  normalizeDemoLineageObservation,
  normalizeInvocationObservation,
} from './normalize.js';
import { DEMO_FAULT_STATUS_ADAPTER_KIND, DEMO_LINEAGE_ADAPTER_KIND } from './demo-adapter.js';
import { normalizeGenericInspectionObservation } from './generic-normalizer.js';
import { computeGenericDerivation, GENERIC_DERIVATION_CAPS } from './generic-derive.js';
import { GENERIC_INSPECTION_ADAPTER_KIND } from './versions.js';

export interface DerivedEventRow {
  readonly id: string;
  readonly eventType: string;
  readonly subjectKey: string | null;
  readonly normalizerName: string;
  readonly normalizerVersion: string;
  readonly inputHash: string;
}

export interface DerivedRelationshipRow {
  readonly id: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly relationKind: string;
  readonly basis: string;
}

export interface DerivationResult {
  readonly events: DerivedEventRow[];
  readonly relationships: DerivedRelationshipRow[];
  /**
   * Phase 14: count of bounded derivation-gap diagnostics produced by
   * the generic manifest-driven derivation (contested identities,
   * redacted/missing link fields, declared-type mismatches). Honest
   * attribution-gap evidence for Phase 15 — never a Phase 15 verdict.
   */
  readonly genericDerivationGaps: number;
  /**
   * B-2: the ACTIVE generic causal graph this pass — direct edges
   * anchored on contested events and chains routed through contested
   * nodes are excluded. Persisted prior rows are NEVER deleted
   * (logically append-only); `genericInvalidations` carries the
   * durable provenance of what was excluded.
   */
  readonly genericInvalidations: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recordToPlain(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Loads every raw observation of a run (ordered by chain index) and
 * derives events from the supported kinds:
 *   - invocation observations (executor HTTP evidence)
 *   - target observations of the explicit Demo lineage adapter
 *   - Phase 14: target observations of the explicit generic
 *     inspection/v1 adapter (additive; policy from the frozen snapshot)
 */
export async function loadNormalizerInputs(
  prisma: PrismaClient,
  runId: string,
): Promise<{
  invocations: Array<{ contentHash: string; chainIndex: number; payload: unknown }>;
  lineageObservations: Array<{ contentHash: string; chainIndex: number; payload: unknown }>;
  faultStatusObservations: Array<{ contentHash: string; chainIndex: number; payload: unknown }>;
  genericInspectionObservations: Array<{
    contentHash: string;
    chainIndex: number;
    payload: unknown;
  }>;
}> {
  const observations = await prisma.rawObservation.findMany({
    where: { runId },
    orderBy: { chainIndex: 'asc' },
    select: { contentHash: true, chainIndex: true, kind: true, adapterKind: true, payload: true },
  });
  const invocations: Array<{ contentHash: string; chainIndex: number; payload: unknown }> = [];
  const lineageObservations: Array<{
    contentHash: string;
    chainIndex: number;
    payload: unknown;
  }> = [];
  const faultStatusObservations: Array<{
    contentHash: string;
    chainIndex: number;
    payload: unknown;
  }> = [];
  const genericInspectionObservations: Array<{
    contentHash: string;
    chainIndex: number;
    payload: unknown;
  }> = [];
  for (const observation of observations) {
    if (
      observation.kind === 'target_observation' &&
      observation.adapterKind === DEMO_LINEAGE_ADAPTER_KIND
    ) {
      lineageObservations.push({
        contentHash: observation.contentHash,
        chainIndex: observation.chainIndex,
        payload: observation.payload,
      });
    } else if (
      observation.kind === 'target_observation' &&
      observation.adapterKind === DEMO_FAULT_STATUS_ADAPTER_KIND
    ) {
      faultStatusObservations.push({
        contentHash: observation.contentHash,
        chainIndex: observation.chainIndex,
        payload: observation.payload,
      });
    } else if (
      observation.kind === 'target_observation' &&
      observation.adapterKind === GENERIC_INSPECTION_ADAPTER_KIND
    ) {
      genericInspectionObservations.push({
        contentHash: observation.contentHash,
        chainIndex: observation.chainIndex,
        payload: observation.payload,
      });
    } else if (
      observation.kind === 'http_response_observed' ||
      observation.kind === 'executor_error'
    ) {
      invocations.push({
        contentHash: observation.contentHash,
        chainIndex: observation.chainIndex,
        payload: observation.payload,
      });
    }
  }
  return {
    invocations,
    lineageObservations,
    faultStatusObservations,
    genericInspectionObservations,
  };
}

// ---------------------------------------------------------------------
// Phase 14 — generic derivation from the FROZEN evidence policy
// ---------------------------------------------------------------------
// The run's ManifestEvidencePolicy comes ONLY from the run's snapshot
// document (ADR-0010 frozen intent). There is NO code path from live
// TargetRegistration.manifestJson into generic analysis: a later
// re-registration can never alter historical generic derivation.
// Legacy snapshots (no manifestEvidencePolicy) simply carry no generic
// policy — generic observations cannot exist for them anyway, since
// the only generic capture seam consumes the frozen policy.

/**
 * Loads the FROZEN ManifestEvidencePolicy for a run from its snapshot
 * document. Returns undefined for legacy manifest-less snapshots
 * (absence means no generic manifest evidence policy was frozen).
 */
export async function loadFrozenEvidencePolicy(
  prisma: PrismaClient,
  runId: string,
): Promise<ManifestEvidencePolicy | undefined> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (run === null) {
    return undefined;
  }
  const target = (run.snapshot.content as { target?: Record<string, unknown> })['target'];
  if (target === undefined || target === null || typeof target !== 'object') {
    return undefined;
  }
  const policy = (target as Record<string, unknown>)['manifestEvidencePolicy'];
  return policy === undefined || policy === null ? undefined : (policy as ManifestEvidencePolicy);
}

/**
 * Derives and persists events + relationships for a run. Returns the
 * full derived set (existing + newly created). Idempotent.
 */
export async function deriveRunEvidence(
  prisma: PrismaClient,
  runId: string,
): Promise<DerivationResult> {
  const inputs = await loadNormalizerInputs(prisma, runId);
  const specs: NormalizedEventSpec[] = [];
  let frozenGenericPolicy: ManifestEvidencePolicy | undefined;
  for (const input of inputs.invocations) {
    specs.push(...normalizeInvocationObservation(input));
  }
  for (const input of inputs.lineageObservations) {
    specs.push(...normalizeDemoLineageObservation(input));
  }
  for (const input of inputs.faultStatusObservations) {
    specs.push(...normalizeDemoFaultStatusObservation(input));
  }
  // Phase 14 (additive): generic manifest-inspection observations
  // normalize through the frozen evidence policy. A legacy snapshot
  // (no manifestEvidencePolicy) derives ZERO generic events — nothing
  // is guessed from live registration state.
  if (inputs.genericInspectionObservations.length > 0) {
    frozenGenericPolicy = await loadFrozenEvidencePolicy(prisma, runId);
    if (frozenGenericPolicy !== undefined) {
      for (const input of inputs.genericInspectionObservations) {
        specs.push(...normalizeGenericInspectionObservation(input, frozenGenericPolicy));
      }
    }
  }

  // Persist events idempotently: the (run, normalizer, version,
  // inputHash) unique key converges repeats/concurrency on one row.
  const events: DerivedEventRow[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    // The idempotency key covers BOTH the source hashes and the event's
    // own semantic payload: one lineage observation normalizes into many
    // distinct events, each keyed by its own meaning. Hashing only the
    // source hashes would silently collapse distinct events (two
    // deliveries, two effects) into one row.
    const inputHash = eventInputHash(spec.sourceObservationHashes, spec.payload);
    const dedupeKey = `${spec.eventType}|${spec.subjectKey ?? ''}|${inputHash}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const where = {
      runId_normalizerName_normalizerVersion_inputHash: {
        runId,
        normalizerName: spec.normalizerName,
        normalizerVersion: spec.normalizerVersion,
        inputHash,
      },
    } as const;
    try {
      const row = await prisma.normalizedEvent.upsert({
        where,
        create: {
          runId,
          eventType: spec.eventType,
          subjectKey: spec.subjectKey,
          payload: JSON.parse(JSON.stringify(spec.payload)) as object,
          normalizerName: spec.normalizerName,
          normalizerVersion: spec.normalizerVersion,
          inputHash,
          origin: 'DETERMINISTIC_DERIVED',
          sourceObservationHashes: [...spec.sourceObservationHashes],
          primaryObservationIndex: spec.primaryObservationIndex,
        },
        update: {},
        select: {
          id: true,
          eventType: true,
          subjectKey: true,
          normalizerName: true,
          normalizerVersion: true,
          inputHash: true,
        },
      });
      events.push(row);
    } catch (error) {
      // Concurrent derivation passes race on the same deterministic
      // key (worker sweep + explicit analysis). The winner's row is
      // THE row: re-read it and converge — never duplicate.
      if ((error as { code?: string }).code !== 'P2002') {
        throw error;
      }
      const existing = await prisma.normalizedEvent.findUniqueOrThrow({
        where,
        select: {
          id: true,
          eventType: true,
          subjectKey: true,
          normalizerName: true,
          normalizerVersion: true,
          inputHash: true,
        },
      });
      events.push(existing);
    }
  }

  // ---- Causal relationships (identity chain ONLY, evidence-model §6) ----
  const relationships: DerivedRelationshipRow[] = [];
  const relSeen = new Set<string>();
  const addRelationship = async (input: {
    readonly fromEventId: string;
    readonly toEventId: string;
    readonly relationKind: string;
    readonly basis: string;
    readonly evidence: Record<string, unknown>;
  }): Promise<void> => {
    const key = `${input.fromEventId}|${input.toEventId}|${input.relationKind}|${input.basis}`;
    if (relSeen.has(key) || input.fromEventId === input.toEventId) {
      return;
    }
    relSeen.add(key);
    const existing = await prisma.causalRelationship.findUnique({
      where: {
        runId_fromEventId_toEventId_relationKind_basis: {
          runId,
          fromEventId: input.fromEventId,
          toEventId: input.toEventId,
          relationKind: input.relationKind,
          basis: input.basis,
        },
      },
      select: { id: true },
    });
    if (existing !== null) {
      relationships.push({ ...input, id: existing.id });
      return;
    }
    try {
      const created = await prisma.causalRelationship.create({
        data: {
          runId,
          fromEventId: input.fromEventId,
          toEventId: input.toEventId,
          relationKind: input.relationKind,
          basis: input.basis,
          evidenceJson: JSON.parse(JSON.stringify(input.evidence)) as object,
        },
        select: { id: true },
      });
      relationships.push({ ...input, id: created.id });
    } catch (error) {
      // Concurrent passes converge on the same deterministic row.
      if ((error as { code?: string }).code !== 'P2002') {
        throw error;
      }
      const winner = await prisma.causalRelationship.findUniqueOrThrow({
        where: {
          runId_fromEventId_toEventId_relationKind_basis: {
            runId,
            fromEventId: input.fromEventId,
            toEventId: input.toEventId,
            relationKind: input.relationKind,
            basis: input.basis,
          },
        },
        select: { id: true },
      });
      relationships.push({ ...input, id: winner.id });
    }
  };

  // Index events for identity-chain walking.
  const byType = new Map<string, DerivedEventRow[]>();
  const payloadOf = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const list = byType.get(event.eventType) ?? [];
    list.push(event);
    byType.set(event.eventType, list);
  }

  // To read payloads we re-query the persisted rows (ids only were
  // returned by upsert).
  const eventRows = await prisma.normalizedEvent.findMany({
    where: { id: { in: events.map((event) => event.id) } },
    select: { id: true, payload: true, eventType: true },
  });
  for (const row of eventRows) {
    payloadOf.set(row.id, recordToPlain(row.payload));
  }

  const payments = byType.get('demo.provider-payment-observed') ?? [];
  const eventsObserved = byType.get('demo.provider-event-observed') ?? [];
  const deliveries = byType.get('demo.webhook-delivery-observed') ?? [];
  const attempts = byType.get('demo.processing-attempt-observed') ?? [];
  const effects = byType.get('demo.financial-effect-observed') ?? [];
  const ledgerEntries = byType.get('demo.ledger-entry-observed') ?? [];
  const deliveryEventsObserved = byType.get('demo.payment-delivery-observed') ?? [];

  // payment → event (providerPaymentId carried by both payloads).
  for (const payment of payments) {
    const paymentPayload = payloadOf.get(payment.id) ?? {};
    for (const event of eventsObserved) {
      const payload = payloadOf.get(event.id) ?? {};
      if (payload['providerPaymentId'] === paymentPayload['providerPaymentId']) {
        await addRelationship({
          fromEventId: payment.id,
          toEventId: event.id,
          relationKind: 'describes-payment',
          basis: 'identity-direct',
          evidence: { providerPaymentId: payload['providerPaymentId'] ?? null },
        });
      }
    }
  }

  // event → delivery (providerEventId carried by both).
  for (const event of eventsObserved) {
    const eventPayload = payloadOf.get(event.id) ?? {};
    for (const delivery of deliveries) {
      const payload = payloadOf.get(delivery.id) ?? {};
      if (
        payload['providerEventId'] === eventPayload['providerEventId'] &&
        typeof payload['providerEventId'] === 'string'
      ) {
        await addRelationship({
          fromEventId: event.id,
          toEventId: delivery.id,
          relationKind: 'delivered-as',
          basis: 'identity-direct',
          evidence: { providerEventId: payload['providerEventId'] },
        });
      }
    }
  }

  // delivery → processing attempt (deliveryAttemptId carried by both).
  for (const delivery of deliveries) {
    const deliveryPayload = payloadOf.get(delivery.id) ?? {};
    for (const attempt of attempts) {
      const payload = payloadOf.get(attempt.id) ?? {};
      if (
        payload['deliveryAttemptId'] === deliveryPayload['deliveryAttemptId'] &&
        typeof payload['deliveryAttemptId'] === 'string'
      ) {
        await addRelationship({
          fromEventId: delivery.id,
          toEventId: attempt.id,
          relationKind: 'processed-as',
          basis: 'identity-direct',
          evidence: { deliveryAttemptId: payload['deliveryAttemptId'] },
        });
      }
    }
  }

  // processing attempt → financial effect (processingAttemptId carried
  // by both) — the effect's provenance is the target's own record.
  for (const attempt of attempts) {
    const attemptPayload = payloadOf.get(attempt.id) ?? {};
    for (const effect of effects) {
      const payload = payloadOf.get(effect.id) ?? {};
      if (
        payload['processingAttemptId'] === attemptPayload['processingAttemptId'] &&
        typeof payload['processingAttemptId'] === 'string'
      ) {
        await addRelationship({
          fromEventId: attempt.id,
          toEventId: effect.id,
          relationKind: 'produced-effect',
          basis: 'identity-direct',
          evidence: { processingAttemptId: payload['processingAttemptId'] },
        });
      }
    }
  }

  // effect → ledger entry (financialEffectId carried by both).
  for (const effect of effects) {
    const effectPayload = payloadOf.get(effect.id) ?? {};
    for (const entry of ledgerEntries) {
      const payload = payloadOf.get(entry.id) ?? {};
      if (
        payload['financialEffectId'] === effectPayload['financialEffectId'] &&
        typeof payload['financialEffectId'] === 'string'
      ) {
        await addRelationship({
          fromEventId: effect.id,
          toEventId: entry.id,
          relationKind: 'recorded-as-entry',
          basis: 'identity-direct',
          evidence: { financialEffectId: payload['financialEffectId'] },
        });
      }
    }
  }

  // delivery-observed (executor evidence) → target delivery record:
  // the executor's own deliveryAttemptId header identity matches the
  // target-recorded deliveryAttemptId. Executor observation → target
  // record linkage is what makes end-to-end attribution possible
  // without timestamp inference. Only exact identity matches link.
  for (const observed of deliveryEventsObserved) {
    const observedPayload = payloadOf.get(observed.id) ?? {};
    for (const delivery of deliveries) {
      const payload = payloadOf.get(delivery.id) ?? {};
      const observedId = observedPayload['deliveryAttemptId'];
      if (
        typeof observedId === 'string' &&
        payload['deliveryAttemptId'] === observedId &&
        observedPayload['providerEventId'] === payload['providerEventId']
      ) {
        await addRelationship({
          fromEventId: observed.id,
          toEventId: delivery.id,
          relationKind: 'executor-delivery-matches-target',
          basis: 'identity-direct',
          evidence: {
            deliveryAttemptId: observedId,
            providerEventId: observedPayload['providerEventId'] ?? null,
          },
        });
      }
    }
  }

  // ---- Phase 14: generic manifest-driven causal relationships ----
  // Computed ONLY from the run's generic normalized events + the FROZEN
  // evidence policy (loaded from the run's snapshot above). The frozen
  // Demo derivation above is untouched (additive seam). Identity-chain
  // diagnostics (contested identities, redacted/missing link fields,
  // type mismatches) persist as bounded versioned gap events so Phase
  // 15 can honestly evaluate NOT_EVALUABLE where it requires the
  // contested linkage — never a Phase 15 verdict here.
  let genericDiagnostics: GenericDerivationDiagnosticSpec[] = [];
  let genericInvalidations = 0;
  if (frozenGenericPolicy !== undefined) {
    const genericEventRows = eventRows
      .filter((row) => (row.payload as { rupturegrid?: unknown })?.['rupturegrid'] !== undefined)
      .filter((row) => {
        const provenance = (row.payload as Record<string, unknown>)['rupturegrid'];
        return (
          typeof provenance === 'object' &&
          provenance !== null &&
          (provenance as Record<string, unknown>)['normalizerName'] ===
            GENERIC_INSPECTION_NORMALIZER_NAME
        );
      })
      .map((row) => ({
        id: row.id,
        eventType: row.eventType,
        payload: recordToPlain(row.payload),
        sourceObservationHashes: [] as string[],
      }));
    // Source hashes for diagnostics come from the persisted events'
    // traceability arrays; re-read them for the generic rows.
    if (genericEventRows.length > 0) {
      const sourceHashes = new Map<string, string[]>();
      const genericRowsWithHashes = await prisma.normalizedEvent.findMany({
        where: { id: { in: genericEventRows.map((row) => row.id) } },
        select: { id: true, sourceObservationHashes: true },
      });
      for (const row of genericRowsWithHashes) {
        sourceHashes.set(row.id, [...row.sourceObservationHashes]);
      }
      const computation = computeGenericDerivation(
        genericEventRows.map((row) => ({
          ...row,
          sourceObservationHashes: sourceHashes.get(row.id) ?? [],
        })),
        frozenGenericPolicy,
      );
      // ---- B-2: the ACTIVE graph excludes contested-anchor edges ----
      // Computation output already refuses new edges anchored on
      // contested events and refuses chains routed through contested
      // nodes; the `invalidated` flag is defense in depth. Persisted
      // PRIOR rows (from an earlier pass, before the conflict existed)
      // are never deleted — the ACTIVE set is recomputed every pass;
      // their exclusion is recorded below as durable provenance.
      const contestedSet = new Set<string>(computation.contestedEventIds);
      const activeSpecs = computation.relationships.filter(
        (spec) =>
          !spec.invalidated &&
          !contestedSet.has(spec.fromEventId) &&
          !contestedSet.has(spec.toEventId),
      );
      for (const spec of activeSpecs) {
        await addRelationship({
          fromEventId: spec.fromEventId,
          toEventId: spec.toEventId,
          relationKind: spec.relationKind,
          basis: spec.basis,
          evidence: spec.evidence,
        });
      }
      genericDiagnostics = [...computation.diagnostics];
      // Persist gap diagnostics as versioned, RuptureGrid-owned events
      // (NOT target events, NOT findings, NOT Phase 15 verdicts).
      for (const diagnostic of genericDiagnostics) {
        await persistDerivationGapEvent(prisma, runId, diagnostic);
      }
      // ---- B-2: durable invalidation provenance ----
      // For every contested identity group this pass: the stale,
      // previously persisted relationship rows touching its events are
      // named in a deterministic, versioned tombstone event (capped;
      // every excluded relationship id appears across the rows of the
      // group). Prior rows are physically preserved (logically
      // append-only) — the tombstone is the audit trail of the
      // exclusion, and repeat passes converge on identical rows.
      for (const invalidation of computation.invalidations) {
        const invalidatedEventIds = Array.isArray(
          (invalidation.payload as Record<string, unknown>)['invalidatedEventIds'],
        )
          ? ((invalidation.payload as Record<string, unknown>)['invalidatedEventIds'] as string[])
          : [];
        // Stale rows = every PERSISTED relationship (this pass or any
        // earlier pass) touching an event of this contested group.
        // Read from the durable store — earlier-pass rows are not in
        // the in-memory list. Rows are preserved, never deleted.
        const staleRows = await prisma.causalRelationship.findMany({
          where: {
            runId,
            OR: [
              { fromEventId: { in: invalidatedEventIds } },
              { toEventId: { in: invalidatedEventIds } },
            ],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const staleRelationshipIds = staleRows.map((row) => row.id);
        await persistDerivationInvalidationEvent(prisma, runId, invalidation, {
          staleRelationshipIds,
        });
        genericInvalidations += 1;
      }
    }
  }

  return {
    events,
    relationships,
    genericDerivationGaps: genericDiagnostics.length,
    genericInvalidations,
  };
}

/**
 * B-2: persists ONE durable invalidation-provenance event (tombstone)
 * as a versioned normalized event owned by RuptureGrid. Deterministic
 * input hash ⇒ repeat/concurrent derivation converges on the same row;
 * P2002 races converge on the winner (same semantics — never aliased).
 * The tombstone NAMES the persisted relationship rows excluded from
 * the ACTIVE graph; it never deletes them (logically append-only).
 */
async function persistDerivationInvalidationEvent(
  prisma: PrismaClient,
  runId: string,
  invalidation: GenericInvalidationSpec,
  stale: { readonly staleRelationshipIds: readonly string[] },
): Promise<void> {
  const cappedIds = stale.staleRelationshipIds.slice(
    0,
    GENERIC_DERIVATION_CAPS.maxInvalidatedRelationshipIdsPerRow,
  );
  const payload = {
    ...invalidation.payload,
    invalidatedRelationshipIds: cappedIds,
    invalidatedRelationshipCount: stale.staleRelationshipIds.length,
    invalidatedRelationshipIdsTruncated: stale.staleRelationshipIds.length > cappedIds.length,
  };
  const inputHash = eventInputHash(invalidation.sourceObservationHashes, payload);
  const where = {
    runId_normalizerName_normalizerVersion_inputHash: {
      runId,
      normalizerName: GENERIC_DERIVATION_INVALIDATION_NORMALIZER_NAME,
      normalizerVersion: GENERIC_DERIVATION_INVALIDATION_NORMALIZER_VERSION,
      inputHash,
    },
  } as const;
  try {
    await prisma.normalizedEvent.upsert({
      where,
      create: {
        runId,
        eventType: GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
        subjectKey:
          `role:${String(invalidation.roleId)}:identity:${invalidation.identityTupleHash}`.slice(
            0,
            200,
          ),
        payload: JSON.parse(JSON.stringify(payload)) as object,
        normalizerName: GENERIC_DERIVATION_INVALIDATION_NORMALIZER_NAME,
        normalizerVersion: GENERIC_DERIVATION_INVALIDATION_NORMALIZER_VERSION,
        inputHash,
        origin: 'DETERMINISTIC_DERIVED',
        sourceObservationHashes: [...invalidation.sourceObservationHashes],
        primaryObservationIndex: null,
      },
      update: {},
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') {
      throw error;
    }
    // Converge on the winner's row (identical semantics by hash).
  }
}

/**
 * Persists ONE derivation-gap diagnostic as a versioned normalized
 * event owned by RuptureGrid (not a target event, not a finding, not a
 * Phase 15 verdict). Deterministic input hash ⇒ repeat/concurrent
 * derivation converges on the same row; P2002 races converge on the
 * winner (same semantics — never aliased).
 */
async function persistDerivationGapEvent(
  prisma: PrismaClient,
  runId: string,
  diagnostic: GenericDerivationDiagnosticSpec,
): Promise<void> {
  const payload = {
    gapKind: diagnostic.gapKind,
    ...diagnostic.payload,
  };
  const inputHash = eventInputHash(diagnostic.sourceObservationHashes, payload);
  const where = {
    runId_normalizerName_normalizerVersion_inputHash: {
      runId,
      normalizerName: GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_NAME,
      normalizerVersion: GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_VERSION,
      inputHash,
    },
  } as const;
  try {
    await prisma.normalizedEvent.upsert({
      where,
      create: {
        runId,
        eventType: GENERIC_DERIVATION_DIAGNOSTIC_EVENT_TYPE,
        subjectKey: diagnostic.subjectKey.slice(0, 200),
        payload: JSON.parse(JSON.stringify(payload)) as object,
        normalizerName: GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_NAME,
        normalizerVersion: GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_VERSION,
        inputHash,
        origin: 'DETERMINISTIC_DERIVED',
        sourceObservationHashes: [...diagnostic.sourceObservationHashes],
        primaryObservationIndex: null,
      },
      update: {},
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') {
      throw error;
    }
    // Converge on the winner's row (identical semantics by hash).
  }
}

/**
 * Builds the canonical evidence-set input tuple for evaluation:
 * every observation content hash, every derived event id + inputHash,
 * every relationship id — canonicalized and hashed. Deterministic:
 * the same evidence state always produces the same hash.
 */
export async function computeEvidenceSetFingerprint(
  prisma: PrismaClient,
  runId: string,
): Promise<{
  observationHashes: string[];
  eventIds: string[];
  relationshipIds: string[];
  fingerprint: string;
}> {
  const observations = await prisma.rawObservation.findMany({
    where: { runId },
    orderBy: { chainIndex: 'asc' },
    select: { contentHash: true },
  });
  const eventRows = await prisma.normalizedEvent.findMany({
    where: { runId },
    orderBy: { id: 'asc' },
    select: { id: true, inputHash: true },
  });
  const relationshipRows = await prisma.causalRelationship.findMany({
    where: { runId },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const observationHashes = observations.map((row) => row.contentHash).sort();
  const eventIds = eventRows.map((row) => row.id).sort();
  const relationshipIds = relationshipRows.map((row) => row.id).sort();
  const fingerprint = createHash('sha256')
    .update(
      canonicalizeJson({
        observationHashes,
        eventInputHashes: eventRows.map((row) => row.inputHash).sort(),
        eventIds,
        relationshipIds,
      }),
    )
    .digest('hex');
  return { observationHashes, eventIds, relationshipIds, fingerprint };
}
