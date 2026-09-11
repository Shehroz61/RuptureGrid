// =====================================================================
// Unit — §7.1 classification table and §7.2 retry policy (permanent)
// =====================================================================
// The classification table is the accepted contract (architecture
// §7.1); these tests pin it. INDETERMINATE must never collapse into
// success/failure, and INDETERMINATE mutations must never auto-retry.

import { describe, expect, it } from 'vitest';
import { classifyInvocation, decideRetry, stageAtLeast } from './classify.js';

describe('classifyInvocation (§7.1 table)', () => {
  it('sent + definitive success → SUCCEEDED / KNOWN_OCCURRED', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'SUCCEEDED',
        httpStatus: 200,
      }),
    ).toEqual({ intentOutcome: 'SUCCEEDED', sideEffectKnowledge: 'KNOWN_OCCURRED' });
  });

  it('definitive 4xx under the demo contract → FAILED / KNOWN_ABSENT (no-effect guarantee)', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 401,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' });
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 409,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' });
  });

  it('definitive 4xx WITHOUT a no-effect contract → FAILED / INDETERMINATE', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'GENERIC_HTTP',
        transportStage: 'RESPONSE_COMPLETE',
        intentOutcome: 'FAILED',
        httpStatus: 422,
      }),
    ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
  });

  it('pre-send failure (DNS/refused/TLS) → FAILED / KNOWN_ABSENT', () => {
    for (const stage of ['PREPARED', 'CONNECTING'] as const) {
      expect(
        classifyInvocation({
          mutation: 'MUTATING',
          contractKind: 'GENERIC_HTTP',
          transportStage: stage,
          intentOutcome: 'FAILED',
          httpStatus: null,
        }),
      ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' });
    }
  });

  it('timeout or reset AFTER send → FAILED / INDETERMINATE', () => {
    for (const stage of ['REQUEST_SENT', 'RESPONSE_HEADERS', 'RESPONSE_COMPLETE'] as const) {
      expect(
        classifyInvocation({
          mutation: 'MUTATING',
          contractKind: 'DEMO_FINTECH_WEBHOOK',
          transportStage: stage,
          intentOutcome: 'FAILED',
          httpStatus: null,
        }),
      ).toEqual({ intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' });
    }
  });

  it('cancel before dispatch → CANCELLED / KNOWN_ABSENT', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: null,
        intentOutcome: 'CANCELLED',
        httpStatus: null,
      }),
    ).toEqual({ intentOutcome: 'CANCELLED', sideEffectKnowledge: 'KNOWN_ABSENT' });
  });

  it('cancel mid-flight with mutating request in flight → CANCELLED / INDETERMINATE', () => {
    expect(
      classifyInvocation({
        mutation: 'MUTATING',
        contractKind: 'DEMO_FINTECH_WEBHOOK',
        transportStage: 'REQUEST_SENT',
        intentOutcome: 'CANCELLED',
        httpStatus: null,
      }),
    ).toEqual({ intentOutcome: 'CANCELLED', sideEffectKnowledge: 'INDETERMINATE' });
  });

  it('read-only actions are NOT_APPLICABLE regardless of outcome', () => {
    for (const intent of ['SUCCEEDED', 'FAILED'] as const) {
      expect(
        classifyInvocation({
          mutation: 'READ_ONLY',
          contractKind: 'GENERIC_HTTP',
          transportStage: 'RESPONSE_COMPLETE',
          intentOutcome: intent,
          httpStatus: intent === 'SUCCEEDED' ? 200 : 500,
        }).sideEffectKnowledge,
      ).toBe('NOT_APPLICABLE');
    }
  });
});

describe('decideRetry (§7.2)', () => {
  it('INDETERMINATE mutating outcome is NEVER auto-retried (ADR-0008)', () => {
    expect(
      decideRetry({
        declaredPolicy: 'SAFE',
        mutation: 'MUTATING',
        sideEffectKnowledge: 'INDETERMINATE',
        intentOutcome: 'FAILED',
        attemptsSoFar: 1,
        maxAttempts: 3,
      }).willRetry,
    ).toBe(false);
    // Even a NONE policy obviously refuses; the SAFE case is the trap.
  });

  it('provably-not-sent SAFE failures retry within budget', () => {
    expect(
      decideRetry({
        declaredPolicy: 'SAFE',
        mutation: 'MUTATING',
        sideEffectKnowledge: 'KNOWN_ABSENT',
        intentOutcome: 'FAILED',
        attemptsSoFar: 1,
        maxAttempts: 3,
      }).willRetry,
    ).toBe(true);
    expect(
      decideRetry({
        declaredPolicy: 'SAFE',
        mutation: 'MUTATING',
        sideEffectKnowledge: 'KNOWN_ABSENT',
        intentOutcome: 'FAILED',
        attemptsSoFar: 3,
        maxAttempts: 3,
      }).willRetry,
    ).toBe(false);
  });

  it('read-only transient failures retry under SAFE', () => {
    expect(
      decideRetry({
        declaredPolicy: 'SAFE',
        mutation: 'READ_ONLY',
        sideEffectKnowledge: 'NOT_APPLICABLE',
        intentOutcome: 'FAILED',
        attemptsSoFar: 1,
        maxAttempts: 3,
      }).willRetry,
    ).toBe(true);
  });

  it('declared NONE never retries', () => {
    expect(
      decideRetry({
        declaredPolicy: 'NONE',
        mutation: 'READ_ONLY',
        sideEffectKnowledge: 'NOT_APPLICABLE',
        intentOutcome: 'FAILED',
        attemptsSoFar: 1,
        maxAttempts: 3,
      }).willRetry,
    ).toBe(false);
  });
});

describe('stage ordering', () => {
  it('stageAtLeast treats REQUEST_SENT as the send boundary', () => {
    expect(stageAtLeast('CONNECTING', 'REQUEST_SENT')).toBe(false);
    expect(stageAtLeast('REQUEST_SENT', 'REQUEST_SENT')).toBe(true);
    expect(stageAtLeast('RESPONSE_COMPLETE', 'REQUEST_SENT')).toBe(true);
    expect(stageAtLeast(null, 'REQUEST_SENT')).toBe(false);
  });
});
