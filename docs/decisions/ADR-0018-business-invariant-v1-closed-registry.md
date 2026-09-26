# ADR-0018: business-invariant/v1 — Closed Deterministic Invariant Registry

## Status

Accepted (Phase 12 — design freeze; implementation in Phase 15).

## Context

v1.0 proves business-correctness through exactly one flagship invariant (INV-IZ-1) plus two
Phase 9 evaluation-tier invariants (INV-DF-1/2), all Demo-Fintech-shaped and hard-coded:
evaluators filter on literal `demo.*` event types, and the finding rule throws on any invariant
other than INV-IZ-1 (`packages/forensics/src/finding.ts`). The v1.1 second domain needs a
declarative-but-closed invariant capability that can express both domains without becoming
arbitrary code execution, user-provided SQL, an AI truth oracle, or an unbounded general-purpose
DSL (product-spec §8; ADR-0007; R-03).

Two design errors from the earlier roadmap draft are corrected here by mandate:

1. **The `noOversell` shape was mathematically wrong.** Comparing accepted reservations against
   *current remaining* stock (`accepted ≤ stockOnHand`) is invalid when `stockOnHand` means
   remaining units: a correct target that received 1 reservation of 1 initial unit would report
   `stockOnHand = 0` and the comparison `1 ≤ 0` would falsely FAIL. A conservation model over
   explicit baseline, consumption, and remaining facts is required instead.
2. **Missing baselines must never be inferred.** Guessing `initialAvailableUnits` from observed
   activity would fabricate the very truth RuptureGrid exists to establish (R-02). Insufficient
   evidence is `NOT_EVALUABLE` — a first-class honest outcome (evidence-model §7).

## Decision

1. **`business-invariant/v1` is a closed registry.** Invariant *kinds* are a fixed, versioned
   vocabulary implemented, reviewed, and audited in platform code. Invariant *instances* are
   pure data: a `key`, a `kind` from the closed vocabulary, and typed `params` referencing only
   event types and fields declared in the target's manifest (ADR-0017) — validated at scenario
   definition time, before any run exists. Adding a kind requires a new ADR, new deterministic
   evaluators with truth-table tests, and an independent audit. There is no user code, no user
   SQL, no expressions, no AI anywhere in evaluation.
2. **v1.1 contains exactly two kinds:**
   - **`atMostOneAcceptedEffect`** — generalizes the INV-IZ-1 shape: for every subject of the
     declared subject node, the number of accepted effects attributable to it (basis ≥
     `identity-chain`) must not exceed `maxAcceptedEffects`. Params: `subjectEvent`,
     `effectEvent`, `equivalenceFields` (the effect-equivalence tuple, as in product-spec §10),
     `maxAcceptedEffects`.
     **PASS requires completeness, not just a small count.** `observed effects ≤ max` does not
     prove `existing effects ≤ max` unless the effect-enumeration surface is proven complete for
     the evaluated subject and verification scope. PASS holds only when ALL of: (1) the logical
     subject is unambiguously identified; (2) every counted accepted effect has sufficient
     required attribution; (3) the evaluation carries **effect-enumeration completeness
     provenance** — evidence, from the observed inspection surface under its declared contract,
     that the relevant accepted-effect enumeration for this subject and scope is complete (for
     example: an explicitly exhaustive single-subject query whose response contract defines the
     returned collection as complete, or a shape-validated completeness/total indicator observed
     in the inspection response and bound to the same scope); (4) counted accepted effects ≤
     `maxAcceptedEffects`. Completeness is never assumed from an empty list, a short list,
     pagination absence, a target-manifest declaration alone, or "no rows observed" — observed
     absence is not proof of absence. If completeness cannot be established, the verdict is
     `NOT_EVALUABLE`, never PASS. The exact JSON mechanism is a Phase 14/15 implementation
     decision; Phase 12 freezes only the requirement.
     **The FAIL/PASS asymmetry is explicit:** a duplicate-effect FAIL is provable from a
     lower-bound subset — with `maxAcceptedEffects = 1`, two fully attributable accepted effects
     already prove FAIL even if additional effects could exist unobserved. PASS is not
     lower-bound-safe and therefore requires the completeness provenance above.
   - **`resourceConservation`** (the no-oversell kind) — per resource (e.g. a SKU), evaluated
     over three declared integer-unit facts: `initialAvailableUnits` (the baseline), the set of
     accepted consumption effects (`acceptedReservedUnits`, counted from attributed effect
     events), and `remainingAvailableUnits` (the target-reported remaining state at verification
     time). Multiple resources are independent subjects; a violation on one SKU never conflates
     with another.
3. **`resourceConservation` verdict rules are exact:**
   - **Integer-unit semantics.** All three facts are non-negative-or-negative integers in declared
     units (never floats, R-06/ADR-0004); `remainingAvailableUnits` may legitimately be negative
     under a broken target — that is exactly what FAIL records. Arithmetic is exact integer
     arithmetic.
   - **Scope-coherence precondition.** The three facts are comparable only within one coherent
     verification scope (Decision 7): baseline, effects, and remaining state from incoherent
     scopes are never compared — that is `NOT_EVALUABLE`, never a verdict.
   - **PASS** requires *complete, coherent, attributable* evidence: a coherent baseline
     observation for the resource, complete attributable enumeration of the consumption effects
     (every counted reservation attributed to the declared consumption node at basis ≥
     `identity-chain`, plus enumeration-completeness provenance as defined for
     `atMostOneAcceptedEffect`), and a coherent remaining-state observation — no attribution
     gaps, no completeness gaps. Formally: every input fact present, attribution complete,
     enumeration complete, scopes coherent, and
     `remainingAvailableUnits == initialAvailableUnits − acceptedReservedUnits` (and
     `acceptedReservedUnits ≤ initialAvailableUnits`, and `remainingAvailableUnits ≥ 0`) observed
     to hold.
   - **FAIL conditions are partitioned by what the evidence can actually prove:**
     - **Case A — `acceptedReservedUnits > initialAvailableUnits`** may be proven from a
       **lower-bound subset**: with a valid, coherent baseline and every counted reservation
       attributable to the evaluated scope, additional unobserved reservations cannot undo the
       violation (observed consumption already exceeds capacity). Enumeration completeness is
       not required.
     - **Case B — `remainingAvailableUnits < 0`** may be proven **directly** when the
       remaining-state observation is authoritative for the evaluated resource/scope/window: an
       authoritative negative remaining state proves the violation by itself. Reservation
       enumeration completeness is not required merely to prove a negative authoritative
       remaining state.
     - **Case C — `remainingAvailableUnits != initialAvailableUnits − acceptedReservedUnits`**
       is valid **only** when the baseline is coherent, the remaining-state observation is
       coherent, the reservation enumeration is **proven complete**, and all counted reservations
       meet attribution requirements. An equality mismatch without a proven-complete reservation
       set is not evidence of a violation: unobserved reservations could reconcile the
       arithmetic. Without completeness, Case C yields `NOT_EVALUABLE`, never FAIL. Audit
       example: `initial = 10`, 2 observed accepted reservations, `remaining = 5` — without
       proof that the reservation set is complete, `5 != 10 − 2` MUST NOT produce FAIL (there
       may actually be 5 reservations).
     Each counted input carries its provenance (observation content hashes, event ids,
     relationship ids). This partition is the meaning of "a FAIL is never established by
     inference from partial evidence": Cases A and B are lower-bound-safe or direct; Case C is
     not, and is gated on completeness. Any required fact that is missing, ambiguous, or
     unattributable — outside an already-proven lower-bound-safe violation — forces
     NOT_EVALUABLE instead.
   - **NOT_EVALUABLE** is mandatory (never a guessed PASS or FAIL) when: the baseline observation
     is missing (no inference of initial capacity — ever); identity/attribution of any counted
     effect is below `identity-chain`; enumeration completeness of the counted consumption
     effects cannot be established (required for PASS and for Case C); the remaining-state
     observation is missing or shape-invalid; the verification scope/window is incoherent or
     cannot be established (Decision 7); or the verification surface is incomplete in any way —
     except where a lower-bound-safe FAIL (Case A; Case B with an authoritative remaining
     observation) is already independently proven. The reason names the
     specific gap (the v1.0 NOT_EVALUABLE honesty pattern, evidence-model §7).
4. **Finding rules join the same registry discipline.** Each invariant kind has a deterministic
   finding rule mapping a FAILed evaluation to a bounded reason code, fixed title/summary
   templates, and the minimal sufficient proof set (the v1.0 finding shape; evidence-model §8).
   New reason codes are added to the closed `FindingReasonCode` vocabulary by migration in
   Phase 15. PASS and NOT_EVALUABLE never produce findings (uncertainty and correctness are never
   converted into defects).
5. **Phase 15 conformance requirement (recorded now, binding then).** The generalized
   `atMostOneAcceptedEffect` evaluator is *derived from the same evaluation shape* as INV-IZ-1
   but the frozen v1.0 INV-IZ-1 evaluator is NOT modified. A committed conformance test must
   prove the generic evaluator agrees with the frozen evaluator on canonical Incident Zero
   evidence fixtures — including the NOT_EVALUABLE attribution-gap cases — before any generic
   evaluation ships. Verdict semantics (PASS / FAIL / NOT_EVALUABLE, attribution requirements)
   are identical to evidence-model §7.
6. **Frozen v1.0 semantics are untouched.** INV-IZ-1, INV-DF-1, INV-DF-2 evaluators and their
   golden suites continue to pass unchanged; the registry is additive.
7. **Verification-scope coherence is a frozen requirement (requirement only; the mechanism is a
   Phase 14/15 decision).** All evidence used by a state/conservation invariant must be proven
   to belong to one coherent verification scope, bound at minimum to: the RuptureGrid
   run/snapshot identity, the declared target, the declared resource identity, a verification
   scope/window, and a target state generation/reset epoch where the target provides such a
   mechanism. Timestamps are never used as causal identity for this binding. Permitted future
   mechanisms include a target-side state generation/reset token, a snapshot/generation
   identifier returned by the inspection surface, an explicitly verified experiment-exclusive
   target state, or another deterministic mechanism accepted in Phases 14/15 — Phase 12 freezes
   the requirement, not the mechanism. A manifest may *declare* experiment exclusivity or an
   equivalent claim about its own state; that declaration is metadata/provenance only and never
   creates platform truth (same boundary as ADR-0016 Decision 5). If the evaluator cannot
   establish that baseline, effects, and final state belong to one coherent scope, the verdict
   is `NOT_EVALUABLE`. The requirement protects truth in both directions: unrelated external
   traffic (an outside reservation, a restock, a concurrent human action on a shared resource)
   must not produce a false FAIL by breaking the arithmetic, and a stale baseline matched
   against fresh remaining state must not produce a false PASS. Phase 16's demo-commerce must
   therefore provide a deterministic way to bind baseline, effect, and final inspection state to
   the same experiment generation.

## Consequences

- Both v1.1 scenarios are expressible in data: INV-CHK-1 (`atMostOneAcceptedEffect` over
  checkout intents/orders) and INV-INV-1 (`resourceConservation` over SKU stock) — see
  docs/checkout-zero.md and ADR-0020.
- The corrected conservation model is decidable from honest evidence alone and cannot be fooled
  by a target that reports a self-consistent-but-fabricated remaining figure: the remaining state
  must *agree* with baseline minus attributed consumption within a coherent verification scope,
  and attribution must be identity-backed with a complete reservation enumeration, so a
  fabricated `remainingAvailableUnits` shows up as Case C — a conservation disagreement — rather
  than as a PASS (and where enumeration completeness or coherence cannot be established, as
  honest `NOT_EVALUABLE` — either way, never a PASS).
- Completeness and coherence are frozen requirements, not implementation details: PASS for both
  kinds, and Case C FAIL for `resourceConservation`, require effect-enumeration completeness
  provenance and a coherent verification scope (Decision 7). The JSON mechanism is a Phase 14/15
  decision; Phase 15 truth tables must enumerate the completeness-gap and incoherent-scope
  cases alongside the attribution-gap cases.
- Scope is deliberately narrow: two kinds only. The seat-booking exclusivity shape (third domain)
  and any aggregate/statistical kind are explicitly deferred (v1.1 scope control).
- The registry shifts some correctness burden to definition-time validation (unknown event types,
  undeclared fields, and malformed params must be rejected before execution); Phase 15 acceptance
  includes enumerated reject-cases.
