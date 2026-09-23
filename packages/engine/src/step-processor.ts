// =====================================================================
// RuptureGrid v1.0 — step execution orchestration
// =====================================================================
// The full owned lifecycle of one claimed step:
//   mark EXECUTING → run repeat WAVES with bounded concurrency →
//   record every invocation (append-only, attributed) → write the
//   terminal state ONCE (fenced) → apply the ordered-dependency
//   policy (stop safely on process failure) → settle the run.
//
// Repeat ≠ retry (§7.2): repeats are planned WAVES of invocations;
// retries are executor-driven, conservative, classified — and never
// applied to INDETERMINATE mutating outcomes (ADR-0008).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { WorkerConfig } from '@rupturegrid/config';
import { SAFE_RETRY_MAX_ATTEMPTS, EXECUTION_LIMITS } from '@rupturegrid/shared';
import type { RunSnapshotDocument, ExperimentStep } from './types.js';
import { claimStep, heartbeatStep, LeaseLostError } from './claim.js';
import type { ClaimResult } from './claim.js';
import { markExecuting, recordInvocation, writeTerminalState } from './transitions.js';
import type { FencingContext } from './transitions.js';
import { classifyInvocation, decideRetry } from './classify.js';
import type { ClassifyResult } from './classify.js';
import { noopEvidenceSink } from './evidence-sink.js';
import type { EvidenceSink } from './evidence-sink.js';
import { executeHttp, CredentialResolutionError } from './executor.js';
import type { CredentialResolver } from './executor.js';
import { noopTelemetry } from './telemetry.js';
import type { EngineTelemetry } from './telemetry.js';

export interface StepProcessorDeps {
  readonly prisma: PrismaClient;
  readonly config: Pick<WorkerConfig, 'WORKER_LEASE_DURATION_MS' | 'WORKER_HEARTBEAT_INTERVAL_MS'>;
  readonly credentials: CredentialResolver;
  /**
   * Invoked after a step's fenced terminal SUCCEEDED write, when the
   * next ordered step becomes dispatchable. Implementations enqueue
   * durably (queue + DISPATCHED marker); failures leave the next step
   * in RECONCILE for the reconciler — never stranded.
   */
  readonly dispatchNextStep?: (runId: string, nextStepRunId: string) => Promise<void>;
  /**
   * Phase 4 evidence sink: receives every REAL invocation observation.
   * Capture failures are recorded (honest incompleteness), never
   * silently swallowed, and never block execution.
   */
  readonly evidenceSink?: EvidenceSink;
  /**
   * Phase 4 EXPLICIT target-evidence adapter hook (§28/§29): invoked
   * after a step's fenced terminal SUCCEEDED write when the step's
   * action declares an evidenceAdapter. The engine resolves the
   * adapter's identity input from the step's own recorded responses
   * (identity-backed, never timestamps) and hands over the frozen
   * snapshot's target origin; the implementation owns the adapter.
   * Failures are recorded as honest incompleteness, never fatal.
   */
  readonly captureEvidenceAdapter?: (input: {
    readonly runId: string;
    readonly stepRunId: string;
    readonly origin: string;
    readonly adapterKind: 'demo-fintech-payment-lineage';
    readonly providerPaymentId: string;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }) => Promise<void>;
  /**
   * Phase 9 controlled-fault control hook (ADR-0014). The engine owns
   * WHEN to arm/disarm (deterministic step semantics); the caller owns
   * HOW (the target's own admin API, with the target credential — the
   * engine stays target-agnostic and holds no target secrets). Arming
   * failure is a hard precondition: the step fails BEFORE any delivery.
   * Disarm is best-effort by contract.
   */
  readonly controlledFaults?: {
    readonly arm: (input: {
      readonly faultPlan: NonNullable<ExperimentStep['action']['faultPlan']>;
      readonly runId: string;
      readonly stepRunId: string;
      /** The FROZEN registered target origin (faults arm only there). */
      readonly origin: string;
    }) => Promise<void>;
    readonly disarm: (input: {
      readonly faultKind: NonNullable<ExperimentStep['action']['faultPlan']>['faultKind'];
      readonly runId: string;
      readonly stepRunId: string;
      readonly origin: string;
    }) => Promise<void>;
  };
  /**
   * Phase 9: explicit fault-status observation hook (docs/controlled-
   * faults.md §5). Called AFTER the terminal write for every fault-
   * bearing step — success OR failure — because configured-vs-activated
   * truth matters most on the failure paths. The caller owns HOW (the
   * target's read-only inspection API, adapter kind, credential); the
   * engine stays target-agnostic. Failure is honest incompleteness,
   * never fatal to the step outcome.
   */
  readonly captureFaultStatusAdapter?: (input: {
    readonly runId: string;
    readonly stepRunId: string;
    readonly origin: string;
    readonly writerOwnerId: string;
    readonly writerFencingToken: string | null;
  }) => Promise<void>;
  /** Phase 9 telemetry seam (ADR-0015). Defaults to a no-op. */
  readonly telemetry?: EngineTelemetry;
}

import type { InvocationObservation } from './evidence-sink.js';

export class StepNotClaimableError extends Error {
  public constructor(stepRunId: string) {
    super(
      `step ${stepRunId} was not claimable (already claimed by a live lease, terminal, or run cancelled) — ` +
        'delivery exits safely without executing',
    );
    this.name = 'StepNotClaimableError';
  }
}

/** Resolves the step's action template from the snapshot document. */
function actionForStep(document: RunSnapshotDocument, sequence: number): ExperimentStep {
  const step = document.steps[sequence];
  if (step === undefined) {
    throw new Error(`snapshot has no step at sequence ${sequence}`);
  }
  return step;
}

/**
 * Builds the Demo webhook credential resolver: values resolved from
 * the validated worker config at request time only (ADR-0012 §55).
 */
export function createDemoCredentialResolver(
  config: Pick<
    WorkerConfig,
    'DEMO_ADMIN_TOKEN' | 'DEMO_INSPECTION_TOKEN' | 'DEMO_PROVIDER_SIGNING_SECRET'
  >,
): CredentialResolver {
  return {
    resolve(ref: string): string {
      if (ref === 'DEMO_ADMIN_TOKEN') {
        if (config.DEMO_ADMIN_TOKEN === undefined) {
          throw new CredentialResolutionError(ref);
        }
        return config.DEMO_ADMIN_TOKEN;
      }
      if (ref === 'DEMO_INSPECTION_TOKEN') {
        if (config.DEMO_INSPECTION_TOKEN === undefined) {
          throw new CredentialResolutionError(ref);
        }
        return config.DEMO_INSPECTION_TOKEN;
      }
      if (ref === 'DEMO_PROVIDER_SIGNING_SECRET') {
        if (config.DEMO_PROVIDER_SIGNING_SECRET === undefined) {
          throw new CredentialResolutionError(ref);
        }
        return config.DEMO_PROVIDER_SIGNING_SECRET;
      }
      throw new CredentialResolutionError(ref);
    },
  };
}

export class StepProcessor {
  private readonly prisma: PrismaClient;
  private readonly config: StepProcessorDeps['config'];
  private readonly credentials: CredentialResolver;
  private readonly heartbeat: HeartbeatLoop;
  private readonly dispatchNextStep: (runId: string, nextStepRunId: string) => Promise<void>;
  private readonly evidenceSink: EvidenceSink;
  private readonly captureEvidenceAdapter:
    | ((input: {
        readonly runId: string;
        readonly stepRunId: string;
        readonly origin: string;
        readonly adapterKind: 'demo-fintech-payment-lineage';
        readonly providerPaymentId: string;
        readonly writerOwnerId: string;
        readonly writerFencingToken: string | null;
      }) => Promise<void>)
    | undefined;
  private readonly controlledFaults: StepProcessorDeps['controlledFaults'] | undefined;
  private readonly captureFaultStatusAdapter:
    StepProcessorDeps['captureFaultStatusAdapter'] | undefined;
  private readonly telemetry: EngineTelemetry;

  public constructor(deps: StepProcessorDeps) {
    this.prisma = deps.prisma;
    this.config = deps.config;
    this.credentials = deps.credentials;
    this.evidenceSink = deps.evidenceSink ?? noopEvidenceSink;
    this.captureEvidenceAdapter = deps.captureEvidenceAdapter;
    this.controlledFaults = deps.controlledFaults;
    this.captureFaultStatusAdapter = deps.captureFaultStatusAdapter;
    this.telemetry = deps.telemetry ?? noopTelemetry;
    this.dispatchNextStep =
      deps.dispatchNextStep ??
      (async () => {
        // Default: no chaining hook (single-step or orchestrator-less
        // usage). Ordered runs must supply the hook; the reconciler
        // remains a safety net for any step left un-dispatched.
      });
    this.heartbeat = new HeartbeatLoop(deps.prisma, deps.config.WORKER_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Processes one delivered step job. Returns the terminal step state
   * (or 'not-claimable' when another generation owns/finished it).
   */
  public async processStep(
    stepRunId: string,
  ): Promise<'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'not-claimable'> {
    const claim = await claimStep(this.prisma, stepRunId, {
      ownerId: this.ownerId,
      leaseDurationMs: this.config.WORKER_LEASE_DURATION_MS,
    });
    if (claim === null) {
      return 'not-claimable';
    }
    const ctx: FencingContext = { ownerId: this.ownerId, fencingToken: claim.fencingToken };
    try {
      return await this.runClaimed(claim, ctx);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Another generation owns this step now; our attempt ends here.
        return 'not-claimable';
      }
      throw error;
    }
  }

  private async runClaimed(
    claim: ClaimResult,
    ctx: FencingContext,
  ): Promise<'SUCCEEDED' | 'FAILED' | 'CANCELLED'> {
    const { prisma } = this;
    const snapshotDocument = await this.loadSnapshotDocument(claim.runId);
    const step = actionForStep(snapshotDocument, claim.sequence);
    const action = step.action;

    // Worker-side environment re-validation (Phase 3 §12, ADR-0011):
    // production-classified targets are denied for execution in v1 —
    // re-checked HERE at execution time, independent of the creation-
    // time check. UI absence does not matter; this is server-side.
    if (snapshotDocument.target.environment === 'PRODUCTION') {
      await writeTerminalState(
        prisma,
        claim.stepRunId,
        {
          state: 'FAILED',
          intentOutcome: 'FAILED',
          sideEffectKnowledge: 'KNOWN_ABSENT',
          attemptCount: 0,
          error: 'worker denied execution: production-classified target (ADR-0011)',
        },
        ctx,
      );
      return 'FAILED';
    }

    // ---- Phase 9 execution-time fault-plan gate (defense in depth) ----
    // Re-derived from the FROZEN snapshot, independent of definition-time
    // validation (R-14): a fault-bearing step may execute only against a
    // LOCAL_DEVELOPMENT target. Fails the step BEFORE any delivery —
    // nothing is ever sent un-gated.
    if (
      action.faultPlan !== undefined &&
      snapshotDocument.target.environment !== 'LOCAL_DEVELOPMENT'
    ) {
      await writeTerminalState(
        prisma,
        claim.stepRunId,
        {
          state: 'FAILED',
          intentOutcome: 'FAILED',
          sideEffectKnowledge: 'KNOWN_ABSENT',
          attemptCount: 0,
          error: `controlled fault denied: faultPlan requires a LOCAL_DEVELOPMENT target (snapshot environment: ${snapshotDocument.target.environment}; ADR-0014)`,
        },
        ctx,
      );
      return 'FAILED';
    }

    await markExecuting(this.prisma, claim.stepRunId, ctx);
    this.telemetry.record({
      kind: 'step.lifecycle',
      runId: claim.runId,
      stepRunId: claim.stepRunId,
      phase: 'executing',
    });
    this.heartbeat.start(claim.stepRunId, ctx, this.config.WORKER_LEASE_DURATION_MS);

    // Best-effort disarm: whatever happens below, an armed plan must be
    // disarmed after the step leaves execution (the arming TTL bounds
    // any leakage). Disarm outcomes NEVER rewrite execution truth.
    let faultPlanArmed: NonNullable<ExperimentStep['action']['faultPlan']> | null = null;
    try {
      // ---- Cooperative cancel check (before any network work) ----
      if (await this.cancelRequested(claim.runId)) {
        await writeTerminalState(
          prisma,
          claim.stepRunId,
          {
            state: 'CANCELLED',
            intentOutcome: 'CANCELLED',
            sideEffectKnowledge: 'KNOWN_ABSENT',
            attemptCount: 0,
            error: 'run cancelled before execution',
          },
          ctx,
        );
        return 'CANCELLED';
      }

      // ---- Phase 9: arm the controlled fault BEFORE the first delivery ----
      // Arming is a HARD precondition: failure fails the step before any
      // request is sent (sideEffectKnowledge KNOWN_ABSENT — nothing left
      // the executor). The fault intent itself is already frozen in the
      // snapshot; the target validates the plan at its own boundary.
      if (action.faultPlan !== undefined) {
        if (this.controlledFaults === undefined) {
          await writeTerminalState(
            prisma,
            claim.stepRunId,
            {
              state: 'FAILED',
              intentOutcome: 'FAILED',
              sideEffectKnowledge: 'KNOWN_ABSENT',
              attemptCount: 0,
              error:
                'controlled fault plan declared but the worker has no fault-control hook configured',
            },
            ctx,
          );
          return 'FAILED';
        }
        try {
          await this.controlledFaults.arm({
            faultPlan: action.faultPlan,
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            origin: snapshotDocument.target.origin,
          });
          faultPlanArmed = action.faultPlan;
          this.telemetry.record({
            kind: 'fault.armed',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            faultKind: action.faultPlan.faultKind,
            maxTriggers: action.faultPlan.maxTriggers,
          });
        } catch (error) {
          await writeTerminalState(
            prisma,
            claim.stepRunId,
            {
              state: 'FAILED',
              intentOutcome: 'FAILED',
              sideEffectKnowledge: 'KNOWN_ABSENT',
              attemptCount: 0,
              error: `controlled fault arming failed before any delivery: ${
                error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
              }`,
            },
            ctx,
          );
          return 'FAILED';
        }
      }

      // ---- Repeat waves with bounded concurrency ----
      const repeat = Math.max(1, Math.min(action.repeat ?? 1, EXECUTION_LIMITS.maxRepeat));
      const concurrency = Math.max(
        1,
        Math.min(action.concurrency ?? 1, EXECUTION_LIMITS.maxConcurrency),
      );
      const maxAttempts = action.retryPolicy === 'SAFE' ? SAFE_RETRY_MAX_ATTEMPTS : 1;
      const waveStaggerMs = Math.max(
        0,
        Math.min(action.waveStaggerMs ?? 0, EXECUTION_LIMITS.maxWaveStaggerMs),
      );

      let waveIndex = 0;
      let attempts = 0;
      let last: ClassifyResult = {
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'NOT_APPLICABLE',
      };
      let lastError: string | null = null;
      let aggregateOk = true;

      let previousWaveStartedAt = 0;
      while (waveIndex * concurrency < repeat) {
        // Phase 9: deterministic wave staggering — each later wave starts
        // at least waveStaggerMs after the previous wave STARTED (no
        // probability; real clock only).
        if (waveIndex > 0 && waveStaggerMs > 0) {
          const waitedMs = Math.max(0, waveStaggerMs - (Date.now() - previousWaveStartedAt));
          if (waitedMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitedMs));
          }
          this.telemetry.record({
            kind: 'wave.staggered',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            waveIndex,
            staggerMs: waveStaggerMs,
            waitedMs,
          });
        }
        const waveStartedAt = Date.now();
        // Cooperative cancel between waves.
        if (await this.cancelRequested(claim.runId)) {
          const sentAnything = attempts > 0 && action.mutation === 'MUTATING';
          await writeTerminalState(
            prisma,
            claim.stepRunId,
            {
              state: 'CANCELLED',
              intentOutcome: 'CANCELLED',
              sideEffectKnowledge: sentAnything ? 'INDETERMINATE' : 'KNOWN_ABSENT',
              attemptCount: attempts,
              error: 'run cancelled mid-flight',
            },
            ctx,
          );
          return 'CANCELLED';
        }

        const waveSize = Math.min(concurrency, repeat - waveIndex * concurrency);
        const outcomes = await Promise.all(
          Array.from({ length: waveSize }, (_, slot) =>
            this.runInvocationWithRetry(
              claim,
              ctx,
              action,
              waveIndex * concurrency + slot,
              maxAttempts,
              snapshotDocument,
            ),
          ),
        );
        // attemptCount = REAL network attempts consumed (repeat slots ×
        // retries actually used), not planned repeat slots.
        for (const outcome of outcomes) {
          attempts += outcome.attemptsUsed;
        }
        for (const outcome of outcomes) {
          if (!outcome.ok) {
            aggregateOk = false;
          }
          if (outcome.sideEffectKnowledge === 'INDETERMINATE') {
            last = {
              intentOutcome: 'FAILED',
              sideEffectKnowledge: 'INDETERMINATE',
            };
          } else {
            last = {
              intentOutcome: outcome.intentOutcome,
              sideEffectKnowledge: outcome.sideEffectKnowledge,
            };
          }
          if (outcome.error !== null) {
            lastError = outcome.error;
          }
        }
        // Ordered-dependency stop policy: a failed mutating step stops
        // the step's remaining waves (and later the run FAILS).
        if (!aggregateOk) {
          break;
        }
        previousWaveStartedAt = waveStartedAt;
        waveIndex += 1;
      }

      const terminal = aggregateOk ? 'SUCCEEDED' : 'FAILED';
      const finalKnowledge: ClassifyResult['sideEffectKnowledge'] =
        last.sideEffectKnowledge === 'INDETERMINATE'
          ? 'INDETERMINATE'
          : terminal === 'SUCCEEDED'
            ? action.mutation === 'MUTATING'
              ? 'KNOWN_OCCURRED'
              : 'NOT_APPLICABLE'
            : last.sideEffectKnowledge;
      await writeTerminalState(
        prisma,
        claim.stepRunId,
        {
          state: terminal,
          intentOutcome: terminal,
          sideEffectKnowledge: finalKnowledge,
          attemptCount: attempts,
          error: lastError,
        },
        ctx,
      );
      this.telemetry.record({
        kind: 'step.lifecycle',
        runId: claim.runId,
        stepRunId: claim.stepRunId,
        phase: 'terminal',
        state: terminal,
        ...(lastError === null ? {} : { detail: lastError.slice(0, 200) }),
      });
      // Phase 9: capture the target's OWN fault-state observation AFTER
      // the terminal write for every fault-bearing step — success OR
      // failure — because configured-vs-activated truth matters most on
      // the failure paths (docs/controlled-faults.md §5). Failure to
      // capture is honest incompleteness: logged, never fatal to the
      // already-persisted step outcome, never fabricated. The engine
      // names NO adapter kind — the caller's hook owns target specifics
      // (engine stays target-agnostic).
      if (action.faultPlan !== undefined && this.captureFaultStatusAdapter !== undefined) {
        try {
          await this.captureFaultStatusAdapter({
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            origin: snapshotDocument.target.origin,
            writerOwnerId: ctx.ownerId,
            writerFencingToken: ctx.fencingToken,
          });
          this.telemetry.record({
            kind: 'fault.status.observed',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            outcome: 'captured',
          });
        } catch (error) {
          this.telemetry.record({
            kind: 'fault.status.observed',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            outcome: 'failed',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
      }
      // Ordered chaining: only a SUCCEEDED step makes the NEXT step
      // dispatchable (stop safely on dependency failures). If this
      // step FAILED/CANCELLED, no further steps dispatch; the
      // reconciler's settleRuns marks the run FAILED and the remaining
      // steps CANCELLED via cancelRequestedAt (set below on failure).
      if (terminal === 'SUCCEEDED') {
        // EXPLICIT adapter capture (§28/§29) BEFORE the next step
        // dispatches: the target's business-state observation enters
        // the evidence chain as part of THIS step's reality.
        if (action.evidenceAdapter !== undefined) {
          await this.runEvidenceAdapterCapture(
            claim,
            ctx,
            action.evidenceAdapter,
            snapshotDocument,
          );
        }
        await this.dispatchNextOrderedStep(claim.runId, claim.sequence);
      } else if (
        terminal === 'FAILED' &&
        action.evidenceAdapter !== undefined &&
        action.faultPlan !== undefined
      ) {
        // Phase 9: a FAILED fault-bearing step ALSO captures its declared
        // adapter AFTER the terminal write (docs/controlled-faults.md
        // §4.2/§4.3): for post-mutation response-loss the mutation
        // objectively committed even though the invocation stays
        // INDETERMINATE — the later inspection is separate, clearly-
        // attributed evidence of what the target REALLY did, and never
        // rewrites execution truth. Ordered chaining stays blocked (the
        // next step is NOT dispatched). Capture failure remains honest
        // incompleteness: logged, never fatal, never fabricated.
        await this.runEvidenceAdapterCapture(claim, ctx, action.evidenceAdapter, snapshotDocument);
      }
      return terminal;
    } finally {
      this.heartbeat.stop();
      // Phase 9: best-effort disarm AFTER the step leaves execution.
      // Never rethrows, never rewrites execution truth; the outcome is
      // telemetry-recorded and the arming TTL bounds any leakage.
      if (faultPlanArmed !== null && this.controlledFaults !== undefined) {
        try {
          await this.controlledFaults.disarm({
            faultKind: faultPlanArmed.faultKind,
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            origin: snapshotDocument.target.origin,
          });
          this.telemetry.record({
            kind: 'fault.disarm.outcome',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            faultKind: faultPlanArmed.faultKind,
            outcome: 'disarmed',
          });
        } catch (error) {
          this.telemetry.record({
            kind: 'fault.disarm.outcome',
            runId: claim.runId,
            stepRunId: claim.stepRunId,
            faultKind: faultPlanArmed.faultKind,
            outcome: 'failed',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
      }
    }
  }

  /**
   * Resolves the declared adapter's logical-payment identity and hands
   * the capture to the injected adapter hook. A `${steps.…}` reference
   * resolves through the SAME mechanism as body references (the
   * target's own response names the payment — identity-backed); a
   * literal is used as-is. Failure is honest incompleteness: logged,
   * never fabricated, never fatal to execution.
   */
  private async runEvidenceAdapterCapture(
    claim: ClaimResult,
    ctx: FencingContext,
    adapter: NonNullable<ExperimentStep['action']['evidenceAdapter']>,
    document: RunSnapshotDocument,
  ): Promise<void> {
    if (this.captureEvidenceAdapter === undefined) {
      return;
    }
    try {
      const providerPaymentId = adapter.providerPaymentIdFrom.startsWith('${steps.')
        ? await this.resolveBodyReferences(claim.runId, adapter.providerPaymentIdFrom)
        : adapter.providerPaymentIdFrom;
      await this.captureEvidenceAdapter({
        runId: claim.runId,
        stepRunId: claim.stepRunId,
        origin: document.target.origin,
        adapterKind: adapter.kind,
        providerPaymentId,
        writerOwnerId: ctx.ownerId,
        writerFencingToken: ctx.fencingToken,
      });
    } catch (error) {
      this.onCaptureFailure(
        { invocationIdentity: `${claim.runId}:${claim.sequence}:adapter-capture` },
        error,
      );
    }
  }

  /**
   * Makes the next ordered step dispatchable and enqueues it. The DB
   * predicate (sequence + 1, still dispatchable) is the correctness
   * gate; enqueue failure leaves it RECONCILE for the reconciler —
   * durable work is never stranded.
   */
  private async dispatchNextOrderedStep(runId: string, sequence: number): Promise<void> {
    const next = await this.prisma.experimentStepRun.findFirst({
      where: { runId, sequence: sequence + 1 },
      select: { id: true, state: true, dispatchState: true },
    });
    if (next === null || next.state !== 'PENDING' || next.dispatchState === 'DISPATCHED') {
      return; // No next step, already terminal (cancel path), or already dispatched.
    }
    const promoted = await this.prisma.experimentStepRun.updateMany({
      where: { id: next.id, dispatchState: 'PENDING' },
      data: { dispatchState: 'RECONCILE' },
    });
    if (promoted.count === 0) {
      return; // Another path (reconciler/duplicate) already claimed it.
    }
    try {
      await this.dispatchNextStep(runId, next.id);
      await this.prisma.experimentStepRun.updateMany({
        where: { id: next.id, dispatchState: 'RECONCILE' },
        data: { dispatchState: 'DISPATCHED', dispatchedAt: new Date(), lastDispatchError: null },
      });
    } catch (error) {
      // Enqueue failed (e.g. Redis down): durable RECONCILE marker
      // stays; the reconciler enqueues when Redis recovers (ADR-0003 §9).
      await this.prisma.experimentStepRun.updateMany({
        where: { id: next.id, dispatchState: 'RECONCILE' },
        data: {
          lastDispatchError:
            error instanceof Error ? error.message.slice(0, 500) : 'next-step enqueue failed',
        },
      });
    }
  }

  /**
   * One planned invocation (repeat slot) with conservative retry.
   * Records EVERY invocation row (append-only, attributed).
   */
  private async runInvocationWithRetry(
    claim: ClaimResult,
    ctx: FencingContext,
    action: ExperimentStep['action'],
    invocationIndex: number,
    maxAttempts: number,
    document: RunSnapshotDocument,
  ): Promise<{
    ok: boolean;
    attemptsUsed: number;
    intentOutcome: ClassifyResult['intentOutcome'];
    sideEffectKnowledge: ClassifyResult['sideEffectKnowledge'];
    error: string | null;
  }> {
    const { prisma } = this;
    let attemptInInvocation = 0;
    while (true) {
      attemptInInvocation += 1;
      const identity = `${claim.runId}:${claim.sequence}:${invocationIndex}:${randomUUID()}`;
      // §59: resolve ${steps.<name>.response.…} references from the
      // recorded invocations of PRIOR steps of THIS run. One small
      // typed mechanism — no arbitrary code, no general dataflow.
      const resolvedBody =
        action.body !== undefined
          ? await this.resolveBodyReferences(claim.runId, action.body)
          : undefined;
      const outcome = await executeHttp({
        action,
        origin: document.target.origin,
        contractKind: document.target.contractKind,
        environment: document.target.environment,
        invocationIdentity: identity,
        credentials: this.credentials,
        ...(resolvedBody === undefined ? {} : { resolvedBody }),
      });
      let classified: ClassifyResult;
      try {
        classified = classifyInvocation({
          mutation: action.mutation,
          contractKind: document.target.contractKind,
          transportStage: outcome.transportStage,
          intentOutcome: outcome.intentOutcome,
          httpStatus: outcome.httpStatus,
        });
        const recorded = await recordInvocation(
          prisma,
          claim.stepRunId,
          {
            // Physical invocation number: repeat slot × retry budget +
            // attempt within this slot. Every ATTEMPT (including retries)
            // is its own honest record — recordInvocation allocates the
            // next free sequence when a prior generation already recorded
            // an invocation for this slot (cross-generation recovery).
            sequence: invocationIndex * SAFE_RETRY_MAX_ATTEMPTS + attemptInInvocation,
            waveIndex: Math.floor(invocationIndex / Math.max(1, action.concurrency ?? 1)),
            invocationIdentity: identity,
            transportStage: outcome.transportStage,
            httpStatus: outcome.httpStatus,
            requestBytes: outcome.requestBytes,
            responseBytes: outcome.responseBytes,
            responseBody: outcome.responseBody,
            durationMs: outcome.durationMs,
            outcome: classified.intentOutcome,
            sideEffectKnowledge: classified.sideEffectKnowledge,
            error: outcome.error,
          },
          ctx,
        );
        // Phase 4 evidence capture: hand the sink EXACTLY what this
        // attempt observed — request bytes were as-sent (credential
        // substitution applied; the evidence layer redacts before
        // persistence), response as-received. Capture failure is
        // recorded as honest incompleteness and NEVER blocks or alters
        // execution semantics; a stale generation's truthful
        // observation is still appendable with its writer provenance
        // (§14) because the sink is not fenced.
        const observation = {
          runId: claim.runId,
          stepRunId: claim.stepRunId,
          invocationId: recorded.invocationId,
          invocationIdentity: identity,
          sequence: recorded.sequence,
          waveIndex: Math.floor(invocationIndex / Math.max(1, action.concurrency ?? 1)),
          method: action.method,
          relativePath: action.relativePath,
          requestHeaders: outcome.headersSent,
          requestBody:
            resolvedBody === undefined
              ? action.body === undefined
                ? null
                : action.body
              : resolvedBody,
          transportStage: outcome.transportStage,
          httpStatus: outcome.httpStatus,
          responseHeaders: outcome.responseHeaders,
          responseBody: outcome.responseBody,
          responseTruncated: outcome.responseTruncated,
          requestBytes: outcome.requestBytes,
          responseBytes: outcome.responseBytes,
          durationMs: outcome.durationMs,
          outcome: classified.intentOutcome === 'SUCCEEDED' ? 'SUCCEEDED' : ('FAILED' as const),
          error: outcome.error,
          observedAt: new Date(),
        } satisfies InvocationObservation;
        try {
          await this.evidenceSink.captureInvocation(observation, {
            ownerId: ctx.ownerId,
            fencingToken: ctx.fencingToken,
          });
        } catch (captureError) {
          // Honest incompleteness: the observation HAPPENED but could
          // not be durably captured. Recorded in the invocation row's
          // error field? No — that would alter execution truth. Logged;
          // the audit trail for capture failures is the worker log.
          this.onCaptureFailure(observation, captureError);
        }
        // Phase 9 telemetry: the REAL per-invocation record — transport
        // stage, status, timing, and the side-effect classification, all
        // from the outcome that was just persisted. Nothing is invented;
        // telemetry never rewrites execution truth (ADR-0015).
        this.telemetry.record({
          kind: 'invocation.executed',
          runId: claim.runId,
          stepRunId: claim.stepRunId,
          invocationIdentity: identity,
          waveIndex: Math.floor(invocationIndex / Math.max(1, action.concurrency ?? 1)),
          attempt: attemptInInvocation,
          transportStage: outcome.transportStage,
          httpStatus: outcome.httpStatus,
          durationMs: outcome.durationMs,
          intentOutcome: classified.intentOutcome,
          sideEffectKnowledge: classified.sideEffectKnowledge,
          error: outcome.error === null ? null : outcome.error.slice(0, 200),
        });
      } catch (error) {
        // Ownership lost mid-invocation (lease expired and another
        // generation claimed): stop immediately and exit without any
        // further network work. The observation of THIS invocation is
        // still recorded honestly by recordInvocation (it is not
        // fenced); only ownership-state errors propagate here.
        if (error instanceof LeaseLostError) {
          return {
            ok: false,
            attemptsUsed: attemptInInvocation,
            intentOutcome: 'FAILED',
            sideEffectKnowledge:
              action.mutation === 'MUTATING' ? 'INDETERMINATE' : 'NOT_APPLICABLE',
            error: 'lease lost after invocation; ownership no longer held',
          };
        }
        throw error;
      }
      const decision = decideRetry({
        declaredPolicy: action.retryPolicy ?? 'NONE',
        mutation: action.mutation,
        sideEffectKnowledge: classified.sideEffectKnowledge,
        intentOutcome: classified.intentOutcome,
        attemptsSoFar: attemptInInvocation,
        maxAttempts,
      });
      if (!decision.willRetry) {
        return {
          ok: classified.intentOutcome === 'SUCCEEDED',
          attemptsUsed: attemptInInvocation,
          intentOutcome: classified.intentOutcome,
          sideEffectKnowledge: classified.sideEffectKnowledge,
          error: outcome.error,
        };
      }
      // Bounded pause before a permitted retry (brief, explicit).
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async cancelRequested(runId: string): Promise<boolean> {
    const run = await this.prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    return run?.cancelRequestedAt !== null && run?.cancelRequestedAt !== undefined;
  }

  /**
   * §59: the ONLY reference grammar is ${steps.<stepName>.response.<json path>}
   * where <json path> is dot/bracket access into that step's recorded
   * responseBody (JSON). Unknown steps or paths throw BEFORE any
   * request is prepared — a missing reference must never silently
   * send a template string to the target. Credentials are never
   * injectable through body references (separate mechanism, R-13).
   */
  private async resolveBodyReferences(runId: string, body: string): Promise<string> {
    const referencePattern = /\$\{steps\.([A-Za-z0-9_-]+)\.response\.([A-Za-z0-9_.[\]]+)\}/g;
    if (!referencePattern.test(body)) {
      return body; // No references: template body as-is.
    }
    referencePattern.lastIndex = 0;
    const replacements = new Map<string, string>();
    const stepsByName = new Map<string, { stepRunId: string; sequence: number }>();
    for (const match of body.matchAll(referencePattern)) {
      const stepName = match[1];
      if (stepName === undefined || replacements.has(match[0])) {
        continue;
      }
      const target = stepsByName.get(stepName) ?? (await this.findPriorStepByName(runId, stepName));
      if (target === null) {
        throw new Error(
          `body reference "\${steps.${stepName}.response.…}" names no prior step of this run — refusing to send unresolved template`,
        );
      }
      stepsByName.set(stepName, target);
      const invocation = await this.prisma.stepInvocation.findFirst({
        where: { stepRunId: target.stepRunId, responseBody: { not: null } },
        orderBy: { sequence: 'asc' },
        select: { responseBody: true },
      });
      const resolved = extractJsonPath(invocation?.responseBody ?? null, match[2] ?? '');
      if (resolved === null) {
        throw new Error(
          `body reference "${match[0]}" could not be resolved from the recorded response of step "${stepName}"`,
        );
      }
      replacements.set(match[0], resolved);
    }
    let resolvedBody = body;
    for (const [token, value] of replacements) {
      resolvedBody = resolvedBody.split(token).join(value);
    }
    return resolvedBody;
  }

  private async findPriorStepByName(
    runId: string,
    name: string,
  ): Promise<{ stepRunId: string; sequence: number } | null> {
    const row = await this.prisma.experimentStepRun.findFirst({
      where: { runId, name, state: 'SUCCEEDED' },
      select: { id: true, sequence: true },
    });
    return row === null ? null : { stepRunId: row.id, sequence: row.sequence };
  }

  /**
   * Loads the step's own snapshot document PER CLAIM — never cached
   * across steps: one worker process executes multiple runs and the
   * origin/contract for THIS claim must be THIS run's, not whichever
   * claim last populated a shared cache (concurrency race).
   */
  private async loadSnapshotDocument(runId: string): Promise<RunSnapshotDocument> {
    const run = await this.prisma.experimentRun.findUnique({
      where: { id: runId },
      include: { snapshot: true },
    });
    if (run === null) {
      throw new Error(`run ${runId} not found`);
    }
    return run.snapshot.content as unknown as RunSnapshotDocument;
  }

  /**
   * Evidence-capture failure hook: never blocks execution, never
   * mutates execution truth. Overridable in tests; the default logs
   * bounded, secret-safe detail (the observation payload is never
   * included — it may contain pre-redaction request material).
   */
  private onCaptureFailure(observation: { invocationIdentity: string }, error: unknown): void {
    // Bounded stderr note; the bounded redacted attempt happens in the
    // evidence layer, so nothing secret-safe to print here exists.
    console.error(
      `[evidence] capture failed for invocation ${observation.invocationIdentity}: ` +
        `${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    );
  }

  private ownerId = `worker-${randomUUID()}`;

  public get id(): string {
    return this.ownerId;
  }
}

// ---------------------------------------------------------------------
// ${steps.…} response path extraction (§59). Supports dot and bracket
// access into a recorded JSON response body: a.b, a[0].b, a.b[1].
// Returns null (never throws) when the path does not resolve.
// ---------------------------------------------------------------------
export function extractJsonPath(rawBody: string | null, path: string): string | null {
  if (rawBody === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  // Prototype-traversal denial (§72: no prototype access through
  // references): `__proto__`, `constructor`, and `prototype` are not
  // data of the recorded response — a path through them resolves to
  // nothing rather than walking the object chain.
  const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    return null;
  }
  let current: unknown = parsed;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      return null;
    }
  }
  if (current === null || typeof current === 'object') {
    return JSON.stringify(current);
  }
  return String(current);
}

// ---------------------------------------------------------------------
// Heartbeat: bounded, observable, testable (Phase 3 §32). A small
// interval loop that renews the lease while the step executes; a
// LeaseLostError propagation aborts the step via the finally in
// runClaimed.
// ---------------------------------------------------------------------
class HeartbeatLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly intervalMs: number,
  ) {}

  public start(stepRunId: string, ctx: FencingContext, leaseDurationMs: number): void {
    this.stop();
    this.stopped = false;
    const tick = async (): Promise<void> => {
      try {
        await heartbeatStep(this.prisma, stepRunId, {
          ownerId: ctx.ownerId,
          fencingToken: ctx.fencingToken,
          leaseDurationMs,
        });
      } catch {
        // Renewal failed: the lease was lost (expired + taken over or
        // fenced). Stop immediately — this generation must not keep
        // doing network work it no longer owns. The step's terminal
        // write will fail fenced; the step resolves through the new
        // owner / reconciliation.
        this.stop();
      }
    };
    this.timer = setInterval(() => {
      void tick();
    }, this.intervalMs);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public get running(): boolean {
    return !this.stopped;
  }
}
