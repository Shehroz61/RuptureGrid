# RUPTUREGRID v1.0 — PHASE 10 RELIABILITY AUDIT

Session: Phase 10 audit (branch `phase-10-full-engineering-audit` from
`phase-9-accepted` = `e39cbfe`). Date: 2026-09-23. Proofs below were
executed in this session against the real stack (real PostgreSQL ×2,
real Redis, real worker/Demo child processes, real HTTP, real browser
via the accepted verifiers). All work uncommitted.

## 1. Verdict

**NO UNRESOLVED RELIABILITY FINDINGS IN PRODUCTION CODE.** One
test-infrastructure flake class (the Phase 9 audit's known remaining
risk) was root-caused and FIXED; the full suites were re-proven green
afterwards.

## 2. Leases and fencing (§16, §17)

Re-attacked via `tests/integration/ownership.test.ts` +
`multi-worker.test.ts` (green in the final integration run):

- Claim = ONE conditional CTE UPDATE on DB time; live leases are never
  stealable; takeover only after `leaseExpiresAt <
  statement_timestamp()`; fencing token increments on every claim.
- All owner state writes are conditioned on (owner, token,
  non-terminal); zero rows ⇒ `LeaseLostError` + durable
  `stale_writer_event`; terminals are write-once (no resurrection).
- Heartbeat renews only the owning generation (DB time); renewal loss
  stops network work; the late worker's STATE writes are rejected while
  its honest observations remain appendable with stale-writer
  provenance (ADR-0009's two-mechanism split as implemented).
- Stale-writer adversarial sequence (A claims → stalls → lease expires
  → B claims (token+1) → B advances → A resumes): A's terminal write
  matches zero rows, is recorded, and B's state is intact — proven by
  the committed suite re-run in this session's final integration pass.

## 3. Reconciler, Redis loss, queue duplication (§19–§21)

- Redis-outage scenario re-proven green
  (`redis-outage-reconciliation.test.ts` in the final run): durable run
  survives in PostgreSQL; reconciliation discovers and dispatches
  after recovery; no operator repair; no duplicate business execution.
- Discovery is a pure durable predicate (no Redis scan); enqueue is
  idempotent by deterministic jobId; the RECONCILE marker gates
  requeue-once; terminal writes are write-once — running the sweep
  repeatedly cannot duplicate execution.
- Queue duplication → duplicate job delivery exits safely as
  not-claimable (suite-proven); PostgreSQL claims remain the
  correctness authority (BullMQ is coordination only — payload
  carries IDs; producer offline-queue disabled so outages surface
  durably).
- Ambiguous-mutation reconciliation is conservative: expired mutating
  leases resolve INDETERMINATE (never a guess, never retried);
  read-only/provably-unsent steps requeue for safe re-execution.

## 4. Ambiguity honesty and retry policy (§12, §26–§28 of the brief)

- Final controlled-faults runs (×2, 80/80 each): RESPONSE_LOSS runs
  persist INDETERMINATE (SQL-verified: exactly 2 INDETERMINATE
  invocations), zero auto-retries, later inspection proves the
  committed effect, invocation knowledge never rewritten.
- `decideRetry` never auto-retries an INDETERMINATE mutating outcome
  regardless of declared policy; SAFE retries apply only to
  provably-no-effect (KNOWN_ABSENT) failures within a bounded budget.
- Classification table re-verified against the accepted Phase 3 table
  (pure function of transport stage × outcome × mutation × contract).

## 5. Crash / outage recovery (§92, §93)

- Worker crash mid-step: lease expiry + reconciliation resolve honestly
  (INDETERMINATE for ambiguous mutations) — suite-proven.
- Control-DB outage: execution cannot pretend success (claim/terminal
  writes fail; the reconciler retries on the next sweep; jobs stay
  coordination-only).
- Demo-DB outage: target request failure semantics stay truthful
  (executor classification; no laundering); recovery involves no
  duplicate unsafe operation (retry policy above).
- Redis restart: covered by the outage suite (recover + re-dispatch
  where safe).

## 6. Process lifecycle and hygiene (§61–§63, §151)

- Normal shutdown: API/worker/Demo close queues/pools/servers on
  SIGINT/SIGTERM (source-verified; worker-startup suite green).
- Hard-kill: verifiers track owned PIDs, refuse unknown listeners
  (showcase probes for THIS session's run IDs), and never global-kill.
- Final state observed: no owned listeners; no orphan verifier
  children; stale empty Playwright temp profile removed (0 remain);
  auditor temp DBs dropped; scratch deleted.

## 7. Test isolation and flakes (§84, §86)

- **Root cause fixed (DEF-2):** four test files generated registration
  origins from wall-clock buckets, colliding on the persistent shared
  dev DB (global-unique origin authority ⇒ hard registration failure).
  This is precisely the flake family the Phase 9 audit observed
  (`ownership.test.ts` stale-origin collision; the identity suite's
  variant observed by this audit at baseline). Fix: random candidate
  origins VERIFIED unregistered against the authoritative table before
  use (bounded 16-attempt regeneration); shared helper
  `uniqueTestOrigin` in the integration harness + suite-local twin in
  the evidence identity suite; displayName hardened.
- **Re-proof:** targeted file ×3 consecutive green; full unit
  33 files 319/319; full integration 23 files 152/152 (final run
  306.08s); `pnpm verify` exit 0; both verifiers PASS ×2 post-fix.
- Serial integration execution remains by documented design
  (shared-infrastructure coordination, e.g. the Redis outage test);
  no random non-deterministic corruption exists anywhere.

## 8. Resource-leak checks (§61)

- Repeated verifier/showcase runs in this session (IZ ×2, CF ×2,
  showcase ×3 incl. video): every session reaped its own children and
  closed its own connections (observed via clean port table and the
  tools' own ownership checks); one pre-existing stale temp profile
  (empty, from an earlier session) was the only residue found and was
  removed.

## 9. Findings summary

| ID | Severity | Area | Status |
|---|---|---|---|
| DEF-1 | P2 | baseline `verify` flake (same root cause as DEF-2) | root-caused; fixed via DEF-2 |
| DEF-2 | P1 (test-infra) | time-bucketed test origins in 4 files | FIXED + re-proven |
| — | P0/P1/P2 | production reliability surfaces | NONE FOUND |

Reliability blockers = NONE. Phase 10 reliability result: **PASS**.
