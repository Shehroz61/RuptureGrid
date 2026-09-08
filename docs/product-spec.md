# RuptureGrid v1.0 — Product Specification

Status: **Phase 0 — definition only. No runtime implementation exists.**
Authoritative for: what RuptureGrid is, what it is not, the identity model, the money model, and the truth hierarchy.

Related documents: [architecture.md](architecture.md), [evidence-model.md](evidence-model.md), [incident-zero.md](incident-zero.md), [security-boundaries.md](security-boundaries.md), [phase-roadmap.md](phase-roadmap.md).

---

## 1. What RuptureGrid is

RuptureGrid is a developer-infrastructure platform for **discovering business-correctness failures in distributed systems** through controlled failure experiments.

It combines four capabilities into one workflow:

1. **Controlled failure testing** — deliberate, repeatable introduction of realistic distributed-system failures (duplicate delivery, timeout after send, retry storms, concurrent processing) against an explicitly authorized target.
2. **Business invariant verification** — deterministic evaluation of declared business rules (e.g., "one confirmed payment must produce at most one accepted credit") against real observed effects.
3. **Forensic analysis** — reconstruction of what actually happened, grounded in captured evidence: which logical action produced which physical attempts, which attempts produced which business effects, and where ambiguity remains.
4. **Reproduction / regression replay** — the ability to re-run the same experiment intent after a fix, and to keep the scenario as a permanent automated regression test.

## 2. The question RuptureGrid answers

> **"Did the system remain BUSINESS-CORRECT when realistic distributed-system failures occurred?"**

This is deliberately deeper than the operational questions conventional tooling answers:

| Conventional tooling answers | RuptureGrid answers |
|---|---|
| Did the service stay online? | Did business state stay correct? |
| Did HTTP return 200? | Did the 200 hide a duplicated financial effect? |
| Did the worker remain alive? | Did two workers corrupt a shared business rule? |
| Did the queue process a message? | Did one logical event become multiple business effects? |

A distributed system can look operationally healthy while corrupting business state. RuptureGrid exists to expose that gap.

## 3. Failure classes in scope

The failure classes RuptureGrid is designed to expose (via controlled experiments):

- **Duplicate delivery** — a webhook is delivered more than once; the target creates multiple business effects for one logical event.
- **Retry duplication** — a retry (by the caller or the target) produces a duplicate order, credit, or side effect.
- **Concurrent processing** — two workers process the same logical event; combined effect violates a business rule.
- **Timeout ambiguity** — a mutating request times out after the target performed the mutation; the caller believes it failed.
- **Crash after remote mutation** — the executor or target crashes after a remote mutation, leaving ambiguous state.
- **Redelivery effect multiplication** — redelivery causes multiple business effects, not just multiple processing attempts.
- **Stale ownership** — a worker whose lease expired writes newer durable state over the current owner's state.
- **Invariant races** — a race condition violates a rule such as "wallet balance may not go negative" or "at most one credit per confirmed payment".

Out of scope for v1: infrastructure-level chaos (CPU/memory exhaustion, network partitions between arbitrary services, disk failures, clock skew injection). These are generic chaos-engineering concerns, not business-correctness concerns (see §8).

## 4. Product pipeline

The conceptual flow, and the component that owns each stage:

```
TARGET SYSTEM            (authorized target, incl. purpose-built Demo Target)
        ↓
CONTROLLED EXPERIMENT    (Control Plane: experiment definition, configuration)
        ↓
REAL EXECUTION           (Execution Plane: workers, adapters, fault injection)
        ↓
REAL OBSERVATIONS        (Evidence System: raw observations at execution time)
        ↓
NORMALIZATION            (Analysis System: versioned normalizers)
        ↓
CAUSAL RECONSTRUCTION    (Analysis System: identity-based causal relationships)
        ↓
BUSINESS INVARIANT
EVALUATION               (Analysis System: deterministic invariant engine)
        ↓
FINDING                  (Analysis System: evidence-backed conclusion)
        ↓
FORENSIC INVESTIGATION   (UI: evidence browser, causal view, timeline)
        ↓
REPRODUCTION             (Control Plane: reproduction definition from snapshot)
        ↓
REMEDIATION              (human workflow: fix the target)
        ↓
REGRESSION REPLAY        (Control Plane + Execution Plane: same experiment re-run;
                          committed automated test)
```

Every stage is grounded in the previous one. Nothing downstream may invent content for an upstream stage (see §9, Truth hierarchy).

## 5. The nine product questions

RuptureGrid must eventually answer, with evidence for every answer:

1. **What happened?** → Timeline + observations (Evidence, Analysis, UI).
2. **What business rule was violated?** → Invariant definitions and evaluation results (Control Plane, Analysis).
3. **What actual state/effect proves the violation?** → Business-effect evidence, target-state verification (Evidence, Analysis).
4. **Which execution path led to it?** → Causal reconstruction from identity linkage (Analysis).
5. **Which requests/events were retries versus distinct business actions?** → Identity model (§7) + normalized events (Analysis).
6. **Was the result definitive or uncertain?** → Explicit outcome semantics, including INDETERMINATE (architecture.md §7).
7. **Can we reproduce the incident?** → Reproduction definitions (incident-replay.md).
8. **Can we replay the same experiment after a fix?** → Snapshot-based replay (incident-replay.md).
9. **Did the fix actually survive?** → Regression replay as permanent automated test (testing-strategy.md §8).

## 6. Users and use cases (v1 direction)

- **Backend engineer** — "Does my webhook handler survive duplicate delivery?" Runs Incident Zero against a local or staging target.
- **SRE / platform engineer** — "Which business rules break under realistic retries and races?" Runs experiments against authorized staging environments before incidents happen in production.
- **Release / QA engineer** — "Is the idempotency fix still holding?" Runs regression replay in CI.

Deployment evolution (post-v1; ADR-0011 sketches the private-network agent direction): local developer tool → CI integration → self-hosted → SaaS control plane with a private-network execution agent. No commercial features (billing, orgs, SSO) are designed or implemented in v1; early choices must not block them (§9).

## 7. Business identity model

RuptureGrid's central analytical concept is the distinction between **logical business identity** and **physical attempts**. These five identities must never be casually collapsed:

| Identity | Represents | Cardinality example (Incident Zero) |
|---|---|---|
| `providerPaymentId` | The logical provider-confirmed payment. One real payment at the payment provider. | 1 |
| `providerEventId` | A logical provider event (e.g., `payment.confirmed`) about that payment. | 1 |
| `deliveryAttemptId` | One physical network/webhook delivery of that event. | 1..N |
| `processingAttemptId` | One application processing attempt of one delivery. | 1..N |
| `financialEffectId` | One accepted financial/business effect (e.g., an accepted wallet credit). | must be ≤ 1 per logical payment (INV-IZ-1) |

Collapse rules:

- One logical payment may experience **many deliveries** and **many processing attempts**.
- One logical payment must create **at most one equivalent accepted credit effect**.
- Multiple deliveries, multiple retries, and multiple processing attempts are **normal distributed-system behavior** — they are NOT business failures by themselves.
- The **duplicated business effect** is the failure. RuptureGrid must therefore count and attribute *effects*, not attempts.
- A retry and a distinct business action must be distinguishable from evidence alone. Where the target's payloads and records do not carry enough identity to distinguish them, that is itself a finding (the target cannot prove correctness), recorded honestly rather than guessed away.

Full worked example: [incident-zero.md](incident-zero.md).

## 8. Explicit non-goals

RuptureGrid is **not** any of the following. Each line is a boundary, not a roadmap item:

| RuptureGrid is NOT | Reason |
|---|---|
| Generic chaos-engineering software | Business correctness under application-level failure is the focus, not infrastructure fault diversity. |
| Generic observability / APM / log viewer | RuptureGrid captures evidence for its own experiments; it does not monitor systems continuously. |
| Generic workflow automation platform | Experiments are bounded, reviewed, declared artifacts — not arbitrary pipelines. |
| Arbitrary HTTP proxy | Only registered, authorized target origins are callable (security-boundaries.md). |
| Arbitrary internet attack tool | Fault injection is narrowly scoped, authorized, and never targeting production (security-boundaries.md). |
| Arbitrary production fault injector | Production environments are **denied** for fault execution in v1 unless a future dedicated security architecture explicitly enables it. |
| SIEM / BI dashboard | Findings are experiment-scoped engineering conclusions, not enterprise analytics. |
| Kubernetes management platform | Out of scope; not required for the product's purpose. |
| AI incident oracle | AI may interpret; it may never decide (§9, ADR-0007). |
| Fake demo generator | Every number RuptureGrid shows comes from real execution (§9). |

## 9. Truth hierarchy

The conceptual truth hierarchy, refined:

```
REAL EXECUTION
  → RAW OBSERVATIONS            (what was actually observed at execution time)
  → NORMALIZED EVENTS           (deterministic, versioned projections)
  → CAUSAL RELATIONSHIPS        (identity-based, with declared basis and strength)
  → INVARIANT EVALUATION        (deterministic verdict: PASS / FAIL / NOT_EVALUABLE)
  → DETERMINISTIC FINDING       (provenance-carrying conclusion)
  → OPTIONAL AI INTERPRETATION  (explicitly labeled interpretation, never truth)
```

Rules:

- Each layer is derived **only** from the layers above it, deterministically where determinism is possible.
- AI output is always a separate, labeled layer. AI must not invent evidence, invent causal relationships, change invariant results, or convert uncertainty into certainty (ADR-0007).
- Uncertainty is a first-class, representable outcome (`INDETERMINATE` side-effect knowledge, `NOT_EVALUABLE` invariant verdicts). The system must be able to say "we cannot determine this" — honestly and visibly — rather than defaulting to a reassuring answer.

## 10. Money model

- All financial amounts are **integers in minor units**. For PKR, the minor unit is the paisa: **PKR 5,000 = 500000 paisa**.
- Floating-point arithmetic must never be used for financial correctness (ADR-0004).
- Every financial amount carries an explicit currency code (v1 deals with PKR; the field exists so a second currency does not require a redesign, but no multi-currency engine is built now).
- Financial-effect **equivalence** is defined by the tuple: logical payment identity, destination wallet/account, effect type (e.g., credit), amount, currency. Two effects matching on this tuple, attributable to the same logical payment, are duplicates.

## 11. Success criteria for v1

1. Incident Zero executes end-to-end against the purpose-built Demo Target: vulnerable mode produces a deterministic FAIL; secure mode produces a deterministic PASS ([incident-zero.md](incident-zero.md)).
2. The same scenario re-runs from its snapshot after a "fix" and the finding reflects the new reality.
3. Both modes are committed permanent regression tests, not one-time demonstrations ([testing-strategy.md](testing-strategy.md) §8).
4. Every number in the UI is traceable to captured evidence; no fabricated content anywhere.
5. The system honestly represents INDETERMINATE outcomes and NOT_EVALUABLE verdicts wherever they genuinely occur.

## 12. Glossary

Canonical definitions live in [evidence-model.md](evidence-model.md) (evidence terms), [architecture.md](architecture.md) (execution terms), and [incident-zero.md](incident-zero.md) (Incident Zero terms). Where documents overlap, the terminology here and in evidence-model.md is canonical.
