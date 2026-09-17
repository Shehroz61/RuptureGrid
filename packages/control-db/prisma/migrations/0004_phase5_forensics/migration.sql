-- =====================================================================
-- RuptureGrid Control — migration 0004 (Phase 5 forensics)
-- =====================================================================
-- Adds the Phase 5 forensic-analysis models to the ANALYSIS context
-- (docs/phase-roadmap.md Phase 5, docs/evidence-model.md §8/§9):
--
--   finding, finding_evidence_reference,
--   forensic_timeline_entry, forensic_derivation,
--   reproduction_definition
--
-- Findings are DERIVED investigator-facing statements that reference an
-- already-persisted InvariantEvaluation (one business truth engine);
-- they never re-evaluate evidence. The forensic timeline is a persisted,
-- versioned, recomputable investigation representation: every entry
-- cites a typed source row, every ordering carries an explicit basis,
-- and timeline entries never assert causality — causal claims live only
-- in the cited evidence.causal_relationship rows.
--
-- Append-only semantics: Finding and ForensicTimelineEntry rows are
-- derived historical artifacts — semantic content is never rewritten;
-- a changed rule/derivation version APPENDS new rows (unique keys
-- enforce convergence for identical (evaluation, version) pairs).
-- PASS / NOT_EVALUABLE produce NO failure Finding (§10/§41).
--
-- Idempotency is enforced at the DATABASE level (§64):
--   finding:                unique (invariantEvaluationId, findingRuleVersion)
--   forensic_timeline_entry: unique (runId, derivationVersion, sourceKind,
--                                    sourceId, entryKind)
--   forensic_derivation:     unique (runId, derivationVersion, inputFingerprint)
--
-- Deliberately ABSENT (R-01 phase boundaries): finding severity,
-- finding workflow status, AI-interpretation tables, product UI tables.
-- No modifications to migrations 0001/0002/0003. No Demo-schema changes
-- (ADR-0002). No db push.

-- CreateEnum
CREATE TYPE "analysis"."FindingReasonCode" AS ENUM ('DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT');

-- CreateEnum
CREATE TYPE "analysis"."EvidenceSubjectKind" AS ENUM ('RUN', 'STEP_RUN', 'INVOCATION', 'RAW_OBSERVATION', 'NORMALIZED_EVENT', 'CAUSAL_RELATIONSHIP', 'INVARIANT_EVALUATION', 'FINDING');

-- CreateEnum
CREATE TYPE "analysis"."TimelineEntryKind" AS ENUM ('RUN_TERMINAL_STATE', 'STEP_TERMINAL_STATE', 'INVOCATION_EXECUTED', 'HTTP_REQUEST_OBSERVED', 'HTTP_RESPONSE_OBSERVED', 'EXECUTOR_ERROR_OBSERVED', 'PROVIDER_PAYMENT_OBSERVED', 'PROVIDER_EVENT_OBSERVED', 'WEBHOOK_DELIVERY_OBSERVED', 'PROCESSING_ATTEMPT_OBSERVED', 'FINANCIAL_EFFECT_OBSERVED', 'LEDGER_ENTRY_OBSERVED', 'TARGET_STATE_OBSERVED', 'PAYMENT_DELIVERY_OBSERVED', 'INVARIANT_EVALUATED', 'FINDING_DERIVED');

-- CreateEnum
CREATE TYPE "analysis"."TimelineOrderingBasis" AS ENUM ('sequence', 'wall_clock', 'unordered_overlap');

-- CreateTable
CREATE TABLE "analysis"."finding" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "invariantEvaluationId" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "evaluatorVersion" VARCHAR(32) NOT NULL,
    "findingRuleVersion" VARCHAR(32) NOT NULL,
    "subjectKey" VARCHAR(200) NOT NULL,
    "reasonCode" "analysis"."FindingReasonCode" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "inputFingerprint" VARCHAR(64) NOT NULL,
    "details" JSONB NOT NULL,
    "provenScope" JSONB NOT NULL,
    "uncertainScope" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."finding_evidence_reference" (
    "id" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "subject" "analysis"."EvidenceSubjectKind" NOT NULL,
    "sourceId" VARCHAR(200) NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "finding_evidence_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."forensic_timeline_entry" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "derivationVersion" VARCHAR(32) NOT NULL,
    "entryKind" "analysis"."TimelineEntryKind" NOT NULL,
    "sourceKind" "analysis"."EvidenceSubjectKind" NOT NULL,
    "sourceId" VARCHAR(200) NOT NULL,
    "orderingBasis" "analysis"."TimelineOrderingBasis" NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "timeMeaning" VARCHAR(40) NOT NULL,
    "subjectKey" VARCHAR(200),
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forensic_timeline_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."forensic_derivation" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "derivationVersion" VARCHAR(32) NOT NULL,
    "inputFingerprint" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "timelineEntryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "forensic_derivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."reproduction_definition" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "snapshotContentHash" VARCHAR(64) NOT NULL,
    "targetModeRequirement" VARCHAR(32),
    "credentialRefs" TEXT[],
    "invariantBindings" JSONB NOT NULL,
    "acceptanceExpectations" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reproduction_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable

-- CreateIndex
CREATE INDEX "finding_runId_idx" ON "analysis"."finding"("runId");

-- CreateIndex
CREATE INDEX "finding_runId_subjectKey_idx" ON "analysis"."finding"("runId", "subjectKey");

-- CreateIndex
CREATE INDEX "finding_invariantKey_idx" ON "analysis"."finding"("invariantKey");

-- CreateIndex
CREATE INDEX "finding_reasonCode_idx" ON "analysis"."finding"("reasonCode");

-- CreateIndex
CREATE UNIQUE INDEX "finding_invariantEvaluationId_findingRuleVersion_key" ON "analysis"."finding"("invariantEvaluationId", "findingRuleVersion");

-- CreateIndex
CREATE INDEX "finding_evidence_reference_findingId_idx" ON "analysis"."finding_evidence_reference"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX "finding_evidence_reference_findingId_sourceId_role_key" ON "analysis"."finding_evidence_reference"("findingId", "sourceId", "role");

-- CreateIndex
CREATE INDEX "forensic_timeline_entry_runId_occurredAt_idx" ON "analysis"."forensic_timeline_entry"("runId", "occurredAt");

-- CreateIndex
CREATE INDEX "forensic_timeline_entry_runId_sequenceNumber_idx" ON "analysis"."forensic_timeline_entry"("runId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "forensic_timeline_entry_runId_entryKind_idx" ON "analysis"."forensic_timeline_entry"("runId", "entryKind");

-- CreateIndex
CREATE INDEX "forensic_timeline_entry_runId_subjectKey_idx" ON "analysis"."forensic_timeline_entry"("runId", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "forensic_timeline_entry_runId_derivationVersion_sourceKind__key" ON "analysis"."forensic_timeline_entry"("runId", "derivationVersion", "sourceKind", "sourceId", "entryKind");

-- CreateIndex
CREATE INDEX "forensic_derivation_runId_idx" ON "analysis"."forensic_derivation"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "forensic_derivation_runId_derivationVersion_inputFingerprin_key" ON "analysis"."forensic_derivation"("runId", "derivationVersion", "inputFingerprint");

-- CreateIndex
CREATE INDEX "reproduction_definition_snapshotId_idx" ON "analysis"."reproduction_definition"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "reproduction_definition_runId_key" ON "analysis"."reproduction_definition"("runId");




-- AddForeignKey
ALTER TABLE "analysis"."finding" ADD CONSTRAINT "finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."finding" ADD CONSTRAINT "finding_invariantEvaluationId_fkey" FOREIGN KEY ("invariantEvaluationId") REFERENCES "analysis"."invariant_evaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."finding_evidence_reference" ADD CONSTRAINT "finding_evidence_reference_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "analysis"."finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."forensic_timeline_entry" ADD CONSTRAINT "forensic_timeline_entry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."forensic_derivation" ADD CONSTRAINT "forensic_derivation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."reproduction_definition" ADD CONSTRAINT "reproduction_definition_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."reproduction_definition" ADD CONSTRAINT "reproduction_definition_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "control"."run_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
