# RuptureGrid v1.0

**Status: PHASE 0 — definition and architecture only. PHASE 0 HAS NO RUNTIME IMPLEMENTATION.** No source code, no dependencies, no database schemas, no builds exist yet. This repository currently contains documentation and ADRs exclusively.

---

## What RuptureGrid is

RuptureGrid is a developer-infrastructure platform for **discovering business-correctness failures in distributed systems** through controlled failure testing, business invariant verification, forensic analysis, and reproduction/regression replay.

The question it answers:

> **Did the system remain BUSINESS-CORRECT when realistic distributed-system failures occurred?**

Not: "Did the service stay online?" or "Did HTTP return 200?" — a distributed system can look operationally healthy while crediting a wallet twice for one payment, duplicating an order on retry, or overselling from stale state. RuptureGrid exposes exactly that gap, reproducibly and with evidence.

## Why it exists

Conventional testing and observability stop at operational health. The most expensive distributed-system failures are business-correctness failures that hide behind healthy signals: a duplicate webhook that credits money twice, a timeout where the side effect actually happened, two workers processing one logical event. RuptureGrid makes these failures **deliberate, observable, attributable, and permanent regression tests**.

## What it is NOT

- Not generic chaos engineering, APM, or a log viewer
- Not an arbitrary HTTP proxy or attack tool — only registered, authorized targets; **production fault targeting is denied in v1**
- Not a workflow platform, SIEM, or BI dashboard
- Not an AI incident oracle — AI may interpret evidence, never decide truth

Full boundary list: [docs/product-spec.md](docs/product-spec.md) §8.

## Incident Zero (flagship scenario)

A provider confirms a legitimate payment of **PKR 5,000 = 500000 paisa** (integer minor units). The correct target credits the wallet with **exactly one credit**. A deliberately vulnerable processing mode credits it **twice under duplicate delivery** (PKR 10,000); a fixed, idempotent implementation stays at PKR 5,000 under the same experiment. RuptureGrid drives the duplicate delivery through the target's legitimate webhook interface, evaluates the invariant **"at most one accepted credit effect per confirmed logical payment"** deterministically from real evidence, and replays the scenario after the fix — permanently, as automated tests.

Details: [docs/incident-zero.md](docs/incident-zero.md).

## Architecture at a high level

Five logical bounded contexts — **Control Plane, Execution Plane, Evidence System, Analysis System, Demo Target** — deployed as API + worker + separate Demo Target application + web UI. PostgreSQL owns durable truth; Redis/BullMQ is coordination-only (a Redis outage must never lose a run — reconciliation recovers it). Execution ownership uses durable leases with fencing tokens so a stale worker cannot overwrite newer state, and ambiguous mutating outcomes are represented honestly as **INDETERMINATE** rather than guessed. Historical runs are pinned to append-only, hash-pinned snapshots for reproduction.

Details: [docs/architecture.md](docs/architecture.md).

## Truth philosophy

```
REAL EXECUTION → RAW OBSERVATIONS → NORMALIZED EVENTS → CAUSAL RELATIONSHIPS
→ INVARIANT EVALUATION → DETERMINISTIC FINDING → OPTIONAL AI INTERPRETATION
```

Every layer derives only from the layer above; AI sits strictly at the end, labeled, never authoritative. If RuptureGrid says "20 requests executed", 20 real requests executed. If it cannot determine something, it says **INDETERMINATE / NOT_EVALUABLE** — visibly. Details: [docs/evidence-model.md](docs/evidence-model.md).

## Security boundary

Narrow by design: registered targets only, deny-by-default destination validation, DNS-aware SSRF protections with honest limitations, credentials redacted before persistence, server-side blast-radius caps, production environments denied. [docs/security-boundaries.md](docs/security-boundaries.md).

## Roadmap

Phase 0 (this) → 1 Monorepo foundation → 2 Demo Target → 3 Execution engine → 4 Evidence + invariants → 5 Forensics → 6 Product UI → 7 Incident Zero golden scenario → 8 Demo showcase → 9 More faults + observability → 10 Full audit → 11 Public release. Per-phase gates: [docs/phase-roadmap.md](docs/phase-roadmap.md).

## Current phase status

**Phase 0 — Product Definition + Architecture + Engineering Constitution.** Deliverables: the documentation set, 13 ADRs, requirements matrix, self-audit. Verdict: **PHASE 0 READY FOR INDEPENDENT AUDIT** (builder's verdict; independent acceptance is deliberately not the builder's to give). Next: independent audit, then Phase 1 per the roadmap.

## Repository layout

```
README.md                        this file
AGENTS.md                        engineering constitution for all contributors
docs/
  product-spec.md                product definition, identity model, money, non-goals
  architecture.md                contexts, topology, ownership, execution semantics
  engineering-rules.md           phase flow, definitions of done, git/migration rules
  testing-strategy.md            testing constitution, adversarial catalog
  security-boundaries.md         authorization, SSRF/DNS/redirects, redaction, limits
  evidence-model.md              evidence terminology, integrity, causality, findings
  incident-zero.md               flagship scenario design
  incident-replay.md             reproduction & snapshot contracts
  product-design.md              UI philosophy, IA, quality gate
  phase-roadmap.md               phases 0–11 with acceptance criteria
  phase-0-requirements.md        traceability matrix
  decisions/                     ADRs 0001–0013
  reports/                       phase self-audit reports
```

## For contributors (human and AI)

Read [AGENTS.md](AGENTS.md) before touching anything. It is the constitution: phase boundaries, truth rules, ownership rules, and verification rules are not negotiable per-task.
