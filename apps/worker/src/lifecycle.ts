// =====================================================================
// RuptureGrid v1.0 — worker lifecycle
// =====================================================================
// The worker's real startup/shutdown sequence, factored into an
// invokable object so its genuine graceful-shutdown path is exercised
// by tests (real runtime verification) rather than assumed. On
// Windows, SIGTERM/SIGINT handlers are unreliable for processes killed
// from other processes; signals remain wired for interactive/Unix
// operation, while tests drive the same code path directly.

import { loadWorkerConfig } from '@rupturegrid/config';
import { createControlDb } from '@rupturegrid/control-db';
import { createLogger } from '@rupturegrid/logger';
import { createProducerRedis, pingRedis } from '@rupturegrid/queue';

export interface WorkerRuntime {
  /** Resolves once dependencies are verified and the ready event emitted. */
  readonly ready: Promise<void>;
  /** Real graceful shutdown: closes Redis, then the DB client. */
  shutdown(): Promise<void>;
}

export async function startWorker(): Promise<WorkerRuntime> {
  const config = loadWorkerConfig();
  const logger = createLogger({
    service: 'rupturegrid-worker',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });

  const controlDb = createControlDb(config.CONTROL_DATABASE_URL);
  const redis = createProducerRedis(config.REDIS_URL);

  const ready = (async () => {
    await controlDb.ping();
    const redisPing = await pingRedis(redis.client);
    if (!redisPing.ok) {
      throw new Error('Redis ping failed');
    }
    logger.info('worker ready', {
      queuePrefix: config.QUEUE_PREFIX,
      queueName: 'foundation-smoke',
    });
  })();

  return {
    ready,
    async shutdown() {
      await redis.close();
      await controlDb.disconnect();
      logger.info('shutdown complete');
    },
  };
}
