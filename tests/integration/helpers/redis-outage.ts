// =====================================================================
// Integration test helpers — Redis outage control (portability repair)
// =====================================================================
// One shared abstraction for every test that must take the shared Redis
// DOWN and bring it back UP (R-03: the outage is real — the real Redis
// binary really stops; no mocks). Two explicit, mutually exclusive
// control modes:
//
//   1. EXPLICIT CONTAINER MODE (CI): RUPTUREGRID_TEST_REDIS_CONTAINER_ID
//      carries the exact container ID of the Redis service container
//      BELONGING TO THE CURRENT JOB (GitHub Actions exports
//      ${{ job.services.redis.id }} — official job-context semantics,
//      docs.github.com "Contexts reference"). All control is by that
//      exact ID; the helper never touches any other container.
//
//   2. LOCAL COMPOSE MODE (default): the repo's own compose project is
//      located by compose LABELS — never by a guessed name — so a
//      developer machine with compose's non-default naming, or any
//      foreign/unrelated Redis containers, is never touched. If the
//      exact project Redis container is not found, the helper fails
//      closed with an actionable error (silent success on a wrong
//      target is the defect class this helper exists to prevent).
//
// Both outage tests (api-health, redis-outage-reconciliation) share
// this one implementation; there is no per-test container-control
// logic left. Integration suites already run with fileParallelism:false,
// so the bounded shared-Redis outage model is preserved.

import { execFileSync } from 'node:child_process';
import { getTestRedisContainerId } from './env.js';

/** Compose project name (compose.yaml `name:` — stable, not machine-specific). */
const COMPOSE_PROJECT = 'rupturegrid';

/** docker CLI wrapper: no shell, real stderr on failure, bounded. */
function runDocker(args: readonly string[]): string {
  return execFileSync('docker', [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
    shell: false,
  });
}

/**
 * Resolves the EXACT Redis container this process may control:
 * explicit ID wins (CI mode); otherwise the compose project's redis
 * service container found by label (local mode). Throws when no
 * unambiguous exact target exists — it never guesses.
 */
function resolveRedisContainer(): string {
  const explicit = getTestRedisContainerId();
  if (explicit !== null) {
    return explicit;
  }
  const out = runDocker([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--filter',
    'label=com.docker.compose.service=redis',
    '--filter',
    'status=running',
    '--format',
    '{{.ID}}',
  ]);
  const ids = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (ids.length === 1) {
    return ids[0] as string;
  }
  if (ids.length === 0) {
    throw new Error(
      `redis-outage helper: no running redis container found for compose project ` +
        `"${COMPOSE_PROJECT}". Start the repo infrastructure first ` +
        '(pnpm infra:up), or set RUPTUREGRID_TEST_REDIS_CONTAINER_ID to the ' +
        'exact container ID to control in CI.',
    );
  }
  throw new Error(
    `redis-outage helper: ambiguous target — ${ids.length} redis containers match ` +
      `compose project "${COMPOSE_PROJECT}" (${ids.join(', ')}). Refusing to guess; ` +
      'set RUPTUREGRID_TEST_REDIS_CONTAINER_ID to the exact container ID.',
  );
}

export interface RedisOutageControl {
  /** Stops ONLY the resolved exact Redis container. */
  stop(): void;
  /** Starts ONLY the resolved exact Redis container. */
  start(): void;
  /** True iff the resolved container answers `redis-cli ping`. */
  reachable(): boolean;
  /** The exact container ID every command targets. */
  readonly containerId: string;
}

/**
 * Resolves the exact Redis container once per suite and returns the
 * bounded control surface. The target is explicit by construction:
 * every docker command below carries the same resolved ID.
 */
export function redisOutageControl(): RedisOutageControl {
  const containerId = resolveRedisContainer();

  return {
    containerId,
    stop(): void {
      runDocker(['stop', containerId]);
    },
    start(): void {
      runDocker(['start', containerId]);
    },
    reachable(): boolean {
      try {
        runDocker(['exec', containerId, 'redis-cli', 'ping']);
        return true;
      } catch {
        return false;
      }
    },
  };
}
