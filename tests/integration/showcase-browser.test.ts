// =====================================================================
// Integration — Phase 8 SHOWCASE (real browser over real golden data)
// =====================================================================
// The acceptance test for the showcase capture contract (§64): a REAL
// browser opens the REAL product UI over a REAL golden run produced by
// the REAL execution pipeline, and the captured artifact is verified
// as an actual PNG of the deterministic viewport. Nothing is mocked —
// the same requirements as the Phase 7 golden suite (real demo, real
// worker, real evidence) plus the real browser layer.
//
// This is a small session (one artifact, the vulnerable overview) so
// the suite stays fast; the FULL 10-artifact plan + video is exercised
// by the live showcase runs (§95/§96), which run the same committed
// code path. Process model mirrors golden-incident-zero.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Minimal structural shape of the express middleware factories used to
// embed the real Control Plane API in-process. Typed locally so the test
// never needs express type packages to describe this seam.
type ExpressJsonMiddleware = (options?: {
  limit?: string;
  [key: string]: unknown;
}) => (request: unknown, response: unknown, next: () => void) => void;
type ExpressUrlencodedMiddleware = (options?: {
  extended?: boolean;
  limit?: string;
  [key: string]: unknown;
}) => (request: unknown, response: unknown, next: () => void) => void;
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { runGoldenScenario, ensureGoldenTargetRegistration } from '@rupturegrid/incident-zero';
import { chromium } from 'playwright';
import { loadTestEnv } from './helpers/env.js';
import { startDemoProcess, startPhase4Worker } from './helpers/golden-harness.js';
import type { RunningDemo } from './helpers/demo-harness.js';
import type { RunningWorker } from './helpers/phase4-harness.js';
import { uniqueName } from './helpers/execution-harness.js';
import { parsePngDimensions, PNG_SIGNATURE } from '../../packages/showcase/dist/validate.js';
import {
  SHOWCASE_DEVICE_SCALE,
  SHOWCASE_VIEWPORT,
} from '../../packages/showcase/dist/capture-plan.js';

const env = loadTestEnv();
// The golden experiment definitions (incident-zero-golden-*) are
// uniquely named and bound to the registered target that holds the
// verifier's demo origin. To reuse the SAME frozen definitions the
// verifier freezes (same snapshot content hash), this suite's demo
// MUST listen on the verifier's vulnerable-mode port (3127) so
// ensureGoldenTargetRegistration converges on that same target.
const DEMO_P8_PORT = Number(process.env.DEMO_P7_TEST_PORT ?? '3127');
const API_P8_PORT = Number(process.env.API_P8_TEST_PORT ?? '3143');
const WEB_P8_PORT = Number(process.env.WEB_P8_TEST_PORT ?? '3142');

let demo: RunningDemo;
let worker: RunningWorker | null = null;
let controlDb: ControlDb;
let outputDir = '';

beforeAll(async () => {
  controlDb = createControlDb(env.controlDatabaseUrl);
  demo = await startDemoProcess(env, DEMO_P8_PORT);
  outputDir = await mkdtemp(join(tmpdir(), 'rg8-it-'));
}, 60_000);

afterAll(async () => {
  if (worker !== null) {
    await worker.close();
  }
  await controlDb.disconnect();
  await demo.close();
  await rm(outputDir, { recursive: true, force: true });
});

async function ensureWorker(): Promise<void> {
  worker ??= await startPhase4Worker(env);
}

describe('Phase 8 — real browser capture over a real golden run', () => {
  it(
    'captures the vulnerable overview as a real PNG bound to the real run',
    { timeout: 300_000 },
    async () => {
      // --- 1. REAL golden execution (the same accepted pipeline) ----
      await ensureWorker();
      const registration = await ensureGoldenTargetRegistration(
        controlDb.prisma,
        demo.baseUrl,
        uniqueName('incident-zero-verify-vulnerable'),
      );
      const golden = await runGoldenScenario({
        prisma: controlDb.prisma,
        redisUrl: env.redisUrl,
        queuePrefix: env.queuePrefix,
        targetId: registration.targetId,
        mode: 'VULNERABLE',
      });
      expect(golden.runState).toBe('COMPLETED');
      expect(golden.evaluation?.verdict).toBe('FAIL');

      // --- 2. REAL API (embedded in-process, same as Phase 7) -------
      // Deep import through the api app's own dependency graph (pnpm's
      // virtual store is not visible from tests/). The module ships no
      // declaration file at that deep path; typed via the local
      // structural aliases above.
      // @ts-expect-error — express deep JS path has no declaration file.
      const expressModule = (await import('../../apps/api/node_modules/express/index.js')) as {
        json: ExpressJsonMiddleware;
        urlencoded: ExpressUrlencodedMiddleware;
      };
      const { NestFactory } = await import('../../apps/api/node_modules/@nestjs/core/index.js');
      const { buildAppModule } = await import('../../apps/api/src/app.module.js');
      const moduleRef = buildAppModule({
        config: {
          NODE_ENV: 'test' as const,
          LOG_LEVEL: 'error' as const,
          API_HOST: '127.0.0.1',
          API_PORT: API_P8_PORT,
          CONTROL_DATABASE_URL: env.controlDatabaseUrl,
          REDIS_URL: env.redisUrl,
          QUEUE_PREFIX: env.queuePrefix,
          CORS_ORIGINS: ['http://localhost:3000'],
        },
        controlDb,
      });
      const app = await NestFactory.create(moduleRef, { logger: false });
      app.use(expressModule.json({ limit: '256kb' }));
      app.use(expressModule.urlencoded({ extended: true, limit: '256kb' }));
      await app.listen(API_P8_PORT, '127.0.0.1');
      const apiOrigin = `http://127.0.0.1:${API_P8_PORT}`;

      // --- 3. REAL web production server (owned child) --------------
      const webTempDir = await mkdtemp(join(tmpdir(), 'rg8-web-'));
      const webChild = spawn(
        process.execPath,
        [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_P8_PORT)],
        {
          cwd: join('apps', 'web'),
          env: {
            ...process.env,
            RUPTUREGRID_API_ORIGIN: apiOrigin,
            TMPDIR: webTempDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const webOrigin = `http://127.0.0.1:${WEB_P8_PORT}`;
      try {
        let webStderr = '';
        webChild.stderr?.on('data', (chunk: Buffer) => {
          webStderr += chunk.toString();
        });
        const webDeadline = Date.now() + 30_000;
        for (;;) {
          try {
            const response = await fetch(webOrigin, {
              signal: AbortSignal.timeout(1_000),
              redirect: 'manual',
            });
            if (response.status < 500) {
              break;
            }
          } catch {
            // not up yet
          }
          if (Date.now() > webDeadline) {
            throw new Error(`web production server did not start: ${webStderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        // --- 4. REAL browser capture (the showcase contract) ------
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({
            viewport: { ...SHOWCASE_VIEWPORT },
            deviceScaleFactor: SHOWCASE_DEVICE_SCALE,
          });
          const page = await context.newPage();
          const route = `/runs/${golden.runId}`;
          await page.goto(`${webOrigin}${route}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          // The product's own FAIL verdict must be visible before any
          // screenshot exists (the capture-plan content gate, §24).
          const deadline = Date.now() + 30_000;
          let body = '';
          for (;;) {
            body = (await page.locator('body').innerText()) ?? '';
            if (body.includes('FAIL') && body.includes(golden.runId)) {
              break;
            }
            if (Date.now() > deadline) {
              throw new Error(`expected content did not appear for ${route}`);
            }
            await page.waitForTimeout(200);
          }
          const screenshotPath = join(outputDir, 'it-vulnerable-overview.png');
          const buffer = await page.screenshot({ path: screenshotPath, type: 'png' });

          // --- 5. The artifact is a REAL PNG of the real viewport --
          const fromDisk = await readFile(screenshotPath);
          expect(fromDisk.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
          expect(parsePngDimensions(fromDisk)).toEqual({
            width: SHOWCASE_VIEWPORT.width,
            height: SHOWCASE_VIEWPORT.height,
          });
          expect(buffer.byteLength).toBeGreaterThan(10_000);

          // The rendered page is the same one users see: redaction is
          // the product's own contract (ADR-0012) — assert no bearer
          // material leaked into what the camera sees.
          expect(body).not.toMatch(/Bearer\s/);
          await context.close();
        } finally {
          await browser.close();
        }
      } finally {
        if (webChild.exitCode === null && webChild.signalCode === null) {
          webChild.kill('SIGTERM');
        }
        await rm(webTempDir, { recursive: true, force: true });
      }
    },
  );
});
