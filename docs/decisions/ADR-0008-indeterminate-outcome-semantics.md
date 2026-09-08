# ADR-0008 — INDETERMINATE Outcome Semantics and Conservative Retries

Status: Accepted (Phase 0)

## Context
Distributed execution produces genuinely unknowable outcomes: a mutating request times out after the target performed the mutation; a worker crashes with a request in flight. No lease, retry, or bookkeeping can un-know what the remote side did. Systems that pretend otherwise (mapping "didn't get a response" to "failed") manufacture false incident narratives — precisely the defect RuptureGrid exposes.

## Decision
- Every mutating invocation records two independent facts ([architecture.md](../architecture.md) §7.1): `intentOutcome` (executor's own work) × `sideEffectKnowledge` (`KNOWN_OCCURRED` | `KNOWN_ABSENT` | `INDETERMINATE`; `NOT_APPLICABLE` for reads).
- `INDETERMINATE` is persisted, displayed, and never laundered into success/failure — in state machines, timelines, findings, and UI ([product-design.md](../product-design.md) §6).
- Retry policy is conservative by default: ambiguous mutations are **never** auto-retried unless the step's declared contract makes retry safe (target-side idempotency) or the experiment explicitly accepts the risk ([architecture.md](../architecture.md) §7.2).
- Collapsing INDETERMINATE into SUCCEEDED/FAILED in code is a review blocker ([engineering-rules.md](../engineering-rules.md) §9).

## Consequences
- Runs can complete with INDETERMINATE steps; run summaries must report them plainly.
- Reconciliation must resolve interrupted work honestly — often to INDETERMINATE for mutating steps (Phase 3).

## Alternatives considered
- **Treat timeout as failure** — rejected: falsifies history whenever the effect actually occurred.
- **Always retry to "resolve" ambiguity** — rejected: manufactures the duplicate effects we test for, as accidents.

## Deferred questions
- Optional target-side idempotency-key mechanics for executor retries (Phase 3, if a scenario requires safe automated retry).
