// =====================================================================
// RuptureGrid v1.0 — Run detail: Comparison (Phase 6)
// =====================================================================
// Post-fix replay comparison (incident-replay §6): side-by-side
// verdicts for the same invariant across two runs. The backend refuses
// cross-intent comparisons (snapshot content hashes must match); the
// UI surfaces that refusal honestly instead of hiding it. Expected
// evidence differences (timestamps, identities) are stated, not shown
// as errors.

import Link from 'next/link';
import type { Route } from 'next';
import { compareRuns, listRuns, ApiRequestError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MonoValue } from '@/components/ui/meta';
import { EmptyState } from '@/components/ui/state-block';
import { verdictClass, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

export default async function RunComparisonPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ runId: string }>;
  readonly searchParams: Promise<{ other?: string }>;
}) {
  const { runId } = await params;
  const query = await searchParams;
  const otherRunId = query.other ?? '';

  return (
    <Section
      title="Run comparison"
      description="Compare this run with another run of the SAME frozen intent (equal snapshot content hash). Differences in verdicts for the same invariant are the signal; differences in evidence are expected."
    >
      <ComparisonForm runId={runId} otherRunId={otherRunId} />
      {otherRunId !== '' ? <ComparisonResult runId={runId} otherRunId={otherRunId} /> : null}
    </Section>
  );
}

async function ComparisonForm({
  runId,
  otherRunId,
}: {
  readonly runId: string;
  readonly otherRunId: string;
}) {
  const page = await listRuns(200, 0);
  const candidates = page.items.filter((run) => run.runId !== runId);
  if (candidates.length === 0) {
    return (
      <EmptyState
        title="No other runs to compare with"
        detail="Comparison needs a second run. Execute the experiment again (a post-fix replay re-runs the same snapshot)."
      />
    );
  }
  return (
    <form className="timeline-filters" method="get" action={`/runs/${runId}/comparison`}>
      <label>
        Compare with
        <select name="other" defaultValue={otherRunId}>
          <option value="">— select a run —</option>
          {candidates.map((run) => (
            <option key={run.runId} value={run.runId}>
              {shortenId(run.runId, 8)} · {run.experimentName} r{run.revisionNumber} · {run.state}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button">
        Compare
      </button>
    </form>
  );
}

async function ComparisonResult({
  runId,
  otherRunId,
}: {
  readonly runId: string;
  readonly otherRunId: string;
}) {
  let comparison: Awaited<ReturnType<typeof compareRuns>> | null = null;
  let snapshotMismatch = false;
  let failure: string | null = null;
  try {
    comparison = await compareRuns(runId, otherRunId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'SNAPSHOT_MISMATCH') {
      snapshotMismatch = true;
    } else if (error instanceof Error) {
      failure = error.message;
    } else {
      failure = String(error);
    }
  }

  if (failure !== null) {
    return <EmptyState title="Comparison failed" detail={failure} />;
  }
  if (snapshotMismatch) {
    return (
      <div className="state-block state-block-error" role="alert">
        <p className="state-block-title">Different execution intent — comparison refused</p>
        <p className="state-block-detail">
          These two runs were pinned to different snapshots (different content hashes). Verdict
          differences would not be meaningful, so the API refuses the comparison. A post-fix replay
          re-runs the SAME snapshot; create the second run from the same experiment revision.
        </p>
      </div>
    );
  }
  if (comparison === null) {
    return null;
  }

  return (
    <>
      <dl className="meta-list">
        <div className="meta-item">
          <dt>Base snapshot</dt>
          <dd>
            <MonoValue value={comparison.snapshotComparison.baseContentHash} />
          </dd>
        </div>
        <div className="meta-item">
          <dt>Comparison snapshot</dt>
          <dd>
            <MonoValue value={comparison.snapshotComparison.comparisonContentHash} />
          </dd>
        </div>
        <div className="meta-item">
          <dt>Intent</dt>
          <dd>
            <Badge
              label={
                comparison.snapshotComparison.sameIntent ? 'same snapshot — comparable' : 'MISMATCH'
              }
              semantic={comparison.snapshotComparison.sameIntent ? 'pass' : 'fail'}
            />
          </dd>
        </div>
      </dl>
      <div className="data-table-wrap" style={{ marginTop: 'var(--sp-3)' }}>
        <table className="data-table compare-table">
          <thead>
            <tr>
              <th scope="col">Invariant</th>
              <th scope="col">Evaluator</th>
              <th scope="col">This run</th>
              <th scope="col">
                <Link href={`/runs/${otherRunId}` as Route}>{shortenId(otherRunId, 8)}</Link>
              </th>
              <th scope="col">Signal</th>
            </tr>
          </thead>
          <tbody>
            {comparison.invariants.map((invariant) => (
              <tr key={invariant.invariantKey}>
                <td>
                  <span className="mono-cell">{invariant.invariantKey}</span>
                </td>
                <td>
                  <span className="mono-cell">{invariant.evaluatorVersion}</span>
                </td>
                <td className="verdict-cell">
                  <Badge
                    label={invariant.baseVerdict}
                    semantic={verdictClass(invariant.baseVerdict)}
                  />
                </td>
                <td className="verdict-cell">
                  <Badge
                    label={invariant.comparisonVerdict}
                    semantic={verdictClass(invariant.comparisonVerdict)}
                  />
                </td>
                <td>
                  {invariant.verdictsDiffer ? (
                    <Badge label="verdicts differ" semantic="uncertain" />
                  ) : (
                    <span>verdicts agree</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="compare-differ-note">
        An ABSENT verdict means the invariant was evaluated in only one run — reported honestly,
        never filled in. Evaluation selection is each run&apos;s latest persisted evaluation per
        invariant.
      </p>
    </>
  );
}
