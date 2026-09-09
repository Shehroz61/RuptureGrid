// =====================================================================
// Integration — Demo Fintech health/readiness (real HTTP process)
// =====================================================================
// The Demo Fintech app runs as a REAL process against ITS OWN
// PostgreSQL. It must never require or report any RuptureGrid
// dependency (ADR-0002).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loadTestEnv } from './helpers/env.js';

const DEMO_DIST = join('apps', 'demo-fintech', 'dist', 'main.js');
const DEMO_TEST_PORT = Number(process.env.DEMO_TEST_PORT ?? '3102');

interface RunningDemo {
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

async function startDemo(options: { demoDatabaseUrl: string; port: number }): Promise<RunningDemo> {
  const child = spawn(process.execPath, [DEMO_DIST], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEMO_DATABASE_URL: options.demoDatabaseUrl,
      DEMO_PORT: String(options.port),
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

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const started = await waitForHttp(`${baseUrl}/health/live`, 20_000);
  if (!started.ok) {
    child.kill();
    throw new Error(`Demo Fintech did not become live. stderr:\n${stderr}`);
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
let demo: RunningDemo | undefined;

beforeAll(async () => {
  env = loadTestEnv();
  demo = await startDemo({ demoDatabaseUrl: env.demoDatabaseUrl, port: DEMO_TEST_PORT });
});

afterAll(async () => {
  await demo?.close();
});

describe('Demo Fintech liveness', () => {
  it('responds 200 with the demo service identity', async () => {
    const response = await fetch(`${demo!.baseUrl}/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('live');
    expect(body.service).toBe('demo-fintech');
  });
});

describe('Demo Fintech readiness', () => {
  it('reports ready when its own PostgreSQL is reachable', async () => {
    const response = await fetch(`${demo!.baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks.demoPostgres).toBe('ok');
  });

  it('reports only the dependencies the Demo app owns', async () => {
    const response = await fetch(`${demo!.baseUrl}/health/ready`);
    const body = (await response.json()) as { checks: Record<string, string> };
    expect(Object.keys(body.checks)).toEqual(['demoPostgres']);
  });
});
