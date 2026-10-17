# PHASE 18 — FINAL SIX-BLOCKER REPAIR & VERIFICATION

Date: 2026-10-16. Implementation follow-up to the final independent adversarial audit; this is **not an independent audit or phase acceptance**.

All six reported blockers are repaired and covered by permanent regressions.
The final complete integration command passed on the frozen repair source.
**READY FOR INDEPENDENT PHASE 18 RE-AUDIT.** Phase 18 remains unaccepted.

## A. Exact root cause of each blocker

| Blocker | Root cause | Repair |
| --- | --- | --- |
| B1: legacy Fintech CLI | The report pipeline read only the later generic `target.invariantBindings` array. Historical Fintech snapshots encode their built-in invariant contract through frozen engine/contract identity, so the CLI incorrectly used an empty bound domain and returned exit 2. | Reconstruct the known legacy domain from the frozen engine/contract; corroborate reproduction metadata before creation; use that domain through analysis completion, Boundary B, report, and classification. |
| B2: incompatible versions | Comparison collected arbitrary current pointers and merely exposed a version-difference flag while still comparing verdict strings. A single generation can also contain multiple authoritative versions of one key. | Authorize each side's single publication, refuse multiple authoritative versions of a key, and refuse cross-side evaluator/eligibility/coverage-mode mismatches. Validate generic row metadata against the frozen binding. |
| B3: foreign/stale pointers | A run-scoped pointer query trusted the resolved evaluation without checking its complete identity, current composite watermark, derivation readiness, or coverage authority. | Accepted read-only chain verification plus Boundary B authorization; explicit pointer-target run/key/subject/version/evidence identity checks; frozen side metadata and explicit as-of watermarks. |
| B4: unknown engine | Preflight checked canonical hash, target authority, and generic registry availability but never checked the required execution engine. | Require the actually implemented `EXECUTION_ENGINE_VERSION` before durable creation; missing/unknown metadata is refused, with no successor substitution. |
| B5: lost subjects | `${invariantKey}::${subjectKey}` was not an injective tuple encoding. `(AUDIT::N, X)` and `(AUDIT, N::X)` collided. | Encode the complete pair with JSON, retaining each exact identity and explicit ABSENT sides. |
| B6: expectation bypass | Assigning `__proto__` to an ordinary object dictionary invoked inherited behavior instead of storing the expected verdict. Unsupported scenario entries and empty assertions also admitted silent narrowing. | Null-prototype dictionaries in both normalizers, explicit normalization issues, and refusal of vacuous assertions. Arbitrary accepted names remain supported. |

## B. Source files and lines changed

These are repair changes on top of the preserved Phase 18 candidate, not a replacement of that candidate.

| Source | Relevant lines / responsibility |
| --- | --- |
| [engine/replay.ts](../../packages/engine/src/replay.ts) | 75: frozen invariant domain; 153: engine availability gate; 273: validated replay binding domain |
| [engine/index.ts](../../packages/engine/src/index.ts) | Additive `frozenInvariantKeys` export |
| [cli/orchestrator.ts](../../packages/cli/src/orchestrator.ts) | 491: reproduction/source snapshot reads; 526: legacy metadata corroboration; 852: shared frozen-key loader |
| [cli/expectations.ts](../../packages/cli/src/expectations.ts) | 57: scenario normalization; 84/116: safe dictionaries; 177: complete non-vacuous assertion |
| [evidence/integrity.ts](../../packages/evidence/src/integrity.ts) | 55/141: optional read-only verification, preserving the default verifier behavior |
| [forensics/replay-comparison.ts](../../packages/forensics/src/replay-comparison.ts) | 214: authorized side reader; 294: same-generation ambiguity refusal; 367/388: both-side authorization and compatibility refusal; 402/412: complete subject identity; 502: certified as-of metadata |
| [Phase 14 fixture](../../tests/integration/phase14-generic-evidence.test.ts) | 224: fixture-owned migrated Control database; teardown drops only that owned database |
| [Phase 15 fixture](../../tests/integration/phase15-generic-invariants.test.ts) | 813: definition-only UNBOUND test uses the durable-origin allocator; 854: real baseline analysis in suite setup makes its cases independent of test order |
| [Phase 17 aggregation fixture](../../tests/integration/phase17-aggregation.test.ts) | 51: reserve an OS-free and durably unregistered listener origin before the existing harness; all original assertions retained |
| [Control provisioner](../../tests/integration/helpers/control-db-provision.ts) | Test-only UUID database, committed migration files, owned cleanup |
| [Hostile integration suite](../../tests/integration/phase18-audit-blockers.test.ts) | 98: actual Fintech CLI; 216/223/260: frozen binding/version preflight; 295: authorized comparison; 317/410: evaluator/eligibility adversaries; 444–557: identity, publication and integrity adversaries; 589: subject collisions |
| [Expectation unit suite](../../packages/cli/src/replay-command.test.ts) | Permanent normalization/assertion counterexamples for special keys, missing/mixed verdicts, malformed expectations and vacuous assertions |

The [ADR-0027 clarification](../decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md) records the existing legacy contract and comparison read discipline. ADR-0012 and the foundational ADR-0026 publication/eligibility contract are unchanged. No new repair migration, dependency, target business-state write, or fingerprint mechanism was added.

## C. Implementation details

Legacy Fintech snapshots with engine `phase3-execution-v1`, contract `DEMO_FINTECH_WEBHOOK`, and no generic evidence policy retain the accepted INV-IZ-1 / INV-DF-1 / INV-DF-2 v1 semantics. The new shared key reader derives this implicit built-in domain from those frozen fields. It does not infer a domain from observed verdicts or mutable registry definitions. The selected reproduction must corroborate every required legacy key/version; absent, duplicated, or unsupported metadata refuses before new work.

Generic runs continue to use their explicit frozen bindings. No historical snapshot, hash, reproduction, or original run is rewritten. The five-way classifier and deterministic evaluators are unchanged; expectations still cannot change a verdict or exit.

Comparison verifies each evidence chain outside the lock with `recordResult: false`, then uses the accepted Boundary B transaction to authorize its exact verified prefix and current C/P/D publication. It never re-analyzes or repairs a stale side to hide a refusal. Boundary B remains the sole generation/missing-proof/coverage selector. The consumer additionally validates every pointer target's complete identity and binding metadata, and requires exactly one authoritative evaluator version per invariant key. Findings, invocation knowledge, and reproduction references are read sequentially inside that same per-run transaction. Output exposes each side's `certifiedAsOf` watermark; it does not promise perpetual freshness or a simultaneous cross-run snapshot.

## D. New permanent adversarial regression tests

[phase18-audit-blockers.test.ts](../../tests/integration/phase18-audit-blockers.test.ts) adds **22 real-infrastructure cases**, independently runnable and shuffle-safe:

- External compiled CLI replay in both Fintech modes, exact S/hash reuse, independent evaluations, complete bound domain, exits 1/0, clean secrets, and preserved original snapshot/evaluations.
- Supported historical engine, missing/unsupported engine metadata, missing/unsupported legacy bindings, and no new run/steps/observations on version refusal.
- Genuine authorized comparison with distinct generated payment subjects and unchanged verifier metadata.
- Incompatible evaluator and eligibility versions despite matching verdicts.
- Two coherent evaluator versions for the same key at the same generation, even when Boundary B reports CURRENT; comparison must explicitly refuse their ambiguous meaning.
- Foreign run, subject, and evidence identities; superseded generation; missing bound proof; unresolved derivation.
- Stale C, P, and D followed by accepted real re-analysis, never stale agreement.
- PostgreSQL's append-only raw-truth guard and comparison refusal for a corrupt integrity head.
- Colliding tuple identities, multiple subjects, both sides, differing verdicts, and ABSENT markers.

[replay-command.test.ts](../../packages/cli/src/replay-command.test.ts) adds special-key coverage for `__proto__`, `constructor`, and `prototype` in both input shapes; multiple expected keys; missing expected FAIL; mixed reported verdicts; unsupported/skipped expectations; and empty assertions. Existing multi-verdict/duplicate tests remain intact.

The comparison detector injections are explicitly synthetic Control-database fixtures, not evidence of target business effects. Their database is freshly migrated, owned by the suite, and dropped. Real business truth comes from the actual HTTP/worker/golden runs and the protected Commerce lifecycle. The test files are permanent working-tree changes; no commit was made.

## E. Independent-audit counterexamples

| Counterexample | Executable protection |
| --- | --- |
| Legacy replay returned exit 2 with no bound evaluations | Actual external CLI regressions require all three legacy keys and correct independently computed exits/verdicts. |
| Same key, v1 versus v999, reported a comparison | Real PostgreSQL evaluator/eligibility drift fixtures require refusal. |
| Replay pointer reused the original run's evaluation | Foreign-target fixtures require refusal before any comparison result. |
| Proof/pointer remained after P advanced | C/P/D tests require refusal; only real re-analysis restores authorization. |
| Unknown engine created four step rows | Correctly canonicalized detector snapshots require pre-creation refusal and unchanged work counts. |
| Two tuple identities became one row | Both tuple identities, additional same-key subjects, and both sides remain present in detector output. |
| Expected `__proto__` FAIL disappeared and matched actual PASS | Both normalizers preserve the key and the assertion mismatches; unsupported/empty assertions cannot match. |

The complete execution matrix is recorded in K, with failed attempts
diagnosed separately in J.

## F. Real Fintech CLI replay evidence

The actual compiled command was exercised against the auditor's original
persisted reproductions in the loaded Control database:

```text
node packages/cli/dist/cli.js replay --reproduction <ID> --timeout 120s --report <OUTPUT> --json
```

| Mode | Original reproduction | New replay run | Actual process exit | INV-IZ-1 |
| --- | --- | --- | --- | --- |
| VULNERABLE | `f3fdc9eb-ac62-47f4-ad54-969f5405380f` | `40eb8c9e-9fe8-4303-9d41-74898e3c2057` | 1 | FAIL |
| SECURE | `38700c1e-fa08-4f05-96fc-35fc8b9c3b7b` | `e82ff3d7-d44c-4de0-87e6-31217d7c0f6d` | 0 | PASS |

VULNERABLE retained snapshot `cc7d2ac6-d96d-4766-a9ff-c11d3c79e420`,
hash `f3485caa59924e06dcd718fcd84ddf8083de2c1b18bca983b17c373512dfccea`.
SECURE retained snapshot `54ca563d-0a0f-4793-b5f0-925a9ba166e9`,
hash `60b724095130f186bcb3e503704b7997b7ede53353eba5a721385c0a561be3fd`.
Their original runs are respectively `d89dbfd7-f2c9-4de8-a83f-45f8e8e0e779`
and `bd6e24d8-6259-4796-b890-84c42a870d72`.

Both reports have certified eligibility and verified evidence, and contain
all three independently evaluated v1 keys: INV-DF-1, INV-DF-2, INV-IZ-1.
The loaded-data driver asserted preservation of the serialized original
reproduction/run/snapshot and equality of each original/replay S/hash.
The permanent external-CLI regression additionally checks original
evaluations remain unchanged. That regression passed in both the full
command and the corrected shuffled run. Actual JSON reports and the
driver's results are retained externally; no expected verdict controls
classification.

## G. Commerce same-snapshot FAIL→PASS preservation

The existing lifecycle implementation and test file are unchanged by this
repair. The corrected shuffled run retained this fresh proof:

| Identity | Actual value |
| --- | --- |
| Original reproduction | `a8a10bf1-8318-41b7-bb72-d2fe9e31c7b7` |
| Same snapshot row S | `c3cd1e87-ac37-435c-a4f7-c7cb87515fb5` |
| Same content hash | `63230b361105038b39a0eca14adaa73b0bc05402bd4fef12f050ae353778e566` |
| Original run | `975c404a-0c81-465f-b302-30649538c17d` |
| Replay run | `f686ba1a-1bfa-43ea-a1e4-7dc8403aafc1` |
| Original historical frame SHA-256, before and after | `65d5cedd924ca15da323c5dc06755dd8c9c08d576e63094d9cf88661cd6ee2e1` |

Both executions made two physical submission requests with genuine
overlap. Target-authored business records show accepted orders **2→1**,
reservations **2→1**, and remaining stock **−1→0**. INV-CHK-1 and
INV-INV-1 both change **FAIL→PASS**, findings **2→0**, actual exits **1→0**.
The target's legitimate admin interface changed processing revision 2→3
on the same instance `958e36cf-6a00-4b54-9a3a-64d94994b051`.
The frozen mode-preserving setup did not undo that remediation.

Both actual CLI reports were retained by matching their run IDs before
fixture cleanup. A subsequent read-only check returned exit 0: canonical
snapshot hash and every raw-observation chain/content hash recomputed;
schema-valid reports matched their durable run-owned pointers, proofs and
C/P/D inputs; captured target business collections and overlap rechecked;
the complete original historical frame matched; five configured credential
values were absent from the inspected artifacts. Each run has 16 raw
observations and five invocations, including the two submissions. These
are implementation verification artifacts, not a separate acceptance audit.

## H. ADR-0026 truth-isolation proof

No evaluator/publication redesign was introduced. Comparison consumes Boundary B's authorized state instead of selecting raw pointers independently. The new detector tests exercise foreign identity, stale C/P/D, superseded generation, missing proof, incomplete derivation, and integrity failure. A foreign row never becomes a business FAIL/PASS, and missing truth cannot manufacture agreement.

Current authority is determined by publication generation and the composite watermark, never timestamps or UUID order. Incompatible evaluator/eligibility versions refuse. Each side's as-of state is explicit. Read-only chain verification leaves original verifier coordination metadata unchanged; a permanent regression compares head rows before and after comparison.

## I. Comparison and expectation correctness

Subject pairing is exact tuple equality. Independently generated Fintech payment identities remain distinct with ABSENT sides; no temporal/positional equivalence is inferred. Per-key agreement remains explicitly agreement of verdict domains, not proof that subjects or causal histories are identical. Generic registry/kind/evaluator detail must match the frozen binding; version-incompatible publications cannot be blended.

All accepted arbitrary expectation keys survive enumeration. Every subject reported for an expected key must carry the expected verdict. Missing expected keys, multiple differing verdicts, unsupported metadata, and explicit empty assertions mismatch visibly. Expectation failures do not rewrite report truth, findings, evidence, or the deterministic classification.

## J. Full integration-suite diagnosis and result

The independent audit's 12 skipped Phase 14 cases came from its `beforeAll`, not failed business assertions. OS-selected ephemeral origin `http://127.0.0.1:50138` was free as a TCP listener but still registered in the persistent Control database to `b1-prov-target-1791970502854-479899`, created 2026-10-14 09:35:02.869 UTC. The provenance suite's historical registration and the library fixture's new name conflicted under the correctly enforced global normalized-origin authority. A unique display name cannot make a previously registered origin unique.

The repair gives the Phase 14 fixture its own migrated Control database. Its actual HTTP origin can no longer collide with another Control database's registration history. Production uniqueness, normalization, and authorization rules remain unchanged; no existing developer registration is deleted. The repaired twelve-case fixture passed directly and in the final monolithic command against the existing loaded development environment.

The test provisioner uses the configured test role's database-creation
rights, applies committed migration SQL, and cleans up only its UUID-named
database after successful creation. Cleanup connects through `postgres`;
it never targets a developer registration or business database. The
ownership and connection semantics were checked against PostgreSQL's
official [CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html)
and [DROP DATABASE](https://www.postgresql.org/docs/current/sql-dropdatabase.html)
documentation.

First failures were diagnosed before reruns:

1. The initial targeted detector run had 29 passed / 2 failed. A superseded pointer was correctly refused under an identity error while the test demanded only a generation label. The raw-corruption test tried an update that PostgreSQL correctly rejected as append-only; even its attempted restoration was forbidden. The corrected test asserts that guard, then corrupts/restores verifier head metadata to test integrity refusal without disabling raw-truth protection.
2. The first shuffled run had 23 passed / 1 failed / 8 filtered. All three Commerce amendment cases passed. The newly added missing-proof case was refused, but a redundant consumer proof lookup masked Boundary B's `MISSING_PROOF` diagnosis with a generic pointer error. The consumer now leaves generation/missing-proof selection to Boundary B while retaining direct identity checks. The specific corrected missing-proof test then passed (1 passed / 20 filtered).

The first clean `pnpm test:integration` command returned **exit 0: 439 passed,
42 files passed, zero skipped**, after its production build also passed.
Vitest started at 16:59:45 local time and completed in 1218.04 seconds.
This included all 22 new hostile cases, all 23 Phase 17 CLI cases, the
ADR-0026 suites, and both protected Phase 18 replay suites. The separate
shuffled result and final monolithic rerun are recorded in K. No failed execution above is represented
as a passing gate.

The first repaired monolithic command completed with **437 passed / 1 failed,
42 files, exit 1**. Every Phase 18 case passed, including all 21 new hostile
cases and the 11 Commerce cases. The failure was another loaded-database
fixture collision: the aggregation fixture recycled origin
`http://127.0.0.1:54634`, and its existing-registration fallback inherited
`commerce-lifecycle-1791030610245-200140`, created **2026-10-03 12:30:10.270
UTC**, with a Commerce signing manifest. The existing credential-authority
check correctly denied that foreign policy before any aggregation action.

The smallest correction is fixture allocation: reserve an OS-selected
listener, check its exact normalized origin against durable registrations,
and close/reallocate before experiment creation if already registered.
The original three aggregation tests and their business assertions are
preserved; all three passed in focused real PostgreSQL/HTTP execution.
Production registration/credential rules and the old registration are
untouched. Re-listening occurs only after closing the prior listener, as
supported by the [Node 22 server API](https://nodejs.org/docs/latest-v22.x/api/net.html#serverlisten).
This is bounded test setup, not a retry of an experiment mutation.
Partial counts are not a green full gate.

The second monolithic command again returned **437 passed / 1 failed,
42 files, exit 1**. Phase 17 aggregation and all Phase 18 cases passed.
The remaining setup failure was the Phase 15 definition-only UNBOUND case:
its clock-modulo port `35375` collided with the persistent registration
`dead-target-1790189535047-903714` (2026-09-23 18:52:15.057 UTC).
The fixture now uses the existing `uniqueTestOrigin(prisma())` allocator.
All 13 Phase 15 cases then passed. AST comparisons against HEAD confirmed
unchanged test titles and assertion expressions in both repaired fixtures:
Phase 17 has 3 titles / 13 assertions; Phase 15 has 13 titles / 29 assertions.

A further hostile B2 case deliberately supplied two coherent versions of
one key at the same generation. Before the additional consumer guard,
Boundary B returned CURRENT and comparison resolved, so the regression
failed (1 failed / 21 filtered). After explicitly refusing this ambiguity,
the same case passed (1 passed / 21 filtered). ADR-0026's publication
mechanisms were not changed. This adds the 22nd permanent regression.

One unit rerun under concurrent integration/lint load timed out in the
unchanged schema-byte-stability test at its existing 5-second deadline
(766 passed / 1 failed). It reported no schema mismatch. The serialized
rerun, with the same assertion and timeout, passed all **767 tests across
60 files**, exit 0, in 46.82 seconds. No assertion or deadline was weakened.

The expanded five-file shuffle (seed 18027) then found two pre-existing
Phase 15 order dependencies: semantic dedup read evaluations that an
earlier test had created, and parallel-analysis idempotency measured a
zero-row baseline unless an earlier analysis had run. It returned
**51 passed / 2 failed / 8 filtered, exit 1**. All 22 new hostile cases,
all three Commerce amendment cases, Phase 14, and Phase 17 aggregation
passed. The correction performs one real `runRunAnalysis` in the generic
evaluation suite's `beforeAll`, after real capture/derivation. The 13 test
titles and 29 assertion expressions remain identical to HEAD. The same
seed is rerun after this diagnosed setup correction, followed by a fresh
complete monolithic command on that final fixture source.

The first closing rerun built successfully but was interrupted without a
final test summary or recorded exit; it is not counted as a completed
gate. On resumption, all 25 frozen runtime/test hashes still matched,
there were no remaining RuptureGrid/Vitest Node processes, and all three
PostgreSQL services plus Redis were healthy. Only the incomplete closing
command was restarted, with a separate log and an actual process-exit
record (`integration-full-resumed-result.json`); previous evidence was
preserved.

The resumed closing command completed at **20:33:55 Asia/Karachi on
2026-10-16**, with recorded **exit 0: 439 tests passed across 42 files,
zero skipped**. Vitest ran for **1264.38 seconds**. Its production build
also passed. `integration-full-resumed.log` and its actual exit record
retain that final result against `tested-source-verified.csv`.

## K. Verification gates and observed counts

| Gate | Observed result |
| --- | --- |
| Unit tests, final source | 767 passed across 60 files, exit 0 |
| Lint | PASS, exit 0 |
| Full typecheck | PASS, exit 0; final root test/source TypeScript check also passed after the fixture cleanup refinement |
| Production build | PASS, including the final full integration command's build stage |
| Control migrations | 9 applied, up to date |
| Fintech migrations | 4 applied, up to date |
| Commerce migrations | 3 applied, up to date |
| Commerce schema agreement | No difference, exit 0 |
| Repaired Phase 14 fixture | 12 passed in targeted execution |
| Final full monolithic integration | 439 passed across 42 files, zero skipped, exit 0; 1264.38 s; final frozen fixture/source inventory |
| Corrected shuffled regressions | Seed 18027; 53 passed across 5 files, 8 explicitly filtered, exit 0; 213.71 s |
| Historical loaded-data Fintech CLI replay | Exact auditor reproductions replayed; actual exits 1/0, certified INV-IZ-1 FAIL/PASS, original S/hash retained |
| Commerce durable proof recheck | Exit 0; both actual reports retained; original frame preserved; 5 credential values scanned |
| Incident Zero / credential canary | Exit 0; 5 intent + 25 vulnerable + 21 secure assertions pass; canary scanned, leaks `[]`; no canary in stdout/stderr |
| Controlled Faults | Exit 0; 4 runs, 18+18+22+22 = 80 assertions pass; plan leakage check passes |
| Format / diff check | PASS, exit 0; final repository check also passed at handoff |

External logs retain the exact first failures, corrections, and final results. Proof exports use `RUPTUREGRID_TEST_ARTIFACT_DIR`; that directory is external to the candidate. No credentials are included in this report.

The two standalone verifier entries were run after a successful production
build as `node packages/incident-zero/dist/cli.js --json` and
`node packages/controlled-faults/dist/cli.js --json`. An external capture
driver set a transient Incident Zero admin-token canary in the child
environment, checked stdout/stderr, and retained redacted JSON results.
It did not change the verifier algorithms or persist the canary value.
Controlled Faults' `leakageCheck` specifically means no live armed fault
plan remains; it is not mislabeled as a credential scan.

The external `phase18-repair` evidence bundle is beside the supplied
`phase18-audit` directory. Its principal artifacts are the full integration
logs, `shuffled-verified.log`, the two `fintech-*-replay.json` reports,
`fintech-cli-probe-VULNERABLE-SECURE-results.json`, both standalone
`*-verifier-result.json` files, and `verified-check/` with the Commerce
proof, actual reports, business facts, and `durable-proof-check.json`.
The complete seeded command selected the Phase 18 blocker/amendment
describes plus all cases in the Phase 14, Phase 15 and Phase 17 aggregation
fixtures; the eight filtered older Commerce cases were covered by the
separate complete monolithic command.

The exact shuffled command (run from the repository root) was:

```text
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-audit-blockers.test.ts tests/integration/phase18-replay-commerce.test.ts tests/integration/phase14-generic-evidence.test.ts tests/integration/phase15-generic-invariants.test.ts tests/integration/phase17-aggregation.test.ts -t 'Phase 18 audit blockers|Phase 18 approved mode-preserving amendment|Phase 14|Phase 15|Phase 17.*monotone' --sequence.shuffle --sequence.seed 18027 --reporter=verbose
```

## L. Security and backward compatibility

The approved mode-preserving Commerce lifecycle, original mode-pinned scenarios, target business algorithms, worker ownership/fencing, conservative INDETERMINATE handling, five-way classifier, and authoritative publication protocol remain intact. The repair adds no automatic retry or direct SQL write to target business state. Credential reference/grant authorization and production destination denial remain in force.

ADR-0027 L.5 remains deferred and unapproved. No fingerprint key, encryption, snapshot fingerprint metadata, value-baseline replay prohibition, or ADR-0012 resolution change was added. Secret-value rotation behind an unchanged authorized reference is still not detected and is not claimed.

The complete monolithic command includes all 23 unchanged Phase 17 CLI
cases and the existing ADR-0026 suites. Controlled Faults' two RESPONSE_LOSS
runs each retain exactly one invocation and INDETERMINATE knowledge; no
blind retry is introduced. Incident Zero's canary scan passed with no
leaks, and the Commerce durable check found none of its five configured
credential values in the inspected artifacts. Earlier failed or partial
verification attempts remain recorded in J.

## M. Updated working-tree inventory

The initial 28-file Phase 18 candidate was preserved. Repair changes to that set are limited to the engine replay/export, CLI orchestration/expectations/tests, comparison, appended ADR-0027 clarification, and appended self-audit. Additional repair files are the verifier's read-only option, Phase 14 isolation wiring, Phase 15 definition-fixture origin allocation, Phase 17 aggregation listener allocation, the Control fixture provisioner, the new hostile integration suite, and this report.

The complete candidate inventory is **35 files: 18 tracked modifications
and 17 untracked files**. Everything remains unstaged.

| State | File |
| --- | --- |
| Modified | `apps/demo-commerce/src/admin-service.ts` |
| Modified | `apps/demo-commerce/src/app.ts` |
| Modified | `docs/checkout-zero.md` |
| Modified | `docs/cli.md` |
| Modified | `docs/incident-replay.md` |
| Modified | `docs/phase-roadmap.md` |
| Modified | `packages/cli/src/cli.ts` |
| Modified | `packages/cli/src/index.ts` |
| Modified | `packages/cli/src/orchestrator.ts` |
| Modified | `packages/commerce-db/prisma/schema.prisma` |
| Modified | `packages/commerce-db/src/checkout-core.ts` |
| Modified | `packages/engine/src/index.ts` |
| Modified | `packages/evidence/src/integrity.ts` |
| Modified | `packages/forensics/src/index.ts` |
| Modified | `tests/integration/helpers/commerce-db-provision.ts` |
| Modified | `tests/integration/phase14-generic-evidence.test.ts` |
| Modified | `tests/integration/phase15-generic-invariants.test.ts` |
| Modified | `tests/integration/phase17-aggregation.test.ts` |
| Untracked | `docs/decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md` |
| Untracked | `docs/external-ci-recipe.md` |
| Untracked | `docs/reports/phase-18-adr-0027-architectural-resolution.md` |
| Untracked | `docs/reports/phase-18-amendment-implementation-verification.md` |
| Untracked | `docs/reports/phase-18-final-six-blocker-repair-verification.md` |
| Untracked | `docs/reports/phase-18-self-audit.md` |
| Untracked | `packages/cli/scenarios/checkout-zero-post-fix.scenario.json` |
| Untracked | `packages/cli/src/expectations.ts` |
| Untracked | `packages/cli/src/replay-command.test.ts` |
| Untracked | `packages/commerce-db/prisma/migrations/20261016_phase18_processing_provenance/migration.sql` |
| Untracked | `packages/engine/src/replay.ts` |
| Untracked | `packages/forensics/src/replay-comparison.test.ts` |
| Untracked | `packages/forensics/src/replay-comparison.ts` |
| Untracked | `tests/integration/helpers/control-db-provision.ts` |
| Untracked | `tests/integration/phase18-audit-blockers.test.ts` |
| Untracked | `tests/integration/phase18-replay-commerce.test.ts` |
| Untracked | `tests/integration/phase18-replay-fintech.test.ts` |

Twenty of the original 28 candidate files remain byte-identical. The eight
changed candidate files are the engine replay/export, CLI orchestration,
expectation implementation/tests, comparison, and appended ADR/self-audit
material. All 25 runtime/test candidate files matched the SHA-256 inventory
captured before the final full command. The self-audit's original 14,475
bytes and ADR-0027's original 12,356 bytes remain exact prefixes. HEAD and
`phase-17-accepted^{}` remain `eb95c157824f8990be609311a18c668e52ec2b76`;
the index is empty. No stage, commit, tag, push, or Phase 19 work was
performed.

## N. Remaining defects or risks

Each of the six reported counterexamples is covered by permanent executable
regressions, and the final complete matrix passed. No confirmed blocker
remains in this repair scope. The deliberately corrupted detector fixtures
do not imply an unprivileged remote-write exploit or tamper-proof database
guarantees. Database records remain logically append-only.

Two complete replay pipelines simultaneously resetting the same target scope are not newly demonstrated by this repair. The permanent lifecycle proves actual concurrent requests within each execution; the existing multi-worker/fencing suites remain required. Future engine/evaluator compatibility needs explicit supported-version policy rather than silent substitution. Deferred secret-value fingerprint detection remains a stated limitation.

## O. Final readiness verdict

**READY FOR INDEPENDENT PHASE 18 RE-AUDIT.**

The six confirmed blockers have cause-level repairs, permanent hostile
regressions, real CLI/process evidence, and a passing final monolithic
command. The genuine Commerce same-S/hash FAIL→fix→PASS lifecycle is
preserved. All changes remain local and unstaged; no commit, tag, push,
Phase 19 work, or deferred fingerprint mechanism was introduced.
Independent Phase 18 acceptance remains a separate review by a reviewer
other than this implementation agent; no phase acceptance is claimed.
