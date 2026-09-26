# RuptureGrid v1.0 — Product Design (UI Philosophy & Contracts)

Status: **Living contract — implemented and accepted through Phase 6 (independent visual/product audit passed); maintained through Phase 11 (released v1.0.1). Phases 0–11 accepted and frozen.**
Authoritative for: design philosophy, explicit anti-patterns, information architecture, the signature investigation UX, accessibility/responsiveness contracts, and the UI quality gate.

Related: [product-spec.md](product-spec.md), [evidence-model.md](evidence-model.md) §9 (timeline rules), [phase-roadmap.md](phase-roadmap.md) Phase 6/8.

---

## 1. Design philosophy

The interface is a **serious engineering instrument** for investigating business-correctness failures. Its credibility comes from:

- **real system state** — every number, status, and timeline entry traces to captured evidence;
- **excellent information hierarchy** — the important thing is findable in seconds;
- **purpose-built investigation tools** — causal views, timelines, and comparisons that a generic dashboard cannot provide.

Technical, serious, clean, deliberate, precise, premium, information-rich, calm, credible. Visual impact comes from hierarchy and density done well — not from decoration.

## 2. Explicit anti-patterns (rejection criteria)

The UI must **not** look like an obvious AI-generated dashboard. Concretely rejected:

- generic SaaS admin-template appearance; copied Linear/Vercel/Stripe styling;
- giant KPI cards, meaningless charts, decorative "operational metrics";
- fake activity feeds, fake content, filler widgets;
- black/purple neon SaaS aesthetic, glassmorphism everywhere, random gradients;
- excessive rounded rectangles, excessive animations, huge whitespace without function;
- turning every dataset into cards when a dense table serves engineers better;
- "Welcome back" screens that answer no engineering question.

Tables are allowed and often appropriate: developer tools require scanability, identifiers, timestamps, status, technical density, filtering, and comparison (these rules operationalize the non-goals of [product-spec.md](product-spec.md) §8).

## 3. Information architecture — question first

Every screen states (in design, before implementation) **which engineering question it answers**:

| Screen | Engineering question |
|---|---|
| Overview | What currently needs attention? (runs in progress, unresolved findings, NOT_EVALUABLE verdicts, stale-writer/reconciliation events) |
| Experiment Builder | What controlled behavior will be executed? (steps, fault plan, repeat/concurrency/timeouts, limits, invariants bound) |
| Run Detail | What happened in this execution? (state machine, step outcomes incl. INDETERMINATE, snapshot reference) |
| Evidence | What was actually observed? (raw observations with integrity info, redaction notices) |
| Causal View | How are actions and effects related? (logical payment → deliveries → attempts → effects with attribution bases) |
| Timeline | What happened, overlapped, retried, or became ambiguous? |
| Invariant View | What rule was tested and why did it pass/fail? (definition version, inputs, verdict + justification) |
| Incident Zero | Can the user immediately understand the failure and the fix? (guided flagship narrative) |

If a proposed screen cannot state its question, it is a decoration — cut it.

## 4. Signature investigation UX

### Causal view
- Clearly separates **logical business actions** from **physical retries/attempts** using the identity model ([product-spec.md](product-spec.md) §7): one logical payment rendered once; its 20 deliveries rendered as attempts, not as 20 fake "events".
- Shows **attribution bases** (`identity-direct` / `identity-chain` / `temporal-correlation`) — visually distinguishing proven strength from weak hints.
- Purpose-built visualization, not a generic graph-library demo: the domain shape (one-to-many fan-out with convergence on effects) is the design.

### Timeline
- An **investigation tool**, not a vertical list of cards: filtering (by identity, kind, outcome), overlap visualization for concurrent work, explicit ordering bases ([evidence-model.md](evidence-model.md) §9), jump-to-evidence from any entry.
- Retries, experiment-declared repeats, and distinct business actions are visually and semantically distinct.
- INDETERMINATE entries are first-class: visibly uncertain, never smoothed into success or failure.

### Comparison
- Side-by-side run comparison for post-fix replay ([incident-replay.md](incident-replay.md) §6): same snapshot, verdicts and effect counts contrasted; evidence-level differences surfaced honestly.

## 5. Visual language (direction, not yet a design system)

- Dense, calm, high-contrast-neutral base; color used **semantically** (outcome/verdict) and never as the sole carrier of meaning.
- Monospace-for-identifiers discipline: IDs, amounts (integer minor units with explicit formatting, e.g., `500000 paisa`), hashes, and timestamps rendered in technical type.
- Motion only where it communicates (state transitions); no ambient animation.

## 6. Accessibility & responsiveness contract

- Designed deliberately for desktop, normal laptop, tablet, and mobile where reasonable — with graceful density degradation, not hidden features.
- State is never communicated by color alone (icons/text/labels accompany verdicts and statuses).
- Keyboard interaction and visible focus states throughout; readable contrast; semantic controls.
- Handled honestly: long identifiers (truncation with full-value inspection), large evidence sets (virtualized tables), error states, empty states, loading states, and **INDETERMINATE states** all designed, not afterthoughts ([testing-strategy.md](testing-strategy.md) §10 uses long IDs in fixtures to enforce this).

## 7. Content rules

- No fake data anywhere in the product UI: every displayed value originates from a real run's evidence or state.
- Empty states say what is empty and why (e.g., "No findings yet — run an experiment"); loading states show real progress where progress exists.
- Amounts render from integer minor units with currency; never floats ([product-spec.md](product-spec.md) §10).

## 8. UI quality gate (Phase 6/8 acceptance)

An independent visual/product audit inspects the **actually rendered** interface at multiple viewport sizes for: information hierarchy, spacing, typography, repetitive card layouts, generic component defaults, meaningless charts, fake content, responsiveness, accessibility, visual identity, and domain-specific workflow fit.

**A UI phase fails acceptance if the interface reads as "AI generated a generic admin dashboard."** Visual inspection is used to find and correct real defects — not to produce attractive screenshots ([AGENTS.md](../AGENTS.md) R-19).
