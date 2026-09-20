// =====================================================================
// Unit — showcase capture plan (Phase 8)
// =====================================================================
// Pins the stable identity of the required artifact set (§30/§58):
// semantic filenames, exact routes over session identifiers, expected
// content bindings, and the narrative order. The artifact plan is a
// committed contract: any change to it must be a deliberate, visible
// change to this test.

import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PLAN,
  SHOWCASE_DEVICE_SCALE,
  SHOWCASE_VIEWPORT,
  artifactFilename,
} from './capture-plan.js';

const IDS = {
  vulnerableRunId: '11111111-1111-4111-8111-111111111111',
  secureRunId: '22222222-2222-4222-8222-222222222222',
  vulnerableFindingId: '33333333-3333-4333-8333-333333333333',
};

describe('showcase capture plan', () => {
  it('has a stable, semantic artifact identity (no generated IDs in names)', () => {
    expect(CAPTURE_PLAN.map((step) => artifactFilename(step))).toEqual([
      '00-runs-index.png',
      '01-vulnerable-overview.png',
      '02-vulnerable-finding.png',
      '03-vulnerable-timeline.png',
      '04-vulnerable-evidence.png',
      '05-vulnerable-reproduction.png',
      '06-secure-overview.png',
      '07-secure-timeline.png',
      '08-secure-evidence.png',
      '09-secure-reproduction.png',
    ]);
  });

  it('requires every capture the roadmap demands (vulnerable + secure surfaces)', () => {
    const names = CAPTURE_PLAN.map((step) => step.artifact);
    for (const required of [
      '01-vulnerable-overview',
      '02-vulnerable-finding',
      '03-vulnerable-timeline',
      '04-vulnerable-evidence',
      '05-vulnerable-reproduction',
      '06-secure-overview',
      '07-secure-timeline',
      '08-secure-evidence',
      '09-secure-reproduction',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('builds routes from the REAL session identifiers (§51)', () => {
    // The runs-index artifact is the shared ledger view — every other
    // artifact is a run-scoped route that MUST carry its real run ID.
    const runScoped = CAPTURE_PLAN.filter((step) => step.artifact !== '00-runs-index');
    for (const step of runScoped.filter((candidate) => candidate.mode === 'VULNERABLE')) {
      expect(step.route(IDS)).toContain(`/runs/${IDS.vulnerableRunId}`);
    }
    for (const step of runScoped.filter((candidate) => candidate.mode === 'SECURE')) {
      expect(step.route(IDS)).toContain(`/runs/${IDS.secureRunId}`);
    }
    const finding = CAPTURE_PLAN.find((step) => step.artifact === '02-vulnerable-finding');
    expect(finding?.route(IDS)).toBe(
      `/runs/${IDS.vulnerableRunId}/findings/${IDS.vulnerableFindingId}`,
    );
  });

  it('binds expected content to session IDs or canonical values — never invented text', () => {
    const overview = CAPTURE_PLAN.find((step) => step.artifact === '01-vulnerable-overview');
    expect(overview?.expectedIncludes(IDS)).toContain(IDS.vulnerableRunId);
    expect(overview?.expectedIncludes(IDS)).toContain('FAIL');
    const finding = CAPTURE_PLAN.find((step) => step.artifact === '02-vulnerable-finding');
    expect(finding?.expectedIncludes(IDS)).toContain('PKR 5,000.00');
    const secureOverview = CAPTURE_PLAN.find((step) => step.artifact === '06-secure-overview');
    expect(secureOverview?.expectedIncludes(IDS)).toContain('PASS');
  });

  it('the finding artifact forbids credential material (§15/§28)', () => {
    const repro = CAPTURE_PLAN.find((step) => step.artifact === '05-vulnerable-reproduction');
    expect(repro?.expectedExcludes?.(IDS)).toContain('Bearer ');
  });

  it('uses the deterministic viewport and device scale', () => {
    expect(SHOWCASE_VIEWPORT).toEqual({ width: 1440, height: 900 });
    expect(SHOWCASE_DEVICE_SCALE).toBe(1);
  });
});
