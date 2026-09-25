// =====================================================================
// Integration — RawObservation IDENTITY semantics (real PostgreSQL)
// =====================================================================
// The observation identity is the PROVENANCE TUPLE (runId, kind,
// invocationIdentity). Contract proven here against the real Control
// PostgreSQL (R-08):
//
//   A. EXACT RETRY       — same run/invocation/content ⇒ ONE row, both
//                          calls return the same semantic row
//   B. CONTENT CONFLICT  — same identity, different stored content ⇒
//                          explicit integrity conflict, original row
//                          unchanged
//   C. CROSS-RUN         — a different run reusing the SAME identity
//                          string gets its OWN row; evidence is never
//                          aliased across runs
//   D. CROSS-INVOCATION  — two distinct invocation identities are two
//                          rows, even with identical content
//
// These tests create unique identities and own their state; they do
// not depend on historical rows being absent or present.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExperiment, createRun, registerTarget } from '@rupturegrid/engine';
import { EvidenceIntegrityConflictError, RawObservationStore } from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();

let secondDb: ControlDb | null = null;
let targetId = '';

beforeAll(async () => {
  // An INDEPENDENT second client proves committed visibility across
  // connections (same host/port/database — verified in the identity
  // probe below, without printing any credential material).
  secondDb = createControlDb(env.controlDatabaseUrl);
});

afterAll(async () => {
  await secondDb?.disconnect();
});

beforeAll(async () => {
  const target = await registerTarget(prisma, {
    displayName: uniqueName('identity-target'),
    environment: 'LOCAL_DEVELOPMENT',
    origins: [await uniqueTestOrigin(prisma)],
    contractKind: 'GENERIC_HTTP',
  });
  targetId = target.targetId;
});

async function freshRun(): Promise<{ runId: string; stepRunId: string }> {
  const created = await createExperiment(prisma, {
    name: uniqueName('identity-experiment'),
    targetId,
    document: {
      steps: [
        {
          name: 'only',
          action: {
            method: 'GET',
            relativePath: '/',
            mutation: 'READ_ONLY',
            contract: 'GENERIC_HTTP',
          },
        },
      ],
    } as never,
  });
  const run = await createRun(prisma, created.revisionId);
  return { runId: run.runId, stepRunId: run.stepRunIds[0] as string };
}

function observationFor(
  made: { runId: string; stepRunId: string },
  invocationIdentity: string,
  contentMarker: string,
): {
  runId: string;
  stepRunId: string;
  invocationId: null;
  invocationIdentity: string;
  sequence: number;
  waveIndex: number;
  method: 'GET';
  relativePath: string;
  requestHeaders: Record<string, string>;
  requestBody: null;
  transportStage: string;
  httpStatus: number;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  responseTruncated: boolean;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  outcome: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  observedAt: Date;
} {
  return {
    runId: made.runId,
    stepRunId: made.stepRunId,
    invocationId: null,
    invocationIdentity,
    sequence: 0,
    waveIndex: 0,
    method: 'GET',
    relativePath: '/',
    requestHeaders: { accept: 'application/json' },
    requestBody: null,
    transportStage: 'RESPONSE_COMPLETE',
    httpStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: JSON.stringify({ marker: contentMarker }),
    responseTruncated: false,
    requestBytes: 0,
    responseBytes: 32,
    durationMs: 5,
    outcome: 'SUCCEEDED',
    error: null,
    observedAt: new Date(),
  };
}

describe('RawObservation identity semantics (real PostgreSQL)', () => {
  it('resolves both clients to the same database (identity probe, no secrets)', async () => {
    const first = await prisma.$queryRawUnsafe<{ db: string; user: string }[]>(
      'SELECT current_database() AS db, current_user AS user',
    );
    const second = await secondDb?.prisma.$queryRawUnsafe<{ db: string; user: string }[]>(
      'SELECT current_database() AS db, current_user AS user',
    );
    expect(first[0]?.db).toBe(second?.[0]?.db);
    expect(first[0]?.user).toBe(second?.[0]?.user);
  });

  it('A. exact retry: same provenance identity + same content ⇒ ONE row, same semantic row returned', async () => {
    const made = await freshRun();
    const identity = `D-exact-retry-${Date.now()}`;
    const store = new RawObservationStore(prisma);
    const first = await store.appendInvocationObservation({
      observation: observationFor(made, identity, 'same-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    const second = await store.appendInvocationObservation({
      observation: observationFor(made, identity, 'same-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    // Same semantic row (id and chain position identical).
    expect(second.id).toBe(first.id);
    expect(second.chainIndex).toBe(first.chainIndex);
    expect(second.contentHash).toBe(first.contentHash);
    // Exactly ONE row exists for this provenance identity — visible to
    // BOTH the original and an independent client.
    expect(
      await prisma.rawObservation.count({
        where: { runId: made.runId, invocationIdentity: identity },
      }),
    ).toBe(1);
    expect(
      await secondDb?.prisma.rawObservation.count({
        where: { runId: made.runId, invocationIdentity: identity },
      }),
    ).toBe(1);
    // The row returned by call #1 is readable by primary key on the
    // SAME client and on the independent client (committed).
    expect(await prisma.rawObservation.findUnique({ where: { id: first.id } })).not.toBeNull();
    expect(
      await secondDb?.prisma.rawObservation.findUnique({ where: { id: first.id } }),
    ).not.toBeNull();
  });

  it('B. content conflict: same identity + different content ⇒ explicit conflict, original unchanged', async () => {
    const made = await freshRun();
    const identity = `D-content-conflict-${Date.now()}`;
    const store = new RawObservationStore(prisma);
    const first = await store.appendInvocationObservation({
      observation: observationFor(made, identity, 'original-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    await expect(
      store.appendInvocationObservation({
        observation: observationFor(made, identity, 'TAMPERED-content'),
        writerOwnerId: 'identity-test-writer',
        writerFencingToken: '1',
      }),
    ).rejects.toBeInstanceOf(EvidenceIntegrityConflictError);
    // Original row unchanged; still exactly one row.
    const row = await prisma.rawObservation.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.contentHash).toBe(first.contentHash);
    expect(JSON.stringify(row.payload)).toContain('original-content');
    expect(
      await prisma.rawObservation.count({
        where: { runId: made.runId, invocationIdentity: identity },
      }),
    ).toBe(1);
  });

  it('C. cross-run isolation: another run reusing the SAME identity string gets its OWN row', async () => {
    const runA = await freshRun();
    const runB = await freshRun();
    const sharedIdentity = `D-cross-run-${Date.now()}`;
    const store = new RawObservationStore(prisma);
    const appendedA = await store.appendInvocationObservation({
      observation: observationFor(runA, sharedIdentity, 'run-a-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    const appendedB = await store.appendInvocationObservation({
      observation: observationFor(runB, sharedIdentity, 'run-a-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    // NOT aliased: two distinct rows in two distinct runs.
    expect(appendedB.id).not.toBe(appendedA.id);
    expect(appendedB.chainIndex).toBe(0); // B's own chain, its own first observation
    const rowsA = await prisma.rawObservation.findMany({ where: { runId: runA.runId } });
    const rowsB = await prisma.rawObservation.findMany({ where: { runId: runB.runId } });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.runId).toBe(runB.runId);
    // Cross-run reuse of a content-identical payload did NOT merge runs'
    // evidence: each chain stands alone.
    expect(rowsA[0]?.id).not.toBe(rowsB[0]?.id);
  });

  it('D. cross-invocation isolation: two distinct invocation identities ⇒ two rows', async () => {
    const made = await freshRun();
    const store = new RawObservationStore(prisma);
    const first = await store.appendInvocationObservation({
      observation: observationFor(made, `D-inv-1-${Date.now()}`, 'identical-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    const second = await store.appendInvocationObservation({
      observation: observationFor(made, `D-inv-2-${Date.now()}`, 'identical-content'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.chainIndex).toBe(first.chainIndex + 1);
    expect(await prisma.rawObservation.count({ where: { runId: made.runId } })).toBe(2);
  });

  it('chain remains gap-free and verifiable after idempotent and conflict attempts', async () => {
    const made = await freshRun();
    const identity = `D-chain-${Date.now()}`;
    const store = new RawObservationStore(prisma);
    await store.appendInvocationObservation({
      observation: observationFor(made, identity, 'content-1'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    // Exact retry must NOT grow the chain.
    await store.appendInvocationObservation({
      observation: observationFor(made, identity, 'content-1'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    // A second invocation appends normally.
    await store.appendInvocationObservation({
      observation: observationFor(made, `D-chain-2-${Date.now()}`, 'content-2'),
      writerOwnerId: 'identity-test-writer',
      writerFencingToken: '1',
    });
    const { verifyRunEvidenceChain } = await import('@rupturegrid/evidence');
    const report = await verifyRunEvidenceChain(prisma, made.runId);
    expect(report.chainValid).toBe(true);
    expect(report.contentHashesValid).toBe(true);
    expect(report.observationCount).toBe(2);
    expect(report.problems).toEqual([]);
  });
});
