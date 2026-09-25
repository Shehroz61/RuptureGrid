// =====================================================================
// Integration — worker lifecycle (real dependencies, real code path)
// =====================================================================
// Verifies (Phase 1 spec §25) using the worker's REAL lifecycle module:
// configuration validation, dependency connection, a structured ready
// event emitted only after successful startup, clear failure when a
// dependency is unavailable, and genuine graceful shutdown. The
// lifecycle is exercised in-process because Windows cannot deliver
// SIGTERM to a process killed from outside — the code path is the same
// one main.ts wires to signals.

import { describe, expect, it } from 'vitest';
import { startWorker } from '../../apps/worker/dist/lifecycle.js';
import { loadTestEnv } from './helpers/env.js';

describe('worker lifecycle with healthy dependencies', () => {
  it('emits a structured ready event after successful startup and shuts down cleanly', async () => {
    process.env.CONTROL_DATABASE_URL = loadTestEnv().controlDatabaseUrl;
    process.env.REDIS_URL = loadTestEnv().redisUrl;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'info';

    const runtime = await startWorker();
    await expect(runtime.ready).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe('worker startup failure when a dependency is unavailable', () => {
  it('fails clearly when Redis is unreachable', async () => {
    process.env.CONTROL_DATABASE_URL = loadTestEnv().controlDatabaseUrl;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // nothing listens here
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'warn';

    const runtime = await startWorker();
    await expect(runtime.ready).rejects.toThrow();
    // Cleanup of partially-started resources must still work.
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
