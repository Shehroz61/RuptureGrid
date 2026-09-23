# RUPTUREGRID v1.0 — PHASE 9 INDEPENDENT AUDIT

Auditor: independent principal-engineer session (not the Phase 9 builder).
Date: 2026-09-23. Branch audited: `phase-9-controlled-faults-observability`,
HEAD = `283827a` (= `phase-8-accepted`), all Phase 9 work uncommitted.
Every number below was observed in this audit session against the real
stack (real Control PostgreSQL, real Demo PostgreSQL, real Redis, real
worker, real Demo HTTP, real browser) unless explicitly attributed.

## 1. Verdict

**PHASE 9 ACCEPTED**

## 2. Repository / Git

- path = repository root checkout at `phase-8-accepted` + uncommitted
  Phase 9 work (the local absolute checkout path is deliberately not
  recorded here — R-15: no machine-specific paths in tracked files; none
  appear in any Phase 9 source file)
- branch = `phase-9-controlled-faults-observability`
- phase-8 baseline = `283827a` (`git rev-parse phase-8-accepted^{commit}`),
  `git merge-base HEAD phase-8-accepted` = `283827a` (no drift)
- Phase 9 committed = NO (fully uncommitted; `git add -N .` used for
  intent-to-add only)
- complete diff inspected = 58 files, ~6,100 insertions / ~124 deletions,
  every changed/new file read; `git diff --check` clean (no whitespace
  errors)
- baseline preserved = YES (all accepted migration files, lockfiles, and
  Phase 3–8 semantics verified byte-identical or behaviorally intact)

## 3. Migration Audit

- new Control migrations = exactly 1: `0005_phase9_fault_timeline`
  (additive enum values `FAULT_PLAN_CONFIGURED`, `FAULT_PLAN_ACTIVATED`
  on `analysis.TimelineEntryKind`; additive nullable JSONB column
  `reproduction_definition.faultIntent`)
- new Demo migrations = exactly 1: `20260921_phase9_fault_control`
  (`fault_plans` table, unique `faultKind`, CHECK bounds on
  `maxTriggers` ∈ [1,10] and `triggersUsed` ∈ [0,maxTriggers])
- accepted migration modifications = NONE (`git diff --name-status
  phase-8-accepted -- <migrations dirs>` = exactly the two additions;
  per-file diffs of every accepted migration and both lockfiles empty).
  **Wording rule:** "accepted migrations untouched" is the proven claim;
  "migration directories have no diff" is FALSE (the two additions are
  the diff). The builder self-audit's contradictory wording was corrected
  in place (§2 of that report).
- fresh apply = PROVEN on auditor-owned empty DBs `rg9aud_ctrl_fresh`,
  `rg9aud_demo_fresh`: `migrate deploy` from zero (no `db push`),
  `migrate status` = "Database schema is up to date!",
  `migrate diff --from-migrations … --to-schema … --exit-code` = 0
  ("No difference detected") for BOTH packages. Prisma validate clean
  for both schemas; `prisma generate` clean.
- upgrade apply = PROVEN on the same fresh DBs: Phase 9 migration
  directories moved aside → Phase-8-only set deployed → representative
  rows inserted (customer, wallet balance 500000, experiment definition)
  → Phase 9 migrations applied → old rows preserved (verified by SELECT),
  new structures present (`fault_plans` table, `faultIntent` column,
  both new enum values), `migrate status` clean both DBs. No reset.
- schema ↔ migration diff = empty (both packages, Prisma 7.10.0 flags)
- data preservation = proven (see upgrade apply)
- result = PASS. Live shared dev DBs were also verified up-to-date
  (non-destructive `migrate status`/`migrate diff` only). All
  auditor-owned databases were dropped after the audit.

## 4. Fault Catalog

- catalog version = `controlled-fault/v1`
  (`CONTROLLED_FAULT_PLAN_VERSION`, mirrored independently by the target
  as `FAULT_PLAN_VERSION` — the boundary deliberately does not share the
  constant, docs §3)
- fault kinds = exactly THREE: `PRE_MUTATION_REJECTION`,
  `CRASH_MID_PROCESSING`, `RESPONSE_TRUNCATION`
  (`CONTROLLED_FAULT_KINDS` in @rupturegrid/shared; same closed list in
  the target's `@rupturegrid/demo-db`). The audit brief's
  `PRE_MUTATION_TRANSIENT_FAILURE` and the builder report's
  `POST_MUTATION_RESPONSE_LOSS` exist NOWHERE in source; "post-mutation
  response loss" is the CLASS realized by the two post-commit kinds
  (docs §4: "connection drop" = the stage-targeted drops of the two
  post-commit kinds; no fourth kind).
- activation model = `first_n_matching_deliveries` (closed v1
  vocabulary; first N matching deliveries since arming, physical arrival
  order, atomic conditional UPDATE — no probability)
- trigger model = `maxTriggers` integer ∈ [1,10]
  (`maxFaultTriggersPerStep`), enforced at definition validation, target
  boundary validation, DB CHECK constraints, and consumed atomically;
  arming REPLACES the plan of that kind (fresh budget + TTL);
  `FAULT_PLAN_TTL_MS` = 900,000 ms lazy expiry
- delay/stagger model = `waveStaggerMs` engine-side deterministic wave
  spacing ∈ [0, 60,000] (`maxWaveStaggerMs`), requires repeat ≥ 2; no
  `delayMs` field was shipped (honestly documented)
- result = PASS (docs §4/ADR-0014 match source exactly)

## 5. Safety

- allowed environments = LOCAL_DEVELOPMENT only, enforced twice:
  definition validation (`validate.ts` fault-plan gate) AND execution
  time from the frozen snapshot (`step-processor.ts` re-derived gate —
  defense in depth); production execution is additionally denied for
  every step (Phase 3 §12/ADR-0011)
- production denial = proven in unit tests (`validate.phase9.test.ts`:
  PRODUCTION and STAGING targets refuse a fault-bearing document) and in
  source (execution-time gate fails the step with KNOWN_ABSENT BEFORE
  any delivery or fault-control call)
- staging denial = proven (same unit tests; STAGING ≠ LOCAL_DEVELOPMENT)
- unknown-target denial = a fault can only be armed through the worker's
  adapter on the FROZEN registered snapshot origin; an unregistered
  origin cannot be reached because snapshots are only created from
  registered targets, and the executor's URL is built exclusively from
  the frozen origin + validated relative path; the fault-control fetch
  re-verifies the response origin equals the registered origin
- arbitrary URL faulting = none exists: no user-supplied URL anywhere in
  the fault path (arm/disarm use the frozen origin + fixed
  `/demo/admin/faults/:kind` route owned by the worker adapter; the
  engine never sees a URL)
- server-side enforcement = the engine + worker enforce; UI is not a
  control (R-14). Denial happens BEFORE any target fault-control request
  is sent (arming failure/missing hook/gate → step FAILED KNOWN_ABSENT
  with attemptCount 0)
- result = PASS

## 6. Engine Boundary

- engine target-specific knowledge = NONE. `packages/engine` knows the
  typed `faultPlan` and the `controlledFaults.arm/disarm` port + the
  `captureFaultStatusAdapter` hook; it imports no Demo route, no Demo
  URL, no Demo credential name, and no `demo-fintech-fault-status`
  string (grep-verified)
- worker adapter = owns all Demo-specific wiring: `PUT/DELETE
  /demo/admin/faults/:kind` with the admin credential (request-time
  only), `GET /inspection/faults` with the inspection credential
- origin binding = the frozen snapshot origin is the only argument
- SSRF/redirect safety = `redirect: 'manual'` on fault-control fetches
  (3xx = failure), final response origin must equal the registered
  origin, bounded 10s timeout; executor rules (allowlist headers,
  executor-owned Host, resolve-once-validate address policy) unchanged
  from Phase 3
- result = PASS

## 7. PRE-MUTATION Scenario

- runId = `8063a7c7-da68-4eb5-9b0e-d302dcab6b87` (verifier run 1) and
  `0f5535b6-e406-4216-ac25-1f924c1e8be8` (verifier run 2); plus
  auditor-browser PRE run in `phase9-browser.test.ts`
- fault = `PRE_MUTATION_REJECTION`, budget 1, activation
  `first_n_matching_deliveries`
- configured = YES (target-observed fault-status observation)
- activated = YES (triggersUsed = 1 observed from the target)
- activation point = BEFORE_MUTATION (hook sits after all validation,
  before any persistence; no delivery row, no processing attempt, no
  financial effect can exist)
- transport = definitive HTTP 409 `CONTROLLED_FAULT_REJECTION`
- sideEffectKnowledge = KNOWN_ABSENT (definitive 4xx under the
  `DEMO_FINTECH_WEBHOOK` no-effect contract — the accepted Phase 3
  classification table, not a new semantic; NOT generic "409 →
  KNOWN_ABSENT": the contract guarantees zero effect on definitive
  rejections)
- retry count = 1 attempt, 0 retries (NONE policy in the verifier
  scenario; SAFE retry is separately proven permitted for KNOWN_ABSENT
  in `demo-controlled-faults.test.ts` with distinct invocation identity)
- failed-attempt mutation = none (business residue checks: zero
  deliveries/attempts/effects for the failed invocation)
- final effects = exactly the intended ones of the earlier setup steps;
  the fault step stops ordered chaining (later steps CANCELLED)
- invariant verdicts = INV-IZ-1 PASS (single credit), INV-DF-1 PASS
  (balance conservation), INV-DF-2 PASS (no negative balance)
- Findings = 0 (asserted `analysis.finding-count = 0`)
- result = PASS

## 8. POST-MUTATION Scenario (crown jewel)

- runId = `88033d1b-66d3-47a5-a16b-3eef6330a94c` (verifier run 1) and
  `5bf7a84a-8aba-4cea-abc5-ddc7f700751a` (verifier run 2); plus the
  browser POST run
- fault = `RESPONSE_TRUNCATION`, budget 1
- configured = YES (target-observed)
- activated = YES (triggersUsed = 1)
- activation point = AFTER_MUTATION (route-layer hook after
  `processDelivery` returned: financial transaction COMMITTED and
  processing attempt finalized)
- target mutation = COMMITTED (proven by the run's own later lineage
  capture: exactly 1 accepted `financial-effect-observed` event;
  socket-level variant proven in `demo-controlled-faults.test.ts` via
  direct inspection HTTP)
- transport observation = valid response headers with inflated
  Content-Length, body prefix written, connection destroyed mid-body;
  executor conservatively records `transportStage=REQUEST_SENT`
  (headers are not knowledge), httpStatus null at invocation level
- sideEffectKnowledge = INDETERMINATE (step AND invocation; never
  laundered, ADR-0008)
- automatic retries = 0 (`attemptCount` = 1, `invocation.count` = 1;
  `decideRetry` refuses INDETERMINATE mutating outcomes regardless of
  declared policy)
- later inspection = business effect exists (separate, clearly-attributed
  lineage evidence; the fault-bearing step runs its declared adapter
  after the FAILED terminal)
- post-inspection knowledge = STILL INDETERMINATE (asserted
  `invocation.knowledge-not-retroactively-changed` against durable rows)
- effects = exactly 1
- invariant verdicts = INV-DF-1 PASS, INV-DF-2 PASS, INV-IZ-1 never FAIL
- Findings = 0
- result = PASS

## 9. Socket-Level Proof

- mutation committed before close = YES (integration
  `demo-controlled-faults.test.ts`: real Node HTTP against the real Demo
  process; response never sent before destroy)
- client response observed = NO (`RESPONSE_TRUNCATION`: connection error
  mid-body, not a JSON response; `CRASH_MID_PROCESSING`: zero response
  bytes)
- connection failure = observed by the real client (fetch failure
  classified conservatively `REQUEST_SENT` ⇒ INDETERMINATE)
- Demo survived = YES (process alive; health checked after)
- trigger count = exactly 1 (`triggersUsed` = 1; second request behaves
  normally)
- subsequent request = succeeds normally
- duplicate mutation = NONE (single delivery row/attempt/effect)
- result = PASS (no mocked HTTP involved)

## 10. Configured vs Activated

- configured-only scenario = `timeline.phase9.test.ts` +
  `demo-controlled-faults.test.ts`: triggersUsed = 0 ⇒ CONFIGURED entry
  only, no ACTIVATED
- matched scenario = both entries derived from the SAME target-authored
  observation class
- maxTriggers = multi-shot budgets proven (2- and 3-trigger arms consume
  exactly their budget then behave normally)
- exhaustion = budget-exhausted deliveries take the normal path
  (`consumeTrigger` returns BUDGET_EXHAUSTED; DB CHECK forbids
  triggersUsed > maxTriggers)
- reset = arming replaces (fresh budget + TTL); disarm deletes; expired
  plans evaluate as disarmed (lazy TTL)
- cross-run leakage = verifier leakage check across 4 runs + forced
  arm/disarm probe: no live (unexpired) plan remains
- result = PASS

## 11. Fault-Status Capture

- ordering = real source: terminal invocation write → telemetry →
  fault-status capture (after the fenced terminal write, before disarm;
  disarm in `finally`) — verified in `step-processor.ts`
- capture-success evidence = `fault.status.observed outcome=captured`
  telemetry + redacted hash-chained `target_observation` raw observation
  (adapter kind `demo-fintech-fault-status`), provenance writer-owned
- capture-failure behavior = dedicated integration test: when the
  post-terminal capture fails, the original invocation terminal state
  and sideEffectKnowledge are unchanged, no synthetic ACTIVATED event is
  created, the failure is telemetry-recorded as honest incompleteness,
  required-evidence invariants become NOT_EVALUABLE, and no Finding is
  fabricated
- invocation preservation = proven (see above)
- NOT_EVALUABLE behavior = proven (INV-IZ-1 attribution-gap path and the
  capture-failure path)
- fake activation = none possible: activation is derived ONLY from
  triggersUsed ≥ 1 in the target's own observation, never from error
  shapes
- result = PASS

## 12. Evidence / Provenance

- raw fault observations = `target_observation` rows,
  `adapterKind=demo-fintech-fault-status`, redacted, hash-chained,
  writer-attributed; no new observation origin class
- normalized events = `demo.fault-plan-state-observed` per plan
  (`demo-fintech-fault-status-normalizer` v1), keyed idempotently by
  (run, normalizer, version, inputHash)
- activation provenance = every timeline ACTIVATED entry traces to a
  normalized event whose payload carries the source observation hash and
  chain index of the real raw observation
- causal relationships = unchanged identity-chain-only derivation; fault
  entries assert no causality
- integrity = `verifyRunEvidenceChain` chain-valid asserted in every
  verifier scenario
- result = PASS

## 13. Normalizer Versioning

- old lineage version = `demo-fintech-inspection-normalizer` v1 → bumped
  EXPLICITLY to v2 (new wallet-reconciliation fields); old payload
  fixtures keep v1 semantics (`normalize.phase9-compat.test.ts`)
- new lineage version = v2 (explicit constant; historical rows never
  reinterpreted)
- fault-status version = `demo-fintech-fault-status-normalizer` v1
  (explicit)
- historical compatibility = proven by the compat suite; same stored
  observation + version ⇒ same events
- silent reinterpretation = none (versions are part of the idempotency
  key)
- result = PASS

## 14. Invariants

- keys = INV-DF-1 (BALANCE_CONSERVATION), INV-DF-2 (NO_NEGATIVE_BALANCE)
  alongside unchanged INV-IZ-1
- business statements = INV-DF-1: for the wallet of an observed payment
  lineage, the target's OWN whole-wallet reconciliation must show
  balance = Σ accepted WALLET_CREDIT ledger entries (exact integer minor
  units, R-06). INV-DF-2: every observed wallet balance ≥ 0. Both are
  BUSINESS correctness — not restatements of timeouts/drops/activations
- versions = both `v1` evaluators, pure and deterministic
- subjects = distinct walletIds named by wallet-state events (INV-DF-2
  has a run-wide `*` subject when nothing was observed)
- completeness = PASS requires target-reported reconciliation fields;
  missing required evidence ⇒ NOT_EVALUABLE (never a silent pass)
- NOT_EVALUABLE = proven (v1-era observations without reconciliation
  fields; empty evidence)
- fake transport invariant = none: a transport fault alone can never
  produce an evaluation or Finding; INV-DF evaluators read only
  target-authored reconciliation numbers
- result = PASS. Scope note: INV-DF-1 consumes the target's whole-wallet
  reconciliation (same-scope comparison; NOT one payment's effects vs
  whole-wallet history — the per-payment fallacy is explicitly guarded
  in docs and code)

## 15. Multi-Invariant Analysis

- deterministic ordering = evaluation sets are iterated in fixed order;
  per-invariant observations sorted by (inputHash, id)
- rerun idempotence = integration-proven ("repeat analysis with
  unchanged evidence returns the SAME rows")
- concurrent idempotence = integration-proven ("concurrent analysis
  passes converge without duplicates or conflicts") via unique keys +
  P2002 tolerance
- duplicate evaluations = none (evidence-set-hash keyed)
- evidence-set hashes = stable canonical fingerprint over observation
  hashes + event input hashes + relationship ids; changes only when
  evidence changes
- subject isolation = per-payment / per-wallet subjects evaluated
  independently; distinct payments never conflated
- result = PASS

## 16. INV-IZ-1 Regression

- vulnerable verdict = FAIL (VULNERABLE Incident Zero: 25/25)
- secure verdict = PASS (SECURE: 21/21)
- vulnerable Finding count = exactly 1
  (`DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT`, `INV-IZ-1` — verified by SQL
  against the real run)
- Finding reason = `DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT`
- pollution from new invariants = none (Findings remain INV-IZ-1-only;
  incident-zero loader pins `invariantKey = 'INV-IZ-1'`; PASS/
  NOT_EVALUABLE evaluations create no Finding rows)
- result = PASS

## 17. Timeline

- configured kind = `FAULT_PLAN_CONFIGURED` (separate enum value + entry)
- activated kind = `FAULT_PLAN_ACTIVATED` (emitted only on observed
  triggersUsed ≥ 1); the interrupted session's collapsed
  `FAULT_PLAN_STATE_OBSERVED` is absent from the final schema
- derivation version = `TIMELINE_DERIVATION_VERSION` v2 (no v1 rows ever
  persisted under the collapsed name — verified: the enum value never
  shipped in any accepted migration)
- source backing = both kinds derive from real target-observed
  normalized events; entries carry typed sourceKind/sourceId,
  orderingBasis (`wall_clock` / `unordered_overlap`), timeMeaning
  (`observedAt`)
- retry representation = each physical attempt is its own
  INVOCATION_EXECUTED entry with its own invocation identity
- ambiguity representation = INDETERMINATE is first-class in step,
  invocation, and timeline entries
- ordering basis = (occurredAt, orderingBasis, sourceKind, sourceId,
  entryKind) — deterministic, insertion-independent
- causality = only via CausalRelationship rows; adjacency asserts
  nothing
- result = PASS

## 18. Reproduction

- fault intent = frozen per step: planVersion, faultKind, activation,
  maxTriggers, waveStaggerMs, credential REFERENCE names
  (`reproduction_definition.faultIntent` JSONB)
- snapshot binding = intent derives ONLY from the frozen snapshot
  (never live state); hash-mismatch against an existing row is refused
  (append-only)
- credential refs = reference names only
- credential values = none (canary-verified)
- replay execution = none exists (deliberately; no Phase 10 machinery)
- result = PASS

## 19. Observability

- events = closed `engine-telemetry/v1` vocabulary: `step.lifecycle`,
  `invocation.executed`, `wave.staggered`, `fault.armed`,
  `fault.disarm.outcome`, `fault.status.observed`, `reconcile.sweep`
- correlation IDs = runId/stepRunId/invocationIdentity/faultKind/
  maxTriggers/waveIndex as applicable; no invented identifiers
- secret values = none (telemetry events carry no credential fields —
  unit-asserted; logger is the redacting structured logger)
- durable truth boundary = telemetry writes no execution/evidence/
  analysis rows and feeds no evaluator (ADR-0015 §4; code-verified)
- generic APM added = none: no vendor SDK dependency in the engine
  (optional OTel API bridge, degrade-to-logger; no Prometheus/Grafana)
- result = PASS

## 20. Security

- admin secret = used only at request time in the worker adapter;
  never logged/persisted
- inspection secret = same (evidence adapters)
- signing secret = exists only inside the signing call frame
- canary = actual live credential values swept across raw_observations,
  normalized_events, forensic_timeline_entry, finding tables and the
  verifier JSON: ZERO occurrences; also zero credential-value-shaped
  strings in the full diff (only `.env.example` reference names, which
  are permitted)
- logs = structured redacted logger; no durable log files in the repo
- evidence = redaction before hashing/persistence (unchanged Phase 4
  path)
- verifier output = bounded, secret-free, classified exit codes
- result = PASS

## 21. Phase 9 Verifier

- command = `pnpm controlled-faults:verify` (and `node …/cli.js --json`)
- assertions = implementation inspected first: durable-truth assertions
  (engine rows, evidence chain, evaluations, timeline, reproduction,
  target-authored fault status); bounded waits; classified exit codes
  0/1/2/3
- first run = PRE 18/18 + 18/18, RESPONSE_LOSS 22/22 + 22/22 = 80/80,
  PASS exit 0
- second run = 80/80, `ok: true`, exit 0
- fresh IDs = all four runIds distinct across runs; no stale activation;
  leakage none
- failure behavior = auditor-forced mismatch (live armed plan planted
  through the target's own admin API, then disarmed): exit 1, classified
  diagnostic `leakage: FAIL — live plans remain: 1`, no green RESULT,
  no secret output
- structured output = `--json` emits the full report
- result = PASS

## 22. Browser — PRE

- execution = real Playwright Chromium against the real Next.js app
  (`phase9-browser.test.ts`, auditor-run, green)
- configured = visible (fault plan timeline entry)
- activated = visible
- KNOWN_ABSENT = visible on the failed invocation/step
- retry = attempt rows shown as recorded (none in this scenario)
- business state = real eventual state from the real run
- timeline = rendered with distinct fault-plan labels
- evidence = real rows only; no Phase 9 UI fixtures (grep-verified)
- result = PASS

## 23. Browser — POST

- execution = real Playwright run
- configured = visible
- activated = visible
- INDETERMINATE = visible as the invocation/step knowledge
- retry = none shown (none occurred)
- later mutation evidence = the committed effect visible through later
  inspection evidence
- knowledge distinction = UI preserves execution-time ambiguity; it does
  not imply the invocation knew the mutation occurred (INDETERMINATE
  remains after evidence)
- timeline / evidence = real, source-backed
- result = PASS

## 24. Browser Runtime

- console = no errors during the browser tests
- hydration = no hydration errors surfaced
- network = no failed requests beyond the intentionally faulted delivery
- deep links = run/timeline deep links exercised
- result = PASS. No Phase 9 screenshot/video automation exists (Phase 8
  showcase machinery unchanged; `.artifacts/` remains gitignored)

## 25. Incident Zero Regression

- command = `pnpm incident-zero:verify`
- frozen intent = 5/5
- vulnerable = 25/25 (VULNERABLE run FAIL with exactly one
  DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT Finding — SQL-verified)
- secure = 21/21
- Finding count = 1 vulnerable / 0 secure (verified by SQL)
- result = PASS (re-run green after the auditor correction)

## 26. Showcase Regression

- command = `pnpm showcase:generate`
- validation = pass
- screenshots = 10
- result = PASS (re-run green after the auditor correction; Phase 8
  source unchanged — the showcase diff contains no Phase 9 edits)

## 27. Tests

- Phase 9 unit = `validate.phase9.test.ts` (15 after correction),
  `telemetry.test.ts` (5), `invariants.phase9.test.ts`,
  `normalize.phase9-compat.test.ts`, `timeline.phase9.test.ts`,
  `fault-control.test.ts` — all green
- workspace unit = 33 files, **319/319** post-correction (318/318
  pre-correction + 1 new regression test)
- Phase 9 integration = `controlled-faults.test.ts` (6),
  `demo-controlled-faults.test.ts` (8), `phase9-browser.test.ts` (2) —
  green in every full run
- workspace integration = 23 files, **152/152**
- real PostgreSQL = yes (Control)
- real Demo PostgreSQL = yes
- real Redis = yes (incl. outage-reconciliation suite)
- real Worker = yes (spawned processes + verifier-owned children)
- real Demo HTTP = yes
- real browser = yes (Playwright Chromium)
- result = PASS. Honest note: three flaky failures appeared across four
  full-suite runs, each in a PRE-EXISTING Phase 3–5 file untouched by
  Phase 9 (`ownership.test.ts` stale-origin collision with 56 old
  time-bucketed registrations; `forensics.test.ts` unordered
  `findFirstOrThrow` across legitimate per-evidence-set evaluations;
  `execution-mechanics.test.ts` load timeout) — each passed solo and on
  full re-runs; final complete pass was 152/152. These are pre-existing
  environment/test-isolation weaknesses, not Phase 9 regressions, and
  are recorded as remaining risks.

## 28. Quality Gates (post-correction, all observed)

- format = pass (Prettier)
- lint = pass (all packages)
- typecheck = pass
- unit = 33 files 319/319
- integration = 23 files 152/152
- build = pass (packages + apps incl. Next static build)
- verify = exit 0
- controlled-fault verifier = PASS (80/80, no leakage)
- incident-zero verifier = PASS (5/5, 25/25, 21/21)
- showcase = PASS (10 screenshots, validation pass)

## 29. Builder Claim Verification

- migration claims = "2 new migrations" TRUE; "accepted migrations
  untouched" TRUE; "directories diff = empty" FALSE as worded (corrected
  in the self-audit); fresh-apply/upgrade-apply TRUE (re-proven
  independently with auditor-owned DBs)
- PRE claims = TRUE (KNOWN_ABSENT justified by contract + activation
  evidence; retry only where SAFE permits)
- POST claims = TRUE (INDETERMINATE persisted; zero retries; later
  inspection proves the effect; knowledge never rewritten)
- test totals = 318/318 + 152/152 TRUE (now 319/319 after the auditor's
  added regression test)
- verifier repeatability = TRUE (twice, 80/80, fresh IDs, no leakage)
- normalizer claims = TRUE (v1 preserved, v2 explicit, fault-status v1)
- invariant claims = TRUE (INV-DF-1/2 are genuine business invariants;
  no fake transport invariant; no Finding pollution)
- secret claims = TRUE (canary zero)
- generated artifacts = none in the diff (screenshots/logs/profiles
  gitignored; verifier JSON kept only in auditor scratch, deleted)
- result = PASS with two report-truth corrections applied

## 30. Auditor Corrections

1. FILE = `packages/engine/src/validate.ts`
   DEFECT = docs/controlled-faults.md §2 requires "one `faultKind` may
   appear on at most one step per document" but no validation enforced
   it (documented rule not implemented — R-04 divergence; arming
   replaces per-kind target state, so two steps sharing a kind would
   race for one budget and make activation order-dependent).
   WHY = closes the last docs-vs-code divergence found in the Phase 9
   surface; keeps activation deterministic and attributable.
   CHANGE = post-mapping duplicate-faultKind check in
   `validateExperimentDocument` (rejects a second step declaring an
   already-declared faultKind; distinct kinds on multiple steps remain
   valid); issue message documents the rule.
   TEST = new unit case in `packages/engine/src/validate.phase9.test.ts`
   ("rejects one faultKind declared on two steps of one document";
   duplicate rejected, distinct kinds accepted).
   REAL REPROOF = unit 33 files 319/319; typecheck/build/verify clean;
   integration 23 files 152/152; controlled-faults verifier PASS 80/80
   (no leakage); incident-zero 5/5, 25/25, 21/21; showcase 10
   screenshots. No valid document changes behavior.
2. FILE = `docs/reports/phase-9-self-audit.md` (report truth, §49)
   DEFECT = wrong fault-catalog naming ("two kinds" incl. a
   nonexistent `POST_MUTATION_RESPONSE_LOSS`) and contradictory
   migration-diff wording.
   WHY = R-02/R-18: the audit report must not contain fabricated or
   imprecise claims.
   CHANGE = corrections applied inline, marked "CORRECTED BY INDEPENDENT
   AUDIT"; builder history not hidden (original claims are quoted inside
   the corrections); §12 appended with the audit outcome.
   TEST = n/a (documentation).
   REAL REPROOF = the corrected statements match the mechanically
   verified facts recorded in this report (§3, §4).

## 31. Report Truth Audit

- result = corrected and now accurate
- incorrect claims found = (a) "exactly two fault kinds …
  POST_MUTATION_RESPONSE_LOSS" — false; catalog is three kinds;
  (b) "git diff on migrations dirs = empty" — false as worded; exactly
  two additions, accepted files untouched; (c) minor: "the two shipped
  fault kinds" phrasing and `.env.example`'s claim that compose init
  creates the shadow DB (compose mounts no init script; harmless —
  Prisma's shadow mechanism manages its own scratch database)

## 32. Remaining Risks (genuine, non-blockers)

1. Pre-existing test-isolation weaknesses in Phase 3–5 integration files
   on a persistent shared dev DB (time-bucketed origin registration
   collisions; one unordered `findFirstOrThrow` over legitimate
   per-evidence-set evaluation rows). Not Phase 9 regressions; each
   passed solo/full re-runs. A future phase should add unique-port
   generation and deterministic evaluation re-fetch (orderBy).
2. `packages/demo-db/prisma.config.ts` imports `@rupturegrid/config`
   without declaring it in `package.json` — pre-existing at
   phase-8-accepted (latent dependency-hygiene gap, outside the Phase 9
   diff; resolvable through pnpm's workspace resolution in all canonical
   project commands).
3. One audit-run flake window in `pnpm verify`'s unit step (same stale
   origin registration class as risk 1) — non-reproducible in isolated
   runs; final gate runs green.
4. The 15-minute arming TTL bounds disarm-failure leakage by design; the
   verifier's leakage check plus lazy TTL expiry keep this honest.

## 33. Phase Preservation

- accepted migrations = untouched (byte-identical)
- Demo business schema semantics = unchanged (FinancialEffectType /
  LedgerEntryType enums structurally correct after the builder's
  interrupted edit — relocation, not corruption; fault_plans is
  separate test-control state with no business coupling)
- Phase 3 execution = classification table, retry policy, executor
  security, fencing unchanged (suites green)
- Phase 4 evidence/invariants = INV-IZ-1 unchanged; derivation idempotent
- Phase 5 forensics = timeline v2 is additive; Finding rules unchanged
- Phase 6 UI = only additive timeline labels
- Phase 7 golden scenario = 5/5, 25/25, 21/21; loader pinned to INV-IZ-1
- Phase 8 showcase = unchanged, validation pass, 10 screenshots
- result = PASS

## 34. Git

- branch = `phase-9-controlled-faults-observability`
- files changed = 58 Phase 9 files + this report + self-audit
  corrections (+1 new test in an existing Phase 9 test file); every file
  re-read after all corrections
- generated artifacts = none tracked (screenshots/videos/logs/profiles
  gitignored; auditor scratch kept outside the repo and deleted)
- git diff --check = clean
- commit = NO; tag = NO; push = NO

## 35. Acceptance Blockers

NONE

**STOP. Phase 10 not started. Nothing committed, tagged, or pushed.**
