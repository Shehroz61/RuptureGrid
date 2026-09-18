// =====================================================================
// RuptureGrid v1.0 — Experiments (Phase 6)
// =====================================================================
// The versioned experiment definitions runs execute. A definition is
// an artifact, not a form: creating and revising experiments happens
// through the Control Plane API (Phase 3 contract). This view answers
// "what controlled behavior exists, and how often has it run?"

import Link from 'next/link';
import { listExperiments, ApiUnreachableError } from '@/lib/api-client';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState } from '@/components/ui/state-block';
import { formatTimestamp, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

export default async function ExperimentsPage() {
  try {
    const page = await listExperiments(200);
    return (
      <>
        <PageHeader
          question="What controlled behavior has been declared for execution?"
          title="Experiments"
        />
        {page.count === 0 ? (
          <EmptyState
            title="No experiment definitions exist"
            detail="Definitions are created through the Control Plane API (POST /api/v1/experiments) with a registered target. RuptureGrid shows only what actually exists."
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Latest revision</th>
                  <th scope="col">Target</th>
                  <th scope="col">Revisions</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((experiment) => (
                  <tr key={experiment.id}>
                    <td>
                      {experiment.name}
                      {experiment.description !== null ? (
                        <span
                          style={{
                            display: 'block',
                            color: 'var(--text-muted)',
                            fontSize: 'var(--text-xs)',
                          }}
                        >
                          {experiment.description}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {experiment.latestRevision !== null ? (
                        <>
                          <span className="mono-cell">
                            r{experiment.latestRevision.revisionNumber}
                          </span>
                          <span
                            className="mono-cell"
                            style={{ display: 'block', color: 'var(--text-muted)' }}
                          >
                            {shortenId(experiment.latestRevision.id, 8)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {experiment.latestRevision !== null ? (
                        <>
                          {experiment.latestRevision.target.displayName}
                          <span
                            className="mono-cell"
                            style={{ display: 'block', color: 'var(--text-muted)' }}
                          >
                            {experiment.latestRevision.target.environment}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{experiment.revisionCount}</td>
                    <td className="num">
                      {experiment.runCount > 0 ? (
                        <Link href="/runs">{experiment.runCount}</Link>
                      ) : (
                        <span>0</span>
                      )}
                    </td>
                    <td>
                      <span className="mono-cell">{formatTimestamp(experiment.createdAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="compare-differ-note">
          Definitions are append-only artifacts: an edit creates a new revision, and historical runs
          remain pinned to the snapshot of the revision they executed (ADR-0010).
        </p>
      </>
    );
  } catch (error) {
    return (
      <>
        <PageHeader
          question="What controlled behavior has been declared for execution?"
          title="Experiments"
        />
        <ErrorState
          title={
            error instanceof ApiUnreachableError
              ? 'Control Plane API unreachable'
              : 'Experiments unavailable'
          }
          error={error instanceof Error ? error : new Error(String(error))}
        />
      </>
    );
  }
}
