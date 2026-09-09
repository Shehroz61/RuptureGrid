// =====================================================================
// RuptureGrid v1.0 — Demo Fintech DB ownership boundary
// =====================================================================
// The ONLY place the Demo Fintech application obtains its database
// client. RuptureGrid applications MUST NOT import this package and
// MUST NOT receive DEMO_DATABASE_URL (ADR-0002, AGENTS R-05).

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

export interface DemoDb {
  /** Raw health probe: SELECT 1 against the Demo PostgreSQL. */
  ping(): Promise<void>;
  /** Closes the underlying connection pool. */
  disconnect(): Promise<void>;
}

/**
 * Creates the Demo Fintech database client from an explicit connection
 * string. The caller (app config layer) owns the value; this package
 * never reads process.env directly.
 */
export function createDemoDb(connectionString: string): DemoDb {
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });

  return {
    async ping() {
      await client.$queryRawUnsafe('SELECT 1');
    },
    async disconnect() {
      await client.$disconnect();
    },
  };
}
