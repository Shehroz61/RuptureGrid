// =====================================================================
// RuptureGrid v1.1 Phase 17 — rupturegrid-report/v1 emitter (ADR-0019
// §3; Checkpoint D Boundary B output discipline — ADR-0026 §13)
// =====================================================================
// SERIALIZATION, NEVER TRUTH. Every truth-bearing field maps to durable
// Control-Plane / Evidence / Analysis state; the emitter:
//   - does NOT re-evaluate raw evidence or recompute business verdicts
//     (it serializes the FROZEN authorized state: pointer-resolved
//     evaluations, persisted findings, the integrity verifier's result,
//     and run/snapshot truth);
//   - performs NO database reads: every DB-resident input was resolved
//     INSIDE the per-run authorization transaction (Boundary B) and
//     handed in as a frozen value. Only `reportId` and `generatedAt`
//     are generated after the commit — neither enters the decision;
//   - allows only CONSISTENCY VALIDATION (the emitted report is
//     schema-validated; the exit object must agree with the exit
//     classifier);
//   - orders every array deterministically (evaluations by invariant
//     key + subject, findings by id, origins sorted — §38): the same
//     authorized truth yields semantically identical content apart from
//     the documented ephemeral envelope metadata (reportId,
//     generatedAt);
//   - serializes BigInt fencing values exactly (decimal string), never
//     coerced through JS Number (§39); money stays integer minor units;
//   - contains NO secret VALUES (reference names only — ADR-0012);
//     the report is a canary leak-scan surface (R-13).
// The report is a filesystem artifact (§93) — never a durable
// authority; no database writes happen here.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ExitAnomaly, ExitClassification } from './exit-code.js';
import type { IntegrityReport } from '@rupturegrid/evidence';

/** The only accepted report envelope version (§35). */
export const REPORT_SCHEMA_VERSION = 'rupturegrid-report/v1';

/** CLI tool identity recorded in the envelope (not business truth). */
export function cliToolIdentity(): { readonly name: string; readonly version: string } {
  let version = '0.0.0';
  try {
    // Read the CLI package version at emit time — repository-local,
    // no network, no dependency-version freeze from memory.
    const require = createRequire(import.meta.url);
    const nodePath = require('node:path') as {
      join: (from: string, ...segments: string[]) => string;
      dirname: (p: string) => string;
    };
    const { join, dirname } = nodePath;
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const parsed = JSON.parse(require('node:fs').readFileSync(packageJsonPath, 'utf8')) as {
      version?: string;
    };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      version = parsed.version;
    }
  } catch {
    // Honest fallback: the envelope tool version is metadata, never
    // truth; a missing file must not fail a report.
  }
  return { name: 'rupturegrid-cli', version };
}

export class ReportEmitterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReportEmitterError';
  }
}

// ---------------------------------------------------------------------
// Frozen inputs (resolved under the Boundary B lock; never re-read here)
// ---------------------------------------------------------------------

export interface ReportTargetIdentity {
  readonly targetId: string;
  readonly displayName: string;
  readonly environment: 'LOCAL_DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  /** Sorted normalized registered origins (deterministic). */
  readonly origins: readonly string[];
}

export interface ReportRunIdentity {
  readonly runId: string;
  readonly experimentName: string;
  readonly experimentDefinitionId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly terminalState: string;
  readonly engineVersion: string;
}

export interface ReportEvaluation {
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly subjectKey: string;
  readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
  readonly reason: string;
  readonly evidenceSetHash: string;
  readonly details: Record<string, unknown>;
  /** The key's authoritative publication mode (additive, §16 labeling). */
  readonly mode: string | null;
}

export interface ReportFinding {
  readonly findingId: string;
  readonly invariantEvaluationId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly findingRuleVersion: string;
  readonly reasonCode: string;
  readonly subjectKey: string;
  readonly title: string;
  readonly summary: string;
  readonly proofReferences: ReadonlyArray<{
    readonly subject: string;
    readonly sourceId: string;
    readonly role: string;
    readonly position: number;
  }>;
  readonly provenScope: Record<string, unknown>;
  readonly uncertainScope: Record<string, unknown>;
  readonly details: Record<string, unknown>;
}

export interface ReportReproductionReference {
  readonly reproductionDefinitionId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly targetModeRequirement: string | null;
  /** Credential REFERENCE names only (never values — ADR-0012). */
  readonly credentialRefs: readonly string[];
  readonly invariantBindings: Record<string, unknown>;
  readonly acceptanceExpectations: Record<string, unknown>;
}

/** One bound key's persisted eligibility/coverage summary (never derived). */
export interface ReportEligibilityKeySummary {
  readonly invariantKey: string;
  readonly mode: string;
  readonly evaluatorVersion: string;
  readonly declaredSubjects: readonly string[];
  readonly eligibleSubjects: readonly string[];
  readonly missingSubjects: readonly string[];
  readonly unexpectedSubjectCount: number;
  readonly foreignInventoryCount: number;
  readonly evidenceGapCount: number;
}

/**
 * The additive eligibility/certification block (ADR-0026 §20): the
 * certified as-of watermark, the bound-domain coverage facts, the named
 * anomalies, the unbound current evaluations (never silently omitted),
 * and the coverage limitation statement.
 */
export interface ReportEligibilitySummary {
  readonly eligibilityVersions: readonly string[];
  readonly analysisGeneration: string;
  readonly certified: boolean;
  readonly certifiedAsOf: {
    readonly headContentHash: string | null;
    readonly observationCount: number;
    readonly lastChainIndex: number | null;
    readonly provenanceRevision: string;
    readonly derivationGeneration: string;
  };
  readonly boundKeys: readonly ReportEligibilityKeySummary[];
  readonly unboundCurrentEvaluations: ReadonlyArray<{
    readonly invariantKey: string;
    readonly subjectKey: string;
    readonly verdict: string;
  }>;
  readonly anomalies: readonly ExitAnomaly[];
  readonly coverageLimitation: string | null;
  readonly freshnessStatement: string;
}

export interface ReportInput {
  readonly target: ReportTargetIdentity;
  readonly run: ReportRunIdentity;
  readonly sideEffectSummary: {
    readonly KNOWN_OCCURRED: number;
    readonly KNOWN_ABSENT: number;
    readonly INDETERMINATE: number;
    readonly NOT_APPLICABLE: number;
  };
  readonly evaluations: readonly ReportEvaluation[];
  readonly findings: readonly ReportFinding[];
  readonly reproduction: ReportReproductionReference | null;
  readonly invariantEvaluatorVersions: ReadonlyArray<{
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
  }>;
  /** Frozen normalizer identities (hoisted under the lock — §13). */
  readonly normalizerVersions: ReadonlyArray<{ name: string; version: string }>;
  /** The additive eligibility block (null when no publication exists). */
  readonly eligibility: ReportEligibilitySummary | null;
}

// ---------------------------------------------------------------------
// The report object
// ---------------------------------------------------------------------

export const FRESHNESS_STATEMENT =
  'This report certifies exactly ONE as-of truth-input watermark (chain identity, provenance revision, derivation generation, analysis generation). Any evidence, provenance, or derivation committed after that watermark belongs to a newer analysis state and is not covered; re-run the command to re-authorize.';

export interface RuptureGridReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly reportId: string;
  readonly generatedAt: string;
  readonly tool: { readonly name: string; readonly version: string };
  readonly target: ReportTargetIdentity;
  readonly run: ReportRunIdentity & {
    readonly normalizerVersions: ReadonlyArray<{ name: string; version: string }>;
    readonly invariantEvaluatorVersions: ReadonlyArray<{
      invariantKey: string;
      evaluatorVersion: string;
    }>;
  };
  readonly sideEffectSummary: ReportInput['sideEffectSummary'];
  readonly evidenceIntegrity: {
    readonly verified: boolean;
    readonly chainHeadHash: string | null;
    readonly observationCount: number;
    readonly problems: IntegrityReport['problems'];
  };
  readonly invariantEvaluations: readonly ReportEvaluation[];
  readonly findings: readonly ReportFinding[];
  readonly reproductionReference:
    ReportReproductionReference | { readonly absent: true; readonly reason: string };
  /** Additive (ADR-0026 §20); absent only when no publication exists. */
  readonly eligibility?: ReportEligibilitySummary;
  readonly exit: {
    readonly code: number;
    readonly class: string;
    readonly reason: string;
  };
}

/**
 * Builds the report object from FROZEN authorized inputs plus the
 * integrity verification and the exit classification. Pure: no database
 * reads, no recomputation. Deterministic ordering:
 *   - evaluations sorted by (invariantKey, subjectKey, evidenceSetHash)
 *   - findings sorted by findingId
 *   - origins pre-sorted by the loader
 * Ephemeral envelope metadata: reportId + generatedAt (documented).
 */
export function buildReport(
  input: ReportInput,
  integrity: IntegrityReport,
  exit: ExitClassification,
): RuptureGridReport {
  const sortedEvaluations = [...input.evaluations].sort(
    (a, b) =>
      a.invariantKey.localeCompare(b.invariantKey) ||
      a.subjectKey.localeCompare(b.subjectKey) ||
      a.evidenceSetHash.localeCompare(b.evidenceSetHash),
  );
  const sortedFindings = [...input.findings].sort((a, b) => a.findingId.localeCompare(b.findingId));
  const report: RuptureGridReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportId: randomUUID(),
    generatedAt: new Date().toISOString(),
    tool: cliToolIdentity(),
    target: {
      ...input.target,
      origins: [...input.target.origins].sort(),
    },
    run: {
      ...input.run,
      normalizerVersions: [...input.normalizerVersions].sort(
        (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
      ),
      invariantEvaluatorVersions: [...input.invariantEvaluatorVersions].sort((a, b) =>
        a.invariantKey.localeCompare(b.invariantKey),
      ),
    },
    sideEffectSummary: { ...input.sideEffectSummary },
    evidenceIntegrity: {
      verified: integrity.chainValid && integrity.contentHashesValid,
      chainHeadHash: integrity.recomputedHeadHash,
      observationCount: integrity.observationCount,
      problems: [...integrity.problems].sort(
        (a, b) => a.chainIndex - b.chainIndex || a.kind.localeCompare(b.kind),
      ),
    },
    invariantEvaluations: sortedEvaluations,
    findings: sortedFindings,
    reproductionReference:
      input.reproduction === null
        ? {
            absent: true,
            reason:
              'the run has no durable reproduction definition (forensic derivation has not completed for this run)',
          }
        : input.reproduction,
    ...(input.eligibility === null ? {} : { eligibility: input.eligibility }),
    exit: {
      code: exit.exitCode,
      class: exit.exitClass,
      reason: exit.reason,
    },
  };
  validateReportExitConsistency(report);
  return report;
}

/**
 * Consistency validation (allowed; NOT recomputation): the exit
 * object must agree with the classifier that was passed in — enforced
 * structurally by construction; this guard keeps future refactors
 * honest.
 */
function validateReportExitConsistency(report: RuptureGridReport): void {
  const classCodes: Record<string, number> = {
    PASS: 0,
    INVARIANT_FAIL: 1,
    NOT_EVALUABLE: 2,
    EXECUTION_FAILURE: 3,
    USAGE_ERROR: 4,
  };
  const expected = classCodes[report.exit.class];
  if (expected === undefined || report.exit.code !== expected) {
    throw new ReportEmitterError(
      `report exit object is inconsistent: class ${report.exit.class} must carry code ${String(expected ?? '?')}`,
    );
  }
}
