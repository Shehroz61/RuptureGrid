// =====================================================================
// Integration — Phase 17 Checkpoint E3: the isolated D-20
// proof-current / pointer-stale pair (ADR-0026 §13–§15)
// =====================================================================
// Checkpoint D exercised the composite refusal path (P/D components)
// but never constructed the isolated pair: the gated writers always
// move proof and pointers together, so the pair is built here as an
// EXPLICITLY LABELED detector probe (the D-10 precedent): only the
// pointer watermark columns are edited (same analysisGeneration, same
// evaluation rows, same proof rows), everything is restored in a
// `finally`, and no business claim is derived from the probed state.
// The FAIL verdicts below are REAL durable verdicts of a genuinely
// vulnerable run — never invented.
//
// CASE A (proof watermark current, a required pointer watermark stale,
// the stale pointer naming a FAIL): the stale FAIL must never be
// trusted as a current eligible FAIL — and the run must never exit 0.
// Expected: detector RETRY/WATERMARK_STALE, classification exit 2.
//
// CASE B (an independently trusted current eligible FAIL alongside a
// separate stale pointer): ADR-0019 precedence over genuinely trusted
// current verdicts only — the trusted FAIL establishes exit 1, while
// an execution/integrity failure still dominates (exit 3). The trust
// of the FAIL is explicit: its pointer watermark equals the locked
// composite watermark in every component (proven from durable rows),
// while the stale pointer's does not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createControlDb } from '@rupturegrid/control-db';
import { recordInvocation, registerTarget, TargetRegistrationError } from '@rupturegrid/engine';
import {
  createEngineEvidenceSink,
  readTruthInputWatermark,
  runRunAnalysis,
  verifyRunEvidenceChain,
  authorizeReportFinalization,
} from '@rupturegrid/evidence';
import type { ReportReadDb } from '@rupturegrid/evidence';
import {
  boundInvariantKeysOf,
  buildReport,
  classifyExit,
  executeScenario,
  loadFrozenReportInputs,
  resolveTargetByDisplayName,
  validateReportAgainstSchema,
  validateScenarioDocument,
} from '@rupturegrid/cli';
import type { FrozenReportInputs, ScenarioDocument } from '@rupturegrid/cli';
import type { BoundKeyDomain, ExitAnomaly, SubjectVerdict } from '@rupturegrid/cli';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import {
  getControlPrisma,
  testTargetOriginCredentialPolicy,
  waitFor,
} from './helpers/execution-harness.js';
import { loadCommerceManifest, startCommerceProcess } from './helpers/commerce-harness.js';
import type { RunningCommerce } from './helpers/commerce-harness.js';
import { provisionThrowawayCommerceDb } from './helpers/commerce-db-provision.js';
import type { ProvisionedCommerceDb } from './helpers/commerce-db-provision.js';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';

const prisma = getControlPrisma();
const COMMERCE_SIGNING_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const COMMERCE_ADMIN_REF = 'COMMERCE_ADMIN_TOKEN';
const GOLDEN_SCENARIOS = join('packages', 'cli', 'scenarios');

let env: TestEnv;
let running: RunningCommerce;
let throwawayDb: ProvisionedCommerceDb | null = null;
let worker: ChildProcess | null = null;
let workerStdout = '';
let workDir = '';
let e2eTargetName = '';
let targetId = '';
let credentialPolicy: TargetOriginCredentialPolicy;

const suiteToken = `e3${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
const suiteScopeToken = `checkout-zero-e3-${suiteToken}`;
const suiteSku = `SKU-E3-${suiteToken}`;
let scenarioCounter = 0;

async function reboundScenario(
  sourceName: string,
): Promise<{ path: string; document: ScenarioDocument }> {
  const raw = await readFile(join(GOLDEN_SCENARIOS, sourceName), 'utf8');
  const document = JSON.parse(raw) as Record<string, unknown>;
  (document['target'] as Record<string, unknown>)['displayName'] = e2eTargetName;
  scenarioCounter += 1;
  const perFile = `${suiteToken}-${String(scenarioCounter)}`;
  const intentFor = (): string => `CHK-${perFile}`;
  const experiment = document['experiment'] as Record<string, unknown>;
  for (const step of experiment['steps'] as Array<Record<string, unknown>>) {
    const action = step['action'] as Record<string, unknown>;
    if (typeof action['body'] !== 'string') {
      continue;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(action['body'] as string) as Record<string, unknown>;
    } catch {
      continue;
    }
    let rebound = false;
    if (typeof body['scopeToken'] === 'string') {
      body['scopeToken'] = suiteScopeToken;
      rebound = true;
    }
    if (typeof body['sku'] === 'string') {
      body['sku'] = suiteSku;
      rebound = true;
    }
    if (typeof body['checkoutIntentId'] === 'string') {
      body['checkoutIntentId'] = intentFor();
      rebound = true;
    }
    if (rebound) {
      action['body'] = JSON.stringify(body);
    }
  }
  const runScope = experiment['runScope'] as Record<string, unknown> | undefined;
  if (runScope !== undefined && runScope !== null) {
    runScope['declaredScope'] = suiteScopeToken;
    const declared = runScope['subjects'] as Record<string, string[]> | undefined;
    for (const [key, subjects] of Object.entries(declared ?? {})) {
      declared![key] = subjects.map((subject) =>
        subject === 'SKU-001' ? suiteSku : subject.startsWith('CHK') ? intentFor() : subject,
      );
    }
  }
  document['name'] = `${String(document['name'])}-e3-${perFile}`;
  const path = join(workDir, `${sourceName}-${String(scenarioCounter)}`);
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8');
  return { path, document: validateScenarioDocument(document) };
}

async function runScenario(sourceName: string): Promise<{
  runId: string;
  exitCode: number;
  outcome: Awaited<ReturnType<typeof executeScenario>>;
}> {
  const scenario = await reboundScenario(sourceName);
  const outcome = await executeScenario(prisma, scenario.document, {
    redisUrl: env.redisUrl,
    queuePrefix: env.queuePrefix,
    credentialPolicy,
    runTimeoutMs: 90_000,
    analysisTimeoutMs: 60_000,
    pollIntervalMs: 500,
  });
  if (outcome.runId === null) {
    throw new Error(`the run was not created: ${outcome.classification.reason}`);
  }
  return { runId: outcome.runId, exitCode: outcome.classification.exitCode, outcome };
}

async function authorize(
  runId: string,
  integrity: Awaited<ReturnType<typeof verifyRunEvidenceChain>>,
) {
  const boundKeys = await boundInvariantKeysOf(prisma, runId);
  return authorizeReportFinalization<FrozenReportInputs>(prisma, runId, {
    boundInvariantKeys: boundKeys,
    verifiedChain: {
      headContentHash: integrity.recomputedHeadHash,
      observationCount: integrity.observationCount,
      lastChainIndex: integrity.observationCount === 0 ? null : integrity.observationCount - 1,
    },
    integrityVerified: integrity.chainValid && integrity.contentHashesValid,
    loadFrozenInputs: (db: ReportReadDb) => loadFrozenReportInputs(db, runId, targetId, boundKeys),
  });
}

/** Production mapping (orchestrator) + the D-20 trust filter: only pointers whose watermark equals the locked W count. */
async function trustedClassification(
  runId: string,
  options: { readonly integrityVerified: boolean } = { integrityVerified: true },
) {
  const integrity = await verifyRunEvidenceChain(prisma, runId);
  const result = await authorize(runId, integrity);
  const boundKeys = await boundInvariantKeysOf(prisma, runId);
  const current = await readTruthInputWatermark(prisma, runId);
  const pointerRows = await prisma.currentEvaluationPointer.findMany({
    where: { runId },
    include: { currentEvaluation: { select: { verdict: true } } },
  });
  const proofRows = await prisma.runEligibilityProof.findMany({ where: { runId } });
  const proofByKey = new Map(
    proofRows.map((proof) => [`${proof.invariantKey}|${proof.evaluatorVersion}`, proof] as const),
  );
  const trustedVerdicts: SubjectVerdict[] = [];
  for (const row of pointerRows) {
    const trusted =
      row.integrityHeadHash === current.chain.headContentHash &&
      row.integrityObservationCount === current.chain.observationCount &&
      row.provenanceRevision === current.provenanceRevision &&
      row.derivationGeneration === current.derivationGeneration;
    if (!trusted) {
      continue;
    }
    const proof = proofByKey.get(`${row.invariantKey}|${row.evaluatorVersion}`);
    const eligible: readonly string[] = Array.isArray(proof?.eligibleSubjectsJson)
      ? (proof?.eligibleSubjectsJson as string[])
      : [];
    if (proof?.mode === 'strict-coverage/v1' && !eligible.includes(row.subjectKey)) {
      continue;
    }
    const verdict = row.currentEvaluation.verdict;
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'NOT_EVALUABLE') {
      continue;
    }
    trustedVerdicts.push({
      invariantKey: row.invariantKey,
      subjectKey: row.subjectKey,
      verdict,
      mode: proof?.mode ?? 'legacy-compat',
      evaluatorVersion: row.evaluatorVersion,
    });
  }
  const domains: BoundKeyDomain[] = boundKeys.map((invariantKey) => {
    const proof = proofRows.find((row) => row.invariantKey === invariantKey);
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
    const arrays = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    return {
      invariantKey,
      mode: proof?.mode ?? null,
      evaluatorVersion: proof?.evaluatorVersion ?? null,
      declaredSubjects: strings(proof?.declaredSubjectsJson),
      eligibleSubjects: strings(proof?.eligibleSubjectsJson),
      missingSubjects: strings(proof?.missingSubjectsJson),
      unexpectedSubjectCount: arrays(proof?.unexpectedSubjects).length,
      evidenceGapCount: arrays(proof?.evidenceGaps).length,
    };
  });
  const anomalies: ExitAnomaly[] = result.anomalies.map((anomaly) => ({
    kind: anomaly.kind,
    invariantKey: anomaly.invariantKey,
    subjectKey: anomaly.subjectKey,
    detail: anomaly.detail,
  }));
  const classification = classifyExit({
    runTerminalState: 'COMPLETED',
    evidenceIntegrityVerified: options.integrityVerified,
    subjectVerdicts: trustedVerdicts,
    boundKeyDomains: domains,
    anomalies,
    ...(result.authorized ? {} : { authorizationFailure: result.reason }),
  });
  return { result, classification, trustedVerdicts, current };
}

beforeAll(async () => {
  env = loadTestEnv();
  createControlDb(env.controlDatabaseUrl);
  let port = 39000 + Math.floor(Math.random() * 4000);
  const commerceHostPort = Number((env.commerceDatabaseUrl.match(/:(\d+)\//) ?? [])[1] ?? 5445);
  throwawayDb = await provisionThrowawayCommerceDb({
    adminUrl: `postgresql://commerce:${env.commercePostgresPassword}@127.0.0.1:${commerceHostPort}/postgres`,
    password: env.commercePostgresPassword,
    port: commerceHostPort,
  });
  const hermeticEnv: TestEnv = { ...env, commerceDatabaseUrl: throwawayDb.databaseUrl };
  e2eTargetName = `checkout-zero-e3-${Date.now().toString(36)}`;
  for (let attempt = 0; ; attempt += 1) {
    running = await startCommerceProcess(hermeticEnv, port);
    credentialPolicy = testTargetOriginCredentialPolicy({
      [running.baseUrl]: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
    });
    try {
      await registerTarget(
        prisma,
        {
          displayName: e2eTargetName,
          environment: 'LOCAL_DEVELOPMENT',
          origins: [running.baseUrl],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
          manifest: loadCommerceManifest(e2eTargetName, running.baseUrl),
        },
        credentialPolicy,
      );
      break;
    } catch (error) {
      await running.close();
      if (!(error instanceof TargetRegistrationError) || attempt >= 2) {
        throw error;
      }
      port = 39000 + Math.floor(Math.random() * 4000);
    }
  }
  targetId = (await resolveTargetByDisplayName(prisma, e2eTargetName)).targetId;
  worker = spawn(process.execPath, [join('apps', 'worker', 'dist', 'main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      WORKER_CONCURRENCY: '2',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_COMMERCE_SIGNING_SECRET: env.commerceSigningSecret,
      COMMERCE_ADMIN_TOKEN: env.commerceAdminToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout?.on('data', (chunk: Buffer) => {
    workerStdout += chunk.toString();
  });
  await waitFor(async () => (workerStdout.includes('ready') ? true : null), 30_000, 100).catch(
    () => {
      throw new Error('worker did not start');
    },
  );
  workDir = await mkdtemp(join(tmpdir(), 'rg-phase17-e3-'));
}, 180_000);

afterAll(async () => {
  worker?.kill();
  await running.close();
  await throwawayDb?.close();
  await rm(workDir, { recursive: true, force: true });
});

describe('E3 · D-20 isolated proof-current / pointer-stale pair', () => {
  it('CASE A: a stale FAIL pointer is never trusted — proof current, required pointer stale ⇒ exit 2, never 0', async () => {
    const { runId, exitCode } = await runScenario('checkout-zero-vulnerable.scenario.json');
    // Actual CLI/orchestrator exit for the genuinely vulnerable run.
    expect(exitCode).toBe(1);

    const head = await readTruthInputWatermark(prisma, runId);
    expect(head.provenanceRevision).toBeGreaterThan(0n);
    const pointersBefore = await prisma.currentEvaluationPointer.findMany({
      where: { runId },
      include: { currentEvaluation: { select: { verdict: true } } },
    });
    expect(pointersBefore.length).toBeGreaterThan(0);
    const realFails = pointersBefore.filter((row) => row.currentEvaluation.verdict === 'FAIL');
    // The run's FAILs are real durable verdicts of its own evidence.
    expect(realFails.length).toBeGreaterThan(0);

    // EXPLICITLY LABELED DETECTOR PROBE: every pointer watermark is
    // moved one provenance revision behind (same generation, same
    // evaluation rows, proof rows untouched). Restored in `finally`;
    // no business claim is derived from the probed state.
    await prisma.currentEvaluationPointer.updateMany({
      where: { runId },
      data: { provenanceRevision: head.provenanceRevision - 1n },
    });
    try {
      const integrity = await verifyRunEvidenceChain(prisma, runId);
      const result = await authorize(runId, integrity);
      expect(result.disposition).toBe('RETRY');
      expect(result.anomalies.map((anomaly) => anomaly.kind)).toContain('WATERMARK_STALE');
      expect(result.state?.certified).toBe(false);

      // The stale rows still SAY fail — trust is withheld anyway.
      const staleRows = await prisma.currentEvaluationPointer.findMany({
        where: { runId },
        include: { currentEvaluation: { select: { verdict: true } } },
      });
      expect(
        staleRows.filter((row) => row.currentEvaluation.verdict === 'FAIL').length,
      ).toBeGreaterThan(0);

      const { classification, trustedVerdicts } = await trustedClassification(runId);
      expect(trustedVerdicts).toHaveLength(0);
      expect(classification.exitCode).toBe(2);
      expect(classification.exitClass).toBe('NOT_EVALUABLE');
    } finally {
      await prisma.currentEvaluationPointer.updateMany({
        where: { runId },
        data: {
          integrityHeadHash: head.chain.headContentHash,
          integrityObservationCount: head.chain.observationCount,
          provenanceRevision: head.provenanceRevision,
          derivationGeneration: head.derivationGeneration,
        },
      });
    }
    // Restored publication authorizes again with the real FAIL ⇒ exit 1:
    // the FAIL was genuine; only its freshness was probed.
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const clean = await authorize(runId, integrity);
    expect(clean.disposition).toBe('AUTHORIZED');
    const { classification } = await trustedClassification(runId);
    expect(classification.exitCode).toBe(1);
  }, 300_000);

  it('CASE B: an independently trusted FAIL dominates a separate stale pointer ⇒ exit 1; integrity still dominates ⇒ exit 3', async () => {
    const { runId, exitCode } = await runScenario('checkout-zero-vulnerable.scenario.json');
    expect(exitCode).toBe(1);

    const head = await readTruthInputWatermark(prisma, runId);
    const pointers = await prisma.currentEvaluationPointer.findMany({
      where: { runId },
      include: { currentEvaluation: { select: { verdict: true } } },
      orderBy: [{ invariantKey: 'asc' }, { subjectKey: 'asc' }],
    });
    expect(pointers.length).toBeGreaterThanOrEqual(2);
    const trustedRow = pointers.find((row) => row.currentEvaluation.verdict === 'FAIL');
    const staleRow = pointers.find((row) => row.id !== trustedRow?.id);
    expect(trustedRow).toBeDefined();
    expect(staleRow).toBeDefined();

    // EXPLICITLY LABELED DETECTOR PROBE: exactly one pointer is moved
    // behind; the trusted FAIL pointer is untouched. Restored in
    // `finally`; no business claim is derived from the probed state.
    await prisma.currentEvaluationPointer.update({
      where: { id: staleRow!.id },
      data: { provenanceRevision: head.provenanceRevision - 1n },
    });
    try {
      const integrity = await verifyRunEvidenceChain(prisma, runId);
      const result = await authorize(runId, integrity);
      // The detector fires: the stale pointer is not silently trusted.
      expect(result.disposition).toBe('RETRY');
      expect(result.anomalies.map((anomaly) => anomaly.kind)).toContain('WATERMARK_STALE');

      // Independence made explicit from durable rows: the trusted FAIL
      // pointer names the locked W in every component; the stale one
      // does not — while both name real evaluation rows.
      const trustedFresh = await prisma.currentEvaluationPointer.findUniqueOrThrow({
        where: { id: trustedRow!.id },
      });
      expect(trustedFresh.integrityHeadHash).toBe(head.chain.headContentHash);
      expect(trustedFresh.integrityObservationCount).toBe(head.chain.observationCount);
      expect(trustedFresh.provenanceRevision).toBe(head.provenanceRevision);
      expect(trustedFresh.derivationGeneration).toBe(head.derivationGeneration);
      const staleCheck = await prisma.currentEvaluationPointer.findUniqueOrThrow({
        where: { id: staleRow!.id },
      });
      expect(staleCheck.provenanceRevision).not.toBe(head.provenanceRevision);

      // ADR-0019 precedence over genuinely trusted verdicts only: the
      // trusted FAIL establishes exit 1 despite the anomaly.
      const { classification, trustedVerdicts } = await trustedClassification(runId);
      expect(trustedVerdicts.map((verdict) => verdict.verdict)).toContain('FAIL');
      expect(classification.exitCode).toBe(1);
      expect(classification.exitClass).toBe('INVARIANT_FAIL');
      expect(classification.precedenceRule).toBe(2);

      // An execution/integrity failure still dominates the trusted FAIL.
      const dominated = await trustedClassification(runId, { integrityVerified: false });
      expect(dominated.classification.exitCode).toBe(3);
      expect(dominated.classification.exitClass).toBe('EXECUTION_FAILURE');
      expect(dominated.classification.precedenceRule).toBe(1);
    } finally {
      await prisma.currentEvaluationPointer.update({
        where: { id: staleRow!.id },
        data: {
          integrityHeadHash: head.chain.headContentHash,
          integrityObservationCount: head.chain.observationCount,
          provenanceRevision: head.provenanceRevision,
          derivationGeneration: head.derivationGeneration,
        },
      });
    }
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const clean = await authorize(runId, integrity);
    expect(clean.disposition).toBe('AUTHORIZED');
    // Report classification over the restored authorized state:
    // a schema-valid report carrying the FAIL.
    const boundKeys = await boundInvariantKeysOf(prisma, runId);
    const { classification } = await trustedClassification(runId);
    expect(classification.exitCode).toBe(1);
    expect(boundKeys.length).toBeGreaterThan(0);
    await runRunAnalysis(prisma, runId);
    const reverified = await verifyRunEvidenceChain(prisma, runId);
    expect(reverified.chainValid && reverified.contentHashesValid).toBe(true);
  }, 300_000);

  it('report classification: the vulnerable authorized state builds a schema-valid INVARIANT_FAIL report', async () => {
    const { runId, exitCode, outcome } = await runScenario(
      'checkout-zero-vulnerable.scenario.json',
    );
    expect(exitCode).toBe(1);
    expect(outcome.reportInput).not.toBeNull();
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const result = await authorize(runId, integrity);
    expect(result.disposition).toBe('AUTHORIZED');
    expect(result.state?.certified).toBe(true);
    const { classification } = await trustedClassification(runId);
    expect(classification.exitCode).toBe(1);
    expect(classification.exitClass).toBe('INVARIANT_FAIL');
    // The orchestrator's own frozen report input builds a schema-valid
    // report carrying the FAIL classification — no hand-assembled bytes.
    const report = buildReport(outcome.reportInput!, integrity, outcome.classification);
    validateReportAgainstSchema(report);
    expect(report.exit.code).toBe(1);
  }, 300_000);

  it('case-26 E2E: a late stale conflicting setup generation after a PASS run drives re-analysis to exit 2', async () => {
    const { runId, exitCode } = await runScenario('checkout-zero-secure.scenario.json');
    expect(exitCode).toBe(0);

    // The owner's own stored setup response (durable truth, read back —
    // never reconstructed): copy its body and advance only the
    // generation, producing a conflicting stale candidate.
    const setupStep = await prisma.experimentStepRun.findFirstOrThrow({
      where: { runId, name: 'establish-scenario' },
      select: { id: true, leaseOwnerId: true, fencingToken: true },
    });
    const ownerObservation = await prisma.rawObservation.findFirstOrThrow({
      where: { runId, stepRunId: setupStep.id, kind: 'http_response_observed' },
      orderBy: { chainIndex: 'asc' },
      select: { payload: true },
    });
    const ownerBody = (ownerObservation.payload as { http: { responseBody: string } }).http
      .responseBody;
    const parsed = JSON.parse(ownerBody) as Record<string, unknown>;
    expect(typeof parsed['verificationScopeId']).toBe('string');
    expect(typeof parsed['generationId']).toBe('number');
    const staleBody = JSON.stringify({
      ...parsed,
      generationId: (parsed['generationId'] as number) + 1,
    });

    // Late stale-worker append AFTER the fenced terminal outcome,
    // through the production writers with a distinct generation
    // identity (unfenced by design — attributed, preserved).
    const staleOwner = `e3-stale-probe-${suiteToken}`;
    const recorded = await recordInvocation(
      prisma,
      setupStep.id,
      {
        sequence: 99,
        waveIndex: 0,
        invocationIdentity: `e3-stale-${runId}-99`,
        transportStage: 'RESPONSE_COMPLETE',
        httpStatus: 200,
        requestBytes: 10,
        responseBytes: staleBody.length,
        responseBody: staleBody,
        durationMs: 1,
        outcome: 'SUCCEEDED',
        sideEffectKnowledge: 'NOT_APPLICABLE',
        error: null,
      },
      { ownerId: staleOwner, fencingToken: '1' },
    );
    const sink = createEngineEvidenceSink(prisma);
    await sink.captureInvocation(
      {
        runId,
        stepRunId: setupStep.id,
        invocationId: recorded.invocationId,
        invocationIdentity: `e3-stale-obs-${runId}-99`,
        sequence: 99,
        waveIndex: 0,
        method: 'POST',
        relativePath: '/demo/admin/scenario',
        requestHeaders: {},
        requestBody: null,
        transportStage: 'RESPONSE_COMPLETE',
        httpStatus: 200,
        responseHeaders: {},
        responseBody: staleBody,
        responseTruncated: false,
        requestBytes: 10,
        responseBytes: staleBody.length,
        durationMs: 1,
        outcome: 'SUCCEEDED',
        error: null,
        observedAt: new Date(),
      },
      { ownerId: staleOwner, fencingToken: '1' },
    );

    // Boundary A re-analysis over the advanced truth input, then a
    // fresh verification and authorization: the stale conflict must
    // fail closed to exit 2 — never a stale PASS.
    await runRunAnalysis(prisma, runId);
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    expect(integrity.chainValid && integrity.contentHashesValid).toBe(true);
    const result = await authorize(runId, integrity);
    expect(result.disposition).toBe('NOT_EVALUABLE');
    expect(result.state?.certified).toBe(false);
    const kinds = result.anomalies.map((anomaly) => anomaly.kind);
    expect(kinds.includes('MISSING_DECLARED_SUBJECT') || kinds.includes('COVERAGE_ANOMALY')).toBe(
      true,
    );
    const { classification } = await trustedClassification(runId);
    expect(classification.exitCode).toBe(2);
    expect(classification.exitClass).toBe('NOT_EVALUABLE');
  }, 300_000);
});
