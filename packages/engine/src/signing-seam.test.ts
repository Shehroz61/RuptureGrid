// =====================================================================
// Unit — Phase 16 ADR-0024 executor signing seam (real TCP HTTP)
// =====================================================================
// Acceptance test matrix items that only the EXECUTOR seam can prove,
// exercised against a real local HTTP server (R-08 — no mocked
// transport): items 10–13 (frozen ref; no reselection at execution;
// rotation; missing runtime secret is pre-send), 15–16 (exact FINAL
// body bytes; body-less `${signature}` fails closed), and 17 (the
// explicit Phase-13 historical compatibility fallback). The signing
// classification and grants are deliberately NOT consulted here — by
// contract they exist only at policy derivation (ADR-0024 §16);
// nothing in this file reads them.

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialResolutionError, ExecutorSecurityError, executeHttp } from './executor.js';
import type { ExecuteInput } from './executor.js';
import {
  LEGACY_SIGNATURE_HEADER,
  PHASE13_HISTORICAL_SIGNING_REF,
  effectiveSignatureHeader,
} from './manifest.js';

const PROVIDER_REF = 'DEMO_PROVIDER_SIGNING_SECRET';
const COMMERCE_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
const PROVIDER_SECRET = 'provider-signing-secret-for-tests-0001';
const COMMERCE_SECRET = 'commerce-signing-secret-for-tests-0001';
const ROTATED_COMMERCE_SECRET = 'commerce-signing-secret-rotated-0002';

interface RecordedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: Buffer;
}

let server: Server;
let origin: string;
const requests: RecordedRequest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, rawBody: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A recording credential resolver over an explicit runtime map. */
function recordingResolver(values: Readonly<Record<string, string>>): {
  resolve(ref: string): string;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    resolve(ref: string): string {
      calls.push(ref);
      const value = values[ref];
      if (value === undefined) {
        throw new CredentialResolutionError(ref);
      }
      return value;
    },
  };
}

function signedAction(body: string | undefined): ExecuteInput['action'] {
  return {
    method: 'POST',
    relativePath: '/signed',
    headers: { 'x-commerce-signature': '${signature}' },
    ...(body === undefined ? {} : { body }),
    mutation: 'MUTATING',
    contract: 'GENERIC_HTTP',
    timeoutMs: 5_000,
  };
}

async function callSigned(input: {
  body?: string;
  resolvedBody?: string;
  ref: string | null;
  credentials: ExecuteInput['credentials'];
}) {
  return executeHttp({
    action: signedAction(input.body),
    origin,
    contractKind: 'GENERIC_HTTP',
    environment: 'LOCAL_DEVELOPMENT',
    invocationIdentity: 'signing-seam-test-invocation',
    credentials: input.credentials,
    signatureHeader: 'x-commerce-signature',
    signatureCredentialRef: input.ref,
    ...(input.resolvedBody === undefined ? {} : { resolvedBody: input.resolvedBody }),
  });
}

function headerOf(request: RecordedRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

describe('ADR-0024 §10: the executor consumes ONLY the frozen signing ref (matrix cases 10–11)', () => {
  it('resolves exactly the frozen reference name and signs with its current value', async () => {
    const resolver = recordingResolver({
      [PROVIDER_REF]: PROVIDER_SECRET,
      [COMMERCE_REF]: COMMERCE_SECRET,
    });
    const body = '{"checkoutIntentId":"CHK-SEAM-1"}';
    const before = requests.length;
    const outcome = await callSigned({ body, ref: COMMERCE_REF, credentials: resolver });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    // The one and only resolution is the FROZEN ref: no live lookup, no
    // reselection among signing-capable refs, no ordering heuristic.
    expect(resolver.calls).toEqual([COMMERCE_REF]);
    const request = requests[before];
    expect(request).toBeDefined();
    expect(headerOf(request as RecordedRequest, 'x-commerce-signature')).toBe(
      createHmac('sha256', COMMERCE_SECRET).update(Buffer.from(body, 'utf8')).digest('hex'),
    );
  });

  it('a signing-classification change after freeze cannot reselect: the frozen ref still signs', async () => {
    // ADR-0024 §16: the platform signing SET is consulted only at policy
    // derivation. The executor has no access to it — the frozen input is
    // the whole authority. (Classification drift therefore cannot alter
    // a frozen run; it can only affect NEW derivations, tested in the
    // policy suite.)
    const resolver = recordingResolver({ [COMMERCE_REF]: COMMERCE_SECRET });
    const outcome = await callSigned({
      body: '{"checkoutIntentId":"CHK-SEAM-2"}',
      ref: COMMERCE_REF,
      credentials: resolver,
    });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    expect(resolver.calls).toEqual([COMMERCE_REF]);
  });

  it('rotating the secret VALUE behind the same frozen ref uses the current value (matrix case 12)', async () => {
    const resolver = recordingResolver({ [COMMERCE_REF]: ROTATED_COMMERCE_SECRET });
    const body = '{"checkoutIntentId":"CHK-SEAM-3"}';
    const before = requests.length;
    const outcome = await callSigned({ body, ref: COMMERCE_REF, credentials: resolver });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    const signature = headerOf(requests[before] as RecordedRequest, 'x-commerce-signature');
    expect(signature).toBe(
      createHmac('sha256', ROTATED_COMMERCE_SECRET).update(Buffer.from(body, 'utf8')).digest('hex'),
    );
    expect(signature).not.toBe(
      createHmac('sha256', COMMERCE_SECRET).update(Buffer.from(body, 'utf8')).digest('hex'),
    );
  });
});

describe('ADR-0024 §10: missing runtime secret fails PRE-SEND (matrix case 13)', () => {
  it('an unresolvable frozen ref rejects before any request is transmitted', async () => {
    const resolver = recordingResolver({ [PROVIDER_REF]: PROVIDER_SECRET });
    const before = requests.length;
    await expect(
      callSigned({
        body: '{"checkoutIntentId":"CHK-SEAM-4"}',
        ref: COMMERCE_REF,
        credentials: resolver,
      }),
    ).rejects.toBeInstanceOf(CredentialResolutionError);
    // No fallback, no unsigned send, no environment scan: the request
    // never existed.
    expect(requests.length).toBe(before);
    expect(resolver.calls).toEqual([COMMERCE_REF]);
  });
});

describe('ADR-0024 §15/§17: the explicit historical compatibility path', () => {
  it('a frozen policy with header present and ref absent resolves the Phase-13 historical ref', async () => {
    // Structurally distinguished by the absence of the ref in the frozen
    // policy object — the exact shape accepted Phase 13–15 froze. The
    // only possible historical ref was the Demo provider signing ref.
    const resolver = recordingResolver({ [PROVIDER_REF]: PROVIDER_SECRET });
    const body = '{"checkoutIntentId":"CHK-SEAM-LEGACY"}';
    const before = requests.length;
    const outcome = await callSigned({ body, ref: null, credentials: resolver });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    expect(resolver.calls).toEqual([PHASE13_HISTORICAL_SIGNING_REF]);
    expect(headerOf(requests[before] as RecordedRequest, 'x-commerce-signature')).toBe(
      createHmac('sha256', PROVIDER_SECRET).update(Buffer.from(body, 'utf8')).digest('hex'),
    );
  });

  it('the legacy manifest-less path keeps its v1.0 signature header constant', () => {
    expect(effectiveSignatureHeader(undefined)).toBe(LEGACY_SIGNATURE_HEADER);
  });
});

describe('ADR-0024 §19: HMAC-SHA256 hex over the EXACT final body bytes (matrix case 15)', () => {
  it('signs the resolved final body (not a re-serialization) and the server can verify it', async () => {
    const resolver = recordingResolver({ [COMMERCE_REF]: COMMERCE_SECRET });
    // Deliberately non-canonical JSON: property order and whitespace are
    // preserved byte-for-byte — no canonicalization exists.
    const resolvedBody = '{ "checkoutIntentId" :\n "CHK-SEAM-5" ,  "z": 1 }';
    const before = requests.length;
    const outcome = await callSigned({
      body: '{"ignored":true}',
      resolvedBody,
      ref: COMMERCE_REF,
      credentials: resolver,
    });
    expect(outcome.intentOutcome).toBe('SUCCEEDED');
    const request = requests[before] as RecordedRequest;
    expect(request.rawBody.toString('utf8')).toBe(resolvedBody);
    const expected = createHmac('sha256', COMMERCE_SECRET)
      .update(Buffer.from(resolvedBody, 'utf8'))
      .digest('hex');
    expect(headerOf(request, 'x-commerce-signature')).toBe(expected);
  });

  it('a ${signature} header with NO body fails closed before send (matrix case 16)', async () => {
    const resolver = recordingResolver({ [COMMERCE_REF]: COMMERCE_SECRET });
    const before = requests.length;
    await expect(callSigned({ ref: COMMERCE_REF, credentials: resolver })).rejects.toBeInstanceOf(
      ExecutorSecurityError,
    );
    expect(requests.length).toBe(before);
    expect(resolver.calls).toEqual([]);
  });
});
