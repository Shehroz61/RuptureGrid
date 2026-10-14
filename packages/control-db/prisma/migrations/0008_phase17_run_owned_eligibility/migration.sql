-- =====================================================================
-- RuptureGrid Control — migration 0008 (Phase 17)
-- Run-owned evaluation eligibility + composite truth-input watermark
-- (ADR-0026 §13)
-- =====================================================================
-- ADDITIVE ONLY (R-12: reviewable, reproducible, testable; no schema
-- push, no destructive rewrite, no historical row touched):
--
--   control.run_truth_input_head       — the run-scoped composite
--       watermark revision counters `(P, D)` of `W = (C, P, D)`. A
--       mutable coordination row by design (the accepted
--       EvidenceIntegrityHead precedent): P advances under the writer
--       protocol with every truth-bearing non-chain write; D advances
--       with every committed derived projection. Missing row ⇒ (0, 0).
--
--   analysis.current_evaluation_pointer — exactly one persisted,
--       analysis-owned current-truth reference per eligible
--       (run, invariantKey, evaluatorVersion, subjectKey) NAMING the
--       current InvariantEvaluation row. Report and classifier read
--       pointers; they never choose rows by timestamp/UUID/row order.
--
--   analysis.run_eligibility_proof      — one persisted eligibility /
--       coverage proof per (run, invariantKey, evaluatorVersion):
--       mode, coverageMode, the shared analysisGeneration, the
--       publication watermark (C, P, D), the anchor tuple, the
--       declared/eligible/missing subject sets, the class-B unexpected
--       identities, the class-C foreign inventory (counts only), the
--       named evidence gaps, and the frozen coverage statement. The
--       report serializes THIS row — persisted analysis results, never
--       rederived business truth.
--
-- All three are COORDINATION METADATA, never a second invariant-truth
-- engine: verdicts live ONLY in `analysis.invariant_evaluation` rows.
--
-- No existing table, column, row, snapshot, or ReproductionDefinition
-- is modified. Existing acceptance-tag databases migrate safely.

-- CreateTable
CREATE TABLE "control"."run_truth_input_head" (
    "runId" UUID NOT NULL,
    "provenanceRevision" BIGINT NOT NULL DEFAULT 0,
    "derivationGeneration" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_truth_input_head_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "analysis"."current_evaluation_pointer" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "evaluatorVersion" VARCHAR(32) NOT NULL,
    "subjectKey" VARCHAR(200) NOT NULL,
    "currentEvaluationId" UUID NOT NULL,
    "evidenceHeadHash" VARCHAR(64) NOT NULL,
    "eligibilityVersion" VARCHAR(32) NOT NULL,
    "analysisGeneration" BIGINT NOT NULL,
    "integrityHeadHash" VARCHAR(64),
    "integrityObservationCount" INTEGER NOT NULL,
    "provenanceRevision" BIGINT NOT NULL,
    "derivationGeneration" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "current_evaluation_pointer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."run_eligibility_proof" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "evaluatorVersion" VARCHAR(32) NOT NULL,
    "eligibilityVersion" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(24) NOT NULL,
    "coverageMode" VARCHAR(32) NOT NULL,
    "analysisGeneration" BIGINT NOT NULL,
    "integrityHeadHash" VARCHAR(64),
    "integrityObservationCount" INTEGER NOT NULL,
    "provenanceRevision" BIGINT NOT NULL,
    "derivationGeneration" BIGINT NOT NULL,
    "anchor" JSONB,
    "declaredSubjectsJson" JSONB,
    "eligibleSubjectsJson" JSONB,
    "missingSubjectsJson" JSONB,
    "unexpectedSubjects" JSONB,
    "foreignInventory" JSONB,
    "evidenceGaps" JSONB,
    "coverageStatement" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_eligibility_proof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "current_evaluation_pointer_runId_idx" ON "analysis"."current_evaluation_pointer"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "current_evaluation_pointer_runId_invariantKey_evaluatorVers_key" ON "analysis"."current_evaluation_pointer"("runId", "invariantKey", "evaluatorVersion", "subjectKey");

-- CreateIndex
CREATE INDEX "run_eligibility_proof_runId_idx" ON "analysis"."run_eligibility_proof"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "run_eligibility_proof_runId_invariantKey_evaluatorVersion_key" ON "analysis"."run_eligibility_proof"("runId", "invariantKey", "evaluatorVersion");

-- AddForeignKey
ALTER TABLE "control"."run_truth_input_head" ADD CONSTRAINT "run_truth_input_head_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."current_evaluation_pointer" ADD CONSTRAINT "current_evaluation_pointer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."current_evaluation_pointer" ADD CONSTRAINT "current_evaluation_pointer_currentEvaluationId_fkey" FOREIGN KEY ("currentEvaluationId") REFERENCES "analysis"."invariant_evaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."run_eligibility_proof" ADD CONSTRAINT "run_eligibility_proof_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

