-- ---------------------------------------------------------------------
-- Phase 16 — logical identity is SCOPE-bound (ADR-0018 Decision 7,
-- ADR-0023 §4, docs/checkout-zero.md §3).
--
-- The logical checkout intent — and therefore its one logical event —
-- belongs to exactly ONE verification scope. The same stable
-- checkoutIntentId may legitimately exist in two distinct scopes (each
-- scope's own reset clears only its own rows); the previous GLOBAL
-- uniqueness made a foreign scope's intent shadow a fresh scope's
-- submission, attributing new effects to the wrong scope/generation.
-- That is precisely the cross-scope attribution leak the scope binding
-- exists to prevent.
--
-- Checkout events: exactly one event per logical intent, enforced by a
-- unique (intentId) index; the deterministic checkoutEventId VALUE
-- carries the scope token, so two scopes never produce the same value.
-- ---------------------------------------------------------------------

DROP INDEX "checkout_intents_checkoutIntentId_key";
CREATE UNIQUE INDEX "checkout_intents_scopeId_checkoutIntentId_key" ON "checkout_intents"("scopeId", "checkoutIntentId");

DROP INDEX "checkout_events_checkoutEventId_key";
DROP INDEX "checkout_events_intentId_idx";
CREATE UNIQUE INDEX "checkout_events_intentId_key" ON "checkout_events"("intentId");
