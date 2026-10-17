// =====================================================================
// Integration — Phase 18: Replay/regression lifecycle on Demo Fintech
// (Incident Zero; ADR-0019 Decision 4; incident-replay §3)
// =====================================================================
// The second domain of the Phase 18 regression proof. REAL Demo
// Fintech processes + the REAL worker + REAL Control PostgreSQL/Redis
// driven through the accepted incident-zero golden API
// (runGoldenScenario) — the same interfaces a human operator uses.
// Every mode pins ONE frozen intent ("ALL runs of a mode pin the SAME
// snapshot content hash" — run.ts), so a second VULNERABLE execution
// IS a same-snapshot replay by construction: new run, new evidence,
// same hash. Assertions come from durable Control-Plane truth, never
// from test-side simulation.
//
// Proven here on real infrastructure:
//   - vulnerable ⇒ genuine FAIL + Finding (twice, independently);
//   - same-hash second execution ⇒ independently computed FAIL, the
//     first run's history byte-unchanged;
//   - comparison of the same-hash pair (no verdict differs);
//   - secure ⇒ PASS + zero Findings;
//   - cross-intent (vulnerable vs secure) comparison refused;
//   - credential references are names only (R-13).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';
import { registerDemoTarget } from './helpers/phase4-harness.js';
import type { ControlDb } from '@rupturegrid/control-db';
import { runGoldenScenario } from '@rupturegrid/incident-zero';
import { compareReplayRuns, RunComparisonError } from '@rupturegrid/forensics';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess } from './helpers/demo-harness.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import { startPhase4Worker } from './helpers/phase4-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { uniqueName } from './helpers/execution-harness.js';

let env = loadTestEnv();
let ownedFixture: OwnedControlFixture;
// Each mode retains one registration in this fixture's owned Control
// namespace. Repeated executions bind that same ID and frozen intent;
// no other suite's registration or experiment definition is inherited.
const VULN_PORT = Number(process.env.DEMO_P18_VULN_PORT ?? '3127');
const SECURE_PORT = Number(process.env.DEMO_P18_SECURE_PORT ?? '3131');

let controlDb: ControlDb;
let demoVulnerable: RunningDemo;
let demoSecure: RunningDemo;
let worker: RunningWorker | null = null;
let vulnerableTargetId = '';
let secureTargetId = '';

type GoldenResult = Awaited<ReturnType<typeof runGoldenScenario>>;
let vulnerableFirst: GoldenResult | null = null;
let vulnerableSecond: GoldenResult | null = null;
let secureResult: GoldenResult | null = null;

beforeAll(async () => {
  ownedFixture = await createOwnedControlFixture(env);
  env = ownedFixture.env;
  controlDb = ownedFixture.controlDb;
  demoVulnerable = await startDemoProcess(env, VULN_PORT);
  demoSecure = await startDemoProcess(env, SECURE_PORT);
  worker ??= await startPhase4Worker(env);
  const vulnerableRegistration = await registerDemoTarget(
    ownedFixture,
    demoVulnerable,
    uniqueName('p18-fintech-vulnerable'),
  );
  vulnerableTargetId = vulnerableRegistration.targetId;
  const secureRegistration = await registerDemoTarget(
    ownedFixture,
    demoSecure,
    uniqueName('p18-fintech-secure'),
  );
  secureTargetId = secureRegistration.targetId;
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await demoVulnerable.close();
  await demoSecure.close();
  await ownedFixture.close();
});

describe('Phase 18 fintech: same-snapshot replay determinism + fix verification', () => {
  it('discovers a genuine vulnerable failure (FAIL + Finding)', async () => {
    vulnerableFirst = await runGoldenScenario({
      prisma: controlDb.prisma,
      redisUrl: env.redisUrl,
      queuePrefix: env.queuePrefix,
      targetId: vulnerableTargetId,
      mode: 'VULNERABLE',
    });
    expect(vulnerableFirst.runState).toBe('COMPLETED');
    expect(vulnerableFirst.evaluation?.verdict).toBe('FAIL');
    expect(vulnerableFirst.finding).not.toBe(null);
    expect(vulnerableFirst.integrity.chainValid).toBe(true);
    expect(vulnerableFirst.reproductionDefinition?.targetModeRequirement).toBe('VULNERABLE');
    // Credential references are names only — never values (R-13).
    expect(vulnerableFirst.reproductionDefinition?.credentialRefs ?? []).not.toContain(
      env.demoAdminToken,
    );
    expect(vulnerableFirst.reproductionDefinition?.snapshotContentHash).toBe(
      vulnerableFirst.snapshotContentHash,
    );
  }, 240_000);

  it('re-executes the same frozen intent: independently computed FAIL, history preserved', async () => {
    expect(vulnerableFirst).not.toBe(null);
    const first = vulnerableFirst as GoldenResult;
    const before = {
      observations: await controlDb.prisma.rawObservation.findMany({
        where: { runId: first.runId },
        select: { id: true, contentHash: true },
        orderBy: { chainIndex: 'asc' },
      }),
      evaluations: await controlDb.prisma.invariantEvaluation.findMany({
        where: { runId: first.runId },
        select: { id: true, verdict: true, reason: true },
        orderBy: { id: 'asc' },
      }),
      findings: await controlDb.prisma.finding.findMany({
        where: { runId: first.runId },
        select: { id: true, reasonCode: true },
        orderBy: { id: 'asc' },
      }),
    };
    vulnerableSecond = await runGoldenScenario({
      prisma: controlDb.prisma,
      redisUrl: env.redisUrl,
      queuePrefix: env.queuePrefix,
      targetId: vulnerableTargetId,
      mode: 'VULNERABLE',
    });
    // A NEW run from the SAME hash-pinned snapshot (run.ts: all runs of
    // a mode share one frozen intent).
    expect(vulnerableSecond.runId).not.toBe(first.runId);
    expect(vulnerableSecond.snapshotContentHash).toBe(first.snapshotContentHash);
    expect(vulnerableSecond.evaluation?.verdict).toBe('FAIL');
    expect(vulnerableSecond.finding).not.toBe(null);
    // Independently computed: distinct evaluation identity.
    expect(vulnerableSecond.evaluation?.id).not.toBe(first.evaluation?.id);
    // Historical evidence preservation: the first run's rows are unchanged.
    const after = {
      observations: await controlDb.prisma.rawObservation.findMany({
        where: { runId: first.runId },
        select: { id: true, contentHash: true },
        orderBy: { chainIndex: 'asc' },
      }),
      evaluations: await controlDb.prisma.invariantEvaluation.findMany({
        where: { runId: first.runId },
        select: { id: true, verdict: true, reason: true },
        orderBy: { id: 'asc' },
      }),
      findings: await controlDb.prisma.finding.findMany({
        where: { runId: first.runId },
        select: { id: true, reasonCode: true },
        orderBy: { id: 'asc' },
      }),
    };
    expect(after.observations).toEqual(before.observations);
    expect(after.evaluations).toEqual(before.evaluations);
    expect(after.findings).toEqual(before.findings);
  }, 240_000);

  it('compares the same-hash fintech pair from durable truth', async () => {
    expect(vulnerableFirst).not.toBe(null);
    expect(vulnerableSecond).not.toBe(null);
    const comparison = await compareReplayRuns(
      controlDb.prisma,
      (vulnerableFirst as GoldenResult).runId,
      (vulnerableSecond as GoldenResult).runId,
    );
    expect(comparison.snapshotContentHash).toBe(
      (vulnerableFirst as GoldenResult).snapshotContentHash,
    );
    expect(comparison.subjects.length).toBeGreaterThan(0);
    // Per-key verdict domains agree (INV-IZ-1 FAIL on both sides).
    // Per-run generated payment identities never match across runs, so
    // per-subject rows honestly show presence/absence — agreement is
    // about the verdict domain per key, never subject-identity equality.
    const key = comparison.keys.find((entry) => entry.invariantKey === 'INV-IZ-1');
    expect(key?.agree).toBe(true);
    expect(key?.baseVerdicts).toEqual(['FAIL']);
    expect(key?.replayVerdicts).toEqual(['FAIL']);
    expect(key?.evaluatorVersionsDiffer).toBe(false);
    // F-1: legacy persisted equivalentEffectCount must remain visible
    // even though generated subjects differ between these executions.
    expect(
      comparison.subjects
        .filter((row) => row.invariantKey === 'INV-IZ-1' && row.baseVerdict === 'FAIL')
        .map((row) => row.baseEffectCount),
    ).toEqual([2]);
    expect(
      comparison.subjects
        .filter((row) => row.invariantKey === 'INV-IZ-1' && row.replayVerdict === 'FAIL')
        .map((row) => row.replayEffectCount),
    ).toEqual([2]);
    expect(comparison.schedulingNote).toMatch(/Scheduling variance is expected/);
  }, 120_000);

  it('verifies the fix: secure ⇒ PASS + zero Findings', async () => {
    secureResult = await runGoldenScenario({
      prisma: controlDb.prisma,
      redisUrl: env.redisUrl,
      queuePrefix: env.queuePrefix,
      targetId: secureTargetId,
      mode: 'SECURE',
    });
    expect(secureResult.evaluation?.verdict).toBe('PASS');
    expect(secureResult.finding).toBe(null);
    expect(await controlDb.prisma.finding.count({ where: { runId: secureResult.runId } })).toBe(0);
    // A different frozen intent (the secure document pins SECURE) —
    // stated, never hidden (ADR-0027).
    expect(secureResult.snapshotContentHash).not.toBe(
      (vulnerableFirst as GoldenResult).snapshotContentHash,
    );
  }, 240_000);

  it('refuses cross-intent fintech comparison', async () => {
    expect(vulnerableFirst).not.toBe(null);
    expect(secureResult).not.toBe(null);
    await expect(
      compareReplayRuns(
        controlDb.prisma,
        (vulnerableFirst as GoldenResult).runId,
        (secureResult as GoldenResult).runId,
      ),
    ).rejects.toBeInstanceOf(RunComparisonError);
  }, 120_000);
});
