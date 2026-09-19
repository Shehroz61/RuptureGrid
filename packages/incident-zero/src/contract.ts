// =====================================================================
// RuptureGrid v1.0 — Incident Zero canonical contract (Phase 7)
// =====================================================================
// The golden scenario constants, transcribed EXACTLY from the accepted
// contracts (docs/incident-zero.md §1–§6, docs/product-spec.md §7/§10,
// docs/incident-replay.md §1, ADR-0004, ADR-0005). Nothing here is a
// new truth engine: every value names a real, accepted behavior of the
// Phase 2 Demo Target under the Phase 3 executor's canonical workload.
//
// Canonical business story (both modes share it):
//   one legitimate logical provider payment of 500000 paisa (PKR 5,000,
//   integer minor units — ADR-0004); TWO logical provider events for
//   that payment (PAYMENT_CONFIRMED, PAYMENT_SETTLED); duplicate
//   delivery pressure of 10 physical deliveries per logical event
//   (20 total) at requested concurrency 8.
//
//   VULNERABLE semantics: event-scoped idempotency admits one
//   equivalent accepted wallet credit per logical event ⇒ 2 accepted
//   equivalent credits ⇒ wallet 1000000 paisa ⇒ INV-IZ-1 FAIL.
//   SECURE semantics: payment-scoped idempotency suppresses equivalent
//   duplicates ⇒ 1 accepted credit ⇒ wallet 500000 paisa ⇒ INV-IZ-1
//   PASS. Suppressed physical activity remains recorded (20 deliveries
//   / 20 processing attempts; 19 suppressed as IDEMPOTENT_DUPLICATE).

/** Money is integer minor units (paisa for PKR) — ADR-0004. Never a float. */
export const PAYMENT_AMOUNT_MINOR = 500000n;
export const PAYMENT_AMOUNT_CURRENCY = 'PKR';

/**
 * Physical duplicate-delivery pressure: incident-zero.md §1/§3 —
 * 20 experiment-declared deliveries of the same logical event payload
 * (10 per logical event), each a distinct deliveryAttemptId.
 */
export const DELIVERIES_PER_EVENT = 10;

/** Requested concurrency for the duplicate-delivery wave (incident-zero.md §4). */
export const DELIVERY_CONCURRENCY = 8;

/** Both logical provider events of the canonical payment (product-spec §7). */
export const LOGICAL_EVENT_COUNT = 2;

/** Derived totals (documented arithmetic, not new truth). */
export const TOTAL_DELIVERIES = DELIVERIES_PER_EVENT * LOGICAL_EVENT_COUNT; // 20

/**
 * Accepted equivalent WALLET_CREDIT effects under the canonical
 * workload — the INV-IZ-1 subject (incident-zero.md §5/§6).
 */
export const VULNERABLE_EXPECTED_EQUIVALENT_EFFECTS = 2;
export const SECURE_EXPECTED_EQUIVALENT_EFFECTS = 1;

/** Expected final wallet balance (integer paisa): 2× vs 1× the credit. */
export const VULNERABLE_EXPECTED_WALLET_BALANCE_MINOR = PAYMENT_AMOUNT_MINOR * 2n; // 1000000
export const SECURE_EXPECTED_WALLET_BALANCE_MINOR = PAYMENT_AMOUNT_MINOR; // 500000

/** Suppressed-but-recorded processing attempts in secure mode (Phase 2 accepted behavior). */
export const SECURE_EXPECTED_SUPPRESSED_ATTEMPTS =
  TOTAL_DELIVERIES - SECURE_EXPECTED_EQUIVALENT_EFFECTS; // 19

/** The flagship invariant key + its accepted evaluator identity. */
export const INVARIANT_KEY = 'INV-IZ-1';

/** Experiment definition names for the golden scenario (Control Plane artifacts). */
export const VULNERABLE_EXPERIMENT_NAME = 'incident-zero-golden-vulnerable';
export const SECURE_EXPERIMENT_NAME = 'incident-zero-golden-secure';

/** Version of the golden scenario definition itself (Phase 7 contract). */
export const GOLDEN_SCENARIO_VERSION = 'v1';

/**
 * The identity names the golden result carries, verbatim from
 * product-spec §7 — the five identities the forensic story walks.
 */
export const IDENTITY_NAMES = [
  'providerPaymentId',
  'providerEventId',
  'deliveryAttemptId',
  'processingAttemptId',
  'financialEffectId',
] as const;

/**
 * The canonical Incident Zero experiment document for one mode,
 * validated by the accepted Phase 3 validator and frozen into the
 * run snapshot. Steps (identical except the mode-setting body):
 *   reset → mode → create-payment → deliver-event-0 (10× @ 8) →
 *   deliver-event-1 (10× @ 8) → capture-lineage.
 *
 * `${steps.create-payment.response.events[N].payload}` carries the
 * provider's own event payload (identity flow — architecture §5);
 * `${signature}` is computed by the executor over the final bytes
 * (the signing secret never enters the document — validate.ts).
 */
export function goldenScenarioSteps(mode: 'VULNERABLE' | 'SECURE'): Array<Record<string, unknown>> {
  return [
    {
      name: 'reset',
      action: {
        method: 'POST',
        relativePath: '/demo/admin/reset',
        headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_ADMIN_TOKEN'],
      },
    },
    {
      name: 'mode',
      action: {
        method: 'PUT',
        relativePath: '/demo/admin/mode',
        headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
        body: JSON.stringify({ mode }),
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_ADMIN_TOKEN'],
      },
    },
    {
      name: 'create-payment',
      action: {
        method: 'POST',
        relativePath: '/demo/provider/payments',
        headers: { authorization: 'Bearer ${credential.DEMO_ADMIN_TOKEN}' },
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        credentialRefs: ['DEMO_ADMIN_TOKEN'],
      },
    },
    {
      name: 'deliver-event-0',
      action: {
        method: 'POST',
        relativePath: '/webhooks/provider',
        headers: { 'x-rupturegrid-provider-signature': '${signature}' },
        body: '${steps.create-payment.response.events[0].payload}',
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        repeat: DELIVERIES_PER_EVENT,
        concurrency: DELIVERY_CONCURRENCY,
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      },
    },
    {
      name: 'deliver-event-1',
      action: {
        method: 'POST',
        relativePath: '/webhooks/provider',
        headers: { 'x-rupturegrid-provider-signature': '${signature}' },
        body: '${steps.create-payment.response.events[1].payload}',
        mutation: 'MUTATING',
        contract: 'DEMO_FINTECH_WEBHOOK',
        repeat: DELIVERIES_PER_EVENT,
        concurrency: DELIVERY_CONCURRENCY,
        credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      },
    },
    {
      name: 'capture-lineage',
      action: {
        method: 'GET',
        relativePath: '/health/live',
        mutation: 'READ_ONLY',
        contract: 'DEMO_FINTECH_WEBHOOK',
        evidenceAdapter: {
          kind: 'demo-fintech-payment-lineage' as const,
          providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
        },
      },
    },
  ];
}
