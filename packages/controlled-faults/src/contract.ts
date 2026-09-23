// =====================================================================
// RuptureGrid v1.0 — controlled-faults verification contract (Phase 9)
// =====================================================================
// The frozen expectations of the two crown-jewel Phase 9 scenarios
// (docs/controlled-faults.md §8). Assertions are evaluated against
// DURABLE Control-Plane truth (engine rows, evidence, evaluations,
// timeline, reproduction) and target-authored fault-status truth —
// never against this runner's own summary numbers alone.

import { CONTROLLED_FAULT_PLAN_VERSION } from '@rupturegrid/shared';

/** Version of this verification contract (bumped only explicitly). */
export const CONTROLLED_FAULTS_CONTRACT_VERSION = 'controlled-faults-verify/v1';

/** The exact fault plan frozen into the PRE_MUTATION_REJECTION step. */
export const PRE_MUTATION_PLAN = {
  planVersion: CONTROLLED_FAULT_PLAN_VERSION,
  faultKind: 'PRE_MUTATION_REJECTION',
  activation: 'first_n_matching_deliveries',
  maxTriggers: 1,
} as const;

/** The exact fault plan frozen into the RESPONSE_TRUNCATION step. */
export const RESPONSE_LOSS_PLAN = {
  planVersion: CONTROLLED_FAULT_PLAN_VERSION,
  faultKind: 'RESPONSE_TRUNCATION',
  activation: 'first_n_matching_deliveries',
  maxTriggers: 1,
} as const;

/**
 * Scenario step builders. The shapes mirror the accepted Phase 3/4
 * document surface (ordered steps, one action type, explicit adapters).
 */

/** Admin reset + SECURE mode + canonical payment creation. */
export function setupSteps(): Array<Record<string, unknown>> {
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
        body: JSON.stringify({ mode: 'SECURE' }),
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
  ];
}

/** Signed webhook delivery step carrying the given fault plan. */
export function faultDeliveryStep(
  faultPlan: Record<string, unknown>,
  withAdapter = false,
): Record<string, unknown> {
  return {
    name: 'deliver-with-fault',
    action: {
      method: 'POST',
      relativePath: '/webhooks/provider',
      headers: { 'x-rupturegrid-provider-signature': '${signature}' },
      body: '${steps.create-payment.response.events[0].payload}',
      mutation: 'MUTATING',
      contract: 'DEMO_FINTECH_WEBHOOK',
      credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET'],
      faultPlan,
      // Response-loss proof: the fault-bearing step declares the
      // explicit adapter so the engine captures the target's OWN
      // business state AFTER this step's terminal write — the committed
      // truth enters evidence without rewriting the invocation (§4.2).
      ...(withAdapter
        ? {
            evidenceAdapter: {
              kind: 'demo-fintech-payment-lineage',
              providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
            },
          }
        : {}),
    },
  };
}

/** Read-only explicit lineage capture (identity from the target's response). */
export function lineageCaptureStep(): Record<string, unknown> {
  return {
    name: 'capture-lineage',
    action: {
      method: 'GET',
      relativePath: '/health/live',
      mutation: 'READ_ONLY',
      contract: 'DEMO_FINTECH_WEBHOOK',
      evidenceAdapter: {
        kind: 'demo-fintech-payment-lineage',
        providerPaymentIdFrom: '${steps.create-payment.response.payment.providerPaymentId}',
      },
    },
  };
}

export const PRE_MUTATION_STEPS = (): Array<Record<string, unknown>> => [
  ...setupSteps(),
  faultDeliveryStep({ ...PRE_MUTATION_PLAN }),
];

export const RESPONSE_LOSS_STEPS = (): Array<Record<string, unknown>> => [
  ...setupSteps(),
  // Pre-delivery target state (honest "before" evidence).
  lineageCaptureStep(),
  // The ambiguous delivery itself declares the adapter: its FAILED
  // terminal still captures the post-mutation truth.
  faultDeliveryStep({ ...RESPONSE_LOSS_PLAN }, true),
];
