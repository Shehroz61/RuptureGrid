// =====================================================================
// Integration helpers — Demo Commerce black-box harness (Phase 16)
// =====================================================================
// Spawns the REAL compiled demo-commerce process and drives it over
// REAL TCP HTTP only. Scenario establishment happens exclusively
// through the target's own admin API — never by direct DB mutation
// (R-05). Concurrency uses a real release gate: both submissions are
// prepared, released in the same tick, and the observed overlap is
// measured CLIENT-side here plus TARGET-side from persisted processing
// timestamps by the suites (testing-strategy §6, R-08).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestEnv } from './env.js';

const COMMERCE_DIST = join('apps', 'demo-commerce', 'dist', 'main.js');
const COMMERCE_MANIFEST_PATH = join('apps', 'demo-commerce', 'target-manifest.json');

/** Executor-owned physical request identity header (see commerce-db identifiers.ts). */
export const REQUEST_ATTEMPT_HEADER = 'x-rupturegrid-delivery-attempt-id';
export const CHECKOUT_SIGNATURE_HEADER = 'x-commerce-signature';

export interface RunningCommerce {
  readonly baseUrl: string;
  readonly env: TestEnv;
  /** Everything the real process wrote to stdout since start (JSON logs). */
  stdout(): string;
  /** Everything the real process wrote to stderr since start. */
  stderr(): string;
  close(): Promise<void>;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Starts the real demo-commerce process on an isolated port. The
 * process is terminated via SIGTERM with SIGKILL fallback so tests
 * never leak Node processes.
 */
export async function startCommerceProcess(env: TestEnv, port: number): Promise<RunningCommerce> {
  const child = spawn(process.execPath, [COMMERCE_DIST], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COMMERCE_DATABASE_URL: env.commerceDatabaseUrl,
      COMMERCE_ADMIN_TOKEN: env.commerceAdminToken,
      DEMO_COMMERCE_SIGNING_SECRET: env.commerceSigningSecret,
      COMMERCE_PORT: String(port),
      COMMERCE_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      // info: the real structured logger is exercised (ADR-0024 matrix
      // case 14 asserts the real process log stream carries no secret).
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const live = await waitForHttp(`${baseUrl}/health/live`, 20_000);
  if (!live) {
    child.kill('SIGKILL');
    throw new Error(`Demo Commerce did not become live. stderr:\n${stderr}`);
  }
  const ready = await waitForHttp(`${baseUrl}/health/ready`, 20_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Demo Commerce never became ready (Commerce PostgreSQL?). stderr:\n${stderr}`);
  }

  return {
    baseUrl,
    env,
    stdout: () => stdout,
    stderr: () => stderr,
    async close(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

/**
 * The committed Commerce target-manifest/v1 document with the live
 * test origin/display name substituted. The document is the real
 * artifact; only registration-specific fields are replaced.
 */
export function loadCommerceManifest(displayName: string, origin: string): Record<string, unknown> {
  const document = JSON.parse(readFileSync(COMMERCE_MANIFEST_PATH, 'utf8')) as Record<
    string,
    unknown
  >;
  return { ...document, displayName, origins: [origin] };
}

// ---------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------

export interface CommerceHttpResult {
  readonly status: number | null;
  readonly body: Record<string, unknown> | null;
  /** Raw response text (may be a truncated body under RESPONSE_TRUNCATION). */
  readonly text: string;
  /** Transport failure message for destroyed connections (crash faults). */
  readonly error: string | null;
}

export interface CheckoutPayloadInput {
  readonly checkoutIntentId: string;
  readonly customerId: string;
  readonly cartId: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly sku: string;
}

export interface ScenarioInitResult {
  readonly scopeToken: string;
  readonly generationId: number;
  readonly sku: string;
  readonly initialAvailableUnits: number;
  readonly mode: string;
}

export interface CommerceClient {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly signingSecret: string;
  resetScenario(input: {
    scopeToken: string;
    sku: string;
    initialAvailableUnits: number;
    mode: 'VULNERABLE' | 'SECURE';
  }): Promise<ScenarioInitResult>;
  setMode(mode: 'VULNERABLE' | 'SECURE'): Promise<string>;
  getMode(): Promise<string>;
  armFault(
    faultKind: string,
    input: { planVersion: string; activation: string; maxTriggers: number },
  ): Promise<Record<string, unknown>>;
  disarmFault(faultKind: string): Promise<void>;
  faultStatus(): Promise<{ plans: Array<Record<string, unknown>> }>;
  submitSigned(
    payload: CheckoutPayloadInput,
    requestAttemptId: string,
    secretOverride?: string,
  ): Promise<CommerceHttpResult>;
  submitRaw(
    rawBody: Buffer,
    requestAttemptId: string,
    signature: string,
  ): Promise<CommerceHttpResult>;
  submitManual(input: {
    rawBody: Buffer;
    requestAttemptId?: string;
    signature?: string;
  }): Promise<CommerceHttpResult>;
  submitConcurrent(
    payload: CheckoutPayloadInput,
    requestAttemptIds: readonly [string, string],
    secretOverride?: string,
  ): Promise<{ responses: [CommerceHttpResult, CommerceHttpResult]; maxInFlight: number }>;
  inspection<T = Record<string, unknown>>(path: string): Promise<T[]>;
  waitForQuiescence(
    scopeToken: string,
  ): Promise<{ inFlightProcessingAttempts: number; totalProcessingAttempts: number }>;
}

export function createCommerceClient(running: RunningCommerce): CommerceClient {
  const { baseUrl, env } = running;

  async function request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: Buffer | string },
  ): Promise<CommerceHttpResult> {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const text = await response.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = null;
      }
      return { status: response.status, body, text, error: null };
    } catch (error) {
      return {
        status: null,
        body: null,
        text: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const adminHeaders = { authorization: `Bearer ${env.commerceAdminToken}` };

  async function inspection<T = Record<string, unknown>>(path: string): Promise<T[]> {
    const response = await request(path, { method: 'GET' });
    if (response.status !== 200 || response.body === null || !Array.isArray(response.body)) {
      throw new Error(
        `commerce inspection ${path} failed: ${String(response.status)} ${response.text.slice(0, 120)}`,
      );
    }
    return response.body as T[];
  }

  async function submitRaw(
    rawBody: Buffer,
    requestAttemptId: string,
    signature: string,
  ): Promise<CommerceHttpResult> {
    return request('/checkout/submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [REQUEST_ATTEMPT_HEADER]: requestAttemptId,
        [CHECKOUT_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });
  }

  function sign(rawBody: Buffer, secret: string): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  async function submitSigned(
    payload: CheckoutPayloadInput,
    requestAttemptId: string,
    secretOverride?: string,
  ): Promise<CommerceHttpResult> {
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    return submitRaw(
      rawBody,
      requestAttemptId,
      sign(rawBody, secretOverride ?? env.commerceSigningSecret),
    );
  }

  return {
    baseUrl,
    adminToken: env.commerceAdminToken,
    signingSecret: env.commerceSigningSecret,

    async resetScenario(input): Promise<ScenarioInitResult> {
      const response = await request('/demo/admin/scenario', {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(
          `commerce scenario reset failed: ${String(response.status)} ${response.text.slice(0, 200)}`,
        );
      }
      return response.body as unknown as ScenarioInitResult;
    },

    async setMode(mode): Promise<string> {
      const response = await request('/demo/admin/mode', {
        method: 'PUT',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(`commerce mode switch failed: ${String(response.status)}`);
      }
      return String(response.body['mode']);
    },

    async getMode(): Promise<string> {
      const response = await request('/demo/admin/status', {
        method: 'GET',
        headers: adminHeaders,
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(`commerce status failed: ${String(response.status)}`);
      }
      return String(response.body['mode']);
    },

    async armFault(faultKind, input): Promise<Record<string, unknown>> {
      const response = await request(`/demo/admin/faults/${encodeURIComponent(faultKind)}`, {
        method: 'PUT',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(
          `commerce fault arming failed: ${String(response.status)} ${response.text.slice(0, 200)}`,
        );
      }
      return response.body;
    },

    async disarmFault(faultKind): Promise<void> {
      const response = await request(`/demo/admin/faults/${encodeURIComponent(faultKind)}`, {
        method: 'DELETE',
        headers: adminHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`commerce fault disarm failed: ${String(response.status)}`);
      }
    },

    async faultStatus(): Promise<{ plans: Array<Record<string, unknown>> }> {
      const response = await request('/demo/admin/faults', {
        method: 'GET',
        headers: adminHeaders,
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(`commerce fault status failed: ${String(response.status)}`);
      }
      return response.body as unknown as { plans: Array<Record<string, unknown>> };
    },

    submitSigned,
    submitRaw,

    async submitManual(input): Promise<CommerceHttpResult> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (input.requestAttemptId !== undefined) {
        headers[REQUEST_ATTEMPT_HEADER] = input.requestAttemptId;
      }
      if (input.signature !== undefined) {
        headers[CHECKOUT_SIGNATURE_HEADER] = input.signature;
      }
      return request('/checkout/submit', { method: 'POST', headers, body: input.rawBody });
    },

    /**
     * Two physical submissions released through a REAL test-side gate:
     * both tasks are prepared and await the same release promise, which
     * resolves when both have arrived — then both dispatches happen in
     * the same tick. Overlap is measured here client-side AND proven
     * from target-persisted timestamps by the suites; the gate is
     * scheduling, never a sleep.
     */
    async submitConcurrent(payload, requestAttemptIds, secretOverride) {
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = sign(rawBody, secretOverride ?? env.commerceSigningSecret);
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inFlight = 0;
      let maxInFlight = 0;

      async function attempt(requestAttemptId: string): Promise<CommerceHttpResult> {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await gate;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await submitRaw(rawBody, requestAttemptId, signature);
        } finally {
          inFlight -= 1;
        }
      }

      const [first, second] = await Promise.all([
        attempt(requestAttemptIds[0]),
        attempt(requestAttemptIds[1]),
      ]);
      return { responses: [first, second], maxInFlight };
    },

    inspection,

    async waitForQuiescence(scopeToken) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rows = await inspection<{
          inFlightProcessingAttempts: number;
          totalProcessingAttempts: number;
          verificationScopeId: string;
        }>('/inspection/quiescence');
        const row = rows.find((candidate) => candidate.verificationScopeId === scopeToken);
        if (row !== undefined && row.inFlightProcessingAttempts === 0) {
          return row;
        }
        if (Date.now() > deadline) {
          throw new Error(`commerce scope ${scopeToken} never became quiescent`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

/** Convenience constructor for the canonical payload of one intent. */
export function checkoutPayload(input: {
  checkoutIntentId: string;
  sku: string;
  totalMinor?: string;
}): CheckoutPayloadInput {
  return {
    checkoutIntentId: input.checkoutIntentId,
    customerId: 'CUST-001',
    cartId: 'CART-001',
    totalMinor: input.totalMinor ?? '500000',
    currency: 'PKR',
    sku: input.sku,
  };
}

/** A fresh, well-formed physical request identity for direct harness calls. */
export function freshRequestAttemptId(): string {
  return `RA-${randomUUID()}`;
}
