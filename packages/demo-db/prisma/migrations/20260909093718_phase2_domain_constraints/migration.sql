-- =====================================================================
-- Demo Fintech — Phase 2 domain constraints (hand-authored extension)
-- =====================================================================
-- Prisma models cannot express CHECK constraints. This migration adds
-- the same-row business-integrity constraints:
--
-- 1. Wallet balances can never go negative (integer minor units only).
-- 2. Every accepted WALLET_CREDIT financial effect / ledger entry must
--    carry a positive amount — a non-positive "credit" is nonsense.
--
-- Cross-table currency agreement (effect/ledger currency = wallet
-- currency) cannot be expressed as a PostgreSQL CHECK (subqueries are
-- forbidden in CHECK constraints). In the Phase 2 design currency is
-- never accepted from webhook payloads: the transactional processing
-- path copies currency/amount exclusively from the stored authoritative
-- ProviderPayment, so agreement holds by construction and is verified
-- by integration tests.
--
-- NOTE: PostgreSQL CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction; plain ADD CONSTRAINT (transactional) is used instead.
-- On this small demo schema the brief exclusive locks are acceptable
-- and keep the migration atomic.

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_nonnegative_check"
  CHECK ("balanceMinor" >= 0);

ALTER TABLE "financial_effects"
  ADD CONSTRAINT "financial_effects_credit_amount_positive_check"
  CHECK ("effectType" <> 'WALLET_CREDIT' OR "amountMinor" > 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_credit_amount_positive_check"
  CHECK ("entryType" <> 'WALLET_CREDIT' OR "amountMinor" > 0);
