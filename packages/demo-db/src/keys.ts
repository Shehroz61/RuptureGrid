// =====================================================================
// Demo Fintech — idempotency scopes (the heart of Incident Zero)
// =====================================================================
// The database-enforced uniqueness on ledger_entries.idempotency_key is
// THE business idempotency mechanism. Its KEY SCOPE decides whether one
// logical payment can produce one or many accepted credits:
//
// VULNERABLE mode — technical idempotency, wrong business scope:
//   wallet-credit:event:<providerEventId>:<walletId>
//   Each logical EVENT is idempotent (re-deliveries of the same event
//   are suppressed — every individual delivery looks "correctly
//   handled"), but several semantically related events for ONE logical
//   payment (confirmed + settled) each create an accepted credit.
//   Deterministic outcome: 2 effects, wallet = 1000000 paisa.
//
// SECURE mode — business idempotency, payment-level scope:
//   wallet-credit:payment:<providerPaymentId>:<walletId>
//   Every event, delivery and processing attempt for the logical
//   payment collapses to at most ONE accepted equivalent credit —
//   enforced by PostgreSQL uniqueness inside the financial
//   transaction, not by application locks or balance checks.
//   Deterministic outcome: 1 effect, wallet = 500000 paisa.
//
// Legitimate DIFFERENT payments never collide: their providerPaymentId
// differs. Two payments of the same amount to the same wallet remain
// independent (contract §115–§118: no balance/timestamp/amount-only
// idempotency).

/** The two processing modes the target owns. */
export type ProcessingMode = 'VULNERABLE' | 'SECURE';

export const PROCESSING_MODES: readonly ProcessingMode[] = ['VULNERABLE', 'SECURE'] as const;

/** Key prefix used by every idempotency key — auditable in the DB. */
export const IDEMPOTENCY_KEY_PREFIX = 'wallet-credit';

/**
 * Derives the ledger idempotency key for a wallet-credit effect under
 * the given processing mode. Pure and deterministic.
 */
export function deriveIdempotencyKey(input: {
  mode: ProcessingMode;
  providerPaymentId: string;
  providerEventId: string;
  walletId: string;
}): string {
  const { mode, providerPaymentId, providerEventId, walletId } = input;
  if (mode === 'SECURE') {
    return `${IDEMPOTENCY_KEY_PREFIX}:payment:${providerPaymentId}:${walletId}`;
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:event:${providerEventId}:${walletId}`;
}
