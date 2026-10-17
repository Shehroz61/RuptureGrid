import { describe, expect, it } from 'vitest';
import { replayEffectCountOf, REPLAY_SCHEDULING_NOTE } from './replay-comparison.js';

describe('replay comparison effect counts', () => {
  it('preserves legacy INV-IZ-1 equivalent-effect counts', () => {
    expect(replayEffectCountOf('INV-IZ-1', { equivalentEffectCount: 2 })).toBe(2);
    expect(replayEffectCountOf('INV-CHK-1', { attributableEffectCount: 1 })).toBe(1);
    expect(replayEffectCountOf('INV-INV-1', { acceptedReservedUnits: 1 })).toBe(1);
    expect(replayEffectCountOf('INV-CHK-1', { equivalentEffectCount: 2 })).toBeNull();
    expect(
      replayEffectCountOf('INV-CHK-1', {
        kind: 'atMostOneAcceptedEffect',
        observedCount: 1,
        observedTotal: 1,
        countedEffectIdentities: ['string:order-1'],
      }),
    ).toBe(1);
    expect(
      replayEffectCountOf('INV-CHK-1', {
        kind: 'atMostOneAcceptedEffect',
        observedCount: 1,
        observedTotal: 2,
        countedEffectIdentities: ['string:order-1'],
      }),
    ).toBeNull();
  });
  it.each([
    undefined,
    null,
    {},
    { equivalentEffectCount: -1 },
    { equivalentEffectCount: 1.5 },
    { equivalentEffectCount: '2' },
    { equivalentEffectCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('does not invent a count from %j', (details) => {
    expect(replayEffectCountOf('INV-IZ-1', details)).toBeNull();
  });
  it('does not mistake target remediation for scheduling luck', () => {
    expect(REPLAY_SCHEDULING_NOTE).toContain('target remediation');
    expect(REPLAY_SCHEDULING_NOTE).toContain('without establishing the cause');
  });
});
