// =====================================================================
// Demo Fintech — canonical business identities
// =====================================================================
// The five identities are DISTINCT concepts (docs/product-spec.md §7)
// and are never collapsed into one generic "eventId":
//
//   providerPaymentId    — logical provider-confirmed payment
//   providerEventId      — logical provider event about that payment
//   deliveryAttemptId    — ONE physical webhook/network delivery
//   processingAttemptId  — ONE application processing attempt (target-side)
//   financialEffectId    — ONE accepted financial effect (target-side)
//
// providerPaymentId/providerEventId/deliveryAttemptId are
// caller-assigned and carried over HTTP. processingAttemptId and
// financialEffectId are assigned by the Demo Target itself.

/** Delivery-attempt header: identity of ONE physical delivery. */
export const DELIVERY_ATTEMPT_HEADER = 'x-rupturegrid-delivery-attempt-id';

/** Provider-signature header (hex HMAC-SHA256 over the raw body). */
export const PROVIDER_SIGNATURE_HEADER = 'x-rupturegrid-provider-signature';

/** Canonical amounts (integer minor units, paisa). */
export const CANONICAL_PAYMENT_AMOUNT_MINOR = 500000n;
export const CANONICAL_DUPLICATED_AMOUNT_MINOR = 1000000n;

/** Canonical demo entities created by reset/bootstrap. */
export const CANONICAL_CUSTOMER_REFERENCE = 'demo-customer-001';
export const CANONICAL_WALLET_CURRENCY = 'PKR';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

/**
 * Validates a caller-supplied business identity. Honest-representation
 * rules: identifiers are non-empty printable tokens of bounded length
 * (16–128 chars here); long identifiers are fixture-default per
 * docs/testing-strategy.md §10.
 */
export function isWellFormedIdentity(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
