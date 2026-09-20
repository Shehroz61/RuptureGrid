// =====================================================================
// Unit — video slide overlays (Phase 8)
// =====================================================================
// Overlays must be FACTUAL text derived from verified session truth
// (§38): no hype, no invented counts, no chronology the session does
// not support. The overlay generator is a pure function over session
// stories, so these tests pin the whole truth surface of the video's
// text layer.

import { describe, expect, it } from 'vitest';
import { slideOverlay, SLIDE_SECONDS, VIDEO_HEIGHT, VIDEO_WIDTH } from './video.js';
import { CAPTURE_PLAN } from './capture-plan.js';
import type { ShowcaseModeStory } from './types.js';

const VULNERABLE: ShowcaseModeStory = {
  mode: 'VULNERABLE',
  runId: 'run-v',
  paymentId: 'pp-v',
  findingId: 'finding-v',
  snapshotContentHash: 'hash-v',
  verdict: 'FAIL',
  runState: 'COMPLETED',
};
const SECURE: ShowcaseModeStory = {
  mode: 'SECURE',
  runId: 'run-s',
  paymentId: 'pp-s',
  findingId: null,
  snapshotContentHash: 'hash-s',
  verdict: 'PASS',
  runState: 'COMPLETED',
};
const FACTS = { deliveries: 20, attempts: 20, invariant: 'IZ-1' } as const;

function step(artifact: string) {
  const found = CAPTURE_PLAN.find((candidate) => candidate.artifact === artifact);
  if (found === undefined) {
    throw new Error(`missing plan step ${artifact}`);
  }
  return found;
}

describe('video slide overlays', () => {
  it('video targets deliberate 1080p composition', () => {
    expect(VIDEO_WIDTH).toBe(1920);
    expect(VIDEO_HEIGHT).toBe(1080);
    expect(SLIDE_SECONDS).toBeGreaterThan(0);
  });

  it('the vulnerable finding slide states the duplicate-credit fact only', () => {
    const text = slideOverlay({
      step: step('02-vulnerable-finding'),
      vulnerable: VULNERABLE,
      secure: SECURE,
      facts: FACTS,
    });
    expect(text).toContain('two accepted equivalent credits');
    // "FAIL" contains the letters AI — the hype ban is word-boundared.
    expect(text).not.toMatch(/\bAI\b|instant(ly)?|hidden fraud/);
  });

  it('the timeline slide carries only verifier-derived counts', () => {
    const text = slideOverlay({
      step: step('03-vulnerable-timeline'),
      vulnerable: VULNERABLE,
      secure: SECURE,
      facts: FACTS,
    });
    expect(text).toContain('20 physical deliveries / 20 processing attempts');
    expect(text).toContain('VULNERABLE');
    expect(text).toContain('FAIL');
  });

  it('the secure overview communicates same-pressure-one-effect', () => {
    const text = slideOverlay({
      step: step('06-secure-overview'),
      vulnerable: VULNERABLE,
      secure: SECURE,
      facts: FACTS,
    });
    expect(text).toContain('SECURE');
    expect(text).toContain('PASS');
    expect(text).toContain('Same pressure; one accepted business effect.');
  });

  it('the closing slide is the honest thesis (no overclaim)', () => {
    const text = slideOverlay({
      step: step('09-secure-reproduction'),
      vulnerable: VULNERABLE,
      secure: SECURE,
      facts: FACTS,
    });
    expect(text).toContain('Transport success is not business correctness.');
  });

  it('the opening slide invents no run numbers', () => {
    const text = slideOverlay({
      step: step('00-runs-index'),
      vulnerable: VULNERABLE,
      secure: SECURE,
      facts: FACTS,
    });
    expect(text).toContain('two target modes');
    expect(text).not.toContain('run-v');
    expect(text).not.toContain('pp-v');
  });

  it('overlay verdicts are transcribed from the session stories, never literals', () => {
    // A vulnerable story carrying the verifier-observed verdict renders
    // exactly that verdict — including a hypothetical PASS — proving
    // the overlay derives from report truth rather than a constant.
    const passingVulnerable = { ...VULNERABLE, verdict: 'PASS' as const };
    const failingSecure = { ...SECURE, verdict: 'FAIL' as const };
    const vulnerableText = slideOverlay({
      step: step('01-vulnerable-overview'),
      vulnerable: passingVulnerable,
      secure: SECURE,
      facts: FACTS,
    });
    expect(vulnerableText).toContain('INV-IZ-1 PASS');
    const secureText = slideOverlay({
      step: step('06-secure-overview'),
      vulnerable: VULNERABLE,
      secure: failingSecure,
      facts: FACTS,
    });
    expect(secureText).toContain('INV-IZ-1 FAIL');
  });
});
