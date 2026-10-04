// =====================================================================
// Unit — Phase 16 B-1 repair: ordinary `${credential.<REF>}` header
// tokens are bounded by the target's FROZEN credential reference set
// =====================================================================
// The independent Phase 16 adversarial audit reproduced blocker B-1: an
// ordinary `${credential.<REF>}` token in an HTTP header could name a
// globally resolvable reference that the target never declared, so the
// Provider signing secret could be transmitted to the Commerce origin.
// This file is the committed regression for the exact attack (ADR-0024
// §13, matrix case 31) and is permanent.
//
// Every claim below runs against REAL code: definition-time validation
// (validate.ts) and the REAL executor transport over REAL TCP HTTP
// (R-08 — no mocked transport). Reference NAMES may appear in issues;
// secret VALUES never do (R-13 / ADR-0012).

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXECUTOR_CREDENTIAL_REFS } from '@rupturegrid/config';
import { executeHttp, substituteCredentials } from './executor.js';
import type { ExecuteInput } from './executor.js';
import { validateExperimentDocument } from './validate.js';
import { ExperimentValidationError } from './types.js';
import { credentialTokenRefs } from './credential-token.js';

const COMMERCE_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const PROVIDER_REF = 'DEMO_PROVIDER_SIGNING_SECRET';
// Clearly synthetic, non-production harness values — never real secrets.
const COMMERCE_SECRET = 'commerce-signing-secret-for-tests-0001';
const PROVIDER_SECRET = 'provider-signing-secret-for-tests-0001';

/** The Commerce target's frozen declared credential set (the audit's shape). */
const COMMERCE_TARGET = {
  id: '11111111-1111-1111-1111-111111111111',
  displayName: 'demo-commerce',
  contractKind: 'GENERIC_HTTP' as const,
  environment: 'LOCAL_DEVELOPMENT' as const,
  credentialRefs: [COMMERCE_REF],
  origins: [{ origin: 'http://127.0.0.1:45001' }],
  manifestJson: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function documentWith(headerName: string, headerValue: string): unknown {
  return {
    steps: [
      {
        name: 'attack',
        action: {
          method: 'GET',
          relativePath: '/probe',
          headers: { [headerName]: headerValue },
          mutation: 'READ_ONLY',
          contract: 'GENERIC_HTTP',
        },
      },
    ],
  };
}

let server: Server;
let origin: string;
const received: Array<Record<string, string | string[] | undefined>> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function recordingResolver(): {
  resolve(ref: string): string;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    resolve(ref: string): string {
      calls.push(ref);
      if (ref === COMMERCE_REF) {
        return COMMERCE_SECRET;
      }
      if (ref === PROVIDER_REF) {
        return PROVIDER_SECRET;
      }
      throw new Error(`unexpected ref ${ref}`);
    },
  };
}

async function callWithHeader(input: {
  headerName: string;
  headerValue: string;
  allowedRefs: readonly string[];
  credentials: ExecuteInput['credentials'];
}) {
  return executeHttp({
    action: {
      method: 'GET',
      relativePath: '/probe',
      headers: { [input.headerName]: input.headerValue },
      mutation: 'READ_ONLY',
      contract: 'GENERIC_HTTP',
      timeoutMs: 5_000,
    },
    origin,
    contractKind: 'GENERIC_HTTP',
    environment: 'LOCAL_DEVELOPMENT',
    invocationIdentity: 'b1-regression',
    credentials: input.credentials,
    signatureHeader: null,
    allowedCredentialRefs: input.allowedRefs,
  });
}

// ---------------------------------------------------------------------
// The shared grammar recognizes exactly the executor's token form
// ---------------------------------------------------------------------

describe('the credential-token grammar is exact and shared (B-1 repair)', () => {
  it('extracts only `${credential.<REF>}` tokens with the allowlist name grammar', () => {
    expect(credentialTokenRefs(`Bearer \${credential.${COMMERCE_REF}}`)).toEqual([COMMERCE_REF]);
    expect(credentialTokenRefs('${credential.A}${credential.B}')).toEqual(['A', 'B']);
    expect(credentialTokenRefs('literal ${credential.lower-case}')).toEqual([]);
    expect(credentialTokenRefs('plain literal value')).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Definition-time enforcement (ADR-0024 §13, matrix case 31)
// ---------------------------------------------------------------------

describe('definition-time: a header token must be a declared target reference', () => {
  it('REJECTS authorization: Bearer ${credential.<globally-available-but-undeclared>} (B-1 attack)', () => {
    try {
      validateExperimentDocument({
        target: COMMERCE_TARGET,
        document: documentWith('authorization', `Bearer \${credential.${PROVIDER_REF}}`),
      });
      throw new Error('expected validation to reject the undeclared token');
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentValidationError);
      const issues = (error as ExperimentValidationError).issues.join('\n');
      // The NAME is reported; the secret VALUE is not.
      expect(issues).toContain(PROVIDER_REF);
      expect(issues).not.toContain(PROVIDER_SECRET);
      expect(issues).not.toContain(COMMERCE_SECRET);
    }
  });

  it('REJECTS idempotency-key: ${credential.<undeclared>} — the rule is header-independent', () => {
    expect(() =>
      validateExperimentDocument({
        target: COMMERCE_TARGET,
        document: documentWith('idempotency-key', `\${credential.${PROVIDER_REF}}`),
      }),
    ).toThrow(/is not declared on the target/);
  });

  it('REJECTS a header carrying one declared and one undeclared token (checks EVERY token)', () => {
    expect(() =>
      validateExperimentDocument({
        target: COMMERCE_TARGET,
        document: documentWith(
          'idempotency-key',
          `\${credential.${COMMERCE_REF}}\${credential.${PROVIDER_REF}}`,
        ),
      }),
    ).toThrow(/DEMO_PROVIDER_SIGNING_SECRET/);
  });

  it('ACCEPTS the target’s own declared reference (positive control)', () => {
    const validated = validateExperimentDocument({
      target: COMMERCE_TARGET,
      document: {
        steps: [
          {
            name: 'legit',
            action: {
              method: 'GET',
              relativePath: '/probe',
              headers: { authorization: `Bearer \${credential.${COMMERCE_REF}}` },
              mutation: 'READ_ONLY',
              contract: 'GENERIC_HTTP',
            },
          },
        ],
      },
    });
    expect(validated.steps[0]?.action.headers?.['authorization']).toBe(
      `Bearer \${credential.${COMMERCE_REF}}`,
    );
  });

  it('ACCEPTS a literal (non-token) idempotency-key value (existing behavior preserved)', () => {
    const validated = validateExperimentDocument({
      target: COMMERCE_TARGET,
      document: documentWith('idempotency-key', 'idem-literal-123'),
    });
    expect(validated.steps[0]?.action.headers?.['idempotency-key']).toBe('idem-literal-123');
  });
});

// ---------------------------------------------------------------------
// Pre-send runtime defense (ADR-0024 §13, matrix case 31)
// ---------------------------------------------------------------------

describe('runtime: pre-send defense uses the FROZEN target credential set', () => {
  it('global capability is NOT authorization: PROVIDER is globally resolvable but not target-authorized', () => {
    // Explicitly prove the resolver CAN resolve it — and still refuses.
    expect(EXECUTOR_CREDENTIAL_REFS).toContain(PROVIDER_REF);
    expect(COMMERCE_TARGET.credentialRefs).not.toContain(PROVIDER_REF);
  });

  it('authorization header: undeclared ref → REJECT before send; resolver NOT called; request NOT sent', async () => {
    const resolver = recordingResolver();
    const before = received.length;
    await expect(
      callWithHeader({
        headerName: 'authorization',
        headerValue: `Bearer \${credential.${PROVIDER_REF}}`,
        allowedRefs: [COMMERCE_REF],
        credentials: resolver,
      }),
    ).rejects.toThrow(/frozen credential set/);
    // No secret resolution, no wire traffic.
    expect(resolver.calls).toEqual([]);
    expect(received.length).toBe(before);
  });

  it('idempotency-key header: undeclared ref → REJECT before send; request NOT sent', async () => {
    const resolver = recordingResolver();
    const before = received.length;
    await expect(
      callWithHeader({
        headerName: 'idempotency-key',
        headerValue: `\${credential.${PROVIDER_REF}}`,
        allowedRefs: [COMMERCE_REF],
        credentials: resolver,
      }),
    ).rejects.toThrow(/DEMO_PROVIDER_SIGNING_SECRET/);
    expect(resolver.calls).toEqual([]);
    expect(received.length).toBe(before);
  });

  it('the rejection error never carries the secret VALUE', async () => {
    try {
      await callWithHeader({
        headerName: 'authorization',
        headerValue: `Bearer \${credential.${PROVIDER_REF}}`,
        allowedRefs: [COMMERCE_REF],
        credentials: recordingResolver(),
      });
      throw new Error('expected pre-send rejection');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(PROVIDER_REF); // the NAME may appear
      expect(message).not.toContain(PROVIDER_SECRET); // the VALUE never does
    }
  });

  it('declared reference in the frozen set still substitutes and sends (positive control)', async () => {
    const resolver = recordingResolver();
    const before = received.length;
    const outcome = await callWithHeader({
      headerName: 'authorization',
      headerValue: `Bearer \${credential.${COMMERCE_REF}}`,
      allowedRefs: [COMMERCE_REF],
      credentials: resolver,
    });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    expect(resolver.calls).toEqual([COMMERCE_REF]);
    expect(received.length).toBe(before + 1);
    expect(received[before]?.['authorization']).toBe(`Bearer ${COMMERCE_SECRET}`);
  });

  it('an absent allowed set fails closed (deny all) at the substitution seam', () => {
    const resolver = recordingResolver();
    expect(() => substituteCredentials(`Bearer \${credential.${PROVIDER_REF}}`, resolver)).toThrow(
      /frozen credential set/,
    );
    expect(resolver.calls).toEqual([]);
  });
});
