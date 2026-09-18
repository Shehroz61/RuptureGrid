// =====================================================================
// Unit — Phase 6 UI semantics (presentation-only logic)
// =====================================================================
// The state/money/formatting logic the product UI renders by. These
// tests pin the presentation CONTRACTS that keep the UI honest:
// money renders FROM integer minor units (never floats, ADR-0004);
// INDETERMINATE / NOT_EVALUABLE are first-class uncertain states that
// never collapse into success/failure (ADR-0008); long identifiers
// truncate with full-value inspection available (product-design §6);
// durations report null (never a fake value) when unmeasurable.

import { describe, expect, it } from 'vitest';
import {
  formatMinorUnits,
  formatDuration,
  formatTimestamp,
  shortenId,
  runStateClass,
  verdictClass,
  knowledgeClass,
  orderingBasisLabel,
} from '../../apps/web/lib/semantics.js';

describe('money rendering (ADR-0004: integer minor units, never floats)', () => {
  it('renders the canonical Incident Zero amount from its integer', () => {
    expect(formatMinorUnits('500000', 'PKR')).toBe('PKR 5,000.00');
  });

  it('renders the duplicated-balance amount', () => {
    expect(formatMinorUnits('1000000', 'PKR')).toBe('PKR 10,000.00');
  });

  it('renders small and zero amounts', () => {
    expect(formatMinorUnits('0', 'PKR')).toBe('PKR 0.00');
    expect(formatMinorUnits('5', 'PKR')).toBe('PKR 0.05');
  });

  it('accepts numbers as minor units (still rendered from the integer)', () => {
    expect(formatMinorUnits(500000, 'PKR')).toBe('PKR 5,000.00');
  });

  it('never silently coerces a non-integer string — labels it raw', () => {
    expect(formatMinorUnits('12.5', 'PKR')).toBe('12.5 PKR (raw)');
    expect(formatMinorUnits('-500', 'PKR')).toBe('-500 PKR (raw)');
  });
});

describe('verdict and state semantics (uncertainty is first-class)', () => {
  it('FAIL is a failure state and PASS a success state', () => {
    expect(verdictClass('FAIL')).toBe('fail');
    expect(verdictClass('PASS')).toBe('pass');
  });

  it('NOT_EVALUABLE is its own uncertain class — never a pass or fail', () => {
    expect(verdictClass('NOT_EVALUABLE')).toBe('uncertain');
  });

  it('INDETERMINATE side-effect knowledge is uncertain — never laundered', () => {
    expect(knowledgeClass('INDETERMINATE')).toBe('uncertain');
    expect(knowledgeClass('KNOWN_OCCURRED')).toBe('pass');
    expect(knowledgeClass('KNOWN_ABSENT')).toBe('neutral');
  });

  it('terminal and in-flight run states render distinctly', () => {
    expect(runStateClass('COMPLETED')).toBe('pass');
    expect(runStateClass('FAILED')).toBe('fail');
    expect(runStateClass('RUNNING')).toBe('running');
    expect(runStateClass('RECONCILING')).toBe('running');
    expect(runStateClass('CANCELLED')).toBe('neutral');
  });

  it('ordering bases use human-exact labels including the unordered basis', () => {
    expect(orderingBasisLabel('sequence')).toBe('sequence');
    expect(orderingBasisLabel('wall_clock')).toBe('wall-clock');
    expect(orderingBasisLabel('unordered_overlap')).toBe('unordered / overlapping');
  });
});

describe('long identifier handling (product-design §6)', () => {
  it('truncates very long ids but keeps both ends', () => {
    const longId = 'a'.repeat(40) + 'b'.repeat(40);
    const shown = shortenId(longId, 8);
    expect(shown.startsWith('aaaaaaaa')).toBe(true);
    expect(shown.endsWith('bbbbbbbb')).toBe(true);
    expect(shown.length).toBeLessThan(longId.length);
  });

  it('returns short ids untouched', () => {
    expect(shortenId('pp-12345678', 10)).toBe('pp-12345678');
  });
});

describe('time formatting honesty', () => {
  it('renders an em dash for absent timestamps (never a fabricated time)', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp('')).toBe('—');
  });

  it('formats an ISO timestamp as technical time', () => {
    expect(formatTimestamp('2026-09-14T10:20:30.000Z')).toContain('2026-09-14 10:20:30');
  });

  it('reports null duration when the run has not terminated', () => {
    expect(formatDuration('2026-09-14T10:00:00.000Z', null)).toBeNull();
  });

  it('reports null duration for unmeasurable ranges (never a negative fake)', () => {
    expect(formatDuration('2026-09-14T10:00:10.000Z', '2026-09-14T10:00:00.000Z')).toBeNull();
  });

  it('formats a sub-minute duration in seconds', () => {
    expect(formatDuration('2026-09-14T10:00:00.000Z', '2026-09-14T10:00:02.500Z')).toBe('2.5s');
  });
});
