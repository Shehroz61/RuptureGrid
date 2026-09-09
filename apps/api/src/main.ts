import { NestFactory } from '@nestjs/core';
import { json as expressJson, urlencoded as expressUrlencoded } from 'express';
import { createControlDb } from '@rupturegrid/control-db';
import type { ControlDb } from '@rupturegrid/control-db';
import { loadConfig } from './config.js';
import { createServiceLogger } from './logger.js';
import { buildAppModule, closeResources } from './app.module.js';

async function main(): Promise<void> {
  // Fail fast on invalid/missing configuration before any resource opens.
  const config = loadConfig();
  const logger = createServiceLogger(config);

  const controlDb: ControlDb = createControlDb(config.CONTROL_DATABASE_URL);
  const app = await NestFactory.create(buildAppModule({ config, controlDb }), {
    logger: false,
  });

  // Conservative HTTP hygiene: no CORS * with credentials, bounded bodies.
  app.use(expressJson({ limit: '256kb' }));
  app.use(expressUrlencoded({ extended: true, limit: '256kb' }));

  const origins: readonly string[] = config.CORS_ORIGINS;
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (origin === undefined || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed'));
      }
    },
    credentials: false,
  });

  await app.listen(config.API_PORT, config.API_HOST);

  logger.info('api started', {
    host: config.API_HOST,
    port: config.API_PORT,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      await app.close();
      await closeResources(app);
      await controlDb.disconnect();
      logger.info('shutdown complete');
    } catch (error) {
      logger.error('shutdown error', { error: String(error) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`API failed to start: ${message}`);
  process.exit(1);
});
