import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HEALTH_OPTIONS, HealthController } from './health/health.controller.js';
import { EXECUTION_OPTIONS, ExecutionController } from './execution/execution.controller.js';
import { EVIDENCE_OPTIONS, EvidenceController } from './evidence/evidence.controller.js';
import {
  FORENSICS_OPTIONS,
  ForensicsController,
  FindingsIndexController,
} from './forensics/forensics.controller.js';
import type { ApiConfig } from '@rupturegrid/config';
import type { ControlDb } from '@rupturegrid/control-db';

export interface AppModuleOptions {
  readonly config: ApiConfig;
  readonly controlDb: ControlDb;
}

/** Builds the configured root module for the API process. */
export function buildAppModule(options: AppModuleOptions) {
  @Module({
    controllers: [
      HealthController,
      ExecutionController,
      EvidenceController,
      FindingsIndexController,
      ForensicsController,
    ],
    providers: [
      {
        provide: HEALTH_OPTIONS,
        useValue: {
          controlDb: options.controlDb,
          redisUrl: options.config.REDIS_URL,
        },
      },
      {
        provide: EXECUTION_OPTIONS,
        useValue: {
          controlDb: options.controlDb,
          redisUrl: options.config.REDIS_URL,
          queuePrefix: options.config.QUEUE_PREFIX,
        },
      },
      {
        provide: EVIDENCE_OPTIONS,
        useValue: {
          controlDb: options.controlDb,
        },
      },
      {
        provide: FORENSICS_OPTIONS,
        useValue: {
          controlDb: options.controlDb,
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

export { HealthController };
