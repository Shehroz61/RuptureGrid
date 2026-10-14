// =====================================================================
// RuptureGrid v1.1 Phase 17 — run-owned anchor intent (ADR-0026 §3/§6/§12)
// =====================================================================
// The frozen `runScope/v1` declaration: what a run INTENDED to verify.
// It is pure data validated at definition/freeze time against:
//
//   - the frozen experiment STEPS (the named setup step must exist and
//     must be a one-shot anchor by declaration);
//   - the frozen generic INVARIANT BINDINGS (every binding key must
//     declare its subjects; the binding's declared scope binding must
//     be a single declared field with a declared generation field);
//   - the frozen ManifestEvidencePolicy (`sensitiveFields` exclusions
//     for anchor field names; declared types for the §6 mapping).
//
// A frozen declaration is INTENT, never proof (ADR-0026 §3): the
// observed anchor is derived by analysis from fenced setup-response
// evidence (§5/§11). Presence of `runScope` on a document additionally
// requires generic `invariantBindings` (rule 6): there is no dead config
// and no implicit compatibility fallback.
//
// Every rejection is a NAMED, deterministic, fail-closed issue — never
// a silent strip, never a guessed default. No runtime code expression
// exists anywhere in `runScope`: values are comparison-only identifiers
// and are never interpolated, resolved, or executed (ADR-0026 §12).
//
// BACKWARD COMPATIBILITY (frozen, ADR-0026 §17): documents with NO
// `runScope` — every accepted Incident Zero / Controlled Faults /
// Phase 14–16 fixture — are byte-identical to today. The presence
// requirement is symmetric: `runScope` ⟺ generic `invariantBindings`.

import { EXECUTOR_CREDENTIAL_REFS } from '@rupturegrid/config';
import { canonicalizeJson } from './canonicalize.js';
import type { ManifestEvidencePolicy } from './manifest.js';
import type { GenericInvariantInstance } from './generic-invariant-registry.js';
import type { ExperimentStep } from './types.js';

/** The exact accepted `runScope.version` (ADR-0026 §3 rule 1). */
export const RUN_SCOPE_VERSION = 'run-scope/v1';

/** The single strict coverage mode of ADR-0026 §7. */
export const RUN_SCOPE_COVERAGE_MODE = 'strict-coverage/v1';

/** The frozen eligibility protocol identity recorded in proofs/pointers. */
export const RUN_SCOPE_ELIGIBILITY_VERSION = 'run-eligibility/v1';

/**
 * The exact numeric bounds of ADR-0026 §12 (every "existing" value is
 * already enforced elsewhere; every "new" value is justified in the ADR
 * against a platform precedent). Frozen here so tests assert the exact
 * numbers, not prose.
 */
export const RUN_SCOPE_LIMITS = {
  /** declaredScope: 1..120 chars (existing name precedent). */
  maxDeclaredScopeChars: 120,
  /** setupStep: the existing step-name grammar (≤63 chars). */
  maxSetupStepChars: 63,
  /** scopeField / generationField: existing FIELD_NAME_PATTERN (≤64). */
  maxFieldNameChars: 64,
  /** subject-map key: the existing invariantKey VarChar(80) bound. */
  maxSubjectKeyChars: 80,
  /** subjects per invariant key (new; 32-family precedent). */
  maxSubjectsPerKey: 32,
  /** total subjects across all keys (new; MANIFEST_LIMITS 64-family). */
  maxTotalSubjects: 64,
  /** subject identity: the existing subjectKey VarChar(200) bound. */
  maxSubjectIdentityChars: 200,
  /** canonical serialized runScope (new; sub-budget of 64_000). */
  maxSerializedBytes: 16_000,
} as const;

/** The existing step-name grammar (validate.ts). */
const STEP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
/**
 * The platform's PERSISTENT-REDACTION name pattern (the same shape the
 * evidence layer applies to every persisted observation payload before
 * content hashing and storage). An anchor field whose NAME matches this
 * pattern is redacted by construction, so no declaration could ever
 * establish an anchor from it: the ADR-0026 §3 rule 4 intent ("never
 * bind the anchor to a field that is redacted by construction") is
 * enforced structurally here — fail closed at definition time instead
 * of shipping dead configuration that can only ever yield
 * ANCHOR_UNPROVEN. Kept in lock-step with `packages/evidence/src/
 * redact.ts` by an explicit conformance test.
 */
const PERSISTENT_REDACTION_NAME_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)/i;

/**
 * True when a declared anchor field name would be redacted by the
 * platform's persistent-redaction name pattern in every durable
 * observation — such a name can never carry anchor authority.
 */
export function isRedactedAnchorFieldName(name: string): boolean {
  return PERSISTENT_REDACTION_NAME_PATTERN.test(name);
}
/** The declared-scope grammar (ADR-0026 §3 rule 3). */
const DECLARED_SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,119}$/;
/** The existing field-name grammar (registry FIELD_NAME_PATTERN). */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** Forbidden interpolation characters in a subject identity. */
const SUBJECT_FORBIDDEN_CHARS: ReadonlySet<string> = new Set(['$', '`', '\\', '{', '}']);
const REDACTED_MARKER = '[Redacted]';

/**
 * A subject identity must be printable non-control and must contain no
 * interpolation syntax (ADR-0026 §3 rule 5/§12). Control characters are
 * checked by code point so no control-character range appears in a
 * regular-expression literal.
 */
function hasForbiddenSubjectForm(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
    if (SUBJECT_FORBIDDEN_CHARS.has(char)) {
      return true;
    }
  }
  return value.includes(REDACTED_MARKER);
}

/** The closed key set of the `runScope` block (exactly six keys). */
export const RUN_SCOPE_KEYS: ReadonlySet<string> = new Set([
  'version',
  'setupStep',
  'declaredScope',
  'scopeField',
  'generationField',
  'subjects',
]);

/** The validated, frozen `runScope/v1` declaration (pure data). */
export interface RunScopeDeclaration {
  readonly version: typeof RUN_SCOPE_VERSION;
  readonly setupStep: string;
  readonly declaredScope: string;
  readonly scopeField: string;
  readonly generationField: string;
  readonly subjects: Readonly<Record<string, readonly string[]>>;
}

/** A deterministic, named definition-time rejection. */
export interface RunScopeIssue {
  readonly code: string;
  readonly detail: string;
}

export class RunScopeDefinitionError extends Error {
  public readonly issues: readonly RunScopeIssue[];

  public constructor(issues: readonly RunScopeIssue[]) {
    super(
      issues.length === 1
        ? `invalid run-scope/v1 declaration (${issues[0]?.code}): ${issues[0]?.detail}`
        : `invalid run-scope/v1 declaration (${issues.length} issues): ${issues
            .map((entry) => `${entry.code}: ${entry.detail}`)
            .join('; ')}`,
    );
    this.name = 'RunScopeDefinitionError';
    this.issues = issues;
  }
}

const issue = (code: string, detail: string): RunScopeIssue => ({ code, detail });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The declared ManifestFieldType of every occurrence of a field name. */
function declaredTypesOf(policy: ManifestEvidencePolicy, field: string): string[] {
  const types: string[] = [];
  for (const node of policy.identityModel.nodes) {
    const declared = node.fields[field];
    if (declared !== undefined) {
      types.push(declared);
    }
  }
  for (const query of policy.inspection) {
    const declared = query.fields[field];
    if (declared !== undefined) {
      types.push(declared);
    }
  }
  return types;
}

/**
 * Validates a raw `runScope` declaration against the frozen steps,
 * generic bindings, and evidence policy; returns the frozen declaration
 * or throws `RunScopeDefinitionError` with every named issue.
 */
export function validateRunScopeDeclaration(input: {
  readonly rawRunScope: unknown;
  readonly steps: readonly ExperimentStep[];
  readonly invariantBindings: readonly GenericInvariantInstance[] | undefined;
  readonly policy: ManifestEvidencePolicy;
}): RunScopeDeclaration {
  const issues: RunScopeIssue[] = [];
  const raw = input.rawRunScope;
  if (!isRecord(raw)) {
    throw new RunScopeDefinitionError([
      issue('RUN_SCOPE_MALFORMED', 'runScope must be a JSON object'),
    ]);
  }
  // ---- Closed key set (rule: unknown fields are rejections). ----
  for (const key of Object.keys(raw)) {
    if (!RUN_SCOPE_KEYS.has(key)) {
      issues.push(
        issue('RUN_SCOPE_UNKNOWN_FIELD', `runScope."${key}" is not a declared run-scope/v1 field`),
      );
    }
  }
  // ---- 1. version (exact; unknown versions are refused, never guessed). ----
  if (raw['version'] !== RUN_SCOPE_VERSION) {
    issues.push(
      issue(
        'RUN_SCOPE_UNKNOWN_VERSION',
        `runScope.version must be exactly "${RUN_SCOPE_VERSION}" (got ${JSON.stringify(raw['version'])})`,
      ),
    );
  }
  // ---- 2. setupStep (exactly one frozen step; one-shot by declaration). ----
  const setupStep = raw['setupStep'];
  let setupStepValid = false;
  if (typeof setupStep !== 'string' || !STEP_NAME_PATTERN.test(setupStep)) {
    issues.push(
      issue(
        'RUN_SCOPE_SETUP_STEP_GRAMMAR',
        'runScope.setupStep must match the step-name grammar ^[a-z][a-z0-9-]{0,62}$',
      ),
    );
  } else {
    const matches = input.steps.filter((step) => step.name === setupStep);
    if (matches.length === 0) {
      issues.push(
        issue(
          'RUN_SCOPE_SETUP_STEP_UNKNOWN',
          `runScope.setupStep "${setupStep}" names no step of the frozen experiment`,
        ),
      );
    } else if (matches.length > 1) {
      // Step names are unique by engine validation: a second match is a
      // validation invariant violation, never resolved by order.
      issues.push(
        issue(
          'RUN_SCOPE_SETUP_STEP_AMBIGUOUS',
          `runScope.setupStep "${setupStep}" matches more than one frozen step (step names must be unique)`,
        ),
      );
    } else {
      const step = matches[0] as ExperimentStep;
      setupStepValid = true;
      const repeat = step.action.repeat ?? 1;
      const concurrency = step.action.concurrency ?? 1;
      const retryPolicy = step.action.retryPolicy ?? 'NONE';
      if (repeat !== 1) {
        issues.push(
          issue(
            'RUN_SCOPE_SETUP_STEP_REPEAT',
            `runScope.setupStep "${setupStep}" must declare repeat: 1 (got ${String(repeat)})`,
          ),
        );
      }
      if (concurrency !== 1) {
        issues.push(
          issue(
            'RUN_SCOPE_SETUP_STEP_CONCURRENCY',
            `runScope.setupStep "${setupStep}" must declare concurrency: 1 (got ${String(concurrency)})`,
          ),
        );
      }
      if (retryPolicy !== 'NONE') {
        issues.push(
          issue(
            'RUN_SCOPE_SETUP_STEP_RETRY_POLICY',
            `runScope.setupStep "${setupStep}" must declare retryPolicy: "NONE" (got ${JSON.stringify(retryPolicy)})`,
          ),
        );
      }
    }
  }
  // ---- 3. declaredScope (1..120; interpolation structurally impossible). ----
  const declaredScope = raw['declaredScope'];
  if (typeof declaredScope !== 'string') {
    issues.push(issue('RUN_SCOPE_SCOPE_LENGTH', 'runScope.declaredScope must be a string'));
  } else if (
    declaredScope.length < 1 ||
    declaredScope.length > RUN_SCOPE_LIMITS.maxDeclaredScopeChars
  ) {
    issues.push(
      issue(
        'RUN_SCOPE_SCOPE_LENGTH',
        `runScope.declaredScope must be 1..${String(RUN_SCOPE_LIMITS.maxDeclaredScopeChars)} characters`,
      ),
    );
  } else if (!DECLARED_SCOPE_PATTERN.test(declaredScope)) {
    issues.push(
      issue(
        'RUN_SCOPE_SCOPE_GRAMMAR',
        'runScope.declaredScope must match ^[a-z][a-z0-9-]{0,119}$ (no interpolation, no whitespace, no control characters)',
      ),
    );
  }
  // ---- 4. scopeField / generationField (field grammar; exclusions). ----
  const sensitiveFields = new Set(input.policy.sensitiveFields);
  const credentialRefs = new Set<string>(EXECUTOR_CREDENTIAL_REFS);
  const anchorFieldNames: { name: string; where: string }[] = [];
  for (const fieldKey of ['scopeField', 'generationField'] as const) {
    const value = raw[fieldKey];
    if (typeof value !== 'string' || !FIELD_NAME_PATTERN.test(value)) {
      issues.push(
        issue(
          'RUN_SCOPE_FIELD_GRAMMAR',
          `runScope.${fieldKey} must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$`,
        ),
      );
      continue;
    }
    if (sensitiveFields.has(value)) {
      issues.push(
        issue(
          'RUN_SCOPE_SENSITIVE_FIELD',
          `runScope.${fieldKey} "${value}" is a sensitive field of the frozen evidence policy; the anchor must never bind to a field that is redacted by construction`,
        ),
      );
    }
    if (credentialRefs.has(value)) {
      issues.push(
        issue(
          'RUN_SCOPE_CREDENTIAL_NAME',
          `runScope.${fieldKey} "${value}" collides with an executor credential reference name; credential names are never anchor fields`,
        ),
      );
    }
    if (isRedactedAnchorFieldName(value)) {
      // ADR-0026 §3 rule 4 / §16 ("the anchor must never be bound to a
      // field that is redacted by construction"). The platform's
      // persistent-redaction NAME pattern is the strongest such registry:
      // a field named `*token*`/`*secret*`/… is replaced by the redaction
      // marker in EVERY persisted observation, so no anchor could ever be
      // established from it. This is reported under the ADR's existing
      // sensitive-field rejection code rather than a new one: the field IS
      // redacted by construction, whether the registry masking it is the
      // target-declared `sensitiveFields` set or the platform default
      // (verified against real durable evidence in the Checkpoint C
      // session: a `scopeToken` anchor was unreadable after persistence).
      issues.push(
        issue(
          'RUN_SCOPE_SENSITIVE_FIELD',
          `runScope.${fieldKey} "${value}" matches the platform persistent-redaction name pattern; its value is redacted before durable persistence in EVERY observation, so no anchor could ever be established from it (fail closed: the anchor field must be readable from stored evidence)`,
        ),
      );
    }
    anchorFieldNames.push({ name: value, where: fieldKey });
  }
  // ---- 5. subjects (keys ⊆ binding keys; every binding key present). ----
  const bindingKeys = new Set((input.invariantBindings ?? []).map((binding) => binding.key));
  const subjectsRaw = raw['subjects'];
  const subjects: Record<string, string[]> = {};
  let totalSubjects = 0;
  if (!isRecord(subjectsRaw)) {
    issues.push(issue('RUN_SCOPE_SUBJECTS_MALFORMED', 'runScope.subjects must be a JSON object'));
  } else {
    for (const [key, value] of Object.entries(subjectsRaw)) {
      if (key.length > RUN_SCOPE_LIMITS.maxSubjectKeyChars) {
        issues.push(
          issue(
            'RUN_SCOPE_SUBJECT_KEY_LENGTH',
            `runScope.subjects key "${key.slice(0, 40)}…" exceeds ${String(RUN_SCOPE_LIMITS.maxSubjectKeyChars)} characters`,
          ),
        );
      }
      if (!bindingKeys.has(key)) {
        issues.push(
          issue(
            'RUN_SCOPE_SUBJECT_KEY_UNKNOWN',
            `runScope.subjects key "${key}" is not a frozen generic invariant binding key`,
          ),
        );
      }
      if (!Array.isArray(value)) {
        issues.push(
          issue('RUN_SCOPE_SUBJECTS_MALFORMED', `runScope.subjects["${key}"] must be an array`),
        );
        continue;
      }
      if (value.length === 0) {
        issues.push(
          issue(
            'RUN_SCOPE_SUBJECTS_EMPTY',
            `runScope.subjects["${key}"] must be a non-empty list of subject identities (a generic instance without declared subjects can never establish eligibility)`,
          ),
        );
      }
      if (value.length > RUN_SCOPE_LIMITS.maxSubjectsPerKey) {
        issues.push(
          issue(
            'RUN_SCOPE_SUBJECTS_PER_KEY_LIMIT',
            `runScope.subjects["${key}"] exceeds ${String(RUN_SCOPE_LIMITS.maxSubjectsPerKey)} subjects`,
          ),
        );
      }
      const seen = new Set<string>();
      const accepted: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string') {
          issues.push(
            issue(
              'RUN_SCOPE_SUBJECT_LENGTH',
              `runScope.subjects["${key}"] entries must be strings`,
            ),
          );
          continue;
        }
        if (entry.length < 1 || entry.length > RUN_SCOPE_LIMITS.maxSubjectIdentityChars) {
          issues.push(
            issue(
              'RUN_SCOPE_SUBJECT_LENGTH',
              `runScope.subjects["${key}"] identity must be 1..${String(RUN_SCOPE_LIMITS.maxSubjectIdentityChars)} characters`,
            ),
          );
          continue;
        }
        if (hasForbiddenSubjectForm(entry)) {
          issues.push(
            issue(
              'RUN_SCOPE_INTERPOLATION',
              `runScope.subjects["${key}"] identity contains a forbidden interpolation/control/redaction form`,
            ),
          );
          continue;
        }
        if (seen.has(entry)) {
          issues.push(
            issue(
              'RUN_SCOPE_SUBJECT_DUPLICATE',
              `runScope.subjects["${key}"] repeats subject identity "${entry}"`,
            ),
          );
          continue;
        }
        seen.add(entry);
        accepted.push(entry);
      }
      totalSubjects += accepted.length;
      subjects[key] = accepted;
    }
    for (const bindingKey of bindingKeys) {
      if (!(bindingKey in subjectsRaw)) {
        issues.push(
          issue(
            'RUN_SCOPE_MISSING_BINDING_KEY',
            `runScope.subjects is missing frozen generic invariant binding key "${bindingKey}" (fail-closed: every generic binding must declare its subjects)`,
          ),
        );
      }
    }
  }
  if (totalSubjects > RUN_SCOPE_LIMITS.maxTotalSubjects) {
    issues.push(
      issue(
        'RUN_SCOPE_TOTAL_SUBJECTS_LIMIT',
        `runScope declares ${String(totalSubjects)} subjects; the total limit is ${String(RUN_SCOPE_LIMITS.maxTotalSubjects)}`,
      ),
    );
  }
  // ---- 6. Generic binding scope/generation mapping (ADR-0026 §6). ----
  for (const binding of input.invariantBindings ?? []) {
    const scopeBinding = (
      binding.params as { scopeBinding?: { fields?: unknown; generationField?: unknown } }
    ).scopeBinding;
    if (scopeBinding === undefined || !Array.isArray(scopeBinding.fields)) {
      // The registry validator already guarantees a scopeBinding shape;
      // a missing one here is a validation invariant violation.
      issues.push(
        issue(
          'RUN_SCOPE_SCOPE_BINDING_MISSING',
          `invariant binding "${binding.key}" declares no scopeBinding (required for run-scope/v1)`,
        ),
      );
      continue;
    }
    if (scopeBinding.fields.length !== 1) {
      issues.push(
        issue(
          'RUN_SCOPE_MULTI_SCOPE_FIELD',
          `invariant binding "${binding.key}" declares ${String(scopeBinding.fields.length)} scope fields; run-scope/v1 requires exactly one (a valid multi-field invariant cannot be combined with run-scope/v1 in a new definition)`,
        ),
      );
    } else {
      const scopeFieldName = scopeBinding.fields[0] as string;
      const types = declaredTypesOf(input.policy, scopeFieldName);
      if (types.some((type) => type !== 'string')) {
        issues.push(
          issue(
            'RUN_SCOPE_SCOPE_FIELD_TYPE',
            `invariant binding "${binding.key}" scope field "${scopeFieldName}" must be declared string on every bound surface`,
          ),
        );
      }
    }
    const generationFieldName = scopeBinding.generationField;
    if (typeof generationFieldName !== 'string') {
      issues.push(
        issue(
          'RUN_SCOPE_GENERATION_REQUIRED',
          `invariant binding "${binding.key}" must declare scopeBinding.generationField when combined with run-scope/v1`,
        ),
      );
    } else {
      const types = declaredTypesOf(input.policy, generationFieldName);
      if (types.some((type) => type !== 'integer-minor-units')) {
        issues.push(
          issue(
            'RUN_SCOPE_GENERATION_FIELD_TYPE',
            `invariant binding "${binding.key}" generation field "${generationFieldName}" must be declared integer-minor-units on every bound surface`,
          ),
        );
      }
    }
  }
  // ---- 7. Serialized sub-budget (canonical bytes). ----
  const serializedBytes = Buffer.byteLength(
    canonicalizeJson({
      version: raw['version'],
      setupStep: raw['setupStep'],
      declaredScope: raw['declaredScope'],
      scopeField: raw['scopeField'],
      generationField: raw['generationField'],
      subjects,
    }),
    'utf8',
  );
  if (serializedBytes > RUN_SCOPE_LIMITS.maxSerializedBytes) {
    issues.push(
      issue(
        'RUN_SCOPE_SERIALIZED_LIMIT',
        `runScope serializes to ${String(serializedBytes)} bytes; the canonical sub-budget is ${String(RUN_SCOPE_LIMITS.maxSerializedBytes)}`,
      ),
    );
  }
  if (issues.length > 0) {
    throw new RunScopeDefinitionError(issues);
  }
  void setupStepValid;
  void anchorFieldNames;
  return {
    version: RUN_SCOPE_VERSION,
    setupStep: setupStep as string,
    declaredScope: declaredScope as string,
    scopeField: raw['scopeField'] as string,
    generationField: raw['generationField'] as string,
    subjects: Object.freeze(
      Object.fromEntries(
        Object.entries(subjects)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, list]) => [key, Object.freeze([...list])]),
      ),
    ),
  };
}
