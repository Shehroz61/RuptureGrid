// =====================================================================
// Integration test helpers — Phase 3 execution engine
// =====================================================================
// Real infrastructure (R-08): real Control PostgreSQL, real Redis/
// BullMQ, real HTTP against the real Demo Fintech app. No mocks for
// any infrastructure semantics.

import { createControlDb } from '@rupturegrid/control-db';
import type { PrismaClient } from '@rupturegrid/control-db';
import { loadTestEnv } from './env.js';

export interface ExecutionTestEnv extends ReturnType<typeof loadTestEnv> {}

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
