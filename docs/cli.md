# rupturegrid CLI (Phases 17–18)

The headless CLI runs a `rupturegrid-scenario/v1` document against the real
stack (Control Plane, queue, worker, target) and exits with one of five
codes. It drives durable run creation, dispatch and analysis, and reports
only outcomes derived from persisted evidence. Expectations never decide
truth (R-02, R-03, R-07).

See [getting started](getting-started.md) for checkout setup and
[project status](project-status.md) for current verification milestones.

## Prerequisites and source entry point

Build from the checkout and invoke the root script:

```bash
pnpm rupturegrid --help
```

Before `run` or `replay`, apply migrations, start Redis and the worker, and
make the registered target reachable. The scenario selector must match the
registration's display name. Commerce registration uses its
[data-only manifest](../apps/demo-commerce/target-manifest.json), adapted
to that registration's name/origin, with current server-owned credential
grants for every declared reference. The bundled manifest's `Demo Commerce`
name differs from the golden CLI selector `checkout-zero-commerce`; do not
assume starting the application automatically registers it. Use the Control
Plane target-registration API/UI and its existing validation.

The command shapes below use `rupturegrid` as shorthand for
`pnpm rupturegrid` from the source checkout; there is no published global CLI.

- **Distribution:** source-only. The CLI runs from a RuptureGrid source
  checkout via `pnpm build:packages && node packages/cli/dist/cli.js`.
  There is no npm package, Docker image, or binary in v1.1 (ADR-0019 §5).
- **Entry:** [packages/cli](../packages/cli) (`src/cli.ts` parse +
  dispatch, `src/orchestrator.ts` orchestration, `src/exit-code.ts`
  classification, `src/report.ts` emitter).

## Commands

```
rupturegrid scenarios validate <scenario.json>
rupturegrid run <scenario.json> --wait --timeout <duration> [--report <file>] [--json]
rupturegrid replay --reproduction <id> --report <file> [--json] [--timeout <duration>]
rupturegrid compare <runId> <otherRunId> [--json] [--report <file>]
rupturegrid schemas emit
```

### `scenarios validate`

Validates a scenario document (closed schema: allowed keys, HTTP methods,
retryPolicy `NONE`, timeout ceilings) **without any durable side effect** —
no revision, no run, no target request. Exit 4 on any invalid input.

### `run`

Full flow: revision → frozen snapshot → dispatch (queue) → bounded-poll
wait → idempotent analysis + forensics → evidence-integrity verification →
report → exit.

- `--wait` is **mandatory** in v1: the CLI never returns while the run is
  still in flight.
- `--timeout` bounds the wait (`ms` / `s` / `m`); a non-terminal run at
  the ceiling is honestly `EXECUTION_FAILURE` (exit 3), never a success.
- `--report <file>` writes the `rupturegrid-report/v1` JSON artifact.
- `--json` makes stdout machine-parseable JSON (the report only); human
  diagnostics go to stderr.
- Usage errors (bad file, unknown target selector, unknown flags,
  malformed scenario) exit **4 before anything durable happens** — no
  revision, no run row, no target request.

### `schemas emit`

Rewrites the published JSON Schemas under `packages/cli/schemas/`
(`rupturegrid-scenario-v1.schema.json`, `rupturegrid-report-v1.schema.json`). Emitted documents are unit-tested
to agree with the compiled validators.

### `replay` (Phase 18)

A NEW run from the SAME hash-pinned snapshot bound by a durable
reproduction definition (ADR-0019 Decision 4; incident-replay §3):

```
rupturegrid replay --reproduction <id> --report <file> [--json] [--timeout <duration>]
```

- `--reproduction <id>` selects the durable reproduction definition;
  `--timeout` bounds the wait (default 120s, same 1ms..1h bounds as
  `run`); `--report`/`--json` behave exactly like `run`.
- Flow: validate binding (snapshot, target binding, invariant
  versions, credential REFERENCE authorization under the CURRENT
  server-owned policy, execution authorization) → create a new run on
  the STORED snapshot (no new snapshot row — the same
  `snapshotContentHash`) → dispatch → bounded poll → idempotent
  analysis + forensics → integrity → report → exit.
- Binding failures (missing reproduction, missing/rotated credential
  authorization, mismatched bindings, unavailable versions,
  unauthorized destinations) fail closed with exit 4 BEFORE anything
  durable happens. Never automatically retries ambiguous mutations.
- The original run's observations, evaluations, and findings are never
  modified: every replay write is keyed by the new run id.
- Golden-scenario limit: for mode-parameterized scenarios
  whose setup step pins the processing mode, same-hash replay
  re-establishes the declared mode — it proves determinism, not a fix.
  Post-fix PASS comes from the fixed-mode scenario (different hash,
  stated in both reports).
- Approved ADR-0027 companion lifecycle: `checkout-zero-post-fix` uses
  mode-preserving setup, so its own original failure and post-fix replay
  share one stored snapshot row/hash. It never overrides a historical
  golden scenario's required mode. Target processing facts are observed;
  independent business effects establish the verdict.
- Credential checks cover registered references/current grants, not
  secret-value rotation behind an unchanged authorized reference. Missing
  runtime values fail pre-send. Section L.5 fingerprint architecture is
  explicitly deferred; legacy reproductions remain replayable under the
  existing checks. Malformed reproduction/run UUIDs are usage errors (4).

### `compare` (Phase 18)

Computed-on-read comparison of two runs of the SAME frozen intent
(incident-replay §6), from durable truth: snapshot hash,
target/experiment identity, invariant keys + versions, per-subject
verdicts, effect counts, findings, evidence references, execution
uncertainty, and provenance. Cross-intent pairs (different snapshot
hashes) are refused with exit 4. Read-only: nothing executes, nothing
durable is written. Scheduling variance is expected and asserted no
causal link (incident-replay §4–§5).

## Five-way exit contract

| Exit | Class              | Meaning                                                                 |
| ---- | ------------------ | ----------------------------------------------------------------------- |
| 0    | `PASS`             | Run terminal `COMPLETED`, evidence chain verified, all bound invariants evaluated `PASS`. |
| 1    | `INVARIANT_FAIL`   | Evidence-backed, evaluated-invariant verdict(s) `FAIL`.                 |
| 2    | `NOT_EVALUABLE`    | Insufficient evidence for a bound invariant — never a guess.            |
| 3    | `EXECUTION_FAILURE`| Run failed/cancelled/timed out, or evidence integrity did not verify, or a bounded wait timeout was reached. Note: an ambiguous side effect (`INDETERMINATE`) on record does **not** by itself force exit 3 — see below. |
| 4    | `USAGE_ERROR`      | Invalid input, rejected before any durable write.                       |

Precedence (frozen): integrity failure (1) → terminal failure (2) →
invariant `FAIL` (3) → missing evaluation (4) → `PASS`.
Expectations in the scenario document are **never truth**; the
classifier reads durable Control-Plane state and evaluated verdicts only
(ADR-0020 §4).

### INDETERMINATE and the exit code (ADR-0019 §2, ADR-0008)

`INDETERMINATE` is always reported honestly — in the run's
`sideEffectSummary` and in every per-step fact the report carries. It
does **not** by itself imply exit 3. A run with `INDETERMINATE` steps
can still exit **0** when: execution reaches the required terminal
state (`COMPLETED`), evidence integrity verifies, and every bound
invariant is independently evaluated `PASS`. A PASS verdict on the
bound invariants never launders execution-time ambiguity into business
truth; the report still exposes the INDETERMINATE counts. The
response-loss golden scenario happens to exit 3 for a different,
explicit reason: its run's terminal state is `FAILED` (the truncated
invocation failed that step), which is precedence rule 2 — not merely
because an invocation is `INDETERMINATE`.

## Report: `rupturegrid-report/v1`

The report (schema published at `packages/cli/schemas/rupturegrid-report-v1.schema.json`)
carries, among others: the exit class + precedence rule; run/snapshot
identities; durable verdicts per bound invariant with their
completeness proofs; evidence-integrity verification results; normalizer
versions read from durable `normalized_event` rows; per-step execution
facts (state, attempt counts, `INDETERMINATE` knowledge); forensic
findings; and the scenario document content hash. When a completed run
cannot honestly name a reproduction, the emitter records
`reproductionReference: { absent, reason }` instead of inventing a
reference (R-02).

## Configuration

Environment-driven and validated by `cliConfigSchema`
([packages/config](../packages/config)): `CONTROL_DATABASE_URL`,
`REDIS_URL`, `QUEUE_PREFIX`, `NODE_ENV`, `LOG_LEVEL`, and
`TARGET_ORIGIN_CREDENTIAL_GRANTS` — a JSON map of target origin → list of
authorized credential references. Only declared, platform-granted
credential references resolve at execution time (ADR-0012, ADR-0025);
secrets never persist in reports, logs, or evidence (R-13).

## Testing

- Unit: scenario loader/validator, exit classifier decision table,
  report emitter, schema round-trips (`packages/cli/src/cli.test.ts`);
  replay/compare parsing plus expectation assertions
  (`packages/cli/src/replay-command.test.ts`).
- E2E over the real stack: `tests/integration/phase17-cli.test.ts`
  exercises all five exits as child processes, expectations-vs-truth,
  evidence-tamper precedence, response-loss `INDETERMINATE`, and
  pipeline idempotence; `tests/integration/phase18-replay-commerce.test.ts`
  and `tests/integration/phase18-replay-fintech.test.ts` exercise the
  replay/regression lifecycle on both domains (same-hash determinism,
  history preservation, comparison, cross-intent refusal, credential
  fail-fast, fix verification, unsafe-retry prevention).

## External CI

See [external-ci-recipe.md](external-ci-recipe.md): how another
repository invokes RuptureGrid from a source checkout and uses exit
codes plus `rupturegrid-report/v1` as CI gates (source-only policy).
