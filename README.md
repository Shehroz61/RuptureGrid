# RuptureGrid v1.0

**Status: PHASE 1 — foundation implemented on branch `phase-1-foundation`, uncommitted, awaiting independent audit.** The Phase 1 branch adds the pnpm/TypeScript monorepo, four application shells (API, worker, web, Demo Fintech), physically separate Control/Demo PostgreSQL services, Redis/BullMQ coordination foundation, real infrastructure tests, and migration workflow. No product domain behavior exists yet — no wallets, payments, experiments, evidence, or Incident Zero execution. See `docs/reports/phase-1-self-audit.md`.

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

**Phase 0 — complete and accepted (tag `phase-0-accepted`). Phase 1 — implemented on `phase-1-foundation`, not yet independently audited.** Phase 0 deliverables: documentation set, 13 ADRs, requirements matrix, self-audit. Phase 1 deliverables: monorepo + core infrastructure foundation per [docs/phase-roadmap.md](docs/phase-roadmap.md). No Phase 1 commit/tag exists yet by design — the builder session leaves all changes uncommitted for independent audit.

## Running the Phase 1 foundation locally

Requirements: Node 22, pnpm 11 (Corepack-managed), Docker with Compose.

```
pnpm install          # install workspace dependencies
cp .env.example .env  # local, gitignored environment (non-production values)
pnpm infra:up         # start control-postgres (5443), demo-postgres (5444), redis (6380)
pnpm db:migrate       # apply Prisma migrations to both databases
pnpm dev              # run API (3001), worker, Demo Fintech (3002), web (3000)
```

Quality gates: `pnpm verify` (format, lint, typecheck, unit tests, build). Real-infrastructure integration tests: `pnpm test:integration` (requires `pnpm infra:up`). Ports are defaults; every host port is environment-configurable — see `.env.example`.

## Repository layout

```
README.md                        this file
AGENTS.md                        engineering constitution for all contributors
compose.yaml                     local infrastructure (control/demo postgres, redis)
.env.example                     documented non-production environment template
eslint.config.mjs / .prettierrc.json / vitest.config.ts   root quality tooling
apps/
  api/            Control Plane HTTP shell (NestJS): health/live, health/ready
  worker/         execution worker shell (BullMQ consumer lifecycle, no HTTP)
  web/            product shell (Next.js): identity page + /health, no dashboard
  demo-fintech/   independent Demo Target shell: owns only the Demo DB
packages/
  config/         per-app environment schemas, fail-fast validation, env ownership
  logger/         pino-based structured logging with mandatory redaction
  control-db/     RuptureGrid Control PostgreSQL client + migrations (Prisma)
  demo-db/        Demo Fintech PostgreSQL client + migrations (Prisma, separate)
  queue/          Redis/BullMQ coordination foundation (smoke queue, connections)
  shared/         service names, money types, redaction utilities
tests/
  unit/           config validation + redaction unit tests (vitest)
  integration/    real PostgreSQL / Redis / HTTP / process tests (vitest)
docs/             Phase 0 architecture, 13 ADRs, roadmap, reports
```

## For contributors (human and AI)

Read [AGENTS.md](AGENTS.md) before touching anything. It is the constitution: phase boundaries, truth rules, ownership rules, and verification rules are not negotiable per-task.
