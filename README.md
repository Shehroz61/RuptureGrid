# RuptureGrid v1.0

**Status: PHASE 5 — Forensic analysis + timeline + findings implemented on branch `phase-5-forensics`, uncommitted, awaiting independent audit.** Phase 1 delivered the pnpm/TypeScript monorepo, four application shells, physically separate Control/Demo PostgreSQL services, Redis/BullMQ coordination foundation, real infrastructure tests, and migration workflow. Phase 2 turned the Demo Target into a real, deliberately small distributed fintech application: durable wallets/payments/events/deliveries/attempts/effects/ledger in its own PostgreSQL, a real signed webhook endpoint, deterministic VULNERABLE and SECURE processing modes switchable through the target's own admin API, a provider simulator, and a read-only inspection API. Phase 3 adds RuptureGrid's first real execution engine (`packages/engine`): registered-target security, versioned experiments, hash-pinned run snapshots, durable runs/steps/invocations with PostgreSQL lease + fencing-token ownership, BullMQ coordination with reconciliation recovery, a bounded HTTP executor with honest side-effect-knowledge classification (including `INDETERMINATE`), and minimal Control Plane API endpoints. Evidence, invariant evaluation, findings, and product UI: Phase 4 adds the deterministic evidence truth chain (`packages/evidence`) — hash-chained, redacted-before-persistence raw observations captured from real invocations, pure deterministic normalization (`demo-fintech-inspection-normalizer/v1`, `executor-invocation-normalizer/v1`), identity-based causal relationships, and the deterministic INV-IZ-1 invariant evaluation (verdicts `PASS` / `FAIL` / `NOT_EVALUABLE`) with evidence-set-hash idempotency and an integrity verifier — exposed through minimal read/analyze APIs. Phase 5 adds the deterministic forensic layer (`packages/forensics`): investigator-facing Findings derived from (never recomputing) persisted invariant evaluations — with typed proof references, confidence scopes (proven/uncertain), and database-constraint idempotency — a persisted, versioned, recomputable forensic timeline with explicit ordering bases and honest time semantics, reproduction definitions bound to frozen snapshots, computed-on-read run comparison, and investigation APIs. Product UI remains absent (Phase 6+). See `docs/reports/phase-2-self-audit.md`, `docs/reports/phase-3-self-audit.md`.

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

**Phase 2 status:** the target implements both modes and the canonical scenario is a committed black-box suite (`tests/integration/demo-incident-zero.test.ts`): under 20 concurrent duplicate deliveries (two logical events, concurrency 8) VULNERABLE deterministically yields 2 accepted credits / balance 1000000 paisa, SECURE deterministically yields 1 accepted credit / balance 500000 paisa with 19 suppressed attempts recorded as `IDEMPOTENT_DUPLICATE`. Details: [docs/incident-zero.md](docs/incident-zero.md), [docs/reports/phase-2-self-audit.md](docs/reports/phase-2-self-audit.md).

**Phase 3 status:** the Incident Zero transport workload can now be driven by RuptureGrid's own execution engine against the real target over HTTP: the engine registers the Demo target (credential references only), pins a hash-pinned snapshot, executes admin reset → mode → payment creation → signed webhook delivery with `${steps.…}` identity flow, and records durable per-invocation outcomes (all honestly classified, e.g. `KNOWN_OCCURRED` for the accepted credit). Invariant evaluation itself is Phase 4 (`tests/integration/evidence-invariants.test.ts`). See `tests/integration/demo-execution.test.ts`.

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

**Phase 0 — complete and accepted (tag `phase-0-accepted`). Phase 1 — complete and accepted (tag `phase-1-accepted`). Phase 2 — implemented on `phase-2-demo-fintech`, not yet independently audited.** Phase 2 deliverables: Demo Fintech domain model + migrations, vulnerable/secure webhook processing, provider simulator, admin (reset/mode) API, read-only inspection API, permanent black-box regression suites per [docs/phase-roadmap.md](docs/phase-roadmap.md). No Phase 2 commit/tag exists yet by design — the builder session leaves all changes uncommitted for independent audit.

## Running the stack locally

Requirements: Node 22, pnpm 11 (Corepack-managed), Docker with Compose.

```
pnpm install          # install workspace dependencies
cp .env.example .env  # local, gitignored environment (non-production values)
pnpm infra:up         # start control-postgres (5443), demo-postgres (5444), redis (6380)
pnpm db:migrate       # apply Prisma migrations to both databases
pnpm dev              # run API (3001), worker, Demo Fintech (3002), web (3000)
```

Quality gates: `pnpm verify` (format, lint, typecheck, unit tests, build). Real-infrastructure integration tests: `pnpm test:integration` (requires `pnpm infra:up`). Ports are defaults; every host port is environment-configurable — see `.env.example`.

## Demo Fintech target (Phase 2)

A genuinely separate application (`apps/demo-fintech`, default port 3002) owning its own PostgreSQL (`packages/demo-db`, migrations `0001_init_demo_database`, `20260909093622_phase2_domain_models`, `20260909093718_phase2_domain_constraints`). Money is always an **integer minor-unit string** on HTTP (e.g. `"amountMinor": "500000"` for PKR 5,000 = 500000 paisa); fractional, signed, exponent, and unsafe-magnitude values are rejected, never coerced. RuptureGrid apps hold no Demo DB credentials and never import `@rupturegrid/demo-db` (lint-enforced).

Routes (trust boundaries are distinct):

| Route | Auth | Purpose |
|---|---|---|
| `GET /health/live`, `GET /health/ready` | none | liveness; readiness checks Demo PostgreSQL only |
| `POST /demo/admin/reset` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — reset business records, recreate canonical customer + zero-balance PKR wallet, mode → VULNERABLE |
| `PUT /demo/admin/mode` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — body `{"mode":"VULNERABLE"\|"SECURE"}`; durable DB-backed state |
| `GET /demo/admin/status` | `DEMO_ADMIN_TOKEN` | current processing mode |
| `POST /demo/provider/payments` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — provider simulator: creates the canonical 500000-paisa CONFIRMED payment + its PAYMENT_CONFIRMED/PAYMENT_SETTLED events, returns per-event signed delivery envelopes (no `deliveryAttemptId` — callers assign one per physical delivery) |
| `POST /webhooks/provider` | HMAC-SHA256 of the exact raw body in `x-rupturegrid-provider-signature` | webhook ingestion; requires `x-rupturegrid-delivery-attempt-id` header; returns `outcome: APPLIED \| IDEMPOTENT_DUPLICATE` (2xx) or a stable error (401/404/409/400/500) |
| `GET /inspection/provider-payments/:providerPaymentId` | `DEMO_INSPECTION_TOKEN` | read-only full lineage: payment → events → deliveries → processing attempts → financial effects → ledger entries + wallet state (entities, not just counts) |
| `GET /inspection/wallets/:walletId/reconciliation` | `DEMO_INSPECTION_TOKEN` | read-only exact balance-vs-ledger reconciliation |

Environment variables owned by Demo Fintech only (documented non-production examples in `.env.example`): `DEMO_HOST`, `DEMO_PORT`, `DEMO_DATABASE_URL`, `DEMO_ADMIN_TOKEN`, `DEMO_INSPECTION_TOKEN`, `DEMO_PROVIDER_SIGNING_SECRET`.

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
  demo-fintech/   independent Demo Target (Express): wallets/payments/events/deliveries/
                  attempts/effects/ledger, webhook + admin + simulator + inspection APIs
packages/
  config/         per-app environment schemas, fail-fast validation, env ownership
  logger/         pino-based structured logging with mandatory redaction
  control-db/     RuptureGrid Control PostgreSQL client + migrations (Prisma)
  demo-db/        Demo Fintech PostgreSQL client + migrations + domain primitives (Prisma, separate)
  queue/          Redis/BullMQ coordination foundation (smoke queue, connections)
  shared/         service names, money types, redaction utilities
tests/
  unit/           config validation + redaction + demo money/keys/signature/payload unit tests (vitest)
  integration/    real PostgreSQL / Redis / HTTP / process tests incl. Incident Zero black-box suites (vitest)
docs/             Phase 0 architecture, 13 ADRs, roadmap, reports
```

## For contributors (human and AI)

Read [AGENTS.md](AGENTS.md) before touching anything. It is the constitution: phase boundaries, truth rules, ownership rules, and verification rules are not negotiable per-task.
