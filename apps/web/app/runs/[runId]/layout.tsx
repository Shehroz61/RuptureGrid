// =====================================================================
// RuptureGrid v1.0 — run detail layout (Phase 6)
// =====================================================================
// Loads the run's durable state once and mounts the shared header +
// view tabs, so every investigation view keeps run context. All data
// comes from the Control Plane API; a failed load renders an honest
// error, never placeholder content.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { getRunStatus, ApiRequestError, ApiUnreachableError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { ErrorState, NotFoundState } from '@/components/ui/state-block';
import { formatTimestamp, runStateClass } from '@/lib/semantics';
import { RunTabBar } from './tab-bar';

export const dynamic = 'force-dynamic';

export default async function RunLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  try {
    const run = await getRunStatus(runId);
    return (
      <>
        <header className="page-header">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link href="/runs">Runs</Link>
            <span className="breadcrumb-sep">/</span>
            <span className="mono-cell">{run.runId}</span>
          </nav>
          <p className="page-question">
            What happened in this execution — and did business rules hold?
          </p>
          <h1 className="page-title">
            Run <span className="mono-value">{run.runId}</span>
          </h1>
          <div className="page-meta">
            <span>
              <Badge label={run.state.replaceAll('_', ' ')} semantic={runStateClass(run.state)} />
            </span>
            <span>
              Experiment snapshot{' '}
              <span className="mono-value" title={run.snapshotHash}>
                {run.snapshotHash.slice(0, 16)}…
              </span>
            </span>
            <span>
              created <span className="mono-value">{formatTimestamp(run.createdAt)}</span>
            </span>
            <span>
              terminal <span className="mono-value">{formatTimestamp(run.terminalAt)}</span>
            </span>
            {run.indeterminateInvocationCount > 0 ? (
              <span>
                <Badge
                  label={`${run.indeterminateInvocationCount} INDETERMINATE invocation${run.indeterminateInvocationCount === 1 ? '' : 's'}`}
                  semantic="uncertain"
                />
              </span>
            ) : null}
          </div>
          {run.failureReason !== null ? (
            <p className="step-error" style={{ marginTop: 'var(--sp-2)' }}>
              Run failure: {run.failureReason}
            </p>
          ) : null}
        </header>
        <RunTabBar runId={run.runId} />
        {children}
      </>
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return (
        <NotFoundState
          title="Run not found"
          detail={`The Control Plane API has no run ${runId}.`}
          backHref="/runs"
          backLabel="← Back to runs"
        />
      );
    }
    return (
      <ErrorState
        title={
          error instanceof ApiUnreachableError ? 'Control Plane API unreachable' : 'Run unavailable'
        }
        error={error instanceof Error ? error : new Error(String(error))}
      />
    );
  }
}
