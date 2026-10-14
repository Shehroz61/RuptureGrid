// =====================================================================
// RuptureGrid Phase 17 — Checkpoint C: run-owned anchor authority
// (ADR-0026 §5/§11 fenced terminal-owner derivation)
// =====================================================================
// The run-owned anchor is derived ONLY from durable proof — never from
// wall clock, DB row order, "latest response", an in-memory value, or the
// `StepInvocation.responseBody` convenience column (which is explicitly
// NOT an authority). The derivation is a pure read:
//
//   1. the frozen snapshot's `steps` array locates `setupStep` by EXACT
//      name and its 0-based ordinal (§11 step 1–3);
//   2. the `ExperimentStepRun` is loaded by `(runId, sequence = ordinal)`
//      — the existing unique key, never a name search across runs — and
//      must carry EXACTLY the setup step name, terminal state `SUCCEEDED`
//      and a non-null lease owner (§11 step 4–5);
//   3. `StepInvocation` rows of that stepRun are the authoritative
//      invocation set (§11 step 6); a response observation is a candidate
//      ONLY when its `invocationId` joins one of them;
//   4. `RawObservation` rows are joined by `(runId, stepRunId,
//      invocationId)` with writer attribution `(writerOwnerId,
//      writerFencingToken)`, and the candidate envelope must be an
//      accepted, 2xx, non-truncated `http_response_observed` row whose
//      stored body parses as a JSON object with a string `scopeField`
//      value and a non-negative SAFE-INTEGER `generationField` value
//      (§5 rule 1, §11 step 8);
//   5. the authoritative candidate set is the TERMINAL-OWNER generation —
//      the stepRun's `(leaseOwnerId, fencingToken)` at its fenced terminal
//      `SUCCEEDED` write. Candidates from another generation are STALE
//      candidates: preserved, compared, never order-selected (§5 rules
//      2–5 and the S-1..S-17 matrix).
//
// Outcomes:
//   * ESTABLISHED — one distinct `(scope, generation)` pair across the
//     terminal-owner candidates, at least one carrying
//     `scope === declaredScope` (exact equality, no coercion), and every
//     stale generation is positively CONVERGENT (identical pair) or does
//     not exist;
//   * ANCHOR_UNPROVEN — no valid terminal-owner response (setup never
//     fenced `SUCCEEDED`, response missing/truncated/redacted/malformed,
//     declared scope never observed, ...): every declared subject takes
//     the missing/NOT_EVALUABLE path;
//   * EVIDENCE_CONFLICT — stale generations with conflicting responses,
//     sent attempts with unknowable outcomes, or unattributable recorded
//     invocations: fail closed. A recorded pre-send invocation set is
//     NEVER immateriality proof (the F-1 rule: a persisted set is not a
//     closed world); the only independent pre-send proof v1 accepts is
//     `experiment_step_run.executingAt IS NULL`, under which no stale
//     generation can exist at all. Null-safe attribution: a generation
//     with a NULL fencing token can never be proven immaterial.
//
// The anchor tuple carries durable row identities/hashes and fencing
// facts only: `(observedScope, observedGeneration, setupStep,
// setupStepRunId, setupObservationHashes, anchorFencing)`. Observed
// provenance is immutable intent evidence; nothing here is business truth.

import type { PrismaClient } from '@rupturegrid/control-db';
import type { RunScopeDeclaration } from '@rupturegrid/engine';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const REDACTED_MARKER = '[Redacted]';

/** A named, bounded evidence gap (anchor/capture/attribution kinds). */
export interface RunAnchorGap {
  readonly kind: string;
  readonly detail: string;
}

/** One stale-generation comparison record (preserved, never erased). */
export interface StaleAnchorGeneration {
  readonly leaseOwnerId: string | null;
  readonly fencingToken: string | null;
  readonly transportStages: readonly string[];
  readonly candidatePairs: readonly { readonly scope: string; readonly generation: number }[];
  readonly disposition: 'CONVERGENT' | 'CONFLICT';
}

/** The proven run-owned anchor tuple (§5 rule 5). */
export interface RunAnchor {
  readonly observedScope: string;
  readonly observedGeneration: number;
  readonly setupStep: string;
  readonly setupStepRunId: string;
  /** Content hashes of the valid terminal-owner candidates (sorted). */
  readonly setupObservationHashes: readonly string[];
  /**
   * Content hashes of OTHER accepted response observations of the run
   * carrying the same `(scope, generation)` pair — corroborating
   * submission provenance, never the gate (§4/§11).
   */
  readonly corroboratingSubmissionHashes: readonly string[];
  readonly anchorFencing: {
    readonly leaseOwnerId: string;
    readonly fencingToken: string;
  };
}

export type RunAnchorState = 'ESTABLISHED' | 'ANCHOR_UNPROVEN' | 'EVIDENCE_CONFLICT';

export interface RunAnchorDerivationResult {
  readonly state: RunAnchorState;
  /** Non-null iff `state === 'ESTABLISHED'`. */
  readonly anchor: RunAnchor | null;
  /** Bounded machine-readable reason (never a business claim). */
  readonly reason: string;
  readonly gaps: readonly RunAnchorGap[];
  readonly staleGenerations: readonly StaleAnchorGeneration[];
}

/** Reads the run's FROZEN `runScopeBinding` (null for legacy snapshots). */
export async function loadFrozenRunScopeBinding(
  prisma: PrismaClient,
  runId: string,
): Promise<RunScopeDeclaration | null> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (run === null) {
    return null;
  }
  const content = run.snapshot.content as { target?: unknown };
  const target = isRecord(content.target) ? content.target : {};
  const binding = target['runScopeBinding'];
  if (!isRecord(binding)) {
    return null;
  }
  return binding as unknown as RunScopeDeclaration;
}

/** The frozen step ordinal of `setupStep` in the snapshot's steps array. */
async function frozenSetupStepOrdinal(
  prisma: PrismaClient,
  runId: string,
  setupStep: string,
): Promise<number | null> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: { snapshot: { select: { content: true } } },
  });
  if (run === null) {
    return null;
  }
  const content = run.snapshot.content as { steps?: unknown };
  const steps = Array.isArray(content.steps) ? content.steps : [];
  const ordinal = steps.findIndex((step) => isRecord(step) && step['name'] === setupStep);
  return ordinal < 0 ? null : ordinal;
}

interface ResponseCandidate {
  readonly rowId: string;
  readonly contentHash: string;
  readonly invocationId: string;
  readonly scope: string;
  readonly generation: number;
  readonly writerOwnerId: string;
  readonly writerFencingToken: bigint | null;
}

const unproven = (
  reason: string,
  gap: RunAnchorGap,
  staleGenerations: readonly StaleAnchorGeneration[] = [],
): RunAnchorDerivationResult => ({
  state: 'ANCHOR_UNPROVEN',
  anchor: null,
  reason,
  gaps: [gap],
  staleGenerations,
});

/**
 * Validates one stored response observation as an anchor candidate. A
 * `gap` string means the row LOOKS like a setup response (accepted 2xx
 * invocation observation) but cannot anchor — truncated, redacted,
 * malformed or type-invalid; `null`/`null` means it is not a candidate
 * at all (S-10/S-11/S-13: gaps, never matches).
 */
function validateCandidateRow(
  row: {
    id: string;
    contentHash: string;
    invocationId: string | null;
    origin: string;
    truncated: boolean;
    payload: unknown;
    writerOwnerId: string;
    writerFencingToken: bigint | null;
  },
  binding: RunScopeDeclaration,
): { readonly candidate: ResponseCandidate | null; readonly gap: string | null } {
  const payload = row.payload;
  if (!isRecord(payload) || payload['kind'] !== 'invocation') {
    return { candidate: null, gap: null };
  }
  const http = isRecord(payload['http']) ? payload['http'] : {};
  const transport = isRecord(payload['transport']) ? payload['transport'] : {};
  const responseStatus = http['responseStatus'];
  if (typeof responseStatus !== 'number' || responseStatus < 200 || responseStatus >= 300) {
    return { candidate: null, gap: null }; // Not an accepted response.
  }
  if (row.origin !== 'OBSERVED' || row.truncated || transport['responseTruncated'] === true) {
    return { candidate: null, gap: 'anchor-response-truncated-or-unobserved' };
  }
  const responseBody = http['responseBody'];
  if (row.invocationId === null || typeof responseBody !== 'string') {
    return { candidate: null, gap: 'anchor-response-body-missing' };
  }
  // ADR-0026 §11 rule 1 (S-11): only a redacted DECISIVE FIELD is a gap.
  // Redaction is normal, expected evidence discipline (ADR-0012 / ADR-0023
  // §4: `*token*`-named and secret-shaped values are masked BEFORE
  // persistence), so an unrelated redacted SIBLING inside the same response
  // body must not invalidate an otherwise fully usable anchor response —
  // the anchor reads its own declared scope/generation fields, both of which
  // are checked for the marker individually below.
  if (responseBody.trim() === REDACTED_MARKER) {
    return { candidate: null, gap: 'anchor-response-redacted' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody) as unknown;
  } catch {
    return { candidate: null, gap: 'anchor-response-malformed' };
  }
  if (!isRecord(parsed)) {
    return { candidate: null, gap: 'anchor-response-malformed' };
  }
  const scopeValue = parsed[binding.scopeField];
  const generationValue = parsed[binding.generationField];
  if (scopeValue === REDACTED_MARKER || generationValue === REDACTED_MARKER) {
    return { candidate: null, gap: 'anchor-response-redacted' };
  }
  if (typeof scopeValue !== 'string' || scopeValue === '') {
    return { candidate: null, gap: 'anchor-response-scope-field-invalid' };
  }
  if (
    typeof generationValue !== 'number' ||
    !Number.isSafeInteger(generationValue) ||
    generationValue < 0
  ) {
    return { candidate: null, gap: 'anchor-response-generation-field-invalid' };
  }
  return {
    candidate: {
      rowId: row.id,
      contentHash: row.contentHash,
      invocationId: row.invocationId,
      scope: scopeValue,
      generation: generationValue,
      writerOwnerId: row.writerOwnerId,
      writerFencingToken: row.writerFencingToken,
    },
    gap: null,
  };
}

/**
 * Content hashes of OTHER accepted response observations of the run
 * carrying exactly the anchor `(scope, generation)` pair — corroborating
 * submission provenance (never the gate). Bounded to response
 * observations other than the setup stepRun's own.
 */
async function corroboratingSubmissionHashes(
  prisma: PrismaClient,
  runId: string,
  setupStepRunId: string,
  observedScope: string,
  observedGeneration: number,
  binding: RunScopeDeclaration,
): Promise<readonly string[]> {
  const rows = await prisma.rawObservation.findMany({
    where: { runId, kind: 'http_response_observed' },
    select: {
      stepRunId: true,
      invocationId: true,
      contentHash: true,
      origin: true,
      truncated: true,
      payload: true,
      writerOwnerId: true,
      writerFencingToken: true,
    },
  });
  const invocationRows =
    rows.length === 0
      ? []
      : await prisma.stepInvocation.findMany({
          where: { stepRun: { runId } },
          select: { id: true },
        });
  const invocationIds = new Set(invocationRows.map((row) => row.id));
  const hashes = new Set<string>();
  for (const row of rows) {
    if (row.stepRunId === setupStepRunId) {
      continue;
    }
    if (row.invocationId === null || !invocationIds.has(row.invocationId)) {
      continue;
    }
    const validated = validateCandidateRow({ ...row, id: row.contentHash }, binding);
    const candidate = validated.candidate;
    if (
      candidate !== null &&
      candidate.scope === observedScope &&
      candidate.generation === observedGeneration
    ) {
      hashes.add(row.contentHash);
    }
  }
  return [...hashes].sort();
}

/**
 * Derives the run-owned anchor (§§5/11) from durable rows only. Pure
 * read: repeat calls on the same durable state return identical results.
 */
export async function deriveRunAnchor(
  prisma: PrismaClient,
  runId: string,
  binding: RunScopeDeclaration,
): Promise<RunAnchorDerivationResult> {
  const ordinal = await frozenSetupStepOrdinal(prisma, runId, binding.setupStep);
  if (ordinal === null) {
    return unproven('SETUP_STEP_UNKNOWN', {
      kind: 'anchor-setup-step-unknown',
      detail: `runScope.setupStep "${binding.setupStep}" names no frozen step of the run's snapshot`,
    });
  }
  const stepRun = await prisma.experimentStepRun.findUnique({
    where: { runId_sequence: { runId, sequence: ordinal } },
    select: {
      id: true,
      name: true,
      state: true,
      leaseOwnerId: true,
      fencingToken: true,
    },
  });
  if (stepRun === null) {
    return unproven('SETUP_STEP_RUN_MISSING', {
      kind: 'anchor-step-run-missing',
      detail: `no experiment_step_run exists at (runId, sequence=${String(ordinal)})`,
    });
  }
  if (stepRun.name !== binding.setupStep) {
    return unproven('SETUP_STEP_NAME_MISMATCH', {
      kind: 'anchor-step-name-mismatch',
      detail: `stepRun at sequence ${String(ordinal)} is named "${stepRun.name}", not "${binding.setupStep}"`,
    });
  }
  if (stepRun.state !== 'SUCCEEDED') {
    return unproven('SETUP_STEP_NOT_SUCCEEDED', {
      kind: 'anchor-step-not-succeeded',
      detail: `setup stepRun terminal state is ${stepRun.state}, not SUCCEEDED — stale observations alone never anchor a run (S-7/S-8)`,
    });
  }
  if (stepRun.leaseOwnerId === null) {
    return unproven('SETUP_STEP_OWNER_MISSING', {
      kind: 'anchor-owner-generation-missing',
      detail:
        'setup stepRun reached SUCCEEDED without a fenced lease owner — no authoritative generation exists',
    });
  }
  const terminalOwner = stepRun.leaseOwnerId;
  const terminalToken = stepRun.fencingToken;

  const invocations = await prisma.stepInvocation.findMany({
    where: { stepRunId: stepRun.id },
    select: {
      id: true,
      transportStage: true,
      writtenByOwner: true,
      writtenByFencingToken: true,
    },
  });
  const invocationIds = new Set(invocations.map((invocation) => invocation.id));

  const observations = await prisma.rawObservation.findMany({
    where: { runId, stepRunId: stepRun.id, kind: 'http_response_observed' },
    orderBy: { chainIndex: 'asc' },
    select: {
      id: true,
      contentHash: true,
      invocationId: true,
      origin: true,
      truncated: true,
      payload: true,
      writerOwnerId: true,
      writerFencingToken: true,
    },
  });

  const gaps: RunAnchorGap[] = [];
  const candidates: ResponseCandidate[] = [];
  for (const row of observations) {
    // §11 step 6: candidates join the stepRun's authoritative invocation
    // set; an observation that joins nothing is not a candidate.
    if (row.invocationId === null || !invocationIds.has(row.invocationId)) {
      continue;
    }
    const validated = validateCandidateRow(row, binding);
    if (validated.gap !== null) {
      gaps.push({ kind: validated.gap, detail: `observation ${row.contentHash.slice(0, 16)}` });
      continue;
    }
    if (validated.candidate !== null) {
      candidates.push(validated.candidate);
    }
  }

  const attributionMatches = (candidate: ResponseCandidate): boolean =>
    candidate.writerOwnerId === terminalOwner &&
    candidate.writerFencingToken !== null &&
    candidate.writerFencingToken === terminalToken;

  const ownerCandidates = candidates.filter(attributionMatches);
  if (ownerCandidates.length === 0) {
    gaps.push({
      kind: 'anchor-response-missing',
      detail:
        'no valid accepted setup response is attributed to the terminal owner generation — ANCHOR_UNPROVEN (stale observations alone never anchor a run)',
    });
    return {
      state: 'ANCHOR_UNPROVEN',
      anchor: null,
      reason: 'NO_VALID_TERMINAL_OWNER_RESPONSE',
      gaps,
      staleGenerations: [],
    };
  }
  if (ownerCandidates.every((candidate) => candidate.scope !== binding.declaredScope)) {
    return unproven('DECLARED_SCOPE_NOT_OBSERVED', {
      kind: 'anchor-declared-scope-not-observed',
      detail: `no terminal-owner candidate carries the declared scope "${binding.declaredScope}" — the target did not establish what the run asked`,
    });
  }
  const pairKeys = new Set(ownerCandidates.map((candidate) => pairKey(candidate)));
  if (pairKeys.size > 1) {
    return {
      state: 'EVIDENCE_CONFLICT',
      anchor: null,
      reason: 'TERMINAL_OWNER_CONFLICT',
      gaps: [
        {
          kind: 'anchor-owner-generation-conflict',
          detail: `terminal-owner candidates disagree on (scope, generation): ${[...pairKeys].sort().join(', ')}`,
        },
      ],
      staleGenerations: [],
    };
  }
  const anchorPair = ownerCandidates[0] as ResponseCandidate;
  const observedScope = anchorPair.scope;
  const observedGeneration = anchorPair.generation;

  // ---- Stale generations (§5 question B; S-2..S-6a, S-16, case 65). ----
  const staleGenerations: StaleAnchorGeneration[] = [];
  let conflict = false;
  const staleGroups = new Map<string, typeof invocations>();
  for (const invocation of invocations) {
    const isOwner =
      invocation.writtenByOwner === terminalOwner &&
      invocation.writtenByFencingToken !== null &&
      invocation.writtenByFencingToken === terminalToken;
    if (isOwner) {
      continue;
    }
    const key = `${invocation.writtenByOwner ?? '\u0000null'}|${invocation.writtenByFencingToken?.toString() ?? '\u0000null'}`;
    const list = staleGroups.get(key) ?? [];
    list.push(invocation);
    staleGroups.set(key, list);
  }
  for (const group of staleGroups.values()) {
    const first = group[0] as (typeof invocations)[number];
    const groupCandidates = candidates.filter(
      (candidate) =>
        candidate.writerOwnerId === first.writtenByOwner &&
        candidate.writerFencingToken !== null &&
        candidate.writerFencingToken === first.writtenByFencingToken,
    );
    const sentInvocations = group.filter(
      (invocation) =>
        invocation.transportStage !== null &&
        invocation.transportStage !== 'PREPARED' &&
        invocation.transportStage !== 'CONNECTING',
    );
    // S-2/S-4 convergence: every valid candidate of the stale generation
    // carries EXACTLY the anchor pair, and every SENT invocation of the
    // generation has its own valid (anchor-pair) response — otherwise the
    // generation's outcome is unknowable (S-16) or the recorded set is
    // merely pre-send without the independent executingAt proof (S-6).
    const allConvergent =
      groupCandidates.length > 0 &&
      groupCandidates.every(
        (candidate) =>
          candidate.scope === observedScope && candidate.generation === observedGeneration,
      ) &&
      sentInvocations.every((invocation) =>
        groupCandidates.some((candidate) => candidate.invocationId === invocation.id),
      );
    const disposition: StaleAnchorGeneration['disposition'] = allConvergent
      ? 'CONVERGENT'
      : 'CONFLICT';
    if (disposition === 'CONFLICT') {
      conflict = true;
    }
    staleGenerations.push({
      leaseOwnerId: first.writtenByOwner,
      fencingToken: first.writtenByFencingToken?.toString() ?? null,
      transportStages: group
        .flatMap((invocation) =>
          invocation.transportStage === null ? [] : [invocation.transportStage],
        )
        .sort(),
      candidatePairs: groupCandidates.map((candidate) => ({
        scope: candidate.scope,
        generation: candidate.generation,
      })),
      disposition,
    });
  }
  if (conflict) {
    return {
      state: 'EVIDENCE_CONFLICT',
      anchor: null,
      reason: 'STALE_GENERATION_CONFLICT',
      gaps: [
        {
          kind: 'anchor-stale-generation-conflict',
          detail:
            'at least one stale setup generation has a conflicting or unknowable outcome — EVIDENCE_CONFLICT (never resolved by order or timestamps)',
        },
      ],
      staleGenerations,
    };
  }

  // ---- Corroborating submissions (provenance only; never the gate). ----
  const corroborating = await corroboratingSubmissionHashes(
    prisma,
    runId,
    stepRun.id,
    observedScope,
    observedGeneration,
    binding,
  );

  return {
    state: 'ESTABLISHED',
    anchor: {
      observedScope,
      observedGeneration,
      setupStep: binding.setupStep,
      setupStepRunId: stepRun.id,
      setupObservationHashes: [
        ...new Set(ownerCandidates.map((candidate) => candidate.contentHash)),
      ].sort(),
      corroboratingSubmissionHashes: corroborating,
      anchorFencing: {
        leaseOwnerId: terminalOwner,
        fencingToken: terminalToken.toString(),
      },
    },
    reason: 'ANCHOR_ESTABLISHED',
    gaps,
    staleGenerations,
  };
}

function pairKey(candidate: ResponseCandidate): string {
  return `${candidate.scope}|${String(candidate.generation)}`;
}
