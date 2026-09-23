// =====================================================================
// Unit — Phase 9 invariants INV-DF-1 / INV-DF-2 (docs/controlled-faults.md §6)
// =====================================================================
// Deterministic, pure evaluation-tier verdicts over the persisted
// evidence graph. PASS requires complete evidence; gaps are
// NOT_EVALUABLE, never silently assumed. Money is integer minor units
// carried as exact decimal strings (R-06 — never floats).

import { describe, expect, it } from 'vitest';
import { evaluateInvDf1, evaluateInvDf2 } from './invariants.js';
import type { InvariantEvidenceGraph } from './invariants.js';

function graph(events: InvariantEvidenceGraph['events']): InvariantEvidenceGraph {
  return { runId: 'r-1', events, relationships: [] };
}

const walletEvent = (overrides: Record<string, unknown>, id = 'e-1') => ({
  id,
  eventType: 'demo.wallet-state-observed',
  subjectKey: 'PP-1',
  payload: {
    walletId: 'w-1',
    balanceMinor: '1000000',
    currency: 'PKR',
    walletLedgerCreditSumMinor: '1000000',
    walletBalanceDifferenceMinor: '0',
    ...overrides,
  },
  inputHash: 'h-' + id,
});

describe('INV-DF-1 balance conservation', () => {
  it('passes when the target-reported whole-wallet difference is exactly zero', () => {
    const results = evaluateInvDf1(graph([walletEvent({})]));
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe('PASS');
    expect(results[0]?.subjectKey).toBe('w-1');
  });

  it('fails when the balance and ledger sum disagree (exact integers)', () => {
    const results = evaluateInvDf1(
      graph([walletEvent({ walletBalanceDifferenceMinor: '-500000' })]),
    );
    expect(results[0]?.verdict).toBe('FAIL');
    expect(results[0]?.details['disagreementEventIds']).toEqual(['e-1']);
  });

  it('is NOT_EVALUABLE when no observation carries the reconciliation fields', () => {
    const results = evaluateInvDf1(
      graph([
        walletEvent(
          { walletLedgerCreditSumMinor: null, walletBalanceDifferenceMinor: null },
          'e-old',
        ),
      ]),
    );
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
  });

  it('fails if ANY observed reconciliation disagrees (every observation counted)', () => {
    const results = evaluateInvDf1(
      graph([
        walletEvent({ walletBalanceDifferenceMinor: '1' }, 'e-1'),
        walletEvent({ walletBalanceDifferenceMinor: '0' }, 'e-2'),
      ]),
    );
    expect(results[0]?.verdict).toBe('FAIL');
  });

  it('never invents subjects from other event types', () => {
    const results = evaluateInvDf1(
      graph([
        {
          id: 'e-x',
          eventType: 'demo.provider-payment-observed',
          subjectKey: 'PP-1',
          payload: { walletId: 'w-1' },
          inputHash: 'h-x',
        },
      ]),
    );
    expect(results).toHaveLength(0);
  });
});

describe('INV-DF-2 no-negative-balance', () => {
  it('passes when every observed balance is non-negative', () => {
    const results = evaluateInvDf2(
      graph([walletEvent({ balanceMinor: '0' }, 'e-1'), walletEvent({}, 'e-2')]),
    );
    expect(results[0]?.verdict).toBe('PASS');
    expect(results[0]?.details['minimumObservedBalanceMinor']).toBe('0');
  });

  it('fails on a negative observed balance with exact integer detail', () => {
    const results = evaluateInvDf2(graph([walletEvent({ balanceMinor: '-1' })]));
    expect(results[0]?.verdict).toBe('FAIL');
    expect(results[0]?.details['minimumObservedBalanceMinor']).toBe('-1');
  });

  it('is NOT_EVALUABLE run-wide when no wallet balance was observed', () => {
    const results = evaluateInvDf2(graph([]));
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
    expect(results[0]?.subjectKey).toBe('*');
  });

  it('ignores observations with malformed (non-integer) balances honestly', () => {
    const results = evaluateInvDf2(graph([walletEvent({ balanceMinor: '12.5' })]));
    expect(results[0]?.verdict).toBe('NOT_EVALUABLE');
  });
});
