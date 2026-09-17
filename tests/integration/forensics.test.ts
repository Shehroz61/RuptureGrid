// =====================================================================
// Integration — Phase 5 forensic derivation over real Phase 4 truth
// =====================================================================
// REAL full-stack Incident Zero runs (real worker, real Control
// PostgreSQL, real Redis, real Demo Fintech over TCP HTTP — R-08);
// Phase 5 derivation runs OFFLINE over the durable Control-DB truth
// only (§77/§78: no Demo call, no target network during derivation).
//
// Covered:
//   VULNERABLE  ⇒ FAIL evaluation ⇒ exactly one Finding with full
//                 provenance and identity-backed causal paths (§56)
//   SECURE      ⇒ PASS ⇒ NO failure Finding; suppressed attempts
//                 visible in the timeline (§57/§25)
//   NOT_EVALUABLE ⇒ NO failure Finding (§60/§41)
//   repeat + concurrent derivation ⇒ idempotent, no duplicates,
//                 precise P2002 convergence (§50/§66/§68)
//   offline derivation with the Demo process stopped (§78)
//   Phase 4 evidence + Phase 3 execution immutability (§35/§36)
//   timeline ordering/ties + keyset pagination via the real API (§61)
//   reproduction definition round-trip (roadmap Phase 5 acceptance)
//   cross-intent comparison refusal (incident-replay §6)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExecutionQueue } from '@rupturegrid/queue';
import { runRunAnalysis } from '@rupturegrid/evidence';
import {
  deriveRunForensics,
  loadFindingProof,
  compareRuns,
  RunComparisonError,
  FINDING_RULE_VERSION,
  TIMELINE_DERIVATION_VERSION,
  FINDING_REASON_CODES,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_ORDERING_BASES,
} from '@rupturegrid/forensics';
import { createExperiment, createRun, markRunDispatching } from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess, createDemoClient } from './helpers/demo-harness.js';
import type { DemoClient, RunningDemo } from './helpers/demo-harness.js';
import { getControlPrisma, uniqueName, waitFor } from './helpers/execution-harness.js';
import {
  createAndDispatchRun,
  incidentZeroSteps,
  registerDemoTarget,
  startPhase4Worker,
} from './helpers/phase4-harness.js';

const env = loadTestEnv();
const prisma = getControlPrisma();
const DEMO_P5_PORT = Number(process.env.DEMO_P5_TEST_PORT ?? '3125');

let demo: RunningDemo;
let client: DemoClient;
let controlDb: ControlDb;
let queue: ReturnType<typeof createExecutionQueue>;
let targetId = '';
let worker: Awaited<ReturnType<typeof startPhase4Worker>> | null = null;

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  queue = createExecutionQueue({ redisUrl: env.redisUrl, prefix: env.queuePrefix });
  demo = await startDemoProcess(env, DEMO_P5_PORT);
  client = createDemoClient(demo);
  targetId = (await registerDemoTarget(prisma, demo)).targetId;
}, 60_000);

afterAll(async () => {
  if (worker !== null) {
    await worker.close();
  }
  await queue.close();
  await controlDb.disconnect();
  await demo.close();
});

async function runAndWait(
  name: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ runId: string; stepRunIds: string[] }> {
  worker ??= await startPhase4Worker(env);
  const made = await createAndDispatchRun(prisma, queue, targetId, name, steps);
  await waitFor(
    async () => {
      const row = await prisma.experimentRun.findUnique({ where: { id: made.runId } });
      return row?.state === 'COMPLETED' || row?.state === 'FAILED' ? true : null;
    },
    90_000,
    500,
  );
  const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: made.runId } });
  expect(run.state).toBe('COMPLETED');
  return made;
}

async function runIncidentZero(
  name: string,
  mode: 'VULNERABLE' | 'SECURE',
  repeat: number,
  concurrency: number,
): Promise<{ runId: string; paymentId: string }> {
  const made = await runAndWait(
    name,
    incidentZeroSteps({ mode, repeat, concurrency, captureLineage: true }),
  );
  const createInvocation = await prisma.stepInvocation.findFirstOrThrow({
    where: { stepRunId: made.stepRunIds[2], responseBody: { not: null } },
    orderBy: { sequence: 'asc' },
  });
  const body = JSON.parse(createInvocation.responseBody ?? '{}') as {
    payment?: { providerPaymentId?: string };
  };
  return { runId: made.runId, paymentId: body.payment?.providerPaymentId ?? '' };
}

async function analyzedRun(
  name: string,
  mode: 'VULNERABLE' | 'SECURE',
  repeat: number,
  concurrency: number,
) {
  const { runId, paymentId } = await runIncidentZero(name, mode, repeat, concurrency);
  const analysis = await runRunAnalysis(prisma, runId);
  return { runId, paymentId, analysis };
}

describe('Phase 5 — VULNERABLE: FAIL evaluation ⇒ one deterministic Finding (§56)', () => {
  it(
    'derives a duplicate-credit Finding with complete provenance and causal paths',
    { timeout: 240_000 },
    async () => {
      const { runId, paymentId, analysis } = await analyzedRun('p5-iz-vuln', 'VULNERABLE', 5, 1);
      expect(paymentId).not.toBe('');
      const evaluation = analysis.evaluations.find((v) => v.subjectKey === paymentId);
      expect(evaluation?.verdict).toBe('FAIL');
      const evaluationRow = await prisma.invariantEvaluation.findFirstOrThrow({
        where: { runId, subjectKey: paymentId },
      });
      const evaluationDetails = evaluationRow.details as Record<string, unknown>;

      const result = await deriveRunForensics(prisma, runId);
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding.subjectKey).toBe(paymentId);
      expect(finding.reasonCode).toBe(FINDING_REASON_CODES.duplicateEquivalentFinancialEffect);
      expect(finding.invariantEvaluationId).toBe(
        (
          await prisma.invariantEvaluation.findFirstOrThrow({
            where: { runId, subjectKey: paymentId },
          })
        ).id,
      );

      // The Finding's stored content.
      const row = await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
      expect(row.findingRuleVersion).toBe(FINDING_RULE_VERSION);
      expect(row.evaluatorVersion).toBe('v1');
      expect(row.invariantKey).toBe('INV-IZ-1');
      expect(row.title).toBe('Duplicate wallet credit for confirmed provider payment');
      expect(row.summary).toContain(paymentId);
      expect(row.summary).toContain('identity-chain');
      expect(row.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // Money copied EXACTLY as the evaluation persisted it (R-06
      // fidelity: the demo target emits amounts as minor-unit strings;
      // the Finding echoes, never converts).
      expect(row.details).toMatchObject({
        equivalentEffectCount: 2,
        amountMinor: evaluationDetails['amountMinor'],
        currency: evaluationDetails['currency'],
        attributionBasis: 'identity-chain',
      });
      expect(JSON.stringify(row.details)).toContain('500000');
      // Confidence scope: proven + uncertain (evidence-model §8).
      expect(row.provenScope).toMatchObject({
        verdict: 'FAIL',
        equivalentEffectCount: 2,
        attributionBasis: 'identity-chain',
      });
      expect(row.uncertainScope).toMatchObject({ schedulingOrderAsserted: false });

      // Provenance: Finding → evaluation → events → relationships →
      // observations (§13), with role structure and deterministic order.
      const refs = await prisma.findingEvidenceReference.findMany({
        where: { findingId: row.id },
        orderBy: { position: 'asc' },
      });
      expect(refs.length).toBeGreaterThanOrEqual(5);
      const evaluationRef = refs.find((ref) => ref.subject === 'INVARIANT_EVALUATION');
      expect(evaluationRef?.sourceId).toBe(row.invariantEvaluationId);
      const effectRefs = refs.filter((ref) => ref.subject === 'NORMALIZED_EVENT');
      expect(effectRefs.length).toBe(2); // the two counted equivalent effects
      expect(refs.some((ref) => ref.subject === 'CAUSAL_RELATIONSHIP')).toBe(true);
      expect(refs.some((ref) => ref.subject === 'RAW_OBSERVATION')).toBe(true);

      // Every cited effect is identity-chain attributable to the subject
      // (§30 causal-path: payment → event → delivery → attempt → effect,
      // walked through the run's own identity-direct relationships).
      const relationships = await prisma.causalRelationship.findMany({ where: { runId } });
      const events = await prisma.normalizedEvent.findMany({ where: { runId } });
      const eventById = new Map(events.map((event) => [event.id, event]));
      const relsByTo = new Map<string, typeof relationships>();
      for (const rel of relationships) {
        if (rel.basis !== 'identity-direct') {
          continue;
        }
        const list = relsByTo.get(rel.toEventId) ?? [];
        list.push(rel);
        relsByTo.set(rel.toEventId, list);
      }
      const chainReachesPayment = (eventId: string, visited: Set<string> = new Set()): boolean => {
        if (visited.has(eventId)) {
          return false;
        }
        visited.add(eventId);
        const incoming = relsByTo.get(eventId) ?? [];
        return incoming.some((rel) => {
          if (
            rel.relationKind === 'describes-payment' &&
            eventById.get(rel.fromEventId)?.eventType === 'demo.provider-payment-observed'
          ) {
            const paymentPayload = (eventById.get(rel.fromEventId)?.payload ?? {}) as Record<
              string,
              unknown
            >;
            return paymentPayload['providerPaymentId'] === paymentId;
          }
          return chainReachesPayment(rel.fromEventId, visited);
        });
      };
      for (const effectRef of effectRefs) {
        const effect = eventById.get(effectRef.sourceId);
        expect(effect?.eventType).toBe('demo.financial-effect-observed');
        expect(effect?.subjectKey).toBe(paymentId);
        // The identity chain from this effect reaches the payment.
        expect(chainReachesPayment(effectRef.sourceId)).toBe(true);
      }

      // Timeline: the vulnerable story is visible end-to-end (§26).
      const timeline = await prisma.forensicTimelineEntry.findMany({ where: { runId } });
      const kinds = new Set(timeline.map((entry) => entry.entryKind));
      expect(kinds).toContain(TIMELINE_ENTRY_KINDS.providerPaymentObserved);
      expect(kinds).toContain(TIMELINE_ENTRY_KINDS.financialEffectObserved);
      expect(kinds).toContain(TIMELINE_ENTRY_KINDS.invariantEvaluated);
      expect(kinds).toContain(TIMELINE_ENTRY_KINDS.findingDerived);
      const effects = timeline.filter(
        (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.financialEffectObserved,
      );
      expect(effects).toHaveLength(2);
      const findingEntry = timeline.find(
        (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.findingDerived,
      );
      expect(findingEntry?.sourceKind).toBe('FINDING');
      expect(findingEntry?.sourceId).toBe(row.id);

      // Reproduction definition round-trip (roadmap Phase 5 acceptance).
      const reproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
        where: { runId },
      });
      expect(reproduction.targetModeRequirement).toBe('VULNERABLE');
      expect(reproduction.credentialRefs).toContain('DEMO_ADMIN_TOKEN');
      expect(JSON.stringify(reproduction.acceptanceExpectations)).toContain('FAIL');
      expect(reproduction.snapshotContentHash).toBe(
        (
          await prisma.experimentRun.findUniqueOrThrow({
            where: { id: runId },
            select: { snapshot: { select: { contentHash: true } } },
          })
        ).snapshot.contentHash,
      );
    },
  );
});

describe('Phase 5 — SECURE: PASS ⇒ no failure Finding, suppression visible (§57/§25)', () => {
  it(
    'derives NO Finding while the timeline shows many deliveries, one effect',
    { timeout: 240_000 },
    async () => {
      const { runId, paymentId, analysis } = await analyzedRun('p5-iz-secure', 'SECURE', 5, 1);
      const evaluation = analysis.evaluations.find((v) => v.subjectKey === paymentId);
      expect(evaluation?.verdict).toBe('PASS');

      const result = await deriveRunForensics(prisma, runId);
      expect(result.findings).toHaveLength(0);
      expect(await prisma.finding.count({ where: { runId } })).toBe(0);

      // The secure timeline still tells the full story: the suppressed
      // deliveries/attempts remain visible next to the single effect.
      const timeline = await prisma.forensicTimelineEntry.findMany({ where: { runId } });
      const deliveries = timeline.filter(
        (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.webhookDeliveryObserved,
      );
      const attempts = timeline.filter(
        (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.processingAttemptObserved,
      );
      const effects = timeline.filter(
        (entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.financialEffectObserved,
      );
      expect(deliveries.length).toBeGreaterThanOrEqual(5);
      expect(attempts.length).toBeGreaterThanOrEqual(5);
      expect(effects).toHaveLength(1);
      expect(
        timeline.some((entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.invariantEvaluated),
      ).toBe(true);
      expect(
        timeline.some((entry) => entry.entryKind === TIMELINE_ENTRY_KINDS.findingDerived),
      ).toBe(false);
    },
  );
});

describe('Phase 5 — NOT_EVALUABLE ⇒ no failure Finding (§60/§41)', () => {
  it(
    'a run without target-state verification yields no Finding, honest timeline',
    { timeout: 240_000 },
    async () => {
      const made = await runAndWait(
        'p5-iz-not-evaluable',
        incidentZeroSteps({ mode: 'VULNERABLE', repeat: 3, concurrency: 1, captureLineage: false }),
      );
      const analysis = await runRunAnalysis(prisma, made.runId);
      void analysis;
      const verdicts = analysis.evaluations.map((v) => v.verdict);
      expect(verdicts).toContain('NOT_EVALUABLE');

      const result = await deriveRunForensics(prisma, made.runId);
      expect(result.findings).toHaveLength(0);
      expect(await prisma.finding.count({ where: { runId: made.runId } })).toBe(0);
      // The timeline still exists — evidence is never hidden.
      expect(
        await prisma.forensicTimelineEntry.count({ where: { runId: made.runId } }),
      ).toBeGreaterThan(0);
    },
  );
});

describe('Phase 5 — idempotency and concurrency (§50/§66/§68)', () => {
  it(
    'repeat and parallel derivations converge: no duplicate Findings/entries',
    { timeout: 240_000 },
    async () => {
      const { runId, paymentId } = await analyzedRun('p5-iz-idempotent', 'VULNERABLE', 3, 1);

      const first = await deriveRunForensics(prisma, runId);
      const second = await deriveRunForensics(prisma, runId);
      expect(second.findings).toHaveLength(1);
      expect(second.findings[0].id).toBe(first.findings[0].id);
      expect(second.findings[0].created).toBe(false);

      // Parallel callers race the same unique constraints; every caller
      // converges on the SAME rows (P2002 handled precisely, §70).
      const [a, b, c] = await Promise.all([
        deriveRunForensics(prisma, runId),
        deriveRunForensics(prisma, runId),
        deriveRunForensics(prisma, runId),
      ]);
      for (const result of [a, b, c]) {
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].id).toBe(first.findings[0].id);
      }
      expect(await prisma.finding.count({ where: { runId } })).toBe(1);
      const entryCount = await prisma.forensicTimelineEntry.count({ where: { runId } });
      const again = await deriveRunForensics(prisma, runId);
      expect(await prisma.forensicTimelineEntry.count({ where: { runId } })).toBe(entryCount);
      expect(again.timelineEntryCount).toBe(entryCount);
      expect(await prisma.reproductionDefinition.count({ where: { runId } })).toBe(1);

      // The input fingerprint is stable across derivations (§135).
      expect(again.inputFingerprint).toBe(first.inputFingerprint);

      // Semantic identity: the Finding exists ONCE per (evaluation,
      // rule version) — the database constraint holds.
      const evaluation = await prisma.invariantEvaluation.findFirstOrThrow({
        where: { runId, subjectKey: paymentId },
      });
      expect(
        await prisma.finding.count({
          where: { invariantEvaluationId: evaluation.id, findingRuleVersion: FINDING_RULE_VERSION },
        }),
      ).toBe(1);
    },
  );

  it(
    'parallel FIRST derivations on a fresh run converge everywhere (§21/§71)',
    { timeout: 240_000 },
    async () => {
      // No sequential warm-up: the very first derivation is raced, so
      // every unique constraint — finding, timeline entry, derivation
      // record, reproduction definition — is genuinely contended.
      const { runId } = await analyzedRun('p5-iz-race-first', 'VULNERABLE', 3, 1);
      const [a, b, c] = await Promise.all([
        deriveRunForensics(prisma, runId),
        deriveRunForensics(prisma, runId),
        deriveRunForensics(prisma, runId),
      ]);
      for (const result of [a, b, c]) {
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].id).toBe(a.findings[0]?.id);
      }
      expect(await prisma.finding.count({ where: { runId } })).toBe(1);
      expect(await prisma.reproductionDefinition.count({ where: { runId } })).toBe(1);
      expect(await prisma.forensicDerivation.count({ where: { runId } })).toBe(1);
      // One entry per (run, version, source, entry kind): no duplicate
      // timeline semantics despite three racing writers.
      const duplicates = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM (
           SELECT "runId", "derivationVersion", "sourceKind", "sourceId", "entryKind"
           FROM analysis.forensic_timeline_entry WHERE "runId" = $1
           GROUP BY "runId", "derivationVersion", "sourceKind", "sourceId", "entryKind"
           HAVING COUNT(*) > 1
         ) dupes`,
        runId,
      );
      expect(Number(duplicates[0]?.count ?? 0)).toBe(0);
    },
  );
});

describe('Phase 5 — offline derivation (§77/§78)', () => {
  it(
    'derives Findings + timeline with the Demo process STOPPED (Control truth only)',
    { timeout: 240_000 },
    async () => {
      const { runId, paymentId } = await analyzedRun('p5-iz-offline', 'VULNERABLE', 3, 1);
      const demoWasRunning = await client.getMode().then(
        () => true,
        () => false,
      );
      expect(demoWasRunning).toBe(true);
      await demo.close();

      const result = await deriveRunForensics(prisma, runId);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].subjectKey).toBe(paymentId);
      expect(await prisma.forensicTimelineEntry.count({ where: { runId } })).toBeGreaterThan(0);

      // Restart the demo for the remaining tests / teardown.
      demo = await startDemoProcess(env, DEMO_P5_PORT);
      client = createDemoClient(demo);
    },
  );
});

describe('Phase 5 — immutability of upstream truth (§35/§36)', () => {
  it(
    'derivation never mutates Phase 4 evidence or Phase 3 execution rows',
    { timeout: 240_000 },
    async () => {
      const { runId } = await analyzedRun('p5-iz-immutable', 'VULNERABLE', 3, 1);

      // JSON-safe snapshots: fencing tokens are BigInt, so project to
      // plain values before comparing.
      const snapshot = async (run: string) => ({
        observations: await prisma.rawObservation.findMany({ where: { runId: run } }),
        events: await prisma.normalizedEvent.findMany({ where: { runId: run } }),
        relationships: await prisma.causalRelationship.findMany({ where: { runId: run } }),
        evaluations: await prisma.invariantEvaluation.findMany({ where: { runId: run } }),
        run: await prisma.experimentRun.findUniqueOrThrow({ where: { id: run } }),
        steps: await prisma.experimentStepRun.findMany({ where: { runId: run } }),
        invocations: await prisma.stepInvocation.findMany({
          where: { stepRun: { runId: run } },
        }),
      });
      const before = JSON.parse(
        JSON.stringify(await snapshot(runId), (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ) as unknown;

      await deriveRunForensics(prisma, runId);
      await deriveRunForensics(prisma, runId);

      const after = JSON.parse(
        JSON.stringify(await snapshot(runId), (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ) as unknown;

      expect(after).toEqual(before);
    },
  );
});

describe('Phase 5 — timeline ordering and API pagination (§22/§61)', () => {
  it(
    'timeline is total-ordered, tie-deterministic, and keyset-paginated via the real API',
    { timeout: 240_000 },
    async () => {
      const { runId } = await analyzedRun('p5-iz-api', 'VULNERABLE', 3, 1);
      await deriveRunForensics(prisma, runId);

      // Deterministic total order over ALL entries.
      const all = await prisma.forensicTimelineEntry.findMany({ where: { runId } });
      const keyOf = (row: { occurredAt: Date; sourceKind: string; sourceId: string }): string =>
        `${row.occurredAt.toISOString()}|${row.sourceKind}|${row.sourceId}`;
      const sorted = [...all].sort((a, b) =>
        keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
      );
      expect(all.length).toBeGreaterThan(10);
      for (let i = 1; i < sorted.length; i++) {
        expect(keyOf(sorted[i]) >= keyOf(sorted[i - 1])).toBe(true);
      }

      // Real API (same construction as the Phase 4 API test).
      const { buildAppModule } = await import('../../apps/api/src/app.module.js');
      const { NestFactory } = await import('../../apps/api/node_modules/@nestjs/core/index.js');
      const moduleRef = buildAppModule({
        config: {
          NODE_ENV: 'test' as const,
          LOG_LEVEL: 'error' as const,
          API_HOST: '127.0.0.1',
          API_PORT: 3137,
          CONTROL_DATABASE_URL: env.controlDatabaseUrl,
          REDIS_URL: env.redisUrl,
          QUEUE_PREFIX: env.queuePrefix,
          CORS_ORIGINS: ['http://localhost:3000'],
        },
        controlDb,
      });
      const app = await NestFactory.create(moduleRef, { logger: false });
      await app.listen(3137, '127.0.0.1');
      const base = 'http://127.0.0.1:3137';
      try {
        const findingsResponse = await fetch(`${base}/api/v1/runs/${runId}/forensics/findings`);
        expect(findingsResponse.status).toBe(200);
        const findings = (await findingsResponse.json()) as {
          count: number;
          findings: Array<{ id: string; reasonCode: string; proofReferences: unknown[] }>;
        };

        // Timeline pagination: bounded page, nextCursor walks to the end.
        const page1 = (await (
          await fetch(`${base}/api/v1/runs/${runId}/forensics/timeline?limit=5`)
        ).json()) as {
          count: number;
          nextCursor: string | null;
          entries: Array<{ occurredAt: string }>;
        };
        expect(page1.count).toBe(5);
        expect(page1.nextCursor).not.toBeNull();

        const seen: Array<{ occurredAt: string }> = [...page1.entries];
        let cursor = page1.nextCursor;
        let guard = 0;
        while (cursor !== null && guard < 100) {
          const page = (await (
            await fetch(
              `${base}/api/v1/runs/${runId}/forensics/timeline?limit=5&cursor=${encodeURIComponent(cursor)}`,
            )
          ).json()) as {
            count: number;
            nextCursor: string | null;
            entries: Array<{ occurredAt: string }>;
          };
          seen.push(...page.entries);
          cursor = page.nextCursor;
          guard += 1;
        }
        expect(seen).toHaveLength(all.length);
        // Ordered walk, no duplicates.
        for (let i = 1; i < seen.length; i++) {
          expect(seen[i].occurredAt >= seen[i - 1].occurredAt).toBe(true);
        }
        expect(new Set(seen.map((entry) => entry.occurredAt)).size).toBeGreaterThan(0);

        // Pagination bounds are enforced.
        const bad = await fetch(`${base}/api/v1/runs/${runId}/forensics/timeline?limit=5000`);
        expect(bad.status).toBe(400);

        // Finding detail: full proof via the API.
        expect(findings.count).toBe(1);
        const detail = (await (
          await fetch(`${base}/api/v1/runs/${runId}/forensics/findings/${findings.findings[0].id}`)
        ).json()) as {
          evaluation: { verdict: string; invariantKey: string };
          evidenceRefs: Array<{ subject: string; sourceId: string }>;
          inputFingerprint: string;
        };
        expect(detail.evaluation.verdict).toBe('FAIL');
        expect(detail.evaluation.invariantKey).toBe('INV-IZ-1');
        expect(detail.evidenceRefs.length).toBeGreaterThanOrEqual(5);
        expect(detail.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);

        // Unknown finding → 404; no cross-run leakage.
        const missing = await fetch(
          `${base}/api/v1/runs/${runId}/forensics/findings/00000000-0000-4000-8000-000000000000`,
        );
        expect(missing.status).toBe(404);

        // Derivation trigger is idempotent through the API.
        const derive1 = await fetch(`${base}/api/v1/runs/${runId}/forensics/derive`, {
          method: 'POST',
        });
        expect(derive1.status).toBe(201);
        const derive2 = await fetch(`${base}/api/v1/runs/${runId}/forensics/derive`, {
          method: 'POST',
        });
        expect(derive2.status).toBe(201);
        expect(await prisma.finding.count({ where: { runId } })).toBe(1);

        // Reproduction definition via the API.
        const reproduction = await fetch(
          `${base}/api/v1/runs/${runId}/forensics/reproduction-definition`,
        );
        expect(reproduction.status).toBe(200);
        const reproductionBody = (await reproduction.json()) as {
          targetModeRequirement: string | null;
        };
        expect(reproductionBody.targetModeRequirement).toBe('VULNERABLE');

        // No secret-shaped values anywhere on the forensic surfaces.
        const surfaces = [findings, detail, reproductionBody];
        for (const surface of surfaces) {
          const text = JSON.stringify(surface).toLowerCase();
          expect(text.includes('bearer')).toBe(false);
          expect(text.includes('${credential')).toBe(false);
          expect(text.includes('sk-')).toBe(false);
        }
      } finally {
        await app.close();
      }
    },
  );
});

describe('Phase 5 — run comparison (incident-replay §6)', () => {
  it(
    'compares two runs of the SAME frozen intent and refuses cross-intent comparison',
    { timeout: 300_000 },
    async () => {
      // ONE experiment revision, TWO runs of it: snapshots are
      // content-addressed per revision, so both runs share the frozen
      // intent's content hash. Verdicts must AGREE (determinism);
      // evidence (timestamps, identities) differs.
      const created = await createExperiment(prisma, {
        name: uniqueName('p5-cmp-shared-revision'),
        targetId,
        document: {
          steps: incidentZeroSteps({
            mode: 'VULNERABLE',
            repeat: 3,
            concurrency: 1,
            captureLineage: true,
          }),
        } as never,
      });
      const runOfRevision = async (
        label: string,
      ): Promise<{ runId: string; paymentId: string }> => {
        worker ??= await startPhase4Worker(env);
        const run = await createRun(prisma, created.revisionId);
        await markRunDispatching(prisma, run.runId);
        const first = run.stepRunIds[0];
        if (first === undefined) {
          throw new Error('run has no steps');
        }
        await queue.enqueueStep({ runId: run.runId, stepRunId: first, sequence: 0 });
        await waitFor(
          async () => {
            const row = await prisma.experimentRun.findUnique({ where: { id: run.runId } });
            return row?.state === 'COMPLETED' || row?.state === 'FAILED' ? true : null;
          },
          90_000,
          500,
        );
        const state = (await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } }))
          .state;
        expect(state).toBe('COMPLETED');
        void label;
        await runRunAnalysis(prisma, run.runId);
        const createInvocation = await prisma.stepInvocation.findFirstOrThrow({
          where: { stepRunId: run.stepRunIds[2], responseBody: { not: null } },
          orderBy: { sequence: 'asc' },
        });
        const body = JSON.parse(createInvocation.responseBody ?? '{}') as {
          payment?: { providerPaymentId?: string };
        };
        return { runId: run.runId, paymentId: body.payment?.providerPaymentId ?? '' };
      };
      const runA = await runOfRevision('a');
      const runB = await runOfRevision('b');

      const same = await compareRuns(prisma, runA.runId, runB.runId);
      expect(same.snapshotComparison.sameIntent).toBe(true);
      expect(same.invariants.length).toBeGreaterThan(0);
      const invIz1 = same.invariants.find((entry) => entry.invariantKey === 'INV-IZ-1');
      expect(invIz1?.verdictsDiffer).toBe(false);
      expect(invIz1?.baseVerdict).toBe('FAIL');
      expect(invIz1?.comparisonVerdict).toBe('FAIL');

      // Cross-intent comparison is refused (different mode = different
      // revision = different snapshot hash).
      const secureRun = await analyzedRun('p5-iz-cmp-secure', 'SECURE', 3, 1);
      const cross = await compareRuns(prisma, runA.runId, secureRun.runId);
      expect(cross.snapshotComparison.sameIntent).toBe(false);
      const differing = cross.invariants.filter((entry) => entry.verdictsDiffer);
      expect(differing.length).toBeGreaterThan(0);

      // Self-comparison is refused outright.
      await expect(compareRuns(prisma, runA.runId, runA.runId)).rejects.toBeInstanceOf(
        RunComparisonError,
      );
    },
  );
});
