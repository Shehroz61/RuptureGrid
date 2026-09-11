import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig, pickRuptureGridEnv } from '@rupturegrid/config';
import { apiConfigSchema, demoConfigSchema, workerConfigSchema } from '@rupturegrid/config';

const VALID_API_ENV = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  API_HOST: '127.0.0.1',
  API_PORT: '3001',
  CONTROL_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5443/db',
  REDIS_URL: 'redis://127.0.0.1:6380',
  QUEUE_PREFIX: 'rupturegrid',
  CORS_ORIGINS: 'http://localhost:3000',
};

const VALID_WORKER_ENV = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  CONTROL_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5443/db',
  REDIS_URL: 'redis://127.0.0.1:6380',
  QUEUE_PREFIX: 'rupturegrid',
};

const VALID_DEMO_ENV = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  DEMO_HOST: '127.0.0.1',
  DEMO_PORT: '3002',
  DEMO_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5444/demo',
  DEMO_ADMIN_TOKEN: 'demo-admin-dev-token-0001',
  DEMO_INSPECTION_TOKEN: 'demo-inspection-dev-token-0001',
  DEMO_PROVIDER_SIGNING_SECRET: 'demo-provider-signing-secret-0001',
};

describe('config validation — success', () => {
  it('accepts a valid API environment', () => {
    const config = loadConfig(apiConfigSchema, VALID_API_ENV);
    expect(config.API_PORT).toBe(3001);
    expect(config.CONTROL_DATABASE_URL).toContain('5443');
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('accepts a valid worker environment', () => {
    const config = loadConfig(workerConfigSchema, VALID_WORKER_ENV);
    expect(config.QUEUE_PREFIX).toBe('rupturegrid');
  });

  it('accepts a valid Demo Fintech environment', () => {
    const config = loadConfig(demoConfigSchema, VALID_DEMO_ENV);
    expect(config.DEMO_PORT).toBe(3002);
  });

  it('applies defaults for optional values', () => {
    const config = loadConfig(apiConfigSchema, {
      CONTROL_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5443/db',
      REDIS_URL: 'redis://127.0.0.1:6380',
    });
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3001);
    expect(config.QUEUE_PREFIX).toBe('rupturegrid');
  });
});

describe('config validation — failure (fail fast)', () => {
  it('rejects an API environment missing the Control DB URL', () => {
    const env: Record<string, string> = { ...VALID_API_ENV };
    delete env.CONTROL_DATABASE_URL;
    expect(() => loadConfig(apiConfigSchema, env)).toThrow(ConfigValidationError);
  });

  it('rejects a non-URL Control DB value', () => {
    expect(() =>
      loadConfig(apiConfigSchema, {
        ...VALID_API_ENV,
        CONTROL_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig(apiConfigSchema, { ...VALID_API_ENV, API_PORT: 'not-a-port' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig(apiConfigSchema, { ...VALID_API_ENV, API_PORT: '99999' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(apiConfigSchema, { ...VALID_API_ENV, LOG_LEVEL: 'verbose' })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects an invalid queue prefix', () => {
    expect(() =>
      loadConfig(apiConfigSchema, { ...VALID_API_ENV, QUEUE_PREFIX: 'bad prefix!' }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects a Demo environment missing the admin token', () => {
    const env: Record<string, string> = { ...VALID_DEMO_ENV };
    delete env.DEMO_ADMIN_TOKEN;
    expect(() => loadConfig(demoConfigSchema, env)).toThrow(ConfigValidationError);
  });

  it('rejects a too-short Demo credential', () => {
    expect(() =>
      loadConfig(demoConfigSchema, { ...VALID_DEMO_ENV, DEMO_ADMIN_TOKEN: 'short' }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects a whitespace-padded Demo credential', () => {
    expect(() =>
      loadConfig(demoConfigSchema, {
        ...VALID_DEMO_ENV,
        DEMO_INSPECTION_TOKEN: '        padded       ',
      }),
    ).toThrow(ConfigValidationError);
  });

  it('reports all issues together (fail-fast clarity)', () => {
    try {
      loadConfig(apiConfigSchema, { LOG_LEVEL: 'verbose' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('config ownership boundaries (contract tests)', () => {
  // The full shared development .env legitimately contains every
  // family's variables. Ownership is enforced by what the VALIDATED
  // CONFIG OBJECT exposes: a foreign family's credentials must never
  // appear in an application's typed config.
  const SHARED_DEV_ENV = {
    ...VALID_API_ENV,
    ...VALID_DEMO_ENV,
    CONTROL_POSTGRES_PASSWORD: 'rupturegrid_dev_password',
    DEMO_POSTGRES_PASSWORD: 'demo_dev_password',
    CONTROL_POSTGRES_PORT: '5443',
    DEMO_POSTGRES_PORT: '5444',
    REDIS_PORT: '6380',
  };

  it('API config never exposes Demo Fintech credentials', () => {
    const config = loadConfig(apiConfigSchema, SHARED_DEV_ENV) as unknown as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty('DEMO_DATABASE_URL');
    expect(config).not.toHaveProperty('DEMO_POSTGRES_PASSWORD');
    expect(config).not.toHaveProperty('DEMO_HOST');
    expect(config).not.toHaveProperty('DEMO_PORT');
  });

  it('Demo Fintech config never exposes RuptureGrid Control or Redis credentials', () => {
    const config = loadConfig(demoConfigSchema, SHARED_DEV_ENV) as unknown as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty('CONTROL_DATABASE_URL');
    expect(config).not.toHaveProperty('CONTROL_POSTGRES_PASSWORD');
    expect(config).not.toHaveProperty('REDIS_URL');
    expect(config).not.toHaveProperty('QUEUE_PREFIX');
  });

  // Phase 3 update (ADR-0012 §55): the worker is the EXECUTOR, so it
  // legitimately receives target credential VALUES for the reference
  // names experiments may declare (DEMO_ADMIN_TOKEN,
  // DEMO_INSPECTION_TOKEN, DEMO_PROVIDER_SIGNING_SECRET). The Demo
  // DATABASE URL remains strictly forbidden — the worker reaches the
  // target over HTTP only. The ownership boundary that must not move
  // is database access, not the executor's credential resolution.
  it('worker config receives executor credential values but NEVER the Demo database', () => {
    const config = loadConfig(workerConfigSchema, SHARED_DEV_ENV) as unknown as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty('DEMO_DATABASE_URL');
    expect(config).not.toHaveProperty('DEMO_POSTGRES_PASSWORD');
    expect(config).not.toHaveProperty('DEMO_HOST');
    expect(config).not.toHaveProperty('DEMO_PORT');
    // Executor credential refs are expected (values resolved at
    // request time only; never logged, never persisted).
    expect(config).toHaveProperty('DEMO_ADMIN_TOKEN');
    expect(config).toHaveProperty('DEMO_INSPECTION_TOKEN');
    expect(config).toHaveProperty('DEMO_PROVIDER_SIGNING_SECRET');
  });

  it('compose-service variables never leak into any app config', () => {
    const api = loadConfig(apiConfigSchema, SHARED_DEV_ENV) as unknown as Record<string, unknown>;
    expect(api).not.toHaveProperty('CONTROL_POSTGRES_PORT');
    expect(api).not.toHaveProperty('REDIS_PORT');

    const demo = loadConfig(demoConfigSchema, SHARED_DEV_ENV) as unknown as Record<string, unknown>;
    expect(demo).not.toHaveProperty('DEMO_POSTGRES_USER');
  });

  it('pickRuptureGridEnv filters out unrelated system variables', () => {
    const picked = pickRuptureGridEnv({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      CONTROL_DATABASE_URL: 'postgresql://u:p@h/db',
    });
    expect(picked).toEqual({ CONTROL_DATABASE_URL: 'postgresql://u:p@h/db' });
  });

  it('API config exposes exactly its declared ownership set', () => {
    const config = loadConfig(apiConfigSchema, SHARED_DEV_ENV);
    expect(Object.keys(config).sort()).toEqual(
      [
        'API_HOST',
        'API_PORT',
        'CONTROL_DATABASE_URL',
        'CORS_ORIGINS',
        'LOG_LEVEL',
        'NODE_ENV',
        'QUEUE_PREFIX',
        'REDIS_URL',
      ].sort(),
    );
  });
});
