# ADR-0005 — Incident Zero as Flagship Scenario

Status: Accepted (Phase 0)

## Context
A platform for proving business-correctness failures needs one rigorous, understandable, end-to-end scenario that proves the whole pipeline works — from controlled failure to deterministic finding to permanent regression.

## Decision
**Incident Zero** is the flagship scenario ([incident-zero.md](../incident-zero.md)): a provider-confirmed payment of PKR 5,000 (500000 paisa) must produce at most one accepted wallet credit; duplicate delivery must expose the vulnerable mode (FAIL: PKR 10,000 wallet) and must pass on the fixed mode (PASS: PKR 5,000). It is:
- the primary acceptance scenario for Phases 2–7;
- a **permanent regression suite** from Phase 7 in both modes (vulnerable ⇒ deterministic FAIL, secure ⇒ deterministic PASS);
- the guided narrative centerpiece of the product UI.

## Consequences
- The Demo Target must implement both processing modes with realistic mechanics (naive per-delivery processing vs idempotent processing) — a deliberately vulnerable mode is a product requirement, not an accident (Phase 2).
- The invariant INV-IZ-1 becomes the reference implementation of the invariant engine's contract (Phase 4).

## Alternatives considered
- **Several smaller scenarios first** — deferred; they are Phase 9 work. Incident Zero first because it exercises every subsystem and communicates the product in one story.

## Deferred questions
- Exact webhook signature scheme between executor (provider simulation) and target (Phase 2).
- Additional variants (timeout-retry, crash-mid-processing, worker-race) — Phase 9 ([incident-zero.md](../incident-zero.md) §8).
