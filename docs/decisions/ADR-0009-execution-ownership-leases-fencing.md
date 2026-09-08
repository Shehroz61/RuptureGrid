# ADR-0009 — Execution Ownership: Durable Leases with Fencing Tokens

Status: Accepted (Phase 0)

## Context
Multiple workers are required from the start (real concurrency is part of the product's testing value). Any multi-worker design must answer: what happens when a worker that lost ownership wakes up and writes?

## Decision
- Claimable work (steps) is guarded by **durable lease rows in PostgreSQL**: `ownerId`, `expiresAt`, and a monotonically increasing **fencing token** incremented on every successful claim ([architecture.md](../architecture.md) §10).
- Workers heartbeat to extend leases; state transitions are **conditional** on `ownerId` + fencing token, so a stale worker's write matches zero rows and must abort, discarding in-memory progress and reporting a stale-writer event. Worker-appended raw observations are append-only records of what was actually observed — they carry their owning invocation identity and writer identity for attribution, and are never dropped by fencing (fencing governs durable *state*, not recorded reality).
- Terminal states are set once, fenced; conflicting writes are rejected at the database and recorded.

**Honest limitation (part of the decision):** leasing protects *durable state*, not *remote reality*. A stale worker's in-flight mutating request may still have hit the target. That ambiguity is handled by ADR-0008's INDETERMINATE semantics — the two mechanisms solve different problems and neither substitutes for the other.

## Consequences
- Every worker write path must carry fencing context — a Phase 3 acceptance scenario with a committed adversarial test ([testing-strategy.md](../testing-strategy.md) §4 item 3).
- Clock skew is mitigated by lease expiry checks at claim time and conditional writes, not by trusting worker clocks for ownership.

## Alternatives considered
- **Redis-based locks** — rejected: coordination-layer locks must not guard durable truth (ADR-0003).
- **Single worker (no ownership problem)** — rejected: concurrency must be real and testable.

## Deferred questions
- Heartbeat interval and lease duration defaults (Phase 3; tuned by adversarial tests, not guessed).
