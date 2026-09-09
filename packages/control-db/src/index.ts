// =====================================================================
// RuptureGrid v1.0 — Control DB ownership boundary
// =====================================================================
// The ONLY place RuptureGrid applications obtain a Control PostgreSQL
// client. Demo Fintech applications MUST NOT import this package
// (enforced by dependency boundaries — see docs/architecture.md §4).

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

export interface ControlDb {
  /** Raw health probe: SELECT 1 against the Control PostgreSQL. */
  ping(): Promise<void>;
  /** Closes the underlying connection pool. */
  disconnect(): Promise<void>;
}

/**
 * Creates the RuptureGrid Control database client from an explicit
 * connection string. The caller (app config layer) owns the value;
 * this package never reads process.env directly.
 */
export function createControlDb(connectionString: string): ControlDb {
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
