// =====================================================================
// Integration — API health/readiness against real dependencies
// =====================================================================
// Verifies real HTTP behavior of the built API process:
//   liveness  → 200 even when dependencies are down
//   readiness → 200 when Control PostgreSQL + Redis are reachable
//   readiness → 503 with an honest per-dependency report when a
//               dependency is unavailable (bounded polling, no fixed
//               sleeps).
// The API runs as a REAL process against the real Control PostgreSQL
// and real Redis. A dedicated port range is used so the developer's
// normal development ports are never disturbed (Phase 1 spec §32).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loadTestEnv } from './helpers/env.js';

const API_DIST = join('apps', 'api', 'dist', 'main.js');
// Dedicated test ports, deliberately outside the development range
// (3000-3002, 5433-5434, 6380). Configurable via env, like everything.
const API_TEST_PORT = Number(process.env.API_TEST_PORT ?? '3101');

interface RunningApi {
  readonly baseUrl: string;
  readonly process: ChildProcess;
  close(): Promise<void>;
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return { ok: response.ok, status: response.status };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return { ok: false, status: 0 };
}

async function startApi(options: {
  controlDatabaseUrl: string;
  redisUrl: string;
  port: number;
}): Promise<RunningApi> {
  const child = spawn(process.execPath, [API_DIST], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: options.controlDatabaseUrl,
      REDIS_URL: options.redisUrl,
      API_PORT: String(options.port),
      API_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const started = await waitForHttp(`${baseUrl}/health/live`, 20_000);
  if (!started.ok) {
    child.kill();
    throw new Error(`API did not become live. stderr:\n${stderr}`);
  }

  return {
    baseUrl,
    process: child,
    async close() {
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

let env: ReturnType<typeof loadTestEnv>;
let api: RunningApi | undefined;

beforeAll(async () => {
  env = loadTestEnv();
  api = await startApi({
    controlDatabaseUrl: env.controlDatabaseUrl,
    redisUrl: env.redisUrl,
    port: API_TEST_PORT,
  });
});

afterAll(async () => {
  await api?.close();
});

async function getReadyStatus(baseUrl: string): Promise<{
  status: number;
  body: { status: string; checks: Record<string, string> } | null;
}> {
  try {
    const response = await fetch(`${baseUrl}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

describe('API liveness', () => {
  it('responds 200 with the API service identity', async () => {
    const response = await fetch(`${api!.baseUrl}/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('live');
    expect(body.service).toBe('rupturegrid-api');
  });
});

describe('API readiness with healthy dependencies', () => {
  it('reports ready when Control PostgreSQL and Redis are reachable', async () => {
    const result = await getReadyStatus(api!.baseUrl);
    expect(result.status).toBe(200);
    expect(result.body?.status).toBe('ready');
    expect(result.body?.checks.controlPostgres).toBe('ok');
    expect(result.body?.checks.redis).toBe('ok');
  });

  it('never reports the Demo Fintech database (not owned by the API)', async () => {
    const result = await getReadyStatus(api!.baseUrl);
    expect(result.body?.checks).not.toHaveProperty('demoPostgres');
  });
});

describe('API readiness when a dependency is unavailable', () => {
  it('reports not_ready with honest per-dependency status when Redis stops', async () => {
    // Stop Redis for the bounded window of this test only; the compose
    // service is restored in this test's finally block.
    const { execSync } = await import('node:child_process');
    execSync('docker compose stop redis', { cwd: process.cwd(), stdio: 'pipe' });
    try {
      const deadline = Date.now() + 20_000;
      let observedNotReady = false;
      while (Date.now() < deadline) {
        const result = await getReadyStatus(api!.baseUrl);
        if (result.status === 503 && result.body?.checks.redis === 'unavailable') {
          observedNotReady = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(observedNotReady).toBe(true);
    } finally {
      execSync('docker compose start redis', { cwd: process.cwd(), stdio: 'pipe' });
    }

    // After Redis returns, readiness must recover — bounded poll.
    const deadline = Date.now() + 20_000;
    let recovered = false;
    while (Date.now() < deadline) {
      const result = await getReadyStatus(api!.baseUrl);
      if (result.status === 200 && result.body?.status === 'ready') {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(recovered).toBe(true);
  });
});

describe('API process cleanup', () => {
  it('terminates the API process (no orphans left behind)', async () => {
    await expect(api!.close()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // On Windows, a kill from another process is TerminateProcess: the
    // process reports a signal (or forced code) rather than running its
    // SIGTERM handler. The cleanup guarantee verified here is that the
    // process is genuinely gone. The API's in-handler graceful-shutdown
    // path (app.close → closeResources → controlDb.disconnect) is the
    // same code exercised by the worker lifecycle tests.
    const gone = api!.process.exitCode !== null || api!.process.signalCode !== null;
    expect(gone).toBe(true);
  });
});
