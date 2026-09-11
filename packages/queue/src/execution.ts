// =====================================================================
// RuptureGrid v1.0 — execution queue (BullMQ, coordination only)
// =====================================================================
// Job payloads carry DURABLE IDENTIFIERS ONLY (ADR-0003 §9): runId,
// stepRunId, sequence. No experiment definitions, no mutable run
// state, no secrets — the worker loads authoritative state from
// PostgreSQL. The jobId is DETERMINISTIC from durable step identity,
// so BullMQ deduplicates coordination for the same step; PostgreSQL
// claims remain the correctness authority even when duplicates are
// delivered deliberately (Phase 3 §43/§44).

import { createHash } from 'node:crypto';
import { EXECUTION_QUEUE_NAME } from '@rupturegrid/shared';
import { Queue, Worker } from 'bullmq';
import type { RedisConnection } from './connection.js';
import { createProducerRedis, createWorkerRedis } from './connection.js';

export interface ExecutionJobPayload {
  readonly runId: string;
  readonly stepRunId: string;
  readonly sequence: number;
}

/**
 * Deterministic BullMQ jobId for a durable step identity. Colon-free
 * (BullMQ 6 rejects ':' in custom ids) and stable across processes.
 */
export function executionJobId(stepRunId: string): string {
  return `step-${createHash('sha256').update(stepRunId).digest('hex').slice(0, 40)}`;
}

export interface ExecutionQueueOptions {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly maxAttempts?: number;
}

export interface ExecutionQueue {
  /** Enqueues one step job. Idempotent per step via deterministic jobId. */
  enqueueStep(payload: ExecutionJobPayload): Promise<void>;
  /** Marks enqueue failure durably (called by dispatchers on failure). */
  close(): Promise<void>;
}

export function createExecutionQueue(options: ExecutionQueueOptions): ExecutionQueue {
  const producer: RedisConnection = createProducerRedis(options.redisUrl);
  void producer.waitUntilReady(10_000).catch(() => {
    // First actual command surfaces the outage; see foundation queue.
  });
  const queue = new Queue(EXECUTION_QUEUE_NAME, {
    connection: producer.client,
    prefix: options.prefix,
    defaultJobOptions: {
      attempts: options.maxAttempts ?? 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 3600, count: 1000 },
    },
  });

  return {
    async enqueueStep(payload) {
      // Fail fast: enableOfflineQueue is false on the producer
      // connection, so an outage REJECTS here instead of silently
      // buffering — the caller records durable dispatch state.
      await producer.waitUntilReady(10_000);
      await queue.add('execute-step', payload, {
        jobId: executionJobId(payload.stepRunId),
      });
    },
    async close() {
      await queue.close();
      await producer.close();
    },
  };
}

export interface ExecutionWorkerHandle {
  readonly close: () => Promise<void>;
}

export interface StartExecutionWorkerOptions {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly concurrency: number;
  readonly processJob: (payload: ExecutionJobPayload) => Promise<void>;
  /**
   * BullMQ stalled-job check interval (ms). The default 30s is right
   * for production; tests with short leases override it so a hung
   * job is not re-delivered mid-test (PostgreSQL fencing remains the
   * correctness authority — this only reduces coordination noise).
   */
  readonly stalledIntervalMs?: number;
}

/**
 * Starts the BullMQ consumer for the execution queue. The processJob
 * callback receives IDs ONLY and must load authoritative state from
 * PostgreSQL (ADR-0003 §9).
 */
export function startExecutionWorker(options: StartExecutionWorkerOptions): ExecutionWorkerHandle {
  const connection: RedisConnection = createWorkerRedis(options.redisUrl);
  const worker = new Worker<ExecutionJobPayload>(
    EXECUTION_QUEUE_NAME,
    async (job) => {
      await options.processJob(job.data);
    },
    {
      connection: connection.client,
      prefix: options.prefix,
      concurrency: options.concurrency,
      ...(options.stalledIntervalMs === undefined
        ? {}
        : { stalledInterval: options.stalledIntervalMs }),
    },
  );

  // Surface unexpected worker loop failures without crashing the
  // process on lifecycle rejections (close() interrupts run()).
  void worker.run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('already running')) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  });

  return {
    async close() {
      await worker.close();
      await connection.close();
    },
  };
}
