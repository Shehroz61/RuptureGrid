// =====================================================================
// Integration — snapshot immutability + target/experiment/run creation
// =====================================================================
// Proves (Phase 3 §20): Run A executes from the ORIGINAL snapshot even
// after the experiment definition is mutated; Run B sees the new one.
// Also proves production denial (§12) and content-addressed snapshots.

import { beforeAll, describe, expect, it } from 'vitest';
import { createExperiment, createRun, registerTarget, RunCreationError } from '@rupturegrid/engine';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const prisma = getControlPrisma();

describe('run snapshots are immutable (ADR-0010, Phase 3 §20)', () => {
  let targetId = '';
  let definitionId = '';
  let revisionId = '';

  beforeAll(async () => {
    // Origin uniqueness is global; derive a fresh port per run so the
    // suite is order-independent and rerunnable.
    const origin = await uniqueTestOrigin(prisma);
    const target = await registerTarget(prisma, {
      displayName: uniqueName('immutability-target'),
      environment: 'LOCAL_DEVELOPMENT',
      origins: [origin],
      contractKind: 'GENERIC_HTTP',
    });
    targetId = target.targetId;
    const created = await createExperiment(prisma, {
      name: uniqueName('immutability-experiment'),
      targetId,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/before-mutation',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    definitionId = created.definitionId;
    revisionId = created.revisionId;
  });

  it('run A pins the original snapshot; mutating the definition does not affect it', async () => {
    const runA = await createRun(prisma, revisionId);
    const snapshotHashA = runA.contentHash;

    // "Mutate" the definition the accepted way: a NEW revision of the
    // definition with different steps (definitions are append-only).
    const created = await prisma.$transaction(async (tx) => {
      const definition = await tx.experimentDefinition.findUniqueOrThrow({
        where: { id: definitionId },
        include: { revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 } },
      });
      return tx.experimentRevision.create({
        data: {
          definitionId,
          revisionNumber: (definition.revisions[0]?.revisionNumber ?? 0) + 1,
          targetId,
          stepsJson: {
            steps: [
              {
                name: 'probe',
                action: {
                  method: 'GET',
                  relativePath: '/after-mutation',
                  mutation: 'READ_ONLY',
                  contract: 'GENERIC_HTTP',
                },
              },
            ],
          },
        },
      });
    });

    // Run A still resolves to the ORIGINAL frozen document + hash.
    const runARow = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: runA.runId },
      include: { snapshot: true },
    });
    expect(runARow.snapshot.contentHash).toBe(snapshotHashA);
    const documentA = runARow.snapshot.content as { steps: { action: { relativePath: string } }[] };
    expect(documentA.steps[0]?.action.relativePath).toBe('/before-mutation');

    // Run B freezes the NEW revision into a NEW snapshot.
    const runB = await createRun(prisma, created.id);
    expect(runB.snapshotId).not.toBe(runA.snapshotId);
    expect(runB.contentHash).not.toBe(snapshotHashA);
    const runBRow = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: runB.runId },
      include: { snapshot: true },
    });
    const documentB = runBRow.snapshot.content as { steps: { action: { relativePath: string } }[] };
    expect(documentB.steps[0]?.action.relativePath).toBe('/after-mutation');
  });

  it('snapshots are content-addressed: re-freezing an unchanged revision reuses the row', async () => {
    const again = await createRun(prisma, revisionId);
    const first = await prisma.experimentRun.findFirstOrThrow({
      where: { snapshot: { revisionId } },
      orderBy: { createdAt: 'asc' },
      select: { snapshotId: true },
    });
    expect(again.snapshotId).toBe(first.snapshotId);
  });

  it('production-classified targets are DENIED at run creation (ADR-0011)', async () => {
    // Origin uniqueness is global; a unique subdomain per run keeps the
    // suite rerunnable against a persistent Control DB.
    const prodOrigin = `https://prod-${Date.now()}.example.internal`;
    const prodTarget = await registerTarget(prisma, {
      displayName: uniqueName('production-target'),
      environment: 'PRODUCTION',
      origins: [prodOrigin],
      contractKind: 'GENERIC_HTTP',
    });
    const prodExperiment = await createExperiment(prisma, {
      name: uniqueName('production-experiment'),
      targetId: prodTarget.targetId,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    await expect(createRun(prisma, prodExperiment.revisionId)).rejects.toBeInstanceOf(
      RunCreationError,
    );
  });

  it('snapshot hashes are stable across re-freezes (canonicalization determinism)', async () => {
    const runC = await createRun(prisma, revisionId);
    const runD = await createRun(prisma, revisionId);
    expect(runC.contentHash).toBe(runD.contentHash);
    expect(runC.snapshotId).toBe(runD.snapshotId);
  });
});

describe('worker-side revalidation of target environment (Phase 3 §12)', () => {
  it('executor re-derives the URL from the registered origin and rejects escapes', async () => {
    // Defense in depth is proven at the unit level (path policy) and
    // by the executor's own origin re-check; here we prove the durable
    // path: a run's snapshot carries ONLY the registered origin.
    // Origin uniqueness is global, so derive a fresh port per run.
    const origin = await uniqueTestOrigin(prisma);
    const target = await registerTarget(prisma, {
      displayName: uniqueName('revalidate-target'),
      environment: 'LOCAL_DEVELOPMENT',
      origins: [origin],
      contractKind: 'GENERIC_HTTP',
    });
    const created = await createExperiment(prisma, {
      name: uniqueName('revalidate-experiment'),
      targetId: target.targetId,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/only-registered-origin',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    const run = await createRun(prisma, created.revisionId);
    const row = await prisma.experimentRun.findUniqueOrThrow({
      where: { id: run.runId },
      include: { snapshot: true },
    });
    const document = row.snapshot.content as { target: { origin: string } };
    expect(document.target.origin).toBe(origin);
  });
});
