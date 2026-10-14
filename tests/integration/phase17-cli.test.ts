// =====================================================================
// Integration — Phase 17: Checkout Zero golden scenarios + headless CLI
// (ADR-0019; R-08 real infrastructure, R-03 no fake evidence)
// =====================================================================
// The REAL compiled CLI process (packages/cli/dist/cli.js) drives the
// REAL Commerce target on REAL TCP, through the REAL queue + REAL
// worker process + REAL Control PostgreSQL — the same interfaces a
// human operator uses (§99 manual-demo parity). Assertions come from
// the CLI's observable interface (exit code, stdout, written report)
// and from DURABLE Control-Plane truth — never from test-side
// simulation. The one deliberate product-write bypass (integrity
// tamper below) is clearly marked and exists to VERIFY the verifier.
//
// Scenario expectations are never truth: the "vulnerable expectations
// vs secure-mode truth" case proves the exit classifier ignores the
// scenario's declared expectations entirely.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';

import { classifyExit, buildReport, executeScenario } from '@rupturegrid/cli';
import { registerTarget, TargetRegistrationError } from '@rupturegrid/engine';
import { runRunAnalysis, deriveRunEvidence, verifyRunEvidenceChain } from '@rupturegrid/evidence';
import type { IntegrityReport } from '@rupturegrid/evidence';
import { deriveRunForensics } from '@rupturegrid/forensics';
import { GENERIC_INSPECTION_NORMALIZER_NAME } from '@rupturegrid/evidence';
import { loadTestEnv } from './helpers/env.js';
import type { TestEnv } from './helpers/env.js';
import {
  getControlPrisma,
  testTargetOriginCredentialPolicy,
  waitFor,
} from './helpers/execution-harness.js';
import {
  createCommerceClient,
  loadCommerceManifest,
  startCommerceProcess,
} from './helpers/commerce-harness.js';
import type { RunningCommerce } from './helpers/commerce-harness.js';
import { provisionThrowawayCommerceDb } from './helpers/commerce-db-provision.js';
import type { ProvisionedCommerceDb } from './helpers/commerce-db-provision.js';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';

const prisma = getControlPrisma();
const COMMERCE_SIGNING_REF = 'DEMO_COMMERCE_SIGNING_SECRET';
// ADR-0025: the Commerce admin boundary is its OWN secret reference.
const COMMERCE_ADMIN_REF = 'COMMERCE_ADMIN_TOKEN';
const CLI_ENTRY = join('packages', 'cli', 'dist', 'cli.js');
const GOLDEN_SCENARIOS = join('packages', 'cli', 'scenarios');

let env: TestEnv;
let running: RunningCommerce;
let throwawayDb: ProvisionedCommerceDb | null = null;
let worker: ChildProcess | null = null;
let workerStdout = '';
let workerStderr = '';
let workDir = '';
let e2eTargetName = '';
let credentialPolicy: TargetOriginCredentialPolicy;
let grantJson = '';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns the REAL compiled CLI process with the real child environment. */
async function runCli(args: readonly string[], timeoutMs = 150_000): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      TARGET_ORIGIN_CREDENTIAL_GRANTS: grantJson,
    },
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
      reject(new Error(`CLI timed out after ${String(timeoutMs)}ms: ${stderr || stdout}`));
    }, timeoutMs);
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

// ---------------------------------------------------------------------
// Deterministic vulnerable-race barrier (Checkpoint D §15B)
// ---------------------------------------------------------------------
// The VULNERABLE target's naive check-then-act race is genuine (no
// artificial delay): two submissions oversell only if both READ the
// single remaining unit BEFORE either write transaction commits. Under
// full-suite load that overlap was probabilistic (two full-suite runs
// missed it). This barrier makes the overlap DETERMINISTIC at a
// test-controlled execution boundary using PostgreSQL's own lock
// semantics — no product-code change, no synthetic business effect, no
// race-forcing backdoor:
//
//   holder  — takes `FOR UPDATE` on the suite SKU row BEFORE the CLI
//             starts: the run's establish step queues on it.
//   waiter  — issues the SAME `FOR UPDATE` only after the establish
//             request is observed queued, so PostgreSQL grants it the
//             row lock ATOMICALLY the moment the establish transaction
//             commits (lock-queue order), i.e. before the two submit
//             requests (dispatched only after establish completes) can
//             write.
//   read    — both submissions' MVCC reads (SELECT) are never blocked
//             by the row lock: both genuinely read the stale stock.
//   write   — both write transactions (FK key-share + decrement) queue
//             behind the waiter until the test releases it, then both
//             commit against their own stale read — the real oversell,
//             produced by the target's own vulnerable logic.
// The barrier only SCHEDULES the real requests; it never writes
// business state (a row lock is not a write) and every durable effect
// is the target's own. If the protocol cannot be established the test
// fails honestly rather than silently falling back to timing luck.
const VULNERABLE_BARRIER_SKU_SQL = 'SELECT "id" FROM skus WHERE "sku" = $1 FOR UPDATE';

/**
 * Commerce backends currently WAITING on this database (PostgreSQL's own
 * wait evidence), observed through a DEDICATED autocommit observer —
 * never through a connection holding the barrier lock. Release-readiness
 * fix (seed-42 loaded failure): the previous detector counted only
 * `wait_event_type = 'Lock'` through the lock-holding connection and
 * observed 0 for ~80s while the run's establish transaction was blocked
 * on the barrier row, exceeding the Commerce target's 5s Prisma
 * transaction timeout (expired-transaction failure, CLI exit 3). The
 * detector now counts ANY wait (`wait_event IS NOT NULL`) with a
 * Commerce-business query shape, excluding the barrier's own backends by
 * pid — so the intended establish/submit request is asserted to have
 * reached the barrier, not just any lock. The `state` column is
 * deliberately NOT filtered: a transaction waiting on a conflicting row
 * still reports its last statement text — the wait is the authoritative
 * fact, the sampled `state` is not.
 */
async function blockedCommerceBackends(
  observer: PgClient,
  excludePids: readonly number[] = [],
): Promise<number> {
  // Active waiters only (`state = 'active'`): idle pool connections wait on
  // `Client/ClientRead` with their last query text still attached and must
  // never count as barrier queue evidence. A genuinely blocked establish or
  // submit reports `active` + a wait event (proven: `active/Lock:transactionid`
  // for the SKU upsert) with a Commerce-business query shape.
  const result = await observer.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event IS NOT NULL
        AND pid <> pg_backend_pid()
        AND (array_length($1::int[], 1) IS NULL OR NOT (pid = ANY ($1::int[])))
        AND query ILIKE ANY (ARRAY['%skus%', '%verification%', '%orders%', '%reservations%', '%commerce_settings%', '%checkout%'])`,
    [excludePids.length === 0 ? null : [...excludePids]],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Lock-only count (diagnostic companion to the any-wait detector above). */
async function lockBlockedCommerceBackends(observer: PgClient): Promise<number> {
  const result = await observer.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Diagnostic snapshot of this database's client backends (barrier honesty). */
async function commerceBackendSnapshot(observer: PgClient): Promise<string> {
  const result = await observer.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string | null;
  }>(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 200) AS query
       FROM pg_stat_activity WHERE datname = current_database() ORDER BY backend_start`,
  );
  return result.rows
    .map(
      (row) =>
        `  pid=${String(row.pid)} [${row.state ?? '?'}/${row.wait_event_type ?? '-'}:${row.wait_event ?? '-'}] ${(row.query ?? '').replace(/\s+/g, ' ')}`,
    )
    .join('\n');
}

/**
 * Runs the REAL CLI child process with the deterministic race barrier
 * armed around the run's establish→submit sequence (see the protocol
 * comment above). Returns the CLI's own observable result.
 */
async function runCliWithDeterministicOversell(
  args: readonly string[],
  timeoutMs = 150_000,
): Promise<CliResult> {
  const url = throwawayDb?.databaseUrl;
  if (url === undefined) {
    throw new Error('the vulnerable-race barrier requires the throwaway Commerce database');
  }
  const holder = new PgClient({ connectionString: url });
  const waiter = new PgClient({ connectionString: url });
  const observer = new PgClient({ connectionString: url });
  await Promise.all([holder.connect(), waiter.connect(), observer.connect()]);
  const pidOf = async (client: PgClient): Promise<number> => {
    const row = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return Number(row.rows[0]?.pid ?? 0);
  };
  const holderPid = await pidOf(holder);
  const waiterPid = await pidOf(waiter);
  const observerPid = await pidOf(observer);
  const barrierPids = [holderPid, waiterPid, observerPid].filter((pid) => pid !== 0);
  // 1. Fixture and target identity are verified BEFORE the barrier is
  //    created: the rebound scenario must name exactly this suite's scope
  //    and SKU, and the establish step must target the running Commerce
  //    origin's admin path in VULNERABLE mode. A mismatch fails fast as a
  //    fixture-setup error — never as a silent fallback.
  const scenarioPath = args[1] ?? '';
  const scenarioRaw = await readFile(scenarioPath, 'utf8').catch(() => '<unreadable>');
  if (scenarioRaw !== '<unreadable>') {
    const parsed = JSON.parse(scenarioRaw) as Record<string, unknown>;
    const steps = (parsed['experiment'] as Record<string, unknown>)['steps'] as Array<
      Record<string, unknown>
    >;
    const establish = steps.find((step) => step['name'] === 'establish-scenario');
    const body = JSON.parse(
      ((establish?.['action'] as Record<string, unknown>)?.['body'] as string) ?? '{}',
    ) as Record<string, unknown>;
    if (body['sku'] !== suiteSku || body['scopeToken'] !== suiteScopeToken) {
      throw new Error(
        `vulnerable-race barrier setup failed: fixture identity mismatch (scenario sku=${String(body['sku'])} scope=${String(body['scopeToken'])} vs suite sku=${suiteSku} scope=${suiteScopeToken})`,
      );
    }
    // The establish step is deliberately blocked on the barrier row while
    // the barrier observes the queue. The executor's default per-invocation
    // HTTP timeout (30s) would abort a slow-under-load dispatch before the
    // barrier can observe and release it — so the rebound (test-owned, never
    // canonical) establish step carries the platform-maximum 60s timeout.
    // The Commerce target's own 5s Prisma transaction timeout still bounds
    // the blocked DB transaction: the barrier must therefore observe and
    // release within seconds (fast any-wait poll below), never near 90s.
    const action = establish?.['action'] as Record<string, unknown> | undefined;
    if (action !== undefined && action['timeoutMs'] === undefined) {
      action['timeoutMs'] = 60_000;
      await writeFile(scenarioPath, JSON.stringify(parsed, null, 2), 'utf8');
    }
  }
  // The suite SKU row must exist before the barrier can lock it. A
  // shuffled first test may run before any establish: seed the row
  // through the target's OWN admin API (a legitimate fixture pre-step;
  // the run's establish reset then re-baselines it in its own context).
  const existing = await holder.query('SELECT 1 FROM skus WHERE "sku" = $1', [suiteSku]);
  if (existing.rowCount === 0) {
    await createCommerceClient(running).resetScenario({
      scopeToken: suiteScopeToken,
      sku: suiteSku,
      initialAvailableUnits: 1,
      mode: 'VULNERABLE',
    });
  }
  let armed: Promise<void> | null = null;
  let cliPromise: Promise<CliResult> | null = null;
  let maxBlocked = 0;
  let maxLockBlocked = 0;
  const barrierCreatedAt = Date.now();
  await holder.query('BEGIN');
  await holder.query(VULNERABLE_BARRIER_SKU_SQL, [suiteSku]);
  // 2-3. Barrier reports durable READY (row lock held) with its pid and
  //      timestamp — only then is the run dispatched.
  const holderLockedAt = Date.now();
  const cliSpawnedAt = holderLockedAt;
  try {
    cliPromise = runCli(args, timeoutMs);
    // 4-5. The run's establish step queues on the barrier row. The poll
    //      uses the DEDICATED observer (never the lock holder) and counts
    //      ANY Commerce-business wait — not just `Lock` — every 20ms, so a
    //      blocked establish is observed in milliseconds and the holder is
    //      released long before the target's 5s transaction timeout. The
    //      90s window is a busy-machine dispatch margin (the holder holds
    //      no expensive work while idle), never a fallback: the barrier
    //      either observes the real queue or fails honestly as a
    //      fixture-setup error — it never falls back to timing luck.
    const armedFrom = Date.now();
    for (;;) {
      const blocked = await blockedCommerceBackends(observer, barrierPids);
      const lockBlocked = await lockBlockedCommerceBackends(observer).catch(() => 0);
      if (blocked > maxBlocked) {
        maxBlocked = blocked;
      }
      if (lockBlocked > maxLockBlocked) {
        maxLockBlocked = lockBlocked;
      }
      if (blocked >= 1) {
        break;
      }
      if (Date.now() - armedFrom > 90_000) {
        throw new Error(
          'vulnerable-race barrier setup failed (phase 1): the establish step never queued on the barrier row',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const establishObservedAt = Date.now();
    // 6-7. Release the holder FIRST, then queue the waiter SEQUENTIALLY.
    //      The waiter must never queue concurrently behind the establish
    //      request on the same row: a concurrent `FOR UPDATE` can acquire
    //      ahead of the blocked multi-statement establish transaction
    //      (observed: waiter idle-holding while the establish INSERT still
    //      waited, submits never dispatched, CLI exit 3). Sequential order
    //      is deterministic either way: if the establish is still running
    //      its remaining statements, the waiter queues behind it (correct
    //      FIFO); if it already committed, the waiter takes the free lock
    //      within milliseconds — while the submits still need the worker
    //      chain (provenance + Redis + claim + HTTP + creates + read,
    //      ~100ms+) before their first write. Either way the waiter holds
    //      before either submit writes.
    await holder.query('ROLLBACK');
    const holderReleasedAt = Date.now();
    armed = (async () => {
      await waiter.query('BEGIN');
      await waiter.query(VULNERABLE_BARRIER_SKU_SQL, [suiteSku]);
    })();
    await armed;
    const waiterAcquiredAt = Date.now();
    // 8. Both submissions read the stale stock, then their transactions
    //    queue behind the waiter. Release ONLY after the required overlap
    //    (two queued writes) is actually established.
    await waitFor(
      async () => {
        const blocked = await blockedCommerceBackends(observer, barrierPids);
        const lockBlocked = await lockBlockedCommerceBackends(observer).catch(() => 0);
        if (blocked > maxBlocked) {
          maxBlocked = blocked;
        }
        if (lockBlocked > maxLockBlocked) {
          maxLockBlocked = lockBlocked;
        }
        return blocked >= 2 ? true : null;
      },
      90_000,
      20,
    ).catch(async () => {
      const snapshot = await commerceBackendSnapshot(observer).catch(() => '<unavailable>');
      throw new Error(
        `vulnerable-race barrier setup failed (phase 2): the two concurrent submissions never queued behind the barrier\nbackends:\n${snapshot}`,
      );
    });
    const overlapObservedAt = Date.now();
    // 9. Release: both transactions commit against their own stale read.
    //    Every durable effect from here on is the target's own; the test
    //    verifies real outcomes (not the barrier) afterwards.
    await waiter.query('ROLLBACK');
    const waiterReleasedAt = Date.now();
    const result = await cliPromise;
    void establishObservedAt;
    void holderReleasedAt;
    void waiterAcquiredAt;
    void overlapObservedAt;
    void waiterReleasedAt;
    return result;
  } catch (error) {
    await holder.query('ROLLBACK').catch(() => undefined);
    await waiter.query('ROLLBACK').catch(() => undefined);
    await armed?.catch(() => undefined);
    const finished = cliPromise === null ? null : await cliPromise.catch(() => null);
    const snapshot = await commerceBackendSnapshot(observer).catch(() => '<unavailable>');
    const skus = await observer
      .query('SELECT "sku", "scopeId" FROM skus ORDER BY "sku"')
      .then((result) => JSON.stringify(result.rows))
      .catch((queryError: unknown) =>
        queryError instanceof Error ? queryError.message : String(queryError),
      );
    const scenarioText = await readFile(args[1] ?? '', 'utf8').catch(() => '<unreadable>');
    const establishBody =
      scenarioText === '<unreadable>'
        ? scenarioText
        : JSON.stringify(
            (
              (JSON.parse(scenarioText) as Record<string, unknown>)['experiment'] as Record<
                string,
                unknown
              >
            )['steps'],
          ).slice(0, 800);
    // Distinguish the FIRST failure's phase and timing; a transaction
    // timeout must never leave orphaned jobs, stale locks, unreleased
    // sessions, or contaminated later runs — the ROLLBACKs above plus the
    // client closes in `finally` guarantee clean handoff, and the CLI
    // promise is always awaited so no worker job is orphaned.
    const now = Date.now();
    throw new Error(
      `the vulnerable-race barrier failed: ${
        error instanceof Error ? error.message : String(error)
      }\nmaxBlockedObserved=${String(maxBlocked)} maxLockBlockedObserved=${String(maxLockBlocked)}\nbarrierCreatedAt=+${String(barrierCreatedAt - barrierCreatedAt)}ms holderLockedAt=+${String(holderLockedAt - barrierCreatedAt)}ms cliSpawnedAt=+${String(cliSpawnedAt - barrierCreatedAt)}ms elapsedMs=${String(now - barrierCreatedAt)}\nholderPid=${String(holderPid)} waiterPid=${String(waiterPid)} observerPid=${String(observerPid)}\nsuiteSku=${suiteSku}\nsuiteScopeToken=${suiteScopeToken}\nskus=${skus}\nsteps=${establishBody}\napp stderr:\n${running
        .stderr()
        .slice(-2000)}\napp stdout:\n${running.stdout().slice(-3000)}\nbackends:\n${snapshot}${
        finished === null
          ? ''
          : `\nCLI exit ${String(finished.code)}\nstdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`
      }`,
      // Preserve the original failure as the cause (diagnostics, never a
      // swallowed error): the barrier reports what actually went wrong.
      { cause: error },
    );
  } finally {
    await holder.end().catch(() => undefined);
    await waiter.end().catch(() => undefined);
    await observer.end().catch(() => undefined);
  }
}

/**
 * Writes a golden scenario with the target selector rebound and a
 * UNIQUE experiment name (experiment names are globally unique in the
 * durable store — E2E reruns on a persistent dev database must never
 * collide with an earlier definition). Returns the file path plus the
 * rebound business identities: one suite scope + one suite SKU shared by
 * every file (each run's establish resets them), per-file intents.
 */
interface ReboundScenario {
  readonly path: string;
  readonly checkoutIntentId: string;
  /** The rebound identity inside the response-loss scenario's body. */
  readonly responseLossCheckoutIntentId: string;
  /** The suite-stable SKU (one SKU for the whole suite scope — see scenarioFile). */
  readonly sku: string;
}
let scenarioRunCounter = 0;
// Unique across suite RUNS (the dev database persists definitions).
const suiteToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// F-3 order-independence repair: ONE suite scope and ONE suite SKU for every
// scenario file in this suite run (including response-loss). Each scenario's
// establish step resets this scope through the target's OWN admin API, which
// deletes the scope's business rows (intents, orders, reservations, attempts)
// and re-baselines the single SKU — so every run starts from a genuinely
// clean logical context no matter which test ran before it (checkout-zero.md
// §4 "clean logical context"; the Phase 16 canonical pattern reuses one
// scope, one SKU, and one intent across VULNERABLE/SECURE runs with a reset
// between). Two earlier defects combined into the shuffled SECURE failure:
// (a) per-file SKU rebinding defeated that reset — every file created a NEW
// SKU row that the reset never deletes (SKU rows are upserted, not cleared),
// so a later SECURE run honestly observed an earlier VULNERABLE run's
// oversold SKU (remaining −1) as a coherent foreign subject and persisted a
// real FAIL; (b) the scopeToken string-surgery rebinding was a silent no-op
// (the token lives only inside JSON-escaped step bodies, which a quoted
// pattern can never match — verified: 0 matches), so response-loss rows
// lived in a separate canonical scope no main-scope reset ever cleans, and a
// later run's conservation evaluation tripped over the foreign reservation
// (SCOPE_INCOHERENT → exit 2). The rebinding below is therefore STRUCTURAL
// (parsed bodies), and the response-loss scope is merged into the same suite
// scope so its residue falls under the same reset. Business intent identities
// stay per-file (deleted on reset; they keep each run's own-subject
// assertions unambiguous). CI on a fresh database needs no rebinding at all;
// the committed scenario files stay canonical.
const suiteScopeToken = `checkout-zero-e2e-${suiteToken}`;
const suiteSku = `SKU-${suiteToken}`;
async function scenarioFile(
  sourceName: string,
  fileBody?: (document: Record<string, unknown>) => void,
): Promise<ReboundScenario> {
  const raw = await readFile(join(GOLDEN_SCENARIOS, sourceName), 'utf8');
  const document = JSON.parse(raw) as Record<string, unknown>;
  const target = document['target'] as Record<string, unknown>;
  target['displayName'] = e2eTargetName;
  // Suite-stable scope + SKU (F-3 repair — see the constants above). The
  // rebinding is STRUCTURAL (parsed step bodies), never string surgery on
  // the serialized document: scopeToken/sku/checkoutIntentId live inside
  // the steps' JSON-encoded body STRINGS, so a quoted pattern on the
  // serialized text can never match them (query: 0 matches — the old
  // replaceAll scope rebinding was a silent no-op and every test shared
  // the canonical scopes). Per-file business intents: each run's establish
  // deletes the prior run's intents, so distinct intents per file keep
  // own-subject assertions unambiguous without accumulating residue.
  // Experiment NAMES stay unique per file (definitions are globally unique
  // in the durable store). Only identity fields are rebound — mode,
  // customer, cart, totals, and currency are never touched.
  const perFileToken = `${suiteToken}-${String(scenarioRunCounter + 1)}`;
  const intentFor = (canonical: string): string =>
    canonical === 'CHK-RL-001' ? `CHKRL-${perFileToken}` : `CHK-${perFileToken}`;
  const experiment = document['experiment'] as Record<string, unknown>;
  const steps = experiment['steps'] as Array<Record<string, unknown>>;
  for (const step of steps) {
    const action = step['action'] as Record<string, unknown>;
    if (typeof action['body'] !== 'string') {
      continue;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(action['body'] as string) as Record<string, unknown>;
    } catch {
      continue; // Not a JSON body (e.g. fault-hook payloads): leave untouched.
    }
    let reboundBody = false;
    if (typeof body['scopeToken'] === 'string') {
      body['scopeToken'] = suiteScopeToken;
      reboundBody = true;
    }
    if (typeof body['sku'] === 'string') {
      body['sku'] = suiteSku;
      reboundBody = true;
    }
    if (typeof body['checkoutIntentId'] === 'string') {
      body['checkoutIntentId'] = intentFor(body['checkoutIntentId'] as string);
      reboundBody = true;
    }
    if (reboundBody) {
      action['body'] = JSON.stringify(body);
    }
  }
  // ---- Checkpoint C: the FROZEN run-scope intent is rebound with the SAME
  // structural discipline as the step bodies. `runScope/v1` is the run-owned
  // comparison anchor (ADR-0026 §3/§11): its declared scope and declared
  // subject identities are what every observed subject is compared against.
  // If the rebound run kept the canonical declaration while the target was
  // re-baselined under the suite scope/SKU, the declaration would name a
  // scope the target never observed — honestly unprovable (ANCHOR_UNPROVEN),
  // never a fabrication to be papered over on the evaluation side.
  const experimentEnvelope = experiment;
  const runScope = experimentEnvelope['runScope'] as Record<string, unknown> | undefined;
  if (runScope !== undefined && runScope !== null) {
    // The suite uses ONE scope for every file (including response-loss), so
    // the declaration follows the re-baselined target exactly.
    runScope['declaredScope'] = suiteScopeToken;
    const declaredSubjects = runScope['subjects'] as Record<string, string[]> | undefined;
    for (const [invariantKey, subjects] of Object.entries(declaredSubjects ?? {})) {
      declaredSubjects![invariantKey] = subjects.map((subject) =>
        subject === 'SKU-001' ? suiteSku : subject.startsWith('CHK') ? intentFor(subject) : subject,
      );
    }
  }
  const rebound = document;
  const baseName = typeof rebound['name'] === 'string' ? rebound['name'] : sourceName;
  scenarioRunCounter += 1;
  rebound['name'] = `${baseName}-${suiteToken}-${String(scenarioRunCounter)}`;
  fileBody?.(rebound);
  const path = join(workDir, `${sourceName}-${String(scenarioRunCounter)}`);
  await writeFile(path, JSON.stringify(rebound, null, 2), 'utf8');
  // Read back the ACTUAL rebound submit intent (never assumed): the
  // checkout-submit step's body carries it. G1 variants remove that step —
  // their (unused) intent is still the per-file one.
  const reboundSteps = (rebound['experiment'] as Record<string, unknown>)['steps'] as Array<
    Record<string, unknown>
  >;
  const submitBody = reboundSteps.find((step) => step['name'] === 'checkout-submit')?.['action'] as
    Record<string, unknown> | undefined;
  let submitBodyJson: Record<string, unknown>;
  try {
    submitBodyJson = JSON.parse((submitBody?.['body'] as string) ?? '{}') as Record<
      string,
      unknown
    >;
  } catch {
    submitBodyJson = {};
  }
  const submitIntent =
    typeof submitBodyJson['checkoutIntentId'] === 'string'
      ? (submitBodyJson['checkoutIntentId'] as string)
      : `CHK-${perFileToken}`;
  const isResponseLossSubmit = submitIntent.startsWith('CHKRL-');
  return {
    path,
    checkoutIntentId: isResponseLossSubmit ? `CHK-${perFileToken}` : submitIntent,
    responseLossCheckoutIntentId: isResponseLossSubmit ? submitIntent : `CHKRL-${perFileToken}`,
    sku: suiteSku,
  };
}

/** Reads one target inspection collection (read-only, R-05 respected). */
async function inspectCollection<T>(path: string): Promise<T[]> {
  const response = await fetch(`${running.baseUrl}${path}`);
  return (await response.json()) as T[];
}

interface TargetOrderRow {
  readonly orderId: string;
  readonly checkoutIntentId: string;
  readonly processingAttemptId: string;
  readonly status: string;
}

interface TargetReservationRow {
  readonly reservationId: string;
  readonly orderId: string;
  readonly sku: string;
  readonly reservedUnits: number;
  readonly status: string;
}

interface TargetRemainingRow {
  readonly sku: string;
  readonly remainingAvailableUnits: number;
}

interface TargetRequestAttemptRow {
  readonly requestAttemptId: string;
  readonly checkoutIntentId: string;
}

interface TargetProcessingAttemptRow {
  readonly processingAttemptId: string;
  readonly requestAttemptId: string;
  readonly startSequence: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: string;
}

/**
 * Asserts the §21 business truth of one VULNERABLE/SECURE golden run from
 * DURABLE Control-Plane rows plus the target's read-only inspection API:
 * physical attempts, accepted orders/reservations for the run's OWN intent
 * and SKU, and the SKU's remaining stock. Every run resets the suite scope
 * first, so the target holds exactly this run's business rows.
 */
async function expectCheckoutZeroBusinessTruth(input: {
  readonly runId: string;
  readonly ownIntent: string;
  readonly ownSku: string;
  readonly expectedAcceptedOrders: number;
  readonly expectedAcceptedReservations: number;
  readonly expectedRemaining: number;
}): Promise<{ readonly processingAttempts: TargetProcessingAttemptRow[] }> {
  const steps = await prisma.experimentStepRun.findMany({
    where: { runId: input.runId },
    orderBy: { sequence: 'asc' },
  });
  const submit = steps.find((step) => step.name === 'checkout-submit');
  expect(submit).toBeDefined();
  const submitId = (submit?.id ?? '') as string;
  // Declared pressure (repeat 2, concurrency 2, retry NONE) drove exactly
  // two physical attempts — never a retry, never a collapse.
  expect(submit?.state).toBe('SUCCEEDED');
  expect(submit?.attemptCount).toBe(2);
  expect(await prisma.stepInvocation.count({ where: { stepRunId: submitId } })).toBe(2);

  const orders = await inspectCollection<TargetOrderRow>('/inspection/orders');
  const ownOrders = orders.filter(
    (order) => order.checkoutIntentId === input.ownIntent && order.status === 'ACCEPTED',
  );
  expect(ownOrders).toHaveLength(input.expectedAcceptedOrders);
  expect(new Set(ownOrders.map((order) => order.orderId)).size).toBe(input.expectedAcceptedOrders);

  const reservations = await inspectCollection<TargetReservationRow>('/inspection/reservations');
  const ownReservations = reservations.filter(
    (reservation) => reservation.sku === input.ownSku && reservation.status === 'ACCEPTED',
  );
  expect(ownReservations).toHaveLength(input.expectedAcceptedReservations);
  for (const reservation of ownReservations) {
    expect(reservation.reservedUnits).toBe(1);
  }

  const remaining = await inspectCollection<TargetRemainingRow>('/inspection/sku-remaining');
  expect(remaining.find((row) => row.sku === input.ownSku)?.remainingAvailableUnits).toBe(
    input.expectedRemaining,
  );

  const requestAttempts = await inspectCollection<TargetRequestAttemptRow>(
    '/inspection/request-attempts',
  );
  const ownRequestIds = new Set(
    requestAttempts
      .filter((attempt) => attempt.checkoutIntentId === input.ownIntent)
      .map((attempt) => attempt.requestAttemptId),
  );
  expect(ownRequestIds.size).toBe(2);
  const processingAttempts = (
    await inspectCollection<TargetProcessingAttemptRow>('/inspection/processing-attempts')
  ).filter((attempt) => ownRequestIds.has(attempt.requestAttemptId));
  expect(processingAttempts).toHaveLength(2);
  return { processingAttempts };
}

/** Asserts genuine overlap from TARGET-PERSISTED timestamps (never executor optimism). */
function expectTargetPersistedOverlap(attempts: readonly TargetProcessingAttemptRow[]): void {
  expect(attempts).toHaveLength(2);
  const [a, b] = [...attempts].sort((x, y) => x.startSequence - y.startSequence);
  if (a === undefined || b === undefined) {
    throw new Error('expected two processing attempts');
  }
  expect(a.requestAttemptId).not.toBe(b.requestAttemptId);
  expect(new Date(a.startedAt).getTime()).toBeLessThan(new Date(b.finishedAt).getTime());
  expect(new Date(b.startedAt).getTime()).toBeLessThan(new Date(a.finishedAt).getTime());
}

beforeAll(async () => {
  env = loadTestEnv();
  // Random high port: the persistent dev database keeps previous
  // registrations (origins are global by design).
  let port = 33000 + Math.floor(Math.random() * 6000);
  // Hermetic target state: a THROWAWAY commerce database per suite run
  // (committed migration SQL only), so the target's complete-collection
  // inspection evidence contains exactly what THIS suite run created.
  const commerceHostPort = Number((env.commerceDatabaseUrl.match(/:(\d+)\//) ?? [])[1] ?? 5445);
  throwawayDb = await provisionThrowawayCommerceDb({
    adminUrl: `postgresql://commerce:${env.commercePostgresPassword}@127.0.0.1:${commerceHostPort}/postgres`,
    password: env.commercePostgresPassword,
    port: commerceHostPort,
  });
  const hermeticEnv: TestEnv = {
    ...env,
    commerceDatabaseUrl: throwawayDb.databaseUrl,
  };
  // A FRESH registration per suite run: the committed golden scenarios
  // pin displayName, but the E2E binds a unique per-run selector so a
  // persistent dev database never collides with earlier runs. The random
  // port can still collide with a stale registration from an old suite
  // run (origins are globally unique) — a bounded retry picks a fresh
  // port instead of failing the whole file on a setup coin-flip. This
  // retries SETUP ONLY (never an assertion) and never weakens the suite.
  e2eTargetName = `checkout-zero-e2e-${Date.now().toString(36)}`;
  for (let attempt = 0; ; attempt += 1) {
    running = await startCommerceProcess(hermeticEnv, port);
    credentialPolicy = testTargetOriginCredentialPolicy({
      [running.baseUrl]: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
    });
    try {
      await registerTarget(
        prisma,
        {
          displayName: e2eTargetName,
          environment: 'LOCAL_DEVELOPMENT',
          origins: [running.baseUrl],
          contractKind: 'GENERIC_HTTP',
          credentialRefs: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
          manifest: loadCommerceManifest(e2eTargetName, running.baseUrl),
        },
        credentialPolicy,
      );
      break;
    } catch (error) {
      await running.close();
      if (!(error instanceof TargetRegistrationError) || attempt >= 2) {
        throw error;
      }
      port = 33000 + Math.floor(Math.random() * 6000);
    }
  }
  // The CLI resolves its platform grant policy from validated config.
  grantJson = JSON.stringify({
    [running.baseUrl]: [COMMERCE_SIGNING_REF, COMMERCE_ADMIN_REF],
  });
  // The REAL worker process (same pattern as multi-worker.test.ts) with
  // EXACTLY the Commerce credentials the worker config owns.
  worker = spawn(process.execPath, [join('apps', 'worker', 'dist', 'main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: env.controlDatabaseUrl,
      REDIS_URL: env.redisUrl,
      QUEUE_PREFIX: env.queuePrefix,
      WORKER_CONCURRENCY: '2',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DEMO_ADMIN_TOKEN: env.demoAdminToken,
      DEMO_COMMERCE_SIGNING_SECRET: env.commerceSigningSecret,
      // ADR-0025: the Commerce admin boundary is its own credential
      // reference — scenario steps resolving
      // ${credential.COMMERCE_ADMIN_TOKEN} need this value present.
      COMMERCE_ADMIN_TOKEN: env.commerceAdminToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout?.on('data', (chunk: Buffer) => {
    workerStdout += chunk.toString();
  });
  worker.stderr?.on('data', (chunk: Buffer) => {
    workerStderr += chunk.toString();
  });
  await waitFor(async () => (workerStdout.includes('ready') ? true : null), 30_000, 100).catch(
    () => {
      throw new Error(`worker did not start: ${workerStderr || workerStdout}`);
    },
  );
  workDir = await mkdtemp(join(tmpdir(), 'rg-phase17-'));
}, 90_000);

afterAll(async () => {
  worker?.kill();
  await running.close();
  await throwawayDb?.close();
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// G1 (Phase 17 acceptance closure): a REAL process-level exit-2
// NOT_EVALUABLE execution/evidence path. No fabricated row, no verdict
// mutation, no --force-not-evaluable: the scenario establishes one unit
// of stock in the SECURE mode via the target's OWN admin API and the
// checkout step NEVER RUNS (its durable step row is not dispatched,
// the same way a missing setup dependency leaves legitimate work
// unexecuted — the queue/dispatch state stays honest). The evaluator
// truth tables then legitimately produce NOT_EVALUABLE for the bound
// invariant whose subject surface never materialized (order/reservation
// entities absent + summary totals zero — the surfaces exist (valid
// empty captures), the consumption evidence does not), while the
// conservation surface is also absent for the consumed resource. The
// analysis pipeline persists those verdicts itself; the classifier
// maps at-least-one NOT_EVALUABLE with no FAIL to exit 2.
//
// Order independence (F-3 repair): this test runs in ANY file position.
// Its establish step resets the one suite scope (deleting every prior
// run's intents, orders, and reservations) and re-baselines the one
// suite SKU, so the run's evidence contains no checkout subject from
// any earlier test — the missing-verdict rule classifies exit 2 from
// the run's OWN incomplete evidence, never from test order.
// ---------------------------------------------------------------------

describe('Phase 17 G1: real process-level NOT_EVALUABLE evidence path (exit 2)', () => {
  it('a completed run whose required evidence surface is absent classifies NOT_EVALUABLE through the real CLI child process', async () => {
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json', (document) => {
      const experiment = document['experiment'] as Record<string, unknown>;
      experiment['steps'] = (experiment['steps'] as Array<Record<string, unknown>>).filter(
        (step) => step['name'] !== 'checkout-submit',
      );
      document['expectations'] = { exitClass: 'NOT_EVALUABLE' };
    });
    const reportPath = join(workDir, 'not-evaluable-report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    // The checkout step is legitimately NOT dispatched: its durable
    // row stays PENDING/dispatchState PENDING (test-side truth, not a
    // fabricated trace — the run's evidence carries exactly what the
    // target was asked and observed nothing for this step).
    if (result.code !== 2) {
      throw new Error(
        `expected OS exit 2 (NOT_EVALUABLE), got ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nworkerOut:\n${workerStdout.slice(-1200)}`,
      );
    }
    expect(result.code).toBe(2); // the REAL child-process OS exit code
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    const exit = report['exit'] as Record<string, unknown>;
    expect(exit['code']).toBe(2);
    expect(exit['class']).toBe('NOT_EVALUABLE');
    // The exit reason names the honest rule-3 sources: a persisted
    // NOT_EVALUABLE verdict and/or a bound key with no persisted
    // verdict (both are "insufficient evidence", never a guess).
    expect(String(exit['reason'])).toMatch(/NOT_EVALUABLE|no persisted verdict/i);
    // A written report file was emitted (construct → validate → write).
    const written = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    expect((written['exit'] as Record<string, unknown>)['class']).toBe('NOT_EVALUABLE');
    const runId = (report['run'] as Record<string, unknown>)['runId'] as string;
    // Honest structure: the run carries ONLY the establish step (the
    // checkout step was never part of this scenario) — the evidence
    // legitimately lacks the consumption surfaces.
    const stepNames = await prisma.experimentStepRun.findMany({
      where: { runId },
      select: { name: true, state: true, attemptCount: true },
    });
    expect(stepNames.map((step) => step.name).sort()).toEqual(['establish-scenario']);
    expect(stepNames.every((step) => step.state === 'SUCCEEDED')).toBe(true);
    expect((report['run'] as Record<string, unknown>)['terminalState']).toBe('COMPLETED');
    const integrity = report['evidenceIntegrity'] as Record<string, unknown>;
    expect(integrity['verified']).toBe(true);
    // The report carries the REAL persisted NOT_EVALUABLE row(s) with
    // their bounded reason codes — read back from DURABLE truth below.
    // A run whose bound invariant found NO subject (no checkout intent
    // ever entered the target) honestly persists zero evaluation rows;
    // the classifier's rule 3 (missing verdict → exit 2) is THE
    // contract here, and the DURABLE checks below prove the absence
    // comes from real truth, not from a broken pipeline.
    const evaluations = report['invariantEvaluations'] as Array<Record<string, unknown>>;
    const notEvaluables = evaluations.filter(
      (evaluation) => evaluation['verdict'] === 'NOT_EVALUABLE',
    );
    // DURABLE truth drives the assertion below; the report row count
    // itself is asserted against the durable rows (no fabrication).

    // ---- DURABLE truth: the analysis pipeline ran ITS OWN evaluation
    // — the persisted rows (all verdicts, including NOT_EVALUABLE) come
    // from the pipeline, never fabricated in the test. When the
    // checkout intent never entered the target, the subject loader has
    // no subject to evaluate and zero generic rows are persisted: the
    // honest exit-2 rule is the MISSING-VERDICT rule (bound key with
    // no persisted verdict), named in the exit reason.
    const persisted = await prisma.invariantEvaluation.findMany({
      where: { runId, invariantKey: { in: ['INV-CHK-1', 'INV-INV-1'] } },
    });
    const notEvaluableViews = notEvaluables.length;
    const persistedNe = persisted.filter((row) => row.verdict === 'NOT_EVALUABLE');
    // The report's rows and the durable rows agree (same bounded
    // reasons, or both empty when no subject exists).
    expect(notEvaluableViews).toBe(persistedNe.length);
    for (const reportRow of notEvaluables as Array<Record<string, unknown>>) {
      expect(persistedNe.some((row) => row.reason === reportRow['reason'])).toBe(true);
    }
    void persistedNe;
    if (persistedNe.length > 0) {
      // The bounded reason names a real Phase 15 truth gap.
      expect(persistedNe.map((row) => row.reason).join(' ')).toMatch(
        /remaining|surface|gap|incomplete/i,
      );
    } else {
      // No-subject case: the bound invariants have NO persisted
      // verdict — recorded in the exit classification itself.
      expect(String(exit['reason'])).toContain('no persisted verdict');
      // The generic analysis DID run (batch rows exist or completed
      // at least once for the bound keys — proven by the exit reason
      // and the COMPLETED state; the durable batch row check): the
      // batches for the bound keys must EXIST (analysis completed).
      const batches = await prisma.evaluationBatch.findMany({
        where: { runId, invariantKey: { in: ['INV-CHK-1', 'INV-INV-1'] } },
        select: { invariantKey: true, completedAt: true },
      });
      expect(batches.length).toBeGreaterThanOrEqual(1);
    }
    // No trusted FAIL dominates: NO FAIL row exists for the run at
    // all (the platform's own legacy INV-DF-* and INV-IZ-1 invariants
    // also evaluated this run's evidence; none of them produced FAIL —
    // and in any case the exit contract is over the BOUND keys only).
    const anyFail = await prisma.invariantEvaluation.count({
      where: { runId, verdict: 'FAIL' },
    });
    expect(anyFail).toBe(0);
    // Evidence integrity behavior is honest in the report.
    expect((written['evidenceIntegrity'] as Record<string, unknown>)['verified']).toBe(true);
    // Reproduction reference honesty: closure gate K still holds.
    expect(report['reproductionReference']).toBeDefined();
  }, 240_000);
}); // G1 describe closes here: the five-way contract, integrity, canary, and
// order-matrix suites below are SIBLINGS — never nested — so the reporter
// groups them accurately and no suite depends on another's position.

// ---------------------------------------------------------------------
// Exit 0 — PASS through the real CLI child process
// ---------------------------------------------------------------------

describe('Phase 17: the five-way exit contract over the real stack', () => {
  it('exit 0 PASS: secure-mode Checkout Zero classifies PASS with a schema-valid report', async () => {
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    const ownIntent = scenario.checkoutIntentId;
    const ownSku = scenario.sku;
    const reportPath = join(workDir, 'secure-report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `expected exit 0, got ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nworkerOut:\n${workerStdout.slice(-1500)}\nworkerErr:\n${workerStderr.slice(-1500)}`,
      );
    }
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report['schemaVersion']).toBe('rupturegrid-report/v1');
    const exit = report['exit'] as Record<string, unknown>;
    expect(exit['code']).toBe(0);
    expect(exit['class']).toBe('PASS');
    // Both bound invariants actually evaluated PASS (durable truth).
    // Evaluations are per (invariant, subject) rows. Every run resets
    // the one suite scope first, so the run's evidence contains exactly
    // its own subjects; the CONTRACT is the distinct bound-key set +
    // every row PASS, never a row count.
    const evaluations = report['invariantEvaluations'] as Array<Record<string, unknown>>;
    const keys = [...new Set(evaluations.map((evaluation) => evaluation['invariantKey']))].sort();
    expect(keys).toEqual(['INV-CHK-1', 'INV-INV-1']);
    for (const evaluation of evaluations) {
      expect(evaluation['verdict']).toBe('PASS');
    }
    // Evidence chain verified and generic inspection evidence EXISTS
    // (the CLI's post-terminal capture ran against the real target).
    const integrity = report['evidenceIntegrity'] as Record<string, unknown>;
    expect(integrity['verified']).toBe(true);
    const normalizers = (report['run'] as Record<string, unknown>)['normalizerVersions'] as Array<
      Record<string, unknown>
    >;
    expect(normalizers.some((entry) => entry['name'] === GENERIC_INSPECTION_NORMALIZER_NAME)).toBe(
      true,
    );
    // The written artifact agrees with stdout (construct → validate → write).
    const written = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    expect(written['schemaVersion']).toBe('rupturegrid-report/v1');
    expect((written['exit'] as Record<string, unknown>)['class']).toBe('PASS');
    const runId = (report['run'] as Record<string, unknown>)['runId'] as string;
    expect(typeof runId).toBe('string');
    // §21 SECURE truth: the same pressure (repeat 2, concurrency 2, retry
    // NONE) yields exactly one accepted order, one reservation, and a
    // conserved stock of 0 — read from durable rows + the target's own
    // read-only inspection, never from the scenario's expectations.
    const { processingAttempts } = await expectCheckoutZeroBusinessTruth({
      runId,
      ownIntent,
      ownSku,
      expectedAcceptedOrders: 1,
      expectedAcceptedReservations: 1,
      expectedRemaining: 0,
    });
    expect([...processingAttempts.map((attempt) => attempt.outcome)].sort()).toEqual([
      'ACCEPTED',
      'INTENT_ALREADY_ACCEPTED',
    ]);
  }, 180_000);

  it('expectations are NOT truth: vulnerable expectations against secure-mode truth still exit 0', async () => {
    // The committed vulnerable scenario EXPECTS INVARIANT_FAIL; executed
    // against the SECURE target mode the DURABLE TRUTH is exactly one
    // accepted order — the classifier must return PASS (exit 0) and the
    // report must agree with truth, never with the expectation.
    const scenario = await scenarioFile('checkout-zero-vulnerable.scenario.json', (document) => {
      const steps = (document['experiment'] as Record<string, unknown>)['steps'] as Array<
        Record<string, unknown>
      >;
      const establish = steps.find((step) => step['name'] === 'establish-scenario');
      const action = establish?.['action'] as Record<string, unknown>;
      action['body'] = (action['body'] as string).replace('"mode":"VULNERABLE"', '"mode":"SECURE"');
    });
    const result = await runCli(['run', scenario.path, '--wait', '--timeout', '90s', '--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    const exit = report['exit'] as Record<string, unknown>;
    expect(exit['class']).toBe('PASS');
    expect(exit['code']).toBe(0);
  }, 180_000);

  it('exit 1 INVARIANT_FAIL: vulnerable-mode Checkout Zero fails both invariants with findings', async () => {
    const scenario = await scenarioFile('checkout-zero-vulnerable.scenario.json');
    // This run's OWN subject identities: the per-file intent plus the
    // suite-stable SKU (every run resets the suite scope first, so the
    // target holds exactly this run's business rows).
    const ownIntent = scenario.checkoutIntentId;
    const ownSku = scenario.sku;
    const reportPath = join(workDir, 'vulnerable-report.json');
    const result = await runCliWithDeterministicOversell([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    const exit = report['exit'] as Record<string, unknown>;
    expect(exit['code']).toBe(1);
    expect(exit['class']).toBe('INVARIANT_FAIL');
    // The defect's OWN subjects evaluated FAIL (durable truth of
    // THIS run's oversell). Every run resets the suite scope first, so
    // no earlier suite generation's subjects remain to confuse the
    // report; the exit contract needs ≥1 bound FAIL — asserted via
    // exit 1 above — and BOTH of this run's identities must be FAIL.
    const evaluations = report['invariantEvaluations'] as Array<Record<string, unknown>>;
    for (const key of [ownIntent, ownSku]) {
      const rows = evaluations.filter((evaluation) => evaluation['subjectKey'] === key);
      expect(rows.length, key).toBeGreaterThanOrEqual(1);
      for (const evaluation of rows) {
        expect(evaluation['verdict'], key).toBe('FAIL');
      }
    }
    // Real forensic findings exist for the real defect.
    const findings = report['findings'] as Array<Record<string, unknown>>;
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const written = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    expect((written['exit'] as Record<string, unknown>)['class']).toBe('INVARIANT_FAIL');
    // §21 VULNERABLE truth: two concurrent submissions of one intent
    // against one unit yield 2 accepted orders, 2 reservations, and a
    // remaining stock of −1 — with REAL overlap measured from
    // target-persisted timestamps (never executor optimism).
    const runId = (report['run'] as Record<string, unknown>)['runId'] as string;
    const { processingAttempts } = await expectCheckoutZeroBusinessTruth({
      runId,
      ownIntent,
      ownSku,
      expectedAcceptedOrders: 2,
      expectedAcceptedReservations: 2,
      expectedRemaining: -1,
    });
    expectTargetPersistedOverlap(processingAttempts);
    expect((report['evidenceIntegrity'] as Record<string, unknown>)['verified']).toBe(true);
  }, 180_000);

  it('exit 3 EXECUTION_FAILURE: response-loss keeps INDETERMINATE knowledge and never exits 0/1', async () => {
    const { path: scenario, responseLossCheckoutIntentId: reboundResponseLoss } =
      await scenarioFile('checkout-zero-response-loss.scenario.json');
    const reportPath = join(workDir, 'response-loss-report.json');
    const result = await runCli([
      'run',
      scenario,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    expect(result.code).toBe(3);
    // No report is emitted: there is no evaluated-truth report to give.
    await expect(readFile(reportPath, 'utf8')).rejects.toThrow();
    // DURABLE truth of the physical invocation: the truncated delivery
    // is honestly INDETERMINATE (sent-but-unknown), retried ZERO times,
    // never collapsed into success or failure (R-10).
    const runs = await prisma.experimentRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { id: true },
    });
    let verified = false;
    for (const candidate of runs.slice(0, 12)) {
      const steps = await prisma.experimentStepRun.findMany({
        where: { runId: candidate.id },
        orderBy: { sequence: 'asc' },
      });
      const faultStep = steps.find((step) => step.state === 'FAILED');
      if (faultStep !== undefined && faultStep.sideEffectKnowledge === 'INDETERMINATE') {
        expect(faultStep.attemptCount).toBe(1);
        const invocations = await prisma.stepInvocation.findMany({
          where: { stepRunId: faultStep.id },
          orderBy: { sequence: 'asc' },
        });
        expect(invocations.length).toBe(1);
        expect(invocations[0]?.sideEffectKnowledge).toBe('INDETERMINATE');
        // The mutation objectively committed on the TARGET (legitimate
        // read-only inspection — R-05 respected), under the REBOUND
        // response-loss identity.
        const response = await fetch(`${running.baseUrl}/inspection/orders`);
        const orders = (await response.json()) as Array<Record<string, unknown>>;
        expect(
          orders.some(
            (order) =>
              order['checkoutIntentId'] === reboundResponseLoss && order['status'] === 'ACCEPTED',
          ),
        ).toBe(true);
        verified = true;
        break;
      }
    }
    expect(verified).toBe(true);
  }, 180_000);

  // -------------------------------------------------------------------
  // Exit 4 — USAGE_ERROR: rejected BEFORE anything durable happens
  // -------------------------------------------------------------------

  describe('exit 4 USAGE_ERROR (nothing executes)', () => {
    it('a missing scenario file is a usage error', async () => {
      const result = await runCli(['run', join(workDir, 'nope.json'), '--wait', '--timeout', '5s']);
      expect(result.code).toBe(4);
    });

    it('an unknown target selector is a usage error with NO durable write', async () => {
      const before = await prisma.experimentDefinition.count();
      const scenario = await scenarioFile('checkout-zero-secure.scenario.json', (document) => {
        (document['target'] as Record<string, unknown>)['displayName'] =
          'no-such-target-exists-anywhere';
      });
      const result = await runCli(['run', scenario.path, '--wait', '--timeout', '5s']);
      expect(result.code).toBe(4);
      expect(await prisma.experimentDefinition.count()).toBe(before);
    });

    it('a malformed scenario is a usage error', async () => {
      const path = join(workDir, 'malformed.json');
      await writeFile(path, '{ not json', 'utf8');
      const result = await runCli(['run', path, '--wait', '--timeout', '5s']);
      expect(result.code).toBe(4);
    });

    it('--wait is mandatory in v1', async () => {
      const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
      const result = await runCli(['run', scenario.path, '--timeout', '5s']);
      expect(result.code).toBe(4);
    });

    it('replay honestly does not exist yet (Phase 18)', async () => {
      const result = await runCli(['replay']);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('Phase 18');
    });
  });
});

// ---------------------------------------------------------------------
// §20 order-independence regression (F-3): every business-scenario
// order over ONE shared Commerce target classifies from the run's OWN
// durable truth. Each run's establish step resets the one suite scope
// through the target's legitimate admin API, so every sequence below
// is hermetic no matter which suite test ran before it — file order,
// shuffle order, and scenario order are all independent kinds of
// evidence, and this suite proves the latter explicitly.
// ---------------------------------------------------------------------

describe('Phase 17 §20: Checkout Zero scenario-order independence (shared target, real CLI)', () => {
  interface GoldenRun {
    readonly scenario: ReboundScenario;
    readonly code: number;
    readonly report: Record<string, unknown>;
  }

  async function runGolden(
    source: 'checkout-zero-vulnerable.scenario.json' | 'checkout-zero-secure.scenario.json',
  ): Promise<GoldenRun> {
    const scenario = await scenarioFile(source);
    const args = ['run', scenario.path, '--wait', '--timeout', '90s', '--json'];
    // Every VULNERABLE run uses the deterministic race barrier (§15B):
    // the oversell (and therefore exit 1) is produced on EVERY run, not
    // by timing luck. SECURE runs are unaffected (no barrier).
    const result =
      source === 'checkout-zero-vulnerable.scenario.json'
        ? await runCliWithDeterministicOversell(args)
        : await runCli(args);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(
        `golden run exited ${String(result.code)} (expected 0 or 1)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return {
      scenario,
      code: result.code,
      report: JSON.parse(result.stdout) as Record<string, unknown>,
    };
  }

  function reportEvaluations(report: Record<string, unknown>): Array<Record<string, unknown>> {
    return report['invariantEvaluations'] as Array<Record<string, unknown>>;
  }

  function expectSecureRun(run: GoldenRun): void {
    expect(run.code).toBe(0);
    expect((run.report['exit'] as Record<string, unknown>)['class']).toBe('PASS');
    const evaluations = reportEvaluations(run.report);
    const keys = [...new Set(evaluations.map((entry) => entry['invariantKey']))].sort();
    expect(keys).toEqual(['INV-CHK-1', 'INV-INV-1']);
    for (const evaluation of evaluations) {
      expect(evaluation['verdict']).toBe('PASS');
    }
    expect((run.report['evidenceIntegrity'] as Record<string, unknown>)['verified']).toBe(true);
  }

  function expectVulnerableRun(run: GoldenRun): void {
    expect(run.code).toBe(1);
    expect((run.report['exit'] as Record<string, unknown>)['class']).toBe('INVARIANT_FAIL');
    const evaluations = reportEvaluations(run.report);
    for (const key of [run.scenario.checkoutIntentId, run.scenario.sku]) {
      const rows = evaluations.filter((entry) => entry['subjectKey'] === key);
      expect(rows.length, key).toBeGreaterThanOrEqual(1);
      for (const evaluation of rows) {
        expect(evaluation['verdict'], key).toBe('FAIL');
      }
    }
    expect((run.report['evidenceIntegrity'] as Record<string, unknown>)['verified']).toBe(true);
  }

  /** A G1 variant: the secure scenario with the checkout step removed. */
  async function runG1Variant(): Promise<GoldenRun> {
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json', (document) => {
      const experiment = document['experiment'] as Record<string, unknown>;
      experiment['steps'] = (experiment['steps'] as Array<Record<string, unknown>>).filter(
        (step) => step['name'] !== 'checkout-submit',
      );
      document['expectations'] = { exitClass: 'NOT_EVALUABLE' };
    });
    const result = await runCli(['run', scenario.path, '--wait', '--timeout', '90s', '--json']);
    if (result.code !== 2) {
      throw new Error(
        `G1 variant exited ${String(result.code)} (expected 2 NOT_EVALUABLE)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return {
      scenario,
      code: result.code,
      report: JSON.parse(result.stdout) as Record<string, unknown>,
    };
  }

  async function expectG1Run(run: GoldenRun): Promise<void> {
    expect(run.code).toBe(2);
    expect((run.report['exit'] as Record<string, unknown>)['class']).toBe('NOT_EVALUABLE');
    for (const evaluation of reportEvaluations(run.report)) {
      expect(evaluation['verdict']).not.toBe('FAIL');
    }
    const runId = (run.report['run'] as Record<string, unknown>)['runId'] as string;
    expect(await prisma.invariantEvaluation.count({ where: { runId, verdict: 'FAIL' } })).toBe(0);
  }

  it('SECURE alone → 0', async () => {
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
  }, 240_000);

  it('VULNERABLE alone → 1', async () => {
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
  }, 240_000);

  it('VULNERABLE → SECURE → 1 → 0', async () => {
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
  }, 300_000);

  it('SECURE → VULNERABLE → 0 → 1', async () => {
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
  }, 300_000);

  it('VULNERABLE → SECURE → SECURE → 1 → 0 → 0', async () => {
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
  }, 400_000);

  it('SECURE → VULNERABLE → SECURE → 0 → 1 → 0', async () => {
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
  }, 400_000);

  it('G1 NOT_EVALUABLE (exit 2) after SECURE', async () => {
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
    await expectG1Run(await runG1Variant());
  }, 300_000);

  it('G1 NOT_EVALUABLE (exit 2) after VULNERABLE', async () => {
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
    await expectG1Run(await runG1Variant());
  }, 300_000);

  it('G1 NOT_EVALUABLE (exit 2) after a full golden run (VULNERABLE → SECURE)', async () => {
    expectVulnerableRun(await runGolden('checkout-zero-vulnerable.scenario.json'));
    expectSecureRun(await runGolden('checkout-zero-secure.scenario.json'));
    await expectG1Run(await runG1Variant());
  }, 400_000);
});

// ---------------------------------------------------------------------
// Integrity tamper precedence + pipeline idempotence (in-process,
// against the same real stack and the running worker)
// ---------------------------------------------------------------------
describe('Phase 17: evidence integrity governs the exit (verified verifier)', () => {
  it('a tampered observation flips a would-be PASS to EXECUTION_FAILURE (rule 1 dominates)', async () => {
    // A real completed run through the accepted orchestration.
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    const { validateScenarioDocument } = await import('@rupturegrid/cli');
    const document = validateScenarioDocument(
      JSON.parse(await readFile(scenario.path, 'utf8')) as unknown,
    );
    const outcome = await executeScenario(prisma, document, {
      redisUrl: env.redisUrl,
      queuePrefix: env.queuePrefix,
      credentialPolicy,
      runTimeoutMs: 90_000,
      analysisTimeoutMs: 60_000,
      pollIntervalMs: 500,
    });
    expect(outcome.reportInput).not.toBeNull();
    expect(outcome.classification.exitClass).toBe('PASS');
    const runId = outcome.runId as string;

    // ---- The deliberate product-write bypass (VERIFIED VERIFIER): ----
    // Everything else in this suite flows through product code paths;
    // HERE the test simulates storage-level drift by tampering a real
    // raw_observation payload directly so the hash-chain verifier's
    // detection is exercised against real durable rows, not fixtures
    // (R-08). The append-only trigger correctly forbids this for every
    // product and test path, so the tamper requires an explicit DBA-level
    // trigger disable — a test-only escape hatch that is restored in a
    // finally block. No product code path can ever do this.
    const observations = await prisma.rawObservation.findMany({
      where: { runId },
      orderBy: { chainIndex: 'asc' },
    });
    expect(observations.length).toBeGreaterThan(0);
    const victim = observations[0];
    if (victim === undefined) {
      throw new Error('no observation rows to tamper');
    }
    const original = victim.payload as Record<string, unknown>;
    const tamperedPayload = { ...original, 'x-test-tamper': 'payload-mutated' };
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "evidence"."raw_observation" DISABLE TRIGGER raw_observation_append_only',
    );
    try {
      await prisma.rawObservation.update({
        where: { id: victim.id },
        data: { payload: tamperedPayload },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "evidence"."raw_observation" ENABLE TRIGGER raw_observation_append_only',
      );
    }

    const integrity = await verifyRunEvidenceChain(prisma, runId);
    expect(integrity.chainValid && integrity.contentHashesValid).toBe(false);
    expect(integrity.problems.length).toBeGreaterThan(0);

    // Frozen precedence: integrity failure DOMINATES the persisted
    // PASS verdicts — the classifier must return EXECUTION_FAILURE.
    const classification = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: false,
      subjectVerdicts: [
        {
          invariantKey: 'INV-CHK-1',
          subjectKey: 'CHK-001',
          verdict: 'PASS',
          mode: 'strict-coverage/v1',
          evaluatorVersion: 'generic-invariant/v1',
        },
        {
          invariantKey: 'INV-INV-1',
          subjectKey: 'SKU-001',
          verdict: 'PASS',
          mode: 'strict-coverage/v1',
          evaluatorVersion: 'generic-invariant/v1',
        },
      ],
      boundKeyDomains: [],
      anomalies: [],
    });
    expect(classification.exitClass).toBe('EXECUTION_FAILURE');
    expect(classification.exitCode).toBe(3);
    expect(classification.precedenceRule).toBe(1);

    // The report built from the REAL tampered-integrity verification
    // carries the real problems and the exit-3 classification.
    const report = buildReport(outcome.reportInput!, integrity as IntegrityReport, classification);
    expect(report.evidenceIntegrity.verified).toBe(false);
    expect(report.evidenceIntegrity.problems.length).toBe(integrity.problems.length);
    expect(report.exit.code).toBe(3);
  }, 240_000);

  it('analysis and forensic derivation are IDEMPOTENT over the real evidence chain', async () => {
    // Self-contained (shuffle-safe): its OWN completed PASS run through
    // the accepted in-process orchestration (the same stack the CLI
    // drives — real queue, real worker, real target), then repeated
    // derivation passes converge on identical rows. No test reads
    // another test's run id or report file.
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    const { validateScenarioDocument } = await import('@rupturegrid/cli');
    const document = validateScenarioDocument(
      JSON.parse(await readFile(scenario.path, 'utf8')) as unknown,
    );
    const outcome = await executeScenario(prisma, document, {
      redisUrl: env.redisUrl,
      queuePrefix: env.queuePrefix,
      credentialPolicy,
      runTimeoutMs: 90_000,
      analysisTimeoutMs: 60_000,
      pollIntervalMs: 500,
    });
    expect(outcome.reportInput).not.toBeNull();
    expect(outcome.classification.exitClass).toBe('PASS');
    const runId = outcome.runId as string;
    const evaluationCount = async (): Promise<number> =>
      prisma.invariantEvaluation.count({ where: { runId } });
    const findingCount = async (): Promise<number> => prisma.finding.count({ where: { runId } });
    const eventCount = async (): Promise<number> =>
      prisma.normalizedEvent.count({ where: { runId } });

    const before = {
      evaluations: await evaluationCount(),
      findings: await findingCount(),
      events: await eventCount(),
    };
    await runRunAnalysis(prisma, runId);
    await deriveRunEvidence(prisma, runId);
    await deriveRunForensics(prisma, runId);
    const afterOne = {
      evaluations: await evaluationCount(),
      findings: await findingCount(),
      events: await eventCount(),
    };
    expect(afterOne).toEqual(before);
    // A second full pass converges on exactly the same rows.
    await runRunAnalysis(prisma, runId);
    await deriveRunEvidence(prisma, runId);
    await deriveRunForensics(prisma, runId);
    const afterTwo = {
      evaluations: await evaluationCount(),
      findings: await findingCount(),
      events: await eventCount(),
    };
    expect(afterTwo).toEqual(before);
    // The chain still verifies after repeated idempotent passes.
    const integrity = await verifyRunEvidenceChain(prisma, runId);
    expect(integrity.chainValid && integrity.contentHashesValid).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------
// R-13 canary scan: no secret VALUE ever reaches the report surface
// ---------------------------------------------------------------------

describe('Phase 17: credential boundary over the report surface', () => {
  it('reports and CLI output contain no credential VALUES (names only)', async () => {
    // Self-contained (shuffle-safe): its OWN secure-mode run through the
    // real CLI child process. The written report and the machine stdout
    // carry credential reference NAMES only — never secret values.
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    const reportPath = join(workDir, 'canary-report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    expect(result.code).toBe(0);
    const reportText = await readFile(reportPath, 'utf8');
    for (const surface of [reportText, result.stdout]) {
      expect(surface).toContain(COMMERCE_SIGNING_REF); // the NAME may appear
      expect(surface).toContain(COMMERCE_ADMIN_REF);
      expect(surface).not.toContain(env.commerceSigningSecret);
      expect(surface).not.toContain(env.commerceAdminToken);
      expect(surface).not.toContain(env.demoAdminToken);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------
// Checkpoint D — report delivery failures (mission §11): a delivery
// failure is an honest EXECUTION_FAILURE (exit 3), never a business
// verdict and never exit 0; no partial artifact may become visible.
// ---------------------------------------------------------------------
describe('Phase 17 Checkpoint D: report delivery failure discipline', () => {
  it('D-25: an undeliverable report path exits 3 with no partial artifact', async () => {
    const scenario = await scenarioFile('checkout-zero-secure.scenario.json');
    // The report's parent path is a regular FILE: the atomic
    // construct → validate → write-temp → rename path cannot deliver.
    const blocker = join(workDir, `blocked-parent-${suiteToken}`);
    await writeFile(blocker, 'not a directory', 'utf8');
    const reportPath = join(blocker, 'report.json');
    const result = await runCli([
      'run',
      scenario.path,
      '--wait',
      '--timeout',
      '90s',
      '--report',
      reportPath,
      '--json',
    ]);
    // The REAL child-process exit code: infrastructure/delivery failure.
    expect(result.code).toBe(3);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string; runId: string | null; report: unknown };
    };
    expect(payload.error.code).toBe('EXECUTION_FAILURE');
    expect(payload.error.report).toBeNull();
    // No report content was emitted anywhere on stdout, and no partial
    // artifact exists at (or beside) the undeliverable path.
    expect(result.stdout).not.toContain('rupturegrid-report/v1');
    await expect(readFile(reportPath, 'utf8')).rejects.toThrow();
    // The run's durable truth is preserved: the run really executed and
    // reached COMPLETED — only the DELIVERY of its artifact failed.
    expect(typeof payload.error.runId).toBe('string');
    const run = await prisma.experimentRun.findUnique({
      where: { id: payload.error.runId as string },
      select: { state: true },
    });
    expect(run?.state).toBe('COMPLETED');
  }, 240_000);
});
