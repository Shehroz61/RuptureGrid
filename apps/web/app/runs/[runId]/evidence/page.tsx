// =====================================================================
// RuptureGrid v1.0 — Run detail: Evidence (Phase 6)
// =====================================================================
// What was actually observed. Layers top-down: the integrity
// verifier's honest statement, causal relationships with their
// attribution bases, normalized events (derived, versioned), and the
// raw observations themselves — the stored REDACTED representations,
// with redaction state visible per row (ADR-0012). Payloads are
// bounded disclosures; nothing is re-derived here.

import {
  getRunIntegrity,
  listObservations,
  listNormalizedEvents,
  listCausalRelationships,
} from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/page';
import { MetaItem, MonoValue, ProofJson } from '@/components/ui/meta';
import { EmptyState } from '@/components/ui/state-block';
import { formatTimestamp, shortenId } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const OBSERVATION_KIND_LABELS: Readonly<Record<string, string>> = {
  http_response_observed: 'HTTP response observed',
  http_request_observed: 'HTTP request observed',
  executor_error: 'executor error',
  target_observation: 'target observation (read-only adapter)',
};

export default async function RunEvidencePage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const [integrity, raw, events, relationships] = await Promise.all([
    getRunIntegrity(runId),
    listObservations(runId),
    listNormalizedEvents(runId),
    listCausalRelationships(runId),
  ]);

  return (
    <>
      <Section
        title="Integrity"
        description="The evidence chain is a linked content-hash append log: stored observations match their hashes and links. This detects post-hoc modification by the application's writers; it is not tamper-proofing (evidence-model §4)."
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
        </dl>
        <p className="compare-differ-note">{integrity.guarantee}</p>
      </Section>

      <Section
        title="Causal relationships"
        description="Identity-based links between normalized events. The basis names the support strength: identity-direct hops, identity-chain conclusions, or temporal-correlation hints — which are never sufficient for a FAIL verdict."
      >
        {relationships.count === 0 ? (
          <EmptyState
            title="No causal relationships derived"
            detail="Relationships are derived during evidence analysis. Without them, no causal claim exists for this run."
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Relation</th>
                  <th scope="col">Basis</th>
                  <th scope="col">From event</th>
                  <th scope="col">To event</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {relationships.relationships.map((relationship) => (
                  <tr key={relationship.id}>
                    <td>
                      <span className="mono-cell">{relationship.relationKind}</span>
                    </td>
                    <td>
                      <Badge
                        label={relationship.basis}
                        semantic={
                          relationship.basis === 'temporal-correlation' ? 'uncertain' : 'neutral'
                        }
                        mono
                      />
                    </td>
                    <td>
                      <MonoValue value={shortenId(relationship.fromEventId, 10)} />
                    </td>
                    <td>
                      <MonoValue value={shortenId(relationship.toEventId, 10)} />
                    </td>
                    <td>
                      <ProofJson label="evidence" value={relationship.evidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Normalized events"
        description="Deterministic, versioned projections of the raw observations. Re-running the same normalizer version on the same observations yields the same events."
      >
        {events.count === 0 ? (
          <EmptyState
            title="No normalized events"
            detail="Events are derived during analysis. Their absence means analysis has not run for this run yet."
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Event type</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Normalizer</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Payload</th>
                </tr>
              </thead>
              <tbody>
                {events.events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <span className="mono-cell">{event.eventType}</span>
                    </td>
                    <td>
                      {event.subjectKey !== null ? <MonoValue value={event.subjectKey} /> : '—'}
                    </td>
                    <td>
                      <span className="mono-cell">
                        {event.normalizerName}/{event.normalizerVersion}
                      </span>
                    </td>
                    <td>
                      <span className="mono-cell">{event.origin}</span>
                    </td>
                    <td>
                      <ProofJson label="payload" value={event.payload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title={`Raw observations (${raw.count})`}
        description="The stored REDACTED representations, in chain order. Redaction happened before persistence; the API cannot un-redact. Where a value was too large to store, the row says so (truncated)."
      >
        {raw.count === 0 ? (
          <EmptyState
            title="No raw observations captured"
            detail="Observations are captured at execution time by the worker. A run without captured observations has no raw evidence."
          />
        ) : (
          raw.observations.map((observation) => (
            <article key={observation.id} className="proof-json">
              <summary style={{ display: 'block' }}>
                <div className="timeline-row" style={{ border: 'none', padding: 0 }}>
                  <span className="timeline-time">#{observation.chainIndex}</span>
                  <span className="timeline-kind">
                    {OBSERVATION_KIND_LABELS[observation.kind] ?? observation.kind}
                  </span>
                  <span className="timeline-subject">
                    <span className="subject-value">{shortenId(observation.contentHash, 14)}</span>
                    <span style={{ display: 'block', color: 'var(--text-muted)' }}>
                      observed {formatTimestamp(observation.observedAt)} · writer{' '}
                      {observation.writerOwnerId}
                      {observation.writerFencingToken !== null
                        ? ` (fencing ${observation.writerFencingToken})`
                        : ''}
                    </span>
                  </span>
                  <span className="timeline-basis">
                    {observation.redactionApplied ? (
                      <Badge label="redacted" semantic="neutral" mono />
                    ) : (
                      <Badge label="no redaction applied" semantic="neutral" mono />
                    )}{' '}
                    {observation.truncated ? (
                      <Badge label="truncated" semantic="uncertain" mono />
                    ) : null}
                  </span>
                </div>
              </summary>
              <div style={{ padding: '0 var(--sp-3) var(--sp-3)' }}>
                <ProofJson label="payload (stored, redacted)" value={observation.payload} />
                <p className="compare-differ-note">
                  chain #{observation.chainIndex} · hash{' '}
                  <MonoValue value={observation.contentHash} /> · prev{' '}
                  {observation.prevContentHash !== null ? (
                    <MonoValue value={shortenId(observation.prevContentHash, 10)} />
                  ) : (
                    '(chain head start)'
                  )}{' '}
                  · policy <MonoValue value={observation.redactionPolicyVersion} />
                </p>
              </div>
            </article>
          ))
        )}
      </Section>
    </>
  );
}
