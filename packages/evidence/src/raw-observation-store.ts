// =====================================================================
// RuptureGrid v1.0 — raw observation capture (Phase 4, §10/§16/§17)
// =====================================================================
// The append service for the evidence store. Guarantees:
//
//   APPEND-ONLY      — create-only persistence; no update/delete path
//                      for observations (evidence-model §4). DB
//                      triggers (migration 0003) back this up.
//   CONTENT-ADDRESSED — contentHash = SHA-256 over the canonical
//                      REDACTED stored representation. Identity for
//                      idempotency is the PROVENANCE TUPLE (runId,
//                      kind, invocationIdentity), NOT the content hash:
//                      identical content across different provenance is
//                      DIFFERENT evidence (separate rows), while an
//                      exact re-persistence of the same provenance
//                      identity resolves to ONE row (§16) and same
//                      identity + different content is an explicit
//                      integrity conflict (never aliased, never
//                      overwritten).
//   HASH-CHAINED     — per run, chainIndex is gap-free and
//                      prevContentHash links each observation to its
//                      predecessor; the head lives in
//                      evidence_integrity_head (evidence-model §4).
//   NOT FENCED       — a stale generation's truthful observation may
//                      be appended with ITS writer identity (§14); it
//                      never regains authority over execution state.
//
// Capture failures never block execution; the engine records them as
// honest incompleteness (an observation that happened but was not
// durably captured is still never fabricated).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { InvocationObservation, EvidenceSink } from '@rupturegrid/engine';
import {
  canonicalEvidenceHash,
  redactBoundedText,
  redactHeaders,
  redactJson,
  REDACTION_POLICY_VERSION,
  REDACTED_MARKER,
  EVIDENCE_HASH_ALGORITHM,
} from './redact.js';
import { OBSERVATION_SCHEMA_VERSION } from './versions.js';

export class EvidenceCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EvidenceCaptureError';
  }
}

/**
 * The requested observation EXISTS under the same provenance identity
 * but with DIFFERENT stored content. This is an explicit integrity
 * conflict: evidence is never overwritten, never silently reinterpreted,
 * and never answered with someone else's row.
 */
export class EvidenceIntegrityConflictError extends EvidenceCaptureError {
  public constructor(message: string) {
    super(message);
    this.name = 'EvidenceIntegrityConflictError';
  }
}

/** Bounded stored-representation cap (characters of JSON text). */
export const OBSERVATION_PAYLOAD_MAX_CHARS = 16_000;

export interface ChainAppendedObservation {
  readonly id: string;
  readonly contentHash: string;
  readonly chainIndex: number;
}

/**
 * Builds the durable payload document for one invocation observation —
 * the canonical stored representation (redaction applied BEFORE this
 * document is hashed and persisted).
 */
function buildInvocationPayload(observation: InvocationObservation): {
  payload: unknown;
  redactionApplied: boolean;
  truncated: boolean;
} {
  const requestHeaders = redactHeaders(observation.requestHeaders);
  const responseHeaders =
    observation.responseHeaders === null ? null : redactHeaders(observation.responseHeaders);
  const requestBody =
    observation.requestBody === null ? null : redactBoundedText(observation.requestBody, 8_000);
  const responseBody =
    observation.responseBody === null ? null : redactBoundedText(observation.responseBody, 8_000);

  const redactionApplied =
    Object.values(requestHeaders).includes(REDACTED_MARKER) ||
    (responseHeaders !== null && Object.values(responseHeaders).includes(REDACTED_MARKER)) ||
    (requestBody !== null && requestBody.redactionApplied) ||
    (responseBody !== null && responseBody.redactionApplied);

  const payload = {
    kind: 'invocation',
    http: {
      method: observation.method,
      relativePath: observation.relativePath,
      requestHeaders,
      requestBody: requestBody === null ? null : requestBody.text,
      responseStatus: observation.httpStatus,
      responseHeaders,
      responseBody: responseBody === null ? null : responseBody.text,
    },
    transport: {
      stage: observation.transportStage,
      requestBytes: observation.requestBytes,
      responseBytes: observation.responseBytes,
      responseTruncated:
        observation.responseTruncated || (responseBody !== null && responseBody.truncated),
      durationMs: observation.durationMs,
    },
    outcome: observation.outcome,
    error: observation.error,
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      applied: redactionApplied,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM,
    },
  };
  return {
    payload,
    redactionApplied,
    truncated: observation.responseTruncated || (responseBody !== null && responseBody.truncated),
  };
}

export interface CaptureInput {
  readonly observation: InvocationObservation;
  /** Worker generation provenance (§14: attributed, never erased). */
  readonly writerOwnerId: string;
  readonly writerFencingToken: string | null;
}

export class RawObservationStore {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Appends one invocation observation to the run's hash chain.
   *
   * Identity is the PROVENANCE TUPLE (runId, kind, invocationIdentity)
   * — not the content hash. An exact re-persistence of the SAME
   * physical invocation's observation (bounded-retry semantics) is
   * idempotent: it resolves to the SAME row. A different invocation —
   * or a different run reusing an identity string — is a DIFFERENT
   * observation with its own row, never an alias of other evidence.
   * Same identity + different stored content ⇒ explicit integrity
   * conflict (never overwrite, never a false idempotent success).
   */
  public async appendInvocationObservation(input: CaptureInput): Promise<ChainAppendedObservation> {
    const { observation } = input;
    const built = buildInvocationPayload(observation);
    // An invocation whose failure detail exists is ALSO the
    // executor_error observation kind (evidence-model §3): one physical
    // invocation, one honest observation row that records the error.
    const kind = observation.error === null ? 'http_response_observed' : 'executor_error';
    const { hash } = canonicalEvidenceHash(built.payload);
    return this.appendChainObservation({
      runId: observation.runId,
      stepRunId: observation.stepRunId,
      invocationId: observation.invocationId,
      invocationIdentity: observation.invocationIdentity,
      kind,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      observedAt: observation.observedAt,
      payload: built.payload,
      redactionApplied: built.redactionApplied,
      truncated: built.truncated,
      contentHash: hash,
      origin: 'OBSERVED',
      writerOwnerId: input.writerOwnerId,
      writerFencingToken: input.writerFencingToken,
    });
  }

  /**
   * Appends a target_observation captured by an EXPLICIT read-only
   * adapter (evidence-model §3). The payload is redacted here, before
   * hashing — never after persistence. The adapter kind is recorded on
   * the row (explicit provenance — §28/§29), and the observation
   * identity derives from the adapter kind so re-captures of the SAME
   * logical observation are idempotent while distinct adapter reads
   * remain distinct rows.
   */
  public async appendTargetObservation(input: {
    readonly runId: string;
    readonly stepRunId: string | null;
    readonly adapterKind: string;
    readonly observedAt: Date;
    readonly payload: unknown;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }): Promise<ChainAppendedObservation> {
    const redacted = redactJson(input.payload);
    const { hash } = canonicalEvidenceHash(redacted);
    // Identity derives from the REDACTED representation's hash (§18:
    // no durable derivative of unredacted content, not even a digest).
    return this.appendChainObservation({
      runId: input.runId,
      stepRunId: input.stepRunId,
      invocationId: null,
      invocationIdentity: `adapter:${input.adapterKind}:${hash.slice(0, 16)}`,
      kind: 'target_observation',
      adapterKind: input.adapterKind,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      observedAt: input.observedAt,
      payload: redacted,
      redactionApplied: JSON.stringify(redacted) !== JSON.stringify(input.payload),
      truncated: false,
      contentHash: hash,
      origin: 'OBSERVED',
      writerOwnerId: input.writerOwnerId,
      writerFencingToken: input.writerFencingToken,
    });
  }

  /**
   * The single chain-append primitive. Allocates the next chain index
   * under a transaction with an advisory lock on the run (serializes
   * concurrent appenders without serializing the whole store), links
   * to the current head, and advances the integrity head row.
   */
  private async appendChainObservation(input: {
    readonly runId: string;
    readonly stepRunId: string | null;
    readonly invocationId: string | null;
    readonly invocationIdentity: string | null;
    readonly kind: string;
    readonly adapterKind?: string;
    readonly schemaVersion: string;
    readonly observedAt: Date;
    readonly payload: unknown;
    readonly redactionApplied: boolean;
    readonly truncated: boolean;
    readonly contentHash: string;
    readonly origin: 'OBSERVED';
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }): Promise<ChainAppendedObservation> {
    // `kind` arrives as a string union of the accepted observation
    // kinds; the generated client requires the enum-typed name.
    const kindName = input.kind as Parameters<
      PrismaClient['rawObservation']['create']
    >[0]['data']['kind'];
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Advisory lock: one appender at a time per run. Fair queueing
          // is not required — only exclusion.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}::text))`;

          // ---- Idempotency by PROVENANCE IDENTITY (inside the lock) ----
          // The identity tuple is (runId, kind, invocationIdentity). If a
          // row already exists for THIS run's invocation: identical stored
          // content ⇒ return it (exact retry); different content ⇒
          // explicit integrity conflict. Evidence is never aliased across
          // provenance and never silently reinterpreted.
          const existing = await tx.rawObservation.findUnique({
            where: {
              runId_kind_invocationIdentity: {
                runId: input.runId,
                kind: kindName,
                invocationIdentity: input.invocationIdentity ?? '',
              },
            },
            select: { id: true, contentHash: true, chainIndex: true },
          });
          if (existing !== null) {
            if (existing.contentHash === input.contentHash) {
              return {
                id: existing.id,
                contentHash: existing.contentHash,
                chainIndex: existing.chainIndex,
              };
            }
            throw new EvidenceIntegrityConflictError(
              `observation identity (run=${input.runId}, kind=${input.kind}, invocation=${input.invocationIdentity ?? 'null'}) ` +
                `already exists with a DIFFERENT stored content hash (${existing.contentHash}); ` +
                'refusing to overwrite or alias evidence — append a superseding observation with its own provenance',
            );
          }

          const head = await tx.evidenceIntegrityHead.findUnique({
            where: { runId: input.runId },
            select: { lastChainIndex: true, headContentHash: true },
          });
          const chainIndex = (head?.lastChainIndex ?? -1) + 1;
          const prevContentHash = head === null ? null : head.headContentHash;

          const created = await tx.rawObservation.create({
            data: {
              id,
              runId: input.runId,
              ...(input.stepRunId === null ? {} : { stepRunId: input.stepRunId }),
              ...(input.invocationId === null ? {} : { invocationId: input.invocationId }),
              ...(input.invocationIdentity === null
                ? {}
                : { invocationIdentity: input.invocationIdentity }),
              kind: input.kind as never,
              ...(input.adapterKind === undefined ? {} : { adapterKind: input.adapterKind }),
              schemaVersion: input.schemaVersion,
              observedAt: input.observedAt,
              payload: input.payload as object,
              redactionApplied: input.redactionApplied,
              redactionPolicyVersion: REDACTION_POLICY_VERSION,
              truncated: input.truncated,
              contentHash: input.contentHash,
              chainIndex,
              ...(prevContentHash === null ? {} : { prevContentHash }),
              origin: input.origin,
              writerOwnerId: input.writerOwnerId,
              ...(input.writerFencingToken === null
                ? {}
                : { writerFencingToken: BigInt(input.writerFencingToken) }),
            },
            select: { id: true, contentHash: true, chainIndex: true },
          });
          await tx.evidenceIntegrityHead.upsert({
            where: { runId: input.runId },
            create: {
              runId: input.runId,
              lastChainIndex: chainIndex,
              headContentHash: input.contentHash,
              observationCount: 1,
            },
            update: {
              lastChainIndex: chainIndex,
              headContentHash: input.contentHash,
              observationCount: { increment: 1 },
            },
          });
          return {
            id: created.id,
            contentHash: created.contentHash,
            chainIndex: created.chainIndex,
          };
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      // Rethrow integrity conflicts verbatim: they are DIAGNOSTIC truth,
      // not infrastructure failures.
      if (error instanceof EvidenceIntegrityConflictError) {
        throw error;
      }
      // A unique violation on the identity tuple means a concurrent
      // appender won the race for the SAME provenance identity while we
      // were outside the transaction (the advisory lock above is the
      // primary guard; this covers any residual window). Classify and
      // query OUTSIDE the failed transaction — never reuse a poisoned
      // transaction's state. Same content ⇒ idempotent success (the
      // winner's row IS this observation); different content ⇒ explicit
      // integrity conflict. Chain-index violations cannot occur under
      // the per-run advisory lock.
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.rawObservation.findUnique({
          where: {
            runId_kind_invocationIdentity: {
              runId: input.runId,
              kind: kindName,
              invocationIdentity: input.invocationIdentity ?? '',
            },
          },
          select: { id: true, contentHash: true, chainIndex: true },
        });
        if (winner !== null) {
          if (winner.contentHash === input.contentHash) {
            return {
              id: winner.id,
              contentHash: winner.contentHash,
              chainIndex: winner.chainIndex,
            };
          }
          throw new EvidenceIntegrityConflictError(
            `observation identity (run=${input.runId}, kind=${input.kind}, invocation=${input.invocationIdentity ?? 'null'}) ` +
              `was concurrently persisted with a DIFFERENT stored content hash (${winner.contentHash}); ` +
              'refusing to overwrite or alias evidence',
          );
        }
      }
      throw new EvidenceCaptureError(
        `failed to append observation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The EvidenceSink implementation handed to the engine. The engine
 * supplies writer provenance per capture (ownerId + the claim's
 * fencing token), so a stale generation's truthful observation is
 * appended WITH ITS OWN IDENTITY — honest reality, attributed (§14).
 */
export function createEngineEvidenceSink(prisma: PrismaClient): EvidenceSink {
  const store = new RawObservationStore(prisma);
  return {
    async captureInvocation(
      observation: InvocationObservation,
      writer: { ownerId: string; fencingToken: string | null },
    ): Promise<void> {
      await store.appendInvocationObservation({
        observation,
        writerOwnerId: writer.ownerId,
        writerFencingToken: writer.fencingToken,
      });
    },
  };
}
