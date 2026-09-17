// =====================================================================
// Unit — run comparison selection logic (comparison.ts)
// =====================================================================
// Latest-evaluation selection must be deterministic (max by
// (createdAt, evaluationId)) and insertion-order independent;
// comparison output marks verdict differences as the signal
// (incident-replay §6).

import { describe, expect, it } from 'vitest';
import { latestEvaluationPerInvariant } from './index.js';
import type { RunVerdictSummary } from './index.js';

function evaluation(
  id: string,
  invariantKey: string,
  verdict: string,
  createdAt: Date,
): RunVerdictSummary {
  return {
    evaluationId: id,
    invariantKey,
    evaluatorVersion: 'v1',
    subjectKey: 'pay_1',
    verdict,
    createdAt,
  };
}

describe('comparison — latest evaluation selection', () => {
  it('selects the newest evaluation per invariant', () => {
    const latest = latestEvaluationPerInvariant([
      evaluation('e1', 'INV-IZ-1', 'FAIL', new Date(1000)),
      evaluation('e2', 'INV-IZ-1', 'PASS', new Date(2000)),
    ]);
    expect(latest.get('INV-IZ-1')?.verdict).toBe('PASS');
    expect(latest.get('INV-IZ-1')?.evaluationId).toBe('e2');
  });

  it('breaks timestamp ties by evaluation id (deterministic, order-free)', () => {
    const forward = latestEvaluationPerInvariant([
      evaluation('e1', 'INV-IZ-1', 'FAIL', new Date(1000)),
      evaluation('e2', 'INV-IZ-1', 'PASS', new Date(1000)),
    ]);
    const backward = [
      ...[
        evaluation('e1', 'INV-IZ-1', 'FAIL', new Date(1000)),
        evaluation('e2', 'INV-IZ-1', 'PASS', new Date(1000)),
      ],
    ].reverse();
    const fromBackward = latestEvaluationPerInvariant(backward);
    expect(forward.get('INV-IZ-1')?.evaluationId).toBe('e2');
    expect(fromBackward.get('INV-IZ-1')?.evaluationId).toBe('e2');
  });

  it('keeps invariants separate', () => {
    const latest = latestEvaluationPerInvariant([
      evaluation('e1', 'INV-IZ-1', 'FAIL', new Date(1000)),
      evaluation('e2', 'INV-XX-1', 'PASS', new Date(1000)),
    ]);
    expect(latest.size).toBe(2);
  });
});
