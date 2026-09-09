// =====================================================================
// RuptureGrid v1.0 — Redis connection factory
// =====================================================================
// Centralizes Redis construction so applications never reconstruct
// Redis URLs in multiple places (Phase 1 spec §51). BullMQ 6 treats
// ioredis as an optional peer dependency: we create the raw ioredis
// client here and pass it to BullMQ. Worker connections REQUIRE
// maxRetriesPerRequest: null (official BullMQ contract) so a worker
// keeps retrying while Redis is briefly unreachable.

import { Redis } from 'ioredis';

export interface RedisConnection {
  /** Raw ioredis client. */
  readonly client: Redis;
  /**
   * Bounded wait until the connection is established and the server is
   * ready for commands. Required before the first command on a
   * fail-fast (enableOfflineQueue: false) connection.
   */
  waitUntilReady(timeoutMs: number): Promise<void>;
  /** Gracefully closes the connection (ioredis quit). */
  close(): Promise<void>;
}

function attachReadyWait(client: Redis): RedisConnection['waitUntilReady'] {
  return (timeoutMs: number) => {
    if (client.status === 'ready') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis connection not ready within ${timeoutMs}ms`));
      }, timeoutMs);
      function cleanup(): void {
        clearTimeout(timer);
        client.off('ready', onReady);
        client.off('error', onError);
      }
      function onReady(): void {
        cleanup();
        resolve();
      }
      function onError(error: Error): void {
        cleanup();
        reject(error);
      }
      client.once('ready', onReady);
      client.once('error', onError);
    });
  };
}

/**
 * Creates a Redis connection for queue producers, health checks, and
 * readiness probes. Semantics per BullMQ guidance + ADR-0003:
 * - enableOfflineQueue: false → commands REJECT immediately while the
 *   connection is down, so enqueue failures and readiness degradation
 *   are VISIBLE instead of silently buffered (a run that cannot be
 *   enqueued must stay DISPATCHING in PostgreSQL, never vanish into a
 *   Redis offline queue).
 * - maxRetriesPerRequest: 1 → a command fails within seconds of an
 *   outage rather than retrying ~20 times.
 * Call waitUntilReady() before the first command on a fresh connection.
 */
export function createProducerRedis(url: string): RedisConnection {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3_000,
  });
  // ioredis emits 'error' on connection drops; without a listener Node
  // treats it as an unhandled 'error' event and CRASHES the process.
  // Outages are expected and are surfaced where they matter — command
  // rejections (enqueue failures, readiness probes) — so the listener
  // here only prevents the default crash.
  client.on('error', () => {});
  return {
    client,
    waitUntilReady: attachReadyWait(client),
    async close() {
      // Graceful quit when the connection is alive; force-disconnect
      // when it is already broken (quit() would itself need to send a
      // command, which fails with enableOfflineQueue: false).
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

/**
 * Creates a Redis connection for queue consumers (Worker). The worker
 * must survive temporary Redis outages, so maxRetriesPerRequest is
 * null per the BullMQ worker contract.
 */
export function createWorkerRedis(url: string): RedisConnection {
  const client = new Redis(url, { maxRetriesPerRequest: null });
  client.on('error', () => {});
  return {
    client,
    waitUntilReady: attachReadyWait(client),
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
