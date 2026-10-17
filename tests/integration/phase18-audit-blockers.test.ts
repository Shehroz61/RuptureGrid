// Permanent regressions for the final independent audit. Real PostgreSQL,
// Redis/BullMQ, worker, TCP target and external CLI. Writer-bug injections
// below are explicitly detector fixtures in a disposable Control database;
// they never represent target effects or mutate accepted historical runs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';
import { Prisma } from '../../packages/control-db/src/generated/client/client.js';
import type { ControlDb } from '@rupturegrid/control-db';
import {
  acquireRunLock,
  advanceDerivationGeneration,
  advanceProvenanceRevision,
  canonicalizeAndHash,
  createRunFromSnapshot,
  validateReplayBinding,
  RUN_SCOPE_ELIGIBILITY_VERSION,
} from '@rupturegrid/engine';
import {
  RawObservationStore,
  authorizeReportFinalization,
  beginDerivationAttempt,
  failDerivationAttempt,
  DERIVATION_KIND_RUN_EVIDENCE,
  publishAnalysisGeneration,
  readCurrentEvaluationPublication,
  readTruthInputWatermark,
  runRunAnalysis,
} from '@rupturegrid/evidence';
import type { PublicationKey } from '@rupturegrid/evidence';
import { compareReplayRuns, RunComparisonError } from '@rupturegrid/forensics';
import { runGoldenScenario } from '@rupturegrid/incident-zero';
import { executeReplay, validateReportAgainstSchema } from '@rupturegrid/cli';
import type { RuptureGridReport } from '@rupturegrid/cli';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess } from './helpers/demo-harness.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import { registerDemoTarget, startPhase4Worker } from './helpers/phase4-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { testTargetOriginCredentialPolicy } from './helpers/execution-harness.js';

let fixtureDb: OwnedControlFixture;
let db: ControlDb;
let demo: RunningDemo;
let worker: RunningWorker;
let directory = '';
let targetId = '';
let env = loadTestEnv();
const refs = ['DEMO_ADMIN_TOKEN', 'DEMO_INSPECTION_TOKEN', 'DEMO_PROVIDER_SIGNING_SECRET'];
let first: Awaited<ReturnType<typeof runGoldenScenario>>;
let second: Awaited<ReturnType<typeof runGoldenScenario>>;
const p = () => db.prisma;
const golden = (mode: 'VULNERABLE' | 'SECURE') =>
  runGoldenScenario({
    prisma: p(),
    targetId,
    mode,
    redisUrl: env.redisUrl,
    queuePrefix: env.queuePrefix,
  });
const compare = () => compareReplayRuns(p(), first.runId, second.runId);

beforeAll(async () => {
  fixtureDb = await createOwnedControlFixture(env);
  env = fixtureDb.env;
  db = fixtureDb.controlDb;
  directory = await mkdtemp(join(tmpdir(), 'rg-p18-blockers-'));
  demo = await startDemoProcess(env, Number(process.env.DEMO_P18_BLOCKERS_PORT ?? '3137'));
  targetId = (await registerDemoTarget(fixtureDb, demo, 'phase18-blocker-detectors')).targetId;
  worker = await startPhase4Worker(env);
  first = await golden('VULNERABLE');
  second = await golden('VULNERABLE');
}, 240_000);

afterAll(async () => {
  await worker?.close();
  await demo?.close();
  await fixtureDb?.close();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // Accepted re-analysis republishes a current W after a preceding stale-W
  // detector, making every test independent of execution/shuffle order.
  await runRunAnalysis(p(), first.runId);
  await runRunAnalysis(p(), second.runId);
});

describe('Phase 18 audit blockers: actual legacy CLI', () => {
  it.each(['VULNERABLE', 'SECURE'] as const)(
    '%s replay retains the frozen legacy domain and independent verdicts',
    async (mode) => {
      const original = await golden(mode);
      const reproduction = await p().reproductionDefinition.findUniqueOrThrow({
        where: { runId: original.runId },
      });
      const originalSnapshot = await p().runSnapshot.findUniqueOrThrow({
        where: { id: reproduction.snapshotId },
      });
      const originalEvaluations = await p().invariantEvaluation.findMany({
        where: { runId: original.runId },
        orderBy: { id: 'asc' },
      });
      const reportPath = join(directory, `${mode}.json`);
      const child = spawn(
        process.execPath,
        [
          'packages/cli/dist/cli.js',
          'replay',
          '--reproduction',
          reproduction.id,
          '--report',
          reportPath,
          '--json',
          '--timeout',
          '120s',
        ],
        {
          env: {
            ...process.env,
            CONTROL_DATABASE_URL: env.controlDatabaseUrl,
            REDIS_URL: env.redisUrl,
            QUEUE_PREFIX: env.queuePrefix,
            TARGET_ORIGIN_CREDENTIAL_GRANTS: JSON.stringify({ [demo.baseUrl]: refs }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('external replay CLI timed out'));
        }, 150_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      expect(stderr).toBe('');
      expect(code).toBe(mode === 'VULNERABLE' ? 1 : 0);
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as RuptureGridReport;
      validateReportAgainstSchema(report);
      expect(JSON.parse(stdout)).toEqual(report);
      expect(report.run.runId).not.toBe(original.runId);
      expect(report.run.snapshotId).toBe(original.snapshotId);
      expect(report.run.snapshotContentHash).toBe(original.snapshotContentHash);
      expect(report.evidenceIntegrity.verified).toBe(true);
      expect(report.eligibility?.certified).toBe(true);
      expect(
        [...new Set(report.invariantEvaluations.map((row) => row.invariantKey))].sort(),
      ).toEqual(['INV-DF-1', 'INV-DF-2', 'INV-IZ-1']);
      const evaluation = report.invariantEvaluations.find((row) => row.invariantKey === 'INV-IZ-1');
      expect(evaluation?.verdict).toBe(mode === 'VULNERABLE' ? 'FAIL' : 'PASS');
      expect(evaluation?.evaluatorVersion).toBe('v1');
      expect(report.findings.length).toBe(mode === 'VULNERABLE' ? 1 : 0);
      expect(
        await p().runSnapshot.findUniqueOrThrow({ where: { id: original.snapshotId } }),
      ).toEqual(originalSnapshot);
      expect(
        await p().invariantEvaluation.findMany({
          where: { runId: original.runId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(originalEvaluations);
      for (const secret of [
        env.demoAdminToken,
        env.demoInspectionToken,
        env.demoProviderSigningSecret,
      ]) {
        expect(stdout + stderr).not.toContain(secret);
      }
      if (process.env.RUPTUREGRID_TEST_ARTIFACT_DIR) {
        await writeFile(
          join(
            process.env.RUPTUREGRID_TEST_ARTIFACT_DIR,
            `phase18-fintech-${mode}-${report.run.runId}.json`,
          ),
          JSON.stringify(
            {
              originalRunId: original.runId,
              reproductionId: reproduction.id,
              processExit: code,
              report,
            },
            null,
            2,
          ),
        );
      }
    },
    240_000,
  );
});

describe('Phase 18 audit blockers: engine compatibility before durable creation', () => {
  it('accepts the genuine historical engine and snapshot without rewriting it', async () => {
    const policy = testTargetOriginCredentialPolicy({ [demo.baseUrl]: refs });
    const binding = await validateReplayBinding(p(), first.snapshotId, policy);
    expect(binding.snapshotId).toBe(first.snapshotId);
    expect(binding.snapshotContentHash).toBe(first.snapshotContentHash);
    expect(binding.invariantKeys).toEqual(['INV-DF-1', 'INV-DF-2', 'INV-IZ-1']);
  });
  it.each([
    { invariants: [] },
    {
      invariants: ['INV-DF-1', 'INV-DF-2', 'INV-IZ-1'].map((invariantKey) => ({
        invariantKey,
        evaluatorVersion: invariantKey === 'INV-IZ-1' ? 'v999' : 'v1',
      })),
    },
  ])('refuses missing/unsupported legacy bindings %j before new work', async ({ invariants }) => {
    const reproduction = await p().reproductionDefinition.findUniqueOrThrow({
      where: { runId: first.runId },
    });
    const count = await p().experimentRun.count();
    try {
      // Detector-only reproduction metadata corruption in the owned DB.
      await p().reproductionDefinition.update({
        where: { id: reproduction.id },
        data: { invariantBindings: { invariants } },
      });
      await expect(
        executeReplay(p(), reproduction.id, {
          redisUrl: env.redisUrl,
          queuePrefix: env.queuePrefix,
          credentialPolicy: testTargetOriginCredentialPolicy({ [demo.baseUrl]: refs }),
          runTimeoutMs: 90_000,
          analysisTimeoutMs: 60_000,
          pollIntervalMs: 100,
        }),
      ).rejects.toThrow(/missing or unsupported frozen invariant/);
      expect(await p().experimentRun.count()).toBe(count);
    } finally {
      await p().reproductionDefinition.update({
        where: { id: reproduction.id },
        data: { invariantBindings: reproduction.invariantBindings as object },
      });
    }
  });
  it.each(['unsupported-engine/v999', undefined])(
    'refuses engine metadata %s with no new work',
    async (version) => {
      const source = await p().runSnapshot.findUniqueOrThrow({ where: { id: first.snapshotId } });
      const document = JSON.parse(JSON.stringify(source.content)) as Record<string, unknown>;
      if (version === undefined) delete document['engineVersion'];
      else document['engineVersion'] = version;
      const hash = canonicalizeAndHash(document).hash;
      const snapshot = await p().runSnapshot.create({
        data: {
          revisionId: source.revisionId,
          canonicalization: source.canonicalization,
          contentHash: hash,
          content: document as object,
        },
      });
      const counts = async () => [
        await p().experimentRun.count(),
        await p().experimentStepRun.count(),
        await p().rawObservation.count(),
      ];
      const before = await counts();
      await expect(
        createRunFromSnapshot(
          p(),
          snapshot.id,
          testTargetOriginCredentialPolicy({ [demo.baseUrl]: refs }),
        ),
      ).rejects.toThrow(/unsupported execution engine/);
      expect(await counts()).toEqual(before);
    },
  );
});

describe('Phase 18 audit blockers: comparison authorization', () => {
  it('authorizes genuine same-hash runs and preserves generated subject differences', async () => {
    const headsBefore = await p().evidenceIntegrityHead.findMany({
      where: { runId: { in: [first.runId, second.runId] } },
      orderBy: { runId: 'asc' },
    });
    const result = await compare();
    expect(
      await p().evidenceIntegrityHead.findMany({
        where: { runId: { in: [first.runId, second.runId] } },
        orderBy: { runId: 'asc' },
      }),
    ).toEqual(headsBefore);
    expect(result.keys.find((row) => row.invariantKey === 'INV-IZ-1')?.agree).toBe(true);
    const subjects = result.subjects.filter((row) => row.invariantKey === 'INV-IZ-1');
    expect(subjects).toHaveLength(2);
    expect(subjects.filter((row) => row.baseVerdict === 'ABSENT')).toHaveLength(1);
    expect(subjects.filter((row) => row.replayVerdict === 'ABSENT')).toHaveLength(1);
    expect(result.base.certifiedAsOf).toEqual(
      (await readCurrentEvaluationPublication(p(), first.runId)).current,
    );
  });

  it('refuses mixed authoritative evaluator versions at the same generation', async () => {
    const pointer = await p().currentEvaluationPointer.findFirstOrThrow({
      where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
    });
    const original = await p().invariantEvaluation.findUniqueOrThrow({
      where: { id: pointer.currentEvaluationId },
    });
    const proof = await p().runEligibilityProof.findFirstOrThrow({
      where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
    });
    // A coherent writer-bug fixture retains v1 and a second version at the
    // SAME generation/watermark. Equal verdict text cannot make it one
    // authoritative semantic version. This is never target-effect evidence.
    const injected = await p().$transaction(async (tx) => {
      await acquireRunLock(tx, second.runId);
      const batch = await tx.evaluationBatch.create({
        data: {
          runId: second.runId,
          invariantKey: original.invariantKey,
          evaluatorVersion: 'v999',
          completedAt: new Date(),
          evaluationCount: 1,
        },
      });
      const evaluation = await tx.invariantEvaluation.create({
        data: {
          batchId: batch.id,
          runId: second.runId,
          invariantKey: original.invariantKey,
          evaluatorVersion: 'v999',
          subjectKey: original.subjectKey,
          verdict: original.verdict,
          reason: 'synthetic mixed-authority detector fixture',
          evidenceSetHash: original.evidenceSetHash,
          completenessBasis: original.completenessBasis,
          details: {
            ...(original.details as object),
            evaluatorVersion: 'v999',
            detector: 'mixed-authority-only',
          },
          sourceObservationHashes: original.sourceObservationHashes,
          normalizedEventIds: original.normalizedEventIds,
          causalRelationshipIds: original.causalRelationshipIds,
        },
      });
      const duplicateProof = await tx.runEligibilityProof.create({
        data: {
          runId: second.runId,
          invariantKey: proof.invariantKey,
          evaluatorVersion: 'v999',
          eligibilityVersion: proof.eligibilityVersion,
          mode: proof.mode,
          coverageMode: proof.coverageMode,
          analysisGeneration: proof.analysisGeneration,
          integrityHeadHash: proof.integrityHeadHash,
          integrityObservationCount: proof.integrityObservationCount,
          provenanceRevision: proof.provenanceRevision,
          derivationGeneration: proof.derivationGeneration,
          coverageStatement: proof.coverageStatement,
        },
      });
      const duplicatePointer = await tx.currentEvaluationPointer.create({
        data: {
          runId: second.runId,
          invariantKey: pointer.invariantKey,
          evaluatorVersion: 'v999',
          subjectKey: pointer.subjectKey,
          currentEvaluationId: evaluation.id,
          evidenceHeadHash: evaluation.evidenceSetHash,
          eligibilityVersion: pointer.eligibilityVersion,
          analysisGeneration: pointer.analysisGeneration,
          integrityHeadHash: pointer.integrityHeadHash,
          integrityObservationCount: pointer.integrityObservationCount,
          provenanceRevision: pointer.provenanceRevision,
          derivationGeneration: pointer.derivationGeneration,
        },
      });
      return { batch, evaluation, duplicateProof, duplicatePointer };
    });
    try {
      expect((await readCurrentEvaluationPublication(p(), second.runId)).state).toBe('CURRENT');
      await expect(compare()).rejects.toThrow(/ambiguous authoritative evaluator versions/);
    } finally {
      await p().$transaction(async (tx) => {
        await acquireRunLock(tx, second.runId);
        await tx.currentEvaluationPointer.delete({ where: { id: injected.duplicatePointer.id } });
        await tx.runEligibilityProof.delete({ where: { id: injected.duplicateProof.id } });
        await tx.invariantEvaluation.delete({ where: { id: injected.evaluation.id } });
        await tx.evaluationBatch.delete({ where: { id: injected.batch.id } });
      });
    }
  });

  it.each(['evaluator', 'eligibility'] as const)(
    'refuses incompatible %s versions even when verdicts agree',
    async (kind) => {
      const where = { runId: second.runId, invariantKey: 'INV-IZ-1' };
      // Explicit writer-bug/version-drift injection, restored in finally.
      const version = kind === 'evaluator' ? 'v999' : 'run-eligibility/v999';
      try {
        if (kind === 'evaluator') {
          await p().invariantEvaluation.updateMany({ where, data: { evaluatorVersion: version } });
          await p().evaluationBatch.updateMany({ where, data: { evaluatorVersion: version } });
        }
        await p().currentEvaluationPointer.updateMany({
          where,
          data:
            kind === 'evaluator' ? { evaluatorVersion: version } : { eligibilityVersion: version },
        });
        await p().runEligibilityProof.updateMany({
          where,
          data:
            kind === 'evaluator' ? { evaluatorVersion: version } : { eligibilityVersion: version },
        });
        await expect(compare()).rejects.toThrow(/incompatible evaluator\/eligibility/);
      } finally {
        await p().invariantEvaluation.updateMany({ where, data: { evaluatorVersion: 'v1' } });
        await p().evaluationBatch.updateMany({ where, data: { evaluatorVersion: 'v1' } });
        await p().currentEvaluationPointer.updateMany({
          where,
          data: { evaluatorVersion: 'v1', eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION },
        });
        await p().runEligibilityProof.updateMany({
          where,
          data: { evaluatorVersion: 'v1', eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION },
        });
      }
    },
  );

  it.each([
    'incomplete',
    'foreign-run-batch',
    'foreign-key-batch',
    'foreign-version-batch',
    'foreign-evaluation-run',
  ] as const)(
    'refuses %s in a mixed trusted/untrusted selection through Boundary B and actual CLI',
    async (kind) => {
      const pointer = await p().currentEvaluationPointer.findFirstOrThrow({
        where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
        include: { currentEvaluation: { include: { batch: true } } },
      });
      const row = pointer.currentEvaluation;
      const batch = row.batch;
      const foreignBatch = await p().evaluationBatch.findFirstOrThrow({
        where: { runId: first.runId, invariantKey: row.invariantKey },
      });
      expect((await compare()).keys.find((key) => key.invariantKey === 'INV-IZ-1')?.agree).toBe(
        true,
      );
      expect(
        await p().currentEvaluationPointer.count({ where: { runId: second.runId } }),
      ).toBeGreaterThan(1);
      try {
        // One corrupt row among otherwise trusted keys. These are owned
        // Control-plane detector modifications, never target business writes.
        if (kind === 'foreign-run-batch') {
          await p().invariantEvaluation.update({
            where: { id: row.id },
            data: { batchId: foreignBatch.id },
          });
        } else if (kind === 'foreign-evaluation-run') {
          await p().invariantEvaluation.update({
            where: { id: row.id },
            data: { runId: first.runId },
          });
        } else {
          await p().evaluationBatch.update({
            where: { id: batch.id },
            data:
              kind === 'incomplete'
                ? { completedAt: null }
                : kind === 'foreign-key-batch'
                  ? { invariantKey: 'BATCH-KEY-DETECTOR' }
                  : { evaluatorVersion: 'batch-version-detector' },
          });
        }
        const authorization = await authorizeReportFinalization(p(), second.runId, {
          boundInvariantKeys: ['INV-DF-1', 'INV-DF-2', 'INV-IZ-1'],
          verifiedChain: (await readTruthInputWatermark(p(), second.runId)).chain,
          integrityVerified: true, // the valid baseline immediately above verified this unchanged chain
          loadFrozenInputs: async () => ({}),
        });
        expect(authorization.disposition).toBe('NOT_EVALUABLE');
        expect(authorization.authorized).toBe(false);
        expect(authorization.state?.certified).toBe(false);
        expect(authorization.anomalies.map((anomaly) => anomaly.kind)).toContain(
          'EVALUATION_AUTHORITY_INVALID',
        );
        await expect(compare()).rejects.toThrow(
          /EVALUATION_AUTHORITY_INVALID|foreign or superseded/,
        );
        const child = spawn(
          process.execPath,
          ['packages/cli/dist/cli.js', 'compare', first.runId, second.runId, '--json'],
          {
            env: { ...process.env, CONTROL_DATABASE_URL: env.controlDatabaseUrl },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        expect(code).toBe(4);
        expect(stderr).toBe('');
        expect(stdout).toMatch(/EVALUATION_AUTHORITY_INVALID|foreign or superseded/);
        const refusal = JSON.parse(stdout) as Record<string, unknown>;
        expect(refusal['subjects']).toBeUndefined();
        expect(refusal['keys']).toBeUndefined();
      } finally {
        await p().invariantEvaluation.update({
          where: { id: row.id },
          data: { runId: row.runId, batchId: row.batchId },
        });
        await p().evaluationBatch.update({
          where: { id: batch.id },
          data: {
            runId: batch.runId,
            invariantKey: batch.invariantKey,
            evaluatorVersion: batch.evaluatorVersion,
            completedAt: batch.completedAt,
          },
        });
      }
      expect((await compare()).keys.find((key) => key.invariantKey === 'INV-IZ-1')?.agree).toBe(
        true,
      );
    },
  );

  it('refuses a missing required subject instead of falling back to its historical evaluation', async () => {
    const proof = await p().runEligibilityProof.findFirstOrThrow({
      where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
    });
    const pointer = await p().currentEvaluationPointer.findFirstOrThrow({
      where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
    });
    try {
      // Strict coverage detector: the required evaluation still exists as
      // history but its current pointer is absent. It cannot fill the gap.
      await p().runEligibilityProof.update({
        where: { id: proof.id },
        data: {
          mode: 'strict-coverage/v1',
          declaredSubjectsJson: [pointer.subjectKey],
          eligibleSubjectsJson: [pointer.subjectKey],
        },
      });
      await p().currentEvaluationPointer.delete({ where: { id: pointer.id } });
      expect(
        await p().invariantEvaluation.findUnique({ where: { id: pointer.currentEvaluationId } }),
      ).not.toBeNull();
      await expect(compare()).rejects.toThrow(/MISSING_SUBJECT_POINTER/);
    } finally {
      await p().currentEvaluationPointer.create({ data: pointer });
      await p().runEligibilityProof.update({
        where: { id: proof.id },
        data: {
          mode: proof.mode,
          declaredSubjectsJson:
            proof.declaredSubjectsJson === null
              ? Prisma.DbNull
              : (proof.declaredSubjectsJson as object),
          eligibleSubjectsJson:
            proof.eligibleSubjectsJson === null
              ? Prisma.DbNull
              : (proof.eligibleSubjectsJson as object),
        },
      });
    }
    expect((await compare()).keys.find((key) => key.invariantKey === 'INV-IZ-1')?.agree).toBe(true);
  });

  it.each(['run', 'subject', 'evidence'] as const)(
    'rejects a pointer with foreign %s identity',
    async (kind) => {
      const pointer = await p().currentEvaluationPointer.findFirstOrThrow({
        where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
      });
      const foreign = await p().currentEvaluationPointer.findFirstOrThrow({
        where: { runId: first.runId, invariantKey: 'INV-IZ-1' },
      });
      try {
        await p().currentEvaluationPointer.update({
          where: { id: pointer.id },
          data:
            kind === 'run'
              ? { currentEvaluationId: foreign.currentEvaluationId }
              : kind === 'subject'
                ? { subjectKey: 'foreign-subject-detector' }
                : { evidenceHeadHash: '0'.repeat(64) },
        });
        await expect(compare()).rejects.toThrow(/foreign or superseded/);
      } finally {
        await p().currentEvaluationPointer.update({
          where: { id: pointer.id },
          data: {
            currentEvaluationId: pointer.currentEvaluationId,
            subjectKey: pointer.subjectKey,
            evidenceHeadHash: pointer.evidenceHeadHash,
          },
        });
      }
    },
  );

  it('rejects a superseded analysis generation', async () => {
    const pointer = await p().currentEvaluationPointer.findFirstOrThrow({
      where: { runId: second.runId },
    });
    try {
      await p().currentEvaluationPointer.update({
        where: { id: pointer.id },
        data: { analysisGeneration: pointer.analysisGeneration - 1n },
      });
      await expect(compare()).rejects.toThrow(/GENERATION_MISMATCH|superseded/);
    } finally {
      await p().currentEvaluationPointer.update({
        where: { id: pointer.id },
        data: { analysisGeneration: pointer.analysisGeneration },
      });
    }
  });

  it('refuses a missing bound proof rather than trusting an orphan pointer', async () => {
    const proof = await p().runEligibilityProof.findFirstOrThrow({
      where: { runId: second.runId, invariantKey: 'INV-IZ-1' },
    });
    try {
      await p().runEligibilityProof.update({
        where: { id: proof.id },
        data: { invariantKey: 'MISSING-PROOF-DETECTOR' },
      });
      await expect(compare()).rejects.toThrow(/MISSING_PROOF/);
    } finally {
      await p().runEligibilityProof.update({
        where: { id: proof.id },
        data: { invariantKey: proof.invariantKey },
      });
    }
  });

  it('refuses an unresolved derivation attempt even when C/P/D have not moved', async () => {
    const attempt = await beginDerivationAttempt(p(), second.runId, DERIVATION_KIND_RUN_EVIDENCE);
    try {
      await expect(compare()).rejects.toThrow(/DERIVATION_NOT_READY/);
    } finally {
      await failDerivationAttempt(
        p(),
        attempt,
        new Error('detector deliberately unresolved; no effects claimed'),
      );
    }
  });

  it.each(['C', 'P', 'D'] as const)(
    'refuses stale %s and authorizes only after real re-analysis',
    async (component) => {
      if (component === 'C') {
        const response = await fetch(`${demo.baseUrl}/health/live`);
        const observed = (await response.json()) as unknown;
        await new RawObservationStore(p()).appendTargetObservation({
          runId: second.runId,
          stepRunId: null,
          adapterKind: 'phase18-audit-health-read',
          observedAt: new Date(),
          payload: { observed },
          writerOwnerId: 'phase18-detector',
          writerFencingToken: null,
          provenanceIdentity: `p18-health:${second.runId}`,
        });
      } else {
        await p().$transaction(async (tx) => {
          await acquireRunLock(tx, second.runId);
          if (component === 'P') await advanceProvenanceRevision(tx, second.runId);
          else await advanceDerivationGeneration(tx, second.runId);
        });
      }
      await expect(compare()).rejects.toBeInstanceOf(RunComparisonError);
      await runRunAnalysis(p(), second.runId);
      expect((await compare()).keys.find((row) => row.invariantKey === 'INV-IZ-1')?.agree).toBe(
        true,
      );
    },
  );

  it('keeps raw truth append-only and refuses a corrupt integrity head', async () => {
    const observation = await p().rawObservation.findFirstOrThrow({
      where: { runId: second.runId },
    });
    await expect(
      p().rawObservation.update({
        where: { id: observation.id },
        data: { payload: { injectedCorruption: true } },
      }),
    ).rejects.toThrow(/append-only/);
    expect(
      (await p().rawObservation.findUniqueOrThrow({ where: { id: observation.id } })).payload,
    ).toEqual(observation.payload);
    const head = await p().evidenceIntegrityHead.findUniqueOrThrow({
      where: { runId: second.runId },
    });
    try {
      // Only verifier metadata is corrupted in this disposable detector DB;
      // the append-only guard is neither disabled nor bypassed.
      await p().evidenceIntegrityHead.update({
        where: { runId: second.runId },
        data: { headContentHash: '0'.repeat(64) },
      });
      await expect(compare()).rejects.toThrow(/integrity verification failed/);
    } finally {
      await p().evidenceIntegrityHead.update({
        where: { runId: second.runId },
        data: { headContentHash: head.headContentHash },
      });
    }
  });

  it('preserves colliding tuples, multiple subjects, and ABSENT sides without identity inference', async () => {
    const tuples = [
      ['AUDIT::N', 'X'],
      ['AUDIT', 'N::X'],
      ['AUDIT', 'another-subject'],
    ] as const;
    const publication = await readCurrentEvaluationPublication(p(), first.runId);
    const keys: PublicationKey[] = publication.proofs.map((proof) => ({
      invariantKey: proof.invariantKey,
      evaluatorVersion: proof.evaluatorVersion,
      registryVersion: '',
      eligibilityVersion: proof.eligibilityVersion,
      mode: proof.mode,
      coverage: null,
      subjects: publication.pointers
        .filter((pointer) => pointer.invariantKey === proof.invariantKey)
        .map((pointer) => ({
          subjectKey: pointer.subjectKey,
          evaluationId: pointer.currentEvaluationId,
          evidenceSetHash: pointer.evidenceHeadHash,
          verdict: pointer.verdict,
        })),
    }));
    // Explicit synthetic identity-detector evaluations, never business proof.
    for (const invariantKey of ['AUDIT::N', 'AUDIT']) {
      await p().invariantDefinition.create({
        data: {
          invariantKey,
          title: 'identity detector fixture',
          description: 'synthetic detector only, never target business truth',
        },
      });
      const batch = await p().evaluationBatch.create({
        data: { runId: first.runId, invariantKey, evaluatorVersion: 'v1', completedAt: new Date() },
      });
      const subjects: PublicationKey['subjects'][number][] = [];
      for (const [, subjectKey] of tuples.filter(([key]) => key === invariantKey)) {
        const row = await p().invariantEvaluation.create({
          data: {
            batchId: batch.id,
            runId: first.runId,
            invariantKey,
            evaluatorVersion: 'v1',
            subjectKey,
            verdict: 'FAIL',
            reason: 'synthetic identity detector fixture',
            evidenceSetHash: 'a'.repeat(64),
            completenessBasis: 'detector-fixture',
            details: {},
            sourceObservationHashes: [],
            normalizedEventIds: [],
            causalRelationshipIds: [],
          },
        });
        subjects.push({
          subjectKey,
          evaluationId: row.id,
          evidenceSetHash: row.evidenceSetHash,
          verdict: row.verdict,
        });
      }
      keys.push({
        invariantKey,
        evaluatorVersion: 'v1',
        registryVersion: '',
        eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
        mode: 'legacy-compat',
        coverage: null,
        subjects,
      });
    }
    try {
      expect(
        (
          await publishAnalysisGeneration(
            p(),
            first.runId,
            await readTruthInputWatermark(p(), first.runId),
            keys,
          )
        ).published,
      ).toBe(true);
      const subjects = (await compare()).subjects.filter((row) =>
        row.invariantKey.startsWith('AUDIT'),
      );
      expect(subjects).toHaveLength(3);
      expect(subjects.map((row) => [row.invariantKey, row.subjectKey])).toEqual(
        expect.arrayContaining(tuples.map((tuple) => [...tuple])),
      );
      expect(subjects.every((row) => row.replayVerdict === 'ABSENT')).toBe(true);
      const replayPublication = await readCurrentEvaluationPublication(p(), second.runId);
      const replayKeys: PublicationKey[] = replayPublication.proofs.map((proof) => ({
        invariantKey: proof.invariantKey,
        evaluatorVersion: proof.evaluatorVersion,
        registryVersion: '',
        eligibilityVersion: proof.eligibilityVersion,
        mode: proof.mode,
        coverage: null,
        subjects: replayPublication.pointers
          .filter((pointer) => pointer.invariantKey === proof.invariantKey)
          .map((pointer) => ({
            subjectKey: pointer.subjectKey,
            evaluationId: pointer.currentEvaluationId,
            evidenceSetHash: pointer.evidenceHeadHash,
            verdict: pointer.verdict,
          })),
      }));
      for (const [invariantKey, subjectKey] of tuples.slice(0, 2)) {
        const batch = await p().evaluationBatch.create({
          data: {
            runId: second.runId,
            invariantKey,
            evaluatorVersion: 'v1',
            completedAt: new Date(),
          },
        });
        const row = await p().invariantEvaluation.create({
          data: {
            batchId: batch.id,
            runId: second.runId,
            invariantKey,
            evaluatorVersion: 'v1',
            subjectKey,
            verdict: 'PASS',
            reason: 'synthetic identity detector fixture',
            evidenceSetHash: 'b'.repeat(64),
            completenessBasis: 'detector-fixture',
            details: {},
            sourceObservationHashes: [],
            normalizedEventIds: [],
            causalRelationshipIds: [],
          },
        });
        replayKeys.push({
          invariantKey,
          evaluatorVersion: 'v1',
          registryVersion: '',
          eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
          mode: 'legacy-compat',
          coverage: null,
          subjects: [
            {
              subjectKey,
              evaluationId: row.id,
              evidenceSetHash: row.evidenceSetHash,
              verdict: row.verdict,
            },
          ],
        });
      }
      expect(
        (
          await publishAnalysisGeneration(
            p(),
            second.runId,
            await readTruthInputWatermark(p(), second.runId),
            replayKeys,
          )
        ).published,
      ).toBe(true);
      const paired = (await compare()).subjects.filter((row) =>
        row.invariantKey.startsWith('AUDIT'),
      );
      expect(paired).toHaveLength(3);
      expect(paired.filter((row) => row.replayVerdict === 'PASS')).toHaveLength(2);
      expect(paired.find((row) => row.subjectKey === 'another-subject')?.replayVerdict).toBe(
        'ABSENT',
      );
      expect(paired.every((row) => row.baseVerdict === 'FAIL' && row.verdictsDiffer)).toBe(true);
    } finally {
      const where = { invariantKey: { in: ['AUDIT::N', 'AUDIT'] } };
      await p().currentEvaluationPointer.deleteMany({ where });
      await p().runEligibilityProof.deleteMany({ where });
      await p().invariantEvaluation.deleteMany({ where });
      await p().evaluationBatch.deleteMany({ where });
      await p().invariantDefinition.deleteMany({ where });
    }
  });
});
