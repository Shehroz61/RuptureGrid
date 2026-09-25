# Contributing to RuptureGrid

Welcome. RuptureGrid is developed under a strict engineering
constitution — read [AGENTS.md](AGENTS.md) first. It is binding for all
contributors, human and AI: phase boundaries (R-01), no fabricated truth
(R-02/R-03), verification before claims (R-07), data ownership (R-05),
integer-minor-unit money (R-06), and security boundaries (R-14) are not
negotiable per-task. This document covers the mechanical how-to; AGENTS.md
and [docs/engineering-rules.md](docs/engineering-rules.md) cover the why.

## Prerequisites

- **Node.js ≥ 22.12** (the repo pins pnpm via `packageManager`)
- **Docker with Compose** (PostgreSQL ×2 + Redis infrastructure)
- Network access for the first dependency install

## Install

```bash
corepack enable        # activates the pnpm pinned in package.json
pnpm install --frozen-lockfile
cp .env.example .env   # local, gitignored environment (non-production values)
```

## Infrastructure & migrations

```bash
pnpm infra:up    # control-postgres (5443), demo-postgres (5444), redis (6380)
pnpm db:migrate  # generate Prisma clients + apply migrations to both databases
```

The Control Plane and the Demo Target own **physically separate
PostgreSQL instances** (ADR-0002). Every schema change ships as a
reviewable Prisma migration (R-12) — never `prisma db push`, never a
schema push outside the migration history. Shadow databases are used for
migration verification.

## Running the stack

```bash
pnpm dev   # API (3001), worker, Demo Fintech (3002), web (3000)
```

## Tests

```bash
pnpm test:unit          # fast gates (vitest)
pnpm test:integration   # real PostgreSQL ×2, Redis, HTTP, browser — needs pnpm infra:up + pnpm db:migrate
```

Integration tests exercise the real stack — no mock stands in for
infrastructure semantics (R-08). A one-time manual run is never
acceptance evidence: acceptance properties live as committed, rerunnable
tests (R-07). If you changed behavior, add or extend a test that proves
it against the real stack.

## Verification before you push

```bash
pnpm verify  # format + lint (workspace AND root tests) + typecheck (workspace AND test programs) + unit tests + build
```

Both gates cover the whole tree: package tests are typechecked via
`tsconfig.checks.json` / `tsconfig.checks.ui.json` and linted by the root
ESLint program. `pnpm release:verify` additionally runs the Incident Zero
and Controlled Faults golden verifiers against real infrastructure.

## Architecture & security boundaries

Before changing anything structural, read:

- [docs/architecture.md](docs/architecture.md) — layering, durable truth
  (R-09), execution ownership and fencing (R-10)
- [docs/security-boundaries.md](docs/security-boundaries.md) — registered
  targets only, production faulting denied in v1, credential
  reference-only handling (R-13)
- [docs/decisions/](docs/decisions/) — the ADR record; changing a
  documented decision requires a new or amended ADR in the same change
  (R-17)

Hard rules you will hit quickly: never write to a target's business
state (R-05); money is integer minor units everywhere, including tests
(R-06); credentials are environment references, never persisted values
(R-13).

## Pull requests

- Keep changes phase-scoped; never implement a future phase "while
  you're in there" (R-01).
- Run `pnpm verify` (and `pnpm test:integration` for infrastructure
  changes) and state real observed results in the description — never
  claim verification you did not perform (R-07).
- Update docs in the same change when behavior or documented decisions
  change (R-17).
- Never commit secrets, generated artifacts, or unrelated files
  (R-16); `.env` is gitignored and placeholders in `.env.example` are
  non-production values only.
- Terminology is part of the contract (R-18): `INDETERMINATE` for
  ambiguous side effects, `NOT_EVALUABLE` for insufficient evidence,
  "logically append-only" for records — never "immutable" or
  "tamper-proof".
