// =====================================================================
// RuptureGrid v1.0 — showcase package (Phase 8)
// =====================================================================
// Public surface of the showcase automation. The package is consumed
// by the CLI, the committed tests, and (in tests only) by the real
// browser integration suite. It exports NO truth engine: every fact
// the showcase presents is obtained from the accepted Phase 7 golden
// verifier at generation time.

export {
  CAPTURE_PLAN,
  artifactFilename,
  SHOWCASE_VIEWPORT,
  SHOWCASE_DEVICE_SCALE,
} from './capture-plan.js';
export type { CaptureStep, ShowcaseIdentifiers } from './capture-plan.js';
export type {
  ShowcaseManifest,
  ArtifactMetadata,
  ShowcaseModeStory,
  ShowcaseVideoMetadata,
  GoldenVerificationReport,
} from './types.js';
export {
  GOLDEN_VERIFIER_COMMAND,
  obtainVerifiedSession,
  runGoldenVerifier,
  extractVerifiedSession,
  setFindingIdResolver,
  VerifierFailureError,
} from './verifier.js';
export type { VerifiedMode } from './verifier.js';
export {
  startBrowser,
  startCaptureSession,
  captureAll,
  captureStep,
  waitForText,
  renderedText,
  writeMetadataSidecar,
  CaptureError,
} from './browser.js';
export type { StartedBrowser, CaptureSession } from './browser.js';
export {
  parsePngDimensions,
  validatePng,
  validateVideo,
  validateSessionArtifacts,
  PNG_SIGNATURE,
} from './validate.js';
export { generateVideo, slideOverlay, VIDEO_WIDTH, VIDEO_HEIGHT, SLIDE_SECONDS } from './video.js';
export {
  safeOutputDir,
  removeStaleVideo,
  VIDEO_FILENAME,
  GENERATED_OUTPUT_DIRNAME,
} from './output-safety.js';
export {
  runShowcaseSession,
  checkPrerequisites,
  assertApiServesSessionRuns,
  renderSummary,
  SHOWCASE_VERSION,
} from './orchestrator.js';
export { main as showcaseMain } from './cli.js';
