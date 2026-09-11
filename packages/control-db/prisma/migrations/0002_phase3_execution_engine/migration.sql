-- =====================================================================
-- RuptureGrid Control — migration 0002 (Phase 3 execution engine)
-- =====================================================================
-- Adds the Phase 3 execution-engine domain models (architecture §6):
--   target_registration / target_origin   registered, authorized targets
--   experiment_definition / _revision     versioned experiment definitions
--   run_snapshot                          hash-pinned execution intent
--   experiment_run / experiment_step_run  durable state machines
--   step_invocation                       one physical attempt of one step
--   stale_writer_event                    rejected stale-writer writes
-- Ownership lease fields (leaseOwnerId / leaseExpiresAt / fencingToken)
-- live ON experiment_step_run per ADR-0009; dispatch markers per ADR-0003.
-- Generated with `prisma migrate diff --from-empty --to-schema --script`
-- from the reviewed schema.prisma (reviewable, reproducible — R-12).
-- No Demo-schema changes. evidence/analysis schemas remain empty.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "control";

-- CreateEnum
CREATE TYPE "control"."TargetEnvironment" AS ENUM ('LOCAL_DEVELOPMENT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "control"."RunState" AS ENUM ('CREATED', 'SNAPSHOT_PINNED', 'DISPATCHING', 'RUNNING', 'RECONCILING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "control"."StepState" AS ENUM ('PENDING', 'DISPATCHED', 'CLAIMED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "control"."IntentOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "control"."SideEffectKnowledge" AS ENUM ('KNOWN_OCCURRED', 'KNOWN_ABSENT', 'INDETERMINATE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "control"."DispatchState" AS ENUM ('PENDING', 'DISPATCHED', 'RECONCILE');

-- CreateEnum
CREATE TYPE "control"."DeclaredRetryPolicy" AS ENUM ('NONE', 'SAFE');

-- CreateEnum
CREATE TYPE "control"."MutationClassification" AS ENUM ('READ_ONLY', 'MUTATING');

-- CreateEnum
CREATE TYPE "control"."ContractKind" AS ENUM ('DEMO_FINTECH_WEBHOOK', 'GENERIC_HTTP');

-- CreateEnum
CREATE TYPE "control"."TransportStage" AS ENUM ('PREPARED', 'CONNECTING', 'REQUEST_SENT', 'RESPONSE_HEADERS', 'RESPONSE_COMPLETE');

-- CreateTable
CREATE TABLE "control"."target_registration" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "environment" "control"."TargetEnvironment" NOT NULL,
    "credentialRefs" TEXT[],
    "contractKind" "control"."ContractKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "target_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."target_origin" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "origin" VARCHAR(255) NOT NULL,

    CONSTRAINT "target_origin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."experiment_definition" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."experiment_revision" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "targetId" UUID NOT NULL,
    "stepsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."run_snapshot" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "canonicalization" VARCHAR(32) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."experiment_run" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "state" "control"."RunState" NOT NULL,
    "failureReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminalAt" TIMESTAMPTZ(6),
    "cancelRequestedAt" TIMESTAMPTZ(6),

    CONSTRAINT "experiment_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."experiment_step_run" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "state" "control"."StepState" NOT NULL DEFAULT 'PENDING',
    "leaseOwnerId" VARCHAR(120),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "dispatchState" "control"."DispatchState" NOT NULL DEFAULT 'PENDING',
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastDispatchError" VARCHAR(500),
    "dispatchedAt" TIMESTAMPTZ(6),
    "intentOutcome" "control"."IntentOutcome",
    "sideEffectKnowledge" "control"."SideEffectKnowledge",
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "executingAt" TIMESTAMPTZ(6),
    "terminalAt" TIMESTAMPTZ(6),

    CONSTRAINT "experiment_step_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."step_invocation" (
    "id" UUID NOT NULL,
    "stepRunId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "invocationIdentity" VARCHAR(120),
    "transportStage" "control"."TransportStage",
    "httpStatus" INTEGER,
    "requestBytes" INTEGER,
    "responseBytes" INTEGER,
    "responseBody" TEXT,
    "waveIndex" INTEGER,
    "durationMs" INTEGER,
    "outcome" "control"."IntentOutcome",
    "sideEffectKnowledge" "control"."SideEffectKnowledge",
    "error" VARCHAR(500),
    "writtenByOwner" VARCHAR(120),
    "writtenByFencingToken" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "step_invocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control"."stale_writer_event" (
    "id" UUID NOT NULL,
    "stepRunId" UUID NOT NULL,
    "attemptedBy" VARCHAR(120) NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "detail" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stale_writer_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "target_registration_displayName_key" ON "control"."target_registration"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "target_origin_origin_key" ON "control"."target_origin"("origin");

-- CreateIndex
CREATE INDEX "target_origin_targetId_idx" ON "control"."target_origin"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_definition_name_key" ON "control"."experiment_definition"("name");

-- CreateIndex
CREATE INDEX "experiment_revision_targetId_idx" ON "control"."experiment_revision"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_revision_definitionId_revisionNumber_key" ON "control"."experiment_revision"("definitionId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "run_snapshot_contentHash_key" ON "control"."run_snapshot"("contentHash");

-- CreateIndex
CREATE INDEX "run_snapshot_revisionId_idx" ON "control"."run_snapshot"("revisionId");

-- CreateIndex
CREATE INDEX "experiment_run_state_idx" ON "control"."experiment_run"("state");

-- CreateIndex
CREATE INDEX "experiment_run_createdAt_idx" ON "control"."experiment_run"("createdAt");

-- CreateIndex
CREATE INDEX "experiment_step_run_runId_idx" ON "control"."experiment_step_run"("runId");

-- CreateIndex
CREATE INDEX "experiment_step_run_dispatchState_state_idx" ON "control"."experiment_step_run"("dispatchState", "state");

-- CreateIndex
CREATE INDEX "experiment_step_run_state_leaseExpiresAt_idx" ON "control"."experiment_step_run"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_step_run_runId_sequence_key" ON "control"."experiment_step_run"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "step_invocation_stepRunId_sequence_key" ON "control"."step_invocation"("stepRunId", "sequence");

-- CreateIndex
CREATE INDEX "stale_writer_event_stepRunId_idx" ON "control"."stale_writer_event"("stepRunId");

-- AddForeignKey
ALTER TABLE "control"."target_origin" ADD CONSTRAINT "target_origin_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "control"."target_registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."experiment_revision" ADD CONSTRAINT "experiment_revision_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "control"."experiment_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."experiment_revision" ADD CONSTRAINT "experiment_revision_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "control"."target_registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."run_snapshot" ADD CONSTRAINT "run_snapshot_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "control"."experiment_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."experiment_run" ADD CONSTRAINT "experiment_run_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "control"."run_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."experiment_step_run" ADD CONSTRAINT "experiment_step_run_runId_fkey" FOREIGN KEY ("runId") REFERENCES "control"."experiment_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."step_invocation" ADD CONSTRAINT "step_invocation_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "control"."experiment_step_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control"."stale_writer_event" ADD CONSTRAINT "stale_writer_event_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "control"."experiment_step_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;