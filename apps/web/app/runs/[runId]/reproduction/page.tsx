// =====================================================================
// RuptureGrid v1.0 — Run detail: Reproduction (Phase 6)
// =====================================================================
// The run's reproduction definition (incident-replay §1): the frozen
// snapshot binding, the required target mode, credential REFERENCES
// (never values — none exist on this surface to show), invariant
// bindings, and acceptance expectations. Replay execution itself is
// not part of Phase 6; this view states exactly what a replay would
// re-execute and what it would NOT reproduce (incident-replay §4).

import { getReproductionDefinition } from '@/lib/api-client';
import { Section } from '@/components/ui/page';
import { MetaItem, MonoValue, ProofJson } from '@/components/ui/meta';
import { EmptyState } from '@/components/ui/state-block';
import { formatTimestamp } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

export default async function RunReproductionPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  let definition: Awaited<ReturnType<typeof getReproductionDefinition>> | null = null;
  let notFound = false;
  try {
    definition = await getReproductionDefinition(runId);
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status: number }).status === 404
    ) {
      notFound = true;
    } else {
      throw error;
    }
  }

  if (notFound || definition === null) {
    return (
      <Section
        title="Reproduction definition"
        description="What an intentional re-execution of this experiment's intent requires."
      >
        <EmptyState
          title="No reproduction definition derived yet"
          detail="The reproduction definition is derived by the forensics pipeline once the run's evidence has been processed (POST /api/v1/runs/{id}/forensics/derive)."
        />
      </Section>
    );
  }

  return (
    <Section
      title="Reproduction definition"
      description="Derived from the run's hash-pinned snapshot. A replay creates a NEW run from this frozen intent — it never rewrites this run's history."
    >
      <dl className="meta-list">
        <MetaItem label="Snapshot ID">
          <MonoValue value={definition.snapshotId} />
        </MetaItem>
        <MetaItem label="Snapshot content hash">
          <MonoValue value={definition.snapshotContentHash} />
        </MetaItem>
        <MetaItem label="Required target mode">
          {definition.targetModeRequirement ?? '— (not mode-specific)'}
        </MetaItem>
        <MetaItem label="Derived at">
          <MonoValue value={formatTimestamp(definition.createdAt)} />
        </MetaItem>
      </dl>

      <div className="kv-table" style={{ marginTop: 'var(--sp-3)' }}>
        <table>
          <tbody>
            <tr>
              <th scope="row">Credential references</th>
              <td>
                {definition.credentialRefs.length === 0 ? (
                  <span>none required</span>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 'var(--sp-4)' }}>
                    {definition.credentialRefs.map((reference) => (
                      <li key={reference}>
                        <span className="mono-value">{reference}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="compare-differ-note">
                  Names only — credential VALUES are never persisted and never appear here
                  (ADR-0012). A rotated secret fails a replay fast and explicitly.
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ProofJson label="Invariant bindings" value={definition.invariantBindings} />
      <ProofJson
        label="Acceptance expectations (this run's own verdicts)"
        value={definition.acceptanceExpectations}
      />

      <div className="note-box">
        <p>
          <strong>What a replay reproduces:</strong> the execution intent — steps, payloads, fault
          plan, repeat/concurrency/timeouts — and the required target mode, verified via the
          target&apos;s own admin API.
        </p>
        <p>
          <strong>What it does not:</strong> wall-clock timing, concurrency interleavings, external
          network conditions, or prior target state (the experiment re-establishes its own
          preconditions through target interfaces). Differences in verdicts between this run and a
          replay are the signal — compare runs on the Comparison view.
        </p>
      </div>
    </Section>
  );
}
