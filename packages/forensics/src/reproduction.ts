// =====================================================================
// RuptureGrid v1.0 — reproduction definitions (Phase 5, incident-replay
// §1)
// =====================================================================
// A ReproductionDefinition is the durable, self-describing description
// of "how to intentionally execute the same experiment intent again",
// derived deterministically from the run's FROZEN snapshot (ADR-0010):
//
//   - The RunSnapshot stays the authoritative intent; this row BINDS
//     run → snapshot → requirements. It never copies the snapshot
//     document (no duplicate truth), only the extracted replay
//     requirements an investigator asks for first.
//   - Target processing mode requirement (incident-replay §1.2) is
//     extracted from the snapshot's own step bodies (the mode-setting
//     step's documented `mode` field) — never guessed, never read from
//     live target state.
//   - Credential REQUIREMENTS are the snapshot's reference names only —
//     values never enter this package (ADR-0012).
//   - Invariant bindings + acceptance expectations come from the run's
//     OWN persisted evaluations (its deterministic verdicts are the
//     expectation for a same-intent replay). Nothing is invented.
//
// Determinism: the same run always yields the same semantic row.
// Idempotency: unique(runId) converges; a hash mismatch against an
// existing row is REFUSED (history is never rewritten, §45).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@rupturegrid/control-db';
import { INV_IZ_1_KEY, INV_IZ_1_TITLE, INV_IZ_1_DESCRIPTION } from '@rupturegrid/evidence';
import { isUniqueConstraint } from './p2002.js';

export class ReproductionDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReproductionDefinitionError';
  }
}

/** Documented invariant identities (only INV-IZ-1 exists in v1). */
const INVARIANT_IDENTITIES: Record<string, { title: string; description: string }> = {
  [INV_IZ_1_KEY]: { title: INV_IZ_1_TITLE, description: INV_IZ_1_DESCRIPTION },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ReproductionDerivationInput {
  readonly runId: string;
  readonly snapshot: {
    readonly id: string;
    readonly contentHash: string;
    readonly document: unknown;
  };
  readonly evaluations: ReadonlyArray<{
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly verdict: string;
  }>;
}

export interface DerivedReproductionDefinition {
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly targetModeRequirement: string | null;
  readonly credentialRefs: readonly string[];
  readonly invariantBindings: Record<string, unknown>;
  readonly acceptanceExpectations: Record<string, unknown>;
}

/**
 * Extracts the required target processing mode from the snapshot's own
 * steps: the documented mode-setter body `{ "mode": "VULNERABLE" |
 * "SECURE" }`. Absent/unknown shapes yield null — honestly absent,
 * never guessed.
 */
export function extractTargetModeRequirement(document: unknown): string | null {
  if (!isRecord(document) || !Array.isArray(document['steps'])) {
    return null;
  }
  for (const step of document['steps']) {
    if (!isRecord(step) || !isRecord(step['action'])) {
      continue;
    }
    const body = step['action']['body'];
    if (typeof body !== 'string' || body.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed) && typeof parsed['mode'] === 'string') {
        const mode = parsed['mode'];
        return mode === 'VULNERABLE' || mode === 'SECURE' ? mode : null;
      }
    } catch {
      // Not JSON: not a mode-setting body.
    }
  }
  return null;
}

/**
 * Pure derivation of the reproduction definition from the run's own
 * durable truth (snapshot + persisted evaluations). Deterministic:
 * identical inputs yield identical outputs (sorted, stable shapes).
 */
export function deriveReproductionDefinition(
  input: ReproductionDerivationInput,
): DerivedReproductionDefinition {
  const document = input.snapshot.document;

  // Credential REQUIREMENTS: the snapshot's reference names (sorted —
  // the snapshot already stores them sorted; re-sort defensively
  // without mutating).
  const target = isRecord(document) && isRecord(document['target']) ? document['target'] : null;
  const credentialRefs =
    target === null || !Array.isArray(target['credentialRefs'])
      ? []
      : [...target['credentialRefs']]
          .filter((ref): ref is string => typeof ref === 'string')
          .sort();

  // Invariant bindings: the run's own distinct (key, version) pairs,
  // deterministically ordered. Identity metadata comes from the
  // documented identities; unknown keys carry no invented metadata.
  const seen = new Set<string>();
  const bindings: Array<Record<string, unknown>> = [];
  for (const evaluation of [...input.evaluations].sort((a, b) =>
    a.invariantKey < b.invariantKey
      ? -1
      : a.invariantKey > b.invariantKey
        ? 1
        : a.evaluatorVersion < b.evaluatorVersion
          ? -1
          : a.evaluatorVersion > b.evaluatorVersion
            ? 1
            : 0,
  )) {
    const bindingKey = `${evaluation.invariantKey}@${evaluation.evaluatorVersion}`;
    if (seen.has(bindingKey)) {
      continue;
    }
    seen.add(bindingKey);
    const identity = INVARIANT_IDENTITIES[evaluation.invariantKey];
    bindings.push({
      invariantKey: evaluation.invariantKey,
      evaluatorVersion: evaluation.evaluatorVersion,
      title: identity?.title ?? null,
      description: identity?.description ?? null,
    });
  }

  // Acceptance expectations: the run's own verdict classes per bound
  // invariant — what a same-intent replay of this run must reproduce.
  const verdictsByKey = new Map<string, Set<string>>();
  for (const evaluation of input.evaluations) {
    const bindingKey = `${evaluation.invariantKey}@${evaluation.evaluatorVersion}`;
    const set = verdictsByKey.get(bindingKey) ?? new Set<string>();
    set.add(evaluation.verdict);
    verdictsByKey.set(bindingKey, set);
  }
  const expectations = bindings.map((binding) => ({
    invariantKey: binding['invariantKey'],
    evaluatorVersion: binding['evaluatorVersion'],
    expectedVerdicts: [
      ...(verdictsByKey.get(
        `${String(binding['invariantKey'])}@${String(binding['evaluatorVersion'])}`,
      ) ?? []),
    ].sort(),
  }));

  return {
    runId: input.runId,
    snapshotId: input.snapshot.id,
    snapshotContentHash: input.snapshot.contentHash,
    targetModeRequirement: extractTargetModeRequirement(document),
    credentialRefs,
    invariantBindings: { invariants: bindings },
    acceptanceExpectations: { expectations },
  };
}

/**
 * Persists the derived definition. unique(runId) makes repeat
 * derivation converge on the existing row; a differing content hash
 * against an existing row is REFUSED (append-only history, §45). A
 * concurrent first derivation of the same run loses the creation race
 * to the P2002 on `reproduction_definition_runId_key` — matched
 * precisely (never a generic swallow) and converged on the winner's
 * row OUTSIDE any aborted transaction (§21/§71); an unrelated P2002
 * still propagates.
 */
export async function persistReproductionDefinition(
  prisma: PrismaClient,
  derived: DerivedReproductionDefinition,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.reproductionDefinition.findUnique({
    where: { runId: derived.runId },
    select: { id: true, snapshotContentHash: true },
  });
  if (existing !== null) {
    return converge(existing, derived);
  }
  try {
    const row = await prisma.reproductionDefinition.create({
      data: {
        id: randomUUID(),
        runId: derived.runId,
        snapshotId: derived.snapshotId,
        snapshotContentHash: derived.snapshotContentHash,
        targetModeRequirement: derived.targetModeRequirement,
        credentialRefs: [...derived.credentialRefs],
        invariantBindings: derived.invariantBindings as object,
        acceptanceExpectations: derived.acceptanceExpectations as object,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (error) {
    if (!isUniqueConstraint(error, ['runId'], 'reproduction_definition_runId_key')) {
      throw error;
    }
    // Lost a creation race with a concurrent derivation of the same
    // run: converge on the winner's row. The snapshot is fixed at run
    // creation, so the winner's semantic row is the one this
    // derivation would have written — a differing hash is still
    // refused, never silently accepted.
    const winner = await prisma.reproductionDefinition.findUnique({
      where: { runId: derived.runId },
      select: { id: true, snapshotContentHash: true },
    });
    if (winner === null) {
      throw error;
    }
    return converge(winner, derived);
  }
}

/** Append-only check against an existing row (§45): same snapshot or refusal. */
function converge(
  existing: { id: string; snapshotContentHash: string },
  derived: DerivedReproductionDefinition,
): { id: string; created: boolean } {
  if (existing.snapshotContentHash !== derived.snapshotContentHash) {
    throw new ReproductionDefinitionError(
      `run ${derived.runId} already has a reproduction definition bound to snapshot ` +
        `${existing.snapshotContentHash}; refusing to rebind (history is append-only)`,
    );
  }
  return { id: existing.id, created: false };
}
