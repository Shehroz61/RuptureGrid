// =====================================================================
// RuptureGrid v1.1 Phase 17 — ONE authoritative scenario validation path
// (B3 repair: SCENARIOS-VALIDATE-NOT-AUTHORITATIVE)
// =====================================================================
// The independent Phase 17 audit found `scenarios validate` exited 0
// for experiment content the real `run` path rejects: a literal
// Authorization secret, `retryPolicy: AGGRESSIVE`, `repeat: 0`,
// `concurrency: 0`, an invalid invariant kind, an unknown nested step
// field. The cause: the validate command only ran the closed-envelope
// check and never the engine's AUTHORITATIVE validation, so the two
// commands disagreed about what a valid scenario is.
//
// Repair (repair mandate §17): ONE validation path for BOTH commands.
// `run` already performs — in order — closed-envelope validation →
// target resolution → server-owned credential policy → the engine's
// validateExperimentDocument (which validates steps, credential
// references, and invariant bindings against the frozen/current target
// manifest policy). This module extracts EXACTLY that pre-execution
// prefix of executeScenario into `validateScenarioAuthoritative`, and
// cli.ts's validate command (and runCommand, via the unchanged
// executeScenario prefix) now use it. No copy/paste validation exists:
// anything the run path rejects, validate rejects identically, exit 4,
// BEFORE anything durable (§18: validate may READ the Control DB —
// target registration, origins, manifest, credential refs are needed
// for honest validation — but it creates NO ExperimentDefinition,
// ExperimentRevision, RunSnapshot, ExperimentRun, or StepRun rows, and
// performs NO target HTTP and NO queue dispatch).
//
// Unknown target displayName → TargetResolutionError → exit 4
// (USAGE_ERROR; nothing durable).
//
// Ordering is the audited-facade order of the run flow's first four
// steps: parse/validate envelope → resolve target → validate the
// embedded experiment document (authoritative engine validator). The
// expected result is a normalized, valid result, with NOTHING executed.

import type { PrismaClient } from '@rupturegrid/control-db';
import { validateExperimentDocument } from '@rupturegrid/engine';
import { EXECUTOR_SIGNING_CREDENTIAL_REFS } from '@rupturegrid/config';
import type { TargetOriginCredentialPolicy } from '@rupturegrid/engine';
import { resolveTargetByDisplayName } from './orchestrator.js';
import type { ScenarioDocument } from './scenario.js';
import { scenarioExperimentDocument } from './scenario.js';

export { TargetResolutionError } from './orchestrator.js';

/** The read-only authoritative-validation result (never executed). */
export interface AuthoritativeValidationResult {
  /** The resolved registration id (read-only lookup). */
  readonly targetId: string;
  readonly targetDisplayName: string;
  /** Whether the closed-envelope (cli layer) validation already ran. */
  readonly envelopeValidated: true;
}

/**
 * Validates a scenario document AUTHORITATIVELY — the same steps the
 * run path performs before anything durable:
 *
 *   1. the closed rupturegrid-scenario/v1 envelope (ALREADY applied by
 *      parseScenarioFile/validateScenarioDocument in both commands —
 *      this function receives the validated document);
 *   2. the registered target lookup by displayName (READ-ONLY; unknown
 *      selector → TargetResolutionError → exit 4);
 *   3. the CURRENT SERVER-OWNED credential authorization policy
 *      (validated config; a scenario can never grant authority —
 *      ADR-0024 §4);
 *   4. the ENGINE's authoritative validateExperimentDocument — steps,
 *      header/credential-reference/classification/limits vocabulary and
 *      invariant bindings against the target's frozen manifest policy.
 *
 * NOTHING is executed: no revision, no run, no snapshot, no step row,
 * no target HTTP request, no queue dispatch. The Control-DB reads are
 * honest (per §18 the embedded ExperimentDocument is only honestly
 * validatable against the target's registration/manifest/credential
 * policy).
 */
export async function validateScenarioAuthoritative(options: {
  readonly prisma: PrismaClient;
  readonly scenario: ScenarioDocument;
  /** The validated, server-owned grant policy (cli config / caller). */
  readonly credentialPolicy: TargetOriginCredentialPolicy;
}): Promise<AuthoritativeValidationResult> {
  // ---- Target lookup (read-only, before anything durable). ----
  // Unknown displayName → TargetResolutionError thrown here. The
  // rejection precedes any experiment write — the CLI maps it to
  // exit 4 with zero durable writes (mandate §19).
  const resolved = await resolveTargetByDisplayName(
    options.prisma,
    options.scenario.target.displayName,
  );
  const target = await options.prisma.targetRegistration.findUniqueOrThrow({
    where: { id: resolved.targetId },
    include: { origins: true },
  });

  // ---- The ENGINE'S authoritative experiment validation. ----
  // The same validator, the same target record (frozen manifest),
  // the same SERVER-OWNED policy objects the run path itself passes
  // through createExperiment. Any ExperimentValidationError here is
  // the run path's own rejection surface — mapped by the CLI to exit 4.
  validateExperimentDocument({
    document: scenarioExperimentDocument(options.scenario),
    target,
    credentialPolicy: options.credentialPolicy,
  });

  return {
    targetId: target.id,
    targetDisplayName: target.displayName,
    envelopeValidated: true,
  };
}

/**
 * Builds the CURRENT SERVER-OWNED grant policy from the validated CLI
 * config (validated fail-closed config in packages/config). The
 * platform owns the signing-capable set and the origin grants — a
 * scenario document can never contribute authority (ADR-0024 §4).
 */
export function authoritativeCredentialPolicyFromConfig(config: {
  readonly TARGET_ORIGIN_CREDENTIAL_GRANTS: Record<string, readonly string[]>;
}): TargetOriginCredentialPolicy {
  return {
    signingCredentialRefs: [...EXECUTOR_SIGNING_CREDENTIAL_REFS],
    originGrants: config.TARGET_ORIGIN_CREDENTIAL_GRANTS,
  };
}
