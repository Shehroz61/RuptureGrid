-- =====================================================================
-- Demo Fintech — Phase 9 target-owned controlled-fault plans
-- =====================================================================
-- docs/controlled-faults.md §2/§3, ADR-0014. The Demo Target owns its
-- fault machinery: this table stores the currently armed plan PER KIND
-- (faultKind unique — arming replaces), its remaining trigger budget,
-- and the arming TTL expiry. RuptureGrid has no credentials for this
-- database; the table is written only by the target's own admin/fault
-- service through its admin API.

CREATE TABLE "fault_plans" (
    "id" UUID NOT NULL,
    -- Closed v1 kind vocabulary is validated in application code BEFORE
    -- persistence; no DB enum so an older target cannot be handed a
    -- future kind it does not implement (400 FAULT_PLAN_UNSUPPORTED_VERSION).
    "faultKind" VARCHAR(40) NOT NULL,
    "planVersion" VARCHAR(32) NOT NULL,
    "activation" VARCHAR(40) NOT NULL,
    "maxTriggers" INTEGER NOT NULL,
    "triggersUsed" INTEGER NOT NULL DEFAULT 0,
    "armedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastTriggeredAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fault_plans_pkey" PRIMARY KEY ("id")
);

-- ONE armed plan per kind: re-arming replaces the row atomically.
CREATE UNIQUE INDEX "fault_plans_faultKind_key" ON "fault_plans"("faultKind");

-- Budget bounds: arming service validates too; the DB enforces it
-- regardless of the caller (deterministic budgeted activation).
ALTER TABLE "fault_plans"
  ADD CONSTRAINT "fault_plans_maxTriggers_bounds_check"
  CHECK ("maxTriggers" >= 1 AND "maxTriggers" <= 10);
ALTER TABLE "fault_plans"
  ADD CONSTRAINT "fault_plans_triggersUsed_bounds_check"
  CHECK ("triggersUsed" >= 0 AND "triggersUsed" <= "maxTriggers");
