// =====================================================================
// RuptureGrid v1.0 — evidence/analysis version identifiers (Phase 4)
// =====================================================================
// Every deterministic engine and schema carries a stable version
// identifier (evidence-model §1 NORMALIZED EVENT, §7; prompt §27).
// Changing semantics = NEW version that coexists with old rows — never
// a silent reinterpretation of persisted meaning.

/** Raw-observation payload schema version. */
export const OBSERVATION_SCHEMA_VERSION = 'obs-v1';

/** Normalizer identity for Demo Fintech inspection lineage payloads. */
export const DEMO_LINEAGE_NORMALIZER_NAME = 'demo-fintech-inspection-normalizer';
/**
 * v2 (Phase 9): the lineage payload gained the target's own whole-wallet
 * reconciliation fields (walletLedgerCreditSumMinor /
 * walletBalanceDifferenceMinor), which the normalizer now carries into
 * wallet-state events. Same stored observation + v2 ⇒ same events; v1
 * rows (without these fields) remain valid history and are never
 * reinterpreted (evidence-model §2).
 */
export const DEMO_LINEAGE_NORMALIZER_VERSION = 'v2';

/** Normalizer identity for executor invocation observations. */
export const INVOCATION_NORMALIZER_NAME = 'executor-invocation-normalizer';
export const INVOCATION_NORMALIZER_VERSION = 'v1';

// =====================================================================
// Phase 14 — generic manifest inspection (ADR-0017, ADR-0021, ADR-0022)
// =====================================================================

/** The explicit Phase 14 generic manifest-inspection adapter kind. */
export const GENERIC_INSPECTION_ADAPTER_KIND = 'generic-inspection/v1';

/** Normalizer identity for generic manifest-inspection captures. */
export const GENERIC_INSPECTION_NORMALIZER_NAME = 'generic-inspection-normalizer';
export const GENERIC_INSPECTION_NORMALIZER_VERSION = 'v1';

/**
 * The platform-owned relation kind for transitive identity-chain
 * attribution (multi-hop reachability through identity-direct edges).
 * NEVER a target-declared edgeKind — target edge kinds name direct
 * edges only (ADR-0017: platform vocabularies stay platform-owned).
 */
export const GENERIC_IDENTITY_CHAIN_RELATION_KIND = 'identity-chain-reachability';

/**
 * Version of the RuptureGrid-owned attribution-gap diagnostic event
 * (deterministic, bounded provenance for contested/ambiguous identity
 * or missing/redacted linkage). NOT a target event, NOT a finding, and
 * never a Phase 15 verdict — Phase 15 reads it as honest gap evidence.
 */
export const GENERIC_DERIVATION_DIAGNOSTIC_EVENT_TYPE = 'rupturegrid.derivation-gap-observed';
export const GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_NAME = 'generic-derivation-diagnostic';
export const GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_VERSION = 'v1';

/**
 * B-2: durable INVALIDATION-provenance event identity (a tombstone in
 * evidence — never a deletion). When a late identity conflict appears,
 * the deterministic, versioned tombstone names the contested events
 * AND the persisted relationship ids excluded from the ACTIVE causal
 * graph. Prior relationship rows are physically preserved (logically
 * append-only); the tombstone is what makes the exclusion auditable.
 */
export const GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE =
  'rupturegrid.derivation-invalidation-observed';
export const GENERIC_DERIVATION_INVALIDATION_NORMALIZER_NAME = 'generic-derivation-invalidation';
export const GENERIC_DERIVATION_INVALIDATION_NORMALIZER_VERSION = 'v1';

/** INV-IZ-1 evaluator identity (incident-zero §5). */
export const INV_IZ_1_KEY = 'INV-IZ-1';
export const INV_IZ_1_EVALUATOR_VERSION = 'v1';
export const INV_IZ_1_TITLE =
  'One confirmed logical payment produces at most one equivalent accepted wallet credit';
export const INV_IZ_1_DESCRIPTION =
  'For every confirmed logical provider payment P, the number of accepted equivalent ' +
  'wallet-credit financial effects causally attributable to P (basis >= identity-chain) ' +
  'must be less than or equal to one. Insufficient evidence yields NOT_EVALUABLE, never a ' +
  'silent pass. Two distinct legitimate payments are evaluated independently and each can PASS.';

// =====================================================================
// Phase 9 additions (docs/controlled-faults.md §6)
// =====================================================================

/** Normalizer identity for Demo fault-status inspection payloads. */
export const DEMO_FAULT_STATUS_NORMALIZER_NAME = 'demo-fintech-fault-status-normalizer';
export const DEMO_FAULT_STATUS_NORMALIZER_VERSION = 'v1';

/** The derived event type emitted from fault-status observations. */
export const DEMO_FAULT_PLAN_STATE_EVENT_TYPE = 'demo.fault-plan-state-observed';

/** INV-DF-1 evaluator identity (docs/controlled-faults.md §6). */
export const INV_DF_1_KEY = 'INV-DF-1';
export const INV_DF_1_EVALUATOR_VERSION = 'v1';
export const INV_DF_1_TITLE =
  'Observed wallet balance equals the sum of its accepted credit ledger entries';
export const INV_DF_1_DESCRIPTION =
  'For the wallet of an observed payment lineage, the integer sum of accepted WALLET_CREDIT ' +
  'ledger entries must exactly equal the observed wallet balance (integer minor units, R-06). ' +
  'Incomplete lineage yields NOT_EVALUABLE, never a silent pass.';

/** INV-DF-2 evaluator identity (docs/controlled-faults.md §6). */
export const INV_DF_2_KEY = 'INV-DF-2';
export const INV_DF_2_EVALUATOR_VERSION = 'v1';
export const INV_DF_2_TITLE = 'Every observed wallet balance is non-negative';
export const INV_DF_2_DESCRIPTION =
  'Every wallet balance observed in the run evidence must be greater than or equal to zero ' +
  '(integer minor units, R-06). A negative observed balance is a business-correctness failure; ' +
  'absence of any observed balance yields NOT_EVALUABLE.';
