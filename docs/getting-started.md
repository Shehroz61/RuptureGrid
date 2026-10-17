# Getting started

Run RuptureGrid from a source checkout against its local demonstration stack:
three independent databases, Redis, five applications and real verification suites.

## Prerequisites

- Git and Node.js **22, at least 22.12**. The verified Phase 18 audit used
  Node 22.23.1; the root `engines` field defines the minimum.
- Corepack and the repository-pinned **pnpm 11.9.0**.
- Docker with Compose v2, running and accessible to your account.
- Network access for dependency, container-image and browser downloads.

Corepack's `install` selects the local `packageManager` pin; avoid commands
that update that field. If Corepack is absent or has outdated signing keys,
follow its [official installation instructions](https://github.com/nodejs/corepack#installation).
`corepack enable` creates shims beside the installation and may need write
permission. Where that directory is read-only, use `corepack pnpm` in place
of `pnpm` rather than changing the repository's package-manager version.

## Prepare the checkout

```bash
git clone https://github.com/Shehroz61/RuptureGrid.git
cd RuptureGrid
corepack enable
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
```

PowerShell's explicit file-copy command is:

```powershell
Copy-Item .env.example .env
```

Copy only when creating your local configuration; retain intentional settings
in an existing `.env`. The template's credentials are non-production examples.
Keep `.env` out of Git and logs.

## Start infrastructure and apply migrations

```bash
pnpm infra:up
pnpm infra:status
pnpm db:migrate
```

| Compose service | Owner | Default host port |
| --- | --- | ---: |
| `control-postgres` | RuptureGrid execution, evidence and analysis state | 5443 |
| `demo-postgres` | Demo Fintech business state | 5444 |
| `commerce-postgres` | Demo Commerce business state | 5445 |
| `redis` | Queue coordination | 6380 |

These are four services, with three physically separate PostgreSQL instances.
`pnpm db:migrate` generates clients and deploys all three committed migration
histories. It does not require shadow databases. For migration development or
schema-diff verification, create the additional databases named in the
`*_SHADOW_DATABASE_URL` comments in [`.env.example`](../.env.example).

If a host port is occupied, update its Compose port variable and corresponding
application URL together. Target-origin changes also require matching
`TARGET_ORIGIN_CREDENTIAL_GRANTS` entries and target registrations. Changing
only a port or widening a grant is not a safe substitute for correct setup.

## Start the applications

```bash
pnpm dev
```

The command builds first, then starts API, worker, web, Fintech and Commerce.
The web UI defaults to [localhost:3000](http://localhost:3000), the API to
`127.0.0.1:3001`, Fintech to `127.0.0.1:3002` and Commerce to `127.0.0.1:3003`.
Use a second terminal for checks and stop foreground applications with Ctrl+C.

RuptureGrid application configuration does not grant it target-database write
access. The shared local template supports separate application processes;
each target owns its own database client and business transactions.

## Verify the demo

```bash
pnpm test:unit
pnpm incident-zero:verify
pnpm controlled-faults:verify
```

Golden verifiers build and manage their own target/worker processes. Run them
serially against disposable local demo state. An exit-zero golden verifier
means its asserted vulnerable and secure outcomes matched real evidence; it
does not mean the vulnerable target passed its business invariant.

For complete integration coverage, install the real test browser first:

```bash
pnpm exec playwright install chromium
pnpm test:integration
```

On a Linux host needing browser libraries, use Playwright's documented
`pnpm exec playwright install --with-deps chromium` variant. Integration
fixtures create/drop owned test databases and intentionally interrupt Redis;
use the dedicated Compose stack and its development database privileges.

`pnpm verify` runs the non-infrastructure quality gates. `pnpm release:verify`
adds infrastructure setup, migrations, integration and golden verifiers; it
does not publish a release.

## Headless Commerce and replay

```bash
pnpm rupturegrid --help
```

Commerce [scenario documents](../packages/cli/scenarios) require a registered
target whose display name matches the scenario selector, the target's
[data-only manifest](../apps/demo-commerce/target-manifest.json), matching
server-owned origin credential grants, a reachable target and a running worker.
The sample manifest name and CLI scenario selector are not interchangeable;
registration must deliberately align them. See [CLI prerequisites and commands](cli.md).

The secure/vulnerable golden documents pin their modes. The separate
`checkout-zero-post-fix` document preserves processing mode so a genuine
failure can be fixed target-side and replayed using its original snapshot.
Reports and reproduction IDs come from actual runs; no sample UUID is needed.

## Troubleshooting

- **Docker access or readiness:** check `pnpm infra:status` and Docker access
  for your account; do not reset volumes to hide a failed test.
- **Missing generated clients:** run `pnpm db:migrate` after dependency installation.
- **Browser unavailable:** install Chromium and any required OS libraries.
- **Origin/credential refusal:** check normalized origins, target registration,
  declared reference names and platform grants. Never bypass validation.
- **Unknown CLI command:** use the source entry point above from a verified
  revision with replay support, not an old release or a presumed global binary.

Further reading: [contributing](../CONTRIBUTING.md), [CLI](cli.md),
[external CI](external-ci-recipe.md), [security policy](../SECURITY.md).
