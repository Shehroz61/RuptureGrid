// =====================================================================
// RuptureGrid v1.1 Phase 15 — business-invariant/v1 definition registry
// (ADR-0018 + ADR-0023; roadmap Phase 15)
// =====================================================================
// The SINGLE authoritative registry for the closed generic invariant
// vocabulary. Exactly TWO kinds exist in v1:
//
//   atMostOneAcceptedEffect   (generalizes the INV-IZ-1 shape)
//   resourceConservation      (the corrected conservation model)
//
// An invariant INSTANCE is pure data (ADR-0018 Decision 1): a key, a
// kind from this closed registry, and typed params referencing ONLY
// declared roles/fields/queryIds of the target's FROZEN
// ManifestEvidencePolicy. This module is the definition-time validator
// against that frozen policy — the same fail-closed re-validation
// discipline as deriveExecutionPolicy/deriveEvidencePolicy. A
// definition that fails validation can never be frozen into a snapshot
// and never reaches evaluation (ADR-0023 §9).
//
// The registry is CLOSED: adding a kind requires a new ADR, new
// deterministic evaluators with truth-table tests, and an independent
// audit. No user code, no user SQL, no expressions, no JSONPath, no AI
// anywhere in evaluation. Unknown kinds/keys/versions are REJECTED
// with named issues — never guessed, never silently dropped.

import { canonicalizeJson } from './canonicalize.js';
import type { ManifestEvidencePolicy } from './manifest.js';
import type { ManifestFieldType } from '@rupturegrid/shared';

// ---------------------------------------------------------------------
// Frozen registry identity (§5 of the phase scope: ONE platform
// constant; registryVersion ≠ evaluatorVersion)
// ---------------------------------------------------------------------

/**
 * The definition protocol identity of the closed generic invariant
 * registry (ADR-0018). This is the REGISTRY version — the protocol a
 * params document is written against — and is deliberately distinct
 * from any evaluatorVersion (the implementation/evaluation semantic
 * version of one evaluator). They are never interchangeable.
 */
export const BUSINESS_INVARIANT_REGISTRY_VERSION = 'business-invariant/v1';

/** The exact registry version string accepted by this validator. */
export const ACCEPTED_REGISTRY_VERSIONS: readonly string[] = [BUSINESS_INVARIANT_REGISTRY_VERSION];

/** The closed v1 kind vocabulary (ADR-0018 Decision 2 — exactly two). */
export const BUSINESS_INVARIANT_KINDS = {
  atMostOneAcceptedEffect: 'atMostOneAcceptedEffect',
  resourceConservation: 'resourceConservation',
} as const;

export type BusinessInvariantKind =
  (typeof BUSINESS_INVARIANT_KINDS)[keyof typeof BUSINESS_INVARIANT_KINDS];

// ---------------------------------------------------------------------
// Params shapes (ADR-0023 §6 — EXACT; closed JSON objects)
// ---------------------------------------------------------------------

/** Accepted-effect selection: exactly one { field, value } pair. */
export interface InvariantAcceptedMatch {
  readonly field: string;
  readonly value: string | number | boolean;
}

/** Completeness mechanism: ONLY observed-total exists in v1 (§2). */
export interface InvariantCompletenessProof {
  readonly kind: 'observed-total';
  readonly queryId: string;
  readonly subjectField: string;
  readonly totalField: string;
}

/** REQUIRED scope binding (ADR-0023 §4): fields non-empty, generation optional. */
export interface InvariantScopeBinding {
  readonly fields: readonly string[];
  readonly generationField?: string;
}

export interface AtMostOneAcceptedEffectParams {
  readonly subjectRole: string;
  readonly subjectIdentityField: string;
  readonly effectRole: string;
  readonly effectIdentityField: string;
  readonly acceptedMatch: InvariantAcceptedMatch;
  readonly equivalenceFields: readonly string[];
  readonly maxAcceptedEffects: number;
  readonly completenessProof: InvariantCompletenessProof;
  readonly scopeBinding: InvariantScopeBinding;
}

export interface ResourceConservationParams {
  readonly resourceIdentityField: string;
  readonly baselineRole: string;
  readonly baselineUnitsField: string;
  readonly remainingRole: string;
  readonly remainingUnitsField: string;
  readonly consumptionEffectRole: string;
  readonly consumptionEffectIdentityField: string;
  readonly consumptionUnitsField: string;
  readonly consumptionAcceptedMatch: InvariantAcceptedMatch;
  readonly completenessProof: InvariantCompletenessProof;
  readonly scopeBinding: InvariantScopeBinding;
}

export type GenericInvariantParams = AtMostOneAcceptedEffectParams | ResourceConservationParams;

/** A parsed generic invariant instance (pure data; ADR-0018 Decision 1). */
export interface GenericInvariantInstance {
  readonly key: string;
  readonly kind: BusinessInvariantKind;
  readonly registryVersion: string;
  readonly params: GenericInvariantParams;
}

// ---------------------------------------------------------------------
// Deterministic named issues
// ---------------------------------------------------------------------

/** Every definition-time rejection carries a deterministic named issue. */
export interface DefinitionIssue {
  readonly code: string;
  readonly detail: string;
}

export class GenericInvariantDefinitionError extends Error {
  public readonly issues: readonly DefinitionIssue[];

  public constructor(issues: readonly DefinitionIssue[]) {
    super(
      issues.length === 1
        ? `invalid business-invariant/v1 definition (${issues[0]?.code}): ${issues[0]?.detail}`
        : `invalid business-invariant/v1 definition (${issues.length} issues): ${issues
            .map((issue) => `${issue.code}: ${issue.detail}`)
            .join('; ')}`,
    );
    this.name = 'GenericInvariantDefinitionError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------
// Validation internals
// ---------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Field names follow the manifest vocabulary (plain JSON keys). */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** Role/query identifiers follow the manifest identifier vocabulary. */
const IDENTIFIER_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
/** Bounded params-key vocabulary check helper (closed schema). */
const MAX_EQUIVALENCE_FIELDS = 32;
const MAX_SCOPE_FIELDS = 16;

function issue(code: string, detail: string): DefinitionIssue {
  return { code, detail };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A safe integer ≥ 0 (maxAcceptedEffects / totals / units vocabulary). */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)
    ? value >= 0
    : false;
}

/**
 * Declared-type compatibility for an acceptedMatch VALUE: a JSON
 * scalar whose primitive type matches the field's declared type —
 * no coercion ("ACCEPTED" is not true; 5 is not "5"; 1.5 is not an
 * integer). integer-minor-units is the vocabulary's ONLY integer
 * primitive: it accepts exactly safe integers (ADR-0023 §1 type
 * note — the NAME carries its R-06 money origin, the check is the
 * accepted safe-integer primitive; no monetary arithmetic is imposed
 * by the name).
 */
function scalarMatchesDeclaredType(value: unknown, declaredType: ManifestFieldType): boolean {
  switch (declaredType) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer-minor-units':
      return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value);
    case 'timestamp':
      return typeof value === 'string';
    default:
      return false; // Unknown declared type: fail closed.
  }
}

interface FieldRef {
  readonly name: string;
  readonly where: string;
  /** The role whose node fields must declare the field (when role-bound). */
  readonly role: string | null;
  /** The inspection query whose entity fields must declare it (when query-bound). */
  readonly queryId: string | null;
  /** Required declared primitive type ('any' = any declared type). */
  readonly requiredType: ManifestFieldType | 'any';
}

/**
 * Resolves the declared ManifestFieldType of a field on a role (via
 * the node fields) or on a query's entity schema. Returns undefined
 * when the role/query itself is undeclared (role/query checks are
 * reported separately) — the field check is then skipped to avoid
 * cascading duplicate issues.
 */
function declaredTypeOf(
  policy: ManifestEvidencePolicy,
  ref: FieldRef,
  issues: DefinitionIssue[],
): ManifestFieldType | undefined {
  if (ref.role !== null) {
    const node = policy.identityModel.nodes.find((n) => n.roleId === ref.role);
    if (node === undefined) {
      issues.push(issue('UNDECLARED_ROLE', `${ref.where}: role "${ref.role}" is not declared`));
      return undefined;
    }
    const declared = node.fields[ref.name];
    if (declared === undefined) {
      issues.push(
        issue(
          'FIELD_NOT_DECLARED_ON_ROLE',
          `${ref.where}: field "${ref.name}" is not declared on role "${ref.role}"`,
        ),
      );
      return undefined;
    }
    if (ref.requiredType !== 'any' && declared !== ref.requiredType) {
      issues.push(
        issue(
          'FIELD_TYPE_MISMATCH',
          `${ref.where}: field "${ref.name}" on role "${ref.role}" is declared ${declared}, requires ${ref.requiredType}`,
        ),
      );
      return undefined;
    }
    return declared;
  }
  if (ref.queryId !== null) {
    const query = policy.inspection.find((q) => q.queryId === ref.queryId);
    if (query === undefined) {
      issues.push(
        issue('UNDECLARED_QUERY_ID', `${ref.where}: queryId "${ref.queryId}" is not declared`),
      );
      return undefined;
    }
    const declared = query.fields[ref.name];
    if (declared === undefined) {
      issues.push(
        issue(
          'FIELD_NOT_DECLARED_ON_QUERY',
          `${ref.where}: field "${ref.name}" is not declared on query "${ref.queryId}"`,
        ),
      );
      return undefined;
    }
    if (ref.requiredType !== 'any' && declared !== ref.requiredType) {
      issues.push(
        issue(
          'FIELD_TYPE_MISMATCH',
          `${ref.where}: field "${ref.name}" on query "${ref.queryId}" is declared ${declared}, requires ${ref.requiredType}`,
        ),
      );
      return undefined;
    }
    return declared;
  }
  return undefined;
}

/**
 * Validates the EXACT closed shape of one completenessProof object
 * (unknown keys rejected; kind must be exactly "observed-total").
 */
function validateCompletenessProof(
  raw: unknown,
  where: string,
  issues: DefinitionIssue[],
): InvariantCompletenessProof | undefined {
  if (!isRecord(raw)) {
    issues.push(issue('MALFORMED_COMPLETENESS_PROOF', `${where} must be an object`));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!['kind', 'queryId', 'subjectField', 'totalField'].includes(key)) {
      issues.push(issue('UNKNOWN_COMPLETENESS_KEY', `${where}.${key} is an unknown key`));
    }
  }
  if (raw['kind'] !== 'observed-total') {
    issues.push(
      issue(
        'COMPLETENESS_KIND_NOT_OBSERVED_TOTAL',
        `${where}.kind must be exactly "observed-total" (the only v1 completeness mechanism); got ${JSON.stringify(raw['kind'] ?? null)}`,
      ),
    );
    return undefined;
  }
  if (typeof raw['queryId'] !== 'string' || !IDENTIFIER_PATTERN.test(raw['queryId'])) {
    issues.push(
      issue('MALFORMED_COMPLETENESS_PROOF', `${where}.queryId must be a declared query identifier`),
    );
    return undefined;
  }
  if (typeof raw['subjectField'] !== 'string' || !FIELD_NAME_PATTERN.test(raw['subjectField'])) {
    issues.push(
      issue('MALFORMED_COMPLETENESS_PROOF', `${where}.subjectField must be a declared field name`),
    );
    return undefined;
  }
  if (typeof raw['totalField'] !== 'string' || !FIELD_NAME_PATTERN.test(raw['totalField'])) {
    issues.push(
      issue('MALFORMED_COMPLETENESS_PROOF', `${where}.totalField must be a declared field name`),
    );
    return undefined;
  }
  return {
    kind: 'observed-total',
    queryId: raw['queryId'],
    subjectField: raw['subjectField'],
    totalField: raw['totalField'],
  };
}

/**
 * Validates the EXACT closed shape of one scopeBinding object
 * (REQUIRED per ADR-0023 §4; fields non-empty; generation optional).
 */
function validateScopeBinding(
  raw: unknown,
  issues: DefinitionIssue[],
): InvariantScopeBinding | undefined {
  const where = 'params.scopeBinding';
  if (!isRecord(raw)) {
    issues.push(
      issue('MALFORMED_SCOPE_BINDING', `${where} must be an object (scopeBinding is REQUIRED)`),
    );
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!['fields', 'generationField'].includes(key)) {
      issues.push(issue('UNKNOWN_SCOPE_BINDING_KEY', `${where}.${key} is an unknown key`));
    }
  }
  const rawFields = raw['fields'];
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    issues.push(issue('EMPTY_SCOPE_FIELDS', `${where}.fields must be a non-empty array`));
    return undefined;
  }
  if (rawFields.length > MAX_SCOPE_FIELDS) {
    issues.push(issue('SCOPE_FIELDS_LIMIT', `${where}.fields exceeds ${MAX_SCOPE_FIELDS}`));
  }
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawFields) {
    if (typeof entry !== 'string' || !FIELD_NAME_PATTERN.test(entry)) {
      issues.push(
        issue('MALFORMED_SCOPE_BINDING', `${where}.fields entries must be declared field names`),
      );
      continue;
    }
    if (seen.has(entry)) {
      issues.push(issue('DUPLICATE_SCOPE_FIELD', `${where}.fields duplicates "${entry}"`));
      continue;
    }
    seen.add(entry);
    fields.push(entry);
  }
  let generationField: string | undefined;
  const rawGeneration = raw['generationField'];
  if (rawGeneration !== undefined) {
    if (typeof rawGeneration !== 'string' || !FIELD_NAME_PATTERN.test(rawGeneration)) {
      issues.push(
        issue('INVALID_GENERATION_FIELD', `${where}.generationField must be a declared field name`),
      );
    } else {
      generationField = rawGeneration;
    }
  }
  if (fields.length === 0) {
    return undefined;
  }
  return generationField === undefined ? { fields } : { fields, generationField };
}

/** Exact closed shape of one acceptedMatch object. */
function validateAcceptedMatch(
  raw: unknown,
  where: string,
  issues: DefinitionIssue[],
): InvariantAcceptedMatch | undefined {
  if (!isRecord(raw)) {
    issues.push(issue('MALFORMED_ACCEPTED_MATCH', `${where} must be an object`));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!['field', 'value'].includes(key)) {
      issues.push(issue('UNKNOWN_ACCEPTED_MATCH_KEY', `${where}.${key} is an unknown key`));
    }
  }
  if (typeof raw['field'] !== 'string' || !FIELD_NAME_PATTERN.test(raw['field'])) {
    issues.push(issue('MALFORMED_ACCEPTED_MATCH', `${where}.field must be a declared field name`));
    return undefined;
  }
  if (!isScalar(raw['value'])) {
    issues.push(issue('MALFORMED_ACCEPTED_MATCH', `${where}.value must be a JSON scalar`));
    return undefined;
  }
  return { field: raw['field'], value: raw['value'] };
}

/** The exact params key sets (ADR-0023 §6). Unknown keys are rejections. */
const AT_MOST_ONE_KEYS: readonly string[] = [
  'subjectRole',
  'subjectIdentityField',
  'effectRole',
  'effectIdentityField',
  'acceptedMatch',
  'equivalenceFields',
  'maxAcceptedEffects',
  'completenessProof',
  'scopeBinding',
];
const RESOURCE_CONSERVATION_KEYS: readonly string[] = [
  'resourceIdentityField',
  'baselineRole',
  'baselineUnitsField',
  'remainingRole',
  'remainingUnitsField',
  'consumptionEffectRole',
  'consumptionEffectIdentityField',
  'consumptionUnitsField',
  'consumptionAcceptedMatch',
  'completenessProof',
  'scopeBinding',
];

/** The forbidden overlap set for an acceptance match field (ADR-0023 §6). */
function forbiddenMatchFieldNames(params: Record<string, unknown>): Set<string> {
  const forbidden = new Set<string>();
  const addAll = (values: unknown): void => {
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === 'string') {
          forbidden.add(value);
        }
      }
    }
  };
  addAll(params['equivalenceFields']);
  const identityCandidates = [
    'subjectIdentityField',
    'effectIdentityField',
    'resourceIdentityField',
    'consumptionEffectIdentityField',
  ];
  for (const key of identityCandidates) {
    const value = params[key];
    if (typeof value === 'string') {
      forbidden.add(value);
    }
  }
  addAll(
    isRecord(params['scopeBinding'])
      ? (params['scopeBinding'] as Record<string, unknown>)['fields']
      : [],
  );
  const scopeGeneration = isRecord(params['scopeBinding'])
    ? (params['scopeBinding'] as Record<string, unknown>)['generationField']
    : undefined;
  if (typeof scopeGeneration === 'string') {
    forbidden.add(scopeGeneration);
  }
  const completeness = isRecord(params['completenessProof'])
    ? (params['completenessProof'] as Record<string, unknown>)
    : undefined;
  if (completeness !== undefined) {
    if (typeof completeness['totalField'] === 'string') {
      forbidden.add(completeness['totalField']);
    }
    if (typeof completeness['subjectField'] === 'string') {
      forbidden.add(completeness['subjectField']);
    }
  }
  const unitsFields = ['baselineUnitsField', 'remainingUnitsField', 'consumptionUnitsField'];
  for (const key of unitsFields) {
    const value = params[key];
    if (typeof value === 'string') {
      forbidden.add(value);
    }
  }
  return forbidden;
}

// ---------------------------------------------------------------------
// The definition validator
// ---------------------------------------------------------------------

/**
 * Validates one raw generic invariant instance against the FROZEN
 * ManifestEvidencePolicy. Collects EVERY issue (fail closed — nothing
 * is fixed up or partially accepted) and throws
 * GenericInvariantDefinitionError on any issue. Returns the parsed
 * instance with its exact closed params.
 *
 * Checks include at least: unknown registry version; unknown kind;
 * unknown top-level/params/nested keys; missing required params; wrong
 * primitive JSON shapes; undeclared roles/queryIds/fields; fields
 * referenced on the wrong role/query; type mismatches across bindings;
 * empty/duplicate scope fields; invalid generation fields; empty/
 * duplicate equivalence fields; equivalence fields absent on
 * subject/effect or type-mismatched; identity fields absent; summary
 * fields absent; non-integer total/units fields; maxAcceptedEffects
 * negative/float/unsafe; acceptedMatch absent or type-incompatible;
 * acceptance fields overlapping forbidden roles (ADR-0023 §6);
 * malformed completenessProof; completeness kind ≠ observed-total.
 */
export function validateGenericInvariantDefinition(
  raw: unknown,
  policy: ManifestEvidencePolicy,
): GenericInvariantInstance {
  const issues: DefinitionIssue[] = [];

  // ---- Top-level shape: exactly { key, kind, params, registryVersion? } ----
  if (!isRecord(raw)) {
    throw new GenericInvariantDefinitionError([
      issue('NOT_AN_OBJECT', 'an invariant instance must be a JSON object'),
    ]);
  }
  for (const key of Object.keys(raw)) {
    if (!['key', 'kind', 'params', 'registryVersion'].includes(key)) {
      issues.push(issue('UNKNOWN_TOP_LEVEL_KEY', `"${key}" is an unknown top-level key`));
    }
  }
  if (typeof raw['key'] !== 'string' || raw['key'].length === 0 || raw['key'].length > 80) {
    issues.push(issue('MALFORMED_KEY', 'key must be a non-empty string of at most 80 characters'));
  }
  const registryVersion =
    raw['registryVersion'] === undefined
      ? BUSINESS_INVARIANT_REGISTRY_VERSION
      : raw['registryVersion'];
  if (
    typeof registryVersion !== 'string' ||
    !(ACCEPTED_REGISTRY_VERSIONS as readonly string[]).includes(registryVersion)
  ) {
    issues.push(
      issue(
        'UNKNOWN_REGISTRY_VERSION',
        `registryVersion must be exactly "${BUSINESS_INVARIANT_REGISTRY_VERSION}" (got ${JSON.stringify(registryVersion ?? null)}); unknown versions are refused, never guessed`,
      ),
    );
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    issues.push(issue('MALFORMED_KIND', 'kind must be a string'));
  } else if (!Object.values(BUSINESS_INVARIANT_KINDS).includes(kind as BusinessInvariantKind)) {
    issues.push(
      issue(
        'UNKNOWN_INVARIANT_KIND',
        `kind "${kind}" is not in the closed business-invariant/v1 vocabulary (${Object.values(BUSINESS_INVARIANT_KINDS).join(' | ')}); no third kind exists`,
      ),
    );
  }
  if (!isRecord(raw['params'])) {
    issues.push(issue('MALFORMED_PARAMS', 'params must be an object'));
    throw new GenericInvariantDefinitionError(issues);
  }
  const rawParams = raw['params'] as Record<string, unknown>;

  // ---- Kind-specific EXACT closed shapes ----
  let params: GenericInvariantParams | undefined;
  if (kind === BUSINESS_INVARIANT_KINDS.atMostOneAcceptedEffect) {
    params = validateAtMostOneParams(rawParams, policy, issues);
  } else if (kind === BUSINESS_INVARIANT_KINDS.resourceConservation) {
    params = validateResourceConservationParams(rawParams, policy, issues);
  } else if (typeof kind === 'string') {
    // Unknown kind: reject unknown params keys generically so a wrong
    // kind can never smuggle arbitrary data past validation.
    for (const key of Object.keys(rawParams)) {
      issues.push(
        issue(
          'UNKNOWN_PARAMS_KEY',
          `params.${key} is an unknown params key (kind "${kind}" is not in the closed registry)`,
        ),
      );
    }
  }

  if (issues.length > 0) {
    throw new GenericInvariantDefinitionError(issues);
  }
  if (params === undefined) {
    throw new GenericInvariantDefinitionError([issue('UNVALIDATED', 'params did not validate')]);
  }
  return {
    key: raw['key'] as string,
    kind: kind as BusinessInvariantKind,
    registryVersion: registryVersion as string,
    params,
  };
}

/** One shared role/field/query cross-check with deterministic issue names. */
function requireRole(
  rawParams: Record<string, unknown>,
  key: string,
  policy: ManifestEvidencePolicy,
  issues: DefinitionIssue[],
): string | undefined {
  const value = rawParams[key];
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    issues.push(issue('MALFORMED_ROLE', `params.${key} must be a declared role id`));
    return undefined;
  }
  if (!policy.identityModel.nodes.some((node) => node.roleId === value)) {
    issues.push(
      issue('UNDECLARED_ROLE', `params.${key} "${value}" is not a declared identityModel role`),
    );
    return undefined;
  }
  return value;
}

function requireFieldOnRole(
  rawParams: Record<string, unknown>,
  key: string,
  role: string | undefined,
  policy: ManifestEvidencePolicy,
  issues: DefinitionIssue[],
  requiredType: ManifestFieldType | 'any',
): string | undefined {
  const value = rawParams[key];
  if (typeof value !== 'string' || !FIELD_NAME_PATTERN.test(value)) {
    issues.push(issue('MALFORMED_FIELD', `params.${key} must be a declared field name`));
    return undefined;
  }
  if (role === undefined) {
    return undefined; // Role issue already recorded; no cascade.
  }
  declaredTypeOf(
    policy,
    { name: value, where: `params.${key}`, role, queryId: null, requiredType },
    issues,
  );
  return value;
}

function validateAtMostOneParams(
  rawParams: Record<string, unknown>,
  policy: ManifestEvidencePolicy,
  issues: DefinitionIssue[],
): AtMostOneAcceptedEffectParams | undefined {
  for (const key of Object.keys(rawParams)) {
    if (!AT_MOST_ONE_KEYS.includes(key)) {
      issues.push(issue('UNKNOWN_PARAMS_KEY', `params.${key} is an unknown params key`));
    }
  }
  const subjectRole = requireRole(rawParams, 'subjectRole', policy, issues);
  const effectRole = requireRole(rawParams, 'effectRole', policy, issues);
  const subjectIdentityField = requireFieldOnRole(
    rawParams,
    'subjectIdentityField',
    subjectRole,
    policy,
    issues,
    'any',
  );
  const effectIdentityField = requireFieldOnRole(
    rawParams,
    'effectIdentityField',
    effectRole,
    policy,
    issues,
    'any',
  );

  // ---- acceptedMatch: exact shape + declared field + value type ----
  const matchWhere = 'params.acceptedMatch';
  const acceptedMatch = validateAcceptedMatch(rawParams['acceptedMatch'], matchWhere, issues);
  if (acceptedMatch !== undefined && effectRole !== undefined) {
    declaredTypeOf(
      policy,
      {
        name: acceptedMatch.field,
        where: `${matchWhere}.field`,
        role: effectRole,
        queryId: null,
        requiredType: 'any',
      },
      issues,
    );
    const declared = policy.identityModel.nodes.find((node) => node.roleId === effectRole)?.fields[
      acceptedMatch.field
    ];
    if (declared !== undefined && !scalarMatchesDeclaredType(acceptedMatch.value, declared)) {
      issues.push(
        issue(
          'ACCEPTED_MATCH_VALUE_TYPE_MISMATCH',
          `${matchWhere}.value ${JSON.stringify(acceptedMatch.value)} is incompatible with the declared type ${declared} of field "${acceptedMatch.field}" on role "${effectRole}" (no coercion)`,
        ),
      );
    }
  }

  // ---- equivalenceFields: 1..N distinct, declared on BOTH roles ----
  const rawEquivalence = rawParams['equivalenceFields'];
  const equivalenceFields: string[] = [];
  if (!Array.isArray(rawEquivalence) || rawEquivalence.length === 0) {
    issues.push(
      issue('EMPTY_EQUIVALENCE_FIELDS', 'params.equivalenceFields must be a non-empty array'),
    );
  } else {
    if (rawEquivalence.length > MAX_EQUIVALENCE_FIELDS) {
      issues.push(
        issue(
          'EQUIVALENCE_FIELDS_LIMIT',
          `params.equivalenceFields exceeds ${MAX_EQUIVALENCE_FIELDS}`,
        ),
      );
    }
    const seen = new Set<string>();
    for (const entry of rawEquivalence) {
      if (typeof entry !== 'string' || !FIELD_NAME_PATTERN.test(entry)) {
        issues.push(
          issue('MALFORMED_FIELD', 'params.equivalenceFields entries must be declared field names'),
        );
        continue;
      }
      if (seen.has(entry)) {
        issues.push(
          issue('DUPLICATE_EQUIVALENCE_FIELD', `params.equivalenceFields duplicates "${entry}"`),
        );
        continue;
      }
      seen.add(entry);
      equivalenceFields.push(entry);
    }
    for (const field of equivalenceFields) {
      if (subjectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: field,
            where: `params.equivalenceFields`,
            role: subjectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
      if (effectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: field,
            where: `params.equivalenceFields`,
            role: effectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
    }
    // ---- Type equality across bindings: every equivalence field must
    // carry the SAME declared primitive type on subject and effect
    // roles (exact-equality equivalence is meaningless across types).
    if (subjectRole !== undefined && effectRole !== undefined) {
      const subjectNode = policy.identityModel.nodes.find((node) => node.roleId === subjectRole);
      const effectNode = policy.identityModel.nodes.find((node) => node.roleId === effectRole);
      for (const field of equivalenceFields) {
        const subjectType = subjectNode?.fields[field];
        const effectType = effectNode?.fields[field];
        if (subjectType !== undefined && effectType !== undefined && subjectType !== effectType) {
          issues.push(
            issue(
              'EQUIVALENCE_FIELD_TYPE_MISMATCH',
              `params.equivalenceFields names "${field}", declared ${subjectType} on "${subjectRole}" but ${effectType} on "${effectRole}" (exact-equality equivalence requires the same type on both)`,
            ),
          );
        }
      }
      // The equivalence tuple must include the subject identity itself
      // when the identity field is declared on the effect role
      // (INV-CHK-1's tuple includes the intent identity; generalization
      // keeps the effect→subject join expressible). ADR-0023 leaves the
      // exact tuple to the target, so no membership requirement is
      // imposed beyond declaration on both roles.
    }
  }

  // ---- maxAcceptedEffects: safe integer ≥ 0 (no float, no unsafe) ----
  const maxAcceptedEffects = rawParams['maxAcceptedEffects'];
  if (!isNonNegativeSafeInteger(maxAcceptedEffects)) {
    if (typeof maxAcceptedEffects === 'number' && Number.isInteger(maxAcceptedEffects)) {
      issues.push(
        issue(
          'MAX_ACCEPTED_EFFECTS_NEGATIVE_OR_UNSAFE',
          'params.maxAcceptedEffects must be a non-negative safe integer',
        ),
      );
    } else {
      issues.push(
        issue(
          'MAX_ACCEPTED_EFFECTS_NOT_INTEGER',
          'params.maxAcceptedEffects must be an integer (no float, no numeric string, no unsafe value)',
        ),
      );
    }
  }

  // ---- completenessProof + scopeBinding (exact closed shapes) ----
  const completenessProof = validateCompletenessProof(
    rawParams['completenessProof'],
    'params.completenessProof',
    issues,
  );
  const scopeBinding = validateScopeBinding(rawParams['scopeBinding'], issues);

  // ---- Cross-references: roles/fields must exist and be coherent ----
  if (completenessProof !== undefined) {
    // The completeness query must be declared; its subjectField must
    // exist on the query's entity schema; its totalField must be the
    // declared integer primitive.
    const query = policy.inspection.find((q) => q.queryId === completenessProof.queryId);
    if (query === undefined) {
      issues.push(
        issue(
          'UNDECLARED_QUERY_ID',
          `params.completenessProof.queryId "${completenessProof.queryId}" is not a declared inspection query`,
        ),
      );
    } else {
      declaredTypeOf(
        policy,
        {
          name: completenessProof.subjectField,
          where: 'params.completenessProof.subjectField',
          role: null,
          queryId: completenessProof.queryId,
          requiredType: 'any',
        },
        issues,
      );
      // The summary must be readable through a field carrying the SAME
      // declared type as the subject identity field (exact-equality
      // binding between summary and subject; ADR-0023 §6).
      const subjectNode =
        subjectRole === undefined
          ? undefined
          : policy.identityModel.nodes.find((node) => node.roleId === subjectRole);
      const summaryType = query.fields[completenessProof.subjectField];
      const subjectIdentityType =
        subjectNode === undefined ? undefined : subjectNode.fields[subjectIdentityField ?? ''];
      if (
        summaryType !== undefined &&
        subjectIdentityType !== undefined &&
        summaryType !== subjectIdentityType
      ) {
        issues.push(
          issue(
            'FIELD_TYPE_MISMATCH',
            `params.completenessProof.subjectField "${completenessProof.subjectField}" is declared ${summaryType} on query "${completenessProof.queryId}", but the subject identity field "${subjectIdentityField ?? ''}" is declared ${subjectIdentityType} (the summary is bound to the subject by exact equality of the same declared type)`,
          ),
        );
      }
      declaredTypeOf(
        policy,
        {
          name: completenessProof.totalField,
          where: 'params.completenessProof.totalField',
          role: null,
          queryId: completenessProof.queryId,
          requiredType: 'integer-minor-units',
        },
        issues,
      );
      // Scope fields must exist on the completeness query surface too.
      if (scopeBinding !== undefined) {
        for (const field of scopeBinding.fields) {
          declaredTypeOf(
            policy,
            {
              name: field,
              where: 'params.scopeBinding.fields (completeness query)',
              role: null,
              queryId: completenessProof.queryId,
              requiredType: 'any',
            },
            issues,
          );
        }
        if (scopeBinding.generationField !== undefined) {
          declaredTypeOf(
            policy,
            {
              name: scopeBinding.generationField,
              where: 'params.scopeBinding.generationField (completeness query)',
              role: null,
              queryId: completenessProof.queryId,
              requiredType: 'any',
            },
            issues,
          );
        }
      }
    }
  }
  if (scopeBinding !== undefined) {
    for (const field of scopeBinding.fields) {
      if (subjectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: field,
            where: 'params.scopeBinding.fields (subject)',
            role: subjectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
      if (effectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: field,
            where: 'params.scopeBinding.fields (effect)',
            role: effectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
    }
    if (scopeBinding.generationField !== undefined) {
      if (subjectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: scopeBinding.generationField,
            where: 'params.scopeBinding.generationField (subject)',
            role: subjectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
      if (effectRole !== undefined) {
        declaredTypeOf(
          policy,
          {
            name: scopeBinding.generationField,
            where: 'params.scopeBinding.generationField (effect)',
            role: effectRole,
            queryId: null,
            requiredType: 'any',
          },
          issues,
        );
      }
    }
  }

  // ---- AcceptedMatch overlap: the match field MUST NOT be any
  // identity, equivalence, scope, generation, or total field (ADR-0023 §6).
  if (acceptedMatch !== undefined) {
    const forbidden = forbiddenMatchFieldNames(rawParams);
    if (forbidden.has(acceptedMatch.field)) {
      issues.push(
        issue(
          'ACCEPTED_MATCH_OVERLAPS_FORBIDDEN_ROLE',
          `params.acceptedMatch.field "${acceptedMatch.field}" overlaps an identity/equivalence/scope/generation/summary/total field (ADR-0023: the acceptance match must select on a distinct field)`,
        ),
      );
    }
  }

  if (issues.length > 0) {
    return undefined;
  }
  return {
    subjectRole: subjectRole as string,
    subjectIdentityField: subjectIdentityField as string,
    effectRole: effectRole as string,
    effectIdentityField: effectIdentityField as string,
    acceptedMatch: acceptedMatch as InvariantAcceptedMatch,
    equivalenceFields,
    maxAcceptedEffects: maxAcceptedEffects as number,
    completenessProof: completenessProof as InvariantCompletenessProof,
    scopeBinding: scopeBinding as InvariantScopeBinding,
  };
}

function validateResourceConservationParams(
  rawParams: Record<string, unknown>,
  policy: ManifestEvidencePolicy,
  issues: DefinitionIssue[],
): ResourceConservationParams | undefined {
  for (const key of Object.keys(rawParams)) {
    if (!RESOURCE_CONSERVATION_KEYS.includes(key)) {
      issues.push(issue('UNKNOWN_PARAMS_KEY', `params.${key} is an unknown params key`));
    }
  }
  const baselineRole = requireRole(rawParams, 'baselineRole', policy, issues);
  const remainingRole = requireRole(rawParams, 'remainingRole', policy, issues);
  const consumptionEffectRole = requireRole(rawParams, 'consumptionEffectRole', policy, issues);
  const resourceIdentityField = requireFieldOnRole(
    rawParams,
    'resourceIdentityField',
    baselineRole,
    policy,
    issues,
    'any',
  );
  // The resource identity must be declared on the consumption effect
  // role too — each counted reservation carries it (ADR-0023 §7).
  if (resourceIdentityField !== undefined && consumptionEffectRole !== undefined) {
    declaredTypeOf(
      policy,
      {
        name: resourceIdentityField,
        where: 'params.resourceIdentityField (consumption role)',
        role: consumptionEffectRole,
        queryId: null,
        requiredType: 'any',
      },
      issues,
    );
  }
  const baselineUnitsField = requireFieldOnRole(
    rawParams,
    'baselineUnitsField',
    baselineRole,
    policy,
    issues,
    'integer-minor-units',
  );
  const remainingUnitsField = requireFieldOnRole(
    rawParams,
    'remainingUnitsField',
    remainingRole,
    policy,
    issues,
    'integer-minor-units',
  );
  const consumptionEffectIdentityField = requireFieldOnRole(
    rawParams,
    'consumptionEffectIdentityField',
    consumptionEffectRole,
    policy,
    issues,
    'any',
  );
  const consumptionUnitsField = requireFieldOnRole(
    rawParams,
    'consumptionUnitsField',
    consumptionEffectRole,
    policy,
    issues,
    'integer-minor-units',
  );

  const matchWhere = 'params.consumptionAcceptedMatch';
  const acceptedMatch = validateAcceptedMatch(
    rawParams['consumptionAcceptedMatch'],
    matchWhere,
    issues,
  );
  if (acceptedMatch !== undefined && consumptionEffectRole !== undefined) {
    declaredTypeOf(
      policy,
      {
        name: acceptedMatch.field,
        where: `${matchWhere}.field`,
        role: consumptionEffectRole,
        queryId: null,
        requiredType: 'any',
      },
      issues,
    );
    const declared = policy.identityModel.nodes.find(
      (node) => node.roleId === consumptionEffectRole,
    )?.fields[acceptedMatch.field];
    if (declared !== undefined && !scalarMatchesDeclaredType(acceptedMatch.value, declared)) {
      issues.push(
        issue(
          'ACCEPTED_MATCH_VALUE_TYPE_MISMATCH',
          `${matchWhere}.value ${JSON.stringify(acceptedMatch.value)} is incompatible with the declared type ${declared} of field "${acceptedMatch.field}" on role "${consumptionEffectRole}" (no coercion)`,
        ),
      );
    }
  }

  const completenessProof = validateCompletenessProof(
    rawParams['completenessProof'],
    'params.completenessProof',
    issues,
  );
  const scopeBinding = validateScopeBinding(rawParams['scopeBinding'], issues);

  // ---- Cross-references ----
  if (completenessProof !== undefined) {
    const query = policy.inspection.find((q) => q.queryId === completenessProof.queryId);
    if (query === undefined) {
      issues.push(
        issue(
          'UNDECLARED_QUERY_ID',
          `params.completenessProof.queryId "${completenessProof.queryId}" is not a declared inspection query`,
        ),
      );
    } else {
      // The summary subjectField must be readable with the SAME
      // declared type as the resource identity (exact-equality binding;
      // the summary field NAME may differ and is what the summary is
      // read through — ADR-0023 §6).
      const summaryType = query.fields[completenessProof.subjectField];
      const resourceNode =
        baselineRole === undefined
          ? undefined
          : policy.identityModel.nodes.find((node) => node.roleId === baselineRole);
      const resourceType =
        resourceNode === undefined ? undefined : resourceNode.fields[resourceIdentityField ?? ''];
      if (summaryType !== undefined && resourceType !== undefined && summaryType !== resourceType) {
        issues.push(
          issue(
            'FIELD_TYPE_MISMATCH',
            `params.completenessProof.subjectField "${completenessProof.subjectField}" is declared ${summaryType} on query "${completenessProof.queryId}", but the resource identity field "${resourceIdentityField ?? ''}" is declared ${resourceType}`,
          ),
        );
      }
      declaredTypeOf(
        policy,
        {
          name: completenessProof.totalField,
          where: 'params.completenessProof.totalField',
          role: null,
          queryId: completenessProof.queryId,
          requiredType: 'integer-minor-units',
        },
        issues,
      );
      if (scopeBinding !== undefined) {
        for (const field of scopeBinding.fields) {
          declaredTypeOf(
            policy,
            {
              name: field,
              where: 'params.scopeBinding.fields (completeness query)',
              role: null,
              queryId: completenessProof.queryId,
              requiredType: 'any',
            },
            issues,
          );
        }
        if (scopeBinding.generationField !== undefined) {
          declaredTypeOf(
            policy,
            {
              name: scopeBinding.generationField,
              where: 'params.scopeBinding.generationField (completeness query)',
              role: null,
              queryId: completenessProof.queryId,
              requiredType: 'any',
            },
            issues,
          );
        }
      }
    }
  }
  if (scopeBinding !== undefined) {
    for (const field of scopeBinding.fields) {
      for (const [roleName, role] of [
        ['baseline', baselineRole],
        ['remaining', remainingRole],
        ['consumption', consumptionEffectRole],
      ] as const) {
        if (role !== undefined) {
          declaredTypeOf(
            policy,
            {
              name: field,
              where: `params.scopeBinding.fields (${roleName})`,
              role,
              queryId: null,
              requiredType: 'any',
            },
            issues,
          );
        }
      }
    }
    if (scopeBinding.generationField !== undefined) {
      for (const role of [baselineRole, remainingRole, consumptionEffectRole]) {
        if (role !== undefined) {
          declaredTypeOf(
            policy,
            {
              name: scopeBinding.generationField,
              where: 'params.scopeBinding.generationField',
              role,
              queryId: null,
              requiredType: 'any',
            },
            issues,
          );
        }
      }
    }
  }
  if (acceptedMatch !== undefined) {
    const forbidden = forbiddenMatchFieldNames(rawParams);
    if (forbidden.has(acceptedMatch.field)) {
      issues.push(
        issue(
          'ACCEPTED_MATCH_OVERLAPS_FORBIDDEN_ROLE',
          `params.consumptionAcceptedMatch.field "${acceptedMatch.field}" overlaps an identity/equivalence/scope/generation/summary/total/units field (ADR-0023: the acceptance match must select on a distinct field)`,
        ),
      );
    }
  }

  // All required fields must have resolved for the params to be valid.
  if (
    issues.length > 0 ||
    baselineRole === undefined ||
    remainingRole === undefined ||
    consumptionEffectRole === undefined ||
    resourceIdentityField === undefined ||
    baselineUnitsField === undefined ||
    remainingUnitsField === undefined ||
    consumptionEffectIdentityField === undefined ||
    consumptionUnitsField === undefined ||
    acceptedMatch === undefined ||
    completenessProof === undefined ||
    scopeBinding === undefined
  ) {
    return undefined;
  }
  return {
    resourceIdentityField,
    baselineRole,
    baselineUnitsField,
    remainingRole,
    remainingUnitsField,
    consumptionEffectRole,
    consumptionEffectIdentityField,
    consumptionUnitsField,
    consumptionAcceptedMatch: acceptedMatch,
    completenessProof,
    scopeBinding,
  };
}

// ---------------------------------------------------------------------
// ALL-OR-NONE generic metadata (ADR-0023 §6/§11)
// ---------------------------------------------------------------------

/**
 * Validates the ALL-OR-NONE generic-metadata triple on a durable
 * InvariantDefinition row (or any other generic-metadata carrier):
 *   - GENERIC: kind + registryVersion + paramsJson ALL non-null;
 *   - LEGACY:  all three null (semantics untouched, never reinterpreted);
 *   - a partial hybrid is INVALID — a definition/persistence-time
 *     rejection (ADR-0023: "no partial hybrid").
 * Returns the parsed and policy-validated instance for a generic
 * carrier, or null for a legacy carrier. Throws on invalid metadata.
 */
export function parseGenericMetadataTriple(
  carrier: {
    readonly kind: string | null;
    readonly registryVersion: string | null;
    readonly paramsJson: unknown;
  },
  policy: ManifestEvidencePolicy,
): GenericInvariantInstance | null {
  const present = [
    carrier.kind !== null,
    carrier.registryVersion !== null,
    carrier.paramsJson !== null,
  ];
  if (present.every((value) => !value)) {
    return null; // Legacy row: valid, semantics untouched.
  }
  if (!present.every((value) => value)) {
    throw new GenericInvariantDefinitionError([
      issue(
        'PARTIAL_GENERIC_METADATA',
        'generic invariant metadata is ALL-OR-NONE: kind, registryVersion, and paramsJson must be together non-null (generic) or together null (legacy); a partial hybrid is invalid (ADR-0023 §6)',
      ),
    ]);
  }
  return validateGenericInvariantDefinition(
    {
      key: '<carrier>',
      kind: carrier.kind,
      registryVersion: carrier.registryVersion,
      params: carrier.paramsJson,
    },
    policy,
  );
}

/** Canonical JSON of the frozen instance params (hash input discipline). */
export function canonicalInstanceParamsJson(instance: GenericInvariantInstance): string {
  return canonicalizeJson({
    key: instance.key,
    kind: instance.kind,
    registryVersion: instance.registryVersion,
    params: instance.params,
  });
}

// ---------------------------------------------------------------------
// Freeze-time binding derivation (ADR-0023 §9/§11)
// ---------------------------------------------------------------------

/**
 * A Phase 15 experiment-document invariant binding (pure data). The
 * document's top-level `invariantBindings` block is additive and
 * OPTIONAL: legacy documents carry none, and a manifest-less target
 * can never declare one (generic instances reference declared
 * roles/fields of a frozen evidence policy — with no policy there is
 * nothing to reference).
 */
export interface ExperimentInvariantBinding {
  readonly key: string;
  readonly kind: string;
  readonly params: unknown;
  readonly registryVersion?: unknown;
}

/**
 * Validates every declared generic invariant binding against the
 * target's frozen ManifestEvidencePolicy and returns the frozen
 * instances, deterministically ordered by key (ADR-0023 §9: a
 * definition that fails validation is never frozen and never reaches
 * evaluation; duplicate keys are rejections — never a silent
 * overwrite).
 *
 * The manifest stays frozen (§1): this validates against the policy
 * the manifest ALREADY declares — no new manifest field, no new
 * version.
 */
export function deriveGenericInvariantBindings(
  rawBindings: unknown,
  policy: ManifestEvidencePolicy,
): readonly GenericInvariantInstance[] {
  if (rawBindings === undefined || rawBindings === null) {
    return []; // Legacy document: no generic bindings.
  }
  if (!Array.isArray(rawBindings)) {
    throw new GenericInvariantDefinitionError([
      issue(
        'MALFORMED_INVARIANT_BINDINGS',
        'invariantBindings must be an array of instance definitions',
      ),
    ]);
  }
  const instances: GenericInvariantInstance[] = [];
  const seenKeys = new Set<string>();
  for (const binding of rawBindings as unknown[]) {
    const instance = validateGenericInvariantDefinition(binding, policy);
    if (instance.registryVersion !== BUSINESS_INVARIANT_REGISTRY_VERSION) {
      throw new GenericInvariantDefinitionError([
        issue(
          'UNKNOWN_REGISTRY_VERSION',
          `invariant binding ${instance.key} carries registry version ${instance.registryVersion}; only ${BUSINESS_INVARIANT_REGISTRY_VERSION} is accepted`,
        ),
      ]);
    }
    if (seenKeys.has(instance.key)) {
      throw new GenericInvariantDefinitionError([
        issue(
          'DUPLICATE_INVARIANT_KEY',
          `invariantBindings duplicates instance key "${instance.key}"`,
        ),
      ]);
    }
    seenKeys.add(instance.key);
    instances.push(instance);
  }
  return [...instances].sort((a, b) => (a.key < b.key ? -1 : 1));
}
