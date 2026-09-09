// =====================================================================
// RuptureGrid v1.0 — foundation queue integration
// =====================================================================
// Proves the BullMQ wiring against real Redis: a queue with a stable
// key prefix and a worker that consumes it. This is the Phase 1 smoke
// queue only — NOT an experiment queue (Phase 3). The payload is a
// harmless marker, never business state; Redis remains coordination-
// only (ADR-0003).
//
// Completion is observed by BOUNDED POLLING of authoritative BullMQ
// state (the completed/failed sets in Redis), never by fixed sleeps
// (testing-strategy §6).

import { FOUNDATION_QUEUE_NAME } from '@rupturegrid/shared';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createProducerRedis, createWorkerRedis } from './connection.js';
import type { RedisConnection } from './connection.js';

export interface FoundationQueueOptions {
  readonly redisUrl: string;
  readonly prefix: string;
}

export interface FoundationJobResult {
  readonly jobId: string;
  readonly payload: unknown;
}

export interface FoundationQueue {
  /** Enqueues one harmless marker job. Returns its BullMQ job id. */
  addJob(payload: unknown): Promise<string>;
  /**
   * Bounded-poll until the job with the given id reaches a terminal
   * state. Resolves with the job's original payload; rejects if the
   * job failed or the deadline passes.
   */
  waitForJob(jobId: string, timeoutMs: number): Promise<FoundationJobResult>;
  /** Closes worker, queue, and all Redis connections. */
  close(): Promise<void>;
}

const POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFoundationQueue(options: FoundationQueueOptions): FoundationQueue {
  const producer: RedisConnection = createProducerRedis(options.redisUrl);
  void producer.waitUntilReady(10_000).catch(() => {
    // The connection failure surfaces on the first actual queue
    // operation; here we only prevent an unhandled rejection.
  });
  const queue = new Queue(FOUNDATION_QUEUE_NAME, {
    connection: producer.client,
    prefix: options.prefix,
  });

  const workerConnection: RedisConnection = createWorkerRedis(options.redisUrl);
  const worker = new Worker(
    FOUNDATION_QUEUE_NAME,
    async (job) => {
      // Foundation processor: observe the payload, nothing else.
      return { payload: job.data };
    },
    {
      connection: workerConnection.client,
      prefix: options.prefix,
    },
  );

  // Start consuming immediately in the background. BullMQ rejects the
  // run() promise when close() interrupts the run loop; that lifecycle
  // rejection is expected and deliberately swallowed here (close() is
  // the authoritative shutdown signal). Any other failure is surfaced
  // through an unhandled-rejection-safe path.
  void worker.run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('already running')) {
      // Re-throw asynchronously so real failures are still visible.
      setTimeout(() => {
        throw error;
      }, 0);
    }
  });

  return {
    async addJob(payload) {
      // Ensure the connection is established before the first command
      // (fail-fast producer semantics — see createProducerRedis).
      await producer.waitUntilReady(10_000);
      const job = await queue.add('foundation-smoke', payload);
      return job.id ?? '';
    },
    async waitForJob(jobId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const completed = await queue.getJobs('completed');
        const completedJob = completed.find((job) => job.id === jobId);
        if (completedJob !== undefined) {
          return { jobId, payload: completedJob.data };
        }

        const failed = await queue.getJobs('failed');
        const failedJob = failed.find((job) => job.id === jobId);
        if (failedJob !== undefined) {
          throw new Error(`Foundation job failed: ${failedJob.failedReason ?? 'unknown reason'}`);
        }

        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(`Foundation job ${jobId} did not complete within ${timeoutMs}ms`);
    },
    async close() {
      await worker.close();
      await queue.close();
      await producer.close();
      await workerConnection.close();
    },
  };
}

export interface RedisPingResult {
  ok: boolean;
  latencyMs?: number;
}

/** Direct Redis ping used by readiness checks and tests. */
export async function pingRedis(redis: Redis): Promise<RedisPingResult> {
  const started = Date.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false };
  }
}
