import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HEALTH_OPTIONS, HealthController } from './health/health.controller.js';
import type { ApiConfig } from '@rupturegrid/config';
import type { ControlDb } from '@rupturegrid/control-db';

export interface AppModuleOptions {
  readonly config: ApiConfig;
  readonly controlDb: ControlDb;
}

/** Builds the configured root module for the API process. */
export function buildAppModule(options: AppModuleOptions) {
  @Module({
    controllers: [HealthController],
    providers: [
      {
        provide: HEALTH_OPTIONS,
        useValue: {
          controlDb: options.controlDb,
          redisUrl: options.config.REDIS_URL,
        },
      },
    ],
  })
  class ConfiguredAppModule {}

  return ConfiguredAppModule;
}

/** Closes all process-owned resources (called on graceful shutdown). */
export async function closeResources(app: INestApplication): Promise<void> {
  const controller = app.get(HealthController);
  await controller.close();
}
