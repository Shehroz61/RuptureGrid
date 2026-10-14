// =====================================================================
// RuptureGrid v1.1 Phase 17 — CLI unit tests
// =====================================================================
// These tests verify the PURE layers of the Phase 17 CLI contract:
//   - exit-code.ts: the frozen five-way precedence classifier;
//   - scenario.ts: the closed rupturegrid-scenario/v1 contract;
//   - report.ts: deterministic rupturegrid-report/v1 serialization;
//   - schema-validate.ts: emitted reports validate against the
//     published schema (construct → validate → write, §41/§45);
//   - cli.ts argument parsing (pure functions only — orchestration is
//     exercised end-to-end by tests/integration/phase17-cli.test.ts
//     against the real stack, per testing-strategy §3).
// No database, no network, no queue: every subject here is pure.

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES, classifyExit, exitClassFor, exitCodeFor } from './exit-code.js';
import type { BoundKeyDomain, SubjectVerdict } from './exit-code.js';
import {
  SCENARIO_VERSION,
  ScenarioValidationError,
  parseScenarioFile,
  scenarioExperimentDocument,
  validateScenarioDocument,
} from './scenario.js';
import { buildReport, REPORT_SCHEMA_VERSION } from './report.js';
import { emitSchemas, serializeSchemaDocumentStable } from './schema-emit.js';
import { ReportSchemaValidationError, validateReportAgainstSchema } from './schema-validate.js';
import { parseTimeoutDuration, parseRunArgs } from './cli.js';
import { reportJsonSchema, scenarioJsonSchema } from './schema-documents.js';
import type { ExitClassificationInput } from './exit-code.js';
import type { IntegrityReport } from '@rupturegrid/evidence';
import type { ReportInput } from './report.js';
import { createHash } from 'node:crypto';

const sha256Hex = (seed: string): string => createHash('sha256').update(seed).digest('hex');

// ---------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------

const subjectVerdict = (
  invariantKey: string,
  subjectKey: string,
  v: 'PASS' | 'FAIL' | 'NOT_EVALUABLE',
  mode = 'strict-coverage/v1',
): SubjectVerdict => ({
  invariantKey,
  subjectKey,
  verdict: v,
  mode,
  evaluatorVersion: 'generic-invariant/v1',
});

function strictDomain(
  invariantKey: string,
  subjects: readonly string[],
  overrides: Partial<BoundKeyDomain> = {},
): BoundKeyDomain {
  return {
    invariantKey,
    mode: 'strict-coverage/v1',
    evaluatorVersion: 'generic-invariant/v1',
    declaredSubjects: subjects,
    eligibleSubjects: subjects,
    missingSubjects: [],
    unexpectedSubjectCount: 0,
    evidenceGapCount: 0,
    ...overrides,
  };
}

function baseInput(): ExitClassificationInput {
  return {
    runTerminalState: 'COMPLETED',
    evidenceIntegrityVerified: true,
    subjectVerdicts: [
      subjectVerdict('INV-CHK-1', 'CHK-001', 'PASS'),
      subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
    ],
    boundKeyDomains: [
      strictDomain('INV-CHK-1', ['CHK-001']),
      strictDomain('INV-INV-1', ['SKU-001']),
    ],
    anomalies: [],
  };
}

function integrityReport(): IntegrityReport {
  return {
    chainValid: true,
    contentHashesValid: true,
    observationCount: 4,
    recomputedHeadHash: sha256Hex('head'),
    problems: [],
  } as unknown as IntegrityReport;
}

const reportInput: ReportInput = {
  target: {
    targetId: 'tgt-1',
    displayName: 'checkout-zero-commerce',
    environment: 'LOCAL_DEVELOPMENT',
    origins: ['http://127.0.0.1:3003'],
  },
  run: {
    runId: 'run-1',
    experimentName: 'checkout-zero',
    experimentDefinitionId: 'def-1',
    revisionId: 'rev-1',
    revisionNumber: 1,
    snapshotId: 'snap-1',
    snapshotContentHash: sha256Hex('snapshot-1'),
    terminalState: 'COMPLETED',
    engineVersion: '1.1.0',
  },
  sideEffectSummary: {
    KNOWN_OCCURRED: 3,
    KNOWN_ABSENT: 1,
    INDETERMINATE: 0,
    NOT_APPLICABLE: 2,
  },
  evaluations: [
    {
      invariantKey: 'INV-INV-1',
      evaluatorVersion: 'generic-invariant/v1',
      subjectKey: 'SKU-001',
      verdict: 'PASS',
      reason: 'conserved',
      evidenceSetHash: sha256Hex('e2'),
      details: {},
      mode: 'strict-coverage/v1',
    },
    {
      invariantKey: 'INV-CHK-1',
      evaluatorVersion: 'generic-invariant/v1',
      subjectKey: 'CHK-001',
      verdict: 'PASS',
      reason: 'exactly one accepted effect',
      evidenceSetHash: sha256Hex('e1'),
      details: {},
      mode: 'strict-coverage/v1',
    },
  ],
  findings: [],
  reproduction: null,
  invariantEvaluatorVersions: [
    { invariantKey: 'INV-CHK-1', evaluatorVersion: 'generic-invariant/v1' },
    { invariantKey: 'INV-INV-1', evaluatorVersion: 'generic-invariant/v1' },
  ],
  normalizerVersions: [],
  eligibility: null,
};

// ---------------------------------------------------------------------
// exit-code.ts — the frozen five-way precedence
// ---------------------------------------------------------------------

describe('exit-code: the five-way contract (ADR-0019 §2)', () => {
  it('codes and classes are paired consistently', () => {
    expect(EXIT_CODES).toEqual({
      PASS: 0,
      INVARIANT_FAIL: 1,
      NOT_EVALUABLE: 2,
      EXECUTION_FAILURE: 3,
      USAGE_ERROR: 4,
    });
    for (const [className, code] of Object.entries(EXIT_CODES)) {
      expect(exitCodeFor(className as keyof typeof EXIT_CODES)).toBe(code);
      expect(exitClassFor(code)).toBe(className);
    }
    expect(exitClassFor(9)).toBeNull();
  });

  it('classifies PASS only when everything is verified and all bound invariants PASS', () => {
    const result = classifyExit(baseInput());
    expect(result.exitClass).toBe('PASS');
    expect(result.exitCode).toBe(0);
    expect(result.precedenceRule).toBe(4);
  });

  it('rule 1: a non-COMPLETED terminal state is EXECUTION_FAILURE even with persisted FAILs', () => {
    const result = classifyExit({
      ...baseInput(),
      runTerminalState: 'FAILED',
      subjectVerdicts: [subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL')],
    });
    expect(result.exitClass).toBe('EXECUTION_FAILURE');
    expect(result.exitCode).toBe(3);
    expect(result.precedenceRule).toBe(1);
  });

  it('rule 1: an evidence-integrity failure DOMINATES a persisted FAIL (exit 3, never 1)', () => {
    const result = classifyExit({
      ...baseInput(),
      evidenceIntegrityVerified: false,
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
      ],
    });
    expect(result.exitClass).toBe('EXECUTION_FAILURE');
    expect(result.precedenceRule).toBe(1);
  });

  it('rule 1: integrity verification that could not run fails CLOSED', () => {
    const result = classifyExit({ ...baseInput(), evidenceIntegrityVerified: undefined });
    expect(result.exitClass).toBe('EXECUTION_FAILURE');
  });

  it('rule 2: a bound FAIL dominates NOT_EVALUABLE (exit 1)', () => {
    const result = classifyExit({
      ...baseInput(),
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'NOT_EVALUABLE'),
      ],
    });
    expect(result.exitClass).toBe('INVARIANT_FAIL');
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('INV-CHK-1');
    expect(result.precedenceRule).toBe(2);
  });

  it('rule 3: a bound invariant with NO persisted verdict is NOT_EVALUABLE (never a silent pass)', () => {
    const result = classifyExit({
      ...baseInput(),
      subjectVerdicts: [subjectVerdict('INV-CHK-1', 'CHK-001', 'PASS')],
    });
    expect(result.exitClass).toBe('NOT_EVALUABLE');
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain('INV-INV-1');
    expect(result.precedenceRule).toBe(3);
  });

  it('rule 3: exit 0 is structurally impossible for a scenario binding zero invariants', () => {
    const result = classifyExit({
      ...baseInput(),
      boundKeyDomains: [],
      subjectVerdicts: [],
    });
    expect(result.exitClass).toBe('NOT_EVALUABLE');
  });

  // ---- Checkpoint D: multi-subject set reduction (ADR-0026 §14) ----------

  it('EXIT-MAP-COLLAPSE repair: one FAIL is not overwritten by another subject PASS, either order', () => {
    const failFirst = classifyExit({
      ...baseInput(),
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL'),
        subjectVerdict('INV-CHK-1', 'CHK-002', 'PASS'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
      ],
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001', 'CHK-002']),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
    });
    const passFirst = classifyExit({
      ...baseInput(),
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-002', 'PASS'),
        subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
      ],
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001', 'CHK-002']),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
    });
    expect(failFirst.exitClass).toBe('INVARIANT_FAIL');
    expect(passFirst.exitClass).toBe('INVARIANT_FAIL');
    expect(failFirst.exitCode).toBe(passFirst.exitCode);
  });

  it('PASS + NOT_EVALUABLE under one bound key is exit 2 (never 0)', () => {
    const result = classifyExit({
      ...baseInput(),
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-001', 'PASS'),
        subjectVerdict('INV-CHK-1', 'CHK-002', 'NOT_EVALUABLE'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
      ],
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001', 'CHK-002']),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
    });
    expect(result.exitClass).toBe('NOT_EVALUABLE');
    expect(result.exitCode).toBe(2);
  });

  it('FAIL + NOT_EVALUABLE under one bound key is exit 1 (FAIL dominates)', () => {
    const result = classifyExit({
      ...baseInput(),
      subjectVerdicts: [
        subjectVerdict('INV-CHK-1', 'CHK-001', 'FAIL'),
        subjectVerdict('INV-CHK-1', 'CHK-002', 'NOT_EVALUABLE'),
        subjectVerdict('INV-INV-1', 'SKU-001', 'PASS'),
      ],
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001', 'CHK-002']),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
    });
    expect(result.exitClass).toBe('INVARIANT_FAIL');
    expect(result.exitCode).toBe(1);
  });

  it('a missing declared subject, a coverage anomaly, and a foreign row are all exit 2', () => {
    const missing = classifyExit({
      ...baseInput(),
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001'], {
          missingSubjects: ['CHK-002'],
          eligibleSubjects: [],
          declaredSubjects: ['CHK-001', 'CHK-002'],
        }),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
      subjectVerdicts: [subjectVerdict('INV-INV-1', 'SKU-001', 'PASS')],
    });
    expect(missing.exitClass).toBe('NOT_EVALUABLE');
    const coverage = classifyExit({
      ...baseInput(),
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001'], { unexpectedSubjectCount: 1 }),
        strictDomain('INV-INV-1', ['SKU-001']),
      ],
    });
    expect(coverage.exitClass).toBe('NOT_EVALUABLE');
    const foreign = classifyExit({
      ...baseInput(),
      anomalies: [
        {
          kind: 'FOREIGN_ROW_ANOMALY',
          invariantKey: 'INV-CHK-1',
          subjectKey: 'FOREIGN-1',
          detail: 'persisted row outside the authoritative domain',
        },
      ],
    });
    expect(foreign.exitClass).toBe('NOT_EVALUABLE');
    expect(foreign.reason).toContain('FOREIGN_ROW_ANOMALY');
  });

  it('a bound legacy key reduces per subject: zero pointers never pass, NE is exit 2', () => {
    const legacyDomain = (subjects: readonly string[]): BoundKeyDomain => ({
      invariantKey: 'INV-IZ-1',
      mode: 'legacy-compat',
      evaluatorVersion: 'v1',
      declaredSubjects: subjects,
      eligibleSubjects: subjects,
      missingSubjects: [],
      unexpectedSubjectCount: 0,
      evidenceGapCount: 0,
    });
    const empty = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: [],
      boundKeyDomains: [legacyDomain([])],
      anomalies: [],
    });
    expect(empty.exitClass).toBe('NOT_EVALUABLE');
    const ne = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: [subjectVerdict('INV-IZ-1', '*', 'NOT_EVALUABLE', 'legacy-compat')],
      boundKeyDomains: [legacyDomain(['*'])],
      anomalies: [],
    });
    expect(ne.exitClass).toBe('NOT_EVALUABLE');
    const pass = classifyExit({
      runTerminalState: 'COMPLETED',
      evidenceIntegrityVerified: true,
      subjectVerdicts: [subjectVerdict('INV-IZ-1', '*', 'PASS', 'legacy-compat')],
      boundKeyDomains: [legacyDomain(['*'])],
      anomalies: [],
    });
    expect(pass.exitClass).toBe('PASS');
  });

  it('a bound key without an authoritative proof never passes', () => {
    const result = classifyExit({
      ...baseInput(),
      boundKeyDomains: [
        strictDomain('INV-CHK-1', ['CHK-001']),
        {
          invariantKey: 'INV-INV-1',
          mode: null,
          evaluatorVersion: null,
          declaredSubjects: [],
          eligibleSubjects: [],
          missingSubjects: [],
          unexpectedSubjectCount: 0,
          evidenceGapCount: 0,
        },
      ],
    });
    expect(result.exitClass).toBe('NOT_EVALUABLE');
  });
});

// ---------------------------------------------------------------------
// scenario.ts — the closed rupturegrid-scenario/v1 contract
// ---------------------------------------------------------------------

function validScenario(): Record<string, unknown> {
  return {
    schemaVersion: SCENARIO_VERSION,
    name: 'checkout-zero-secure',
    description: 'Two concurrent submissions of one intent against one unit of stock.',
    target: { displayName: 'checkout-zero-commerce' },
    experiment: {
      steps: [
        {
          name: 'checkout-submit',
          action: {
            method: 'POST',
            relativePath: '/checkout/submit',
            body: '{}',
            mutation: 'MUTATING',
            contract: 'GENERIC_HTTP',
          },
        },
      ],
      invariantBindings: [
        { key: 'INV-CHK-1', kind: 'atMostOneAcceptedEffect' },
        { key: 'INV-INV-1', kind: 'resourceConservation' },
      ],
    },
    expectations: {
      exitClass: 'PASS',
      invariantVerdicts: { 'INV-CHK-1': 'PASS', 'INV-INV-1': 'PASS' },
    },
  };
}

describe('scenario: closed rupturegrid-scenario/v1 validation', () => {
  it('accepts a well-formed scenario and passes the experiment through untouched', () => {
    const document = validateScenarioDocument(validScenario());
    expect(document.schemaVersion).toBe(SCENARIO_VERSION);
    expect(document.target.displayName).toBe('checkout-zero-commerce');
    expect(scenarioExperimentDocument(document)).toEqual({
      steps: (validScenario()['experiment'] as Record<string, unknown>)['steps'],
      invariantBindings: [
        { key: 'INV-CHK-1', kind: 'atMostOneAcceptedEffect' },
        { key: 'INV-INV-1', kind: 'resourceConservation' },
      ],
    });
  });

  it('refuses unknown schema versions — never guessed', () => {
    expect(() =>
      validateScenarioDocument({ ...validScenario(), schemaVersion: 'rupturegrid-scenario/v2' }),
    ).toThrow(ScenarioValidationError);
  });

  it('rejects unknown top-level fields (closed schema)', () => {
    expect(() => validateScenarioDocument({ ...validScenario(), surprise: 1 })).toThrow(
      /unknown top-level field/,
    );
  });

  it('rejects expectations naming a non-bound invariant key', () => {
    const raw = validScenario();
    (raw['expectations'] as Record<string, unknown>)['invariantVerdicts'] = {
      'INV-OTHER': 'PASS',
    };
    expect(() => validateScenarioDocument(raw)).toThrow(/not a bound invariant key/);
  });

  it('rejects unknown expectation fields and invalid exit-class values', () => {
    const raw = validScenario();
    raw['expectations'] = { exitClass: 'MAYBE', extra: true };
    expect(() => validateScenarioDocument(raw)).toThrow(
      /exitClass must be one of|unknown field \(the expectations block is closed\)/s,
    );
  });

  it('reports MULTIPLE issues in one validation pass', () => {
    try {
      validateScenarioDocument({ schemaVersion: 'nope', name: 'x' });
      expect.unreachable('validation must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      expect((error as ScenarioValidationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('parseScenarioFile: rejects unreadable files and invalid JSON as usage errors', async () => {
    await expect(parseScenarioFile('Z:/definitely/missing/scenario.json')).rejects.toThrow(
      ScenarioValidationError,
    );
    const dir = await mkdtemp(join(tmpdir(), 'rg-scenario-'));
    try {
      const broken = join(dir, 'broken.json');
      await writeFile(broken, '{ not json', 'utf8');
      await expect(parseScenarioFile(broken)).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the committed golden scenarios validate against the contract', async () => {
    // Golden scenarios live at packages/cli/scenarios (repo-visible).
    const scenariosDir = join(__dirname, '..', 'scenarios');
    const vulnerable = await parseScenarioFile(
      join(scenariosDir, 'checkout-zero-vulnerable.scenario.json'),
    );
    const secure = await parseScenarioFile(
      join(scenariosDir, 'checkout-zero-secure.scenario.json'),
    );
    const responseLoss = await parseScenarioFile(
      join(scenariosDir, 'checkout-zero-response-loss.scenario.json'),
    );
    expect(vulnerable.target.displayName).toBe('checkout-zero-commerce');
    expect(secure.expectations?.exitClass).toBe('PASS');
    // Response-loss documents PASS verdicts but deliberately declares NO
    // exitClass expectation (execution outcome is environment-dependent).
    expect(responseLoss.expectations?.exitClass).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// report.ts + schema-validate.ts — serialization and schema agreement
// ---------------------------------------------------------------------

describe('report: rupturegrid-report/v1 emission', () => {
  it('orders evaluations deterministically (invariantKey, then subjectKey)', () => {
    const report = buildReport(reportInput, integrityReport(), classifyExit(baseInput()));
    const keys = report.invariantEvaluations.map((evaluation) => evaluation.invariantKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('serializes an absent reproduction honestly (absent + reason, never invented)', () => {
    const report = buildReport(reportInput, integrityReport(), classifyExit(baseInput()));
    expect(report.reproductionReference).toEqual({
      absent: true,
      reason: expect.stringContaining('reproduction'),
    });
  });

  it('carries the exit object from the classifier verbatim', () => {
    const classification = classifyExit(baseInput());
    const report = buildReport(reportInput, integrityReport(), classification);
    expect(report.exit).toEqual({
      code: 0,
      class: 'PASS',
      reason: classification.reason,
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  it('every emitted report validates against the published schema', () => {
    const report = buildReport(reportInput, integrityReport(), classifyExit(baseInput()));
    expect(() => validateReportAgainstSchema(report)).not.toThrow();
  });

  it('serializes the additive eligibility block when one is frozen', () => {
    const withEligibility: ReportInput = {
      ...reportInput,
      eligibility: {
        eligibilityVersions: ['run-eligibility/v1'],
        analysisGeneration: '7',
        certified: true,
        certifiedAsOf: {
          headContentHash: sha256Hex('head'),
          observationCount: 4,
          lastChainIndex: 3,
          provenanceRevision: '12',
          derivationGeneration: '5',
        },
        boundKeys: [
          {
            invariantKey: 'INV-CHK-1',
            mode: 'strict-coverage/v1',
            evaluatorVersion: 'generic-invariant/v1',
            declaredSubjects: ['CHK-001'],
            eligibleSubjects: ['CHK-001'],
            missingSubjects: [],
            unexpectedSubjectCount: 0,
            foreignInventoryCount: 0,
            evidenceGapCount: 0,
          },
        ],
        unboundCurrentEvaluations: [
          { invariantKey: 'INV-DF-2', subjectKey: '*', verdict: 'NOT_EVALUABLE' },
        ],
        anomalies: [],
        coverageLimitation: null,
        freshnessStatement: 'as-of only',
      },
    };
    const report = buildReport(withEligibility, integrityReport(), classifyExit(baseInput()));
    expect(report.eligibility?.certified).toBe(true);
    expect(report.eligibility?.unboundCurrentEvaluations).toHaveLength(1);
    expect(() => validateReportAgainstSchema(report)).not.toThrow();
  });

  it('does not re-order a frozen normalizer list non-deterministically', () => {
    const withNormalizers: ReportInput = {
      ...reportInput,
      normalizerVersions: [
        { name: 'z-normalizer', version: '2' },
        { name: 'a-normalizer', version: '1' },
      ],
    };
    const report = buildReport(withNormalizers, integrityReport(), classifyExit(baseInput()));
    expect(report.run.normalizerVersions.map((entry) => entry.name)).toEqual([
      'a-normalizer',
      'z-normalizer',
    ]);
  });

  it('an inconsistent exit class/code pairing is a construction error', () => {
    const report = buildReport(reportInput, integrityReport(), classifyExit(baseInput()));
    const tampered = { ...report, exit: { ...report.exit, code: 3 } } as typeof report;
    expect(() => validateReportAgainstSchema(tampered)).toThrow(ReportSchemaValidationError);
  });
});

// ---------------------------------------------------------------------
// cli.ts — pure argument parsing
// ---------------------------------------------------------------------

describe('cli argument parsing', () => {
  it('parses ms/s/m timeout durations and rejects junk', () => {
    expect(parseTimeoutDuration('500')).toBe(500);
    expect(parseTimeoutDuration('90s')).toBe(90_000);
    expect(parseTimeoutDuration('2m')).toBe(120_000);
    expect(parseTimeoutDuration('0')).toBeNull();
    expect(parseTimeoutDuration('-5s')).toBeNull();
    expect(parseTimeoutDuration('2h')).toBeNull();
    expect(parseTimeoutDuration('abc')).toBeNull();
  });

  it('requires --wait and --timeout in v1', () => {
    const missing = parseRunArgs(['scenario.json']);
    expect(typeof missing).toBe('string');
  });

  it('parses the full v1 run surface', () => {
    const flags = parseRunArgs([
      'scenario.json',
      '--wait',
      '--timeout',
      '30s',
      '--report',
      'out/report.json',
      '--json',
    ]);
    expect(typeof flags).toBe('object');
    expect(flags).toMatchObject({
      scenarioPath: 'scenario.json',
      wait: true,
      json: true,
      reportPath: 'out/report.json',
    });
  });

  it('accepts --timeout=VALUE form', () => {
    const flags = parseRunArgs(['s.json', '--wait', '--timeout=45s']);
    expect(typeof flags).toBe('object');
    expect(flags).toMatchObject({ scenarioPath: 's.json', wait: true });
  });
});

// ---------------------------------------------------------------------
// Committed schema artifacts agree with the emitter's source of truth
// ---------------------------------------------------------------------

describe('schema emission artifacts', () => {
  it('the emitted schema files match the compiled documents', async () => {
    // Emitted artifacts live at packages/cli/schemas (repo-visible),
    // one level above the compiled src/ directory.
    const dir = join(__dirname, '..', 'schemas');
    const reportSchemaText = await readFile(join(dir, 'rupturegrid-report-v1.schema.json'), 'utf8');
    const scenarioSchemaText = await readFile(
      join(dir, 'rupturegrid-scenario-v1.schema.json'),
      'utf8',
    );
    const reportSchema = JSON.parse(reportSchemaText) as Record<string, unknown>;
    const scenarioSchema = JSON.parse(scenarioSchemaText) as Record<string, unknown>;
    expect(reportSchema['$id']).toContain('rupturegrid-report-v1.schema.json');
    expect(scenarioSchema['$id']).toContain('rupturegrid-scenario-v1.schema.json');
    // The committed artifacts must be EXACTLY the compiled documents
    // (emit is a pure serialization of the runtime source of truth —
    // the validator can never silently drift from the published file).
    expect(reportSchema).toEqual(reportJsonSchema);
    expect(scenarioSchema).toEqual(scenarioJsonSchema);
  });

  // -----------------------------------------------------------------
  // B2 repair: emission is Prettier-STABLE by construction. A fresh
  // `schemas emit` must reproduce the committed artifacts BYTE-FOR-
  // BYTE (the same serialization contract `pnpm format:check` fully
  // requires, including the .prettierrc.json printWidth applied to
  // short arrays). Byte-stability is the only assertion strong enough
  // to prove the next emission cannot recreate the B2 format failure.
  // -----------------------------------------------------------------

  it('a fresh emission reproduces the committed schema files BYTE-FOR-BYTE (B2 stability)', async () => {
    const dir = join(__dirname, '..', 'schemas');
    const committed = {
      report: await readFile(join(dir, 'rupturegrid-report-v1.schema.json'), 'utf8'),
      scenario: await readFile(join(dir, 'rupturegrid-scenario-v1.schema.json'), 'utf8'),
    };
    const stabilized = {
      report: await serializeSchemaDocumentStable(
        reportJsonSchema,
        join(dir, 'rupturegrid-report-v1.schema.json'),
      ),
      scenario: await serializeSchemaDocumentStable(
        scenarioJsonSchema,
        join(dir, 'rupturegrid-scenario-v1.schema.json'),
      ),
    };
    expect(stabilized.report).toBe(committed.report);
    expect(stabilized.scenario).toBe(committed.scenario);
  });

  it('writing a fresh emission into a temp directory is byte-identical to the committed copies', async () => {
    // Full emitSchemas() path (mkdir + resolveConfig + format + write),
    // not only the serializer: the CLI's actual emission contract.
    const dir = await mkdtemp(join(tmpdir(), 'rg-schema-emit-'));
    try {
      const written = await emitSchemas(dir);
      expect(written.length).toBe(2);
      const committedReport = await readFile(
        join(__dirname, '..', 'schemas', 'rupturegrid-report-v1.schema.json'),
        'utf8',
      );
      const committedScenario = await readFile(
        join(__dirname, '..', 'schemas', 'rupturegrid-scenario-v1.schema.json'),
        'utf8',
      );
      expect(await readFile(written[0] as string, 'utf8')).toBe(committedReport);
      expect(await readFile(written[1] as string, 'utf8')).toBe(committedScenario);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
