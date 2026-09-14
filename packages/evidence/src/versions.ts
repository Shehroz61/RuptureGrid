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
export const DEMO_LINEAGE_NORMALIZER_VERSION = 'v1';

/** Normalizer identity for executor invocation observations. */
export const INVOCATION_NORMALIZER_NAME = 'executor-invocation-normalizer';
export const INVOCATION_NORMALIZER_VERSION = 'v1';

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
