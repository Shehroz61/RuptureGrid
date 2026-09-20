#!/usr/bin/env node
// =====================================================================
// RuptureGrid v1.0 — one-command showcase generator (Phase 8)
// =====================================================================
// `pnpm showcase:generate` → this CLI (§13). Options (§14):
//
//   --output <dir>     output directory (default .artifacts/showcase);
//                      created if missing, never deleted wholesale
//                      (§67 — only session-owned files are removed)
//   --video            render the walkthrough video from this
//                      session's screenshots (§34–§45)
//   --no-video         explicitly skip the video (default)
//   --screenshots-only alias of --no-video
//   --json             print the session manifest as JSON to stdout
//
// Exit codes (classified, §13.7/§52):
//   0  session generated + validated
//   1  capture/validation failure (artifact problem)
//   2  prerequisite failure (environment, verifier refused, service
//      identity, browser unavailable)
//   3  timeout

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runShowcaseSession } from './orchestrator.js';
import { VerifierFailureError } from './verifier.js';
import { CaptureError } from './browser.js';

const DEFAULT_OUTPUT_DIR = join('.artifacts', 'showcase');

interface ParsedArgs {
  readonly output: string;
  readonly withVideo: boolean;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | number {
  let output = DEFAULT_OUTPUT_DIR;
  let withVideo = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        process.stderr.write('--output requires a directory argument\n');
        return 2;
      }
      output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      const value = arg.slice('--output='.length);
      if (value === '') {
        process.stderr.write('--output requires a directory argument\n');
        return 2;
      }
      output = value;
      continue;
    }
    if (arg === '--video') {
      withVideo = true;
      continue;
    }
    if (arg === '--no-video' || arg === '--screenshots-only') {
      withVideo = false;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    process.stderr.write(
      `unknown argument: ${arg}\nusage: showcase-generate [--output <dir>] [--video] [--no-video] [--screenshots-only] [--json]\n`,
    );
    return 2;
  }
  return { output, withVideo, json };
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'number') {
    return parsed;
  }
  const startedAt = Date.now();
  try {
    await mkdir(parsed.output, { recursive: true });
    const result = await runShowcaseSession({
      outputDir: parsed.output,
      withVideo: parsed.withVideo,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.summary}\n`);
    }
    return result.manifest.validation.pass ? 0 : 1;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    let exitCode = 1;
    let label = 'SHOWCASE FAILURE';
    if (error instanceof VerifierFailureError) {
      exitCode = 2;
      label = 'GOLDEN VERIFIER REFUSED — NO ARTIFACTS PRODUCED';
    } else if (error instanceof CaptureError) {
      exitCode = 1;
      label = 'CAPTURE FAILURE';
    } else if (
      error instanceof Error &&
      /did not (finish|become ready|materialize) within/.test(error.message)
    ) {
      exitCode = 3;
      label = 'TIMEOUT';
    } else if (
      error instanceof Error &&
      /already in use|exited before becoming ready/.test(error.message)
    ) {
      exitCode = 2;
      label = 'SHOWCASE ENVIRONMENT';
    }
    process.stderr.write(
      `${label} (after ${elapsed}ms): ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return exitCode;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
