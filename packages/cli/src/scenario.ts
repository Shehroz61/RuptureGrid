// =====================================================================
// RuptureGrid v1.1 Phase 17 — rupturegrid-scenario/v1 closed contract
// (ADR-0019 Decision 3 consequence; roadmap Phase 17)
// =====================================================================
// The FIRST versioned scenario-document contract. A scenario is pure
// DATA that binds the EXISTING accepted ExperimentDocument vocabulary
// (packages/engine validate.ts — the authoritative validation) to a
// stable target selector and optional acceptance expectations.
//
// Hard properties (frozen here, enforced by validateScenarioDocument):
//   - CLOSED schema: unknown fields are rejected at every level —
//     a scenario can never smuggle executable content in.
//   - DATA-ONLY: no code, no SQL, no expression language, no target
//     DB access. The experiment block reuses the accepted experiment
//     step vocabulary VERBATIM (no second HTTP-step grammar exists).
//   - VERSIONED: only `rupturegrid-scenario/v1` is accepted; unknown
//     versions are refused, never guessed.
//   - BOUNDED: serialized size is capped (server-side blast-radius
//     discipline, security-boundaries §8).
//   - PORTABLE: the target selector is `displayName` — a USER-FACING
//     lookup convenience ONLY (registration makes it unique). It is
//     NEVER a security principal (ADR-0024 §3): after lookup, the
//     stored registration (id, origins, environment, manifest,
//     credential refs, platform authorization) remains authoritative,
//     and no scenario field can grant target authority.
//   - EXPECTATIONS ARE NOT TRUTH (ADR-0019): expectations exist for
//     committed regression assertions; they NEVER influence
//     evaluation, findings, report truth, or exit classification
//     (exit-classifier.ts reads durable truth only).
//
// Nothing here executes: validation is pure; no run, no durable
// mutation, and no target HTTP request can occur from this module.
//
// Existing experiment validation stays AUTHORITATIVE: the embedded
// experiment document is validated by validateExperimentDocument
// against the resolved target BEFORE any durable write (run.ts).
// Scenario validation narrows nothing and weakens nothing.

import type { GenericInvariantInstance } from '@rupturegrid/engine';

/** The only accepted scenario document version. Unknown versions: refused. */
export const SCENARIO_VERSION = 'rupturegrid-scenario/v1';

/** Closed exit-class vocabulary (the five-way contract, ADR-0019). */
export const EXPECTED_EXIT_CLASSES = [
  'PASS',
  'INVARIANT_FAIL',
  'NOT_EVALUABLE',
  'EXECUTION_FAILURE',
  'USAGE_ERROR',
] as const;
export type ExpectedExitClass = (typeof EXPECTED_EXIT_CLASSES)[number];

/** Closed invariant-verdict vocabulary (evidence-model §1/§7). */
export const EXPECTED_VERDICTS = ['PASS', 'FAIL', 'NOT_EVALUABLE'] as const;
export type ExpectedVerdict = (typeof EXPECTED_VERDICTS)[number];

/** Maximum serialized scenario size (bytes) — bounded input discipline. */
export const SCENARIO_MAX_SERIALIZED_BYTES = 64_000;

/** Maximum length of the scenario name / description strings. */
export const SCENARIO_NAME_MAX_CHARS = 120;
export const SCENARIO_DESCRIPTION_MAX_CHARS = 500;

export class ScenarioValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      issues.length === 1
        ? `invalid scenario document: ${issues[0]}`
        : `invalid scenario document (${String(issues.length)} issues):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'ScenarioValidationError';
    this.issues = issues;
  }
}

/** The stable, portable target selector. Metadata only — never authority. */
export interface ScenarioTargetSelector {
  /**
   * A unique registered target displayName. Registration enforces
   * uniqueness (`target_registration.displayName @unique`), so this
   * resolves to exactly one stored registration. It is a lookup
   * convenience: the resolved registration row (id, origins,
   * environment, manifest, credentialRefs, platform grants) is the
   * entire authority for any subsequent execution.
   */
  readonly displayName: string;
}

/** Optional acceptance expectations — NEVER truth (see module header). */
export interface ScenarioExpectations {
  /** The exit class a committed regression run is expected to classify. */
  readonly exitClass?: ExpectedExitClass;
  /** Expected verdict (or absence: "missing") per bound invariant key. */
  readonly invariantVerdicts?: Readonly<Record<string, ExpectedVerdict>>;
}

/**
 * The validated scenario document (pure data). `experiment` is the
 * EXISTING ExperimentDocument shape (steps + optional
 * invariantBindings) passed through untouched for the engine's own
 * authoritative validation.
 */
export interface ScenarioDocument {
  readonly schemaVersion: typeof SCENARIO_VERSION;
  readonly name: string;
  readonly description: string;
  readonly target: ScenarioTargetSelector;
  /** The accepted experiment vocabulary — validated by the engine. */
  readonly experiment: {
    readonly steps: unknown;
    readonly invariantBindings?: readonly GenericInvariantInstance[];
    /** Phase 17 (ADR-0026 §3): optional run-scope/v1 anchor intent. */
    readonly runScope?: unknown;
  };
  readonly expectations?: ScenarioExpectations;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Closed-vocabulary membership helper. */
function memberOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Validates one expectations block. Closed fields, closed enums,
 * bounded map. Returns the issues found (empty = valid).
 */
function expectationsIssues(
  raw: Record<string, unknown>,
  path: string,
  invariantKeys: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== 'exitClass' && key !== 'invariantVerdicts') {
      issues.push(`${path}.${key}: unknown field (the expectations block is closed)`);
    }
  }
  if (raw['exitClass'] !== undefined) {
    if (!memberOf(raw['exitClass'], EXPECTED_EXIT_CLASSES)) {
      issues.push(`${path}.exitClass must be one of: ${EXPECTED_EXIT_CLASSES.join(', ')}`);
    }
  }
  if (raw['invariantVerdicts'] !== undefined) {
    const map = raw['invariantVerdicts'];
    if (!isRecord(map)) {
      issues.push(`${path}.invariantVerdicts must be an object keyed by invariant key`);
    } else {
      for (const [invariantKey, verdict] of Object.entries(map)) {
        if (!invariantKeys.has(invariantKey)) {
          issues.push(
            `${path}.invariantVerdicts["${invariantKey}"]: not a bound invariant key of this scenario`,
          );
        }
        if (!memberOf(verdict, EXPECTED_VERDICTS)) {
          issues.push(
            `${path}.invariantVerdicts["${invariantKey}"] must be one of: ${EXPECTED_VERDICTS.join(', ')}`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Validates a raw scenario document against the closed
 * rupturegrid-scenario/v1 contract. Pure — never executes, never
 * touches the network or database. Throws ScenarioValidationError
 * with every issue listed. Size bounding happens in parseScenarioFile
 * (which owns the file read) and re-checked here on the object shape.
 */
export function validateScenarioDocument(raw: unknown): ScenarioDocument {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    throw new ScenarioValidationError(['scenario must be a JSON object']);
  }
  // ---- schemaVersion (exact; unknown versions refused, never guessed) ----
  if (raw['schemaVersion'] !== SCENARIO_VERSION) {
    issues.push(
      `schemaVersion must be exactly "${SCENARIO_VERSION}" (got ${JSON.stringify(
        raw['schemaVersion'] ?? null,
      )}; unknown versions are never guessed)`,
    );
  }
  // ---- name ----
  const name = raw['name'];
  if (typeof name !== 'string' || name.trim().length < 3) {
    issues.push('name must be a string of at least 3 characters');
  } else if (name.length > SCENARIO_NAME_MAX_CHARS) {
    issues.push(`name exceeds ${String(SCENARIO_NAME_MAX_CHARS)} characters`);
  }
  // ---- description ----
  const description = raw['description'];
  if (typeof description !== 'string' || description.length === 0) {
    issues.push('description must be a non-empty string');
  } else if (description.length > SCENARIO_DESCRIPTION_MAX_CHARS) {
    issues.push(`description exceeds ${String(SCENARIO_DESCRIPTION_MAX_CHARS)} characters`);
  }
  // ---- target selector (closed: displayName only) ----
  const target = raw['target'];
  if (!isRecord(target)) {
    issues.push('target must be an object with a displayName selector');
  } else {
    for (const key of Object.keys(target)) {
      if (key !== 'displayName') {
        issues.push(`target.${key}: unknown field (the target selector is closed)`);
      }
    }
    const displayName = target['displayName'];
    if (typeof displayName !== 'string' || displayName.trim().length < 3) {
      issues.push('target.displayName must be a string of at least 3 characters');
    } else if (displayName.length > SCENARIO_NAME_MAX_CHARS) {
      issues.push(`target.displayName exceeds ${String(SCENARIO_NAME_MAX_CHARS)} characters`);
    }
  }
  // ---- experiment block (closed envelope; contents engine-validated) ----
  const experiment = raw['experiment'];
  if (!isRecord(experiment)) {
    issues.push('experiment must be an object with a steps array');
  } else {
    for (const key of Object.keys(experiment)) {
      if (key !== 'steps' && key !== 'invariantBindings' && key !== 'runScope') {
        issues.push(
          `experiment.${key}: unknown field (the experiment envelope carries only steps, invariantBindings, and runScope)`,
        );
      }
    }
    if (!Array.isArray(experiment['steps'])) {
      issues.push('experiment.steps must be an array (the accepted experiment vocabulary)');
    }
    if (
      experiment['invariantBindings'] !== undefined &&
      !Array.isArray(experiment['invariantBindings'])
    ) {
      issues.push('experiment.invariantBindings must be an array of invariant instances');
    }
    if (experiment['runScope'] !== undefined && !isRecord(experiment['runScope'])) {
      issues.push('experiment.runScope must be an object (the closed run-scope/v1 declaration)');
    }
  }
  // ---- expectations (closed; never truth) ----
  const boundKeys = new Set<string>();
  if (isRecord(experiment) && Array.isArray(experiment['invariantBindings'])) {
    for (const binding of experiment['invariantBindings']) {
      if (isRecord(binding) && typeof binding['key'] === 'string') {
        boundKeys.add(binding['key']);
      }
    }
  }
  if (raw['expectations'] !== undefined) {
    if (!isRecord(raw['expectations'])) {
      issues.push('expectations must be an object');
    } else {
      issues.push(...expectationsIssues(raw['expectations'], 'expectations', boundKeys));
    }
  }
  // ---- closed top level ----
  const allowedTop = new Set([
    'schemaVersion',
    'name',
    'description',
    'target',
    'experiment',
    'expectations',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) {
      issues.push(`"${key}": unknown top-level field (rupturegrid-scenario/v1 is closed)`);
    }
  }
  if (issues.length > 0) {
    throw new ScenarioValidationError(issues);
  }
  // Narrowed construction (fields verified above).
  const verifiedExperiment = experiment as {
    steps: unknown;
    invariantBindings?: readonly GenericInvariantInstance[];
    runScope?: unknown;
  };
  const experimentOut: ScenarioDocument['experiment'] = {
    steps: verifiedExperiment.steps,
    ...(verifiedExperiment.invariantBindings !== undefined
      ? { invariantBindings: verifiedExperiment.invariantBindings }
      : {}),
    ...(verifiedExperiment.runScope !== undefined ? { runScope: verifiedExperiment.runScope } : {}),
  };
  const document: ScenarioDocument = {
    schemaVersion: SCENARIO_VERSION,
    name: name as string,
    description: description as string,
    target: { displayName: (target as Record<string, unknown>)['displayName'] as string },
    experiment: experimentOut,
    ...(raw['expectations'] === undefined
      ? {}
      : { expectations: raw['expectations'] as ScenarioExpectations }),
  };
  return document;
}

/**
 * Reads and parses a scenario file: bounded size, strict JSON, then
 * closed-schema validation. Pure I/O — nothing executes, nothing
 * durable happens, no network request occurs. USAGE-ERROR semantics
 * belong to the caller (cli.ts maps ScenarioValidationError to exit 4).
 */
export async function parseScenarioFile(path: string): Promise<ScenarioDocument> {
  const { readFile } = await import('node:fs/promises');
  let rawText: string;
  try {
    rawText = await readFile(path, 'utf8');
  } catch (error) {
    throw new ScenarioValidationError([
      `scenario file "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const bytes = Buffer.byteLength(rawText, 'utf8');
  if (bytes > SCENARIO_MAX_SERIALIZED_BYTES) {
    throw new ScenarioValidationError([
      `scenario file is ${String(bytes)} bytes; the accepted maximum is ${String(SCENARIO_MAX_SERIALIZED_BYTES)}`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new ScenarioValidationError([
      `scenario file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return validateScenarioDocument(parsed);
}

/**
 * Serializes the scenario's embedded experiment document for the
 * engine's authoritative validateExperimentDocument call. The scenario
 * layer adds NOTHING to the experiment vocabulary.
 */
export function scenarioExperimentDocument(scenario: ScenarioDocument): unknown {
  const out: Record<string, unknown> = { steps: scenario.experiment.steps };
  if (scenario.experiment.invariantBindings !== undefined) {
    out['invariantBindings'] = scenario.experiment.invariantBindings;
  }
  if (scenario.experiment.runScope !== undefined) {
    out['runScope'] = scenario.experiment.runScope;
  }
  return out;
}
