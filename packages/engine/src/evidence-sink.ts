// =====================================================================
// RuptureGrid v1.0 — evidence sink boundary (Phase 4)
// =====================================================================
// The execution engine OBSERVES real invocations; the evidence layer
// OWNS durable truth (docs/evidence-model.md §3, architecture §10).
// This interface is the narrow seam between them: the engine hands the
// sink what it actually observed (never invented, never interpreted),
// and the evidence package decides persistence. The engine never
// imports the evidence package — dependency direction is evidence →
// engine (the sink is injected), so the execution domain stays
// self-contained and no import cycle can exist.

/**
 * What the executor actually observed for one physical invocation.
 * Every field is an honest record of this attempt; `responseBody` is
 * already bounded (executor cap) and is redacted by the evidence
 * layer BEFORE persistence — never here, never later.
 */
export interface InvocationObservation {
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationId: string | null;
  readonly invocationIdentity: string;
  readonly sequence: number;
  readonly waveIndex: number;
  readonly method: string;
  /** Normalized relative path only — never an absolute URL. */
  readonly relativePath: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: string | null;
  readonly transportStage: string;
  readonly httpStatus: number | null;
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly responseBody: string | null;
  readonly responseTruncated: boolean;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly error: string | null;
  readonly observedAt: Date;
}

/**
 * Narrow capture seam. Implementations (the evidence package) own
 * idempotency, redaction, hashing, and chaining. The engine supplies
 * the claim's writer provenance (ownerId + fencing token) so a stale
 * generation's truthful observation remains appendable and ATTRIBUTED
 * (§14) — without regaining authority over execution state. Capture
 * failures are recorded (an observation that could not be persisted is
 * REALITY: it happened but was not durably captured — honest
 * incompleteness), never silently swallowed, and never block execution.
 */
export interface EvidenceSink {
  captureInvocation(
    observation: InvocationObservation,
    writer: { ownerId: string; fencingToken: string | null },
  ): Promise<void>;
}

/** Null-object sink: Phase 3 semantics when no evidence sink is set. */
export const noopEvidenceSink: EvidenceSink = {
  async captureInvocation(): Promise<void> {
    // Deliberately nothing: absence of an evidence sink is a valid
    // configuration (execution and evidence are separate concerns).
  },
};
