// =====================================================================
// RuptureGrid v1.0 — typed API client for the web app (Phase 6)
// =====================================================================
// Server-side fetch layer over the accepted Phase 3/4/5 API surfaces.
// Design rules:
//   - The API origin is environment-driven (RUPTUREGRID_API_ORIGIN,
//     default http://127.0.0.1:3001). No hard-coded machine specifics.
//   - Every read maps failures to typed results; pages render honest
//     error states instead of guessing or inventing content.
//   - No credentials exist for this surface (all APIs are read/derive
//     only in v1); nothing secret is sent, and the API returns only
//     already-redacted content (ADR-0012).
//   - Response shapes are typed locally and validated minimally where
//     a wrong shape would produce fabricated-looking UI.

const API_ORIGIN = (process.env['RUPTUREGRID_API_ORIGIN'] ?? 'http://127.0.0.1:3001').replace(
  /\/$/,
  '',
);

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export class ApiUnreachableError extends Error {
  public constructor(detail: string) {
    super(detail);
    this.name = 'ApiUnreachableError';
  }
}

/** One page of an offset-paginated list response. */
export interface OffsetPage<T> {
  readonly total: number;
  readonly count: number;
  readonly offset: number;
  readonly items: T[];
}

const JSON_HEADERS: Readonly<Record<string, string>> = { accept: 'application/json' };

async function requestJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, { headers: JSON_HEADERS, cache: 'no-store' });
  } catch (error) {
    throw new ApiUnreachableError(
      error instanceof Error ? error.message : 'network error contacting the API process',
    );
  }
  if (!response.ok) {
    // The API's error envelope is { error: { code, message } }; fall back
    // to the bare status when the body is not that shape.
    let code = `HTTP_${response.status}`;
    let message = `API returned HTTP ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as Record<string, unknown>)['error'] === 'object'
      ) {
        const envelope = (body as { error: Record<string, unknown> })['error'];
        if (typeof envelope['code'] === 'string') {
          code = envelope['code'];
        }
        if (typeof envelope['message'] === 'string') {
          message = envelope['message'];
        }
      }
    } catch {
      // Non-JSON error body: keep the status-based message.
    }
    throw new ApiRequestError(response.status, code, message);
  }
  return response.json() as Promise<unknown>;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiRequestError(502, 'UNEXPECTED_RESPONSE', `unexpected API response at ${path}`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

// ---------------------------------------------------------------------
// Runs (Phase 3 Control Plane)
// ---------------------------------------------------------------------

export type RunState =
  | 'CREATED'
  | 'SNAPSHOT_PINNED'
  | 'DISPATCHING'
  | 'RUNNING'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface RunSummary {
  readonly runId: string;
  readonly state: RunState;
  readonly createdAt: string;
  readonly terminalAt: string | null;
  readonly failureReason: string | null;
  readonly cancelRequestedAt: string | null;
  readonly snapshotContentHash: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly experimentId: string;
  readonly experimentName: string;
  readonly targetDisplayName: string;
  readonly targetEnvironment: string;
  readonly stepCount: number;
  readonly succeededStepCount: number;
  readonly failedStepCount: number;
  readonly indeterminateStepCount: number;
  readonly findingCount: number;
}

export interface ExperimentSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly revisionCount: number;
  readonly runCount: number;
  readonly latestRevision: {
    readonly id: string;
    readonly revisionNumber: number;
    readonly createdAt: string;
    readonly target: { readonly displayName: string; readonly environment: string };
  } | null;
}

export async function listRuns(limit: number, offset: number): Promise<OffsetPage<RunSummary>> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs?limit=${limit}&offset=${offset}`),
    'runs',
  );
  const runs = body['runs'];
  if (!Array.isArray(runs)) {
    throw new ApiRequestError(502, 'UNEXPECTED_RESPONSE', 'unexpected API response at runs[]');
  }
  return {
    total: num(body['total'], runs.length),
    count: num(body['count'], runs.length),
    offset: num(body['offset'], offset),
    items: runs as RunSummary[],
  };
}

export async function listExperiments(limit = 50): Promise<OffsetPage<ExperimentSummary>> {
  const body = expectRecord(await requestJson(`/api/v1/experiments?limit=${limit}`), 'experiments');
  const experiments = body['experiments'];
  if (!Array.isArray(experiments)) {
    throw new ApiRequestError(
      502,
      'UNEXPECTED_RESPONSE',
      'unexpected API response at experiments[]',
    );
  }
  return {
    total: num(body['total'], experiments.length),
    count: experiments.length,
    offset: 0,
    items: experiments as ExperimentSummary[],
  };
}

export interface RunStepSummary {
  readonly id: string;
  readonly sequence: number;
  readonly name: string;
  readonly state: string;
  readonly intentOutcome: string | null;
  readonly sideEffectKnowledge: string | null;
  readonly attemptCount: number;
  readonly error: string | null;
  readonly dispatchState: string;
  readonly leaseOwnerId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: string;
}

export interface RunStatus {
  readonly runId: string;
  readonly state: RunState;
  readonly snapshotHash: string;
  readonly canonicalization: string;
  readonly cancelRequestedAt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly terminalAt: string | null;
  readonly steps: RunStepSummary[];
  readonly indeterminateInvocationCount: number;
}

export async function getRunStatus(runId: string): Promise<RunStatus> {
  const body = expectRecord(await requestJson(`/api/v1/runs/${runId}`), 'run');
  return {
    runId: String(body['runId'] ?? runId),
    state: body['state'] as RunState,
    snapshotHash: String(body['snapshotHash'] ?? ''),
    canonicalization: String(body['canonicalization'] ?? ''),
    cancelRequestedAt: (body['cancelRequestedAt'] as string | null) ?? null,
    failureReason: (body['failureReason'] as string | null) ?? null,
    createdAt: String(body['createdAt'] ?? ''),
    terminalAt: (body['terminalAt'] as string | null) ?? null,
    steps: Array.isArray(body['steps']) ? (body['steps'] as RunStepSummary[]) : [],
    indeterminateInvocationCount: num(body['indeterminateInvocationCount'], 0),
  };
}

// ---------------------------------------------------------------------
// Evidence + analysis (Phase 4)
// ---------------------------------------------------------------------

export interface RawObservation {
  readonly id: string;
  readonly chainIndex: number;
  readonly kind: string;
  readonly adapterKind: string | null;
  readonly schemaVersion: string;
  readonly observedAt: string;
  readonly payload: unknown;
  readonly redactionApplied: boolean;
  readonly redactionPolicyVersion: string;
  readonly truncated: boolean;
  readonly contentHash: string;
  readonly prevContentHash: string | null;
  readonly origin: string;
  readonly writerOwnerId: string;
  readonly writerFencingToken: string | null;
  readonly createdAt: string;
}

export async function listObservations(
  runId: string,
  kind?: string,
): Promise<{ readonly count: number; readonly observations: RawObservation[] }> {
  const query = kind === undefined || kind === '' ? '' : `?kind=${encodeURIComponent(kind)}`;
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/observations${query}`),
    'observations',
  );
  const observations = body['observations'];
  return {
    count: num(body['count'], 0),
    observations: Array.isArray(observations) ? (observations as RawObservation[]) : [],
  };
}

export interface IntegrityReport {
  readonly runId: string;
  readonly observationCount: number;
  readonly headContentHash: string | null;
  readonly recomputedHeadHash: string | null;
  readonly chainValid: boolean;
  readonly contentHashesValid: boolean;
  readonly problems: ReadonlyArray<{
    readonly chainIndex: number;
    readonly kind: string;
    readonly detail: string;
  }>;
  readonly guarantee: string;
  readonly verifiedAt: string;
}

export async function getRunIntegrity(runId: string): Promise<IntegrityReport> {
  const body = expectRecord(await requestJson(`/api/v1/runs/${runId}/integrity`), 'integrity');
  return {
    runId: String(body['runId'] ?? runId),
    observationCount: num(body['observationCount'], 0),
    headContentHash: (body['headContentHash'] as string | null) ?? null,
    recomputedHeadHash: (body['recomputedHeadHash'] as string | null) ?? null,
    chainValid: body['chainValid'] === true,
    contentHashesValid: body['contentHashesValid'] === true,
    problems: Array.isArray(body['problems'])
      ? (body['problems'] as IntegrityReport['problems'])
      : [],
    guarantee: String(body['guarantee'] ?? ''),
    verifiedAt: String(body['verifiedAt'] ?? ''),
  };
}

export interface InvariantEvaluationSummary {
  readonly id: string;
  readonly subjectKey: string;
  readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
  readonly reason: string;
  readonly evidenceSetHash: string;
  readonly completenessBasis: string;
  readonly details: unknown;
  readonly createdAt: string;
}

export interface InvariantBatch {
  readonly batchId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly evaluationCount: number;
  readonly evaluations: InvariantEvaluationSummary[];
}

export async function listInvariantEvaluations(runId: string): Promise<InvariantBatch[]> {
  const body = expectRecord(await requestJson(`/api/v1/runs/${runId}/invariants`), 'invariants');
  const batches = body['batches'];
  if (!Array.isArray(batches)) {
    return [];
  }
  return batches as InvariantBatch[];
}

// ---------------------------------------------------------------------
// Forensics (Phase 5)
// ---------------------------------------------------------------------

export interface FindingSummary {
  readonly id: string;
  readonly invariantEvaluationId: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly findingRuleVersion: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly title: string;
  readonly summary: string;
  readonly inputFingerprint: string;
  readonly details: unknown;
  readonly provenScope: unknown;
  readonly uncertainScope: unknown;
  readonly proofReferences: ReadonlyArray<{
    readonly subject: string;
    readonly sourceId: string;
    readonly role: string;
    readonly position: number;
  }>;
  readonly createdAt: string;
}

export async function listRunFindings(runId: string): Promise<OffsetPage<FindingSummary>> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/findings`),
    'findings',
  );
  const findings = body['findings'];
  if (!Array.isArray(findings)) {
    throw new ApiRequestError(502, 'UNEXPECTED_RESPONSE', 'unexpected API response at findings[]');
  }
  return {
    total: num(body['count'], findings.length),
    count: findings.length,
    offset: 0,
    items: findings as FindingSummary[],
  };
}

export interface GlobalFindingSummary {
  readonly id: string;
  readonly runId: string;
  readonly runState: RunState;
  readonly runCreatedAt: string;
  readonly experimentName: string;
  readonly targetDisplayName: string;
  readonly targetEnvironment: string;
  readonly snapshotContentHash: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly findingRuleVersion: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
}

export async function listFindings(
  limit: number,
  offset: number,
): Promise<OffsetPage<GlobalFindingSummary>> {
  const body = expectRecord(
    await requestJson(`/api/v1/findings?limit=${limit}&offset=${offset}`),
    'findings',
  );
  const findings = body['findings'];
  if (!Array.isArray(findings)) {
    throw new ApiRequestError(502, 'UNEXPECTED_RESPONSE', 'unexpected API response at findings[]');
  }
  return {
    total: num(body['total'], findings.length),
    count: findings.length,
    offset: num(body['offset'], offset),
    items: findings as GlobalFindingSummary[],
  };
}

export interface TimelineEntry {
  readonly entryKind: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly orderingBasis: 'sequence' | 'wall_clock' | 'unordered_overlap';
  readonly sequenceNumber: number;
  readonly occurredAt: string;
  readonly timeMeaning: string;
  readonly subjectKey: string | null;
  readonly details: unknown;
}

export interface TimelinePage {
  readonly count: number;
  readonly nextCursor: string | null;
  readonly entries: TimelineEntry[];
}

export async function getTimelinePage(
  runId: string,
  params: { readonly limit: number; readonly cursor?: string; readonly subjectKey?: string },
): Promise<TimelinePage> {
  const search = new URLSearchParams({ limit: String(params.limit) });
  if (params.cursor !== undefined && params.cursor !== '') {
    search.set('cursor', params.cursor);
  }
  if (params.subjectKey !== undefined && params.subjectKey !== '') {
    search.set('subjectKey', params.subjectKey);
  }
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/timeline?${search.toString()}`),
    'timeline',
  );
  const entries = body['entries'];
  return {
    count: num(body['count'], 0),
    nextCursor: typeof body['nextCursor'] === 'string' ? body['nextCursor'] : null,
    entries: Array.isArray(entries) ? (entries as TimelineEntry[]) : [],
  };
}

export interface FindingProof {
  readonly id: string;
  readonly runId: string;
  readonly subjectKey: string;
  readonly reasonCode: string;
  readonly title: string;
  readonly summary: string;
  readonly invariantKey: string;
  readonly evaluatorVersion: string;
  readonly findingRuleVersion: string;
  readonly inputFingerprint: string;
  readonly details: unknown;
  readonly provenScope: unknown;
  readonly uncertainScope: unknown;
  readonly createdAt: string;
  readonly evaluation: {
    readonly id: string;
    readonly runId: string;
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly subjectKey: string;
    readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUABLE';
    readonly reason: string;
    readonly evidenceSetHash: string;
    readonly completenessBasis: string;
    readonly details: unknown;
    readonly sourceObservationHashes: readonly string[];
    readonly normalizedEventIds: readonly string[];
    readonly causalRelationshipIds: readonly string[];
  };
  readonly evidenceRefs: ReadonlyArray<{
    readonly subject: string;
    readonly sourceId: string;
    readonly role: string;
    readonly position: number;
  }>;
}

export async function getFindingProof(runId: string, findingId: string): Promise<FindingProof> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/findings/${findingId}`),
    'finding',
  );
  return body as unknown as FindingProof;
}

export interface ReproductionDefinition {
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly targetModeRequirement: string | null;
  readonly credentialRefs: readonly string[];
  readonly invariantBindings: unknown;
  readonly acceptanceExpectations: unknown;
  readonly createdAt: string;
}

export async function getReproductionDefinition(runId: string): Promise<ReproductionDefinition> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/reproduction-definition`),
    'reproduction',
  );
  return {
    runId: String(body['runId'] ?? runId),
    snapshotId: String(body['snapshotId'] ?? ''),
    snapshotContentHash: String(body['snapshotContentHash'] ?? ''),
    targetModeRequirement: (body['targetModeRequirement'] as string | null) ?? null,
    credentialRefs: Array.isArray(body['credentialRefs'])
      ? (body['credentialRefs'] as string[])
      : [],
    invariantBindings: body['invariantBindings'] ?? null,
    acceptanceExpectations: body['acceptanceExpectations'] ?? null,
    createdAt: String(body['createdAt'] ?? ''),
  };
}

export interface RunComparison {
  readonly baseRunId: string;
  readonly comparisonRunId: string;
  readonly snapshotComparison: {
    readonly baseSnapshotId: string;
    readonly comparisonSnapshotId: string;
    readonly baseContentHash: string;
    readonly comparisonContentHash: string;
    readonly sameIntent: boolean;
  };
  readonly invariants: ReadonlyArray<{
    readonly invariantKey: string;
    readonly evaluatorVersion: string;
    readonly baseVerdict: string;
    readonly comparisonVerdict: string;
    readonly verdictsDiffer: boolean;
    readonly baseEvaluationId: string;
    readonly comparisonEvaluationId: string;
  }>;
}

export async function compareRuns(runId: string, otherRunId: string): Promise<RunComparison> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/compare/${otherRunId}`),
    'compare',
  );
  return body as unknown as RunComparison;
}

export interface CausalRelationship {
  readonly id: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly relationKind: string;
  readonly basis: string;
  readonly evidence: unknown;
}

export async function listCausalRelationships(
  runId: string,
): Promise<{ readonly count: number; readonly relationships: CausalRelationship[] }> {
  const body = expectRecord(
    await requestJson(`/api/v1/runs/${runId}/forensics/causal-relationships`),
    'relationships',
  );
  const relationships = body['relationships'];
  return {
    count: num(body['count'], 0),
    relationships: Array.isArray(relationships) ? (relationships as CausalRelationship[]) : [],
  };
}

export interface NormalizedEventSummary {
  readonly id: string;
  readonly eventType: string;
  readonly subjectKey: string | null;
  readonly payload: unknown;
  readonly normalizerName: string;
  readonly normalizerVersion: string;
  readonly inputHash: string;
  readonly origin: string;
  readonly sourceObservationHashes: readonly string[];
  readonly primaryObservationIndex: number | null;
  readonly createdAt: string;
}

export async function listNormalizedEvents(
  runId: string,
): Promise<{ readonly count: number; readonly events: NormalizedEventSummary[] }> {
  const body = expectRecord(await requestJson(`/api/v1/runs/${runId}/events`), 'events');
  const events = body['events'];
  return {
    count: num(body['count'], 0),
    events: Array.isArray(events) ? (events as NormalizedEventSummary[]) : [],
  };
}
