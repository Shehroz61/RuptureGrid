// =====================================================================
// Demo Commerce DB ownership boundary
// =====================================================================
// The ONLY place the Demo Commerce application obtains its database
// client and its business-transaction semantics. RuptureGrid
// applications MUST NOT import this package and MUST NOT receive
// COMMERCE_DATABASE_URL (ADR-0002, AGENTS R-05 — lint-enforced exactly
// like the Demo Fintech boundary). This target shares NOTHING with the
// Demo Fintech store: separate PostgreSQL instance, separate schema
// history, separate domain.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client/client.js';

export { Prisma } from './generated/client/client.js';
export type { PrismaClient } from './generated/client/client.js';
export * from './fault-control.js';
export * from './checkout-core.js';
export * from './checkout-payload.js';
export * from './identifiers.js';
export * from './signature.js';
export type {
  CommerceSettings,
  VerificationScope,
  Sku,
  CheckoutIntent,
  CheckoutEvent,
  RequestAttempt,
  ProcessingAttempt,
  Order,
  Reservation,
  CommerceFaultPlan,
} from './generated/client/client.js';

export interface CommerceDb {
  /** The typed Prisma client — services compose queries on it. */
  readonly client: PrismaClient;
  /** Raw health probe: SELECT 1 against the Commerce PostgreSQL. */
  ping(): Promise<void>;
  /** Closes the underlying connection pool. */
  disconnect(): Promise<void>;
}

/**
 * Creates the Demo Commerce database client from an explicit connection
 * string. The caller (app config layer) owns the value; this package
 * never reads process.env directly.
 */
export function createCommerceDb(connectionString: string): CommerceDb {
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });

  return {
    client,
    async ping() {
      await client.$queryRawUnsafe('SELECT 1');
    },
    async disconnect() {
      await client.$disconnect();
    },
  };
}
