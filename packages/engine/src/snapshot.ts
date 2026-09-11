// =====================================================================
// RuptureGrid v1.0 — RunSnapshot creation (ADR-0010)
// =====================================================================
// A run executes from a FROZEN snapshot, never from mutable definition
// rows. The snapshot document is built from the revision's validated
// steps plus the target registration, canonicalized deterministically
// (canonicalize.ts), and stored with its SHA-256 content hash. Runs
// reference the snapshot id + hash. No secret values ever enter the
// document (references only — ADR-0012).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import { EXECUTION_ENGINE_VERSION } from '@rupturegrid/shared';
import type { ContractKind } from './target.js';
import { canonicalizeAndHash, CANONICALIZATION_ALGORITHM } from './canonicalize.js';
import type { ExperimentDocument, RunSnapshotDocument } from './types.js';

export class SnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export interface FrozenSnapshot {
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly document: RunSnapshotDocument;
}

/**
 * Builds the snapshot document for a revision. Pure — exported for
 * tests. Credential refs come from the TARGET registration only;
 * step-level refs must already be a subset (validated).
 */
export function buildSnapshotDocument(input: {
  readonly revision: {
    readonly id: string;
    readonly revisionNumber: number;
    readonly stepsJson: unknown;
  };
  readonly definition: { readonly id: string; readonly name: string };
  readonly target: {
    readonly id: string;
    readonly displayName: string;
    readonly environment: string;
    readonly contractKind: string;
    readonly credentialRefs: readonly string[];
    readonly origins: readonly { readonly origin: string }[];
  };
}): { document: RunSnapshotDocument; canonical: string; hash: string } {
  const target = input.target;
  if (target.origins.length === 0) {
    throw new SnapshotError('target has no registered origins');
  }
  const environmentOk = ['LOCAL_DEVELOPMENT', 'STAGING', 'PRODUCTION'].includes(target.environment);
  if (!environmentOk) {
    throw new SnapshotError(`unknown target environment: ${target.environment}`);
  }
  // Deterministic primary origin: lexicographically first normalized
  // origin. The revision is pinned to exactly one executable origin.
  const origin = [...target.origins].map((entry) => entry.origin).sort()[0] as string;
  const document: RunSnapshotDocument = {
    engineVersion: EXECUTION_ENGINE_VERSION,
    canonicalization: CANONICALIZATION_ALGORITHM,
    target: {
      targetId: target.id,
      displayName: target.displayName,
      environment: target.environment as RunSnapshotDocument['target']['environment'],
      origin,
      contractKind: target.contractKind as ContractKind,
      credentialRefs: [...target.credentialRefs].sort(),
    },
    experiment: {
      definitionId: input.definition.id,
      revisionId: input.revision.id,
      definitionName: input.definition.name,
      revisionNumber: input.revision.revisionNumber,
    },
    steps: (input.revision.stepsJson as ExperimentDocument).steps,
  };
  const { canonical, hash } = canonicalizeAndHash(document);
  return { document, canonical, hash };
}

/**
 * Creates (or retrieves) the RunSnapshot for a revision. Snapshots
 * are content-addressed: re-freezing an unchanged revision returns
 * the existing row (idempotent, no duplicate hash rows possible —
 * contentHash is unique).
 */
export async function freezeSnapshot(
  prisma: PrismaClient,
  revisionId: string,
): Promise<FrozenSnapshot> {
  const revision = await prisma.experimentRevision.findUnique({
    where: { id: revisionId },
    include: {
      definition: true,
      target: { include: { origins: true } },
    },
  });
  if (revision === null) {
    throw new SnapshotError(`revision ${revisionId} does not exist`);
  }
  const { document, hash } = buildSnapshotDocument({
    revision: {
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      stepsJson: revision.stepsJson,
    },
    definition: { id: revision.definition.id, name: revision.definition.name },
    target: {
      id: revision.target.id,
      displayName: revision.target.displayName,
      environment: revision.target.environment,
      contractKind: revision.target.contractKind,
      credentialRefs: revision.target.credentialRefs,
      origins: revision.target.origins,
    },
  });

  const existing = await prisma.runSnapshot.findUnique({ where: { contentHash: hash } });
  if (existing !== null) {
    return { snapshotId: existing.id, contentHash: existing.contentHash, document };
  }

  const snapshotId = randomUUID();
  await prisma.runSnapshot.create({
    data: {
      id: snapshotId,
      revisionId: revision.id,
      canonicalization: CANONICALIZATION_ALGORITHM,
      contentHash: hash,
      // The canonical string itself is the durable serialized form.
      content: JSON.parse(canonicalizeAndHash(document).canonical) as object,
    },
  });
  return { snapshotId, contentHash: hash, document };
}
