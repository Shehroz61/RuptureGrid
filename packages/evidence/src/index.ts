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
  GENERIC_INSPECTION_ADAPTER_KIND,
  GENERIC_INSPECTION_NORMALIZER_NAME,
  GENERIC_INSPECTION_NORMALIZER_VERSION,
  GENERIC_IDENTITY_CHAIN_RELATION_KIND,
  GENERIC_DERIVATION_DIAGNOSTIC_EVENT_TYPE,
  GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_NAME,
  GENERIC_DERIVATION_DIAGNOSTIC_NORMALIZER_VERSION,
  GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
  GENERIC_DERIVATION_INVALIDATION_NORMALIZER_NAME,
  GENERIC_DERIVATION_INVALIDATION_NORMALIZER_VERSION,
  INV_IZ_1_KEY,
  INV_IZ_1_EVALUATOR_VERSION,
  INV_IZ_1_TITLE,
  INV_IZ_1_DESCRIPTION,
  DEMO_FAULT_STATUS_NORMALIZER_NAME,
  DEMO_FAULT_STATUS_NORMALIZER_VERSION,
  DEMO_FAULT_PLAN_STATE_EVENT_TYPE,
  INV_DF_1_KEY,
  INV_DF_1_EVALUATOR_VERSION,
  INV_DF_1_TITLE,
  INV_DF_1_DESCRIPTION,
  INV_DF_2_KEY,
  INV_DF_2_EVALUATOR_VERSION,
  INV_DF_2_TITLE,
  INV_DF_2_DESCRIPTION,
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
  DEMO_FAULT_STATUS_ADAPTER_KIND,
  captureDemoFaultStatus,
  validateFaultStatus,
} from './demo-adapter.js';

export {
  EVIDENCE_ADAPTER_KINDS,
  isKnownEvidenceAdapterKind,
  GENERIC_INSPECTION_ENVELOPE_VERSION,
  GENERIC_INSPECTION_TIMEOUT_MS,
  GENERIC_INSPECTION_MAX_RESPONSE_BYTES,
  GENERIC_INSPECTION_MAX_RESPONSE_CHARS,
  GENERIC_INSPECTION_OPAQUE_BODY_PLACEHOLDER,
  GenericInspectionAdapterError,
  genericInspectionProvenanceIdentity,
  validateGenericInspectionCapture,
  captureGenericInspectionQuery,
  captureGenericInspectionSet,
} from './generic-inspection.js';
export type {
  GenericInspectionValidation,
  GenericInspectionObservationEnvelope,
  GenericOpaqueBodyMetadata,
  CaptureGenericInspectionQueryInput,
  CapturedGenericInspection,
} from './generic-inspection.js';

export {
  genericSubjectKey,
  normalizeGenericInspectionObservation,
  canonicalEventSpecsJson,
} from './generic-normalizer.js';

export { GENERIC_DERIVATION_CAPS, computeGenericDerivation } from './generic-derive.js';
export type {
  GenericEventRow,
  GenericRelationshipSpec,
  GenericDerivationGapKind,
  GenericDerivationDiagnosticSpec,
  GenericDerivationComputation,
  GenericInvalidationSpec,
} from './generic-derive.js';
export type {
  DemoAdapterConfig,
  DemoLineagePayload,
  CapturedLineage,
  DemoFaultPlanState,
  DemoFaultStatusPayload,
  CapturedFaultStatus,
} from './demo-adapter.js';

export {
  normalizeInvocationObservation,
  normalizeDemoLineageObservation,
  normalizeDemoFaultStatusObservation,
  eventInputHash,
} from './normalize.js';
export type { NormalizedEventSpec } from './normalize.js';

export {
  deriveRunEvidence,
  loadNormalizerInputs,
  loadFrozenEvidencePolicy,
  computeEvidenceSetFingerprint,
} from './derive.js';
export type { DerivationResult, DerivedEventRow, DerivedRelationshipRow } from './derive.js';

export {
  evaluateInvIz1,
  evaluateInvDf1,
  evaluateInvDf2,
  COMPLETENESS_BASES,
  INV_IZ_1,
} from './invariants.js';
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
