// =====================================================================
// RuptureGrid v1.0 — shared service identities and constants
// =====================================================================
// Cross-cutting, non-domain primitives only (AGENTS R-05; Phase 1
// non-scope §6). Domain types (Wallet, ExperimentRun, Evidence, …)
// deliberately DO NOT live here.

/** Canonical service names used in structured logs and health metadata. */
export const SERVICE_NAMES = {
  api: 'rupturegrid-api',
  worker: 'rupturegrid-worker',
  web: 'rupturegrid-web',
  demoFintech: 'demo-fintech',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/** The Phase 1 foundation smoke queue (BullMQ). */
export const FOUNDATION_QUEUE_NAME = 'foundation-smoke';

/**
 * The Phase 3 experiment execution queue (BullMQ). Coordination only
 * (ADR-0003): job payloads carry durable row identifiers, never
 * authoritative state.
 */
export const EXECUTION_QUEUE_NAME = 'experiment-execution';

/**
 * Default BullMQ key prefix. Every queue participant (Queue, Worker,
 * QueueEvents) must use the same prefix or they will not see each
 * other's keys.
 */
export const DEFAULT_QUEUE_PREFIX = 'rupturegrid';

/**
 * Version identifier recorded in every RunSnapshot (ADR-0010). Bumped
 * only when snapshot semantics change, never silently.
 */
export const EXECUTION_ENGINE_VERSION = 'phase3-execution-v1';

// ---------------------------------------------------------------------
// Execution engine enums (Phase 3)
// ---------------------------------------------------------------------

/**
 * Target environment classification (security-boundaries §2, architecture
 * §6). The Demo Fintech target is LOCAL_DEVELOPMENT-classified;
 * PRODUCTION targets are denied experiment execution in v1 (ADR-0011).
 * Address-class policy (loopback/private/link-local) is likewise denied
 * for every environment except LOCAL_DEVELOPMENT (security-boundaries §5).
 */
export const TARGET_ENVIRONMENTS = ['LOCAL_DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

/**
 * Run state machine (architecture §8):
 * CREATED → SNAPSHOT_PINNED → DISPATCHING → RUNNING →
 * (RECONCILING ⇄) → { COMPLETED | FAILED | CANCELLED }.
 */
export const RUN_STATES = [
  'CREATED',
  'SNAPSHOT_PINNED',
  'DISPATCHING',
  'RUNNING',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES: readonly RunState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Step intent-execution state machine (architecture §8):
 * PENDING → DISPATCHED → CLAIMED → EXECUTING → terminal.
 * The v1 ordered-dependency policy stops a run on process failure: a
 * step whose prerequisite terminally FAILED/CANCELLED is itself marked
 * CANCELLED (sideEffectKnowledge KNOWN_ABSENT, reason recorded) — no
 * state outside the accepted machine is invented.
 * sideEffectKnowledge is deliberately NOT a state — it is an
 * orthogonal dimension (ADR-0008) carried as its own field.
 */
export const STEP_STATES = [
  'PENDING',
  'DISPATCHED',
  'CLAIMED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const STEP_TERMINAL_STATES: readonly StepState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * intentOutcome — did the executor complete its own work for the step?
 * (architecture §7.1). Orthogonal to sideEffectKnowledge.
 */
export const INTENT_OUTCOMES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type IntentOutcome = (typeof INTENT_OUTCOMES)[number];

/**
 * sideEffectKnowledge — what is known about the remote mutation
 * (ADR-0008). Never collapsed into intentOutcome; INDETERMINATE is
 * persisted, displayed, and never auto-retried.
 */
export const SIDE_EFFECT_KNOWLEDGE_VALUES = [
  'KNOWN_OCCURRED',
  'KNOWN_ABSENT',
  'INDETERMINATE',
  'NOT_APPLICABLE',
] as const;
export type SideEffectKnowledge = (typeof SIDE_EFFECT_KNOWLEDGE_VALUES)[number];

/**
 * Declared step retry classification (architecture §7.2). Experiments
 * must declare the step's idempotency characteristics; the executor
 * applies the conservative default table on top.
 *   NONE  — no executor retry (default; mutations are NONE by default)
 *   SAFE  — retry permitted for provably pre-send failures and
 *           read-only transient failures, within a small bounded budget
 */
export const DECLARED_RETRY_POLICIES = ['NONE', 'SAFE'] as const;
export type DeclaredRetryPolicy = (typeof DECLARED_RETRY_POLICIES)[number];

/** Durable dispatch/reconciliation markers (ADR-0003). */
export const DISPATCH_STATES = ['PENDING', 'DISPATCHED', 'RECONCILE'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

// ---------------------------------------------------------------------
// Blast-radius limits — server-side caps (security-boundaries §8)
// ---------------------------------------------------------------------
// Enforced at experiment validation / run creation AND re-checked by
// the executor before any remote request (architecture "server-side
// enforcement"). Values are conservative explicit defaults; every one
// is configurable through validated environment where operationally
// necessary (executor config), never client-trusted.

export const EXECUTION_LIMITS = {
  /** Maximum ordered steps per experiment definition. */
  maxStepsPerExperiment: 20,
  /** Maximum experiment-declared repeat per step. */
  maxRepeat: 100,
  /** Maximum in-flight concurrency per step. */
  maxConcurrency: 32,
  /** Default per-invocation timeout (ms). */
  defaultTimeoutMs: 30_000,
  /** Maximum per-invocation timeout (ms). */
  maxTimeoutMs: 60_000,
  /** Maximum request body bytes per invocation. */
  maxRequestBodyBytes: 256_000,
  /** Maximum response body bytes buffered per invocation. */
  maxResponseBytes: 1_000_000,
  /** Maximum custom headers per step. */
  maxHeaders: 32,
  /** Maximum total remote invocations budgeted per run. */
  maxTotalInvocationsPerRun: 10_000,
  /** Bound for durable error messages (bytes of text). */
  maxErrorMessageLength: 500,
  /**
   * Phase 9: maximum deterministic repeat-wave stagger per step (ms).
   * 0 disables staggering. Bounded server-side like every other
   * blast-radius limit (security-boundaries §8).
   */
  maxWaveStaggerMs: 60_000,
  /** Phase 9: maximum fault-plan trigger budget per step. */
  maxFaultTriggersPerStep: 10,
} as const;

export type ExecutionLimits = typeof EXECUTION_LIMITS;

/**
 * The bounded retry budget for steps declared SAFE (architecture
 * §7.2). Mutating steps default to NONE regardless; SAFE retry is
 * still refused for INDETERMINATE outcomes (ADR-0008).
 */
export const SAFE_RETRY_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------
// Money is always an integer amount of minor units (paisa for PKR) with
// an explicit currency code — never a float (AGENTS R-06, ADR-0004).
// Phase 1 establishes the type contract; business logic arrives later.
// ---------------------------------------------------------------------

export type CurrencyCode = 'PKR';

export interface MoneyMinorUnits {
  /** Integer amount in the currency's minor unit. Never a float. */
  readonly amountMinorUnits: number;
  readonly currency: CurrencyCode;
}

// ---------------------------------------------------------------------
// Phase 9 — controlled-fault constants (docs/controlled-faults.md)
// ---------------------------------------------------------------------
// The closed plan-semantics version and kind vocabulary the ENGINE
// accepts. The Demo Target independently declares the same vocabulary
// in @rupturegrid/demo-db (the target boundary deliberately does not
// depend on @rupturegrid/shared — ADR-0002); docs/controlled-faults.md
// is the single semantic authority both must match.

export const CONTROLLED_FAULT_PLAN_VERSION = 'controlled-fault/v1';

export const CONTROLLED_FAULT_KINDS = [
  'PRE_MUTATION_REJECTION',
  'CRASH_MID_PROCESSING',
  'RESPONSE_TRUNCATION',
] as const;
export type ControlledFaultKind = (typeof CONTROLLED_FAULT_KINDS)[number];

export const CONTROLLED_FAULT_ACTIVATIONS = ['first_n_matching_deliveries'] as const;
export type ControlledFaultActivation = (typeof CONTROLLED_FAULT_ACTIVATIONS)[number];

export { isSensitiveKey, maskSensitiveFields, maskValue, redactUrlPassword } from './redact.js';
