// =====================================================================
// Demo Commerce — checkout submission service (one physical request →
// one processing path)
// =====================================================================
// The ONLY order of authority for a checkout submission:
//   1. authenticity — HMAC-SHA256 over the EXACT raw body bytes with
//      the Commerce signing secret (never any other target's secret);
//   2. the declared payload contract (typed, closed, exact);
//   3. the target-owned PRE_MUTATION_REJECTION fault hook — AFTER all
//      validation, BEFORE any persistence (docs/controlled-faults.md
//      §4.1; the target never claims the platform's classification);
//   4. the business core: one synchronous processing path per physical
//      submission (vulnerable/secure by the target's own durable mode).
// No RuptureGrid concept exists in this file: the target reports
// commerce facts and outcomes only (R-18).

import type {
  CheckoutPayload,
  CommerceDb,
  FaultControlService,
  SubmitCheckoutResult,
} from '@rupturegrid/commerce-db';
import {
  CheckoutPayloadError,
  parseCheckoutPayload,
  submitCheckout,
  verifyCheckoutSignature,
} from '@rupturegrid/commerce-db';
import {
  CheckoutAuthenticationError,
  ControlledFaultRejectionError,
  PayloadInvalidError,
} from './errors.js';

export interface CheckoutSubmissionService {
  submit(input: {
    /** Executor-assigned physical request identity, recorded verbatim. */
    requestAttemptId: string;
    /** Exact transmitted body bytes (the signature binds these). */
    rawBody: Buffer;
    /** Raw signature header value as received. */
    signatureHeader: string | undefined;
    /** JSON-parsed body (semantic validation happens here, not in Express). */
    parsedBody: unknown;
  }): Promise<SubmitCheckoutResult>;
}

export function createCheckoutSubmissionService(options: {
  db: CommerceDb;
  faults: FaultControlService;
  signingSecret: string;
}): CheckoutSubmissionService {
  const { db, faults, signingSecret } = options;

  return {
    async submit(input): Promise<SubmitCheckoutResult> {
      // 1. Authenticity first: no payload semantics are evaluated for an
      //    unauthenticated request. The secret value never appears in
      //    the error surface (R-13).
      if (
        typeof input.signatureHeader !== 'string' ||
        !verifyCheckoutSignature(signingSecret, input.rawBody, input.signatureHeader)
      ) {
        throw new CheckoutAuthenticationError('checkout signature missing or invalid');
      }

      // 2. Payload contract: exact, typed, closed — no coercion.
      let payload: CheckoutPayload;
      try {
        payload = parseCheckoutPayload(input.parsedBody);
      } catch (error) {
        if (error instanceof CheckoutPayloadError) {
          throw new PayloadInvalidError(error.message);
        }
        throw error;
      }

      // 3. Controlled fault: definitive contract rejection after ALL
      //    validation and BEFORE any persistence. The classification of
      //    this 409 (under the conservative GENERIC_HTTP contract, an
      //    INDETERMINATE post-send outcome) is the PLATFORM's decision —
      //    the target's own claim would be metadata, never truth.
      const rejection = await faults.consumeTrigger('PRE_MUTATION_REJECTION');
      if (rejection === 'TRIGGERED') {
        throw new ControlledFaultRejectionError(
          'checkout rejected by the target before any business mutation (controlled fault)',
        );
      }

      // 4. Exactly one processing path for this physical submission.
      return submitCheckout(db, {
        rawBody: input.rawBody,
        requestAttemptId: input.requestAttemptId,
        payload,
      });
    },
  };
}
