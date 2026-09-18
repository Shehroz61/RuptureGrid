// =====================================================================
// RuptureGrid v1.0 — Control Plane execution endpoints (Phase 3)
// =====================================================================
// Minimal, truthful API over the durable engine (Phase 3 §24):
//   POST /api/v1/targets                 register a target
//   GET  /api/v1/targets/:id             target details
//   POST /api/v1/experiments             create definition + revision 1
//   POST /api/v1/runs                    create run (snapshot pinned)
//   POST /api/v1/runs/:id/dispatch       mark DISPATCHING + enqueue
//   GET  /api/v1/runs/:id                truthful run + step state
//   POST /api/v1/runs/:id/cancel         request cooperative cancel
// Responses contain durable state only — no fabricated data. Request
// bodies are bounded (256kb at the app layer).

import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { ControlDb } from '@rupturegrid/control-db';
import {
  registerTarget,
  getTarget,
  createExperiment,
  createRun,
  settleCancelledRun,
  TargetRegistrationError,
  ExperimentValidationError,
  RunCreationError,
} from '@rupturegrid/engine';
import type { TargetRegistrationResult, CreatedRun } from '@rupturegrid/engine';
// createExecutionQueue is used via a lazy import inside dispatch to
// keep the controller's module-load surface honest.

export const EXECUTION_OPTIONS = Symbol('execution-options');

/** Parses a bounded non-negative integer query parameter (list routes). */
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpException(
      {
        error: {
          code: 'INVALID_PAGINATION',
          message: `${name} must be an integer in ${min}..${max}`,
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

export interface ExecutionControllerOptions {
  readonly controlDb: ControlDb;
  readonly redisUrl: string;
  readonly queuePrefix: string;
}

@Controller('api/v1')
export class ExecutionController {
  private readonly controlDb: ControlDb;
  private readonly redisUrl: string;
  private readonly queuePrefix: string;

  public constructor(@Inject(EXECUTION_OPTIONS) options: ExecutionControllerOptions) {
    this.controlDb = options.controlDb;
    this.redisUrl = options.redisUrl;
    this.queuePrefix = options.queuePrefix;
  }

  private mapError(error: unknown): never {
    if (
      error instanceof TargetRegistrationError ||
      error instanceof ExperimentValidationError ||
      error instanceof RunCreationError
    ) {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: error.message } },
        HttpStatus.BAD_REQUEST,
      );
    }
    throw error;
  }

  /**
   * Marks the run DISPATCHING and enqueues every claimable step.
   * On enqueue failure the step keeps its durable dispatch marker and
   * the run stays DISPATCHING — reconciliation recovers it (ADR-0003).
   */
  private async dispatchRunDurably(runId: string): Promise<{ enqueued: number; failed: number }> {
    const { markRunDispatching } = await import('@rupturegrid/engine');
    const { createExecutionQueue } = await import('@rupturegrid/queue');
    await markRunDispatching(this.controlDb.prisma, runId);
    // Ordered runs: only the FIRST step is enqueued; the worker chains
    // each subsequent step after its predecessor SUCCEEDS (stop safely
    // on dependency failures). A pending-and-claimable frontier check
    // (same predicate as the reconciler) keeps re-dispatch idempotent.
    const steps = (await this.controlDb.prisma.$queryRaw`
      SELECT s."id", s."sequence"
        FROM "control"."experiment_step_run" s
       WHERE s."runId" = ${runId}::uuid
         AND s."state" IN ('PENDING', 'DISPATCHED')
         AND s."dispatchState" IN ('PENDING', 'RECONCILE')
         AND NOT EXISTS (
           SELECT 1 FROM "control"."experiment_step_run" prior
            WHERE prior."runId" = s."runId"
              AND prior."sequence" < s."sequence"
              AND prior."state" <> 'SUCCEEDED'
         )
       ORDER BY s."sequence" ASC
       LIMIT 1
    `) as Array<{ id: string; sequence: number }>;
    const queue = createExecutionQueue({
      redisUrl: this.redisUrl,
      prefix: this.queuePrefix,
    });
    let enqueued = 0;
    let failed = 0;
    try {
      for (const step of steps) {
        try {
          await queue.enqueueStep({ runId, stepRunId: step.id, sequence: step.sequence });
          await this.controlDb.prisma.experimentStepRun.updateMany({
            where: { id: step.id, dispatchState: 'PENDING' },
            data: { dispatchState: 'DISPATCHED', dispatchedAt: new Date() },
          });
          enqueued += 1;
        } catch {
          failed += 1;
          await this.controlDb.prisma.experimentStepRun.updateMany({
            where: { id: step.id },
            data: { lastDispatchError: 'enqueue failed (Redis unavailable)' },
          });
        }
      }
      // When NOTHING could be enqueued but the run has steps, leave a
      // durable reconcile trail for every frontier step so recovery is
      // certain (Redis-outage creation path, Phase 3 §40).
      if (enqueued === 0 && steps.length === 0) {
        const pendingSteps = await this.controlDb.prisma.experimentStepRun.findMany({
          where: { runId, state: 'PENDING', dispatchState: 'PENDING' },
          select: { id: true },
        });
        if (pendingSteps.length > 0) {
          await this.controlDb.prisma.experimentStepRun.updateMany({
            where: { id: { in: pendingSteps.map((step) => step.id) } },
            data: {
              dispatchState: 'RECONCILE',
              lastDispatchError: 'initial dispatch enqueued nothing',
            },
          });
        }
      }
    } finally {
      await queue.close();
    }
    return { enqueued, failed };
  }

  @Post('targets')
  public async register(@Body() body: unknown): Promise<TargetRegistrationResult> {
    const input = body as {
      displayName?: unknown;
      environment?: unknown;
      origins?: unknown;
      contractKind?: unknown;
      credentialRefs?: unknown;
    };
    try {
      return await registerTarget(this.controlDb.prisma, {
        displayName: String(input.displayName ?? ''),
        environment: input.environment as never,
        origins: Array.isArray(input.origins) ? (input.origins as string[]) : [],
        contractKind: input.contractKind as never,
        ...(Array.isArray(input.credentialRefs)
          ? { credentialRefs: input.credentialRefs as string[] }
          : {}),
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Get('targets/:id')
  public async getTargetById(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await getTarget(this.controlDb.prisma, id);
    } catch (error) {
      if (error instanceof TargetRegistrationError) {
        throw new HttpException(
          { error: { code: 'NOT_FOUND', message: error.message } },
          HttpStatus.NOT_FOUND,
        );
      }
      throw error;
    }
  }

  @Post('experiments')
  public async createExperimentEndpoint(@Body() body: unknown) {
    const input = body as {
      name?: unknown;
      description?: unknown;
      targetId?: unknown;
      document?: unknown;
    };
    if (typeof input.targetId !== 'string') {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: 'targetId is required' } },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await createExperiment(this.controlDb.prisma, {
        name: String(input.name ?? ''),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        targetId: input.targetId,
        document: input.document,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post('runs')
  public async createRunEndpoint(@Body() body: unknown): Promise<CreatedRun> {
    const input = body as { revisionId?: unknown };
    if (typeof input.revisionId !== 'string') {
      throw new HttpException(
        { error: { code: 'VALIDATION_FAILED', message: 'revisionId is required' } },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await createRun(this.controlDb.prisma, input.revisionId);
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post('runs/:id/dispatch')
  public async dispatch(@Param('id', ParseUUIDPipe) runId: string) {
    const run = await this.controlDb.prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { id: true, state: true },
    });
    if (run === null) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: `run ${runId} does not exist` } },
        HttpStatus.NOT_FOUND,
      );
    }
    if (run.state !== 'SNAPSHOT_PINNED') {
      throw new HttpException(
        {
          error: {
            code: 'INVALID_STATE',
            message: `run is ${run.state}; only SNAPSHOT_PINNED runs can be dispatched`,
          },
        },
        HttpStatus.CONFLICT,
      );
    }
    const result = await this.dispatchRunDurably(runId);
    return {
      runId,
      state: 'DISPATCHING',
      enqueued: result.enqueued,
      enqueueFailures: result.failed,
      note:
        result.failed > 0
          ? 'some steps could not be enqueued; the run stays durable in DISPATCHING and reconciliation will recover them'
          : null,
    };
  }

  /**
   * Run list (Phase 6 UI input): truthful, bounded, newest-first.
   * Every column is durable Control-Plane state — no derived
   * percentages, no health scores. Pagination is offset/limit with
   * server-side bounds; `total` is reported so the UI can render
   * honest coverage ("showing X–Y of Z"), never a fake infinite list.
   */
  @Get('runs')
  public async listRuns(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const take = parseBoundedInt(limit, 50, 1, 200, 'limit');
    const skip = parseBoundedInt(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const [total, runs] = await Promise.all([
      this.controlDb.prisma.experimentRun.count(),
      this.controlDb.prisma.experimentRun.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        skip,
        select: {
          id: true,
          state: true,
          createdAt: true,
          terminalAt: true,
          failureReason: true,
          cancelRequestedAt: true,
          snapshot: {
            select: {
              contentHash: true,
              revision: {
                select: {
                  id: true,
                  revisionNumber: true,
                  definition: { select: { id: true, name: true } },
                  target: { select: { displayName: true, environment: true } },
                },
              },
            },
          },
          steps: { select: { state: true, sideEffectKnowledge: true } },
          _count: { select: { findings: true } },
        },
      }),
    ]);
    return {
      total,
      count: runs.length,
      offset: skip,
      limit: take,
      runs: runs.map((run) => ({
        runId: run.id,
        state: run.state,
        createdAt: run.createdAt,
        terminalAt: run.terminalAt,
        failureReason: run.failureReason,
        cancelRequestedAt: run.cancelRequestedAt,
        snapshotContentHash: run.snapshot.contentHash,
        revisionId: run.snapshot.revision.id,
        revisionNumber: run.snapshot.revision.revisionNumber,
        experimentId: run.snapshot.revision.definition.id,
        experimentName: run.snapshot.revision.definition.name,
        targetDisplayName: run.snapshot.revision.target.displayName,
        targetEnvironment: run.snapshot.revision.target.environment,
        stepCount: run.steps.length,
        succeededStepCount: run.steps.filter((step) => step.state === 'SUCCEEDED').length,
        failedStepCount: run.steps.filter((step) => step.state === 'FAILED').length,
        indeterminateStepCount: run.steps.filter(
          (step) => step.sideEffectKnowledge === 'INDETERMINATE',
        ).length,
        findingCount: run._count.findings,
      })),
    };
  }

  /**
   * Experiment definition list (Phase 6 UI input): the versioned
   * definitions that runs execute. Truthful counts only; the latest
   * revision is included so the UI can show which revision is current
   * without implying that older revisions vanished (append-only).
   */
  @Get('experiments')
  public async listExperiments(@Query('limit') limit?: string) {
    const take = parseBoundedInt(limit, 50, 1, 200, 'limit');
    const [total, definitions] = await Promise.all([
      this.controlDb.prisma.experimentDefinition.count(),
      this.controlDb.prisma.experimentDefinition.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          revisions: {
            orderBy: { revisionNumber: 'desc' },
            take: 1,
            select: {
              id: true,
              revisionNumber: true,
              createdAt: true,
              target: { select: { displayName: true, environment: true } },
            },
          },
          _count: { select: { revisions: true } },
        },
      }),
    ]);
    const definitionsOut = await Promise.all(
      definitions.map(async (definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        createdAt: definition.createdAt,
        revisionCount: definition._count.revisions,
        latestRevision: definition.revisions[0] === undefined ? null : definition.revisions[0],
        runCount: await this.controlDb.prisma.experimentRun.count({
          where: { snapshot: { revision: { definitionId: definition.id } } },
        }),
      })),
    );
    return { total, count: definitionsOut.length, limit: take, experiments: definitionsOut };
  }

  @Get('runs/:id')
  public async runStatus(@Param('id', ParseUUIDPipe) runId: string) {
    const run = await this.controlDb.prisma.experimentRun.findUnique({
      where: { id: runId },
      include: {
        snapshot: { select: { contentHash: true, canonicalization: true } },
        steps: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            name: true,
            state: true,
            intentOutcome: true,
            sideEffectKnowledge: true,
            attemptCount: true,
            error: true,
            dispatchState: true,
            leaseOwnerId: true,
            leaseExpiresAt: true,
            fencingToken: true,
          },
        },
      },
    });
    if (run === null) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: `run ${runId} does not exist` } },
        HttpStatus.NOT_FOUND,
      );
    }
    const indeterminateCount = await this.controlDb.prisma.stepInvocation.count({
      where: { stepRun: { runId }, sideEffectKnowledge: 'INDETERMINATE' },
    });
    return {
      runId: run.id,
      state: run.state,
      snapshotHash: run.snapshot.contentHash,
      canonicalization: run.snapshot.canonicalization,
      cancelRequestedAt: run.cancelRequestedAt,
      failureReason: run.failureReason,
      createdAt: run.createdAt,
      terminalAt: run.terminalAt,
      steps: run.steps.map((step) => ({
        ...step,
        // BigInt fencing tokens are not JSON-serializable; the durable
        // value is exposed exactly, as a decimal string.
        fencingToken: step.fencingToken.toString(),
      })),
      indeterminateInvocationCount: indeterminateCount,
    };
  }

  @Post('runs/:id/cancel')
  public async cancel(@Param('id', ParseUUIDPipe) runId: string) {
    const run = await this.controlDb.prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { id: true, state: true },
    });
    if (run === null) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: `run ${runId} does not exist` } },
        HttpStatus.NOT_FOUND,
      );
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      return { runId, state: run.state, note: 'run already terminal' };
    }
    // For non-RUNNING runs (never dispatched), settle immediately;
    // RUNNING runs get cancelRequestedAt and workers settle at
    // cooperative cancel points.
    if (run.state !== 'RUNNING') {
      await settleCancelledRun(this.controlDb.prisma, runId);
      return { runId, state: 'CANCELLED', note: 'run cancelled before execution' };
    }
    await this.controlDb.prisma.experimentRun.update({
      where: { id: runId },
      data: { cancelRequestedAt: new Date() },
    });
    return {
      runId,
      state: 'RUNNING',
      note: 'cancel requested; workers stop at cooperative cancel points',
    };
  }
}
