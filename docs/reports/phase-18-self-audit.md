# RuptureGrid v1.1 — Phase 18 Self-Audit (Builder)

Status: **Builder self-audit. NOT acceptance.** Phase 17 is independently
audited, CI-green, tagged (`phase-17-accepted`), and CLOSED; no Phase 17
file was modified in this change (one stale Phase 17 test *name* is
disclosed in §9 — its assertions still pass byte-untouched). No commit,
tag, or push was performed (R-16; mandate hard boundary).

Baseline at start: commit `eb95c15` (`eb95c157824f8990be609311a18c668e52ec2b76`),
branch `main`, working tree clean, tag `phase-17-accepted` present.
Infra: local Docker PostgreSQL ×3 + Redis (all healthy), Node v22.23.1,
pnpm 11.9.0.

## 1. Implemented functionality

- **`packages/engine/src/replay.ts` (new): `validateReplayBinding` +
  `createRunFromSnapshot`.** Fail-closed pre-execution validation
  (snapshot exists and is well-formed; revision still binds the same
  target; environment not production; frozen origin still registered;
  frozen credential refs ⊆ registration refs ∩ CURRENT platform
  grants; frozen invariant kinds/registry versions still accepted —
  never silently substituted) and new-run creation on the EXISTING
  snapshot row (same `snapshotContentHash`; per-run advisory lock +
  provenance-revision protocol identical to `createRun`). No migration
  (existing tables only).
- **`packages/cli` replay command.** `rupturegrid replay --reproduction
  <id> --report <file> [--json] [--timeout <duration>]` (default 120s).
  `orchestrator.ts` was refactored so `run` and `replay` share
  `dispatchRun` + `driveRunToReport` VERBATIM (bounded poll →
  capture → analysis → forensics → integrity → Boundary B
  authorization → classification → report). Phase 17's
  `phase17-cli.test.ts` (23 tests) passes unchanged against the
  refactor. Binding failures map to exit 4 with nothing durable;
  post-dispatch outcomes use the identical five-way contract.
- **`packages/cli` compare command.** `rupturegrid compare <runA>
  <runB> [--json] [--report <file>]`: read-only computed-on-read
  comparison; cross-intent pairs refused (exit 4).
- **`packages/forensics/src/replay-comparison.ts` (new):
  `compareReplayRuns`.** Compares snapshot hash, frozen
  target/experiment identity, bound invariant keys + versions,
  per-(key,subject) verdicts from persisted current-evaluation
  pointers (never timestamp ordering), effect counts from persisted
  evaluation details (`attributableEffectCount` /
  `acceptedReservedUnits`, null when absent — never guessed),
  findings, evidence references (head hash + observation count),
  side-effect summaries, NOT_EVALUABLE reasons, analysis
  generations/eligibility versions, reproduction references, and a
  fixed scheduling-honesty note. Refuses self-comparison, missing
  runs, and hash-mismatched (cross-intent) pairs. Adds a per-KEY
  verdict-domain agreement layer (`keys` + `unboundKeys`) because
  per-run generated identities (fintech payment ids) never match
  across runs — agreement is about verdict sets per key. Legacy
  `compareRuns` untouched.
- **`packages/cli/src/expectations.ts` (new):
  `assertAcceptanceExpectations` + normalizers** for scenario and
  reproduction expectation shapes. Pure; takes the FINISHED report —
  expectations can never influence classification (the classifier never
  sees them). Requires every reported subject of a key to match (no
  collapse); missing/unbound keys mismatch honestly (never vacuous).
- **Regression suites (real infrastructure):**
  `tests/integration/phase18-replay-commerce.test.ts` (8 tests),
  `tests/integration/phase18-replay-fintech.test.ts` (5 tests).
- **Docs:** `docs/external-ci-recipe.md` (new; source-checkout
  invocation, exit-code/JSON gates, distribution honesty),
  `docs/cli.md` (replay/compare sections), and PROPOSED
  **ADR-0027** (the §2 contradiction + smallest resolution; no
  accepted contract altered).

## 2. Snapshot/reproduction correctness

- Replay creates NO new snapshot row: original and replay runs share
  one `snapshotContentHash` (proven 3× on commerce, e.g.
  `60e2d646c725…`, `add379c0a838…`, `2650ed336737…`; fintech pairs
  share per-mode hashes by construction).
- Reproduction definitions are read from durable rows (id, hash match
  against the stored snapshot, `targetModeRequirement`,
  reference-NAMES-only credential refs). History-tamper check
  (row hash vs stored hash) enforced before creation.
- Vulnerable vs secure scenarios hash differently (setup bodies pin
  opposite modes) — asserted in-suite.

## 3. Demonstrated failure → fix → replay → PASS evidence

Commerce (3 full lifecycle executions on the loaded dev DB, latest
shown; each execution = vulnerable run + same-hash replay + secure run
+ response-loss run):

| Run | State | Hash (12) | Obs | Evals | Findings | Verdicts | Mode req |
|---|---|---|---|---|---|---|---|
| vulnerable | COMPLETED | `60e2d646c725` | 14 | 4 | 2 | CHK FAIL, INV FAIL | VULNERABLE |
| replay (same hash) | COMPLETED | `60e2d646c725` | 14 | 4 | 2 | CHK FAIL, INV FAIL | VULNERABLE |
| secure (post-fix) | COMPLETED | `6fb036899f12` | 14 | 4 | 0 | CHK PASS, INV PASS | SECURE |
| response-loss | FAILED | `0ccb59cc63ca` | 3 | 1 | 0 | — (exit 3) | none |

(The two earlier executions show the identical pattern with different
hashes — determinism across suite runs, not hash reuse.)

- Vulnerable FAIL backed by target-persisted proof each time: 2
  accepted orders + 2 accepted reservations for the run's own intent,
  `remainingAvailableUnits = −1`, 2 distinct `requestAttemptId`s, 2
  processing attempts with measured overlap from target-persisted
  timestamps (deterministic-oversell barrier: test-owned scheduling
  only).
- Genuine fix: target mode switched VULNERABLE → SECURE through the
  target's OWN admin API (`PUT /demo/admin/mode`, verified via status
  read); no backdoor state edits (R-05).
- Original FAIL preserved: original run's observations/evaluations/
  findings asserted byte-equal before/after replay (ids, content
  hashes, verdicts, reasons).
- Fintech: vulnerable FAIL + Finding twice (same hash, distinct
  evaluation ids, first run's rows unchanged), secure PASS + 0
  findings, cross-mode comparison refused.
- **Blocked as written (ADR-0027): same-hash FAIL → PASS was NOT
  demonstrated because the frozen contracts make it unreachable**
  (setup pins VULNERABLE; the target's own reset re-arms it; the mode
  switch IS the fix interface). Post-fix PASS comes from the SECURE
  scenario (different hash — stated in both reports, never hidden).
  No workaround was taken (mid-run switch, label-preserving code fix,
  scenario substitution, and snapshot alteration were each rejected on
  constitutional grounds — see ADR-0027).

## 4. Comparison and regression results

- Same-hash commerce pairs: `compare` exit 0; per-key agree
  (CHK FAIL/FAIL, INV FAIL/FAIL); per-subject rows agree with effect
  counts 2/2; new evidence head, equal finding counts, scheduling note
  present. In-process `compareReplayRuns` agrees with the CLI surface.
- Same-hash fintech pairs: per-key agree (INV-IZ-1 FAIL/FAIL, same
  evaluator version); subjects honestly show presence/absence (rotated
  payment identities).
- Cross-intent pairs (vuln vs secure, both domains): refused —
  CLI exit 4 (`SNAPSHOT_MISMATCH`), `RunComparisonError` in-process.
- Credential mismatch (admin grant revoked): replay exit 4, run count
  unchanged. Unknown reproduction id: exit 4, nothing created.
- Unsafe-retry prevention: submit steps show exactly the declared
  repeats (attemptCount 2, 2 invocations, retryPolicy NONE);
  response-loss shows exactly 1 INDETERMINATE invocation, exit 3, no
  report file, and the committed mutation verified out-of-band.
- Expectation assertions: vulnerable scenario expectations matched on
  FAIL reports; secure expectations matched on PASS; reproduction
  expectations (bound-scoped) matched on replays; unit suite proves
  NOT_EVALUABLE never masquerades as PASS and missing/unbound keys
  never pass silently.

## 5. Gate results (actual, this session)

| Gate | Result |
|---|---|
| `pnpm format:check` | PASS (all files) |
| `pnpm lint` | PASS (exit 0, all workspaces + tests) |
| `pnpm typecheck` | PASS (exit 0, all workspaces) |
| `pnpm test:unit` | 741/742 ordered (1 timeout, see §6) → **742/742 shuffled rerun** (59 files) |
| `pnpm build` | PASS (exit 0, final tree incl. apps) |
| `pnpm db:migrate` | no-op, exit 0 (no schema change; no migration in this change) |
| `git diff --check` | clean |
| `pnpm test:integration` | **414/414 across all 40 files** (run in chunks; every file exit 0) |
| `pnpm incident-zero:verify` | PASS (frozen intent 5/5; VULN 25/25; SECURE 21/21) |
| `pnpm controlled-faults:verify` | PASS (18/18 ×2, 22/22 ×2, no leakage) |
| Phase 18 commerce E2E | 8/8, plus 8/8 loaded-DB rerun |
| Phase 18 fintech E2E | 5/5 |
| Phase 17 CLI E2E (regression) | 23/23 (refactor-safe) |

Integration chunk counts: phase17-cli 23; c+d 26; aggregation/b1/b2/b3
86; e1/e2/e3 32; forensics/snapshot/manifest/phase14 41; phase15/16/
evidence×2 62; execution/multi-worker/ownership/queue/observation 25;
demo×2/golden 58; controlled-faults×2/demo-db/api-health/databases/
demo-health/logger 39; redis-outage/worker-startup 3; web 3; browsers 3.

## 6. Failures met during the work (all repaired, none hidden)

1. `chainHash` is not a `RawObservation` field (`contentHash` is) —
   broke both Phase 18 suites' preservation snapshots. Fixed (3
   spots); preservation assertions now compare durable row sets.
2. Fintech golden definition names are global and bound to one target:
   fresh ports collided with existing definitions. Fixed by reusing
   the canonical origins (the golden suite's own idempotent-by-origin
   pattern).
3. Reproduction expectations span the FULL evaluation domain
   (including unbound legacy INV-DF-2 rows) while reports serialize
   the bound domain: scoped the test assertion to bound keys (mirrors
   the classifier); disclosed, not papered over.
4. Fintech per-subject pairing is meaningless across runs (rotated
   payment identities): added the per-key agreement layer
   (`keys`/`unboundKeys`) to the comparison contract; both suites
   assert it.
5. `pnpm test:unit` ordered run: 1 timeout in
   `tests/unit/pre-commit-hook.test.ts` (a git-hook test needing ~93s
   standalone under no load vs its 60s budget under full-suite
   parallel load). Untouched by this change (not in the file list);
   passes standalone (6/6) and in the shuffled full rerun (742/742).
   No retries-until-green: the failure is recorded here with its
   isolation evidence.
6. Two NUL bytes were accidentally embedded in a new source file's
   string separators during writing; detected by byte scan, replaced
   with `::`, re-verified zero NUL bytes.

## 7. Files changed (14; no stage/commit/tag/push)

Modified (6): `docs/cli.md`, `packages/cli/src/cli.ts`,
`packages/cli/src/index.ts`, `packages/cli/src/orchestrator.ts`,
`packages/engine/src/index.ts`, `packages/forensics/src/index.ts`.
Added (8): `docs/decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md`
(PROPOSED), `docs/external-ci-recipe.md`,
`docs/reports/phase-18-self-audit.md` (this file),
`packages/cli/src/expectations.ts`,
`packages/cli/src/replay-command.test.ts`,
`packages/engine/src/replay.ts`,
`packages/forensics/src/replay-comparison.ts`,
`tests/integration/phase18-replay-commerce.test.ts`,
`tests/integration/phase18-replay-fintech.test.ts`.
No migration, no historical-report edit, no Phase 17 file edit, no
secret committed (canary assertions in-suite; reports scanned).

## 8. Security and backward-compatibility findings

- Secrets: credential VALUES never enter snapshots, reproductions,
  reports, logs, or comparisons (refs only). CLI canary assertions +
  Phase 17's credential-VALUES suite (still green) cover this. No new
  leak surface (comparison carries hashes/counts/reasons, never
  headers/bodies).
- Authorization: replay reuses the server-owned grant policy object;
  revoked grants fail closed pre-durable (proven E2E). Production
  denial re-enforced at replay validation; `--force-production`-style
  flags remain rejected; destinations re-validated against live
  registration.
- No unsafe retry introduced: frozen `retryPolicy: NONE` executes
  unchanged; `decideRetry` untouched; INDETERMINATE handling untouched
  (response-loss E2E re-proven).
- Backward compat: `executeScenario`'s observable behavior unchanged
  (23/23 Phase 17 CLI green); `compareRuns`, the report schema, and
  snapshot canonicalization untouched; engine/forensics/CLI index
  changes are additive exports; `driveRunToReport` is the moved
  verbatim pipeline.

## 9. Remaining blockers and risks

1. **[BLOCKER, referred to audit] Roadmap Phase 18 acceptance item
   "same-snapshot replay → PASS" is unsatisfiable as written**
   (ADR-0027 PROPOSED): setup-pinned mode + atomic target reset +
   mode-switch-as-fix. Delivered instead: same-hash determinism proof
   + different-hash fix verification + refusal discipline + proposed
   resolution (honest doctrine now; structural split as a future ADR).
2. Phase 17 test name `'replay honestly does not exist yet (Phase 18)'`
   is stale-by-supersession: file byte-untouched per R-01; its
   assertions (exit 4, `Phase 18` in stderr) still pass via the replay
   usage error. Auditor to decide whether to rename it as a Phase 18
   acceptance edit.
3. Credential value-rotation detection is grant-level + pre-send, not
   fingerprint comparison: no value fingerprint is persisted in v1
   (docs say "may"; implementation stores names only) — recorded in
   ADR-0027 §"honesty note", not invented.
4. Full `pnpm test:integration` was executed in sequential chunks (all
   40 files, all exit 0), not one process invocation, because the
   single-invocation run exceeds the execution timeout of this
   environment. Same tests, same config, same infrastructure.
5. Comparison `subjects` pairing across runs with rotated identities
   yields ABSENT markers by design; consumers must read `keys`
   agreement for verdict comparison (documented + tested).

## 10. Repository integrity

`git status` shows only the 14 Phase 18 files above. `git diff
--cached` was never populated; no commit/tag/push performed. No
force-push, no history rewrite, no acceptance tag. Historical reports
under `docs/reports/` untouched. Working tree contains only the
reviewable Phase 18 change set.

## 11. Final independent-audit blocker repair (2026-10-16 appendix)

Sections 1–10 above preserve the original delivery's historical claims and
limitations. The approved ADR-0027 amendment subsequently resolved the
mode-pinned architecture contradiction, and the independent auditor proved
the genuine same-S/hash Commerce FAIL→fix→PASS lifecycle. That final audit
still returned FAIL for six correctness defects. This appendix records the
authorized implementation follow-up; it is not independent acceptance.

- **B1:** the generic-only CLI binding lookup lost the historical Fintech
  built-in domain. The repair reconstructs that domain from frozen
  engine/contract identity, corroborates the reproduction's supported
  bindings, and carries it through the existing report/exit pipeline.
- **B2/B3:** comparison now consumes accepted Boundary B authorization
  after read-only chain verification, validates pointer-target identities
  and frozen binding metadata, and refuses incompatible versions or
  stale/ineligible publication. Generation/coverage selection remains
  owned by ADR-0026's existing mechanisms.
- **B4:** missing or unavailable execution-engine metadata is refused
  before new durable replay work. Supported historical snapshots retain
  their original bytes and hash; no successor is silently substituted.
- **B5:** collision-free tuple encoding preserves complete invariant and
  subject identity, with explicit ABSENT sides for different identities.
- **B6:** both expectation normalizers preserve arbitrary accepted names
  with null-prototype dictionaries. Unsupported/skipped inputs and empty
  assertions cannot silently match; expected FAIL cannot disappear.

The permanent hostile suite exercises actual Fintech CLI processes,
PostgreSQL publication/watermark adversaries, and identity collisions.
Special-key assertions are permanent unit regressions. The Phase 14
fixture now owns a migrated Control database, addressing persistent
origin-registration collisions without changing production uniqueness.
The Commerce implementation, canonical scenarios, and protected lifecycle
tests are unchanged by this repair. ADR-0027 L.5 remains deferred; no
fingerprint mechanism or Phase 19 implementation was added.

See [Final Six-Blocker Repair & Verification](phase-18-final-six-blocker-repair-verification.md)
for the complete A–O report, exact source/test references, diagnosed first
failures, final command results, proof identities, remaining limitations,
working-tree inventory, and readiness verdict. No stage, commit, tag, or
push is performed by this implementation follow-up.

The full verification run also exposed an incompatible persisted-origin
reuse in the Phase 17 aggregation fixture. Its binding setup now verifies
that the OS-selected listener origin is unregistered before creating the
experiment. All original aggregation assertions remain intact; production
registration/credential checks and the historical registration are not
modified. The final repair report records the exact failed full command,
diagnosis, focused correction result, and subsequent monolithic result.

The next monolithic run exposed a separate Phase 15 definition-fixture
collision: its clock-modulo port was already registered in the loaded
database. That definition-only fixture now uses the existing durable-origin
allocator. Its original 13 titles and 29 assertion expressions are
unchanged, as are the Phase 17 aggregation fixture's 3 titles and 13
assertions. All 13 Phase 15 cases passed after that setup correction.

An additional B2 regression demonstrated that two coherent evaluator
versions for one invariant key can share a generation while Boundary B
returns CURRENT. Comparison now explicitly refuses that ambiguous
authoritative domain. The new test failed before this guard and passed
after it; no ADR-0026 evaluator/publication redesign was made. The hostile
suite now contains 22 real-infrastructure cases.

The final complete `pnpm test:integration` invocation passed its production
build and **all 439 tests across 42 files, zero skipped, exit 0** (Vitest
1218.04 seconds). This supersedes the earlier monolithic limitations and
failed setup attempts without rewriting their historical records. The
serialized unit run passed **767 tests across 60 files**. The final repair
report records the remaining verification gates and handoff verdict.

The expanded five-file shuffled run subsequently found two older Phase 15
order dependencies: cases read an analyzed baseline supplied by another
case. Suite setup now performs one real baseline analysis after capture
and derivation. The original 13 titles and 29 assertions remain intact.
The first clean full command above preceded this fixture-only correction;
the final repair report distinguishes that run from the same-seed corrected
shuffle and the final monolithic rerun on the corrected fixture source.

The corrected same-seed shuffle passed **53 cases across five files,
8 explicitly filtered, exit 0**. It covers all 22 new hostile cases, all
three Commerce amendment cases, and all cases in the three repaired
fixtures. Fresh actual Commerce reports were retained and checked
read-only against durable truth, including original-history preservation.
The auditor's exact historical Fintech reproductions now replay with
certified INV-IZ-1 FAIL/PASS and actual exits 1/0, preserving their S/hash.
Incident Zero passed 5 intent + 25 vulnerable + 21 secure assertions and
its transient credential-canary scan. Controlled Faults passed all 80
assertions across four runs and left no live armed plan; response-loss
invocations remain INDETERMINATE with no retry.

The closing full command was interrupted once without a completed result;
that attempt was excluded. After resumption on identical frozen source,
the final `pnpm test:integration` command passed its production build and
**439 tests across 42 files, zero skipped, exit 0**, completing at 20:33:55
Asia/Karachi on 2026-10-16 (Vitest 1264.38 seconds). Full typecheck, final
root fixture/source check, lint, format, migration verification and diff
checks also passed. Historical report/ADR prefixes and the accepted Git
baseline remain preserved; the index is empty.

Implementation handoff: **READY FOR INDEPENDENT PHASE 18 RE-AUDIT**.
Phase 18 remains local, uncommitted, and unaccepted. No stage, commit,
tag, push, Phase 19 work, or deferred L.5 fingerprint mechanism occurred.
The complete A–O repair report above is the final verification record;
acceptance requires a separate independent reviewer.
