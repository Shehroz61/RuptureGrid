// =====================================================================
// RuptureGrid v1.0 — Run detail: Execution (Phase 6)
// =====================================================================
// The durable execution record: each step's state-machine position,
// its intentOutcome and — orthogonally — its sideEffectKnowledge,
// including INDETERMINATE as a first-class displayed state (ADR-0008).
// Fencing tokens and lease owners are shown as the technical facts
// they are; nothing is derived or prettified into "health".

import { getRunStatus } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MetaItem, MonoValue } from '@/components/ui/meta';
import { stepStateClass, knowledgeClass, formatTimestamp } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const KNOWLEDGE_LABELS: Readonly<Record<string, string>> = {
  KNOWN_OCCURRED: 'effect known to occur',
  KNOWN_ABSENT: 'effect known absent',
  INDETERMINATE: 'INDETERMINATE — effect unknowable',
  NOT_APPLICABLE: 'read-only (no remote effect)',
};

export default async function RunExecutionPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const run = await getRunStatus(runId);

  return (
    <>
      {run.indeterminateInvocationCount > 0 ? (
        <div className="note-box">
          <p>
            <strong>
              {run.indeterminateInvocationCount} invocation
              {run.indeterminateInvocationCount === 1 ? '' : 's'} with INDETERMINATE side-effect
              knowledge.
            </strong>{' '}
            A mutating request was sent and its outcome on the target could not be observed (for
            example a timeout after send). RuptureGrid does not guess: the invocation is recorded as
            INDETERMINATE and is never auto-retried (ADR-0008).
          </p>
        </div>
      ) : null}
      <Section
        title="Steps"
        description="One row per durable step run, in experiment order. intentOutcome (did the executor complete its work?) and sideEffectKnowledge (what is known about the remote mutation?) are independent facts."
      >
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Step</th>
                <th scope="col">State</th>
                <th scope="col">Intent outcome</th>
                <th scope="col">Side-effect knowledge</th>
                <th scope="col">Attempts</th>
                <th scope="col">Dispatch</th>
                <th scope="col">Lease owner</th>
                <th scope="col">Fencing token</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((step) => (
                <tr key={step.id}>
                  <td className="num">{step.sequence}</td>
                  <td>{step.name}</td>
                  <td className="step-table-state">
                    <Badge label={step.state} semantic={stepStateClass(step.state)} />
                  </td>
                  <td>
                    <span className="mono-cell">{step.intentOutcome ?? '—'}</span>
                  </td>
                  <td>
                    {step.sideEffectKnowledge !== null ? (
                      <Badge
                        label={
                          KNOWLEDGE_LABELS[step.sideEffectKnowledge] ?? step.sideEffectKnowledge
                        }
                        semantic={knowledgeClass(step.sideEffectKnowledge)}
                      />
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                  <td className="num">{step.attemptCount}</td>
                  <td>
                    <span className="mono-cell">{step.dispatchState}</span>
                    {step.leaseExpiresAt !== null ? (
                      <span
                        className="mono-cell"
                        style={{ display: 'block', color: 'var(--text-muted)' }}
                      >
                        lease → {formatTimestamp(step.leaseExpiresAt)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {step.leaseOwnerId !== null ? (
                      <MonoValue value={step.leaseOwnerId} />
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                  <td className="num">{step.fencingToken}</td>
                  <td>
                    {step.error !== null ? <span className="step-error">{step.error}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Run metadata">
        <dl className="meta-list">
          <MetaItem label="Snapshot hash">
            <MonoValue value={run.snapshotHash} />
          </MetaItem>
          <MetaItem label="Canonicalization">
            <MonoValue value={run.canonicalization} />
          </MetaItem>
          <MetaItem label="Created">
            <MonoValue value={formatTimestamp(run.createdAt)} />
          </MetaItem>
          <MetaItem label="Terminal at">
            <MonoValue value={formatTimestamp(run.terminalAt)} />
          </MetaItem>
          <MetaItem label="Cancel requested">
            <MonoValue value={formatTimestamp(run.cancelRequestedAt)} />
          </MetaItem>
          <MetaItem label="Failure reason">{run.failureReason ?? '—'}</MetaItem>
        </dl>
      </Section>
    </>
  );
}
