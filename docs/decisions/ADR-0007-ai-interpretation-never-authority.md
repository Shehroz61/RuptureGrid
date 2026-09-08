# ADR-0007 — AI Interpretation, Never Authority

Status: Accepted (Phase 0)

## Context
LLM assistance can genuinely help investigators understand complex failure evidence. But an AI that decides truth — or blurs interpretation into evidence — would make RuptureGrid's central promise (evidence-backed determinism) a lie.

## Decision
- AI may: summarize evidence, explain deterministic findings, suggest possible root causes, suggest remediation, assist investigation — always as **labeled interpretation** tied to, and never mutating, the deterministic layer ([evidence-model.md](../evidence-model.md) §2).
- AI may never: invent evidence, invent causal relationships, change invariant results, convert uncertainty into certainty, fabricate behavior.
- AI inputs exclude secrets ([security-boundaries.md](../security-boundaries.md) §7).
- Architecturally: AI artifacts are a separate origin class (`AI_INTERPRETED`), stored and surfaced distinctly from `OBSERVED`/`DERIVED`, and can never be inputs to invariant evaluation. Truth hierarchy ends "…→ DETERMINISTIC FINDING → OPTIONAL AI INTERPRETATION" ([product-spec.md](../product-spec.md) §9).

## Consequences
- AI features are optional add-ons; the product is fully functional without any model.
- AI provenance (model identity, references, timestamp) is recorded like engine provenance.

## Alternatives considered
- **AI-generated findings** — rejected outright; would defeat the product's purpose.

## Deferred questions
- Which AI features ship post-v1, if any (unscheduled; each requires design review under this ADR).
