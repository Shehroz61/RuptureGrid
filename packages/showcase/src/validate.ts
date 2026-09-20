// =====================================================================
// RuptureGrid v1.0 — artifact validation (Phase 8)
// =====================================================================
// Generated artifacts are validated as REAL files, not by extension:
//   - PNGs: 8-byte signature + IHDR chunk parse (dimensions extracted
//     from the IHDR payload, big-endian) + non-zero size + min bytes;
//   - video: ffprobe (via ffprobe-static) against the actual stream —
//     container, dimensions, duration, codec — PLUS a full decode pass
//     with the bundled ffmpeg: a faststart MP4 carries its metadata at
//     the front, so a truncated file can still probe cleanly while half
//     its frames are missing. Only a stream that decodes end to end
//     with zero decode errors passes (§46/§47/§48/§49).
//
// Validation is a gate: a session whose required artifacts fail
// validation is a failed session.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CAPTURE_PLAN } from './capture-plan.js';
import type { ArtifactMetadata } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------
// PNG (§47)
// ---------------------------------------------------------------------

/** The exact 8-byte PNG signature every valid PNG must start with. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngValidation {
  readonly valid: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly detail: string;
}

/** Parses a PNG's IHDR to extract the real encoded dimensions. */
export function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  // Chunk layout: length (4 BE) + type "IHDR" (4) + data (13) + crc (4).
  const type = buffer.subarray(12, 16).toString('ascii');
  if (type !== 'IHDR') {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

/** Validates one artifact file as a real PNG of expected dimensions. */
export async function validatePng(options: {
  readonly filePath: string;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
}): Promise<PngValidation> {
  let buffer: Buffer;
  try {
    buffer = await readFile(options.filePath);
  } catch {
    return { valid: false, width: null, height: null, detail: 'file not readable' };
  }
  if (buffer.length === 0) {
    return { valid: false, width: null, height: null, detail: 'file is empty' };
  }
  const dims = parsePngDimensions(buffer);
  if (dims === null) {
    return {
      valid: false,
      width: null,
      height: null,
      detail: 'not a parsable PNG (signature/IHDR)',
    };
  }
  if (dims.width !== options.expectedWidth || dims.height !== options.expectedHeight) {
    return {
      valid: false,
      width: dims.width,
      height: dims.height,
      detail: `dimensions ${dims.width}x${dims.height} differ from expected ${options.expectedWidth}x${options.expectedHeight}`,
    };
  }
  return { valid: true, width: dims.width, height: dims.height, detail: 'valid PNG' };
}

// ---------------------------------------------------------------------
// Video (§48)
// ---------------------------------------------------------------------

export interface VideoValidation {
  readonly valid: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly codecName: string | null;
  readonly detail: string;
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
}

interface FfprobeOutput {
  readonly streams?: readonly FfprobeStream[];
  readonly format?: { readonly duration?: string };
}

/** Locates the bundled ffprobe binary (declared in ffprobe-static.d.ts). */
async function ffprobePath(): Promise<string> {
  const mod = (await import('ffprobe-static')) as unknown as {
    default?: { readonly path?: string };
  };
  const resolved = mod.default?.path;
  if (resolved === undefined || resolved === '') {
    throw new Error('ffprobe-static did not expose a binary path');
  }
  return resolved;
}

/** Locates the bundled ffmpeg binary (same package as the encoder). */
async function ffmpegPath(): Promise<string> {
  const mod = (await import('ffmpeg-static')) as unknown as {
    default?: string | null;
  };
  const resolved = mod.default;
  if (resolved === undefined || resolved === null || resolved === '') {
    throw new Error('ffmpeg-static did not expose a binary path');
  }
  return resolved;
}

/**
 * Decodes the ENTIRE stream with the bundled ffmpeg and requires zero
 * decode errors. Container metadata alone cannot prove a file is fully
 * intact: with `+faststart` the moov atom leads the file, so a truncated
 * MP4 probes with perfect codec/dimensions/duration while its tail
 * frames are gone. The decode pass is what makes "decodability" true.
 */
async function decodesWithoutErrors(filePath: string): Promise<boolean> {
  try {
    await execFileAsync(
      await ffmpegPath(),
      ['-v', 'error', '-xerror', '-i', filePath, '-f', 'null', '-'],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes a video file's actual stream/container properties and decodes
 * it end to end. A file that cannot be probed or does not decode fully
 * is invalid — extension is never trusted.
 */
export async function validateVideo(options: {
  readonly filePath: string;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
}): Promise<VideoValidation> {
  const probeBinary = await ffprobePath();
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    options.filePath,
  ];
  let stdout: string;
  try {
    const result = await execFileAsync(probeBinary, args, {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    return {
      valid: false,
      width: null,
      height: null,
      durationSeconds: null,
      codecName: null,
      detail: `ffprobe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return {
      valid: false,
      width: null,
      height: null,
      durationSeconds: null,
      codecName: null,
      detail: 'ffprobe output was not parsable JSON',
    };
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (videoStream === undefined) {
    return {
      valid: false,
      width: null,
      height: null,
      durationSeconds: null,
      codecName: null,
      detail: 'no video stream present',
    };
  }
  const durationSeconds =
    parsed.format?.duration !== undefined ? Number(parsed.format.duration) : null;
  const width = videoStream.width ?? null;
  const height = videoStream.height ?? null;
  if (width !== options.expectedWidth || height !== options.expectedHeight) {
    return {
      valid: false,
      width,
      height,
      durationSeconds,
      codecName: videoStream.codec_name ?? null,
      detail: `dimensions ${width}x${height} differ from expected ${options.expectedWidth}x${options.expectedHeight}`,
    };
  }
  if (durationSeconds === null || !(durationSeconds > 0)) {
    return {
      valid: false,
      width,
      height,
      durationSeconds,
      codecName: videoStream.codec_name ?? null,
      detail: 'duration missing or non-positive',
    };
  }
  if (!(await decodesWithoutErrors(options.filePath))) {
    return {
      valid: false,
      width,
      height,
      durationSeconds,
      codecName: videoStream.codec_name ?? null,
      detail: 'stream does not decode end to end (truncated or corrupt)',
    };
  }
  return {
    valid: true,
    width,
    height,
    durationSeconds,
    codecName: videoStream.codec_name ?? null,
    detail: 'valid video',
  };
}

// ---------------------------------------------------------------------
// Session-level validation (§46)
// ---------------------------------------------------------------------

export interface SessionValidation {
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/**
 * Validates the whole session: every required plan artifact exists as
 * a real, correctly-dimensioned PNG; metadata binds real files.
 */
export async function validateSessionArtifacts(options: {
  readonly outputDir: string;
  readonly artifacts: readonly ArtifactMetadata[];
}): Promise<SessionValidation> {
  const problems: string[] = [];
  for (const step of CAPTURE_PLAN) {
    const expectedName = `${step.artifact}.png`;
    const metadata = options.artifacts.find((artifact) => artifact.filename === expectedName);
    if (metadata === undefined) {
      problems.push(`required artifact missing from session: ${expectedName}`);
      continue;
    }
    const filePath = join(options.outputDir, expectedName);
    const png = await validatePng({
      filePath,
      expectedWidth: metadata.viewport.width,
      expectedHeight: metadata.viewport.height,
    });
    if (!png.valid) {
      problems.push(`${expectedName}: ${png.detail}`);
      continue;
    }
    const fileStat = await stat(filePath);
    if (fileStat.size !== metadata.bytes) {
      problems.push(
        `${expectedName}: metadata byte count ${metadata.bytes} != file size ${fileStat.size}`,
      );
    }
    // File identity (§31): the sidecar's SHA-256 must match the file
    // exactly — a swapped, stale, or edited PNG cannot pass validation.
    const fileBuffer = await readFile(filePath);
    const actualHash = createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash !== metadata.sha256) {
      problems.push(`${expectedName}: sha256 mismatch — file does not match its sidecar digest`);
    }
  }
  return { pass: problems.length === 0, problems };
}
