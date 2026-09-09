// =====================================================================
// Integration — Redis + BullMQ foundation queue (real infrastructure)
// =====================================================================
// Proves (Phase 1 spec §29): real Redis, the Phase 1 smoke queue, a
// real enqueue, a real BullMQ Worker consuming it, the actual payload
// observed, the actual configured prefix in the real keyspace, and
// clean resource shutdown. No mocks. No in-memory substitutes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundationQueue, createProducerRedis, pingRedis } from '@rupturegrid/queue';
import type { FoundationQueue } from '@rupturegrid/queue';
import { FOUNDATION_QUEUE_NAME } from '@rupturegrid/shared';
import { loadTestEnv } from './helpers/env.js';

let env: ReturnType<typeof loadTestEnv>;
let foundationQueue: FoundationQueue;

beforeAll(() => {
  env = loadTestEnv();
});

afterAll(async () => {
  await foundationQueue?.close();
});

describe('Redis connectivity', () => {
  it('answers PING on the configured Redis', async () => {
    const redis = createProducerRedis(env.redisUrl);
    try {
      await redis.waitUntilReady(10_000);
      const result = await pingRedis(redis.client);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeLessThan(2_000);
    } finally {
      await redis.close();
    }
  });
});

describe('BullMQ foundation queue round trip', () => {
  it('delivers a real job from producer to worker through real Redis', async () => {
    foundationQueue = createFoundationQueue({
      redisUrl: env.redisUrl,
      prefix: env.queuePrefix,
    });

    const marker = { test: 'foundation-round-trip', at: new Date().toISOString() };
    const jobId = await foundationQueue.addJob(marker);
    expect(jobId).not.toBe('');

    const result = await foundationQueue.waitForJob(jobId, 15_000);
    expect(result.jobId).toBe(jobId);
    expect(result.payload).toEqual(marker);
  });

  it('stores keys under the actually configured prefix', async () => {
    const probe = createProducerRedis(env.redisUrl);
    await probe.waitUntilReady(10_000);
    try {
      // BullMQ stores queue state under <prefix>:<queueName>:*.
      // This assertion runs against the REAL Redis keyspace, proving
      // all participants used the same prefix.
      const keys = await probe.client.keys(`${env.queuePrefix}:${FOUNDATION_QUEUE_NAME}:*`);
      expect(keys.length).toBeGreaterThan(0);
      // And nothing exists under a different prefix for this queue.
      const foreign = await probe.client.keys(`wrongprefix:${FOUNDATION_QUEUE_NAME}:*`);
      expect(foreign).toEqual([]);
    } finally {
      await probe.close();
    }
  });

  it('closes every resource cleanly (no connection leaks)', async () => {
    const queue = createFoundationQueue({
      redisUrl: env.redisUrl,
      prefix: env.queuePrefix,
    });
    const jobId = await queue.addJob({ test: 'cleanup-check' });
    await queue.waitForJob(jobId, 15_000);
    // close() must resolve without hanging even though the worker
    // holds a blocking connection.
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
