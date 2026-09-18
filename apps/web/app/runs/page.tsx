// =====================================================================
// RuptureGrid v1.0 — Runs (Phase 6)
// =====================================================================
// Question this screen answers (product-design §3): "What experiments
// were executed, and what was the business verdict?" Every column is
// durable backend state. No success percentages, no health scores.

import Link from 'next/link';
import type { Route } from 'next';
import { listRuns, ApiUnreachableError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/state-block';
import { PageHeader } from '@/components/ui/page';
import { formatTimestamp, runStateClass, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

function stateLabel(state: string): string {
  return state.replaceAll('_', ' ');
}

export default async function RunsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ offset?: string }>;
}) {
  const params = await searchParams;
  const rawOffset = Number(params.offset ?? '0');
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const page = await listRuns(PAGE_SIZE, offset);
    const shownFrom = page.total === 0 ? 0 : offset + 1;
    const shownTo = offset + page.count;

    return (
      <>
        <PageHeader
          question="What experiments were executed, and what was the business verdict?"
          title="Runs"
        />
        {page.total === 0 ? (
          <EmptyState
            title="No runs exist yet"
            detail="A run appears here after an experiment is executed against a registered target through the Control Plane API. RuptureGrid shows nothing else — no seeded examples, no demo data."
          />
        ) : (
          <>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Experiment</th>
                    <th scope="col">Target</th>
                    <th scope="col">State</th>
                    <th scope="col">Steps</th>
                    <th scope="col">INDETERMINATE</th>
                    <th scope="col">Findings</th>
                    <th scope="col">Created</th>
                    <th scope="col">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((run) => {
                    const duration =
                      run.terminalAt !== null
                        ? formatDurationLabel(run.createdAt, run.terminalAt)
                        : null;
                    return (
                      <tr key={run.runId}>
                        <td>
                          <Link href={`/runs/${run.runId}` as Route}>
                            <span className="mono-cell">{shortenId(run.runId, 10)}</span>
                          </Link>
                        </td>
                        <td>
                          {run.experimentName}
                          <span className="mono-cell" style={{ display: 'block' }}>
                            revision r{run.revisionNumber}
                          </span>
                        </td>
                        <td>
                          {run.targetDisplayName}
                          <span
                            className="mono-cell"
                            style={{ display: 'block', color: 'var(--text-muted)' }}
                          >
                            {run.targetEnvironment}
                          </span>
                        </td>
                        <td>
                          <Badge
                            label={stateLabel(run.state)}
                            semantic={runStateClass(run.state)}
                          />
                        </td>
                        <td className="num">
                          {run.succeededStepCount}/{run.stepCount}
                          {run.failedStepCount > 0 ? (
                            <span style={{ color: 'var(--verdict-fail)' }}>
                              {' '}
                              ({run.failedStepCount} failed)
                            </span>
                          ) : null}
                        </td>
                        <td className="num">
                          {run.indeterminateStepCount > 0 ? (
                            <Badge
                              label={String(run.indeterminateStepCount)}
                              semantic="uncertain"
                              mono
                            />
                          ) : (
                            <span>0</span>
                          )}
                        </td>
                        <td className="num">
                          {run.findingCount > 0 ? (
                            <Link href={`/runs/${run.runId}/findings` as Route}>
                              {run.findingCount}
                            </Link>
                          ) : (
                            <span>0</span>
                          )}
                        </td>
                        <td>
                          <span className="mono-cell">{formatTimestamp(run.createdAt)}</span>
                        </td>
                        <td className="num">{duration ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="page-nav" aria-label="Run list pages">
              <span>
                Showing {shownFrom}–{shownTo} of {page.total} runs
              </span>
              {offset > 0 ? (
                <Link
                  className="button"
                  href={`/runs?offset=${Math.max(0, offset - PAGE_SIZE)}` as Route}
                  aria-disabled="false"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="button" aria-disabled="true">
                  ← Previous
                </span>
              )}
              {shownTo < page.total ? (
                <Link
                  className="button"
                  href={`/runs?offset=${offset + PAGE_SIZE}` as Route}
                  aria-disabled="false"
                >
                  Next →
                </Link>
              ) : (
                <span className="button" aria-disabled="true">
                  Next →
                </span>
              )}
            </nav>
          </>
        )}
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader
          question="What experiments were executed, and what was the business verdict?"
          title="Runs"
        />
        <ErrorState
          title={
            error instanceof ApiUnreachableError
              ? 'Control Plane API unreachable'
              : 'Run list unavailable'
          }
          error={error instanceof Error ? error : new Error(String(error))}
        />
      </>
    );
  }
}

function formatDurationLabel(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return '—';
  }
  const seconds = (end - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
