// =====================================================================
// RuptureGrid v1.0 — Run detail: Timeline (Phase 6)
// =====================================================================
// The investigation timeline (product-design §4): filtering by
// subject, explicit ordering bases on every row, INDETERMINATE /
// unordered entries as first-class uncertain rows, honest time
// semantics (each row names what its timestamp means), and keyset
// pagination matching the API's composite cursor — no fake infinite
// scroll, no reordering beyond what the backend asserts.

import Link from 'next/link';
import type { Route } from 'next';
import { getTimelinePage, getRunStatus } from '@/lib/api-client';
import { Section } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/state-block';
import { formatTimestamp, orderingBasisLabel, timeMeaningLabel, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const KIND_ORDER_LABELS: Readonly<Record<string, string>> = {
  RUN_TERMINAL_STATE: 'run terminal state',
  STEP_TERMINAL_STATE: 'step terminal state',
  INVOCATION_EXECUTED: 'invocation executed',
  HTTP_REQUEST_OBSERVED: 'HTTP request observed',
  HTTP_RESPONSE_OBSERVED: 'HTTP response observed',
  EXECUTOR_ERROR_OBSERVED: 'executor error observed',
  PROVIDER_PAYMENT_OBSERVED: 'provider payment observed',
  PROVIDER_EVENT_OBSERVED: 'provider event observed',
  WEBHOOK_DELIVERY_OBSERVED: 'webhook delivery observed',
  PROCESSING_ATTEMPT_OBSERVED: 'processing attempt observed',
  FINANCIAL_EFFECT_OBSERVED: 'financial effect observed',
  LEDGER_ENTRY_OBSERVED: 'ledger entry observed',
  TARGET_STATE_OBSERVED: 'target state observed',
  PAYMENT_DELIVERY_OBSERVED: 'payment delivery observed',
  // Phase 9 (docs/controlled-faults.md §6): configured vs activated are
  // separate target-authored facts and stay separate rows.
  FAULT_PLAN_CONFIGURED: 'fault plan configured',
  FAULT_PLAN_ACTIVATED: 'fault plan activated',
  INVARIANT_EVALUATED: 'invariant evaluated',
  FINDING_DERIVED: 'finding derived',
};

function entryKindLabel(kind: string): string {
  return KIND_ORDER_LABELS[kind] ?? kind.toLowerCase().replaceAll('_', ' ');
}

export default async function RunTimelinePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ runId: string }>;
  readonly searchParams: Promise<{ cursor?: string; subjectKey?: string }>;
}) {
  const { runId } = await params;
  const query = await searchParams;
  const subjectKey = query.subjectKey ?? '';
  const cursor = query.cursor ?? '';

  const [run, page] = await Promise.all([
    getRunStatus(runId),
    getTimelinePage(runId, { limit: PAGE_SIZE, cursor, subjectKey }),
  ]);

  const filterHref = (next: { cursor?: string; subjectKey?: string }): string => {
    const search = new URLSearchParams();
    if (next.subjectKey !== undefined && next.subjectKey !== '') {
      search.set('subjectKey', next.subjectKey);
    }
    if (next.cursor !== undefined && next.cursor !== '') {
      search.set('cursor', next.cursor);
    }
    const qs = search.toString();
    return `/runs/${runId}/timeline${qs === '' ? '' : `?${qs}`}`;
  };

  return (
    <Section
      title="Forensic timeline"
      description="Persisted derived entries in the backend's deterministic total order. Every row names its ordering basis and what its timestamp means; concurrent observations are shown as unordered/overlapping — relative order is not asserted."
    >
      <form className="timeline-filters" method="get" action={`/runs/${runId}/timeline`}>
        <label>
          Subject
          <input
            type="text"
            name="subjectKey"
            defaultValue={subjectKey}
            placeholder="e.g. a providerPaymentId"
            size={40}
          />
        </label>
        <button type="submit" className="button">
          Apply filter
        </button>
        {subjectKey !== '' ? <Link href={filterHref({})}>Clear filter</Link> : null}
      </form>

      {run.indeterminateInvocationCount > 0 ? (
        <div className="note-box">
          <p>
            This run contains {run.indeterminateInvocationCount} INDETERMINATE invocation
            {run.indeterminateInvocationCount === 1 ? '' : 's'}. Timeline rows derived from such
            invocations are marked explicitly — their remote effects were not observable, and that
            uncertainty is part of the record.
          </p>
        </div>
      ) : null}

      {page.entries.length === 0 ? (
        <EmptyState
          title="No timeline entries match"
          detail={
            subjectKey !== ''
              ? `No entries carry subject "${subjectKey}". Clear the filter or use a different subject key (for example the run's providerPaymentId).`
              : 'The forensic timeline is derived by the forensics pipeline. If this run has settled, trigger POST /api/v1/runs/{id}/forensics/derive.'
          }
        />
      ) : (
        <>
          <ol className="timeline-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {page.entries.map((entry, index) => {
              const uncertain =
                entry.orderingBasis === 'unordered_overlap' || entry.timeMeaning !== 'execution';
              return (
                <li
                  key={`${entry.sourceKind}-${entry.sourceId}-${entry.entryKind}-${index}`}
                  className={`timeline-row${uncertain ? ' timeline-row-uncertain' : ''}`}
                >
                  <span className="timeline-time">
                    {formatTimestamp(entry.occurredAt)}
                    <span style={{ display: 'block', color: 'var(--text-faint)' }}>
                      {timeMeaningLabel(entry.timeMeaning)}
                    </span>
                  </span>
                  <span className="timeline-kind">
                    <span className="kind-label">{entryKindLabel(entry.entryKind)}</span>
                    <span style={{ display: 'block', color: 'var(--text-faint)' }}>
                      source: {entry.sourceKind.toLowerCase().replaceAll('_', ' ')}
                    </span>
                  </span>
                  <span className="timeline-subject">
                    {entry.subjectKey !== null ? (
                      <span className="subject-value">{entry.subjectKey}</span>
                    ) : (
                      <span className="subject-value" style={{ color: 'var(--text-faint)' }}>
                        {shortenId(entry.sourceId, 12)}
                      </span>
                    )}
                  </span>
                  <span className="timeline-basis">
                    order: {orderingBasisLabel(entry.orderingBasis)}
                  </span>
                </li>
              );
            })}
          </ol>
          <nav className="page-nav" aria-label="Timeline pages">
            <span>
              {page.entries.length} entr{page.entries.length === 1 ? 'y' : 'ies'} on this page
            </span>
            {page.nextCursor !== null ? (
              <Link
                className="button"
                href={filterHref({ cursor: page.nextCursor, subjectKey }) as Route}
              >
                Next page →
              </Link>
            ) : (
              <span className="button" aria-disabled="true">
                Next page →
              </span>
            )}
          </nav>
        </>
      )}
    </Section>
  );
}
