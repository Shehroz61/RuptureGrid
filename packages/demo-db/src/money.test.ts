// =====================================================================
// Unit — exact integer money (AGENTS R-06, ADR-0004)
// =====================================================================

import { describe, expect, it } from 'vitest';
import { amountMinorToString, MoneyFormatError, parseAmountMinor, sameMoney } from './money.js';

describe('parseAmountMinor — accepts canonical decimal integer strings', () => {
  it('parses the canonical Incident Zero amount exactly', () => {
    expect(parseAmountMinor('500000')).toBe(500000n);
  });

  it('parses zero', () => {
    expect(parseAmountMinor('0')).toBe(0n);
  });

  it('parses large but safe amounts', () => {
    expect(parseAmountMinor('9007199254740991')).toBe(9007199254740991n);
  });
});

describe('parseAmountMinor — rejects non-canonical representations', () => {
  const invalid: Array<[string, unknown]> = [
    ['fractional value', '500000.50'],
    ['fractional with trailing zeros', '5000.00'],
    ['negative value', '-500000'],
    ['plus sign', '+500000'],
    ['zero with negative sign', '-0'],
    ['exponent notation', '5e5'],
    ['exponent notation (capital)', '5E5'],
    ['whitespace padding', ' 500000'],
    ['trailing whitespace', '500000 '],
    ['leading zeros', '0500000'],
    ['empty string', ''],
    ['number (not string)', 500000],
    ['float number (not string)', 5000.5],
    ['null', null],
    ['undefined', undefined],
    ['object', { minor: '500000' }],
  ];

  for (const [label, value] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => parseAmountMinor(value)).toThrow(MoneyFormatError);
    });
  }

  it('rejects magnitudes beyond the safe envelope', () => {
    expect(() => parseAmountMinor('9007199254740992')).toThrow(MoneyFormatError);
  });
});

describe('DTO serialization', () => {
  it('round-trips an exact amount through its canonical string', () => {
    const original = 500000n;
    expect(parseAmountMinor(amountMinorToString(original))).toBe(original);
  });
});

describe('sameMoney — exact equality including currency', () => {
  it('matches same amount and currency', () => {
    expect(
      sameMoney(
        { amountMinor: 500000n, currency: 'PKR' },
        { amountMinor: 500000n, currency: 'PKR' },
      ),
    ).toBe(true);
  });

  it('does not match different amounts', () => {
    expect(
      sameMoney(
        { amountMinor: 500000n, currency: 'PKR' },
        { amountMinor: 499999n, currency: 'PKR' },
      ),
    ).toBe(false);
  });

  it('does not match different currencies', () => {
    expect(
      sameMoney(
        { amountMinor: 500000n, currency: 'PKR' },
        { amountMinor: 500000n, currency: 'USD' },
      ),
    ).toBe(false);
  });
});
