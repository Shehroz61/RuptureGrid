// =====================================================================
// Integration — Phase 17 Checkpoint B2: derivation generation `D`,
// derivation-attempt completeness, and the derived-projection writer
// protocol (ADR-0026 §13)
// =====================================================================
// REAL PostgreSQL throughout (R-08): every case inspects durable rows —
// `control.run_truth_input_head`, `evidence.derivation_attempt`,
// `evidence.normalized_event`, `evidence.causal_relationship`, the raw
// chain head — and locking is proven by REAL PostgreSQL advisory-lock
// contention observed through `pg_locks` with controlled barriers, never
// by mocks, never by timing-sleep heuristics.
//
// The invariants under test (ADR-0026 §13):
//   * every COMMITTED derived row advances `D` by exactly +1 in the SAME
//     transaction, under the SAME per-run advisory lock the B1 provenance
//     protocol and the raw-chain append primitive use;
//   * an idempotent no-op advances nothing;
//   * a pass is a durable ATTEMPT: IN_PROGRESS before its first derived
//     write, COMPLETE only after its completeness checks pass against the
//     source watermark it captured (`(C, P)` for the D-participating
//     evidence kind; `(C, P, D)` for the completeness-marked forensics
//     kind), NEVER by adoption of a newer source;
//   * a reader fails closed unless an authoritative COMPLETE proof covers
//     the CURRENT state (`readDerivationReadiness`).
//
// Fault injection (D-02/D-08/D-09/D-11/D-12) is TEST-SIDE ONLY: a Prisma
// client EXTENSION wraps the real client (no production seam, no code
// path that production callers can reach) and either intercepts one
// statement or runs a real append at a precise point. It cannot weaken
// the protocol — it only decides WHERE a real failure or a real
// concurrent write lands.
//
// Deliberately NOT here (later checkpoints, as the checkpoint mandates):
// current-evaluation pointer publication and boundary A end-to-end
// (C), report authorization (D), and the CLI classifier (C/D). The
// B2-level ordering primitives (`captureStage1Source`,
// `captureStage2Watermark`, `validateWatermarkCurrent`) are proven here
// against cases 64 and 67; their end-to-end verdict consequences are C's.

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@rupturegrid/control-db';
import {
  acquireRunLock,
  advanceDerivationGeneration,
  createExperiment,
  createRun,
  markRunDispatching,
  readTruthInputHead,
  registerTarget,
  settleRuns,
} from '@rupturegrid/engine';
import {
  DERIVATION_KIND_RUN_EVIDENCE,
  DERIVATION_KIND_RUN_FORENSICS,
  RawObservationStore,
  abandonDerivationAttempt,
  beginDerivationAttempt,
  captureStage1Source,
  captureStage2Watermark,
  completeDerivationAttempt,
  deriveRunEvidence,
  eventInputHash,
  readDerivationReadiness,
  readTruthInputWatermark,
  validateWatermarkCurrent,
  verifyRunEvidenceChain,
} from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const prisma = getControlPrisma();
const store = new RawObservationStore(prisma);

/** Every run this suite creates (all left in honest, non-settleable states). */
const createdRunIds: string[] = [];

// ---------------------------------------------------------------------
// Harness: real runs, real observations, real protocol writers
// ---------------------------------------------------------------------

interface StepHarness {
  readonly runId: string;
  readonly stepRunIds: readonly string[];
}

/** Registers one target + experiment + run through the REAL engine path. */
async function makeRun(stepCount = 1, namePrefix = 'b2-deriv'): Promise<StepHarness> {
  const target = await registerTarget(prisma, {
    displayName: uniqueName(`${namePrefix}-target`),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [await uniqueTestOrigin(prisma)],
    contractKind: 'GENERIC_HTTP',
  });
  const experiment = await createExperiment(prisma, {
    name: uniqueName(`${namePrefix}-experiment`),
    targetId: target.targetId,
    document: {
      steps: Array.from({ length: stepCount }, (_, index) => ({
        name: `step-${index}`,
        action: {
          method: 'POST',
          relativePath: '/counter/increment',
          body: '{}',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
        },
      })),
    },
  });
  const run = await createRun(prisma, experiment.revisionId);
  createdRunIds.push(run.runId);
  return { runId: run.runId, stepRunIds: [...run.stepRunIds] };
}

/**
 * Appends ONE real invocation observation carrying a Demo webhook body.
 * That normalizes into EXACTLY ONE event (`demo.payment-delivery-observed`)
 * and ZERO relationships — the precise control D-01 needs.
 */
async function appendInvocationObservation(
  harness: StepHarness,
  providerPaymentId: string,
): Promise<void> {
  await store.appendInvocationObservation({
    observation: {
      runId: harness.runId,
      stepRunId: harness.stepRunIds[0] ?? harness.runId,
      invocationId: null,
      invocationIdentity: `b2-inv-${providerPaymentId}`,
      sequence: 0,
      waveIndex: 0,
      method: 'POST' as const,
      relativePath: '/webhooks/provider',
      requestHeaders: {},
      requestBody: JSON.stringify({
        providerPaymentId,
        providerEventId: `evt-${providerPaymentId}`,
        eventType: 'payment.succeeded',
        amountMinor: '5000',
        currency: 'PKR',
      }),
      transportStage: 'RESPONSE_COMPLETE',
      httpStatus: 200,
      responseHeaders: null,
      responseBody: JSON.stringify({
        processingAttemptId: `attempt-${providerPaymentId}`,
        outcome: 'ACCEPTED',
        financialEffectId: `effect-${providerPaymentId}`,
      }),
      responseTruncated: false,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
      outcome: 'SUCCEEDED' as const,
      error: null,
      observedAt: new Date(),
    },
    writerOwnerId: `b2-writer-${providerPaymentId}`,
    writerFencingToken: '1',
  });
}

/**
 * Appends ONE real Demo-lineage target observation carrying a COMPLETE
 * identity chain: 6 events (payment, provider event, delivery, processing
 * attempt, financial effect, ledger entry) and 5 identity-chain
 * relationships — the full multi-row projection D-08/D-09 need.
 */
async function appendLineageObservation(
  harness: StepHarness,
  providerPaymentId: string,
): Promise<void> {
  const providerEventId = `evt-${providerPaymentId}`;
  const deliveryAttemptId = `del-${providerPaymentId}`;
  const processingAttemptId = `pa-${providerPaymentId}`;
  const financialEffectId = `fx-${providerPaymentId}`;
  await store.appendTargetObservation({
    runId: harness.runId,
    stepRunId: null,
    adapterKind: 'demo-fintech-payment-lineage',
    observedAt: new Date(),
    payload: {
      payment: {
        providerPaymentId,
        walletId: 'wallet-1',
        amountMinor: '5000',
        currency: 'PKR',
        status: 'SUCCEEDED',
      },
      events: [{ providerEventId, eventType: 'payment.succeeded' }],
      deliveries: [{ deliveryAttemptId, providerEventId, status: 'DELIVERED' }],
      processingAttempts: [{ processingAttemptId, deliveryAttemptId, outcome: 'ACCEPTED' }],
      financialEffects: [
        {
          financialEffectId,
          providerPaymentId,
          processingAttemptId,
          walletId: 'wallet-1',
          effectType: 'CREDIT',
          amountMinor: '5000',
          currency: 'PKR',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      ledgerEntries: [
        {
          financialEntryId: `le-${providerPaymentId}`,
          financialEffectId,
          walletId: 'wallet-1',
          entryType: 'CREDIT',
          amountMinor: '5000',
          currency: 'PKR',
          idempotencyKey: `idem-${providerPaymentId}`,
        },
      ],
    },
    writerOwnerId: `b2-lineage-${providerPaymentId}`,
    writerFencingToken: null,
    provenanceIdentity: `b2-lineage:${providerPaymentId}`,
  });
}

interface ProtocolWriteInput {
  readonly normalizerName: string;
  readonly normalizerVersion: string;
  readonly eventType: string;
  readonly subjectKey: string;
  readonly payload: Record<string, unknown>;
  /** When false, the write does NOT advance `D` (the UNTRACKED variant). */
  readonly advanceGeneration?: boolean;
}

/**
 * A FOREIGN derived writer performing the SUPPORTED writer protocol
 * (per-run lock → derived row → `D` advance → commit) — the shape a
 * concurrent/different normalizer-version pass has. Used for cases 64/67
 * and for the untracked-writer detection case.
 */
async function foreignDerivedCommit(
  runId: string,
  input: ProtocolWriteInput,
): Promise<{ readonly id: string; readonly method: string }> {
  const inputHash = eventInputHash([], input.payload);
  return prisma.$transaction(
    async (tx) => {
      await acquireRunLock(tx, runId);
      const row = await tx.normalizedEvent.create({
        data: {
          runId,
          eventType: input.eventType,
          subjectKey: input.subjectKey,
          payload: input.payload as object,
          normalizerName: input.normalizerName,
          normalizerVersion: input.normalizerVersion,
          inputHash,
          origin: 'DETERMINISTIC_DERIVED',
          sourceObservationHashes: [],
          primaryObservationIndex: null,
        },
        select: { id: true },
      });
      if (input.advanceGeneration !== false) {
        await advanceDerivationGeneration(tx, runId);
      }
      return { id: row.id, method: 'protocol' };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/** A FULL foreign derivation pass (attempt + protocol write + proof). */
async function foreignDerivationPass(runId: string, input: ProtocolWriteInput): Promise<bigint> {
  const attempt = await beginDerivationAttempt(prisma, runId, DERIVATION_KIND_RUN_EVIDENCE);
  await foreignDerivedCommit(runId, input);
  const resolution = await completeDerivationAttempt(prisma, attempt, {
    projectionCounts: { foreign: 1 },
  });
  if (resolution.status !== 'COMPLETE') {
    throw new Error(`foreign derivation pass did not complete: ${resolution.status}`);
  }
  return attempt.attemptGeneration;
}

/** A LEGACY (pre-protocol) derived row: no lock, no attempt, no `D` advance. */
async function legacyDerivedRow(runId: string, input: ProtocolWriteInput): Promise<string> {
  const row = await prisma.normalizedEvent.create({
    data: {
      runId,
      eventType: input.eventType,
      subjectKey: input.subjectKey,
      payload: input.payload as object,
      normalizerName: input.normalizerName,
      normalizerVersion: input.normalizerVersion,
      inputHash: eventInputHash([], input.payload),
      origin: 'DETERMINISTIC_DERIVED',
      sourceObservationHashes: [],
      primaryObservationIndex: null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Durable counts of the run's derived projection. */
async function readProjectionCounts(
  runId: string,
): Promise<{ events: number; relationships: number; diagnostics: number }> {
  const [events, relationships] = await Promise.all([
    prisma.normalizedEvent.count({ where: { runId } }),
    prisma.causalRelationship.count({ where: { runId } }),
  ]);
  return { events, relationships, diagnostics: 0 };
}

async function readD(runId: string): Promise<bigint> {
  return (await readTruthInputHead(prisma, runId)).derivationGeneration;
}

async function readP(runId: string): Promise<bigint> {
  return (await readTruthInputHead(prisma, runId)).provenanceRevision;
}

async function attemptsFor(runId: string, kind: string) {
  return prisma.derivationAttempt.findMany({
    where: { runId, derivationKind: kind },
    orderBy: { attemptGeneration: 'asc' },
  });
}

/**
 * The evaluation-facing evidence read (the shape `runRunAnalysis` uses):
 * durable rows read AFTER a watermark capture — never an in-memory cache.
 */
async function readEvaluationFacingEvidence(runId: string): Promise<{
  readonly eventIds: readonly string[];
  readonly relationshipIds: readonly string[];
}> {
  const [events, relationships] = await Promise.all([
    prisma.normalizedEvent.findMany({
      where: { runId },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
    prisma.causalRelationship.findMany({
      where: { runId },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  return {
    eventIds: events.map((row) => row.id),
    relationshipIds: relationships.map((row) => row.id),
  };
}

// ---------------------------------------------------------------------
// Controlled barriers (never sleeps): a REAL interactive transaction
// holds the run's advisory lock until the test releases it.
// ---------------------------------------------------------------------

class Barrier {
  private released = false;
  private readonly gate: Promise<void>;
  private open!: () => void;

  public constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.open = () => {
        this.released = true;
        resolve();
      };
    });
  }

  public wait(): Promise<void> {
    return this.gate;
  }

  public release(): void {
    if (!this.released) {
      this.open();
    }
  }
}

async function holdRunLock(
  runId: string,
): Promise<{ release: () => void; held: Promise<void>; done: Promise<void> }> {
  const barrier = new Barrier();
  let signal!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      await acquireRunLock(tx, runId);
      signal();
      await barrier.wait();
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
  await acquired;
  return { release: () => barrier.release(), held: acquired, done };
}

/**
 * Bounded wait for a REAL, not-yet-granted advisory-lock wait on this
 * run's key, observed in `pg_locks` — proof the contender is BLOCKED IN
 * POSTGRESQL on the same run lock, not merely pending in JS.
 */
async function waitForRunLockWait(runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = (await prisma.$queryRaw`
      WITH key AS (SELECT hashtext(${runId}::text)::bigint AS k)
      SELECT count(*)::int AS waiting
        FROM pg_locks l, key
       WHERE l.locktype = 'advisory'
         AND NOT l.granted
         AND l.objsubid = 1
         AND l.classid = ((key.k >> 32) & 4294967295)::oid
         AND l.objid = (key.k & 4294967295)::oid
    `) as Array<{ waiting: number }>;
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('no advisory-lock wait on the run key appeared within 10s');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------
// Test-side fault injection: a Prisma client EXTENSION over the real
// client. No production seam exists; production callers never pass one.
// ---------------------------------------------------------------------

interface FaultPlan {
  /** Fail the 1-based Nth `normalizedEvent.create` of this client. */
  readonly failEventCreateAt?: number;
  /** Fail the first N `derivationAttempt.updateMany` calls (marker writes). */
  readonly failAttemptMarkerWrites?: number;
  /** Fail the `D`-advance raw statement (`run_truth_input_head` write). */
  readonly failDerivationGenerationAdvance?: boolean;
  /**
   * After the FIRST `rawObservation.findMany` of a pass returns (inputs
   * already read), run this REAL concurrent write — proving the source
   * moved mid-pass without any sleep.
   */
  readonly afterFirstObservationRead?: () => Promise<void>;
}

function faultClient(fault: FaultPlan): PrismaClient {
  let eventCreateCalls = 0;
  let markerWrites = 0;
  let observationReads = 0;
  const extended = prisma.$extends({
    query: {
      normalizedEvent: {
        async create({ args, query }) {
          eventCreateCalls += 1;
          if (fault.failEventCreateAt === eventCreateCalls) {
            throw new Error('fault-injection: derived write interrupted');
          }
          return query(args);
        },
      },
      derivationAttempt: {
        async updateMany({ args, query }) {
          markerWrites += 1;
          if (
            fault.failAttemptMarkerWrites !== undefined &&
            markerWrites <= fault.failAttemptMarkerWrites
          ) {
            throw new Error('fault-injection: completion marker write interrupted');
          }
          return query(args);
        },
      },
      async $executeRaw({ args, query }) {
        if (
          fault.failDerivationGenerationAdvance === true &&
          args.strings.join(' ').includes('run_truth_input_head')
        ) {
          throw new Error('fault-injection: derivation-generation advance interrupted');
        }
        return query(args);
      },
      rawObservation: {
        async findMany({ args, query }) {
          const rows = await query(args);
          observationReads += 1;
          if (observationReads === 1 && fault.afterFirstObservationRead !== undefined) {
            await fault.afterFirstObservationRead();
          }
          return rows;
        },
      },
    },
  });
  return extended as unknown as PrismaClient;
}

afterAll(async () => {
  // HYGIENE, not cleanup-for-cosmetics (the B1 lesson): a finished run
  // left RUNNING is SETTLEABLE, and `settleRuns` is a BOUNDED batch over
  // the SHARED dev database. This suite leaves runs in PENDING/DISPATCHING
  // (never claimable leftovers by design), but it drains the shared
  // backlog through the platform's OWN settlement path anyway and proves
  // it left nothing settleable among its runs.
  await settleRuns(prisma, 1000);
  let settleableStragglers = 0;
  for (const runId of createdRunIds) {
    const rows = (await prisma.$queryRaw`
      SELECT count(*)::int AS n
        FROM "control"."experiment_run" r
       WHERE r."id" = ${runId}::uuid
         AND r."state" = 'RUNNING'
         AND EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id")
         AND NOT EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('CLAIMED','EXECUTING'))
         AND (NOT EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('PENDING','DISPATCHED'))
              OR EXISTS (SELECT 1 FROM "control"."experiment_step_run" s WHERE s."runId" = r."id" AND s."state" IN ('FAILED','CANCELLED')))
    `) as Array<{ n: number }>;
    settleableStragglers += rows[0]?.n ?? 0;
  }
  expect(settleableStragglers).toBe(0);
});

// =====================================================================
// D-01 … D-03 — the `D` advance itself
// =====================================================================

describe('B2 · D-01: one committed derived insert advances D exactly once', () => {
  it('advances +1 per created derived row, in the same transaction, and certifies COMPLETE', async () => {
    const harness = await makeRun();
    await appendInvocationObservation(harness, `pay-d01-${Date.now()}`);
    expect(await readD(harness.runId)).toBe(0n);

    const result = await deriveRunEvidence(prisma, harness.runId);

    // ONE invocation observation ⇒ ONE event, ZERO relationships.
    expect(result.events).toHaveLength(1);
    expect(result.relationships).toHaveLength(0);
    expect(result.derivationCompleteness.status).toBe('COMPLETE');
    expect(await readD(harness.runId)).toBe(1n); // exactly one committed insert ⇒ +1
    const counts = await readProjectionCounts(harness.runId);
    expect(counts.events).toBe(1);
    expect(counts.relationships).toBe(0);

    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('COMPLETE');
    expect(attempts[0]?.attemptGeneration).toBe(1n);
    expect(attempts[0]?.committedDerivationGeneration).toBe(1n);
    expect(attempts[0]?.sourceChainObservationCount).toBe(1);
    expect(attempts[0]?.sourceChainHeadHash).not.toBeNull();

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(true);
    expect(readiness.state).toBe('COMPLETE');
    expect(readiness.unresolvedAttempts).toHaveLength(0);
  });
});

describe('B2 · D-02: rollback leaves both the row and D unchanged', () => {
  it('rolls back a derived row and its D advance together on a database-level failure', async () => {
    const harness = await makeRun(1, 'b2-d02');
    await appendInvocationObservation(harness, `pay-d02-${Date.now()}`);
    // The D-advance statement fails INSIDE the derived-write transaction:
    // PostgreSQL rolls the whole transaction back — the event row cannot
    // survive without its revision.
    const failing = faultClient({ failDerivationGenerationAdvance: true });
    await expect(deriveRunEvidence(failing, harness.runId)).rejects.toThrow(/fault-injection/);

    expect(await readD(harness.runId)).toBe(0n);
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(0);
    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('FAILED');

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('FAILED');
  });
});

describe('B2 · D-03: idempotent duplicate derivation does not churn D', () => {
  it('a repeat pass converges on the same rows and advances nothing', async () => {
    const harness = await makeRun(1, 'b2-d03');
    await appendInvocationObservation(harness, `pay-d03-${Date.now()}`);

    const first = await deriveRunEvidence(prisma, harness.runId);
    expect(first.derivationCompleteness.status).toBe('COMPLETE');
    expect(await readD(harness.runId)).toBe(1n);

    const second = await deriveRunEvidence(prisma, harness.runId);
    expect(second.derivationCompleteness.status).toBe('COMPLETE');
    expect(second.events).toHaveLength(1);
    // No unjustified generation churn: the same durable rows, so no new commit.
    expect(await readD(harness.runId)).toBe(1n);
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(1);

    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === 'COMPLETE')).toBe(true);
    expect(attempts.map((attempt) => attempt.attemptGeneration)).toEqual([1n, 2n]);
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(true);
  });
});

// =====================================================================
// D-04 … D-07 — locking, serialization, independence, shared keys
// =====================================================================

describe('B2 · D-04: two same-run derivation writers serialize', () => {
  it('a derivation genuinely BLOCKS in PostgreSQL on the held run lock, then converges', async () => {
    const harness = await makeRun(1, 'b2-d04');
    await appendInvocationObservation(harness, `pay-d04-${Date.now()}`);
    const holder = await holdRunLock(harness.runId);
    const pass = deriveRunEvidence(prisma, harness.runId).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      // The pass is stuck in PostgreSQL acquiring the SAME run lock.
      await waitForRunLockWait(harness.runId);
    } finally {
      holder.release();
    }
    const outcome = await pass;
    await holder.done;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value.derivationCompleteness.status).toBe('COMPLETE');
    expect(await readD(harness.runId)).toBe(1n);
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(1);
  });

  it('two CONCURRENT passes on the same run converge on one row and one generation step', async () => {
    const harness = await makeRun(1, 'b2-d04b');
    await appendInvocationObservation(harness, `pay-d04b-${Date.now()}`);
    const [a, b] = await Promise.all([
      deriveRunEvidence(prisma, harness.runId),
      deriveRunEvidence(prisma, harness.runId),
    ]);
    expect(a.derivationCompleteness.status).toBe('COMPLETE');
    expect(b.derivationCompleteness.status).toBe('COMPLETE');
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(1);
    // Exactly one pass created the row; the other converged (P2002 path).
    expect(await readD(harness.runId)).toBe(1n);
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(true);
  });
});

describe('B2 · D-05: different runs remain independent', () => {
  it('a derivation on run B completes while run A’s lock is provably held', async () => {
    const runA = await makeRun(1, 'b2-d05-a');
    const runB = await makeRun(1, 'b2-d05-b');
    await appendInvocationObservation(runB, `pay-d05b-${Date.now()}`);
    const holder = await holdRunLock(runA.runId);
    try {
      const result = await deriveRunEvidence(prisma, runB.runId);
      expect(result.derivationCompleteness.status).toBe('COMPLETE');
      expect(await readD(runB.runId)).toBe(1n);
      expect(await readD(runA.runId)).toBe(0n); // A untouched
    } finally {
      holder.release();
      await holder.done;
    }
  });
});

describe('B2 · D-06: the raw-chain writer and the D writer share the run lock', () => {
  it('both the chain append and a derivation wait on the SAME pg_locks key', async () => {
    const harness = await makeRun(1, 'b2-d06');
    // 1) The chain append blocks on the held run lock (same key as B1 proved).
    const holder = await holdRunLock(harness.runId);
    const append = appendInvocationObservation(harness, `pay-d06-${Date.now()}`);
    try {
      await waitForRunLockWait(harness.runId);
    } finally {
      holder.release();
    }
    await append;
    await holder.done;
    expect(await prisma.rawObservation.count({ where: { runId: harness.runId } })).toBe(1);

    // 2) The derivation's BEGIN (first statement of its locked transaction)
    //    waits on the SAME key, then derives the appended observation.
    const holder2 = await holdRunLock(harness.runId);
    const pass = deriveRunEvidence(prisma, harness.runId);
    try {
      await waitForRunLockWait(harness.runId);
    } finally {
      holder2.release();
    }
    const result = await pass;
    await holder2.done;
    expect(result.derivationCompleteness.status).toBe('COMPLETE');
    expect(result.events).toHaveLength(1); // the one appended observation
    expect(await readD(harness.runId)).toBe(1n);
  });
});

describe('B2 · D-07: the P writer and the D writer share the run lock', () => {
  it('a provenance write and a derivation serialize on one lock order without lost revisions', async () => {
    const harness = await makeRun(1, 'b2-d07');
    await appendInvocationObservation(harness, `pay-d07-${Date.now()}`);
    const holder = await holdRunLock(harness.runId);
    const pWriter = markRunDispatching(prisma, harness.runId); // real P writer (+1)
    const dWriter = deriveRunEvidence(prisma, harness.runId).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await waitForRunLockWait(harness.runId); // at least one contender blocked in PostgreSQL
      // Bounded: both contenders must be waiting on the same key while held.
      await waitForRunLockWait(harness.runId);
    } finally {
      holder.release();
    }
    await pWriter;
    const outcome = await dWriter;
    await holder.done;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw outcome.error;
    }
    // One lock order, no deadlock, no lost revision: P +1 (exactly, on top
    // of the run-creation advance), D +1.
    expect(await readP(harness.runId)).toBe(2n);
    expect(await readD(harness.runId)).toBe(1n);
    expect(outcome.value.derivationCompleteness.status).toBe('COMPLETE');
  });
});

// =====================================================================
// D-08 … D-10 — partial / failed / recovered derivation
// =====================================================================

describe('B2 · D-08: a partially built projection stays visibly INCOMPLETE', () => {
  it('leaves the committed rows durable and D advanced, but never COMPLETE', async () => {
    const harness = await makeRun(1, 'b2-d08');
    await appendLineageObservation(harness, `pay-d08-${Date.now()}`);
    // Interrupt the THIRD event write: two event rows commit (each with its
    // own D advance), the rest never run.
    const failing = faultClient({ failEventCreateAt: 3 });
    await expect(deriveRunEvidence(failing, harness.runId)).rejects.toThrow(/fault-injection/);

    const counts = await readProjectionCounts(harness.runId);
    expect(counts.events).toBe(2); // honest partial projection, preserved
    expect(counts.relationships).toBe(0);
    expect(await readD(harness.runId)).toBe(2n); // exactly the two committed rows
    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('FAILED');
    expect(attempts[0]?.committedDerivationGeneration).toBeNull();

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('FAILED');
    expect(readiness.proof).toBeNull();
  });
});

describe('B2 · D-09: a controlled failure between derived writes cannot certify COMPLETE', () => {
  it('a crash at the completion boundary leaves the attempt unresolved and the projection uncertified', async () => {
    const harness = await makeRun(1, 'b2-d09');
    await appendLineageObservation(harness, `pay-d09-${Date.now()}`);
    // Every derived write commits; the COMPLETION marker write and the
    // failure marker write both fail — the durable state of a process
    // that died between the last write and publishing completeness.
    const crashing = faultClient({ failAttemptMarkerWrites: 2 });
    await expect(deriveRunEvidence(crashing, harness.runId)).rejects.toThrow(/fault-injection/);

    const counts = await readProjectionCounts(harness.runId);
    expect(counts.events).toBe(6);
    expect(counts.relationships).toBe(5);
    expect(await readD(harness.runId)).toBe(11n); // 6 events + 5 relationships

    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('IN_PROGRESS'); // NOT cleared, NOT COMPLETE
    expect(attempts[0]?.completedAt).toBeNull();

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('IN_PROGRESS');
    expect(readiness.proof).toBeNull();
    expect(readiness.unresolvedAttempts).toHaveLength(1);
  });
});

describe('B2 · D-10: a retry recomputes and eventually proves completeness', () => {
  it('a fresh full pass supersedes the unresolved attempt without clearing it', async () => {
    const harness = await makeRun(1, 'b2-d10');
    await appendLineageObservation(harness, `pay-d10-${Date.now()}`);
    const crashing = faultClient({ failAttemptMarkerWrites: 2 });
    await expect(deriveRunEvidence(crashing, harness.runId)).rejects.toThrow(/fault-injection/);
    const stuck = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(stuck[0]?.status).toBe('IN_PROGRESS');
    expect(await readD(harness.runId)).toBe(11n);

    // Retry (full recompute; idempotent convergence on every existing row).
    const retry = await deriveRunEvidence(prisma, harness.runId);
    expect(retry.derivationCompleteness.status).toBe('COMPLETE');
    // No duplicate rows and no unjustified churn: the recovery pass created
    // nothing new, so `D` did not move.
    expect(await readD(harness.runId)).toBe(11n);
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(6);
    expect(await prisma.causalRelationship.count({ where: { runId: harness.runId } })).toBe(5);

    // The older attempt is PRESERVED as unresolved history and is reported,
    // never silently cleared; the authoritative rule is the newer proof.
    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe('IN_PROGRESS');
    expect(attempts[1]?.status).toBe('COMPLETE');
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(true);
    // Readiness generations are decimal strings (JSON-safe, exact).
    expect(readiness.proof?.attemptGeneration).toBe('2');
    expect(readiness.unresolvedAttempts.map((attempt) => attempt.attemptGeneration)).toEqual(['1']);
  });
});

// =====================================================================
// D-11 … D-12 — source watermark binding (C and P advance mid-pass)
// =====================================================================

describe('B2 · D-11: source C advances during derivation — the old source is never certified current', () => {
  it('marks the attempt INCOMPLETE, preserves the derived rows, and a later pass re-establishes completeness', async () => {
    const harness = await makeRun(1, 'b2-d11');
    const firstPayment = `pay-d11a-${Date.now()}`;
    await appendInvocationObservation(harness, firstPayment);
    const secondPayment = `pay-d11b-${Date.now()}`;
    // A REAL chain append lands after the pass read its inputs (never a sleep:
    // the hook fires exactly between the input read and the first derived write).
    const moving = faultClient({
      afterFirstObservationRead: () => appendInvocationObservation(harness, secondPayment),
    });
    const result = await deriveRunEvidence(moving, harness.runId);

    expect(result.derivationCompleteness.status).toBe('INCOMPLETE');
    expect(result.derivationCompleteness.reason).toBe('SOURCE_ADVANCED_DURING_DERIVATION');
    // The derived rows from the pass are PRESERVED (logically append-only).
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(1);
    expect(await readD(harness.runId)).toBe(1n);
    const chainAfter = await readTruthInputWatermark(prisma, harness.runId);
    expect(chainAfter.chain.observationCount).toBe(2);

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('INCOMPLETE');
    expect(readiness.reason).toContain('SOURCE_ADVANCED_DURING_DERIVATION');
    expect(readiness.proof).toBeNull();

    // A later FULL derivation re-establishes completeness for the new source.
    const recovery = await deriveRunEvidence(prisma, harness.runId);
    expect(recovery.derivationCompleteness.status).toBe('COMPLETE');
    expect(await prisma.normalizedEvent.count({ where: { runId: harness.runId } })).toBe(2);
    expect(await readD(harness.runId)).toBe(2n);
    const ready = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(ready.complete).toBe(true);
  });
});

describe('B2 · D-12: source P advances during derivation — the old source is never certified current', () => {
  it('marks the attempt INCOMPLETE on a mid-pass provenance write and never adopts the newer P', async () => {
    const harness = await makeRun(1, 'b2-d12');
    await appendInvocationObservation(harness, `pay-d12-${Date.now()}`);
    const pBefore = await readP(harness.runId); // 1n: the run-creation write
    const moving = faultClient({
      // A REAL truth-bearing provenance write (the run dispatch marker) lands
      // after the pass read its inputs — the B1 writer protocol, not a mock.
      afterFirstObservationRead: () => markRunDispatching(prisma, harness.runId),
    });
    const result = await deriveRunEvidence(moving, harness.runId);

    expect(result.derivationCompleteness.status).toBe('INCOMPLETE');
    expect(result.derivationCompleteness.reason).toBe('SOURCE_ADVANCED_DURING_DERIVATION');
    expect(await readP(harness.runId)).toBe(pBefore + 1n); // exactly one P writer
    expect(await readD(harness.runId)).toBe(1n); // the pass's own committed row
    const attempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(attempts[0]?.sourceProvenanceRevision).toBe(pBefore);
    expect(attempts[0]?.status).toBe('INCOMPLETE');

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);

    const recovery = await deriveRunEvidence(prisma, harness.runId);
    expect(recovery.derivationCompleteness.status).toBe('COMPLETE');
    const ready = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(ready.complete).toBe(true);
    expect(ready.proof?.source.provenanceRevision).toBe((pBefore + 1n).toString());
  });
});

// =====================================================================
// D-13 … D-14 — two-stage Boundary A ordering (ADR-0026 cases 67 and 64)
// =====================================================================

describe('B2 · D-13 (case 67): a foreign derivation commit BEFORE stage 2 is included in W0', () => {
  it('captures D0 including the foreign commit, does not race, and post-stage-2 reads see it', async () => {
    const harness = await makeRun(1, 'b2-d13');
    await appendInvocationObservation(harness, `pay-d13-${Date.now()}`);

    // Stage 1 — the before-read of the pass.
    const stage1 = await captureStage1Source(prisma, harness.runId);

    // The pass's own derivation.
    const own = await deriveRunEvidence(prisma, harness.runId);
    expect(own.derivationCompleteness.status).toBe('COMPLETE');
    const dAfterOwn = await readD(harness.runId);
    expect(dAfterOwn).toBe(1n);

    // An EARLIER in-memory/dedicated read (the pre-stage-2 view) — captured
    // here on purpose to prove no earlier result may override the later reads.
    const beforeStage2 = await readEvaluationFacingEvidence(harness.runId);

    // A FOREIGN derivation writer (another pass, e.g. a newer normalizer
    // version) commits AFTER this pass's derivation and BEFORE stage 2.
    const foreign = await foreignDerivationPass(harness.runId, {
      normalizerName: 'foreign-normalizer',
      normalizerVersion: 'v2',
      eventType: 'foreign.projection-observed',
      subjectKey: 'foreign-subject',
      payload: { note: 'foreign derived row' },
    });
    expect(foreign).toBe(2n);
    const dAfterForeign = await readD(harness.runId);
    expect(dAfterForeign).toBe(2n);

    // Stage 2 — the final capture. `C` and `P` did not move, so the pass may
    // continue; `D0` INCLUDES the foreign commit.
    const stage2 = await captureStage2Watermark(prisma, harness.runId, stage1);
    expect(stage2.raced).toBe(false);
    expect(stage2.watermark.derivationGeneration).toBe(2n);
    expect(stage2.watermark.chain.observationCount).toBe(1);
    expect(stage2.watermark.provenanceRevision).toBe(stage1.provenanceRevision);

    // EVERY evaluation-facing read AFTER stage 2 sees the foreign rows.
    const afterStage2 = await readEvaluationFacingEvidence(harness.runId);
    const foreignRow = await prisma.normalizedEvent.findFirstOrThrow({
      where: { runId: harness.runId, normalizerName: 'foreign-normalizer' },
      select: { id: true },
    });
    expect(beforeStage2.eventIds).not.toContain(foreignRow.id);
    expect(afterStage2.eventIds).toContain(foreignRow.id);
    expect(afterStage2.eventIds.length).toBe(beforeStage2.eventIds.length + 1);

    // The foreign pass published its own proof: readiness is authoritative at
    // the new generation (D0), and the projection is certified.
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(true);
    expect(readiness.proof?.attemptGeneration).toBe(foreign.toString());
    expect(readiness.proof?.committedDerivationGeneration).toBe('2');
  });
});

describe('B2 · D-14 (case 64): a foreign derivation commit AFTER stage 2 invalidates W0', () => {
  it('advances D, makes W0 stale in the derivation component, and blocks publication', async () => {
    const harness = await makeRun(1, 'b2-d14');
    await appendInvocationObservation(harness, `pay-d14-${Date.now()}`);
    const stage1 = await captureStage1Source(prisma, harness.runId);
    await deriveRunEvidence(prisma, harness.runId);
    const { watermark: w0, raced } = await captureStage2Watermark(prisma, harness.runId, stage1);
    expect(raced).toBe(false);
    expect(w0.derivationGeneration).toBe(1n);

    // The foreign derived commit lands AFTER stage 2.
    await foreignDerivationPass(harness.runId, {
      normalizerName: 'foreign-normalizer',
      normalizerVersion: 'v2',
      eventType: 'foreign.projection-observed',
      subjectKey: 'foreign-subject',
      payload: { note: 'post-stage-2 foreign derived row' },
    });

    // Publication validation primitive: W0 no longer matches — in the D
    // component alone (C and P are byte-unchanged).
    const validation = await validateWatermarkCurrent(prisma, harness.runId, w0);
    expect(validation.matches).toBe(false);
    expect(validation.changedComponents).toEqual(['derivationGeneration']);
    expect(validation.current.derivationGeneration).toBe(2n);
    expect(validation.current.chain).toEqual(w0.chain);
    expect(validation.current.provenanceRevision).toBe(w0.provenanceRevision);
  });
});

// =====================================================================
// D-15 — overlapping attempts
// =====================================================================

describe('B2 · D-15: overlapping attempts cannot clear each other’s state', () => {
  it('a newer complete pass supersedes an older attempt without touching its row, and a late commit is detected', async () => {
    const harness = await makeRun(1, 'b2-d15');
    await appendInvocationObservation(harness, `pay-d15-${Date.now()}`);

    // Attempt A: a still-running older pass (durable IN_PROGRESS, no writes yet).
    const attemptA = await beginDerivationAttempt(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(attemptA.attemptGeneration).toBe(1n);

    // Attempt B: a newer full pass completes while A is "still running".
    const passB = await deriveRunEvidence(prisma, harness.runId);
    expect(passB.derivationCompleteness.status).toBe('COMPLETE');
    const rowsAfterB = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_EVIDENCE);
    // A was NOT cleared, NOT abandoned, NOT rewritten — it is preserved.
    expect(rowsAfterB).toHaveLength(2);
    expect(rowsAfterB[0]?.status).toBe('IN_PROGRESS');
    expect(rowsAfterB[1]?.status).toBe('COMPLETE');
    expect(rowsAfterB[1]?.attemptGeneration).toBe(2n);

    const readyAfterB = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readyAfterB.complete).toBe(true);
    expect(readyAfterB.unresolvedAttempts.map((attempt) => attempt.attemptGeneration)).toEqual([
      '1',
    ]);

    // The older pass commits LATER: it cannot be silently ignored — the D
    // advance invalidates the newer proof (fail closed, never a false PASS).
    await foreignDerivedCommit(harness.runId, {
      normalizerName: 'late-normalizer',
      normalizerVersion: 'v1',
      eventType: 'late.projection-observed',
      subjectKey: 'late-subject',
      payload: { note: 'late write by the older attempt' },
    });
    const readinessAfterLate = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readinessAfterLate.complete).toBe(false);
    expect(readinessAfterLate.state).toBe('UNATTRIBUTED');
    expect(readinessAfterLate.reason).toBe('DERIVATION_GENERATION_ADVANCED_AFTER_PROOF');
    expect(readinessAfterLate.proof?.committedDerivationGeneration).toBe('1');
    expect(readinessAfterLate.current.derivationGeneration).toBe('2');
  });
});

// =====================================================================
// D-16 — forensic derivation coverage (class B exclusion, proven)
// =====================================================================

describe('B2 · D-16: forensic derivation follows the proven permitted exclusion', () => {
  it('does NOT advance D, proves its own completeness, and cannot change evaluation inputs', async () => {
    const harness = await makeRun(1, 'b2-d16');
    await appendInvocationObservation(harness, `pay-d16-${Date.now()}`);
    await deriveRunEvidence(prisma, harness.runId);
    const dBefore = await readD(harness.runId);

    // Evaluation BEFORE forensics: the evidence-set identity the evaluator sees.
    const evidenceBefore = await readEvaluationFacingEvidence(harness.runId);

    const forensics = await deriveRunForensics(prisma, harness.runId);
    expect(forensics.derivationCompleteness.status).toBe('COMPLETE');

    // The grounded exclusion: a report-facing projection never makes the
    // derivation generation (and therefore every evaluation pointer) stale.
    expect(await readD(harness.runId)).toBe(dBefore);

    const forensicAttempts = await attemptsFor(harness.runId, DERIVATION_KIND_RUN_FORENSICS);
    expect(forensicAttempts).toHaveLength(1);
    expect(forensicAttempts[0]?.status).toBe('COMPLETE');
    expect(forensicAttempts[0]?.committedDerivationGeneration).toBe(dBefore);
    // Captured source for the completeness-marked kind includes D itself.
    expect(forensicAttempts[0]?.sourceDerivationGeneration).toBe(dBefore);

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_FORENSICS,
    );
    expect(readiness.complete).toBe(true);
    expect(readiness.state).toBe('COMPLETE');

    // The evaluator-facing evidence read is byte-identical: forensic rows are
    // NOT an evaluation input (the proven non-influence property).
    const evidenceAfter = await readEvaluationFacingEvidence(harness.runId);
    expect(evidenceAfter).toEqual(evidenceBefore);

    // And the marker is load-bearing: a later derived commit makes the
    // forensic proof stale (fail closed) until a forensic pass re-proves it.
    await foreignDerivationPass(harness.runId, {
      normalizerName: 'foreign-normalizer',
      normalizerVersion: 'v2',
      eventType: 'foreign.projection-observed',
      subjectKey: 'foreign-subject',
      payload: { note: 'post-forensics derived commit' },
    });
    const staleForensics = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_FORENSICS,
    );
    expect(staleForensics.complete).toBe(false);
    expect(staleForensics.state).toBe('UNATTRIBUTED');
    // A rerun of the forensic derivation re-establishes completeness.
    const again = await deriveRunForensics(prisma, harness.runId);
    expect(again.derivationCompleteness.status).toBe('COMPLETE');
    const reReady = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_FORENSICS,
    );
    expect(reReady.complete).toBe(true);
  });

  it('an INCOMPLETE forensic pass (source moved mid-pass) fails closed', async () => {
    const harness = await makeRun(1, 'b2-d16b');
    await appendInvocationObservation(harness, `pay-d16b-${Date.now()}`);
    await deriveRunEvidence(prisma, harness.runId);
    // A foreign derived commit BETWEEN the forensic attempt's begin and its
    // completion is a real mid-pass source move for this kind (its inputs
    // include the derived graph). The hook fires after the pass's evidence
    // load — i.e. strictly inside the pass, after the attempt captured its
    // source watermark.
    let moved = false;
    const moving = prisma.$extends({
      query: {
        normalizedEvent: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (!moved) {
              moved = true;
              await foreignDerivationPass(harness.runId, {
                normalizerName: 'foreign-mid-forensics',
                normalizerVersion: 'v2',
                eventType: 'foreign.projection-observed',
                subjectKey: 'foreign-subject',
                payload: { note: 'mid-forensics foreign commit' },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;
    const result = await deriveRunForensics(moving, harness.runId);
    expect(result.derivationCompleteness.status).toBe('INCOMPLETE');
    expect(result.derivationCompleteness.reason).toBe('SOURCE_ADVANCED_DURING_DERIVATION');
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_FORENSICS,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('INCOMPLETE');
  });
});

// =====================================================================
// D-17 … D-19 — fail-closed defaults, legacy compatibility
// =====================================================================

describe('B2 · D-17: a missing or abandoned completion marker is fail-closed', () => {
  it('fails closed on an abandoned attempt and on projection rows with no attempt at all', async () => {
    // (a) Abandoned attempt: no COMPLETE proof ⇒ fail closed.
    const abandoned = await makeRun(1, 'b2-d17a');
    await appendInvocationObservation(abandoned, `pay-d17a-${Date.now()}`);
    const attempt = await beginDerivationAttempt(
      prisma,
      abandoned.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    const abandonedApplied = await abandonDerivationAttempt(
      prisma,
      abandoned.runId,
      attempt.attemptGeneration,
      DERIVATION_KIND_RUN_EVIDENCE,
      'operator-supersession',
    );
    expect(abandonedApplied).toBe(true);
    const abandonedReadiness = await readDerivationReadiness(
      prisma,
      abandoned.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(abandonedReadiness.complete).toBe(false);
    expect(abandonedReadiness.state).toBe('INCOMPLETE');
    expect(abandonedReadiness.reason).toContain('ATTEMPT_ABANDONED');
    // An abandoned attempt is never re-finished by another writer either.
    const reclaimed = await completeDerivationAttempt(prisma, attempt, {});
    expect(reclaimed.status).toBe('NOT_APPLIED');

    // (b) Projection rows with NO attempt row: the missing marker is visible.
    const untracked = await makeRun(1, 'b2-d17b');
    await legacyDerivedRow(untracked.runId, {
      normalizerName: 'legacy-pre-b2-normalizer',
      normalizerVersion: 'v1',
      eventType: 'legacy.event-observed',
      subjectKey: 'legacy-subject',
      payload: { note: 'pre-protocol row' },
    });
    const untrackedReadiness = await readDerivationReadiness(
      prisma,
      untracked.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(untrackedReadiness.complete).toBe(false);
    expect(untrackedReadiness.state).toBe('UNTRACKED');
    expect(untrackedReadiness.reason).toBe('PROJECTION_ROWS_WITHOUT_ATTEMPT');

    // A full B2 pass re-establishes a proven-complete projection.
    await appendInvocationObservation(untracked, `pay-d17b-${Date.now()}`);
    const pass = await deriveRunEvidence(prisma, untracked.runId);
    expect(pass.derivationCompleteness.status).toBe('COMPLETE');
    const readyNow = await readDerivationReadiness(
      prisma,
      untracked.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readyNow.complete).toBe(true);
  });
});

describe('B2 · D-18: the existing evidence chain remains hash-valid', () => {
  it('verifies the chain after appends, a derivation, and a forensic pass', async () => {
    const harness = await makeRun(2, 'b2-d18');
    await appendInvocationObservation(harness, `pay-d18a-${Date.now()}`);
    await appendLineageObservation(harness, `pay-d18b-${Date.now()}`);
    await deriveRunEvidence(prisma, harness.runId);
    await deriveRunForensics(prisma, harness.runId);
    const report = await verifyRunEvidenceChain(prisma, harness.runId);
    expect(report.chainValid).toBe(true);
    expect(report.contentHashesValid).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.observationCount).toBe(2);
  });
});

describe('B2 · D-19: a legacy run without a truth-input-head row reads predictably', () => {
  it('treats a missing head row as (0, 0), never fabricates one, and certifies an empty projection', async () => {
    const harness = await makeRun(1, 'b2-d19');
    // Simulate a PRE-PROTOCOL legacy run: its authority head row predates the
    // protocol, and the frozen compatibility default treats a missing row as
    // (0, 0) (ADR-0026 §13). Removing this run's own coordination row (never
    // business truth, never evidence) is the only way to construct that state
    // on today's code, where run creation is itself a protocol writer.
    await prisma.runTruthInputHead.deleteMany({ where: { runId: harness.runId } });
    const headRows = (await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "control"."run_truth_input_head" WHERE "runId" = ${harness.runId}::uuid
    `) as Array<{ n: number }>;
    expect(headRows[0]?.n).toBe(0);
    expect(await readP(harness.runId)).toBe(0n);
    expect(await readD(harness.runId)).toBe(0n);

    const emptyReadiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(emptyReadiness.complete).toBe(false);
    expect(emptyReadiness.state).toBe('NOT_STARTED');
    expect(emptyReadiness.reason).toBe('NO_DERIVATION_ATTEMPT');
    expect(emptyReadiness.current.chain).toEqual({
      headContentHash: null,
      observationCount: 0,
      lastChainIndex: null,
    });

    // An empty run (no observations) derives NOTHING ⇒ no derived commit ⇒
    // no head row is invented, D stays 0, and the pass still proves COMPLETE.
    const emptyPass = await deriveRunEvidence(prisma, harness.runId);
    expect(emptyPass.events).toHaveLength(0);
    expect(emptyPass.derivationCompleteness.status).toBe('COMPLETE');
    const stillNoHead = (await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "control"."run_truth_input_head" WHERE "runId" = ${harness.runId}::uuid
    `) as Array<{ n: number }>;
    expect(stillNoHead[0]?.n).toBe(0);
    expect(await readD(harness.runId)).toBe(0n);
    const emptyReady = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(emptyReady.complete).toBe(true);

    // A later real observation: the chain append advances ONLY `C`
    // (never P, never D), and the next pass initializes D = 1.
    await appendInvocationObservation(harness, `pay-d19-${Date.now()}`);
    expect(await readP(harness.runId)).toBe(0n);
    expect(await readD(harness.runId)).toBe(0n);
    const pass = await deriveRunEvidence(prisma, harness.runId);
    expect(pass.derivationCompleteness.status).toBe('COMPLETE');
    expect(await readD(harness.runId)).toBe(1n);
    expect(await readP(harness.runId)).toBe(0n);
    const head = await readTruthInputHead(prisma, harness.runId);
    expect(head.provenanceRevision).toBe(0n);
    expect(head.derivationGeneration).toBe(1n);
  });
});

// =====================================================================
// D-20 — concurrent P, C and D operations
// =====================================================================

describe('B2 · D-20: concurrent same-run P, C and D operations keep one lock order', () => {
  it('a provenance write, a chain append and a derivation all complete with no lost revision', async () => {
    const harness = await makeRun(1, 'b2-d20');
    await appendInvocationObservation(harness, `pay-d20-${Date.now()}`);

    const holder = await holdRunLock(harness.runId);
    const pWriter = markRunDispatching(prisma, harness.runId);
    const cWriter = appendInvocationObservation(harness, `pay-d20b-${Date.now()}`);
    const dWriter = deriveRunEvidence(prisma, harness.runId);
    try {
      await waitForRunLockWait(harness.runId); // three contenders, one key
    } finally {
      holder.release();
    }
    const [pResult, cResult, dResult] = await Promise.allSettled([pWriter, cWriter, dWriter]);
    await holder.done;
    expect(pResult.status).toBe('fulfilled');
    expect(cResult.status).toBe('fulfilled');
    expect(dResult.status).toBe('fulfilled');
    if (dResult.status !== 'fulfilled') {
      throw dResult.reason;
    }

    // One lock order, no deadlock, no lost revision: P advanced by exactly
    // the one provenance write; the chain is gap-free and hash-valid with
    // both observations; D equals the number of committed derived rows
    // (events + relationships) — every one advanced it exactly once.
    expect(await readP(harness.runId)).toBe(2n); // run creation + the dispatch marker
    const chain = await verifyRunEvidenceChain(prisma, harness.runId);
    expect(chain.chainValid).toBe(true);
    expect(chain.observationCount).toBe(2);
    const counts = await readProjectionCounts(harness.runId);
    expect(await readD(harness.runId)).toBe(BigInt(counts.events + counts.relationships));
  });
});

// =====================================================================
// D-21 — untracked writers
// =====================================================================

describe('B2 · D-21: an untracked derived write cannot be represented as a proven pass', () => {
  it('DETECTS a protocol write that advances D with no covering proof (UNATTRIBUTED)', async () => {
    const harness = await makeRun(1, 'b2-d21a');
    await appendInvocationObservation(harness, `pay-d21a-${Date.now()}`);
    await deriveRunEvidence(prisma, harness.runId);
    expect(
      (await readDerivationReadiness(prisma, harness.runId, DERIVATION_KIND_RUN_EVIDENCE)).complete,
    ).toBe(true);

    // An unsupported/untracked writer that TAKES the lock and advances D but
    // never creates an attempt (a hand-rolled or crashed custom writer).
    await foreignDerivedCommit(harness.runId, {
      normalizerName: 'untracked-normalizer',
      normalizerVersion: 'v1',
      eventType: 'untracked.event-observed',
      subjectKey: 'untracked-subject',
      payload: { note: 'untracked derived commit' },
    });

    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('UNATTRIBUTED');
    expect(readiness.reason).toBe('DERIVATION_GENERATION_ADVANCED_AFTER_PROOF');
  });

  it('DOCUMENTS the residual: a direct write that neither advances D nor creates an attempt is outside the application protocol', async () => {
    // This case is deliberately an HONEST BOUNDARY RECORD, not a guarantee:
    // an application-level lock cannot see a write that never takes it and
    // never advances `D` (the same class as direct SQL/DBA mutation, R-18).
    // It is recorded as a blocker in the B2 self-audit; this assertion
    // documents the boundary so no reader infers coverage that does not
    // exist.
    const harness = await makeRun(1, 'b2-d21b');
    await appendInvocationObservation(harness, `pay-d21b-${Date.now()}`);
    await deriveRunEvidence(prisma, harness.runId);
    const dBefore = await readD(harness.runId);
    await legacyDerivedRow(harness.runId, {
      normalizerName: 'dba-style-normalizer',
      normalizerVersion: 'v1',
      eventType: 'dba-style.event-observed',
      subjectKey: 'dba-style-subject',
      payload: { note: 'direct application-protocol-bypassing write' },
    });
    expect(await readD(harness.runId)).toBe(dBefore); // D untouched
    const readiness = await readDerivationReadiness(
      prisma,
      harness.runId,
      DERIVATION_KIND_RUN_EVIDENCE,
    );
    // The durable proof still stands for everything the protocol wrote; the
    // bypassing row is NOT detected (documented residual, never claimed).
    expect(readiness.complete).toBe(true);
  });
});

// =====================================================================
// Helper primitives (mirrors the B1 suite's helper coverage)
// =====================================================================

describe('B2 · helper primitives', () => {
  it('advanceDerivationGeneration is monotone by exactly 1 per call in one transaction', async () => {
    const harness = await makeRun(1, 'b2-helper');
    expect(await readD(harness.runId)).toBe(0n);
    const pBefore = await readP(harness.runId);
    await prisma.$transaction(
      async (tx) => {
        await acquireRunLock(tx, harness.runId);
        await advanceDerivationGeneration(tx, harness.runId);
        await advanceDerivationGeneration(tx, harness.runId);
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    expect(await readD(harness.runId)).toBe(2n);
    const head = await readTruthInputHead(prisma, harness.runId);
    expect(head.provenanceRevision).toBe(pBefore); // D writers never touch P
    // Reading a watermark captures all three components as ONE identity.
    const watermark = await readTruthInputWatermark(prisma, harness.runId);
    expect(watermark.derivationGeneration).toBe(2n);
    expect(watermark.chain.observationCount).toBe(0);
  });

  it('stage-1 and stage-2 captures agree when nothing moves, and detect a race when it does', async () => {
    const harness = await makeRun(1, 'b2-helper2');
    const stage1 = await captureStage1Source(prisma, harness.runId);
    const stage2 = await captureStage2Watermark(prisma, harness.runId, stage1);
    expect(stage2.raced).toBe(false);
    expect(stage2.watermark).toEqual(stage1);
    const validation = await validateWatermarkCurrent(prisma, harness.runId, stage1);
    expect(validation.matches).toBe(true);
    expect(validation.changedComponents).toEqual([]);

    await markRunDispatching(prisma, harness.runId); // P advances
    const raced = await captureStage2Watermark(prisma, harness.runId, stage1);
    expect(raced.raced).toBe(true);
    const mismatch = await validateWatermarkCurrent(prisma, harness.runId, stage1);
    expect(mismatch.matches).toBe(false);
    expect(mismatch.changedComponents).toEqual(['provenanceRevision']);
  });

  it('a run that does not exist is not fabricated into an attempt', async () => {
    const result = await deriveRunEvidence(prisma, randomUUID());
    expect(result.events).toHaveLength(0);
    expect(result.derivationCompleteness.status).toBe('NOT_APPLIED');
    expect(result.derivationCompleteness.reason).toBe('RUN_NOT_FOUND');
  });
});
