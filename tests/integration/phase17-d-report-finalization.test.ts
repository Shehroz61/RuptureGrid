// =====================================================================
// Integration — Phase 17 Checkpoint D: Boundary B report authorization,
// composite-watermark adversaries and the authorized exit reduction
// (ADR-0026 §13–§15, §20; mission §7–§11, §14)
// =====================================================================
// Every case drives the REAL stack (R-08): the real Commerce target over
// real TCP, the REAL queue + worker, the REAL StepProcessor, the REAL
// capture/derivation/analysis pipelines, the REAL per-run advisory-lock
// Boundary B transaction, and the REAL Control PostgreSQL. Assertions
// read the CLI's own observable surface (`executeScenario` outcome,
// written report objects, exit classifications) plus DURABLE rows.
//
// Watermark adversaries never fabricate evidence: C advances only
// through the ACCEPTED append primitive with a REAL read-only HTTP
// observation of the target, P advances only through the accepted
// provenance writer primitive, D advances only through a REAL derived
// write, and an unresolved derivation attempt is opened with the real
// attempt primitive. The one explicitly labeled exception is D-10's
// writer-bug injection, which exists to prove the foreign-row DETECTOR
// fails closed; it is removed in a finally block and no business claim
// is derived from it.
//
// Counterexample map: D-10 (foreign persisted row ⇒ exit 2, never a
// business FAIL), D-12 (no required subject verdicts ⇒ never exit 0,
// report still emitted), D-14 (row/order independence), D-15 (the
// report preserves EVERY current subject evaluation), D-16 (raw
// observation append ⇒ old verification stale ⇒ no stale exit 0),
// D-17 (provenance append ⇒ stale ⇒ no stale exit 0), D-18 (derived
// write advances D ⇒ stale ⇒ no stale exit 0), D-19 (attempt changes
// readiness without rows ⇒ never a stale PASS), D-22 (post-authorization
// truth stays explicitly AS-OF the locked watermark), D-23 (concurrent
// report authorizations never mix generations), D-24 (lock timeout is an
// honest infrastructure failure, never a stale PASS), D-26 (version
// surfaces are frozen under the lock; no post-authorization live read).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createControlDb } from '@rupturegrid/control-db';

import {
  acquireRunLock,
  advanceDerivationGeneration,
  advanceProvenanceRevision,
  registerTarget,
  TargetRegistrationError,
} from '@rupturegrid/engine';
import {
  DERIVATION_KIND_RUN_EVIDENCE,
  RawObservationStore,
  authorizeReportFinalization,
  beginDerivationAttempt,
  failDerivationAttempt,
  readCurrentEvaluationPublication,
  readTruthInputWatermark,
  runRunAnalysis,
  verifyRunEvidenceChain,
} from '@rupturegrid/evidence';
import type { ReportAuthorizationAnomaly, ReportReadDb } from '@rupturegrid/evidence';
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
/**
 * The honest boundary-B refusal kinds a stale decision may name: the
 * moved verified identity, a stale publication watermark, or the
 * readiness of the derived projection over the advanced source. All of
 * them refuse the decision (bounded re-analysis); none of them PASSES.
 */
const REFUSAL_ANOMALY_KINDS = [
  'VERIFIED_IDENTITY_ADVANCED',
  'WATERMARK_STALE',
  'DERIVATION_NOT_READY',
  'MISSING_PROOF',
];
const COMMERCE_SIGNING_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const COMMERCE_ADMIN_REF = 'COMMERCE_ADMIN_TOKEN';
const GOLDEN_SCENARIOS = join('packages', 'cli', 'scenarios');

let env: TestEnv;
let running: RunningCommerce;
let throwawayDb: ProvisionedCommerceDb | null = null;
let worker: ChildProcess | null = null;
let workerStdout = '';
let workerStderr = '';
let workDir = '';
let e2eTargetName = '';
let targetId = '';
let credentialPolicy: TargetOriginCredentialPolicy;

const suiteToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const suiteScopeToken = `checkout-zero-d-${suiteToken}`;
const suiteSku = `SKU-D-${suiteToken}`;
let scenarioCounter = 0;

interface RunOutcome {
  readonly runId: string;
  readonly outcome: Awaited<ReturnType<typeof executeScenario>>;
}

/** Rebinds a committed golden scenario to this suite's target/scope/sku. */
async function reboundScenario(
  sourceName: string,
  fileBody?: (document: Record<string, unknown>) => void,
): Promise<{ path: string; document: ScenarioDocument }> {
  const raw = await readFile(join(GOLDEN_SCENARIOS, sourceName), 'utf8');
  const document = JSON.parse(raw) as Record<string, unknown>;
  (document['target'] as Record<string, unknown>)['displayName'] = e2eTargetName;
  scenarioCounter += 1;
  const perFile = `${suiteToken}-${String(scenarioCounter)}`;
  const intentFor = (canonical: string): string =>
    canonical === 'CHK-RL-001' ? `CHKRL-${perFile}` : `CHK-${perFile}`;
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
      body['checkoutIntentId'] = intentFor(body['checkoutIntentId'] as string);
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
        subject === 'SKU-001' ? suiteSku : subject.startsWith('CHK') ? intentFor(subject) : subject,
      );
    }
  }
  document['name'] = `${String(document['name'])}-d-${perFile}`;
  fileBody?.(document);
  const path = join(workDir, `${sourceName}-${String(scenarioCounter)}`);
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8');
  return { path, document: validateScenarioDocument(document) };
}

/** Runs one scenario through the REAL audited orchestration (in-process). */
async function runScenario(
  sourceName: string,
  fileBody?: (document: Record<string, unknown>) => void,
): Promise<RunOutcome> {
  const scenario = await reboundScenario(sourceName, fileBody);
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
  return { runId: outcome.runId, outcome };
}

/** The G1 shape: the secure scenario with its checkout step removed. */
function withoutCheckoutStep(document: Record<string, unknown>): void {
  const experiment = document['experiment'] as Record<string, unknown>;
  experiment['steps'] = (experiment['steps'] as Array<Record<string, unknown>>).filter(
    (step) => step['name'] !== 'checkout-submit',
  );
}

/** Authorizes one report decision over the real publication (Boundary B). */
type ReportAuthorization = Awaited<
  ReturnType<typeof authorizeReportFinalization<FrozenReportInputs>>
>;

async function authorize(
  runId: string,
  integrity: Awaited<ReturnType<typeof verifyRunEvidenceChain>>,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<ReportAuthorization> {
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
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
}

/** The CLI's own rule-1 mapping for a decision that could not be performed. */
function infrastructureClassification(reason: string) {
  return classifyExit({
    runTerminalState: 'COMPLETED',
    evidenceIntegrityVerified: undefined,
    executionFailureReason: reason,
    subjectVerdicts: [],
    boundKeyDomains: [],
    anomalies: [],
  });
}

beforeAll(async () => {
  env = loadTestEnv();
  let port = 39000 + Math.floor(Math.random() * 4000);
  const commerceHostPort = Number((env.commerceDatabaseUrl.match(/:(\d+)\//) ?? [])[1] ?? 5445);
  throwawayDb = await provisionThrowawayCommerceDb({
    adminUrl: `postgresql://commerce:${env.commercePostgresPassword}@127.0.0.1:${commerceHostPort}/postgres`,
    password: env.commercePostgresPassword,
    port: commerceHostPort,
  });
  const hermeticEnv: TestEnv = { ...env, commerceDatabaseUrl: throwawayDb.databaseUrl };
  e2eTargetName = `checkout-zero-d-${Date.now().toString(36)}`;
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
  worker.stderr?.on('data', (chunk: Buffer) => {
    workerStderr += chunk.toString();
  });
  await waitFor(async () => (workerStdout.includes('ready') ? true : null), 30_000, 100).catch(
    () => {
      throw new Error(`worker did not start: ${workerStderr || workerStdout}`);
    },
  );
  workDir = await mkdtemp(join(tmpdir(), 'rg-phase17-d-'));
}, 120_000);

afterAll(async () => {
  worker?.kill();
  await running.close();
  await throwawayDb?.close();
  await rm(workDir, { recursive: true, force: true });
});

describe('Checkpoint D — authorized report state (reduction, ordering, completeness)', () => {
  it('D-14/D-15: one authorized state per real publication, order-independent, every current subject preserved', async () => {
    const { runId, outcome } = await runScenario('checkout-zero-secure.scenario.json');
    expect(outcome.classification.exitClass).toBe('PASS');
    expect(outcome.reportInput).not.toBeNull();

    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const first = await authorize(runId, integrity);
    const second = await authorize(runId, integrity);
    expect(first.disposition).toBe('AUTHORIZED');
    expect(first.state?.certified).toBe(true);
    // Nothing about the authorized state depends on read order: the same
    // durable rows authorize byte-identical frozen values.
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(second.reason).toBe(first.reason);

    // The authoritative read is ordered by (key, subject), never by
    // physical row order or insertion order.
    const publication = await readCurrentEvaluationPublication(prisma, runId);
    const ordered = [...publication.pointers].sort(
      (a, b) =>
        a.invariantKey.localeCompare(b.invariantKey) || a.subjectKey.localeCompare(b.subjectKey),
    );
    expect(
      publication.pointers.map((entry) => `${entry.invariantKey}/${entry.subjectKey}`),
    ).toEqual(ordered.map((entry) => `${entry.invariantKey}/${entry.subjectKey}`));

    // D-15: the written report preserves EVERY current subject
    // evaluation of the bound keys — exactly the durable pointer set.
    const report = buildReport(outcome.reportInput!, integrity, outcome.classification);
    validateReportAgainstSchema(report);
    const boundKeys = await boundInvariantKeysOf(prisma, runId);
    const pointers = await prisma.currentEvaluationPointer.findMany({
      where: { runId, invariantKey: { in: boundKeys } },
      select: { invariantKey: true, subjectKey: true },
    });
    const durable = new Set(pointers.map((row) => `${row.invariantKey}/${row.subjectKey}`));
    const reported = new Set(
      report.invariantEvaluations.map((row) => `${row.invariantKey}/${row.subjectKey}`),
    );
    expect(reported).toEqual(durable);
    expect(durable.size).toBeGreaterThanOrEqual(2);

    // The exit reduction is a SET reduction: every permutation of the
    // authorized domain yields the same class and code.
    const domains = boundKeys.map((invariantKey) => ({
      invariantKey,
      mode: 'strict-coverage/v1',
      evaluatorVersion: 'generic-invariant/v1',
      declaredSubjects: pointers
        .filter((row) => row.invariantKey === invariantKey)
        .map((row) => row.subjectKey),
      eligibleSubjects: pointers
        .filter((row) => row.invariantKey === invariantKey)
        .map((row) => row.subjectKey),
      missingSubjects: [] as string[],
      unexpectedSubjectCount: 0,
      evidenceGapCount: 0,
    }));
    const verdicts = pointers.map((row) => ({
      invariantKey: row.invariantKey,
      subjectKey: row.subjectKey,
      verdict: 'PASS' as const,
      mode: 'strict-coverage/v1',
      evaluatorVersion: 'generic-invariant/v1',
    }));
    const permute = <T>(items: readonly T[]): T[] => [...items].reverse();
    const base = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: verdicts,
      boundKeyDomains: domains,
      anomalies: [],
    });
    const reversed = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: permute(verdicts),
      boundKeyDomains: permute(domains),
      anomalies: [],
    });
    expect(base.exitCode).toBe(0);
    expect(reversed.exitCode).toBe(base.exitCode);
    expect(reversed.exitClass).toBe(base.exitClass);
  }, 240_000);

  it('D-12: a bound domain with no persisted verdict never passes and still emits an uncertified report', async () => {
    const { runId, outcome } = await runScenario(
      'checkout-zero-secure.scenario.json',
      withoutCheckoutStep,
    );
    // The real classification: exit 2 (NOT_EVALUABLE), never 0.
    expect(outcome.classification.exitClass).toBe('NOT_EVALUABLE');
    expect(outcome.classification.exitCode).toBe(2);
    expect(outcome.reportInput).not.toBeNull();
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const report = buildReport(outcome.reportInput!, integrity, outcome.classification);
    validateReportAgainstSchema(report);
    expect(report.exit.code).toBe(2);
    expect(report.eligibility?.certified).toBe(false);

    // The durable truth behind it: the declared checkout subject of the
    // bound invariant never materialized, so that bound key has NO
    // current verdict — the durable fact the missing-verdict rule rests
    // on; no PASS is representable (never a vacuous pass).
    const boundKeys = await boundInvariantKeysOf(prisma, runId);
    expect(boundKeys).toContain('INV-CHK-1');
    const pointers = await prisma.currentEvaluationPointer.findMany({
      where: { runId, invariantKey: { in: boundKeys } },
      select: { invariantKey: true },
    });
    expect(pointers.filter((row) => row.invariantKey === 'INV-CHK-1')).toHaveLength(0);
    const classification = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: [],
      boundKeyDomains: boundKeys.map((invariantKey) => ({
        invariantKey,
        mode: 'strict-coverage/v1',
        evaluatorVersion: 'generic-invariant/v1',
        declaredSubjects: [],
        eligibleSubjects: [],
        missingSubjects: [],
        unexpectedSubjectCount: 0,
        evidenceGapCount: 0,
      })),
      anomalies: [],
    });
    expect(classification.exitCode).toBe(2);
    expect(classification.reason).toContain('no persisted verdict');
  }, 240_000);
});

describe('Checkpoint D — composite watermark adversaries W = (C, P, D)', () => {
  it('D-16/D-22/D-26: a raw observation append invalidates the verified prefix (no stale PASS)', async () => {
    const { runId, outcome } = await runScenario('checkout-zero-secure.scenario.json');
    expect(outcome.classification.exitClass).toBe('PASS');
    const verifiedBefore = await verifyRunEvidenceChain(prisma, runId);
    const authorized = await authorize(runId, verifiedBefore);
    expect(authorized.disposition).toBe('AUTHORIZED');
    const asOfBefore = authorized.state?.watermark;
    const frozenBefore = JSON.stringify(authorized.state);

    // ---- A REAL read-only observation of the REAL target, appended
    // through the ACCEPTED append primitive (attributed to this test):
    // the byte cap/redaction/chain logic is the product's own.
    const remaining = await fetch(`${running.baseUrl}/inspection/sku-remaining`).then(
      (response) => response.json() as Promise<unknown>,
    );
    const store = new RawObservationStore(prisma);
    const appended = await store.appendTargetObservation({
      runId,
      stepRunId: null,
      adapterKind: 'phase17-d-post-authorization-read',
      observedAt: new Date(),
      payload: { source: 'phase17-d', readOnly: true, collection: 'sku-remaining', remaining },
      writerOwnerId: 'phase17-d-test',
      writerFencingToken: null,
      provenanceIdentity: `phase17-d:sku-remaining:${runId}`,
    });
    const verifiedAfter = await verifyRunEvidenceChain(prisma, runId);
    expect(verifiedAfter.chainValid && verifiedAfter.contentHashesValid).toBe(true);
    expect(verifiedAfter.observationCount).toBe(verifiedBefore.observationCount + 1);
    expect(verifiedAfter.recomputedHeadHash).not.toBe(verifiedBefore.recomputedHeadHash);

    // The OLD verification covered a prefix the locked head no longer
    // has: the authorization must refuse (bounded RETRY) — never decide
    // against an unverified head, never a stale PASS.
    const stale = await authorize(runId, verifiedBefore);
    expect(stale.disposition).toBe('RETRY');
    expect(stale.anomalies.length).toBeGreaterThan(0);
    for (const anomaly of stale.anomalies) {
      expect(REFUSAL_ANOMALY_KINDS).toContain(anomaly.kind);
    }
    expect(stale.state?.certified).toBe(false);
    expect(stale.external).not.toBeNull();
    const staleDecision = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: [],
      boundKeyDomains: [],
      anomalies: stale.anomalies,
      authorizationFailure: stale.reason,
    });
    expect(staleDecision.exitCode).toBe(2);

    // An append committed BEFORE authorization is never silently
    // excluded: even with the chain re-verified over the new head, the
    // decision stays refused until the derived projection over the
    // advanced source is proven complete (Boundary A).
    const unready = await authorize(runId, verifiedAfter);
    expect(unready.disposition).toBe('RETRY');
    expect(unready.state?.certified).toBe(false);

    // D-22: the previously authorized artifact is AS-OF the old
    // watermark and is not retroactively rewritten; after Boundary A
    // re-derives over the advanced source, a FRESH verification
    // authorizes a NEWER as-of state.
    const frozenAfter = JSON.stringify(authorized.state);
    expect(frozenAfter).toBe(frozenBefore);
    expect(authorized.state?.watermark).toEqual(asOfBefore);
    await runRunAnalysis(prisma, runId);
    const verifiedFinal = await verifyRunEvidenceChain(prisma, runId);
    const fresh = await authorize(runId, verifiedFinal);
    expect(fresh.disposition).toBe('AUTHORIZED');
    expect(fresh.state?.certified).toBe(true);
    expect(fresh.state?.watermark.chain.observationCount).toBe(
      (asOfBefore?.chain.observationCount ?? 0) + 1,
    );
    expect(fresh.state?.watermark.chain.headContentHash).toBe(verifiedAfter.recomputedHeadHash);
    void appended;
  }, 300_000);

  it('D-17/D-18/D-19: P, D and readiness adversaries each refuse a stale decision', async () => {
    const { runId } = await runScenario('checkout-zero-secure.scenario.json');
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const baseline = await authorize(runId, integrity);
    expect(baseline.disposition).toBe('AUTHORIZED');

    // ---- D-19: a real IN_PROGRESS derivation attempt that commits no
    // row still makes the projection unproven (readiness, not content).
    const attempt = await beginDerivationAttempt(prisma, runId, DERIVATION_KIND_RUN_EVIDENCE);
    const duringAttempt = await authorize(runId, integrity);
    expect(duringAttempt.disposition).toBe('RETRY');
    expect(
      duringAttempt.anomalies.map((anomaly: ReportAuthorizationAnomaly) => anomaly.kind),
    ).toEqual(['DERIVATION_NOT_READY']);
    expect(duringAttempt.state?.certified).toBe(false);
    expect(
      classifyExit({
        runTerminalState: 'COMPLETED',
        evidenceIntegrityVerified: true,
        subjectVerdicts: [],
        boundKeyDomains: [],
        anomalies: duringAttempt.anomalies,
        authorizationFailure: duringAttempt.reason,
      }).exitCode,
    ).not.toBe(0);
    await failDerivationAttempt(prisma, attempt, new Error('phase17-d readiness adversary'));
    const afterAttempt = await authorize(runId, integrity);
    expect(afterAttempt.disposition).toBe('AUTHORIZED');

    // ---- D-17: a REAL provenance write (the accepted protocol
    // primitive) advances P and invalidates the frozen proof/pointer
    // watermark — bounded re-analysis converges, but the old state can
    // never authorize a stale decision.
    await prisma.$transaction(async (tx) => {
      await acquireRunLock(tx, runId);
      await advanceProvenanceRevision(tx, runId);
    });
    const current = await readTruthInputWatermark(prisma, runId);
    expect(current.provenanceRevision).toBeGreaterThan(0n);
    const staleProvenance = await authorize(runId, integrity);
    expect(staleProvenance.disposition).toBe('RETRY');
    expect(staleProvenance.anomalies.length).toBeGreaterThan(0);
    for (const anomaly of staleProvenance.anomalies) {
      expect(REFUSAL_ANOMALY_KINDS).toContain(anomaly.kind);
    }
    expect(staleProvenance.state?.certified).toBe(false);
    expect(
      classifyExit({
        runTerminalState: 'COMPLETED',
        evidenceIntegrityVerified: true,
        subjectVerdicts: [],
        boundKeyDomains: [],
        anomalies: staleProvenance.anomalies,
        authorizationFailure: staleProvenance.reason,
      }).exitCode,
    ).toBe(2);

    // Boundary A recomputes at the now-current W and the decision
    // re-authorizes: staleness is a re-analysis trigger, not a verdict.
    await runRunAnalysis(prisma, runId);
    const refreshed = await authorize(runId, integrity);
    expect(refreshed.disposition).toBe('AUTHORIZED');
    expect(refreshed.state?.certified).toBe(true);
    expect(refreshed.state?.watermark.provenanceRevision).toBe(
      current.provenanceRevision.toString(),
    );

    // ---- D-18: real evidence arriving (accepted append primitive) plus
    // a derived write that advances D through the SAME primitive every
    // committed derived write uses. A bare advance with no covering
    // attempt is exactly the protocol deviation the completeness check
    // is designed to catch (B2 D-21), so the refusal legitimately names
    // that condition — and it NEVER passes.
    const beforeAdvance = await readTruthInputWatermark(prisma, runId);
    const remaining = await fetch(`${running.baseUrl}/inspection/sku-remaining`).then(
      (response) => response.json() as Promise<unknown>,
    );
    await new RawObservationStore(prisma).appendTargetObservation({
      runId,
      stepRunId: null,
      adapterKind: 'phase17-d-derived-adversary-read',
      observedAt: new Date(),
      payload: { source: 'phase17-d', readOnly: true, remaining },
      writerOwnerId: 'phase17-d-test',
      writerFencingToken: null,
      provenanceIdentity: `phase17-d:derived-adversary:${runId}`,
    });
    await runRunAnalysis(prisma, runId);
    const afterEvidence = await readTruthInputWatermark(prisma, runId);
    expect(afterEvidence.chain.observationCount).toBe(beforeAdvance.chain.observationCount + 1);
    const beforeDerivedWrite = await readTruthInputWatermark(prisma, runId);
    await prisma.$transaction(async (tx) => {
      await acquireRunLock(tx, runId);
      await advanceDerivationGeneration(tx, runId);
    });
    const afterAdvance = await readTruthInputWatermark(prisma, runId);
    expect(afterAdvance.derivationGeneration).toBe(beforeDerivedWrite.derivationGeneration + 1n);
    // The stale decision (old verified C, old publication watermark) is
    // refused; the fresh verification authorizes the NEWER as-of state.
    const staleAfterAdvance = await authorize(runId, integrity);
    expect(staleAfterAdvance.disposition).toBe('RETRY');
    expect(staleAfterAdvance.anomalies.length).toBeGreaterThan(0);
    for (const anomaly of staleAfterAdvance.anomalies) {
      expect(REFUSAL_ANOMALY_KINDS).toContain(anomaly.kind);
    }
    expect(staleAfterAdvance.state?.certified).toBe(false);
    expect(
      classifyExit({
        runTerminalState: 'COMPLETED',
        evidenceIntegrityVerified: true,
        subjectVerdicts: [],
        boundKeyDomains: [],
        anomalies: staleAfterAdvance.anomalies,
        authorizationFailure: staleAfterAdvance.reason,
      }).exitCode,
    ).toBe(2);
    await runRunAnalysis(prisma, runId);
    const verifiedAfterAdvance = await verifyRunEvidenceChain(prisma, runId);
    const freshAfterAdvance = await authorize(runId, verifiedAfterAdvance);
    expect(freshAfterAdvance.disposition).toBe('AUTHORIZED');
    expect(freshAfterAdvance.state?.certified).toBe(true);
    // The authorized state never certifies an OLDER derivation
    // generation than the one the locked watermark names.
    expect(
      BigInt(freshAfterAdvance.state?.watermark.derivationGeneration ?? '0'),
    ).toBeGreaterThanOrEqual(afterAdvance.derivationGeneration);
    expect(freshAfterAdvance.state?.watermark.chain.observationCount).toBe(
      afterAdvance.chain.observationCount,
    );
    expect(baseline.state?.certified).toBe(true);
  }, 300_000);

  it('D-23: concurrent report authorizations serialize on the run lock and never mix generations', async () => {
    const { runId } = await runScenario('checkout-zero-secure.scenario.json');
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const [a, b, c] = await Promise.all([
      authorize(runId, integrity),
      authorize(runId, integrity),
      authorize(runId, integrity),
    ]);
    for (const result of [a, b, c]) {
      expect(result.disposition).toBe('AUTHORIZED');
      expect(result.state?.certified).toBe(true);
      expect(result.state?.analysisGeneration).toBe(a.state?.analysisGeneration);
      expect(JSON.stringify(result.state?.pointers)).toBe(JSON.stringify(a.state?.pointers));
    }
    const proofs = await prisma.runEligibilityProof.findMany({
      where: { runId },
      select: { analysisGeneration: true },
      distinct: ['analysisGeneration'],
    });
    expect(proofs).toHaveLength(1);
  }, 240_000);

  it('D-24: a held run lock turns the authorization into an honest infrastructure failure', async () => {
    const { runId } = await runScenario('checkout-zero-secure.scenario.json');
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    // Hold the SAME per-run advisory lock (the product's own primitive)
    // on a real second connection for the duration of the attempt.
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const held = createControlDb(env.controlDatabaseUrl);
    const holder = held.prisma.$transaction(
      async (tx) => {
        await acquireRunLock(tx, runId);
        await gate;
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    try {
      // Bounded wait for the holder to own the lock (a real pg lock wait).
      await waitFor(
        async () =>
          (
            await held.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
              `SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
            )
          )[0] !== undefined
            ? true
            : null,
        10_000,
        100,
      ).catch(() => undefined);
      let failure: unknown = null;
      try {
        await authorize(runId, integrity, { lockTimeoutMs: 500 });
      } catch (error) {
        failure = error;
      }
      expect(failure).not.toBeNull();
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message.length).toBeGreaterThan(0);
      // No decision exists to misreport: the caller's rule-1 mapping is
      // EXIT_CLASSES.EXECUTION_FAILURE (exit 3), never a stale PASS.
      const classification = infrastructureClassification(
        `the report authorization could not be performed: ${message}`,
      );
      expect(classification.exitClass).toBe('EXECUTION_FAILURE');
      expect(classification.exitCode).toBe(3);
      expect(classification.precedenceRule).toBe(1);
    } finally {
      releaseGate();
      await holder.catch(() => undefined);
      await held.disconnect().catch(() => undefined);
    }
    // The lock is gone: the same decision authorizes normally.
    const afterRelease = await authorize(runId, integrity);
    expect(afterRelease.disposition).toBe('AUTHORIZED');
  }, 240_000);

  it('D-10: a persisted evaluation row outside the run-owned domain is a consistency anomaly, never a business FAIL', async () => {
    const { runId } = await runScenario('checkout-zero-secure.scenario.json');
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    const proof = await prisma.runEligibilityProof.findFirstOrThrow({
      where: { runId, mode: 'strict-coverage/v1', invariantKey: 'INV-CHK-1' },
    });
    const batch = await prisma.evaluationBatch.findFirstOrThrow({
      where: { runId, invariantKey: proof.invariantKey, completedAt: { not: null } },
    });
    // EXPLICITLY LABELED WRITER-BUG INJECTION: the gated pipeline never
    // creates such a row; this exists only to prove the DETECTOR fails
    // closed. It is deleted in the finally block and no business claim,
    // finding, or report field is derived from it.
    const injected = await prisma.invariantEvaluation.create({
      data: {
        runId,
        batchId: batch.id,
        invariantKey: proof.invariantKey,
        evaluatorVersion: proof.evaluatorVersion,
        subjectKey: `FOREIGN-${suiteToken}`,
        verdict: 'FAIL',
        reason: 'phase17-d detector injection (never a business claim)',
        evidenceSetHash: '0'.repeat(64),
        completenessBasis: 'phase17-d-injection',
        details: { injectedBy: 'phase17-d-suite' },
        sourceObservationHashes: [],
        normalizedEventIds: [],
        causalRelationshipIds: [],
      },
    });
    try {
      const result = await authorize(runId, integrity);
      // Exit 2 — the anomaly decides; the injected FAIL is NOT a business
      // failure of this run.
      expect(result.disposition).toBe('NOT_EVALUABLE');
      expect(result.anomalies.map((anomaly: ReportAuthorizationAnomaly) => anomaly.kind)).toContain(
        'FOREIGN_ROW_ANOMALY',
      );
      expect(result.state?.anomalies.length).toBeGreaterThan(0);
      expect(result.external).not.toBeNull();
      const classification = classifyExit({
        runTerminalState: 'COMPLETED',
        evidenceIntegrityVerified: true,
        subjectVerdicts: [],
        boundKeyDomains: [],
        anomalies: result.anomalies,
      });
      expect(classification.exitClass).toBe('NOT_EVALUABLE');
      expect(classification.exitCode).toBe(2);
    } finally {
      await prisma.invariantEvaluation.delete({ where: { id: injected.id } });
    }
    // With the injected row gone the SAME publication authorizes again:
    // the anomaly was the only blocker.
    const clean = await authorize(runId, integrity);
    expect(clean.disposition).toBe('AUTHORIZED');
  }, 300_000);
});
