# rupturegrid CLI (Phase 17)

The headless CLI runs a `rupturegrid-scenario/v1` document against the real
stack (Control Plane, queue, worker, target) and exits with one of five
codes. It is a thin, honest driver over the durable Control-Plane truth:
it creates nothing, guesses nothing, and never reports a verdict it did
not derive from evidence (R-02, R-03, R-07).

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
rupturegrid schemas emit
rupturegrid replay            # NOT implemented in Phase 17 (Phase 18)
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
(`scenario-v1.json`, `report-v1.json`). Emitted documents are unit-tested
to agree with the compiled validators.

### `replay`

Prints a usage error naming Phase 18. The CLI never pretends replay
exists (R-02).

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

The report (schema published at `packages/cli/schemas/report-v1.json`)
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
  report emitter, schema round-trips (`packages/cli/src/cli.test.ts`).
- E2E over the real stack: `tests/integration/phase17-cli.test.ts`
  exercises all five exits as child processes, expectations-vs-truth,
  evidence-tamper precedence, response-loss `INDETERMINATE`, and
  pipeline idempotence.
