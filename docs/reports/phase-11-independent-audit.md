# RUPTUREGRID v1.0 — PHASE 11 INDEPENDENT PUBLIC-RELEASE ACCEPTANCE AUDIT

Auditor: independent Phase 11 acceptance audit (fresh session; no builder
session state). Date: 2026-09-24. Branch audited:
`phase-11-public-release-preparation`, on top of `phase-10-accepted` =
`a00632f7967ff86d0eaa23d1d0ec33e6dce5b13b` (HEAD at audit start). Every
result below was observed in this audit against the real stack (real
Control PostgreSQL :5443, real Demo PostgreSQL :5444, real Redis :6380,
real HTTP, real browser where applicable). All work remains UNCOMMITTED
by phase-boundary design. No commit, tag, or push was performed.

Evidence rule (AGENTS.md R-02/R-07): nothing in this report is
documented-only; every claim is backed by a command executed in this
session with its observed exit code and output. Where this audit
corrected the builder's self-audit, the correction is marked
`[AUDIT CORRECTION]` in that document and cross-referenced here.

---

## 1. Verdict

- **PHASE 11: CODE-READY — ACCEPTED**
- **PUBLISH-READY: BLOCKED ON OWNER DECISIONS**
  (license, security contact, repository URL, copyright holder, release
  hosting — §26; plus the ffmpeg-static licensing confirmation, §17)

The release-preparation work itself meets the phase exit criteria. What
blocks publication are five decisions that only the project owner can
make; none of them is a code defect, and none was fabricated or guessed
by builder or auditor.

## 2. Scope and method

The audit (a) reconstructed and reviewed the builder's complete
Phase 11 diff, (b) re-ran every release gate from the documented
commands, (c) proved the clean-checkout and portability properties that
the brief marks blocking, (d) executed the release verification chain
end-to-end, (e) applied minimal Phase-11-only corrections where the
audit found defects, and (f) corrected factual errors in the builder's
self-audit rather than leaving false statements in the tree. Negative
controls (deliberate defects, then exact reverts) were used to prove the
gates and the verifier actually detect breakage. Long-running commands
ran with unbounded timeouts; one earlier 600 s timeout kill produced a
spurious Windows `STATUS_DLL_INIT_FAILED 0xC0000142` cascade that was
correctly discarded as an audit-harness artifact, not a product defect.

## 3. Baseline reconstruction

The builder's original diff was enumerated with `git diff --stat`:
**40 files, +1035/−166** at audit start, all uncommitted on
`phase-10-accepted`. The full diff was read: `.github/workflows/ci.yml`,
`CHANGELOG.md`, `README.md`, `SECURITY.md`, `tsconfig.checks.json`,
`tsconfig.checks.ui.json`, `eslint.config.mjs`, root `package.json`,
`packages/demo-db/package.json`,
`packages/incident-zero/src/readiness.ts`, every changed test file, and
`pnpm-lock.yaml`.

## 4. Builder diff review — tests and code fixes

All builder test changes were verified genuine against real sources:

- `SimulatedScenarioClient` now types the nested `payment:` object —
  verified against the real
  `apps/demo-fintech/src/provider-simulator-service.ts`; the previous
  flat `providerPaymentId` type was lying about the API shape.
- `requireId` / `scenarioEvent` guards fail loudly instead of querying
  with `undefined`.
- The engine test fixture now matches the real
  `TargetRegistrationModel`.
- `readiness.ts` changes are behavior-identical (declared-but-
  uninitialized variables fixed under `recommended-type-checked`).
- Two new justified `@ts-expect-error` directives (express deep JS
  path), both commented.
- `type: module` on the root package is safe: the only CJS-interop usage
  in the engine is `createRequire(import.meta.url)` in
  `packages/engine/src/telemetry.ts`.
- No phantom production dependencies were found in the manifest audit.

## 5. Builder diff review — configs, metadata, CI

- `tsconfig.checks.json` / `tsconfig.checks.ui.json`: `noEmit` gate
  programs covering `tests/**` and every package-local `*.test.ts` +
  package `.d.ts`; workspace packages resolve from source via `paths`.
- `eslint.config.mjs`: root program now lints `**/*.ts(x)` repo-wide
  (tests included); no ignore was loosened, strictness not reduced.
- `ci.yml`: one `gates` job mirroring the documented local flow, real
  service containers with health checks. Audit corrections C5–C7 below.
- Version policy: root `package.json` `version` = `1.0.0` is the single
  release-version authority; protocol/schema versions
  (`controlled-fault/v1`, normalizer/derivation versions,
  `EXECUTION_ENGINE_VERSION`) are semantic protocol versions, untouched.

## 6. Negative controls (gates proven to detect defects)

- Type error injected → `tsc` check program exits 2 → restored exactly.
- Lint error injected in `tests/integration` → eslint root program
  exits 1 → restored exactly.
- Type error injected into `packages/shared/src/index.ts` →
  `release:verify` exits 1 fast-fail → restored exactly → exit 0.
- Audit-harness accident (R-02 honesty record): a `git checkout --`
  revert briefly discarded the builder's 2-line edit in
  `tests/integration/worker-startup.test.ts` (unused `let env`
  removal). It was reconstructed exactly and verified; the final diff
  equals the builder's original + audit corrections only.

## 7. Corrections ledger (C1–C10)

Each correction: defect → why → fix → proof. All are Phase-11-scope,
minimal, and re-proven after application (§8).

**C1 — Invented release metadata URLs (P1).** Root `package.json`
`repository`/`homepage` and the CHANGELOG link carried
`example.com/invalid/repo-url-placeholder`. Violates R-02/R-03/R-15
(never invent URLs; placeholders presented as metadata are fake truth).
Fix: fields/link removed; the real URL is an owner decision (§26).
Proof: grep for the placeholder string over the tracked tree returns
nothing; `pnpm verify` still exit 0.

**C2 — Missing contributor guide.** A public source release documented
install and verification in README but had no contributor workflow
document. Fix: `CONTRIBUTING.md` created (prerequisites, install,
infra/migrations, running the stack, tests, `pnpm verify` /
`release:verify`, architecture/security reading, PR rules tied to
R-01/R-07/R-16/R-17/R-18). Proof: file present; every command it names
exists in root `package.json` and was executed green in this audit.

**C3 — Self-audit factual falsehood: path with spaces (§15).** The
builder's self-audit claimed the checkout lived "under a user directory
containing spaces". False: the checkout is `E:\RuptureGrid-v1.0` (no
spaces). Leaving a false statement in the acceptance record violates
R-02. Fix: falsehood corrected in place, marked
`[AUDIT CORRECTION — factual error fixed]`, and the real spaced-path
evidence recorded (this audit's §23). Proof: `pwd`/path enumeration;
spaced-path run in §23.

**C4 — Broken internal references.** Self-audit referenced nonexistent
sections `§22`/`§30` (its own §17/§16 were meant); `SECURITY.md`
pointed at self-audit `§22`. Fix: refs retargeted to the real sections
(§17, §16); SECURITY.md ref retargeted with the reporting-channel
sentence preserved. Proof: `grep "§22\|§30"` over both files returns
nothing.

**C5 — Dead `CI_ENV_FILE` in `ci.yml`.** The workflow referenced an env-
file mechanism it does not use (dead configuration invites drift).
Fix: step removed. Proof: `grep CI_ENV_FILE` over the workflow returns
nothing; YAML re-validated.

**C6 — Fragile psql shadow-DB step.** The shadow-database creation
relied on implicit psql defaults. Fix: explicit connection-string form
with a comment. Proof: YAML parse via `npx js-yaml`; step matches the
documented shadow-DB names.

**C7 — Missing workflow permissions.** `ci.yml` had no explicit
`permissions`, leaving the default GITHUB_TOKEN scope. Fix:
`permissions: contents: read` (least privilege). Proof: present in the
workflow; YAML validated.

**C8 (P1) — `pnpm typecheck` broken on a clean tree.** The check
programs import `apps/worker/dist/*`, but the typecheck script did not
build the worker app: clean-tree typecheck failed TS2307 on
`apps/worker/dist/lifecycle.js`, and CI would fail at the typecheck
step. Fix: typecheck script now builds the worker app first
(`&& pnpm --filter @rupturegrid/worker run build &&`). Proof: clean-
checkout gates green (§9); CI step ordering now consistent.

**C9 — Undocumented environment knobs.** `RG_GOLDEN_CANARY` and
`RG_CF_SCENARIO_TIMEOUT_MS` are read by the incident-zero and
controlled-faults CLIs (verified by grep) but were absent from
`.env.example`. Fix: documented as commented optional entries.
Proof: `.env.example` carries both names; CLIs run green with them
unset.

**C10 — `release:verify` composition incomplete.** The script omitted
`pnpm verify:integration` relative to the required composition.
Fix: `release:verify` = `verify` + `verify:integration` +
`incident-zero:verify` + `controlled-faults:verify`. Proof: extended
script executed end-to-end in a single invocation, exit 0 (§10);
package.json format-checked.

## 8. Post-correction gates

After all corrections: `pnpm format:check` pass; `pnpm verify` exit 0;
final tracked diff **43 files, +1586/−166** (builder's 40-file diff +
audit corrections to `package.json`, `CHANGELOG.md`, `ci.yml`,
`.env.example`, `docs/reports/phase-11-self-audit.md`, `SECURITY.md`;
new files `CONTRIBUTING.md` and this report — intent-to-add, uncommitted).
Lockfile hash
`eb28f309633a4f3b…` unchanged by every install performed.

## 9. Clean-checkout proof (blocking property)

Source-only tree at `/e/RG-AUDIT-CLEAN` built from `git ls-files` tar
(no build artifacts). Observed: frozen install exit 0 (52.8 s, lockfile
hash identical); fresh empty databases `rg_audit_control` (+shadow) and
`rg_audit_demo` (+shadow) — all 5 control + 4 demo migrations applied,
exit 0; format, lint, typecheck (with C8 fix), unit 319 tests, build,
incident-zero verify, controlled-faults verify all green; integration
152/152 green. First integration run had 2 failures traced to the
audit's own DB-name deviation (the suite asserts the documented names
`/rupturegrid` and `/demo_fintech`, correctly); with the documented
`.env` restored, 152/152 pass. This was the auditor's deviation, not a
product defect (recorded per R-02).

## 10. Release verification end-to-end (§20/§21)

- Original `release:verify`: full single invocation, exit 0.
- Extended (C10) `release:verify`: full single invocation, exit 0 —
  unit 33 files + integration 23 files (319.54 s) + both verifiers
  `RESULT: PASS`, one command, fail-fast chain observed working (§6).
- The builder's claim that single invocation exceeded a 10-minute
  window was a shell-timeout artifact of the builder session, not a
  script property; corrected in the self-audit (§10 there).

## 11. Incident Zero regression (final, main tree)

Two final runs, each exit 0, fresh run IDs per run. VULNERABLE target:
25/25 assertions, INV-IZ-1 FAIL with 1 Finding. SECURE target: 21/21,
0 Findings. Canary clean in every run. Durable-truth spot check:
COMPLETED runs carry 7 findings in the recent window
(`analysis.finding`) — the pipeline writes what it observed.

## 12. Controlled Faults regression (final, main tree)

Two final runs, each exit 0: 80/80 per run (18/18 ×2 PRE,
22/22 ×2 RESPONSE_LOSS), leakage none. PRE steps = `KNOWN_ABSENT`,
attemptCount 1 (no unsafe retry); RESPONSE_LOSS steps = `INDETERMINATE`
preserved, attemptCount 1 — consistent with R-10.

## 13. Showcase regression

`showcase:generate` exit 0 (10 screenshots, validation pass) ×2;
`--video` exit 0 (`showcase-walkthrough.mp4`, 1,032,096 bytes, codec
avc1/H.264, no hvc1). `.artifacts/` gitignored — nothing tracked.

## 14. Static content checks

- No placeholder URL remains in tracked files (post-C1); remaining
  `example.com` hits were prose in the self-audit, corrected there.
- Overclaim grep: only negations ("not tamper-proof", "not
  non-repudiable"); no `immutable`/`tamper-proof` claims; R-18
  terminology (`INDETERMINATE`, `NOT_EVALUABLE`, `logically
  append-only`, `repeat` vs `retry`) verified in changed surfaces.
- No secrets in the tracked tree (§40 checks clean; `.env` untracked).
- Largest tracked file: `pnpm-lock.yaml` (~165 KB) — expected.

## 15. Git invariants (§58)

- Branch `phase-11-public-release-preparation`; HEAD = `a00632f`
  (`phase-10-accepted` = tag object `e565020`); builder committed
  nothing; this audit committed nothing.
- Tags: exactly **11** — `phase-0-accepted` … `phase-10-accepted`, all
  present. (Self-audit's "12" was a miscount; corrected there.)
- No commit, tag, or push performed (R-16; brief).

## 16. Dependency audit (§35)

`pnpm audit` of the frozen tree: 7 vulnerabilities (1 low, 1 moderate,
5 high), **all transitive and dev/toolchain-reachable only**:
multer ×4 via `@nestjs/platform-express` (the API parses no multipart
bodies), mysql2 ×2 and deepmerge-ts via the Prisma CLI bundle
(dev-time only). No reachable runtime path was found; per the brief no
blind upgrades were made — this is recorded for the owner as routine
maintenance, not a release blocker.

## 17. License review (§36)

Direct-dependency licenses are permissive (MIT/Apache-2.0/ISC/BSD
lineage; `zod` MIT verified on disk at `node_modules/.pnpm/zod@4.5.4`).
One exception: **`ffmpeg-static` is GPL-3.0-or-later** — a build-time
downloaded binary used only for the optional showcase video. Consequence
for the owner: distributing showcase artifacts built with it may trigger
GPL obligations; the code dependency is dev-only. Recorded as an owner
decision alongside the LICENSE choice (§26). The repository itself has
**no LICENSE file** — nothing was guessed.

## 18. Test inventory and orphan check (§43/§44)

`*.test.ts` inventory: **26 under `tests/`** + **30 package-local**
(`packages/**`, `apps/**`, excluding `dist`/generated/`node_modules`) =
**56 total**. Coverage: `tsconfig.checks.json` covers `tests/**` and
every package-local test; `tests/unit/ui-semantics.test.ts` (which
imports real web sources) is typechecked by `tsconfig.checks.ui.json`
under apps/web's options. Orphan check via `tsc --listFilesOnly`
against both programs: zero orphans.

## 19. Frozen-install re-proof (§45)

Main tree `pnpm install --frozen-lockfile` exit 0 with lockfile sha256
`eb28f309633a4f3b3231da5a7eb2ab4fe45b369b8329942b77e67bfff32c80c8`
unchanged after all manifest changes (audit included no manifest edits
beyond the builder's demo-db devDependency, already in the lockfile).

## 20. Schema-drift check (§46)

Prisma 7 syntax (`migrate diff --from-config-datasource --to-migrations
prisma/migrations --exit-code`, the `--from-url` form being removed in
Prisma 7): "No difference detected" for **both** control and demo
databases (exit 0). Migrations are the authoritative history; no
schema push exists (R-12).

## 21. Versions, CHANGELOG, fault kinds (§27/§29/§33)

- Protocol versions are separate from the release version; CHANGELOG
  states this explicitly.
- Every script the CHANGELOG names exists in root `package.json`
  (including `release:verify` post-C10).
- Fault kinds exercised: `PRE_MUTATION_REJECTION`,
  `CRASH_MID_PROCESSING`, `RESPONSE_TRUNCATION`; `KNOWN_ABSENT` kinds
  documented in `docs/controlled-faults.md` — docs match behavior.

## 22. README quickstart executed as documented (§17)

`pnpm infra:up` executed standalone: **exit 0** (idempotent; all three
services Healthy). Services confirmed via `docker compose ps`:
control-postgres :5443, demo-postgres :5444, redis :6380, all healthy
throughout the audit. `cp .env.example .env`, `pnpm db:migrate`, and
the documented dev/verify commands were exercised in the clean-checkout
proof (§9) exactly as README documents.

## 23. Path-with-spaces portability proof (§41, blocking)

Source-only tree at **`E:\rg audit spaces`** (18 top-level entries,
`.env` copied; the earlier timed-out attempt had tried to copy
`node_modules` — abandoned for the source-only approach). Observed:
`pnpm install --frozen-lockfile` exit 0 (9.6 s; lockfile hash
identical; the pre-build bin-link WARN for `incident-zero-verify` is
benign and disappears after build), `pnpm db:generate` exit 0,
`pnpm build` exit 0, and a full `pnpm incident-zero:verify` run against
the real stack: **exit 0, fresh run IDs, VULNERABLE 25/25, SECURE
21/21**. Portability (R-15) holds on a spaced path. This closes the
§41 blocking requirement and replaces the builder's false §15 claim
(C3).

## 24. Self-audit corrections applied

`docs/reports/phase-11-self-audit.md` (and `SECURITY.md`) were corrected
in place, each marked `[AUDIT CORRECTION]`; false content was never
left standing alongside the truth. Applied: §15 spaces falsehood (C3);
§2 "12 phase tags" → 11 (R-02 count fix); §10 single-invocation
limitation re-attributed to the builder session's shell timeout and
closed with this audit's end-to-end runs; §10 clean-clone residual risk
closed by this audit's clean-checkout proof (§9 above); broken refs
§22→§17, §30→§16, SECURITY.md §22→§17 (C4). The self-audit's substance
(genuine fixes, real gates) was confirmed, not merely trusted.

## 25. Honest limitations and residual risks

1. **CI workflow never executed on a real remote runner.** No push is
   permitted (R-16; brief), so `.github/workflows/ci.yml` is validated
   statically (YAML parse; every composed command run green locally,
   including on a clean checkout) but its first real run remains a
   post-publication follow-up for the owner.
2. Overclaim greps are pattern-based checks of tracked files, not a
   semantic guarantee of every doc sentence; the R-18-critical surfaces
   (README, SECURITY.md, verifiers) were read directly.
3. The 7 audit findings are dev-reachable only **as of today's
   advisories**; dependency triage is a recurring duty, not a one-time
   gate.
4. `vitest` remains resolved via the root devDependency rather than
   declared per-package (builder's accepted residual risk, unchanged).
5. Scratch logs (`tmp-showcase-video*.log` at repo root) predate
   Phase 11, are untracked and gitignored; left in place.

## 26. Owner decisions required (publication blockers)

1. **License** — choose and add a LICENSE file (legal decision);
   `license: UNLICENSED` stays until then.
2. **Security contact** — dedicated mailbox or GitHub Security
   Advisories; SECURITY.md marks it pending owner decision.
3. **Public repository URL** — root `package.json` `repository`/
   `homepage` were removed with C1 and must be re-added with the real
   URL once it exists.
4. **Copyright holder** — needed for the chosen license text.
5. **Release hosting** — source archive vs public git host; npm
   publication is not part of v1.0 (all workspace packages `private`).
6. **ffmpeg-static licensing confirmation** — confirm GPL-3.0-or-later
   obligations are acceptable for showcase video artifacts, or drop the
   optional video feature from the release.

## 27. Reproduction commands (rerunnable evidence)

All evidence is rerunnable from a clean checkout:
`corepack enable && pnpm install --frozen-lockfile && cp .env.example
.env && pnpm infra:up && pnpm db:migrate && pnpm verify &&
pnpm test:integration && pnpm release:verify` — plus
`pnpm showcase:generate [--video]`, `pnpm audit`, and the Prisma 7
diff command from §20. Negative controls in §6 reproduce by injecting
the stated defects and observing the stated exits.

## 28. Constitution compliance notes

- R-01: only Phase 11 scope touched; corrections are release-prep
  scope. R-02/R-03/R-07: every claim in this report was observed in
  this session; two of the auditor's own errors (integration-DB
  deviation; worker-startup revert accident) are recorded, not hidden.
- R-04/R-17: no architecture change; documentation corrections shipped
  in the same change as the findings that motivated them.
- R-05/R-08/R-09/R-10: verifiers ran against the real, separated
  stacks; `INDETERMINATE`/`KNOWN_ABSENT` semantics observed intact.
- R-06/R-13/R-14/R-15/R-16/R-18/R-19/R-20: no money-related changes;
  no secrets introduced or persisted; boundaries untouched and
  verifier-checked; portability proven (§9, §23); no git mutations;
  terminology greps clean; doc claims checked against behavior.

## 29. Final verdicts

- **PHASE 11 CODE-READY: ACCEPTED.** The builder's release-preparation
  work is genuine and complete; the audit's 10 corrections are applied
  and re-proven; all release gates pass on the real stack, on a clean
  checkout, and on a spaced path.
- **PUBLISH-READY: BLOCKED ON OWNER DECISIONS** — license, security
  contact, repository URL, copyright holder, release hosting, and the
  ffmpeg-static licensing confirmation (§26). Once those decisions land
  (URL re-added, LICENSE added, contact published), the tree is a
  source release ready for the owner's chosen publishing route; the CI
  workflow's first real remote run remains the only post-publication
  verification debt.

No commit was made; no tag was created; nothing was pushed. The tree is
left with the builder's diff plus the audit corrections, uncommitted,
for the owner to review.
