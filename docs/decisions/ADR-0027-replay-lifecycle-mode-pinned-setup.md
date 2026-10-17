# ADR-0027: Replay Lifecycle vs Mode-Pinned Setup (PROPOSED)

## Status

**2026-10-16 amendment: narrow architectural direction APPROVED by the
project owner; implementation and local verification authorized. Phase 18
is NOT accepted.** The original proposal below is preserved as history;
the amendment at the end supersedes its Decision 1 and future-phase
deferral in Decision 2. This approval does not authorize Git staging,
commits, tags, pushes, Phase 19, or the fingerprint proposal.

### Historical proposal status (superseded by the amendment below)

**PROPOSED — NOT ACCEPTED.** Design analysis only. No runtime change, no
migration, no implementation in this change. Written during Phase 18 to
discharge the mandate's critical design check: the accepted contracts as
frozen make one Phase 18 acceptance item unreachable as written, and this
ADR records the exact contradiction plus the smallest ADR-compliant
resolution for independent-audit adjudication. Nothing here alters any
accepted contract; where this proposal and an accepted document disagree,
the accepted document governs until this ADR (or a successor) is accepted.

## Context

Phase 18 requires the lifecycle "discovered failure → reproduction
definition → target fix through its own interfaces → same-snapshot replay
→ PASS" on Demo Commerce, with the replay creating "a NEW run from the
same hash-pinned snapshot" (ADR-0019 Decision 4; incident-replay §3; the
Phase 18 roadmap acceptance).

## The contradiction (traced, not guessed)

1. **Replay is exact-intent by contract.** ADR-0010 + ADR-0019 Decision 4
   + incident-replay §3: a replay is a new run from the STORED snapshot;
   "exact or semantically pinned" means the same `snapshotContentHash`.
   The snapshot is the resolved execution intent: step templates
   (method, path, headers minus credentials, BODIES), fault plan,
   repeat/concurrency/timeouts, invariant bindings, engine versions.
2. **The canonical Checkout Zero setup step pins the vulnerable mode.**
   `packages/cli/scenarios/checkout-zero-vulnerable.scenario.json`, step
   `establish-scenario`: body
   `{"scopeToken":"checkout-zero","sku":"SKU-001",
   "initialAvailableUnits":1,"mode":"VULNERABLE"}`. The SECURE scenario
   differs in exactly that body (plus name/description/expectations), so
   the two scenarios necessarily freeze DIFFERENT content hashes.
3. **The setup step atomically applies the mode.** Demo Commerce
   `initializeScenarioContext` (`packages/commerce-db/src/checkout-core.ts`)
   advances the scope generation, clears the scope's business rows,
   re-baselines the SKU, AND applies the declared processing mode in ONE
   target-owned transaction. Replaying the vulnerable snapshot therefore
   re-arms VULNERABLE mode on the target — by the target's own correct
   behavior — before the submissions execute.
4. **The mode switch IS the legitimate fix interface.**
   checkout-zero.md §2: "Switching between vulnerable and secure
   processing modes is done via the target's own configuration/admin
   API — a legitimate interface — never by editing target state behind
   its back (R-05)." The reproduction definition's
   `targetModeRequirement` (extracted from the snapshot's own step
   bodies) records VULNERABLE for the vulnerable snapshot.
5. **Therefore a same-hash replay of the vulnerable snapshot
   deterministically reproduces FAIL, and PASS from the same hash is
   unreachable while the target honors its mode contract.** The fix
   (mode → SECURE via the admin API) is undone by the replay's own
   setup step before any business submission executes. The same
   structure holds for Incident Zero: the fintech golden document pins
   the mode in its `mode` step body
   (`packages/incident-zero/src/contract.ts` → `PUT /demo/admin/mode`
   with `{"mode": …}`), so the contradiction is domain-general, not a
   commerce accident.

## Rejected workarounds (each violates the constitution or a frozen contract)

- **Mid-run mode switch** (replay setup in VULNERABLE, then flip to
  SECURE via the admin API before the submissions): contradicts the
  reproduction's `targetModeRequirement`, makes the PASS a property of
  an out-of-band intervention rather than of (snapshot + fixed
  target), and is not reproducible by an auditor replaying the same
  snapshot without the intervention. Rejected (R-02: the report would
  present intervention-dependent truth as durable target truth).
- **Fixing the vulnerable code path under the VULNERABLE label** (a
  target code change so the naive pipeline no longer oversells): the
  snapshot hash is preserved and same-hash PASS is achieved, but the
  target no longer implements its specified contract (checkout-zero.md
  §6 matrix; Phase 16 acceptance "both modes behave per
  checkout-zero.md"), and the committed vulnerable ⇒ FAIL regression
  suites go red. A "fix" that deletes the bug-injection fixture is not
  a remediation; it invalidates Phase 16/17 acceptance (R-01).
  Rejected.
- **Substituting the secure scenario and claiming same-snapshot
  reproduction**: the hashes differ; the claim would be false (R-02).
  Rejected.
- **Altering the stored snapshot** (rewriting the setup body to SECURE
  while presenting the original hash): history rewrite of
  logically-append-only intent (incident-replay §7; R-02). Rejected.

## Decision (proposed)

1. **Honest lifecycle doctrine (no contract change required).** For
   mode-parameterized scenarios, the Phase 18 lifecycle is demonstrated
   as TWO durable evidences, never conflated:
   - (a) **Same-hash replay proves determinism**: the vulnerable
     reproduction replays to the SAME hash with an independently
     computed FAIL (exit 1) — the bug is still present, exactly as the
     frozen intent declares. Original and replay verdicts are
     independently computed; the original FAIL and its historical
     evidence remain unchanged.
   - (b) **Post-fix verification proves remediation**: after the genuine
     target-side fix (mode → SECURE through the target's own admin
     API), the SECURE scenario (different hash — stated, never hidden)
     yields PASS with zero findings (exit 0).
   - The two are linked by shared experiment lineage (identical steps
     modulo the mode precondition), NOT by hash equality; the
     comparison surface refuses the cross-hash pair
     (`SNAPSHOT_MISMATCH`) and the reports carry the lineage note.
2. **Structural resolution (future accepted ADR required before
   implementation).** If a future phase wants literal same-hash
   FAIL → PASS transitions for mode-parameterized scenarios, the
   setup step must be split into snapshotted business intent (scope
   reset, SKU baseline, submissions, invariants) and a NON-snapshotted
   environment precondition (mode selection bound at replay time to
   the reproduction's `targetModeRequirement` with an explicit,
   provenance-recorded operator override). That changes snapshot
   semantics, the scenario contract, and the comparison rule — it is a
   dedicated architecture phase with its own ADR, never a Phase 18
   "while you're in there" (R-01). This proposal does NOT implement it.
3. **Credential-fingerprint honesty note.** incident-replay §1/§4 and
   ADR-0010/ADR-0012 describe credential "references + fingerprints"
   with replay failing fast on fingerprint mismatch. The v1
   implementation persists reference NAMES only (snapshot
   `credentialRefs`; reproduction `credentialRefs`) — no value
   fingerprint is persisted anywhere, and none is compared at replay.
   The implemented fail-fast is: removed/unauthorized grants fail
   closed at replay validation (before anything durable), and missing
   runtime values fail pre-send (`CredentialResolutionError` → FAILED
   step → exit 3), never silently. Any future fingerprint comparison
   is a schema + ADR change, not a reading of current behavior. This
   proposal records the gap without inventing the mechanism (R-02).

## Consequences

- Phase 18 delivers: the replay command, the enriched comparison
  surface, expectation assertions, both-domain regression suites, and
  the external-CI recipe — all green on real infrastructure.
- The roadmap's "same-snapshot replay → PASS" item is BLOCKED by this
  contradiction, demonstrated (vulnerable same-hash replay → FAIL) and
  referred to independent audit with this proposal attached. Phase 18
  acceptance of that item requires either accepting the doctrine in
  Decision 1 or accepting + implementing the structural change in
  Decision 2 in a later phase.
- No accepted document is edited by this proposal; no runtime behavior
  depends on it.

## Alternatives considered

- **Accepting the mid-run switch as "the fix"**: rejected above (R-02).
- **Deferring all of Phase 18 until the structural change lands**:
  rejected — the replay machinery, comparison, expectations, suites,
  and CI recipe are independently valuable and fully implementable
  under the frozen contracts; only the single same-hash-PASS
  demonstration is blocked.

## Approved Phase 18 amendment — 2026-10-16

The project owner explicitly approved mode-preserving target setup and a
new mode-neutral lifecycle: new genuine failure → durable reproduction →
legitimate target-side mode fix → replay of the identical stored snapshot
→ independently evaluated PASS. Decision 1 is rejected as sufficient
acceptance evidence. Decision 2 is replaced by this in-phase amendment:

- Add authenticated `POST /demo/admin/scenario-context`, accepting only
  scope/SKU/baseline intent and preserving existing target processing
  configuration. Retain `/demo/admin/scenario`'s required mode and golden
  behavior. Retain the fenced setup-response scope/generation anchor.
- Add a separate scenario whose frozen steps observe configuration,
  reset business context without setting mode, submit the same two
  deliberate concurrent requests, and observe configuration afterward.
  Its original failure and replay share one snapshot row/hash; it never
  claims the historical golden snapshot's hash.
- Record target-owned configuration revision/instance and the effective
  configuration actually selected by each processing attempt. The same
  captured value selects the real reservation implementation. Capture
  these facts in setup/status/submission HTTP responses and durable target
  rows; preserve existing exact-shape inspection collections and their
  manifest contracts. Business evaluators remain independent of mode.
- Preserve new-run/evidence isolation, logically append-only history,
  complete inspection, ADR-0026 eligibility/publication/authorization,
  existing credential grants/destination restrictions, five-way exits,
  and conservative INDETERMINATE/no-unsafe-retry behavior.
- Repair E-1/F-1/G-1/D-1 and the comparison explanation that incorrectly
  treats any same-hash verdict difference as scheduling luck. Add real
  infrastructure acceptance/refusal tests and run the required gates.

### Explicitly deferred security proposal

Resolution-report Section L.5's fingerprint mechanism was explicitly
**NOT AUTHORIZED** by the owner. It remains a proposed, deferred security
enhancement: no platform fingerprint key, snapshot fingerprint metadata,
ADR-0012 credential-resolution changes, missing-baseline replay denial,
or retroactive invalidation of reproductions is permitted in this work.
Existing reference/registration/grant checks remain in force. Changed
secret values behind an unchanged authorized reference are not detected
without a fingerprint baseline; documentation and audit results must say
so. This mechanism is not technically required for mode-preserving setup.
Other checks required to reject corrupt snapshot content, invalid bindings
and unsupported invariant versions preserve the existing contracts; they
do not authorize redesigning credential handling.

### Acceptance remains independent

Same-snapshot FAIL→fix→PASS must be demonstrated by permanent tests over
real HTTP, PostgreSQL, Redis/BullMQ and worker processes. The original
FAIL/findings/evidence stay unchanged; target business effects, complete
independent evaluations, and verified report truth establish the replay
PASS. A mode label or expected verdict never establishes business truth.
Only independent re-audit can accept Phase 18.

### Final-audit repair clarification (2026-10-16)

The six-blocker repair preserves the approved amendment and existing
ADR-0010/ADR-0026 contracts. Historical `phase3-execution-v1` Fintech
snapshots without generic evidence policy encode the accepted built-in
INV-IZ-1/INV-DF-1/INV-DF-2 v1 domain through their frozen engine and
`DEMO_FINTECH_WEBHOOK` contract identity. Replay reconstructs that domain
from those frozen fields and corroborates the reproduction's bindings;
it neither guesses from observed evaluations nor rewrites snapshots.
Unknown/missing engine metadata or unsupported legacy bindings refuse
before new durable work. No successor engine is declared.

Replay comparison now uses read-only chain verification followed by the
accepted Boundary B authorization for each side. It refuses stale or
ineligible publication, mismatched pointer-target identities, and
incompatible authoritative evaluator/eligibility versions. Each side is
explicitly as-of its authorized C/P/D watermark; exact subject tuples
remain distinct, including independently generated identities and ABSENT
sides. The foundational publication/eligibility rules are unchanged.
This clarification authorizes no fingerprint mechanism or Phase 19 work.

### Two-blocker implementation clarification (2026-10-17)

Boundary B's existing ADR-0026 checklist 7 applies to replay comparison as
well as reports: each pointer must resolve to an evaluation with the same
run, invariant, subject, evaluator version and evidence identity, whose
batch is completed and belongs to that same run/invariant/version. The
shared authorization transaction now checks that chain under the per-run
lock and refuses the entire uncertified selection on any contradiction;
historical rows never fill a missing current subject. The existing schema's
completion marker is `completedAt`; `evaluationCount` records accumulated
history and does not replace the current proof's subject-coverage check.
This enforces the accepted authority contract without a new selector.

Built-in invariant-definition initialization uses PostgreSQL conflict-safe
insertion so concurrent worker and foreground first-use analysis converge
on the same unique definitions. Existing definitions are preserved. A real
PostgreSQL lock-barrier regression exercises the formerly failing overlap.
No retry, timeout, registration, verdict or credential contract changes.
Phase 18 still requires independent re-audit; L.5 remains deferred.

## Current status — 2026-10-17 (Asia/Karachi)

The approved narrow architectural amendment is implemented. The final
independent Phase 18 acceptance recheck PASSED on 17 October 2026 against
the unstaged candidate. The
[final independent acceptance reference](../reports/phase-18-final-independent-acceptance-reference.md)
records the original report hash, exact results and portable evidence index.

The earlier proposal, approval boundaries and re-audit requirement above
remain historical text. This dated status records the completed independent
recheck; it does not retroactively approve the original proposal or declare
the whole ADR accepted. The approved subset remains the mode-preserving
setup/provenance/lifecycle amendment and its documented correctness repairs.

- Architectural implementation: completed and independently audited.
- Final independent acceptance audit: PASSED.
- Controlled Phase 18 Git commit: NOT YET CREATED.
- CI on that new commit: NOT YET RUN.
- Phase 18 acceptance tag: NOT YET CREATED.
- Phase 19: NOT STARTED.

Phase 18 is not yet declared accepted or published. Commit/push and
acceptance-tag actions remain separate explicit authorization gates.
Section L.5 remains PROPOSED, DEFERRED, and UNIMPLEMENTED: no fingerprint
mechanism is approved, no ADR-0012 change is made, and no legacy-replay
restriction is introduced. Existing credential-reference/registration/grant
checks remain enforced; secret-value changes behind an unchanged,
still-authorized reference are not fingerprint-verified.
