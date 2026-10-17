# Contributing to RuptureGrid

Help make business-correctness failures easier to reproduce, understand and
prevent. Useful contributions include reproducible bug reports, clearer
documentation, focused fixes and regression tests that exercise real effects.

Read [AGENTS.md](AGENTS.md) and the [engineering rules](docs/engineering-rules.md).
They apply to human and AI contributors. The central expectations are simple:
report only observed truth, respect target ownership, preserve uncertainty,
and keep work within its authorized phase. Contributions use the project's
[Apache-2.0 license](LICENSE).

## Set up a development checkout

You need Git, **Node.js 22 (at least 22.12)**, Corepack, and Docker with
Compose v2. The workspace pins **pnpm 11.9.0**; keep that pin and the lockfile.

```bash
corepack enable
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:migrate
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
Corepack shim installation may need write permission to the Node installation;
[getting started](docs/getting-started.md) covers alternatives and troubleshooting.

Compose supplies three independent PostgreSQL instances (Control, Fintech,
Commerce) and Redis. `pnpm db:migrate` generates clients and applies all three
migration histories. `pnpm dev` builds and starts API, worker, web UI and both
target applications. The gitignored `.env` contains local configuration;
never commit it or paste its values into an issue.

## Find the right change

Search [existing issues](https://github.com/Shehroz61/RuptureGrid/issues) before
opening a report or proposal. For a substantial design change, describe the
problem, constraints and intended evidence in an issue before investing in
implementation so contributors can establish scope together.

Use a descriptive branch and open a focused pull request against `main`.
Explain the observable problem and resulting behavior. Keep unrelated cleanup
and dependency upgrades separate. Check the [roadmap](docs/phase-roadmap.md):
future-phase implementation cannot be bundled into a current-phase fix.
Changing a documented architectural decision requires a new or amended ADR
in the same change; don't silently substitute an architecture.

## Where things live

| Location | Responsibility |
| --- | --- |
| `apps/api`, `apps/worker`, `apps/web` | Control Plane, execution and investigation UI |
| `apps/demo-fintech`, `apps/demo-commerce` | Independent business targets and their HTTP interfaces |
| `packages/control-db`, `packages/demo-db`, `packages/commerce-db` | Separately owned clients and migration histories |
| `packages/engine`, `packages/evidence`, `packages/forensics` | Execution, evidence, invariants and deterministic findings |
| `packages/cli` | Headless commands, scenario documents and JSON reports |
| `tests/integration` | Real infrastructure, process, browser and adversarial regressions |
| `docs`, `docs/decisions`, `docs/reports` | Living contracts, decisions and dated audit evidence |

## Coding and documentation conventions

Follow the existing TypeScript, ESLint and Prettier configuration. Keep
configuration environment-driven, validate inputs server-side, and avoid
machine-specific paths. Financial amounts use integer minor units everywhere,
including fixtures; HTTP money fields use their declared integer-string shape.

Use `INDETERMINATE` for ambiguous side effects and `NOT_EVALUABLE` for
insufficient evidence. Call database records **logically append-only**; don't
promise privileged-write protection. Distinguish intentional `repeat` pressure
from a `retry` after failure. AI interpretation never decides a verdict.

Update living documentation with behavior changes. Preserve dated audit
reports and evidence instead of editing their historical results. Link to
source or rerunnable tests for claims; never invent output, requests or counts.

## Run the relevant checks

| Command | Purpose |
| --- | --- |
| `pnpm test:unit` | Pure logic and unit regressions |
| `pnpm verify` | Format, lint, typecheck, unit tests and build |
| `pnpm test:integration` | Real PostgreSQL, Redis/BullMQ, HTTP, processes and browser suites |
| `pnpm incident-zero:verify` | Both Fintech golden modes |
| `pnpm controlled-faults:verify` | Rejection/response-loss and conservative ambiguity semantics |
| `pnpm release:verify` | Full quality, infrastructure/integration and golden verification |

Before integration tests, run `pnpm infra:up`, `pnpm db:migrate`, and
`pnpm exec playwright install chromium`. On Linux, browser system libraries
may also be needed; see the [setup guide](docs/getting-started.md).

Run integration files serially with the committed configuration. The outage
suite intentionally stops the configured Redis container; don't run competing
suites or use a shared service carrying someone else's work. Disposable
Control fixtures require create/drop-database privileges on the test PostgreSQL
service. Standard local Compose credentials provide these privileges.

Mocks can cover pure logic; they cannot be the sole evidence for PostgreSQL,
queue, HTTP, browser or concurrency semantics. A race test must measure actual
overlap or use a real synchronization barrier—`Promise.all` alone proves none.
Report commands, outcomes and deliberate test filters accurately. If a check
was not run, say so. See the [testing strategy](docs/testing-strategy.md).

### Add scenarios and regressions

Start with the [scenario files](packages/cli/scenarios), [CLI contract](docs/cli.md)
and [target-manifest design](docs/decisions/ADR-0016-external-target-integration-target-manifest.md).
Declare bounded requests, repeat/concurrency, credential references and
versioned invariant bindings. Use the existing closed invariant registry;
new execution surfaces or invariant kinds require the appropriate design scope.

A business-failure regression should demonstrate the vulnerable effect,
independently evaluate its FAIL, and demonstrate the secure behavior with
real target-owned state. Replay tests must preserve the original snapshot
and evidence, create independent runs, and refuse incompatible comparisons.
Detector fixtures must be explicitly identified; never present synthetic
observations as business effects. Add hostile and insufficient-evidence cases
where the guarantee depends on them.

### Database changes

Every schema change includes a reviewable migration in the owning database's
migration directory. Test the committed SQL on real PostgreSQL. Do not edit
an already committed migration, use schema push as history, or write across
target ownership boundaries. RuptureGrid never repairs target business tables
through a database connection. Migration development/shadow-database setup is
covered in [getting started](docs/getting-started.md).

## Formatting and commit hooks

Use `pnpm format:check` and `pnpm lint` to validate. `pnpm format` rewrites
non-ignored files across the repository; review its diff carefully. Markdown
is hand-maintained and excluded by the current [Prettier ignore file](.prettierignore).

Installation enables Husky. The pre-commit hook runs Prettier checks and
ESLint on staged source/configuration files, without `--fix`. It does not
replace full CI, infrastructure tests or a review of the staged diff.
Do not bypass a failed check to claim verification.

## Security and pull-request evidence

Use only registered, authorized non-production targets. Controlled fault
plans remain local-development-only. Keep secrets environment-referenced and
redact logs, reports, screenshots and reproductions before sharing.

A pull request should include:

- The problem, final behavior, scope and any related issue/ADR.
- Tests or other evidence for changed guarantees, including actual outcomes.
- Relevant ownership, destination, credential and uncertainty implications.
- Documentation/migration changes and any meaningful limits or unrun checks.

Report ordinary bugs through the [bug form](https://github.com/Shehroz61/RuptureGrid/issues/new/choose).
Report vulnerabilities through **GitHub Private Vulnerability Reporting** as
specified in [SECURITY.md](SECURITY.md), never a public issue or pull request.
