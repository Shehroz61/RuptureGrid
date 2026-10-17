# RuptureGrid

[![CI](https://github.com/Shehroz61/RuptureGrid/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Shehroz61/RuptureGrid/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Find the business failures hiding behind healthy services.**

A payment endpoint can return HTTP 200 while crediting a wallet twice. A
checkout service can stay online while selling stock it does not have.
RuptureGrid tests business correctness under distributed-system failures,
then explains the result through evidence from real execution.

It runs bounded HTTP experiments against registered targets, evaluates
business invariants, and preserves the failure → reproduction → target fix
→ replay → regression-test lifecycle.

## What you can investigate

- **Controlled failures:** duplicate delivery, concurrent requests,
  rejection and response loss, with real HTTP and Redis/BullMQ-backed work.
- **Business outcomes:** deterministic invariant evaluation and findings
  derived from captured business effects, with explicit insufficient-evidence
  results.
- **Evidence and forensics:** redacted observations, provenance, integrity
  verification, identity-based relationships and an investigation timeline.
- **Replay and comparison:** a new execution from the same hash-pinned
  snapshot, preserving original evidence and comparing original/replay
  outcomes without guessing why they differ.
- **Automation:** a headless CLI, `rupturegrid-report/v1` JSON reports,
  honest exit codes and permanent regression suites for two business domains.

PostgreSQL owns durable execution and evidence state. Redis coordinates
work; reconciliation recovers durable intent after queue outages. Ambiguous
side effects remain `INDETERMINATE`; insufficient evidence remains
`NOT_EVALUABLE`.

## Two real business proofs

| Scenario | Vulnerable processing | Secure processing |
| --- | --- | --- |
| **[Incident Zero — Fintech](docs/incident-zero.md)**: duplicate delivery of one legitimate PKR 5,000 payment confirmation | Two equivalent accepted credits; wallet credited PKR 10,000 | One accepted credit; wallet credited PKR 5,000 |
| **[Checkout Zero — Commerce](docs/checkout-zero.md)**: two concurrent submissions of one checkout intent against one unit of stock | Two accepted orders and reservations; remaining stock −1 | One accepted order and reservation; remaining stock 0 |

These outcomes are asserted by the golden and lifecycle tests against real
HTTP services and target-owned PostgreSQL state. Money uses integer minor
units: PKR 5,000 is `500000` paisa.

The Commerce companion lifecycle discovers a genuine failure, applies the
fix through the target's own administration API, then replays the original
reproduction from the **same stored snapshot** to an independently evaluated
PASS. The original failure stays intact. Existing mode-pinned golden
scenarios retain their declared modes; see [replay semantics](docs/incident-replay.md).

## Quick start

Use **Node.js 22, at least 22.12**, Corepack, Git, and Docker with Compose v2.
The repository pins **pnpm 11.9.0** in `package.json`. First installation
requires network access. See [setup and troubleshooting](docs/getting-started.md)
if Corepack is missing, outdated, or cannot create its shims.

```bash
git clone https://github.com/Shehroz61/RuptureGrid.git
cd RuptureGrid
corepack enable
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm test:unit
```

In Windows PowerShell, replace the `cp` line with:

```powershell
Copy-Item .env.example .env
```

Compose starts **three separate PostgreSQL instances**—Control (5443),
Fintech (5444), Commerce (5445)—and Redis (6380). Migrations generate the
Prisma clients and apply each database's own migration history. Configuration
and non-production example credentials come from [`.env.example`](.env.example).

Start all five applications in the foreground:

```bash
pnpm dev
```

Open the [web UI](http://localhost:3000). Defaults are API `3001`, Fintech
`3002`, Commerce `3003`, plus the worker process. Ports are configurable;
keep target origins and credential grants aligned when changing them.

### Run your first verification

After infrastructure and migrations are ready, run:

```bash
pnpm incident-zero:verify
```

This builds the project, starts its own Fintech target and worker processes,
and checks vulnerable FAIL and secure PASS from durable evidence. It exits
0 only when the verifier's assertions pass. Run verifiers serially in a
disposable local demo environment: they reset demo business state.

For the CLI entry point:

```bash
pnpm rupturegrid --help
```

The [CLI guide](docs/cli.md) covers target/worker prerequisites, Commerce
[scenario files](packages/cli/scenarios), replay, comparison and report exit
codes. There is no globally installed `rupturegrid` binary to assume.

## Architecture

```text
Web UI ---> Control Plane API ---> Control PostgreSQL <--- Headless CLI
                  |              durable runs and evidence     |
                  +---> Redis / BullMQ <------------------------+
                         coordination only
                              |
                        Execution workers
                              +--- evidence / analysis ---> Control PostgreSQL
                              +--- HTTP ---> Fintech ---- Fintech PostgreSQL
                              +--- HTTP ---> Commerce --- Commerce PostgreSQL
```

Each target owns its business logic and database. RuptureGrid changes target
behavior only through legitimate target interfaces and observes results
through explicit read-only inspection contracts. It never writes directly
to either target's business tables. [Architecture and ownership details](docs/architecture.md).

## Documentation

| Start here | Read |
| --- | --- |
| Install and run | [Getting started](docs/getting-started.md) |
| Headless execution and reports | [CLI](docs/cli.md) |
| Payment correctness proof | [Incident Zero](docs/incident-zero.md) |
| Checkout and inventory proof | [Checkout Zero](docs/checkout-zero.md) |
| Reproduction and comparison | [Replay](docs/incident-replay.md) |
| Use from another repository | [External CI recipe](docs/external-ci-recipe.md) |
| Components and data ownership | [Architecture](docs/architecture.md) |
| Evidence guarantees | [Evidence model](docs/evidence-model.md) |
| Authorized execution | [Security boundaries](docs/security-boundaries.md) |
| Work on the project | [Contributing](CONTRIBUTING.md) |
| Design decisions | [ADRs](docs/decisions/) |
| Verification and next steps | [Project status](docs/project-status.md) · [Roadmap](docs/phase-roadmap.md) |

## Safety and limits

Execution requires registered, authorized **non-production** targets.
Production execution is denied; controlled fault plans are restricted to
`LOCAL_DEVELOPMENT`, including denial on staging. Use isolated infrastructure
and appropriate network egress restrictions.

Snapshots and evidence records are **logically append-only**, with
modification detection—not protection from a privileged database writer.
Replay preserves intent, not exact network timing or thread scheduling.
Credential-reference authorization is checked; secret-value rotation behind
an unchanged authorized reference is not fingerprint-verified.

Distribution is **source-only**. There is no published CLI npm package,
prebuilt binary, RuptureGrid Docker image, hosted demo or SaaS service.
The two bundled targets demonstrate cross-domain correctness testing; they
are not evidence of independent third-party adoption or production safety.

## Contributing and security

Bug reports, focused improvements and evidence-backed regression tests are
welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[engineering constitution](AGENTS.md) before making changes.

Report vulnerabilities privately through the route in [SECURITY.md](SECURITY.md),
not public issues. RuptureGrid is licensed under [Apache-2.0](LICENSE).
Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
