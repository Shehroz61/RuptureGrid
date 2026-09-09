-- CreateEnum
CREATE TYPE "ProcessingMode" AS ENUM ('VULNERABLE', 'SECURE');

-- CreateEnum
CREATE TYPE "ProviderPaymentStatus" AS ENUM ('CONFIRMED');

-- CreateEnum
CREATE TYPE "ProviderEventType" AS ENUM ('PAYMENT_CONFIRMED', 'PAYMENT_SETTLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('ACCEPTED', 'FAILED_PROCESSING');

-- CreateEnum
CREATE TYPE "ProcessingOutcome" AS ENUM ('APPLIED', 'IDEMPOTENT_DUPLICATE', 'FAILED');

-- CreateEnum
CREATE TYPE "FinancialEffectType" AS ENUM ('WALLET_CREDIT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('WALLET_CREDIT');

-- CreateTable
CREATE TABLE "demo_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "processingMode" "ProcessingMode" NOT NULL DEFAULT 'VULNERABLE',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "demo_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "customerReference" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balanceMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_payments" (
    "id" UUID NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "walletId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "ProviderPaymentStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" "ProviderEventType" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DeliveryStatus" NOT NULL,
    "sourceIp" TEXT,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_attempts" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "outcome" "ProcessingOutcome",
    "failureReason" TEXT,

    CONSTRAINT "processing_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_effects" (
    "id" UUID NOT NULL,
    "financialEffectId" TEXT NOT NULL,
    "paymentId" UUID NOT NULL,
    "processingAttemptId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "effectType" "FinancialEffectType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "financialEffectId" UUID NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_customerReference_key" ON "customers"("customerReference");

-- CreateIndex
CREATE INDEX "wallets_customerId_idx" ON "wallets"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_payments_providerPaymentId_key" ON "provider_payments"("providerPaymentId");

-- CreateIndex
CREATE INDEX "provider_payments_walletId_idx" ON "provider_payments"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_providerEventId_key" ON "provider_events"("providerEventId");

-- CreateIndex
CREATE INDEX "provider_events_paymentId_idx" ON "provider_events"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_deliveryAttemptId_key" ON "webhook_deliveries"("deliveryAttemptId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_eventId_idx" ON "webhook_deliveries"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "processing_attempts_deliveryId_key" ON "processing_attempts"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_effects_financialEffectId_key" ON "financial_effects"("financialEffectId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_effects_processingAttemptId_key" ON "financial_effects"("processingAttemptId");

-- CreateIndex
CREATE INDEX "financial_effects_paymentId_idx" ON "financial_effects"("paymentId");

-- CreateIndex
CREATE INDEX "financial_effects_walletId_idx" ON "financial_effects"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_financialEffectId_key" ON "ledger_entries"("financialEffectId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotencyKey_key" ON "ledger_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_entries_walletId_idx" ON "ledger_entries"("walletId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_payments" ADD CONSTRAINT "provider_payments_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "provider_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "provider_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_attempts" ADD CONSTRAINT "processing_attempts_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "webhook_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_effects" ADD CONSTRAINT "financial_effects_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "provider_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_effects" ADD CONSTRAINT "financial_effects_processingAttemptId_fkey" FOREIGN KEY ("processingAttemptId") REFERENCES "processing_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_effects" ADD CONSTRAINT "financial_effects_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_financialEffectId_fkey" FOREIGN KEY ("financialEffectId") REFERENCES "financial_effects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
