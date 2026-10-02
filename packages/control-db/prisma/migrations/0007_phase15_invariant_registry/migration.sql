-- =====================================================================
-- RuptureGrid Control — migration 0007 (Phase 15 invariant registry)
-- =====================================================================
-- business-invariant/v1 (ADR-0018, ADR-0023): the closed generic
-- invariant registry and its finding-rule vocabulary. ADDITIVE ONLY:
--
--   1. "analysis"."FindingReasonCode" gains EXACTLY the four Phase 15
--      reason codes (ADR-0023 §10). The existing
--      DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT value is untouched; no
--      value is renamed, removed, or reinterpreted. Per-case
--      conservation codes are kept because they name the proven
--      failure mechanism (forensic clarity) while staying bounded.
--
--   2. "analysis"."invariant_definition" gains three NULLABLE generic
--      metadata columns — kind / registryVersion / paramsJson (the
--      ALL-OR-NONE generic-metadata triple of ADR-0023 §6/§11):
--        - LEGACY rows (INV-IZ-1, INV-DF-1/2) keep all three NULL and
--          their semantics untouched; NULL means "legacy hard-coded
--          definition", never "metadata was dropped".
--        - GENERIC rows (business-invariant/v1 instances) carry all
--          three non-null: invariantKey remains the instance key,
--          paramsJson carries the frozen §6 instance params. The
--          ALL-OR-NONE rule (a partial hybrid is invalid) is enforced
--          in application validation — the columns themselves are
--          independently nullable so legacy rows stay legal.
--      No evaluation-table change: InvariantEvaluation keeps its
--      existing columns; registryVersion is copied into the evaluation
--      `details` at evaluation time (ADR-0023 §11).
--
-- Enum extension follows the accepted migration-0005 convention
-- (ALTER TYPE ... ADD VALUE): no existing value is renamed, removed,
-- or reinterpreted.

ALTER TYPE "analysis"."FindingReasonCode" ADD VALUE 'TOO_MANY_ACCEPTED_EFFECTS';
ALTER TYPE "analysis"."FindingReasonCode" ADD VALUE 'RESOURCE_CONSERVATION_EXCEEDED_BASELINE';
ALTER TYPE "analysis"."FindingReasonCode" ADD VALUE 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING';
ALTER TYPE "analysis"."FindingReasonCode" ADD VALUE 'RESOURCE_CONSERVATION_MISMATCH';

ALTER TABLE "analysis"."invariant_definition"
  ADD COLUMN "kind" VARCHAR(40);
ALTER TABLE "analysis"."invariant_definition"
  ADD COLUMN "registryVersion" VARCHAR(24);
ALTER TABLE "analysis"."invariant_definition"
  ADD COLUMN "paramsJson" JSONB;
