-- =====================================================================
-- RuptureGrid Control — migration 0001 (infrastructure only)
-- =====================================================================
-- Establishes the RuptureGrid schema ownership boundaries (control /
-- evidence / analysis) per docs/architecture.md §4 and ADR-0002.
-- Deliberately creates NO domain tables: targets, experiments, runs,
-- evidence, findings arrive in Phases 3–5 (R-01 phase boundaries).

CREATE SCHEMA IF NOT EXISTS "control";
CREATE SCHEMA IF NOT EXISTS "evidence";
CREATE SCHEMA IF NOT EXISTS "analysis";
