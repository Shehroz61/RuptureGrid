// =====================================================================
// Integration — structured logging (real output verification)
// =====================================================================
// Verifies the actual JSON lines the logger emits to stdout: stable
// fields present, redaction applied, service identity correct. This is
// the "logs are machine-readable" contract, checked against real
// emitted bytes rather than by mocking pino.

import { describe, expect, it } from 'vitest';
import { createLogger } from '@rupturegrid/logger';

function captureStdout(run: (line: (json: unknown) => void) => void): Promise<unknown> {
  return new Promise((resolve) => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    try {
      run(() => {
        // Parse the first JSON line found.
        const line = captured.split('\n').find((l) => l.startsWith('{'));
        resolve(line === undefined ? null : (JSON.parse(line) as unknown));
      });
    } finally {
      process.stdout.write = original;
    }
  });
}

describe('structured logging output', () => {
  it('emits JSON with stable fields and service identity', async () => {
    const logged = await captureStdout((done) => {
      const logger = createLogger({ service: 'rupturegrid-api', environment: 'test' });
      logger.info('hello foundation', { detail: 'value' });
      setTimeout(() => done(undefined), 100);
    });

    expect(logged).toMatchObject({
      level: 30,
      msg: 'hello foundation',
      service: 'rupturegrid-api',
      environment: 'test',
    });
  });

  it('redacts connection strings and secrets from real emitted logs', async () => {
    const logged = await captureStdout((done) => {
      const logger = createLogger({ service: 'rupturegrid-worker', environment: 'test' });
      logger.info('startup config', {
        CONTROL_DATABASE_URL: 'postgresql://user:supersecret@db:5433/db',
        password: 'hunter2',
      });
      setTimeout(() => done(undefined), 100);
    });

    const text = JSON.stringify(logged);
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('***');
    expect(text).toContain('[Redacted]');
  });
});
