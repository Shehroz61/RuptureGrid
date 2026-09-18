// =====================================================================
// RuptureGrid v1.0 — Findings (Phase 6)
// =====================================================================
// Every persisted Finding across runs, newest first. Each row carries
// the run context an investigator needs to decide where to look.
// Findings are deterministic conclusions; nothing here ranks or
// decorates them.

import Link from 'next/link';
import type { Route } from 'next';
import { listFindings, ApiUnreachableError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page';
import { MonoValue } from '@/components/ui/meta';
import { EmptyState, ErrorState } from '@/components/ui/state-block';
import { formatTimestamp, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function FindingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ offset?: string }>;
}) {
  const params = await searchParams;
  const rawOffset = Number(params.offset ?? '0');
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const page = await listFindings(PAGE_SIZE, offset);
    const shownFrom = page.total === 0 ? 0 : offset + 1;
    const shownTo = offset + page.count;

    return (
      <>
        <PageHeader
          question="Which business rules were demonstrably violated, with what proof?"
          title="Findings"
        />
        {page.total === 0 ? (
          <EmptyState
            title="No findings exist"
            detail="A finding is derived only when an invariant evaluation FAILs on real evidence. No failure means no findings — this list is never seeded with examples."
          />
        ) : (
          <>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Reason</th>
                    <th scope="col">Title</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Invariant</th>
                    <th scope="col">Run</th>
                    <th scope="col">Experiment</th>
                    <th scope="col">Target</th>
                    <th scope="col">Derived</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((finding) => (
                    <tr key={finding.id}>
                      <td>
                        <Badge label={finding.reasonCode} semantic="fail" mono />
                      </td>
                      <td>
                        <Link href={`/runs/${finding.runId}/findings/${finding.id}` as Route}>
                          {finding.title}
                        </Link>
                      </td>
                      <td>
                        <MonoValue value={shortenId(finding.subjectKey, 14)} />
                      </td>
                      <td>
                        <span className="mono-cell">
                          {finding.invariantKey} ({finding.evaluatorVersion})
                        </span>
                      </td>
                      <td>
                        <Link href={`/runs/${finding.runId}` as Route}>
                          <span className="mono-cell">{shortenId(finding.runId, 8)}</span>
                        </Link>
                      </td>
                      <td>{finding.experimentName}</td>
                      <td>
                        {finding.targetDisplayName}
                        <span
                          className="mono-cell"
                          style={{ display: 'block', color: 'var(--text-muted)' }}
                        >
                          {finding.targetEnvironment}
                        </span>
                      </td>
                      <td>
                        <span className="mono-cell">{formatTimestamp(finding.createdAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="page-nav" aria-label="Findings pages">
              <span>
                Showing {shownFrom}–{shownTo} of {page.total} findings
              </span>
              {offset > 0 ? (
                <Link
                  className="button"
                  href={`/findings?offset=${Math.max(0, offset - PAGE_SIZE)}` as Route}
                >
                  ← Previous
                </Link>
              ) : (
                <span className="button" aria-disabled="true">
                  ← Previous
                </span>
              )}
              {shownTo < page.total ? (
                <Link className="button" href={`/findings?offset=${offset + PAGE_SIZE}` as Route}>
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
          question="Which business rules were demonstrably violated, with what proof?"
          title="Findings"
        />
        <ErrorState
          title={
            error instanceof ApiUnreachableError
              ? 'Control Plane API unreachable'
              : 'Findings unavailable'
          }
          error={error instanceof Error ? error : new Error(String(error))}
        />
      </>
    );
  }
}
