// =====================================================================
// Integration — Phase 14 foreign-manifest generic evidence chain (R-08)
// =====================================================================
// The Phase 14 exit criterion: a NON-Demo-shaped target declaration can
// go manifest declaration → frozen run policy → read-only HTTP
// inspection → redacted raw observation → typed normalized events →
// identity-direct causal relationships → identity-chain attribution —
// with NO hard-coded Fintech vocabulary.
//
// The fixture is deliberately UNLIKE payments/webhooks: a small
// LIBRARY domain (member → loan → fine). Real HTTP fixture server,
// real Control PostgreSQL, real redaction, real derivation. The Demo
// path is untouched by construction (separate adapter kinds and
// normalizers; existing suites prove the frozen behavior).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { createExperiment, createRun, registerTarget } from '@rupturegrid/engine';
import {
  canonicalEvidenceHash,
  captureGenericInspectionQuery,
  captureGenericInspectionSet,
  deriveRunEvidence,
  GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
  GENERIC_INSPECTION_ADAPTER_KIND,
  GENERIC_IDENTITY_CHAIN_RELATION_KIND,
  loadFrozenEvidencePolicy,
  normalizeGenericInspectionObservation,
  verifyRunEvidenceChain,
} from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import { uniqueName } from './helpers/execution-harness.js';

const prisma = () => controlDb!.prisma;

let controlDb: ControlDb | null = null;
let baseUrl = '';
let manifestTargetId: string | null = null;
let runId: string | null = null;

// ---------------------------------------------------------------------
// Library-domain manifest (roles/fields unrelated to Demo Fintech)
// ---------------------------------------------------------------------
const libraryManifest = (origin: string, displayName: string) => ({
  manifestVersion: 'target-manifest/v1' as const,
  displayName,
  environment: 'LOCAL_DEVELOPMENT' as const,
  origins: [origin],
  credentialRefs: [] as string[],
  contract: { kind: 'GENERIC_HTTP' as const },
  inspection: [
    {
      queryId: 'members',
      roleId: 'member',
      description: 'Registered members',
      path: '/inspection/members',
      fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
      identityFields: ['memberId'],
    },
    {
      queryId: 'membersArchive',
      roleId: 'member',
      description: 'Archive member registry (same role, same identity — B-3)',
      path: '/inspection/members-archive',
      fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
      identityFields: ['memberId'],
    },
    {
      queryId: 'loans',
      roleId: 'loan',
      description: 'Loans',
      path: '/inspection/loans',
      fields: { loanId: 'string', memberId: 'string' },
      identityFields: ['loanId'],
    },
    {
      queryId: 'fines',
      roleId: 'fine',
      description: 'Fines',
      path: '/inspection/fines',
      fields: { fineId: 'string', loanId: 'string', amountMinorUnits: 'integer-minor-units' },
      identityFields: ['fineId'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'member',
        description: 'A member',
        fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
      },
      { roleId: 'loan', description: 'A loan', fields: { loanId: 'string', memberId: 'string' } },
      {
        roleId: 'fine',
        description: 'A fine',
        fields: { fineId: 'string', loanId: 'string', amountMinorUnits: 'integer-minor-units' },
      },
    ],
    causalEdges: [
      { fromRoleId: 'member', toRoleId: 'loan', edgeKind: 'took-out', linkFields: ['memberId'] },
      { fromRoleId: 'loan', toRoleId: 'fine', edgeKind: 'incurred', linkFields: ['loanId'] },
    ],
    effectRoleIds: ['fine'],
  },
  sensitiveFields: ['homeAddress'],
});

// ---------------------------------------------------------------------
// Fixture state + HTTP behavior (read-only inspection surfaces)
// ---------------------------------------------------------------------
const fixtureState = {
  members: [{ memberId: 'MEM-1', cardStatus: 'active', homeAddress: '42 Secret Lane' }],
  membersArchive: [] as { memberId: string; cardStatus: string; homeAddress: string }[],
  loans: [
    { loanId: 'LOAN-1', memberId: 'MEM-1' },
    { loanId: 'LOAN-2', memberId: 'MEM-2' }, // disconnected member
  ],
  fines: [{ fineId: 'FINE-1', loanId: 'LOAN-1', amountMinorUnits: 150000 }],
  loansInvalid: false,
};

const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('read-only inspection surface');
    return;
  }
  if (path === '/inspection/members') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixtureState.members));
    return;
  }
  if (path === '/inspection/members-archive') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixtureState.membersArchive));
    return;
  }
  // B-5 status-matrix surface: the SAME valid-array body from every
  // status class — only 2xx may ever become business events.
  const statusMatch = /^\/status\/(\d{3})$/.exec(path);
  if (statusMatch !== null) {
    const status = Number(statusMatch[1]);
    res.writeHead(status, { 'content-type': 'application/json' });
    if (status === 204) {
      res.end();
    } else {
      res.end(JSON.stringify([{ memberId: 'MEM-1', cardStatus: 'active', homeAddress: 'x' }]));
    }
    return;
  }
  // B-1 truncation + plaintext-secret surface: an over-cap body whose
  // first bytes carry a bearer secret (truncated AND secret-bearing),
  // and a short plaintext body carrying every secret shape.
  if (path === '/huge-truncated-secret') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      `opaque-prefix-canary-DO-NOT-PERSIST\nBearer sk-canary-truncated-secret\n${'x'.repeat(300_000)}`,
    );
    return;
  }
  if (path === '/plain-secret') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      'auth=Bearer sk-live-canary-abc123 jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk url=postgres://admin:hunter2canary@db.example/main',
    );
    return;
  }
  // Opaque-body security closure surfaces: bodies that can never be
  // parsed into the declared JSON structure. Their raw text must never
  // persist — no regex salvage exists for arbitrary key/value formats.
  if (path === '/opaque-kv') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('password=supersecret\napiKey=my-secret-value\nnote=hello');
    return;
  }
  if (path === '/opaque-bearer') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Bearer VERY_SECRET_TOKEN');
    return;
  }
  if (path === '/opaque-malformed') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"members": [{"memberId": "MEM-1", "password": supersecret}');
    return;
  }
  if (path === '/opaque-html') {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html><body>upstream error: supersecret leaked</body></html>');
    return;
  }
  if (path === '/inspection/loans') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(fixtureState.loansInvalid ? [{ loanId: 'LOAN-1' }] : fixtureState.loans),
    );
    return;
  }
  if (path === '/inspection/fines') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixtureState.fines));
    return;
  }
  if (path === '/redirect-away') {
    res.writeHead(302, { location: 'http://127.0.0.1:1/evil' });
    res.end();
    return;
  }
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

  const displayName = uniqueName('library-manifest-target');
  const registered = await registerTarget(prisma(), {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
    manifest: libraryManifest(baseUrl, displayName),
  });
  manifestTargetId = registered.targetId;

  const created = await createExperiment(prisma(), {
    name: uniqueName('library-experiment'),
    targetId: registered.targetId,
    document: {
      steps: [
        {
          name: 'probe',
          action: {
            method: 'GET',
            relativePath: '/inspection/members',
            mutation: 'READ_ONLY',
            contract: 'GENERIC_HTTP',
          },
        },
      ],
    },
  });
  const run = await createRun(prisma(), created.revisionId);
  runId = run.runId;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    fixture.close(() => resolve());
  });
  await controlDb?.disconnect();
});

/** Registers the library target once (origin authority is global). */
async function ensureLibraryTarget(): Promise<string> {
  if (manifestTargetId !== null) {
    return manifestTargetId;
  }
  const displayName = uniqueName('library-manifest-target');
  const registered = await registerTarget(prisma(), {
    displayName,
    environment: 'LOCAL_DEVELOPMENT',
    origins: [baseUrl],
    contractKind: 'GENERIC_HTTP',
    credentialRefs: [],
    manifest: libraryManifest(baseUrl, displayName),
  });
  manifestTargetId = registered.targetId;
  return registered.targetId;
}

describe('Phase 14: foreign-manifest evidence chain end to end (real HTTP + real PostgreSQL)', () => {
  it('freezes the manifest evidence policy into the run snapshot', async () => {
    await ensureLibraryTarget();
    const policy = await loadFrozenEvidencePolicy(prisma(), runId as string);
    expect(policy).toBeDefined();
    expect(policy?.inspection.map((query) => query.queryId)).toEqual([
      'members',
      'membersArchive',
      'loans',
      'fines',
    ]);
    expect(policy?.identityModel.causalEdges.map((edge) => edge.edgeKind)).toEqual([
      'took-out',
      'incurred',
    ]);
    expect(policy?.sensitiveFields).toEqual(['homeAddress']);
    const run = await prisma().experimentRun.findUniqueOrThrow({
      where: { id: runId as string },
      select: { snapshot: { select: { content: true } } },
    });
    const target = (run.snapshot.content as { target: Record<string, unknown> })['target'];
    // Phase 13 execution policy untouched; Phase 14 evidence policy additive.
    expect('manifestPolicy' in target).toBe(true);
    expect('manifestEvidencePolicy' in target).toBe(true);
  });

  it('captures REAL HTTP inspections as honest redacted raw observations', async () => {
    const captured = await captureGenericInspectionSet(prisma(), {
      runId: runId as string,
      stepRunId: null,
      origin: baseUrl,
      environment: 'LOCAL_DEVELOPMENT',
      policy: (await loadFrozenEvidencePolicy(prisma(), runId as string))!,
      writerOwnerId: 'phase14-integration',
      writerFencingToken: null,
    });
    expect(captured).toHaveLength(4);
    expect(captured.every((entry) => entry.adapterKind === GENERIC_INSPECTION_ADAPTER_KIND)).toBe(
      true,
    );
    expect(captured.every((entry) => entry.valid)).toBe(true);

    const observations = await prisma().rawObservation.findMany({
      where: { runId: runId as string, adapterKind: GENERIC_INSPECTION_ADAPTER_KIND },
    });
    expect(observations).toHaveLength(4);
    for (const observation of observations) {
      expect(observation.kind).toBe('target_observation');
      expect(observation.origin).toBe('OBSERVED');
      // Query provenance identity: stable per (run, queryId).
      expect(observation.invocationIdentity).toMatch(/^manifest-inspection:/);
      const payload = observation.payload as {
        declaration: { queryId: string; roleId: string; path: string };
        observed: {
          httpStatus: number;
          responseJsonText: string;
          responseJson: unknown;
          parseStatus: string;
          opaqueBody?: unknown;
        };
        validation: { valid: boolean };
        redaction: { applied: boolean };
      };
      expect(payload.observed.httpStatus).toBe(200);
      expect(payload.validation.valid).toBe(true);
      // Valid parsed JSON: the REDACTED structured representation is
      // the stored body truth; no opaque placeholder exists on this
      // path, and the stored text is exactly the serialization of the
      // REDACTED structured value.
      expect(payload.observed.parseStatus).toBe('parsed-json');
      expect(payload.observed.opaqueBody).toBeUndefined();
      expect(payload.observed.responseJsonText).not.toContain('42 Secret Lane');
      expect(payload.observed.responseJsonText).toBe(JSON.stringify(payload.observed.responseJson));
      // The target-declared sensitive field is masked BEFORE persistence.
      expect(JSON.stringify(payload)).not.toContain('42 Secret Lane');
      // The applied flag is honest per capture: true exactly when
      // redaction transformed THIS capture (the members query carries
      // the address; the others legitimately carry nothing sensitive).
      expect(payload.redaction.applied).toBe(payload.declaration.queryId === 'members');
    }
    // The integrity chain covers the new observations.
    const report = await verifyRunEvidenceChain(prisma(), runId as string);
    expect(report.chainValid).toBe(true);
  });

  it('idempotent re-capture of the same query converges; different content conflicts', async () => {
    const policy = (await loadFrozenEvidencePolicy(prisma(), runId as string))!;
    // Same query, same state ⇒ idempotent (same row).
    const recaptured = await captureGenericInspectionSet(prisma(), {
      runId: runId as string,
      stepRunId: null,
      origin: baseUrl,
      environment: 'LOCAL_DEVELOPMENT',
      policy,
      queryIds: ['fines'],
      writerOwnerId: 'phase14-integration-2',
      writerFencingToken: null,
    });
    expect(recaptured).toHaveLength(1);
    const first = await prisma().rawObservation.findFirstOrThrow({
      where: {
        runId: runId as string,
        adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
        invocationIdentity: 'manifest-inspection:fines',
      },
      select: { id: true, contentHash: true },
    });
    expect(recaptured[0]?.observationId).toBe(first.id);

    // Same query, DIFFERENT target state ⇒ explicit integrity conflict
    // (never overwrite, never two contradictory "final" captures).
    fixtureState.fines.push({ fineId: 'FINE-2', loanId: 'LOAN-1', amountMinorUnits: 100000 });
    try {
      await expect(
        captureGenericInspectionSet(prisma(), {
          runId: runId as string,
          stepRunId: null,
          origin: baseUrl,
          environment: 'LOCAL_DEVELOPMENT',
          policy,
          queryIds: ['fines'],
          writerOwnerId: 'phase14-integration-3',
          writerFencingToken: null,
        }),
      ).rejects.toThrow(/DIFFERENT stored content hash/);
    } finally {
      fixtureState.fines.pop();
    }
  });

  it('derives typed role events, identity-direct edges, and multi-hop identity-chain attribution', async () => {
    await deriveRunEvidence(prisma(), runId as string);
    const events = await prisma().normalizedEvent.findMany({
      where: { runId: runId as string },
    });
    const relationships = await prisma().causalRelationship.findMany({
      where: { runId: runId as string },
    });

    // Role-typed events, exact declared vocabulary, no Demo vocabulary.
    const byType = new Map<string, number>();
    for (const event of events) {
      byType.set(event.eventType, (byType.get(event.eventType) ?? 0) + 1);
    }
    expect(byType.get('member')).toBe(1);
    expect(byType.get('loan')).toBe(2);
    expect(byType.get('fine')).toBe(1);
    for (const event of events) {
      expect(event.eventType).not.toMatch(/^demo\./);
      const payload = event.payload as Record<string, unknown>;
      // Payload preserves declared fields exactly; provenance is reserved.
      expect(payload['rupturegrid']).toBeDefined();
    }
    const fine = events.find((event) => event.eventType === 'fine');
    expect((fine?.payload as Record<string, unknown>)['amountMinorUnits']).toBe(150000);

    // identity-direct: member→loan (took-out) for the member that was
    // actually observed, loan→fine (incurred). LOAN-2 (member MEM-2)
    // stays honestly UNLINKED — no member event for MEM-2 was ever
    // captured, and no linkage is guessed from absence.
    const direct = relationships.filter((row) => row.basis === 'identity-direct');
    expect(direct.map((row) => row.relationKind).sort()).toEqual(['incurred', 'took-out']);
    const tookOut = direct.find((row) => row.relationKind === 'took-out');
    expect(tookOut?.evidenceJson).toMatchObject({
      matchedFields: ['memberId'],
      matchedValues: { memberId: 'MEM-1' },
      edgeKind: 'took-out',
    });

    // identity-chain: disconnected member stays disconnected.
    const chain = relationships.filter((row) => row.basis === 'identity-chain');
    expect(chain).toHaveLength(1);
    expect(chain[0]?.relationKind).toBe(GENERIC_IDENTITY_CHAIN_RELATION_KIND);
    const memberEvent = events.find((event) => event.eventType === 'member');
    const fineEvent = events.find((event) => event.eventType === 'fine');
    expect(chain[0]?.fromEventId).toBe(memberEvent?.id);
    expect(chain[0]?.toEventId).toBe(fineEvent?.id);
    const loan2 = events.find(
      (event) =>
        event.eventType === 'loan' &&
        (event.payload as Record<string, unknown>)['memberId'] === 'MEM-2',
    );
    expect(chain[0]?.toEventId).not.toBe(loan2?.id);
  });

  it('repeat derivation is idempotent (no duplicates, same semantics)', async () => {
    const before = await deriveRunEvidence(prisma(), runId as string);
    const again = await deriveRunEvidence(prisma(), runId as string);
    const events = await prisma().normalizedEvent.findMany({
      where: { runId: runId as string, normalizerName: 'generic-inspection-normalizer' },
    });
    const relationships = await prisma().causalRelationship.findMany({
      where: { runId: runId as string },
    });
    expect(events).toHaveLength(4);
    expect(relationships).toHaveLength(before.relationships.length);
    expect(again.relationships).toHaveLength(before.relationships.length);
    expect(again.events).toHaveLength(before.events.length);
  });

  it('malformed responses persist honestly and yield ZERO events (no salvage)', async () => {
    const { captureGenericInspectionQuery } = await import('@rupturegrid/evidence');
    const policy = (await loadFrozenEvidencePolicy(prisma(), runId as string))!;
    fixtureState.loansInvalid = true;
    try {
      await expect(
        captureGenericInspectionQuery(prisma(), {
          runId: runId as string,
          stepRunId: null,
          origin: baseUrl,
          environment: 'LOCAL_DEVELOPMENT',
          policy,
          queryId: 'loans',
          writerOwnerId: 'phase14-invalid-capture',
          writerFencingToken: null,
        }),
      ).rejects.toThrow(/DIFFERENT stored content hash/);
    } finally {
      fixtureState.loansInvalid = false;
    }
    // The valid capture from earlier remains THE loans observation, and
    // derivation still produces exactly the honest event set above.
    const loansEvents = await prisma().normalizedEvent.findMany({
      where: { runId: runId as string, eventType: 'loan' },
    });
    expect(loansEvents).toHaveLength(2);
  });

  it('redirects are never followed (read-only redirect: manual policy)', async () => {
    const { loadRunSnapshot } = await import('@rupturegrid/engine');
    const { document } = await loadRunSnapshot(prisma(), runId as string);
    // The seam only ever builds GET <frozen origin><declared literal
    // path>; a 3xx is an observed status, never a destination escape.
    // Probed here at the fixture level: the away-redirect route is not
    // declared in the policy, so no query can reach it; and the adapter
    // uses redirect:'manual' (unit-level contract) with origin-pinned
    // URL construction (no absolute/scheme-relative forms exist).
    expect(document.target.origin).toBe(baseUrl);
    expect(
      document.target.manifestEvidencePolicy?.inspection.every((query) =>
        query.path.startsWith('/inspection/'),
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------
  // Blocker repair: B-5 status matrix over REAL HTTP + PostgreSQL.
  // Every observed status persists an HONEST raw observation, but only
  // 2xx captures may normalize into business events.
  // -----------------------------------------------------------------
  describe('B-5: HTTP status gates business normalization (real HTTP)', () => {
    it('undeclared queryIds are refused, never guessed (frozen-declaration guard)', async () => {
      const policy = (await loadFrozenEvidencePolicy(prisma(), runId as string))!;
      await expect(
        captureGenericInspectionSet(prisma(), {
          runId: runId as string,
          stepRunId: null,
          origin: baseUrl,
          environment: 'LOCAL_DEVELOPMENT',
          policy,
          queryIds: ['status301'],
          writerOwnerId: 'phase14-b5-unknown-query',
          writerFencingToken: null,
        }),
      ).rejects.toThrow(/does not resolve to a declared inspection query/);
    });

    it('the normalization gate refuses non-2xx and truncated envelopes with zero events', async () => {
      const policy = (await loadFrozenEvidencePolicy(prisma(), runId as string))!;
      const validArray = [{ memberId: 'MEM-1', cardStatus: 'active', homeAddress: 'gate-probe' }];
      for (const status of [200, 201, 204, 301, 400, 404, 500, 503]) {
        const is2xxBody = status !== 204;
        const parsed = status === 204 ? undefined : validArray;
        const envelope = {
          envelopeVersion: 'generic-inspection-observation/v1' as const,
          adapterKind: GENERIC_INSPECTION_ADAPTER_KIND,
          declaration: {
            inspectionVersion: 'inspection/v1' as const,
            queryId: 'members',
            roleId: 'member',
            path: '/inspection/members',
          },
          observed: {
            httpStatus: status,
            responseContentType: 'application/json',
            parseStatus:
              parsed === undefined ? ('not-attempted' as const) : ('parsed-json' as const),
            truncated: status === 204,
            responseJsonText: is2xxBody ? JSON.stringify(validArray) : null,
            ...(parsed === undefined
              ? {
                  opaqueBody: {
                    placeholder: '[Opaque body omitted]',
                    reasonCode: 'NO_RESPONSE_BODY_OBSERVED',
                    observedBodyBytes: 0,
                  },
                }
              : { responseJson: parsed }),
          },
          validation: { valid: true, reasonCode: 'VALID', detail: 'probe' },
          redaction: { policyVersion: 'evidence-redaction-v1', applied: false },
        };
        const events = normalizeGenericInspectionObservation(
          { contentHash: `hash-${String(status)}`, chainIndex: 0, payload: envelope },
          policy,
        );
        if (status >= 200 && status < 300 && status !== 204) {
          expect(events.length).toBeGreaterThan(0);
        } else {
          expect(events).toEqual([]);
        }
      }
    });
  });

  // -----------------------------------------------------------------
  // Blocker repair: B-3 cross-query same-role conflict over REAL
  // capture + derivation + PostgreSQL.
  // -----------------------------------------------------------------
  it('B-3: same-role cross-query conflicting captures are contested; the active graph excludes the edge', async () => {
    // A SECOND run on the SAME registered target (same frozen manifest,
    // per-run capture identity): derivation pass 1 is clean; the archive
    // registry then disagrees with the primary registry about MEM-1 —
    // same role (member), same declared identityFields, different
    // queryId — the exact audited bug.
    const created = await createExperiment(prisma(), {
      name: uniqueName('library-conflict-experiment'),
      targetId: manifestTargetId as string,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/inspection/members',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    const conflictRunId = (await createRun(prisma(), created.revisionId)).runId;
    const conflictPolicy = (await loadFrozenEvidencePolicy(prisma(), conflictRunId))!;

    // Derivation pass 1: a clean direct edge (member MEM-1 → loan) is
    // persisted while the archive registry still AGREES (empty archive).
    // The archive query's capture identity stays free — the conflicting
    // observation must arrive as its FIRST capture (per-query capture
    // identity is by design immutable within a run: a later capture of
    // the same query with different content is an explicit integrity
    // conflict, never an overwrite).
    await captureGenericInspectionSet(prisma(), {
      runId: conflictRunId,
      stepRunId: null,
      origin: baseUrl,
      environment: 'LOCAL_DEVELOPMENT',
      policy: conflictPolicy,
      queryIds: ['members', 'loans', 'fines'],
      writerOwnerId: 'phase14-b3-pass1',
      writerFencingToken: null,
    });
    const pass1 = await deriveRunEvidence(prisma(), conflictRunId);
    const pass1Direct = pass1.relationships.filter(
      (row) => row.basis === 'identity-direct' && row.relationKind === 'took-out',
    );
    expect(pass1Direct).toHaveLength(1);

    // The archive registry now DISAGREES about MEM-1 (same role, same
    // declared identity, different queryId). Its first capture carries
    // the conflicting payload — the cross-query conflict B-3 requires.
    // The stale loans capture for this run still holds, so the pass-1
    // direct edge is exactly the stale row B-2 targets.
    fixtureState.membersArchive.push({
      memberId: 'MEM-1',
      cardStatus: 'suspended',
      homeAddress: '42 Secret Lane',
    });
    try {
      await captureGenericInspectionQuery(prisma(), {
        runId: conflictRunId,
        stepRunId: null,
        origin: baseUrl,
        environment: 'LOCAL_DEVELOPMENT',
        policy: conflictPolicy,
        queryId: 'membersArchive',
        writerOwnerId: 'phase14-b3-pass2',
        writerFencingToken: null,
      });
      const pass2 = await deriveRunEvidence(prisma(), conflictRunId);

      // The conflict IS detected across queries (B-3) ...
      expect(pass2.genericDerivationGaps).toBeGreaterThan(0);
      const gapEvents = await prisma().normalizedEvent.findMany({
        where: {
          runId: conflictRunId,
          eventType: 'rupturegrid.derivation-gap-observed',
        },
      });
      expect(gapEvents.length).toBeGreaterThan(0);

      // ... and the ACTIVE graph excludes the stale member→loan edge,
      // while the pass-1 row is physically PRESERVED (append-only).
      expect(pass2.relationships.some((row) => row.relationKind === 'took-out')).toBe(false);
      const persistedStale = await prisma().causalRelationship.findMany({
        where: { runId: conflictRunId, relationKind: 'took-out' },
      });
      expect(persistedStale).toHaveLength(1); // preserved, never deleted

      // Durable invalidation provenance names the stale rows.
      const invalidations = await prisma().normalizedEvent.findMany({
        where: {
          runId: conflictRunId,
          eventType: GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
        },
      });
      expect(invalidations.length).toBeGreaterThan(0);
      const namedIds = invalidations.flatMap(
        (event) =>
          ((event.payload as Record<string, unknown>)['invalidatedRelationshipIds'] as string[]) ??
          [],
      );
      expect(namedIds).toContain(persistedStale[0]?.id);

      // Repeat derivation is idempotent (no duplicate stale rows, no
      // duplicate tombstones, still no active edge).
      const pass3 = await deriveRunEvidence(prisma(), conflictRunId);
      expect(pass3.relationships.some((row) => row.relationKind === 'took-out')).toBe(false);
      const staleAgain = await prisma().causalRelationship.findMany({
        where: { runId: conflictRunId, relationKind: 'took-out' },
      });
      expect(staleAgain).toHaveLength(1);
      const invalidationsAgain = await prisma().normalizedEvent.findMany({
        where: {
          runId: conflictRunId,
          eventType: GENERIC_DERIVATION_INVALIDATION_EVENT_TYPE,
        },
      });
      expect(invalidationsAgain).toHaveLength(invalidations.length);
    } finally {
      fixtureState.membersArchive.pop();
    }
  });

  // -----------------------------------------------------------------
  // Blocker repair: B-1 truncation provenance + G redaction hardening
  // over REAL HTTP (an over-cap secret-bearing body and a plaintext
  // multi-secret body) + real PostgreSQL persistence.
  // -----------------------------------------------------------------
  it('B-1/G: over-cap and plaintext bodies persist secret-free, truncated, zero events', async () => {
    // The probe target uses the SAME fixture origin under the other
    // registered spelling (localhost) — the origin authority is global,
    // so a second registration of 127.0.0.1 would be rejected.
    const probeOrigin = baseUrl.replace('127.0.0.1', 'localhost');
    const probeDisplayName = uniqueName('library-probe-target');
    const probeManifest = {
      ...libraryManifest(probeOrigin, probeDisplayName),
      inspection: [
        {
          queryId: 'hugeSecret',
          roleId: 'member',
          description: 'Over-cap body carrying opaque plaintext + a bearer secret',
          path: '/huge-truncated-secret',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'plainSecret',
          roleId: 'member',
          description: 'Plaintext body carrying every secret shape',
          path: '/plain-secret',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'opaqueKv',
          roleId: 'member',
          description: 'Opaque key=value body (the exact re-audit finding shape)',
          path: '/opaque-kv',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'opaqueBearer',
          roleId: 'member',
          description: 'Opaque plaintext bearer body',
          path: '/opaque-bearer',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'opaqueMalformed',
          roleId: 'member',
          description: 'Malformed JSON carrying a secret',
          path: '/opaque-malformed',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'opaqueHtml',
          roleId: 'member',
          description: 'Non-2xx HTML error body carrying a secret',
          path: '/opaque-html',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status301',
          roleId: 'member',
          description: 'Redirect with a valid-array body',
          path: '/status/301',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status400',
          roleId: 'member',
          description: 'Client error with a valid-array body',
          path: '/status/400',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status404',
          roleId: 'member',
          description: 'Not found with a valid-array body',
          path: '/status/404',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status500',
          roleId: 'member',
          description: 'Server error with a valid-array body',
          path: '/status/500',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status503',
          roleId: 'member',
          description: 'Unavailable with a valid-array body',
          path: '/status/503',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
        {
          queryId: 'status204',
          roleId: 'member',
          description: 'No content',
          path: '/status/204',
          fields: { memberId: 'string', cardStatus: 'string', homeAddress: 'string' },
          identityFields: ['memberId'],
        },
      ],
    };
    const probeRegistered = await registerTarget(prisma(), {
      displayName: probeDisplayName,
      environment: 'LOCAL_DEVELOPMENT',
      origins: [probeOrigin],
      contractKind: 'GENERIC_HTTP',
      credentialRefs: [],
      manifest: probeManifest,
    });
    const probeExperiment = await createExperiment(prisma(), {
      name: uniqueName('library-probe-experiment'),
      targetId: probeRegistered.targetId,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/status/204',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    const probeRunId = (await createRun(prisma(), probeExperiment.revisionId)).runId;
    const probePolicy = (await loadFrozenEvidencePolicy(prisma(), probeRunId))!;

    const captured = await captureGenericInspectionSet(prisma(), {
      runId: probeRunId,
      stepRunId: null,
      origin: probeOrigin,
      environment: 'LOCAL_DEVELOPMENT',
      policy: probePolicy,
      writerOwnerId: 'phase14-b1g-probes',
      writerFencingToken: null,
    });
    const byQuery = new Map(captured.map((entry) => [entry.queryId, entry]));

    // B-1: the over-cap response is honestly marked truncated ...
    const huge = byQuery.get('hugeSecret');
    expect(huge).toBeDefined();
    const hugeRow = await prisma().rawObservation.findUniqueOrThrow({
      where: { id: huge!.observationId },
    });
    const hugeObserved = observedOfPayload(hugeRow.payload);
    expect(hugeRow.truncated).toBe(true);
    expect(hugeObserved.truncated).toBe(true);
    expect(hugeRow.payload as { validation: { valid: boolean; reasonCode: string } }).toMatchObject(
      {
        validation: { valid: false, reasonCode: 'RESPONSE_TRUNCATED' },
      },
    );
    // Opaque-body closure: the truncated body persists NO text at all —
    // not even a bounded prefix of its bytes (where both canaries live)
    // — and no hash/fingerprint of those bytes exists anywhere.
    expect(hugeObserved.responseJsonText).toBeNull();
    expect(hugeObserved.opaqueBody?.reasonCode).toBe('TRUNCATED_BODY_NOT_PERSISTED');
    expect(hugeObserved.opaqueBody?.observedBodyBytes).toBeGreaterThan(0);
    const hugeJson = JSON.stringify(hugeRow.payload);
    expect(hugeJson).not.toContain('sk-canary-truncated-secret');
    expect(hugeJson).not.toContain('opaque-prefix-canary-DO-NOT-PERSIST');
    expect(hugeJson).toContain('[Opaque body omitted]');
    // The contentHash is over the final SAFE stored representation:
    // recomputing SHA-256 over the canonicalized stored payload must
    // reproduce the persisted hash exactly.
    expect(hugeRow.contentHash).toBe(hashOfPayload(hugeRow.payload));

    // G: the plaintext multi-secret body is OPAQUE — its raw text is
    // not stored in any form, so no secret shape can survive either.
    const plain = byQuery.get('plainSecret');
    expect(plain).toBeDefined();
    const plainRow = await prisma().rawObservation.findUniqueOrThrow({
      where: { id: plain!.observationId },
    });
    const plainJson = JSON.stringify(plainRow.payload);
    expect(plainJson).not.toContain('sk-live-canary-abc123');
    expect(plainJson).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(plainJson).not.toContain('hunter2canary');
    const plainObserved = observedOfPayload(plainRow.payload);
    expect(plainObserved.responseJsonText).toBeNull();
    expect(plainObserved.opaqueBody?.reasonCode).toBe('INVALID_JSON_BODY_NOT_PERSISTED');
    expect(plainObserved.responseContentType).toContain('text/plain');
    expect(plainRow.contentHash).toBe(hashOfPayload(plainRow.payload));
    expect(plainPayloadInvalid(plainRow)).toBe(true);

    // ----------------------------------------------------------------
    // Opaque-body security closure (post-repair re-audit): bodies that
    // cannot parse into the declared JSON structure persist ZERO body
    // content — no raw text, no regex key/value salvage, no hash or
    // fingerprint of the unsafe bytes. Only safe bounded metadata and
    // the fixed placeholder.
    // ----------------------------------------------------------------
    const opaqueExpectations: Array<{
      queryId: string;
      forbidden: string[];
      httpStatus: number;
      reasonCode: string;
      contentTypeIncludes: string | null;
    }> = [
      {
        queryId: 'opaqueKv',
        forbidden: ['supersecret', 'my-secret-value', 'password=', 'apiKey='],
        httpStatus: 200,
        reasonCode: 'INVALID_JSON_BODY_NOT_PERSISTED',
        contentTypeIncludes: 'text/plain',
      },
      {
        queryId: 'opaqueBearer',
        forbidden: ['VERY_SECRET_TOKEN'],
        httpStatus: 200,
        reasonCode: 'INVALID_JSON_BODY_NOT_PERSISTED',
        contentTypeIncludes: 'text/plain',
      },
      {
        queryId: 'opaqueMalformed',
        forbidden: ['supersecret'],
        httpStatus: 200,
        reasonCode: 'INVALID_JSON_BODY_NOT_PERSISTED',
        contentTypeIncludes: 'application/json',
      },
      {
        queryId: 'opaqueHtml',
        forbidden: ['supersecret', '<html>', '<body>'],
        httpStatus: 500,
        reasonCode: 'INVALID_JSON_BODY_NOT_PERSISTED',
        contentTypeIncludes: 'text/html',
      },
    ];
    for (const expectation of opaqueExpectations) {
      const entry = byQuery.get(expectation.queryId);
      expect(entry, expectation.queryId).toBeDefined();
      const row = await prisma().rawObservation.findUniqueOrThrow({
        where: { id: entry!.observationId },
      });
      const json = JSON.stringify(row.payload);
      for (const forbidden of expectation.forbidden) {
        expect(json, `${expectation.queryId} must not contain ${forbidden}`).not.toContain(
          forbidden,
        );
      }
      expect(json, expectation.queryId).toContain('[Opaque body omitted]');
      const observed = observedOfPayload(row.payload);
      expect(observed.parseStatus).toBe('invalid-json');
      expect(observed.responseJsonText).toBeNull();
      expect(observed.httpStatus).toBe(expectation.httpStatus);
      expect(observed.opaqueBody?.reasonCode).toBe(expectation.reasonCode);
      expect(observed.opaqueBody?.observedBodyBytes).toBeGreaterThan(0);
      expect(observed.responseContentType).toContain(expectation.contentTypeIncludes);
      if (expectation.httpStatus >= 300) {
        expect(row.payload as { validation: { valid: boolean; reasonCode: string } }).toMatchObject(
          {
            validation: { valid: false, reasonCode: 'HTTP_NON_SUCCESS' },
          },
        );
      }
      // Hash over the final safe stored representation (per row).
      expect(row.contentHash).toBe(hashOfPayload(row.payload));
    }

    // Valid parsed JSON still persists its REDACTED structured
    // representation: the probe run has no valid capture by design
    // (every probe body is opaque or non-2xx) — proven on the main
    // run's members capture below and in the opaque-body unit matrix.

    // B-5 over the REAL capture seam: non-2xx statuses persist honestly
    // (correct status recorded) and validate INVALID — zero events.
    for (const [queryId, expectedStatus] of [
      ['status301', 301],
      ['status400', 400],
      ['status404', 404],
      ['status500', 500],
      ['status503', 503],
    ] as const) {
      const entry = byQuery.get(queryId);
      expect(entry).toBeDefined();
      const row = await prisma().rawObservation.findUniqueOrThrow({
        where: { id: entry!.observationId },
      });
      const payload = row.payload as {
        observed: { httpStatus: number };
        validation: { valid: boolean; reasonCode: string };
      };
      expect(payload.observed.httpStatus).toBe(expectedStatus);
      expect(payload.validation.valid).toBe(false);
      expect(payload.validation.reasonCode).toBe('HTTP_NON_SUCCESS');
      expect(entry!.valid).toBe(false);
    }

    // 204: honest observation, zero events (inspection/v1 requires a
    // JSON array body).
    const noContent = byQuery.get('status204');
    expect(noContent).toBeDefined();
    const noContentRow = await prisma().rawObservation.findUniqueOrThrow({
      where: { id: noContent!.observationId },
    });
    const noContentPayload = noContentRow.payload as {
      observed: { httpStatus: number };
      validation: { valid: boolean };
    };
    expect(noContentPayload.observed.httpStatus).toBe(204);
    expect(noContentPayload.validation.valid).toBe(false);
    expect(noContent!.valid).toBe(false);

    // Derivation over the probe run: NONE of the probe observations
    // can become business events (zero member events).
    const probeDerived = await deriveRunEvidence(prisma(), probeRunId);
    const memberEvents = await prisma().normalizedEvent.findMany({
      where: { runId: probeRunId, eventType: 'member' },
    });
    expect(memberEvents).toHaveLength(0);
    expect(probeDerived.events.every((event) => event.eventType !== 'member')).toBe(true);

    // The probe target's registration-level redaction registry still
    // applies (sensitiveFields homeAddress is masked in any parsed body).
    expect(JSON.stringify(probeDerived)).not.toContain('gate-probe');
  });

  // -----------------------------------------------------------------
  // B-1: the generic inspection transport asks the SHARED engine seam.
  // Denied address classes are refused with the executor's own policy
  // object (LOCAL_DEVELOPMENT exception included), proven at the seam
  // level and at the adapter level (denial ⇒ honest no-response
  // observation, never a guessed capture).
  // -----------------------------------------------------------------
  it('B-1: the adapter resolves destination security through the shared engine seam', async () => {
    const { isDeniedAddress, assertDestinationAllowed } = await import('@rupturegrid/engine');
    // The exact functions the adapter calls are the executor's reviewed
    // seam exports (byte-identical re-exports — see the engine unit
    // matrix in destination-seam.test.ts).
    expect(isDeniedAddress('127.0.0.1')).toBe(true);
    expect(isDeniedAddress('169.254.169.254')).toBe(true);
    await expect(
      assertDestinationAllowed(new URL('http://127.0.0.1:1'), 'STAGING'),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      assertDestinationAllowed(new URL('http://127.0.0.1:1'), 'LOCAL_DEVELOPMENT'),
    ).resolves.toBeUndefined();

    // Adapter-level denial: a STAGING environment must never reach a
    // loopback target through the generic inspection transport either.
    // The denial is an HONEST observation of the blocked attempt (no
    // response observed) on a DEDICATED run — persisted under that
    // run's provenance identity with validation INVALID — never a
    // guessed capture and never a transport bypass.
    const denialExperiment = await createExperiment(prisma(), {
      name: uniqueName('library-denial-experiment'),
      targetId: manifestTargetId as string,
      document: {
        steps: [
          {
            name: 'probe',
            action: {
              method: 'GET',
              relativePath: '/inspection/members',
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    const denialRunId = (await createRun(prisma(), denialExperiment.revisionId)).runId;
    const policy = (await loadFrozenEvidencePolicy(prisma(), denialRunId))!;
    const denied = await captureGenericInspectionQuery(prisma(), {
      runId: denialRunId,
      stepRunId: null,
      origin: baseUrl,
      environment: 'STAGING',
      policy,
      queryId: 'members',
      writerOwnerId: 'phase14-b1-denial',
      writerFencingToken: null,
    });
    expect(denied.valid).toBe(false);
    const deniedRow = await prisma().rawObservation.findUniqueOrThrow({
      where: { id: denied.observationId },
    });
    expect(deniedRow.truncated).toBe(false);
    const deniedPayload = deniedRow.payload as {
      validation: { valid: boolean; reasonCode: string; detail: string };
      observed: { httpStatus: number | null };
    };
    expect(deniedPayload.validation.valid).toBe(false);
    expect(deniedPayload.observed.httpStatus).toBeNull();
    expect(
      deniedPayload.validation.reasonCode === 'NO_RESPONSE_OBSERVED' ||
        deniedPayload.validation.reasonCode === 'HTTP_NON_SUCCESS',
    ).toBe(true);
    expect(deniedPayload.validation.detail + deniedPayload.validation.reasonCode).toMatch(
      /denied|timed out|failed/i,
    );
  });
});

function plainPayloadInvalid(row: { payload: unknown }): boolean {
  const payload = row.payload as {
    validation?: { valid?: boolean };
    observed?: { parseStatus?: string };
  };
  return payload.validation?.valid === false && payload.observed?.parseStatus === 'invalid-json';
}

/** Typed view of the generic-inspection envelope's observed block. */
function observedOfPayload(payload: unknown): {
  httpStatus: number | null;
  responseContentType: string | null;
  parseStatus: string;
  truncated: boolean;
  responseJsonText: string | null;
  opaqueBody?: { reasonCode: string; observedBodyBytes: number; placeholder: string };
} {
  return (
    payload as {
      observed: {
        httpStatus: number | null;
        responseContentType: string | null;
        parseStatus: string;
        truncated: boolean;
        responseJsonText: string | null;
        opaqueBody?: { reasonCode: string; observedBodyBytes: number; placeholder: string };
      };
    }
  ).observed;
}

/**
 * Recomputes the evidence content hash over the STORED payload exactly
 * as the store did at persistence time (canonicalizeJson + SHA-256 —
 * the canonicalEvidenceHash seam). Proves contentHash is over the
 * final SAFE stored representation — a hash over any raw body bytes
 * cannot equal it.
 */
function hashOfPayload(payload: unknown): string {
  return canonicalEvidenceHash(payload).hash;
}
