// =====================================================================
// Unit — golden verifier bridge (Phase 8)
// =====================================================================
// Pins the session-extraction contract over the verifier's JSON report
// shape (§8): passing reports yield REAL run IDs; non-passing or
// incomplete reports are refused — never partially consumed. The
// finding-ID resolver contract is exercised without any database.

import { describe, expect, it } from 'vitest';
import { extractVerifiedSession, setFindingIdResolver, VerifierFailureError } from './verifier.js';
import type { GoldenVerificationReport } from './types.js';

function assertion(name: string, expected: string, actual: string, pass = true) {
  return { name, expected, actual, pass };
}

function report(overrides?: {
  readonly ok?: boolean;
  readonly vulnerablePass?: boolean;
  readonly findingActual?: string;
}): GoldenVerificationReport {
  return {
    ok: overrides?.ok ?? true,
    exitCode: 0,
    scenarioVersion: 'v1',
    spawned: [],
    registrations: [],
    frozenIntent: { pass: true, assertions: [] },
    modes: [
      {
        mode: 'VULNERABLE',
        runId: 'run-v-1111',
        snapshotContentHash: 'hash-v',
        paymentId: 'pp-v',
        pass: overrides?.vulnerablePass ?? true,
        assertions: [
          assertion('execution.state', 'COMPLETED', 'COMPLETED'),
          assertion('INV-IZ-1.verdict', 'FAIL', 'FAIL'),
          assertion(
            'finding.reason-code',
            'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
            overrides?.findingActual ?? 'DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT',
          ),
        ],
      },
      {
        mode: 'SECURE',
        runId: 'run-s-2222',
        snapshotContentHash: 'hash-s',
        paymentId: 'pp-s',
        pass: true,
        assertions: [assertion('INV-IZ-1.verdict', 'PASS', 'PASS')],
      },
    ],
    canary: { scanned: false, leaks: [] },
  } as unknown as GoldenVerificationReport;
}

describe('extractVerifiedSession', () => {
  it('returns the REAL run IDs from a passing report', async () => {
    setFindingIdResolver(async () => 'finding-9999');
    const session = await extractVerifiedSession(report());
    expect(session.vulnerable.runId).toBe('run-v-1111');
    expect(session.secure.runId).toBe('run-s-2222');
    expect(session.vulnerable.findingId).toBe('finding-9999');
  });

  it('refuses a non-passing report (ok=false)', async () => {
    setFindingIdResolver(async () => 'finding-9999');
    await expect(extractVerifiedSession(report({ ok: false }))).rejects.toBeInstanceOf(
      VerifierFailureError,
    );
  });

  it('refuses a report where the vulnerable mode failed', async () => {
    setFindingIdResolver(async () => 'finding-9999');
    await expect(extractVerifiedSession(report({ vulnerablePass: false }))).rejects.toBeInstanceOf(
      VerifierFailureError,
    );
  });

  it('refuses a report without the canonical vulnerable finding', async () => {
    setFindingIdResolver(async () => 'finding-9999');
    await expect(
      extractVerifiedSession(report({ findingActual: 'SOME_OTHER_RULE' })),
    ).rejects.toBeInstanceOf(VerifierFailureError);
  });

  it('refuses to invent a finding ID when no resolver is wired', async () => {
    setFindingIdResolver(null);
    await expect(extractVerifiedSession(report())).rejects.toThrow(/resolver/);
  });

  it('refuses when the resolver finds no durable finding row', async () => {
    setFindingIdResolver(async () => '');
    await expect(extractVerifiedSession(report())).rejects.toThrow(/refusing to invent/);
  });
});
