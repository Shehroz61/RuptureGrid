# RuptureGrid v1.0 — Phase 2 Self-Audit (Builder's Report)

Date: 2026-09-09. Builder session. All Phase 2 changes are **uncommitted** on branch `phase-2-demo-fintech` (created from `phase-1-accepted` = `8527e24`), awaiting independent audit per ADR-0013. No commit, no tag, no push was performed.

Every operational number in this report was observed from actual command output or actual HTTP responses during this session. Where a claim could not be verified, it is not made.

## 1. Verdict (builder's)

**PHASE 2 READY FOR INDEPENDENT AUDIT.**

This is the builder's verdict only. Independent acceptance is deliberately not the builder's to give.

## 2. Starting checkpoint

| Item | Value |
|---|---|
| Repository | RuptureGrid v1.0 local checkout |
| Starting branch | `phase-1-foundation` |
| Phase 1 commit | `8527e24f42896514b15ddb38a9518586fb859697` (`8527e24`) |
| Phase 1 tag | `phase-1-accepted` (annotated tag object `c1c2359…` → commit `8527e24`; unsigned annotation, matching Phase 0 convention) |
| Phase 0 tag | `phase-0-accepted` (annotated tag object `4f6bcc8…` → commit `5058cf7`) |
| Starting working tree | CLEAN (verified with `git status` before any modification) |
| Phase 2 branch | `phase-2-demo-fintech` (created via `git switch -c phase-2-demo-fintech phase-1-accepted`) |

## 3. Environment

| Component | Version |
|---|---|
| OS | Windows (Git Bash toolchain) |
| Node.js | v22.23.1 |
| pnpm | 11.9.0 |
| Prisma CLI / client | 7.10.0 (unchanged from Phase 1) |
| Express (demo-fintech) | ^5.2.1 (unchanged from Phase 1 shell) |
| PostgreSQL (demo) | postgres:18 container, healthy throughout |

## 4. Scope

**Implemented (Phase 2 only):**

- Demo Fintech domain model + migration set (eight domain models + durable processing-mode settings).
- Real transactional wallet-credit financial effect (effect + ledger + balance atomic in one PostgreSQL transaction).
- Deterministic VULNERABLE and SECURE processing modes, target-owned, DB-backed, restart-durable.
- Provider webhook endpoint with HMAC-SHA256 authenticity over exact raw bytes.
- Provider simulator (canonical payment + two logical events + signed delivery envelopes).
- Target-owned admin API (reset, mode) with a distinct read-only inspection API.
- Permanent test suites: unit (money/keys/signature/payload/config) and integration (black-box Incident Zero both modes, DB domain semantics, all Phase 1 suites green).

**Explicitly not implemented (Phase 3+ hard non-scope, §24 verified):** experiment definitions, ExperimentRun/StepRun, HTTP target adapter, fault-injection engine, BullMQ experiment queue for experiments, durable run dispatch, execution leases, fencing-token runtime, reconciliation engine, RunSnapshot, RuptureGrid evidence records, normalized events, causal graph engine, invariant evaluation engine, findings, forensic timeline, reproduction engine, product dashboard, causal UI, AI, RuptureGrid authentication/orgs/RBAC/billing, production targeting. All verified absent by code search over `apps/` and `packages/` (searches for `Experiment`, `Finding`, `Invariant`, `RunSnapshot`, `fencing`, `lease` return no Phase 2 matches).

## 5. Domain model (Demo DB — target-owned)

Model names are exactly as in the schema (`packages/demo-db/prisma/schema.prisma`), all `@@map`ped to snake_case tables:

| Model | Table | Key business fields |
|---|---|---|
| Customer | `customers` | `customerReference` (unique), `createdAt` |
| Wallet | `wallets` | `customerId` FK, `currency` CHAR(3), `balanceMinor` BIGINT (CHECK ≥ 0), timestamps |
| ProviderPayment | `provider_payments` | `providerPaymentId` (unique), `walletId` FK, `amountMinor` BIGINT, `currency`, status enum `CONFIRMED`, `createdAt`/`confirmedAt` |
| ProviderEvent | `provider_events` | `providerEventId` (unique), `paymentId` FK, `eventType` enum (`PAYMENT_CONFIRMED` \| `PAYMENT_SETTLED`), `createdAt` |
| WebhookDelivery | `webhook_deliveries` | `deliveryAttemptId` (unique), `eventId` FK, `receivedAt`, status (`ACCEPTED` \| `FAILED_PROCESSING`), `sourceIp` |
| ProcessingAttempt | `processing_attempts` | `deliveryId` (unique FK), `startedAt`, `finishedAt`, `outcome` enum nullable (`APPLIED` \| `IDEMPOTENT_DUPLICATE` \| `FAILED`), `failureReason` |
| FinancialEffect | `financial_effects` | `financialEffectId` (unique), `paymentId` FK, `processingAttemptId` (unique FK), `walletId` FK, `effectType` (`WALLET_CREDIT`), `amountMinor` BIGINT, `currency` |
| LedgerEntry | `ledger_entries` | `financialEffectId` (unique FK), `walletId` FK, `entryType`, `amountMinor` BIGINT, `currency`, `idempotencyKey` **nullable unique**, `createdAt` |
| DemoSettings | `demo_settings` | single row `id='default'`, `processingMode` enum (`VULNERABLE` \| `SECURE`), `updatedAt` |

No Organization/User/Role/Session/AuditLog/Experiment/Evidence/Finding models exist in the Demo DB.

## 6. Database / migration

- **Migrations (Demo DB):** `0001_init_demo_database` (Phase 1, untouched), `20260909093622_phase2_domain_models` (Prisma-generated DDL), `20260909093718_phase2_domain_constraints` (hand-authored: `wallets_balance_nonnegative_check`, `financial_effects_credit_amount_positive_check`, `ledger_entries_credit_amount_positive_check`). Migration history is append-only; no accepted migration was edited. (`prisma migrate dev --create-only` + applied after authoring review; the applied migration was adjusted before its first successful apply — see §27.)
- **Constraints:** unique indexes on `customers.customerReference`, `provider_payments.providerPaymentId`, `provider_events.providerEventId`, `webhook_deliveries.deliveryAttemptId`, `financial_effects.financialEffectId`, `financial_effects.processingAttemptId`, `ledger_entries.financialEffectId`, `ledger_entries.idempotencyKey` (nullable-unique), `processing_attempts.deliveryId`; FKs for every causal relation; CHECK constraints above. Verified present via `pg_indexes`/`pg_constraint` queries in `tests/integration/demo-db-domain.test.ts`.
- **Indexes:** the unique indexes above plus single-column lookup indexes on `wallets.customerId`, `provider_payments.walletId`, `provider_events.paymentId`, `webhook_deliveries.eventId`, `financial_effects.paymentId`, `financial_effects.walletId`, `ledger_entries.walletId`. No speculative indexes.
- **Control DB changes:** none (verified: `git diff phase-1-accepted --name-only -- packages/control-db` is empty; no Control migrations added).
- **db push:** not used anywhere; no `db push` in any script; migrations applied via `prisma migrate dev` / `prisma migrate deploy`.
- **Clean-database proof:** the Demo `public` schema was dropped (all 17 objects) and `prisma migrate deploy` re-applied all 3 migrations successfully (`_prisma_migrations` = 3 rows re-created).

## 7. Money

- **Representation:** exact integers (`bigint` in application code, PostgreSQL `BIGINT` in storage). HTTP DTO representation is a canonical **decimal integer string** (`"amountMinor": "500000"`), documented in README and validated by `parseAmountMinor`.
- **Canonical amount:** 500000 paisa = PKR 5,000 (`CANONICAL_PAYMENT_AMOUNT_MINOR = 500000n`, asserted in tests). Two credits = 1000000 paisa.
- **Currency:** `PKR` (`CHAR(3)` columns, explicit everywhere; payload validation accepts PKR only).
- **Fraction handling:** `parseAmountMinor` rejects fractions, signs, whitespace, exponent notation, leading zeros, non-string values, and magnitudes > 2^53−1 — never rounds, never coerces (unit-tested exhaustively).
- **HTTP serialization:** explicit DTO mappers (`apps/demo-fintech/src/dto.ts`) convert bigint → string via `bigintToString` (envelope-checked). No `JSON.stringify` is ever called on a raw BigInt; no global BigInt prototype patching exists. All inspection/webhook responses are explicit DTOs.

## 8. Identity model

All five identities are distinct named columns in distinct tables (never a generic `eventId`):

| Identity | Lives in | Assigned by | Uniqueness |
|---|---|---|---|
| `providerPaymentId` | `provider_payments.providerPaymentId` | provider simulator (caller-side) | DB-unique |
| `providerEventId` | `provider_events.providerEventId` | provider simulator (caller-side) | DB-unique |
| `deliveryAttemptId` | `webhook_deliveries.deliveryAttemptId` | the executor/test harness, per physical request, carried in header `x-rupturegrid-delivery-attempt-id` | DB-unique (409 on reuse) |
| `processingAttemptId` | `processing_attempts.id` (UUID) | Demo Fintech | internal PK, one per delivery |
| `financialEffectId` | `financial_effects.financialEffectId` | Demo Fintech (`fe-<32 hex>`) | DB-unique |

Relation chain (all FK-backed, verified by the lineage test): `financial_effects.processingAttemptId → processing_attempts.deliveryId → webhook_deliveries.eventId → provider_events.paymentId → provider_payments`. `FinancialEffect` additionally carries denormalized `paymentId`/`walletId` FKs for direct attribution.

## 9. Vulnerable mode

- **Business bug:** idempotency scope is the logical provider **event** instead of the logical payment — "each event is idempotent" is technically true and business-wrong. Ledger key: `wallet-credit:event:<providerEventId>:<walletId>`.
- **Idempotency scope:** event-level (duplicate deliveries of the SAME event are suppressed; two semantically related events of one payment each create an accepted credit).
- **Why deterministic:** the outcome depends only on which idempotency keys already exist in PostgreSQL (unique index), never on timing or interleavings. Under any schedule, each event's first insert wins; both events' keys are distinct by construction.
- **Actual canonical result (observed 4×, §16):** 1 payment, 2 events, 20 deliveries, 20 processing attempts, APPLIED=2, IDEMPOTENT_DUPLICATE=18, 2 financial effects, 2 ledger entries, wallet 1000000 paisa, reconciliation diff 0.

## 10. Secure mode

- **Idempotency scope:** payment-level business scope — `wallet-credit:payment:<providerPaymentId>:<walletId>`.
- **Database enforcement:** PostgreSQL unique index `ledger_entries_idempotencyKey_key` inside the financial transaction; a losing concurrent insert raises P2002, the transaction rolls back entirely, and only the idempotency-key violation maps to `IDEMPOTENT_DUPLICATE` (precise constraint inspection in `applyWalletCreditFinancialEffect`). No application mutex, no balance/timestamp/amount heuristics.
- **Actual canonical result (observed 4×, §17):** 20 deliveries, 20 processing attempts, APPLIED=1, IDEMPOTENT_DUPLICATE=19, 1 financial effect, 1 ledger entry, wallet 500000 paisa, reconciliation diff 0.

## 11. Provider simulator

- **Route:** `POST /demo/provider/payments` (marked DEMO/DEVELOPMENT ONLY in code and README).
- **Authentication:** `Authorization: Bearer <DEMO_ADMIN_TOKEN>` (privileged demo setup, §59).
- **Payment creation:** one logical payment, PKR 500000 paisa, status `CONFIRMED`, attached to the canonical wallet.
- **Event creation:** exactly two logical events — `PAYMENT_CONFIRMED` and `PAYMENT_SETTLED` (semantically believable labels per §113).
- **Signature generation:** per-event HMAC-SHA256 (hex) over the canonical JSON of the returned payload, using the same secret the webhook verifies. It does **not** assign `deliveryAttemptId` (§29) — each physical delivery's identity is supplied by the caller.

## 12. Webhook

- **Route:** `POST /webhooks/provider`.
- **Delivery-attempt header:** `x-rupturegrid-delivery-attempt-id` — required, format-validated, persisted, echoed in responses.
- **Signature validation:** HMAC-SHA256 over the EXACT raw request bytes (`x-rupturegrid-provider-signature`), timing-safe comparison; raw bytes captured via Express 5's `json({ verify })` (verified against current body-parser docs — a single global parser captures rawBody; a route-level second parser would be skipped by body-parser's already-parsed guard).
- **Payload validation:** strict rejection (never coercion) of fractional/zero/negative/unsafe amounts, non-PKR currency, unknown event types, malformed identities — before any business resolution.
- **Success response:** `200 {deliveryAttemptId, processingAttemptId, outcome: "APPLIED", financialEffectId, providerEventId, providerPaymentId}`.
- **Duplicate response:** `200 {…, outcome: "IDEMPOTENT_DUPLICATE", financialEffectId: null}` — a successful duplicate-suppression response (§41).
- **Error behavior:** missing/malformed header → 400 `TRANSPORT_INVALID`; bad/missing signature → 401 `PROVIDER_AUTHENTICATION_FAILED`; unknown event/payment → 404 `NOT_FOUND`; identity/amount/event-type mismatch → 409 `BUSINESS_MISMATCH`; reused `deliveryAttemptId` → 409 `DUPLICATE_DELIVERY_ATTEMPT_ID`; internal failure → 500 `PROCESSING_FAILED`/`INTERNAL_ERROR` with no stack traces, SQL, or secrets.

## 13. Admin interface

- **Reset:** `POST /demo/admin/reset` — one transaction deletes all Phase 2 business records (children → parents), resets mode to VULNERABLE, recreates the canonical customer + zero-balance PKR wallet; returns the baseline DTO. Operates only on the Demo Target's own database; no generic SQL.
- **Mode switching:** `PUT /demo/admin/mode` with `{"mode":"VULNERABLE"|"SECURE"}`; `GET /demo/admin/status` exposes the current mode (§107).
- **Authorization:** `DEMO_ADMIN_TOKEN` bearer; timing-safe comparison; missing/wrong token → 401.
- **Durability:** mode is a row in `demo_settings` — verified to survive a real process restart (manual runtime check: SECURE survived kill + relaunch).

## 14. Inspection interface

- **Routes:** `GET /inspection/provider-payments/:providerPaymentId` (full lineage), `GET /inspection/wallets/:walletId/reconciliation` (exact balance-vs-ledger integers).
- **Authorization:** `DEMO_INSPECTION_TOKEN` bearer only; the admin token is NOT valid on inspection routes and the inspection token is NOT valid on admin routes (both tested).
- **Read-only guarantee:** the service performs only Prisma reads (`findUnique`/relation includes); no write path exists in `inspection-service.ts`.
- **Entities exposed:** payment, events, deliveries, processing attempts, financial effects, ledger entries, wallet — with convenience counts (entities are the truth, counts are convenience). Suppressed attempts remain visible (`IDEMPOTENT_DUPLICATE` outcomes).
- **Causal lineage support:** the response carries all five identities with FK-backed relations, deterministic ordering (§36), and the current processing mode. No invariant verdicts are ever produced (§120).

## 15. Transactionality

- **Financial transaction:** `applyWalletCreditFinancialEffect` runs one `db.client.$transaction` creating FinancialEffect + LedgerEntry + wallet increment; any error rolls back all three.
- **Idempotency conflict behavior:** the P2002 for the ledger idempotency key propagates out of the transaction (guaranteeing full rollback) and is mapped to `IDEMPOTENT_DUPLICATE` only afterwards; other unique violations remain failures. This ordering is deliberate: catching-and-returning inside the callback would COMMIT a partial transaction (orphan effect).
- **Rollback evidence:** DB-domain test proves a failing transaction leaves zero effects, zero ledger entries, and an unchanged balance; the concurrent test proves exactly one APPLIED + one IDEMPOTENT_DUPLICATE with one effect/one entry/one increment.
- **Wallet/ledger consistency:** `balanceMinor = Σ accepted WALLET_CREDIT ledger entries` asserted exactly (`differenceMinor === "0"`) after every canonical scenario, in both modes.

## 16. Canonical Vulnerable Scenario (actual measured values)

- payment count = 1
- event count = 2 (`PAYMENT_CONFIRMED`, `PAYMENT_SETTLED`)
- delivery count = 20 (10 per event, distinct `deliveryAttemptId`s)
- configured concurrency = 8
- measured concurrency = 8 (maximum in-flight HTTP operations, client-side atomic counter, test evidence)
- processing attempts = 20
- APPLIED = 2
- IDEMPOTENT_DUPLICATE = 18
- financial effects = 2 (500000 paisa each, same wallet, WALLET_CREDIT)
- ledger entries = 2 (event-scoped keys)
- wallet balance = 1000000 paisa
- HTTP results = all 20 deliveries `200` with explicit `outcome` fields
- repeatability runs = the canonical-scenario suite executed 4 times in this session (initial run + 3 dedicated re-runs) with identical outcomes; plus 2 further full-scenario runtime checks through real TCP HTTP, also identical

## 17. Canonical Secure Scenario (actual measured values)

- payment count = 1
- event count = 2 (same semantics, same workload)
- delivery count = 20
- configured concurrency = 8
- measured concurrency = 8
- processing attempts = 20
- APPLIED = 1
- IDEMPOTENT_DUPLICATE = 19 (all persisted and inspectable)
- financial effects = 1 (500000 paisa)
- ledger entries = 1 (key `wallet-credit:payment:<providerPaymentId>:<walletId>`)
- wallet balance = 500000 paisa
- HTTP results = all 20 deliveries `200` (suppressed ones explicitly `IDEMPOTENT_DUPLICATE`)
- repeatability runs = identical suite re-run evidence as §16

## 18. Two Legitimate Payments

- payments = 2 (both PKR 500000, same canonical wallet, distinct `providerPaymentId`s, SECURE mode)
- accepted effects = 1 per payment (2 total)
- wallet result = 1000000 paisa, reconciliation diff 0
- idempotency collision = none (distinct payment-scoped keys asserted; no wallet-global suppression)

## 19. Causal Lineage

- effect → processing: `financial_effects.processingAttemptId` FK (unique)
- processing → delivery: `processing_attempts.deliveryId` FK (unique)
- delivery → event: `webhook_deliveries.eventId` FK
- event → payment: `provider_events.paymentId` FK
- timestamp inference used = **NO** (lineage test walks identities only; timestamps order lists for display, never infer causality)

## 20. Tests

- unit files = 6 (`tests/unit/config.test.ts`, `tests/unit/redaction.test.ts`, `packages/demo-db/src/money.test.ts`, `keys.test.ts`, `signature.test.ts`, `webhook-payload.test.ts`)
- unit tests = 83 passing
- integration files = 9 (7 Phase 1 + `demo-incident-zero.test.ts` + `demo-db-domain.test.ts`)
- integration tests = 72 passing
- black-box HTTP = yes — flagship suites spawn the real process and use real TCP `fetch` only
- real PostgreSQL = yes — both suites; no SQLite, no mock DB anywhere
- real concurrency = yes — semaphore-bounded overlapping requests; measured max in-flight = 8 (≥2 required)
- signature tests = valid/invalid/missing/tampered-after-signing (binds payload content) + secret-mismatch
- security tests = admin/inspection denial matrices, token non-interchangeability, unknown-payment 404, no-residue-after-rejection
- atomicity tests = failed transaction leaves zero residue; concurrent losing insert leaves zero residue
- actual result = 83/83 unit, 72/72 integration, all green; Incident Zero suites re-run 3× consecutively with identical outcomes

## 21. Phase 1 Regression

- existing tests = 7 Phase 1 integration files (25 tests) + 2 Phase 1 unit files — all still passing
- health = API/Demo/Web health suites green (Demo semantics unchanged: liveness process-only, readiness Demo PG only)
- queue = Redis/BullMQ round-trip suite green
- Control DB = connectivity/ownership/migration suites green
- API = health suites green (no API source changed)
- Worker = startup/fail-fast suites green (no worker source changed)
- Web = production-build/health suites green (no web source changed)
- result = full `pnpm test:integration` 72/72; full `pnpm verify` chain green

## 22. Quality Gates (actual command outcomes)

| Gate | Command | Result |
|---|---|---|
| format:check | `pnpm format:check` | PASS (after `pnpm format`; 9 new files reformatted) |
| lint | `pnpm lint` | PASS (all workspace projects; boundary probes re-verified then reverted) |
| typecheck | `pnpm typecheck` | PASS (incl. from deleted generated-client state) |
| unit | `pnpm test:unit` | PASS 83/83 |
| integration | `pnpm test:integration` | PASS 72/72 |
| build | `pnpm build` | PASS (all workspace projects incl. `next build`) |
| verify | `pnpm verify` | PASS (chained) |
| compose | `docker compose config --quiet`; `infra:up` state | PASS (3 services healthy) |
| migrations | `pnpm db:migrate` | PASS ("No pending migrations"; clean-DB re-apply proven) |
| clean-generation | deleted `packages/{demo-db,control-db}/src/generated` → `pnpm typecheck`/`pnpm build`/`pnpm test:*` | PASS (regenerated from scratch by the commands) |

## 23. Runtime Verification (actual)

- Demo started = yes, real process on port 3199 (`node apps/demo-fintech/dist/main.js`)
- live = `200 {"status":"live","service":"demo-fintech"}` (observed)
- ready = `200 {"status":"ready",…,"checks":{"demoPostgres":"ok"}}` (observed)
- vulnerable flow = reset → mode → simulator → 2 signed deliveries → inspection: 2 effects, balance 1000000 (observed)
- secure flow = reset → mode SECURE → simulator → 2 signed deliveries → inspection: 1 APPLIED + 1 IDEMPOTENT_DUPLICATE, balance 500000 (observed)
- inspection = lineage + reconciliation endpoints verified read-only with the inspection token
- security probes = bad signature 401, duplicate deliveryAttemptId 409, missing/wrong tokens 401, inspection-token-on-admin 401 (observed)
- restart durability = mode SECURE survived real kill + relaunch (observed)
- shutdown = SIGTERM → clean exit; server log shows shutdown; no orphan processes (verified via repeated kill + process checks)
- full canonical concurrent runtime check = §16/§17 values, run twice per mode through real TCP HTTP

## 24. Phase Boundary Audit

experiment engine = ABSENT · run models = ABSENT · fault injection = ABSENT · leases = ABSENT · fencing runtime = ABSENT · reconciliation = ABSENT · RunSnapshot = ABSENT · RuptureGrid evidence = ABSENT · invariant engine = ABSENT · findings = ABSENT · timeline = ABSENT · AI = ABSENT · product UI = ABSENT.

(Verified by code search for `Experiment|RunSnapshot|fencing|lease|Finding|Invariant|reconciliation` over `apps/` and `packages/` — no Phase 2 matches. The target only exposes truth; interpretation belongs to later phases.)

## 25. Files Created / Modified

- **packages/demo-db:** `prisma/schema.prisma` (domain models), `prisma/migrations/20260909093622_phase2_domain_models/`, `prisma/migrations/20260909093718_phase2_domain_constraints/`, `src/index.ts` (client + financial transaction), `src/{money,bigint-safe,identifiers,keys,signature,webhook-payload}.ts` (+4 unit-test files).
- **apps/demo-fintech:** `src/{app,main,errors,auth,raw-body,dto,admin-service,provider-simulator-service,webhook-processing-service,inspection-service}.ts` (main.ts rewritten; rest new).
- **packages/config:** `src/schemas.ts` (three demo credentials added to `demoConfigSchema`).
- **tests:** `integration/helpers/{env,demo-harness}.ts`, `integration/demo-incident-zero.test.ts`, `integration/demo-db-domain.test.ts`, `unit/config.test.ts` (demo-credential coverage).
- **Root:** `.env.example` (three documented non-production demo credentials), `README.md` (Phase 2 status/routes/money/env documentation).
- **Unmodified:** all accepted Phase 0 docs, AGENTS.md, all ADRs, `apps/api`, `apps/worker`, `apps/web`, `packages/control-db`, `packages/queue`, `packages/shared`, `packages/logger`, Phase 1 migrations, `compose.yaml` (verified via `git diff phase-1-accepted --name-only`).

## 26. Dependencies Added

- **Production:** none. HMAC uses Node's built-in `node:crypto`; raw-body capture uses Express 5's existing body-parser `verify` option; no new runtime packages.
- **Development:** none.

(Phase 2 was implemented entirely with the Phase 1 dependency set — §91/§92 satisfied.)

## 27. Self-Audit Findings (defects found and fixed during this session)

| # | File | Defect | Fix |
|---|---|---|---|
| F-01 | `packages/demo-db/src/index.ts` (first draft) | The P2002 idempotency conflict was caught INSIDE the `$transaction` callback and returned as a normal result — the transaction would COMMIT, leaving an orphan FinancialEffect with no ledger entry/balance increment | Restructured: the conflict propagates out of the transaction (PostgreSQL rolls back everything) and is mapped to `IDEMPOTENT_DUPLICATE` only afterwards; DB test now proves zero residue |
| F-02 | `apps/demo-fintech/src/app.ts` (first draft) | Two JSON parsers: a global `express.json()` followed by a route-level parser with `verify` — body-parser's already-parsed guard would skip the second, so `rawBody` would never be captured and every webhook would 401 | Single global `express.json({ limit, verify: captureRawBody })`; webhook route reads the captured bytes; verified live end-to-end |
| F-03 | `apps/demo-fintech/src/provider-simulator-service.ts` (first draft) | Referenced a nonexistent `db.signingSecret`; contained a misplaced mid-file import and an awkward `void`-ed import | Rewritten as a factory taking `{ db, signingSecret }`; wiring in `main.ts` passes the validated config value |
| F-04 | `apps/demo-fintech/src/webhook-processing-service.ts` (first draft) | Draft contained a garbage object field and no happy-path return (caught during self-review before commit of thought, not after a test failure) | Rewritten cleanly; full flow verified by smoke test and suites |
| F-05 | `packages/demo-db/prisma/migrations/20260909093718_…` | First authored version used subquery CHECK constraints for cross-table currency agreement — PostgreSQL rejects subqueries in CHECKs (error 0A000 observed) | Removed the invalid constraints (currency agreement holds by construction: amount/currency are copied exclusively from the stored payment, never from payloads — enforced in `webhook-processing-service` and proven by mismatch tests); valid same-row CHECKs retained. The file was fixed before its first successful apply; no accepted history was edited |
| F-06 | `apps/demo-fintech/src/inspection-service.ts` (first draft) | Not-found paths returned `undefined as never` instead of an error | Replaced with `NotFoundError` (404), tested |
| F-07 | `tests/integration/helpers/demo-harness.ts` | Dead `seq` variable; destructuring removed `baseUrl` still used in `call()` → 5 test failures | Fixed; full suite green afterwards |
| F-08 | `tests/integration/demo-incident-zero.test.ts` | Two test bugs: lineage test looked up attempts via the wrong map; reused-delivery test used an id that didn't match the earlier one (wrong pad width). One expectation bug: foreign currency is rejected at transport layer (400, §56) before business resolution, so 409 was the wrong assertion | Tests corrected to assert the real contract (rejection with zero residue); app behavior verified correct in all three cases |
| F-09 | `pnpm format:check` | 9 new Phase 2 files failed Prettier | `pnpm format` applied; gates re-run green |

## 28. Deliberate Deferrals (Phase 3+)

- RuptureGrid executor/provider simulation **of record** (Phase 2's simulator is target-owned demo setup; RuptureGrid will act AS the provider with its own executor and evidence capture).
- Delivery-attempt overlap visualization, forensic timeline, invariant evaluation (INV-IZ-1 as an engine), findings — Phases 4–5.
- Timeout/crash/worker-race Incident Zero variants — Phase 9 (the mode semantics already support them).
- Inspection pagination/scaling, observation adapters — Phase 4+, only if needed.

## 29. Remaining Risks (non-blocking)

1. **Concurrent-delivery scheduling is real, not scripted:** under sustained overlap the boundary between "concurrent" and "sequential" is timing-dependent; determinism of the *business outcome* is guaranteed by the idempotency keys (proven 4×/mode), but individual request interleavings vary by design (per incident-replay.md §5).
2. **`req.ip` is trusted from the socket** for `sourceIp`; fine for a local demo target, would need proxy-awareness before any non-local deployment (out of Phase 2 scope by design — the target is local/authorized-test only).
3. **Prisma 7 remains a young major** (Phase 1 risk carried forward); the migration workflow and generated-client regeneration were re-verified this phase.
4. **Foreign containers from a different project** still occupy 5433/5434 on this machine (documented in Phase 1); unaffected and untouched.

## 30. Phase 0 / Phase 1 Preservation

- accepted Phase 0 docs changed = **NO** (`git diff phase-1-accepted -- docs/ AGENTS.md` is empty; markdown excluded from Prettier since Phase 1)
- Phase 1 ownership rules changed = **NO** (`eslint.config.mjs` untouched; both boundary directions probed live and reverted)
- Phase 1 infrastructure regressions = **NONE** (all Phase 1 suites green; API/Worker/Web/Control-DB sources untouched; compose unchanged)

## 31. Git

- branch = `phase-2-demo-fintech` (from `phase-1-accepted`)
- files changed = 8 modified + 26 new = 34 files, 4200 insertions / 57 deletions — fully visible via `git add -N .` + `git status --short -uall`/`git diff --stat`
- `git diff --check` = clean (no whitespace errors)
- commit = **NO** · tag = **NO** · push = **NO**

## 32. Acceptance Blockers

**NONE** (builder's assessment). The branch is submitted for independent Phase 2 audit.
