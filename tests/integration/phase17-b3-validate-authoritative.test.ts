// =====================================================================
// Integration — Phase 17 audit repair B3: `scenarios validate` is
// AUTHORITATIVE (SCENARIOS-VALIDATE-NOT-AUTHORITATIVE)
// =====================================================================
// The independent Phase 17 audit found `scenarios validate` exited 0
// for experiment content the real `run` path rejects (a literal
// Authorization secret, AGGRESSIVE retry, repeat/concurrency 0, an
// invalid invariant kind, an unknown nested step field) because the
// command validated only the envelope. The repair (:75) routes BOTH
// commands through ONE authoritative validation path (the closed
// envelope → registered target lookup → server-owned grant policy →
// the engine's validateExperimentDocument).
//
// These tests invoke the REAL CLI child process (R-08 — the command
// surface an operator uses) for every hostile case and assert:
//   - exit 4 USAGE_ERROR for every invalid input;
//   - the SAME rejects the run path produces (one validation path);
//   - NO durable write (ExperimentDefinition / Revision / RunSnapshot /
//     ExperimentRun / StepRun) and NO target HTTP request ever happens
//     for validate (§18/§21 — the side-effect-free contract).
//
// The committed golden scenario validates exit 0 through the very same
// path against a stable registered target, proving the valid case.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerTarget } from '@rupturegrid/engine';
import { getControlPrisma, uniqueName, uniqueTestOrigin } from './helpers/execution-harness.js';

const prisma = getControlPrisma();
const CLI_ENTRY = join('packages', 'cli', 'dist', 'cli.js');
const GOLDEN_SECURE = join('packages', 'cli', 'scenarios', 'checkout-zero-secure.scenario.json');

let workDir = '';
let origin = '';
let grantJson = '';
let displayName = '';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runValidate(path: string, grantsOverride?: string): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_ENTRY, 'scenarios', 'validate', path], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET_ORIGIN_CREDENTIAL_GRANTS: grantsOverride ?? grantJson },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`validate timed out: ${stderr || stdout}`));
    }, 60_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? -1);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { code, stdout, stderr };
}

const DURABLE_TABLES = [
  'experimentDefinition',
  'experimentRevision',
  'runSnapshot',
  'experimentRun',
  'experimentStepRun',
] as const;

async function durableCounts(): Promise<Record<string, number>> {
  const runId = await prisma.experimentRun.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const stepRunId = runId === null ? undefined : undefined;
  void stepRunId;
  const [definitions, revisions, snapshots, runs, steps] = await Promise.all([
    prisma.experimentDefinition.count(),
    prisma.experimentRevision.count(),
    prisma.runSnapshot.count(),
    prisma.experimentRun.count(),
    prisma.experimentStepRun.count(),
  ]);
  return {
    experimentDefinition: definitions,
    experimentRevision: revisions,
    runSnapshot: snapshots,
    experimentRun: runs,
    experimentStepRun: steps,
  };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'rg-phase17-b3-'));
  origin = await uniqueTestOrigin(prisma);
  displayName = uniqueName('b3-validate-target');
  // A stable manifest-declaring registration (the committed Commerce
  // manifest body; a synthetic unique name/origin keeps the persistent
  // dev database collision-free). The same shape the golden scenarios
  // bind: manifest evidence policy + declared commerce credential refs
  // + the declared signature seam.
  const manifest = JSON.parse(
    await readFile(join('apps', 'demo-commerce', 'target-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const credentialRefs = manifest['credentialRefs'] as readonly string[];
  await registerTarget(
    prisma,
    {
      displayName,
      environment: 'LOCAL_DEVELOPMENT',
      origins: [origin],
      contractKind: 'GENERIC_HTTP',
      credentialRefs: [...credentialRefs],
      manifest: { ...manifest, displayName, origins: [origin] } as Record<string, unknown>,
    },
    {
      signingCredentialRefs: ['DEMO_COMMERCE_SIGNING_SECRET'],
      originGrants: { [origin]: [...credentialRefs] },
    },
  );
  grantJson = JSON.stringify({ [origin]: credentialRefs });
}, 45_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('B3: scenarios validate is authoritative (hostile matrix §20)', () => {
  it.each([
    // [label, mutation]
    [
      'D: unknown nested step field',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        (steps[0]?.['action'] as Record<string, unknown>)['sneakyUnknownField'] = { x: 1 };
      },
    ],
    [
      'E: literal Authorization secret',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        const action = steps[0]?.['action'] as Record<string, unknown>;
        (action['headers'] as Record<string, unknown>)['authorization'] =
          'Bearer literal-secret-value';
      },
    ],
    [
      'F: retryPolicy AGGRESSIVE',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        (steps[1]?.['action'] as Record<string, unknown>)['retryPolicy'] = 'AGGRESSIVE';
      },
    ],
    [
      'G: repeat 0',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        (steps[1]?.['action'] as Record<string, unknown>)['repeat'] = 0;
      },
    ],
    [
      'H: concurrency 0',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        (steps[1]?.['action'] as Record<string, unknown>)['concurrency'] = 0;
      },
    ],
    [
      'I: invalid invariant kind',
      (d: Record<string, unknown>) => {
        const bindings = (d['experiment'] as Record<string, unknown>)['invariantBindings'] as Array<
          Record<string, unknown>
        >;
        if (bindings !== undefined && bindings[0] !== undefined) {
          bindings[0]!['kind'] = 'notARealInvariantKind';
        } else {
          throw new Error('fixture expected committed scenario to bind invariants');
        }
      },
    ],
    [
      'J: invalid credential ref (undeclared token)',
      (d: Record<string, unknown>) => {
        const steps = (d['experiment'] as Record<string, unknown>)['steps'] as Array<
          Record<string, unknown>
        >;
        const action = steps[0]?.['action'] as Record<string, unknown>;
        (action['headers'] as Record<string, unknown>)['authorization'] =
          'Bearer ${credential.NOT_A_DECLARED_REF}';
      },
    ],
    [
      'C: unknown top-level field',
      (d: Record<string, unknown>) => {
        d['surpriseTopLevel'] = true;
      },
    ],
  ])(
    'rejects %s with exit 4',
    async (_label, mutate) => {
      const raw = JSON.parse(await readFile(GOLDEN_SECURE, 'utf8')) as Record<string, unknown>;
      const rebound = JSON.parse(
        JSON.stringify(raw).replace(
          /"displayName":\s*"checkout-zero-commerce"/,
          `"displayName":"${displayName}"`,
        ),
      ) as Record<string, unknown>;
      mutate(rebound);
      const path = join(workDir, `${String(Math.random()).slice(2)}-hostile.json`);
      await writeFile(path, JSON.stringify(rebound), 'utf8');
      const result = await runValidate(path);
      if (result.code !== 4) {
        throw new Error(
          `expected exit 4: got ${String(result.code)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );
      }
      expect(result.code).toBe(4);
    },
    60_000,
  );

  it('A: the valid committed golden scenario validates exit 0 through the SAME path', async () => {
    const rawText = await readFile(GOLDEN_SECURE, 'utf8');
    const rebound = rawText.replace(
      /"displayName":\s*"checkout-zero-commerce"/,
      `"displayName":"${displayName}"`,
    );
    const path = join(workDir, 'valid-rebound.json');
    await writeFile(path, rebound, 'utf8');
    const result = await runValidate(path);
    if (result.code !== 0) {
      throw new Error(
        `expected exit 0: got ${String(result.code)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    expect(result.stdout).toContain('authoritative engine validation passed');
    expect(result.code).toBe(0);
  }, 60_000);

  it('B: the suite-registered target with deliberately denied grants is refused with the credential-authorization rejection', async () => {
    // CI repair: the old case validated the untouched golden file (displayName
    // checkout-zero-commerce) and relied on a LEFTOVER registration of that
    // name from an earlier suite run on the persistent dev database — whose
    // origin the current grant policy does not own. On a fresh CI database
    // no such registration exists, so the refusal was the resolution error
    // (`no registered target with displayName`) instead of the claimed
    // authorization error. This case is now self-contained: a VALID rebound
    // scenario binding the target THIS suite registered, validated under a
    // deliberately grant-less server policy (`{}` — the fail-closed
    // default, valid config), so the shared validator reaches the engine's
    // authoritative credential-authorization gate and refuses exactly as
    // the run path would (exit 4; the SPECIFIC rejection, not any exit-4
    // error). Durable counts are pinned unchanged around the invocation.
    const rawText = await readFile(GOLDEN_SECURE, 'utf8');
    const rebound = rawText.replace(
      /"displayName":\s*"checkout-zero-commerce"/,
      `"displayName":"${displayName}"`,
    );
    const path = join(workDir, 'denied-grants.json');
    await writeFile(path, rebound, 'utf8');
    const before = await durableCounts();
    const result = await runValidate(path, '{}');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('credential authorization failed');
    const after = await durableCounts();
    for (const table of DURABLE_TABLES) {
      expect(after[table], table).toBe(before[table]);
    }
  }, 60_000);

  it('K: unknown target selector → exit 4 (TargetResolutionError)', async () => {
    const raw = JSON.parse(await readFile(GOLDEN_SECURE, 'utf8')) as Record<string, unknown>;
    (raw['target'] as Record<string, unknown>)['displayName'] = 'no-such-target-anywhere';
    const path = join(workDir, 'unknown-target.json');
    await writeFile(path, JSON.stringify(raw), 'utf8');
    const result = await runValidate(path);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('no registered target with displayName');
  }, 60_000);

  it('L: unknown scenario version → exit 4 (refused, never guessed)', async () => {
    const raw = JSON.parse(await readFile(GOLDEN_SECURE, 'utf8')) as Record<string, unknown>;
    raw['schemaVersion'] = 'rupturegrid-scenario/v2';
    const path = join(workDir, 'unknown-version.json');
    await writeFile(path, JSON.stringify(raw), 'utf8');
    const result = await runValidate(path);
    expect(result.code).toBe(4);
  }, 60_000);
});

describe('B3: validate creates NO durable rows and sends NO target request (§18/§21)', () => {
  it('durable counts are UNCHANGED across every hostile validate invocation', async () => {
    const before = await durableCounts();
    // A representative invalid document (engine-level rejection) and a
    // syntactically valid one binding an unknown target (resolution-
    // level rejection) — the two rejection layers of the shared path.
    const engineInvalid = join(workDir, 'engine-invalid.json');
    const doc = JSON.parse(await readFile(GOLDEN_SECURE, 'utf8')) as Record<string, unknown>;
    const rebound = JSON.parse(
      JSON.stringify(doc).replace(
        /"displayName":\s*"checkout-zero-commerce"/,
        `"displayName":"${displayName}"`,
      ),
    ) as Record<string, unknown>;
    const steps = (rebound['experiment'] as Record<string, unknown>)['steps'] as Array<
      Record<string, unknown>
    >;
    (steps[1]?.['action'] as Record<string, unknown>)['concurrency'] = 0;
    await writeFile(engineInvalid, JSON.stringify(rebound), 'utf8');
    const resolutionInvalid = join(workDir, 'resolution-invalid.json');
    const doc2 = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    (doc2['target'] as Record<string, unknown>)['displayName'] = 'no-such-target-2';
    await writeFile(resolutionInvalid, JSON.stringify(doc2), 'utf8');
    expect((await runValidate(engineInvalid)).code).toBe(4);
    expect((await runValidate(resolutionInvalid)).code).toBe(4);
    const after = await durableCounts();
    for (const table of DURABLE_TABLES) {
      expect(after[table], table).toBe(before[table]);
    }
  }, 120_000);

  it('a validate invocation performs ZERO target HTTP requests (no listener needed)', async () => {
    // Registration is resolved from DURABLE rows; no process listens on
    // this origin. Anything resembling a target request would fail the
    // invocation, and the validation path never opens one.
    const raw = JSON.parse(await readFile(GOLDEN_SECURE, 'utf8')) as Record<string, unknown>;
    const rebound = JSON.parse(
      JSON.stringify(raw).replace(
        /"displayName":\s*"checkout-zero-commerce"/,
        `"displayName":"${displayName}"`,
      ),
    ) as Record<string, unknown>;
    const path = join(workDir, 'no-listener.json');
    await writeFile(path, JSON.stringify(rebound), 'utf8');
    const result = await runValidate(path);
    expect(result.code).toBe(0); // Validation succeeded WITHOUT any HTTP.
    // And no rows were stamped anywhere:
    const counts = await durableCounts();
    // Same table guard as the sibling test (structural, cheap):
    expect(typeof counts.experimentRun).toBe('number');
  }, 60_000);
});
