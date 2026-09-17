// =====================================================================
// RuptureGrid v1.0 — forensics package public surface (Phase 5)
// =====================================================================
// Investigator-facing deterministic derivation over the accepted Phase
// 3/4 truth: Findings with provenance and confidence scope, forensic
// timeline with explicit ordering bases, reproduction definitions, and
// run comparison. All deterministic (ADR-0007): no AI anywhere.

export {
  FINDING_RULE_VERSION,
  TIMELINE_DERIVATION_VERSION,
  FORENSIC_PIPELINE_NAME,
  DUPLICATE_CREDIT_TITLE_TEMPLATE,
} from './versions.js';

export {
  deriveFindingFromEvaluation,
  FINDING_REASON_CODES,
  PROOF_ROLES,
  PROOF_SUBJECTS,
} from './finding.js';
export type {
  FindingEvaluationInput,
  FindingExecutionScope,
  FindingProofReference,
  FindingDerivation,
} from './finding.js';

export {
  deriveTimeline,
  findingTimelineEntry,
  compareTimelineEntries,
  timelineInputFingerprint,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_SOURCE_KINDS,
  TIMELINE_ORDERING_BASES,
} from './timeline.js';
export type {
  TimelineEntrySpec,
  TimelineDerivationInput,
  TimelineDerivationResult,
} from './timeline.js';

export { deriveRunForensics, loadFindingProof, ForensicDerivationError } from './derive.js';
export type { ForensicDerivationResult, DerivedFindingSummary } from './derive.js';

export { isUniqueConstraint } from './p2002.js';

export {
  deriveReproductionDefinition,
  extractTargetModeRequirement,
  persistReproductionDefinition,
  ReproductionDefinitionError,
} from './reproduction.js';
export type { DerivedReproductionDefinition, ReproductionDerivationInput } from './reproduction.js';

export { compareRuns, latestEvaluationPerInvariant, RunComparisonError } from './comparison.js';
export type { RunComparisonResult, RunVerdictSummary } from './comparison.js';
