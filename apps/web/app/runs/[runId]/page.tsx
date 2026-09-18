// =====================================================================
// RuptureGrid v1.0 — Run detail: Overview (Phase 6)
// =====================================================================
// The run's business-verdict summary. Every value is durable state:
// step outcome counts from the run row, verdicts from persisted
// invariant evaluations, integrity from the evidence-chain verifier.
// The page links into the investigation path (findings → timeline →
// evidence) without duplicating their content.

import Link from 'next/link';
import type { Route } from 'next';
import {
  getRunStatus,
  getRunIntegrity,
  listInvariantEvaluations,
  listRunFindings,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MetaItem, MonoValue, ProofJson } from '@/components/ui/meta';
import { EmptyState } from '@/components/ui/state-block';
import { verdictClass, stepStateClass, formatTimestamp } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

export default async function RunOverviewPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const [run, integrity, batches, findings] = await Promise.all([
    getRunStatus(runId),
    getRunIntegrity(runId),
    listInvariantEvaluations(runId),
    listRunFindings(runId),
  ]);

  const evaluations = batches.flatMap((batch) => batch.evaluations);
  const failCount = evaluations.filter((evaluation) => evaluation.verdict === 'FAIL').length;
  const passCount = evaluations.filter((evaluation) => evaluation.verdict === 'PASS').length;
  const notEvaluableCount = evaluations.filter(
    (evaluation) => evaluation.verdict === 'NOT_EVALUABLE',
  ).length;

  return (
    <>
      <Section
        title="Business verdicts"
        description="Deterministic invariant evaluations over this run's captured evidence. PASS/FAIL/NOT_EVALUABLE are the engine's verdicts — never restated, never recomputed here."
      >
        {evaluations.length === 0 ? (
          <EmptyState
            title="No invariant evaluations yet"
            detail="Evaluations appear after the run's evidence has been analyzed (POST /api/v1/runs/{id}/analyze — the worker does this automatically when the run settles)."
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Invariant</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Evaluator</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((evaluation) => (
                  <tr key={evaluation.id}>
                    <td>
                      <span className="mono-cell">{batches[0]?.invariantKey ?? ''}</span>
                    </td>
                    <td>
                      <MonoValue value={evaluation.subjectKey} />
                    </td>
                    <td>
                      <Badge
                        label={evaluation.verdict}
                        semantic={verdictClass(evaluation.verdict)}
                      />
                    </td>
                    <td>
                      <span className="mono-cell">{evaluation.id.slice(0, 8)}…</span>
                    </td>
                    <td>{evaluation.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="compare-differ-note">
          {failCount} FAIL · {passCount} PASS · {notEvaluableCount} NOT_EVALUABLE
          {findings.count > 0 ? (
            <>
              {' '}
              ·{' '}
              <Link href={`/runs/${runId}/findings` as Route}>
                {findings.count} finding(s) derived
              </Link>
            </>
          ) : null}
        </p>
      </Section>

      <Section
        title="Execution summary"
        description="Durable step states with their orthogonal side-effect knowledge. A mutating step whose remote effect is unknowable stays INDETERMINATE — it is never collapsed into success or failure (ADR-0008)."
      >
        <dl className="meta-list">
          <MetaItem label="Steps">
            {run.steps.filter((step) => step.state === 'SUCCEEDED').length}
            {' / '}
            {run.steps.length} succeeded
          </MetaItem>
          <MetaItem label="INDETERMINATE invocations">{run.indeterminateInvocationCount}</MetaItem>
          <MetaItem label="Run state">
            <Badge label={run.state.replaceAll('_', ' ')} semantic={stepStateClass(run.state)} />
          </MetaItem>
          <MetaItem label="Snapshot hash">
            <MonoValue value={run.snapshotHash} />
          </MetaItem>
        </dl>
        <p>
          <Link href={`/runs/${runId}/execution` as Route}>Full execution detail →</Link>
        </p>
      </Section>

      <Section
        title="Evidence integrity"
        description="What the verifier actually proves: stored observations match their recorded hashes and links. It does not claim tamper-proofing or immutability (evidence-model §4)."
      >
        <dl className="meta-list">
          <MetaItem label="Observations">{integrity.observationCount}</MetaItem>
          <MetaItem label="Chain">
            <Badge
              label={integrity.chainValid ? 'intact' : 'PROBLEMS DETECTED'}
              semantic={integrity.chainValid ? 'pass' : 'fail'}
            />
          </MetaItem>
          <MetaItem label="Content hashes">
            <Badge
              label={integrity.contentHashesValid ? 'valid' : 'MISMATCH'}
              semantic={integrity.contentHashesValid ? 'pass' : 'fail'}
            />
          </MetaItem>
          <MetaItem label="Verified at">
            <MonoValue value={formatTimestamp(integrity.verifiedAt)} />
          </MetaItem>
        </dl>
        <p className="compare-differ-note">{integrity.guarantee}</p>
        {integrity.problems.length > 0 ? (
          <ProofJson label="Integrity problems" value={integrity.problems} />
        ) : null}
        <p>
          <Link href={`/runs/${runId}/evidence` as Route}>Browse raw evidence →</Link>
        </p>
      </Section>
    </>
  );
}
