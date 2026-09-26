# RuptureGrid v1.0

**Status: PHASES 0–11 ACCEPTED AND FROZEN (tags `phase-0-accepted` … `phase-11-accepted`).** **v1.0.1 is published and CI-green**: licensed **Apache-2.0** (see [LICENSE](LICENSE)), released as **source only** — no npm, Docker-image, prebuilt-binary, or bundled-ffmpeg publication is part of the release, and that policy is unchanged. Public repository: [github.com/Shehroz61/RuptureGrid](https://github.com/Shehroz61/RuptureGrid) — vulnerability disclosure runs through GitHub Private Vulnerability Reporting there (see [SECURITY.md](SECURITY.md)).

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

One command — `pnpm incident-zero:verify` — starts the real Demo Target and real worker (owned child processes, exact PIDs), executes the canonical workload in both modes end to end (1 payment, 2 logical events, 20 deliveries, concurrency 8, real HTTP, real queue), and verifies from durable Control-Plane truth: VULNERABLE ⇒ 2 accepted equivalent credits / wallet 1000000 paisa / INV-IZ-1 **FAIL** / 1 Finding; SECURE ⇒ 1 accepted credit / wallet 500000 paisa / INV-IZ-1 **PASS** / 0 Findings. Details: [docs/incident-zero.md](docs/incident-zero.md).

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

Narrow by design: registered targets only, deny-by-default destination validation, DNS-aware SSRF protections with honest limitations (network egress isolation is the primary control), credentials redacted before persistence, server-side blast-radius caps, production environments denied. [docs/security-boundaries.md](docs/security-boundaries.md).

## Running the stack locally

Requirements: **Node.js ≥ 22.12** (Corepack-managed **pnpm ≥ 11**; the repo pins `pnpm@11.9.0` via `packageManager`), **Docker with Compose**, and network access to download dependencies on first install.

```
corepack enable        # once per machine — activates the pinned pnpm
pnpm install           # install workspace dependencies (frozen lockfile)
cp .env.example .env   # local, gitignored environment (non-production values)
pnpm infra:up          # start control-postgres (5443), demo-postgres (5444), redis (6380)
pnpm db:migrate        # generate Prisma clients + apply migrations to both databases
pnpm dev               # run API (3001), worker, Demo Fintech (3002), web (3000)
```

Every host port is environment-configurable — see `.env.example`. All first-run steps are listed above; there are no hidden manual steps.

## Verification commands

| Command | What it proves |
|---|---|
| `pnpm verify` | format + lint (workspace **and** root tests) + typecheck (workspace **and** test programs) + unit tests + build |
| `pnpm test:integration` | 24 real-infrastructure suites over real PostgreSQL ×2, Redis, HTTP, browser — requires `pnpm infra:up` and `pnpm db:migrate` |
| `pnpm incident-zero:verify` | the golden Incident Zero scenario end to end, exit 0 only on verified truth |
| `pnpm controlled-faults:verify` | pre-mutation rejection + post-mutation response-loss fault scenarios, including honest `INDETERMINATE` outcomes and zero unsafe retries |
| `pnpm showcase:generate` | browser showcase over a fresh real golden run (`--video` composes the H.264 walkthrough); artifacts land in gitignored `.artifacts/showcase/` |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | individual quality gates |

## Demo Fintech target

A genuinely separate application (`apps/demo-fintech`, default port 3002) owning its own PostgreSQL (`packages/demo-db`). Money is always an **integer minor-unit string** on HTTP (e.g. `"amountMinor": "500000"` for PKR 5,000 = 500000 paisa); fractional, signed, exponent, and unsafe-magnitude values are rejected, never coerced. RuptureGrid apps hold no Demo DB credentials and never import `@rupturegrid/demo-db` (lint-enforced).

Routes (trust boundaries are distinct):

| Route | Auth | Purpose |
|---|---|---|
| `GET /health/live`, `GET /health/ready` | none | liveness; readiness checks Demo PostgreSQL only |
| `POST /demo/admin/reset` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — reset business records, recreate canonical customer + zero-balance PKR wallet, mode → VULNERABLE |
| `PUT /demo/admin/mode` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — body `{"mode":"VULNERABLE"\|"SECURE"}`; durable DB-backed state |
| `GET /demo/admin/status` | `DEMO_ADMIN_TOKEN` | current processing mode |
| `PUT /demo/admin/faults/:faultKind` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — arm a controlled fault plan (LOCAL_DEVELOPMENT targets only; server-side bounds enforced) |
| `GET /demo/admin/faults` | `DEMO_ADMIN_TOKEN` | DEMO ONLY — current fault-plan state |
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
tsconfig.base.json / tsconfig.checks.json / tsconfig.checks.ui.json
                                 shared compiler options + test-typecheck gate programs
apps/
  api/            Control Plane HTTP API (NestJS): targets, experiments, runs,
                  evidence, analysis, forensics, timeline, comparison
  worker/         execution worker (BullMQ consumer lifecycle, no HTTP)
  web/            product UI (Next.js): runs, evidence, forensics, reproduction
  demo-fintech/   independent Demo Target (Express): wallets/payments/events/
                  deliveries/attempts/effects/ledger, webhook + admin + simulator
                  + inspection + controlled-fault APIs
packages/
  shared/         service names, money types, redaction utilities
  config/         per-app environment schemas, fail-fast validation, env ownership
  logger/         pino-based structured logging with mandatory redaction
  control-db/     RuptureGrid Control PostgreSQL client + migrations (Prisma)
  demo-db/        Demo Fintech PostgreSQL client + migrations + domain primitives
  queue/          Redis/BullMQ coordination boundary (coordination-only)
  engine/         execution engine: validation, snapshots, leases/fencing,
                  HTTP executor, classification, reconciliation (ADR-0009/0015)
  evidence/       evidence truth: redacted capture, hash-chained observations,
                  deterministic normalization, causal derivation, invariants
  forensics/      Findings from persisted evaluations, forensic timeline,
                  reproduction definitions, run comparison
  incident-zero/  golden Incident Zero orchestrator + verifier CLI
  controlled-faults/ controlled-faults verifier CLI (Phase 9 scenarios)
  showcase/       browser showcase automation over real verifier output
tests/
  unit/           config validation, redaction, UI semantics (vitest)
  integration/    real PostgreSQL / Redis / HTTP / process / browser suites,
                  incl. Incident Zero and controlled-faults black-box suites
docs/             architecture, product spec, security boundaries, decision records (ADRs),
                  phase roadmap, incident/scenario docs, per-phase audit reports
```

## For contributors (human and AI)

Read [AGENTS.md](AGENTS.md) before touching anything. It is the constitution: phase boundaries, truth rules, ownership rules, and verification rules are not negotiable per-task.

## License

RuptureGrid v1.0 is licensed under **Apache-2.0** — see [LICENSE](LICENSE).
Third-party dependencies retain their own licenses (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); `ffmpeg-static` is
development/showcase tooling only and is not bundled or distributed as a
RuptureGrid release artifact).
