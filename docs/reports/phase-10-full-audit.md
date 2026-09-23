# RUPTUREGRID v1.0 — PHASE 10 FULL ENGINEERING AUDIT

Auditor/corrective engineer: Phase 10 principal-systems-auditor session
(branch `phase-10-full-engineering-audit`, cut from `phase-9-accepted` =
`e39cbfe`). Date: 2026-09-23. Every number below was observed in this
session against the real stack (real Control PostgreSQL, real Demo
PostgreSQL, real Redis, real worker/Demo child processes, real HTTP,
real browser via the accepted verifiers). Attacks that found NO defect
are recorded where the property is important. All work remains
UNCOMMITTED by phase-boundary design.

## 1. Verdict

**PHASE 10 READY FOR INDEPENDENT AUDIT**

## 2. Starting checkpoint

- repository = RuptureGrid v1.0 local checkout (path deliberately not
  recorded — R-15)
- starting branch = `phase-9-controlled-faults-observability`, tree clean
- phase-9 commit = `e39cbfe` (`git rev-parse phase-9-accepted^{commit}`
  = `e39cbfe28f05bcc06c8ca7c84d90ffed030cafae`)
- phase-9 tag = `phase-9-accepted` → e39cbfe (verified; not moved)
- Phase 10 branch = `phase-10-full-engineering-audit` (created from
  `phase-9-accepted`; `git switch -c` observed)

## 3. Baseline gates (Phase 9 accepted, observed on this machine before fixes)

| Gate | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test:unit` | 33 files, 319/319 pass (~19–23s) |
| `pnpm build` | pass |
| `pnpm verify` | 1 failure / 2 passes (see DEF-1) |
| `pnpm test:integration` | 23 files, 152/152 pass (360.16s, first audit run) |
| `pnpm incident-zero:verify` | PASS (5/5, 25/25, 21/21) |
| `pnpm controlled-faults:verify` | PASS (80/80, no leakage) |
| `pnpm showcase:generate` | PASS (10 screenshots, validation pass) |

## 4. Architecture / boundary audit (§6 system map — verified in source)

Truth ownership, verified file-by-file:

- **Control PostgreSQL** (`packages/control-db`, schemas control /
  evidence / analysis) — the only durable truth for targets,
  experiments, snapshots, runs, steps, invocations, evidence, findings,
  timeline, reproduction. Owned by API + worker exclusively.
- **Demo PostgreSQL** (`packages/demo-db`) — business truth of the
  target (customers, wallets, payments, events, deliveries, attempts,
  effects, ledger, demo_settings, fault_plans). Written only by
  `apps/demo-fintech` through its own admin/webhook interfaces.
  Lint-enforced: `eslint.config.mjs` forbids `@rupturegrid/demo-db`
  imports in API/worker/web (error-level, verified present) and forbids
  control-db/queue imports in demo-fintech. Worker reaches the Demo
  over HTTP only; `DEMO_DATABASE_URL` is not in the worker schema
  (`packages/config/src/schemas.ts` — verified absent).
- **Redis/BullMQ** (`packages/queue`) — coordination only; job payloads
  carry durable row IDs (`ExecutionJobPayload` = runId/stepRunId/
  sequence); deterministic `jobId` from stepRunId; producer has
  offline-queue disabled so an outage rejects loudly into the durable
  `lastDispatchError`/RECONCILE path (ADR-0003).
- **State-machine authority** — `packages/engine` (claim/lease/fencing
  `claim.ts`, fenced transitions `transitions.ts`, classification
  `classify.ts`, retry `decideRetry`, executor `executor.ts`).
- **Evidence truth** — `packages/evidence` (redact-before-persist,
  provenance-identity idempotency, advisory-locked hash chain append,
  versioned normalizers, INV-IZ-1/DF-1/DF-2 evaluators, integrity
  verifier).
- **Forensic derivation** — `packages/forensics` (Findings from
  persisted evaluations only; timeline v2; reproduction bound to
  snapshot; precise P2002 matching `p2002.ts`).
- **Presentation** — `apps/web` reads only through `apps/api` HTTP
  surfaces (`apps/web/lib/api-client.ts`; `cache: 'no-store'`; no DB
  imports possible — lint rule above). Every page
  `export const dynamic = 'force-dynamic'` (stale run truth impossible
  via static caching).
- **Orchestration/verification** — `packages/incident-zero`,
  `packages/controlled-faults`, `packages/showcase` are verifiers and
  presentation; they never create truth outside the accepted pipeline.

Boundary defects found: none (the one cross-boundary hazard class —
test-origin registration — is DEF-2, test-only, fixed).

result = PASS

## 5. Migration audit (§9)

- Accepted migration modifications = NONE. `git diff --stat
  phase-9-accepted -- <both migrations trees>` = empty (proven).
  Migration sets enumerated: Control 0001–0005 (init, phase3, phase4,
  phase5, phase9), Demo 0001 + 2× phase2 + phase9 — byte-identical to
  accepted.
- Fresh apply = PROVEN. Auditor-owned empty databases
  `rg10aud_ctrl_fresh` / `rg10aud_demo_fresh` created; `prisma migrate
  deploy` from zero ("All migrations have been successfully applied.",
  exit 0, both packages); no `db push` anywhere.
- Upgrade apply = PROVEN. Phase 9 migration directories moved aside →
  Phase-8-era sets deployed on fresh `rg10aud_ctrl_upg` /
  `rg10aud_demo_upg` → representative rows inserted (control
  target_registration row; demo demo_settings row mode=SECURE) →
  Phase 9 migrations restored + applied → old rows verified still
  present (`rg10-upgrade-probe` / `SECURE`), new structures present
  (`reproduction_definition.faultIntent` column = 1;
  `fault_plans` table = 1). No reset; no data loss.
- Schema ↔ migration diff = "No difference detected." (exit 0) for
  BOTH packages (`migrate diff --from-migrations --to-schema`).
- Enum evolution = additive only (`ALTER TYPE ... ADD VALUE` for the
  two Phase 9 timeline kinds; verified 18 values in the fresh DB).
- CHECK constraints = verified live: `fault_plans_maxTriggers_bounds_
  check` [1,10], `fault_plans_triggersUsed_bounds_check`
  [0,maxTriggers], unique `faultKind`.
- Append-only triggers = verified present in migration 0003
  (`raw_observation_append_only`, `*_no_delete`,
  `normalized_event_*`, `causal_relationship_*`) with the migration's
  own honest header (pragmatic application-mutation guard, not
  tamper-proofing).
- Destructive operations = none in any migration (schema creation and
  additive alteration only).
- All auditor-owned databases dropped after the proofs (observed
  DROP DATABASE ×4).

result = PASS

## 6. Database / transaction audit (§10, §11)

Constraints verified in schema + migration SQL (R-12):

- idempotency/unique-effect authority = DB-enforced:
  `ledger_entries."idempotencyKey"` unique (Demo migration
  20260909093718); `applyWalletCreditFinancialEffect` wraps
  FinancialEffect + LedgerEntry + wallet increment in ONE transaction
  and maps ONLY the precise idempotency-key P2002 to
  IDEMPOTENT_DUPLICATE (`packages/demo-db/src/index.ts`
  `isIdempotencyKeyConflict`; other violations propagate as failures).
- invocation identity = `@@unique([stepRunId, sequence])` +
  deliveryAttemptId DB-unique in the Demo (repeated physical identity
  = 409 contract conflict, distinct from legitimate redelivery).
- fault budget = DB CHECK bounds + atomic conditional UPDATE
  (`consumeTrigger`: `WHERE triggersUsed < maxTriggers AND expiresAt >
  now` — concurrency-exact, verified in source).
- Finding uniqueness = `@@unique([invariantEvaluationId,
  findingRuleVersion])`; evaluation uniqueness =
  `@@unique([runId, invariantKey, evaluatorVersion, subjectKey,
  evidenceSetHash])`; timeline uniqueness =
  `@@unique([runId, derivationVersion, sourceKind, sourceId,
  entryKind])`; reproduction uniqueness = `@@unique([runId])`;
  observation identity = `@@unique([runId, kind, invocationIdentity])`.
- P2002 handling = precise everywhere: `packages/forensics/src/p2002.ts`
  matches constraint fields OR the DDL index name (Prisma 7
  driver-adapter shape) and re-fetches OUTSIDE the aborted transaction;
  `raw-observation-store.ts` classifies the winner inside/outside the
  advisory lock (same content ⇒ idempotent; different content ⇒
  explicit `EvidenceIntegrityConflictError`, never aliasing);
  `recordInvocation` re-allocates next-free sequence on P2002 with a
  bounded 64-attempt loop (no infinite retry, no swallowed unrelated
  P2002 — rethrow otherwise).
- Partial-write risks = none found: every multi-write correctness path
  is a single Prisma transaction (financial effect; registration
  target+origins; claim CTE; demo reset).
- External HTTP inside DB transactions = none. The advisory-locked
  evidence append does no network I/O; the executor, fault-control
  fetch, and inspection adapters all run OUTSIDE any transaction.
  `registerTarget`'s transaction is DB-only.
- Lease writes use DB time (`statement_timestamp()`), not worker
  clocks (§94) — verified in `claim.ts`/`heartbeatStep`/
  `resolveExpiredLease`.

result = PASS

## 7. Money / identity audit (§12, §13)

- Integer minor units = verified (`packages/demo-db/src/money.ts`):
  decimal-integer-string parse to bigint; fractional, sign, exponent,
  whitespace, leading-zero, over-magnitude all rejected; unit-tested.
  No float arithmetic exists in any money path (grep clean; the only
  `Math.random` hits are test identity generation, not semantics).
- PKR 5,000 = 500000 paisa throughout (fixtures, verifiers, UI
  formatting from minor units).
- Currency always travels with amount; `sameMoney` requires both;
  effect equivalence tuple = payment identity + wallet + type + amount
  + currency (`deriveIdempotencyKey` scopes: VULNERABLE=event-level —
  the deliberate defect; SECURE=payment-level — the fix; documented in
  `keys.ts` and proven by the golden suite).
- Business identities (`providerPaymentId` / `providerEventId` /
  `deliveryAttemptId` / `processingAttemptId` / `financialEffectId`)
  remain distinct in the Demo schema, the inspection lineage, the
  normalizers, and the derivation chain. Duplicate delivery ≠ duplicate
  effect is the INV-IZ-1 counting rule; retry ≠ new payment is the
  classify/decideRetry separation; transport failure ≠ business failure
  is the orthogonal `intentOutcome` × `sideEffectKnowledge` model.
- Negative amount escape = impossible (parse rejects sign; payload
  validation requires `amountMinor > 0`; amount/currency for effects
  are copied exclusively from the stored payment row — the webhook
  can never rewrite them).

result = PASS

## 8. Demo target audit (§14, §15)

Proven by the accepted permanent suites re-run in this session
(`demo-incident-zero.test.ts`, `demo-db-domain.test.ts`,
`demo-controlled-faults.test.ts` — all green, real TCP HTTP, measured
overlap with an atomic in-flight counter, barrier-style concurrency):

- sequential duplicates, concurrent duplicates (20 deliveries,
  concurrency 8), two legitimate payments, two event types, mode
  switch, reset, fault-plan state, ledger reconciliation, wallet
  balance, FinancialEffect/LedgerEntry — all asserted against the
  target's own inspection API.
- Secure mode = exactly one accepted effect under duplicate pressure;
  vulnerable mode = deterministic duplicate per frozen scenario;
  suppressed attempts remain persisted as IDEMPOTENT_DUPLICATE
  (never hidden).
- Reset re-establishes the canonical baseline atomically (transaction,
  children-first deletes) — verified in `admin-service.ts`.

result = PASS (no Phase 9 regression)

## 9. Lease / fencing audit (§16, §17)

Attacked by `tests/integration/ownership.test.ts` (re-run green) and
`multi-worker.test.ts` (re-run green), all against real PostgreSQL:

- two concurrent claimants: exactly one wins; fencing token increments
  monotonically on every claim (claim = ONE conditional CTE UPDATE).
- a live lease is never stealable; takeover only after DB-time expiry.
- stale writer: `markExecuting` / `writeTerminalState` conditioned on
  (owner, token, non-terminal state) → zero rows ⇒ `LeaseLostError` +
  durable `stale_writer_event`. Terminal states are write-once (no
  resurrection).
- heartbeat renews only for the owning generation (zero-row ⇒
  LeaseLostError); heartbeat loss stops network work; late terminal /
  late evidence behavior: state writes rejected, observations remain
  appendable WITH their stale writer provenance (fencing governs
  state, never recorded reality — ADR-0009 as implemented).
- reconcile-during-execution: a step with a live lease is invisible to
  `resolveExpiredLease` (re-checks expiry inside the transaction);
  a run with any CLAIMED/EXECUTING step is never settled.

result = PASS

## 10. Reconciler / Redis / queue audit (§19–§21)

- `redis-outage-reconciliation.test.ts` (re-run green): Redis lost
  after durable run creation → run persists in DISPATCHING → recovery
  via reconciliation; no lost durable work; no duplicate business
  execution (deterministic jobId + PostgreSQL claim authority).
- Reconciler attacked at each phase boundary (before dispatch, after
  durable marker, after queue insert, after claim, mid/after HTTP,
  before terminal) — the accepted suites cover the crash/kill windows
  (`execution-mechanics.test.ts`, `multi-worker.test.ts`); every wait
  is bounded polling on persisted state.
- Queue duplication: duplicate job delivery exits safely as
  not-claimable (verified in `execution-mechanics.test.ts` "duplicate
  BullMQ delivery executes exactly once").
- Stale-writer reconciliation outcome for ambiguous mutations =
  INDETERMINATE (never a guess; `reconciler.ts` conservative path
  verified in source, proven by tests).

result = PASS

## 11. SSRF / HTTP security audit (§22–§25)

Source-verified, contract-by-contract (`packages/engine/src/executor.ts`,
`validate.ts`, `target.ts`, `step-processor.ts`):

- URL construction: ONLY snapshot registered origin + validated
  relative path; absolute/scheme-relative forms cannot exist; the
  executor re-checks `url.origin === origin.origin` after
  construction; userinfo, path, query, fragment, non-HTTP(S) schemes
  rejected at registration (`normalizeOrigin`).
- Redirects = `redirect: 'manual'` in the executor AND the worker
  fault-control fetch (3xx = failure; final response origin must equal
  the registered origin). No helper uses default automatic redirects
  (grep-verified across engine/worker/evidence/showcase/verifier
  clients — the lineage/fault-status adapters target the registered
  origin only and the verifier clients are local-only).
- Address-class policy (`isDeniedAddress` + `assertDestinationAllowed`):
  loopback, RFC1918, link-local, CGNAT, unique-local, IPv4-mapped
  IPv6 (recursively), 64:ff9b, unspecified — denied for
  STAGING/PRODUCTION; resolve-once-validate before any connection;
  DNS-rebinding honest limitation documented (egress isolation is the
  primary control). LOCAL_DEVELOPMENT exemption is by design.
- Host header pinned from the origin; step headers allowlisted;
  CR/LF/NUL rejected; `${signature}` is the only provider-signature
  form (executor-computed over final bytes; the secret exists only in
  the call frame).
- Credentials: only `Bearer ${credential.<REF>}` reference form is
  valid in definitions; substitution happens at request time; values
  never logged/persisted; Authorization is in the evidence
  REDACTED_HEADERS set.
- Limits (server-side, `EXECUTION_LIMITS` + executor re-check): request
  body cap (pre-send), response content-length cap (headers stage,
  body cancelled), buffered response cap, bounded stored-body capture
  with explicit `responseTruncated` flag, per-invocation timeout with
  abort → conservative `REQUEST_SENT` (§25/§26 verified: abort can
  never prove non-send; only ECONNREFUSED/ENOTFOUND/EAI_AGAIN/
  ECONNABORTED/CERT_*/ERR_TLS_* are provably pre-send).
- Registered-origin registration attacks (§23): duplicate origin
  (global unique, rejected), different environment class per origin
  (scheme policy), malformed origin, path in origin, credential in
  origin, mixed case (lowercased), default ports (explicit port
  preserved), trailing slash (pathname must be `/`) — all covered by
  `validate.test.ts` + registration behavior verified in source.

result = PASS (no bypass found)

## 12. Ambiguity / retry audit (§26–§28)

- Classification table implemented exactly as accepted
  (`classify.ts`): success⇒KNOWN_OCCURRED; no-effect-contract 4xx
  ⇒ KNOWN_ABSENT (only DEMO_FINTECH_WEBHOOK); pre-send failures ⇒
  KNOWN_ABSENT; post-send timeout/reset/truncation/crash ⇒
  INDETERMINATE; read-only ⇒ NOT_APPLICABLE; cancel before dispatch ⇒
  KNOWN_ABSENT, mid-flight mutating ⇒ INDETERMINATE.
- Post-mutation response loss re-proven live in this session's final
  controlled-faults runs: RESPONSE_LOSS runs show exactly 2
  INDETERMINATE invocations alongside KNOWN_OCCURRED/NOT_APPLICABLE
  rows (SQL observed); zero retries (`attemptCount`=1); later
  inspection proves the committed effect; invocation knowledge NOT
  rewritten (verifier assertion `knowledge-not-retroactively-changed`).
- No source path rewrites INDETERMINATE after the fact (grep + source
  read: `sideEffectKnowledge` is written once per terminal, fenced).
- Retry enumeration: `decideRetry` — NONE ⇒ never; INDETERMINATE
  mutating ⇒ never (regardless of SAFE); SAFE+KNOWN_ABSENT ⇒ bounded
  budget; read-only transient ⇒ bounded. Queue retries = attempts:1
  (BullMQ) + reconciler requeue gated by RECONCILE once-marker.
  No ambiguous non-idempotent mutation is auto-retried anywhere.

result = PASS

## 13. Controlled fault audit (§29–§32)

- Environment safety: definition-time gate (PRODUCTION/STAGING
  refused) + execution-time re-derivation from the frozen snapshot
  (defense in depth) — both verified in source
  (`validate.ts`, `step-processor.ts`); unit suites green.
- Trigger atomicity: `consumeTrigger` atomic conditional UPDATE —
  concurrent matching requests against maxTriggers=1 yield exactly one
  activation (real-concurrency suites green; DB CHECK backstop).
- TTL: 15-minute arming TTL, lazy expiry at every hook; leakage check
  (`no live (unexpired) armed plan remains`) passed in both final
  verifier runs; disarm is best-effort in a `finally` AFTER the
  terminal write and never rewrites execution truth.
- Cross-run leakage: none across the four final verifier runs +
  showcase sessions (fresh IDs everywhere; leakage check clean).
- RESPONSE_TRUNCATION: commit-before-truncation proven (route-layer
  hook after `processDelivery` returns; headers with inflated
  Content-Length; body prefix; destroy mid-body); executor conservatively
  classifies REQUEST_SENT ⇒ INDETERMINATE (headers are not knowledge);
  Demo stays alive; budget exact; no valid success emitted (§32
  re-proven live).
- CRASH_MID_PROCESSING: zero response bytes after commit; same
  conservative classification; socket-level suite green (§31 proven
  by committed tests, not by fault name).
- One-faultKind-per-document validation in place (Phase 9 audit
  correction retained; unit suite green).

result = PASS

## 14. Evidence audit (§33–§39)

- Capture order: executor observes → invocation row → evidence sink
  (raw observation of actual observed bytes, redacted before hashing)
  → later normalization. Raw observation reflects reality (payload
  built from the ExecutorOutcome as-received), never from intent.
- Redaction (§34): header-level (Authorization/Cookie/Set-Cookie/
  proxy-authorization/provider-signature REMOVED), name-pattern deep
  masking, value-SHAPE masking (bearer/JWT/userinfo URLs) even under
  innocuous keys. Canary/secret-value scans of the durable stores:
  0 hits (final scan below).
- Redaction-before-bounding (§35): `redactBoundedText` parses and
  redacts the FULL raw text BEFORE any bounding; the REDACTED
  representation is then bounded; the unredacted-truncation path is
  gone (auditor-corrected Phase 4 property re-verified in source).
- Append-log concurrency (§37): per-run `pg_advisory_xact_lock`,
  gap-free chainIndex, prevContentHash linkage, head upsert —
  high-concurrency append proven by the accepted evidence suites
  (re-run green); no duplicate index, no lost observation.
- Idempotency (§38): provenance-tuple identity — same identity+content
  ⇒ one row; same identity+different content ⇒ explicit integrity
  conflict (never overwrite/alias). Concurrent P2002 race classified
  against the winner (verified in source).
- Capture failure (§39): evidence failure after execution never alters
  execution truth (honest incompleteness, logged); required-evidence
  invariants become NOT_EVALUABLE; no fake PASS/FAIL/Finding
  (dedicated integration test green).
- Integrity (§107-class attack): chain verifier detects stored-bytes
  modification — permanent test green (`snapshot-immutability` /
  evidence suites); detection (not prevention) is the documented claim.

result = PASS

## 15. Normalization / causality (§40, §41)

- Normalizer versions enumerated and explicit: invocation
  (`executor-invocation-normalizer`), lineage v2 (bumped from v1
  explicitly; `normalize.phase9-compat.test.ts` proves v1 fixtures
  keep v1 semantics), fault-status v1. Versions are part of the
  idempotency key — no silent reinterpretation possible.
- Causal relationships: every `addRelationship` requires exact
  identity-field equality in both payloads (providerPaymentId /
  providerEventId / deliveryAttemptId / processingAttemptId /
  financialEffectId) with basis `identity-direct`; the evaluator walks
  only `identity-direct` hops. Close timestamps never create
  causality (no timestamp-based link exists anywhere in `derive.ts`).

result = PASS

## 16. Invariant audit (§42–§46)

- INV-IZ-1 (v1 evaluator, pure): ≤1 accepted equivalent effect per
  confirmed payment; FAIL requires identity-chain attribution for
  every counted duplicate; insufficient attribution/completeness ⇒
  NOT_EVALUABLE. Adversarial matrix covered by unit + integration
  suites (one payment 0/1/2 equivalent effects, two separate payments,
  multiple wallets, different amount/currency/effect type — all
  green).
- INV-DF-1 BALANCE_CONSERVATION: whole-wallet reconciliation scope
  (target's own `walletLedgerCreditSumMinor` vs balance) — the
  one-payment-vs-whole-wallet fallacy is explicitly guarded (previous
  legitimate history preserved as PASS scope; reset isolates). PASS
  requires complete target-reported fields; missing ⇒ NOT_EVALUABLE.
- INV-DF-2 NO_NEGATIVE_BALANCE: every observed balance ≥ 0; missing
  evidence ⇒ NOT_EVALUABLE (not PASS). Large-integer amounts handled
  in exact bigint.
- Completeness (§43): evidence-withholding produces NOT_EVALUABLE —
  proven by the capture-failure suite and the attribution-gap paths.

result = PASS

## 17. Analysis / Finding audit (§47–§49)

- Concurrent analysis: unique-key idempotency (batch
  `(run, invariant, evaluatorVersion)`; evaluation
  `(run, invariant, version, subject, evidenceSetHash)`) + P2002
  tolerance; repeat/concurrent suites green ("converge without
  duplicates or conflicts").
- Hash stability: `computeEvidenceSetFingerprint` over sorted
  observation hashes + event input hashes + ids — canonicalized,
  deterministic; same evidence ⇒ same fingerprint.
- Finding rules: ONLY a FAILed INV-IZ-1 evaluation produces a Finding;
  PASS/NOT_EVALUABLE never do; timeout/409/connection-drop/fault
  activation/INDETERMINATE alone can never create one (evaluations are
  the sole input; transport-only evidence cannot satisfy attribution).
- Fingerprints: SHA-256 over the canonical semantic input tuple;
  no wall-clock, no random IDs in semantic identity (verified in
  `finding.ts`).

result = PASS

## 18. Timeline audit (§50, §51)

- Every entry kind enumerated (`TIMELINE_ENTRY_KINDS`, 18 values incl.
  the two Phase 9 fault kinds); each cites a typed durable source
  (`TIMELINE_SOURCE_KINDS`) with explicit `orderingBasis`
  (sequence / wall_clock / unordered_overlap) and `timeMeaning`.
- FAULT_PLAN_CONFIGURED vs FAULT_PLAN_ACTIVATED remain separate facts
  derived only from target-observed trigger accounting.
- Pagination (§51): keyset over the FULL composite sort key
  `(occurredAt, sourceKind, sourceId, entryKind)` via parameterized
  tuple comparison (§51 ties handled — verified in the controller);
  deterministic total order; the Phase 9 self-audit's unordered
  `findFirstOrThrow` over evaluations (risk noted there) was re-checked
  in `persistFinding` — the re-fetch is by the precise unique key
  (invariantEvaluationId + findingRuleVersion), not unordered, so no
  correction was needed.

result = PASS

## 19. Reproduction / comparison (§52–§54)

- ReproductionDefinition: derived ONLY from the frozen snapshot;
  credential REFERENCE names only; fault intent frozen (version, kind,
  activation, maxTriggers, waveStaggerMs); hash mismatch against an
  existing row refused (append-only). No claim that credentials or
  network conditions are historically frozen (docs match).
- Concurrency: `@@unique([runId])` + precise P2002 matching
  (`p2002.ts`) — no duplicate semantic reproduction; transaction state
  valid.
- Comparison: same-intent requirement enforced (snapshot content-hash
  equality; refusal is explicit `SNAPSHOT_MISMATCH` 403; self-comparison
  refused); deterministic latest-evaluation selection by
  (createdAt, id).

result = PASS

## 20. API audit (§55, §89–§93, §121–§123)

- Input validation: bounded pagination on every list route
  (`parseBoundedInt` / `parsePaging`: limits 1..200, non-negative
  offsets, malformed cursors ⇒ 400 INVALID_PAGINATION); UUID route
  params via `ParseUUIDPipe` (malformed IDs ⇒ structured 400, no stack
  trace); unknown enum query values cannot inject (cursor enum values
  validated against closed lists BEFORE raw SQL; `$queryRawUnsafe`
  strings contain no user input — parameters only; the canary scanner's
  table/column names are compile-time constants).
- Error handling: expected domain errors map to 400/404/409/403 with
  the documented envelope; Demo maps parse failures to 400/413 (never
  500); unexpected errors log redacted bounded detail and return a
  secret-free 500. Demo admin/inspection token confusion tested
  (§57): wrong-role tokens refused (`requireBearerToken` per-boundary;
  timing-safe digest comparison, unequal-length safe via fixed-length
  SHA-256 digests).
- IDOR/object isolation (§90): every run-scoped query filters by runId
  (`requireRun` + where clauses); a finding from run A under run B's
  route ⇒ 404 (`proof.runId !== runId` check verified in
  `findingDetail`).
- Method semantics (§122): Nest route decorators bind methods
  explicitly (GET read-only routes cannot mutate; POST/PUT/DELETE
  mutations refuse other verbs with 404/405-style framework refusal —
  no read endpoint performs a write, verified per-controller).
- Content-type (§123): Demo binds ONE raw-body-capturing JSON parser;
  malformed JSON ⇒ 400 TRANSPORT_INVALID; oversized ⇒ 413.
- CORS (§124): allowlist-based origin check, `credentials: false` —
  no wildcard-credentials combination (verified in `apps/api/main.ts`).

result = PASS

## 21. Secrets / cryptography (§56–§59, §110, §150)

- admin / inspection / signing secrets are distinct boundaries
  (Demo `auth.ts`); the golden verifier deliberately probes admin
  WITHOUT credentials (401 proves the route) and never prints values.
- HMAC = SHA-256 over the EXACT raw request bytes (raw-body capture
  bound to the parser that supplies it); re-serialized JSON, field
  reordering, whitespace changes all break the signature (accepted
  suites re-run green); missing/malformed/duplicate-header cases ⇒
  401/400 paths (suite-covered).
- Timing-safe comparison: `timingSafeEqual` over fixed-length SHA-256
  digests (equal-length always; unequal-length input safe because the
  digest length is constant).
- Canary matrix (§110/§150): DB durable stores scanned for
  credential-value-shaped strings and canary patterns — 0 hits
  (raw_observation, run_snapshot, forensic_timeline_entry, and the
  golden verifier's own 10-store canary scan which passed inside both
  final verifier runs); showcase manifest/sidecars contain only
  reference-form `Bearer ${credential.DEMO_ADMIN_TOKEN}` strings
  (snapshot-derived reference NAMES, permitted; no values); `.env`
  untracked; `.env.example` placeholders only.

result = PASS

## 22. Resource / process audit (§61–§63, §151)

- Normal shutdown: API/worker/Demo close DB pools and queue consumers
  on SIGINT/SIGTERM (verified in source; worker-startup suite green).
- Hard kill: verifiers own their child processes by PID, detect stale
  services, refuse unknown listeners (showcase probes the API for
  THIS session's run IDs before capturing), and never global-kill
  node.exe (source-verified `orchestrator.ts`).
- Final hygiene: no owned listeners remain (netstat clean for all
  service ports); no orphan verifier children; the one stale empty
  Playwright temp profile from an earlier session was identified
  (empty dir, not the user's live profile) and removed — zero remain;
  auditor scratch (logs, temp DBs, artifacts) deleted; `.artifacts/`
  was cleaned and is gitignored anyway.

result = PASS

## 23. Logging / observability (§64, §65, §128)

- Log redaction: the structured logger masks sensitive keys and
  credential-bearing URL strings pre-emission (`maskSensitiveFields`);
  telemetry events carry correlation IDs and classification only —
  unit-asserted no credential fields.
- Truth claims: operational log messages name operational events
  (`step.lifecycle`, `invocation.executed`, `fault.armed`,
  `reconcile sweep`); no business verdict ("payment duplicated") is
  claimed from transport signals — business truth lives only in
  deterministic evaluation/finding rows.
- Log injection: pino JSON serialization preserves structure for
  hostile strings (structured logger, single-line JSON events; test
  suite green).
- Durable truth boundary: telemetry writes no execution/evidence/
  analysis rows (ADR-0015; code-verified).

result = PASS

## 24. UI audit (§66–§73)

- Data access: browser code fetches only the API via
  `lib/api-client.ts` (`cache: 'no-store'`); no DB imports possible
  (lint-enforced); no `NEXT_PUBLIC_*` exists at all (grep clean) —
  no secret can be exposed through public env (§126).
- Run states: `runStateClass` covers CREATED/SNAPSHOT_PINNED/
  DISPATCHING/RUNNING/RECONCILING/COMPLETED/FAILED/CANCELLED with
  text labels (no impossible state label; unknown ⇒ neutral).
- sideEffectKnowledge: all four values first-class
  (`KNOWN_OCCURRED`/`KNOWN_ABSENT`/`INDETERMINATE`/
  `NOT_APPLICABLE`); INDETERMINATE rendered "effect unknowable",
  never collapsed (unit-tested).
- NOT_EVALUABLE: its own uncertain class — never styled/worded as
  PASS/FAIL/"no issues" (unit-tested; overview renders it as a
  verdict with its own badge and honest empty/error states).
- Evidence-integrity wording: "detects post-hoc modification … it is
  not tamper-proofing (evidence-model §4)" — the honest linked-hash
  description is on the page (verified; §70 clean; no inflated claims
  anywhere — grep-verified with negations reviewed).
- Error states: typed `ApiUnreachableError`/`ApiRequestError` render
  explicit error blocks; empty states state what is empty and why; no
  fake fallback data exists (§73; grep + source-verified).
- Large data (§71): observations/events sections render bounded
  server pages (API count fields + paginated timeline with keyset
  cursor); long IDs handled via `MonoValue`/`shortenId` with full
  values inspectable; no giant unbounded JSON freeze found.
- Accessibility (§72): semantic headings/tables (`scope="col"`),
  text labels accompanying every color-coded badge (state never
  carried by color alone), keyboard-navigable links (server-rendered
  anchors); no redesign performed — no genuine accessibility defect
  found in the representative pages reviewed.

result = PASS

## 25. Browser security (§125–§127, §120)

- XSS: no `dangerouslySetInnerHTML` anywhere (grep clean); hostile
  target-controlled strings would be React-escaped by default; the
  ProofJson renderer serializes values as text. The final showcase +
  browser suites render real fault-tainted data with zero console
  errors (§120: no console/page errors, no hydration errors, no
  unexpected failed requests — Phase 9 browser suite + showcase
  validation green).
- Caching: every page `force-dynamic`; no static generation of run
  truth (§125 verified per page).
- Build-time env: none public (§126 above).

result = PASS

## 26. Showcase audit (§74, §75)

- Fresh binding: the verifier is the sole execution truth (exit 0
  required); fresh run IDs every session (observed across three
  showcase sessions); content-gated captures assert this session's
  IDs before saving; provenance sidecars + manifest derive from the
  verifier only.
- Hash validation: PNG signature/dimensions/sha256 and ffprobe video
  validation passed, including a full `--video` run (H.264
  walkthrough composed and validated, exit 0).
- Output safety: output-path refusal outside `.artifacts/`,
  stale-MP4 removal, no unrelated deletion (`output-safety.ts`
  verified + unit suite green); corrupted-artifact rejection covered
  by unit tests (§75).
- Audit-scratch artifacts were removed from the working tree after
  proof (gitignored by design).

result = PASS

## 27. Dependency / supply chain (§76, §77)

- No duplicate major runtime stacks; runtime vs dev dependency split
  verified per package (showcase declares playwright/ffmpeg-static/
  ffprobe-static as production deps because it uses them at runtime —
  documented in `docs/showcase.md`).
- Known latent gap retained as a risk: `packages/demo-db/
  prisma.config.ts` imports `@rupturegrid/config` without declaring it
  (pre-existing at phase-8-accepted, resolves via pnpm workspace
  protocol in all canonical commands; recorded in the Phase 9 audit
  as risk 2). Not changed in Phase 10 (R-143 change minimization; a
  manifest-only edit would churn the lockfile without a correctness
  effect).
- Build scripts/binaries: ffmpeg-static/ffprobe-static ship binaries
  inside their packages (no postinstall download); Playwright browser
  binaries are NOT downloaded during install (docs + behavior
  verified); no unexpected lifecycle scripts observed in the lockfile
  for these packages (§77).

result = PASS (one documented non-blocking hygiene gap retained)

## 28. Portability / clean build (§78–§81, §135)

- No machine-specific paths in tracked source (`E:\`, `C:\`, `/Users/`,
  `/home/` grep: only a unit-test fixture string `HOME: '/home/
  someone'`, which is test data, not an assumption — accepted).
- Windows-safe path handling verified in practice (this entire audit
  ran on Windows: compose, migrations, verifiers, showcase, video).
  Cross-platform Node scripts use `node:child_process` spawn of
  `process.execPath` with no shell-specific syntax (verified).
- Clean-source build: Prisma generated clients are gitignored and
  regenerated by `pnpm db:generate` (part of build/typecheck);
  `pnpm build` regenerates and rebuilds everything from source — the
  audit's repeated full builds (each verifier invocation) prove no
  stale-dist dependency (§81/§135 satisfied by observed behavior;
  removing `dist/` is covered by `pnpm build`'s clean tsc emit each
  run).
- `.env` not tracked; `.env.example` contains documented non-production
  placeholders only (§83).

result = PASS

## 29. Test quality / isolation (§84–§86)

- **DEF-1 (P2, fixed in proof-of-cause; baseline flake):** one
  `pnpm verify` run failed inside `test:unit` during the baseline
  while two subsequent full runs passed. Root cause identified by
  repeated targeted runs: `packages/evidence/src/observation-
  identity.test.ts` registered a TIME-BUCKETED origin
  (`35000 + Date.now() % 900`) on the persistent shared dev DB and
  collided with a previously registered origin (global-unique origin
  authority ⇒ `TargetRegistrationError`). Reproduced once in 9
  full-suite runs (1 failed / 8 passed) — deterministic-on-collision,
  probabilistic-on-clock.
- **DEF-2 (P1, FIXED — same class, all four sites):** the
  time-bucketed-origin pattern existed in 4 test files
  (`observation-identity.test.ts`, `ownership.test.ts`,
  `execution-mechanics.test.ts`, `snapshot-immutability.test.ts` ×2
  sites). This is the same isolation weakness the Phase 9 audit
  recorded as "remaining risk" — Phase 10 eliminates it.
  - FIX: a `uniqueTestOrigin()` helper (shared harness + suite-local
    twin) that generates a random loopback port and VERIFIES
    non-registration against the authoritative `target_origin` table
    before use (bounded 16-attempt regeneration). The security
    property (global origin uniqueness) is untouched; only the tests'
    collision-prone generation changed. The identity suite's
    displayName was also made collision-free.
  - REGRESSION PROPERTY: origin registration itself remains
    adversarially tested (global-unique enforcement is production
    code and was NOT weakened).
  - RUNTIME RE-PROOF: previously-flaky file ×3 consecutive green;
    full unit 33 files 319/319; full integration 23 files 152/152
    after the fix; `verify` green.
- Serial vs parallel: integration suite is `fileParallelism: false`
  by documented design (shared-infrastructure coordination); unit
  suite parallel with no shared durable state.
- Weak tests (§85): reviewed the critical suites — assertions are
  semantic (counts, verdicts, states, hashes) rather than
  `toBeDefined`-only; no dead tests found; no test that cannot fail
  was identified in the audit scope.
- No "environmental" flake labels were accepted without evidence: the
  one remaining historical flake class from Phase 9 (load-timeout in
  `execution-mechanics.test.ts` under machine load) did not recur in
  this session's three full integration runs and has no code defect
  identified; it remains a documented watch item, not a masking.

result = PASS after fix

## 30. Performance sanity (§87, §131)

- Bounded pagination everywhere; timeline keyset (index-friendly
  tuple comparison); analysis loads run-scoped sets with selected
  columns only; the reconcile sweep is batch-bounded; evidence append
  is a single indexed transaction per observation.
- No N+1 detected in the critical paths reviewed (derivation reads
  run-scoped sets once; the derivation relationship walk is O(events×
  related-events) per run but events are per-run bounded by run
  budget — acceptable for v1 scale and not demonstrated as a real
  problem, so not "fixed" per §87).
- Large-evidence honesty: observation payloads bounded at capture
  (16k chars, redaction-aware), `truncated` flag honest; no unbounded
  endpoint returns an entire run blindly (list routes are paginated).

result = PASS (no demonstrated defect)

## 31. Cross-run isolation (§102–§105)

- Findings: run-scoped rows + run-scoped API filters (§90 check);
  global findings index carries runId per row. SQL re-verified on the
  final runs (each run's findings belong to it alone).
- Evidence / timeline / relationships: every query in the evidence/
  analysis/forensics packages filters `runId` (source-verified — no
  missing-runId query found); observation identity includes runId;
  timeline unique key includes runId.
- Reproduction: bound to (runId, snapshotId, snapshotContentHash);
  wrong-run resolution impossible via the run-scoped route.
- Faults: target-side plan state is keyed per faultKind with TTL and
  the verifier's leakage check proves no live plan remains across the
  full cross-scenario sequence (§101: IZ → CF → showcase(+IZ) → CF →
  IZ all executed in this session with fresh IDs and stable verdicts).

result = PASS

## 32. Incident Zero final proof (§117, §32)

Final repeat runs (both exit 0):

- Run A: VULNERABLE run `b88a284f-b2a4-4e18-82b3-c53397b00dae`
  (25/25), SECURE run `bbe6acc0-5f4d-491f-9082-fe07cb962eb6` (21/21),
  frozen intent 5/5.
- Run B (final): VULNERABLE run `1f0feec1-e95d-4fa4-be59-252eac534fde`
  (25/25) — INV-IZ-1 FAIL with exactly 1 Finding (SQL-verified);
  SECURE run `e86b1787-0968-48c7-8250-c59d37e2acec` (21/21) — 0
  Findings (SQL-verified); snapshots stable across repeats
  (`f3485caa5992…` / `60b724095130…`); evidence chains gap-free
  (lastChainIndex 24, observationCount 25, both runs); integrity
  verified inside the verifier (chain-valid asserted).

result = PASS

## 33. Controlled-fault final proof (§118, §33)

Final repeat runs (both exit 0):

- PRE_MUTATION_REJECTION ×2: runs `8abe48fd…` / `c7d63b4a…` and
  `11082a34…` / `8b657f32…` — 18/18 each; KNOWN_ABSENT on the
  faulted delivery (contract-guaranteed no-effect); 0 unsafe retries;
  0 Findings.
- RESPONSE_LOSS ×2: runs `dee19c8c…` / `3b9e5d4d…` and
  `c2e825b1-ff37-4e2b-a4a7-b63d4ee1bc79` / `1491c474-8e07-4600-a4cd-
  00ce9a3fa696` — 22/22 each; INDETERMINATE persisted (SQL-verified:
  exactly 2 INDETERMINATE invocations in the final runs); retries = 0;
  later inspection proves the committed effect; invocation knowledge
  never rewritten; leakage check clean in every run.

result = PASS

## 34. Full browser walk (§119, §34)

Executed via the accepted mechanisms in this session:

- showcase browser capture walked /runs, both runs' overview,
  VULNERABLE finding detail, timeline, evidence, and reproduction
  pages with per-page content assertions bound to this session's run
  IDs (10 screenshots, validation pass) — real Chromium, real Next.js.
- The Phase 9 browser suite (integration, green) additionally walks
  execution and fault-timeline views for both fault stories with
  console/hydration checks (§34's execution/coverage items).
- Comparison and experiments pages exist and are wired to the same
  typed API client (source-verified; comparison refused cross-intent
  at the API, proven by unit + controller tests).

result = PASS

## 35. Defects found

- **DEF-1** — severity P2 — area test isolation / CI truth —
  files `packages/evidence/src/observation-identity.test.ts` (+3
  sibling files) — defect: time-bucketed test origins collide on the
  persistent shared dev DB, producing non-deterministic suite
  failures (observed: 1 `verify` failure at baseline; 1/9 unit-run
  failure) — reproduction: repeat `pnpm test:unit` until
  `Date.now() % bucket` re-hits a registered origin — risk: false
  red suites erode trust in the gates (R-02-adjacent) — fix:
  DEF-2's fix — regression test: the suites themselves are the
  regression (they now verify non-registration before use); flake
  re-proof = 3 consecutive green targeted runs + full green suites —
  runtime re-proof: see §29.
- **DEF-2** — severity P1 (test-infra defect class; production code
  untouched) — area test isolation — files `tests/integration/
  helpers/execution-harness.ts` (+ `uniqueTestOrigin`), `tests/
  integration/ownership.test.ts`, `tests/integration/execution-
  mechanics.test.ts`, `tests/integration/snapshot-immutability.test.ts`
  (2 sites), `packages/evidence/src/observation-identity.test.ts` —
  defect: 4 files generated registration origins from clock buckets —
  reproduction: sustained repeated runs against the persistent DB —
  risk: intermittent false CI/local failures of exactly the kind the
  Phase 9 audit observed — fix: random + authoritative-collision-
  checked origin generation (bounded); displayName hardened in the
  identity suite — regression test: suites re-run green ×3 targeted +
  2 full suite runs post-fix — runtime re-proof: final gates all
  green (§40).

No P0 defects. No production-code defect was found in the audited
surfaces; the accepted Phase 3–9 guarantees re-proved live (§32/§33).

## 36. Security findings

- P0 = none. P1 = none. P2 = none.
- P3 = none new (documentation wording re-checked — no inflated
  claims found).
- Remaining blockers = none.

## 37. Reliability findings

- P0 = none. P1 = none in production code.
- P2 = DEF-1/DEF-2 (test-isolation; fixed — see §35).
- P3 = none new.
- Remaining blockers = none.

## 38. Documentation corrections

- None required. Cross-checked README, architecture, security
  boundaries, evidence model, controlled-faults, showcase, incident
  docs, roadmap, and all 15 ADRs against final source: no stale claim
  found in this audit (Phase 9's audit already corrected the earlier
  self-audit wording defects). The Phase 9 report's "remaining risks"
  item 1 (time-bucketed origin registrations) is now RESOLVED by this
  phase; this report records that.

## 39. Final test totals

- unit = 33 files, 319/319 passed (final gate run)
- integration = 23 files, 152/152 passed (306.08s final run)
- incident-zero = PASS ×2 post-fix (5/5, 25/25, 21/21 each)
- controlled-faults = PASS ×2 post-fix (80/80 each, leakage none)
- showcase = PASS ×3 sessions (10 screenshots each; validation pass)
- showcase-video = PASS (--video session: 10 screenshots + validated
  H.264 walkthrough, exit 0)

## 40. Final quality gates

- format = pass; lint = pass; typecheck = pass; unit = 319/319;
  integration = 152/152; build = pass; verify = exit 0.

## 41. Secret canary

- database = 0 hits (raw_observation / run_snapshot /
  forensic_timeline_entry scans for credential-value shapes)
- logs = none (redacting logger; telemetry unit-asserted)
- API = no secret material in any response surface (references only)
- browser = zero console errors; no secret rendered (content-gated
  captures)
- showcase = manifest contains only reference-form credential NAMES
  (snapshot-derived); no values
- result = CLEAN

## 42. Process hygiene

- listeners = none owned remaining (all service ports free)
- node processes = no orphan verifier/demo/worker children (verifier
  PIDs tracked and reaped by the tools themselves)
- browser = none left running; stale temp profile removed (0 remain)
- profiles = 0 temp Playwright profiles remain
- temporary DBs = all 4 auditor databases dropped (observed)
- scratch = logs/artifacts deleted; working tree contains only the
  intended source changes
- result = CLEAN

## 43. Phase preservation

- Phase 0 (architecture/docs) = intact (no doc drift found)
- Phase 1 (foundation/ownership lint boundaries) = intact
- Phase 2 (Demo target semantics) = intact (suites green)
- Phase 3 (execution engine) = intact (classification/fencing/limits
  unchanged; suites green)
- Phase 4 (evidence/invariants) = intact (chain, redaction, INV-IZ-1)
- Phase 5 (forensics) = intact (finding/timeline/reproduction rules)
- Phase 6 (UI) = intact (no UI change in this phase)
- Phase 7 (golden scenario) = PASS ×2 post-fix
- Phase 8 (showcase) = PASS ×3 incl. video
- Phase 9 (controlled faults) = PASS ×2 post-fix; catalog/gates
  unchanged
- result = PRESERVED (zero production-source changes in this phase;
  only test-isolation corrections)

## 44. Reports created

- full audit = `docs/reports/phase-10-full-audit.md` (this file)
- security audit = `docs/reports/phase-10-security-audit.md`
- reliability audit = `docs/reports/phase-10-reliability-audit.md`

## 45. Remaining risks (genuine, non-blockers)

1. `packages/demo-db/prisma.config.ts` imports `@rupturegrid/config`
   without a package.json declaration (pre-existing, workspace-
   resolved; documented in Phase 9 audit risk 2 — unchanged by design
   here).
2. `execution-mechanics.test.ts` load-timeout sensitivity under heavy
   machine load (historical, not reproduced in this session's three
   full integration runs; no code defect identified; bounded-wait
   design already correct).
3. Integration suite serial-by-design runtime (~5–6 minutes) is an
   accepted trade-off for shared-infrastructure coordination.
4. Derivation relationship construction is O(events × related-events)
   per run — fine at v1 experiment scale; revisit only if run sizes
   grow orders of magnitude.

## 46. Git

- branch = `phase-10-full-engineering-audit`
- files changed = 5 (all test-isolation fixes: harness + 4 call
  sites); reports added
- git diff --check = clean
- generated artifacts = none tracked (.artifacts/ gitignored; scratch
  removed)
- commit = NO; tag = NO; push = NO

## 47. Acceptance blockers

NONE

**STOP. Phase 11 not started. Nothing committed, tagged, or pushed.**
