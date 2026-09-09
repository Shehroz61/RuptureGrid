// =====================================================================
// Demo Fintech — read-only inspection service (target-authored truth)
// =====================================================================
// Future RuptureGrid observes target business truth HERE, over HTTP
// with a read-only credential — never via the Demo DB (ADR-0002,
// architecture.md §5). The output preserves the explicit identity
// chain so an analyzer can reconstruct:
//
//   providerPaymentId → providerEventId(s) → deliveryAttemptId(s) →
//   processingAttemptId(s) → financialEffectId(s)
//
// purely from stored relations/foreign keys — never timestamp
// inference (§35, §65, evidence-model.md §6). Counts are convenience
// fields only; the entities are the truth. NO invariant verdicts are
// produced here — "FAIL/PASS/CRITICAL/SURVIVED" are RuptureGrid
// analysis concepts, not target truth (§120, §87).

import type { DemoDb, ProcessingMode } from '@rupturegrid/demo-db';
import { NotFoundError } from './errors.js';
import {
  toFinancialEffectDto,
  toLedgerEntryDto,
  toProcessingAttemptDto,
  toProviderEventDto,
  toProviderPaymentDto,
  toWebhookDeliveryDto,
  toWalletDto,
} from './dto.js';
import type {
  FinancialEffectDto,
  LedgerEntryDto,
  ProcessingAttemptDto,
  ProviderEventDto,
  ProviderPaymentDto,
  WalletDto,
  WebhookDeliveryDto,
} from './dto.js';

export interface PaymentLineage {
  payment: ProviderPaymentDto;
  events: ProviderEventDto[];
  deliveries: WebhookDeliveryDto[];
  processingAttempts: ProcessingAttemptDto[];
  financialEffects: FinancialEffectDto[];
  ledgerEntries: LedgerEntryDto[];
  wallet: WalletDto;
  /** Convenience totals ONLY — the entity arrays above are the truth. */
  counts: {
    events: number;
    deliveries: number;
    processingAttempts: number;
    financialEffects: number;
    ledgerEntries: number;
  };
  processingMode: ProcessingMode;
}

export interface WalletReconciliation {
  wallet: WalletDto;
  /** Exact integer sum of accepted WALLET_CREDIT ledger entries. */
  ledgerCreditSumMinor: string;
  /** balanceMinor − ledgerCreditSumMinor must be exactly 0n. */
  differenceMinor: string;
}

export interface DemoInspectionService {
  paymentLineage(providerPaymentId: string): Promise<PaymentLineage>;
  walletReconciliation(walletId: string): Promise<WalletReconciliation>;
}

export function createDemoInspectionService(db: DemoDb): DemoInspectionService {
  return {
    /**
     * Complete lineage for one logical payment. Deterministic ordering:
     * events by (createdAt, providerEventId); deliveries by
     * (receivedAt, deliveryAttemptId); attempts by (startedAt, id);
     * effects by (createdAt, financialEffectId) — §36.
     */
    async paymentLineage(providerPaymentId: string): Promise<PaymentLineage> {
      const payment = await db.client.providerPayment.findUnique({
        where: { providerPaymentId },
        include: {
          wallet: true,
          events: {
            orderBy: [{ createdAt: 'asc' }, { providerEventId: 'asc' }],
            include: {
              deliveries: {
                orderBy: [{ receivedAt: 'asc' }, { deliveryAttemptId: 'asc' }],
                include: { processingAttempt: true },
              },
            },
          },
          financialEffects: {
            orderBy: [{ createdAt: 'asc' }, { financialEffectId: 'asc' }],
            include: { ledgerEntry: true },
          },
        },
      });
      if (payment === null) {
        throw new NotFoundError('unknown provider payment');
      }

      const mode = await db.client.demoSettings.findUnique({ where: { id: 'default' } });

      const events = payment.events.map((event) => toProviderEventDto(event, payment));
      const deliveries = payment.events
        .flatMap((event) =>
          event.deliveries.map((delivery) => toWebhookDeliveryDto(delivery, event.providerEventId)),
        )
        .sort(
          (a, b) =>
            a.receivedAt.localeCompare(b.receivedAt) ||
            a.deliveryAttemptId.localeCompare(b.deliveryAttemptId),
        );
      const processingAttempts = payment.events
        .flatMap((event) =>
          event.deliveries.map((delivery) =>
            delivery.processingAttempt === null
              ? null
              : toProcessingAttemptDto(delivery.processingAttempt, delivery.deliveryAttemptId),
          ),
        )
        .filter((a): a is ProcessingAttemptDto => a !== null)
        .sort(
          (a, b) =>
            a.startedAt.localeCompare(b.startedAt) ||
            a.processingAttemptId.localeCompare(b.processingAttemptId),
        );

      const financialEffects = payment.financialEffects.map((effect) =>
        toFinancialEffectDto(effect, payment.providerPaymentId),
      );
      const ledgerEntries = payment.financialEffects
        .map((effect) =>
          effect.ledgerEntry === null ? null : toLedgerEntryDto(effect.ledgerEntry),
        )
        .filter((e): e is LedgerEntryDto => e !== null);

      return {
        payment: toProviderPaymentDto(payment),
        events,
        deliveries,
        processingAttempts,
        financialEffects,
        ledgerEntries,
        wallet: toWalletDto(payment.wallet),
        counts: {
          events: events.length,
          deliveries: deliveries.length,
          processingAttempts: processingAttempts.length,
          financialEffects: financialEffects.length,
          ledgerEntries: ledgerEntries.length,
        },
        processingMode: mode?.processingMode ?? 'VULNERABLE',
      };
    },

    /** Exact-integer wallet/ledger reconciliation for one wallet. */
    async walletReconciliation(walletId: string): Promise<WalletReconciliation> {
      const wallet = await db.client.wallet.findUnique({
        where: { id: walletId },
        include: { ledgerEntries: { where: { entryType: 'WALLET_CREDIT' } } },
      });
      if (wallet === null) {
        throw new NotFoundError('unknown wallet');
      }
      const ledgerCreditSum = wallet.ledgerEntries.reduce(
        (sum, entry) => sum + entry.amountMinor,
        0n,
      );
      return {
        wallet: toWalletDto(wallet),
        ledgerCreditSumMinor: ledgerCreditSum.toString(10),
        differenceMinor: (wallet.balanceMinor - ledgerCreditSum).toString(10),
      };
    },
  };
}
