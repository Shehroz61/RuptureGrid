// =====================================================================
// RuptureGrid v1.0 — Demo Fintech DB ownership boundary
// =====================================================================
// The ONLY place the Demo Fintech application obtains its database
// client and its financial transaction semantics. RuptureGrid
// applications MUST NOT import this package and MUST NOT receive
// DEMO_DATABASE_URL (ADR-0002, AGENTS R-05).
//
// Financial-transaction contract (Phase 2 §21): an accepted wallet
// credit creates FinancialEffect + LedgerEntry + wallet increment
// ATOMICALLY — succeed together or roll back together. Business
// idempotency is DB-enforced: the ledger's unique idempotency_key is
// the deduplication authority. A losing concurrent insert raises a
// unique violation that propagates out of the transaction, so
// PostgreSQL rolls the ENTIRE transaction back (no orphan effect, no
// partial ledger, no balance change — §67); only afterwards is that
// precise violation mapped to IDEMPOTENT_DUPLICATE. Every other error
// remains a failure (§43). Isolation: PostgreSQL default READ COMMITTED
// plus the unique constraint is sufficient for this design (§122) —
// the unique index, not serialization, provides correctness.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client/client.js';
import { deriveIdempotencyKey, type ProcessingMode } from './keys.js';
import { randomId } from './signature.js';

export { Prisma };
export type { PrismaClient };
export * from './money.js';
export * from './bigint-safe.js';
export * from './identifiers.js';
export * from './keys.js';
export * from './signature.js';
export * from './webhook-payload.js';
export type {
  Customer,
  Wallet,
  ProviderPayment,
  ProviderEvent,
  WebhookDelivery,
  ProcessingAttempt,
  FinancialEffect,
  LedgerEntry,
  DemoSettings,
} from './generated/client/client.js';

/**
 * A transaction-scoped Prisma client (the argument of a `$transaction`
 * interactive callback): the full client minus connection/transaction
 * management operations.
 */
export type DemoTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface DemoDb {
  /** The typed Prisma client — services compose queries on it. */
  readonly client: PrismaClient;
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
    client,
    async ping() {
      await client.$queryRawUnsafe('SELECT 1');
    },
    async disconnect() {
      await client.$disconnect();
    },
  };
}

// ---------------------------------------------------------------------
// Atomic financial effect
// ---------------------------------------------------------------------

export interface WalletCreditInput {
  mode: ProcessingMode;
  walletId: string;
  /** The stored authoritative payment — amount/currency come from it. */
  payment: {
    id: string;
    providerPaymentId: string;
    amountMinor: bigint;
    currency: string;
  };
  event: { id: string; providerEventId: string };
  processingAttemptId: string;
}

export type WalletCreditOutcome = 'APPLIED' | 'IDEMPOTENT_DUPLICATE';

export interface WalletCreditResult {
  outcome: WalletCreditOutcome;
  /** Set only when outcome === 'APPLIED'. */
  financialEffectId: string | null;
}

/**
 * Applies one wallet-credit business effect atomically.
 *
 * A single PostgreSQL transaction creates the FinancialEffect, its
 * LedgerEntry (carrying the mode-scoped idempotency key, unique at the
 * DATABASE level), and the wallet increment. On an idempotency-key
 * uniqueness conflict the error propagates and the transaction rolls
 * back completely; the precise conflict is then mapped to
 * IDEMPOTENT_DUPLICATE. Any other unique violation or error propagates
 * as a failure.
 */
export async function applyWalletCreditFinancialEffect(
  db: DemoDb,
  input: WalletCreditInput,
): Promise<WalletCreditResult> {
  const idempotencyKey = deriveIdempotencyKey({
    mode: input.mode,
    providerPaymentId: input.payment.providerPaymentId,
    providerEventId: input.event.providerEventId,
    walletId: input.walletId,
  });
  const financialEffectId = randomId('fe');

  try {
    const created = await db.client.$transaction(async (tx) => {
      const financialEffect = await tx.financialEffect.create({
        data: {
          financialEffectId,
          paymentId: input.payment.id,
          processingAttemptId: input.processingAttemptId,
          walletId: input.walletId,
          effectType: 'WALLET_CREDIT',
          amountMinor: input.payment.amountMinor,
          currency: input.payment.currency,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: input.walletId,
          financialEffectId: financialEffect.id,
          entryType: 'WALLET_CREDIT',
          amountMinor: input.payment.amountMinor,
          currency: input.payment.currency,
          idempotencyKey,
        },
      });

      await tx.wallet.update({
        where: { id: input.walletId },
        data: { balanceMinor: { increment: input.payment.amountMinor } },
      });

      return financialEffect.financialEffectId;
    });
    return { outcome: 'APPLIED', financialEffectId: created };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Only the ledger idempotency-key uniqueness violation is a
      // legitimate idempotent duplicate. Any other unique violation
      // (e.g. a caller identity collision) is a genuine error.
      if (isIdempotencyKeyConflict(error)) {
        return { outcome: 'IDEMPOTENT_DUPLICATE', financialEffectId: null };
      }
    }
    throw error;
  }
}

/** The Postgres index backing the ledger idempotency uniqueness. */
const IDEMPOTENCY_UNIQUE_INDEX = 'ledger_entries_idempotencyKey_key';

/**
 * Precise inspection of a P2002 error (Phase 2 §43): only the ledger
 * idempotency-key uniqueness violation maps to IDEMPOTENT_DUPLICATE.
 * Prisma 7 P2002 errors carry the conflicting constraint/target meta.
 */
function isIdempotencyKeyConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  const meta = error.meta as { target?: string[] | string } | undefined;
  const target = meta?.target;
  if (Array.isArray(target)) {
    return target.includes('idempotencyKey');
  }
  if (typeof target === 'string') {
    return target.includes(IDEMPOTENCY_UNIQUE_INDEX) || target.includes('idempotencyKey');
  }
  // Some driver paths report the constraint via message only.
  return typeof error.message === 'string' && error.message.includes(IDEMPOTENCY_UNIQUE_INDEX);
}
