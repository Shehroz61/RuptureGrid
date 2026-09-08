# ADR-0004 — Money as Integer Minor Units

Status: Accepted (Phase 0)

## Context
Incident Zero (and any financial correctness claim) requires exact arithmetic on amounts. Floating-point representations of decimal currency introduce rounding defects that would contaminate the very evidence RuptureGrid exists to produce.

## Decision
- All financial amounts are **integers in minor units**. PKR's minor unit is the paisa: PKR 5,000 = `500000` paisa.
- Every monetary value carries an explicit **currency code**. v1 deals with PKR; the field exists so a second currency never forces a redesign — no multi-currency engine is built now.
- **Equivalence tuple** for financial-effect comparison: logical payment identity, destination wallet/account, effect type, amount, currency ([product-spec.md](../product-spec.md) §10).
- Applies to domain code, APIs, evidence, fixtures, and UI rendering (UI renders from minor units; never parses floats) — AGENTS R-06.

## Consequences
- Column types must be integer-capable (`bigint`/`numeric` decision at schema time, Phase 2).
- Formatting to "PKR 5,000.00" is a presentation concern, always derived from the integer.

## Alternatives considered
- **Floats/doubles** — categorically rejected.
- **Decimal libraries** — unnecessary complexity for integer-paisa arithmetic; reconsider only if a future currency with sub-minor-unit semantics appears.

## Deferred questions
- Exact column type per store (Phase 2/4 schema work).
