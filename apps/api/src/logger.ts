import { createLogger } from '@rupturegrid/logger';
import type { ApiConfig } from '@rupturegrid/config';

export function createServiceLogger(config: ApiConfig) {
  return createLogger({
    service: 'rupturegrid-api',
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
  });
}
