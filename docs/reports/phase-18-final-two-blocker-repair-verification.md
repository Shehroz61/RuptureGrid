# PHASE 18 — FINAL TWO-BLOCKER REPAIR & VERIFICATION

Date: 2026-10-17, Asia/Karachi. Implementation verification of the two defects in the 16 October final independent acceptance audit. This is not independent acceptance. Phase 18 remains local, unstaged, uncommitted and unaccepted.

## A. Root cause of incomplete/foreign batch acceptance

Comparison verified the snapshot, raw chain, pointer scalar identity, proof, generation and C/P/D authority, but neither its frozen-input callback nor Boundary B validated the evaluation's batch. The independent batchId and runId foreign keys permit an own-run evaluation to reference another run's batch. A non-null evaluation pointer also says nothing about batch completion. The actual CLI previously returned exit 0 and replay PASS for both contradictions.

The exact former Commerce detector inputs now return exit 4 with EVALUATION_AUTHORITY_INVALID and no comparison subjects/keys. The complete cloned baseline still compares FAIL to PASS. These detector modifications occur only in newly migrated UUID-owned Control databases, restored and dropped; genuine source records are read-only. Evidence: historical-preservation/batch-authority-cli-closure.json and extended-trust-boundary-probes.json.

## B. Exact comparison trust-boundary repair

[Shared Boundary B authorization](../../packages/evidence/src/report-authorization.ts) resolves each selected evaluation together with its batch under the existing per-run advisory lock. It requires evaluation run/key/subject/evaluator/evidence identity to match the pointer, batch run/key/evaluator identity to match the same request, and completedAt to be non-null. Any contradictory row makes the entire selection NOT_EVALUABLE and uncertified, including a mixture of valid and invalid keys. Comparison refuses that selection through its existing RunComparisonError/CLI exit-4 contract; report authorization retains its uncertified business refusal. No historical fallback or second truth selector is introduced.

The accepted schema has no separate batch status or batch analysis-generation column. completedAt is its completion marker; evaluationCount records accumulated evaluation history and is not a substitute for proof subject coverage. Current proof/pointer generation, required subjects, C/P/D, verified chain identity and derivation readiness remain the existing authority for the selected set. No schema change is required.

## C. Hostile batch counterexample tests

[Permanent hostile suite](../../tests/integration/phase18-audit-blockers.test.ts) now contains 28 cases. Together with the new initializer regression, the focused command passed 29/29 across two files, zero skips, exit 0. The full gate also executed them. All original assertions remain; the evaluator-version detector now changes its batch coherently as well, so it still reaches the intended cross-side compatibility check.

| Required state | Durable regression and result |
| --- | --- |
| Complete authoritative batch | Genuine same-hash pair authorizes before corruption and again after restoration. |
| Incomplete batch | completedAt null: Boundary B NOT_EVALUABLE/uncertified; actual CLI exit 4, no verdict. |
| Foreign run batch | Own evaluation attached to original run's batch: same refusal. |
| Wrong batch invariant/version | Each contradiction refuses through Boundary B and actual CLI. |
| Foreign evaluation run | Evaluation run changed while pointer stays local: refuses; no verdict. |
| Pointer to foreign evaluation | Existing run/subject/evidence pointer identity detectors still refuse. |
| Generation mismatch/superseded publication | Old pointer generation refuses; mixed authoritative evaluator versions refuse. |
| Stale C/P/D | Each actual truth-input advance refuses until legitimate re-analysis. |
| Missing eligibility proof | Missing bound proof refuses despite persisted rows. |
| Missing required subject evaluation | Strict proof retains required subject; current pointer removed while historical evaluation remains: refuses without fallback. |
| Multiple subjects per invariant | Collision/same-key detector retains three exact tuples, distinct sides and ABSENT semantics. |
| Mixed trusted/untrusted rows | Each new corruption affects one selected key among otherwise valid keys; no partial comparison escapes. |

The two exact former Commerce CLI counterexamples also passed as refused on a disposable clone of the previous audit's genuine FAIL/PASS pair. The extended original trust matrix has no unclosed cases. Evidence: focused-regressions.log, historical-preservation/batch-authority-cli-closure.json, historical-preservation/extended-trust-boundary-probes.json.

## D. Root cause of initialization race

The first failure was P2002 at ensureInvariantDefinitions in analysis.ts, reached by phase18-audit-blockers.test.ts beforeAll. Its empty migrated Control database started an automatic worker, then foreground runGoldenScenario analysis. Worker analyzeSettledRuns and foreground runRunAnalysis both performed a client-side upsert with empty update against absent unique invariant definitions. Their read-then-insert operations raced. This is production first-use behavior, not target-origin collision, module caching, Redis loss or a registration-permission problem. The failing beforeAll explains all 22 skipped assertions in the prior monolithic and shuffled gates.

Before repair in this session, four compiled callers were held at a real PostgreSQL SHARE table-lock barrier on the initially empty invariant_definition table. pg_locks confirmed four blocked RowExclusiveLock writers before release: one completed and three rejected with P2002. Exactly three definitions existed. The owned database was dropped. Evidence: initializer-before.log and invariant-initialization-race.json.

## E. Exact synchronization/fixture repair

[ensureInvariantDefinitions](../../packages/evidence/src/analysis.ts) now uses one createMany with skipDuplicates, letting PostgreSQL INSERT ON CONFLICT DO NOTHING arbitrate concurrent first insertion. Existing definitions and their content remain unchanged. No error suppression, blind retry, delay, timeout increase, registration weakening or test-only priming is used. The version-sensitive API was checked against [official Prisma v7 documentation](https://www.prisma.io/docs/orm/v7/reference/prisma-client-reference#createmany).

[Permanent real-PostgreSQL regression](../../tests/integration/phase18-initialization.test.ts) recreates the exact empty-database/four-writer barrier, asserts every caller completes, verifies exactly the three expected definitions, and repeats concurrent initialization to assert exact row preservation. Bounded polling observes actual locks; elapsed time is never overlap evidence. finally releases the lock, joins pending calls and drops only its owned database.

The compiled after-repair barrier observed four blocked writers, four fulfilled callers, zero rejections, three definitions and owned cleanup. The original worker/foreground fixture also passed its complete 28 cases in the focused and full commands. Evidence: initializer-after.json and focused-regressions.log.

## F. Full integration command, count, skips and exit

Command: pnpm test:integration. Standard configuration unchanged: real infrastructure, fileParallelism=false, original hook/test timeouts and existing explicit case bounds.

**43 files passed; 446 tests passed; 0 skipped; exit 0.** All 446 collected cases are accounted for. This is one completed monolithic invocation after the source repair. It ran 2026-10-17T01:22:36.9428298+05:00 to 2026-10-17T01:41:29.9529886+05:00 (1133.01 seconds including build). No setup-skipped cases, failed suites or lucky integration reruns are substituted. Evidence: integration-full.log and gate-results.json.

The prior independent audit's failed result remains historical evidence: 417 passed, 22 skipped, exit 1. It is not rewritten as passing.

## G. Shuffled verification results

Exact formerly failing command:

~~~text
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-audit-blockers.test.ts tests/integration/phase18-replay-commerce.test.ts tests/integration/phase14-generic-evidence.test.ts tests/integration/phase15-generic-invariants.test.ts tests/integration/phase17-aggregation.test.ts -t "Phase 18 audit blockers|Phase 18 approved mode-preserving amendment|Phase 14|Phase 15|Phase 17.*monotone" --sequence.shuffle --sequence.seed 18027 --reporter=verbose
~~~

**5 files passed; 59 tests passed; 8 deliberately filtered; exit 0.** The -t expression intentionally excludes eight unrelated cases; zero skips result from setup failure. All 28 hostile cases ran. Seed 18027 and the existing five-file selection are preserved. The new initializer barrier also passed in the full monolithic gate. Evidence: shuffled.log.

## H. Commerce same-snapshot FAIL→PASS preservation

The unchanged permanent real HTTP/worker/Redis/PostgreSQL Commerce lifecycle executed in the full command and again in the planned shuffle. The new full-run proof is phase18-proof-cc450447-d5de-44a4-b3a6-8bf5cc439253.json.

| Identity | Full-gate value |
| --- | --- |
| Reproduction | 1179d645-fc5e-4b06-a854-95c39b9cb6ab |
| Original run | 673f1238-b96e-4c41-a90c-7e936ce0539b |
| Fixed replay | cc450447-d5de-44a4-b3a6-8bf5cc439253 |
| Exact snapshot row, both | 53911f9a-6294-417d-ac2c-738a425a6c91 |
| Exact snapshot content hash, both | 9a6e4a98fdb2fc55a9ddb26bc4d78c6d980000ca246bf9b02cfd2307b6088850 |
| Original/preserved complete-frame SHA-256 | 6528dd14b0ca22d4a0a7af3a25878d14ccb5f82674ea6be7ca4ca03533e25921 |

Actual CLI exits 1→0; accepted orders/reservations 2→1; stock −1→0; INV-CHK-1/INV-INV-1 FAIL/FAIL→PASS/PASS; findings 2→0. The no-fix control still FAILs. Legitimate target admin mode remediation is VULNERABLE revision 7→SECURE revision 8, on the same target instance. Both executions record real overlapping submissions and actual-used configuration. Original report bytes and the complete original durable frame remain unchanged.

The separate read-only verifier rehashed snapshot content, every raw payload/link/head, pointers/proofs and completed own-run batches, and checked captured business collections, report schema and credential absence. It also rechecked the previous independent audit's original frame unchanged. These are observed preservation checks, not a claim of tamper-proof records. Evidence: durable-proof-check.json, business-proof-*.json, actual-reports, historical-preservation.log.

## I. Fintech replay preservation

Both permanent actual legacy CLI cases executed in the full and shuffled gates. Additionally, the exact durable reproductions from the earlier audit were replayed again through new CLI processes with real worker/target infrastructure:

| Mode | New replay run | Same historical snapshot row | CLI exit |
| --- | --- | --- | --- |
| VULNERABLE | 6b15101c-6385-4844-a577-7cb0ca1fc00c | cc7d2ac6-d96d-4766-a9ff-c11d3c79e420 | 1 |
| SECURE | c7f9e5a7-a6c8-49a4-bd58-95676ac71d19 | 54ca563d-0a0f-4793-b5f0-925a9ba166e9 | 0 |

The VULNERABLE reproduction remains f3fdc9eb-ac62-47f4-ad54-969f5405380f; SECURE remains 38700c1e-fa08-4f05-96fc-35fc8b9c3b7b. Their hashes remain f3485caa59924e06dcd718fcd84ddf8083de2c1b18bca983b17c373512dfccea and 60b724095130f186bcb3e503704b7997b7ede53353eba5a721385c0a561be3fd. Each replay retains all three v1 keys, 25 independently rehashed observations and completed own-run batches; INV-IZ-1 effects 2/1 give FAIL/PASS, with no unexpected NOT_EVALUABLE. Original reproduction/run/snapshot bindings are unchanged. Evidence: fintech-cli-probe-VULNERABLE-SECURE-results.json and fintech-independent-recheck.json.

## J. ADR-0026 integrity and publication guarantees

The existing Boundary A publication, shared generation, proof coverage, Boundary B advisory lock, C/P/D watermark equality, verified-prefix binding and derivation readiness remain in force. The repair fills checklist 7's omitted batch authority check in the shared report/comparison authorizer. A read-only comparison still never repairs its own stale input. Each side discloses its own authorized as-of watermark; no simultaneous cross-run snapshot is claimed.

All eleven Phase 17 integration files passed, including CLI exit reduction, eligibility, publication, aggregation, finalization, provenance/derivation, anchors and worker fencing. Phase 15's original thirteen titles/twenty-nine assertions and Phase 17 aggregation's three titles/thirteen assertions remain AST-identical to accepted HEAD. Genuine same-snapshot comparison and cross-intent refusal remain tested. The existing B1–B6 regressions, including engine preflight, version mismatch, exact subject tuples and prototype-key expectations, pass. Evidence: integration-full.log, assertion-preservation JSON files and expectation-probes.json.

## K. Unit and remaining verification gates

| Command | Exit | Evidence log |
| --- | --- | --- |
| pnpm format:check | 0 | format.log |
| pnpm lint | 0 | lint.log |
| pnpm typecheck | 0 | typecheck.log |
| pnpm test:unit | 0 | unit.log |
| pnpm build | 0 | build.log |
| pnpm test:integration | 0 | integration-full.log |
| pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-audit-blockers.test.ts tests/integration/phase18-replay-commerce.test.ts tests/integration/phase14-generic-evidence.test.ts tests/integration/phase15-generic-invariants.test.ts tests/integration/phase17-aggregation.test.ts -t "Phase 18 audit blockers\|Phase 18 approved mode-preserving amendment\|Phase 14\|Phase 15\|Phase 17.*monotone" --sequence.shuffle --sequence.seed 18027 --reporter=verbose | 0 | shuffled.log |
| pnpm incident-zero:verify | 0 | incident-zero.log |
| pnpm controlled-faults:verify | 0 | controlled-faults.log |

Unit: 767 passed across 60 files, zero skips. Focused regressions: 29 passed, zero skips, exit 0. Control/Fintech/Commerce migration histories: 9/4/3 up to date; all three datasource/schema diffs report no difference and exit 0. Fresh disposable fixtures use the actual migration SQL. No repair migration, schema push or dependency change was introduced.

Incident Zero passed 5 frozen-intent, 25 vulnerable and 21 secure assertions. Controlled Faults passed 18+18+22+22 assertions, preserving INDETERMINATE and no unsafe retry. A fresh actual transient credential canary reported scanned=true, no leaks and no canary in captured output; its value was never written to evidence. Evidence: incident-zero-verifier-result.json, migration-*.log, schema-*.log and git-final.json.

An external PowerShell results-array bookkeeping error stopped the first gate runner after lint; no monolithic integration had begun. Only that external runner was corrected. The successful format result was retained; lint was repeated because its exit record had not persisted. All gate attempts are retained; no product failure was erased. See harness-correction.txt and lint-before-harness-error.log.

## L. Security and backward compatibility

Registered destinations, environment denial, credential reference/grant checks, blast-radius caps, money units, target database ownership, fencing and uncertainty semantics are unchanged. Tests use legitimate target APIs for business state. Explicit corruption is confined to disposable Control-plane detector fixtures with restoration/cleanup. These checks are correctness regressions, not claims of an unprivileged database-write exploit or a comprehensive security scan.

ADR-0027 L.5 credential fingerprints remain deferred and unapproved. No key, fingerprint baseline, rotation detection, legacy-baseline denial or credential-resolution redesign was added. Changed secret values behind an unchanged authorized reference remain undetected. Existing mode-pinned Commerce scenarios and the additive mode-preserving lifecycle remain intact.

## M. Complete changed-file inventory

39 local candidate files relative to accepted Phase 17; all are listed below. Of the 35 files present on entry, only ADR-0027 (appended clarification) and the hostile suite changed in this repair. Added repair scope is the two tracked evidence implementation files, the new initializer test and this report. The other 33 entry-candidate files remain byte-identical. All 38 candidate hashes captured at the full-gate start remain unchanged afterward. All 31 pre-existing reports remain byte-identical.

| State | File |
| --- | --- |
| Modified | apps/demo-commerce/src/admin-service.ts |
| Modified | apps/demo-commerce/src/app.ts |
| Modified | docs/checkout-zero.md |
| Modified | docs/cli.md |
| Untracked | docs/decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md |
| Untracked | docs/external-ci-recipe.md |
| Modified | docs/incident-replay.md |
| Modified | docs/phase-roadmap.md |
| Untracked | docs/reports/phase-18-adr-0027-architectural-resolution.md |
| Untracked | docs/reports/phase-18-amendment-implementation-verification.md |
| Untracked | docs/reports/phase-18-final-six-blocker-repair-verification.md |
| Untracked | docs/reports/phase-18-final-two-blocker-repair-verification.md |
| Untracked | docs/reports/phase-18-self-audit.md |
| Untracked | packages/cli/scenarios/checkout-zero-post-fix.scenario.json |
| Modified | packages/cli/src/cli.ts |
| Untracked | packages/cli/src/expectations.ts |
| Modified | packages/cli/src/index.ts |
| Modified | packages/cli/src/orchestrator.ts |
| Untracked | packages/cli/src/replay-command.test.ts |
| Untracked | packages/commerce-db/prisma/migrations/20261016_phase18_processing_provenance/migration.sql |
| Modified | packages/commerce-db/prisma/schema.prisma |
| Modified | packages/commerce-db/src/checkout-core.ts |
| Modified | packages/engine/src/index.ts |
| Untracked | packages/engine/src/replay.ts |
| Modified | packages/evidence/src/analysis.ts |
| Modified | packages/evidence/src/integrity.ts |
| Modified | packages/evidence/src/report-authorization.ts |
| Modified | packages/forensics/src/index.ts |
| Untracked | packages/forensics/src/replay-comparison.test.ts |
| Untracked | packages/forensics/src/replay-comparison.ts |
| Modified | tests/integration/helpers/commerce-db-provision.ts |
| Untracked | tests/integration/helpers/control-db-provision.ts |
| Modified | tests/integration/phase14-generic-evidence.test.ts |
| Modified | tests/integration/phase15-generic-invariants.test.ts |
| Modified | tests/integration/phase17-aggregation.test.ts |
| Untracked | tests/integration/phase18-audit-blockers.test.ts |
| Untracked | tests/integration/phase18-initialization.test.ts |
| Untracked | tests/integration/phase18-replay-commerce.test.ts |
| Untracked | tests/integration/phase18-replay-fintech.test.ts |

HEAD and dereferenced phase-17-accepted remain eb95c157824f8990be609311a18c668e52ec2b76. The annotated tag object remains dc49a32c060635c071848efb7508b3251ec23b5b. Index empty; git diff --check exit 0. No staging, commit, tag, push, history rewrite or Phase 19 work occurred. The external evidence bundle is named phase18-two-blocker-repair; it includes exact commands/exits/times, test logs, reports, detector inputs/results and hashes. Prior audit evidence was not modified.

## N. Remaining risks or blockers

No confirmed blocker remains in the two-defect repair scope after the completed gates. Independent acceptance is still required. Records remain logically append-only; arbitrary database writers are not made tamper-proof. Per-side as-of certification does not imply a simultaneous cross-run snapshot or causal proof from equal verdict strings. Two full pipelines concurrently resetting the same business scope are not newly demonstrated. Credential-value fingerprint detection remains deferred. The permanent suites retain real per-run overlapping requests, multi-worker ownership and Redis recovery coverage.

## O. Final readiness verdict

**READY FOR INDEPENDENT PHASE 18 RE-AUDIT**

Both reported defects have cause-level production repairs and permanent real-infrastructure regressions. The complete monolithic and exact shuffled gates passed, and the genuine Commerce and historical Fintech lifecycle evidence is preserved. Phase 18 is not accepted; all changes remain local and unstaged.
