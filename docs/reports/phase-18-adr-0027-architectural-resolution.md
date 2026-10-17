# PHASE 18 — ADR-0027 ARCHITECTURAL RESOLUTION

Date: 2026-10-16 (Asia/Karachi). Status: **RESOLUTION READY FOR APPROVAL — design only.**

**Recommendation:** approve a narrowly scoped Phase 18 amendment that adds a Commerce context-reset API which preserves processing configuration, plus a new lifecycle scenario using that API. Discover a new, real failure with this scenario; remediate the target through its existing mode API; replay that failure's reproduction ID from exactly the same stored snapshot. Keep the existing mode-pinned golden scenarios and historical snapshots unchanged.

Reject ADR-0027 Decision 1. Replace Decision 2's future-phase deferral and operator override with the concrete additive design below. No mode override, snapshot rewriting, different-hash substitution, or automatic fix-verification service is needed.

This report proposes changes; it does not accept ADR-0027, approve implementation, or accept Phase 18. Existing implementation and audit results are distinguished from work observed during this review.

## A. Verified contradiction and source references

### Repository baseline observed in this session

- Branch: `main`; HEAD: `eb95c157824f8990be609311a18c668e52ec2b76`.
- Dereferencing the annotated `phase-17-accepted` tag resolves to that same commit. The raw tag-object ID is a different identity and must not be mistaken for the tagged commit.
- Initial working tree: six modified tracked files and nine untracked files; staging empty. The builder self-audit's headings say 14 files, but its enumerated additions contain nine files, making 15 total. This discrepancy does not authorize editing that historical report.
- The supplied CI success and independent auditor execution are prior evidence reported by the user. This review did not re-run that CI or the infrastructure suites.

### Contradiction traced through the code

| Contract or implementation | Source at review time | Consequence |
| --- | --- | --- |
| Mandatory lifecycle ends in same-snapshot replay PASS | [phase-roadmap.md](../phase-roadmap.md), lines 252–262, especially 258 | FAIL reproduction plus different-hash secure verification does not meet acceptance. |
| Replay means a new run from the stored hash-pinned snapshot | [ADR-0010](../decisions/ADR-0010-run-snapshots.md), lines 9–13; [ADR-0019](../decisions/ADR-0019-headless-cli-report-envelope-replay-lifecycle.md), Decision 4; [incident-replay.md](../incident-replay.md), lines 23–36 | Step bodies are preserved along with all other execution intent. |
| The golden vulnerable setup includes `mode: VULNERABLE` | [vulnerable scenario](../../packages/cli/scenarios/checkout-zero-vulnerable.scenario.json), `experiment.steps[0].action.body` | The mode setter is part of this particular experiment's intent. |
| The setup route requires mode | [app.ts](../../apps/demo-commerce/src/app.ts), lines 93–134, especially 114–119 | Omitting mode from the old endpoint is not a working solution. |
| Initialization resets rows, advances generation, re-baselines SKU, and writes mode in one transaction | [checkout-core.ts](../../packages/commerce-db/src/checkout-core.ts), lines 94–167, especially 127–156 | Replay reinstates VULNERABLE after an operator switched to SECURE. |
| Legitimate remediation writes target-owned configuration | [app.ts](../../apps/demo-commerce/src/app.ts), lines 140–153; [checkout-core.ts](../../packages/commerce-db/src/checkout-core.ts), lines 179–188 | `PUT /demo/admin/mode` is the existing fix interface, but old setup undoes it. |
| Actual dispatch selects a real business implementation from mode | [checkout-core.ts](../../packages/commerce-db/src/checkout-core.ts), lines 230 and 328–343 | Mode selects naive reservation or intent-scoped idempotent reservation; it is not an evaluator verdict. |
| Reproduction's required mode is extracted from frozen request bodies | [reproduction.ts](../../packages/forensics/src/reproduction.ts), lines 90–118 and 241–248 | A golden vulnerable reproduction remains VULNERABLE; it cannot be reinterpreted as mode-neutral. |
| Replay reuses the existing snapshot row | [replay.ts](../../packages/engine/src/replay.ts), lines 249–305; [orchestrator.ts](../../packages/cli/src/orchestrator.ts), lines 477–514 | Preserve this implementation; the defect is the demonstration contract's coupling to mode-setting setup. |
| Existing Commerce test honestly uses a different secure scenario | [phase18-replay-commerce.test.ts](../../tests/integration/phase18-replay-commerce.test.ts), lines 465–587 and 671–724 | Current assertions establish FAIL→FAIL under one hash, then PASS under a different hash. |

The precise contradiction is **remediation cannot survive this setup contract**. It is too strong to claim that every vulnerable execution must fail regardless of scheduling: the naive race can avoid oversell if requests serialize. The accepted [deterministic overlap helper](../../tests/integration/helpers/deterministic-oversell.ts), lines 5–16, explicitly records that possibility. An accidental vulnerable PASS cannot prove a fix. The new lifecycle must establish real overlap, repeat the no-fix control, and prove the effective processing configuration.

Two documentation discrepancies also matter. [incident-replay.md](../incident-replay.md), lines 15, 43 and 67, currently treats required processing mode as universal. That needs an explicit amendment for the new scenario. [ADR-0026](../decisions/ADR-0026-run-owned-evaluation-eligibility.md), lines 5–7, still says PROPOSED and Phase 17 uncommitted, despite the accepted Phase 17 baseline and implemented pointer/proof schema. Preserve its implemented guarantees; an authorized administrative addendum should reconcile that stale status without pretending this reviewer supplied its historical approval.

## B. Candidate solutions and why alternatives fail

| Candidate | Decision |
| --- | --- |
| ADR-0027 Decision 1: same-hash FAIL reproduction plus different-hash secure PASS | **Reject as acceptance resolution.** Both observations remain useful and honest, but the mandatory same-snapshot transition is missing. |
| Modify the historical snapshot or skip its mode setter during replay | **Reject.** Changes executed intent while claiming the old hash. |
| Patch the implementation behind the VULNERABLE label to become secure | **Reject for this demo target.** Removes the specified failure fixture and breaks the frozen VULNERABLE⇒FAIL golden contract. A real third-party deployment may fix implementation without changing stimulus, but that does not authorize changing this target's golden semantics. |
| Switch mode after the replay's vulnerable setup | **Reject.** An intervention during execution is required to defeat the frozen mode setter; unattended replay cannot reproduce the stated precondition. |
| Remove all setup and reset the target outside the run | **Reject.** Loses the fenced setup-response anchor required by ADR-0026 and weakens run-owned scope proof. |
| Make mode optional on the old setup endpoint, silently defaulting to live mode | **Do not select.** Technically possible as an explicitly approved extension, but it changes the existing endpoint's validation contract and risks omitted-mode mistakes. A separate endpoint isolates the new semantics and leaves old request validation intact. |
| Broad new replay mode, mutable snapshot fields, per-replay mode override, or new fix service | **Reject as unnecessary scope.** The executor already replays ordinary HTTP intent; target configuration can be observed without becoming replay input. |
| Defer the structural resolution to Phase 19 | **Reject.** Phase 19 depends on accepted Phase 18. |
| Add mode-preserving context setup and a new same-hash lifecycle | **Select.** Changes the target's setup surface additively, reuses the existing replay/evaluation machinery, and preserves old golden experiments. |

The new scenario establishes a **new lifecycle**, not a repaired identity for any old vulnerable snapshot. Its first failure and its own post-fix replay share one hash. Neither shares the old golden snapshot's hash by assertion or by design.

## C. Recommended architecture

### C1. Keep intent frozen; classify mode according to what the experiment actually declares

| Dimension | Existing golden scenarios | New Phase 18 lifecycle scenario |
| --- | --- | --- |
| Mode-setting request body | Frozen VULNERABLE or SECURE; immutable experiment intent | Absent; no step sets processing mode |
| Business stimulus | Frozen setup, payload, two repeats, concurrency two, timeouts, retry policy, invariant bindings and subjects | Equally frozen; same values on original and replay |
| Processing behavior | Required by the frozen setter | External target-owned precondition, observed separately on every execution |
| `targetModeRequirement` | Existing VULNERABLE/SECURE value | `null`: no required mode declared; never inferred from the first observed mode |
| Observed scope generation | Fresh per run, outside intent hash | Same ADR-0026 rule; fresh per run, outside intent hash |
| Post-fix expectation | Golden secure run remains its own experiment | Test asserts PASS after remediation; original reproduction's FAIL expectations remain unchanged |

The endpoint path and mode-preserving semantics are themselves frozen stimulus. The processing mode actually observed at execution is evidence. This distinction is a documented target contract, not permission to exclude arbitrary snapshot fields from hashing.

### C2. Add a separate target-owned setup endpoint

Proposed path: authenticated `POST /demo/admin/scenario-context`. This is a **new** endpoint; it does not exist in the inspected tree.

Request body has exactly `scopeToken`, `sku`, and `initialAvailableUnits`, using the existing identifier bounds and safe-integer checks. Reject `mode`, unknown keys, malformed values, and an SKU currently owned by a different scope. Require existing initialized processing settings; do not silently create a default mode.

In one target-owned transaction: lock/read the settings row without changing its configuration; advance the requested scope generation; clear only that scope's business rows; create or re-baseline its SKU; return the committed scope/generation/baseline and observed processing configuration. Preserve the existing reset endpoint's required mode, atomicity, response meanings, and golden behavior. Share a private reset primitive only if equivalence is proven; do not refactor the reservation algorithms.

The new response retains `verificationScopeId`, `generationId`, `sku`, and `initialAvailableUnits` so the unchanged ADR-0026 anchor procedure still works. Use `verificationScopeId`, not a token-named field, for persisted anchor authority: [app.ts](../../apps/demo-commerce/src/app.ts), lines 121–133, documents the redaction boundary.

### C3. Record configuration actually used, including changes within a run

Add a target-owned migration with:

- `CommerceSettings.processingRevision`: monotone `bigint`, initially zero for the newly introduced counter, incremented on **every successful explicit mode-setting operation**, including setting the same mode. Both the existing reset-and-mode endpoint and the mode API must use this writer rule. It is not a reconstructed historical deployment count.
- `CommerceSettings.targetInstanceId`: generated UUID identifying this target database installation, stable across setup, mode switches, and process restarts. It is observed identity, not an authorization capability or a proof against a malicious database clone.
- Nullable `ProcessingAttempt.processingModeUsed`, `processingRevisionUsed`, and `targetInstanceIdUsed`. Historical rows stay null; no invented backfill of past behavior.

At submission, read one coherent settings tuple and persist that exact tuple on the processing attempt. Dispatch the naive/idempotent branch from that same captured mode value. Do not read the settings again to choose a different branch, or fill inspection fields from current settings later. This preserves the existing reservation algorithms and their concurrency semantics.

Return those facts from the existing processing-attempt inspection surface, and configuration identity from setup and authenticated status responses. Encode revision as a bounded canonical decimal string, never a lossy JavaScript Number. The existing complete inspection response is already captured as raw evidence; these diagnostic fields need not become new invariant fields or manifest capabilities.

The new scenario contains ordinary authenticated GET status steps before setup and after submissions. Their identical frozen requests can return different true observations on original and replay. Raw invocation responses and inspection bodies are persisted through the existing redaction and chain append paths. No special evidence importer is necessary.

### C4. Preserve business truth and distinguish it from remediation attribution

The two existing generic invariants continue to decide business PASS/FAIL/NOT_EVALUABLE using orders, reservations, scope, baseline, completeness and attribution. They never read mode labels or expected verdicts to decide business truth.

The committed lifecycle test separately requires coherent configuration evidence: same target instance across the pair; one stable processing revision within each execution; all submitted processing attempts agree with setup/status; original mode VULNERABLE; replay mode SECURE; the revision transition matches the observed mode-API operation. Missing, conflicting, redacted or truncated configuration evidence fails the lifecycle assertion. A real business PASS may still be reported honestly, but cannot establish successful remediation when this additional proof is missing.

This does not introduce an automatic fix-verification service (Phase 18 non-scope). `compare` remains a read-only investigation view. A successful compare command means it produced a permitted comparison, not that a target fix succeeded.

### C5. Preserve replay implementation and correct its comparison explanation

Reuse `createRunFromSnapshot`, dispatch, bounded durable polling, generic capture, analysis, forensics, chain verification, Boundary B authorization, reporting, and five-way exit classification. Do not re-freeze the scenario during replay.

Retain same-hash refusal for cross-intent pairs. Compare each subject without collapsing FAIL into PASS; display independently persisted effect counts and findings. Correct [replay-comparison.ts](../../packages/forensics/src/replay-comparison.ts)'s `REPLAY_SCHEDULING_NOTE`: a same-hash verdict change can reflect a legitimate target fix, as incident-replay §6 requires. It is not by itself proof of scheduling luck. Exact interleavings remain unpromised, and comparison alone cannot establish the cause of a difference.

## D. Exact contract and ADR implications

Approval must authorize an **in-place Phase 18 architecture amendment**, not a future phase and not retroactive Phase 17 acceptance work.

| Contract | Exact proposed disposition |
| --- | --- |
| ADR-0027 Decision 1 | Explicitly reject as sufficient Phase 18 acceptance. Preserve the record of why it was proposed. |
| ADR-0027 Decision 2 | Replace with C1–C5 and the security closure in F. Remove future-phase prerequisite and operator mode override. Keep PROPOSED until the authorized architectural approver records approval. |
| incident-replay §§1, 4, 8 | Qualify mode binding: explicitly declared mode remains frozen; scenarios with mode-preserving setup have no required mode, observe the target's current behavior, and may demonstrate post-fix changes. Wrong **declared** mode still fails; absence is not an implicit override. |
| checkout-zero §4, particularly line 66 | Preserve the original parameterized golden setup verbatim as its existing contract; add a separately named Phase 18 lifecycle variant and endpoint with mode-preserving setup. Sections 3, 5, 6, and 7 keep their identity, invariant, golden-matrix, and ambiguity semantics. |
| ADR-0020 Decision 2 | Add a Phase 18 companion-lifecycle note. Two declared concurrent submissions, one unit, real target effects, VULNERABLE/SECURE implementations, and the golden matrix remain unchanged. |
| Phase 18 roadmap | Add the narrow target setup/provenance amendment to scope and deliverables. Keep the exact same-snapshot FAIL→fix→replay→PASS acceptance and independent-audit exit criterion. Both-domain regression requirements remain. |
| ADR-0010 | Core intent/hash/storage/new-run rules remain. Specify forward-only optional fingerprint metadata for newly replay-eligible snapshots, implementing its existing fingerprint requirement; old documents/hashes remain unchanged. |
| ADR-0012, ADR-0024 | Record the bounded fingerprint-preflight clarification in F: only trusted credential resolution computes a non-secret comparison value; raw values never reach snapshot builders. Frozen reference selection and server-owned grants remain. Clarify new replay authorization versus continued execution of an existing frozen run. |
| ADR-0019 | Preserve five-way exits and report/v1. Clarify original reproduction expectations versus post-fix assertions, and reject unsupported comparison versions rather than silently coercing them. |
| ADR-0026 §§3–13, 24–25 | No semantic amendment to anchors, eligibility, coverage, fencing, C/P/D, publication, or authorization. New generation and configuration observations remain per-run evidence. Reconcile its stale status separately with the recorded Phase 17 approval authority. |

No constitution rule, money representation, target database ownership rule, invariant registry, report schema, generic inspection path interpolation rule, release policy, or Phase 19 scope needs relaxation. No accepted migration or historical report is edited. Living-contract additions must cite the approved amendment and distinguish old from new behavior.

## E. Concrete same-snapshot FAIL→PASS execution design

Create a new committed scenario, proposed filename `packages/cli/scenarios/checkout-zero-post-fix.scenario.json`, with:

1. `observe-before`: authenticated GET `/demo/admin/status`; read-only, one invocation, retry NONE.
2. `establish-scenario`: authenticated POST `/demo/admin/scenario-context`, body containing only the scope, SKU, and initial units `1`; one invocation, concurrency one, retry NONE.
3. `checkout-submit`: existing signed checkout body, total `"500000"` minor units and currency `"PKR"`; repeat two, concurrency two, retry NONE.
4. `observe-after`: same authenticated status GET, read-only, one invocation, retry NONE.

Copy the existing two invariant bindings and `runScope/v1` structure into this new file. Keep the setup name and top-level anchor field names compatible. Use separate lifecycle scope/SKU names so ordinary golden runs do not erase the lifecycle's target context accidentally. A suite may rebind names once before the first freeze; it must not regenerate names or modify the file before replay.

Before discovery, use the target's mode API to establish VULNERABLE. Execute the new scenario with controlled real overlap. Persist its FAIL, findings, reproduction ID `R`, snapshot row `S` and full hash `H`.

Complete and certify the original report, then capture its historical row sets. With no requests in flight, issue exactly one successful `PUT /demo/admin/mode` with `{"mode":"SECURE"}` through the authenticated target API. Save its actual response as a test artifact and confirm the read-back configuration. The API response must carry the instance ID and applied revision; no test assigns a fabricated revision.

Invoke `replay --reproduction R`. The replay's status and context-reset requests observe SECURE and do not set mode. The replay creates fresh run/step/invocation/evidence/evaluation identities and references **the same S and H**. The context reset creates a fresh observed generation and clean business context. Two real concurrent submissions now traverse the target's unchanged idempotent implementation. Independent complete inspection establishes one accepted order, one reservation of one unit, remaining zero; both invariants PASS.

Compare original and replay. Require H equality, identical binding/version domain, CHK FAIL→PASS, INV FAIL→PASS, recorded counts 2→1, original findings retained and no replay findings. `agree: false` and `verdictsDiffer: true` are the expected successful comparison content for this lifecycle. Compare exit zero does not replace these assertions.

The original reproduction continues to contain its original FAIL expectations. Applying those exact-intent expectations to the fixed replay must report a mismatch; a separate committed post-fix assertion requires all eligible subjects PASS. Neither changes classification, history, or snapshot content.

## F. Security and historical-evidence preservation proof

### Ownership, credentials, destinations and versions

The runner's writes to the target remain authenticated HTTP calls. Inspection remains read-only, complete-collection, literal-path inspection. Only the target writes Commerce PostgreSQL. Test-only database access may read target rows and hold scheduling locks as the already accepted helper does; it must not insert, delete, repair, or alter business effects. Provisioning/migrations occur through the target's own application deployment workflow.

Current replay code rechecks frozen refs against registration and current grants ([replay.ts](../../packages/engine/src/replay.ts), lines 167–188), but explicitly does **not** detect changed values behind an unchanged reference (lines 25–32). This is a real mismatch with ADR-0010 line 13, ADR-0019 Decision 4, incident-replay lines 16/25/44/66, and the Phase 18 credential-rotation acceptance. Revoking a grant is not a value-rotation test. Do not accept the proposed ADR's claim that an honesty note alone closes this contract.

**Required bounded security repair before acceptance:** add a versioned fingerprint block to newly replay-eligible snapshot JSON at the first freeze. No Control DB column or migration is required for this JSON extension. A trusted credential-resolver preflight computes fingerprints and passes **only fingerprints** to the pure snapshot builder. This explicitly extends ADR-0012's request-time-only wording to include trusted pre-execution fingerprinting; raw values remain confined to that resolver and are never passed to the scenario, snapshot builder, report, or AI.

Use a platform-owned HMAC-SHA256 key from validated environment configuration, independent of target credentials and unavailable to scenario/manifest input. Freeze public algorithm/key-version identifiers and one digest per frozen target credential reference. Bind the digest transcript unambiguously to domain `rupturegrid-credential/v1`, target ID, normalized origin, reference name and exact secret bytes. Use length-delimited or canonical encoding; compare digests in constant time. This avoids publishing an unkeyed password-checking oracle for weak admin tokens. Never publish the HMAC key or target secret. No new dependency is needed; verify official runtime API documentation at implementation time under R-20.

At replay preflight, require all frozen refs to be registered, currently granted, resolvable, and fingerprint-equal before creating a run or contacting the target. The trusted executor also compares its own resolved values immediately before use, so a separate worker environment cannot silently use different secrets; use that same resolved byte value for the physical request. Initial CLI discovery freezes these bindings before execution. Existing direct legacy run creation may remain available without the optional block, but a credentialed reproduction without an original fingerprint baseline is **not replay-authorized**: refuse explicitly; do not backfill history from today's secret. Credential-free snapshots need no fingerprint entries. A changed/missing fingerprint key also fails closed, with no override. Rotation is still usable for new experiments with new snapshots, never silently for the old reproduction.

This is an explicit compatibility restriction on previously unaccepted Phase 18 replay, not a rewrite of Phase 17 run semantics. Include it in the approval decision. New Commerce discovery and replay tests have a baseline; old credentialed snapshots remain readable and comparable, and their reports remain historical evidence.

Other required fail-closed checks, without changing the authorization model:

- Recompute canonical snapshot content hash and require equality to stored hash and reproduction binding. Comparing two stored hash strings alone does not detect changed JSON under an old hash. Validate canonicalization identifier and shape; do not repair a corrupt snapshot.
- Require the reproduction's original run to reference the same snapshot row and hash as the reproduction itself; checking reproduction-to-snapshot hash alone is not a complete run binding check.
- Check current registration identity, registered origin, contract kind, and environment against the frozen binding. In particular, deny a live production/unknown environment or classification mismatch; the current replay environment check reads the frozen environment, not a live-environment equality check ([replay.ts](../../packages/engine/src/replay.ts), lines 142–165).
- Preserve the existing executor's URL parsing, origin, address resolution/pinning, scheme, redirect, credentials and blast-radius controls on every request. The new setup endpoint obtains no destination override. A registration/grant change after replay validation does not authorize a new destination or new credential reference. Existing frozen-run grant semantics in ADR-0024 §16 remain explicit; do not claim continuous revocation checking that the executor does not perform.
- Validate frozen `engineVersion` against the supported execution implementation, plus the original reproduction's evaluator versions and actually used normalizer versions against available implementations. Current replay checks generic kind/registry version only ([replay.ts](../../packages/engine/src/replay.ts), lines 191–223). Registry availability is not proof of engine/evaluator/normalizer compatibility. Reject unknown versions, missing required version provenance, or absent declared successors; do not select current defaults silently. Compare must refuse cross-authoritative-version pairs per ADR-0026 §24.

These are acceptance closure obligations exposed by inspection, not claims of additional exploited vulnerabilities or a broad security audit. They must have focused tests; the amendment must not conceal them behind the main lifecycle repair.

### Separate runs and preserve historical authority

The old and new runs share intent identity, not execution identity. Each has independent setup generation, request attempts, processing attempts, effects, raw chain, evaluations, findings, eligibility proof and current pointers. Eligibility still uses exact declared subject plus observed scope/generation equality, with terminal-owner fenced setup provenance. Observed processing revision is not substituted for scope generation.

Same-scope reset legitimately deletes the prior target context through the target API, as the accepted golden reset already does. It does **not** preserve the old target database rows. Preserve the original failure's complete captured business evidence and report before resetting; prove those Control Plane/analysis rows stay identical afterward. Do not claim the old order still exists in the live target after reset.

All captured configuration and business observations enter the existing chain as class A evidence. They therefore advance C; derivations and provenance continue under the existing D/P rules. No new live target read enters report authorization, evaluation, or pointer selection. Boundary A still publishes only at the captured composite W; Boundary B still authorizes one coherent as-of W. Original reports retain their original certification point. No SQL lock is claimed to prevent an unrecorded external send.

### Prevent drift from being called a fix

Require constant target instance, stable configuration tuple within each run, same business baseline and workload, unchanged authoritative versions, independent complete evidence, and measured overlap on both sides. Require only the intentional processing transition between executions. The monotone revision detects an observed VULNERABLE→SECURE→VULNERABLE or same-label reconfiguration even when endpoint mode labels match again.

Missing attempt provenance, a changed target instance, unexpected revision change, incomplete inspection, a changed baseline, or evaluator drift must prevent the committed lifecycle assertion from passing. Business FAIL remains FAIL; insufficient business evidence remains NOT_EVALUABLE; neither is recolored to satisfy this diagnostic assertion. Target configuration claims alone never establish business success.

This proves the scoped demo remediation under controlled conditions. It does not establish universal causal isolation, third-party deployment identity, cryptographic tamper-proofing, or correctness under every schedule. A malicious target can lie about its own build identity; this is not an attestation system.

## G. Minimal files and components requiring modification after approval

The irreducible **main-blocker** delta is the additive setup API, effective-configuration provenance, new scenario, lifecycle tests, comparison explanation, and living-contract amendments. Security closure is separate but necessary to satisfy the existing acceptance wording; do not hide its cost.

| Component/files | Planned bounded change |
| --- | --- |
| `apps/demo-commerce/src/app.ts`, `admin-service.ts` | New authenticated context endpoint; additive status/setup/mode-response provenance. Preserve existing route requirements. |
| `packages/commerce-db/src/checkout-core.ts`, `index.ts` | Mode-preserving context initializer; revision-aware settings writers; capture effective tuple once per processing attempt. Reservation algorithms remain unchanged. |
| `packages/commerce-db/prisma/schema.prisma`, one **new** Commerce migration | Settings revision/instance and nullable historical attempt provenance. No Control/Commerce shared schema. |
| `apps/demo-commerce/src/inspection-service.ts` | Serialize stored per-attempt provenance, not live settings substituted onto old attempts. No invariant-specific target code. |
| New `packages/cli/scenarios/checkout-zero-post-fix.scenario.json` | Mode-preserving setup, observational status steps, existing payload/concurrency/bindings/runScope. Old scenario files untouched. |
| `tests/integration/phase18-replay-commerce.test.ts` or new focused `phase18-same-snapshot-post-fix.test.ts` | Real CLI lifecycle and durable assertions. Prefer a new self-contained test file so existing Phase 18 evidence remains reviewable. |
| New test-only lifecycle scheduling helper if required | Two queued submissions with real overlap in both target modes; reuse accepted primitives, leave the Phase 17 helper/test unchanged. |
| `packages/forensics/src/replay-comparison.ts` | Correct fix-versus-scheduling explanation; version refusals; F-1 count repair. Keep computed-on-read and per-subject truth. |
| `packages/engine/src/replay.ts`, CLI replay orchestration | Content-hash, live binding and complete version checks; fingerprint preflight; retain fresh run creation and shared pipeline. |
| `packages/engine/src/types.ts`, `snapshot.ts`, `run-create.ts`; trusted resolver and configuration modules | Optional forward fingerprint block, preflight plumbing, executor pre-send fingerprint check, platform fingerprint-key configuration. Pure canonicalizer unchanged. Existing legacy creation paths unchanged. |
| `packages/cli/src/cli.ts`, `expectations.ts`, `replay-command.test.ts`; focused new integration tests | E-1/G-1 fixes and explicit failures. Add typed errors rather than treating arbitrary DB errors as usage errors. |
| ADR-0027; living replay/checkout/roadmap/CLI/CI docs; focused ADR addenda | Approved contract text, correct schema paths, explicit lifecycle and security limits. Preserve old reports and accepted historical migration files. |

No need to modify the two generic evaluators, INV-IZ-1, Demo Fintech business core, generic manifest vocabulary, queue semantics, raw observation protocol, report/v1 schema, web UI, or Phase 17 golden scenario/test files. If implementation discovers such a need, return to this architecture gate instead of expanding scope silently.

## H. Detailed implementation sequence

1. Architectural owner records the narrow amendment approval and approved scope, including fingerprint compatibility and stale-status reconciliation. Revise ADR-0027 and living contracts first; preserve the prior proposal and rejection rationale in its decision history. Keep phase acceptance separate.
2. Record and hash the existing working tree; inspect the full baseline diff. Keep all existing uncommitted Phase 18 work. Do not stage/commit merely because architectural approval arrived; follow the separately authorized phase workflow.
3. Add the target migration and context endpoint. Test atomic reset, mode preservation, required existing settings, scope/SKU ownership, validation, authentication and revision writer behavior against real Commerce PostgreSQL.
4. Add per-attempt effective configuration capture and read-only serialization. Confirm the same captured value selects the branch. Verify that added bookkeeping neither serializes the naive reservation algorithm nor changes secure idempotency.
5. Add the new scenario. Establish a baseline failure under real controlled overlap; check actual orders/reservations and complete durable analysis before writing any success assertion.
6. Implement the bounded replay security closure in F with focused tests. Resolve secrets only inside trusted preflight/execution; never change the stored original baseline. Verify config-key errors cannot emit secret bytes.
7. Add the full same-snapshot lifecycle and no-fix/drift controls. Use the original reproduction ID, not a new scenario run, for the fixed execution. Preserve all historical row sets.
8. Correct comparison explanation/version refusal and implement E-1/F-1/G-1/D-1. Keep these reviewable as distinct repairs; no historical audit rewrite.
9. Run focused real-infrastructure tests, unchanged Phase 17 suites, all regression/security gates, and the repository's format/lint/typecheck/build checks. Record failures and exact commands. Repeat only for a changed tree or unresolved failure.
10. Review the complete diff, then obtain independent Phase 18 audit of the actual CLI lifecycle and all security refusals. Phase 18 stays unaccepted until that audit and authorized checkpoint workflow complete. Phase 19 stays closed throughout this work.

## I. Exact regression and acceptance-test plan

All items below are **planned tests, not executed results**. Commit them as rerunnable acceptance evidence after approval. A self-contained lifecycle test must execute its stages in one test/fixture, not rely on file ordering or a previous test's global variables.

### I1. Topology and commands

Use the existing Commerce throwaway-database and process harnesses, a real worker process, real TCP HTTP, Control PostgreSQL and Redis/BullMQ. Keep Commerce DB credentials out of CLI/worker environments. The test's lock observer is separate from the runtime executor. Provision a dedicated target instance for the controlled lifecycle and use one stable origin/registration within that lifecycle. Isolated test topology is hygiene; ADR-0026 anchor proof remains the source of eligibility.

After implementation and with the documented environment configured, run from the checkout:

```powershell
pnpm infra:up
pnpm db:migrate
pnpm build
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-same-snapshot-post-fix.test.ts
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase18-replay-commerce.test.ts tests/integration/phase18-replay-fintech.test.ts tests/integration/phase17-cli.test.ts
pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/phase17-c-run-owned-eligibility.test.ts tests/integration/phase17-d-report-finalization.test.ts tests/integration/snapshot-immutability.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm incident-zero:verify
pnpm controlled-faults:verify
```

The first named test file is proposed, not currently present. Add focused target-provenance and replay-security test files to these commands when implemented. `pnpm test:integration` builds and uses `tests/integration/vitest.config.ts`; it disables file parallelism because infrastructure is shared. Do not improvise a different config or run Redis-outage files in parallel with the lifecycle. A chunked full run must enumerate every file and retain every outcome; it must not be reported as a single invocation.

The current Fintech suite's two vulnerable executions call `runGoldenScenario`, not the reproduction-ID replay command ([phase18-replay-fintech.test.ts](../../tests/integration/phase18-replay-fintech.test.ts), lines 86–139). Preserve that valid same-hash golden regression evidence, but do not describe it as CLI reproduction-loading coverage. Add a focused Fintech reproduction-ID replay case using a newly fingerprinted CLI-created snapshot if making that stronger coverage claim; no Fintech mode-neutral target amendment is needed for the Commerce lifecycle acceptance.

### I2. One complete Commerce lifecycle

| Stage | Required observable and durable assertions |
| --- | --- |
| 1. Legitimate environment | Real readiness responses; registered LOCAL_DEVELOPMENT target with intended origin and refs; actual successful admin configuration to VULNERABLE. Provision SKU through the target API before any lock barrier. No business-row fixture writes. |
| 2. Immutable experiment | Validate the new scenario; freeze once. Assert no request body sets mode, request templates and `runScopeBinding` match the committed/rebound fixture, and fingerprint baseline exists for every frozen ref. Record S, full H, and canonical content. |
| 3. Genuine failure | Execute real CLI `run <scenario> --wait --report <file> --json`. Use a bounded lock barrier that observes two submit attempts blocked on real business work before release. Assert target-persisted processing intervals overlap (`A.startedAt < B.finishedAt` and converse); two distinct physical request IDs and processing IDs; two accepted order IDs, two reservations of one unit, baseline one, remaining minus one; identical intended integer-money tuple. No simulated response or synthetic effect. |
| 4. Durable FAIL/Finding | Original run COMPLETED; current authoritative pointers resolve to FAIL for both declared subjects; each has the expected finding with proof references to original observations/evaluations. Eligibility mode strict coverage, no missing/unexpected declared-domain subjects. Report validates against the actual schema, integrity verified, exit 1. Obtain R from `analysis.reproduction_definition`; require R.runId = original, R.snapshotId = S, R.snapshotContentHash = H and R.targetModeRequirement = null. |
| 5. Preserve baseline | Save full original snapshot, run, steps, invocations, raw observations ordered by chain index, normalized events, causal links, evaluations/batches, findings/proof references, timeline, reproduction, pointers, eligibility proofs and truth-input head. Save exact original report bytes. Exclude only documented mutable verifier bookkeeping if chain verification is invoked again. |
| 6. Genuine remediation | After original analysis/report completes and target is quiescent, authenticated mode PUT to SECURE succeeds exactly once. Persist actual response artifact and read-back. Require same instance ID and revision increment by one relative to original run's stable tuple. No other config writer may run during this interval. |
| 7. Original reproduction replay | Spawn real CLI `replay --reproduction R --report <new-file> --json`. Assert a new run B, new step rows, original S; snapshot row count for S unchanged, and no new snapshot for replay. Reload S and recompute canonical SHA-256 = H. Snapshot JSON and stored H byte/semantically identical to baseline. No live scenario or experiment revision reload alters execution. |
| 8. Independent execution | B's setup anchor has same scope value, a strictly newer observed generation within this scope, and B's own fenced response observation. Submit invocation IDs/request IDs differ from original, exactly two repeats and zero retry attempts. Both effective processing tuples equal SECURE at the applied revision; before/setup/after observations agree. Raw/evaluation/finding/proof identities are disjoint across runs. Never compare analysis-generation numbers across runs as an identity proof; numbers can legitimately coincide. |
| 9. Genuine PASS | Use equivalent observed overlap pressure for secure processing: one submission may block on SKU while its duplicate blocks on intent settlement. Never require two secure transactions to pass the same idempotency lock. Observe both attempt starts/lock waits before release, assert persisted overlap. Inspect exactly one accepted order, one reservation, accepted reserved units one, baseline one, remaining zero; one ACCEPTED and one INTENT_ALREADY_ACCEPTED processing result. Complete orders/reservations totals and quiescence must match that generation. Both current evaluations PASS; zero B findings; COMPLETED, verified report, exit 0. |
| 10. History unchanged | Reload every saved original row set and compare canonical serialized rows, IDs, hashes, verdicts, reasons, relationships and certifications. Original findings and FAIL pointers remain. Original report file bytes unchanged. Old target rows may have been legitimately reset; original captured evidence must not be deleted or replaced. |
| 11. Compare | Real CLI compare plus in-process compare agree on H, binding/version domain, both FAIL→PASS transitions, subject-wise counts 2→1, original findings vs none on B, separate chain references and reproduction IDs. Confirm compare performs no durable writes. Reverify each chain and its matching report certification; comparison head references alone are not integrity verification. |
| 12. Regression permanence | Repeat a no-fix replay while VULNERABLE under the same overlap protocol and require FAIL, not merely nonzero exit. Repeat secure replay of R while stable SECURE and require PASS. Each replay still references S/H and has independent effects/evidence. Use this to separate a true fixed processing path from lucky scheduling. |
| 13. Compatibility | Run unchanged Phase 17 CLI, anchor/watermark/publication, Commerce Phase 16, Incident Zero and Controlled Faults suites. Preserve golden scenario/test file bytes. Neither labels nor expected verdicts enter evaluator logic. |

The overlap helper may need an additive lifecycle-specific wrapper. Its existing broad wait count ([deterministic-oversell.ts](../../tests/integration/helpers/deterministic-oversell.ts), lines 244–268) is a starting point, not proof that the proposed secure-mode test already works. New barriers must verify relevant backend/request identity and release within real target transaction deadlines; a barrier timeout fails the test and never falls back to sleep-based overlap or reruns until green.

### I3. Exact Control DB checks

Use Prisma model names from the current schema; the following is the intended assertion shape inside the new integration test, with `originalRunId`, `replayRunId`, `reproductionId`, `beforeSnapshot`, and `originalRowSets` obtained from real execution. Import the existing `canonicalizeAndHash` implementation rather than `JSON.stringify` for snapshot hashing.

```ts
const reproduction = await prisma.reproductionDefinition.findUniqueOrThrow({
  where: { id: reproductionId },
});
const original = await prisma.experimentRun.findUniqueOrThrow({
  where: { id: originalRunId }, include: { snapshot: true },
});
const replay = await prisma.experimentRun.findUniqueOrThrow({
  where: { id: replayRunId }, include: { snapshot: true },
});
expect(replay.id).not.toBe(original.id);
expect(replay.snapshotId).toBe(original.snapshotId);
expect(replay.snapshotId).toBe(reproduction.snapshotId);
expect(replay.snapshot.contentHash).toBe(reproduction.snapshotContentHash);
expect(canonicalizeAndHash(replay.snapshot.content).hash).toBe(original.snapshot.contentHash);
expect(replay.snapshot).toEqual(beforeSnapshot);

const pointers = await prisma.currentEvaluationPointer.findMany({
  where: { runId: replayRunId }, include: { currentEvaluation: true },
});
const proofs = await prisma.runEligibilityProof.findMany({ where: { runId: replayRunId } });
const chain = await prisma.evidenceIntegrityHead.findUniqueOrThrow({
  where: { runId: replayRunId },
});
const truth = await prisma.runTruthInputHead.findUniqueOrThrow({ where: { runId: replayRunId } });
for (const pointer of pointers) {
  expect(pointer.currentEvaluation.runId).toBe(replayRunId);
  expect(pointer.integrityHeadHash).toBe(chain.headContentHash);
  expect(pointer.integrityObservationCount).toBe(chain.observationCount);
  expect(pointer.provenanceRevision).toBe(truth.provenanceRevision);
  expect(pointer.derivationGeneration).toBe(truth.derivationGeneration);
  const proof = proofs.find(p => p.invariantKey === pointer.invariantKey &&
    p.evaluatorVersion === pointer.evaluatorVersion);
  expect(proof).toBeDefined();
  expect(proof!.analysisGeneration).toBe(pointer.analysisGeneration);
  expect(proof!.integrityHeadHash).toBe(pointer.integrityHeadHash);
  expect(proof!.integrityObservationCount).toBe(pointer.integrityObservationCount);
  expect(proof!.provenanceRevision).toBe(pointer.provenanceRevision);
  expect(proof!.derivationGeneration).toBe(pointer.derivationGeneration);
}
```

These checks run at quiescence after authorized reporting; add explicit nonempty/exact domain assertions so empty pointer/proof arrays cannot pass vacuously. For this one-subject-per-key fixture require exactly the two bound current pointers, both expected subjects, the authoritative version triple, no missing/unexpected domain, and the existing treatment of disclosed unbound legacy diagnostics. Assert the original pointer domain and FAIL values independently. The replay's inspection captures must resolve to its own anchor generation; do not use `StepInvocation.responseBody` as business authority.

For historical preservation, deep-compare `originalRowSets` before/after rather than just counts or a selected verdict. For target assertions, read target-persisted rows through inspection; an independent test-side read-only SQL cross-check may join orders→intent, reservations→order/SKU and processing→request→intent. Join actual foreign keys and verify scope/generation; do not infer association from timestamps or UUID order.

### I4. Negative and adversarial matrix

| Test | Required rejection or preservation |
| --- | --- |
| Value rotates behind same authorized ref, both target and worker updated | Fingerprint mismatch before replay run creation/contact, exit 4, no new run/step/evidence/target request; catches the case a fresh credential would otherwise authenticate successfully. |
| Ref missing; grant revoked; registration ref removed; fingerprint key unavailable; old credentialed snapshot has no baseline | Explicit preflight rejection, exit 4, no new run or physical request. Never backfill or substitute another credential. |
| Worker alone has different/missing value after preflight | Pre-send fingerprint/resolution failure, execution failure exit 3 with an honest durable run when already created; zero target sends for that action; no secret leakage. |
| Invalid or nonexistent reproduction; malformed UUIDs | Exit 4 before DB UUID casts or execution; no durable or target effect. A real DB outage remains exit 3. |
| Reproduction points to wrong snapshot/hash/run binding; changed JSON under unchanged stored hash; unsupported canonicalization | Fail closed before run creation; do not repair history or issue HTTP. Use disposable fixture data to construct corruption cases, never historical production/evidence rows. |
| Origin removed, registration mismatch, contract mismatch, frozen/live production or unknown environment | Exit 4 before replay starts. Existing worker production gate remains; destination negative tests assert zero receiver hits, not merely an error string. |
| Unsupported frozen engine, normalizer, registry, evaluator, or eligibility version | Explicit version failure before execution where preflight can determine it; no silent current-version substitution. Cross-authoritative-version comparison refused. |
| Different snapshot hash, different payload/concurrency/binding, unrelated run or self-comparison | Compare refuses cross-intent/self pairs; never relax hash equality to lineage similarity. |
| No mode fix, VULNERABLE control | Same H and measured overlap still produce real FAIL/findings. Merely rerunning cannot establish remediation. |
| SECURE label but incomplete business evidence or conflicting effects | No diagnostic success from the label: accepted evaluators independently yield FAIL or NOT_EVALUABLE according to actual evidence. |
| Mode switch during processing; same-label setter; ABA mode toggle; changed target instance | Actual revision/attempt evidence makes lifecycle assertion fail. Do not rewrite a real business verdict or pretend the final status read proves the whole interval. |
| Foreign scope, wrong generation, stale setup writer, unexpected in-scope subject | Existing ADR-0026 exclusion/coverage/conflict rules remain. No foreign FAIL contamination and no dropped own FAIL. |
| Late raw/provenance/derivation writes around Boundary A/B | Existing race suites must still prove full W comparison, atomic proof/pointer generation, bounded re-analysis, and fail-closed exhaustion; no new direct writer bypass. |
| Setup response loss or mutation response truncation | INDETERMINATE remains recorded with exactly the declared attempt count and no automatic retry. Missing authoritative setup anchor cannot become PASS. Later inspection remains a separate observation. |
| Redis outage/reconciliation, stale worker | Existing durable-intent recovery and fenced state-write tests stay green; raw stale observations remain honestly attributed. |
| Secret canaries and huge/malformed diagnostic fields | Scan snapshots, observations, reports, errors, logs and compare output for values/keys; bounded serialization/redaction must cause missing diagnostic proof, never successful remediation from omitted data. |

Use transport receivers, before/after row sets, and actual target request tables to prove no requests/no effects on refusal paths. Keep fault execution within its existing local-development gate; the new endpoint does not expand permitted environments.

## J. E-1, F-1, G-1 and D-1 follow-up repairs

| Finding | Source confirmation | Narrow repair and regression |
| --- | --- | --- |
| E-1 malformed IDs yield exit 3 | CLI replay/compare parsers accept arbitrary nonempty strings; DB UUID lookup occurs later; generic DB errors map to execution failure. See [cli.ts](../../packages/cli/src/cli.ts), parsers at 147–240 and compare error mapping at 611–630. | Validate UUID syntax at the command/API input boundary before creating DB clients or making lookups. Add empty/malformed/extra-length/flag-like IDs and valid-but-missing UUID cases. Preserve DB outage exit 3. Update unaccepted Phase 18 parser fixtures currently using `repro-1`/`base-id`. No Phase 17 test edits. |
| F-1 legacy count omitted | [replay-comparison.ts](../../packages/forensics/src/replay-comparison.ts), `effectCountOf`, reads only `attributableEffectCount`/`acceptedReservedUnits`; [invariants.ts](../../packages/evidence/src/invariants.ts), lines 191/212/239, persists `equivalentEffectCount`. | Read the declared legacy INV-IZ-1 count for that invariant/evaluator, requiring a non-negative safe integer. Keep null for absent/malformed counts; never infer from finding totals. Test real Fintech comparisons plus pure extraction cases. Do not conflate units with order counts in labeling. |
| G-1 unsupported multi-verdict expectations disappear | [expectations.ts](../../packages/cli/src/expectations.ts), lines 80–118, skips entries unless `expectedVerdicts.length === 1`; the current unit test explicitly expects omission. | Smallest safe change: normalization returns an explicit typed error/unsupported-entry diagnostic, and assertion cannot return matched when any entry was dropped. Preserve single-verdict semantics; reject malformed/unknown/empty/multi-verdict entries and conflicting duplicate keys. Supporting exact verdict-set semantics is optional future scope, not implicit membership matching. Post-fix expectations remain a separate test assertion. |
| D-1 report-schema filename wrong | CLI/CI docs refer to `packages/cli/schemas/report-v1.json` (CLI docs also abbreviate scenario schema), but the real checked-in file is `packages/cli/schemas/rupturegrid-report-v1.schema.json`. | Correct references to the real report schema and `rupturegrid-scenario-v1.schema.json`; verify paths exist and schema-emission docs match source. Fix living docs only; do not edit historical self-audit evidence. |

Also correct the comparison scheduling note and require the ADR-0026 cross-version refusal described above. They are directly necessary to present the intended FAIL→PASS comparison honestly.

## K. Risks and compatibility implications

- **Backward compatibility:** old golden endpoints, required modes, scenario/test files and hashes remain intact. Target source receives additive behavior after approval; accepted Phase 17 history is not rewritten. Any accepted suite failure blocks completion, rather than authorizing changed expected results.
- **Target migration cost:** a separate Commerce migration is necessary for durable effective-configuration provenance. Pretending status-only reads prove which branch ran would be smaller but unsound. Nullable historical fields explicitly preserve unknowns.
- **Concurrency:** bookkeeping must not serialize the vulnerable race. Capture settings in a short coherent read, persist the captured tuple, and execute the same reservation code. The real barrier test is mandatory. Reset and submissions sharing one scope concurrently are not made safe by documentation; anchor conflicts/coverage remain fail-closed.
- **Global mode:** mode is installation-wide today. Use a dedicated instance for the acceptance test; on shared targets require observed stable revisions and reject remediation attribution on interference. Do not introduce per-run target modes or a new tenancy model to solve this demo lifecycle.
- **History versus live target reset:** original live target rows are intentionally removed by legitimate reset. Original durable captured truth and its report remain the historical evidence, not a claim of retained live rows.
- **Credential compatibility:** credentialed snapshots created without an original fingerprint cannot support honest value-rotation fail-fast retroactively. Keep them readable; deny replay explicitly. New replay-eligible CLI snapshots add only forward metadata; existing direct legacy runs remain available. Fingerprint key loss/rotation can make old replays unavailable; fail closed and document recovery rather than silently rebinding.
- **Version provenance:** the current snapshot type freezes `engineVersion` but does not itself enumerate normalizer/evaluator versions. The replay gate must consult the original durable evaluation/normalization provenance, preserve it, and reject missing/unsupported authority. Do not claim the generic registry check already covers this.
- **Causation limits:** identical intent plus observed configuration transition and independent business evidence demonstrates this controlled remediation. It is not proof of all environmental variables or all schedules. No mode label, operator declaration, expected outcome or AI text can substitute for actual effects.
- **Scope control:** no generic environment-override framework, fix verification daemon, new invariant kind, UI, public distribution or Phase 19 work is authorized by this amendment.

## L. Explicit decisions requiring approval

The architectural owner must approve or reject this concrete package before implementation:

1. **Phase boundary:** authorize only the target setup/provenance and replay acceptance-closure work described here as a Phase 18 amendment. Keep Phase 17 frozen and Phase 19 closed.
2. **Mode semantics:** retain required mode as immutable intent when explicitly declared; allow the separately named lifecycle scenario to preserve/observe target configuration with `targetModeRequirement = null`. No operator override and no mutation of old snapshots.
3. **Target change:** approve the separate context endpoint, target-owned provenance migration, per-attempt configuration capture and status evidence. Mode switching remains the existing legitimate fix; no new fix service.
4. **Demonstration:** approve a new original failure and its own same-S/H replay as the required lifecycle. Explicitly reject any claim that it retroactively has a golden vulnerable snapshot's hash, and reject Decision 1 as sufficient acceptance.
5. **Security closure:** approve trusted fingerprint preflight, forward-only optional snapshot metadata, denial of old credentialed replay without a baseline, content-hash revalidation, complete version gates and current binding checks. Preserve frozen-reference selection and existing continued-run authorization semantics; do not invent continuous grant revocation.
6. **Contract records:** authorize the exact prospective living-contract/ADR addenda in D, and reconcile ADR-0026's status using its existing approval record. This report does not mark either ADR accepted.
7. **Follow-up scope:** include E-1/F-1/G-1/D-1 and the comparison explanation/version repairs as focused Phase 18 repairs. Require the real test matrix and independent lifecycle audit before any phase-acceptance claim.

Architectural approval is not independent phase acceptance and does not itself authorize staging, commits, tags or pushes. The implementation workflow must receive its own applicable authorization.

## M. Final verdict and verification performed

**RESOLUTION READY FOR APPROVAL.** The main contradiction has a feasible additive resolution: freeze a mode-preserving experiment once, observe its genuine failure, change only target-owned processing through the legitimate mode API, and execute the original reproduction from the identical stored snapshot. Preserve mode-pinned golden experiments as separate unchanged regressions.

**Phase 18 remains unaccepted.** The same-snapshot post-fix PASS and security closure are planned and unimplemented. ADR-0027 remains PROPOSED. The four follow-up repairs are planned, not fixed.

Observed verification in this review:

- Read-only Git inspection confirmed baseline commit/tag, staging state and the initial 15-file Phase 18 inventory. Source review covered the requested contracts, proposed ADR, self-audit, target initialization/admin/inspection path, replay/comparison code and current Phase 18 unit/integration tests.
- `pnpm exec vitest run --config vitest.config.ts packages/cli/src/replay-command.test.ts`: first attempt failed during transform-cache rename with `EPERM`; **zero tests ran**. A retry with TEMP/TMP pointing to a writable scratch directory completed: **one test file, 12 tests passed**, exit 0. This verifies only the existing parsing/expectation unit suite, including its currently specified omission behavior; it does not validate the proposed architecture or the infrastructure lifecycle.
- Report-only Prettier check passed; all 28 relative Markdown links resolve to existing files. `git diff --check` passed for tracked changes and staging remained empty. No infrastructure lifecycle, migrations, repository-wide format/lint/typecheck/build gates, or independent audit were run for this design. Prior builder/auditor results are not re-certified here.
- SHA-256 comparison of all 449 initially tracked/untracked files found no changed or deleted file; the only added file is this report. Thus every pre-existing Phase 18 file and accepted Phase 17 artifact is preserved. No staging, commit, tag, push, or Phase 19 work is performed.

**Approval gate:** approve the seven decisions in L before production-code implementation. Do not weaken the mandatory same-snapshot acceptance requirement to close this gate.
