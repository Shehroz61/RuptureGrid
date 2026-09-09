// =====================================================================
// Integration — Demo domain semantics on REAL PostgreSQL (§80)
// =====================================================================
// Domain-layer integration tests against the real Demo database:
// constraint enforcement, nullable-unique behavior (verified, not
// assumed — §20), concurrent losing transactions (§124), and atomic
// rollback with zero residue (§67). The flagship black-box scenario
// remains HTTP-driven; this file proves the database semantics the
// black-box suite depends on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyWalletCreditFinancialEffect, createDemoDb, Prisma } from '@rupturegrid/demo-db';
import type { DemoDb } from '@rupturegrid/demo-db';
import { loadTestEnv } from './helpers/env.js';

let db: DemoDb;
const UNIQUE_INDEX = 'ledger_entries_idempotencyKey_key';

beforeAll(() => {
  const env = loadTestEnv();
  db = createDemoDb(env.demoDatabaseUrl);
});

afterAll(async () => {
  await db?.disconnect();
});

/** Creates an isolated wallet + logical payment for a test. */
async function createScenarioEntities() {
  const customer = await db.client.customer.create({
    data: { customerReference: `cust-${crypto.randomUUID()}` },
  });
  const wallet = await db.client.wallet.create({
    data: { customerId: customer.id, currency: 'PKR', balanceMinor: 0n },
  });
  const payment = await db.client.providerPayment.create({
    data: {
      providerPaymentId: `pp-test-${crypto.randomUUID()}`,
      walletId: wallet.id,
      currency: 'PKR',
      amountMinor: 500000n,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
  });
  const eventA = await db.client.providerEvent.create({
    data: {
      providerEventId: `pe-test-${crypto.randomUUID()}`,
      eventType: 'PAYMENT_CONFIRMED',
      paymentId: payment.id,
    },
  });
  const eventB = await db.client.providerEvent.create({
    data: {
      providerEventId: `pe-test-${crypto.randomUUID()}`,
      eventType: 'PAYMENT_SETTLED',
      paymentId: payment.id,
    },
  });
  return { customer, wallet, payment, eventA, eventB };
}

describe('schema constraints exist (migration truth)', () => {
  it('the idempotency uniqueness index exists', async () => {
    const rows = await db.client.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE indexname = '${UNIQUE_INDEX}'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('the wallet non-negative balance CHECK exists', async () => {
    const rows = await db.client.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conname = 'wallets_balance_nonnegative_check'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('the five business identities carry unique constraints', async () => {
    const rows = await db.client.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN (
        'provider_payments_providerPaymentId_key',
        'provider_events_providerEventId_key',
        'webhook_deliveries_deliveryAttemptId_key',
        'financial_effects_financialEffectId_key',
        'ledger_entries_financialEffectId_key'
      )`,
    );
    expect(rows).toHaveLength(5);
  });
});

describe('nullable-unique idempotency semantics (verified on real PostgreSQL)', () => {
  it('multiple NULL idempotency keys may coexist', async () => {
    const scenario = await createScenarioEntities();
    const attemptA = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventA.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const attemptB = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventB.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const effectA = await db.client.financialEffect.create({
      data: {
        financialEffectId: `fe-${crypto.randomUUID()}`,
        paymentId: scenario.payment.id,
        processingAttemptId: attemptA.id,
        walletId: scenario.wallet.id,
        effectType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
      },
    });
    const effectB = await db.client.financialEffect.create({
      data: {
        financialEffectId: `fe-${crypto.randomUUID()}`,
        paymentId: scenario.payment.id,
        processingAttemptId: attemptB.id,
        walletId: scenario.wallet.id,
        effectType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
      },
    });
    await db.client.ledgerEntry.create({
      data: {
        walletId: scenario.wallet.id,
        financialEffectId: effectA.id,
        entryType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
        idempotencyKey: null,
      },
    });
    await db.client.ledgerEntry.create({
      data: {
        walletId: scenario.wallet.id,
        financialEffectId: effectB.id,
        entryType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
        idempotencyKey: null,
      },
    });
    const entries = await db.client.ledgerEntry.count({
      where: { financialEffectId: { in: [effectA.id, effectB.id] }, idempotencyKey: null },
    });
    expect(entries).toBe(2);
  });

  it('two identical non-null idempotency keys conflict (P2002)', async () => {
    const scenario = await createScenarioEntities();
    const attempt = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventA.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const effect = await db.client.financialEffect.create({
      data: {
        financialEffectId: `fe-${crypto.randomUUID()}`,
        paymentId: scenario.payment.id,
        processingAttemptId: attempt.id,
        walletId: scenario.wallet.id,
        effectType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
      },
    });
    await db.client.ledgerEntry.create({
      data: {
        walletId: scenario.wallet.id,
        financialEffectId: effect.id,
        entryType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
        idempotencyKey: 'key-dup-test-00000001',
      },
    });
    const attempt2 = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventB.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const effect2 = await db.client.financialEffect.create({
      data: {
        financialEffectId: `fe-${crypto.randomUUID()}`,
        paymentId: scenario.payment.id,
        processingAttemptId: attempt2.id,
        walletId: scenario.wallet.id,
        effectType: 'WALLET_CREDIT',
        amountMinor: 100n,
        currency: 'PKR',
      },
    });
    await expect(
      db.client.ledgerEntry.create({
        data: {
          walletId: scenario.wallet.id,
          financialEffectId: effect2.id,
          entryType: 'WALLET_CREDIT',
          amountMinor: 100n,
          currency: 'PKR',
          idempotencyKey: 'key-dup-test-00000001',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('domain CHECK constraints are enforced by PostgreSQL', () => {
  it('a negative wallet balance is rejected', async () => {
    const scenario = await createScenarioEntities();
    await expect(
      db.client.wallet.update({
        where: { id: scenario.wallet.id },
        data: { balanceMinor: -1n },
      }),
    ).rejects.toThrow(/balance_nonnegative|check/i);
  });
});

describe('atomic wallet-credit transaction (§67, §124)', () => {
  it('a failing financial transaction leaves ZERO residue', async () => {
    const scenario = await createScenarioEntities();
    const attempt = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventA.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    // Nonexistent wallet → FK violation mid-transaction.
    await expect(
      applyWalletCreditFinancialEffect(db, {
        mode: 'SECURE',
        walletId: '00000000-0000-0000-0000-000000000000',
        payment: {
          id: scenario.payment.id,
          providerPaymentId: scenario.payment.providerPaymentId,
          amountMinor: 500000n,
          currency: 'PKR',
        },
        event: { id: scenario.eventA.id, providerEventId: scenario.eventA.providerEventId },
        processingAttemptId: attempt.id,
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    expect(
      await db.client.financialEffect.count({ where: { processingAttemptId: attempt.id } }),
    ).toBe(0);
    expect(await db.client.ledgerEntry.count({ where: { walletId: scenario.wallet.id } })).toBe(0);
    expect(
      (await db.client.wallet.findUnique({ where: { id: scenario.wallet.id } }))?.balanceMinor,
    ).toBe(0n);
  });

  it('two CONCURRENT losing/succeeding inserts: exactly one APPLIED, one IDEMPOTENT_DUPLICATE', async () => {
    const scenario = await createScenarioEntities();
    const attemptA = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventA.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const attemptB = await db.client.processingAttempt.create({
      data: {
        delivery: {
          create: {
            deliveryAttemptId: `D-${crypto.randomUUID()}`,
            eventId: scenario.eventB.id,
            status: 'ACCEPTED',
          },
        },
      },
    });
    const base = {
      mode: 'SECURE' as const,
      walletId: scenario.wallet.id,
      payment: {
        id: scenario.payment.id,
        providerPaymentId: scenario.payment.providerPaymentId,
        amountMinor: 500000n,
        currency: 'PKR',
      },
    };
    const [resultA, resultB] = await Promise.all([
      applyWalletCreditFinancialEffect(db, {
        ...base,
        event: { id: scenario.eventA.id, providerEventId: scenario.eventA.providerEventId },
        processingAttemptId: attemptA.id,
      }),
      applyWalletCreditFinancialEffect(db, {
        ...base,
        event: { id: scenario.eventB.id, providerEventId: scenario.eventB.providerEventId },
        processingAttemptId: attemptB.id,
      }),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(['APPLIED', 'IDEMPOTENT_DUPLICATE']);
    const applied = resultA.outcome === 'APPLIED' ? resultA : resultB;
    expect(applied.financialEffectId).not.toBeNull();

    // Exactly one effect, one ledger entry, one increment.
    expect(
      await db.client.financialEffect.count({ where: { paymentId: scenario.payment.id } }),
    ).toBe(1);
    expect(await db.client.ledgerEntry.count({ where: { walletId: scenario.wallet.id } })).toBe(1);
    expect(
      (await db.client.wallet.findUnique({ where: { id: scenario.wallet.id } }))?.balanceMinor,
    ).toBe(500000n);
  });
});

function crypto_randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
const crypto = { randomUUID: crypto_randomUUID };
