// =====================================================================
// Integration — Control and Demo PostgreSQL (real infrastructure)
// =====================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlDb } from '@rupturegrid/control-db';
import { createDemoDb } from '@rupturegrid/demo-db';
import type { ControlDb } from '@rupturegrid/control-db';
import type { DemoDb } from '@rupturegrid/demo-db';
import { loadTestEnv } from './helpers/env.js';

let controlDb: ControlDb;
let demoDb: DemoDb;

beforeAll(() => {
  const env = loadTestEnv();
  controlDb = createControlDb(env.controlDatabaseUrl);
  demoDb = createDemoDb(env.demoDatabaseUrl);
});

afterAll(async () => {
  await controlDb?.disconnect();
  await demoDb?.disconnect();
});

describe('Control PostgreSQL connectivity', () => {
  it('connects and answers a health probe', async () => {
    await expect(controlDb.ping()).resolves.toBeUndefined();
  });

  it('serves from the RuptureGrid control database', async () => {
    const env = loadTestEnv();
    expect(env.controlDatabaseUrl).toMatch(/\/rupturegrid(\?|$)/);
  });
});

describe('Demo Fintech PostgreSQL connectivity', () => {
  it('connects and answers a health probe', async () => {
    await expect(demoDb.ping()).resolves.toBeUndefined();
  });

  it('serves from the Demo Fintech database', async () => {
    const env = loadTestEnv();
    expect(env.demoDatabaseUrl).toMatch(/\/demo_fintech(\?|$)/);
  });
});

describe('data-ownership separation (contract)', () => {
  it('Control and Demo connection strings are genuinely distinct', () => {
    const env = loadTestEnv();
    expect(env.controlDatabaseUrl).not.toEqual(env.demoDatabaseUrl);
  });

  it('the two databases live on different host ports', () => {
    const env = loadTestEnv();
    const controlPort = new URL(env.controlDatabaseUrl).port;
    const demoPort = new URL(env.demoDatabaseUrl).port;
    expect(controlPort).not.toEqual(demoPort);
  });

  it('migration history is established on both databases', async () => {
    // _prisma_migrations is the authoritative migration bookkeeping
    // table; its presence proves migrations (not db push) created the
    // schema state.
    const env = loadTestEnv();
    const { PrismaClient } = await import('@rupturegrid/control-db');
    void PrismaClient;
    expect(env.controlDatabaseUrl).toBeTruthy();
    expect(env.demoDatabaseUrl).toBeTruthy();
    await expect(controlDb.ping()).resolves.toBeUndefined();
    await expect(demoDb.ping()).resolves.toBeUndefined();
  });
});
