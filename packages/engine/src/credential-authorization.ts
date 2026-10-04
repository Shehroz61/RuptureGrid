// =====================================================================
// RuptureGrid v1.1 Phase 16 — ADR-0024 platform credential authorization
// =====================================================================
// Platform-owned target-origin credential authorization and the
// signing-capable subset (ADR-0024). Three concepts stay frozen apart
// (ADR-0024 §2):
//
//   A. GLOBAL EXECUTOR CAPABILITY — EXECUTOR_CREDENTIAL_REFS
//      (@rupturegrid/config): what the deployment can potentially
//      resolve. Authorizes NOBODY.
//   B. TARGET-ORIGIN CREDENTIAL GRANTS — TargetOriginCredentialPolicy
//      (this module): what may be transmitted to WHICH normalized
//      origin authority. The ONLY thing that grants target access.
//   C. SIGNING CAPABILITY — EXECUTOR_SIGNING_CREDENTIAL_REFS
//      (@rupturegrid/config): which authorized references may serve as
//      ${signature} HMAC keys. A classification, never an escape hatch.
//
// Enforcement points (ADR-0024 §5, §8, §16): registration validation
// and execution-policy derivation for NEW runs. NEVER per request (the
// executor consumes the frozen snapshot policy; a historical run's
// credential use is fixed).
//
// Security properties frozen here:
//   - the authorization principal is the NORMALIZED TARGET ORIGIN
//     AUTHORITY — never displayName, never caller declarations
//     (ADR-0024 §3);
//   - multi-origin targets require the INTERSECTION of per-origin
//     grants, never the union (ADR-0024 §6);
//   - the signing binding is exactly-one over the AUTHORIZED declared
//     subset — zero rejects, 2+ rejects as ambiguous, no ordering or
//     naming heuristic ever selects a key (ADR-0024 §8);
//   - issues are bounded and name-only: reference names, origins, and
//     counts — never values (R-13, ADR-0012, ADR-0024 §17);
//   - fail closed everywhere: an absent policy context cannot derive a
//     manifest execution policy that declares a signature seam.

import { EXECUTOR_CREDENTIAL_REFS, EXECUTOR_SIGNING_CREDENTIAL_REFS } from '@rupturegrid/config';
import { normalizeOrigin } from './target.js';
import type { TargetManifest } from './manifest.js';

/** The executor's server-side credential-reference allowlist (ADR-0012). */
const EXECUTOR_CREDENTIAL_REF_SET: ReadonlySet<string> = new Set(EXECUTOR_CREDENTIAL_REFS);

// ---------------------------------------------------------------------
// The platform policy object (ADR-0024 §4: the durable representation
// is an implementation decision; the CONTENT model is frozen —
// reference names × normalized origins, nothing else)
// ---------------------------------------------------------------------

/**
 * The server-owned target-origin credential policy. Constructed by the
 * platform (API process) from validated configuration — never from any
 * target- or caller-supplied data — and passed explicitly into
 * registration and snapshot derivation. Reference names and normalized
 * origins ONLY (R-13; ADR-0024 §17).
 */
export interface TargetOriginCredentialPolicy {
  /**
   * The signing-capable subset (concept B). The platform classifies
   * these explicitly; this module never infers them from names.
   */
  readonly signingCredentialRefs: readonly string[];
  /**
   * Normalized origin authority → authorized credential reference
   * NAMES. A reference missing from an origin's grant set is not
   * authorized for that origin.
   */
  readonly originGrants: Readonly<Record<string, readonly string[]>>;
}

/**
 * The fail-closed default policy: the platform signing classification
 * applies, but NO origin holds any grant — every credential-declaring
 * manifest registration/derivation is rejected until the operator
 * grants references to specific origins. Callers that cannot supply
 * the real policy therefore deny by default; they can never widen
 * access by omission.
 */
export const DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY: TargetOriginCredentialPolicy = {
  signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
  originGrants: {},
};

/** Authorization context threaded through derivation call sites. */
export interface PolicyAuthorizationInput {
  readonly policy: TargetOriginCredentialPolicy;
  /** The registered, normalized origins of the target. */
  readonly origins: readonly string[];
}

export class CredentialAuthorizationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      issues.length === 1
        ? `credential authorization failed: ${issues[0]}`
        : `credential authorization failed (${issues.length} issues):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'CredentialAuthorizationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------
// Platform configuration invariants (ADR-0024 §18) — enforced at
// configuration/startup validation, never per request.
// ---------------------------------------------------------------------

/**
 * Validates the platform policy object against the frozen
 * configuration invariants (ADR-0024 §18):
 *
 *   EXECUTOR_SIGNING_CREDENTIAL_REFS ⊆ EXECUTOR_CREDENTIAL_REFS
 *   every grant's reference name ∈ EXECUTOR_CREDENTIAL_REFS
 *
 * and the content model: grant keys are normalized origin authorities,
 * values are name-only reference lists. Returns every issue (empty =
 * valid); bounded, name-only, secret-free. A violating platform
 * configuration refuses to start — it is never silently repaired.
 */
export function targetOriginCredentialPolicyIssues(policy: TargetOriginCredentialPolicy): string[] {
  const issues: string[] = [];
  const signingOutside = policy.signingCredentialRefs.filter(
    (ref) => !EXECUTOR_CREDENTIAL_REF_SET.has(ref),
  );
  if (signingOutside.length > 0) {
    issues.push(
      `signing-capable refs outside EXECUTOR_CREDENTIAL_REFS: ${signingOutside.join(', ')} (the signing set must be a subset of the executor set — ADR-0024 §18)`,
    );
  }
  const signingSeen = new Set<string>();
  for (const ref of policy.signingCredentialRefs) {
    if (signingSeen.has(ref)) {
      issues.push(`duplicate signing-capable ref: ${ref}`);
    }
    signingSeen.add(ref);
  }
  for (const [origin, refs] of Object.entries(policy.originGrants)) {
    let normalizedOrigin: string;
    try {
      normalizedOrigin = normalizeOrigin(origin);
    } catch (error) {
      issues.push(
        `grant origin "${origin.slice(0, 80)}" is not a valid normalized origin authority: ${
          error instanceof Error ? error.message : 'invalid'
        }`,
      );
      continue;
    }
    if (normalizedOrigin !== origin) {
      issues.push(
        `grant origin "${origin.slice(0, 80)}" is not in normalized form (expected "${normalizedOrigin}"); grants are keyed by the exact stored origin authority`,
      );
    }
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!EXECUTOR_CREDENTIAL_REF_SET.has(ref)) {
        issues.push(
          `grant for "${origin.slice(0, 80)}" names "${ref}", which is outside EXECUTOR_CREDENTIAL_REFS (a stale grant fails configuration validation — ADR-0024 §18)`,
        );
      }
      if (seen.has(ref)) {
        issues.push(`grant for "${origin.slice(0, 80)}" duplicates "${ref}"`);
      }
      seen.add(ref);
    }
  }
  return issues;
}

/** Fail-fast form of the §18 validation (used at API startup). */
export function assertValidTargetOriginCredentialPolicy(
  policy: TargetOriginCredentialPolicy,
): void {
  const issues = targetOriginCredentialPolicyIssues(policy);
  if (issues.length > 0) {
    throw new CredentialAuthorizationError(issues);
  }
}

// ---------------------------------------------------------------------
// Authorization questions (ADR-0024 §5–§6)
// ---------------------------------------------------------------------

/**
 * The credential references authorized for a target with the given
 * registered normalized origins: the INTERSECTION of every origin's
 * grant set (ADR-0024 §6 — never the union). A reference missing from
 * ANY origin's grant set is not target-authorized; an origin with no
 * grant entry contributes the empty set.
 */
export function authorizedRefsForTarget(
  policy: TargetOriginCredentialPolicy,
  origins: readonly string[],
): Set<string> {
  let authorized: Set<string> | undefined;
  for (const origin of origins) {
    const grants: readonly string[] = policy.originGrants[origin] ?? [];
    // ADR-0024 §5: authorization = allowlist membership (condition 1)
    // AND the origin grant (condition 2). The global vocabulary is
    // re-applied here as defense in depth even though §18 configuration
    // validation already rejects stale grants at startup.
    const grantSet = new Set<string>(grants.filter((ref) => EXECUTOR_CREDENTIAL_REF_SET.has(ref)));
    if (authorized === undefined) {
      authorized = new Set<string>(grantSet);
    } else {
      const current: Set<string> = authorized;
      authorized = new Set<string>([...current].filter((ref) => grantSet.has(ref)));
    }
  }
  return authorized ?? new Set<string>();
}

/**
 * Stage 1 (ADR-0024 §8): every declared reference must be authorized
 * for EVERY registered normalized origin of the target. Throws a
 * bounded, name-only CredentialAuthorizationError otherwise.
 */
export function assertCredentialRefsAuthorized(
  policy: TargetOriginCredentialPolicy,
  origins: readonly string[],
  refs: readonly string[],
): void {
  if (refs.length === 0) {
    return; // credential-less targets stay legal with no grants (§7)
  }
  const authorized = authorizedRefsForTarget(policy, origins);
  const unauthorized = [...new Set(refs)].filter((ref) => !authorized.has(ref));
  if (unauthorized.length > 0) {
    throw new CredentialAuthorizationError(
      unauthorized.map(
        (ref) =>
          `credential reference "${ref}" is not platform-authorized for the registered origin authority (${origins.join(', ')}); target declarations never grant credential access (ADR-0024 §5–§6)`,
      ),
    );
  }
}

// ---------------------------------------------------------------------
// The two-stage signing pipeline (ADR-0024 §8)
// ---------------------------------------------------------------------

/**
 * The resolved signature-credential binding for a validated manifest:
 * present exactly when the manifest declares `signatureHeader` (the
 * frozen pair invariant — ADR-0024 §9).
 */
export interface SignatureCredentialBinding {
  readonly signatureHeader: string;
  readonly signatureCredentialRef: string;
}

/**
 * Runs the two-stage signing pipeline (ADR-0024 §8) over an ALREADY
 * structurally-validated manifest and the CURRENT platform policy:
 *
 *   Stage 1 — authorization: ALL manifest credentialRefs must be
 *   authorized for the target's registered origins (§5–§6). Failure
 *   rejects before any signing question is asked.
 *
 *   Stage 2 — capability, over the authorized declared subset only:
 *     declaredSigningRefs = AUTHORIZED manifest.credentialRefs
 *                             ∩ EXECUTOR_SIGNING_CREDENTIAL_REFS
 *   requiring EXACTLY ONE member: zero → reject (no credential can
 *   back the declared seam); 2+ → reject (ambiguous binding — no
 *   selection heuristic exists); exactly one → that reference NAME is
 *   the deterministic binding.
 *
 * A manifest without `signatureHeader` has no signature seam at all:
 * no fields are produced and declared signing-capable refs remain
 * ordinary credential refs (ADR-0024 §9).
 *
 * Throws CredentialAuthorizationError with bounded, name-only issues.
 */
export function resolveSignatureCredentialBinding(
  policy: TargetOriginCredentialPolicy,
  origins: readonly string[],
  manifest: Pick<TargetManifest, 'signatureHeader' | 'credentialRefs'>,
): SignatureCredentialBinding | undefined {
  // ---- Stage 1: authorization of ALL declared refs ----
  assertCredentialRefsAuthorized(policy, origins, manifest.credentialRefs);
  if (manifest.signatureHeader === undefined) {
    return undefined; // No declared signature seam; no binding exists.
  }
  // ---- Stage 2: exact-one over the AUTHORIZED declared subset ----
  const authorized = authorizedRefsForTarget(policy, origins);
  const signingSet = new Set(policy.signingCredentialRefs);
  const declaredSigningRefs = manifest.credentialRefs.filter(
    (ref) => authorized.has(ref) && signingSet.has(ref),
  );
  if (declaredSigningRefs.length === 0) {
    throw new CredentialAuthorizationError([
      `signatureHeader "${manifest.signatureHeader}" is declared, but no declared credential reference is both platform-authorized for the registered origin authority and signing-capable; zero authorized signing refs cannot back the declared seam (ADR-0024 §8)`,
    ]);
  }
  if (declaredSigningRefs.length > 1) {
    throw new CredentialAuthorizationError([
      `signatureHeader "${manifest.signatureHeader}" is ambiguous: ${declaredSigningRefs.length} declared authorized signing-capable refs (${declaredSigningRefs.join(', ')}); no selection heuristic exists (ADR-0024 §8)`,
    ]);
  }
  const ref = declaredSigningRefs[0];
  if (ref === undefined) {
    // Unreachable (length checked above); fail closed rather than guess.
    throw new CredentialAuthorizationError(['signature binding resolved to nothing']);
  }
  return { signatureHeader: manifest.signatureHeader, signatureCredentialRef: ref };
}
