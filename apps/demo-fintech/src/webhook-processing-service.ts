// =====================================================================
// Demo Fintech — webhook processing service (the Incident Zero core)
// =====================================================================
// Conceptual order per request (Phase 2 §58):
//   transport metadata → delivery-attempt identity validation →
//   provider signature (raw bytes) → payload schema validation →
//   resolve known provider event/payment → business consistency →
//   record valid delivery → processing attempt → financial transaction
//
// Rules implemented here:
// - Financial processing NEVER precedes provider authenticity (§58).
// - Unauthenticated requests are NOT persisted as business deliveries
//   and create NO processing attempts (deliberate, §58).
// - The webhook references a REGISTERED payment; it can never rewrite
//   amount/currency/wallet (§57): amount+currency for the effect are
//   copied exclusively from the stored ProviderPayment row.
// - deliveryAttemptId is DB-unique: a repeated physical identity is a
//   contract conflict (§25), distinct from a legitimate redelivery
//   (same providerEventId, NEW deliveryAttemptId).
// - VULNERABLE vs SECURE differ ONLY in the idempotency scope of the
//   ledger key; each accepted credit is still internally atomic (§114).
// - Duplicate-suppressed attempts remain persisted as
//   IDEMPOTENT_DUPLICATE (§22, §119) — never hidden.

import type { DemoDb, ProcessingMode } from '@rupturegrid/demo-db';
import {
  applyWalletCreditFinancialEffect,
  parseWebhookPayload,
  Prisma,
  verifyProviderSignature,
  WebhookPayloadError,
} from '@rupturegrid/demo-db';
import {
  BusinessMismatchError,
  DuplicateDeliveryIdentityError,
  NotFoundError,
  ProcessingFailedError,
  ProviderAuthenticationError,
  TransportError,
} from './errors.js';

export interface ProcessDeliveryInput {
  deliveryAttemptId: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  sourceIp: string | undefined;
}

export interface ProcessDeliveryResult {
  deliveryAttemptId: string;
  processingAttemptId: string;
  outcome: 'APPLIED' | 'IDEMPOTENT_DUPLICATE';
  financialEffectId: string | null;
  providerEventId: string;
  providerPaymentId: string;
}

export interface WebhookProcessingService {
  processDelivery(input: ProcessDeliveryInput): Promise<ProcessDeliveryResult>;
}

export function createWebhookProcessingService(options: {
  db: DemoDb;
  signingSecret: string;
  modeProvider: () => Promise<ProcessingMode>;
}): WebhookProcessingService {
  const { db, signingSecret, modeProvider } = options;

  return {
    /**
     * Processes one physical webhook delivery synchronously and returns
     * the definitive business outcome — HTTP responses never precede
     * the outcome (§77).
     */
    async processDelivery(input: ProcessDeliveryInput): Promise<ProcessDeliveryResult> {
      const { deliveryAttemptId, rawBody, signatureHeader } = input;

      // 1. Provider authenticity — before ANY business persistence (§58).
      if (
        signatureHeader === undefined ||
        !verifyProviderSignature(signingSecret, rawBody, signatureHeader)
      ) {
        throw new ProviderAuthenticationError('provider signature missing or invalid');
      }

      // 2. Payload schema validation (safe, secret-free messages).
      let payloadJson: unknown;
      try {
        payloadJson = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new TransportError('payload is not valid JSON');
      }
      let payload;
      try {
        payload = parseWebhookPayload(payloadJson);
      } catch (error) {
        if (error instanceof WebhookPayloadError) {
          throw new TransportError(error.message);
        }
        throw error;
      }

      // 3. Resolve the registered logical event/payment.
      const event = await db.client.providerEvent.findUnique({
        where: { providerEventId: payload.providerEventId },
        include: { payment: true },
      });
      if (event === null) {
        throw new NotFoundError('unknown provider event');
      }
      const payment = event.payment;

      // 4. Business consistency: the payload references, never rewrites.
      if (payload.providerPaymentId !== payment.providerPaymentId) {
        throw new BusinessMismatchError('providerEventId does not belong to providerPaymentId');
      }
      if (payload.eventType !== event.eventType) {
        throw new BusinessMismatchError('eventType does not match the registered event');
      }
      if (payload.amountMinor !== payment.amountMinor || payload.currency !== payment.currency) {
        throw new BusinessMismatchError(
          'payload amount/currency contradict the registered payment',
        );
      }

      // 5. Record the valid physical delivery + its processing attempt.
      let deliveryId: string;
      try {
        const delivery = await db.client.webhookDelivery.create({
          data: {
            deliveryAttemptId,
            eventId: event.id,
            status: 'ACCEPTED',
            sourceIp: input.sourceIp ?? null,
          },
        });
        deliveryId = delivery.id;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          isDeliveryIdentityConflict(error)
        ) {
          throw new DuplicateDeliveryIdentityError(
            'deliveryAttemptId was already recorded: one physical identity per request',
          );
        }
        throw error;
      }

      const attempt = await db.client.processingAttempt.create({
        data: { deliveryId },
      });

      // 6. The atomic financial transaction (§21, §114).
      let outcome: ProcessDeliveryResult['outcome'];
      let financialEffectId: string | null;
      try {
        const mode = await modeProvider();
        const credit = await applyWalletCreditFinancialEffect(db, {
          mode,
          walletId: payment.walletId,
          payment: {
            id: payment.id,
            providerPaymentId: payment.providerPaymentId,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
          },
          event: { id: event.id, providerEventId: event.providerEventId },
          processingAttemptId: attempt.id,
        });
        outcome = credit.outcome;
        financialEffectId = credit.financialEffectId;
      } catch (error) {
        // Genuine failure: record it honestly, then surface a stable
        // error. No financial mutation can have survived — the failed
        // transaction rolled back atomically (§67).
        await db.client.processingAttempt
          .update({
            where: { id: attempt.id },
            data: {
              outcome: 'FAILED',
              finishedAt: new Date(),
              failureReason: safeFailureReason(error),
            },
          })
          .catch(() => undefined);
        await db.client.webhookDelivery
          .update({ where: { id: deliveryId }, data: { status: 'FAILED_PROCESSING' } })
          .catch(() => undefined);
        throw new ProcessingFailedError(safeFailureReason(error));
      }

      // 7. Finalize the attempt outcome (the suppressed stay visible).
      await db.client.processingAttempt.update({
        where: { id: attempt.id },
        data: { outcome, finishedAt: new Date() },
      });

      return {
        deliveryAttemptId,
        processingAttemptId: attempt.id,
        outcome,
        financialEffectId,
        providerEventId: event.providerEventId,
        providerPaymentId: payment.providerPaymentId,
      };
    },
  };
}

function safeFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 200);
  }
  return 'unknown processing failure';
}

function isDeliveryIdentityConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  const meta = error.meta as { target?: string[] | string } | undefined;
  const target = meta?.target;
  if (Array.isArray(target)) {
    return target.includes('deliveryAttemptId');
  }
  if (typeof target === 'string') {
    return (
      target.includes('webhook_deliveries_deliveryAttemptId_key') ||
      target.includes('deliveryAttemptId')
    );
  }
  return error.message.includes('webhook_deliveries_deliveryAttemptId_key');
}
