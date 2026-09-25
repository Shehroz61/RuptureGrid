// =====================================================================
// RuptureGrid v1.0 — golden scenario readiness checks (Phase 7)
// =====================================================================
// Prerequisites of the golden run, each verified against REAL state —
// never assumed (incident-replay §8: wrong/unreachable target fails
// the run BEFORE any experiment delivery occurs). Local-development
// only (R-14): the runner refuses any non-LOCAL_DEVELOPMENT target.
//
// Checks (all pass/fail, honest messages, no invented values):
//   1. Control PostgreSQL reachable (durable truth owns the run).
//   2. Redis reachable (coordination available; its loss would only
//      defer dispatch to reconciliation — still verified up front).
//   3. Registered target exists with a LOCAL_DEVELOPMENT environment.
//   4. Demo Target answers /health/ready over real HTTP.
//   5. Demo Target admin status answers (the mode step's interface).
//
// Credential VALUES are never part of readiness output (ADR-0012).

import { connect } from 'node:net';
import type { NetConnectOpts, TcpSocketConnectOpts } from 'node:net';
import { URL } from 'node:url';
import type { PrismaClient } from '@rupturegrid/control-db';

export class ReadinessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReadinessError';
  }
}

export interface ReadinessReport {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
  }>;
  readonly ok: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded real-TCP reachability probe (no shell, no invented latency). */
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port } as TcpSocketConnectOpts & NetConnectOpts);
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function urlHostPort(rawUrl: string): { host: string; port: number } {
  const parsed = new URL(rawUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 5432)),
  };
}

/**
 * Verifies every prerequisite. Throws ReadinessError on the FIRST
 * failed check so the failure is actionable, and returns the full
 * report otherwise. `origin` is the registered target origin the run
 * will execute against (frozen in the snapshot).
 */
export async function verifyGoldenReadiness(
  prisma: PrismaClient,
  input: { readonly targetId: string; readonly origin: string; readonly redisUrl: string },
): Promise<ReadinessReport> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Control PostgreSQL — real query against the durable store.
  const controlOk = await prisma.$queryRaw`SELECT 1 AS ok`.then(() => true).catch(() => false);
  checks.push({
    name: 'control-postgres',
    ok: controlOk,
    detail: controlOk ? 'reachable' : 'Control PostgreSQL is not reachable',
  });

  // 2. Redis — real TCP probe of the coordination store.
  const redis = urlHostPort(input.redisUrl);
  const redisOk = await tcpReachable(redis.host, redis.port, 2_000);
  checks.push({
    name: 'redis',
    ok: redisOk,
    detail: redisOk ? 'reachable' : `Redis is not reachable at ${redis.host}:${redis.port}`,
  });

  // 3. Registered target, LOCAL_DEVELOPMENT only (R-14).
  const target = await prisma.targetRegistration.findUnique({
    where: { id: input.targetId },
    include: { origins: true },
  });
  const targetOk =
    target !== null &&
    target.environment === 'LOCAL_DEVELOPMENT' &&
    target.origins.some((entry) => entry.origin === input.origin);
  checks.push({
    name: 'target-registration',
    ok: targetOk,
    detail: targetOk
      ? `target ${input.targetId} registered LOCAL_DEVELOPMENT with origin ${input.origin}`
      : `target ${input.targetId} must be a registered LOCAL_DEVELOPMENT target with origin ${input.origin}`,
  });
  if (!targetOk) {
    throw new ReadinessError(checks.find((check) => !check.ok)?.detail ?? 'readiness failed');
  }

  // 4. Demo Target readiness endpoint — real HTTP GET (unauthenticated).
  let demoReady = false;
  let demoReadyDetail: string;
  try {
    const response = await fetch(`${input.origin}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body: unknown = await response.json().catch(() => null);
    demoReady = response.ok && isRecord(body) && body['status'] === 'ready';
    demoReadyDetail = demoReady
      ? `${input.origin}/health/ready → 200 ready`
      : `${input.origin}/health/ready → HTTP ${response.status}`;
  } catch (error) {
    demoReadyDetail = `${input.origin}/health/ready → ${
      error instanceof Error ? error.message : 'unreachable'
    }`;
  }
  checks.push({ name: 'demo-target-ready', ok: demoReady, detail: demoReadyDetail });

  // 5. Admin status endpoint — the legitimate interface the mode step
  // will use. Probed WITHOUT credentials here (a 401 proves the route
  // is served; presenting the credential value is execution's business).
  let adminServed = false;
  let adminDetail: string;
  try {
    const response = await fetch(`${input.origin}/demo/admin/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    adminServed = response.status === 401 || response.status === 200;
    adminDetail = adminServed
      ? `${input.origin}/demo/admin/status served (HTTP ${response.status})`
      : `${input.origin}/demo/admin/status → unexpected HTTP ${response.status}`;
  } catch (error) {
    adminDetail = `${input.origin}/demo/admin/status → ${
      error instanceof Error ? error.message : 'unreachable'
    }`;
  }
  checks.push({ name: 'demo-target-admin', ok: adminServed, detail: adminDetail });

  const failed = checks.find((check) => !check.ok);
  if (failed !== undefined) {
    throw new ReadinessError(failed.detail);
  }
  return { checks, ok: true };
}
