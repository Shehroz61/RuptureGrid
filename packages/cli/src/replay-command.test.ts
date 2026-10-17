// =====================================================================
// RuptureGrid v1.1 Phase 18 — replay/compare/expectation unit tests
// =====================================================================
// Pure layers only (no database, no network, no queue):
//   - cli.ts: parseReplayArgs / parseCompareArgs;
//   - expectations.ts: acceptance-expectation normalization + assertion.
// Orchestration is exercised end-to-end by
// tests/integration/phase18-replay.test.ts against the real stack
// (testing-strategy §3).

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

import { parseCompareArgs, parseReplayArgs, REPLAY_DEFAULT_TIMEOUT_MS } from './cli.js';
import {
  assertAcceptanceExpectations,
  expectationsFromReproduction,
  expectationsFromScenario,
} from './expectations.js';
import type { ExpectationReportView } from './expectations.js';

it('documents the actual published schema filenames in both consumer documents', () => {
  for (const path of ['docs/cli.md', 'docs/external-ci-recipe.md']) {
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('packages/cli/schemas/rupturegrid-report-v1.schema.json');
    expect(text).not.toContain('packages/cli/schemas/report-v1.json');
  }
  expect(existsSync('packages/cli/schemas/rupturegrid-report-v1.schema.json')).toBe(true);
});

describe('replay — argument parsing (pure)', () => {
  it('parses the mandated command shape with the documented default timeout', () => {
    const parsed = parseReplayArgs([
      '--reproduction',
      '00000000-0000-4000-8000-000000000001',
      '--report',
      'out.json',
    ]);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') {
      throw new Error('unreachable');
    }
    expect(parsed.reproductionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(parsed.reportPath).toBe('out.json');
    expect(parsed.json).toBe(false);
    expect(parsed.timeoutMs).toBe(REPLAY_DEFAULT_TIMEOUT_MS);
  });

  it('accepts --json and an explicit --timeout', () => {
    const parsed = parseReplayArgs([
      '--reproduction=00000000-0000-4000-8000-000000000002',
      '--report=out.json',
      '--json',
      '--timeout',
      '90s',
    ]);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') {
      throw new Error('unreachable');
    }
    expect(parsed.reproductionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(parsed.json).toBe(true);
    expect(parsed.timeoutMs).toBe(90_000);
  });

  it('rejects a missing reproduction id, unknown flags, forbidden flags, and positionals', () => {
    expect(parseReplayArgs(['--report', 'out.json'])).toMatch(/--reproduction/);
    expect(parseReplayArgs(['--reproduction', 'x', '--bogus'])).toMatch(/unknown flag/);
    expect(parseReplayArgs(['--reproduction', 'x', '--force-production'])).toMatch(
      /forbidden flag/,
    );
    expect(parseReplayArgs(['--reproduction', 'x', 'stray'])).toMatch(/positional/);
    expect(parseReplayArgs(['--reproduction', 'x', '--timeout', 'nope'])).toMatch(
      /malformed timeout/,
    );
  });
});

describe('compare — argument parsing (pure)', () => {
  it.each(['not-a-uuid', '', '00000000-0000-4000-8000', '0'.repeat(100)])(
    'rejects malformed id %j as usage input',
    (id) => {
      expect(typeof parseReplayArgs(['--reproduction', id])).toBe('string');
      expect(typeof parseCompareArgs([id, '00000000-0000-4000-8000-000000000002'])).toBe('string');
    },
  );
  it('parses two run ids with optional --json/--report', () => {
    const parsed = parseCompareArgs([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '--json',
    ]);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') {
      throw new Error('unreachable');
    }
    expect(parsed.baseRunId).toBe('00000000-0000-4000-8000-000000000001');
    expect(parsed.otherRunId).toBe('00000000-0000-4000-8000-000000000002');
    expect(parsed.json).toBe(true);
    expect(parsed.reportPath).toBe(null);
  });

  it('rejects missing ids and unknown flags', () => {
    expect(parseCompareArgs(['only-one'])).toMatch(/exactly two run ids/);
    expect(parseCompareArgs([])).toMatch(/exactly two run ids/);
    expect(parseCompareArgs(['a', 'b', '--bogus'])).toMatch(/unknown flag/);
  });
});

const reportView = (
  exitClass: string,
  verdicts: ReadonlyArray<{ invariantKey: string; subjectKey: string; verdict: string }>,
): ExpectationReportView => ({ exitClass, invariantEvaluations: verdicts });

describe('acceptance expectations — normalization (pure, never truth)', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'preserves special key %s in both input shapes',
    (key) => {
      const scenario = JSON.parse(`{"invariantVerdicts":{"${key}":"FAIL","K":"PASS"}}`) as unknown;
      for (const normalized of [
        expectationsFromScenario(scenario),
        expectationsFromReproduction({
          expectations: [
            { invariantKey: key, expectedVerdicts: ['FAIL'] },
            { invariantKey: 'K', expectedVerdicts: ['PASS'] },
          ],
        }),
      ]) {
        expect(Object.keys(normalized.invariantVerdicts ?? {})).toEqual([key, 'K']);
        expect(normalized.invariantVerdicts?.[key]).toBe('FAIL');
        expect(
          assertAcceptanceExpectations(
            reportView('PASS', [
              { invariantKey: key, subjectKey: 's', verdict: 'PASS' },
              { invariantKey: 'K', subjectKey: 's', verdict: 'PASS' },
            ]),
            normalized,
          ).matched,
        ).toBe(false);
        expect(
          assertAcceptanceExpectations(
            reportView('PASS', [{ invariantKey: 'K', subjectKey: 's', verdict: 'PASS' }]),
            normalized,
          ).matched,
        ).toBe(false);
        expect(
          assertAcceptanceExpectations(
            reportView('INVARIANT_FAIL', [
              { invariantKey: key, subjectKey: 's', verdict: 'FAIL' },
              { invariantKey: 'K', subjectKey: 's', verdict: 'PASS' },
            ]),
            normalized,
          ).matched,
        ).toBe(true);
      }
    },
  );

  it('never matches an explicitly empty or skipped reproduction assertion', () => {
    for (const raw of [
      { expectations: [] },
      { expectations: [{ invariantKey: 'K', expectedVerdicts: ['FAIL', 'PASS'] }] },
    ]) {
      expect(
        assertAcceptanceExpectations(reportView('PASS', []), expectationsFromReproduction(raw))
          .matched,
      ).toBe(false);
    }
  });

  it('exposes unsupported scenario entries rather than silently dropping them', () => {
    for (const raw of [
      { invariantVerdicts: { K: null } },
      { invariantVerdicts: [] },
      { invariantVerdicts: { K: 'UNKNOWN' } },
      { exitClass: 123 },
      [],
    ]) {
      const normalized = expectationsFromScenario(raw);
      expect(normalized.normalizationIssues?.length).toBeGreaterThan(0);
      expect(assertAcceptanceExpectations(reportView('PASS', []), normalized).matched).toBe(false);
    }
  });

  it('never reports a successful empty assertion', () => {
    expect(assertAcceptanceExpectations(reportView('PASS', []), {}).matched).toBe(false);
  });

  it('rejects unexpected verdicts under a special key across distinct subjects', () => {
    const expected = expectationsFromReproduction({
      expectations: [{ invariantKey: '__proto__', expectedVerdicts: ['FAIL'] }],
    });
    expect(
      assertAcceptanceExpectations(
        reportView('INVARIANT_FAIL', [
          { invariantKey: '__proto__', subjectKey: 'a', verdict: 'FAIL' },
          { invariantKey: '__proto__', subjectKey: 'b', verdict: 'PASS' },
        ]),
        expected,
      ).matched,
    ).toBe(false);
  });
  it.each([
    [{ invariantKey: 'K', expectedVerdicts: [] }],
    [{ invariantKey: 'K', expectedVerdicts: ['UNKNOWN'] }],
    [
      { invariantKey: 'K', expectedVerdicts: ['PASS'] },
      { invariantKey: 'K', expectedVerdicts: ['FAIL'] },
    ],
    [null],
  ])('exposes unsupported or conflicting entries: %j', (...entries) => {
    const normalized = expectationsFromReproduction({ expectations: entries });
    expect(normalized.normalizationIssues?.length).toBeGreaterThan(0);
    expect(assertAcceptanceExpectations(reportView('PASS', []), normalized).matched).toBe(false);
  });
  it('normalizes a scenario expectations block', () => {
    expect(
      expectationsFromScenario({
        exitClass: 'INVARIANT_FAIL',
        invariantVerdicts: { 'INV-CHK-1': 'FAIL' },
      }),
    ).toEqual({ exitClass: 'INVARIANT_FAIL', invariantVerdicts: { 'INV-CHK-1': 'FAIL' } });
    expect(expectationsFromScenario(undefined)).toEqual({});
    expect(expectationsFromScenario(null)).toEqual({});
  });

  it('normalizes a reproduction acceptanceExpectations block (single-verdict keys only)', () => {
    const normalized = expectationsFromReproduction(
      {
        expectations: [
          { invariantKey: 'INV-CHK-1', evaluatorVersion: 'v1', expectedVerdicts: ['FAIL'] },
          {
            invariantKey: 'INV-INV-1',
            evaluatorVersion: 'v1',
            expectedVerdicts: ['FAIL', 'PASS'],
          },
          { invariantKey: 'MALFORMED' },
        ],
      },
      'INVARIANT_FAIL',
    );
    // Unsupported entries remain visible and prevent a vacuous match.
    expect(normalized).toEqual({
      exitClass: 'INVARIANT_FAIL',
      invariantVerdicts: { 'INV-CHK-1': 'FAIL' },
      normalizationIssues: [
        'reproduction expectation 1 requires a key and exactly one supported verdict',
        'reproduction expectation 2 requires a key and exactly one supported verdict',
      ],
    });
    expect(
      assertAcceptanceExpectations(
        reportView('INVARIANT_FAIL', [
          { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-001', verdict: 'FAIL' },
        ]),
        normalized,
      ).matched,
    ).toBe(false);
  });
});

describe('acceptance expectations — assertion (pure, never influences verdicts)', () => {
  it('matches a report that meets every expectation', () => {
    const result = assertAcceptanceExpectations(
      reportView('INVARIANT_FAIL', [
        { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-001', verdict: 'FAIL' },
        { invariantKey: 'INV-INV-1', subjectKey: 'SKU-001', verdict: 'FAIL' },
      ]),
      {
        exitClass: 'INVARIANT_FAIL',
        invariantVerdicts: { 'INV-CHK-1': 'FAIL', 'INV-INV-1': 'FAIL' },
      },
    );
    expect(result.matched).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('mismatches a wrong exit class without changing the report', () => {
    const view = reportView('PASS', [
      { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-001', verdict: 'PASS' },
    ]);
    const result = assertAcceptanceExpectations(view, { exitClass: 'INVARIANT_FAIL' });
    expect(result.matched).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/exit class is PASS/);
    // The report stands: the assertion returns a verdict about the
    // assertion, never a new verdict about the run.
    expect(view.exitClass).toBe('PASS');
  });

  it('requires EVERY subject of a key to carry the expected verdict (no collapse)', () => {
    const result = assertAcceptanceExpectations(
      reportView('INVARIANT_FAIL', [
        { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-001', verdict: 'FAIL' },
        { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-002', verdict: 'PASS' },
      ]),
      { invariantVerdicts: { 'INV-CHK-1': 'FAIL' } },
    );
    expect(result.matched).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/do not all equal/);
  });

  it('mismatches missing and unbound keys (never a vacuous pass)', () => {
    const missing = assertAcceptanceExpectations(reportView('PASS', []), {
      invariantVerdicts: { 'INV-CHK-1': 'PASS' },
    });
    expect(missing.matched).toBe(false);
    expect(missing.mismatches.join(' ')).toMatch(/no reported evaluation/);
    const unbound = assertAcceptanceExpectations(
      reportView('PASS', [{ invariantKey: 'INV-CHK-1', subjectKey: 's', verdict: 'PASS' }]),
      { invariantVerdicts: { 'INV-NOPE-9': 'PASS' } },
    );
    expect(unbound.matched).toBe(false);
  });

  it('never masquerades NOT_EVALUABLE as PASS', () => {
    const result = assertAcceptanceExpectations(
      reportView('NOT_EVALUABLE', [
        { invariantKey: 'INV-CHK-1', subjectKey: 'CHK-001', verdict: 'NOT_EVALUABLE' },
      ]),
      { exitClass: 'PASS', invariantVerdicts: { 'INV-CHK-1': 'PASS' } },
    );
    expect(result.matched).toBe(false);
    expect(result.mismatches).toHaveLength(2);
  });
});
