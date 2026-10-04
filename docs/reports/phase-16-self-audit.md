# Phase 16 Self-Audit — Demo Commerce Target + ADR-0024 Runtime

Session: Phase 16 builder on branch `main` (starting HEAD `6052a5d917f2e8213360f9701c228dadabe2a339`
= "docs: freeze pre-Phase 16 credential authorization"). Uncommitted by
phase-boundary design. Every number in this report was observed in a
terminal in this working tree during this session; nothing is claimed
that was not run.

Starting-state proof (run at session start and re-verified at end):

- `git rev-parse HEAD` → `6052a5d917f2e8213360f9701c228dadabe2a339`
- `git log -1 --oneline` → `6052a5d docs: freeze pre-Phase 16 credential authorization`
- `git rev-parse 'phase-15-accepted^{commit}'` → `1a926d82000b8a03ec83dd5ec188ac7cfa6deecd`
- `git diff --cached` → empty; `git status --short` → only Phase 16 changes.
- No commit, stage, tag, push, or release was performed.

## A. Pre-flight and contracts read

Pre-flight passed fail-closed (HEAD, tag, clean-except-Phase-16 tree,
nothing staged). Read before implementation: `AGENTS.md`,
`docs/product-spec.md`, `docs/architecture.md`,
`docs/security-boundaries.md`, `docs/evidence-model.md`,
`docs/testing-strategy.md`, `docs/engineering-rules.md`,
`docs/incident-replay.md`, `docs/phase-roadmap.md`,
`docs/checkout-zero.md`; ADR-0002, ADR-0004, ADR-0008, ADR-0010,
ADR-0011, ADR-0012, ADR-0014, ADR-0016, ADR-0017, ADR-0018, ADR-0020,
ADR-0021, ADR-0022, ADR-0023, and **ADR-0024** (the accepted-but-not-yet-implemented
contract this phase implements).

## B. P16-A — ADR-0024 runtime implementation

- `EXECUTOR_CREDENTIAL_REFS` (deployment capability vocabulary) now
  contains four names: `DEMO_ADMIN_TOKEN`, `DEMO_INSPECTION_TOKEN`,
  `DEMO_PROVIDER_SIGNING_SECRET`, `DEMO_COMMERCE_SIGNING_SECRET`.
  It still authorizes nobody by itself.
- `EXECUTOR_SIGNING_CREDENTIAL_REFS` is the platform-owned, explicitly
  enumerated signing-capable **subset** (`DEMO_PROVIDER_SIGNING_SECRET`,
  `DEMO_COMMERCE_SIGNING_SECRET`). No name heuristic exists anywhere:
  the classification is a literal, explicitly-enumerated platform list
  (no `contains SIGNING`/prefix/suffix/first-ref/environment-scan
  logic), proven behaviorally by the signing-classification and
  two-stage-binding unit tests, and reinforced by the engine
  target-agnostic source guard in
  `packages/engine/src/credential-authorization.test.ts` (which asserts
  no engine source line carries a Commerce-specific constant or
  branch). A configuration where the subset escapes the allowlist fails
  startup fast (unit-tested).

  *Correction (this repair): an earlier revision of this report claimed
  "a source-level test scans the engine for `SIGNING`-substring logic".
  No such test exists; the actual guard and behavioral tests are as
  described here.*
- Grant representation (smallest honest form): one env-seeded JSON
  object, `TARGET_ORIGIN_CREDENTIAL_GRANTS`, mapping **normalized
  origin → credential reference NAMES only** — parsed and validated by
  `packages/config/src/schemas.ts` (`parseTargetOriginCredentialGrants`),
  secret-free, fail-closed on empty, invalid grants or stale ref names
  fail configuration validation.
- Authorization principal: the normalized target origin authority
  (never `displayName`). Multi-origin rule: **intersection** — a ref
  must be granted for every registered origin.
- Enforcement points (all server-owned, all fail-closed, all before any
  durable write): target registration
  (`registerTarget`, `packages/engine/src/target.ts` — deny-by-default
  policy parameter), new-snapshot/run derivation
  (`createExperiment` / `createRun`), and pre-send resolution
  (`createCredentialResolver` in `step-processor.ts`).
- Signing binding: two-stage — Stage 1 authorization (grants), Stage 2
  `resolveSignatureCredentialBinding` requires exactly one authorized,
  declared, signing-capable ref when `signatureHeader` is present; the
  ref is frozen as `signatureCredentialRef` in the run snapshot.
- Historical compatibility: policies with header present + ref absent
  resolve `PHASE13_HISTORICAL_SIGNING_REF` (`DEMO_PROVIDER_SIGNING_SECRET`)
  at execution; stored snapshot bytes are never rewritten.
- Generic resolver: `createCredentialResolver` is ref-name-driven with
  no target-specific branch and no engine-known Commerce constant.
- New modules: `packages/engine/src/credential-authorization.ts`
  (`TargetOriginCredentialPolicy`, `CredentialAuthorizationError` with
  bounded name-only issues, `DENY_ALL_TARGET_ORIGIN_CREDENTIAL_POLICY`).

## C. P16-B/C/D/E — Demo Commerce target

- App: `apps/demo-commerce` (Express 5, own process, own port,
  `SERVICE_NAMES.demoCommerce`), files: `src/{raw-body,inspection-service,
  admin-service,checkout-service,app,main,errors,auth}.ts`.
- Database: `packages/commerce-db` — its own Prisma schema, own client
  factory, own shadow-URL config; **10 tables**
  (`commerce_settings`, `verification_scopes`, `skus`,
  `checkout_intents`, `checkout_events`, `request_attempts`,
  `processing_attempts`, `orders`, `reservations`,
  `commerce_fault_plans`).
- Isolation: physically separate PostgreSQL service
  `commerce-postgres` (port 5445, db `demo_commerce`, own credentials)
  in `compose.yaml`; no RuptureGrid app or package imports
  `commerce-db` (eslint boundary in `eslint.config.mjs`, asserted by
  config tests: no `COMMERCE_*` credential in any app config).
- Migrations (R-12, schema history is the authority):
  `20261002_phase16_commerce_domain` and
  `20261003_phase16_scoped_logical_identity` — both deploy with
  **"No pending migrations to apply"**.
- Identity model (physical, one-row-per-physical-request): logical
  checkout intent identity is `(scopeId, checkoutIntentId)` scoped
  unique; physical request identity is the executor delivery-attempt
  header `x-rupturegrid-delivery-attempt-id` recorded verbatim as
  `requestAttemptId`; plus `processingAttemptId`, `orderId`,
  `reservationId`, `sku` resource identity. Scoped event identity
  `CE-<scopeToken>-<checkoutIntentId>` with one event row per intent.
- Admin API: target-owned routes (mode, reset, fault arm/disarm/status)
  server-side gated by `COMMERCE_ADMIN_TOKEN`. Inspection API:
  read-only, credential-free (no inspection token exists — generic
  inspection contract), 11 literal request paths (ADR-0022).
- Controlled faults: `controlled-fault/v1` hooks live in the target's
  own route layer on the manifest-declared surface
  (`/checkout/submit`, kinds `PRE_MUTATION_REJECTION`,
  `CRASH_MID_PROCESSING`, `RESPONSE_TRUNCATION` — no new kind).
- Processing modes: `VULNERABLE` / `SECURE` as durable target state,
  switchable without reset.
- Manifest: `apps/demo-commerce/target-manifest.json` —
  `target-manifest/v1`, contract `GENERIC_HTTP`, signature header
  `X-Commerce-Signature`, credentialRefs
  `["DEMO_COMMERCE_SIGNING_SECRET"]`, 11 inspection queries, 11
  identity nodes, 5 exact-equality causal edges, subject
  `checkoutIntent`, effects `order` + `reservation`. **No
  target-manifest/v1 schema change** (validated by the unchanged
  Phase-13 validator).

## D. ADR-0024 test matrix — all 31 cases covered and green

The frozen matrix in ADR-0024 §"Required implementation test matrix"
now has **31 cases**: cases 1–20 = original signing contract (20),
cases 21–30 = platform authorization (10), and case 31 = the B-1
ordinary-header-token membership regression added by this repair (§13).
Coverage, by suite (all passed in this session):

| Cases | Suite (count) |
| --- | --- |
| 2, 3, 4, 5, 6, 8, 18, 19, 21, 24, 25, 26, 27, 29, 30, 20 (source guard) | `packages/engine/src/credential-authorization.test.ts` (24) |
| 1, 10, 11, 12, 13, 15, 16, 17 | `packages/engine/src/signing-seam.test.ts` (8) |
| 7 (subset fail-fast), grant parsing/hygiene | `tests/unit/config.test.ts` (25) |
| 1, 9, 17 (legacy registration/snapshot byte-shape, freeze, re-registration) | `tests/integration/target-manifest.test.ts` (15) |
| 4, 13, 14, 21, 22, 23, 26, 28, 29, 20 (end-to-end), 9, 31 (real Commerce target) | `tests/integration/phase16-demo-commerce.test.ts` (36; was 35 before the B-1 case) |
| 31 (definition-time + pre-send runtime, real TCP) | `packages/engine/src/credential-token-boundary.test.ts` (12) |

Ordinary `${credential.<REF>}` **declaration** cannot bypass origin
authorization: case 23 registers a non-signing declared ref with no
grant and is rejected — authorization governs **all** declared refs,
not only the signing seam.

**B-1 correction (this repair).** The statement above covered the
`credentialRefs` *field* but NOT the header *token*: before this repair,
an ordinary `${credential.<REF>}` token in a header value could name a
globally resolvable reference the target never declared, were validated
on token FORM only (`authorization`) or not at all (`idempotency-key`),
and were resolved by the executor through the global resolver — so the
Provider signing secret could reach the Commerce origin. That was
blocker B-1 (see §L). It is fixed and regression-tested as case 31.

## E. P16-F behavior tests (measured, canonical results)

- **VULNERABLE** ("two genuinely overlapping submissions oversell the
  last unit"): release-gate concurrency with client `maxInFlight ≥ 2`;
  overlap proven from **target-persisted** timestamps (attempt A
  started before B finished AND vice versa); results
  **orders = 2, reservations = 2, remaining units = −1** — the
  canonical 2/2/−1, on integer minor units (500000 PKR paisa per
  order, R-06, no float anywhere).
- **SECURE** ("intent-keyed idempotency keeps exactly one accepted
  effect under the same pressure"): same gate, same payload,
  outcomes `[ACCEPTED, INTENT_ALREADY_ACCEPTED]`, two physical
  attempts with verbatim request identities; results
  **orders = 1, reservations = 1, remaining = 0** — canonical 1/1/0.
- Also measured: mode switch durability, generation advance on every
  reset, scope-clearing resets (repeatable scenarios), signature
  accept/missing/cross-secret/tamper (401 `CHECKOUT_AUTHENTICATION_FAILED`),
  physical-identity header enforcement, duplicate request identity
  rejection, malformed payload 400, all three fault kinds + closed
  vocabulary refusal, STAGING fault denial, inspection shape
  completeness, and the no-secret-leak surface (case 14).

## F. P16-G gates — all measured green this session

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS (exit 0) |
| `pnpm lint` | PASS (exit 0) |
| `pnpm typecheck` | PASS (exit 0) |
| `pnpm test:unit` | **52 files / 626 tests passed** (exit 0) |
| `pnpm build` | PASS (exit 0) |
| `pnpm db:migrate` (all three DBs) | Control 7, Fintech 4, Commerce 2 migrations — **0 pending** |
| `pnpm verify:integration` | **28 files / 233 tests passed** (exit 0) — incl. phase16 (35), target-manifest (15), golden-incident-zero (15), browser suites |
| `pnpm incident-zero:verify` | **PASS** — frozen intent 5/5, VULNERABLE 25/25, SECURE 21/21 assertions |
| `pnpm controlled-faults:verify` | **PASS** — 18/18 twice, 22/22 twice, "leakage: none" |
| Secret-leak scan | No dev secret values in `apps/demo-commerce`, `packages/commerce-db`, `docs` (grep exit 1, no errors); tracked-tree matches only `.env.example` documented dev defaults and test env fallbacks (existing convention); manifest carries no secret-shaped string |

`typecheck`/`build`/`db:migrate` ran with `COMMERCE_DATABASE_URL` and
`COMMERCE_SHADOW_DATABASE_URL` supplied inline because this machine's
developer `.env` predates Phase 16; CI copies `.env.example` verbatim
(which defines them), so this is a local-environment note, not a
pipeline defect.

## G. Failures encountered and repairs (honest list)

1. **Cross-scope logical-identity defect (integration, 6 red tests).**
   Global `@unique` on `checkout_intents.checkoutIntentId` and
   `checkout_events.checkoutEventId` made logical identity collide
   across verification scopes (a second scope's identical intent id
   violated the unique row), surfacing as SECURE 500s
   (`checkout_intents_scopeId_checkoutIntentId_key`). Repaired with
   composite `@@unique([scopeId, checkoutIntentId])` and
   `@@unique([intentId])` on events, migration
   `20261003_phase16_scoped_logical_identity`, scope-qualified event
   ids, scope-bound inspection summaries, and `inScope()`/`inGeneration()`
   binding in tests. Before/after race repro: mixed
   `[200,500]` → **15/15 rounds `[200,200]`-free**.
2. **Prisma 7 unique-violation detection.** With `@prisma/adapter-pg`
   the driver error carries the constraint at
   `meta.driverAdapterError.cause.constraint.index`, not `meta.target`;
   `uniqueViolationConstraint` handles both shapes plus a message
   fallback, and `isIntentAlreadySettled` now checks P2025 **before**
   the P2002 branch (previously unreachable ⇒ spurious SECURE 500).
3. **Reservation FK** used the wrong order reference in one pipeline —
   both pipelines now reference the created order row.
4. **`ID_PATTERN` minimum length** rejected legal identities
   (`CHK-001`) — minimum set to 3 with the same character class.
5. **Case-13 test design error.** A resolver denial is fail-fast
   *pre-send* (no invocation row exists); the test wrongly awaited a
   terminal invocation state and hung — rewritten to assert the
   rejection directly, then the no-send/no-leak assertions passed.
6. **`TransportStage.SENT` → `REQUEST_SENT`** enum name in a test.
7. **Lint**: needless escapes in template literals
   (`credential-authorization.ts`); an unused variable in the Phase 16
   suite — both fixed at the source (no suppressions).
8. **Hygiene**: `packages/commerce-db/src/generated/` was not
   gitignored (unlike `demo-db`) — `.gitignore` updated; generated
   client now ignored (verified with `git check-ignore`).
9. **Typecheck defects from the new required config field (fixed this
   session):** five in-process API config literals in
   `evidence-invariants`, `forensics`, `golden-incident-zero`,
   `phase9-browser`, and `showcase-browser` tests lacked
   `TARGET_ORIGIN_CREDENTIAL_GRANTS` (added as fail-closed `{}` — none
   registers a manifest through the HTTP API, verified by grep);
   `commerce-harness.ts` passed `headers: Record<string,string> | undefined`
   under `exactOptionalPropertyTypes` (converted to conditional
   spread, same as `body`); and a union-schema `loadConfig` inference
   break in `tests/unit/config.test.ts` (split into two
   separately-inferred `loadConfig` calls — assertions unchanged).
10. **Fault-message assertion** reworded to the closed v1 vocabulary
    (never accepting free-form messages).

## H. Security review (R-02, R-13, R-14)

> **Correction (this repair).** The "Cross-target credential use: NO"
> claim below was FALSE before the B-1 repair: the audit reproduced a
> cross-target ordinary-token bypass (Commerce received the Provider
> secret). It became NO only AFTER the definition-time and pre-send
> membership enforcement plus the case-31 regression proof. The bullet
> is annotated accordingly.

- Secret values in manifest: **NO** (grep of committed manifest:
  no `secret|token` string at all).
- Secret values in grant records: **NO** — grants hold names + origins
  only (parser rejects non-name content).
- Secret values in snapshot / logs / evidence / error messages: **NO**
  — integration case 14 asserts all six surfaces after a real signed
  run; case 13 asserts a missing runtime secret fails pre-send with a
  bounded, value-free error.
- Cross-target credential use: **NO — only after the B-1 repair.**
  Before repair this was FALSE for ordinary header tokens (the audited
  B-1 bypass). It is now NO on three independent layers: (1)
  registration rejects declared cross-target refs (cases 21/22, no
  durable row); (2) definition-time validation rejects a header token
  whose ref is not a declared target reference (case 31); (3) the
  executor's pre-send substitution seam refuses the frozen-set miss
  before resolving or sending (case 31), so the resolver is never
  called for an unauthorized ref. The target itself also rejects the
  other target's HMAC key (401).
- Production fault execution: **NO** — registration refuses
  `PRODUCTION` (ADR-0016) and fault execution is LOCAL_DEVELOPMENT-only
  (STAGING denial integration-tested for Commerce).
- Unsafe INDETERMINATE retry: **NO** — `RESPONSE_TRUNCATION` proof
  shows commit-then-lost-response stays INDETERMINATE with no retry
  (integration + verifier).

## I. Phase boundary

Not implemented, not started, not wired: headless CLI, Checkout Zero
scenario, `rupturegrid-report/v1`, replay lifecycle, UI, new invariant
kinds, new fault kinds, target-manifest/v1 schema changes. Demo
Fintech app/DB behavior unchanged; Incident Zero golden untouched
(verified PASS, docs unmodified).

## J. Repository state at report time

- staged: NONE · commit: NONE · tag: NONE · push: NONE
- HEAD still `6052a5d917f2e8213360f9701c228dadabe2a339`.
- Working tree: 35 modified tracked files + new `apps/demo-commerce/`
  (11 files), `packages/commerce-db/` (13 files), 3 new engine files,
  2 new test files, and this report.

## K. Verdict

**READY FOR INDEPENDENT PHASE 16 AUDIT.** This is a builder
self-audit, not acceptance: acceptance is declared only by the
independent adversarial audit and the phase process (R-07).

## L. Independent audit result and B-1 repair (this session)

**The independent Phase 16 adversarial audit returned FAIL — PHASE 16
REPAIR REQUIRED, with exactly ONE blocking finding: B-1.**

Reproduced issue (undeclared credential-token bypass): on the real
Commerce target, whose frozen/declared credential set is
`["DEMO_COMMERCE_SIGNING_SECRET"]`, an experiment header
`authorization: Bearer ${credential.DEMO_PROVIDER_SIGNING_SECRET}` was
**accepted by validation**, the executor **globally resolved**
`DEMO_PROVIDER_SIGNING_SECRET`, the **HTTP request was sent**, and the
Commerce origin **received the Provider secret** — a violation of
ADR-0024 §13 and the target-scoped credential boundary.

Root cause: `validate.ts` checked token FORM (for `authorization` only)
but never checked token-ref membership against the target's declared
credential set; the executor's `substituteCredentials` resolved every
`${credential.<REF>}` token through the global, unscoped resolver.
`action.credentialRefs` was never the gate the token could bypass.

Repair (B-1 only, plus tightly related truth cleanup):

- One shared token grammar — `packages/engine/src/credential-token.ts`
  (`credentialTokenRefs`, `credentialTokenPattern`) — used by BOTH
  validation and the executor, so the token the executor sees is the
  token validation sees.
- Definition-time: `validate.ts` extracts every `${credential.<REF>}`
  token from every allowed header value and rejects (bounded, name-only
  issue) any ref not in the target's declared credential set.
  `action.credentialRefs` semantics are preserved unchanged.
- Pre-send runtime defense (defense in depth): `executeHttp` takes the
  FROZEN snapshot `target.credentialRefs` and
  `substituteCredentials` refuses any token ref outside it BEFORE
  calling `CredentialResolver.resolve`; an absent set is the empty set
  (deny all). Authority is the frozen snapshot only — no live
  registration, no current grants, no signing classification.
- Regression: `packages/engine/src/credential-token-boundary.test.ts`
  (12 tests) covers the exact B-1 attack on `authorization` and
  `idempotency-key`, multi-token values, the declared-ref positive
  control, resolver-not-called, request-not-sent, and
  no-secret-value-in-error. ADR-0024 matrix case 31 added.
- Self-audit corrections: this section; the §H cross-target overclaim;
  the §B source-test overclaim; the stale shadow-DB comment in
  `packages/commerce-db/prisma.config.ts`; and the ADR-0024 §2.C
  signing-seed wording (both Demo signing refs, not only the Provider
  ref).

After repair, the exact adversarial replay is REJECTED at definition
time and, independently, refused pre-send by the executor: resolver
calls for the Provider ref = 0, HTTP requests sent = 0, wrong-origin
secret received = NO.

## M. Post-repair gate results (this session)

Observed in this working tree after the repair (never the pre-repair
baseline forced to match):

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS (exit 0) |
| `pnpm lint` | PASS (exit 0) |
| `pnpm typecheck` | PASS (exit 0) — commerce URLs supplied inline (local `.env` predates Phase 16, as in §F) |
| `pnpm test:unit` | **53 files / 638 tests passed** (was 52/626; +1 file/+12 B-1 tests) |
| `pnpm build` | PASS (exit 0) |
| `pnpm db:migrate` | Control 7, Fintech 4, Commerce 2 — **0 pending** |
| targeted engine suites | credential-token-boundary 12, credential-authorization 24, signing-seam 8, validate 10, validate.phase9 15, destination-seam 11 — all pass |
| phase16 demo-commerce integration | **36/36 passed** (was 35; +1 B-1 case) |
| full integration suite | 28 files / 234 tests; every file green individually. One combined run showed two ENVIRONMENTAL flake sources, neither B-1: (a) dedicated test ports 3101/3102 were occupied by unrelated local services (api-health/demo-health fail fast on a non-ok response); re-running with `API_TEST_PORT`/`DEMO_TEST_PORT` free → 8/8 pass; (b) one run's random ephemeral fixture port collided with a pre-registered manifest-less origin in the persistent dev DB (phase15 `ensureManifestTarget` reuse); phase15 alone → 13/13 pass |
| `pnpm incident-zero:verify` | **PASS** — frozen intent 5/5, VULNERABLE 25/25, SECURE 21/21 |
| `pnpm controlled-faults:verify` | **PASS** — 18/18 ×2, 22/22 ×2, "leakage: none" |
| B-1 adversarial replay | definition-time REJECTED and pre-send REFUSED: resolver calls for the undeclared Provider ref = 0, HTTP requests sent = 0, wrong-origin secret received = NO |
| secret-value scan of new tests/docs | reference NAMES only; no secret VALUES persisted |
