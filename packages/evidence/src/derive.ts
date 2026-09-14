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
import { canonicalizeJson } from '@rupturegrid/engine';
import { eventInputHash } from './normalize.js';
import type { NormalizedEventSpec } from './normalize.js';
import { normalizeDemoLineageObservation, normalizeInvocationObservation } from './normalize.js';
import { DEMO_LINEAGE_ADAPTER_KIND } from './demo-adapter.js';

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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recordToPlain(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Loads every raw observation of a run (ordered by chain index) and
 * derives events from the two supported kinds:
 *   - invocation observations (executor HTTP evidence)
 *   - target observations of the explicit Demo lineage adapter
 */
export async function loadNormalizerInputs(
  prisma: PrismaClient,
  runId: string,
): Promise<{
  invocations: Array<{ contentHash: string; chainIndex: number; payload: unknown }>;
  lineageObservations: Array<{ contentHash: string; chainIndex: number; payload: unknown }>;
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
  return { invocations, lineageObservations };
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
  for (const input of inputs.invocations) {
    specs.push(...normalizeInvocationObservation(input));
  }
  for (const input of inputs.lineageObservations) {
    specs.push(...normalizeDemoLineageObservation(input));
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

  return { events, relationships };
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
