import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createProducerRedis } from '@rupturegrid/queue';
import type { RedisConnection } from '@rupturegrid/queue';
import type { ControlDb } from '@rupturegrid/control-db';

/** DI token for the health controller's owned dependencies. */
export const HEALTH_OPTIONS = Symbol('health-options');

export interface HealthControllerOptions {
  readonly controlDb: ControlDb;
  readonly redisUrl: string;
}

@Controller()
export class HealthController {
  private readonly controlDb: ControlDb;
  private readonly redis: RedisConnection;

  public constructor(@Inject(HEALTH_OPTIONS) options: HealthControllerOptions) {
    this.controlDb = options.controlDb;
    this.redis = createProducerRedis(options.redisUrl);
  }

  /**
   * Liveness: the process event loop is alive. It must NOT fail merely
   * because Redis/PostgreSQL is down.
   */
  @Get('/health/live')
  public live() {
    return { status: 'live', service: 'rupturegrid-api' };
  }

  /**
   * Readiness: the API can currently serve its owned responsibilities.
   * Verifies ONLY the dependencies the API owns: Control PostgreSQL and
   * Redis. The Demo Fintech database is deliberately NOT checked — it
   * does not belong to the Control Plane (ADR-0002).
   */
  @Get('/health/ready')
  public async ready(@Res() response: Response) {
    const checks: Record<string, string> = {};

    try {
      await this.controlDb.ping();
      checks.controlPostgres = 'ok';
    } catch {
      checks.controlPostgres = 'unavailable';
    }

    try {
      await this.redis.client.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'unavailable';
    }

    const ready = checks.controlPostgres === 'ok' && checks.redis === 'ok';
    response
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not_ready', service: 'rupturegrid-api', checks });
  }

  /** Closes the Redis connection owned by this controller. */
  public async close(): Promise<void> {
    await this.redis.close();
  }
}
