# PHASE 18 — ARCHITECTURAL AMENDMENT IMPLEMENTATION & VERIFICATION

Date: 2026-10-16 (Asia/Karachi). Phase 18 implementation report; **not phase acceptance**.

**READY FOR INDEPENDENT PHASE 18 RE-AUDIT.** The approved subset is
implemented and the required local verification gates below passed. This
is an implementation-readiness verdict, not Phase 18 acceptance.

## 1. Authorized architecture and implementation

The owner approved the narrow Phase 18 amendment and explicitly rejected
Section L.5's fingerprint mechanism. [ADR-0027](../decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md)
preserves its original proposal and appends the approved direction and
explicit security deferral. The architectural-resolution report and prior
self-audit remain historical records, unchanged by this implementation.

Demo Commerce now offers authenticated `POST /demo/admin/scenario-context`.
Its closed body accepts scope, SKU and a non-negative integer baseline
within the target's PostgreSQL integer range. It rejects a mode field,
unknown/missing fields, malformed values, uninitialized processing
settings, and an SKU belonging to another scope. In a target-owned
transaction it preserves processing configuration, advances scope
generation, resets that scope's business rows and establishes its SKU
baseline. Setup is serialized per SKU and uses a coherent locked settings
read; configuration changes and reset either commit coherently or roll
back. The old required-mode setup endpoint retains its golden behavior.

The target migration adds a configuration revision and persistent target
instance identity, plus nullable effective-configuration columns on
processing attempts. Existing attempts remain unknown; there is no
fabricated historical backfill. Explicit mode-setting operations increment
the revision. Each submission captures one settings tuple, stores it on its
processing attempt, and selects the actual naive/idempotent implementation
from that same mode value. Neither reservation implementation changed.

Configuration facts travel in setup/status/submission HTTP responses and
are captured through the existing redacted observation chain. Existing
exact-shape inspection collections and the target manifest are unchanged.
This avoids adding undeclared fields that would invalidate inspection
captures. Revisions serialize as decimal strings; money remains integer
minor units.

The new `checkout-zero-post-fix` scenario observes configuration, resets
business context without selecting mode, performs the existing two
concurrent checkout submissions and observes configuration again. Its
reproduction has `targetModeRequirement: null`. This is a new original
failure lifecycle, never a claim to reuse a historical golden scenario's
hash.

## 2. Replay, contracts and the four repairs

The existing replay dispatcher, analysis/evidence-integrity pipeline,
ADR-0026 publication/authorization boundaries and five-way classifier are
retained. Replay additionally verifies canonical content against the stored
snapshot hash, checks the reproduction against its original run's snapshot
binding, and refuses current environment/contract mismatch. No snapshot
metadata or credential-resolution mechanism was added.

| Finding | Repair |
| --- | --- |
| E-1 | Replay/compare CLI parsers reject malformed UUIDs as usage errors before database lookup. The replay orchestration entry also validates the reproduction UUID. Valid-but-missing IDs remain distinct from infrastructure failures. |
| F-1 | Comparisons read legacy INV-IZ-1 `equivalentEffectCount` when present and valid. The real FAIL→PASS test additionally exposed the accepted generic PASS branch's complete `observedCount` representation; the reader now exposes that persisted count only with matching total and counted identities. Missing/invalid counts remain null. |
| G-1 | Reproduction expectation normalization exposes unsupported, malformed, multi-verdict and duplicate-key entries through explicit issues. Such issues prevent a successful assertion; supported keys are not silently presented as the whole assertion. Expectations never change a business verdict or exit class. |
| D-1 | Both consumer documents point to `packages/cli/schemas/rupturegrid-report-v1.schema.json`; scenario-schema references also use the actual published name. A focused test checks both documents and file existence. |

The comparison's scheduling explanation now acknowledges real target
remediation. A verdict difference is an investigation signal; comparison
does not establish its cause. The replay comparison remains computed on
read and refuses different snapshot hashes.

Living replay/checkout/roadmap/CLI/CI contracts document the approved
separation without weakening the mandatory same-snapshot acceptance item.
ADR-0012 is unchanged. The old golden scenarios and Phase 17 tests are not
edited to accommodate the amendment.

## 3. Permanent real-infrastructure proof

The Commerce integration suite adds a self-contained lifecycle over real
TCP HTTP, a real worker, Redis/BullMQ, Control PostgreSQL and a throwaway
Commerce PostgreSQL database built from the migration history. All
business setup/remediation uses target HTTP. Test-side target SQL uses a
read-only transaction; the accepted overlap helper holds scheduling locks
and never writes business effects.

The lifecycle requires a real original FAIL with two accepted orders, two
reservations, stock minus one and target-persisted overlap. A no-fix replay
under the same workload must FAIL again. After the legitimate mode PUT,
replay uses the original reproduction ID and exact snapshot row/hash, with
new execution/evidence/evaluation identities. The target must persist one
accepted order, one reservation of one unit and stock zero, with one
ACCEPTED and one INTENT_ALREADY_ACCEPTED processing outcome. Both current
business evaluations independently PASS, findings are empty, evidence
integrity verifies and the report exits zero.

The test compares the original complete execution/evidence/analysis row
sets and exact report bytes before/after replay. It checks independent
current pointers and proof generations against each run's C/P/D truth
watermark, verifies captured effective configuration and actual target
attempt configuration, and asserts FAIL→PASS/count changes in the CLI and
in-process comparison. It scans reports, captured historical row sets and
process logs for credential canaries.

The complete Commerce/Fintech run passed 16/16 tests. The three new
amendment tests also passed in shuffled order with seed `18027` on the
already loaded Control database. The following proof is from that passing
shuffled execution, exported by the test and checked against durable rows:

| Identity | Observed value |
| --- | --- |
| Original reproduction passed to replay | `2fd25d14-2453-4a33-b761-44a2556c1db7` |
| Original run | `ad66b788-2e04-43f8-b3cc-09930e95020e` |
| Fixed replay run | `b65316e8-c126-42f4-aace-5658df1c18ee` |
| Snapshot row on BOTH runs | `61a6a100-fe35-48ae-b1bb-dda209351cd6` |
| Exact snapshot content hash on BOTH runs | `79e253586db1a23f6f5b7a3b1e4b03f8e7b57233ed74f85ee9377e44e1a1da18` |
| Target instance on BOTH runs | `08992b0c-edf1-44ac-9489-11c07d8ea8b7` |
| Processing configuration | VULNERABLE revision `2` → SECURE revision `3` |

| Durable/observed outcome | Original | Post-fix replay |
| --- | --- | --- |
| Run state | COMPLETED | COMPLETED |
| Accepted orders | 2 | 1 |
| Accepted reservations | 2 | 1 |
| Remaining stock | −1 | 0 |
| INV-CHK-1 | FAIL | PASS |
| INV-INV-1 | FAIL | PASS |
| Findings | 2 | 0 |
| Raw observations / verified chain count | 16 / 16 | 16 / 16 |
| Report exit | 1 | 0 |

Original chain head: `3c78a9bad227f42dc151b85bcbb83b2325cedc3f3f3ff3c26a1eacd8fcadc6d5`.
Replay chain head: `41d0cee5cafd179db124e61544eb1553fd4c77d23d738292de433a8933e76450`.
The chain heads differ, and each durable head's verified hash/count agrees
with that run's own current head/count.

Original historical frame SHA-256: `d3d8efb50555cc4f12f9d41740f59df1e47e472e431733180d80fecf381dc88e`.
The independently reloaded post-replay frame hash is exactly
`d3d8efb50555cc4f12f9d41740f59df1e47e472e431733180d80fecf381dc88e`.
The equality covers the original run/snapshot, steps/invocations, raw and
normalized evidence, causal edges, evaluation batches/rows, finding proof
references, timeline/derivation records, reproduction, current pointers,
eligibility proofs and truth-input/integrity heads. The test also checks
original report byte equality before fixture cleanup.

The INV-CHK-1 evaluation IDs are `17ddc4f9-9dbf-4a07-a76c-e9bf49137dc2`
and `1f80d784-6d86-4eaa-8286-ee38a8472ff6`; the INV-INV-1 IDs are
`139c8066-0093-4f2b-91c3-f6cffc4503c5` and
`85bb9096-03ef-4d82-b877-a80143ee8281`. The comparison exposes
2→1 independently persisted counts for both subjects, distinct evidence-set
hashes and the FAIL→PASS transitions. The original reproduction's FAIL
expectations remain unchanged and deliberately mismatch the fixed report;
the separate post-fix assertion requires PASS.

Generated local artifact (ignored by Git):
`.artifacts/phase18/phase18-proof-b65316e8-c126-42f4-aace-5658df1c18ee.json`.
It records these actual identities, chain heads, history hashes and
comparison/evaluation references. To reproduce an artifact from a fresh
execution:

```powershell
$env:RUPTUREGRID_TEST_ARTIFACT_DIR = Join-Path (Get-Location) '.artifacts/phase18'
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-replay-commerce.test.ts -t 'Phase 18 approved mode-preserving amendment' --sequence.shuffle --sequence.seed 18027
```

## 4. Security/refusal coverage and credential limitation

Permanent refusal tests cover malformed/unknown reproduction IDs, revoked
grants, changed target binding, unauthorized origin, production binding,
content/hash tampering, missing/unsupported invariant registry version,
cross-intent comparison, failed setup, and response-loss ambiguity. Corrupt
intent fixtures are new snapshot rows, never edits to the genuine failure's
history. Refused creation checks assert unchanged run/step/observation
counts and target request records. Failed setup records the honest
INDETERMINATE mutating invocation with no checkout delivery and no retry.

Existing reference/registration/current-grant checks, destination controls,
production denial, server limits, redaction, ownership/fencing and
conservative ambiguity handling remain in force. No platform fingerprint
key, fingerprint snapshot block, missing-baseline replay ban or retroactive
reproduction invalidation was introduced.

**Known limitation, explicitly deferred by the owner:** changed secret
values behind an unchanged authorized reference are not fingerprint
detected. Missing runtime values fail pre-send, and revoked/missing
authorization fails the existing checks. This report does not describe a
grant-revocation test as proof of secret-value rotation detection.

## 5. Verification ledger and diagnosed failures

| Gate | Observed result |
| --- | --- |
| Infrastructure | Docker Desktop was stopped. Started it, then brought up the project's four healthy PostgreSQL/Redis services. Existing orphan containers were left untouched. |
| Migrations | `pnpm db:migrate` passed; Control/Fintech had no pending migrations and Commerce applied `20261016_phase18_processing_provenance`. Fresh Commerce test databases also apply all three target migrations. |
| Focused unit tests | Initial CLI/comparison run passed 29 tests; subsequent full unit run includes the added documentation regression. |
| Full unit tests | `pnpm test:unit` with local TCP access: **760/760 passed, 60 files**, exit 0. |
| Test-source typecheck | `pnpm exec tsc -p tsconfig.checks.json --noEmit` passed after correcting test-model/type errors. |
| Initial three-suite integration batch | 38 passed, one newly added test failed; unchanged Phase 17 CLI and Phase 18 Fintech files passed. The failure was the expanded history query described below, not a changed expected business verdict. |
| Corrected final-build Phase 18 suites | Commerce **11/11**, Fintech **5/5**, both files passed. |
| Shuffled amendment tests | **3/3 passed**, eight unrelated file tests filtered out, seed `18027`; real proof artifact exported and canary-scanned. |
| Unchanged Phase 17 safety suites | **144/144 passed across 10 files**, covering eligibility/coverage, composite truth watermarks, publication, authorization and worker/stale-writer handling. |
| Unchanged Phase 17 CLI suite | **23/23 passed**, including the original vulnerable FAIL, secure PASS and response-loss INDETERMINATE/no-retry lifecycle. Combined Phase 17 coverage: **167/167 across 11 unchanged files**. |
| Evidence/domain integration group | **91/91 passed across seven files**: forensics, snapshot immutability, target manifests, generic invariants, Commerce domain, evidence capture and evidence invariants. The eighth file's initial registration collision and isolated recovery are recorded below. |
| Remaining isolated integration files | **143/143 passed across 21 files**, including Phase 14 (12), execution/ownership/queues, golden Incident Zero, controlled faults, database/API/target health, Redis-outage recovery, worker startup, web and both real-browser suites. |
| Complete integration coverage | **417/417 tests across all 41 integration files passed**, assembled from serial groups/file executions using the existing integration configuration. The shuffled three-test repeat is additional and excluded from this total. |
| Full typecheck | `pnpm typecheck` passed, including all packages/apps and both test/UI check programs. |
| Build | `pnpm build` passed on the final production source, including generated clients and the Next.js production build. |
| Format/lint | `pnpm format:check` and `pnpm lint` passed. |
| Schema agreement | Read-only Commerce `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`: no difference detected, exit 0. |
| Incident Zero standalone verifier | `node packages/incident-zero/dist/cli.js --json`: exit 0; five frozen-intent, 25 VULNERABLE and 21 SECURE assertions passed. Generated admin-credential canary scanned: zero leaks. |
| Controlled Faults standalone verifier | `node packages/controlled-faults/dist/cli.js --json`: exit 0; PRE_MUTATION_REJECTION twice (18 assertions each), RESPONSE_LOSS twice (22 each); all 80 assertions passed, no live unexpired armed plan remained. |
| Security/canary checks | Existing destination/grant/production/fencing/ambiguity suites passed; the new lifecycle's reports, historical rows and process output passed credential-canary checks. Incident Zero additionally scanned durable evidence stores and child output; the local verifier driver also checked its captured output before artifact persistence. |
| Final repository checks | `git diff --check` passed, staging remained empty, and HEAD/accepted-tag identity plus all 61 protected-file hashes were unchanged. No Phase 19 work or Git writes performed. |

The initial groups ran on the already loaded Control database, as did the
complete Phase 18 suites and shuffled amendment tests. The final 21-file
verification driver gave target-registering files fresh disposable Control
databases, deployed all nine existing Control migrations through Prisma,
used unique queue prefixes, and dropped only its own databases afterward.
The database-name conformance test used the configured main database.
No registration was deleted or security check weakened to resolve a port
collision. The original same-snapshot proof remains in the main database.
This verifies complete integration coverage; it is not a claim that a
single monolithic `pnpm test:integration` process passed on the loaded
database.

The executable commands above used the production output from the passing
full `pnpm build`; they ran serially after integration coverage. The wrapper
scripts' redundant rebuilds were not rerun or claimed. Safe JSON output is
retained locally in `.artifacts/phase18-incident-zero-verifier.json` and
`.artifacts/phase18-controlled-faults-verifier.json` (ignored by Git).
The Incident Zero runs are `e4037962-7866-466d-87ce-c84b56c6a6f2`
(VULNERABLE) and `65806fca-7698-4da6-82ce-a4cdca6ae221` (SECURE).
All four infrastructure services were healthy after the outage test and
the verifier gates.

Initial failures and repairs are retained explicitly:

1. New test calls omitted `run`'s required `--timeout` flag. The CLI
   correctly refused before creating a run; the overlap helper waited for a
   setup that never happened. Added authoritative validation/CLI failure
   diagnostics and corrected the invocation. Two initial attempts exposed
   the same input error; no production security or concurrency rule was
   weakened.
2. The genuine fixed execution then PASSed, but comparison returned null
   for its checkout effect count. Inspection of the accepted evaluator and
   actual durable PASS details identified its complete `observedCount`
   shape. Corrected only the comparison reader and added a unit regression;
   no evaluator result was changed.
3. Test-source typing caught an exact-optional-property mismatch and the
   actual `Finding.evidenceRefs` relation name. Corrected both. Expanding
   the historical preservation frame subsequently used `runId` directly on
   stale-writer events; runtime validation rejected it. Corrected the query
   to select through `stepRun.runId`; the expanded test-source typecheck
   passed afterward.
4. A full unit attempt in the default sandbox reported failures in
   unchanged socket tests. A direct loopback HTTP probe returned EACCES.
   Stopped that environment-invalid attempt without claiming a full test
   count, then ran the suite with local TCP access: 760/760 passed. No
   socket assertion was removed or mocked.
5. Format checks during active test editing identified unformatted new
   test lines. Applied Prettier to the changed code. Markdown is deliberately
   ignored by the repository's formatter; architecture prose is maintained
   manually, and a successful formatter command is not Markdown layout QA.
6. The evidence/domain integration batch passed seven files (91 tests),
   but Phase 14's setup refused an ephemeral origin already registered on
   the loaded database (`http://127.0.0.1:49677`); its 12 tests were skipped
   after that beforeAll failure. The refusal was legitimate. Running the
   unchanged file against a newly migrated disposable Control database
   passed all 12 tests. The remaining target-registering files then used
   the same isolated fixture strategy. Neither old registrations nor
   destination-authorization checks were changed.

## 6. Exact amendment files and preservation

Relative to the 450-file starting working tree, this amendment modifies
19 files and adds four; it deletes none. SHA-256 verification found all
61 selected historical reports, existing migrations, golden scenario
documents and Phase 17 test files unchanged, including the architectural
resolution report and original Phase 18 self-audit. HEAD and the dereferenced
accepted tag remain `eb95c157824f8990be609311a18c668e52ec2b76`.

- Modified: `apps/demo-commerce/src/admin-service.ts`
- Modified: `apps/demo-commerce/src/app.ts`
- Modified: `docs/checkout-zero.md`
- Modified: `docs/cli.md`
- Modified: `docs/decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md`
- Modified: `docs/external-ci-recipe.md`
- Modified: `docs/incident-replay.md`
- Modified: `docs/phase-roadmap.md`
- Modified: `packages/cli/src/cli.ts`
- Modified: `packages/cli/src/expectations.ts`
- Modified: `packages/cli/src/orchestrator.ts`
- Modified: `packages/cli/src/replay-command.test.ts`
- Modified: `packages/commerce-db/prisma/schema.prisma`
- Modified: `packages/commerce-db/src/checkout-core.ts`
- Modified: `packages/engine/src/replay.ts`
- Modified: `packages/forensics/src/replay-comparison.ts`
- Modified: `tests/integration/helpers/commerce-db-provision.ts`
- Modified: `tests/integration/phase18-replay-commerce.test.ts`
- Modified: `tests/integration/phase18-replay-fintech.test.ts`
- Added: `docs/reports/phase-18-amendment-implementation-verification.md`
- Added: `packages/cli/scenarios/checkout-zero-post-fix.scenario.json`
- Added: `packages/commerce-db/prisma/migrations/20261016_phase18_processing_provenance/migration.sql`
- Added: `packages/forensics/src/replay-comparison.test.ts`

No Git staging, commit, tag or push is authorized or performed in this
repository. Phase 19 has not started.

## 7. Remaining risks and audit boundary

Processing mode is target-wide. Stable per-run configuration evidence and
controlled overlap establish this scoped lifecycle; they do not prove
universal causal isolation or correctness under every workload. A live
target reset legitimately removes the prior business context; the
original captured Control Plane evidence is the historical record. The
throwaway target database is dropped on test teardown, while Control Plane
evidence remains durable.

Architectural direction approval and successful local checks do not accept
Phase 18. Independent re-audit must rerun the real lifecycle and inspect its
durable proof. No implementation or local-verification blocker remains for
the approved subset. Secret-value rotation detection remains the explicit
deferred architectural limitation described above; no fingerprint
mechanism was needed to implement or verify the lifecycle.

**Final verdict: READY FOR INDEPENDENT PHASE 18 RE-AUDIT.**
