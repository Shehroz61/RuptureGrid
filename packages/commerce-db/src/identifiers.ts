// =====================================================================
// Demo Commerce — canonical identities and contracts
// =====================================================================
// The Checkout Zero identities (docs/checkout-zero.md §3, ADR-0020
// Decision 1) are DISTINCT concepts and are never collapsed:
//
//   checkoutIntentId     — logical business intent (caller-assigned,
//                          unique WITHIN a verification scope)
//   checkoutEventId      — logical event about one intent (target-
//                          assigned, deterministic, scope-qualified)
//   requestAttemptId     — ONE physical API call (executor-assigned, header)
//   processingAttemptId  — ONE target-side processing attempt (target)
//   orderId              — ONE accepted order effect (target)
//   reservationId        — ONE accepted reservation effect (target)
//   sku                  — the resource identity (scenario-assigned)
//
// No name is shared with the fintech domain: this is a genuinely
// separate commerce/inventory model, not a rename.

/**
 * Request-attempt header: identity of ONE physical submission.
 *
 * The VALUE is the executor's single platform-owned per-invocation
 * identity — the same `x-rupturegrid-delivery-attempt-id` framing
 * header the executor has always attached to every physical call
 * (executor-owned; step headers can never override it, and it is
 * unique per physical attempt, including both concurrent repeat slots
 * of one step). The target records its value VERBATIM as its
 * requestAttemptId (docs/checkout-zero.md §2: "the target records the
 * same correlation identity"), so executor evidence and target
 * evidence correlate on exact string equality. There is deliberately
 * NO second, target-specific identity header mechanism in the
 * platform: inventing one (a per-slot header template) would be a new
 * execution-surface grammar, and static scenario constants cannot
 * express "distinct per physical submission".
 */
export const REQUEST_ATTEMPT_HEADER = 'x-rupturegrid-delivery-attempt-id';

/** Checkout-signature header (hex HMAC-SHA256 over the raw body). */
export const CHECKOUT_SIGNATURE_HEADER = 'x-commerce-signature';

// Bounded printable token: starts alphanumeric, then identifier
// characters. The minimum is 3 characters because the CANONICAL
// Checkout Zero identities (docs/checkout-zero.md §3) are short stable
// tokens — CHK-001, CE-001, RA-001, SKU-001 — and the target contract
// must accept them; the maximum keeps the token bounded. Long
// identifiers remain legal and are used by the platform suites
// (testing-strategy §10), which is exactly why no LENGTH is ever part
// of identity semantics: only exact-equality values are.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;

/**
 * Validates a caller-supplied business identity (bounded printable
 * token).
 */
export function isWellFormedIdentity(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
