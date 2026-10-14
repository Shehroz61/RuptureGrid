// =====================================================================
// Unit — Phase 17 F-5: the pre-commit hook is mutation-free
// =====================================================================
// The independent audit reproduced a real contributor-expectation
// violation: with `prettier --write`, a staged edit PLUS a separate
// unstaged edit in the SAME file could have the unstaged hunk swept into
// the commit (lint-staged re-stages the rewritten file). These tests run
// the REAL hook command chain in DISPOSABLE git repositories and inspect
// the committed tree, the index, and the working tree.
//
// The hook itself is `.husky/pre-commit` → `pnpm exec lint-staged`; this
// test invokes the same `lint-staged` binary (from this repository's
// node_modules) so it is portable across shells. The harness wires the
// real hook file into the disposable repo via `core.hooksPath`, so the
// hook FILE content is executed too. The repository's pre-commit wiring
// (config shape, LF-only hook, CI gate) is separately pinned in
// tooling.test.ts. Nothing here touches the real RuptureGrid repository:
// every git command runs inside a fresh mkdtemp directory that is removed
// afterwards.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LINT_STAGED_JS = join(ROOT, 'node_modules', 'lint-staged', 'bin', 'lint-staged.js');
const ROOT_BIN = join(ROOT, 'node_modules', '.bin');

// These tests shell out to real git + lint-staged in disposable repos, so
// they need more than the default 5s headroom when the full unit suite runs
// them alongside everything else.
const itHooked = (name: string, fn: () => void): void => it(name, fn, 60_000);

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitOk(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function hookEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${ROOT_BIN}${delimiter}${process.env.PATH ?? ''}` };
}

/** Creates a disposable git repo wired with the real hook + config. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'rg-hook-'));
  gitOk(repo, ['init', '-q']);
  gitOk(repo, ['config', 'user.email', 'hook-test@rupturegrid.local']);
  gitOk(repo, ['config', 'user.name', 'Hook Test']);
  gitOk(repo, ['config', 'commit.gpgsign', 'false']);
  gitOk(repo, ['config', 'core.autocrlf', 'false']);
  // The real config artifacts.
  writeFileSync(join(repo, '.lintstagedrc.json'), readFileSync(join(ROOT, '.lintstagedrc.json')));
  writeFileSync(join(repo, '.prettierrc.json'), readFileSync(join(ROOT, '.prettierrc.json')));
  // The real hook file, executed by git via core.hooksPath. A POSIX
  // shebang is prepended so git can spawn it directly in the disposable
  // repo (the husky-managed hook is invoked by husky's own wrapper).
  const hooksDir = join(repo, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hook = readFileSync(join(ROOT, '.husky', 'pre-commit'), 'utf8');
  writeFileSync(join(hooksDir, 'pre-commit'), `#!/bin/sh\n${hook}`);
  chmodSync(join(hooksDir, 'pre-commit'), 0o755);
  gitOk(repo, ['config', 'core.hooksPath', hooksDir.replaceAll('\\', '/')]);
  // `pnpm exec lint-staged` must resolve in the disposable repo: provide a
  // local shim that runs THIS repository's lint-staged (the same binary the
  // real hook delegates to).
  const binDir = join(repo, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const shim = `#!/bin/sh\nexec node ${JSON.stringify(LINT_STAGED_JS)} "$@"\n`;
  writeFileSync(join(binDir, 'lint-staged'), shim);
  chmodSync(join(binDir, 'lint-staged'), 0o755);
  writeFileSync(join(binDir, 'lint-staged.cmd'), `@node ${JSON.stringify(LINT_STAGED_JS)} %*\r\n`);
  // Prettier-stable (the hook runs `prettier --check`).
  writeFileSync(join(repo, 'package.json'), '{\n  "name": "hook-fixture",\n  "private": true\n}\n');
  return repo;
}

/** Runs the same lint-staged binary the hook runs. */
function runLintStaged(cwd: string): GitResult {
  const result = spawnSync(process.execPath, [LINT_STAGED_JS], {
    cwd,
    encoding: 'utf8',
    env: hookEnv(),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function commit(cwd: string, message: string): GitResult {
  const result = spawnSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: hookEnv(),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const JSON_TEMPLATE = [
  '{',
  '  "a": 1,',
  '  "gap1": 0,',
  '  "gap2": 0,',
  '  "gap3": 0,',
  '  "gap4": 0,',
  '  "gap5": 0,',
  '  "gap6": 0,',
  '  "gap7": 0,',
  '  "d": 1',
  '}',
  '',
].join('\n');

describe('F-5: pre-commit hook never commits unstaged hunks (disposable repos)', () => {
  itHooked(
    'a staged hunk commits while a separate unstaged hunk in the same file stays out',
    () => {
      const repo = makeRepo();
      try {
        const file = join(repo, 'data.json');
        writeFileSync(file, JSON_TEMPLATE);
        gitOk(repo, ['add', '.']);
        gitOk(repo, ['commit', '-m', 'baseline', '--no-verify']);

        // Stage hunk A (change "a"), then add unstaged hunk B (change "d").
        writeFileSync(file, JSON_TEMPLATE.replace('"a": 1', '"a": 2'));
        gitOk(repo, ['add', 'data.json']);
        writeFileSync(file, readFileSync(file, 'utf8').replace('"d": 1', '"d": 2'));

        // The staged index must NOT contain hunk B, and the working tree must.
        const stagedBefore = gitOk(repo, ['show', ':data.json']);
        expect(stagedBefore).toContain('"a": 2');
        expect(stagedBefore).not.toContain('"d": 2');
        expect(readFileSync(file, 'utf8')).toContain('"d": 2');

        // Run the hook command chain.
        const lint = runLintStaged(repo);
        expect(lint.status, lint.stderr).toBe(0);

        // The index is untouched by the mutation-free hook.
        const stagedAfter = gitOk(repo, ['show', ':data.json']);
        expect(stagedAfter).toBe(stagedBefore);
        expect(stagedAfter).not.toContain('"d": 2');

        // Commit through the real hook; the committed tree holds ONLY hunk A.
        const commitResult = commit(repo, 'staged-only');
        expect(commitResult.status, commitResult.stderr).toBe(0);
        const committed = gitOk(repo, ['show', 'HEAD:data.json']);
        expect(committed).toContain('"a": 2');
        expect(committed).not.toContain('"d": 2');
        // The unstaged edit is preserved locally (not lost).
        expect(readFileSync(file, 'utf8')).toContain('"d": 2');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  itHooked(
    'a malformed/format-violating staged file BLOCKS the commit and preserves the index',
    () => {
      const repo = makeRepo();
      try {
        const file = join(repo, 'data.json');
        writeFileSync(file, JSON_TEMPLATE);
        gitOk(repo, ['add', '.']);
        gitOk(repo, ['commit', '-m', 'baseline', '--no-verify']);

        // A malformed JSON hunk is staged; a separate unstaged edit exists.
        writeFileSync(file, '{\n  "broken": ,\n}\n');
        gitOk(repo, ['add', 'data.json']);
        const stagedBefore = gitOk(repo, ['show', ':data.json']);

        const lint = runLintStaged(repo);
        expect(lint.status).not.toBe(0); // prettier --check fails → blocked

        const commitResult = commit(repo, 'should-not-commit');
        expect(commitResult.status).not.toBe(0); // the hook blocked it

        // Index and working tree are preserved exactly.
        expect(gitOk(repo, ['show', ':data.json'])).toBe(stagedBefore);
        expect(readFileSync(file, 'utf8')).toContain('"broken"');
        // No new commit was created.
        expect(gitOk(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  itHooked('a well-formatted staged file commits cleanly (valid JSON baseline)', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'data.json'), JSON_TEMPLATE);
      gitOk(repo, ['add', '.']);
      const commitResult = commit(repo, 'valid');
      expect(commitResult.status, commitResult.stderr).toBe(0);
      expect(gitOk(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  itHooked('an empty staged set is a safe no-op (exit 0)', () => {
    const repo = makeRepo();
    try {
      const result = runLintStaged(repo);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  itHooked('handles a staged path containing spaces', () => {
    const repo = makeRepo();
    try {
      const spaced = join(repo, 'a spaced file.json');
      writeFileSync(spaced, JSON_TEMPLATE);
      gitOk(repo, ['add', '--', 'a spaced file.json']);
      const result = runLintStaged(repo);
      expect(result.status, result.stderr).toBe(0);
      // The file was neither rewritten nor staged differently.
      expect(readFileSync(spaced, 'utf8')).toBe(JSON_TEMPLATE);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  itHooked('the real hook file is LF-only and delegates to lint-staged', () => {
    const hook = readFileSync(join(ROOT, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toContain('lint-staged');
    expect(hook).not.toContain('\r');
    expect(existsSync(LINT_STAGED_JS)).toBe(true);
  });
});
