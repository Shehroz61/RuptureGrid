// =====================================================================
// RuptureGrid v1.0 — Incident Zero package surface (Phase 7)
// =====================================================================
// The golden scenario as one library. No new business truth engine:
// everything below orchestrates accepted Phase 2/3/4/5 systems.

export {
  PAYMENT_AMOUNT_MINOR,
  PAYMENT_AMOUNT_CURRENCY,
  DELIVERIES_PER_EVENT,
  DELIVERY_CONCURRENCY,
  LOGICAL_EVENT_COUNT,
  TOTAL_DELIVERIES,
  VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS,
  SECURE_EXPECTED_EQUIVALENT_EFFECTS,
  VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR,
  SECURE_EXPECTED_WALLET_BALANCE_MINOR,
  SECURE_EXPECTED_SUPPRESSED_ATTEMPTS,
  INVARIANT_KEY,
  VULNERABLE_EXPERIMENT_NAME,
  SECURE_EXPERIMENT_NAME,
  GOLDEN_SCENARIO_VERSION,
  IDENTITY_NAMES,
  goldenScenarioSteps,
} from './contract.js';

export { ReadinessError } from './readiness.js';
export type { ReadinessReport } from './readiness.js';

export { GoldenRunError, ensureGoldenTargetRegistration, runGoldenScenario } from './run.js';
export type {
  GoldenRunOptions,
  GoldenRunResult,
  GoldenMode,
  GoldenTargetRegistration,
  GoldenPaymentIdentity,
  GoldenWalletState,
  GoldenEvaluation,
  GoldenFinding,
} from './run.js';
