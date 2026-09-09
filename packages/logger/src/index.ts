// =====================================================================
// RuptureGrid v1.0 — structured logging
// =====================================================================
// Machine-readable JSON logs with stable fields (level, time, msg,
// service, environment). Every structured payload is redacted before it
// reaches the sink (AGENTS R-13, ADR-0012): sensitive keys are masked
// by name and credential-bearing URL strings are redacted wherever they
// appear.

import { maskSensitiveFields } from '@rupturegrid/shared';
import pino from 'pino';

export interface LoggerOptions {
  /** Canonical service name, e.g. 'rupturegrid-api'. */
  readonly service: string;
  /** Runtime environment, e.g. 'development'. */
  readonly environment: string;
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface RuptureGridLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Creates a structured logger. All payloads are redacted before
 * emission; never pass raw secrets or connection strings to a logger.
 */
export function createLogger(options: LoggerOptions): RuptureGridLogger {
  const logger = pino({
    level: options.level ?? 'info',
    base: {
      service: options.service,
      environment: options.environment,
    },
  });

  function emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const payload = maskSensitiveFields(data ?? {});
    if (typeof payload === 'object' && payload !== null) {
      logger[level](payload, message);
    } else {
      logger[level](message);
    }
  }

  return {
    debug: (message, data) => emit('debug', message, data),
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
  };
}
