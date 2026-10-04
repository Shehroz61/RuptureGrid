import { EXECUTOR_SIGNING_CREDENTIAL_REFS, loadApiConfig } from '@rupturegrid/config';
import type { ApiConfig } from '@rupturegrid/config';
import { assertValidTargetOriginCredentialPolicy } from '@rupturegrid/engine';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';

export function loadConfig(): ApiConfig {
  return loadApiConfig();
}

/**
 * Phase 16 (ADR-0024 §4/§18): builds the SERVER-OWNED platform
 * target-origin credential policy from validated API configuration —
 * the signing-capable classification plus the validated grant map.
 * The policy is platform configuration maintained OUTSIDE the target-
 * registration request path: a registration request can never grant
 * itself credentials. Validated fail-fast at startup (subset + grant
 * referential integrity), then handed explicitly to registration,
 * definition validation, and run-creation snapshot freezes.
 */
export function buildTargetOriginCredentialPolicy(config: ApiConfig): TargetOriginCredentialPolicy {
  const policy: TargetOriginCredentialPolicy = {
    signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
    originGrants: config.TARGET_ORIGIN_CREDENTIAL_GRANTS,
  };
  assertValidTargetOriginCredentialPolicy(policy);
  return policy;
}
