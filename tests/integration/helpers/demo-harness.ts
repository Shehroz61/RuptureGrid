// =====================================================================
// Integration helpers — Demo Fintech black-box harness
// =====================================================================
// Spawns the REAL compiled demo-fintech process and drives it over
// REAL TCP HTTP only. No direct DB mutation to create scenarios (§105);
// scenario establishment happens exclusively through the target's own
// HTTP interfaces.
//
// The `deliverMany` helper measures REAL client-side in-flight overlap
// with an atomic counter (§76) — test evidence only, never product
// runtime telemetry.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestEnv } from './env.js';

const DEMO_DIST = join('apps', 'demo-fintech', 'dist', 'main.js');

export interface RunningDemo {
  readonly baseUrl: string;
  readonly env: TestEnv;
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
 * Starts the real demo-fintech process on an isolated port. The
 * process is terminated via SIGTERM with SIGKILL fallback so tests
 * never leak Node processes (§97).
 */
export async function startDemoProcess(env: TestEnv, port: number): Promise<RunningDemo> {
  const child = spawn(process.execPath, [DEMO_DIST], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEMO_DATABASE_URL: env.demoDatabaseUrl,
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_INSPECTION_TOKEN: env.demoInspectionToken,
      DEMO_PROVIDER_SIGNING_SECRET: env.demoProviderSigningSecret,
      DEMO_PORT: String(port),
      DEMO_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const live = await waitForHttp(`${baseUrl}/health/live`, 20_000);
  if (!live) {
    child.kill('SIGKILL');
    throw new Error(`Demo Fintech did not become live. stderr:\n${stderr}`);
  }

  return {
    baseUrl,
    env,
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

// ---------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------

export interface DemoClient {
  reset(): Promise<void>;
  setMode(mode: 'VULNERABLE' | 'SECURE'): Promise<void>;
  getMode(): Promise<string>;
  createCanonicalPayment(): Promise<SimulatedScenarioClient>;
  inspectionLineage(providerPaymentId: string): Promise<LineageClient>;
  walletReconciliation(walletId: string): Promise<WalletReconciliationClient>;
  deliverSigned(
    payload: unknown,
    deliveryAttemptId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  deliverRaw(
    rawBody: Buffer,
    deliveryAttemptId: string,
    signature: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface SimulatedScenarioClient {
  providerPaymentId: string;
  amountMinor: string;
  currency: string;
  walletId: string;
  events: Array<{
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    signature: string;
  }>;
}

export interface LineageClient {
  payment: { providerPaymentId: string; amountMinor: string; currency: string; status: string };
  events: Array<{ providerEventId: string; eventType: string; providerPaymentId: string }>;
  deliveries: Array<{ deliveryAttemptId: string; providerEventId: string; status: string }>;
  processingAttempts: Array<{
    processingAttemptId: string;
    deliveryAttemptId: string;
    outcome: string | null;
  }>;
  financialEffects: Array<{
    financialEffectId: string;
    providerPaymentId: string;
    processingAttemptId: string;
    walletId: string;
    amountMinor: string;
    currency: string;
    effectType: string;
  }>;
  ledgerEntries: Array<{
    financialEffectId: string;
    walletId: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string | null;
    entryType: string;
  }>;
  wallet: { walletId: string; balanceMinor: string; currency: string };
  counts: {
    events: number;
    deliveries: number;
    processingAttempts: number;
    financialEffects: number;
    ledgerEntries: number;
  };
  processingMode: string;
}

export interface WalletReconciliationClient {
  wallet: { walletId: string; balanceMinor: string; currency: string };
  ledgerCreditSumMinor: string;
  differenceMinor: string;
}

export function createDemoClient(demo: RunningDemo): DemoClient {
  const { baseUrl, env } = demo;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed as Record<string, unknown> };
  }

  return {
    async reset() {
      const { status, body } = await call(
        'POST',
        '/demo/admin/reset',
        undefined,
        env.demoAdminToken,
      );
      if (status !== 200) {
        throw new Error(`reset failed: ${status} ${JSON.stringify(body)}`);
      }
    },
    async setMode(mode) {
      const { status, body } = await call('PUT', '/demo/admin/mode', { mode }, env.demoAdminToken);
      if (status !== 200) {
        throw new Error(`setMode failed: ${status} ${JSON.stringify(body)}`);
      }
    },
    async getMode() {
      const { status, body } = await call(
        'GET',
        '/demo/admin/status',
        undefined,
        env.demoAdminToken,
      );
      if (status !== 200) {
        throw new Error(`getMode failed: ${status}`);
      }
      return String(body['mode']);
    },
    async createCanonicalPayment(): Promise<SimulatedScenarioClient> {
      const { status, body } = await call(
        'POST',
        '/demo/provider/payments',
        undefined,
        env.demoAdminToken,
      );
      if (status !== 201) {
        throw new Error(`createCanonicalPayment failed: ${status} ${JSON.stringify(body)}`);
      }
      return body as unknown as SimulatedScenarioClient;
    },
    async inspectionLineage(providerPaymentId) {
      const { status, body } = await call(
        'GET',
        `/inspection/provider-payments/${providerPaymentId}`,
        undefined,
        env.demoInspectionToken,
      );
      if (status !== 200) {
        throw new Error(`lineage failed: ${status} ${JSON.stringify(body)}`);
      }
      return body as unknown as LineageClient;
    },
    async walletReconciliation(walletId) {
      const { status, body } = await call(
        'GET',
        `/inspection/wallets/${walletId}/reconciliation`,
        undefined,
        env.demoInspectionToken,
      );
      if (status !== 200) {
        throw new Error(`reconciliation failed: ${status} ${JSON.stringify(body)}`);
      }
      return body as unknown as WalletReconciliationClient;
    },
    async deliverSigned(payload, deliveryAttemptId) {
      const raw = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = createHmac('sha256', env.demoProviderSigningSecret)
        .update(raw)
        .digest('hex');
      return deliverRawOn(demo, raw, deliveryAttemptId, signature);
    },
    async deliverRaw(rawBody, deliveryAttemptId, signature) {
      return deliverRawOn(demo, rawBody, deliveryAttemptId, signature);
    },
  };
}

/** Low-level signed delivery against a specific running demo. */
async function deliverRawOn(
  demo: RunningDemo,
  rawBody: Buffer,
  deliveryAttemptId: string,
  signature: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${demo.baseUrl}/webhooks/provider`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rupturegrid-delivery-attempt-id': deliveryAttemptId,
      'x-rupturegrid-provider-signature': signature,
    },
    body: new Uint8Array(rawBody),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------
// Real concurrent delivery with measured in-flight overlap
// ---------------------------------------------------------------------

export interface ConcurrentDeliveryResult {
  responses: Array<{ status: number; body: Record<string, unknown> }>;
  /** Maximum measured in-flight HTTP operations (test evidence, §76). */
  maxInFlight: number;
}

/**
 * Delivers `count` DIFFERENT physical deliveries (unique
 * deliveryAttemptIds) of the SAME event payload with a bounded
 * concurrency window, measuring the real maximum in-flight overlap
 * client-side. Uses no sleeps: tasks start immediately, bounded by the
 * semaphore; the barrier effect comes from the semaphore releasing all
 * `concurrency` tasks before any awaits the network round-trip.
 */
export async function deliverManyConcurrent(
  demo: RunningDemo,
  payload: unknown,
  options: { count: number; concurrency: number },
): Promise<ConcurrentDeliveryResult> {
  const signature = createHmac('sha256', demo.env.demoProviderSigningSecret)
    .update(Buffer.from(JSON.stringify(payload), 'utf8'))
    .digest('hex');
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');

  let inFlight = 0;
  let maxInFlight = 0;
  let nextIndex = 0;
  const responses: Array<{ status: number; body: Record<string, unknown> }> = new Array(
    options.count,
  );

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.count) {
        return;
      }
      inFlight += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      try {
        responses[index] = await deliverRawOn(demo, rawBody, `D-${randomUUID()}`, signature);
      } finally {
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  return { responses, maxInFlight };
}
