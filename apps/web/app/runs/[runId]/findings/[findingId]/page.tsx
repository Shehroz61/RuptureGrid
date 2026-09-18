// =====================================================================
// RuptureGrid v1.0 — Finding detail: the complete proof (Phase 6)
// =====================================================================
// One screen holds the whole evidentiary chain: the authoritative
// invariant evaluation, the deterministic rule identity, the confidence
// scope (what is PROVEN versus what remains uncertain — evidence-model
// §8), and every ordered proof reference. Nothing here interprets or
// strengthens the deterministic result (ADR-0007).

import Link from 'next/link';
import type { Route } from 'next';
import { getFindingProof } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MetaItem, MonoValue, ProofJson } from '@/components/ui/meta';
import { NotFoundState } from '@/components/ui/state-block';
import { formatTimestamp, verdictClass } from '@/lib/semantics';
import { FindingDetails } from '@/components/findings/finding-details';

export const dynamic = 'force-dynamic';

const SUBJECT_LABELS: Readonly<Record<string, string>> = {
  RUN: 'Run',
  STEP_RUN: 'Step run',
  INVOCATION: 'Invocation',
  RAW_OBSERVATION: 'Raw observation (content hash)',
  NORMALIZED_EVENT: 'Normalized event',
  CAUSAL_RELATIONSHIP: 'Causal relationship',
  INVARIANT_EVALUATION: 'Invariant evaluation',
  FINDING: 'Finding',
};

export default async function FindingDetailPage({
  params,
}: {
  readonly params: Promise<{ runId: string; findingId: string }>;
}) {
  const { runId, findingId } = await params;
  let proof: Awaited<ReturnType<typeof getFindingProof>>;
  try {
    proof = await getFindingProof(runId, findingId);
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status: number }).status === 404
    ) {
      return (
        <NotFoundState
          title="Finding not found"
          detail={`No finding ${findingId} exists for run ${runId}.`}
          backHref={`/runs/${runId}/findings`}
          backLabel="← Back to this run's findings"
        />
      );
    }
    throw error;
  }

  return (
    <>
      <article className="finding-card">
        <div className="finding-meta">
          <Badge label={proof.reasonCode} semantic="fail" mono />
          <span>
            rule <span className="mono-value">{proof.findingRuleVersion}</span>
          </span>
          <span>
            derived <span className="mono-value">{formatTimestamp(proof.createdAt)}</span>
          </span>
          <span>
            fingerprint <MonoValue value={proof.inputFingerprint} />
          </span>
        </div>
        <h2 className="finding-card-title">{proof.title}</h2>
        <p className="finding-card-summary">{proof.summary}</p>
        <FindingDetails details={proof.details} />
      </article>

      <Section
        title="Authoritative evaluation"
        description="The Finding rests on this persisted invariant evaluation. The verdict is the evaluation engine's — the finding layer copies it, never recomputes it."
      >
        <dl className="meta-list">
          <MetaItem label="Invariant">
            <MonoValue value={proof.evaluation.invariantKey} />
          </MetaItem>
          <MetaItem label="Verdict">
            <Badge
              label={proof.evaluation.verdict}
              semantic={verdictClass(proof.evaluation.verdict)}
            />
          </MetaItem>
          <MetaItem label="Evaluator version">
            <MonoValue value={proof.evaluation.evaluatorVersion} />
          </MetaItem>
          <MetaItem label="Subject">
            <MonoValue value={proof.evaluation.subjectKey} />
          </MetaItem>
          <MetaItem label="Evidence-set hash">
            <MonoValue value={proof.evaluation.evidenceSetHash} />
          </MetaItem>
          <MetaItem label="Completeness basis">
            <MonoValue value={proof.evaluation.completenessBasis} />
          </MetaItem>
        </dl>
        <p className="compare-differ-note">{proof.evaluation.reason}</p>
        <ProofJson label="Evaluation details (as persisted)" value={proof.evaluation.details} />
      </Section>

      <Section
        title="Confidence scope"
        description="What the evidence proves versus what remains uncertain. Uncertainty is listed explicitly — INDETERMINATE invocations and non-identity attribution dependencies are never smoothed over."
      >
        <div className="scope-grid">
          <div className="scope-panel scope-panel-proven">
            <h3>Proven</h3>
            <ProofJson label="provenScope (as persisted)" value={proof.provenScope} />
          </div>
          <div className="scope-panel scope-panel-uncertain">
            <h3>Uncertain</h3>
            {proof.uncertainScope === null ||
            (typeof proof.uncertainScope === 'object' &&
              Object.keys(proof.uncertainScope as object).length === 0) ? (
              <p className="state-block-detail">Nothing recorded as uncertain for this finding.</p>
            ) : (
              <ProofJson label="uncertainScope (as persisted)" value={proof.uncertainScope} />
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Proof references"
        description="The minimal sufficient evidence set, in deterministic order. Each reference is typed and resolvable to its durable row (or, for raw observations, its content hash)."
      >
        <div className="data-table-wrap">
          <table className="data-table proof-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Subject</th>
                <th scope="col">Role</th>
                <th scope="col">Source ID</th>
              </tr>
            </thead>
            <tbody>
              {proof.evidenceRefs.map((reference) => (
                <tr key={`${reference.position}-${reference.sourceId}`}>
                  <td className="num">{reference.position}</td>
                  <td>{SUBJECT_LABELS[reference.subject] ?? reference.subject}</td>
                  <td>{reference.role}</td>
                  <td>
                    <MonoValue value={reference.sourceId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="compare-differ-note">
          Evaluation inputs — {proof.evaluation.normalizedEventIds.length} normalized event(s),{' '}
          {proof.evaluation.causalRelationshipIds.length} causal relationship(s),{' '}
          {proof.evaluation.sourceObservationHashes.length} source observation hash(es) — are
          resolvable in the run's{' '}
          <Link href={`/runs/${runId}/evidence` as Route}>evidence views</Link>.
        </p>
      </Section>
    </>
  );
}
