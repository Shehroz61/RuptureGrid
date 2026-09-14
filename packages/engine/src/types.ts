// =====================================================================
// RuptureGrid v1.0 — Phase 3 execution-domain types
// =====================================================================
// The experiment document is deliberately NARROW (Phase 3 §14/§15):
// ordered steps, one action type (controlled HTTP against a registered
// target). No universal workflow language, no shell/SQL/filesystem/
// code-evaluation actions. This document shape is what experiment
// validation accepts, what revisions store, and what snapshots
// freeze (ADR-0010).

import type { ContractKind } from './target.js';

/** The only HTTP methods the v1 executor accepts. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const MUTATION_CLASSIFICATIONS = ['READ_ONLY', 'MUTATING'] as const;
export type MutationClassification = (typeof MUTATION_CLASSIFICATIONS)[number];

/** Step retry classification (shared enum, mirrored in shared package). */
export type DeclaredRetryPolicy = 'NONE' | 'SAFE';

/**
 * One controlled HTTP action template. `relativePath` is validated to
 * stay within the registered origin (absolute URLs are REJECTED —
 * security-boundaries §3). Header VALUES may embed `${credential.<REF}`
 * references; body may embed `${steps.…}` variable references (§59).
 */
export interface HttpActionTemplate {
  readonly method: HttpMethod;
  readonly relativePath: string;
  /** Custom headers. Names are allowlisted; values redact-safe strings. */
  readonly headers?: Readonly<Record<string, string>>;
  /** UTF-8 body. Only meaningful for methods that carry one. */
  readonly body?: string;
  /** Declared mutation semantics (drives side-effect classification). */
  readonly mutation: MutationClassification;
  /** Declared retry policy (drives executor retries; default NONE). */
  readonly retryPolicy?: DeclaredRetryPolicy;
  /** Experiment-declared repeats (default 1). Distinct from retries. */
  readonly repeat?: number;
  /** Max in-flight invocations for this step (default 1). */
  readonly concurrency?: number;
  /** Per-invocation timeout in ms (bounded; default from limits). */
  readonly timeoutMs?: number;
  /**
   * Response-interpretation contract for classification (§27). Must
   * equal the target's registered contract kind.
   */
  readonly contract: ContractKind;
  /**
   * Credential reference names this action resolves at execution time.
   * Must be a subset of the target's registered credentialRefs.
   */
  readonly credentialRefs?: readonly string[];
  /**
   * Phase 4: EXPLICIT target-evidence adapter declaration (§28/§29).
   * When set, after this step's terminal write the worker invokes the
   * named adapter to capture target business-state observations
   * (read-only, target-authored APIs only). Adapter selection is
   * NEVER inferred from response shape or path substrings.
   */
  readonly evidenceAdapter?: {
    /** The adapter kind (the only Phase 4 kind: demo payment lineage). */
    readonly kind: 'demo-fintech-payment-lineage';
    /**
     * Where the logical payment id comes from: a `${steps.<name>.response.…}`
     * reference resolved like body references (identity-backed — the
     * target's own response names the payment), or a literal.
     */
    readonly providerPaymentIdFrom: string;
  };
}

/** One ordered step of an experiment. */
export interface ExperimentStep {
  /** Stable step name, referenced by variable references. */
  readonly name: string;
  readonly action: HttpActionTemplate;
}

/** The validated experiment document (the only accepted shape). */
export interface ExperimentDocument {
  readonly steps: readonly ExperimentStep[];
}

/**
 * The frozen snapshot document (ADR-0010 §18): everything one run
 * needs, with credential VALUES absent (references only).
 */
export interface RunSnapshotDocument {
  readonly engineVersion: string;
  readonly canonicalization: string;
  readonly target: {
    readonly targetId: string;
    readonly displayName: string;
    readonly environment: 'LOCAL_DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
    /** Normalized registered origin: `scheme://host[:port]`. */
    readonly origin: string;
    readonly contractKind: ContractKind;
    /** Credential REFERENCE names only — never values (ADR-0012). */
    readonly credentialRefs: readonly string[];
  };
  readonly experiment: {
    readonly definitionId: string;
    readonly revisionId: string;
    readonly definitionName: string;
    readonly revisionNumber: number;
  };
  readonly steps: readonly ExperimentStep[];
}

export class ExperimentValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      issues.length === 1
        ? `invalid experiment document: ${issues[0]}`
        : `invalid experiment document (${issues.length} issues):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'ExperimentValidationError';
    this.issues = issues;
  }
}
