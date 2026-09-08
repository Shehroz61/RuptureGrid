# ADR-0002 — Data Ownership Separation

Status: Accepted (Phase 0)

## Context
RuptureGrid's credibility depends on treating targets as external systems. The Demo Target could trivially share one database with RuptureGrid — and that would quietly invalidate every claim about target ownership, external behavior, and evidence integrity.

## Decision
- The Demo Target is a **separate application with its own PostgreSQL instance/schema set and its own migration history**. RuptureGrid holds no credentials to it.
- RuptureGrid's own data lives in one RuptureGrid PostgreSQL instance with three logically owned schemas (`control`, `evidence`, `analysis`), each owned by exactly one bounded context; cross-context access only through context APIs ([architecture.md](../architecture.md) §4).
- If a future phase splits the RuptureGrid schemas onto separate instances, application code must not assume co-location.
- Business-state verification uses the target-authored read-only inspection API; an optional read-only observation adapter is allowed only when explicitly configured and audited ([architecture.md](../architecture.md) §5).

## Consequences
- Slightly more operational surface (two databases) in exchange for an honest, provable trust boundary.
- All invariant evaluation of target state goes through defined interfaces — good for testing and for the product's core claim.

## Alternatives considered
- **One shared database** — rejected: destroys the external-target premise and enables exactly the hidden mutations the product forbids (AGENTS R-05).
- **Separate database per RuptureGrid context from day one** — deferred: adds ops burden without an immediate correctness need; logical ownership plus a no-co-location assumption rule preserves the option.

## Deferred questions
- Read-only observer adapter mechanics (SQL observer vs enhanced inspection API) — Phase 4.
