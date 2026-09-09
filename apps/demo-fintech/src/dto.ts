// =====================================================================
// Demo Fintech — explicit response DTOs (Phase 2 §108)
// =====================================================================
// No raw Prisma model objects are ever returned. Every response shape
// is intentional: bigint money is serialized to canonical decimal
// strings (never JSON.stringify on BigInt — §94), and only safe fields
// are exposed (no secrets, no internal ids beyond the documented ones).

import { bigintToString } from '@rupturegrid/demo-db';
import type {
  Customer,
  FinancialEffect,
  LedgerEntry,
  ProcessingAttempt,
  ProviderEvent,
  ProviderPayment,
  Wallet,
  WebhookDelivery,
} from '@rupturegrid/demo-db';

export interface CustomerDto {
  customerReference: string;
  createdAt: string;
}

export interface WalletDto {
  walletId: string;
  customerId: string;
  currency: string;
  balanceMinor: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPaymentDto {
  providerPaymentId: string;
  walletId: string;
  amountMinor: string;
  currency: string;
  status: string;
  createdAt: string;
  confirmedAt: string;
}

export interface ProviderEventDto {
  providerEventId: string;
  providerPaymentId: string;
  eventType: string;
  createdAt: string;
}

export interface WebhookDeliveryDto {
  deliveryAttemptId: string;
  providerEventId: string;
  receivedAt: string;
  status: string;
}

export interface ProcessingAttemptDto {
  processingAttemptId: string;
  deliveryAttemptId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  failureReason: string | null;
}

export interface FinancialEffectDto {
  financialEffectId: string;
  providerPaymentId: string;
  processingAttemptId: string;
  walletId: string;
  effectType: string;
  amountMinor: string;
  currency: string;
  createdAt: string;
}

export interface LedgerEntryDto {
  financialEffectId: string;
  walletId: string;
  entryType: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export function toCustomerDto(customer: Customer): CustomerDto {
  return {
    customerReference: customer.customerReference,
    createdAt: customer.createdAt.toISOString(),
  };
}

export function toWalletDto(wallet: Wallet): WalletDto {
  return {
    walletId: wallet.id,
    customerId: wallet.customerId,
    currency: wallet.currency,
    balanceMinor: bigintToString(wallet.balanceMinor),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toProviderPaymentDto(payment: ProviderPayment): ProviderPaymentDto {
  return {
    providerPaymentId: payment.providerPaymentId,
    walletId: payment.walletId,
    amountMinor: bigintToString(payment.amountMinor),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt.toISOString(),
    confirmedAt: payment.confirmedAt.toISOString(),
  };
}

export function toProviderEventDto(
  event: ProviderEvent,
  payment: ProviderPayment,
): ProviderEventDto {
  return {
    providerEventId: event.providerEventId,
    providerPaymentId: payment.providerPaymentId,
    eventType: event.eventType,
    createdAt: event.createdAt.toISOString(),
  };
}

export function toWebhookDeliveryDto(
  delivery: WebhookDelivery,
  providerEventId: string,
): WebhookDeliveryDto {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    providerEventId,
    receivedAt: delivery.receivedAt.toISOString(),
    status: delivery.status,
  };
}

export function toProcessingAttemptDto(
  attempt: ProcessingAttempt,
  deliveryAttemptId: string,
): ProcessingAttemptDto {
  return {
    processingAttemptId: attempt.id,
    deliveryAttemptId,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt === null ? null : attempt.finishedAt.toISOString(),
    outcome: attempt.outcome === null ? null : attempt.outcome,
    failureReason: attempt.failureReason,
  };
}

export function toFinancialEffectDto(
  effect: FinancialEffect,
  providerPaymentId: string,
): FinancialEffectDto {
  return {
    financialEffectId: effect.financialEffectId,
    providerPaymentId,
    processingAttemptId: effect.processingAttemptId,
    walletId: effect.walletId,
    effectType: effect.effectType,
    amountMinor: bigintToString(effect.amountMinor),
    currency: effect.currency,
    createdAt: effect.createdAt.toISOString(),
  };
}

export function toLedgerEntryDto(entry: LedgerEntry): LedgerEntryDto {
  return {
    financialEffectId: entry.financialEffectId,
    walletId: entry.walletId,
    entryType: entry.entryType,
    amountMinor: bigintToString(entry.amountMinor),
    currency: entry.currency,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt.toISOString(),
  };
}
