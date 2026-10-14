// =====================================================================
// Integration — Phase 17 Checkpoint E1: anchor stale-generation
// S-matrix (ADR-0026 §5, S-1..S-17 + S-6a)
// =====================================================================
// Every case derives the run-owned anchor from DURABLE rows (R-08: real
// Control PostgreSQL) via the production derivation
// (`deriveRunAnchor`) and the production writers (`claimStep`,
// `markExecuting`, `recordInvocation`, `writeTerminalState`, the real
// evidence sink). S-1 additionally drives the FULL production path —
// the REAL StepProcessor against a REAL HTTP fixture — so the golden
// anchor is proven end to end, not merely seeded.
//
// HONESTY LABELS (R-02/R-03). Seeded invocation/observation rows below
// are ANCHOR-PROVENANCE FIXTURES: synthetic setup responses carrying
// only `(verificationScopeId, generationId)` JSON. They are never
// commerce business evidence, never accepted effects, and no commerce
// effect is asserted anywhere in this suite. Fixtures that shape
// provenance state beyond what the production writers emit (NULL
// fencing token, NULL executingAt on a SUCCEEDED step, renamed stepRun,
// other-step attribution) are marked FIXTURE explicitly per case and
// assert only the derivation's fail-closed handling of that
// schema-consistent state — never a business claim.
//
// S-matrix map (ADR-0026 §5):
//   S-1  one valid terminal-owner response, no stale      → ESTABLISHED
//   S-2  duplicate identical owner responses              → ESTABLISHED
//   S-3  two generation values among owner candidates     → CONFLICT
//   S-4  stale response identical to owner                → convergent
//   S-5  stale conflicting generation, not immaterial     → CONFLICT
//   S-6  stale pre-send-only recorded rows, no indep proof→ CONFLICT
//   S-6a executingAt IS NULL, no stale generation        → ESTABLISHED
//   S-7  stale-only, setup never fenced SUCCEEDED         → UNPROVEN
//   S-8  setup terminal FAILED                            → UNPROVEN
//   S-9  response sent but persistence failed (no row)    → UNPROVEN
//   S-10 truncated response                              → UNPROVEN
//   S-11 redacted decisive field                         → UNPROVEN
//   S-12 owner candidates conflict on scope              → CONFLICT
//   S-13 malformed body / wrong field types              → UNPROVEN
//   S-14 response from another runId                     → ignored
//   S-15 response from a different step of the same run  → not candidate
//   S-16 sent stale attempt, unknowable outcome          → CONFLICT
//   S-17 same scope re-established under a NEW generation→ CONFLICT
// Plus mission scenarios Q (unrelated redacted sibling stands), R
// (declared scope never observed), T (non-2xx ignored), N (fencing
// mismatch), H (late invocation after SUCCEEDED + P advance), I/J/K
// (pre-send proof discipline), L/M (wrong run/step identity).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb, PrismaClient } from '@rupturegrid/control-db';
import {
  StepProcessor,
  claimStep,
  createCredentialResolver,
  createExperiment,
  createRun,
  markExecuting,
  markRunDispatching,
  readTruthInputHead,
  recordInvocation,
  registerTarget,
  settleRuns,
  writeTerminalState,
} from '@rupturegrid/engine';
import type { FencingContext } from '@rupturegrid/engine';
import { createEngineEvidenceSink, deriveRunAnchor } from '@rupturegrid/evidence';
import type { RunScopeDeclaration } from '@rupturegrid/engine';
import { loadTestEnv } from './helpers/env.js';
import { uniqueName } from './helpers/execution-harness.js';

const prisma = (): PrismaClient => controlDb!.prisma;

let controlDb: ControlDb | null = null;
let fixture: Server;
let baseUrl = '';
let manifestTargetId: string | null = null;

const SETUP_STEP = 'establish-scope';
const ANCHOR_PATH = '/anchor/establish';
const SCOPE = 'e1-scope';
const OTHER_SCOPE = 'e1-other-scope';

let identityCounter = 0;
const nextIdentity = (tag: string): string => `e1-${tag}-${String((identityCounter += 1))}`;

// ---------------------------------------------------------------------
// Manifest + invariant bindings (copied shape from the Checkpoint C
// suite: the declaration validator requires the completeness-proof
// queryIds to exist in the frozen manifest policy).
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

const e1Manifest = (origin: string, displayName: string) => ({
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
let anchorScope = SCOPE;
let anchorGeneration = 7;

beforeAll(async () => {
  controlDb = createControlDb(loadTestEnv().controlDatabaseUrl);
  fixture = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (req.method === 'GET' && path === ANCHOR_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ verificationScopeId: anchorScope, generationId: anchorGeneration }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  for (let attempt = 0; ; attempt += 1) {
    await new Promise<void>((resolve) => {
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address() as AddressInfo;
    const candidate = `http://127.0.0.1:${String(address.port)}`;
    const taken = await prisma().targetOrigin.findUnique({
      where: { origin: candidate },
      select: { id: true },
    });
    if (taken === null) {
      baseUrl = candidate;
      return;
    }
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
    if (attempt >= 15) {
      throw new Error('no unregistered loopback origin for the Checkpoint E1 fixture');
    }
  }
});

afterAll(async () => {
  // Drain our own settleable runs through the platform's own path.
  if (controlDb !== null) {
    await settleRuns(prisma(), 200).catch(() => undefined);
  }
  if (fixture !== undefined) {
    await new Promise<void>((resolve) => {
      fixture.close(() => resolve());
    });
  }
  await controlDb?.disconnect();
});

async function ensureManifestTarget(): Promise<string> {
  if (manifestTargetId !== null) {
    return manifestTargetId;
  }
  const existing = await prisma().targetOrigin.findUnique({
    where: { origin: baseUrl },
    select: { targetId: true },
  });
  if (existing !== null) {
    manifestTargetId = existing.targetId;
    return manifestTargetId;
  }
  const displayName = uniqueName('phase17e1-fixture-target');
  const registered = await registerTarget(prisma(), {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
    manifest: e1Manifest(baseUrl, displayName),
  });
  manifestTargetId = registered.targetId;
  return registered.targetId;
}

function bindingFor(declaredScope: string): RunScopeDeclaration {
  return {
    version: 'run-scope/v1',
    setupStep: SETUP_STEP,
    declaredScope,
    scopeField: 'verificationScopeId',
    generationField: 'generationId',
    subjects: { 'INV-CHK-1': ['CHK-A'], 'INV-INV-1': ['SKU-A'] },
  } as unknown as RunScopeDeclaration;
}

function experimentDocument(
  declaredScope: string,
  stepNames: readonly string[] = [SETUP_STEP],
): Record<string, unknown> {
  return {
    steps: stepNames.map((name) => ({
      name,
      action: {
        method: 'GET',
        relativePath: ANCHOR_PATH,
        mutation: 'READ_ONLY',
        contract: 'GENERIC_HTTP',
        repeat: 1,
        concurrency: 1,
        retryPolicy: 'NONE',
      },
    })),
    invariantBindings: [INV_CHK_1, INV_INV_1],
    runScope: {
      version: 'run-scope/v1',
      setupStep: SETUP_STEP,
      declaredScope,
      scopeField: 'verificationScopeId',
      generationField: 'generationId',
      subjects: { 'INV-CHK-1': ['CHK-A'], 'INV-INV-1': ['SKU-A'] },
    },
  };
}

async function newRun(
  declaredScope = SCOPE,
  stepNames: readonly string[] = [SETUP_STEP],
): Promise<{ runId: string; stepRunId: string }> {
  const targetId = await ensureManifestTarget();
  const created = await createExperiment(prisma(), {
    name: uniqueName('phase17e1-experiment'),
    targetId,
    document: experimentDocument(declaredScope, stepNames) as never,
  });
  const run = await createRun(prisma(), created.revisionId);
  await markRunDispatching(prisma(), run.runId);
  const stepRun = await prisma().experimentStepRun.findFirstOrThrow({
    where: { runId: run.runId, name: SETUP_STEP },
    select: { id: true },
  });
  return { runId: run.runId, stepRunId: stepRun.id };
}

async function stepRunIdOf(runId: string, name: string): Promise<string> {
  const row = await prisma().experimentStepRun.findFirstOrThrow({
    where: { runId, name },
    select: { id: true },
  });
  return row.id;
}

const anchorBody = (scope: string, generation: number, extra?: Record<string, unknown>): string =>
  JSON.stringify({ verificationScopeId: scope, generationId: generation, ...(extra ?? {}) });

// ---------------------------------------------------------------------
// Production-writer helpers (the same functions the worker calls)
// ---------------------------------------------------------------------
async function claimAs(
  stepRunId: string,
  ownerId: string,
  leaseDurationMs = 30_000,
): Promise<FencingContext> {
  const claim = await claimStep(prisma(), stepRunId, { ownerId, leaseDurationMs });
  if (claim === null) {
    throw new Error(`claim failed for ${ownerId} on ${stepRunId}`);
  }
  return { ownerId, fencingToken: claim.fencingToken };
}

/** A real lease-takeover stale shape: B claims, its lease expires (DB time), A claims. */
async function claimTakeover(
  stepRunId: string,
  staleOwner: string,
  owner: string,
): Promise<{ staleCtx: FencingContext; ctx: FencingContext }> {
  const staleClaim = await claimStep(prisma(), stepRunId, {
    ownerId: staleOwner,
    leaseDurationMs: 120,
  });
  if (staleClaim === null) {
    throw new Error(`stale claim failed for ${staleOwner}`);
  }
  const staleCtx: FencingContext = { ownerId: staleOwner, fencingToken: staleClaim.fencingToken };
  let ctx: FencingContext | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claim = await claimStep(prisma(), stepRunId, { ownerId: owner, leaseDurationMs: 30_000 });
    if (claim !== null) {
      ctx = { ownerId: owner, fencingToken: claim.fencingToken };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (ctx === null) {
    throw new Error(`takeover claim failed for ${owner}`);
  }
  return { staleCtx, ctx };
}

async function recordRow(opts: {
  stepRunId: string;
  sequence: number;
  ctx: FencingContext;
  stage: string;
  status?: number | null;
  body?: string | null;
  knowledge?: 'KNOWN_OCCURRED' | 'KNOWN_ABSENT' | 'INDETERMINATE' | 'NOT_APPLICABLE';
  outcome?: 'SUCCEEDED' | 'FAILED';
  error?: string | null;
}): Promise<string> {
  const recorded = await recordInvocation(
    prisma(),
    opts.stepRunId,
    {
      sequence: opts.sequence,
      waveIndex: 0,
      invocationIdentity: nextIdentity('inv'),
      transportStage: opts.stage,
      httpStatus: opts.status ?? null,
      requestBytes: 10,
      responseBytes: opts.body?.length ?? 0,
      responseBody: opts.body ?? null,
      durationMs: 1,
      outcome: opts.outcome ?? 'SUCCEEDED',
      sideEffectKnowledge: opts.knowledge ?? 'NOT_APPLICABLE',
      error: opts.error ?? null,
    },
    opts.ctx,
  );
  return recorded.invocationId;
}

async function captureRow(opts: {
  runId: string;
  stepRunId: string;
  invocationId: string;
  status: number | null;
  body: string | null;
  truncated?: boolean;
  error?: string | null;
  ownerId: string;
  fencingToken: string | null;
}): Promise<void> {
  const sink = createEngineEvidenceSink(prisma());
  await sink.captureInvocation(
    {
      runId: opts.runId,
      stepRunId: opts.stepRunId,
      invocationId: opts.invocationId,
      invocationIdentity: nextIdentity('obs'),
      sequence: 1,
      waveIndex: 0,
      method: 'GET',
      relativePath: ANCHOR_PATH,
      requestHeaders: {},
      requestBody: null,
      transportStage: 'RESPONSE_COMPLETE',
      httpStatus: opts.status,
      responseHeaders: {},
      responseBody: opts.body,
      responseTruncated: opts.truncated ?? false,
      requestBytes: 10,
      responseBytes: opts.body?.length ?? 0,
      durationMs: 1,
      outcome: opts.error ? 'FAILED' : 'SUCCEEDED',
      error: opts.error ?? null,
      observedAt: new Date(),
    },
    { ownerId: opts.ownerId, fencingToken: opts.fencingToken },
  );
}

/** One valid owner response (invocation + captured observation). */
async function ownerResponse(
  runId: string,
  stepRunId: string,
  ctx: FencingContext,
  body: string,
  sequence: number,
  status: number | null = 200,
): Promise<void> {
  const invocationId = await recordRow({
    stepRunId,
    sequence,
    ctx,
    stage: 'RESPONSE_COMPLETE',
    status,
    body,
  });
  await captureRow({
    runId,
    stepRunId,
    invocationId,
    status,
    body,
    ownerId: ctx.ownerId,
    fencingToken: ctx.fencingToken,
  });
}

async function terminalAs(
  stepRunId: string,
  ctx: FencingContext,
  state: 'SUCCEEDED' | 'FAILED',
  attemptCount: number,
): Promise<void> {
  await writeTerminalState(
    prisma(),
    stepRunId,
    {
      state,
      intentOutcome: state,
      sideEffectKnowledge: 'NOT_APPLICABLE',
      attemptCount,
      error: null,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------
// S-1 — golden production path (REAL StepProcessor + REAL HTTP)
// ---------------------------------------------------------------------
describe('E1 · S-1 golden anchor over the real production path', () => {
  it('S-1/A: one valid terminal-owner setup response anchors the run (real StepProcessor + real HTTP)', async () => {
    anchorScope = SCOPE;
    anchorGeneration = 7;
    const { runId, stepRunId } = await newRun(SCOPE);
    const processor = new StepProcessor({
      prisma: prisma(),
      config: { WORKER_LEASE_DURATION_MS: 10_000, WORKER_HEARTBEAT_INTERVAL_MS: 2_000 },
      credentials: createCredentialResolver({}),
      evidenceSink: createEngineEvidenceSink(prisma()),
    });
    const outcome = await processor.processStep(stepRunId);
    expect(outcome).toBe('SUCCEEDED');

    const durableStep = await prisma().experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { leaseOwnerId: true, fencingToken: true, state: true },
    });
    expect(durableStep.state).toBe('SUCCEEDED');

    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ESTABLISHED');
    expect(result.anchor?.observedScope).toBe(SCOPE);
    expect(result.anchor?.observedGeneration).toBe(7);
    expect(result.anchor?.setupStepRunId).toBe(stepRunId);
    expect(result.anchor?.setupObservationHashes).toHaveLength(1);
    expect(result.anchor?.anchorFencing.leaseOwnerId).toBe(durableStep.leaseOwnerId);
    expect(result.anchor?.anchorFencing.fencingToken).toBe(
      (durableStep.fencingToken as bigint).toString(),
    );
    expect(result.staleGenerations).toHaveLength(0);

    // The frozen snapshot carries the same binding the derivation used.
    const run = await prisma().experimentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: { select: { content: true } } },
    });
    const target = (run.snapshot.content as { target: Record<string, unknown> }).target;
    expect(target['runScopeBinding']).toMatchObject({ declaredScope: SCOPE });
  });
});

// ---------------------------------------------------------------------
// Owner-side matrix (production writers, no HTTP)
// ---------------------------------------------------------------------
describe('E1 · owner-side S-cases', () => {
  it('S-2/B: duplicate identical terminal-owner responses still establish (no order selection)', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ESTABLISHED');
    expect(result.anchor?.observedScope).toBe(SCOPE);
    expect(result.anchor?.observedGeneration).toBe(7);
  });

  it('S-3/C: two generation values among terminal-owner candidates → EVIDENCE_CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 8), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('TERMINAL_OWNER_CONFLICT');
    expect(result.anchor).toBeNull();
  });

  it('S-12/R-owner: terminal-owner candidates conflicting on scope → EVIDENCE_CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(OTHER_SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('TERMINAL_OWNER_CONFLICT');
  });

  it('S-8: setup terminal FAILED → ANCHOR_UNPROVEN (never a guessed anchor)', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(stepRunId, ctx, 'FAILED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('SETUP_STEP_NOT_SUCCEEDED');
    expect(result.anchor).toBeNull();
  });

  it('S-9/G: response physically observed but persistence failed (no durable row) → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    // The invocation row exists (REQUEST reached the target); the
    // observation capture never persisted — nothing is reconstructed.
    await recordRow({ stepRunId, sequence: 1, ctx, stage: 'RESPONSE_COMPLETE', status: 200 });
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('NO_VALID_TERMINAL_OWNER_RESPONSE');
  });

  it('S-10/O: truncated setup response is a gap → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    const invocationId = await recordRow({
      stepRunId,
      sequence: 1,
      ctx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 7),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId,
      status: 200,
      body: anchorBody(SCOPE, 7),
      truncated: true,
      ownerId: ctx.ownerId,
      fencingToken: ctx.fencingToken,
    });
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.gaps.map((gap) => gap.kind)).toContain('anchor-response-truncated-or-unobserved');
  });

  it('S-11/P-a: redacted scope field is a gap → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(
      runId,
      stepRunId,
      ctx,
      JSON.stringify({ verificationScopeId: '[Redacted]', generationId: 7 }),
      1,
    );
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.gaps.map((gap) => gap.kind)).toContain('anchor-response-redacted');
  });

  it('S-11/P-b: redacted generation field is a gap → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(
      runId,
      stepRunId,
      ctx,
      JSON.stringify({ verificationScopeId: SCOPE, generationId: '[Redacted]' }),
      1,
    );
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.gaps.map((gap) => gap.kind)).toContain('anchor-response-redacted');
  });

  it('S-13/T-a: malformed body is a gap → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, 'this is not json{{{', 1);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.gaps.map((gap) => gap.kind)).toContain('anchor-response-malformed');
  });

  it('S-13/S: wrong field types are gaps, never coerced → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    // Numeric scope and string generation: no coercion in either direction.
    await ownerResponse(
      runId,
      stepRunId,
      ctx,
      JSON.stringify({ verificationScopeId: 42, generationId: '7' }),
      1,
    );
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    const kinds = result.gaps.map((gap) => gap.kind);
    expect(
      kinds.includes('anchor-response-scope-field-invalid') ||
        kinds.includes('anchor-response-generation-field-invalid'),
    ).toBe(true);
  });

  it('T: non-2xx setup-looking response is not a candidate → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1, 500);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('NO_VALID_TERMINAL_OWNER_RESPONSE');
  });

  it('R: declared scope never observed → ANCHOR_UNPROVEN (target did not establish it)', async () => {
    const { runId, stepRunId } = await newRun(OTHER_SCOPE);
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(OTHER_SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('DECLARED_SCOPE_NOT_OBSERVED');
  });

  it('Q: an unrelated redacted sibling field does not invalidate the anchor', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    // `adminToken` matches the platform redaction name pattern and is
    // masked before persistence; the decisive fields are intact.
    await ownerResponse(
      runId,
      stepRunId,
      ctx,
      anchorBody(SCOPE, 7, { adminToken: 'not-a-secret-just-a-name', note: 'plain' }),
      1,
    );
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const stored = await prisma().rawObservation.findFirstOrThrow({
      where: { runId, stepRunId, kind: 'http_response_observed' },
      select: { payload: true },
    });
    const storedBody = (stored.payload as { http: { responseBody: string } }).http.responseBody;
    expect(storedBody).toContain('[Redacted]');
    expect(JSON.parse(storedBody) as Record<string, unknown>)?.toMatchObject({
      verificationScopeId: SCOPE,
      generationId: 7,
    });
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ESTABLISHED');
  });
});

// ---------------------------------------------------------------------
// Stale-generation matrix (real lease-takeover attribution)
// ---------------------------------------------------------------------
describe('E1 · stale-generation S-cases', () => {
  it('S-4/D: stale response identical to owner → CONVERGENT, anchor stands', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    // Stale generation observed first (its real prior-generation rows).
    const staleInvocation = await recordRow({
      stepRunId,
      sequence: 1,
      ctx: staleCtx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 7),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId: staleInvocation,
      status: 200,
      body: anchorBody(SCOPE, 7),
      ownerId: staleCtx.ownerId,
      fencingToken: staleCtx.fencingToken,
    });
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ESTABLISHED');
    expect(result.staleGenerations).toHaveLength(1);
    expect(result.staleGenerations[0]?.disposition).toBe('CONVERGENT');
  });

  it('S-5/C/E: stale response with conflicting generation → EVIDENCE_CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    const staleInvocation = await recordRow({
      stepRunId,
      sequence: 1,
      ctx: staleCtx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 5),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId: staleInvocation,
      status: 200,
      body: anchorBody(SCOPE, 5),
      ownerId: staleCtx.ownerId,
      fencingToken: staleCtx.fencingToken,
    });
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
    expect(result.anchor).toBeNull();
    expect(result.staleGenerations).toHaveLength(1);
    expect(result.staleGenerations[0]?.disposition).toBe('CONFLICT');
    expect(result.staleGenerations[0]?.candidatePairs).toEqual([{ scope: SCOPE, generation: 5 }]);
  });

  it('S-17: same scope re-established under a NEW generation is still a conflict', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    const staleInvocation = await recordRow({
      stepRunId,
      sequence: 1,
      ctx: staleCtx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 5),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId: staleInvocation,
      status: 200,
      body: anchorBody(SCOPE, 5),
      ownerId: staleCtx.ownerId,
      fencingToken: staleCtx.fencingToken,
    });
    await markExecuting(prisma(), stepRunId, ctx);
    // The terminal owner re-establishes the SAME scope string with a NEW
    // generation: no target-specific superset reasoning may declare the
    // older reset immaterial — the conflict is sustained.
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
  });

  it('S-6/J: recorded pre-send-only stale rows are NEVER immateriality proof → CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    // The stale generation's recorded set is entirely pre-send
    // (PREPARED): under the frozen F-1 rule a persisted set is not a
    // closed world, so the conflict is sustained.
    await recordRow({ stepRunId, sequence: 1, ctx: staleCtx, stage: 'PREPARED' });
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const durableStep = await prisma().experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { executingAt: true },
    });
    expect(durableStep.executingAt).not.toBeNull();
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
    expect(result.staleGenerations[0]?.transportStages).toEqual(['PREPARED']);
  });

  it('S-16/K: sent stale attempt with unknowable outcome → EVIDENCE_CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    // REQUEST_SENT with no observable response: the scope may have been
    // reset with an unknowable result.
    await recordRow({ stepRunId, sequence: 1, ctx: staleCtx, stage: 'REQUEST_SENT', status: null });
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
  });

  it('S-7/F: stale-only responses, setup never fenced SUCCEEDED → ANCHOR_UNPROVEN', async () => {
    const { runId, stepRunId } = await newRun();
    const staleOwner = uniqueName('e1-stale');
    const staleCtx = await claimAs(stepRunId, staleOwner);
    await markExecuting(prisma(), stepRunId, staleCtx);
    const invocationId = await recordRow({
      stepRunId,
      sequence: 1,
      ctx: staleCtx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 7),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId,
      status: 200,
      body: anchorBody(SCOPE, 7),
      ownerId: staleCtx.ownerId,
      fencingToken: staleCtx.fencingToken,
    });
    // No terminal write: the setup step never fenced SUCCEEDED, so stale
    // observations alone never anchor the run.
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('SETUP_STEP_NOT_SUCCEEDED');
  });

  it('N: terminal-owner name with a mismatched fencing token is stale → CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    // Same owner name, wrong token, conflicting generation: fencing
    // mismatch never inherits authority. The token is a well-formed but
    // unattributed generation counter value (never the terminal token).
    const impostor: FencingContext = { ownerId: ctx.ownerId, fencingToken: '999999' };
    const impostorInvocation = await recordRow({
      stepRunId,
      sequence: 2,
      ctx: impostor,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 9),
    });
    await captureRow({
      runId,
      stepRunId,
      invocationId: impostorInvocation,
      status: 200,
      body: anchorBody(SCOPE, 9),
      ownerId: impostor.ownerId,
      fencingToken: impostor.fencingToken,
    });
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 2);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
  });

  it('case-65: NULL-token stale SENT invocation can never be immaterial → CONFLICT', async () => {
    // FIXTURE: `writtenByFencingToken` is nullable in the schema but no
    // production writer emits NULL today; this probes the null-safe
    // fail-closed attribution (ADR-0026 §5/case 65) over a
    // schema-consistent row. The row is preserved, attributed, and the
    // anchor fails closed — it never becomes KNOWN_ABSENT evidence.
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    await prisma().$transaction(async (tx) => {
      const { acquireRunLock, advanceProvenanceRevision } = await import('@rupturegrid/engine');
      await acquireRunLock(tx, runId);
      await tx.stepInvocation.create({
        data: {
          stepRunId,
          sequence: 2,
          invocationIdentity: nextIdentity('nulltoken'),
          transportStage: 'REQUEST_SENT',
          writtenByOwner: 'e1-null-token-writer',
          writtenByFencingToken: null,
        },
      });
      await advanceProvenanceRevision(tx, runId);
    });
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('EVIDENCE_CONFLICT');
    expect(result.reason).toBe('STALE_GENERATION_CONFLICT');
    const nullGroup = result.staleGenerations.find(
      (group) => group.leaseOwnerId === 'e1-null-token-writer',
    );
    expect(nullGroup?.fencingToken).toBeNull();
    expect(nullGroup?.disposition).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------
// Identity / join cases + the independent pre-send proof
// ---------------------------------------------------------------------
describe('E1 · identity joins and pre-send proof', () => {
  it('S-14/L: setup-looking response from another runId is ignored for THIS run', async () => {
    const first = await newRun();
    const second = await newRun();
    const ctx = await claimAs(second.stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), second.stepRunId, ctx);
    await ownerResponse(second.runId, second.stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(second.stepRunId, ctx, 'SUCCEEDED', 1);

    const other = await deriveRunAnchor(prisma(), second.runId, bindingFor(SCOPE));
    expect(other.state).toBe('ESTABLISHED');

    const ownerCtx = await claimAs(first.stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), first.stepRunId, ownerCtx);
    await terminalAs(first.stepRunId, ownerCtx, 'SUCCEEDED', 0);
    const result = await deriveRunAnchor(prisma(), first.runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    // The foreign row is preserved as that run's own evidence.
    const foreignRows = await prisma().rawObservation.count({
      where: { runId: second.runId, kind: 'http_response_observed' },
    });
    expect(foreignRows).toBe(1);
  });

  it('S-15/M: response from a different step of the same run is not a candidate', async () => {
    const { runId } = await newRun(SCOPE, [SETUP_STEP, 'other-step']);
    const otherStepRunId = await stepRunIdOf(runId, 'other-step');
    // FIXTURE: attributed to the other stepRun through the production
    // writers (a worker records only for its claimed step; the row shape
    // is identical). The setup stepRun itself has no response.
    const otherCtx: FencingContext = { ownerId: uniqueName('e1-other'), fencingToken: '1' };
    const invocationId = await recordRow({
      stepRunId: otherStepRunId,
      sequence: 1,
      ctx: otherCtx,
      stage: 'RESPONSE_COMPLETE',
      status: 200,
      body: anchorBody(SCOPE, 7),
    });
    await captureRow({
      runId,
      stepRunId: otherStepRunId,
      invocationId,
      status: 200,
      body: anchorBody(SCOPE, 7),
      ownerId: otherCtx.ownerId,
      fencingToken: otherCtx.fencingToken,
    });
    const setupCtx = await claimAs(await stepRunIdOf(runId, SETUP_STEP), uniqueName('e1-owner'));
    await markExecuting(prisma(), await stepRunIdOf(runId, SETUP_STEP), setupCtx);
    await terminalAs(await stepRunIdOf(runId, SETUP_STEP), setupCtx, 'SUCCEEDED', 0);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('NO_VALID_TERMINAL_OWNER_RESPONSE');
  });

  it('M-ordinal: stepRun name mismatch at the frozen ordinal → ANCHOR_UNPROVEN', async () => {
    // FIXTURE: creation always names stepRuns from the snapshot; this
    // renames the row to probe the §11 step-5 name check over a
    // schema-consistent state. No business claim is derived.
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    await prisma().experimentStepRun.update({
      where: { id: stepRunId },
      data: { name: 'renamed-step' },
    });
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ANCHOR_UNPROVEN');
    expect(result.reason).toBe('SETUP_STEP_NAME_MISMATCH');
  });

  it('S-6a/I: executingAt IS NULL with no stale generation → anchor stands', async () => {
    // FIXTURE: SUCCEEDED via the production writers always stamps
    // executingAt, so the NULL marker is restored here to probe the
    // independent step-level pre-send proof (the ONLY immateriality
    // evidence v1 accepts) over a schema-consistent state.
    const { runId, stepRunId } = await newRun();
    const ctx = await claimAs(stepRunId, uniqueName('e1-owner'));
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 1);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    await prisma().experimentStepRun.update({
      where: { id: stepRunId },
      data: { executingAt: null },
    });
    const durableStep = await prisma().experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { executingAt: true },
    });
    expect(durableStep.executingAt).toBeNull();
    const invocations = await prisma().stepInvocation.count({ where: { stepRunId } });
    expect(invocations).toBe(1);
    const result = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(result.state).toBe('ESTABLISHED');
  });

  it('H: late StepInvocation after terminal SUCCEEDED advances P and flips the anchor to CONFLICT', async () => {
    const { runId, stepRunId } = await newRun();
    const owners = { stale: uniqueName('e1-stale'), owner: uniqueName('e1-owner') };
    const { staleCtx, ctx } = await claimTakeover(stepRunId, owners.stale, owners.owner);
    await markExecuting(prisma(), stepRunId, ctx);
    await ownerResponse(runId, stepRunId, ctx, anchorBody(SCOPE, 7), 2);
    await terminalAs(stepRunId, ctx, 'SUCCEEDED', 1);
    const before = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(before.state).toBe('ESTABLISHED');
    const headBefore = await readTruthInputHead(prisma(), runId);

    // A late stale-worker append AFTER the fenced terminal write: the
    // row is preserved (unfenced, attributed) and invalidates the old
    // authorized truth through the composite P watermark.
    await recordRow({ stepRunId, sequence: 3, ctx: staleCtx, stage: 'REQUEST_SENT', status: null });
    const headAfter = await readTruthInputHead(prisma(), runId);
    expect(headAfter.provenanceRevision).toBeGreaterThan(headBefore.provenanceRevision);

    const after = await deriveRunAnchor(prisma(), runId, bindingFor(SCOPE));
    expect(after.state).toBe('EVIDENCE_CONFLICT');
    expect(after.reason).toBe('STALE_GENERATION_CONFLICT');

    // The terminal truth itself is never rewritten by the late row.
    const durableStep = await prisma().experimentStepRun.findUniqueOrThrow({
      where: { id: stepRunId },
      select: { state: true, leaseOwnerId: true, fencingToken: true },
    });
    expect(durableStep.state).toBe('SUCCEEDED');
    expect(durableStep.leaseOwnerId).toBe(ctx.ownerId);
    const lateRows = await prisma().stepInvocation.count({ where: { stepRunId } });
    expect(lateRows).toBe(2);
  });
});
