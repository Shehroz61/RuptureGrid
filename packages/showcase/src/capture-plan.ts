// =====================================================================
// RuptureGrid v1.0 — showcase capture plan (Phase 8)
// =====================================================================
// The stable, semantic identity of the showcase's required artifacts.
// This is the ONLY place the artifact set is defined; the orchestrator
// walks it, the validator checks against it, and the tests pin it.
// Filenames are stable and semantic (never run-ID-keyed); routes are
// constructed from the REAL run/finding IDs the golden verifier
// produces. Nothing here fabricates content: every artifact names the
// durable values the captured page must visibly carry before the
// screenshot is allowed to be saved (§24/§53 — a blank, wrong, or
// unverifiable page is a failed capture, never an artifact).
//
// Route construction and content expectations reference the accepted
// Phase 6 UI contract only (apps/web routes) — no presentation page is
// created or altered for capture.

/**
 * The two golden modes, mirroring the accepted verifier's own mode
 * vocabulary (packages/incident-zero run-types).
 */
export type ShowcaseMode = 'VULNERABLE' | 'SECURE';

/**
 * How an artifact's expected content is checked before the screenshot
 * is saved. `expectedIncludes` values must ALL appear in the page's
 * rendered text; `expectedExcludes` must appear in NONE of them.
 * Expected content is always bound to the session's REAL identifiers
 * or to canonical contract values — never invented.
 */
export interface CaptureStep {
  /** Stable semantic artifact stem (§30) — never a generated run ID. */
  readonly artifact: string;
  /** The mode's run this capture belongs to (drives route + binding). */
  readonly mode: ShowcaseMode;
  /** Exact route, relative to the web origin. */
  readonly route: (ids: ShowcaseIdentifiers) => string;
  /** Rendered-text substrings that must ALL be present. */
  readonly expectedIncludes: (ids: ShowcaseIdentifiers) => readonly string[];
  /** Rendered-text substrings that must NOT appear. */
  readonly expectedExcludes?: (ids: ShowcaseIdentifiers) => readonly string[];
  /** Why this artifact exists (manifest provenance field). */
  readonly purpose: string;
}

/** The REAL identifiers a golden session produces (verifier output). */
export interface ShowcaseIdentifiers {
  readonly vulnerableRunId: string;
  readonly secureRunId: string;
  /** The vulnerable mode's single deterministic failure Finding ID. */
  readonly vulnerableFindingId: string;
}

/**
 * How the product's runs table displays a run ID (apps/web/lib/
 * semantics.ts shortenId): first 10 chars + ellipsis + last 10 chars.
 * The runs index never renders full IDs, so its content gate keys on
 * the product's OWN rendering of the real identifiers — derived here
 * with the product's exact rule rather than loosened to prose.
 */
export function shortenedRunId(runId: string): string {
  return `${runId.slice(0, 10)}…${runId.slice(-10)}`;
}

/** The primary deterministic technical viewport (§21). */
export const SHOWCASE_VIEWPORT = { width: 1440, height: 900 } as const;
/** Deterministic device scale (§22) — recorded in artifact metadata. */
export const SHOWCASE_DEVICE_SCALE = 1 as const;

/**
 * The required artifact plan. Ordering is the narrative order of the
 * showcase (§58: same command ⇒ same artifact structure/order).
 */
export const CAPTURE_PLAN: readonly CaptureStep[] = [
  {
    artifact: '00-runs-index',
    mode: 'VULNERABLE',
    purpose: 'Runs list — the experiment ledger the investigation starts from',
    route: () => '/runs',
    expectedIncludes: (ids) => [
      shortenedRunId(ids.vulnerableRunId),
      shortenedRunId(ids.secureRunId),
    ],
    expectedExcludes: () => ['Application error', 'Control Plane API unreachable'],
  },
  {
    artifact: '01-vulnerable-overview',
    mode: 'VULNERABLE',
    purpose: 'Vulnerable run overview — execution COMPLETED vs business FAIL distinction',
    route: (ids) => `/runs/${ids.vulnerableRunId}`,
    expectedIncludes: (ids) => [ids.vulnerableRunId, 'COMPLETED', 'FAIL', 'INV-IZ-1'],
  },
  {
    artifact: '02-vulnerable-finding',
    mode: 'VULNERABLE',
    purpose: 'The deterministic Finding: subject, two equivalent PKR 5,000 effects, proven scope',
    route: (ids) => `/runs/${ids.vulnerableRunId}/findings/${ids.vulnerableFindingId}`,
    expectedIncludes: () => [
      'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
      'PKR 5,000.00',
      'identity-chain',
      'Proven',
    ],
  },
  {
    artifact: '03-vulnerable-timeline',
    mode: 'VULNERABLE',
    purpose:
      'Vulnerable forensic timeline — ordering bases; overlap is visible, causality is not implied by adjacency',
    route: (ids) => `/runs/${ids.vulnerableRunId}/timeline`,
    expectedIncludes: (ids) => [ids.vulnerableRunId, 'Forensic timeline', 'order:'],
  },
  {
    artifact: '04-vulnerable-evidence',
    mode: 'VULNERABLE',
    purpose:
      'Vulnerable evidence — redacted raw observations, chain integrity, honest guarantee wording',
    route: (ids) => `/runs/${ids.vulnerableRunId}/evidence`,
    expectedIncludes: () => [
      'Raw observations',
      'Integrity',
      'detects post-hoc modification',
      'Redaction happened before persistence',
    ],
  },
  {
    artifact: '05-vulnerable-reproduction',
    mode: 'VULNERABLE',
    purpose:
      'Vulnerable reproduction definition — frozen snapshot binding, credential REFERENCES only',
    route: (ids) => `/runs/${ids.vulnerableRunId}/reproduction`,
    expectedIncludes: (ids) => [
      'Reproduction definition',
      ids.vulnerableRunId,
      'DEMO_ADMIN_TOKEN',
      'Names only',
    ],
    expectedExcludes: () => ['Bearer '],
  },
  {
    artifact: '06-secure-overview',
    mode: 'SECURE',
    purpose: 'Secure run overview — same pressure, PASS verdict, zero failure findings',
    route: (ids) => `/runs/${ids.secureRunId}`,
    expectedIncludes: (ids) => [ids.secureRunId, 'COMPLETED', 'PASS', 'INV-IZ-1'],
  },
  {
    artifact: '07-secure-timeline',
    mode: 'SECURE',
    purpose: 'Secure timeline — same 20-delivery physical pressure recorded honestly',
    route: (ids) => `/runs/${ids.secureRunId}/timeline`,
    expectedIncludes: (ids) => [ids.secureRunId, 'Forensic timeline', 'order:'],
  },
  {
    artifact: '08-secure-evidence',
    mode: 'SECURE',
    purpose: 'Secure evidence — suppressed attempts remain recorded as observations',
    route: (ids) => `/runs/${ids.secureRunId}/evidence`,
    expectedIncludes: () => [
      'Raw observations',
      'Integrity',
      'Redaction happened before persistence',
    ],
  },
  {
    artifact: '09-secure-reproduction',
    mode: 'SECURE',
    purpose: 'Secure reproduction definition — SECURE mode requirement',
    route: (ids) => `/runs/${ids.secureRunId}/reproduction`,
    expectedIncludes: () => ['Reproduction definition', 'SECURE', 'Names only'],
  },
] as const;

/** Artifact filename for a plan step (stable, semantic — §30). */
export function artifactFilename(step: CaptureStep): string {
  return `${step.artifact}.png`;
}
