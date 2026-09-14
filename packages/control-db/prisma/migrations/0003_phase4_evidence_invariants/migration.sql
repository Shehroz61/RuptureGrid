-- =====================================================================
-- RuptureGrid Control — migration 0003 (Phase 4 evidence + invariants)
-- =====================================================================
-- Adds the Phase 4 evidence-truth models (docs/evidence-model.md,
-- ADR-0006) in their accepted bounded contexts:
--
--   evidence schema:  raw_observation, normalized_event,
--                     causal_relationship, evidence_integrity_head
--   analysis schema:  invariant_definition, evaluation_batch,
--                     invariant_evaluation
--
-- Evidence truth is LOGICALLY APPEND-ONLY (evidence-model §4, stated
-- honestly): no application update/delete path exists for observation,
-- event, or relationship rows; corrections append new rows with their
-- own provenance. Database-level UPDATE/DELETE protection for the
-- append-only truth tables is added at the end of this migration —
-- pragmatic for the demo lifecycle (cleanup drops whole tables),
-- never a claim of tamper-proofing (a DB administrator can still
-- re-alter tables; the protection is a guard against the application
-- accidentally mutating truth, not a forensic guarantee).
--
-- The evaluation/derived tables are NOT write-protected: analysis is
-- idempotent-by-input-hash (re-running analysis with new evidence
-- appends evaluation rows; batches carry counters), so repeat passes
-- legitimately create new derived rows under their own provenance.
-- Deliberately ABSENT (R-01 phase boundaries): Finding, finding
-- severity, forensic timeline, reproduction definitions, AI tables.
-- No Demo-schema changes (ADR-0002).

-- CreateEnum
CREATE TYPE "evidence"."ObservationKind" AS ENUM ('http_request_observed', 'http_response_observed', 'delivery_emitted', 'executor_error', 'target_observation');

-- CreateEnum
CREATE TYPE "evidence"."EvidenceOrigin" AS ENUM ('OBSERVED', 'DETERMINISTIC_DERIVED', 'AI_INTERPRETED');

-- CreateEnum
CREATE TYPE "analysis"."InvariantVerdict" AS ENUM ('PASS', 'FAIL', 'NOT_EVALUABLE');

-- CreateTable
CREATE TABLE "evidence"."raw_observation" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepRunId" UUID,
    "invocationId" UUID,
    "invocationIdentity" VARCHAR(120),
    "kind" "evidence"."ObservationKind" NOT NULL,
    "adapterKind" VARCHAR(64),
    "schemaVersion" VARCHAR(32) NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,
    "redactionApplied" BOOLEAN NOT NULL,
    "redactionPolicyVersion" VARCHAR(32) NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" VARCHAR(64) NOT NULL,
    "chainIndex" INTEGER NOT NULL,
    "prevContentHash" VARCHAR(64),
    "origin" "evidence"."EvidenceOrigin" NOT NULL,
    "writerOwnerId" VARCHAR(120) NOT NULL,
    "writerFencingToken" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."normalized_event" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "subjectKey" VARCHAR(200),
    "payload" JSONB NOT NULL,
    "normalizerName" VARCHAR(80) NOT NULL,
    "normalizerVersion" VARCHAR(32) NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "origin" "evidence"."EvidenceOrigin" NOT NULL DEFAULT 'DETERMINISTIC_DERIVED',
    "sourceObservationHashes" TEXT[],
    "primaryObservationIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normalized_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."causal_relationship" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "fromEventId" UUID NOT NULL,
    "toEventId" UUID NOT NULL,
    "relationKind" VARCHAR(64) NOT NULL,
    "basis" VARCHAR(24) NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "causal_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."evidence_integrity_head" (
    "runId" UUID NOT NULL,
    "lastChainIndex" INTEGER NOT NULL,
    "headContentHash" VARCHAR(64) NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMPTZ(6),
    "lastVerifiedHeadHash" VARCHAR(64),
    "lastVerifiedObservationCount" INTEGER,

    CONSTRAINT "evidence_integrity_head_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "analysis"."invariant_definition" (
    "id" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invariant_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."evaluation_batch" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "evaluatorVersion" VARCHAR(32) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "evaluationCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "evaluation_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis"."invariant_evaluation" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "invariantKey" VARCHAR(80) NOT NULL,
    "evaluatorVersion" VARCHAR(32) NOT NULL,
    "subjectKey" VARCHAR(200) NOT NULL,
    "verdict" "analysis"."InvariantVerdict" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "evidenceSetHash" VARCHAR(64) NOT NULL,
    "completenessBasis" VARCHAR(64) NOT NULL,
    "details" JSONB NOT NULL,
    "sourceObservationHashes" TEXT[],
    "normalizedEventIds" TEXT[],
    "causalRelationshipIds" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invariant_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Observation IDENTITY is the provenance tuple (runId, kind,
-- invocationIdentity): an exact re-persistence of the SAME physical
-- invocation's observation converges on ONE row (idempotent retry),
-- while a DIFFERENT invocation — or a different run reusing an identity
-- string — is a DIFFERENT observation with its own row. contentHash is
-- an integrity/traceability field, NOT a global identity: two runs
-- observing byte-identical content MUST NOT alias each other's
-- evidence (same hash ≠ same observation).
CREATE UNIQUE INDEX "raw_observation_runId_kind_invocationIdentity_key" ON "evidence"."raw_observation"("runId", "kind", "invocationIdentity");

-- CreateIndex
CREATE INDEX "raw_observation_contentHash_idx" ON "evidence"."raw_observation"("contentHash");

-- CreateIndex
CREATE INDEX "raw_observation_runId_kind_idx" ON "evidence"."raw_observation"("runId", "kind");

-- CreateIndex
CREATE INDEX "raw_observation_stepRunId_idx" ON "evidence"."raw_observation"("stepRunId");

-- CreateIndex
CREATE INDEX "raw_observation_runId_chainIndex_idx" ON "evidence"."raw_observation"("runId", "chainIndex");

-- CreateIndex
CREATE INDEX "normalized_event_runId_eventType_idx" ON "evidence"."normalized_event"("runId", "eventType");

-- CreateIndex
CREATE INDEX "normalized_event_runId_subjectKey_idx" ON "evidence"."normalized_event"("runId", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_event_runId_normalizerName_normalizerVersion_inp_key" ON "evidence"."normalized_event"("runId", "normalizerName", "normalizerVersion", "inputHash");

-- CreateIndex
CREATE INDEX "causal_relationship_runId_idx" ON "evidence"."causal_relationship"("runId");

-- CreateIndex
CREATE INDEX "causal_relationship_fromEventId_idx" ON "evidence"."causal_relationship"("fromEventId");

-- CreateIndex
CREATE INDEX "causal_relationship_toEventId_idx" ON "evidence"."causal_relationship"("toEventId");

-- CreateIndex
CREATE UNIQUE INDEX "causal_relationship_runId_fromEventId_toEventId_relationKin_key" ON "evidence"."causal_relationship"("runId", "fromEventId", "toEventId", "relationKind", "basis");

-- CreateIndex
CREATE UNIQUE INDEX "invariant_definition_invariantKey_key" ON "analysis"."invariant_definition"("invariantKey");

-- CreateIndex
CREATE INDEX "evaluation_batch_runId_idx" ON "analysis"."evaluation_batch"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_batch_runId_invariantKey_evaluatorVersion_key" ON "analysis"."evaluation_batch"("runId", "invariantKey", "evaluatorVersion");

-- CreateIndex
CREATE INDEX "invariant_evaluation_runId_idx" ON "analysis"."invariant_evaluation"("runId");

-- CreateIndex
CREATE INDEX "invariant_evaluation_batchId_idx" ON "analysis"."invariant_evaluation"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "invariant_evaluation_runId_invariantKey_evaluatorVersion_su_key" ON "analysis"."invariant_evaluation"("runId", "invariantKey", "evaluatorVersion", "subjectKey", "evidenceSetHash");

-- AddForeignKey
ALTER TABLE "evidence"."raw_observation" ADD CONSTRAINT "raw_observation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."raw_observation" ADD CONSTRAINT "raw_observation_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "control"."experiment_step_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."normalized_event" ADD CONSTRAINT "normalized_event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."causal_relationship" ADD CONSTRAINT "causal_relationship_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."causal_relationship" ADD CONSTRAINT "causal_relationship_fromEventId_fkey" FOREIGN KEY ("fromEventId") REFERENCES "evidence"."normalized_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."causal_relationship" ADD CONSTRAINT "causal_relationship_toEventId_fkey" FOREIGN KEY ("toEventId") REFERENCES "evidence"."normalized_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."evidence_integrity_head" ADD CONSTRAINT "evidence_integrity_head_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."evaluation_batch" ADD CONSTRAINT "evaluation_batch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."invariant_evaluation" ADD CONSTRAINT "invariant_evaluation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "analysis"."evaluation_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."invariant_evaluation" ADD CONSTRAINT "invariant_evaluation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis"."invariant_evaluation" ADD CONSTRAINT "invariant_evaluation_invariantKey_fkey" FOREIGN KEY ("invariantKey") REFERENCES "analysis"."invariant_definition"("invariantKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Append-only protection for evidence-truth tables (evidence-model §4,
-- honest semantics — see header). Time-stamped derivation columns are
-- deliberately NOT protected; observation truth columns are.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "evidence"."forbid_observation_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'evidence.% is append-only: updates/deletes of observation truth are forbidden (docs/evidence-model.md §4)',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER raw_observation_append_only
  BEFORE UPDATE OF "runId", "stepRunId", "invocationId", "invocationIdentity", "kind",
    "adapterKind", "schemaVersion", "observedAt", "payload", "redactionApplied",
    "redactionPolicyVersion", "truncated", "contentHash", "chainIndex", "prevContentHash",
    "origin", "writerOwnerId", "writerFencingToken"
  ON "evidence"."raw_observation"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();

CREATE TRIGGER raw_observation_no_delete
  BEFORE DELETE ON "evidence"."raw_observation"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();

CREATE TRIGGER normalized_event_append_only
  BEFORE UPDATE OF "runId", "eventType", "subjectKey", "payload", "normalizerName",
    "normalizerVersion", "inputHash", "origin", "sourceObservationHashes",
    "primaryObservationIndex"
  ON "evidence"."normalized_event"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();

CREATE TRIGGER raw_observation_no_delete_ne
  BEFORE DELETE ON "evidence"."normalized_event"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();

CREATE TRIGGER causal_relationship_append_only
  BEFORE UPDATE OF "runId", "fromEventId", "toEventId", "relationKind", "basis", "evidenceJson"
  ON "evidence"."causal_relationship"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();

CREATE TRIGGER causal_relationship_no_delete
  BEFORE DELETE ON "evidence"."causal_relationship"
  FOR EACH ROW EXECUTE FUNCTION "evidence"."forbid_observation_mutation"();