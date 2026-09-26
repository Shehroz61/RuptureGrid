# ADR-0020: Checkout Zero — Second-Domain Decision and Scenario Safety Model

## Status

Accepted (Phase 12 — design freeze; target implemented Phase 16; scenario + CLI Phase 17).

## Context

The v1.1 theme (Second-Domain Generalization Proof) requires a second business domain that was **not**
designed around Incident Zero, to prove RuptureGrid's abstraction generalizes. The candidate
comparison (roadmap analysis, now frozen):

| Candidate | Different semantics from fintech | Realistic distributed bugs | Clean to build | Generalization proof | Verdict |
|---|---|---|---|---|---|
| **Order/inventory (checkout + stock)** | Yes — API-client topology, concurrent duplicate submissions, aggregate-capacity invariant | Duplicate orders under retry/timeout ambiguity; oversell under concurrency | Yes | Best — new contract path, new invariant shape | **Chosen** |
| Email/notification exactly-once | Thin — same single-effect shape as INV-IZ-1 | Duplicate sends under redelivery | Easy | Weak — near-rename of fintech entities | Rejected |
| Subscription/billing entitlements | No — fintech-adjacent; entitlement ≈ financialEffect | Entitlement duplication | Easy | Weakest — renaming fintech | Rejected |
| Job/workflow duplicate execution | Medium — infrastructure-flavored; effect observability is circular (the job IS the effect) | Duplicate dispatch | Medium | Medium | Rejected |
| Reservation/seat double-booking | Yes — exclusivity invariant (no two accepted reservations per seat×slot) is a genuinely third shape | Double-booking under concurrency | Medium | Strong | **Deferred** — designated third-domain proof beyond v1.1 (scope control) |

One earlier roadmap error is corrected here by mandate. The draft's canonical failure driver was:
post-send response loss → `INDETERMINATE` → *retry* → duplicate order. **That design is
rejected.** It violates RuptureGrid's own safety model: an ambiguous mutating outcome remains
`INDETERMINATE` and is **never automatically retried** (architecture §7.2; ADR-0008; the executor
rule "INDETERMINATE mutating outcome is never auto-retried" is already implemented and tested).
A scenario that depended on an automatic retry after ambiguity would require violating the
platform's core discipline — and would manufacture duplicates as an execution artifact rather
than observing them as target behavior.

## Decision

1. **The second domain is order/inventory (checkout + stock), demonstrated by `apps/
   demo-commerce`.** Entities: `checkoutIntentId` (logical business intent), `checkoutEventId`
   (logical event, e.g. `CHECKOUT_SUBMITTED`), `requestAttemptId` (physical API call),
   `processingAttemptId`, `orderId` + `reservationId` (accepted business effects), `sku` +
   stock figures (resource). Money-like fields (e.g. order total) are integer minor units with
   explicit currency (R-06/ADR-0004).
2. **Canonical Checkout Zero business-failure driver — deliberate concurrency, not retry.**
   Initial state: one SKU with `initialAvailableUnits = 1`; one logical checkout intent.
   Execution: **two deliberately concurrent physical submissions for the SAME stable
   `checkoutIntentId`** — an explicit repeat/concurrency experiment scheduled by the scenario
   (two physical requests, experiment-declared, distinct `requestAttemptId`s). This is the
   platform's existing **repeat ≠ retry** distinction made load-bearing (architecture §7.2):
   repeats are intentional experiment content with their own invocations; retries are
   executor-driven responses to failure and are governed by the declared conservative policy.
   - **VULNERABLE target:** accepts both submissions ⇒ 2 accepted equivalent orders,
     2 accepted reservations, `remainingAvailableUnits = −1` ⇒ INV-CHK-1 FAIL and
     INV-INV-1 FAIL.
   - **SECURE target:** intent-keyed idempotency ⇒ exactly 1 accepted equivalent order,
     1 reservation, `remainingAvailableUnits = 0` ⇒ both invariants PASS.
   Full scenario contract: [docs/checkout-zero.md](../checkout-zero.md).
3. **The ambiguous response-loss case is a separate safety proof, not the business-failure
   driver.** A distinct experiment (target-owned `controlled-fault/v1` hook, e.g.
   `RESPONSE_TRUNCATION` / `CRASH_MID_PROCESSING` at the manifest-declared fault hook) makes the
   target commit the mutation and lose the response. RuptureGrid records the honest
   `INDETERMINATE` side-effect knowledge, performs **no automatic retry**, and the run's
   execution record is never rewritten. Later out-of-band inspection may reveal what actually
   happened (e.g. the order DID commit); that inspection is a distinct observation that
   **does not rewrite execution-time knowledge** — the same later-inspection distinction Phase 9
   already proved on Demo Fintech (docs/controlled-faults.md §4.2).
4. **Invariants (instances of the ADR-0018 closed registry):**
   - `INV-CHK-1` — `atMostOneAcceptedEffect`: at most one accepted order equivalent to the
     logical checkout intent (equivalence tuple over intent/customer/cart/total/currency;
     identity-chain attribution required for FAIL).
   - `INV-INV-1` — `resourceConservation`: for the SKU, the corrected conservation model over
     `initialAvailableUnits`, `acceptedReservedUnits`, `remainingAvailableUnits`
     (ADR-0018 Decision 3: lower-bound-safe FAIL cases (a)/(b); equality-mismatch FAIL (c) only
     with proven-complete reservation enumeration; missing baseline, completeness gaps, or
     incoherent verification scope ⇒ NOT_EVALUABLE, never inferred or guessed;
     scope-coherence requirement per ADR-0018 Decision 7).
5. **Frozen v1.0 semantics untouched.** The Demo Fintech target, INV-IZ-1, and the golden suites
   are not modified by this decision; the Phase 15 conformance requirement (ADR-0018 Decision 5)
   binds the generic evaluator to the frozen one on Incident Zero fixtures.

## Consequences

- - What v1.1 proves and does not prove: it proves cross-domain generalization (the truth chain,
  attribution rules, and uncertainty semantics hold on a second domain not designed around
  Incident Zero), external-in-kind target integration (a target integrates through a data-only
  manifest over its own HTTP interfaces), and onboarding readiness from documentation (the
  Phase 19 stranger test). It does NOT prove independent third-party adoption, production
  adoption, or external organization usage — the stranger test is an adoption-readiness test,
  not evidence that a third party adopted RuptureGrid.
- The generalization proof is structurally strong: the second domain differs on topology
  (executor as the target's API client, not a provider webhook), on failure driver (deliberate
  concurrent duplicate submissions, not provider redelivery), and on invariant shape (an
  aggregate conservation model, not per-identity effect counting) — while reusing the identical
  truth chain, attribution rules, and uncertainty semantics.
- The repeat/retry boundary is now explicitly scenario-load-bearing and must be tested as such in
  Phase 17: the duplicate pressure comes from declared repeats with distinct
  `requestAttemptId`s; no automatic retry exists anywhere in the canonical path.
- The response-loss experiment doubles as a regression test for the platform's own safety model:
  INDETERMINATE persisted, zero unsafe retries, no rewrite of execution truth.
- `apps/demo-commerce` is a genuinely separate application with its own PostgreSQL instance; it
  is built to its own business logic (not around its invariant) — the Phase 16 audit must
  confirm the invariant is RuptureGrid-side and the target stands alone.
