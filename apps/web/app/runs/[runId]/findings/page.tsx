// =====================================================================
// RuptureGrid v1.0 — Run detail: Findings (Phase 6)
// =====================================================================
// Deterministic findings derived from this run's invariant
// evaluations. The finding layer never recomputes verdicts; this page
// never reinterprets them. Each card links to the full proof.

import Link from 'next/link';
import type { Route } from 'next';
import { listRunFindings } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MonoValue } from '@/components/ui/meta';
import { EmptyState } from '@/components/ui/state-block';
import { formatTimestamp } from '@/lib/semantics';
import { FindingDetails } from '@/components/findings/finding-details';

export const dynamic = 'force-dynamic';

export default async function RunFindingsPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const page = await listRunFindings(runId);

  return (
    <Section
      title="Findings"
      description="Deterministic conclusions derived from persisted invariant evaluations — with full provenance. PASS and NOT_EVALUABLE evaluations produce no failure finding, by design."
    >
      {page.count === 0 ? (
        <EmptyState
          title="No findings for this run"
          detail="Findings are derived only when an invariant evaluation FAILs. A run with PASS or NOT_EVALUABLE verdicts — or one not yet analyzed — has none. This is not an error; it is what the evidence supports."
        />
      ) : (
        page.items.map((finding) => (
          <article key={finding.id} className="finding-card">
            <div className="finding-meta">
              <Badge label={finding.reasonCode} semantic="fail" mono />
              <span>
                invariant <span className="mono-value">{finding.invariantKey}</span> (
                {finding.evaluatorVersion})
              </span>
              <span>
                rule <span className="mono-value">{finding.findingRuleVersion}</span>
              </span>
              <span>
                derived <span className="mono-value">{formatTimestamp(finding.createdAt)}</span>
              </span>
            </div>
            <h3 className="finding-card-title">{finding.title}</h3>
            <p className="finding-card-summary">{finding.summary}</p>
            <p className="finding-meta">
              <span>
                subject <MonoValue value={finding.subjectKey} />
              </span>
              <span>
                {finding.proofReferences.length} proof reference
                {finding.proofReferences.length === 1 ? '' : 's'}
              </span>
              <span>
                fingerprint <MonoValue value={`${finding.inputFingerprint.slice(0, 16)}…`} />
              </span>
            </p>
            <FindingDetails details={finding.details} />
            <p>
              <Link href={`/runs/${runId}/findings/${finding.id}` as Route}>Full proof →</Link>
            </p>
          </article>
        ))
      )}
    </Section>
  );
}
