-- CreateEnum
CREATE TYPE "CommerceProcessingMode" AS ENUM ('VULNERABLE', 'SECURE');

-- CreateEnum
CREATE TYPE "CheckoutIntentStatus" AS ENUM ('OPEN', 'PROCESSING', 'SETTLED');

-- CreateEnum
CREATE TYPE "ProcessingOutcome" AS ENUM ('ACCEPTED', 'INTENT_ALREADY_ACCEPTED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACCEPTED');

-- ---------------------------------------------------------------------
-- Monotonic start-ordinal sequence: authoritative persisted ordering
-- evidence for processing-attempt overlap analysis (testing-strategy
-- §6). Created explicitly so no ORM-side default can silently drift.
-- ---------------------------------------------------------------------
CREATE SEQUENCE "processing_attempt_start_seq" AS bigint START 1;

-- CreateTable
CREATE TABLE "commerce_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "processingMode" "CommerceProcessingMode" NOT NULL DEFAULT 'VULNERABLE',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commerce_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_scopes" (
    "id" UUID NOT NULL,
    "scopeId" TEXT NOT NULL,
    "generationId" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "scopeId" UUID NOT NULL,
    "initialAvailableUnits" INTEGER NOT NULL,
    "remainingAvailableUnits" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_intents" (
    "id" UUID NOT NULL,
    "checkoutIntentId" TEXT NOT NULL,
    "scopeId" UUID NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "sku" TEXT NOT NULL,
    "status" "CheckoutIntentStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_events" (
    "id" UUID NOT NULL,
    "checkoutEventId" TEXT NOT NULL,
    "intentId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_attempts" (
    "id" UUID NOT NULL,
    "requestAttemptId" TEXT NOT NULL,
    "intentId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_attempts" (
    "id" UUID NOT NULL,
    "processingAttemptId" TEXT NOT NULL,
    "requestAttemptId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startSequence" BIGINT NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "outcome" "ProcessingOutcome",
    "failureReason" TEXT,

    CONSTRAINT "processing_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "orderId" TEXT NOT NULL,
    "intentId" UUID NOT NULL,
    "processingAttemptId" UUID NOT NULL,
    "customerId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "orderTotalMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "reservationId" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "skuRowId" UUID NOT NULL,
    "reservedUnits" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_fault_plans" (
    "id" UUID NOT NULL,
    "faultKind" VARCHAR(40) NOT NULL,
    "planVersion" VARCHAR(32) NOT NULL,
    "activation" VARCHAR(40) NOT NULL,
    "maxTriggers" INTEGER NOT NULL,
    "triggersUsed" INTEGER NOT NULL DEFAULT 0,
    "armedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastTriggeredAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commerce_fault_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_scopes_scopeId_key" ON "verification_scopes"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "skus_sku_key" ON "skus"("sku");

-- CreateIndex
CREATE INDEX "skus_scopeId_idx" ON "skus"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_intents_checkoutIntentId_key" ON "checkout_intents"("checkoutIntentId");

-- CreateIndex
CREATE INDEX "checkout_intents_scopeId_idx" ON "checkout_intents"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_events_checkoutEventId_key" ON "checkout_events"("checkoutEventId");

-- CreateIndex
CREATE INDEX "checkout_events_intentId_idx" ON "checkout_events"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "request_attempts_requestAttemptId_key" ON "request_attempts"("requestAttemptId");

-- CreateIndex
CREATE INDEX "request_attempts_intentId_idx" ON "request_attempts"("intentId");

-- CreateIndex
CREATE INDEX "request_attempts_eventId_idx" ON "request_attempts"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "processing_attempts_processingAttemptId_key" ON "processing_attempts"("processingAttemptId");

-- CreateIndex
CREATE INDEX "processing_attempts_requestAttemptId_idx" ON "processing_attempts"("requestAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderId_key" ON "orders"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_processingAttemptId_key" ON "orders"("processingAttemptId");

-- CreateIndex
CREATE INDEX "orders_intentId_idx" ON "orders"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_reservationId_key" ON "reservations"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_orderId_key" ON "reservations"("orderId");

-- CreateIndex
CREATE INDEX "reservations_sku_idx" ON "reservations"("sku");

-- CreateIndex
CREATE INDEX "reservations_skuRowId_idx" ON "reservations"("skuRowId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_fault_plans_faultKind_key" ON "commerce_fault_plans"("faultKind");

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "verification_scopes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "verification_scopes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_events" ADD CONSTRAINT "checkout_events_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "checkout_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_attempts" ADD CONSTRAINT "processing_attempts_requestAttemptId_fkey" FOREIGN KEY ("requestAttemptId") REFERENCES "request_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_processingAttemptId_fkey" FOREIGN KEY ("processingAttemptId") REFERENCES "processing_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_skuRowId_fkey" FOREIGN KEY ("skuRowId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Business sign discipline (ADR-0023 §8 B-2): baselines are
-- non-negative; accepted reservations consume NON-NEGATIVE unit
-- counts. remainingAvailableUnits is deliberately unconstrained — it
-- MAY legitimately go negative under a broken target, and that exact
-- fact is what the conservation invariant records.
-- ---------------------------------------------------------------------

ALTER TABLE "skus" ADD CONSTRAINT "skus_initial_nonnegative_check" CHECK ("initialAvailableUnits" >= 0);
ALTER TABLE "skus" ADD CONSTRAINT "skus_initial_safe_check" CHECK ("initialAvailableUnits" <= 9007199254740991);
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_units_nonnegative_check" CHECK ("reservedUnits" >= 0);
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_units_positive_check" CHECK ("reservedUnits" > 0);
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_total_nonnegative_check" CHECK ("totalMinor" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_nonnegative_check" CHECK ("orderTotalMinor" >= 0);
ALTER TABLE "processing_attempts" ADD CONSTRAINT "processing_attempts_startsequence_safe_check" CHECK ("startSequence" <= 9007199254740991);
