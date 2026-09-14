// =====================================================================
// RuptureGrid v1.0 — Evidence/Analysis read APIs (Phase 4)
// =====================================================================
// Deterministic, truthful read surfaces over the evidence and analysis
// bounded contexts (Phase 4 §22): raw observations, normalized events,
// causal relationships, invariant evaluations, and the integrity
// verifier. Every row returned is durable stored state — nothing is
// computed or embellished here. Payloads were REDACTED before
// persistence; this layer cannot un-redact them.
//
// Deliberately ABSENT (R-01 phase boundary): findings, severities,
// "CRITICAL", timeline/forensic presentation, AI surfaces.

import {
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
import { runRunAnalysis, verifyRunEvidenceChain, AnalysisError } from '@rupturegrid/evidence';

export const EVIDENCE_OPTIONS = Symbol('evidence-options');

export interface EvidenceControllerOptions {
  readonly controlDb: ControlDb;
}

@Controller('api/v1/runs/:runId')
export class EvidenceController {
  private readonly controlDb: ControlDb;

  public constructor(@Inject(EVIDENCE_OPTIONS) options: EvidenceControllerOptions) {
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

  /** Raw observations: the stored REDACTED representations + chain metadata. */
  @Get('observations')
  public async observations(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query('kind') kind: string | undefined,
  ) {
    await this.requireRun(runId);
    const rows = await this.controlDb.prisma.rawObservation.findMany({
      where: { runId, ...(kind !== undefined && kind !== '' ? { kind: kind as never } : {}) },
      orderBy: { chainIndex: 'asc' },
    });
    return {
      runId,
      count: rows.length,
      observations: rows.map((row) => ({
        id: row.id,
        chainIndex: row.chainIndex,
        kind: row.kind,
        adapterKind: row.adapterKind,
        schemaVersion: row.schemaVersion,
        observedAt: row.observedAt,
        payload: row.payload,
        redactionApplied: row.redactionApplied,
        redactionPolicyVersion: row.redactionPolicyVersion,
        truncated: row.truncated,
        contentHash: row.contentHash,
        prevContentHash: row.prevContentHash,
        origin: row.origin,
        writerOwnerId: row.writerOwnerId,
        writerFencingToken: row.writerFencingToken?.toString() ?? null,
        createdAt: row.createdAt,
      })),
    };
  }

  /** Normalized events (DETERMINISTIC_DERIVED projections). */
  @Get('events')
  public async events(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const rows = await this.controlDb.prisma.normalizedEvent.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      runId,
      count: rows.length,
      events: rows.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        subjectKey: row.subjectKey,
        payload: row.payload,
        normalizerName: row.normalizerName,
        normalizerVersion: row.normalizerVersion,
        inputHash: row.inputHash,
        origin: row.origin,
        sourceObservationHashes: row.sourceObservationHashes,
        primaryObservationIndex: row.primaryObservationIndex,
        createdAt: row.createdAt,
      })),
    };
  }

  /** Causal relationships with their explicit attribution bases. */
  @Get('relationships')
  public async relationships(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const rows = await this.controlDb.prisma.causalRelationship.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
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
        createdAt: row.createdAt,
      })),
    };
  }

  /** Invariant evaluations (deterministic verdicts; NOT findings). */
  @Get('invariants')
  public async invariants(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    const batches = await this.controlDb.prisma.evaluationBatch.findMany({
      where: { runId },
      orderBy: { startedAt: 'asc' },
      include: {
        evaluations: { orderBy: { createdAt: 'asc' } },
      },
    });
    return {
      runId,
      batches: batches.map((batch) => ({
        batchId: batch.id,
        invariantKey: batch.invariantKey,
        evaluatorVersion: batch.evaluatorVersion,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
        evaluationCount: batch.evaluationCount,
        evaluations: batch.evaluations.map((evaluation) => ({
          id: evaluation.id,
          subjectKey: evaluation.subjectKey,
          verdict: evaluation.verdict,
          reason: evaluation.reason,
          evidenceSetHash: evaluation.evidenceSetHash,
          completenessBasis: evaluation.completenessBasis,
          details: evaluation.details,
          sourceObservationHashes: evaluation.sourceObservationHashes,
          normalizedEventIds: evaluation.normalizedEventIds,
          causalRelationshipIds: evaluation.causalRelationshipIds,
          createdAt: evaluation.createdAt,
        })),
      })),
    };
  }

  /** Deterministic analysis trigger (derivation + evaluation, idempotent). */
  @Post('analyze')
  public async analyze(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    try {
      return await runRunAnalysis(this.controlDb.prisma, runId);
    } catch (error) {
      if (error instanceof AnalysisError) {
        throw new HttpException(
          { error: { code: 'ANALYSIS_FAILED', message: error.message } },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Integrity verification: recompute the run's evidence chain (read-only). */
  @Get('integrity')
  public async integrity(@Param('runId', ParseUUIDPipe) runId: string) {
    await this.requireRun(runId);
    return verifyRunEvidenceChain(this.controlDb.prisma, runId);
  }
}
