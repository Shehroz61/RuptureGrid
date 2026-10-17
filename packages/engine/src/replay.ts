// =====================================================================
// RuptureGrid v1.1 Phase 18 — snapshot-pinned replay (ADR-0019 Decision 4;
// incident-replay §3; ADR-0010)
// =====================================================================
// A replay is a NEW run from a STORED snapshot — never a rewrite of the
// original run's history, never a modified snapshot disguised as replay.
//
//   validateReplayBinding — fail-closed pre-execution validation of the
//     stored snapshot against CURRENT platform truth: the target binding
//     (registration still exists, frozen origin still registered,
//     environment still executable), the credential REFERENCE
//     authorization (snapshot refs ⊆ registration refs ∩ CURRENT
//     platform grants — rotation/removal of a grant fails here, before
//     anything durable happens), and invariant-version availability
//     (the frozen kinds/registry versions must still be accepted —
//     unavailable versions fail closed; v1 declares no silent
//     successor substitution, incident-replay §8).
//   createRunFromSnapshot — the validated snapshot yields a new run row
//     (new id) referencing the EXISTING snapshot row (no new snapshot,
//     no content rewrite — the same `snapshotContentHash`), with fresh
//     step rows built from the frozen steps. The ADR-0026 §13 writer
//     protocol (per-run advisory lock + provenance revision advance in
//     the same transaction) is identical to createRun's.
//
// What this module does NOT do (honest limits, incident-replay §4):
//   - It does not detect rotation of secret VALUES: snapshots persist
//     reference NAMES only (ADR-0012), and no value fingerprint is
//     persisted in v1 — a rotated value behind a still-authorized ref
//     resolves at request time like any run. A MISSING value fails
//     pre-send (CredentialResolutionError → FAILED step → exit 3), never
//     silently. The pre-execution grant check above is the replay-time
//     fail-fast for removed/rotated-away AUTHORIZATION.
//   - It verifies canonical content integrity without rewriting frozen
//     intent (ADR-0010). Corrupt content or shape fails closed.
//   - It never touches another run's rows: every write is keyed by the
//     new run id. Historical observations, evaluations, and findings
//     are structurally unreachable from here.

import { randomUUID } from 'node:crypto';
import { canonicalizeAndHash, CANONICALIZATION_ALGORITHM } from './canonicalize.js';
import type { PrismaClient } from '@rupturegrid/control-db';
import type { TargetEnvironment } from '@rupturegrid/shared';
import { EXECUTION_ENGINE_VERSION } from '@rupturegrid/shared';
import type { CreatedRun } from './run-create.js';
import { RunCreationError } from './run-create.js';
import type { RunSnapshotDocument } from './types.js';
import {
  ACCEPTED_REGISTRY_VERSIONS,
  BUSINESS_INVARIANT_KINDS,
} from './generic-invariant-registry.js';
import type { TargetOriginCredentialPolicy } from './credential-authorization.js';
import {
  assertCredentialRefsAuthorized,
  DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY,
} from './credential-authorization.js';
import {
  acquireRunLock,
  advanceProvenanceRevision,
  PROVENANCE_TRANSACTION_MAX_WAIT_MS,
  PROVENANCE_TRANSACTION_TIMEOUT_MS,
} from './truth-input-head.js';

/** Bounded provenance-writer transaction (writer protocol, ADR-0026 §13). */
const PROVENANCE_TX = {
  timeout: PROVENANCE_TRANSACTION_TIMEOUT_MS,
  maxWait: PROVENANCE_TRANSACTION_MAX_WAIT_MS,
} as const;

/**
 * Frozen evaluation domain. Legacy Fintech snapshots encode their built-in
 * invariant contract through the engine version + contract kind, rather than
 * the later generic bindings array. Never infer bindings from observed rows
 * or mutable definitions, and never add metadata to historical snapshots.
 */
export function frozenInvariantKeys(document: RunSnapshotDocument): string[] {
  if (Array.isArray(document.target.invariantBindings)) {
    return [...new Set(document.target.invariantBindings.map((binding) => binding.key))].sort();
  }
  if (
    document.engineVersion === EXECUTION_ENGINE_VERSION &&
    document.target.contractKind === 'DEMO_FINTECH_WEBHOOK' &&
    document.target.manifestEvidencePolicy === undefined
  ) {
    // phase3-execution-v1's accepted built-in analysis contract (Phases 4/9).
    return ['INV-DF-1', 'INV-DF-2', 'INV-IZ-1'];
  }
  return [];
}

export class ReplayValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReplayValidationError';
  }
}

/** The validated facts a replay run is created from (all durable truth). */
export interface ReplayBinding {
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly origin: string;
  readonly credentialRefs: readonly string[];
  /** Bound invariant keys of the frozen snapshot (the exit domain). */
  readonly invariantKeys: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fail-closed pre-execution validation of a stored snapshot for replay.
 * Reads only; creates nothing, executes nothing, contacts no target.
 * Every failure names the binding problem without secret values.
 */
export async function validateReplayBinding(
  prisma: PrismaClient,
  snapshotId: string,
  /**
   * The CURRENT server-owned platform credential policy. Grant drift
   * since the original freeze fails NEW replays closed (no new run is
   * created); historical runs keep their frozen policy and are never
   * re-consulted. Defaults to the fail-closed deny-all policy.
   */
  credentialPolicy?: TargetOriginCredentialPolicy,
): Promise<ReplayBinding> {
  const policy = credentialPolicy ?? DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY;
  const snapshot = await prisma.runSnapshot.findUnique({
    where: { id: snapshotId },
    include: { revision: { include: { target: { include: { origins: true } } } } },
  });
  if (snapshot === null) {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} does not exist — replay refuses to invent intent`,
    );
  }
  const document = snapshot.content as unknown as RunSnapshotDocument;
  if (!isRecord(document) || !isRecord(document['target']) || !Array.isArray(document['steps'])) {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} carries a corrupt document — replay refuses to repair frozen intent`,
    );
  }
  if (
    snapshot.canonicalization !== CANONICALIZATION_ALGORITHM ||
    document.canonicalization !== CANONICALIZATION_ALGORITHM ||
    canonicalizeAndHash(document).hash !== snapshot.contentHash
  ) {
    throw new ReplayValidationError(
      'snapshot content does not match its canonical hash — replay refuses tampered intent',
    );
  }
  if (document.engineVersion !== EXECUTION_ENGINE_VERSION) {
    throw new ReplayValidationError(
      'snapshot requires a missing or unsupported execution engine version — replay refuses silent engine substitution',
    );
  }
  const frozen = document.target;
  if (typeof frozen['targetId'] !== 'string' || typeof frozen['origin'] !== 'string') {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} carries no frozen target binding — replay refuses to guess one`,
    );
  }
  const targetId = frozen['targetId'] as string;
  const frozenOrigin = frozen['origin'] as string;

  // ---- Target binding: the registration must still exist. ----
  const target = snapshot.revision.target;
  if (target.id !== targetId) {
    // The snapshot's frozen target differs from the revision's live
    // binding (registration replacement under a frozen revision):
    // fail closed — replay never rebinds intent to another target.
    throw new ReplayValidationError(
      `snapshot ${snapshotId} is bound to target ${targetId} but its revision now binds ${target.id} — replay refuses to rebind frozen intent`,
    );
  }

  if (target.environment !== frozen.environment || target.contractKind !== frozen.contractKind) {
    throw new ReplayValidationError(
      'current target environment or contract differs from the frozen binding — replay is refused',
    );
  }

  // ---- Environment authorization (ADR-0011, defense in depth with the
  // worker's own pre-execution check): production stays denied. ----
  const environment = frozen['environment'] as string;
  if (environment === 'PRODUCTION') {
    throw new ReplayValidationError(
      'production-classified targets are denied for experiment execution in v1 (ADR-0011)',
    );
  }
  if (environment !== 'LOCAL_DEVELOPMENT' && environment !== 'STAGING') {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} carries an unknown environment "${environment.slice(0, 40)}" — replay refuses to execute under it`,
    );
  }

  // ---- Destination authorization: the frozen origin must still be a
  // registered origin of the bound target (security-boundaries §3).
  // A removed origin fails closed — replay never follows intent to an
  // unauthorized destination. ----
  const registeredOrigins = target.origins.map((entry) => entry.origin);
  if (!registeredOrigins.includes(frozenOrigin)) {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} is pinned to origin ${frozenOrigin}, which is no longer a registered origin of target "${target.displayName}" — replay refuses an unauthorized destination`,
    );
  }

  // ---- Credential REFERENCE authorization (ADR-0024 §5–§6, CURRENT
  // policy): every frozen ref must still be platform-authorized for the
  // frozen origin. A removed grant (rotation-away of authorization)
  // fails here, before anything durable happens. Names only, never
  // values (R-13). ----
  const frozenRefs = Array.isArray(frozen['credentialRefs'])
    ? (frozen['credentialRefs'] as unknown[]).filter(
        (ref): ref is string => typeof ref === 'string',
      )
    : [];
  const unregistered = frozenRefs.filter((ref) => !target.credentialRefs.includes(ref));
  if (unregistered.length > 0) {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} requires credential reference(s) ${unregistered.map((ref) => `"${ref}"`).join(', ')} no longer registered on target "${target.displayName}" — replay refuses to execute (missing or rotated credentials fail closed)`,
    );
  }
  try {
    assertCredentialRefsAuthorized(policy, [frozenOrigin], frozenRefs);
  } catch (error) {
    throw new ReplayValidationError(
      `snapshot ${snapshotId} requires credential reference(s) no longer platform-authorized for ${frozenOrigin} — replay refuses to execute (missing or rotated credentials fail closed): ${error instanceof Error ? error.message.slice(0, 300) : 'authorization failed'}`,
    );
  }

  // ---- Invariant-version availability (incident-replay §8): every
  // frozen generic binding's kind + registry version must still be
  // accepted. Unavailable versions fail closed — v1 never silently
  // substitutes engines or successor evaluators. ----
  const frozenBindings = Array.isArray(frozen['invariantBindings'])
    ? (frozen['invariantBindings'] as unknown[])
    : [];
  for (const binding of frozenBindings) {
    if (!isRecord(binding) || typeof binding['key'] !== 'string') {
      throw new ReplayValidationError(
        `snapshot ${snapshotId} carries a malformed invariant binding — replay refuses to guess its evaluation authority`,
      );
    }
    const kind = binding['kind'];
    const registryVersion = binding['registryVersion'];
    if (
      typeof kind !== 'string' ||
      !(Object.values(BUSINESS_INVARIANT_KINDS) as readonly string[]).includes(kind)
    ) {
      throw new ReplayValidationError(
        `snapshot ${snapshotId} binds invariant "${binding['key']}" of unavailable kind ${JSON.stringify(kind ?? null)} — replay refuses to substitute evaluators`,
      );
    }
    if (
      typeof registryVersion !== 'string' ||
      !(ACCEPTED_REGISTRY_VERSIONS as readonly string[]).includes(registryVersion)
    ) {
      throw new ReplayValidationError(
        `snapshot ${snapshotId} binds invariant "${binding['key']}" at unavailable registry version ${JSON.stringify(registryVersion ?? null)} — replay refuses to substitute evaluators`,
      );
    }
  }

  return {
    snapshotId: snapshot.id,
    snapshotContentHash: snapshot.contentHash,
    targetId: target.id,
    targetDisplayName: target.displayName,
    origin: frozenOrigin,
    credentialRefs: [...frozenRefs].sort(),
    invariantKeys: frozenInvariantKeys(document),
  };
}

/**
 * Creates a durable replay run from an EXISTING snapshot row:
 *   1. validate the binding (fail-closed, nothing durable on failure)
 *   2. enforce environment authorization (production DENIED in v1)
 *   3. insert run + step rows in ONE transaction under the per-run
 *      advisory lock (ADR-0026 §13 writer protocol)
 * No new snapshot row is created: the replay run references the stored
 * snapshot id + hash — the same `snapshotContentHash` as the original
 * run. The run ends in SNAPSHOT_PINNED with all steps PENDING/PENDING;
 * marking DISPATCHING and enqueueing are the caller's next step (the
 * CLI orchestrator owns that, exactly like the `run` flow).
 */
export async function createRunFromSnapshot(
  prisma: PrismaClient,
  snapshotId: string,
  credentialPolicy?: TargetOriginCredentialPolicy,
): Promise<CreatedRun> {
  const binding = await validateReplayBinding(prisma, snapshotId, credentialPolicy);

  const snapshot = await prisma.runSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
  const document = snapshot.content as unknown as RunSnapshotDocument;
  const steps: readonly { readonly name: string }[] = document.steps;

  const environment: TargetEnvironment = document.target
    .environment as unknown as TargetEnvironment;
  if (environment === 'PRODUCTION') {
    throw new RunCreationError(
      'production-classified targets are denied for experiment execution in v1 (ADR-0011)',
    );
  }

  // The run id is generated here so the per-run advisory lock can be
  // taken FIRST, before the run's own truth-bearing rows (the run row
  // and its step rows) are written — and `P` advanced for them in the
  // SAME transaction (ADR-0026 §13 writer protocol).
  const runId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await acquireRunLock(tx, runId);
    await tx.experimentRun.create({
      data: {
        id: runId,
        snapshotId: binding.snapshotId,
        state: 'SNAPSHOT_PINNED',
      },
    });
    await tx.experimentStepRun.createMany({
      data: steps.map((step, sequence) => ({
        runId,
        sequence,
        name: step.name,
        state: 'PENDING',
        dispatchState: 'PENDING',
      })),
    });
    await advanceProvenanceRevision(tx, runId);
  }, PROVENANCE_TX);

  const stepRuns = await prisma.experimentStepRun.findMany({
    where: { runId },
    orderBy: { sequence: 'asc' },
    select: { id: true },
  });

  return {
    runId,
    snapshotId: binding.snapshotId,
    contentHash: binding.snapshotContentHash,
    stepRunIds: stepRuns.map((step) => step.id),
  };
}
