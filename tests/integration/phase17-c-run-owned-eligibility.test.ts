// =====================================================================
// Integration — Phase 17 Checkpoint C: run-owned eligibility and
// authoritative current-evaluation publication (ADR-0026 §5–§15)
// =====================================================================
// Every case below drives the REAL stack (R-08): a real HTTP fixture
// target, the REAL StepProcessor (fenced claims + real terminal
// `SUCCEEDED` writes), the REAL inspection capture pipeline, the REAL
// generic derivation + analysis pipeline, the REAL reconciler settlement,
// and the REAL Control PostgreSQL — including the real per-run advisory
// lock publication transaction. Assertions read DURABLE rows (proof,
// pointer, InvariantEvaluation, Finding) plus the READ-ONLY publication
// surface Checkpoint D will consume; they never assert on a helper's
// return value alone and never invent an observation.
//
// Counterexample map (checkpoint mandate §15): C0 marker-only readiness
// race, C-01/C-02/C-03 foreign-scope non-contamination, C-04 generation
// separation, C-05/C-06 strict coverage anomalies, C-07 missing declared
// subject, C-08 redacted/type-invalid fail-closed, C-09 incomplete
// observed total, C-11/C-12/C-13 stale composite watermark, C-16
// concurrent publication, C-17 same-fingerprint reuse at a newer
// watermark, C-18 missing proof/pointer, C-19 conflicting evaluator
// version, C-20 legacy snapshot compatibility. C-14 (foreign derived
// commit before stage 2) is B2's D-13 proven with real fault injection;
// this suite asserts the publication-facing consequences of the same
// watermark discipline.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createOwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { OwnedControlFixture } from './helpers/owned-control-fixture.js';
import type { ControlDb, PrismaClient } from '@rupturegrid/control-db';
import {
  RUN_SCOPE_ELIGIBILITY_VERSION,
  StepProcessor,
  createCredentialResolver,
  createExperiment,
  createRun,
  markRunDispatching,
  settleRuns,
} from '@rupturegrid/engine';
import {
  DERIVATION_KIND_RUN_EVIDENCE,
  beginDerivationAttempt,
  captureGenericInspectionSet,
  captureStage1Source,
  createEngineEvidenceSink,
  deriveRunEvidence,
  failDerivationAttempt,
  loadFrozenEvidencePolicy,
  loadPersistedCaptureStatuses,
  publishAnalysisGeneration,
  readCurrentEvaluationPublication,
  readDerivationReadiness,
  readTruthInputWatermark,
  runRunAnalysis,
} from '@rupturegrid/evidence';
import type { PublicationKey, TruthInputWatermark } from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import { loadTestEnv } from './helpers/env.js';
import { uniqueName } from './helpers/execution-harness.js';

const prisma = (): PrismaClient => controlDb!.prisma;

let controlDb: ControlDb | null = null;
let ownedFixture: OwnedControlFixture | null = null;
let baseUrl = '';
let manifestTargetId: string | null = null;

const SETUP_STEP = 'establish-scope';
const ANCHOR_PATH = '/admin/establish-scope';
const CHK_VERSION = 'generic-invariant/v1';
const OWN_SCOPE = 'scope-owned';
const FOREIGN_SCOPE = 'scope-foreign';

// ---------------------------------------------------------------------
// Fixture target state (the HTTP surface serves exactly this)
// ---------------------------------------------------------------------
interface FixtureRow {
  readonly [field: string]: string | number;
}

interface FixtureState {
  readonly setupScope: string;
  readonly setupGeneration: number;
  readonly checkoutIntents: FixtureRow[];
  readonly orders: FixtureRow[];
  readonly ordersSummary: FixtureRow[];
  readonly skus: FixtureRow[];
  readonly stockBaseline: FixtureRow[];
  readonly stockRemaining: FixtureRow[];
  readonly reservations: FixtureRow[];
  readonly reservationsSummary: FixtureRow[];
}

/** The observed (fixture-side) world; every case overrides what it needs. */
let state: FixtureState = emptyState(OWN_SCOPE, 1);

function emptyState(setupScope: string, setupGeneration: number): FixtureState {
  return {
    setupScope,
    setupGeneration,
    checkoutIntents: [],
    orders: [],
    ordersSummary: [],
    skus: [],
    stockBaseline: [],
    stockRemaining: [],
    reservations: [],
    reservationsSummary: [],
  };
}

function ownScopePassCase(): FixtureState {
  return {
    ...emptyState(OWN_SCOPE, 1),
    checkoutIntents: [intent('CHK-A', OWN_SCOPE, 1)],
    orders: [order('ORD-A1', 'CHK-A', OWN_SCOPE, 1)],
    ordersSummary: [
      {
        checkoutIntentId: 'CHK-A',
        acceptedOrderTotal: 1,
        verificationScopeId: OWN_SCOPE,
        generationId: 1,
      },
    ],
    skus: [{ sku: 'SKU-A', title: 'Gadget', verificationScopeId: OWN_SCOPE, generationId: 1 }],
    stockBaseline: [
      { sku: 'SKU-A', initialAvailableUnits: 10, verificationScopeId: OWN_SCOPE, generationId: 1 },
    ],
    stockRemaining: [
      { sku: 'SKU-A', remainingAvailableUnits: 8, verificationScopeId: OWN_SCOPE, generationId: 1 },
    ],
    reservations: [
      {
        reservationId: 'RES-A1',
        sku: 'SKU-A',
        reservedUnits: 2,
        status: 'ACCEPTED',
        verificationScopeId: OWN_SCOPE,
        generationId: 1,
      },
    ],
    reservationsSummary: [
      {
        sku: 'SKU-A',
        acceptedReservationTotal: 1,
        verificationScopeId: OWN_SCOPE,
        generationId: 1,
      },
    ],
  };
}

function order(
  orderId: string,
  checkoutIntentId: string,
  scope: string,
  generation: number,
): FixtureRow {
  return {
    orderId,
    checkoutIntentId,
    customerId: 'CUST-1',
    cartId: 'CART-1',
    totalMinor: 500000,
    currency: 'PKR',
    status: 'ACCEPTED',
    verificationScopeId: scope,
    generationId: generation,
  };
}

function intent(checkoutIntentId: string, scope: string, generation: number): FixtureRow {
  return {
    checkoutIntentId,
    customerId: 'CUST-1',
    cartId: 'CART-1',
    totalMinor: 500000,
    currency: 'PKR',
    status: 'CONFIRMED',
    verificationScopeId: scope,
    generationId: generation,
  };
}

let fixture: Server;

function fixtureServer(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // The frozen SETUP surface: the run-owned anchor is the fenced 2xx
    // response to this request and nothing else (ADR-0026 §5). The
    // declared anchor field is `verificationScopeId` — a name the
    // platform's persistent-redaction pattern does NOT mask (a
    // `*token*`-named field is redacted before persistence and rejected
    // at declaration validation).
    if ((req.method === 'GET' || req.method === 'POST') && path === ANCHOR_PATH) {
      return json({
        verificationScopeId: state.setupScope,
        generationId: state.setupGeneration,
        mode: 'SECURE',
      });
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('read-only inspection surface');
      return;
    }
    if (path === '/inspection/checkout-intents') return json(state.checkoutIntents);
    if (path === '/inspection/orders') return json(state.orders);
    if (path === '/inspection/orders-summary') return json(state.ordersSummary);
    if (path === '/inspection/skus') return json(state.skus);
    if (path === '/inspection/stock-baseline') return json(state.stockBaseline);
    if (path === '/inspection/stock-remaining') return json(state.stockRemaining);
    if (path === '/inspection/reservations') return json(state.reservations);
    if (path === '/inspection/reservations-summary') return json(state.reservationsSummary);
    res.writeHead(404);
    res.end('not found');
  });
}

// ---------------------------------------------------------------------
// Manifest: every role/field the two reference invariant instances use
// ---------------------------------------------------------------------
const STRING = 'string';
const INTEGER = 'integer-minor-units';

const identityFields = {
  checkoutIntent: {
    checkoutIntentId: STRING,
    customerId: STRING,
    cartId: STRING,
    totalMinor: INTEGER,
    currency: STRING,
    status: STRING,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  order: {
    orderId: STRING,
    checkoutIntentId: STRING,
    customerId: STRING,
    cartId: STRING,
    totalMinor: INTEGER,
    currency: STRING,
    status: STRING,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  ordersSummary: {
    checkoutIntentId: STRING,
    acceptedOrderTotal: INTEGER,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  sku: { sku: STRING, title: STRING, verificationScopeId: STRING, generationId: INTEGER },
  skuBaseline: {
    sku: STRING,
    initialAvailableUnits: INTEGER,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  skuRemaining: {
    sku: STRING,
    remainingAvailableUnits: INTEGER,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  reservation: {
    reservationId: STRING,
    sku: STRING,
    reservedUnits: INTEGER,
    status: STRING,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
  reservationsSummary: {
    sku: STRING,
    acceptedReservationTotal: INTEGER,
    verificationScopeId: STRING,
    generationId: INTEGER,
  },
} as const;

const cManifest = (origin: string, displayName: string) => ({
  manifestVersion: 'target-manifest/v1' as const,
  displayName,
  environment: 'LOCAL_DEVELOPMENT' as const,
  origins: [origin],
  credentialRefs: [] as string[],
  contract: { kind: 'GENERIC_HTTP' as const },
  inspection: [
    {
      queryId: 'checkoutIntents',
      roleId: 'checkoutIntent',
      description: 'Checkout intents',
      path: '/inspection/checkout-intents',
      fields: identityFields.checkoutIntent,
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'Orders',
      path: '/inspection/orders',
      fields: identityFields.order,
      identityFields: ['orderId'],
    },
    {
      queryId: 'ordersSummary',
      roleId: 'ordersSummary',
      description: 'Per-intent accepted-order totals',
      path: '/inspection/orders-summary',
      fields: identityFields.ordersSummary,
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'skus',
      roleId: 'sku',
      description: 'SKU registry',
      path: '/inspection/skus',
      fields: identityFields.sku,
      identityFields: ['sku'],
    },
    {
      queryId: 'stockBaseline',
      roleId: 'skuBaseline',
      description: 'Stock baselines',
      path: '/inspection/stock-baseline',
      fields: identityFields.skuBaseline,
      identityFields: ['sku'],
    },
    {
      queryId: 'stockRemaining',
      roleId: 'skuRemaining',
      description: 'Stock remaining',
      path: '/inspection/stock-remaining',
      fields: identityFields.skuRemaining,
      identityFields: ['sku'],
    },
    {
      queryId: 'reservations',
      roleId: 'reservation',
      description: 'Reservations',
      path: '/inspection/reservations',
      fields: identityFields.reservation,
      identityFields: ['reservationId'],
    },
    {
      queryId: 'reservationsSummary',
      roleId: 'reservationsSummary',
      description: 'Per-SKU accepted-reservation totals',
      path: '/inspection/reservations-summary',
      fields: identityFields.reservationsSummary,
      identityFields: ['sku'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'checkoutIntent',
        description: 'A checkout intent',
        fields: identityFields.checkoutIntent,
      },
      { roleId: 'order', description: 'An order effect', fields: identityFields.order },
      {
        roleId: 'ordersSummary',
        description: 'A per-intent total',
        fields: identityFields.ordersSummary,
      },
      { roleId: 'sku', description: 'A stocked resource', fields: identityFields.sku },
      {
        roleId: 'skuBaseline',
        description: 'A baseline stock fact',
        fields: identityFields.skuBaseline,
      },
      {
        roleId: 'skuRemaining',
        description: 'A remaining stock fact',
        fields: identityFields.skuRemaining,
      },
      {
        roleId: 'reservation',
        description: 'A reservation effect',
        fields: identityFields.reservation,
      },
      {
        roleId: 'reservationsSummary',
        description: 'A per-SKU total',
        fields: identityFields.reservationsSummary,
      },
    ],
    causalEdges: [
      {
        fromRoleId: 'checkoutIntent',
        toRoleId: 'order',
        edgeKind: 'produced',
        linkFields: ['checkoutIntentId'],
      },
      {
        fromRoleId: 'sku',
        toRoleId: 'reservation',
        edgeKind: 'reserved-from',
        linkFields: ['sku'],
      },
    ],
    effectRoleIds: ['order', 'reservation'],
  },
  sensitiveFields: [] as string[],
});

const INV_CHK_1 = {
  key: 'INV-CHK-1',
  kind: 'atMostOneAcceptedEffect',
  registryVersion: 'business-invariant/v1',
  params: {
    subjectRole: 'checkoutIntent',
    subjectIdentityField: 'checkoutIntentId',
    effectRole: 'order',
    effectIdentityField: 'orderId',
    acceptedMatch: { field: 'status', value: 'ACCEPTED' },
    equivalenceFields: ['checkoutIntentId', 'customerId', 'cartId', 'totalMinor', 'currency'],
    maxAcceptedEffects: 1,
    completenessProof: {
      kind: 'observed-total',
      queryId: 'ordersSummary',
      subjectField: 'checkoutIntentId',
      totalField: 'acceptedOrderTotal',
    },
    scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
  },
};

const INV_INV_1 = {
  key: 'INV-INV-1',
  kind: 'resourceConservation',
  registryVersion: 'business-invariant/v1',
  params: {
    resourceIdentityField: 'sku',
    baselineRole: 'skuBaseline',
    baselineUnitsField: 'initialAvailableUnits',
    remainingRole: 'skuRemaining',
    remainingUnitsField: 'remainingAvailableUnits',
    consumptionEffectRole: 'reservation',
    consumptionEffectIdentityField: 'reservationId',
    consumptionUnitsField: 'reservedUnits',
    consumptionAcceptedMatch: { field: 'status', value: 'ACCEPTED' },
    completenessProof: {
      kind: 'observed-total',
      queryId: 'reservationsSummary',
      subjectField: 'sku',
      totalField: 'acceptedReservationTotal',
    },
    scopeBinding: { fields: ['verificationScopeId'], generationField: 'generationId' },
  },
};

// ---------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------
beforeAll(async () => {
  ownedFixture = await createOwnedControlFixture(loadTestEnv());
  controlDb = ownedFixture.controlDb;
  fixture = fixtureServer();
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((fixture.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (fixture !== undefined) {
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
  }
  await ownedFixture?.close();
});

async function ensureManifestTarget(): Promise<string> {
  if (manifestTargetId !== null) return manifestTargetId;
  const displayName = 'phase17c-fixture-target';
  const registered = await ownedFixture!.acquireTarget('manifest', {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
    manifest: cManifest(baseUrl, displayName),
  });
  manifestTargetId = registered.targetId;
  return registered.targetId;
}

// ---------------------------------------------------------------------
// Run construction (real engine, real terminal states, real settlement)
// ---------------------------------------------------------------------
interface RunInput {
  readonly declaredScope?: string;
  readonly declaredSubjects?: { readonly chk: readonly string[]; readonly inv: readonly string[] };
}

function experimentDocument(input: RunInput): Record<string, unknown> {
  return {
    steps: [
      {
        name: SETUP_STEP,
        action: {
          method: 'GET',
          relativePath: ANCHOR_PATH,
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
    ],
    invariantBindings: [INV_CHK_1, INV_INV_1],
    runScope: {
      version: 'run-scope/v1',
      setupStep: SETUP_STEP,
      declaredScope: input.declaredScope ?? OWN_SCOPE,
      scopeField: 'verificationScopeId',
      generationField: 'generationId',
      subjects: {
        'INV-CHK-1': [...(input.declaredSubjects?.chk ?? ['CHK-A'])],
        'INV-INV-1': [...(input.declaredSubjects?.inv ?? ['SKU-A'])],
      },
    },
  };
}

/**
 * Creates, dispatches and executes one run's frozen steps, leaving the run
 * RUNNING (the state the real pipeline observes before settlement).
 */
async function buildRunUnsettled(input: RunInput = {}): Promise<string> {
  const targetId = await ensureManifestTarget();
  const created = await createExperiment(prisma(), {
    name: uniqueName('phase17c-experiment'),
    targetId,
    document: experimentDocument(input) as never,
  });
  const run = await createRun(prisma(), created.revisionId);
  await markRunDispatching(prisma(), run.runId);
  await executeStep(run.runId, SETUP_STEP);
  return run.runId;
}

/** Creates, executes and SETTLES one run (the real reconciler path). */
async function buildRun(input: RunInput = {}): Promise<string> {
  const runId = await buildRunUnsettled(input);
  await settleRuns(prisma(), 200);
  const settled = await prisma().experimentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { state: true },
  });
  if (settled.state !== 'COMPLETED') {
    throw new Error(`phase17c run ${runId} settled as ${settled.state}, not COMPLETED`);
  }
  return runId;
}

/** Runs ONE frozen step in-process through the REAL StepProcessor. */
async function executeStep(runId: string, name: string): Promise<void> {
  const stepRun = await prisma().experimentStepRun.findFirstOrThrow({
    where: { runId, name },
    select: { id: true },
  });
  const processor = new StepProcessor({
    prisma: prisma(),
    config: { WORKER_LEASE_DURATION_MS: 10_000, WORKER_HEARTBEAT_INTERVAL_MS: 2_000 },
    credentials: createCredentialResolver({}),
    evidenceSink: createEngineEvidenceSink(prisma()),
  });
  await processor.processStep(stepRun.id);
}

/** Captures every declared inspection query and derives the evidence. */
async function captureAndDerive(runId: string): Promise<void> {
  const policy = await loadFrozenEvidencePolicy(prisma(), runId);
  if (policy === undefined) {
    throw new Error(`run ${runId} froze no evidence policy`);
  }
  await captureGenericInspectionSet(prisma(), {
    runId,
    stepRunId: null,
    origin: baseUrl,
    environment: 'LOCAL_DEVELOPMENT',
    policy,
    writerOwnerId: 'phase17c-integration',
    writerFencingToken: null,
  });
  await deriveRunEvidence(prisma(), runId);
}

// ---------------------------------------------------------------------
// Durable-row readers (assertions come from ROWS, never helper returns)
// ---------------------------------------------------------------------
async function proofs(runId: string, invariantKey: string) {
  return prisma().runEligibilityProof.findMany({ where: { runId, invariantKey } });
}

async function pointers(runId: string, invariantKey: string) {
  return prisma().currentEvaluationPointer.findMany({
    where: { runId, invariantKey },
    include: { currentEvaluation: { select: { verdict: true, evaluatorVersion: true } } },
  });
}

async function evaluations(runId: string, invariantKey: string) {
  return prisma().invariantEvaluation.findMany({
    where: { runId, invariantKey, evaluatorVersion: CHK_VERSION },
    orderBy: { id: 'asc' },
  });
}

/** The publication keys of one run, rebuilt from its own durable rows. */
async function publicationKeys(runId: string): Promise<readonly PublicationKey[]> {
  const rows = await evaluations(runId, 'INV-CHK-1');
  return [
    {
      invariantKey: 'INV-CHK-1',
      evaluatorVersion: CHK_VERSION,
      registryVersion: 'business-invariant/v1',
      eligibilityVersion: RUN_SCOPE_ELIGIBILITY_VERSION,
      mode: 'strict-coverage/v1',
      subjects: rows.map((row) => ({
        subjectKey: row.subjectKey,
        evaluationId: row.id,
        evidenceSetHash: row.evidenceSetHash,
        verdict: row.verdict,
      })),
      coverage: null,
    },
  ];
}

/** A minimal `own scope` case: one declared subject, one accepted order. */
function useCase(next: Partial<FixtureState>): void {
  state = { ...ownScopePassCase(), ...next };
}

// =====================================================================
// 1. The golden strict publication
// =====================================================================
describe('Checkpoint C — authoritative strict publication', () => {
  it('publishes one coherent generation: anchor-bound PASS pointer, strict proof, CURRENT read', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    const analysis = await runRunAnalysis(prisma(), runId);
    expect(analysis.publication.published).toBe(true);
    expect(analysis.publication.state).toBe('PUBLISHED');
    expect(analysis.publication.analysisGeneration).not.toBeNull();

    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof).toBeDefined();
    expect(proof?.mode).toBe('strict-coverage/v1');
    expect(proof?.evaluatorVersion).toBe(CHK_VERSION);
    expect(proof?.eligibilityVersion).toBe(RUN_SCOPE_ELIGIBILITY_VERSION);
    const anchor = proof?.anchor as {
      observedScope: string;
      observedGeneration: number;
      setupStep: string;
      setupStepRunId: string;
      anchorFencing: { leaseOwnerId: string; fencingToken: string };
    };
    expect(anchor.observedScope).toBe(OWN_SCOPE);
    expect(anchor.observedGeneration).toBe(1);
    expect(anchor.setupStep).toBe(SETUP_STEP);
    // The anchor names the REAL durable step run of the frozen step.
    const setupStepRun = await prisma().experimentStepRun.findFirstOrThrow({
      where: { runId, name: SETUP_STEP },
      select: { id: true, leaseOwnerId: true, fencingToken: true },
    });
    expect(anchor.setupStepRunId).toBe(setupStepRun.id);
    expect(anchor.anchorFencing.leaseOwnerId).toBe(setupStepRun.leaseOwnerId);
    expect(anchor.anchorFencing.fencingToken).toBe(setupStepRun.fencingToken?.toString());
    expect(proof?.declaredSubjectsJson).toEqual(['CHK-A']);
    expect(proof?.eligibleSubjectsJson).toEqual(['CHK-A']);
    expect(proof?.missingSubjectsJson).toEqual([]);
    expect(proof?.unexpectedSubjects).toEqual([]);
    expect(proof?.foreignInventory).toEqual([]);
    expect(proof?.coverageStatement).toMatch(/declared, evidence-verified verification domain/i);

    // Durable pointer → a real persisted PASS evaluation of THIS run.
    const chkPointers = await pointers(runId, 'INV-CHK-1');
    expect(chkPointers).toHaveLength(1);
    expect(chkPointers[0]?.subjectKey).toBe('CHK-A');
    expect(chkPointers[0]?.currentEvaluation.verdict).toBe('PASS');
    expect(chkPointers[0]?.currentEvaluation.evaluatorVersion).toBe(CHK_VERSION);
    const row = await prisma().invariantEvaluation.findUniqueOrThrow({
      where: { id: chkPointers[0]?.currentEvaluationId ?? '' },
    });
    expect(row.subjectKey).toBe('CHK-A');
    expect(row.evidenceSetHash).toBe(chkPointers[0]?.evidenceHeadHash);
    expect(row.verdict).toBe('PASS');

    // Both bound kinds publish under ONE generation; the read is CURRENT.
    expect((await pointers(runId, 'INV-INV-1')).map((entry) => entry.subjectKey)).toEqual([
      'SKU-A',
    ]);
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT');
    expect(read.missingSubjectPointers).toEqual([]);
    expect(
      new Set([
        ...read.proofs.map((entry) => entry.analysisGeneration),
        ...read.pointers.map((entry) => entry.analysisGeneration),
      ]).size,
    ).toBe(1);
  });
});

// =====================================================================
// 2. C-01 / C-02 / C-03 — foreign scope never contaminates this run
// =====================================================================
describe('Checkpoint C — foreign-scope non-contamination (C-01/C-02/C-03)', () => {
  it('C-01/C-03: a foreign vulnerable subject’s FAIL is never evaluated and never a finding', async () => {
    useCase({
      checkoutIntents: [intent('CHK-A', OWN_SCOPE, 1), intent('CHK-FOREIGN', FOREIGN_SCOPE, 1)],
      orders: [
        order('ORD-A1', 'CHK-A', OWN_SCOPE, 1),
        order('ORD-F1', 'CHK-FOREIGN', FOREIGN_SCOPE, 1),
        order('ORD-F2', 'CHK-FOREIGN', FOREIGN_SCOPE, 1),
      ],
      ordersSummary: [
        {
          checkoutIntentId: 'CHK-A',
          acceptedOrderTotal: 1,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          checkoutIntentId: 'CHK-FOREIGN',
          acceptedOrderTotal: 2,
          verificationScopeId: FOREIGN_SCOPE,
          generationId: 1,
        },
      ],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    const analysis = await runRunAnalysis(prisma(), runId);
    expect(analysis.publication.published).toBe(true);

    const chkPointers = await pointers(runId, 'INV-CHK-1');
    expect(chkPointers.map((entry) => entry.subjectKey)).toEqual(['CHK-A']);
    expect(chkPointers[0]?.currentEvaluation.verdict).toBe('PASS');
    // The foreign subject has NO evaluation row, NO pointer, NO finding.
    expect(await evaluations(runId, 'INV-CHK-1')).toHaveLength(1);
    expect(
      await prisma().invariantEvaluation.count({
        where: { runId, invariantKey: 'INV-CHK-1', subjectKey: 'CHK-FOREIGN' },
      }),
    ).toBe(0);
    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof?.eligibleSubjectsJson).toEqual(['CHK-A']);
    expect(proof?.unexpectedSubjects).toEqual([]);
    expect(proof?.foreignInventory).toEqual([
      { scope: FOREIGN_SCOPE, generation: 1, subjectCount: 1 },
    ]);
    await deriveRunForensics(prisma(), runId);
    expect(await prisma().finding.findMany({ where: { runId } })).toEqual([]);
  });

  it('C-02: an own-scope FAIL survives a foreign-scope PASS and yields a real finding', async () => {
    useCase({
      checkoutIntents: [intent('CHK-A', OWN_SCOPE, 1), intent('CHK-FOREIGN', FOREIGN_SCOPE, 1)],
      orders: [
        order('ORD-A1', 'CHK-A', OWN_SCOPE, 1),
        order('ORD-A2', 'CHK-A', OWN_SCOPE, 1),
        order('ORD-F1', 'CHK-FOREIGN', FOREIGN_SCOPE, 1),
      ],
      ordersSummary: [
        {
          checkoutIntentId: 'CHK-A',
          acceptedOrderTotal: 2,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          checkoutIntentId: 'CHK-FOREIGN',
          acceptedOrderTotal: 1,
          verificationScopeId: FOREIGN_SCOPE,
          generationId: 1,
        },
      ],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const chkPointers = await pointers(runId, 'INV-CHK-1');
    expect(chkPointers.map((entry) => entry.subjectKey)).toEqual(['CHK-A']);
    expect(chkPointers[0]?.currentEvaluation.verdict).toBe('FAIL');
    expect(
      await prisma().currentEvaluationPointer.count({
        where: { runId, subjectKey: 'CHK-FOREIGN' },
      }),
    ).toBe(0);
    await deriveRunForensics(prisma(), runId);
    const findings = await prisma().finding.findMany({
      where: { runId, invariantKey: 'INV-CHK-1' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.subjectKey).toBe('CHK-A');
    expect(findings[0]?.reasonCode).toBe('TOO_MANY_ACCEPTED_EFFECTS');
    // The finding rests on the evaluation the CURRENT POINTER names.
    expect(findings[0]?.invariantEvaluationId).toBe(chkPointers[0]?.currentEvaluationId);
  });
});

// =====================================================================
// 3. C-04 — same identity at different generations: never merged
// =====================================================================
describe('Checkpoint C — generation separation (C-04)', () => {
  it('never merges one identity observed at two generations: class-D fail closed', async () => {
    useCase({
      checkoutIntents: [intent('CHK-A', OWN_SCOPE, 1), intent('CHK-A', OWN_SCOPE, 2)],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    const analysis = await runRunAnalysis(prisma(), runId);
    expect(analysis.publication.published).toBe(true);

    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof?.eligibleSubjectsJson).toEqual([]);
    expect(proof?.missingSubjectsJson).toEqual(['CHK-A']);
    const gaps = (proof?.evidenceGaps ?? []) as Array<{ kind: string; detail: string }>;
    expect(gaps.some((gap) => gap.kind === 'scope-or-subject-indeterminate')).toBe(true);
    expect(gaps.some((gap) => gap.kind === 'declared-subject-missing')).toBe(true);
    expect(await evaluations(runId, 'INV-CHK-1')).toEqual([]);
    expect(await pointers(runId, 'INV-CHK-1')).toEqual([]);
  });
});

// =====================================================================
// 4. C-05 / C-06 — strict coverage anomalies
// =====================================================================
describe('Checkpoint C — strict subject coverage (C-05/C-06)', () => {
  it('C-05: declared SKU-A PASS with an undeclared same-scope oversold SKU-B is a coverage anomaly', async () => {
    useCase({
      skus: [
        { sku: 'SKU-A', title: 'Gadget', verificationScopeId: OWN_SCOPE, generationId: 1 },
        { sku: 'SKU-B', title: 'Gizmo', verificationScopeId: OWN_SCOPE, generationId: 1 },
      ],
      stockBaseline: [
        {
          sku: 'SKU-A',
          initialAvailableUnits: 10,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          sku: 'SKU-B',
          initialAvailableUnits: 10,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
      ],
      stockRemaining: [
        {
          sku: 'SKU-A',
          remainingAvailableUnits: 8,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          sku: 'SKU-B',
          remainingAvailableUnits: -1,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
      ],
      reservations: [
        {
          reservationId: 'RES-A1',
          sku: 'SKU-A',
          reservedUnits: 2,
          status: 'ACCEPTED',
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          reservationId: 'RES-B1',
          sku: 'SKU-B',
          reservedUnits: 2,
          status: 'ACCEPTED',
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
      ],
      reservationsSummary: [
        {
          sku: 'SKU-A',
          acceptedReservationTotal: 1,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          sku: 'SKU-B',
          acceptedReservationTotal: 1,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
      ],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const proof = (await proofs(runId, 'INV-INV-1'))[0];
    expect(proof?.declaredSubjectsJson).toEqual(['SKU-A']);
    expect(proof?.eligibleSubjectsJson).toEqual(['SKU-A']);
    expect(proof?.unexpectedSubjects).toEqual([
      { subjectKey: 'SKU-B', scope: OWN_SCOPE, generation: 1 },
    ]);
    const gaps = (proof?.evidenceGaps ?? []) as Array<{ kind: string }>;
    expect(gaps.some((gap) => gap.kind === 'coverage-anomaly')).toBe(true);
    // The anomaly is inventory, not a verdict: SKU-B has no row, no pointer
    // and no finding (what the report must surface is the PROOF — D).
    expect(await evaluations(runId, 'INV-INV-1')).toHaveLength(1);
    expect((await pointers(runId, 'INV-INV-1')).map((entry) => entry.subjectKey)).toEqual([
      'SKU-A',
    ]);
    expect((await pointers(runId, 'INV-INV-1'))[0]?.currentEvaluation.verdict).toBe('PASS');
    await deriveRunForensics(prisma(), runId);
    expect(await prisma().finding.findMany({ where: { runId } })).toEqual([]);
  });

  it('C-06: a declared intent PASS with an undeclared same-scope duplicate is a coverage anomaly', async () => {
    useCase({
      checkoutIntents: [intent('CHK-A', OWN_SCOPE, 1), intent('CHK-B', OWN_SCOPE, 1)],
      orders: [
        order('ORD-A1', 'CHK-A', OWN_SCOPE, 1),
        order('ORD-B1', 'CHK-B', OWN_SCOPE, 1),
        order('ORD-B2', 'CHK-B', OWN_SCOPE, 1),
      ],
      ordersSummary: [
        {
          checkoutIntentId: 'CHK-A',
          acceptedOrderTotal: 1,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
        {
          checkoutIntentId: 'CHK-B',
          acceptedOrderTotal: 2,
          verificationScopeId: OWN_SCOPE,
          generationId: 1,
        },
      ],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof?.eligibleSubjectsJson).toEqual(['CHK-A']);
    expect(proof?.unexpectedSubjects).toEqual([
      { subjectKey: 'CHK-B', scope: OWN_SCOPE, generation: 1 },
    ]);
    expect(await evaluations(runId, 'INV-CHK-1')).toHaveLength(1);
    // The publication is internally consistent — which is exactly why an
    // anomaly must be read from the PROOF, never inferred from a pointer.
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT');
    expect(read.pointers.filter((entry) => entry.invariantKey === 'INV-CHK-1')).toHaveLength(1);
  });
});

// =====================================================================
// 5. C-07 — a missing declared subject is honest NE proof data
// =====================================================================
describe('Checkpoint C — missing declared subject (C-07)', () => {
  it('records the missing declared subject as a fail-closed gap with no verdict', async () => {
    useCase({
      skus: [],
      stockBaseline: [],
      stockRemaining: [],
      reservations: [],
      reservationsSummary: [],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const proof = (await proofs(runId, 'INV-INV-1'))[0];
    expect(proof?.declaredSubjectsJson).toEqual(['SKU-A']);
    expect(proof?.eligibleSubjectsJson).toEqual([]);
    expect(proof?.missingSubjectsJson).toEqual(['SKU-A']);
    const gaps = (proof?.evidenceGaps ?? []) as Array<{ kind: string }>;
    expect(gaps.some((gap) => gap.kind === 'declared-subject-missing')).toBe(true);
    // No verdict is invented for a subject that was never observed.
    expect(await evaluations(runId, 'INV-INV-1')).toEqual([]);
    expect(await pointers(runId, 'INV-INV-1')).toEqual([]);
  });
});

// =====================================================================
// 6. C-08 — redacted / type-invalid scope-or-generation fails closed
// =====================================================================
describe('Checkpoint C — ambiguous evidence fails closed (C-08)', () => {
  it('a redacted scope VALUE is class D: never assumed foreign, never evaluated', async () => {
    useCase({
      checkoutIntents: [intent('CHK-A', '[Redacted]', 1)],
      orders: [{ ...order('ORD-A1', 'CHK-A', OWN_SCOPE, 1), verificationScopeId: '[Redacted]' }],
      ordersSummary: [],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof?.eligibleSubjectsJson).toEqual([]);
    expect(proof?.foreignInventory).toEqual([]);
    expect(proof?.missingSubjectsJson).toEqual(['CHK-A']);
    const gaps = (proof?.evidenceGaps ?? []) as Array<{ kind: string }>;
    expect(gaps.some((gap) => gap.kind === 'scope-or-subject-indeterminate')).toBe(true);
    expect(await evaluations(runId, 'INV-CHK-1')).toEqual([]);
    expect(await pointers(runId, 'INV-CHK-1')).toEqual([]);
  });

  it('a type-invalid generation value never matches the anchor (no coercion)', async () => {
    // EVERY entity of the declared subject carries the type-invalid value:
    // `generationId` is declared `integer-minor-units`, so a string is not
    // comparable with the anchor's integer generation — not by coercion,
    // not by stringification, not by "close enough".
    const bad = 'gen-1' as unknown as number;
    useCase({
      checkoutIntents: [{ ...intent('CHK-A', OWN_SCOPE, 1), generationId: bad }],
      orders: [{ ...order('ORD-A1', 'CHK-A', OWN_SCOPE, 1), generationId: bad }],
      ordersSummary: [
        {
          checkoutIntentId: 'CHK-A',
          acceptedOrderTotal: 1,
          verificationScopeId: OWN_SCOPE,
          generationId: bad,
        },
      ],
    });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const proof = (await proofs(runId, 'INV-CHK-1'))[0];
    expect(proof?.eligibleSubjectsJson).toEqual([]);
    expect(proof?.missingSubjectsJson).toEqual(['CHK-A']);
    expect(await evaluations(runId, 'INV-CHK-1')).toEqual([]);
    expect(await pointers(runId, 'INV-CHK-1')).toEqual([]);
    // The capture/derivation provenance records the surface honestly (never
    // a silent zero and never a coerced match).
    const statuses = await loadPersistedCaptureStatuses(prisma(), runId);
    const intentCapture = [...statuses.values()].find(
      (entry) => entry.queryId === 'checkoutIntents',
    );
    expect(intentCapture === undefined || intentCapture.valid === false).toBe(true);
  });
});

// =====================================================================
// 7. C-09 — completeness is never assumed
// =====================================================================
describe('Checkpoint C — completeness is never assumed (C-09)', () => {
  it('a declared subject with a missing observed total is NOT_EVALUABLE, never PASS', async () => {
    useCase({ ordersSummary: [] });
    const runId = await buildRun();
    await captureAndDerive(runId);
    await runRunAnalysis(prisma(), runId);

    const rows = await evaluations(runId, 'INV-CHK-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('NOT_EVALUABLE');
    const chkPointers = await pointers(runId, 'INV-CHK-1');
    expect(chkPointers).toHaveLength(1);
    expect(chkPointers[0]?.currentEvaluation.verdict).toBe('NOT_EVALUABLE');
  });
});

// =====================================================================
// 8. C0 / C-15 — the marker-only readiness race
// =====================================================================
describe('Checkpoint C — C0 marker-only readiness race', () => {
  it('a newer IN_PROGRESS derivation attempt (no derived row, W byte-identical) blocks publication', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    const first = await runRunAnalysis(prisma(), runId);
    expect(first.publication.published).toBe(true);
    const publishedGeneration = first.publication.analysisGeneration;
    const before = await readTruthInputWatermark(prisma(), runId);
    const beforeProofs = await proofs(runId, 'INV-CHK-1');

    // A REAL newer derivation attempt starts and commits NO derived row.
    const handle = await beginDerivationAttempt(prisma(), runId, DERIVATION_KIND_RUN_EVIDENCE);
    const after = await readTruthInputWatermark(prisma(), runId);
    // The composite watermark is BYTE-IDENTICAL — the point of the C0 case:
    // W alone cannot see the marker change.
    expect(after.chain.headContentHash).toBe(before.chain.headContentHash);
    expect(after.chain.observationCount).toBe(before.chain.observationCount);
    expect(after.chain.lastChainIndex).toBe(before.chain.lastChainIndex);
    expect(after.provenanceRevision).toBe(before.provenanceRevision);
    expect(after.derivationGeneration).toBe(before.derivationGeneration);

    const readiness = await readDerivationReadiness(prisma(), runId, DERIVATION_KIND_RUN_EVIDENCE);
    expect(readiness.complete).toBe(false);
    expect(readiness.state).toBe('IN_PROGRESS');
    expect(readiness.reason).toBe('NEWER_ATTEMPT_IN_PROGRESS');

    // A publication attempt at the SAME W must STILL be refused: the
    // durable readiness proof — not W — authorizes publication.
    const attempt = await publishAnalysisGeneration(
      prisma(),
      runId,
      before,
      await publicationKeys(runId),
    );
    expect(attempt.published).toBe(false);
    expect(attempt.reason).toMatch(/DERIVATION_NOT_READY/);

    // Nothing was rewritten: the same generation, the same proof rows.
    const afterProofs = await proofs(runId, 'INV-CHK-1');
    expect(afterProofs[0]?.analysisGeneration).toBe(beforeProofs[0]?.analysisGeneration);
    expect(afterProofs[0]?.analysisGeneration.toString()).toBe(publishedGeneration);
    // The report-side read fails closed while the attempt is unresolved.
    expect((await readCurrentEvaluationPublication(prisma(), runId)).state).toBe(
      'DERIVATION_NOT_READY',
    );

    // Resolving the attempt (the REAL failure path) and re-deriving
    // restores completeness and publishes a NEWER generation.
    await failDerivationAttempt(prisma(), handle, new Error('MARKER_RACE_FIXTURE_RESOLUTION'));
    expect(
      (await readDerivationReadiness(prisma(), runId, DERIVATION_KIND_RUN_EVIDENCE)).complete,
    ).toBe(true);
    await deriveRunEvidence(prisma(), runId);
    const recovered = await runRunAnalysis(prisma(), runId);
    expect(recovered.publication.published).toBe(true);
    expect(recovered.publication.analysisGeneration).not.toBe(publishedGeneration);
  });

  it('C-11/C-13: a stale publication attempt whose captured W is no longer current writes NOTHING', async () => {
    useCase({});
    // The real pipeline order: evidence captured and derived while the run
    // is still RUNNING; the pass's stage-1 capture is taken there.
    const runId = await buildRunUnsettled({});
    await captureAndDerive(runId);
    const staleW0: TruthInputWatermark = await captureStage1Source(prisma(), runId);

    // Current-evaluation publication requires a terminal COMPLETED run
    // (ADR-0026 §13 step 4): a non-terminal pass evaluates history but
    // publishes nothing.
    const early = await runRunAnalysis(prisma(), runId);
    expect(early.publication.published).toBe(false);
    expect(early.publication.state).toBe('NOT_APPLICABLE');
    expect(await proofs(runId, 'INV-CHK-1')).toEqual([]);

    // The REAL reconciler settles the run: every step is terminal, so the
    // run becomes COMPLETED and the settlement write advances `P`.
    expect(await settleRuns(prisma(), 200)).toBeGreaterThan(0);
    const current = await readTruthInputWatermark(prisma(), runId);
    expect(current.provenanceRevision).not.toBe(staleW0.provenanceRevision);

    const attempt = await publishAnalysisGeneration(
      prisma(),
      runId,
      staleW0,
      await publicationKeys(runId),
    );
    expect(attempt.published).toBe(false);
    expect(attempt.reason).toBe('TRUTH_INPUT_ADVANCED_BEFORE_PUBLICATION');
    expect(attempt.changedComponents).toContain('provenanceRevision');
    // No partial publication at all.
    expect(await proofs(runId, 'INV-CHK-1')).toEqual([]);
    expect(await pointers(runId, 'INV-CHK-1')).toEqual([]);
    expect((await readCurrentEvaluationPublication(prisma(), runId)).state).toBe('MISSING_PROOF');

    // The fresh pass publishes the COMPLETE selection at the new W.
    const analysis = await runRunAnalysis(prisma(), runId);
    expect(analysis.publication.published).toBe(true);
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT');
    for (const proof of read.proofs) {
      expect(proof.provenanceRevision).toBe(current.provenanceRevision.toString());
      expect(proof.integrityHeadHash).toBe(current.chain.headContentHash);
      expect(proof.derivationGeneration).toBe(current.derivationGeneration.toString());
    }
  });

  it('a persisted selection whose watermark no longer matches the truth input fails closed', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    expect((await runRunAnalysis(prisma(), runId)).publication.published).toBe(true);
    expect((await readCurrentEvaluationPublication(prisma(), runId)).state).toBe('CURRENT');
    // Controlled fault injection (the verifier verifying the verifier): the
    // stored proof/pointer watermark is rewound — exactly the durable state
    // a real post-publication writer would produce — and the read surface
    // must refuse the stale selection instead of reporting CURRENT.
    await prisma().runEligibilityProof.updateMany({
      where: { runId, invariantKey: 'INV-CHK-1' },
      data: { provenanceRevision: 0n },
    });
    await prisma().currentEvaluationPointer.updateMany({
      where: { runId, invariantKey: 'INV-CHK-1' },
      data: { provenanceRevision: 0n },
    });
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT_POINTER_STALE');
  });
});

// =====================================================================
// 9. C-16 — concurrent publication
// =====================================================================
describe('Checkpoint C — concurrent publication (C-16)', () => {
  it('two concurrent analysis publishers converge: one coherent generation, no lost verdict', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);

    // Two REAL publishers of the same run race (real transactions, real
    // per-run advisory lock, no sleeps as concurrency proof).
    const [a, b] = await Promise.all([
      runRunAnalysis(prisma(), runId),
      runRunAnalysis(prisma(), runId),
    ]);
    expect(a.publication.published).toBe(true);
    expect(b.publication.published).toBe(true);
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT');
    expect(
      new Set([
        ...read.proofs.map((entry) => entry.analysisGeneration),
        ...read.pointers.map((entry) => entry.analysisGeneration),
      ]).size,
    ).toBe(1);
    // No generation mixing, no lost pointer, no duplicated evaluation.
    expect([...new Set(read.proofs.map((entry) => entry.invariantKey))].sort()).toEqual(
      [...new Set(read.pointers.map((entry) => entry.invariantKey))].sort(),
    );
    expect(read.pointers.filter((entry) => entry.invariantKey === 'INV-CHK-1')).toHaveLength(1);
    expect(read.pointers.filter((entry) => entry.invariantKey === 'INV-INV-1')).toHaveLength(1);
    // The concurrent writers produced exactly ONE evaluation row per
    // (subject, evidence identity) — no duplicates, no lost row — and every
    // pointer resolves to a persisted evaluation of this run.
    const rows = await evaluations(runId, 'INV-CHK-1');
    expect(rows).toHaveLength(1);
    const chkPointer = read.pointers.find((entry) => entry.invariantKey === 'INV-CHK-1');
    expect(chkPointer?.currentEvaluationId).toBe(rows[0]?.id);
    expect(
      new Set([...read.proofs, ...read.pointers].map((entry) => entry.analysisGeneration)).size,
    ).toBe(1);
  });

  it('a stale publisher racing a re-analysis can never win: the fresh W is what remains', async () => {
    useCase({});
    // Stage 1 of the stale publisher is taken while the run is still
    // RUNNING; the real settlement then advances `P` before the race.
    const runId = await buildRunUnsettled({});
    await captureAndDerive(runId);
    const staleW0 = await captureStage1Source(prisma(), runId);
    await settleRuns(prisma(), 200);
    const current = await readTruthInputWatermark(prisma(), runId);
    expect(current.provenanceRevision).not.toBe(staleW0.provenanceRevision);

    const [stale, fresh] = await Promise.all([
      publishAnalysisGeneration(prisma(), runId, staleW0, await publicationKeys(runId)),
      runRunAnalysis(prisma(), runId),
    ]);
    expect(stale.published).toBe(false);
    expect(fresh.publication.published).toBe(true);
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('CURRENT');
    // No stored proof or pointer still names the pre-race truth input.
    for (const proof of read.proofs) {
      expect(proof.provenanceRevision).toBe(current.provenanceRevision.toString());
      expect(proof.integrityHeadHash).toBe(current.chain.headContentHash);
      expect(proof.derivationGeneration).toBe(current.derivationGeneration.toString());
    }
    for (const pointer of read.pointers) {
      expect(pointer.provenanceRevision).toBe(current.provenanceRevision.toString());
      expect(pointer.integrityHeadHash).toBe(current.chain.headContentHash);
    }
    expect(read.analysisGeneration).toBe(fresh.publication.analysisGeneration);
  });
});

// =====================================================================
// 10. C-18 / C-19 — missing or conflicting publication data fails closed
// =====================================================================
describe('Checkpoint C — fail-closed reads (C-18/C-19)', () => {
  it('C-18: a run with no persisted publication reports MISSING_PROOF', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.present).toBe(false);
    expect(read.state).toBe('MISSING_PROOF');
    expect(read.analysisGeneration).toBeNull();
  });

  it('C-18: an eligible subject whose pointer is absent fails closed (never a silent PASS)', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    expect((await runRunAnalysis(prisma(), runId)).publication.published).toBe(true);
    const pointer = (await pointers(runId, 'INV-CHK-1'))[0];
    expect(pointer).toBeDefined();
    // Controlled fault injection (the verifier verifying the verifier):
    // remove exactly one pointer row and confirm the read surface refuses
    // the incomplete selection instead of treating the key as satisfied.
    await prisma().currentEvaluationPointer.delete({ where: { id: pointer?.id ?? '' } });
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('MISSING_SUBJECT_POINTER');
    expect(read.missingSubjectPointers).toEqual([
      { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-A' },
    ]);
  });

  it('C-19: a pointer claiming a version with no proof is refused, not silently selected', async () => {
    useCase({});
    const runId = await buildRun();
    await captureAndDerive(runId);
    expect((await runRunAnalysis(prisma(), runId)).publication.published).toBe(true);
    const pointer = (await pointers(runId, 'INV-CHK-1'))[0];
    // Controlled fault injection: the pointer claims an evaluator version
    // the proof row does not carry (the conflicting-version counterexample).
    await prisma().currentEvaluationPointer.update({
      where: { id: pointer?.id ?? '' },
      data: { evaluatorVersion: 'generic-invariant/v9' },
    });
    const read = await readCurrentEvaluationPublication(prisma(), runId);
    expect(read.state).toBe('GENERATION_MISMATCH');
  });
});

// =====================================================================
// 11. C-20 — legacy snapshot compatibility
// =====================================================================
describe('Checkpoint C — legacy snapshot compatibility (C-20)', () => {
  it('a snapshot frozen with bindings but NO runScope evaluates in labeled legacy-compat mode', async () => {
    useCase({});
    const targetId = await ensureManifestTarget();
    // The NEW-definition biconditional must hold: a new document declaring
    // generic bindings without runScope is refused at definition time.
    await expect(
      createExperiment(prisma(), {
        name: uniqueName('phase17c-invalid'),
        targetId,
        document: {
          steps: [
            {
              name: SETUP_STEP,
              action: {
                method: 'GET',
                relativePath: ANCHOR_PATH,
                mutation: 'READ_ONLY',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
          invariantBindings: [INV_CHK_1, INV_INV_1],
        } as never,
      }),
    ).rejects.toThrow(/GENERIC_BINDINGS_WITHOUT_RUN_SCOPE|runScope/);

    // HISTORICAL freeze shape: the definition/revision rows a pre-rule
    // freeze produced (bindings, no runScope). The REAL snapshot builder
    // freezes the run from them; nothing here bypasses the product path.
    const definition = await prisma().experimentDefinition.create({
      data: { name: uniqueName('phase17c-legacy-experiment') },
      select: { id: true },
    });
    const revision = await prisma().experimentRevision.create({
      data: {
        definitionId: definition.id,
        revisionNumber: 1,
        targetId,
        stepsJson: {
          steps: [
            {
              name: SETUP_STEP,
              action: {
                method: 'GET',
                relativePath: ANCHOR_PATH,
                mutation: 'READ_ONLY',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
          invariantBindings: [INV_CHK_1, INV_INV_1],
        } as never,
      },
      select: { id: true },
    });
    const run = await createRun(prisma(), revision.id);
    const frozen = await prisma().runSnapshot.findFirstOrThrow({
      where: { runs: { some: { id: run.runId } } },
      select: { content: true },
    });
    const frozenTarget = (frozen.content as { target?: Record<string, unknown> }).target ?? {};
    expect('runScopeBinding' in frozenTarget).toBe(false);

    await markRunDispatching(prisma(), run.runId);
    await executeStep(run.runId, SETUP_STEP);
    await settleRuns(prisma(), 200);
    await captureAndDerive(run.runId);
    const analysis = await runRunAnalysis(prisma(), run.runId);
    expect(analysis.publication.published).toBe(true);

    // Legacy-compat semantics: the as-observed domain is published under
    // the labeled legacy mode, with NO anchor/declared/coverage claim.
    const proof = (await proofs(run.runId, 'INV-CHK-1'))[0];
    expect(proof?.mode).toBe('legacy-compat');
    expect(proof?.evaluatorVersion).toBe('v1');
    expect(proof?.anchor).toBeNull();
    expect(proof?.declaredSubjectsJson).toBeNull();
    expect(proof?.coverageStatement).toMatch(/legacy-compat/i);
    const legacyRows = await prisma().invariantEvaluation.findMany({
      where: { runId: run.runId, invariantKey: 'INV-CHK-1' },
    });
    expect(legacyRows.length).toBeGreaterThan(0);
    expect(legacyRows.every((row) => row.evaluatorVersion === 'v1')).toBe(true);
    const legacyPointers = await pointers(run.runId, 'INV-CHK-1');
    expect(legacyPointers.length).toBe(legacyRows.length);
    expect(
      legacyPointers.every((entry) => entry.eligibilityVersion === RUN_SCOPE_ELIGIBILITY_VERSION),
    ).toBe(true);
    expect((await readCurrentEvaluationPublication(prisma(), run.runId)).state).toBe('CURRENT');
  });
});
