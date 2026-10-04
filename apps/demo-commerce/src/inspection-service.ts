// =====================================================================
// Demo Commerce — read-only inspection service (target-authored truth)
// =====================================================================
// RuptureGrid observes target business truth HERE, over HTTP, with a
// credential-free read-only surface (ADR-0021/ADR-0022: the Phase 14
// generic inspection adapter attaches no Authorization header, so this
// surface accepts none and must never require one). Every endpoint is
// a LITERAL static collection path (ADR-0022): no runtime parameter
// binding, no interpolation — subject identity, verification scope,
// and experiment generation travel in the returned entities.
//
// Every array element carries EXACTLY the fields its manifest query
// declares (ADR-0021 shape validation is exact: an undeclared extra
// field or a missing declared field invalidates the whole capture).
// Values are commerce FACTS only — no invariant verdicts, no
// PASS/FAIL/NOT_EVALUABLE, no RuptureGrid truth vocabulary (R-18).
//
// Processing attempts: only FINISHED attempts are returned
// (finishedAt/outcome are non-null). An in-flight attempt cannot carry
// the declared timestamp fields without nulls, and null is not a
// declared shape; the quiescence surface reports in-flight counts so a
// caller can prove quiescence (bounded polling) before verification
// instead of guessing. This is a declared filtering property of this
// surface, not a completeness claim (ADR-0022 §6).
//
// Exact-integer discipline: money-like values are bigint in the
// database; they are emitted as JSON numbers only after an explicit
// safe-integer guard — a value that could not be represented exactly
// fails loudly instead of being silently rounded (R-06).

import type { CommerceDb } from '@rupturegrid/commerce-db';

/** Money-like bigint → exact JSON number, or a loud failure (R-06). */
function toExactNumber(value: bigint, field: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`inspection value ${field} is outside the exact JSON-safe integer envelope`);
  }
  return asNumber;
}

// ---------------------------------------------------------------------
// Declared entity shapes (field-for-field with the manifest queries)
// ---------------------------------------------------------------------

export interface CheckoutIntentEntity {
  checkoutIntentId: string;
  customerId: string;
  cartId: string;
  totalMinor: number;
  currency: string;
  sku: string;
  status: string;
  verificationScopeId: string;
  generationId: number;
}

export interface RequestAttemptEntity {
  requestAttemptId: string;
  checkoutIntentId: string;
  verificationScopeId: string;
  generationId: number;
}

export interface ProcessingAttemptEntity {
  processingAttemptId: string;
  requestAttemptId: string;
  startSequence: number;
  startedAt: string;
  finishedAt: string;
  outcome: string;
  verificationScopeId: string;
  generationId: number;
}

export interface OrderEntity {
  orderId: string;
  checkoutIntentId: string;
  processingAttemptId: string;
  customerId: string;
  cartId: string;
  totalMinor: number;
  currency: string;
  status: string;
  verificationScopeId: string;
  generationId: number;
}

export interface ReservationEntity {
  reservationId: string;
  orderId: string;
  sku: string;
  reservedUnits: number;
  status: string;
  verificationScopeId: string;
  generationId: number;
}

export interface SkuEntity {
  sku: string;
  verificationScopeId: string;
  generationId: number;
}

export interface SkuBaselineEntity {
  sku: string;
  initialAvailableUnits: number;
  verificationScopeId: string;
  generationId: number;
}

export interface SkuRemainingEntity {
  sku: string;
  remainingAvailableUnits: number;
  verificationScopeId: string;
  generationId: number;
}

export interface OrdersSummaryEntity {
  checkoutIntentId: string;
  acceptedOrderTotal: number;
  verificationScopeId: string;
  generationId: number;
}

export interface ReservationsSummaryEntity {
  sku: string;
  acceptedReservationTotal: number;
  verificationScopeId: string;
  generationId: number;
}

export interface QuiescenceEntity {
  inFlightProcessingAttempts: number;
  totalProcessingAttempts: number;
  verificationScopeId: string;
  generationId: number;
}

export interface CommerceInspectionService {
  checkoutIntents(): Promise<CheckoutIntentEntity[]>;
  requestAttempts(): Promise<RequestAttemptEntity[]>;
  processingAttempts(): Promise<ProcessingAttemptEntity[]>;
  orders(): Promise<OrderEntity[]>;
  reservations(): Promise<ReservationEntity[]>;
  skus(): Promise<SkuEntity[]>;
  skuBaselines(): Promise<SkuBaselineEntity[]>;
  skuRemainings(): Promise<SkuRemainingEntity[]>;
  ordersSummaries(): Promise<OrdersSummaryEntity[]>;
  reservationsSummaries(): Promise<ReservationsSummaryEntity[]>;
  quiescence(): Promise<QuiescenceEntity[]>;
}

export function createCommerceInspectionService(db: CommerceDb): CommerceInspectionService {
  const { client } = db;

  return {
    /** One element per logical checkout intent. */
    async checkoutIntents(): Promise<CheckoutIntentEntity[]> {
      const rows = await client.checkoutIntent.findMany({
        include: { scope: true },
        orderBy: [{ createdAt: 'asc' }, { checkoutIntentId: 'asc' }],
      });
      return rows.map((row) => ({
        checkoutIntentId: row.checkoutIntentId,
        customerId: row.customerId,
        cartId: row.cartId,
        totalMinor: toExactNumber(row.totalMinor, 'totalMinor'),
        currency: row.currency,
        sku: row.sku,
        status: row.status,
        verificationScopeId: row.scope.scopeId,
        generationId: row.scope.generationId,
      }));
    },

    /** One element per PHYSICAL submission, recording the executor's header verbatim. */
    async requestAttempts(): Promise<RequestAttemptEntity[]> {
      const rows = await client.requestAttempt.findMany({
        include: { intent: { include: { scope: true } } },
        orderBy: [{ receivedAt: 'asc' }, { requestAttemptId: 'asc' }],
      });
      return rows.map((row) => ({
        requestAttemptId: row.requestAttemptId,
        checkoutIntentId: row.intent.checkoutIntentId,
        verificationScopeId: row.intent.scope.scopeId,
        generationId: row.intent.scope.generationId,
      }));
    },

    /**
     * One element per FINISHED target-side processing attempt
     * (startSequence preserves authoritative start ordering).
     */
    async processingAttempts(): Promise<ProcessingAttemptEntity[]> {
      const rows = await client.processingAttempt.findMany({
        where: { finishedAt: { not: null } },
        include: {
          requestAttempt: { include: { intent: { include: { scope: true } } } },
        },
        orderBy: [{ startSequence: 'asc' }, { processingAttemptId: 'asc' }],
      });
      return rows.map((row) => {
        if (row.finishedAt === null || row.outcome === null) {
          // Unreachable given the filter; fail loudly rather than emit null.
          throw new Error('inspection invariant violated: unfinished processing attempt selected');
        }
        return {
          processingAttemptId: row.processingAttemptId,
          requestAttemptId: row.requestAttempt.requestAttemptId,
          startSequence: toExactNumber(row.startSequence, 'startSequence'),
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt.toISOString(),
          outcome: row.outcome,
          verificationScopeId: row.requestAttempt.intent.scope.scopeId,
          generationId: row.requestAttempt.intent.scope.generationId,
        };
      });
    },

    /** One element per accepted-or-rejected order effect. */
    async orders(): Promise<OrderEntity[]> {
      const rows = await client.order.findMany({
        include: {
          intent: { include: { scope: true } },
          processingAttempt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { orderId: 'asc' }],
      });
      return rows.map((row) => ({
        orderId: row.orderId,
        checkoutIntentId: row.intent.checkoutIntentId,
        processingAttemptId: row.processingAttempt.processingAttemptId,
        customerId: row.customerId,
        cartId: row.cartId,
        totalMinor: toExactNumber(row.orderTotalMinor, 'orderTotalMinor'),
        currency: row.currency,
        status: row.status,
        verificationScopeId: row.intent.scope.scopeId,
        generationId: row.intent.scope.generationId,
      }));
    },

    /** One element per accepted reservation effect against a SKU. */
    async reservations(): Promise<ReservationEntity[]> {
      const rows = await client.reservation.findMany({
        include: { order: { include: { intent: { include: { scope: true } } } } },
        orderBy: [{ createdAt: 'asc' }, { reservationId: 'asc' }],
      });
      return rows.map((row) => ({
        reservationId: row.reservationId,
        orderId: row.order.orderId,
        sku: row.sku,
        reservedUnits: row.reservedUnits,
        status: row.status,
        verificationScopeId: row.order.intent.scope.scopeId,
        generationId: row.order.intent.scope.generationId,
      }));
    },

    /** One element per stocked resource. */
    async skus(): Promise<SkuEntity[]> {
      const rows = await client.sku.findMany({
        include: { scope: true },
        orderBy: [{ sku: 'asc' }],
      });
      return rows.map((row) => ({
        sku: row.sku,
        verificationScopeId: row.scope.scopeId,
        generationId: row.scope.generationId,
      }));
    },

    /** One element per SKU carrying the declared BASELINE (never inferred). */
    async skuBaselines(): Promise<SkuBaselineEntity[]> {
      const rows = await client.sku.findMany({
        include: { scope: true },
        orderBy: [{ sku: 'asc' }],
      });
      return rows.map((row) => ({
        sku: row.sku,
        initialAvailableUnits: row.initialAvailableUnits,
        verificationScopeId: row.scope.scopeId,
        generationId: row.scope.generationId,
      }));
    },

    /** One element per SKU carrying the current REMAINING state. */
    async skuRemainings(): Promise<SkuRemainingEntity[]> {
      const rows = await client.sku.findMany({
        include: { scope: true },
        orderBy: [{ sku: 'asc' }],
      });
      return rows.map((row) => ({
        sku: row.sku,
        remainingAvailableUnits: row.remainingAvailableUnits,
        verificationScopeId: row.scope.scopeId,
        generationId: row.scope.generationId,
      }));
    },

    /**
     * Per-intent accepted-order totals (ADR-0023 observed-total
     * completeness surface). Intents with zero accepted orders are
     * PRESENT with total 0 — a real observed zero, never an absent row.
     */
    async ordersSummaries(): Promise<OrdersSummaryEntity[]> {
      const intents = await client.checkoutIntent.findMany({
        include: { scope: true },
        orderBy: [{ createdAt: 'asc' }, { checkoutIntentId: 'asc' }],
      });
      const groups = await client.order.groupBy({
        by: ['intentId'],
        where: { status: 'ACCEPTED' },
        _count: { _all: true },
      });
      const counts = new Map(groups.map((group) => [group.intentId, group._count._all]));
      return intents.map((intent) => ({
        checkoutIntentId: intent.checkoutIntentId,
        acceptedOrderTotal: counts.get(intent.id) ?? 0,
        verificationScopeId: intent.scope.scopeId,
        generationId: intent.scope.generationId,
      }));
    },

    /**
     * Per-SKU accepted-reservation totals (ADR-0023 observed-total
     * completeness surface), zero totals included. The total counts
     * ONLY reservations whose order's intent belongs to the SAME
     * verification scope the SKU row is currently bound to: a
     * reservation made under a DIFFERENT scope binding can never
     * inflate the current scope's observed total — cross-scope
     * attribution is exactly what the scope binding exists to prevent
     * (ADR-0023 §4).
     */
    async reservationsSummaries(): Promise<ReservationsSummaryEntity[]> {
      const skuRows = await client.sku.findMany({
        include: { scope: true },
        orderBy: [{ sku: 'asc' }],
      });
      const counts = await Promise.all(
        skuRows.map((row) =>
          client.reservation.count({
            where: {
              sku: row.sku,
              status: 'ACCEPTED',
              order: { intent: { scopeId: row.scopeId } },
            },
          }),
        ),
      );
      return skuRows.map((row, index) => ({
        sku: row.sku,
        acceptedReservationTotal: counts[index] ?? 0,
        verificationScopeId: row.scope.scopeId,
        generationId: row.scope.generationId,
      }));
    },

    /**
     * Quiescence evidence per scope: in-flight and total processing
     * attempts. The settle step polls this until
     * inFlightProcessingAttempts == 0 — bounded polling of authoritative
     * persisted state, never a fixed sleep (testing-strategy §6).
     */
    async quiescence(): Promise<QuiescenceEntity[]> {
      const scopes = await client.verificationScope.findMany({
        orderBy: [{ scopeId: 'asc' }],
      });
      const results: QuiescenceEntity[] = [];
      for (const scope of scopes) {
        const total = await client.processingAttempt.count({
          where: { requestAttempt: { intent: { scopeId: scope.id } } },
        });
        const inFlight = await client.processingAttempt.count({
          where: {
            finishedAt: null,
            requestAttempt: { intent: { scopeId: scope.id } },
          },
        });
        results.push({
          inFlightProcessingAttempts: inFlight,
          totalProcessingAttempts: total,
          verificationScopeId: scope.scopeId,
          generationId: scope.generationId,
        });
      }
      return results;
    },
  };
}
