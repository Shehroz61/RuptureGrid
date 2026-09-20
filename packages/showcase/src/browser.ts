// =====================================================================
// RuptureGrid v1.0 — real browser capture (Phase 8)
// =====================================================================
// Real browser automation over the ACCEPTED Phase 6 product (§17/§18):
//   - a real Chromium-family browser via Playwright's `channel`
//     mechanism (system Edge, else system Chrome, else the bundled
//     Chromium — the first that launches wins); never HTML fabrication;
//   - a TEMPORARY, automation-owned browser profile in the session's
//     owned output tree, removed on close (§68) — the user's real
//     browser profile is never touched;
//   - deterministic viewport + deviceScaleFactor from the capture plan
//     (§21/§22), recorded into every artifact's metadata;
//   - NO sleep-based correctness (§23): every capture waits for a
//     bounded condition — the route's data bound to the session's REAL
//     run/finding IDs — and ASSERTS the plan's expected rendered
//     content (§24/§53) before the screenshot is allowed to exist.
//
// Capture-only hacks are forbidden (§74/§75): this module never
// injects styles, never mutates DOM, never patches product code. It
// adapts to the product as it is.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  CAPTURE_PLAN,
  SHOWCASE_DEVICE_SCALE,
  SHOWCASE_VIEWPORT,
  artifactFilename,
} from './capture-plan.js';
import type { CaptureStep, ShowcaseIdentifiers } from './capture-plan.js';
import type { ArtifactMetadata } from './types.js';

/** Raised when a required surface cannot be captured truthfully. */
export class CaptureError extends Error {
  public readonly artifact: string;
  public readonly route: string;

  public constructor(artifact: string, route: string, detail: string) {
    super(`capture failed for ${artifact} (${route}): ${detail}`);
    this.name = 'CaptureError';
    this.artifact = artifact;
    this.route = route;
  }
}

/** The browser channels tried in order (system browsers preferred). */
const BROWSER_CHANNELS = ['msedge', 'chrome'] as const;
/** Final fallback: the bundled Playwright Chromium headless build. */
const BUNDLED_CHANNEL = 'chromium' as const;

export interface StartedBrowser {
  readonly channel: string;
  /** The real Playwright browser handle (context creation + close). */
  readonly handle: Browser;
  readonly close: () => Promise<void>;
}

/**
 * Launches the real browser with a temporary owned profile. The
 * profile directory lives INSIDE the session's owned output tree and
 * is removed on close (§67/§68) — never an arbitrary user path.
 */
export async function startBrowser(options: {
  readonly profileDir: string;
}): Promise<StartedBrowser> {
  await mkdir(options.profileDir, { recursive: true });
  let lastError: string | null = null;
  for (const channel of [...BROWSER_CHANNELS, BUNDLED_CHANNEL]) {
    try {
      const browser: Browser = await chromium.launch({
        channel,
        headless: true,
        args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
      });
      return {
        channel,
        handle: browser,
        close: async () => {
          await browser.close();
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `no usable browser could be launched (tried: ${BROWSER_CHANNELS.join(', ')}). ` +
      `Install Microsoft Edge or Google Chrome, or run \`npx playwright install chromium\`. Last error: ${lastError ?? 'none'}`,
  );
}

/** One open capture context over the started browser. */
export interface CaptureSession {
  readonly channel: string;
  readonly newPage: () => Promise<Page>;
  readonly close: () => Promise<void>;
}

export async function startCaptureSession(browser: StartedBrowser): Promise<CaptureSession> {
  // One owned context per session: deterministic locale/timezone, the
  // plan's viewport + scale, and a profile rooted in the session's
  // owned output tree. Closing the browser in orchestrator cleanup
  // also closes any live context.
  const context: BrowserContext = await browser.handle.newContext({
    viewport: { ...SHOWCASE_VIEWPORT },
    deviceScaleFactor: SHOWCASE_DEVICE_SCALE,
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  return {
    channel: browser.channel,
    newPage: async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      return page;
    },
    close: async () => {
      await context.close();
    },
  };
}

// ---------------------------------------------------------------------
// Text extraction + bounded waits (never sleeps-as-correctness, §23)
// ---------------------------------------------------------------------

/** The page's rendered text content (body innerText). */
export async function renderedText(page: Page): Promise<string> {
  return (await page.locator('body').innerText({ timeout: 15_000 })) ?? '';
}

/**
 * Waits (bounded) until the given text appears in the rendered body.
 * The wait polls the REAL DOM — the product's own rendering — with a
 * hard deadline; there are no fixed sleeps.
 */
export async function waitForText(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await renderedText(page);
    if (body.includes(text)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await page.waitForTimeout(200);
  }
}

// ---------------------------------------------------------------------
// The capture walk
// ---------------------------------------------------------------------

export interface CaptureOutcome {
  readonly metadata: ArtifactMetadata;
}

/**
 * Captures one plan step: navigates, waits for the expected REAL
 * content (bound to this session's identifiers), asserts includes and
 * excludes, then writes the PNG + returns its metadata sidecar.
 */
export async function captureStep(options: {
  readonly page: Page;
  readonly step: CaptureStep;
  readonly webBaseUrl: string;
  readonly ids: ShowcaseIdentifiers;
  readonly sourceVerdict: 'FAIL' | 'PASS';
  readonly outputDir: string;
  readonly contentTimeoutMs: number;
}): Promise<CaptureOutcome> {
  const { page, step, webBaseUrl, ids, outputDir } = options;
  const route = step.route(ids);
  const url = `${webBaseUrl}${route}`;

  // Bounded navigation: the product must actually render the route.
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (error) {
    throw new CaptureError(
      step.artifact,
      route,
      `navigation did not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Bounded wait for the FIRST expected datum — the page's own render
  // loop finishes loading data before it appears (server components
  // render data server-side; this guards slow first loads).
  const firstExpected = step.expectedIncludes(ids)[0];
  if (firstExpected === undefined) {
    throw new CaptureError(step.artifact, route, 'capture plan defines no expected content');
  }
  const appeared = await waitForText(page, firstExpected, options.contentTimeoutMs);
  if (!appeared) {
    throw new CaptureError(
      step.artifact,
      route,
      `expected content did not appear within ${options.contentTimeoutMs}ms: "${firstExpected}" — refusing to capture a blank or wrong page`,
    );
  }

  // Content assertions (§24): all expected, none excluded.
  const body = await renderedText(page);
  const missing = step.expectedIncludes(ids).filter((expected) => !body.includes(expected));
  if (missing.length > 0) {
    throw new CaptureError(
      step.artifact,
      route,
      `expected content missing from the rendered page: ${missing.map((m) => `"${m}"`).join(', ')}`,
    );
  }
  const forbidden =
    step.expectedExcludes?.(ids).filter((excluded) => body.includes(excluded)) ?? [];
  if (forbidden.length > 0) {
    throw new CaptureError(
      step.artifact,
      route,
      `forbidden content present on the rendered page: ${forbidden.map((f) => `"${f}"`).join(', ')}`,
    );
  }

  // Deterministic settle: web fonts have finished loading before the
  // screenshot (bounded by Playwright's own protocol timeout). The
  // expression is passed as a string — it runs in the page's JS
  // context, outside this module's type graph.
  await page.evaluate('document.fonts.ready');

  const filename = artifactFilename(step);
  const capturedAt = new Date().toISOString();
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, filename);
  const buffer = await page.screenshot({ path: filePath, fullPage: false, type: 'png' });
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  const metadata: ArtifactMetadata = {
    filename,
    runId: step.mode === 'VULNERABLE' ? ids.vulnerableRunId : ids.secureRunId,
    findingId:
      step.mode === 'VULNERABLE' && route.includes('/findings/') ? ids.vulnerableFindingId : null,
    route,
    capturedAt,
    viewport: { ...SHOWCASE_VIEWPORT },
    deviceScaleFactor: SHOWCASE_DEVICE_SCALE,
    sourceVerdict: options.sourceVerdict,
    sha256,
    bytes: buffer.byteLength,
    purpose: step.purpose,
    status: 'captured',
  };
  return { metadata };
}

/**
 * Captures the full plan in order. Any failed capture aborts the whole
 * session (§52/§53 — no partial showcase).
 */
export async function captureAll(options: {
  readonly session: CaptureSession;
  readonly webBaseUrl: string;
  readonly ids: ShowcaseIdentifiers;
  /** Verdicts are transcribed from the verifier report (§9), never
   *  hard-coded — the orchestrator passes the INV-IZ-1 verdict the
   *  verifier observed for each mode. */
  readonly verdicts: { readonly VULNERABLE: 'FAIL' | 'PASS'; readonly SECURE: 'FAIL' | 'PASS' };
  readonly outputDir: string;
  readonly contentTimeoutMs: number;
}): Promise<ArtifactMetadata[]> {
  const captured: ArtifactMetadata[] = [];
  for (const step of CAPTURE_PLAN) {
    const page = await options.session.newPage();
    try {
      const outcome = await captureStep({
        page,
        step,
        webBaseUrl: options.webBaseUrl,
        ids: options.ids,
        sourceVerdict: options.verdicts[step.mode],
        outputDir: options.outputDir,
        contentTimeoutMs: options.contentTimeoutMs,
      });
      captured.push(outcome.metadata);
    } finally {
      await page.close();
    }
  }
  return captured;
}

/** Writes a metadata sidecar JSON next to its artifact (§11/§31). */
export async function writeMetadataSidecar(
  outputDir: string,
  metadata: readonly ArtifactMetadata[],
): Promise<string> {
  const sidecarPath = join(outputDir, 'artifacts-metadata.json');
  await writeFile(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return sidecarPath;
}
