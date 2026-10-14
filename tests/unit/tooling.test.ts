import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 17 tooling contract (R-07): pins the local pre-commit quality gates
// to committed, rerunnable checks so the hook wiring cannot silently drift
// from the documented contributor workflow. These assertions read the
// configuration artifacts only — they never execute git or lint-staged.
const ROOT = process.cwd();

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

/** Extracts the numeric floor from a simple `>=x.y.z` engine range. */
function parseEngineFloor(range: string): string | null {
  const match = /^\s*>=\s*(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  return match?.[1] ?? null;
}

/** Returns -1/0/1 for a < b / a == b / a > b on dotted numeric versions. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

const LINT_STAGED_TS_RULE = '*.{ts,tsx}';
const LINT_STAGED_CONFIG_RULE = '*.{js,mjs,cjs,json,yml,yaml,css}';
// Phase 17 F-5: hook tasks are MUTATION-FREE. `prettier --check` never
// rewrites, so a staged file's unstaged hunks can never be swept into a
// commit; ESLint runs WITHOUT --fix. Contributors run `pnpm format`
// manually before staging.
const PRETTIER_CHECK = 'prettier --check';
const ESLINT_CHECK = 'eslint --no-warn-ignored';

describe('pre-commit tooling contract', () => {
  const pkg = readJson<PackageJson>('package.json');
  const lintStaged = readJson<Record<string, string[]>>('.lintstagedrc.json');

  it('declares husky and lint-staged as root devDependencies', () => {
    expect(pkg.devDependencies?.husky).toBeDefined();
    expect(pkg.devDependencies?.['lint-staged']).toBeDefined();
  });

  it('installs git hooks through the prepare script after pnpm install', () => {
    // `prepare` runs automatically after `pnpm install`, wiring `.husky/_`
    // without any manual, machine-specific setup step.
    expect(pkg.scripts?.prepare).toBe('husky');
  });

  it('keeps the repository quality scripts available', () => {
    // The MANUAL formatter (`pnpm format`) is the only path that rewrites
    // files; the hook is check-only (F-5).
    expect(pkg.scripts?.format).toContain('prettier --write');
    expect(pkg.scripts?.['format:check']).toContain('prettier --check');
    expect(pkg.scripts?.lint).toContain('eslint');
  });

  it('runs mutation-free prettier --check then eslint (no --fix) on staged TS/TSX', () => {
    const rule = lintStaged[LINT_STAGED_TS_RULE] ?? [];
    expect(rule).toEqual([PRETTIER_CHECK, ESLINT_CHECK]);
    // Mutation-free by contract: check-only prettier, no eslint --fix.
    for (const task of rule) {
      expect(task).not.toContain('--write');
      expect(task).not.toContain('--fix');
    }
    // Prettier must run before eslint.
    expect(rule.indexOf(ESLINT_CHECK)).toBeGreaterThan(rule.indexOf(PRETTIER_CHECK));
  });

  it('checks staged config/source formats with prettier --check only (mutation-free)', () => {
    const rule = lintStaged[LINT_STAGED_CONFIG_RULE] ?? [];
    expect(rule).toEqual([PRETTIER_CHECK]);
    expect(rule.join(' ')).not.toContain('--write');
  });

  it('keeps the hook Node support consistent with the dependency engine requirements (F-4)', () => {
    // The root declares `engines.node`; the installed lint-staged declares
    // its own floor. The root minimum must satisfy EVERY hook dependency's
    // declared engine, or `pnpm install` warns/fails on a documented
    // supported Node version. F-4 repaired a real mismatch here.
    const rootNode = pkg.engines?.['node'] ?? '';
    const rootFloor = parseEngineFloor(rootNode);
    expect(rootFloor).not.toBeNull();
    const lintStagedPkg = readJson<{ version: string; engines?: Record<string, string> }>(
      'node_modules/lint-staged/package.json',
    );
    const dependencyFloor = parseEngineFloor(lintStagedPkg.engines?.['node'] ?? '');
    expect(dependencyFloor).not.toBeNull();
    // Node >= 22.12.0 is the root minimum; the hook dependency must not
    // require a HIGHER floor than the repository declares as supported.
    expect(compareVersions(dependencyFloor as string, rootFloor as string)).toBeLessThanOrEqual(0);
  });

  it('targets only staged files (no --all, no custom staging engine)', () => {
    const hook = readText('.husky/pre-commit');
    expect(hook).toContain('lint-staged');
    expect(hook).not.toContain('--all');
    // Hook files must be LF so Git for Windows and Linux behave alike.
    expect(hook).not.toContain('\r');
  });

  it('preserves hand-maintained markdown and frozen/generated paths from formatting', () => {
    const ignore = readText('.prettierignore');
    expect(ignore).toContain('*.md');
    expect(ignore).toContain('packages/*/generated');
    expect(ignore).toContain('packages/*/prisma/migrations');
  });

  it('keeps CI as the authoritative format/lint gate (hooks are local guards only)', () => {
    const ci = readText('.github/workflows/ci.yml');
    expect(ci).toContain('pnpm format:check');
    expect(ci).toContain('pnpm lint');
    expect(ci).not.toContain('continue-on-error');
  });
});
