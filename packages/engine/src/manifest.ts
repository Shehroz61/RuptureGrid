// =====================================================================
// RuptureGrid v1.1 Phase 13 — target-manifest/v1 (ADR-0016, ADR-0017)
// =====================================================================
// The SINGLE authoritative validation boundary for target manifests.
// Registration, snapshot freezing, and definition-time policy all
// derive from the functions in this file — ad-hoc manifest checks are
// forbidden elsewhere (Phase 13 scope: one closed-schema boundary).
//
// The manifest is CLOSED, VERSIONED, and DATA-ONLY (ADR-0016 §2):
//   - unknown versions are REJECTED, never guessed;
//   - unknown fields are REJECTED at every nesting level (recursive
//     closure — not merely top-level);
//   - no executable content exists anywhere in the model: no code, no
//     expressions, no SQL, no eval-like strings. Every string field is
//     a bounded identifier, bounded description, header name, or
//     relative path validated below;
//   - nothing is silently dropped, coerced, deduplicated, or guessed:
//     an invalid manifest is rejected explicitly with every issue named.
//
// Truth boundary (ADR-0016 §5): target-declared contract metadata
// (e.g. noEffectOnRejection) is PROVENANCE about what the target claims
// about its own responses. It is recorded and frozen so the
// classification basis of every invocation is auditable — it NEVER
// feeds classification. RuptureGrid truth (KNOWN_ABSENT / INDETERMINATE)
// is manufactured only by the platform-defined mechanisms of §7.1.
//
// Server-side limits (security-boundaries §8 discipline) come from
// MANIFEST_LIMITS in @rupturegrid/shared: they bound the NETWORK
// PAYLOAD a registrant may submit. They are resource/security caps,
// NOT claims that valid identity models have at most that many nodes
// (ADR-0017 deliberately fixes no conceptual chain length).

import {
  CONTROLLED_FAULT_KINDS,
  CONTROLLED_FAULT_PLAN_VERSION,
  MANIFEST_FIELD_TYPES,
  MANIFEST_LIMITS,
  TARGET_MANIFEST_ENVIRONMENTS,
  TARGET_MANIFEST_VERSION,
} from '@rupturegrid/shared';
import type { ControlledFaultKind, ManifestFieldType } from '@rupturegrid/shared';
import { CONTRACT_KINDS, normalizeOrigin } from './target.js';
import type { ContractKind } from './target.js';
import { validateRelativePath } from './validate.js';
import { EXECUTOR_CREDENTIAL_REFS } from '@rupturegrid/config';

/** The executor's server-side credential-reference allowlist (ADR-0012). */
const EXECUTOR_CREDENTIAL_REF_SET: ReadonlySet<string> = new Set(EXECUTOR_CREDENTIAL_REFS);

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class ManifestValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      issues.length === 1
        ? `invalid target manifest: ${issues[0]}`
        : `invalid target manifest (${issues.length} issues):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------
// The v1 manifest model (data-only; closed at every level)
// ---------------------------------------------------------------------

/**
 * Target-declared contract metadata (ADR-0016 Decision 5). PROVENANCE
 * ONLY — never RuptureGrid truth. Closed vocabulary: exactly
 * `noEffectOnRejection` in v1.
 */
export interface TargetManifestContractMetadata {
  readonly noEffectOnRejection?: boolean;
}

export interface ManifestIdentityNode {
  readonly roleId: string;
  readonly description: string;
  /** Declared typed fields carried by this node's events (exact names). */
  readonly fields: Readonly<Record<string, ManifestFieldType>>;
}

export interface ManifestCausalEdge {
  readonly fromRoleId: string;
  readonly toRoleId: string;
  /** Stable target-chosen identifier (e.g. `delivered-as`). */
  readonly edgeKind: string;
  /** Exact-equality linkage fields; ≥ 1 (edges without identity basis are rejected). */
  readonly linkFields: readonly string[];
}

export interface ManifestIdentityModel {
  readonly nodes: readonly ManifestIdentityNode[];
  readonly causalEdges: readonly ManifestCausalEdge[];
  /** Which declared node(s) are the counted business effects. */
  readonly effectRoleIds: readonly string[];
  /** Which declared node the logical business action hangs from. */
  readonly subjectRoleId?: string;
}

export interface ManifestInspectionQuery {
  /** Stable target-chosen query identifier (unique across queries). */
  readonly queryId: string;
  readonly description: string;
  /** Read-only relative path on the target's registered origins. */
  readonly path: string;
  /** Declared response entity schema: field name → declared primitive type. */
  readonly fields: Readonly<Record<string, ManifestFieldType>>;
  /** Which declared fields are identity fields (exact-equality join keys). */
  readonly identityFields: readonly string[];
}

/** The validated, normalized target-manifest/v1 document. */
export interface TargetManifest {
  readonly manifestVersion: typeof TARGET_MANIFEST_VERSION;
  readonly displayName: string;
  readonly environment: (typeof TARGET_MANIFEST_ENVIRONMENTS)[number];
  /** Normalized origins (`scheme://host[:port]`, lowercase host). */
  readonly origins: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly contract: {
    /** Platform-defined response-semantics class (§7.1 classification). */
    readonly kind: ContractKind;
    /** Target-declared metadata — provenance, never truth. */
    readonly metadata: TargetManifestContractMetadata;
  };
  readonly inspection: readonly ManifestInspectionQuery[];
  readonly identityModel: ManifestIdentityModel;
  readonly sensitiveFields: readonly string[];
  /** Lowercased declared signature header name, when declared. */
  readonly signatureHeader?: string;
  readonly faultHook?: {
    readonly version: typeof CONTROLLED_FAULT_PLAN_VERSION;
    readonly path: string;
    readonly kinds: readonly ControlledFaultKind[];
  };
}

// ---------------------------------------------------------------------
// Legacy (pre-manifest) policy seams — preserved unchanged for v1.0
// targets. A manifest-less registration keeps exactly the v1.0
// hard-coded behavior; a manifest-declaring target replaces these
// seams declaratively. The two modes never mix.
// ---------------------------------------------------------------------

/** The v1.0 hard-coded signature header (Demo provider contract). */
export const LEGACY_SIGNATURE_HEADER = 'x-rupturegrid-provider-signature';

/** The v1.0 hard-coded fault-gate delivery path (Demo webhook contract). */
export const LEGACY_DEMO_FAULT_HOOK_PATH = '/webhooks/provider';

/**
 * The manifest-derived execution policy frozen into run snapshots and
 * re-derived at definition time. Present on a snapshot only when the
 * target registered with a manifest (legacy snapshots are unchanged
 * byte-for-byte).
 */
export interface ManifestExecutionPolicy {
  readonly manifestVersion: string;
  /** Declared signature-header name, when declared. */
  readonly signatureHeader?: string;
  readonly faultHook?: {
    readonly path: string;
    readonly kinds: readonly ControlledFaultKind[];
  };
  /** Target-declared contract metadata (provenance; never classification input). */
  readonly contractMetadata: {
    readonly noEffectOnRejection: boolean;
  };
}

/**
 * The effective signature header for a target: the manifest-declared
 * name when a manifest declares one, the v1.0 legacy name for legacy
 * (manifest-less) targets, or null for a manifest target that declared
 * none (no signature seam exists for it).
 */
export function effectiveSignatureHeader(
  policy: ManifestExecutionPolicy | undefined,
): string | null {
  if (policy === undefined) {
    return LEGACY_SIGNATURE_HEADER;
  }
  return policy.signatureHeader ?? null;
}

export interface EffectiveFaultHook {
  readonly path: string;
  readonly kinds: readonly ControlledFaultKind[];
}

/**
 * The effective fault hook for a target. Legacy (manifest-less) Demo
 * targets keep the v1.0 hard-coded gate exactly (DEMO_FINTECH_WEBHOOK +
 * /webhooks/provider + the full closed kind vocabulary); legacy
 * GENERIC_HTTP targets have no hook at all. Manifest targets use ONLY
 * what they declared — a fault plan can never target a route or kind
 * the target did not declare (ADR-0016 §2 faultHook).
 */
export function effectiveFaultHook(
  policy: ManifestExecutionPolicy | undefined,
  contractKind: ContractKind,
): EffectiveFaultHook | null {
  if (policy === undefined) {
    return contractKind === 'DEMO_FINTECH_WEBHOOK'
      ? { path: LEGACY_DEMO_FAULT_HOOK_PATH, kinds: [...CONTROLLED_FAULT_KINDS] }
      : null;
  }
  return policy.faultHook ?? null;
}

/**
 * Derives the frozen execution policy from a stored manifest. The
 * manifest is RE-VALIDATED here (defense in depth — a stored manifest
 * that no longer validates can never silently become execution
 * policy); corruption fails closed. Returns undefined for a legacy
 * (manifest-less) registration.
 */
export function deriveExecutionPolicy(manifestJson: unknown): ManifestExecutionPolicy | undefined {
  if (manifestJson === null || manifestJson === undefined) {
    return undefined;
  }
  const manifest = validateTargetManifest(manifestJson);
  const policy: ManifestExecutionPolicy = {
    manifestVersion: manifest.manifestVersion,
    ...(manifest.signatureHeader === undefined
      ? {}
      : { signatureHeader: manifest.signatureHeader }),
    ...(manifest.faultHook === undefined
      ? {}
      : {
          faultHook: { path: manifest.faultHook.path, kinds: [...manifest.faultHook.kinds] },
        }),
    contractMetadata: {
      noEffectOnRejection: manifest.contract.metadata.noEffectOnRejection === true,
    },
  };
  return policy;
}

// ---------------------------------------------------------------------
// Validation internals
// ---------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CR/LF/NUL (and the rest of C0) must never enter any manifest string. */
function hasForbiddenControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Target-chosen stable identifiers: roles, query ids, edge kinds. */
const IDENTIFIER_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

/** Event/response field names (plain JSON keys — no dot/bracket paths). */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Target-declared sensitive field names (dot-qualified allowed). */
const SENSITIVE_FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

/** Credential reference names (environment-variable style). */
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** RFC 7230 header-name token. Excludes CR/LF/NUL/whitespace by construction. */
const HEADER_NAME_PATTERN = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;

/** Framing/system-owned headers no manifest may claim (executor-owned). */
const FORBIDDEN_SIGNATURE_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'expect',
  'upgrade',
  'authorization',
  'cookie',
  'set-cookie',
  'x-rupturegrid-delivery-attempt-id',
]);

const TOP_LEVEL_FIELDS = new Set([
  'manifestVersion',
  'displayName',
  'environment',
  'origins',
  'credentialRefs',
  'contract',
  'inspection',
  'identityModel',
  'sensitiveFields',
  'signatureHeader',
  'faultHook',
]);

const REQUIRED_TOP_LEVEL_FIELDS = [
  'manifestVersion',
  'displayName',
  'environment',
  'origins',
  'credentialRefs',
  'contract',
  'inspection',
  'identityModel',
  'sensitiveFields',
] as const;

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Validates a declared typed-field map (identity nodes and inspection
 * entity schemas). Closed: unknown keys are the declared field names
 * themselves; VALUES must be exact members of the closed type
 * vocabulary — never coerced.
 */
function validateTypedFieldMap(
  raw: unknown,
  where: string,
  maxFields: number,
  issues: string[],
): Record<string, ManifestFieldType> {
  const fields: Record<string, ManifestFieldType> = {};
  if (!isRecord(raw)) {
    issues.push(`${where} must be an object (field name → declared primitive type)`);
    return fields;
  }
  const entries = Object.entries(raw);
  if (entries.length > maxFields) {
    issues.push(`${where} exceeds the ${maxFields}-field limit (got ${entries.length})`);
  }
  for (const [name, type] of entries) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      issues.push(`${where}.${name} is not a valid field name (must match ${FIELD_NAME_PATTERN})`);
      continue;
    }
    if (!(MANIFEST_FIELD_TYPES as readonly string[]).includes(type as string)) {
      issues.push(
        `${where}.${name} must be one of: ${MANIFEST_FIELD_TYPES.join(', ')} (got ${JSON.stringify(type ?? null)})`,
      );
      continue;
    }
    fields[name] = type as ManifestFieldType;
  }
  return fields;
}

/**
 * Validates a target-manifest/v1 document. Collects EVERY issue (the
 * registrant sees the full rejection list at once — nothing is fixed
 * up or partially applied). Throws ManifestValidationError on any
 * issue. Returns the normalized manifest.
 */
export function validateTargetManifest(raw: unknown): TargetManifest {
  const issues: string[] = [];

  // ---- Object / array / non-object rejection ----
  if (!isRecord(raw)) {
    throw new ManifestValidationError([
      Array.isArray(raw)
        ? 'manifest must be a JSON object (arrays are not manifests)'
        : 'manifest must be a JSON object',
    ]);
  }

  // ---- Serialized-size cap (resource/security limit, checked first) ----
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new ManifestValidationError(['manifest must be JSON-serializable data']);
  }
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MANIFEST_LIMITS.maxSerializedBytes) {
    issues.push(
      `serialized manifest is ${serializedBytes} bytes; the server-side cap is ${MANIFEST_LIMITS.maxSerializedBytes} (MANIFEST_LIMITS.maxSerializedBytes)`,
    );
  }

  // ---- Version (exact; unknown versions REJECTED, never guessed) ----
  if (raw['manifestVersion'] !== TARGET_MANIFEST_VERSION) {
    issues.push(
      `manifestVersion must be exactly "${TARGET_MANIFEST_VERSION}" (got ${JSON.stringify(raw['manifestVersion'] ?? null)}); unknown versions are refused, never guessed`,
    );
  }

  // ---- Closed top-level schema ----
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      issues.push(`unknown top-level field "${key}" (the manifest schema is closed)`);
    }
  }
  for (const required of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(required in raw)) {
      issues.push(`missing required field "${required}"`);
    }
  }

  // ---- displayName ----
  let displayName = '';
  const rawDisplayName = raw['displayName'];
  if (!isPlainString(rawDisplayName)) {
    issues.push('displayName must be a string');
  } else if (
    hasForbiddenControlChars(rawDisplayName) ||
    rawDisplayName.trim() !== rawDisplayName ||
    rawDisplayName.length < 3 ||
    rawDisplayName.length > MANIFEST_LIMITS.maxDisplayNameChars
  ) {
    issues.push(
      `displayName must be 3..${MANIFEST_LIMITS.maxDisplayNameChars} characters, CR/LF/NUL-free, without leading/trailing whitespace`,
    );
  } else {
    displayName = rawDisplayName;
  }

  // ---- environment (v1.x vocabulary; PRODUCTION refused) ----
  let environment: TargetManifest['environment'] | undefined;
  const rawEnvironment = raw['environment'];
  if (!isPlainString(rawEnvironment)) {
    issues.push('environment must be a string');
  } else if (rawEnvironment === 'PRODUCTION') {
    issues.push(
      'PRODUCTION manifests are refused: production registration is denied in v1.x (ADR-0016)',
    );
  } else if (!(TARGET_MANIFEST_ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    issues.push(
      `environment must be one of: ${TARGET_MANIFEST_ENVIRONMENTS.join(', ')} (got "${rawEnvironment}")`,
    );
  } else {
    environment = rawEnvironment as TargetManifest['environment'];
  }

  // ---- origins (normalized; duplicates after normalization rejected) ----
  let origins: string[] = [];
  const rawOrigins = raw['origins'];
  if (rawOrigins === undefined) {
    issues.push('missing required field "origins"');
  } else if (!Array.isArray(rawOrigins)) {
    issues.push('origins must be an array of origin strings');
  } else if (rawOrigins.length === 0) {
    issues.push(
      'origins must contain at least one origin (execution requires a registered origin)',
    );
  } else if (rawOrigins.length > MANIFEST_LIMITS.maxOrigins) {
    issues.push(`origins exceeds the ${MANIFEST_LIMITS.maxOrigins}-origin limit`);
  } else {
    const normalized: string[] = [];
    for (let index = 0; index < rawOrigins.length; index += 1) {
      const entry = rawOrigins[index];
      if (!isPlainString(entry)) {
        issues.push(`origins[${index}] must be a string`);
        continue;
      }
      try {
        const normalizedOrigin = normalizeOrigin(entry);
        if (normalizedOrigin.length > 255) {
          issues.push(`origins[${index}] normalized form exceeds 255 characters`);
          continue;
        }
        normalized.push(normalizedOrigin);
      } catch (error) {
        issues.push(
          `origins[${index}]: ${error instanceof Error ? error.message : 'invalid origin'}`,
        );
      }
    }
    const duplicate = normalized.find((origin, index) => normalized.indexOf(origin) !== index);
    if (duplicate !== undefined) {
      issues.push(
        `duplicate origins after normalization: ${duplicate} (duplicates are rejected, never deduplicated)`,
      );
    }
    // Environment scheme policy (security-boundaries §3.1, ADR-0016 §5):
    // STAGING is HTTPS-only; LOCAL_DEVELOPMENT may use http or https.
    // (PRODUCTION is refused entirely above.)
    if (environment === 'STAGING') {
      for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index]?.startsWith('http:')) {
          issues.push(
            `origins[${index}] uses http; STAGING manifests require https (LOCAL_DEVELOPMENT only)`,
          );
        }
      }
    }
    origins = normalized;
  }

  // ---- credentialRefs (names only; subset of the executor allowlist) ----
  let credentialRefs: string[] = [];
  const rawRefs = raw['credentialRefs'];
  if (rawRefs === undefined) {
    issues.push('missing required field "credentialRefs"');
  } else if (!Array.isArray(rawRefs)) {
    issues.push('credentialRefs must be an array of credential reference NAMES (never values)');
  } else {
    if (rawRefs.length > MANIFEST_LIMITS.maxCredentialRefs) {
      issues.push(`credentialRefs exceeds the ${MANIFEST_LIMITS.maxCredentialRefs}-ref limit`);
    }
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (let index = 0; index < rawRefs.length; index += 1) {
      const ref = rawRefs[index];
      if (!isPlainString(ref)) {
        issues.push(`credentialRefs[${index}] must be a string (a reference NAME, never a value)`);
        continue;
      }
      if (!CREDENTIAL_REF_PATTERN.test(ref)) {
        issues.push(
          `credentialRefs[${index}] ("${ref.slice(0, 20)}") is not a valid reference name (must match ${CREDENTIAL_REF_PATTERN})`,
        );
        continue;
      }
      if (!(EXECUTOR_CREDENTIAL_REF_SET as ReadonlySet<string>).has(ref)) {
        issues.push(
          `credentialRefs[${index}] ("${ref}") is outside the executor's server-side allowlist (ADR-0012)`,
        );
        continue;
      }
      if (seen.has(ref)) {
        issues.push(
          `duplicate credentialRef "${ref}" (duplicates are rejected, never deduplicated)`,
        );
        continue;
      }
      seen.add(ref);
      accepted.push(ref);
    }
    credentialRefs = accepted;
  }

  // ---- contract (platform-defined class + closed metadata vocabulary) ----
  let contractKind: ContractKind | undefined;
  let contractMetadata: TargetManifestContractMetadata = {};
  const rawContract = raw['contract'];
  if (rawContract === undefined) {
    issues.push('missing required field "contract"');
  } else if (!isRecord(rawContract)) {
    issues.push('contract must be an object');
  } else {
    for (const key of Object.keys(rawContract)) {
      if (key !== 'kind' && key !== 'metadata') {
        issues.push(`unknown contract field "${key}" (the contract schema is closed)`);
      }
    }
    const rawKind = rawContract['kind'];
    if (!isPlainString(rawKind) || !(CONTRACT_KINDS as readonly string[]).includes(rawKind)) {
      issues.push(
        `contract.kind must be one of: ${CONTRACT_KINDS.join(', ')} (got ${JSON.stringify(rawKind ?? null)})`,
      );
    } else {
      contractKind = rawKind as ContractKind;
    }
    const rawMetadata = rawContract['metadata'];
    if (rawMetadata !== undefined) {
      if (!isRecord(rawMetadata)) {
        issues.push('contract.metadata must be an object');
      } else {
        for (const key of Object.keys(rawMetadata)) {
          if (key !== 'noEffectOnRejection') {
            issues.push(
              `unknown contract.metadata field "${key}" (target-declared metadata is a closed vocabulary: noEffectOnRejection)`,
            );
          }
        }
        const rawNoEffect = rawMetadata['noEffectOnRejection'];
        if (rawNoEffect !== undefined) {
          if (typeof rawNoEffect !== 'boolean') {
            issues.push('contract.metadata.noEffectOnRejection must be a boolean (never coerced)');
          } else {
            contractMetadata = { noEffectOnRejection: rawNoEffect };
          }
        }
      }
    }
  }

  // ---- inspection (named read-only query declarations; structural) ----
  let inspection: ManifestInspectionQuery[] = [];
  const rawInspection = raw['inspection'];
  if (rawInspection === undefined) {
    issues.push('missing required field "inspection"');
  } else if (!Array.isArray(rawInspection)) {
    issues.push('inspection must be an array of named read-only query declarations');
  } else {
    if (rawInspection.length > MANIFEST_LIMITS.maxInspectionQueries) {
      issues.push(`inspection exceeds the ${MANIFEST_LIMITS.maxInspectionQueries}-query limit`);
    }
    const seenQueryIds = new Set<string>();
    const acceptedQueries: ManifestInspectionQuery[] = [];
    for (let index = 0; index < rawInspection.length; index += 1) {
      const where = `inspection[${index}]`;
      const rawQuery = rawInspection[index];
      if (!isRecord(rawQuery)) {
        issues.push(`${where} must be an object`);
        continue;
      }
      for (const key of Object.keys(rawQuery)) {
        if (!['queryId', 'description', 'path', 'fields', 'identityFields'].includes(key)) {
          issues.push(`unknown ${where} field "${key}" (the inspection-query schema is closed)`);
        }
      }
      let queryId = '';
      const rawQueryId = rawQuery['queryId'];
      if (!isPlainString(rawQueryId) || !IDENTIFIER_PATTERN.test(rawQueryId)) {
        issues.push(`${where}.queryId must match ${IDENTIFIER_PATTERN}`);
      } else if (seenQueryIds.has(rawQueryId)) {
        issues.push(`${where}.queryId "${rawQueryId}" duplicates an earlier query id`);
      } else {
        seenQueryIds.add(rawQueryId);
        queryId = rawQueryId;
      }
      let description = '';
      const rawDescription = rawQuery['description'];
      if (
        !isPlainString(rawDescription) ||
        hasForbiddenControlChars(rawDescription) ||
        rawDescription.length > MANIFEST_LIMITS.maxDescriptionChars
      ) {
        issues.push(
          `${where}.description must be a CR/LF/NUL-free string of at most ${MANIFEST_LIMITS.maxDescriptionChars} characters`,
        );
      } else {
        description = rawDescription;
      }
      let path = '';
      const rawPath = rawQuery['path'];
      if (!isPlainString(rawPath)) {
        issues.push(`${where}.path must be a string (read-only relative path)`);
      } else if (rawPath.length > MANIFEST_LIMITS.maxFaultHookPathChars) {
        issues.push(
          `${where}.path exceeds the ${MANIFEST_LIMITS.maxFaultHookPathChars}-character path limit`,
        );
      } else {
        try {
          path = validateRelativePath(rawPath);
        } catch (error) {
          issues.push(
            `${where}.path: ${error instanceof Error ? error.message : 'invalid relative path'}`,
          );
        }
      }
      const fields = validateTypedFieldMap(
        rawQuery['fields'],
        `${where}.fields`,
        MANIFEST_LIMITS.maxFieldsPerInspectionQuery,
        issues,
      );
      let identityFields: string[] = [];
      const rawIdentityFields = rawQuery['identityFields'];
      if (!Array.isArray(rawIdentityFields)) {
        issues.push(`${where}.identityFields must be an array of declared field names`);
      } else {
        const seen = new Set<string>();
        const accepted: string[] = [];
        for (const entry of rawIdentityFields) {
          if (!isPlainString(entry) || !FIELD_NAME_PATTERN.test(entry)) {
            issues.push(`${where}.identityFields entries must be declared field names`);
            continue;
          }
          if (!(entry in fields)) {
            issues.push(`${where}.identityFields names undeclared field "${entry}"`);
            continue;
          }
          if (seen.has(entry)) {
            issues.push(`${where}.identityFields duplicates "${entry}"`);
            continue;
          }
          seen.add(entry);
          accepted.push(entry);
        }
        identityFields = accepted;
      }
      if (queryId !== '' && description !== '' && path !== '') {
        acceptedQueries.push({ queryId, description, path, fields, identityFields });
      }
    }
    inspection = acceptedQueries;
  }

  // ---- identityModel (typed declarations; structural only in Phase 13) ----
  let identityModel: ManifestIdentityModel | undefined;
  const rawIdentityModel = raw['identityModel'];
  if (rawIdentityModel === undefined) {
    issues.push('missing required field "identityModel"');
  } else if (!isRecord(rawIdentityModel)) {
    issues.push('identityModel must be an object');
  } else {
    for (const key of Object.keys(rawIdentityModel)) {
      if (!['nodes', 'causalEdges', 'effectRoleIds', 'subjectRoleId'].includes(key)) {
        issues.push(`unknown identityModel field "${key}" (the identity-model schema is closed)`);
      }
    }
    // Nodes: one minimum (ADR-0017); the count cap is a PAYLOAD SAFETY
    // limit, never a claim about valid identity-graph shapes.
    const nodes: ManifestIdentityNode[] = [];
    const roleIds = new Set<string>();
    const rolesFields = new Map<string, Record<string, ManifestFieldType>>();
    const rawNodes = rawIdentityModel['nodes'];
    if (rawNodes === undefined) {
      issues.push('missing required field "identityModel.nodes"');
    } else if (!Array.isArray(rawNodes)) {
      issues.push('identityModel.nodes must be an array');
    } else if (rawNodes.length === 0) {
      issues.push(
        'identityModel.nodes must contain at least one node (ADR-0017: one node minimum)',
      );
    } else {
      if (rawNodes.length > MANIFEST_LIMITS.maxIdentityNodes) {
        issues.push(
          `identityModel.nodes exceeds the ${MANIFEST_LIMITS.maxIdentityNodes}-node server-side payload cap (this cap bounds the submission size; it is NOT a claim that valid identity models have at most this many nodes)`,
        );
      }
      for (let index = 0; index < rawNodes.length; index += 1) {
        const where = `identityModel.nodes[${index}]`;
        const rawNode = rawNodes[index];
        if (!isRecord(rawNode)) {
          issues.push(`${where} must be an object`);
          continue;
        }
        for (const key of Object.keys(rawNode)) {
          if (!['roleId', 'description', 'fields'].includes(key)) {
            issues.push(`unknown ${where} field "${key}" (the identity-node schema is closed)`);
          }
        }
        let roleId = '';
        const rawRoleId = rawNode['roleId'];
        if (!isPlainString(rawRoleId) || !IDENTIFIER_PATTERN.test(rawRoleId)) {
          issues.push(`${where}.roleId must match ${IDENTIFIER_PATTERN}`);
        } else if (roleIds.has(rawRoleId)) {
          issues.push(`${where}.roleId "${rawRoleId}" duplicates an earlier role id`);
        } else {
          roleIds.add(rawRoleId);
          roleId = rawRoleId;
        }
        let description = '';
        const rawDescription = rawNode['description'];
        if (
          !isPlainString(rawDescription) ||
          hasForbiddenControlChars(rawDescription) ||
          rawDescription.length > MANIFEST_LIMITS.maxDescriptionChars
        ) {
          issues.push(
            `${where}.description must be a CR/LF/NUL-free string of at most ${MANIFEST_LIMITS.maxDescriptionChars} characters`,
          );
        } else {
          description = rawDescription;
        }
        const fields = validateTypedFieldMap(
          rawNode['fields'],
          `${where}.fields`,
          MANIFEST_LIMITS.maxFieldsPerIdentityNode,
          issues,
        );
        if (roleId !== '' && description !== '') {
          nodes.push({ roleId, description, fields });
          rolesFields.set(roleId, fields);
        }
      }
    }

    // Causal edges: typed, between DECLARED roles, with a non-empty
    // exact-equality basis declared on BOTH endpoint nodes.
    const causalEdges: ManifestCausalEdge[] = [];
    const rawEdges = rawIdentityModel['causalEdges'];
    if (rawEdges === undefined) {
      issues.push('missing required field "identityModel.causalEdges"');
    } else if (!Array.isArray(rawEdges)) {
      issues.push('identityModel.causalEdges must be an array');
    } else {
      if (rawEdges.length > MANIFEST_LIMITS.maxCausalEdges) {
        issues.push(
          `identityModel.causalEdges exceeds the ${MANIFEST_LIMITS.maxCausalEdges}-edge server-side payload cap (a submission-size limit, not an identity-model semantic)`,
        );
      }
      const seenTriples = new Set<string>();
      for (let index = 0; index < rawEdges.length; index += 1) {
        const where = `identityModel.causalEdges[${index}]`;
        const rawEdge = rawEdges[index];
        if (!isRecord(rawEdge)) {
          issues.push(`${where} must be an object`);
          continue;
        }
        for (const key of Object.keys(rawEdge)) {
          if (!['fromRoleId', 'toRoleId', 'edgeKind', 'linkFields'].includes(key)) {
            issues.push(`unknown ${where} field "${key}" (the causal-edge schema is closed)`);
          }
        }
        let fromRoleId = '';
        const rawFrom = rawEdge['fromRoleId'];
        if (!isPlainString(rawFrom) || !IDENTIFIER_PATTERN.test(rawFrom)) {
          issues.push(`${where}.fromRoleId must match ${IDENTIFIER_PATTERN}`);
        } else if (!roleIds.has(rawFrom)) {
          issues.push(`${where}.fromRoleId "${rawFrom}" references an undeclared role`);
        } else {
          fromRoleId = rawFrom;
        }
        let toRoleId = '';
        const rawTo = rawEdge['toRoleId'];
        if (!isPlainString(rawTo) || !IDENTIFIER_PATTERN.test(rawTo)) {
          issues.push(`${where}.toRoleId must match ${IDENTIFIER_PATTERN}`);
        } else if (!roleIds.has(rawTo)) {
          issues.push(`${where}.toRoleId "${rawTo}" references an undeclared role`);
        } else {
          toRoleId = rawTo;
        }
        let edgeKind = '';
        const rawEdgeKind = rawEdge['edgeKind'];
        if (!isPlainString(rawEdgeKind) || !IDENTIFIER_PATTERN.test(rawEdgeKind)) {
          issues.push(`${where}.edgeKind must match ${IDENTIFIER_PATTERN}`);
        } else {
          edgeKind = rawEdgeKind;
        }
        let linkFields: string[] = [];
        const rawLinkFields = rawEdge['linkFields'];
        if (!Array.isArray(rawLinkFields)) {
          issues.push(`${where}.linkFields must be an array of declared field names`);
        } else if (rawLinkFields.length === 0) {
          issues.push(
            `${where}.linkFields must not be empty (an edge with no identity basis is rejected at registration — ADR-0017)`,
          );
        } else if (rawLinkFields.length > MANIFEST_LIMITS.maxLinkFieldsPerEdge) {
          issues.push(
            `${where}.linkFields exceeds the ${MANIFEST_LIMITS.maxLinkFieldsPerEdge}-field limit`,
          );
        } else {
          const seen = new Set<string>();
          const accepted: string[] = [];
          for (const entry of rawLinkFields) {
            if (!isPlainString(entry) || !FIELD_NAME_PATTERN.test(entry)) {
              issues.push(`${where}.linkFields entries must be declared field names`);
              continue;
            }
            if (seen.has(entry)) {
              issues.push(`${where}.linkFields duplicates "${entry}"`);
              continue;
            }
            seen.add(entry);
            accepted.push(entry);
          }
          for (const field of accepted) {
            const fromFields = fromRoleId === '' ? undefined : rolesFields.get(fromRoleId);
            const toFields = toRoleId === '' ? undefined : rolesFields.get(toRoleId);
            if (
              (fromFields !== undefined && !(field in fromFields)) ||
              (toFields !== undefined && !(field in toFields))
            ) {
              issues.push(
                `${where}.linkFields names "${field}", which is not declared on both endpoint roles (${fromRoleId || '?'} and ${toRoleId || '?'}); exact-equality edges require the field on both`,
              );
              break;
            }
          }
          linkFields = accepted;
        }
        const triple = `${fromRoleId}->${toRoleId}:${edgeKind}`;
        if (seenTriples.has(triple)) {
          issues.push(`${where} duplicates the causal edge ${triple}`);
          continue;
        }
        if (fromRoleId !== '' && toRoleId !== '' && edgeKind !== '' && linkFields.length > 0) {
          seenTriples.add(triple);
          causalEdges.push({ fromRoleId, toRoleId, edgeKind, linkFields });
        }
      }
    }

    // Effect/subject designations: declared roles only.
    let effectRoleIds: string[] = [];
    const rawEffectRoleIds = rawIdentityModel['effectRoleIds'];
    if (rawEffectRoleIds === undefined) {
      issues.push('missing required field "identityModel.effectRoleIds"');
    } else if (!Array.isArray(rawEffectRoleIds)) {
      issues.push('identityModel.effectRoleIds must be an array of declared role ids');
    } else {
      const seen = new Set<string>();
      const accepted: string[] = [];
      for (const entry of rawEffectRoleIds) {
        if (!isPlainString(entry) || !IDENTIFIER_PATTERN.test(entry)) {
          issues.push('identityModel.effectRoleIds entries must be declared role ids');
          continue;
        }
        if (!roleIds.has(entry)) {
          issues.push(`identityModel.effectRoleIds references undeclared role "${entry}"`);
          continue;
        }
        if (seen.has(entry)) {
          issues.push(`identityModel.effectRoleIds duplicates "${entry}"`);
          continue;
        }
        seen.add(entry);
        accepted.push(entry);
      }
      effectRoleIds = accepted;
    }

    let subjectRoleId: string | undefined;
    const rawSubjectRoleId = rawIdentityModel['subjectRoleId'];
    if (rawSubjectRoleId !== undefined) {
      if (!isPlainString(rawSubjectRoleId) || !IDENTIFIER_PATTERN.test(rawSubjectRoleId)) {
        issues.push('identityModel.subjectRoleId must be a declared role id');
      } else if (!roleIds.has(rawSubjectRoleId)) {
        issues.push(`identityModel.subjectRoleId references undeclared role "${rawSubjectRoleId}"`);
      } else {
        subjectRoleId = rawSubjectRoleId;
      }
    }

    if (issues.length === 0) {
      identityModel = {
        nodes,
        causalEdges,
        effectRoleIds,
        ...(subjectRoleId === undefined ? {} : { subjectRoleId }),
      };
    }
  }

  // ---- sensitiveFields (the target's redaction-registry extension) ----
  let sensitiveFields: string[] = [];
  const rawSensitive = raw['sensitiveFields'];
  if (rawSensitive === undefined) {
    issues.push('missing required field "sensitiveFields"');
  } else if (!Array.isArray(rawSensitive)) {
    issues.push('sensitiveFields must be an array of field names');
  } else {
    if (rawSensitive.length > MANIFEST_LIMITS.maxSensitiveFields) {
      issues.push(`sensitiveFields exceeds the ${MANIFEST_LIMITS.maxSensitiveFields}-field limit`);
    }
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (let index = 0; index < rawSensitive.length; index += 1) {
      const entry = rawSensitive[index];
      if (!isPlainString(entry) || !SENSITIVE_FIELD_PATTERN.test(entry)) {
        issues.push(
          `sensitiveFields[${index}] is not a valid field name (must match ${SENSITIVE_FIELD_PATTERN})`,
        );
        continue;
      }
      if (seen.has(entry)) {
        issues.push(
          `duplicate sensitiveField "${entry}" (duplicates are rejected, never deduplicated)`,
        );
        continue;
      }
      seen.add(entry);
      accepted.push(entry);
    }
    sensitiveFields = accepted;
  }

  // ---- signatureHeader (optional; validated header-name rules) ----
  let signatureHeader: string | undefined;
  const rawSignatureHeader = raw['signatureHeader'];
  if (rawSignatureHeader !== undefined) {
    if (!isPlainString(rawSignatureHeader)) {
      issues.push(
        'signatureHeader must be a string (the header NAME carrying the executor-computed HMAC)',
      );
    } else if (
      !HEADER_NAME_PATTERN.test(rawSignatureHeader) ||
      rawSignatureHeader.length > MANIFEST_LIMITS.maxHeaderNameChars
    ) {
      issues.push(
        `signatureHeader must be a valid RFC 7230 header-name token of at most ${MANIFEST_LIMITS.maxHeaderNameChars} characters (no CR/LF/NUL/whitespace)`,
      );
    } else {
      const lower = rawSignatureHeader.toLowerCase();
      if (FORBIDDEN_SIGNATURE_HEADERS.has(lower)) {
        issues.push(
          `signatureHeader "${lower}" is a framing/system-owned header the executor owns (it can never be declared by a manifest)`,
        );
      } else {
        signatureHeader = lower;
      }
    }
  }

  // ---- faultHook (optional; the target-owned controlled-fault surface) ----
  let faultHook: TargetManifest['faultHook'];
  const rawFaultHook = raw['faultHook'];
  if (rawFaultHook !== undefined) {
    if (!isRecord(rawFaultHook)) {
      issues.push('faultHook must be an object');
    } else {
      for (const key of Object.keys(rawFaultHook)) {
        if (!['version', 'path', 'kinds'].includes(key)) {
          issues.push(`unknown faultHook field "${key}" (the fault-hook schema is closed)`);
        }
      }
      const rawVersion = rawFaultHook['version'];
      if (rawVersion !== CONTROLLED_FAULT_PLAN_VERSION) {
        issues.push(
          `faultHook.version must be exactly "${CONTROLLED_FAULT_PLAN_VERSION}" (got ${JSON.stringify(rawVersion ?? null)})`,
        );
      }
      let path = '';
      const rawHookPath = rawFaultHook['path'];
      if (!isPlainString(rawHookPath)) {
        issues.push(
          'faultHook.path must be a string (the declared fault-controlled delivery path)',
        );
      } else if (rawHookPath.length > MANIFEST_LIMITS.maxFaultHookPathChars) {
        issues.push(
          `faultHook.path exceeds the ${MANIFEST_LIMITS.maxFaultHookPathChars}-character path limit`,
        );
      } else {
        try {
          path = validateRelativePath(rawHookPath);
        } catch (error) {
          issues.push(
            `faultHook.path: ${error instanceof Error ? error.message : 'invalid relative path'}`,
          );
        }
      }
      let kinds: ControlledFaultKind[] = [];
      const rawKinds = rawFaultHook['kinds'];
      if (!Array.isArray(rawKinds)) {
        issues.push('faultHook.kinds must be an array of controlled-fault kinds');
      } else if (rawKinds.length === 0) {
        issues.push(
          'faultHook.kinds must not be empty (a declared hook declares at least one kind)',
        );
      } else {
        const seen = new Set<string>();
        const accepted: ControlledFaultKind[] = [];
        for (const kind of rawKinds) {
          if (
            !isPlainString(kind) ||
            !(CONTROLLED_FAULT_KINDS as readonly string[]).includes(kind)
          ) {
            issues.push(
              `faultHook.kinds entries must be one of: ${CONTROLLED_FAULT_KINDS.join(', ')} (got ${JSON.stringify(kind ?? null)})`,
            );
            continue;
          }
          if (seen.has(kind)) {
            issues.push(`duplicate faultHook kind "${kind}"`);
            continue;
          }
          seen.add(kind);
          accepted.push(kind as ControlledFaultKind);
        }
        kinds = accepted;
      }
      if (rawVersion === CONTROLLED_FAULT_PLAN_VERSION && path !== '' && kinds.length > 0) {
        faultHook = { version: CONTROLLED_FAULT_PLAN_VERSION, path, kinds };
      }
    }
  }

  // Cross-field closure: a declared signature header is computed by the
  // executor with the DEMO_PROVIDER_SIGNING_SECRET credential (ADR-0012,
  // request-time only). A manifest that declares the header without
  // declaring that reference could never have its signature computed —
  // fail fast at registration instead of at execution.
  if (signatureHeader !== undefined && !credentialRefs.includes('DEMO_PROVIDER_SIGNING_SECRET')) {
    issues.push(
      'signatureHeader requires the DEMO_PROVIDER_SIGNING_SECRET credentialRef (the executor computes the HMAC with it at request time; ADR-0012)',
    );
  }

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }

  return {
    manifestVersion: TARGET_MANIFEST_VERSION,
    displayName,
    environment: environment as TargetManifest['environment'],
    origins,
    credentialRefs,
    contract: {
      kind: contractKind as ContractKind,
      metadata: contractMetadata,
    },
    inspection,
    identityModel: identityModel as ManifestIdentityModel,
    sensitiveFields,
    ...(signatureHeader === undefined ? {} : { signatureHeader }),
    ...(faultHook === undefined ? {} : { faultHook }),
  };
}
