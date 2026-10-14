-- =====================================================================
-- RuptureGrid Control — migration 0009 (Phase 17, Checkpoint B2)
-- Derivation-attempt completeness record (ADR-0026 §13)
-- =====================================================================
-- ADDITIVE ONLY (R-12: reviewable, reproducible, testable; NO destructive
-- statement, NO warmup, NO table/column/row of an existing table touched):
--
--   evidence.derivation_attempt — one durable row per derivation ATTEMPT
--       of a run. The set of derivation commits that have run is NOT
--       derivable from the raw chain, so a partial projection must never
--       be read as complete: the attempt is made durable BEFORE its first
--       derived write, marked COMPLETE only after its completeness checks
--       pass, and a reader that finds the newest attempt non-terminal (or
--       terminal-but-stale against the current truth-input watermark)
--       fails closed.
--
--   evidence."DerivationAttemptStatus" — IN_PROGRESS | COMPLETE |
--       INCOMPLETE | FAILED | ABANDONED. ABANDONED records a superseded
--       in-progress attempt; its row is preserved, so a newer attempt can
--       never silently clear an older one's state.
--
-- Coordination metadata only: never business truth, never a verdict
-- (R-18). Generated with
--   prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema prisma/schema.prisma --script

-- CreateEnum
CREATE TYPE "evidence"."DerivationAttemptStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE', 'INCOMPLETE', 'FAILED', 'ABANDONED');

-- CreateTable
CREATE TABLE "evidence"."derivation_attempt" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "derivationKind" VARCHAR(64) NOT NULL,
    "attemptGeneration" BIGINT NOT NULL,
    "status" "evidence"."DerivationAttemptStatus" NOT NULL,
    "sourceChainHeadHash" VARCHAR(64),
    "sourceChainObservationCount" INTEGER NOT NULL,
    "sourceChainLastIndex" INTEGER,
    "sourceProvenanceRevision" BIGINT NOT NULL,
    "sourceDerivationGeneration" BIGINT NOT NULL,
    "committedDerivationGeneration" BIGINT,
    "projectionCounts" JSONB,
    "reason" VARCHAR(500),
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "derivation_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "derivation_attempt_runId_derivationKind_status_idx" ON "evidence"."derivation_attempt"("runId", "derivationKind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "derivation_attempt_runId_derivationKind_attemptGeneration_key" ON "evidence"."derivation_attempt"("runId", "derivationKind", "attemptGeneration");

-- AddForeignKey
ALTER TABLE "evidence"."derivation_attempt" ADD CONSTRAINT "derivation_attempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

