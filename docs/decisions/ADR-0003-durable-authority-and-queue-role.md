# ADR-0003 — Durable Authority (PostgreSQL) and Queue Role (Coordination Only)

Status: Accepted (Phase 0)

## Context
Execution coordination needs a queue; queues built on Redis are not durable truth. If the queue becomes the only record of work, a Redis failure silently deletes experiments — unacceptable for a product whose core value is trustworthy execution records.

## Decision
- **PostgreSQL owns durable truth**: runs, execution intent (snapshots), step state, evidence, invariant results, findings.
- **Redis/BullMQ is coordination only**: job payloads reference durable row IDs, never carry authoritative state.
- Required failure behavior (acceptance scenario in Phase 3): API durably creates run → queue unavailable → run persists → queue recovers → **reconciliation discovers undispatched durable work** → execution continues automatically ([architecture.md](../architecture.md) §9).

## Consequences
- Every dispatch path needs a reconciliation counterpart — designed in from Phase 3, not bolted on.
- Redis data loss is an operational nuisance, never a data-loss incident.

## Alternatives considered
- **Queue-as-source-of-truth** — rejected for the durability reason above.
- **PostgreSQL-based queue (SKIP LOCKED)** — viable alternative that reduces moving parts; revisit at Phase 3 if BullMQ's semantics prove unnecessary for our claim/retry patterns. Decision now: BullMQ, with the reconciliation contract making a later swap survivable.

## Deferred questions
- Exact reconciliation sweep design and intervals (Phase 3).
- Queue technology re-evaluation trigger criteria (Phase 3 review).
