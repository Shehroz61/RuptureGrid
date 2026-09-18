// =====================================================================
// RuptureGrid v1.0 — Forensic analysis read/trigger APIs (Phase 5)
// =====================================================================
// Deterministic, truthful investigation surfaces over the accepted
// Phase 3/4 truth. Findings and timeline entries are DURABLE DERIVED
// rows — this layer returns stored state, never re-derives on read
// (re-derivation happens only through the explicit trigger) and never
// recomputes a verdict (one business truth engine, §37).
//
// Every route validates pagination bounds and returns ONLY stored,
// already-redacted content. No secret values exist anywhere downstream
// of the evidence store (ADR-0012); there is nothing to leak.

import {
  Controller,
  ForbiddenException,
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
  deriveRunForensics,
  loadFindingProof,
  compareRuns,
  ForensicDerivationError,
  RunComparisonError,
} from '@rupturegrid/forensics';

export const FORENSICS_OPTIONS = Symbol('forensics-options');

export interface ForensicsControllerOptions {
  readonly controlDb: ControlDb;
}

/** Pagination bounds (§61): bounded page sizes, no unbounded reads. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

function parsePaging(query: { limit?: string | undefined; cursor?: string | undefined }): {
  take: number;
  cursor: string | null;
} {
  const raw = query.limit === undefined || query.limit === '' ? NaN : Number(query.limit);
  const limit = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_PAGE_SIZE;
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new HttpException(
      { error: { code: 'INVALID_PAGINATION', message: `limit must be 1..${MAX_PAGE_SIZE}` } },
      HttpStatus.BAD_REQUEST,
    );
  }
  return { take: limit, cursor: query.cursor ?? null };
}

/**
 * Global findings index (Phase 6 UI input): every persisted Finding
 * across runs, newest first, with the run context an investigator
 * needs to decide where to look. Read-only over stored rows; verdict
 * semantics remain those of the referenced evaluations (never recomputed).
 * Bounded offset pagination like the runs list.
 */
@Controller('api/v1/findings')
export class FindingsIndexController {
  private readonly controlDb: ControlDb;

  public constructor(@Inject(FORENSICS_OPTIONS) options: ForensicsControllerOptions) {
    this.controlDb = options.controlDb;
  }

  @Get()
  public async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const rawLimit = limit === undefined || limit === '' ? NaN : Number(limit);
    const take = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
    if (take < 1 || take > MAX_PAGE_SIZE) {
      throw new HttpException(
        { error: { code: 'INVALID_PAGINATION', message: `limit must be 1..${MAX_PAGE_SIZE}` } },
        HttpStatus.BAD_REQUEST,
      );
    }
    const rawOffset = offset === undefined || offset === '' ? 0 : Number(offset);
    if (!Number.isInteger(rawOffset) || rawOffset < 0) {
      throw new HttpException(
        { error: { code: 'INVALID_PAGINATION', message: 'offset must be a non-negative integer' } },
        HttpStatus.BAD_REQUEST,
      );
    }
    const skip = rawOffset;
    const [total, rows] = await Promise.all([
      this.controlDb.prisma.finding.count(),
      this.controlDb.prisma.finding.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        skip,
        include: {
          run: {
            select: {
              id: true,
              state: true,
              createdAt: true,
              snapshot: {
                select: {
                  contentHash: true,
                  revision: {
                    select: {
                      definition: { select: { id: true, name: true } },
                      target: { select: { displayName: true, environment: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    return {
      total,
      count: rows.length,
      offset: skip,
      limit: take,
      findings: rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        runState: row.run.state,
        runCreatedAt: row.run.createdAt,
        experimentName: row.run.snapshot.revision.definition.name,
        targetDisplayName: row.run.snapshot.revision.target.displayName,
        targetEnvironment: row.run.snapshot.revision.target.environment,
        snapshotContentHash: row.run.snapshot.contentHash,
        invariantKey: row.invariantKey,
        evaluatorVersion: row.evaluatorVersion,
        findingRuleVersion: row.findingRuleVersion,
        subjectKey: row.subjectKey,
        reasonCode: row.reasonCode,
        title: row.title,
        summary: row.summary,
        createdAt: row.createdAt,
      })),
    };
  }
}

@Controller('api/v1/runs/:runId/forensics')
export class ForensicsController {
  private readonly controlDb: ControlDb;

  public constructor(@Inject(FORENSICS_OPTIONS) options: ForensicsControllerOptions) {
    this.controlDb = options.controlDb;
  }

  private async requireRun(runId: string): Promise<void> {
    const run = await this.controlDb.prisma.experimentRun.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (run === null) {
      throw new HttpException(
        { error: { code: 'NOT_FOUND', message: `run ${runId} does not exist` } },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * Derivation trigger (§20): deterministic, idempotent. Repeated
   * calls converge (database-constraint idempotency); failures leave
   * Phase 3/4 truth untouched.
   */
  @Post('derive')
  public async derive(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    try {
      return await deriveRunForensics(this.controlDb.prisma, runId);
    } catch (error) {
      if (error instanceof ForensicDerivationError) {
        throw new HttpException(
          { error: { code: 'DERIVATION_FAILED', message: error.message } },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Findings for the run (deterministic order: createdAt, id). */
  @Get('findings')
  public async findings(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const rows = await this.controlDb.prisma.finding.findMany({
      where: { runId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { evidenceRefs: { orderBy: { position: 'asc' } } },
    });
    return {
      runId,
      count: rows.length,
      findings: rows.map((row) => ({
        id: row.id,
        invariantEvaluationId: row.invariantEvaluationId,
        invariantKey: row.invariantKey,
        evaluatorVersion: row.evaluatorVersion,
        findingRuleVersion: row.findingRuleVersion,
        subjectKey: row.subjectKey,
        reasonCode: row.reasonCode,
        title: row.title,
        summary: row.summary,
        inputFingerprint: row.inputFingerprint,
        details: row.details,
        provenScope: row.provenScope,
        uncertainScope: row.uncertainScope,
        proofReferences: row.evidenceRefs.map((reference) => ({
          subject: reference.subject,
          sourceId: reference.sourceId,
          role: reference.role,
          position: reference.position,
        })),
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * One Finding's complete proof (§54): the authoritative evaluation,
   * the rule identity, the confidence scope, and every proof reference
   * resolved to its durable row id / observation contentHash.
   */
  @Get('findings/:findingId')
  public async findingDetail(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
  ) {
    await this.requireRun(runId);
    const proof = await loadFindingProof(this.controlDb.prisma, findingId);
    if (proof === null || proof.runId !== runId) {
      throw new HttpException(
        {
          error: {
            code: 'NOT_FOUND',
            message: `finding ${findingId} does not exist for run ${runId}`,
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return proof;
  }

  /**
   * The forensic timeline (§19–§28): persisted derived entries in the
   * deterministic total order (occurredAt, orderingBasis, sourceKind,
   * sourceId, entryKind), keyset-paginated and bounded (§61). Causal
   * claims are returned ONLY as the run's CausalRelationship
   * references — adjacency here asserts nothing (§23).
   */
  @Get('timeline')
  public async timeline(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('subjectKey') subjectKey?: string,
  ) {
    await this.requireRun(runId);
    const { take } = parsePaging({ limit });
    // Keyset pagination over the FULL composite sort key via a raw
    // tuple comparison (Prisma 7's typed API cannot express enum `gt`):
    // (occurredAt, sourceKind, sourceId, entryKind) > cursor — precise,
    // parameterized, index-friendly. An occurredAt-only cursor would
    // skip tied rows (§61: pagination must be complete).
    let tuplePredicate = '';
    const parameters: unknown[] = [runId, take];
    if (cursor !== undefined && cursor !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw new HttpException(
          { error: { code: 'INVALID_PAGINATION', message: 'malformed cursor' } },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 4 ||
        parsed.some((part) => typeof part !== 'string')
      ) {
        throw new HttpException(
          { error: { code: 'INVALID_PAGINATION', message: 'malformed cursor' } },
          HttpStatus.BAD_REQUEST,
        );
      }
      const [cursorAt, cursorSourceKind, cursorSourceId, cursorEntryKind] = parsed as [
        string,
        string,
        string,
        string,
      ];
      const at = new Date(cursorAt);
      if (Number.isNaN(at.getTime())) {
        throw new HttpException(
          { error: { code: 'INVALID_PAGINATION', message: 'malformed cursor' } },
          HttpStatus.BAD_REQUEST,
        );
      }
      // Enum values are validated against the known kinds — they are
      // bound as typed casts, never interpolated as SQL.
      const allowedSourceKinds = [
        'RUN',
        'STEP_RUN',
        'INVOCATION',
        'RAW_OBSERVATION',
        'NORMALIZED_EVENT',
        'CAUSAL_RELATIONSHIP',
        'INVARIANT_EVALUATION',
        'FINDING',
      ];
      const allowedEntryKinds = [
        'RUN_TERMINAL_STATE',
        'STEP_TERMINAL_STATE',
        'INVOCATION_EXECUTED',
        'HTTP_REQUEST_OBSERVED',
        'HTTP_RESPONSE_OBSERVED',
        'EXECUTOR_ERROR_OBSERVED',
        'PROVIDER_PAYMENT_OBSERVED',
        'PROVIDER_EVENT_OBSERVED',
        'WEBHOOK_DELIVERY_OBSERVED',
        'PROCESSING_ATTEMPT_OBSERVED',
        'FINANCIAL_EFFECT_OBSERVED',
        'LEDGER_ENTRY_OBSERVED',
        'TARGET_STATE_OBSERVED',
        'PAYMENT_DELIVERY_OBSERVED',
        'INVARIANT_EVALUATED',
        'FINDING_DERIVED',
      ];
      if (
        !allowedSourceKinds.includes(cursorSourceKind) ||
        !allowedEntryKinds.includes(cursorEntryKind)
      ) {
        throw new HttpException(
          { error: { code: 'INVALID_PAGINATION', message: 'malformed cursor' } },
          HttpStatus.BAD_REQUEST,
        );
      }
      parameters.push(at, cursorSourceKind, cursorSourceId, cursorEntryKind);
      tuplePredicate =
        ` AND ("occurredAt", "sourceKind", "sourceId", "entryKind") > ` +
        `($3::timestamptz, $4::"analysis"."EvidenceSubjectKind", $5::text, $6::"analysis"."TimelineEntryKind")`;
    }
    const hasSubject = subjectKey !== undefined && subjectKey !== '';
    const subjectParameter = parameters.length + 1; // next positional slot
    const subjectPredicate = hasSubject ? ` AND "subjectKey" = $${subjectParameter}::text` : '';
    if (hasSubject) {
      parameters.push(subjectKey);
    }
    const rows = (await this.controlDb.prisma.$queryRawUnsafe(
      `SELECT * FROM analysis.forensic_timeline_entry WHERE "runId" = $1::uuid${tuplePredicate}${subjectPredicate} ` +
        `ORDER BY "occurredAt", "sourceKind", "sourceId", "entryKind" LIMIT $2::int`,
      ...parameters,
    )) as Array<{
      id: string;
      runId: string;
      derivationVersion: string;
      entryKind: string;
      sourceKind: string;
      sourceId: string;
      orderingBasis: string;
      sequenceNumber: number;
      occurredAt: Date;
      timeMeaning: string;
      subjectKey: string | null;
      details: unknown;
    }>;
    // Keyset cursor over the FULL composite sort key (occurredAt,
    // sourceKind, sourceId, entryKind): an occurredAt-only cursor
    // would skip tied rows (§61: pagination must be complete).
    const last = rows.at(-1);
    const cursorOf = (row: {
      occurredAt: Date;
      sourceKind: string;
      sourceId: string;
      entryKind: string;
    }): string =>
      Buffer.from(
        JSON.stringify([row.occurredAt.toISOString(), row.sourceKind, row.sourceId, row.entryKind]),
        'utf8',
      ).toString('base64url');
    return {
      runId,
      derivationVersions: [...new Set(rows.map((row) => row.derivationVersion))].sort(),
      count: rows.length,
      nextCursor: rows.length === take && last !== undefined ? cursorOf(last) : null,
      entries: rows.map((row) => ({
        entryKind: row.entryKind,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        orderingBasis: row.orderingBasis,
        sequenceNumber: row.sequenceNumber,
        occurredAt: row.occurredAt,
        timeMeaning: row.timeMeaning,
        subjectKey: row.subjectKey,
        details: row.details,
      })),
    };
  }

  /** The run's causal claims (Phase 4 relationships) — the ONLY causal truth. */
  @Get('causal-relationships')
  public async causalRelationships(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const rows = await this.controlDb.prisma.causalRelationship.findMany({
      where: { runId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      runId,
      count: rows.length,
      relationships: rows.map((row) => ({
        id: row.id,
        fromEventId: row.fromEventId,
        toEventId: row.toEventId,
        relationKind: row.relationKind,
        basis: row.basis,
        evidence: row.evidenceJson,
      })),
    };
  }

  /** The run's reproduction definition (incident-replay §1). */
  @Get('reproduction-definition')
  public async reproductionDefinition(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const row = await this.controlDb.prisma.reproductionDefinition.findUnique({
      where: { runId },
    });
    if (row === null) {
      throw new HttpException(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'reproduction definition not yet derived for this run',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      runId: row.runId,
      snapshotId: row.snapshotId,
      snapshotContentHash: row.snapshotContentHash,
      targetModeRequirement: row.targetModeRequirement,
      credentialRefs: row.credentialRefs,
      invariantBindings: row.invariantBindings,
      acceptanceExpectations: row.acceptanceExpectations,
      createdAt: row.createdAt,
    };
  }

  /**
   * Run comparison (incident-replay §6): computed on read from the two
   * runs' persisted verdicts. Refuses cross-intent comparisons.
   */
  @Get('compare/:otherRunId')
  public async compare(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('otherRunId', ParseUUIDPipe) otherRunId: string,
  ) {
    await this.requireRun(runId);
    try {
      const result = await compareRuns(this.controlDb.prisma, runId, otherRunId);
      if (!result.snapshotComparison.sameIntent) {
        throw new ForbiddenException({
          error: {
            code: 'SNAPSHOT_MISMATCH',
            message: 'runs have different snapshot content hashes; comparison is not meaningful',
          },
        });
      }
      return result;
    } catch (error) {
      if (error instanceof RunComparisonError) {
        throw new HttpException(
          { error: { code: 'COMPARISON_FAILED', message: error.message } },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }
}
