-- =====================================================================
-- RuptureGrid Control — migration 0006 (Phase 13 target manifest)
-- =====================================================================
-- ADR-0016: target-manifest/v1 is stored as REGISTRATION PROVENANCE on
-- the target it describes. The manifest is data-only, closed-schema,
-- and validated server-side BEFORE any row is written; this migration
-- only adds the durable place it lives.
--
-- ADDITIVE, nullable column:
--   - legacy (pre-manifest) targets keep NULL — the v1.0 Demo Fintech
--     registration path is byte-identical in behavior and in storage;
--   - manifest registrations store the EXACT validated manifest
--     document (provenance, auditable from evidence; ADR-0016 §2).
--
-- No value is renamed, removed, or reinterpreted; no credential value
-- can ever enter this column (manifests carry reference NAMES only —
-- ADR-0012; the validator rejects value-shaped strings structurally).
-- NULL means "registered without a manifest" (the v1.0 path), never
-- "manifest was dropped".

ALTER TABLE "control"."target_registration"
  ADD COLUMN "manifestJson" JSONB;
