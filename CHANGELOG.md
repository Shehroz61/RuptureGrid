# Changelog

All notable changes to RuptureGrid are documented here. Versions follow
the product release policy in `docs/reports/phase-11-self-audit.md` §6:
the **root `package.json` `version` field is the single authoritative
release version**; protocol/schema version strings (`controlled-fault/v1`,
normalizer and derivation versions, `EXECUTION_ENGINE_VERSION`) are
semantic protocol versions and are deliberately NOT release versions.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-09-24 (code-ready)

First public release candidate of RuptureGrid. Everything below was
delivered through phases 0–10, each independently audited and accepted
(tags `phase-0-accepted` … `phase-10-accepted`); reports live in
`docs/reports/`. Phase 11 prepared this release without changing product
semantics.

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
- 33 unit test files (319 tests) and 23 real-infrastructure integration
  test files (152 tests) — real PostgreSQL ×2, real Redis, real TCP HTTP,
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
  scripts. No repository URL is declared anywhere in package metadata —
  assigning one is an owner decision and none is invented here.
- README rewritten to the truthful v1.0 state: accepted phase status,
  complete quickstart with no hidden steps, verification-command table,
  current repository layout.

### Security

- No secrets are committed; `.env` is gitignored and `.env.example`
  contains non-production placeholder values only. Credential handling is
  reference-only end to end (ADR-0012).

### Known limitations

See `docs/reports/phase-11-self-audit.md` §"Remaining risks" and
`docs/security-boundaries.md` §5 (DNS-rebinding TOCTOU honesty, egress
isolation as primary control). Publication of this repository (license,  public URL, security contact) requires owner decisions recorded in the
Phase 11 report.

Version headings above intentionally carry no link targets: no public
repository URL has been assigned (owner decision), so no comparison links
can be defined. Do not invent one.
