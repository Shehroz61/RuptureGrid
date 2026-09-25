# Changelog

All notable changes to RuptureGrid are documented here. Versions follow
the product release policy in `docs/reports/phase-11-self-audit.md` §6:
the **root `package.json` `version` field is the single authoritative
release version**; protocol/schema version strings (`controlled-fault/v1`,
normalizer and derivation versions, `EXECUTION_ENGINE_VERSION`) are
semantic protocol versions and are deliberately NOT release versions.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-09-25 (prepared for v1.0.0 release)

Prepared for the v1.0.0 public source release of RuptureGrid — not yet
published or tagged. Everything below was
delivered through phases 0–10, each independently audited and accepted
(tags `phase-0-accepted` … `phase-10-accepted`); reports live in
`docs/reports/`. Phase 11 prepared this release without changing product
semantics.

### Release policy (publication closure)

- Licensed **Apache-2.0** — the official license text is in `LICENSE`.
  `license` metadata is `Apache-2.0` in the root manifest and in the three
  workspace manifests that previously carried `UNLICENSED`
  (`@rupturegrid/controlled-faults`, `@rupturegrid/incident-zero`,
  `@rupturegrid/showcase`); the remaining workspace manifests, all
  `private: true`, declare no license field. No copyright-holder identity
  was invented.
- **Source-only release:** v1.0.0 publication consists of source,
  documentation, migrations, tests, and verifier/showcase source. It
  does NOT include npm package publication, Docker image publication,
  prebuilt binaries, bundled FFmpeg binaries, or generated showcase
  media.
- Security disclosure runs through **GitHub Private
  Vulnerability Reporting**, enabled by the repository owner on the
  public repository (see `SECURITY.md`). No security email exists or is
  invented.
- The real public repository is `https://github.com/Shehroz61/RuptureGrid`;
  the root `package.json` declares it as `repository`, `homepage`, and
  `bugs` metadata. Workspace manifests remain `private: true` and carry
  no repository metadata.
- `ffmpeg-static` remains a development/showcase dependency only; no
  FFmpeg binary is bundled or distributed as a RuptureGrid release
  artifact (see `THIRD_PARTY_NOTICES.md`).

### Added — platform

- pnpm/TypeScript monorepo (Node ≥ 22.12, pnpm ≥ 11) with four applications
  and thirteen workspace packages, all quality gates reproducible from a
  clean checkout.
- Control Plane HTTP API (NestJS) exposing targets, experiments, runs,
  evidence, analysis, forensics, timeline, and run comparison.
- Execution worker with durable PostgreSQL lease + fencing-token
  ownership, BullMQ coordination (coordination-only), reconciliation
  recovery after Redis loss, and honest side-effect-knowledge
  classification including `INDETERMINATE`.
- Deterministic evidence truth chain: redacted-before-persistence raw
  observations, hash-chained append-only storage, versioned pure
  normalizers, identity-based causal relationships, deterministic
  invariant evaluation (`PASS` / `FAIL` / `NOT_EVALUABLE`), and an
  integrity verifier that detects post-hoc modification (not
  tamper-proofing).
- Deterministic forensic layer: Findings derived only from persisted
  invariant evaluations, versioned forensic timeline with explicit
  ordering bases, reproduction definitions bound to frozen hash-pinned
  snapshots, computed-on-read run comparison.
- Investigation UI (Next.js) reading only through the Control Plane API:
  runs, execution, evidence, timeline, findings, reproduction — with
  honest empty/error states and `INDETERMINATE`/`NOT_EVALUABLE` rendered
  as first-class outcomes.
- Demo Fintech target: a genuinely separate application owning its own
  PostgreSQL (wallets, payments, events, deliveries, attempts, effects,
  ledger) with a signed webhook endpoint, deterministic VULNERABLE/SECURE
  processing modes, provider simulator, read-only inspection API, and
  target-owned controlled-fault plans (LOCAL_DEVELOPMENT targets only;
  production/staging denied server-side).
- Security boundaries: registered targets only, deny-by-default
  destination validation with DNS-aware address-class policy, redirect
  refusal, credential-reference-only secrets (redacted before any
  persistence), server-side blast-radius caps, timing-safe token
  comparison, raw-byte HMAC verification.

### Added — verification & scenario assets

- Incident Zero golden scenario: one command (`pnpm incident-zero:verify`)
  executes the canonical duplicate-webhook workload against the real stack
  in both modes and verifies durable truth (VULNERABLE ⇒ INV-IZ-1 FAIL
  with 1 Finding; SECURE ⇒ PASS with 0 Findings).
- Controlled-faults verifier (`pnpm controlled-faults:verify`): pre-send
  rejection and post-send response-loss scenarios, asserting zero unsafe
  retries, preserved `INDETERMINATE` knowledge, and clean fault-plan TTL
  hygiene.
- Showcase automation (`pnpm showcase:generate`, optional `--video`):
  real browser captures over a fresh verifier-produced run, every artifact
  content-gated and provenance-stamped; all output gitignored.
- 32 unit test files (313 tests) and 24 real-infrastructure integration
  test files (158 tests) — real PostgreSQL ×2, real Redis, real TCP HTTP,
  real browser; no mocks stand in for infrastructure semantics.
- GitHub Actions CI running the same gates on real PostgreSQL ×2 and Redis
  services (`.github/workflows/ci.yml`).
- Release verification script `pnpm release:verify` (verify + Incident
  Zero + Controlled Faults).

### Changed — Phase 11 release preparation (no product-semantics change)

- Test-gate coverage closed: package-local `*.test.ts` files and all of
  `tests/**` are now typechecked (`tsconfig.checks.json`,
  `tsconfig.checks.ui.json`) and linted (root eslint program) — the two
  gate blind spots proven by the Phase 10 independent audit (AUDIT-1/
  AUDIT-4 classes) can no longer hide defects; verified with intentional
  error probes.
- Root `package.json` gained `"type": "module"` (the repo has no root
  CommonJS entry points) so the test tree is ESM under both vitest and
  tsc.
- `packages/demo-db` now declares its real `prisma.config.ts` dependency
  on `@rupturegrid/config` (devDependency) instead of relying on
  workspace hoisting; lockfile regenerated through pnpm and re-proven
  with a frozen install.
- Root metadata completed: version, engines, packageManager, release
  scripts. Repository/homepage/bugs URLs were added to the root manifest
  after Phase 11, when the real public repository was created.
- README rewritten to the truthful v1.0 state: accepted phase status,
  complete quickstart with no hidden steps, verification-command table,
  current repository layout.

### Fixed — post-publication CI repair

- Test classification: `packages/evidence/src/observation-identity.test.ts`
  (the real-PostgreSQL RawObservation identity suite) was misclassified as
  a unit test by the root unit glob and failed on clean CI databases
  (Prisma P2021: relation `control.target_origin` does not exist) because
  unit tests intentionally run before migrations. The suite moved to
  `tests/integration/observation-identity.test.ts` on the shared
  integration harness; unit = 32 files / 313 tests, integration = 24 files
  / 158 tests. Counts changed only through the reclassification; no
  assertion, migration, or production-semantics change.

### Security

- No secrets are committed; `.env` is gitignored and `.env.example`
  contains non-production placeholder values only. Credential handling is
  reference-only end to end (ADR-0012).

### Known limitations

See `docs/reports/phase-11-self-audit.md` §"Remaining risks" and
`docs/security-boundaries.md` §5 (DNS-rebinding TOCTOU honesty, egress
isolation as primary control). The remaining publication to-do list
lives in `docs/reports/release-checklist.md`.

Version headings above intentionally carry no link targets: `[1.0.0]` is
the initial release with no prior version to compare against. Comparison
links in future entries may anchor against the public repository
(`https://github.com/Shehroz61/RuptureGrid`).
