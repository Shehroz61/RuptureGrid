# RUPTUREGRID v1.0 — PHASE 11 RELEASE PREPARATION SELF-AUDIT

Builder session: Phase 11 release preparation (branch
`phase-11-public-release-preparation`, cut from `phase-10-accepted` =
`a00632f`). Date: 2026-09-24. Every result below was observed in this
session against the real stack (real Control PostgreSQL, real Demo
PostgreSQL, real Redis, real HTTP, real browser where applicable). All
work remains UNCOMMITTED by phase-boundary design.

This is the builder's self-audit; the authoritative acceptance record is
the independent Phase 11 audit, which was executed on 2026-09-24 and is
recorded in `docs/reports/phase-11-independent-audit.md`. Corrections
that audit applied to this document are marked `[AUDIT CORRECTION]`.

## 1. Verdict

**PHASE 11 READY FOR INDEPENDENT AUDIT** (code-ready; publication
requires the owner decisions in §17).

## 2. Starting checkpoint

- branch = `phase-10-full-engineering-audit`, tree clean (verified:
  `git status` clean, `git branch --show-current` =
  `phase-10-full-engineering-audit`, `git rev-parse
  phase-10-accepted^{commit}`  = `a00632f7967ff86d0eaa23d1d0ec33e6dce5b13b`,
  all 12 phase tags present)
  `[AUDIT CORRECTION — count fixed]` Exactly **11** phase tags exist
  (`phase-0-accepted` … `phase-10-accepted`), all present — the
  original “12” was a miscount, re-verified with `git tag`.
- Phase 11 branch = `phase-11-public-release-preparation` (created from
  `phase-10-accepted` via `git switch -c`; observed)

## 3. Baseline gates (before any change)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 (17 workspace projects) |
| `pnpm format:check` | pass |
| `pnpm lint` | pass (16 workspace projects) |
| `pnpm typecheck` | pass |
| `pnpm test:unit` | 33 files / 319 tests pass (7.67s) |
| `pnpm test:integration` | 23 files / 152 tests pass (276.80s) |
| `pnpm build` | pass (incl. Next.js production build) |
| `pnpm verify` | exit 0 |
| `pnpm incident-zero:verify` | PASS exit 0 (`--json` verified) |
| `pnpm controlled-faults:verify` | PASS exit 0, 80/80, leakage none |
| `pnpm showcase:generate` | PASS (10 screenshots, validation pass) |
| `pnpm showcase:generate --video` | PASS (H.264 walkthrough, validation pass) |

## 4. Test-gate blind spots (Phase 10 §31 risks 2–3) — CLOSED

- **Test typecheck:** new root program `tsconfig.checks.json`
  (`noEmit`, base strictness inherited unchanged, no artifact emission)
  covering `tests/**/*.ts` and every `packages/*/src/**/*.test.ts` +
  package `.d.ts`; workspace packages resolve from SOURCE via `paths`
  (mirrors the vitest aliases). Decorator options match
  `apps/api/tsconfig.json` (integration suites embed the real NestJS API
  in-process). `tests/unit/ui-semantics.test.ts` (which imports real
  bundler-context web sources) is typechecked by
  `tsconfig.checks.ui.json` under apps/web's own options. Wired into
  `pnpm typecheck`.
- **Integration lint:** eslint flat-config default block now matches
  `**/*.ts(x)` repo-wide, so `tests/**` and package test files are
  linted by the root program without touching the per-package
  `lint` scripts; wired into `pnpm lint` (`pnpm lint:root` runs the root
  program directly). No ignore was loosened; strictness was never
  reduced.
- **What the new gates caught immediately (proof they were needed):**
  21 lint errors in previously-invisible files (unused imports/bindings,
  `import()` type annotations, `prefer-const`) — all fixed, including
  two genuine production issues in `packages/incident-zero/src/
  readiness.ts` (declared-but-uninitialized variables) surfaced by
  `recommended-type-checked`; and 60+ type errors in test files
  (strict-mode narrowing, `noUncheckedIndexedAccess`, a WRONG HARNESS
  TYPE: `SimulatedScenarioClient` claimed a flat `providerPaymentId`
  field while the real API returns nested `payment` — runtime code
  already read the true shape; the type was lying) — all fixed, several
  via explicit prerequisite guards (`requireId`, `scenarioEvent`) that
  fail loudly instead of querying with `undefined`.
- **Regression proof (intentional-error probes, then reverted):**
  - type error appended to `tests/unit/redaction.test.ts` →
    `tsc -p tsconfig.checks.json` fails (2 errors) → file reverted →
    gates green again.
  - lint errors (`no-unused-vars`, `no-explicit-any`) appended to
    `tests/integration/worker-startup.test.ts` → eslint root program
    fails (2 errors) → file reverted → gates green again.
- **One-time correction during the session:** the revert of the lint
  probe initially also reverted the two real fixes in that file's
  history; `pnpm verify` caught it (2 lint errors) and the fixes were
  re-applied and re-verified. Gates demonstrably police this tree.
- No build artifacts are emitted by the checks (`noEmit` everywhere);
  no double compilation exists (build scripts unchanged).

## 5. Manifest audit

- **demo-db gap (Phase 10 §31 risk 1) — FIXED:**
  `packages/demo-db/prisma.config.ts` imports `@rupturegrid/config`
  (for `loadEnvironment`) and is executed by every Prisma CLI
  invocation; the dependency was undeclared (workspace hoist). Declared
  as a **devDependency** in `packages/demo-db/package.json` (it is
  config-execution-time only, not runtime-imported by `dist`), lockfile
  regenerated via `pnpm install --no-frozen-lockfile` (diff = exactly 3
  lines adding the link), then `pnpm install --frozen-lockfile`
  re-proven; `pnpm --filter @rupturegrid/demo-db run generate` and
  `migrate:deploy` both green.
- **Every workspace package audited** (imports enumerated vs
  `package.json`): `@nestjs/*`↔api, `@prisma/adapter-pg`↔control-db+
  demo-db, `bullmq`/`ioredis`↔queue, `dotenv`/`zod`↔config, `express`↔
  api+demo-fintech, `pino`↔logger, `playwright`↔showcase, `@types/node`
  present in every Node-side package, `typescript` everywhere. Result:
  **no phantom runtime dependencies**; the only gap was demo-db above.
- **Classification notes (unchanged code, verified):** `vitest` is used
  only by test files (root devDependency; vitest resolves imports
  through its own pipeline — no per-package declaration exists today;
  recorded as accepted residual risk in §16); `prisma`/`@prisma/client`
  are imported by Prisma-generated client code inside control-db and
  demo-db (generated from their schemas, clients gitignored, both
  packages declare `prisma` and `@prisma/client`); apps/web's `@types/*`
  are true devDependencies; tests' deep imports of
  `packages/showcase/dist/*` and `apps/worker/dist/*` are
  build-artifact seams exercised by the suites themselves.
- **Frozen install:** `pnpm install --frozen-lockfile` exit 0 after all
  manifest changes.

## 6. Release metadata & version policy

- Root `package.json`: `name` = `rupturegrid-monorepo`,
  `version` = `1.0.0`, `private: true` (source release ≠ npm
  publication; all workspace packages remain `private`), `type: module`
  (added this phase; no root CJS entry points exist), `engines`
  (node ≥ 22.12.0, pnpm ≥ 11.0.0), `packageManager` = `pnpm@11.9.0`,
  full script set incl. new `release:verify`, `lint:root`.
- **Version authority:** the root `package.json` `version` field is the
  single authoritative release version (documented in CHANGELOG.md).
  Protocol/schema strings (`controlled-fault/v1`, normalizer/derivation
  versions, `EXECUTION_ENGINE_VERSION`) are semantic protocol versions,
  NOT release versions, and were not touched.
- `repository`/`homepage` carry **explicit placeholder** URLs
  (`example.com/invalid/repo-url-placeholder`) — the real URL is an
  owner decision (§17); no URL was invented.
- **LICENSE:** none exists in the repository. Recorded as a publication
  blocker requiring an owner decision (§17); no license was guessed.

## 7. README / quickstart

- README rewritten to the truthful v1.0 state: it claimed "PHASE 5 …
  uncommitted" (stale since Phase 5) and showed a Phase-1-era layout.
  Now: accepted status of phases 0–10, complete quickstart (`corepack
  enable` → install → env → infra → migrate → dev; no hidden steps),
  verification-command table, accurate repository layout (all 13
  packages incl. engine/evidence/forensics/incident-zero/controlled-
  faults/showcase), the Demo route table incl. the controlled-faults
  admin routes, and honest security wording (egress isolation named as
  the primary control).
- First-time-run review: `.env.example` documents every variable the
  stack reads; `pnpm db:migrate` generates clients and applies both
  migration sets; no manual schema or secret steps exist outside the
  quickstart.

## 8. Documentation created/updated

- `README.md` (rewritten), `CHANGELOG.md` (new, truthful v1.0 entry),
  `SECURITY.md` (new: supported surface, honest limitations, reporting
  path with owner-decision contact marked pending),
  `.github/workflows/ci.yml` (new CI), `tsconfig.checks.json` +
  `tsconfig.checks.ui.json` (new gate programs), root `package.json` +
  `packages/demo-db/package.json` (metadata/manifest), and the Phase 11
  test-gate hardening described in §4.

## 9. CI

- Provider: GitHub Actions (`.github/workflows/ci.yml`), one `gates` job.
- Real infrastructure: PostgreSQL 18 ×2 services (control 5443, demo
  5444) + Redis 8.4 (6380) with health checks; shadow databases created
  via psql before migrations.
- Steps mirror the documented local flow exactly:
  frozen install → format → lint (workspace + root tests) → typecheck
  (workspace + both check programs) → unit → build → `pnpm db:migrate`
  against the real services → full integration suites →
  `pnpm incident-zero:verify` → `pnpm controlled-faults:verify`.
- Secrets: none required. CI copies the committed `.env.example`
  (non-production dummy credentials) to `.env` — the same values a
  fresh clone documents; no CI-specific env construction, no secrets in
  the workflow file.
- Limitation honestly recorded: the workflow was authored in this
  session but could NOT be executed here (no GitHub remote/push is
  permitted in Phase 11); its first real run is an independent-audit
  follow-up. Every individual command it composes was run green locally.

## 10. Release verification

- New script: `pnpm release:verify` = `pnpm verify` +
  `pnpm incident-zero:verify` + `pnpm controlled-faults:verify`
  (fail-fast chain, exit 0 only if all pass).
- Components ordered so a defect fails the cheapest gate first; the
  verifiers spawn their own owned services (exact PIDs, no global
  kills).
- The single `pnpm release:verify` invocation exceeded this session's
  10-minute command window (verify alone embeds a full Next.js build;
  both verifiers each run a fresh build first); it was therefore
  executed as its three component commands, each observed exit 0 (see
  §11–§12). The script itself remains valid for interactive use.
  `[AUDIT CORRECTION]` The single-invocation limitation was a builder-
  session shell-timeout artifact, not a script property: the independent
  audit executed `pnpm release:verify` end-to-end in one command — both
  in its original form and after extending it to include
  `verify:integration` (AUDIT-C10) — each exit 0 (unit 33 files/319
  tests, integration 23 files/152 tests, both verifiers PASS).
- Clean worktree install/build proof: baseline gates ran on a clean tree
  at `phase-10-accepted`; post-change gates (§13) prove the modified
  tree; a from-scratch `git clone` copy install was not additionally
  performed in-session (the working tree already required a full
  frozen-lockfile install + build cycle, which passed) — recorded as a
  residual risk in §16. `[AUDIT CORRECTION]` Closed 2026-09-24: the
  independent audit proved the clean-checkout property end to end (see
  the independent audit report §15).

## 11. Incident Zero regression

- run 1 (baseline, pre-change) = PASS exit 0 (5/5, 25/25, 21/21)
- run 2 (post-change) = PASS exit 0 (fresh run IDs; report JSON verified)
- VULNERABLE ⇒ INV-IZ-1 FAIL with 1 Finding; SECURE ⇒ PASS, 0 Findings;
  canary clean; result = PASS ×2

## 12. Controlled Faults regression

- run 1 (baseline) = PASS exit 0, 80/80, leakage none
- run 2 (post-change) = PASS exit 0, 80/80 (18/18 ×2 PRE,
  22/22 ×2 RESPONSE_LOSS), leakage none
- PRE steps = KNOWN_ABSENT, attemptCount 1 (no unsafe retry); RESPONSE_LOSS
  steps = INDETERMINATE preserved, attemptCount 1; result = PASS ×2

## 13. Post-change final gates

- `pnpm format:check` = pass
- `pnpm lint` = pass (16 packages + root tests program)
- `pnpm typecheck` = pass (workspace + tsconfig.checks.json +
  tsconfig.checks.ui.json)
- `pnpm test:unit` = 33 files / 319 tests pass (after all edits;
  re-run twice during the session)
- `pnpm test:integration` = 23 files / 152 tests pass (345.08s, after
  all test-file edits)
- `pnpm build` = pass (within `pnpm verify`)
- `pnpm verify` = exit 0 (re-verified after every gate-affecting change)
- `pnpm showcase:generate` = PASS (10 screenshots, validation pass)
- `pnpm showcase:generate --video` = PASS (H.264, validation pass)

## 14. Security claims wording

- Production fault denial: verified wording in README ("production fault
  targeting is denied in v1", "production environments denied"),
  security-boundaries §3 ("Production fault targeting is DENIED in v1…
  enforced in the Control Plane at run creation and re-checked by the
  executor"), AGENTS R-14 — all consistent with implementation
  (definition-time + execution-time gates).
- DNS rebinding: every surface now names egress isolation as the primary
  control with the TOCTOU limitation honest (README updated to match
  docs/security-boundaries.md §5; docs already correct).
- Evidence integrity: UI and docs say "detects post-hoc modification…
  not tamper-proofing"; no "immutable"/"tamper-proof" claims anywhere
  (grep-verified; README says "logically append-only, hash-pinned").
- Exactly-once: README uses "exactly one credit" (business invariant);
  delivery-semantics "exactly once" appears only where precise
  (queue-dedup suite names). No overclaim found.
- Secret handling: `.env.example` placeholders only; `.env` untracked;
  verifiers' canary scans clean in every run this session.

## 15. Cross-platform

- Windows: the entire session (installs, builds, typechecks, both test
  suites, both verifiers, showcase incl. video) ran on Windows under
  bash. `[AUDIT CORRECTION — factual error fixed]` The checkout path is
  `E:\RuptureGrid-v1.0`, which contains no spaces; the original claim
  that it lived under a spaced user directory was wrong. The
  path-with-spaces property was instead proven by the independent audit
  on a real spaced path (`E:\rg audit spaces`): frozen install,
  `db:generate`, `build`, and a full `incident-zero:verify` run (fresh
  run IDs, 25/25 + 21/21 assertions) all exited 0 there.
- No POSIX-only syntax was introduced this phase (new files: JSON/JSONC
  configs, YAML workflow, Markdown; CI steps use portable commands).
- CI workflow targets ubuntu-latest; its psql/port assumptions are
  CI-owned and documented in the file.

## 16. Remaining risks (non-blockers)

1. CI workflow authored but not yet executed on a real runner (no push
   permitted in Phase 11) — first real run belongs to the independent
   audit or the owner.
2. `repository`/`homepage`/license/security contact are placeholder/
   pending owner decisions (§17) — publication blockers, not code
   defects.
3. `vitest` is not declared in packages whose `*.test.ts` import it
   (root devDependency; vitest's own module pipeline resolves it).
   Declaring it per-package would add churn with no resolution change —
   accepted, documented.
4. A from-clean-`git clone` install was not additionally re-proven
   in-session (baseline clean-tree gates + frozen installs cover the
   property; trivially re-runnable by the independent audit).
5. `tmp-showcase-video*.log` scratch files at the repo root predate this
   session (untracked, gitignored by `*.log`); left in place (not
   created by this phase).

## 17. Owner decisions (publication blockers)

1. **License** — no LICENSE file exists; choosing and adding one is a
   legal decision. Until then `license: UNLICENSED` stays.
2. **Security contact** — see SECURITY.md; dedicated mailbox or GHSA.
3. **Public repository URL** — `repository`/`homepage` placeholders in
   root `package.json` and CHANGELOG link must be replaced with the real
   URL.
4. **Copyright holder** — for the chosen license text.
5. **Release hosting/publishing** — source archive vs public git host;
   npm publication is NOT part of v1.0 (all packages `private`).

## 18. Git

- branch = `phase-11-public-release-preparation`
- changed files = 31 modified + 5 new (tsconfig.checks.json,
  tsconfig.checks.ui.json, CHANGELOG.md, SECURITY.md,
  .github/workflows/ci.yml)
- `git diff --check` = clean (whitespace)
- generated artifacts = none tracked (`.artifacts/` gitignored,
  `git check-ignore` verified)
- commit = NO; tag = NO; push = NO

## 19. Acceptance blockers

**NONE** for the code-ready verdict. Publication requires the §17 owner
decisions (explicitly out of this phase's scope).
