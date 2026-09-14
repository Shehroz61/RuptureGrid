// =====================================================================
// RuptureGrid v1.0 — evidence package public surface (Phase 4)
// =====================================================================

export {
  REDACTION_POLICY_VERSION,
  EVIDENCE_HASH_ALGORITHM,
  REDACTED_MARKER,
  isRedactedHeader,
  redactHeaders,
  redactJson,
  redactBoundedText,
  canonicalEvidenceHash,
} from './redact.js';

export {
  OBSERVATION_SCHEMA_VERSION,
  DEMO_LINEAGE_NORMALIZER_NAME,
  DEMO_LINEAGE_NORMALIZER_VERSION,
  INVOCATION_NORMALIZER_NAME,
  INVOCATION_NORMALIZER_VERSION,
  INV_IZ_1_KEY,
  INV_IZ_1_EVALUATOR_VERSION,
  INV_IZ_1_TITLE,
  INV_IZ_1_DESCRIPTION,
} from './versions.js';

export {
  RawObservationStore,
  EvidenceCaptureError,
  EvidenceIntegrityConflictError,
  createEngineEvidenceSink,
  OBSERVATION_PAYLOAD_MAX_CHARS,
} from './raw-observation-store.js';
export type { CaptureInput, ChainAppendedObservation } from './raw-observation-store.js';

export {
  DEMO_LINEAGE_ADAPTER_KIND,
  DemoAdapterError,
  captureDemoPaymentLineage,
  validateLineage,
} from './demo-adapter.js';
export type { DemoAdapterConfig, DemoLineagePayload, CapturedLineage } from './demo-adapter.js';

export {
  normalizeInvocationObservation,
  normalizeDemoLineageObservation,
  eventInputHash,
} from './normalize.js';
export type { NormalizedEventSpec } from './normalize.js';

export {
  deriveRunEvidence,
  loadNormalizerInputs,
  computeEvidenceSetFingerprint,
} from './derive.js';
export type { DerivationResult, DerivedEventRow, DerivedRelationshipRow } from './derive.js';

export { evaluateInvIz1, COMPLETENESS_BASES, INV_IZ_1 } from './invariants.js';
export type {
  InvariantEvidenceGraph,
  InvariantVerdictValue,
  EvaluationSubjectResult,
  EvaluatorVersion,
} from './invariants.js';

export { runRunAnalysis, ensureInvariantDefinitions, AnalysisError } from './analysis.js';
export type { AnalysisRunResult, PersistedEvaluation } from './analysis.js';

export { verifyRunEvidenceChain } from './integrity.js';
export type { IntegrityReport, ChainProblem } from './integrity.js';
