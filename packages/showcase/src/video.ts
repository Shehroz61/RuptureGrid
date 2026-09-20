// =====================================================================
// RuptureGrid v1.0 — showcase video (Phase 8)
// =====================================================================
// A concise technical walkthrough (§34–§37) composed DETERMINISTICALLY
// from THIS session's real screenshots (§35): no fake browser footage,
// no invented frames, no chronology that reality does not support. The
// narrative order is the capture plan's own order (vulnerable story →
// secure story), which is the truth order of the session.
//
// Tooling: FFmpeg — but no global FFmpeg requirement is imposed on the
// repository. The bundled ffmpeg-static binary (a production dependency
// of the showcase CLI: the CLI itself performs the encoding at runtime)
// encodes an MP4 (H.264, yuv420p) at 1920×1080 (§43/§44). Every overlay
// is factual text derived from the session's verified report (§38) —
// rendered by the video generator from real assertion values, never
// hard-coded story numbers.
//
// The video is OPTIONAL (default OFF for the committed default path;
// `--video` enables it, `--no-video` keeps it off explicitly, §14).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CAPTURE_PLAN } from './capture-plan.js';
import type { ArtifactMetadata } from './types.js';
import type { ShowcaseModeStory } from './types.js';
import { VIDEO_FILENAME } from './output-safety.js';

const execFileAsync = promisify(execFile);

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
/** One second per slide — a 10-slide plan yields a ~10s technical walkthrough. */
export const SLIDE_SECONDS = 1;
/** Wide-playability H.264 in MP4 (§43). */
export const VIDEO_CODEC = 'h264';

export interface VideoResult {
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly codecName: string;
  readonly sourceFilenames: readonly string[];
  readonly generatedBy: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The factual overlay text for one slide, derived from session truth. */
export function slideOverlay(options: {
  readonly step: (typeof CAPTURE_PLAN)[number];
  vulnerable: ShowcaseModeStory;
  secure: ShowcaseModeStory;
  /** Canonical facts, from the accepted contract constants only. */
  facts: { readonly deliveries: number; readonly attempts: number; readonly invariant: string };
}): string {
  const mode = options.step.mode;
  const story = mode === 'VULNERABLE' ? options.vulnerable : options.secure;
  const lines: string[] = [];
  if (options.step.artifact === '00-runs-index') {
    // The delivery count comes from the accepted contract constant
    // handed in as a fact — never a hard-coded story number (§9/§38).
    lines.push(
      `Incident Zero — one payment, ${options.facts.deliveries} duplicate deliveries, two target modes`,
    );
  } else if (mode === 'VULNERABLE') {
    // The verdict is the session story's verifier-observed value (§45):
    // never a literal — the overlay may only state what the report said.
    lines.push(
      `VULNERABLE — execution ${story.runState}, INV-${options.facts.invariant} ${story.verdict}`,
    );
    if (options.step.artifact === '01-vulnerable-overview') {
      lines.push('Transport succeeded; business correctness failed.');
    }
    if (options.step.artifact === '02-vulnerable-finding') {
      lines.push('One confirmed payment, two accepted equivalent credits.');
    }
    if (options.step.artifact === '03-vulnerable-timeline') {
      lines.push(
        `${options.facts.deliveries} physical deliveries / ${options.facts.attempts} processing attempts.`,
      );
    }
  } else {
    // Verdict from the verifier-observed session story, as above (§45).
    lines.push(
      `SECURE — execution ${story.runState}, INV-${options.facts.invariant} ${story.verdict}`,
    );
    if (options.step.artifact === '06-secure-overview') {
      lines.push('Same pressure; one accepted business effect.');
    }
    if (options.step.artifact === '09-secure-reproduction') {
      lines.push('Transport success is not business correctness.');
    }
  }
  return lines.join(' ');
}

/** Locates the bundled ffmpeg binary. */
async function ffmpegPath(): Promise<string> {
  const mod = (await import('ffmpeg-static')) as unknown as { default: string | null };
  const resolved: string | null = mod.default;
  if (resolved === null || resolved === undefined || resolved === '') {
    throw new Error('ffmpeg-static did not expose a binary path');
  }
  return resolved;
}

/**
 * Renders one 1920×1080 slide PNG: the real screenshot letterboxed onto
 * the video canvas with its factual overlay. Pure composition of real
 * pixels + verified text — no content manipulation (§33).
 */
async function renderSlide(options: {
  readonly screenshotPath: string;
  readonly overlayText: string;
  readonly outputPath: string;
}): Promise<void> {
  // The slide is composed by ffmpeg itself (scale + pad + drawtext) so
  // no canvas dependency is introduced. The screenshot is the ONLY
  // image source; the overlay is the ONLY added content.
  const args = [
    '-y',
    '-i',
    options.screenshotPath,
    '-filter_complex',
    [
      `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=white`,
      `drawbox=x=0:y=ih-90:w=iw:h=90:color=black@0.85:t=fill`,
      `drawtext=text='${options.overlayText.replaceAll(String.fromCharCode(39), String.fromCharCode(8217))}':fontcolor=white:fontsize=30:x=(w-text_w)/2:y=h-64`,
    ].join(','),
    '-frames:v',
    '1',
    options.outputPath,
  ];
  await execFileAsync(await ffmpegPath(), args, { timeout: 60_000 });
}

/**
 * Encodes the slide sequence into one MP4 (H.264, yuv420p). Duration
 * is exactly slides × SLIDE_SECONDS.
 */
export async function generateVideo(options: {
  readonly outputDir: string;
  readonly artifacts: readonly ArtifactMetadata[];
  readonly vulnerable: ShowcaseModeStory;
  readonly secure: ShowcaseModeStory;
  readonly facts: {
    readonly deliveries: number;
    readonly attempts: number;
    readonly invariant: string;
  };
}): Promise<VideoResult | null> {
  const slidesDir = join(options.outputDir, 'video-slides');
  await mkdir(slidesDir, { recursive: true });
  const sources: string[] = [];
  try {
    let index = 0;
    for (const step of CAPTURE_PLAN) {
      const artifact = options.artifacts.find(
        (candidate) => candidate.filename === `${step.artifact}.png`,
      );
      if (artifact === undefined) {
        throw new Error(`video source missing: ${step.artifact}.png (capture plan violated)`);
      }
      const overlay = slideOverlay({
        step,
        vulnerable: options.vulnerable,
        secure: options.secure,
        facts: options.facts,
      });
      const slidePath = join(slidesDir, `slide-${String(index).padStart(2, '0')}.png`);
      await renderSlide({
        screenshotPath: join(options.outputDir, artifact.filename),
        overlayText: overlay,
        outputPath: slidePath,
      });
      sources.push(slidePath);
      index += 1;
    }

    // Concatenate: one input per slide, each held for SLIDE_SECONDS,
    // encoded H.264 yuv420p at the target resolution. The concat
    // demuxer ignores the FINAL duration directive and holds the last
    // image for only its intrinsic single-frame duration — which would
    // flash the closing thesis slide for a single frame. Appending the
    // final file one more time (without a duration directive) makes the
    // closing slide hold for the full SLIDE_SECONDS, so the probed
    // duration equals slides × SLIDE_SECONDS as the manifest claims.
    const outputPath = join(options.outputDir, VIDEO_FILENAME);
    const concatListPath = join(slidesDir, 'concat.txt');
    const lastSource = sources[sources.length - 1];
    if (lastSource === undefined) {
      throw new Error('video source list is empty — capture plan violated');
    }
    const concatLines = [
      ...sources.map(
        (source) => `file '${source.replaceAll('\\', '/')}'\nduration ${SLIDE_SECONDS}`,
      ),
      `file '${lastSource.replaceAll('\\', '/')}'`,
    ].join('\n');
    await writeFile(concatListPath, `${concatLines}\n`, 'utf8');
    const ffmpegArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-vf',
      `fps=10,format=yuv420p,scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
      outputPath,
    ];
    await execFileAsync(await ffmpegPath(), ffmpegArgs, { timeout: 120_000 });

    const fileStat = await stat(outputPath);
    const bytes = await readFile(outputPath);
    return {
      filename: VIDEO_FILENAME,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      durationSeconds: sources.length * SLIDE_SECONDS,
      codecName: VIDEO_CODEC,
      sourceFilenames: options.artifacts.map((artifact) => artifact.filename),
      generatedBy: "ffmpeg-static (libx264) composed from this session's captured screenshots",
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: fileStat.size,
    };
  } finally {
    if (existsSync(slidesDir)) {
      await rm(slidesDir, { recursive: true, force: true });
    }
  }
}
