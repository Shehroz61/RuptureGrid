// =====================================================================
// RuptureGrid v1.0 — forensic timeline derivation (Phase 5, §19–§28)
// =====================================================================
// The forensic timeline is the INVESTIGATION representation of a run
// (evidence-model §9): it organizes the real Phase 3 execution truth
// and Phase 4 derived truth into a stable, source-cited, deterministic
// ordering. It is NOT the source of truth and never mutates it:
//
//   - Every entry cites a TYPED source row (§47) — no source-less
//     synthetic events. Causal claims live ONLY in the cited
//     CausalRelationship rows; temporal adjacency is never causality
//     (§23).
//   - Every ordering carries an explicit basis (evidence-model §9):
//     `sequence` where a deterministic engine ordinal exists,
//     `wall_clock` where only the capture timestamp exists, and
//     `unordered_overlap` where facts were reported as a set (e.g.
//     every entity of one inspection capture) and relative order is
//     NOT knowable — never asserted.
//   - Time semantics stay distinct (§21): execution time (invocation),
//     observedAt (capture time of an observation), and derivedAt
//     (creation of derived truth) are named per entry via `timeMeaning`
//     — never one fake event timestamp. A normalized event's occurredAt
//     is its SOURCE OBSERVATION's capture time (when the fact became
//     evidenced), not the derivation instant.
//   - Logical vs physical actions stay distinct (§24): one logical
//     payment entry, one entry per logical provider event, one entry
//     per PHYSICAL delivery/invocation, one entry per processing
//     attempt, one entry per financial effect — deliveries are never
//     flattened into effects (§51).
//   - Duplicate suppression stays VISIBLE (§25): the secure scenario
//     shows every suppressed delivery/attempt next to the single
//     accepted effect; INDETERMINATE outcomes are first-class entries
//     (evidence-model §9), never smoothed over.
//
// Derivation is deterministic, versioned, and recomputable (§33/§34/
// §67/§68): the same persisted Phase 3/4 inputs always produce the same
// semantic entries; persistence converges via the unique key
// (runId, derivationVersion, sourceKind, sourceId, entryKind). The
// rendered order is time-primary with deterministic tie-breakers
// (§22): (occurredAt, orderingBasis, sourceKind, sourceId, entryKind)
// — insertion order can never influence it.

import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@rupturegrid/engine';
import { TIMELINE_DERIVATION_VERSION } from './versions.js';

/** Bounded timeline entry kinds (§20) — DB enum values. */
export const TIMELINE_ENTRY_KINDS = {
  runTerminalState: 'RUN_TERMINAL_STATE',
  stepTerminalState: 'STEP_TERMINAL_STATE',
  invocationExecuted: 'INVOCATION_EXECUTED',
  httpRequestObserved: 'HTTP_REQUEST_OBSERVED',
  httpResponseObserved: 'HTTP_RESPONSE_OBSERVED',
  executorErrorObserved: 'EXECUTOR_ERROR_OBSERVED',
  providerPaymentObserved: 'PROVIDER_PAYMENT_OBSERVED',
  providerEventObserved: 'PROVIDER_EVENT_OBSERVED',
  webhookDeliveryObserved: 'WEBHOOK_DELIVERY_OBSERVED',
  processingAttemptObserved: 'PROCESSING_ATTEMPT_OBSERVED',
  financialEffectObserved: 'FINANCIAL_EFFECT_OBSERVED',
  ledgerEntryObserved: 'LEDGER_ENTRY_OBSERVED',
  targetStateObserved: 'TARGET_STATE_OBSERVED',
  paymentDeliveryObserved: 'PAYMENT_DELIVERY_OBSERVED',
  invariantEvaluated: 'INVARIANT_EVALUATED',
  findingDerived: 'FINDING_DERIVED',
} as const;

/** Typed source subjects (§47) — DB enum values. */
export const TIMELINE_SOURCE_KINDS = {
  run: 'RUN',
  stepRun: 'STEP_RUN',
  invocation: 'INVOCATION',
  rawObservation: 'RAW_OBSERVATION',
  normalizedEvent: 'NORMALIZED_EVENT',
  causalRelationship: 'CAUSAL_RELATIONSHIP',
  invariantEvaluation: 'INVARIANT_EVALUATION',
  finding: 'FINDING',
} as const;

/** Ordering bases (evidence-model §9) — DB enum values. */
export const TIMELINE_ORDERING_BASES = {
  sequence: 'sequence',
  wallClock: 'wall_clock',
  unorderedOverlap: 'unordered_overlap',
} as const;

export interface TimelineEntrySpec {
  readonly entryKind: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly orderingBasis: string;
  readonly sequenceNumber: number;
  readonly occurredAt: Date;
  readonly timeMeaning: string;
  readonly subjectKey: string | null;
  readonly details: Record<string, unknown>;
}

export interface TimelineDerivationInput {
  readonly run: {
    readonly id: string;
    readonly state: string;
    readonly terminalAt: Date | null;
  };
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly sequence: number;
    readonly name: string;
    readonly state: string;
    readonly intentOutcome: string | null;
    readonly sideEffectKnowledge: string | null;
    readonly terminalAt: Date | null;
  }>;
  readonly invocations: ReadonlyArray<{
    readonly id: string;
    readonly stepRunId: string;
    readonly sequence: number;
    readonly invocationIdentity: string | null;
    readonly outcome: string | null;
    readonly sideEffectKnowledge: string | null;
    readonly httpStatus: number | null;
    readonly createdAt: Date;
    readonly finishedAt: Date | null;
  }>;
  readonly observations: ReadonlyArray<{
    readonly contentHash: string;
    readonly chainIndex: number;
    readonly kind: string;
    readonly adapterKind: string | null;
    readonly observedAt: Date;
    readonly invocationIdentity: string | null;
    readonly payload: unknown;
  }>;
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly eventType: string;
    readonly subjectKey: string | null;
    readonly payload: Record<string, unknown>;
    readonly createdAt: Date;
  }>;
  readonly relationships: ReadonlyArray<{
    readonly id: string;
    readonly fromEventId: string;
    readonly toEventId: string;
    readonly relationKind: string;
    readonly basis: string;
  }>;
  readonly evaluations: ReadonlyArray<{
    readonly id: string;
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly subjectKey: string;
    readonly verdict: string;
    readonly createdAt: Date;
  }>;
}

export interface TimelineDerivationResult {
  readonly entries: TimelineEntrySpec[];
  /** Causal claims available for presentation: relationship count. */
  readonly causalClaimCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Safe bounded JSON detail (sources are already redacted Phase 4 rows). */
function safeDetails(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Deterministic terminal time for an invocation-sourced entry: the
 * invocation's own terminal time when known, else its creation.
 * `timeMeaning` states which semantic the instant carries (§21).
 */
function invocationTime(invocation: TimelineDerivationInput['invocations'][number]): Date {
  return invocation.finishedAt ?? invocation.createdAt;
}

/**
 * Pure timeline derivation over the persisted Phase 3/4 truth. Entry
 * order below is presentation-independent; compareTimelineEntries
 * makes the rendered order total and stable (§22).
 */
export function deriveTimeline(input: TimelineDerivationInput): TimelineDerivationResult {
  const entries: TimelineEntrySpec[] = [];
  const seen = new Set<string>();
  const push = (spec: TimelineEntrySpec): void => {
    const key = `${spec.sourceKind}|${spec.sourceId}|${spec.entryKind}`;
    if (seen.has(key)) {
      return; // One fact, one entry (§48) — source precedence applied below.
    }
    seen.add(key);
    entries.push(spec);
  };

  // ---- RUN terminal state (sequence basis: the run is the root). ----
  if (input.run.terminalAt !== null) {
    push({
      entryKind: TIMELINE_ENTRY_KINDS.runTerminalState,
      sourceKind: TIMELINE_SOURCE_KINDS.run,
      sourceId: input.run.id,
      orderingBasis: TIMELINE_ORDERING_BASES.sequence,
      sequenceNumber: 0,
      occurredAt: input.run.terminalAt,
      timeMeaning: 'execution',
      subjectKey: null,
      details: safeDetails({ runId: input.run.id, state: input.run.state }),
    });
  }

  // ---- STEP terminal states (sequence basis: step ordinals). ----
  for (const step of input.steps) {
    if (step.terminalAt === null) {
      continue;
    }
    push({
      entryKind: TIMELINE_ENTRY_KINDS.stepTerminalState,
      sourceKind: TIMELINE_SOURCE_KINDS.stepRun,
      sourceId: step.id,
      orderingBasis: TIMELINE_ORDERING_BASES.sequence,
      sequenceNumber: step.sequence,
      occurredAt: step.terminalAt,
      timeMeaning: 'execution',
      subjectKey: null,
      details: safeDetails({
        stepRunId: step.id,
        sequence: step.sequence,
        name: step.name,
        state: step.state,
        intentOutcome: step.intentOutcome,
        sideEffectKnowledge: step.sideEffectKnowledge,
      }),
    });
  }

  // ---- Physical invocations (§24: physical attempts are first-class). ----
  for (const invocation of input.invocations) {
    const isExecutorError = invocation.outcome !== null && invocation.outcome !== 'SUCCEEDED';
    push({
      entryKind: TIMELINE_ENTRY_KINDS.invocationExecuted,
      sourceKind: TIMELINE_SOURCE_KINDS.invocation,
      sourceId: invocation.id,
      orderingBasis: TIMELINE_ORDERING_BASES.sequence,
      sequenceNumber: invocation.sequence,
      occurredAt: invocationTime(invocation),
      timeMeaning: 'execution',
      subjectKey: null,
      details: safeDetails({
        invocationId: invocation.id,
        stepRunId: invocation.stepRunId,
        sequence: invocation.sequence,
        invocationIdentity: invocation.invocationIdentity,
        outcome: invocation.outcome,
        sideEffectKnowledge: invocation.sideEffectKnowledge,
        httpStatus: invocation.httpStatus,
      }),
    });
    if (isExecutorError) {
      push({
        entryKind: TIMELINE_ENTRY_KINDS.executorErrorObserved,
        sourceKind: TIMELINE_SOURCE_KINDS.invocation,
        sourceId: invocation.id,
        orderingBasis: TIMELINE_ORDERING_BASES.sequence,
        sequenceNumber: invocation.sequence,
        occurredAt: invocationTime(invocation),
        timeMeaning: 'execution',
        subjectKey: null,
        details: safeDetails({
          invocationId: invocation.id,
          outcome: invocation.outcome,
          sideEffectKnowledge: invocation.sideEffectKnowledge,
        }),
      });
    }
  }

  // ---- Raw observations (wall-clock capture semantics). ----
  // Invocation observations carry the HTTP wire facts; the
  // HTTP_REQUEST/HTTP_RESPONSE entry kinds make transport activity
  // inspectable DISTINCTLY from business effects (§17/§26/§51).
  // Target-state observations (adapter reads) appear as explicit
  // TARGET_STATE_OBSERVED capture points — the entity-level facts come
  // from the normalized events below.
  for (const observation of input.observations) {
    const payload = isRecord(observation.payload) ? observation.payload : {};
    const http = isRecord(payload['http']) ? payload['http'] : null;
    if (http !== null) {
      if (typeof http['method'] === 'string') {
        push({
          entryKind: TIMELINE_ENTRY_KINDS.httpRequestObserved,
          sourceKind: TIMELINE_SOURCE_KINDS.rawObservation,
          sourceId: observation.contentHash,
          orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
          sequenceNumber: observation.chainIndex,
          occurredAt: observation.observedAt,
          timeMeaning: 'observedAt',
          subjectKey: null,
          details: safeDetails({
            contentHash: observation.contentHash,
            kind: observation.kind,
            invocationIdentity: observation.invocationIdentity,
            method: str(http['method']),
            relativePath: str(http['relativePath']),
          }),
        });
      }
      if (typeof http['responseStatus'] === 'number') {
        push({
          entryKind: TIMELINE_ENTRY_KINDS.httpResponseObserved,
          sourceKind: TIMELINE_SOURCE_KINDS.rawObservation,
          sourceId: observation.contentHash,
          orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
          sequenceNumber: observation.chainIndex,
          occurredAt: observation.observedAt,
          timeMeaning: 'observedAt',
          subjectKey: null,
          details: safeDetails({
            contentHash: observation.contentHash,
            kind: observation.kind,
            invocationIdentity: observation.invocationIdentity,
            responseStatus: http['responseStatus'],
          }),
        });
      }
    } else if (observation.kind === 'target_observation') {
      push({
        entryKind: TIMELINE_ENTRY_KINDS.targetStateObserved,
        sourceKind: TIMELINE_SOURCE_KINDS.rawObservation,
        sourceId: observation.contentHash,
        orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
        sequenceNumber: observation.chainIndex,
        occurredAt: observation.observedAt,
        timeMeaning: 'observedAt',
        subjectKey: null,
        details: safeDetails({
          contentHash: observation.contentHash,
          adapterKind: observation.adapterKind,
        }),
      });
    }
  }

  // ---- Normalized events: the business entities (logical vs physical).
  // ---- Their occurredAt is the SOURCE OBSERVATION's capture time (the
  // ---- instant the fact became evidenced); events derived from ONE
  // ---- target-state capture form an unordered_overlap sibling group —
  // ---- the target reported them as a set, and relative order within
  // ---- the set is NOT knowable from the evidence (evidence-model §9).
  const observationByHash = new Map(
    input.observations.map((observation) => [observation.contentHash, observation]),
  );
  type EventRow = TimelineDerivationInput['events'][number];
  const eventsBySourceHash = new Map<string, EventRow[]>();
  for (const event of input.events) {
    const source = isRecord(event.payload['sourceObservation'])
      ? event.payload['sourceObservation']
      : null;
    const hash = source === null ? null : str(source['contentHash']);
    if (hash === null) {
      continue;
    }
    const list = eventsBySourceHash.get(hash) ?? [];
    list.push(event);
    eventsBySourceHash.set(hash, list);
  }
  for (const event of input.events) {
    const entryKind = eventKindFor(event.eventType);
    if (entryKind === null) {
      continue; // Unknown event types are never invented into entries.
    }
    const source = isRecord(event.payload['sourceObservation'])
      ? event.payload['sourceObservation']
      : null;
    const hash = source === null ? null : str(source['contentHash']);
    const observation = hash === null ? undefined : observationByHash.get(hash);
    // Sibling detection: >1 event from the same TARGET-STATE capture
    // share no knowable mutual order. Invocation observations emit at
    // most one business event, so they keep the wall_clock basis.
    const siblings = hash === null ? [] : (eventsBySourceHash.get(hash) ?? []);
    const unorderedSiblings =
      observation !== undefined && observation.kind === 'target_observation' && siblings.length > 1;
    push({
      entryKind,
      sourceKind: TIMELINE_SOURCE_KINDS.normalizedEvent,
      sourceId: event.id,
      orderingBasis: unorderedSiblings
        ? TIMELINE_ORDERING_BASES.unorderedOverlap
        : TIMELINE_ORDERING_BASES.wallClock,
      sequenceNumber: observation === undefined ? 0 : observation.chainIndex,
      occurredAt: observation === undefined ? event.createdAt : observation.observedAt,
      timeMeaning: observation === undefined ? 'derivedAt' : 'observedAt',
      subjectKey: event.subjectKey,
      details: safeDetails({
        eventId: event.id,
        eventType: event.eventType,
        businessIdentities: businessIdentitiesOf(event.eventType, event.payload),
      }),
    });
  }

  // ---- Invariant evaluations (derived truth; deterministically placed). ----
  for (const evaluation of input.evaluations) {
    push({
      entryKind: TIMELINE_ENTRY_KINDS.invariantEvaluated,
      sourceKind: TIMELINE_SOURCE_KINDS.invariantEvaluation,
      sourceId: evaluation.id,
      orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
      sequenceNumber: 0,
      occurredAt: evaluation.createdAt,
      timeMeaning: 'derivedAt',
      subjectKey: evaluation.subjectKey,
      details: safeDetails({
        evaluationId: evaluation.id,
        invariantKey: evaluation.invariantKey,
        evaluatorVersion: evaluation.evaluatorVersion,
        verdict: evaluation.verdict,
      }),
    });
  }

  // ---- FINDING_DERIVED entries are appended by the pipeline AFTER
  // ---- Finding persistence (source: the Finding row itself).

  return {
    entries,
    causalClaimCount: input.relationships.length,
  };
}

/**
 * FINDING_DERIVED entry builder (used by the pipeline post-persist).
 * The source is the FINDING row itself — the derived artifact the
 * entry presents (§47: typed source, no source-less entries).
 */
export function findingTimelineEntry(input: {
  readonly findingId: string;
  readonly runId: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly invariantKey: string;
  readonly createdAt: Date;
}): TimelineEntrySpec {
  return {
    entryKind: TIMELINE_ENTRY_KINDS.findingDerived,
    sourceKind: TIMELINE_SOURCE_KINDS.finding,
    sourceId: input.findingId,
    orderingBasis: TIMELINE_ORDERING_BASES.wallClock,
    sequenceNumber: 0,
    occurredAt: input.createdAt,
    timeMeaning: 'derivedAt',
    subjectKey: input.subjectKey,
    details: safeDetails({
      findingId: input.findingId,
      runId: input.runId,
      reasonCode: input.reasonCode,
      invariantKey: input.invariantKey,
    }),
  };
}

/**
 * The persisted total order (§22): time-primary with explicit
 * deterministic tie-breakers — no insertion-order dependence, no
 * relying on SELECT ... ORDER BY timestamp alone when timestamps tie.
 */
export function compareTimelineEntries(a: TimelineEntrySpec, b: TimelineEntrySpec): number {
  const at = a.occurredAt.getTime();
  const bt = b.occurredAt.getTime();
  if (at !== bt) {
    return at - bt;
  }
  if (a.orderingBasis !== b.orderingBasis) {
    return a.orderingBasis < b.orderingBasis ? -1 : 1;
  }
  if (a.sourceKind !== b.sourceKind) {
    return a.sourceKind < b.sourceKind ? -1 : 1;
  }
  if (a.sourceId !== b.sourceId) {
    return a.sourceId < b.sourceId ? -1 : 1;
  }
  if (a.entryKind !== b.entryKind) {
    return a.entryKind < b.entryKind ? -1 : 1;
  }
  return 0;
}

/** Timeline derivation input fingerprint (§33): versioned, recomputable. */
export function timelineInputFingerprint(input: TimelineDerivationInput): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        derivationVersion: TIMELINE_DERIVATION_VERSION,
        run: { id: input.run.id, state: input.run.state },
        steps: input.steps.map((step) => [step.id, step.state, step.terminalAt?.toISOString()]),
        invocations: input.invocations.map((invocation) => [invocation.id, invocation.outcome]),
        observationHashes: input.observations.map((observation) => observation.contentHash).sort(),
        eventIds: input.events.map((event) => event.id).sort(),
        relationshipIds: input.relationships.map((relationship) => relationship.id).sort(),
        evaluationIds: input.evaluations.map((evaluation) => evaluation.id).sort(),
      }),
    )
    .digest('hex');
}

function eventKindFor(eventType: string): string | null {
  switch (eventType) {
    case 'demo.provider-payment-observed':
      return TIMELINE_ENTRY_KINDS.providerPaymentObserved;
    case 'demo.provider-event-observed':
      return TIMELINE_ENTRY_KINDS.providerEventObserved;
    case 'demo.webhook-delivery-observed':
      return TIMELINE_ENTRY_KINDS.webhookDeliveryObserved;
    case 'demo.processing-attempt-observed':
      return TIMELINE_ENTRY_KINDS.processingAttemptObserved;
    case 'demo.financial-effect-observed':
      return TIMELINE_ENTRY_KINDS.financialEffectObserved;
    case 'demo.ledger-entry-observed':
      return TIMELINE_ENTRY_KINDS.ledgerEntryObserved;
    case 'demo.payment-delivery-observed':
      return TIMELINE_ENTRY_KINDS.paymentDeliveryObserved;
    default:
      return null; // Unknown event types are never invented into entries.
  }
}

/** Bounded identity set per entity type (§97: identities stay distinct). */
function businessIdentitiesOf(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const identities: Record<string, unknown> = {};
  const copy = (key: string): void => {
    if (typeof payload[key] === 'string' || typeof payload[key] === 'number') {
      identities[key] = payload[key];
    }
  };
  copy('providerPaymentId');
  copy('providerEventId');
  copy('deliveryAttemptId');
  copy('processingAttemptId');
  copy('financialEffectId');
  copy('walletId');
  copy('effectType');
  copy('amountMinor');
  copy('currency');
  copy('balanceMinor');
  copy('outcome');
  copy('status');
  copy('entryType');
  copy('eventType');
  return { eventType, ...identities };
}
