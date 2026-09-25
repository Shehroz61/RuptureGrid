// =====================================================================
// Integration test helpers — Phase 3 execution engine
// =====================================================================
// Real infrastructure (R-08): real Control PostgreSQL, real Redis/
// BullMQ, real HTTP against the real Demo Fintech app. No mocks for
// any infrastructure semantics.

import { createControlDb } from '@rupturegrid/control-db';
import type { PrismaClient } from '@rupturegrid/control-db';
import { registerTarget, TargetRegistrationError } from '@rupturegrid/engine';
import { loadTestEnv } from './env.js';

export type ExecutionTestEnv = ReturnType<typeof loadTestEnv>;

let cachedPrisma: PrismaClient | null = null;

/**
 * One PrismaClient per process, pointed at the real Control DB —
 * built through the same ownership-boundary factory the apps use.
 */
export function getControlPrisma(): PrismaClient {
  if (cachedPrisma === null) {
    const env = loadTestEnv();
    cachedPrisma = createControlDb(env.controlDatabaseUrl).prisma;
  }
  return cachedPrisma;
}

/**
 * Narrows an optional id for use in a typed Prisma where-clause. Fails
 * the suite with an explicit prerequisite error instead of silently
 * querying with an undefined id.
 */
export function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value === '') {
    throw new Error(`prerequisite missing: ${label} has no id`);
  }
  return value;
}

/** Poll until the predicate holds (bounded). */
export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Deterministic per-suite entity names (tests run serially). */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * A collision-free loopback ORIGIN for tests that need a registered
 * target they never actually connect to. The database previously used
 * time-bucketed ports (`39000 + Date.now() % 900`), which collide on
 * the PERSISTENT shared dev database: a later run re-buckets onto an
 * origin an earlier run already registered, and registration fails
 * (origin authority is global by design — TargetRegistrationError).
 * Uniqueness here comes from a 32-bit random component (~1 in 65k
 * collision odds per generation attempt), verified against the
 * authoritative registration BEFORE use, with bounded regeneration.
 * The security property is untouched: the origin remains a plain
 * loopback http origin the registration contract can fully validate.
 */
export async function uniqueTestOrigin(prisma: PrismaClient): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = 35000 + Math.floor(Math.random() * 20000);
    const origin = `http://127.0.0.1:${port}`;
    const clash = await prisma.targetOrigin.findUnique({ where: { origin }, select: { id: true } });
    if (clash === null) {
      return origin;
    }
  }
  throw new Error(
    'uniqueTestOrigin: could not find an unregistered loopback origin in 16 attempts',
  );
}

/**
 * Registers a LOCAL fixture target for tests that bind their HTTP
 * fixture server to an OS-EPHEMERAL port (`listen(0)`). Ephemeral ports
 * recycle across suite runs, and a registration from an earlier run
 * survives on the persistent shared dev DB — so plain registration is
 * itself a collision-flake (origin authority is global by design).
 * On TargetRegistrationError the suite's EXISTING registration for
 * that exact origin is reused; any other error propagates. Global
 * uniqueness is never bypassed or weakened: two different targets can
 * still never hold one origin.
 */
export async function registerLocalFixtureTarget(
  prisma: PrismaClient,
  displayName: string,
  fixtureOrigin: string,
): Promise<string> {
  try {
    const registered = await registerTarget(prisma, {
      displayName,
      environment: 'LOCAL_DEVELOPMENT',
      origins: [fixtureOrigin],
      contractKind: 'GENERIC_HTTP',
    });
    return registered.targetId;
  } catch (error) {
    if (error instanceof TargetRegistrationError) {
      const existing = await prisma.targetRegistration.findFirstOrThrow({
        where: { origins: { some: { origin: fixtureOrigin } } },
      });
      return existing.id;
    }
    throw error;
  }
}
