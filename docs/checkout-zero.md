# RuptureGrid v1.1 — Checkout Zero (Second-Domain Scenario)

Status: **Frozen design contract (Phase 12 design freeze). Target implementation in Phase 16; scenario, invariants, and headless CLI execution in Phase 17; regression permanence in Phase 18. Not yet implemented — nothing in this document claims runtime behavior.**

Checkout Zero is the v1.1 second-domain proof scenario: a purpose-built commerce target that either oversells stock under two deliberately concurrent checkout submissions of one logical intent (vulnerable mode) or stays business-correct (secure mode), with RuptureGrid proving which happened from real evidence — using a different topology, a different failure driver, and a different invariant shape than Incident Zero.

Related: [product-spec.md](product-spec.md) §7 (identity model), [evidence-model.md](evidence-model.md) §6–§7 (attribution, honest uncertainty), [architecture.md](architecture.md) §7 (execution semantics, repeat ≠ retry), ADR-0008, ADR-0016, ADR-0017, ADR-0018, ADR-0020.

---

## 1. Scenario definition

A storefront checkout confirms one logical checkout intent against a stock of **one unit**: one SKU with **`initialAvailableUnits = 1`**, and **one logical checkout intent** for that SKU.

- **Correct behavior:** the intent yields exactly one accepted order and one accepted reservation; the SKU's remaining available units end at **0**.
- **Vulnerable target behavior:** under two deliberately concurrent submissions of the same logical intent, the target accepts more than one equivalent order and reserves stock that does not exist — 2 accepted orders, 2 accepted reservations, `remainingAvailableUnits = −1`.
- **Secure (fixed) target behavior:** under the equivalent experiment, intent-keyed idempotency yields exactly one accepted order, one reservation, `remainingAvailableUnits = 0`.

## 2. Actors and topology

```
RuptureGrid Executor (acts AS the storefront API client)
   │  submits checkout requests to the target's checkout endpoint
   │  (duplicate pressure is experiment-declared: two concurrent submissions,
   │   distinct requestAttemptIds, same stable checkoutIntentId)
   ▼
Demo Commerce checkout endpoint (generic HTTP contract, target-manifest/v1)
   │  accepts request (requestAttemptId correlated by target)
   │  enqueues/processing (processingAttemptId assigned by target)
   ▼
Demo Commerce business core
   │  vulnerable mode: order + reservation per submission (naive check-then-reserve)
   │  secure mode: idempotent order+reservation keyed by logical intent identity
   ▼
Target-owned orders + reservations + SKU stock (Target PostgreSQL — target-owned)
```

- The **storefront client is simulated by RuptureGrid's executor** acting as the target's API client over the target's legitimate HTTP interface. This is the deliberate topology contrast with Incident Zero (provider webhook sender); no target internals are touched ([architecture.md](architecture.md) §5).
- The step contract is **`GENERIC_HTTP`** with the conservative semantics of ADR-0016 Decision 3: definitive 2xx ⇒ `KNOWN_OCCURRED`; any post-send failure ⇒ `INDETERMINATE`; pre-send failures ⇒ `KNOWN_ABSENT`.
- Each physical submission carries an **executor-assigned `requestAttemptId`** (sent as a request header), so the target records the same correlation identity; the target assigns its own `processingAttemptId` values. Both sides can therefore be correlated from evidence alone.
- The target records its own domain objects (`checkoutIntent`, `checkoutEvent`, `requestAttempt`, `processingAttempt`, `order`, `reservation`, SKU stock facts).
- Switching between vulnerable and secure processing modes is done via the **target's own configuration/admin API** — a legitimate interface — never by editing target state behind its back (R-05).
- Inspection uses the target-authored read-only inspection API declared in the target manifest (`inspection/v1`; ADR-0016, ADR-0017): orders, reservations, and the SKU's stock facts (`initialAvailableUnits`, `remainingAvailableUnits`). RuptureGrid shape-validates responses against the declared schemas; values are checked, never interpreted; unknown or undeclared shapes produce **no events**.

## 3. Identity walk-through

One logical checkout intent under the concurrent-submission experiment:

| Layer | Identity | Count in vulnerable scenario |
|---|---|---|
| Logical checkout intent | `checkoutIntentId: CHK-001` | 1 |
| Logical checkout event | `checkoutEventId: CE-001` (`CHECKOUT_SUBMITTED` for CHK-001) | 1 |
| Physical submissions | `requestAttemptId: RA-001..RA-002` (two experiment-declared concurrent submissions) | 2 |
| Processing attempts | `processingAttemptId: PA-001..PA-0NN` (target-side; may exceed or trail submissions under concurrency/timeouts) | 1..N |
| Accepted business effects | `orderId` + `reservationId` (order for CHK-001; reservation against the SKU) | **must be ≤ 1 order — this is INV-CHK-1; exactly 1 reservation, conserved stock — this is INV-INV-1** |
| Resource subject | `sku: SKU-001` with integer-unit stock facts | 1 |

Declared identity chain (ADR-0017 Decision 4): `checkoutIntent` → `requestAttempt` → `processingAttempt` → `order` → `reservation` — five typed nodes with typed causal edges, exact field equality only; the chain length is a declaration of this target, not a platform assumption. The resource identity `sku` is the subject of the conservation invariant's declared facts.

Collapse rules (from [product-spec.md](product-spec.md) §7): repeated submissions and processing attempts are normal; duplicated *accepted effects* are the failure. If the target cannot distinguish a repeated submission from a distinct business action from its own records, that is itself a finding, reported honestly.

## 4. Experiment design — repeat ≠ retry, made load-bearing

Single experiment, parameterized:

1. **Setup step** — via the target's API: create the SKU with `initialAvailableUnits = 1` (integer units, R-06); ensure a clean logical context; switch target processing mode (`vulnerable` | `secure`) via target admin API.
2. **Submission step** — **two deliberately concurrent physical submissions for the SAME stable `checkoutIntentId: CHK-001`** (intent payload: customer, cart, total in integer minor units with explicit currency, destination SKU). Distinct `requestAttemptId`s per submission; real overlap.
   - This is an **explicit repeat/concurrency experiment scheduled by the scenario** — the platform's existing **repeat ≠ retry** distinction made load-bearing ([architecture.md](architecture.md) §7.2; ADR-0020 Decision 2): repeats are intentional experiment content with their own invocations; retries are executor-driven responses to failure and are governed by the declared conservative policy.
   - **This is NOT an automatic retry, and the canonical path contains no automatic retry anywhere.** An ambiguous mutating outcome remains `INDETERMINATE` and is **never automatically retried** (ADR-0008). The duplicate pressure comes only from the declared concurrent submissions.
3. **Settle step** — bounded polling until the target reports quiescence (no in-flight processing) — polling authoritative persisted state, never fixed sleeps ([testing-strategy.md](testing-strategy.md) §6).
4. **Verify step** — target-state verification via the target-authored read-only inspection API: accepted orders, accepted reservations, and the SKU's stock facts with their recorded provenance.

All steps recorded as observations; the entire run snapshotted at creation ([incident-replay.md](incident-replay.md)).

## 5. The invariants

Both invariants are instances of the **closed `business-invariant/v1` registry** (ADR-0018) — pure data bound to the target's declared event types and fields (ADR-0017); no user code, no SQL, no AI anywhere in evaluation.

### INV-CHK-1 — `atMostOneAcceptedEffect` (per checkout intent)

> **For the logical checkout intent CHK, the number of accepted orders equivalent to CHK, attributable at basis ≥ `identity-chain`, must not exceed one** (`maxAcceptedEffects = 1`).

Definitions used by the evaluation:

- **Accepted order** — an order recorded in the target's authoritative state, accepted (not rejected/pending), for the declared equivalence tuple.
- **Equivalent** — matches the tuple: logical checkout intent identity, customer, cart, order total (integer minor units + currency; ADR-0004).
- **Attributable** — per the attribution rules of [evidence-model.md](evidence-model.md) §6, requiring basis ≥ `identity-chain` for a FAIL verdict; `temporal-correlation` alone can never produce a FAIL.
- **Verdicts** — `PASS` (≤ 1 equivalent accepted order, **with effect-enumeration completeness
  provenance** establishing the relevant accepted-effect enumeration for this intent and scope
  is complete; see below), attribution complete; `FAIL` (≥ 2, **every** counted order attributed
  at basis ≥ `identity-chain`); `NOT_EVALUABLE` (an attribution gap among candidate effects,
  an enumeration-completeness gap, an incoherent verification scope, or the verification
  surface is absent or incomplete). An attribution gap is never silently dropped to manufacture
  a lower count — and never guessed around to manufacture a FAIL.
- **Completeness rule (PASS is not lower-bound-safe).** `observed orders ≤ 1` does not prove
  `existing orders ≤ 1` unless the inspection surface is proven complete for this subject and
  scope: completeness provenance must come from the observed surface under its declared contract
  (an explicitly exhaustive single-subject query, or a shape-validated completeness/total
  indicator bound to the same scope) — never from an empty list, a short list, pagination
  absence, the manifest declaration alone, or "no rows observed". If completeness cannot be
  established: `NOT_EVALUABLE`, never PASS. The FAIL asymmetry: with `maxAcceptedEffects = 1`,
  two fully attributable accepted orders already prove FAIL even if additional orders could
  exist unobserved.
- **Scope coherence.** Baseline, effect, and remaining-state evidence belong to one coherent
  verification scope — the run/snapshot, the declared target, the declared resource identity,
  the verification window, and the target's experiment generation where such a mechanism exists
  (ADR-0018 Decision 7). Out-of-scope evidence is `NOT_EVALUABLE`, never compared; unrelated
  external traffic must not cause a false PASS or a false FAIL.

### INV-INV-1 — `resourceConservation` (per SKU)

> **For the SKU, stock is conserved: `remainingAvailableUnits == initialAvailableUnits − acceptedReservedUnits`, with `acceptedReservedUnits ≤ initialAvailableUnits` and `remainingAvailableUnits ≥ 0`.**

The three declared integer-unit facts (ADR-0018 Decision 3):

- `initialAvailableUnits` — the baseline, from a baseline observation (never inferred);
- `acceptedReservedUnits` — counted from accepted reservation effects attributed to the declared consumption node at basis ≥ `identity-chain`;
- `remainingAvailableUnits` — the target-reported remaining state at verification time (may legitimately be negative under a broken target; that is exactly what FAIL records).

All three are integers in declared units — never floats (R-06/ADR-0004); arithmetic is exact integer arithmetic. All three facts must come from one coherent verification scope (ADR-0018 Decision 7); out-of-scope or incoherent evidence is `NOT_EVALUABLE`, never compared.

- **PASS** requires *complete, coherent, attributable* evidence: the baseline observation present and coherent, every counted reservation effect attributed at basis ≥ `identity-chain`, **reservation-enumeration completeness provenance** (as defined for INV-CHK-1), a remaining-state observation present, coherent, and shape-valid, no attribution or completeness gaps — and the conservation equalities above observed to hold.
- **FAIL** requires sufficient attributable evidence to prove a violation — any of:
  (a) `acceptedReservedUnits > initialAvailableUnits` — lower-bound-safe: with a coherent baseline and fully attributable counted reservations, unobserved additional reservations cannot undo the violation;
  (b) `remainingAvailableUnits < 0` — provable directly from an authoritative remaining-state observation for the evaluated resource/scope/window; enumeration completeness is not required merely to prove a negative authoritative remaining state;
  (c) `remainingAvailableUnits != initialAvailableUnits − acceptedReservedUnits` — valid **only** when baseline and remaining state are coherent and the reservation enumeration is **proven complete** with full attribution; otherwise `NOT_EVALUABLE`, never FAIL. Audit example: `initial = 10`, 2 observed accepted reservations, `remaining = 5` — without proof that the reservation set is complete, `5 != 10 − 2` MUST NOT produce FAIL (there may actually be 5 reservations).
- **NOT_EVALUABLE** is mandatory (never a guessed PASS or FAIL) when: the baseline observation is missing (**no inference of initial capacity — ever**; R-02); identity/attribution of any counted effect is below `identity-chain`; reservation-enumeration completeness cannot be established (required for PASS and for FAIL case (c)); the remaining-state observation is missing or shape-invalid; the verification scope/window is incoherent or cannot be established; or the verification surface is incomplete in any way — except where a lower-bound-safe FAIL (case (a); case (b) with an authoritative remaining observation) is already independently proven. The reason names the specific gap ([evidence-model.md](evidence-model.md) §7).
- **Scope coherence (ADR-0018 Decision 7).** Baseline, effect, and final inspection state must be proven to belong to one coherent verification scope — the same run/snapshot, declared target, declared resource identity, verification window, and target experiment generation where such a mechanism exists. A manifest *declaration* of experiment exclusivity is metadata/provenance only — never platform truth. Where coherence cannot be established, the verdict is `NOT_EVALUABLE`, never a guessed PASS or FAIL. Unrelated external traffic (an outside reservation, a restock, a concurrent human action) must not produce a false FAIL by breaking the arithmetic, nor a false PASS by matching a stale baseline; the demo-commerce target (Phase 16) must provide a deterministic way to bind baseline, effects, and final inspection state to the same experiment generation. The mechanism is a Phase 14/15 decision; the requirement is frozen here.
- **Anti-fabrication property** (ADR-0018 Consequences): a target reporting a self-consistent-but-fabricated remaining figure cannot produce a PASS — the remaining state must *agree* with baseline minus attributed consumption within a coherent verification scope, with identity-backed attribution and a complete reservation enumeration, so a fabricated figure shows up as case (c), a conservation disagreement (or as honest `NOT_EVALUABLE` where completeness/coherence cannot be established) — never as a PASS.

## 6. Expected behavior matrix

| Target mode | Experiment | Expected orders | Expected reservations | Expected `remainingAvailableUnits` | Expected verdicts |
|---|---|---|---|---|---|
| `vulnerable` | 2 concurrent submissions, one intent, SKU stock 1 | 2 | 2 | **−1** | **INV-CHK-1 FAIL, INV-INV-1 FAIL** (deterministic, evidence-backed) |
| `secure` | same experiment | 1 | 1 | 0 | **INV-CHK-1 PASS, INV-INV-1 PASS** |
| either | verification surface unavailable | — | — | — | **NOT_EVALUABLE** (honest) |

In vulnerable mode, the mechanism of failure is realistic, not artificial: the target processes each concurrent submission as an independent business action (naive check-then-reserve) and accepts an order + reservation per submission — reserving a unit that does not exist. The oversell is a *duplicated business effect consuming nonexistent stock* — exactly the class of failure RuptureGrid exists to expose.

## 7. The response-loss safety proof (separate experiment)

A distinct experiment — not the business-failure driver — proves the platform's own safety model against the second domain, mirroring the Phase 9 proof on Demo Fintech ([controlled-faults.md](controlled-faults.md) §4.2; ADR-0020 Decision 3):

- **Fault:** a target-owned `controlled-fault/v1` hook at the manifest-declared fault hook (`faultHook`; ADR-0016) — `RESPONSE_TRUNCATION` or `CRASH_MID_PROCESSING` — makes the target commit the order + reservation, then lose the response in flight.
- **Expected classification:** the executor's request was sent; the connection died in flight ⇒ conservative `transportStage=REQUEST_SENT` ⇒ mutating action ⇒ `intentOutcome=FAILED`, `sideEffectKnowledge=INDETERMINATE` (never laundered; ADR-0008).
- **Retry:** NEVER auto-retried, even if `SAFE` is declared. Exactly one attempt is made per repeat slot. The run ends FAILED with the ambiguity preserved — RuptureGrid does NOT collapse the ambiguity into success.
- **Later inspection (separate, out-of-band):** the target's committed truth (the order DID occur) is proven afterward through the target's read-only inspection API — a distinct observation that is never merged into the run's execution record and never rewrites execution-time knowledge.
- **Purpose:** regression-proof INDETERMINATE handling on a second topology: ambiguity persisted and displayed, zero unsafe retries, later inspection distinguished from execution observation.

## 8. What PASS/FAIL proves — and what it does not

Proves: for **this** logical checkout intent and **this** SKU, under **this** experiment, the target's authoritative business state did (or did not) violate INV-CHK-1 / INV-INV-1, with evidence-backed attribution and the exact verdict rules of §5.

Does not prove: general idempotency of the target's checkout; correctness under all concurrency patterns, timings, or stock levels; correctness of other SKUs, intents, or customers outside the experiment. Findings stay scoped; RuptureGrid never generalizes beyond evidence ([evidence-model.md](evidence-model.md) §10). A `NOT_EVALUABLE` verdict is a first-class honest outcome — in CI it is never a success (exit class 2; ADR-0019) — and an absent verification surface yields `NOT_EVALUABLE`, never a guessed verdict.

## 9. Regression permanence

Both modes of Checkout Zero become committed automated tests from Phase 17–18 onward ([testing-strategy.md](testing-strategy.md) §8; ADR-0019 Decision 4): the committed scenario file + expected verdicts + exit-code assertion run in CI via the headless CLI from a RuptureGrid checkout.

- vulnerable mode ⇒ the suite **must** produce deterministic FAIL findings for INV-CHK-1 **and** INV-INV-1 (exit 1);
- secure mode ⇒ the suite **must** produce deterministic PASS verdicts (exit 0, evidence chain verified);
- replay re-executes from the same hash-pinned snapshot ([incident-replay.md](incident-replay.md); ADR-0010) — the same `snapshotContentHash`, never a merged history;
- a one-time terminal demonstration by any agent is **not** acceptance evidence (R-07).

## 10. Forensic narrative (what the UI and report must be able to show)

For a vulnerable-mode run, an investigator should see, without leaving the tool: the single logical checkout intent; the two concurrent physical submissions (with experiment-declared repeat annotations and distinct `requestAttemptId`s); the overlap visualization of submissions and processing attempts; the two accepted orders + reservations with their attribution chains (`identity-chain` via submission → processing → order/reservation); the SKU stock progression (1 initial → 2 reserved → −1 remaining); the deterministic FAIL verdicts of INV-CHK-1 and INV-INV-1 with evidence references and exact matched fields; and the reproduction definition for replay after a fix. In secure mode the same view shows one order, one reservation, remaining 0, and both PASS verdicts. For the response-loss experiment, the `INDETERMINATE` outcome appears as a first-class uncertain entry — never silently resolved — with the later inspection observation kept distinct. The headless surface (`rupturegrid-report/v1`; ADR-0019) serializes the same durable truth: verdicts, reasons, evidence-set hashes, integrity status, and the resulting exit code.
