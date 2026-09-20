// =====================================================================
// RuptureGrid v1.0 — showcase output-path safety (Phase 8)
// =====================================================================
// The only filesystem surface where the showcase may create or remove
// files is the session's output directory (§66/§67). This module owns
// the two safety-critical primitives:
//
//   - `safeOutputDir` normalizes the user-supplied path and REFUSES a
//     target inside the repository unless it lives under the
//     designated generated-output root (`.artifacts/`) — so artifact
//     writes, the owned browser profile, and stale-output removal can
//     never touch repository sources, however the path is spelled
//     (absolute, relative, traversal). Paths OUTSIDE the repository are
//     the operator's own territory; the session only ever creates and
//     removes files it names itself inside that one directory.
//   - `removeStaleVideo` removes a video left by an EARLIER session so
//     a no-video session never leaves a stale MP4 in the active output
//     directory (§55/§56) — by exact filename, never by pattern.
//
// The repository root is injected so the path logic is pure and unit
// testable without touching the real repository.

import { stat, rm } from 'node:fs/promises';
import { join, resolve, sep, isAbsolute } from 'node:path';

/** The single canonical video filename (generated + stale-removed). */
export const VIDEO_FILENAME = 'showcase-walkthrough.mp4';

/** The designated generated-output root inside the repository. */
export const GENERATED_OUTPUT_DIRNAME = '.artifacts';

/**
 * True when `candidate` is `root` itself or anywhere inside it.
 * Both paths must already be absolute/normalized.
 */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Normalizes a user-supplied output path (§66) and refuses a target
 * inside the repository unless it is under the generated-output root.
 * `resolve` collapses `.`/`..` traversal and redundant separators, so
 * every spelling of a repository-inside path is caught uniformly.
 */
export function safeOutputDir(rawPath: string, repoRoot: string): string {
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rawPath);
  const root = resolve(repoRoot);
  const artifactsRoot = join(root, GENERATED_OUTPUT_DIRNAME);
  if (isInside(root, resolved) && !isInside(artifactsRoot, resolved)) {
    throw new Error(
      `refusing output directory inside the repository: ${resolved} — ` +
        `use a directory under ${GENERATED_OUTPUT_DIRNAME}/ or outside the repository`,
    );
  }
  return resolved;
}

/**
 * Removes a video left in the output directory by an EARLIER session
 * (§55/§56): a session that does not generate the video must not leave
 * a stale MP4 behind that could be mistaken for this session's
 * product. Returns true when a stale file was removed.
 */
export async function removeStaleVideo(outputDir: string): Promise<boolean> {
  const stalePath = join(outputDir, VIDEO_FILENAME);
  try {
    await stat(stalePath);
  } catch {
    return false;
  }
  await rm(stalePath, { force: true });
  return true;
}
