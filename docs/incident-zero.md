# RuptureGrid v1.0 — Incident Zero (Flagship Scenario)

Status: **Living contract — implemented and accepted (Phase 7; regression-permanent since Phase 7, tags `phase-7-accepted` … `phase-11-accepted`). Phases 0–11 accepted and frozen (released v1.0.1).**
Incident Zero is the flagship demonstration and permanent regression scenario: a purpose-built fintech target that either duplicates a payment credit under duplicate delivery (vulnerable mode) or stays business-correct (secure mode), with RuptureGrid proving which happened from real evidence.

Related: [product-spec.md](product-spec.md) §7 (identity model), [evidence-model.md](evidence-model.md), [architecture.md](architecture.md) §5 (target ownership), ADR-0004, ADR-0005.

---

## 1. Scenario definition

A payment provider confirms a legitimate payment of **PKR 5,000 = 500000 paisa** (integer minor units; ADR-0004) made by a customer whose wallet must receive **ONE equivalent credit**.

- **Correct behavior:** the appropriate wallet receives exactly one accepted credit of 500000 paisa attributable to that logical payment.
- **Vulnerable target behavior:** under duplicate/concurrent webhook delivery, the target credits the wallet more than once — e.g., the wallet ends at PKR 10,000 (1000000 paisa) after receiving two 500000-paisa credits for one confirmed payment.
- **Secure (fixed) target behavior:** under the equivalent failure experiment, the wallet receives exactly one credit — PKR 5,000.

## 2. Actors and topology

```
RuptureGrid Executor (acts AS the provider)
   │  delivers signed webhook payloads to the target's webhook endpoint
   │  (duplicate delivery is experiment-declared: repeat + concurrency + fault plan)
   ▼
Demo Target webhook endpoint
   │  accepts delivery (deliveryAttemptId recorded by target)
   │  enqueues/processing (processingAttemptId)
   ▼
Demo Target business core
   │  vulnerable mode: credit per delivery/attempt (naive)
   │  secure mode: idempotent credit keyed by logical identity
   ▼
Target-owned wallet + ledger + financial effects (Target PostgreSQL — target-owned)
```

- The **provider is simulated by RuptureGrid's executor** delivering webhook payloads through the target's legitimate HTTP interface. No target internals are touched ([architecture.md](architecture.md) §5).
- Each physical delivery carries an **executor-assigned `deliveryAttemptId`** (sent in a webhook header), so the target records the same correlation identity on its `WebhookDelivery`; the target assigns its own `processingAttemptId` values. Both sides can therefore be correlated from evidence alone.
- The target records its own domain objects (Phase 2 domain: `Customer`, `Wallet`, `ProviderPayment`, `ProviderEvent`, `WebhookDelivery`, `ProcessingAttempt`, `FinancialEffect`, `LedgerEntry`).
- Switching between vulnerable and secure processing modes is done via the **target's own configuration/admin API** — a legitimate interface — never by editing target state behind its back.

## 3. Identity walk-through

One logical payment under a duplicate-delivery experiment:

| Layer | Identity | Count in vulnerable scenario |
|---|---|---|
| Logical payment | `providerPaymentId: PP-001` | 1 |
| Logical provider event | `providerEventId: PE-001` (`payment.confirmed` for PP-001) | 1 |
| Physical deliveries | `deliveryAttemptId: D-001..D-020` (same payload, 20 experiment-declared deliveries) | 20 |
| Processing attempts | `processingAttemptId: PA-001..PA-0NN` (target-side; may exceed or trail deliveries under concurrency/timeouts) | 1..N |
| Accepted financial effects | `financialEffectId: FE-xxx` (500000 paisa credits to wallet W) | **must be ≤ 1 — this is the invariant** |

Collapse rules (from [product-spec.md](product-spec.md) §7): deliveries, retries, and processing attempts are normal; duplicated *accepted effects* are the failure. If the target cannot distinguish a retry from a distinct business action from its own records, that is itself a finding, reported honestly.

## 4. Experiment design

Single experiment, parameterized:

1. **Setup step** — via the target's API: create customer + wallet (balance 0), ensure clean logical context; switch target processing mode (`vulnerable` | `secure`) via target admin API.
2. **Delivery step** — deliver the `payment.confirmed` webhook for `providerPaymentId: PP-001`, `providerEventId: PE-001`, amount `500000`, currency `PKR`, destination wallet reference — with a fault plan:
   - `repeat: 20` identical deliveries (same logical event, 20 distinct `deliveryAttemptId`s),
   - `concurrency: 8` (real overlap),
   - optional variants: post-send timeout on selected deliveries, staggered redelivery waves.
3. **Settle step** — bounded polling until the target reports quiescence (no in-flight processing) — polling authoritative persisted state, never fixed sleeps ([testing-strategy.md](testing-strategy.md) §6).
4. **Verify step** — target-state verification via the target-authored read-only inspection API: wallet balance, ledger entries, financial effects with their recorded provenance.

All steps recorded as observations; the entire run snapshotted at creation ([incident-replay.md](incident-replay.md)).

## 5. The flagship invariant — INV-IZ-1

> **For every confirmed logical provider payment P, the number of accepted equivalent wallet-credit financial effects causally attributable to P must be less than or equal to one.**

Definitions used by the evaluation:

- **Accepted financial effect** — an effect recorded in the target's authoritative effects ledger (`financialEffectId` set), of type `credit`, to the destination wallet, for amount `500000`, currency `PKR`.
- **Equivalent** — matches the tuple: logical payment identity, destination wallet, effect type, amount, currency ([product-spec.md](product-spec.md) §10).
- **Causally attributable** — per the attribution rules of [evidence-model.md](evidence-model.md) §6, requiring basis ≥ `identity-chain` for a FAIL verdict; `temporal-correlation` alone can never produce a FAIL.
- **Evaluation inputs** — normalized events (deliveries, processing observations) + target-state verification (effects ledger, wallet balance, ledger entries).
- **Verdicts** — `PASS` (≤ 1 effect), `FAIL` (≥ 2 effects), `NOT_EVALUABLE` (effects exist but attribution is insufficient, or verification surface incomplete).

Illustrations:

| Scenario | Deliveries | Processing attempts | Accepted credits | Verdict |
|---|---|---|---|---|
| Duplicate delivery handled correctly | 20 | 20 | 1 (500000 paisa) | **PASS** |
| Duplicate delivery mishandled | 20 | 20 | 2+ (2× 500000 paisa) | **FAIL** |
| Two legitimate independent payments | 2 (distinct `providerPaymentId`) | 2 | 1 each | **PASS independently** |

The last row is deliberate: distinct logical payments must never be conflated into a false duplicate.

## 6. Expected behavior matrix

| Target mode | Experiment | Expected wallet delta | Expected INV-IZ-1 verdict |
|---|---|---|---|
| `vulnerable` | 20 duplicate deliveries, concurrency 8 | +1000000 paisa (PKR 10,000) — two accepted credits | **FAIL** (deterministic, evidence-backed) |
| `secure` | same experiment | +500000 paisa (PKR 5,000) — one accepted credit | **PASS** |
| `secure` | variant: post-send timeout + executor-declared-retry risk accepted | +500000 paisa — one accepted credit | **PASS** |
| either | verification surface unavailable | — | **NOT_EVALUABLE** (honest) |

In vulnerable mode, the mechanism of failure is realistic, not artificial: the target processes each delivery as an independent business action (naive implementation) and creates an accepted credit per processing attempt. The duplicate is a *duplicated business effect* — exactly the class of failure RuptureGrid exists to expose.

## 7. What PASS/FAIL proves — and what it does not

Proves: for **this** logical payment, under **this** failure experiment, the target's authoritative business state did (or did not) violate INV-IZ-1, with evidence-backed attribution.

Does not prove: general idempotency of the target; correctness under all failure classes; correctness of payments outside the experiment. Findings stay scoped; RuptureGrid never generalizes beyond evidence ([evidence-model.md](evidence-model.md) §10).

## 8. Variants (later phases)

- **Timeout-triggered retry variant** — deliveries include post-send timeouts; the experiment declares the retry policy explicitly; outcome classification exercises INDETERMINATE handling ([architecture.md](architecture.md) §7).
- **Crash-mid-processing variant** — the target exposes a controlled fault hook (target-owned) to crash a processing attempt after a ledger write but before effect finalization; exercises crash-after-mutation ambiguity.
- **Worker-race variant** — the target is deployed with multiple processing workers to expose dual-processing races.

Each variant is an *additional experiment definition*, never a mutation of the Incident Zero core; each becomes a permanent regression test in its own right.

## 9. Regression permanence

Both modes of Incident Zero are committed automated tests from Phase 7 onward ([testing-strategy.md](testing-strategy.md) §8):

- vulnerable mode ⇒ the suite **must** produce a deterministic FAIL finding;
- secure mode ⇒ the suite **must** produce a deterministic PASS finding;
- a one-time terminal demonstration by any agent is **not** acceptance evidence.

## 10. Forensic narrative (what the UI must be able to show)

For a vulnerable-mode run, an investigator should see, without leaving the tool: the single logical payment; 20 physical deliveries (with fault-plan annotations); the overlap/concurrency visualization of deliveries and processing attempts; the two accepted credits with their attribution chains (`identity-chain` via delivery → processing → effect); the wallet balance progression (0 → 500000 → 1000000 paisa); the deterministic FAIL verdict of INV-IZ-1 with evidence references; and the reproduction definition for replay after a fix. INDETERMINATE outcomes (if the experiment includes timeout variants) appear as first-class uncertain entries — never silently resolved.
