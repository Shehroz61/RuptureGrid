// =====================================================================
// Integration test helpers — Phase 3 execution engine
// =====================================================================
// Real infrastructure (R-08): real Control PostgreSQL, real Redis/
// BullMQ, real HTTP against the real Demo Fintech app. No mocks for
// any infrastructure semantics.

import { createControlDb } from '@rupturegrid/control-db';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';
import { EXECUTOR_SIGNING_CREDENTIAL_REFS } from '@rupturegrid/config';
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
 *
 * This allocator returns only UNBOUND origins; it never returns a target
 * ID. Live reusable fixtures use createOwnedControlFixture instead. A
 * registration clash must fail rather than adopting another target ID.
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
 * Phase 16 (ADR-0024 §54 discipline): builds the SERVER-OWNED test
 * authorization policy for a specific registered origin set. The TEST
 * constructs this policy from the platform side — the registration
 * REQUEST still supplies only names, and the origin grant here is
 * deliberately scoped to the exact normalized origins passed in. No
 * localhost wildcard exists, no "LOCAL_DEVELOPMENT means all refs"
 * shortcut exists: every grant is explicit, per-origin, name-only.
 */
export function testTargetOriginCredentialPolicy(
  originRefs: Readonly<Record<string, readonly string[]>>,
): TargetOriginCredentialPolicy {
  return {
    signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
    originGrants: Object.fromEntries(
      Object.entries(originRefs).map(([origin, refs]) => [origin, [...refs]]),
    ),
  };
}
