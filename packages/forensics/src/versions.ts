// =====================================================================
// RuptureGrid v1.0 — forensics version identifiers (Phase 5)
// =====================================================================
// Every deterministic engine and schema carries a stable version
// identifier (evidence-model §2: derived artifacts record which version
// produced them). Changing semantics = NEW version that coexists with
// old rows — never a silent reinterpretation of persisted meaning.

/** Version of the deterministic finding rule implemented in finding.ts. */
export const FINDING_RULE_VERSION = 'v1';

/**
 * Version of the deterministic timeline derivation implemented in
 * timeline.ts. v2 (Phase 9): the target-owned fault-plan vocabulary
 * entered as two separate kinds — FAULT_PLAN_CONFIGURED (plan armed)
 * and FAULT_PLAN_ACTIVATED (triggersUsed ≥ 1 observed). v1 rows were
 * never persisted against the collapsed v1 name in any accepted phase,
 * so the bump only names the new vocabulary; existing Phase 5 entry
 * semantics are unchanged.
 */
export const TIMELINE_DERIVATION_VERSION = 'v2';

/** Identity of the forensic derivation pipeline (pipeline.ts). */
export const FORENSIC_PIPELINE_NAME = 'phase5-forensics-pipeline';

/** Title template input for the canonical duplicate-credit Finding. */
export const DUPLICATE_CREDIT_TITLE_TEMPLATE =
  'Duplicate wallet credit for confirmed provider payment' as const;
