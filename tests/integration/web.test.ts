// =====================================================================
// Integration — web application (real Next.js production server)
// =====================================================================
// Verifies the web shell builds and serves: the retired Phase 1
// foundation home page redirects to the runs list (the product entry
// point since Phase 6), the rendered product carries NO fake
// operational content (product-design §7, Phase 1 spec §42), and the
// liveness route answers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

const WEB_DIR = join('apps', 'web');
const WEB_TEST_PORT = Number(process.env.WEB_TEST_PORT ?? '3103');

interface RunningWeb {
  readonly baseUrl: string;
  readonly process: ChildProcess;
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function startWeb(): Promise<RunningWeb> {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_TEST_PORT)],
    {
      cwd: WEB_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${WEB_TEST_PORT}`;
  const up = await waitForHttp(baseUrl, 30_000);
  if (!up) {
    child.kill();
    throw new Error(`Web did not start. stderr:\n${stderr}`);
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

let web: RunningWeb | undefined;

beforeAll(async () => {
  web = await startWeb();
});

afterAll(async () => {
  await web?.close();
});

describe('web home route', () => {
  it('redirects the retired foundation page to the runs list', async () => {
    const response = await fetch(web!.baseUrl, { redirect: 'manual' });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/runs');
  });

  it('renders the product shell without fake operational data', async () => {
    const response = await fetch(`${web!.baseUrl}/runs`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('RuptureGrid');

    // No fake operational data (product-design §7, Phase 1 spec §42).
    expect(html).not.toMatch(/99\.9%/);
    expect(html).not.toMatch(/\b\d+\s+experiments\b/i);
    expect(html).not.toMatch(/\b\d+\s+incidents\b/i);
  });
});

describe('web liveness route', () => {
  it('answers the liveness contract', async () => {
    const response = await fetch(`${web!.baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('live');
    expect(body.service).toBe('rupturegrid-web');
  });
});
