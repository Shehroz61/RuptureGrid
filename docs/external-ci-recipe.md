# RuptureGrid v1.1 — External CI Recipe (Phase 18)

How another repository invokes RuptureGrid from a **source checkout** and
uses CLI exit codes plus `rupturegrid-report/v1` JSON reports as CI gates.

Related: [cli.md](cli.md), [checkout-zero.md](checkout-zero.md),
[incident-replay.md](incident-replay.md), ADR-0019.

## Distribution honesty (read first)

RuptureGrid v1.1 is **source-only** (ADR-0019 §5). There is no npm
package, no Docker image with the CLI, no prebuilt binary, and no hosted
service. A consumer team runs RuptureGrid from a checkout — typically
pinned to a verified full commit SHA as a git submodule or a CI
`actions/checkout` step — against their own
non-production target. Nothing in this recipe claims third-party
adoption: it is the documented invocation contract, not usage evidence.

## Prerequisites (consumer side)

- A RuptureGrid source checkout (pinned tag/commit), Node ≥ 22.12,
  pnpm ≥ 11.
- Reachable Control PostgreSQL + Redis (the consumer's own
  infrastructure; `pnpm infra:up && pnpm db:migrate` from the checkout
  for the local case).
- The consumer target registered with its target-manifest/v1
  (LOCAL_DEVELOPMENT only for fault execution; production targeting is
  denied in v1 and stays denied).
- The worker process running (`apps/worker`), or an equivalent
  deployment of the checkout's worker entrypoint.
- Server-owned credential grants configured
  (`TARGET_ORIGIN_CREDENTIAL_GRANTS`); secret VALUES live only in the
  worker/executor environment, never in scenario files, reports, or logs.

## Gate 1 — run the scenario

```yaml
- name: Run RuptureGrid scenario
  run: |
    cd rupturegrid
    pnpm build:packages
    node packages/cli/dist/cli.js run \
      ../my-team/scenarios/checkout-regression.scenario.json \
      --wait --timeout 120s \
      --report ../my-team/reports/checkout.json \
      --json > ../my-team/reports/stdout.json
```

`--wait` is mandatory; `--timeout` bounds the wait. The OS exit code IS
the gate signal (ADR-0019 §2):

| Exit | Class              | CI meaning                                              |
| ---- | ------------------ | ------------------------------------------------------- |
| 0    | `PASS`             | terminal `COMPLETED`, evidence verified, all PASS       |
| 1    | `INVARIANT_FAIL`   | ≥ 1 bound invariant FAIL (FAIL dominates NOT_EVALUABLE) |
| 2    | `NOT_EVALUABLE`    | insufficient evidence — **failure, never success**      |
| 3    | `EXECUTION_FAILURE`| infra/execution/integrity failure — **failure**         |
| 4    | `USAGE_ERROR`      | invalid input — nothing executed — **failure**          |

Gate rule: **only exit 0 passes**. Exits 1–4 all fail the gate, with
different triage (business regression vs unevaluable vs infra vs usage).
`NOT_EVALUABLE` must never be treated as success (R-02/R-03).

## Gate 2 — assert the machine-readable report

The `--report` file is `rupturegrid-report/v1` (schema published at
`packages/cli/schemas/rupturegrid-report-v1.schema.json` in the checkout). A gate job
should:

1. Validate the report against the published schema (consumers must
   ignore unknown fields — additive evolution).
2. Assert the exit object agrees with the process exit code.
3. Assert `evidenceIntegrity.verified === true`.
4. Assert per-invariant verdicts equal the committed expectations
   (scenario file `expectations` + expected exit class). Expectations
   never influence RuptureGrid's own classification — they are the
   consumer's assertion input only.
5. Scan the report for secret values (R-13: reports carry reference
   NAMES only; any value leak fails the gate and the secret must be
   rotated).

```bash
node -e "
  const report = require('./reports/checkout.json');
  const assert = require('node:assert');
  assert.equal(report.schemaVersion, 'rupturegrid-report/v1');
  assert.equal(report.exit.code, 0);
  assert.equal(report.evidenceIntegrity.verified, true);
  for (const evaluation of report.invariantEvaluations)
    assert.equal(evaluation.verdict, 'PASS');
  assert.equal(report.findings.length, 0);
"
```

## Gate 3 — replay and compare (regression lifecycle)

After a failure is fixed target-side through the target's own
interfaces, replay the durable reproduction and compare:

```bash
REPRO=$(node -e "console.log(require('./reports/checkout-fail.json').reproductionReference.reproductionDefinitionId)")
node packages/cli/dist/cli.js replay --reproduction "$REPRO" \
  --report ./reports/checkout-replay.json --json
test $? -eq 0 || exit 1   # post-fix replay must exit 0 (PASS)

ORIG_RUN=$(node -e "console.log(require('./reports/checkout-fail.json').run.runId)")
REPLAY_RUN=$(node -e "console.log(require('./reports/checkout-replay.json').run.runId)")
node packages/cli/dist/cli.js compare "$ORIG_RUN" "$REPLAY_RUN" --json
test $? -eq 0 || exit 1   # same intent; cross-intent pairs are refused
```

Caveat: the example requires mode-preserving stimulus, such as the
approved ADR-0027 `checkout-zero-post-fix` companion scenario. Its first
failure and replay must share the exact snapshot row/hash. Configure the
initial vulnerable behavior and apply remediation only through target
administration between executions; replay must not set mode.

For the unchanged golden mode-parameterized scenarios whose
setup step pins the processing mode, a same-hash replay re-establishes
the declared mode — same-hash replay proves determinism (FAIL
reproduces FAIL while the bug is present), and post-fix PASS comes from
the fixed-mode scenario (a different hash, stated in both reports).
Consumers must not claim same-snapshot reproduction when the snapshot
hashes differ; the reports carry both hashes for exactly this check.

Credential-reference/grant revocation is checked; secret-value rotation
behind an unchanged authorized reference is not fingerprint-detected.
Section L.5 remains explicitly deferred, with no new legacy-replay ban.

## Required immutable revision

Before publication, the recipe requires `rupturegrid_revision`: the full
40-character hexadecimal commit SHA of a Phase 18-capable revision whose
CI checks the maintainer has verified. No such finalization commit has
been created as of 17 October 2026. Do not substitute the Phase 17
checkpoint, an unresolved placeholder, a moving branch, or an unpublished
acceptance tag. The job below rejects missing/malformed input before
checkout; checkout fails if the SHA cannot be resolved, and the next step
checks the exact checked-out identity and required Phase 18 source paths.
File presence is a compatibility guard, not a substitute for verified CI.

After controlled finalization, obtain the full SHA from the maintainer's
verified commit/CI record in the
[upstream repository](https://github.com/Shehroz61/RuptureGrid). If a Phase 18
acceptance tag is subsequently authorized and published, resolve that
annotated tag to its commit and verify the same CI record, then store the
full commit SHA as the consumer's input. The checkout contract remains the
SHA; this document does not claim that the commit, tag, or release already
exists. Review a new revision before changing the consumer's pinned input.

## CI workflow with an explicit revision input (illustrative)

The consumer owns the `my-team` checkout and supplies
`ci/configure-rupturegrid.sh` and `ci/run-and-gate.sh`. The first configures
the consumer's non-production environment without printing secrets; the
second performs the gates above and manages the worker/registered target
required by the prerequisites. These consumer-specific scripts are not
included here. The example uses separate checkouts, read-only repository
permissions, and no persisted checkout credentials. It does not execute
untrusted pull-request code with target credentials.

```yaml
name: RuptureGrid regression
on:
  workflow_dispatch:
    inputs:
      rupturegrid_revision:
        description: Verified Phase 18 commit SHA (40 hexadecimal characters)
        required: true
        type: string
permissions:
  contents: read
jobs:
  regression:
    runs-on: ubuntu-latest
    env:
      RUPTUREGRID_REVISION: ${{ inputs.rupturegrid_revision }}
    steps:
      - name: Require an immutable revision
        shell: bash
        run: |
          set -euo pipefail
          if [[ ! "${RUPTUREGRID_REVISION:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
            printf '%s\n' 'A verified full Phase 18 commit SHA is required; placeholders and branches are refused.' >&2
            exit 1
          fi
      - name: Checkout consumer
        uses: actions/checkout@v4
        with:
          path: my-team
          persist-credentials: false
      - name: Checkout pinned RuptureGrid source
        uses: actions/checkout@v4
        with:
          repository: Shehroz61/RuptureGrid
          ref: ${{ inputs.rupturegrid_revision }}
          path: rupturegrid
          persist-credentials: false
      - name: Verify revision and Phase 18 source
        shell: bash
        run: |
          set -euo pipefail
          test "$(git -C rupturegrid rev-parse HEAD)" = "${RUPTUREGRID_REVISION,,}"
          git -C rupturegrid cat-file -e HEAD:packages/engine/src/replay.ts
          git -C rupturegrid cat-file -e HEAD:packages/cli/scenarios/checkout-zero-post-fix.scenario.json
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: rupturegrid/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: rupturegrid/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
        working-directory: rupturegrid
      - run: ../my-team/ci/configure-rupturegrid.sh
        working-directory: rupturegrid
      - run: pnpm infra:up && pnpm db:migrate
        working-directory: rupturegrid
      - run: pnpm build
        working-directory: rupturegrid
      - run: ./my-team/ci/run-and-gate.sh
```

Action input semantics were checked against the official documentation for
[checkout v4](https://github.com/actions/checkout/tree/v4),
[pnpm setup v4](https://github.com/pnpm/action-setup/tree/v4), and
[Node setup v4](https://github.com/actions/setup-node/tree/v4). No runtime
dependency or repository CI workflow is changed by this recipe.

## What CI does NOT prove

A green gate proves: for the declared intent, SKU/scope, and
experiment, the target's authoritative business state did (or did not)
violate the bound invariants, with evidence-backed attribution
(checkout-zero.md §8). It does not prove general idempotency,
correctness under other concurrency patterns, or correctness of other
resources outside the experiment. Findings stay scoped; RuptureGrid
never generalizes beyond evidence.
