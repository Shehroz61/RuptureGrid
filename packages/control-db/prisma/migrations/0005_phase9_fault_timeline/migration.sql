-- =====================================================================
-- RuptureGrid Control — migration 0005 (Phase 9 controlled faults)
-- =====================================================================
-- Extends the Phase 5 forensic timeline vocabulary with two entry kinds
-- for target-owned controlled-fault state (docs/controlled-faults.md
-- §6, ADR-0014):
--
--   FAULT_PLAN_CONFIGURED — one persisted NormalizedEvent of type
--   demo.fault-plan-state-observed, sourced from the Demo Target's own
--   read-only fault-status inspection: the plan of this kind is
--   currently armed (target-authored configuration truth).
--
--   FAULT_PLAN_ACTIVATED — the SAME observation class, but derived
--   ONLY when the observed trigger accounting shows triggersUsed ≥ 1
--   (budget consumption is the persisted basis for "activated";
--   never inferred from error shapes). Configured and activated are
--   separate facts and remain separate timeline entries; neither
--   asserts that a fault "caused" anything — causal claims remain
--   confined to causal_relationship rows (evidence-model §6).
--
-- This is an ADDITIVE enum extension (PostgreSQL ALTER TYPE ... ADD
-- VALUE): no existing value is renamed, removed, or reinterpreted —
-- Phase 5 timeline derivation is preserved bit-for-bit. Prisma
-- migrates enums by comparing the model enum against the migration
-- history, so the schema.prisma enum gains the same values in the same
-- change (R-12: migrations are the schema history; the Prisma schema
-- mirrors them).
--
-- Idempotency note: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block in older PostgreSQL versions; in PostgreSQL 12+
-- it can, but re-running a migration is not a supported workflow
-- (migrations are tracked and applied once). The statements are plain
-- and match the accepted Phase 5 migration conventions.

ALTER TYPE "analysis"."TimelineEntryKind" ADD VALUE 'FAULT_PLAN_CONFIGURED';
ALTER TYPE "analysis"."TimelineEntryKind" ADD VALUE 'FAULT_PLAN_ACTIVATED';

-- Phase 9 reproduction (docs/controlled-faults.md §17): the frozen
-- fault INTENT of the run's snapshot steps — typed plan fields only
-- (version / kind / activation / budget / wave stagger), credential
-- REFERENCE names only, never values (ADR-0012). Additive nullable
-- column: runs without fault intent carry NULL.
ALTER TABLE "analysis"."reproduction_definition"
  ADD COLUMN "faultIntent" JSONB;
