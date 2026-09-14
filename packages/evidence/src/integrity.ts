// =====================================================================
// RuptureGrid v1.0 — evidence integrity verification (Phase 4, §20)
// =====================================================================
// Recomputes the per-run hash chain and content hashes and reports
// what is ACTUALLY verifiable, stated honestly (evidence-model §4):
//
//   VERIFIABLE: that the stored observation rows are exactly the rows
//   the application's writers appended — content hashes match their
//   stored redacted representations, the chain is gap-free, linked,
//   and its head matches the integrity-head row.
//
//   NOT CLAIMED: tamper-proofing, immutability against a database
//   administrator, non-repudiation, legal proof. A DBA can rewrite
//   rows AND recompute this chain; the verifier detects post-hoc
//   modification by the application's writers, nothing more.
//
// The verifier is read-only: it never rewrites observation rows. The
// verification outcome is recorded on the integrity-head row (its own
// coordination metadata), never on the observations themselves.

import type { PrismaClient } from '@rupturegrid/control-db';
import { canonicalEvidenceHash } from './redact.js';

export interface ChainProblem {
  readonly chainIndex: number;
  readonly kind: 'gap' | 'hash-mismatch' | 'broken-link' | 'head-mismatch' | 'count-mismatch';
  readonly detail: string;
}

export interface IntegrityReport {
  readonly runId: string;
  readonly observationCount: number;
  readonly headContentHash: string | null;
  readonly recomputedHeadHash: string | null;
  readonly chainValid: boolean;
  readonly contentHashesValid: boolean;
  readonly problems: ChainProblem[];
  /** Honest guarantee statement (never overclaimed). */
  readonly guarantee:
    | 'append-only chain intact: stored observations match their hashes and links'
    | 'chain verification FAILED: stored observations do not match their recorded hashes/links';
  readonly verifiedAt: Date;
}

/**
 * Verifies one run's evidence chain end to end:
 *   1. observations ordered by chainIndex, gap-free from 0
 *   2. every prevContentHash links to its predecessor's contentHash
 *   3. every contentHash equals SHA-256 of the canonical stored payload
 *   4. the head row matches the recomputed head and count
 */
export async function verifyRunEvidenceChain(
  prisma: PrismaClient,
  runId: string,
): Promise<IntegrityReport> {
  const observations = await prisma.rawObservation.findMany({
    where: { runId },
    orderBy: { chainIndex: 'asc' },
    select: {
      chainIndex: true,
      contentHash: true,
      prevContentHash: true,
      payload: true,
      redactionApplied: true,
      redactionPolicyVersion: true,
    },
  });
  const head = await prisma.evidenceIntegrityHead.findUnique({
    where: { runId },
    select: {
      lastChainIndex: true,
      headContentHash: true,
      observationCount: true,
    },
  });

  const problems: ChainProblem[] = [];
  observations.forEach((observation, position) => {
    if (observation.chainIndex !== position) {
      problems.push({
        chainIndex: observation.chainIndex,
        kind: 'gap',
        detail: `expected chain index ${position}, found ${observation.chainIndex}`,
      });
    }
    const { hash } = canonicalEvidenceHash(observation.payload);
    if (hash !== observation.contentHash) {
      problems.push({
        chainIndex: observation.chainIndex,
        kind: 'hash-mismatch',
        detail: 'stored payload does not hash to its recorded contentHash',
      });
    }
    const previous = observations[position - 1];
    const expectedPrev = position === 0 ? null : (previous?.contentHash ?? null);
    if ((observation.prevContentHash ?? null) !== expectedPrev) {
      problems.push({
        chainIndex: observation.chainIndex,
        kind: 'broken-link',
        detail: 'prevContentHash does not reference the predecessor observation',
      });
    }
  });

  const recomputedHeadHash =
    observations.length === 0 ? null : (observations[observations.length - 1]?.contentHash ?? null);
  if (head === null) {
    if (observations.length > 0) {
      problems.push({
        chainIndex: observations.length - 1,
        kind: 'head-mismatch',
        detail: 'observations exist but the integrity head row is missing',
      });
    }
  } else {
    if (head.headContentHash !== recomputedHeadHash) {
      problems.push({
        chainIndex: head.lastChainIndex,
        kind: 'head-mismatch',
        detail: 'integrity head hash does not match the recomputed chain head',
      });
    }
    if (head.observationCount !== observations.length) {
      problems.push({
        chainIndex: head.lastChainIndex,
        kind: 'count-mismatch',
        detail: `integrity head records ${head.observationCount} observations; found ${observations.length}`,
      });
    }
  }

  const chainValid = !problems.some((problem) => problem.kind !== 'hash-mismatch');
  const contentHashesValid = !problems.some((problem) => problem.kind === 'hash-mismatch');
  const verifiedAt = new Date();

  // Record the verification OUTCOME on the head row (coordination
  // metadata only — observation rows are never touched).
  if (head !== null) {
    await prisma.evidenceIntegrityHead.update({
      where: { runId },
      data: {
        lastVerifiedAt: verifiedAt,
        lastVerifiedHeadHash: recomputedHeadHash,
        lastVerifiedObservationCount: observations.length,
      },
    });
  }

  return {
    runId,
    observationCount: observations.length,
    headContentHash: head?.headContentHash ?? null,
    recomputedHeadHash,
    chainValid,
    contentHashesValid,
    problems,
    guarantee:
      problems.length === 0
        ? 'append-only chain intact: stored observations match their hashes and links'
        : 'chain verification FAILED: stored observations do not match their recorded hashes/links',
    verifiedAt,
  };
}
