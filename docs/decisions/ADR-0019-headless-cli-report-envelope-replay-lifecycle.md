# ADR-0019: Headless CLI, rupturegrid-report/v1, and the Replay/Regression Lifecycle

## Status

Accepted (Phase 12 — design freeze; implementation in Phases 17–18).

## Context

v1.0's verification surface is two scenario-specific verifier packages (`incident-zero`,
`controlled-faults`) with human+JSON output and classified exit codes. External adoption needs a
first-class headless workflow — create, execute, wait, analyze, report, exit — that another
team's CI can consume, with honest exit semantics: infrastructure failure must be
distinguishable from business-invariant failure, and "cannot evaluate" must never look like
success (R-02/R-03; ADR-0007; evidence-model §7).

One earlier roadmap error is corrected here by mandate: the draft implied an externally
distributable `rupturegrid` executable. v1.1 remains **source-only** (no npm publication, no
Docker images, no prebuilt binaries — the v1.0 release policy stands). The honest framing is:

- **Headless/CI-capable CLI semantics** — a command surface with deterministic, script-consumable
  output and exit codes. This is a *capability*.
- **Public CLI distribution** — publishing an installable artifact. This is a *release policy
  decision* that v1.1 does not make.

For v1.1, the CLI is invoked **from a RuptureGrid checkout** (root pnpm scripts over
`packages/cli`), by teams who run RuptureGrid themselves — consistent with the platform's
local-development/staging boundary and source-only distribution.

## Decision

1. **`packages/cli` provides the headless command surface** (implemented Phase 17), invoked from
   the checkout, e.g.:
   - `pnpm rupturegrid scenarios validate <scenario.json>`
   - `pnpm rupturegrid run <scenario.json> --wait --timeout <duration> --report <file> [--json]`
   - `pnpm rupturegrid replay --reproduction <id> --report <file> [--json]` (Phase 18)
   The `run` flow: validate scenario → create experiment revision → pin snapshot (ADR-0010) →
   dispatch → **wait by bounded polling of durable run state** (never fixed sleeps;
   testing-strategy §6) → trigger idempotent analysis (derivation + evaluation) → verify the
   evidence chain → emit the report → exit.
2. **Exit codes are a documented, honest, five-way contract:**
   | Code | Class | Rule |
   |---|---|---|
   | `0` | `PASS` | Run terminal `COMPLETED`; evidence chain verified; **every** bound invariant verdict `PASS` |
   | `1` | `INVARIANT_FAIL` | ≥ 1 bound invariant verdict `FAIL` (FAIL dominates NOT_EVALUABLE in the exit decision; the report lists both) |
   | `2` | `NOT_EVALUABLE` | No FAIL, but ≥ 1 bound invariant is `NOT_EVALUABLE` (or a bound invariant received no verdict) — **never a success for CI purposes** |
   | `3` | `EXECUTION_FAILURE` | Prerequisite/infrastructure/execution reality: target unreachable, run terminal `FAILED`/`CANCELLED`, wait timeout, or evidence-integrity verification failed |
   | `4` | `USAGE_ERROR` | Invalid scenario/manifest/flags — nothing executed |
   No path produces a fake success: exit 0 requires verified evidence and all-PASS verdicts; a
   run that never executed cannot exit 0 or 1.
   **Exit-code precedence is fixed** (evaluated top-down; the first matching rule wins):
   1. evidence-integrity / execution-truth failure (`EXECUTION_FAILURE`) ⇒ exit 3 —
      **integrity failure dominates business verdicts**: if the evidence chain fails to verify,
      the CLI must NOT emit exit 1 merely because an invariant evaluation also contains FAIL
      (a FAIL resting on an unverifiable evidence chain cannot be trusted); the business
      verdict is untrusted and the report must say so;
   2. otherwise, any bound invariant verdict `FAIL` ⇒ exit 1 (FAIL dominates NOT_EVALUABLE; the
      report lists both);
   3. otherwise, any bound invariant `NOT_EVALUABLE` or missing required verdict ⇒ exit 2;
   4. otherwise, every bound invariant `PASS` ⇒ exit 0;
   5. invalid scenario/manifest/flags rejected before execution ⇒ exit 4 (nothing executed).
   **INDETERMINATE and exit 0:** a run may contain execution-time `INDETERMINATE` steps and
   still exit 0 ONLY if execution reaches the required terminal state, evidence integrity
   verifies, and every bound invariant is independently evaluable and `PASS`. The report still
   exposes INDETERMINATE counts honestly — a PASS verdict on the bound invariants never
   launders execution-time ambiguity into business truth.
3. **`rupturegrid-report/v1` is a versioned, additive-only JSON envelope** whose fields are a
   serialization of durable Control-Plane truth — never a new truth engine:
   - `schemaVersion` (exactly `rupturegrid-report/v1`), `reportId`, `generatedAt`, tool identity;
   - target identity (registration, display name, origin, environment class);
   - run identity: `runId`, experiment name/revision, **snapshot id + `snapshotContentHash`**
     (frozen intent identity), terminal execution state, engine/normalizer versions;
   - side-effect-knowledge summary counts (including honest `INDETERMINATE` counts);
   - `evidenceIntegrity`: verified flag, chain head hash, observation count (from the integrity
     verifier — a failed verification forces exit class 3, never a quiet report);
   - invariant evaluations: key, evaluator version, subject, verdict, reason, evidence-set hash,
     bounded details;
   - findings: reason code, subject, title/summary (fixed templates), minimal proof references,
     `provenScope`/`uncertainScope`;
   - reproduction reference: reproduction-definition id + snapshot hash + acceptance
     expectations;
   - the resulting exit code.
   JSON only. Consumers must ignore unknown fields (additive evolution); verdict and exit enums
   are closed; a breaking change mints `rupturegrid-report/v2` with a dual-emission window. The
   report joins the canary leak-scan surfaces (R-13: no secrets anywhere in a report). No
   PDF/human-format export is designed in v1.1.
4. **Replay/regression lifecycle (Phase 18).** Discovery → the run's `ReproductionDefinition`
   (already durable: run → snapshot → target binding → credential *references* → invariant
   bindings → acceptance expectations) → `replay` creates a **new run from the same
   hash-pinned snapshot** (never merged into the original's history; ADR-0010; incident-replay §3)
   → comparison is the explicit computed-on-read view (refuses cross-intent) → the consumer's
   regression test is the **committed scenario file + expected verdicts + exit-code assertion**
   in their own CI. "Exact or semantically pinned" means the same `snapshotContentHash`;
   credential rotation fails fast with an explicit mismatch; scheduling variance is expected and
   findings never depend on it (incident-replay §4–§5). A one-time demonstration is never
   acceptance evidence (R-07; testing-strategy §8).
5. **Distribution honesty is part of the contract.** v1.1 documentation and the CLI's own help
   state that the CLI runs from a RuptureGrid checkout and is not a distributed executable.
   Public distribution (npm/Docker/binary) is deferred and requires its own release-policy ADR.

## Consequences

- CI integration becomes real but self-hosted: a consumer runs RuptureGrid from a checkout
  against their non-production target. This is the correct v1.1 scope and keeps the release
  policy honest (Correction 5).
- The five-way exit table makes `NOT_EVALUABLE` structurally un-launderable: CI treats exit 2 as
  failure, matching the platform's uncertainty-is-first-class philosophy.
- The report gives machine consumers everything needed to audit a verdict from durable truth
  (snapshot hash, evaluation details, evidence-set hash, integrity status) without trusting the
  CLI's own summary.
- The scenario-document format (scenario JSON binding experiment steps + invariant instances +
  acceptance expectations) is specified in Phase 17 with the same closed-schema discipline as the
  manifest.
