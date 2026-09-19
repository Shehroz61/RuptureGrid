// =====================================================================
// RuptureGrid v1.0 — golden scenario result types (Phase 7)
// =====================================================================
// Type-only module: the safe result structures one golden execution
// produces (every value is durable Control-Plane truth; generated IDs
// are per-run; no credential value ever appears — ADR-0012). Kept free
// of runtime imports so verification/checker modules and unit tests can
// consume the shapes without pulling in the orchestrator's runtime
// dependencies.

export type GoldenMode = 'VULNERABLE' | 'SECURE';

export interface GoldenTargetRegistration {
  readonly targetId: string;
  readonly origin: string;
  readonly created: boolean;
}

/**
 * The logical provider payment of THIS run, taken from the create-
 * payment step's OWN recorded response (identity from the provider's
 * response — never invented by the orchestrator).
 */
export interface GoldenPaymentIdentity {
  readonly providerPaymentId: string;
  readonly walletId: string;
  readonly amountMinor: string;
  readonly currency: string;
}

/** The wallet state recorded by the capture-lineage adapter (Phase 4 evidence). */
export interface GoldenWalletState {
  readonly walletId: string;
  readonly balanceMinor: string;
  readonly currency: string;
}

/** Evaluation row for the run's payment subject (Phase 4 truth). */
export interface GoldenEvaluation {
  readonly id: string;
  readonly subjectKey: string;
  readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
  readonly reason: string;
  readonly equivalentEffectCount: number | null;
}

/** The failure Finding derived by Phase 5 for this run (null ⇒ none). */
export interface GoldenFinding {
  readonly id: string;
  readonly reasonCode: string;
  readonly subjectKey: string;
}

/**
 * The complete, safe result of one golden execution: every value is
 * durable Control-Plane truth. Generated IDs are per-run; no credential
 * value ever appears here (ADR-0012).
 */
export interface GoldenRunResult {
  readonly scenarioVersion: string;
  readonly mode: GoldenMode;
  readonly runId: string;
  readonly experimentId: string;
  readonly revisionId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly targetId: string;
  readonly targetOrigin: string;
  readonly runState: string;
  readonly payment: GoldenPaymentIdentity;
  readonly wallet: GoldenWalletState | null;
  readonly evaluation: GoldenEvaluation | null;
  readonly finding: GoldenFinding | null;
  readonly integrity: { readonly observationCount: number; readonly chainValid: boolean };
  readonly timelineEntryCount: number;
  readonly reproductionDefinition: {
    readonly snapshotContentHash: string;
    readonly targetModeRequirement: string | null;
    readonly credentialRefs: readonly string[];
  } | null;
  readonly deliveryCount: number;
  readonly processingAttemptCount: number;
  readonly financialEffectCount: number;
}
