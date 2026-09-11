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
import { executeHttp, CredentialResolutionError } from './executor.js';
import type { CredentialResolver } from './executor.js';

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
}

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

  public constructor(deps: StepProcessorDeps) {
    this.prisma = deps.prisma;
    this.config = deps.config;
    this.credentials = deps.credentials;
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

    await markExecuting(this.prisma, claim.stepRunId, ctx);
    this.heartbeat.start(claim.stepRunId, ctx, this.config.WORKER_LEASE_DURATION_MS);

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

      // ---- Repeat waves with bounded concurrency ----
      const repeat = Math.max(1, Math.min(action.repeat ?? 1, EXECUTION_LIMITS.maxRepeat));
      const concurrency = Math.max(
        1,
        Math.min(action.concurrency ?? 1, EXECUTION_LIMITS.maxConcurrency),
      );
      const maxAttempts = action.retryPolicy === 'SAFE' ? SAFE_RETRY_MAX_ATTEMPTS : 1;

      let waveIndex = 0;
      let attempts = 0;
      let last: ClassifyResult = {
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'NOT_APPLICABLE',
      };
      let lastError: string | null = null;
      let aggregateOk = true;

      while (waveIndex * concurrency < repeat) {
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
      // Ordered chaining: only a SUCCEEDED step makes the NEXT step
      // dispatchable (stop safely on dependency failures). If this
      // step FAILED/CANCELLED, no further steps dispatch; the
      // reconciler's settleRuns marks the run FAILED and the remaining
      // steps CANCELLED via cancelRequestedAt (set below on failure).
      if (terminal === 'SUCCEEDED') {
        await this.dispatchNextOrderedStep(claim.runId, claim.sequence);
      }
      return terminal;
    } finally {
      this.heartbeat.stop();
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
        await recordInvocation(
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
