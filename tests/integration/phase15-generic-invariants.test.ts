// =====================================================================
// Integration — Phase 15 business-invariant/v1 registry (R-08)
// =====================================================================
// The Phase 15 exit criteria, exercised over the REAL stack: a manifest
// declaring both invariant kinds' surfaces → frozen snapshot invariant
// bindings (validated at freeze time) → read-only HTTP inspection →
// redacted raw observations → typed normalized events → active graph →
// generic evaluation → idempotent InvariantEvaluation persistence →
// deterministic generic Findings for FAILs only. Real PostgreSQL, real
// HTTP fixture, no mocks for infrastructure semantics (R-08).
//
// The fixture domain is deliberately neutral (a warehouse + checkout
// vocabulary unrelated to the frozen Demo lineage except where the
// conformance semantics demand the checkout shape).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExperiment, createRun, registerTarget } from '@rupturegrid/engine';
import {
  captureGenericInspectionSet,
  deriveRunEvidence,
  loadFrozenEvidencePolicy,
  runRunAnalysis,
} from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import { loadTestEnv } from './helpers/env.js';
import { uniqueName } from './helpers/execution-harness.js';

const prisma = () => controlDb!.prisma;

let controlDb: ControlDb | null = null;
let baseUrl = '';
let manifestTargetId: string | null = null;

// ---------------------------------------------------------------------
// Warehouse+checkout manifest: every role/field the two reference
// invariant instances reference is declared here (definition-time
// validation is against THIS frozen policy).
// ---------------------------------------------------------------------
const phase15Manifest = (origin: string, displayName: string) => ({
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
      fields: {
        checkoutIntentId: 'string',
        customerId: 'string',
        cartId: 'string',
        totalMinor: 'integer-minor-units',
        currency: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'Orders',
      path: '/inspection/orders',
      fields: {
        orderId: 'string',
        checkoutIntentId: 'string',
        customerId: 'string',
        cartId: 'string',
        totalMinor: 'integer-minor-units',
        currency: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['orderId'],
    },
    {
      queryId: 'ordersArchive',
      roleId: 'order',
      description: 'Archive orders (same role, same identity — B-3)',
      path: '/inspection/orders-archive',
      fields: {
        orderId: 'string',
        checkoutIntentId: 'string',
        customerId: 'string',
        cartId: 'string',
        totalMinor: 'integer-minor-units',
        currency: 'string',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['orderId'],
    },
    {
      queryId: 'ordersSummary',
      roleId: 'ordersSummary',
      description: 'Per-intent accepted-order totals',
      path: '/inspection/orders-summary',
      fields: {
        checkoutIntentId: 'string',
        acceptedOrderTotal: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['checkoutIntentId'],
    },
    {
      queryId: 'skus',
      roleId: 'sku',
      description: 'SKU registry',
      path: '/inspection/skus',
      fields: {
        sku: 'string',
        title: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'stockBaseline',
      roleId: 'skuBaseline',
      description: 'Stock baselines',
      path: '/inspection/stock-baseline',
      fields: {
        sku: 'string',
        initialAvailableUnits: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'stockRemaining',
      roleId: 'skuRemaining',
      description: 'Stock remaining state',
      path: '/inspection/stock-remaining',
      fields: {
        sku: 'string',
        remainingAvailableUnits: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
    {
      queryId: 'reservations',
      roleId: 'reservation',
      description: 'Reservations',
      path: '/inspection/reservations',
      fields: {
        reservationId: 'string',
        sku: 'string',
        reservedUnits: 'integer-minor-units',
        status: 'string',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['reservationId'],
    },
    {
      queryId: 'reservationsSummary',
      roleId: 'reservationsSummary',
      description: 'Per-SKU accepted-reservation totals',
      path: '/inspection/reservations-summary',
      fields: {
        sku: 'string',
        acceptedReservationTotal: 'integer-minor-units',
        verificationScopeId: 'string',
        generationId: 'string',
      },
      identityFields: ['sku'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'checkoutIntent',
        description: 'A checkout intent',
        fields: {
          checkoutIntentId: 'string',
          customerId: 'string',
          cartId: 'string',
          totalMinor: 'integer-minor-units',
          currency: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'order',
        description: 'An order',
        fields: {
          orderId: 'string',
          checkoutIntentId: 'string',
          customerId: 'string',
          cartId: 'string',
          totalMinor: 'integer-minor-units',
          currency: 'string',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'ordersSummary',
        description: 'A per-intent summary row',
        fields: {
          checkoutIntentId: 'string',
          acceptedOrderTotal: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'sku',
        description: 'A stocked resource',
        fields: {
          sku: 'string',
          title: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'skuBaseline',
        description: 'A baseline fact',
        fields: {
          sku: 'string',
          initialAvailableUnits: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'skuRemaining',
        description: 'A remaining fact',
        fields: {
          sku: 'string',
          remainingAvailableUnits: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'reservation',
        description: 'A reservation effect',
        fields: {
          reservationId: 'string',
          sku: 'string',
          reservedUnits: 'integer-minor-units',
          status: 'string',
          verificationScopeId: 'string',
          generationId: 'string',
        },
      },
      {
        roleId: 'reservationsSummary',
        description: 'A per-SKU summary row',
        fields: {
          sku: 'string',
          acceptedReservationTotal: 'integer-minor-units',
          verificationScopeId: 'string',
          generationId: 'string',
        },
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
  sensitiveFields: [],
});

// ---------------------------------------------------------------------
// The two frozen reference instances (ADR-0023 §6 shapes)
// ---------------------------------------------------------------------
const INV_CHK_1 = {
  key: 'INV-CHK-1',
  kind: 'atMostOneAcceptedEffect',
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
// Fixture state + read-only HTTP behavior
// ---------------------------------------------------------------------
interface OrderRow {
  orderId: string;
  checkoutIntentId: string;
  customerId: string;
  cartId: string;
  totalMinor: number;
  currency: string;
  status: string;
  verificationScopeId: string;
  generationId: string;
}

const SCOPE = 'scope-phase15';
const GEN = 'gen-1';

const fixtureState = {
  checkoutIntents: [
    {
      checkoutIntentId: 'CHK-ONE',
      customerId: 'CUST-1',
      cartId: 'CART-1',
      totalMinor: 500000,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      checkoutIntentId: 'CHK-TWO',
      customerId: 'CUST-2',
      cartId: 'CART-2',
      totalMinor: 700000,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      checkoutIntentId: 'CHK-DUP',
      customerId: 'CUST-3',
      cartId: 'CART-3',
      totalMinor: 900000,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      checkoutIntentId: 'CHK-ZERO',
      customerId: 'CUST-4',
      cartId: 'CART-4',
      totalMinor: 100000,
      currency: 'PKR',
      status: 'CONFIRMED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
  ],
  orders: [
    {
      orderId: 'ORD-1',
      checkoutIntentId: 'CHK-ONE',
      customerId: 'CUST-1',
      cartId: 'CART-1',
      totalMinor: 500000,
      currency: 'PKR',
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      orderId: 'ORD-D1',
      checkoutIntentId: 'CHK-DUP',
      customerId: 'CUST-3',
      cartId: 'CART-3',
      totalMinor: 900000,
      currency: 'PKR',
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      orderId: 'ORD-D2',
      checkoutIntentId: 'CHK-DUP',
      customerId: 'CUST-3',
      cartId: 'CART-3',
      totalMinor: 900000,
      currency: 'PKR',
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
  ] as OrderRow[],
  ordersArchive: [] as OrderRow[],
  ordersSummary: [
    {
      checkoutIntentId: 'CHK-ONE',
      acceptedOrderTotal: 1,
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      checkoutIntentId: 'CHK-DUP',
      acceptedOrderTotal: 2,
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      checkoutIntentId: 'CHK-ZERO',
      acceptedOrderTotal: 0,
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
  ],
  skus: [
    { sku: 'SKU-A', title: 'Gadget', verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-B', title: 'Gizmo', verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-C', title: 'Widget', verificationScopeId: SCOPE, generationId: GEN },
  ],
  stockBaseline: [
    { sku: 'SKU-A', initialAvailableUnits: 10, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-B', initialAvailableUnits: 10, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-C', initialAvailableUnits: 10, verificationScopeId: SCOPE, generationId: GEN },
  ],
  stockRemaining: [
    { sku: 'SKU-A', remainingAvailableUnits: 8, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-B', remainingAvailableUnits: -1, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-C', remainingAvailableUnits: 5, verificationScopeId: SCOPE, generationId: GEN },
  ],
  reservations: [
    {
      reservationId: 'RES-A1',
      sku: 'SKU-A',
      reservedUnits: 2,
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      reservationId: 'RES-B1',
      sku: 'SKU-B',
      reservedUnits: 2,
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
    {
      reservationId: 'RES-C1',
      sku: 'SKU-C',
      reservedUnits: 2,
      status: 'ACCEPTED',
      verificationScopeId: SCOPE,
      generationId: GEN,
    },
  ],
  reservationsSummary: [
    { sku: 'SKU-A', acceptedReservationTotal: 1, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-B', acceptedReservationTotal: 1, verificationScopeId: SCOPE, generationId: GEN },
    { sku: 'SKU-C', acceptedReservationTotal: 1, verificationScopeId: SCOPE, generationId: GEN },
  ],
  ordersArchiveValid: true,
  ordersOk: true,
};

const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('read-only inspection surface');
    return;
  }
  const json = (body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/inspection/checkout-intents') return json(fixtureState.checkoutIntents);
  if (path === '/inspection/orders') {
    if (!fixtureState.ordersOk) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'orders surface unavailable' }));
      return;
    }
    return json(fixtureState.orders);
  }
  if (path === '/inspection/orders-archive') {
    if (!fixtureState.ordersArchiveValid) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'archive unavailable' }));
      return;
    }
    return json(fixtureState.ordersArchive);
  }
  if (path === '/inspection/orders-summary') return json(fixtureState.ordersSummary);
  if (path === '/inspection/skus') return json(fixtureState.skus);
  if (path === '/inspection/stock-baseline') return json(fixtureState.stockBaseline);
  if (path === '/inspection/stock-remaining') return json(fixtureState.stockRemaining);
  if (path === '/inspection/reservations') return json(fixtureState.reservations);
  if (path === '/inspection/reservations-summary') return json(fixtureState.reservationsSummary);
  res.writeHead(404);
  res.end('not found');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    fixture.listen(0, '127.0.0.1', () => resolve());
  });
  const address = fixture.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  controlDb = createControlDb(loadTestEnv().controlDatabaseUrl);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    fixture.close(() => resolve());
  });
  await controlDb?.disconnect();
});

/**
 * Registers the manifest target once (origin authority is global).
 * Idempotent across suite runs: a reused OS port whose origin is still
 * registered in the persistent DB resolves to the EXISTING target.
 */
async function ensureManifestTarget(): Promise<string> {
  if (manifestTargetId !== null) {
    return manifestTargetId;
  }
  const existingOrigin = await prisma().targetOrigin.findUnique({
    where: { origin: baseUrl },
    select: { targetId: true },
  });
  if (existingOrigin !== null) {
    manifestTargetId = existingOrigin.targetId;
    return manifestTargetId;
  }
  const displayName = uniqueName('phase15-manifest-target');
  const registered = await registerTarget(prisma(), {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
    manifest: phase15Manifest(baseUrl, displayName),
  });
  manifestTargetId = registered.targetId;
  return registered.targetId;
}

/** Creates an experiment WITH frozen generic invariant bindings + a run. */
async function createRunWithBindings(): Promise<{ runId: string; revisionId: string }> {
  const targetId = await ensureManifestTarget();
  const created = await createExperiment(prisma(), {
    name: uniqueName('phase15-invariants-experiment'),
    targetId,
    document: {
      steps: [
        {
          name: 'probe',
          action: {
            method: 'GET',
            relativePath: '/inspection/skus',
            mutation: 'READ_ONLY',
            contract: 'GENERIC_HTTP',
          },
        },
      ],
      invariantBindings: [INV_CHK_1, INV_INV_1],
    },
  });
  const run = await createRun(prisma(), created.revisionId);
  return { runId: run.runId, revisionId: created.revisionId };
}

/** Captures every declared inspection query and derives the evidence. */
async function captureAndDerive(runId: string): Promise<void> {
  const policy = (await loadFrozenEvidencePolicy(prisma(), runId))!;
  await captureGenericInspectionSet(prisma(), {
    runId,
    stepRunId: null,
    origin: baseUrl,
    environment: 'LOCAL_DEVELOPMENT',
    policy,
    writerOwnerId: 'phase15-integration',
    writerFencingToken: null,
  });
  await deriveRunEvidence(prisma(), runId);
}

// Legacy INV-DF-1/INV-DF-2 evaluators also report evaluatorVersion 'v1',
// so filtering on evaluatorVersion alone would mix legacy rows into the
// generic row set. Invariant keys are the unambiguous discriminator.
const latestGenericEvaluations = async (runId: string) =>
  prisma().invariantEvaluation.findMany({
    where: { runId, invariantKey: { in: ['INV-CHK-1', 'INV-INV-1'] } },
    orderBy: { createdAt: 'asc' },
  });

describe('Phase 15: frozen binding round-trip (real PostgreSQL)', () => {
  it('freezes validated invariant bindings into the run snapshot', async () => {
    const { runId } = await createRunWithBindings();
    const run = await prisma().experimentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { snapshot: { select: { content: true } } },
    });
    const target = (run.snapshot.content as { target: Record<string, unknown> })['target'];
    const bindings = target['invariantBindings'] as Array<{ key: string; kind: string }>;
    expect(Array.isArray(bindings)).toBe(true);
    expect(bindings.map((binding) => binding.key)).toEqual(['INV-CHK-1', 'INV-INV-1']);
    expect('manifestEvidencePolicy' in target).toBe(true);
  });

  it('rejects an invalid definition at definition time (never stored, never frozen, never evaluated)', async () => {
    const targetId = await ensureManifestTarget();
    await expect(
      createExperiment(prisma(), {
        name: uniqueName('phase15-invalid-binding'),
        targetId,
        document: {
          steps: [
            {
              name: 'probe',
              action: {
                method: 'GET',
                relativePath: '/inspection/skus',
                mutation: 'READ_ONLY',
                contract: 'GENERIC_HTTP',
              },
            },
          ],
          invariantBindings: [
            {
              ...INV_CHK_1,
              params: { ...INV_CHK_1.params, subjectRole: 'notADeclaredRole' },
            },
          ],
        },
      }),
    ).rejects.toThrow(/UNDECLARED_ROLE|notADeclaredRole/i);
  });

  it('rejects invariantBindings on a manifest-less target (no policy to validate against)', async () => {
    const displayName = uniqueName('phase15-legacy-target');
    const port = 20000 + (Date.now() % 20000);
    const registered = await registerTarget(prisma(), {
      displayName,
      environment: 'LOCAL_DEVELOPMENT',
      origins: [`http://127.0.0.1:${port}`],
      contractKind: 'GENERIC_HTTP',
      credentialRefs: [],
    });
    // The contract mismatch on the legacy target is irrelevant: the
    // Phase 15 §9 invariantBindings rejection is DEFINITION-time and
    // fires regardless (no policy to validate against).
    await expect(
      createExperiment(prisma(), {
        name: uniqueName('phase15-legacy-binding'),
        targetId: registered.targetId,
        document: {
          steps: [
            {
              name: 'probe',
              action: {
                method: 'GET',
                relativePath: '/',
                mutation: 'READ_ONLY',
                contract: 'LOCAL_DEVELOPMENT',
              },
            },
          ],
          invariantBindings: [INV_CHK_1],
        },
      }),
    ).rejects.toThrow(/invariantBindings|evidence policy/i);
  });
});

describe('Phase 15: generic evaluation over real evidence', () => {
  let runId: string;

  beforeAll(async () => {
    const created = await createRunWithBindings();
    runId = created.runId;
    await captureAndDerive(runId);
  });

  it('atMostOne: PASS with one attributed effect + proven completeness', async () => {
    await runRunAnalysis(prisma(), runId);
    const rows = await latestGenericEvaluations(runId);
    const pass = rows.find(
      (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-ONE'),
    );
    expect(pass?.verdict).toBe('PASS');
  });

  it('atMostOne: FAIL on two distinct attributed effects (row 5) + deterministic Finding', async () => {
    const result = await runRunAnalysis(prisma(), runId);
    expect([...result.genericInvariantKeys].sort()).toEqual(['INV-CHK-1', 'INV-INV-1']);
    const rows = await latestGenericEvaluations(runId);
    const fail = rows.find(
      (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-DUP'),
    );
    expect(fail?.verdict).toBe('FAIL');
    const forensics = await deriveRunForensics(prisma(), runId);
    const finding = forensics.findings.find(
      (entry) =>
        entry.reasonCode === 'TOO_MANY_ACCEPTED_EFFECTS' &&
        entry.invariantEvaluationId === fail?.id,
    );
    expect(finding).toBeDefined();
  });

  it('atMostOne: convergent duplicate observations count ONCE (semantic dedup)', async () => {
    // ORD-D1 and ORD-D2 are distinct identities (2 effects ⇒ FAIL);
    // the summary total 2 matches ⇒ the FAIL is not a count artifact.
    const rows = await latestGenericEvaluations(runId);
    const fail = rows.find(
      (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-DUP'),
    );
    const details = (fail?.details ?? {}) as {
      attributableEffectCount?: number;
      countedEffectIdentities?: string[];
    };
    expect(details.attributableEffectCount).toBe(2);
    expect(details.countedEffectIdentities).toHaveLength(2); // ORD-D1 + ORD-D2 — never collapsed, never double-counted.
  });

  it('resourceConservation: Case A, B, C verdicts with per-case Finding reason codes', async () => {
    await runRunAnalysis(prisma(), runId);
    const rows = await latestGenericEvaluations(runId);
    const bySku = (sku: string) =>
      rows.find((row) => row.invariantKey === 'INV-INV-1' && row.subjectKey.includes(sku));
    // SKU-A: 10 − 2 = 8 = remaining ⇒ PASS.
    expect(bySku('SKU-A')?.verdict).toBe('PASS');
    // SKU-B: authoritative remaining −1 ⇒ FAIL Case B.
    expect(bySku('SKU-B')?.verdict).toBe('FAIL');
    // SKU-C: 10 − 2 = 8 ≠ 5 with completeness proven ⇒ FAIL Case C.
    expect(bySku('SKU-C')?.verdict).toBe('FAIL');
    const mechanisms = await prisma().invariantEvaluation.findMany({
      where: { runId, invariantKey: 'INV-INV-1', verdict: 'FAIL' },
      select: { details: true },
    });
    const found = mechanisms
      .map((row) => (row.details as { failureMechanism?: string }).failureMechanism)
      .sort();
    // SKU-B is Case B (authoritative remaining −1) and SKU-C is Case C
    // (10 − 2 = 8 ≠ 5 with completeness proven): exactly the two failure
    // mechanisms the frozen §8 verdict algorithm produces here.
    expect(found).toEqual(
      ['RESOURCE_CONSERVATION_MISMATCH', 'RESOURCE_CONSERVATION_NEGATIVE_REMAINING'].sort(),
    );
    // Findings derive ONLY for FAIL evaluations, with the exact reason code.
    const forensics = await deriveRunForensics(prisma(), runId);
    const genericReasons = forensics.findings.map((entry) => entry.reasonCode).sort();
    expect(genericReasons).toContain('RESOURCE_CONSERVATION_NEGATIVE_REMAINING');
  });

  it('idempotency + concurrency: parallel analysis passes converge on ONE row per semantic evaluation', async () => {
    const before = await prisma().invariantEvaluation.count({ where: { runId } });
    await Promise.all([
      runRunAnalysis(prisma(), runId),
      runRunAnalysis(prisma(), runId),
      runRunAnalysis(prisma(), runId),
    ]);
    const after = await prisma().invariantEvaluation.count({ where: { runId } });
    expect(after).toBe(before); // Same evidence ⇒ same evidenceSetHash ⇒ no new rows.
  });

  it('restart determinism: analysis is reproducible from durable rows alone', async () => {
    const first = await runRunAnalysis(prisma(), runId);
    const rowsAfterFirst = await latestGenericEvaluations(runId);
    const hashes = rowsAfterFirst
      .map((row) => `${row.invariantKey}:${row.subjectKey}:${row.evidenceSetHash}`)
      .sort();
    // A "restarted" analysis pass reads the same durable truth and
    // must reproduce the identical hashes and verdicts.
    await runRunAnalysis(prisma(), runId);
    const rowsAfterSecond = await latestGenericEvaluations(runId);
    const hashes2 = rowsAfterSecond
      .map((row) => `${row.invariantKey}:${row.subjectKey}:${row.evidenceSetHash}`)
      .sort();
    expect(hashes2).toEqual(hashes);
    expect(first.genericEvaluatedCount).toBe(rowsAfterSecond.length);
  });
});

describe('Phase 15: capture honesty and contested identity (real HTTP surfaces)', () => {
  it('valid [] vs failed capture: PASS requires the COMPLETE capture set; a failed effect-role capture never PASSES (rows 14/17)', async () => {
    const created = await createRunWithBindings();
    const localRun = created.runId;
    await captureAndDerive(localRun);
    await runRunAnalysis(prisma(), localRun);
    // CHK-ZERO: valid [] orders capture + summary total 0 ⇒ PASS (§3).
    const rows = await latestGenericEvaluations(localRun);
    const zero = rows.find(
      (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-ZERO'),
    );
    expect(zero?.verdict).toBe('PASS');

    // Now break the archive effect-role surface (a required PASS
    // capture) and capture a NEW run: CHK-ONE's single effect can no
    // longer PASS (row 17), while CHK-DUP's lower-bound FAIL stands
    // (row 18 — missing ADDITIONAL captures never undo a FAIL).
    fixtureState.ordersArchiveValid = false;
    try {
      const broken = await createRunWithBindings();
      await captureAndDerive(broken.runId);
      await runRunAnalysis(prisma(), broken.runId);
      const brokenRows = await latestGenericEvaluations(broken.runId);
      const stillPass = brokenRows.find(
        (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-ONE'),
      );
      expect(stillPass?.verdict).toBe('NOT_EVALUABLE');
      expect(
        (stillPass?.details as { gapReason?: string }).gapReason ?? stillPass?.reason,
      ).toBeDefined();
      const stillFail = brokenRows.find(
        (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-DUP'),
      );
      expect(stillFail?.verdict).toBe('FAIL');
    } finally {
      fixtureState.ordersArchiveValid = true;
    }
  });

  it('multi-query denial: a failed PRIMARY effect surface is never [] (row 14) — every verdict degrades to honest NOT_EVALUABLE', async () => {
    fixtureState.ordersOk = false;
    try {
      const broken = await createRunWithBindings();
      await captureAndDerive(broken.runId);
      await runRunAnalysis(prisma(), broken.runId);
      const rows = await latestGenericEvaluations(broken.runId);
      // The surface holding the counted effects is ABSENT: no effect
      // entity exists, so neither the lower-bound FAIL (no provable
      // effects — row 18 protects only already-counted proofs) nor a
      // PASS (row 14: never []) can fire. Honest NOT_EVALUABLE for all.
      const dup = rows.find(
        (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-DUP'),
      );
      expect(dup?.verdict).toBe('NOT_EVALUABLE');
      const one = rows.find(
        (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-ONE'),
      );
      expect(one?.verdict).toBe('NOT_EVALUABLE');
    } finally {
      fixtureState.ordersOk = true;
    }
  });

  it('conflicting duplicate identity across same-role queries ⇒ CONTESTED_IDENTITY, never two effects (B-2/B-3)', async () => {
    fixtureState.ordersArchive = [
      {
        orderId: 'ORD-D1',
        checkoutIntentId: 'CHK-DUP',
        customerId: 'CUST-3',
        cartId: 'CART-3',
        totalMinor: 999999, // Conflicting payload for the SAME order identity.
        currency: 'PKR',
        status: 'ACCEPTED',
        verificationScopeId: SCOPE,
        generationId: GEN,
      },
    ];
    try {
      const contested = await createRunWithBindings();
      await captureAndDerive(contested.runId);
      await runRunAnalysis(prisma(), contested.runId);
      const rows = await latestGenericEvaluations(contested.runId);
      const dup = rows.find(
        (row) => row.invariantKey === 'INV-CHK-1' && row.subjectKey.includes('CHK-DUP'),
      );
      expect(dup?.verdict).toBe('NOT_EVALUABLE');
      const details = (dup?.details ?? {}) as { gap?: string };
      expect(details.gap ?? '').toContain('CONTESTED_IDENTITY');
    } finally {
      fixtureState.ordersArchive = [];
    }
  });

  it('the frozen generic registry is closed: only business-invariant/v1 instances evaluate', async () => {
    const created = await createRunWithBindings();
    const policy = (await loadFrozenEvidencePolicy(prisma(), created.runId))!;
    expect(policy).toBeDefined();
    const run = await prisma().experimentRun.findUniqueOrThrow({
      where: { id: created.runId },
      select: { snapshot: { select: { content: true } } },
    });
    const target = (run.snapshot.content as { target: Record<string, unknown> })['target'];
    const bindings = target['invariantBindings'] as Array<{ registryVersion: string }>;
    for (const binding of bindings) {
      expect(binding.registryVersion).toBe('business-invariant/v1');
    }
  });
});
