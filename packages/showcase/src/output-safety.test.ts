// =====================================================================
// Unit — showcase output-path safety (Phase 8, auditor correction)
// =====================================================================
// Pins §66/§22 output-root safety (a repository-inside output path is
// refused unless it lives under the designated generated-output root;
// traversal spellings are collapsed first) and §55/§56 stale-output
// removal (only the canonical video filename is ever removed, only
// from the session's own output directory). Pure filesystem + path
// logic — no database, no services, no browser.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeOutputDir, removeStaleVideo, VIDEO_FILENAME } from './output-safety.js';

const REPO = mkdtempSync(join(tmpdir(), 'rg8-repo-'));
afterAll(() => {
  rmSync(REPO, { recursive: true, force: true });
});

describe('safeOutputDir', () => {
  it('accepts the designated generated-output root and paths under it', () => {
    expect(safeOutputDir(join(REPO, '.artifacts'), REPO)).toBe(join(REPO, '.artifacts'));
    expect(safeOutputDir(join(REPO, '.artifacts', 'showcase'), REPO)).toBe(
      join(REPO, '.artifacts', 'showcase'),
    );
  });

  it('accepts paths outside the repository', () => {
    const outside = join(tmpdir(), 'rg8-out-showcase');
    expect(safeOutputDir(outside, REPO)).toBe(outside);
  });

  it('refuses the repository root itself', () => {
    expect(() => safeOutputDir(REPO, REPO)).toThrow(/refusing output directory/);
    expect(() => safeOutputDir(join(REPO, '.'), REPO)).toThrow(/refusing output directory/);
  });

  it('refuses repository source directories in any spelling', () => {
    expect(() => safeOutputDir(join(REPO, 'packages', 'showcase'), REPO)).toThrow(/refusing/);
    expect(() => safeOutputDir(join(REPO, 'apps', 'web'), REPO)).toThrow(/refusing/);
    // traversal spellings collapse to the same refused target
    expect(() => safeOutputDir(join(REPO, '.artifacts', '..', 'packages'), REPO)).toThrow(
      /refusing/,
    );
    expect(() => safeOutputDir(join(REPO, 'packages', '..', 'docs'), REPO)).toThrow(/refusing/);
  });

  it('refuses a .artifacts-prefixed sibling that is not the output root', () => {
    // `.artifacts-ev/` is NOT under `.artifacts/` — a lookalike name
    // must not smuggle a repository-inside target past the guard.
    expect(() => safeOutputDir(join(REPO, '.artifacts-ev'), REPO)).toThrow(/refusing/);
  });

  it('keeps a repository-root sibling directory outside the guard', () => {
    // A directory named like the repo but outside it is operator land.
    const sibling = resolve(REPO, '..', 'repo-root-workdir');
    expect(safeOutputDir(sibling, REPO)).toBe(sibling);
  });

  it('uses the platform separator when testing containment', () => {
    // Windows-style joined paths must still resolve through `sep`.
    const target = join(REPO, 'docs');
    expect(() => safeOutputDir(target, REPO)).toThrow(/refusing/);
  });

  it('resolves relative paths against the process working directory', () => {
    // Runtime contract: a relative --output lands under the caller's
    // cwd, so with the repository as cwd the designated root passes and
    // repository sources are refused.
    const cwd = process.cwd();
    expect(safeOutputDir('.artifacts', cwd)).toBe(join(cwd, '.artifacts'));
    expect(() => safeOutputDir('packages', cwd)).toThrow(/refusing/);
  });
});

describe('removeStaleVideo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg8-stale-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes an earlier session video and reports that it did', async () => {
    writeFileSync(join(dir, VIDEO_FILENAME), 'stale-bytes');
    const removed = await removeStaleVideo(dir);
    expect(removed).toBe(true);
    expect(existsSync(join(dir, VIDEO_FILENAME))).toBe(false);
  });

  it('reports no-op when no video is present', async () => {
    expect(await removeStaleVideo(dir)).toBe(false);
  });

  it('never touches other files in the directory', async () => {
    writeFileSync(join(dir, '00-runs-index.png'), 'png-bytes');
    await removeStaleVideo(dir);
    expect(existsSync(join(dir, '00-runs-index.png'))).toBe(true);
  });
});
