// =====================================================================
// RuptureGrid v1.0 — showcase session types (Phase 8)
// =====================================================================
// The ephemeral showcase-session manifest and artifact metadata shapes.
// The manifest binds every produced artifact to its provenance chain
// (phase-7 accepted commit → golden verifier result → run → route →
// file). It is generated fresh per session, written only to the
// ignored output directory, and NEVER committed. It carries credential
// REFERENCE NAMES at most (they appear in the product's own
// reproduction view); credential VALUES are impossible here by
// construction — the verifier result types never contain them and the
// manifest never reads environment secret values (ADR-0012, R-13).

// The verifier's JSON report shape (single source: the accepted
// Phase 7 verifier's `--json` output — packages/incident-zero cli.ts).
// The showcase consumes it read-only; the incident-zero package does
// not export the type, so the exact shape is restated here and pinned
// by the bridge's unit tests.
export interface GoldenVerificationReport {
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly scenarioVersion: string;
  readonly spawned: ReadonlyArray<{ readonly label: string; readonly pid: number }>;
  readonly registrations: ReadonlyArray<{
    readonly mode: string;
    readonly created: boolean;
    readonly origin: string;
    readonly targetId: string;
  }>;
  readonly frozenIntent: {
    readonly pass: boolean;
    readonly assertions: ReadonlyArray<{
      readonly name: string;
      readonly expected: string;
      readonly actual: string;
      readonly pass: boolean;
    }>;
  };
  readonly modes: ReadonlyArray<{
    readonly mode: string;
    readonly runId: string;
    readonly snapshotContentHash: string;
    readonly paymentId: string;
    readonly pass: boolean;
    readonly assertions: ReadonlyArray<{
      readonly name: string;
      readonly expected: string;
      readonly actual: string;
      readonly pass: boolean;
    }>;
  }>;
  readonly canary: { readonly scanned: boolean; readonly leaks: readonly string[] };
}

/** Which stage produced/consumed an artifact, for honest status text. */
export type ArtifactStatus = 'captured' | 'validated';

/** Provenance sidecar bound to ONE artifact file (§11/§31). */
export interface ArtifactMetadata {
  /** Stable semantic filename, e.g. `01-vulnerable-overview.png`. */
  readonly filename: string;
  /** The REAL golden run this artifact depicts. */
  readonly runId: string;
  /** The REAL finding depicted, when the artifact is a finding view. */
  readonly findingId: string | null;
  /** Exact route captured (§51) — relative to the web origin. */
  readonly route: string;
  /** ISO-8601 capture instant (descriptive only — never an identity). */
  readonly capturedAt: string;
  /** Deterministic viewport + scale actually used (§21/§22). */
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  /** The run's INV-IZ-1 verdict at capture time (from verifier truth). */
  readonly sourceVerdict: 'FAIL' | 'PASS';
  /** SHA-256 of the artifact file — file identity, not truth (§60). */
  readonly sha256: string;
  /** Byte size of the artifact. */
  readonly bytes: number;
  /** Why this artifact exists (from the capture plan). */
  readonly purpose: string;
  readonly status: ArtifactStatus;
}

/** One mode's verified story, transcribed from verifier truth. */
export interface ShowcaseModeStory {
  readonly mode: 'VULNERABLE' | 'SECURE';
  readonly runId: string;
  readonly paymentId: string;
  /** Vulnerable mode only: the deterministic failure Finding. */
  readonly findingId: string | null;
  readonly snapshotContentHash: string;
  readonly verdict: 'FAIL' | 'PASS';
  readonly runState: string;
}

/** Video provenance, present only when the video stage ran (§45). */
export interface ShowcaseVideoMetadata {
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly codecName: string;
  readonly sourceFilenames: readonly string[];
  readonly generatedBy: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The complete ephemeral showcase-session manifest (§10). */
export interface ShowcaseManifest {
  readonly showcaseVersion: string;
  readonly generatedAt: string;
  /** The accepted Phase 7 checkpoint this showcase presents (§11). */
  readonly phase7Commit: string;
  readonly goldenScenarioVersion: string;
  readonly vulnerable: ShowcaseModeStory;
  readonly secure: ShowcaseModeStory;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  /** The verifier invocation that produced the session's truth. */
  readonly goldenVerifier: {
    readonly command: string;
    readonly exitCode: number;
    readonly report: GoldenVerificationReport;
  };
  readonly artifacts: readonly ArtifactMetadata[];
  readonly video: ShowcaseVideoMetadata | null;
  /** Ellapsed wall-clock of the whole generation, milliseconds. */
  readonly durationMs: number;
  /** Aggregate validation result (§46) — the session's own gate. */
  readonly validation: { readonly pass: boolean; readonly problems: readonly string[] };
}
