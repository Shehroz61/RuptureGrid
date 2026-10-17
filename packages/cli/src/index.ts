// =====================================================================
// RuptureGrid v1.1 Phase 17 — @rupturegrid/cli public surface
// =====================================================================
// Orchestration + serialization over accepted truth. Nothing here
// computes business verdicts; the engines own truth (§8).

export {
  SCENARIO_VERSION,
  SCENARIO_MAX_SERIALIZED_BYTES,
  EXPECTED_EXIT_CLASSES,
  EXPECTED_VERDICTS,
  validateScenarioDocument,
  parseScenarioFile,
  scenarioExperimentDocument,
  ScenarioValidationError,
} from './scenario.js';
export type {
  ScenarioDocument,
  ScenarioTargetSelector,
  ScenarioExpectations,
  ExpectedExitClass,
  ExpectedVerdict,
} from './scenario.js';

export {
  EXIT_CLASSES,
  EXIT_CODES,
  EXIT_MODE_STRICT,
  EXIT_MODE_LEGACY,
  exitCodeFor,
  exitClassFor,
  classifyExit,
} from './exit-code.js';
export type {
  ExitClass,
  SubjectVerdict,
  BoundKeyDomain,
  ExitAnomaly,
  ExitClassificationInput,
  ExitClassification,
} from './exit-code.js';

export {
  REPORT_SCHEMA_VERSION,
  FRESHNESS_STATEMENT,
  buildReport,
  cliToolIdentity,
  ReportEmitterError,
} from './report.js';
export type {
  RuptureGridReport,
  ReportInput,
  ReportTargetIdentity,
  ReportRunIdentity,
  ReportEvaluation,
  ReportFinding,
  ReportReproductionReference,
  ReportEligibilityKeySummary,
  ReportEligibilitySummary,
} from './report.js';

export {
  loadReportTarget,
  loadReportRun,
  loadSideEffectSummary,
  loadReportFindings,
  loadReportReproduction,
  loadNormalizerVersions,
  loadInvariantEvaluatorVersions,
  ReportInputError,
} from './report-input.js';

export {
  executeScenario,
  executeReplay,
  driveRunToReport,
  dispatchRun,
  resolveTargetByDisplayName,
  waitForRunTerminal,
  waitForAnalysisComplete,
  boundInvariantKeysOf,
  // The Boundary B frozen-input seam: the SAME lock-scoped acquisition
  // the `run` command uses, exported so the checkpoint suites exercise
  // the product path instead of a parallel test-side loader.
  loadFrozenReportInputs,
  TargetResolutionError,
  AnalysisTimeoutError,
  ReplayRequestError,
  ReplayValidationError,
} from './orchestrator.js';
export type { RunOutcome, RunFlowOptions, FrozenReportInputs } from './orchestrator.js';

export {
  assertAcceptanceExpectations,
  expectationsFromScenario,
  expectationsFromReproduction,
} from './expectations.js';
export type {
  AcceptanceExpectations,
  ExpectationReportView,
  ExpectationAssertion,
} from './expectations.js';

export {
  reportJsonSchema,
  scenarioJsonSchema,
  REPORT_SCHEMA_FILE,
  SCENARIO_SCHEMA_FILE,
} from './schema-documents.js';
export { emitSchemas, serializeSchemaDocumentStable } from './schema-emit.js';
export { validateReportAgainstSchema, ReportSchemaValidationError } from './schema-validate.js';

export {
  cliMain,
  parseTimeoutDuration,
  parseRunArgs,
  parseReplayArgs,
  parseCompareArgs,
  REPLAY_DEFAULT_TIMEOUT_MS,
} from './cli.js';
export type { CliDeps } from './cli.js';
