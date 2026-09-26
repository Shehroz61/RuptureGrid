# RuptureGrid v1.0 — Phase Roadmap

Status: **v1.0 phases 0–11 accepted and frozen (released v1.0.1); v1.1 design frozen in Phase 12 — Phases 13–19 defined, not implemented.**
This document is the ordered, gated plan from Phase 0 through the v1.0 release (Phases 0–11, accepted and frozen) and the v1.1 **Second-Domain Generalization Proof** (Phases 12–19). Later phases must not begin until the prior phase's exit criteria are met ([AGENTS.md](../AGENTS.md) R-01, ADR-0013).

---

## Phase 0 — Product Definition + Architecture + Engineering Constitution (this phase)

- **Goal:** the architectural constitution for everything that follows.
- **Scope:** documentation set, ADRs, requirements matrix, self-audit. No runtime code, no dependencies.
- **Non-scope:** everything runnable.
- **Prerequisites:** clean greenfield workspace, git repository.
- **Acceptance:** all required documents exist and are internally consistent; requirements matrix complete; phase boundary audit passes (no runtime artifacts); Git checks clean.
- **Testing:** none (no code exists) — consistency is verified by the adversarial self-audit ([reports/phase-0-self-audit.md](reports/phase-0-self-audit.md)).
- **Security considerations:** security boundaries documented ([security-boundaries.md](security-boundaries.md)).
- **Deliverables:** the full `docs/` set, README, AGENTS.md, ADRs, this matrix.
- **Exit criteria:** verdict "PHASE 0 READY FOR INDEPENDENT AUDIT" from the builder; independent audit pending (builder cannot self-accept).

## Phase 1 — Monorepo + Core Infrastructure Foundation

- **Goal:** the portable skeleton all later phases build on.
- **Scope:** pnpm monorepo; root toolchain (verified versions per ADR-0001 policy); API shell (NestJS), worker process shell, web shell (Next.js), Demo Target shell; PostgreSQL (RuptureGrid) + separate Target PostgreSQL + Redis via Docker Compose; environment validation; structured logging with correlation IDs; health/readiness endpoints; graceful shutdown; foundational integration tests (real PG/Redis); migration tooling established.
- **Non-scope:** business logic, experiment engine, UI features.
- **Prerequisites:** Phase 0 accepted.
- **Acceptance:** all four processes boot against real infrastructure from a clean checkout on any machine; graceful shutdown proven under real signals; environment validation rejects invalid configs fail-fast.
- **Testing:** integration tests against real PostgreSQL/Redis; process-level tests for shutdown/readiness.
- **Security:** secrets via environment only; `.env` examples without values; no ports/paths in source.
- **Deliverables:** workspace layout, compose file, health/readiness, logging foundation, CI-able test harness.
- **Exit criteria:** clean typecheck/lint/build; runtime verification evidence; independent audit passed.

## Phase 2 — Purpose-Built Demo Target

- **Goal:** the external fintech target that makes everything provable.
- **Scope:** domain model (Customer, Wallet, ProviderPayment, ProviderEvent, WebhookDelivery, ProcessingAttempt, FinancialEffect, LedgerEntry); webhook ingestion; **vulnerable and secure/idempotent processing modes** switchable via target-owned admin API; target-authored read-only inspection API; own PostgreSQL instance and migrations; integer minor units (paisa) everywhere.
- **Non-scope:** RuptureGrid engine features; UI.
- **Prerequisites:** Phase 1.
- **Acceptance:** target runs as a fully external app (RuptureGrid has no target-DB credentials); both modes demonstrably behave per [incident-zero.md](incident-zero.md) §6 under real duplicate delivery driven by curl/scripts; inspection API read-only.
- **Testing:** real HTTP tests; concurrency tests with measured overlap; mode-switch tests; money-integer tests.
- **Security:** target validates webhook signatures (provider simulation contract); no RuptureGrid credentials to target DB; admin API explicit and local-development scoped.
- **Deliverables:** demo target application, its migration set, inspection API, mode contract documentation.
- **Exit criteria:** independent audit confirms external-ownership boundary and both modes' behavior.

## Phase 3 — Experiment Execution Engine

- **Goal:** real controlled execution with durable ownership.
- **Scope:** Control Plane domain model + snapshots; run/step state machines; BullMQ dispatch; worker claims with **leases, heartbeats, fencing tokens**; HTTP target adapter with destination validation ([security-boundaries.md](security-boundaries.md) §3–§6); fault plan primitives (duplicate delivery, post-send timeout); repeat/concurrency/timeout with server-side caps; outcome classification incl. **INDETERMINATE**; retry policy ([architecture.md](architecture.md) §7); cancellation; **reconciliation** (Redis-outage scenario); stale-writer safety.
- **Non-scope:** evidence analytics beyond raw capture, invariant engine, UI.
- **Prerequisites:** Phases 1–2.
- **Acceptance:** fencing scenario test (stale worker rejected); Redis-outage reconciliation test (no lost runs); INDETERMINATE classification table test-verified; snapshot append-only enforcement test; destination validation probes pass.
- **Testing:** full adversarial catalog items 1–7 applicable subset ([testing-strategy.md](testing-strategy.md) §4); multi-worker process tests; measured overlap.
- **Security:** destination validation live; production denial enforced; blast-radius caps enforced server-side.
- **Deliverables:** execution engine, snapshots, reconciliation, adapter, documented state machines.
- **Exit criteria:** real runtime verification with multiple workers; independent audit.

## Phase 4 — Evidence Capture + Business Invariant Engine

- **Goal:** capture truth durably; evaluate business rules deterministically.
- **Scope:** evidence ingestion (append-only, content-addressed, per-run hash chain); redaction-before-persistence ([security-boundaries.md](security-boundaries.md) §7); versioned normalizers; normalized events; identity-based causal relationships with attribution bases; versioned invariant engine (PASS/FAIL/NOT_EVALUABLE); INV-IZ-1 implementation; target-state verification via inspection API (+ optional read-only observer adapter, explicitly configured).
- **Non-scope:** findings UX, timelines UI, screenshots.
- **Prerequisites:** Phase 3.
- **Acceptance:** chain-tamper detection test; redaction completeness probe (no secrets in store/logs); invariant determinism test; INV-IZ-1 evaluated correctly on seeded evidence sets; NOT_EVALUABLE surfaced honestly.
- **Testing:** unit (normalizers, engine), integration (PG append-only semantics), adversarial (tamper, redaction, determinism).
- **Security:** redaction verified by tests; evidence access least-privilege.
- **Deliverables:** evidence system, normalizers, causal reconstruction, invariant engine, INV-IZ-1.
- **Exit criteria:** independent audit with re-run evaluations.

## Phase 5 — Forensic Analysis + Timeline + Findings

- **Goal:** turn evidence into investigation.
- **Scope:** findings with provenance ([evidence-model.md](evidence-model.md) §8); timeline assembly with ordering bases; comparison of runs (post-fix replay groundwork); reproduction definitions generated from snapshots; investigation APIs.
- **Non-scope:** AI features (deferred, optional), UI.
- **Prerequisites:** Phase 4.
- **Acceptance:** a vulnerable-mode Incident Zero run yields a complete, evidence-referenced finding and investigation-ready timeline; attribution bases present; reproduction definition round-trips.
- **Testing:** determinism of finding derivation; timeline ordering-basis tests; comparison correctness.
- **Security:** findings expose no secrets; provenance complete.
- **Deliverables:** analysis completion layer, reproduction definitions, investigation APIs.
- **Exit criteria:** independent audit traces a finding end-to-end to raw observations.

## Phase 6 — Product Design System + Main Application UI

- **Goal:** the human-designed product interface.
- **Scope:** design system per [product-design.md](product-design.md); screens: Overview, Experiment Builder, Run Detail, Evidence, Causal View, Timeline, Invariant View, Incident Zero; tables/lists, filtering, comparison views; full a11y/responsiveness contract; long-ID and large-evidence handling; states (loading/empty/error/INDETERMINATE).
- **Non-scope:** fake content, decorative dashboards (rejected), AI features.
- **Prerequisites:** Phase 5.
- **Acceptance:** **independent visual/product audit passes** — the UI does not read as a generic AI dashboard ([product-design.md](product-design.md) §8); rendered inspection at multiple viewports; keyboard/focus/a11y checks; every displayed value traceable to evidence.
- **Testing:** Playwright E2E over real runs; visual audit at multiple viewports; a11y checks.
- **Security:** UI never displays secrets; redaction notices visible in Evidence views.
- **Deliverables:** design system, all core screens, audit report.
- **Exit criteria:** audit-passed UI over real data.

## Phase 7 — Incident Zero End-to-End Golden Scenario

- **Goal:** the flagship scenario as a one-click (and scripted) reality.
- **Scope:** full Incident Zero experiment definitions for both modes; E2E run through UI and API; forensic narrative rendering ([incident-zero.md](incident-zero.md) §10); **permanent regression suites** (vulnerable⇒FAIL, secure⇒PASS); post-fix replay demonstration.
- **Non-scope:** new fault classes.
- **Prerequisites:** Phases 2–6.
- **Acceptance:** both modes produce deterministic, evidence-backed verdicts in a real end-to-end run; regression suites committed and green; replay-from-snapshot works against a "fixed" target.
- **Testing:** E2E (real processes, real HTTP, real concurrency); regression suites; determinism checks.
- **Security:** full destination/redaction validation active in the golden path.
- **Deliverables:** golden scenario, regression suite, guided Incident Zero view.
- **Exit criteria:** independent audit replays the scenario from scratch.

## Phase 8 — Automated Demo / Screenshots / Video Showcase

- **Goal:** honest, reproducible showcase material.
- **Scope:** scripted demo against a real local stack; screenshot set; video (FFmpeg) produced from real runs — every number real; no fabricated UI states.
- **Non-scope:** marketing claims beyond verified behavior.
- **Prerequisites:** Phase 7.
- **Acceptance:** demo reproducible from a clean checkout; every depicted value traceable to a real run; visual audit of depicted screens.
- **Testing:** the demo script itself is a test (deterministic scenario runner).
- **Security:** no secrets in any artifact; demo uses local-development target only.
- **Deliverables:** demo assets, scripts, documentation.
- **Exit criteria:** independent audit reruns the demo script.

## Phase 9 — Additional Controlled Faults + Observability

- **Goal:** broaden failure coverage; add deep visibility.
- **Scope:** additional fault primitives (connection drop, response truncation, staggered redelivery waves, crash-mid-processing via a target-owned fault hook); new invariant kinds (balance conservation, no-negative-balance); OpenTelemetry instrumentation; observability of the engine itself (queues, leases, reconciliation metrics).
- **Non-scope:** production fault targeting (still denied); infrastructure chaos.
- **Prerequisites:** Phase 7.
- **Acceptance:** each new fault has adversarial tests; INDETERMINATE semantics exercised by every ambiguous fault; telemetry shows real traces for real runs.
- **Testing:** adversarial catalog extensions; measured concurrency for each fault.
- **Security:** each new fault re-reviewed against [security-boundaries.md](security-boundaries.md).
- **Deliverables:** fault library v2, invariants v2, telemetry.
- **Exit criteria:** independent audit.

## Phase 10 — Full Engineering / Security / Reliability Audit

- **Goal:** prove the whole system against its constitution.
- **Scope:** end-to-end audit: every [AGENTS.md](../AGENTS.md) rule, every adversarial catalog item on the full stack, performance/limits under real load, failure-injection drills (PG pause, Redis loss, worker kill, disk pressure), documentation-vs-implementation conformance.
- **Non-scope:** new features.
- **Prerequisites:** Phase 9.
- **Acceptance:** written audit report with findings triaged; all blockers fixed; regression suites green.
- **Testing:** the audit **is** testing; full suite execution on real infrastructure.
- **Security:** threat model re-verified against [security-boundaries.md](security-boundaries.md) table-by-table.
- **Deliverables:** audit report(s), fixed blockers.
- **Exit criteria:** no open blockers; independent auditor sign-off.

## Phase 11 — Public Release Preparation

- **Goal:** make the project usable by strangers.
- **Scope:** installation/onboarding docs, versioned release, CI pipeline (full suites on real infrastructure), licensing decision, public repository hygiene, roadmap publication; optional GitHub workflows (using minimum required permissions per [AGENTS.md](../AGENTS.md) R-16).
- **Non-scope:** commercial features (billing/orgs/SSO) — still deferred.
- **Prerequisites:** Phase 10.
- **Acceptance:** a stranger can go from clone to Incident Zero following only the documentation; CI green on real infrastructure; secrets scan clean.
- **Testing:** fresh-environment E2E as the release gate.
- **Security:** final secrets/dependencies review; release artifacts verified.
- **Deliverables:** release, docs, CI.
- **Exit criteria:** release accepted by independent audit.

---

---

# v1.1 — Second-Domain Generalization Proof (Phases 12–19)

Theme: prove RuptureGrid tests business correctness for a second, independent domain that was NOT
designed around Incident Zero — through a data-only target manifest, a closed declarative
invariant registry, a headless CLI with honest exit semantics, a machine-readable report, and a
replay/regression lifecycle. Design frozen in Phase 12 (ADR-0016 … ADR-0020,
[checkout-zero.md](checkout-zero.md)). No phase below may begin before the prior phase's audit gate.

Honest scope of the v1.1 proof: it establishes **cross-domain generalization** (the truth chain,
attribution rules, and uncertainty semantics hold on a second, independent domain),
**external-in-kind target integration** (a target integrates through a data-only manifest over
its own HTTP interfaces with no RuptureGrid imports and no shared database), and **onboarding
readiness from documentation** (the Phase 19 stranger test). It does NOT establish independent
third-party adoption, production adoption, or external organization usage — the stranger test is
an adoption-readiness test, not evidence that any third party adopted RuptureGrid.

## Phase 12 — v1.1 Design Freeze + Living-Documentation Repair (this phase)

- **Goal:** freeze the v1.1 design contract BEFORE any implementation; repair living-documentation staleness left by the v1.0.1 release.
- **Scope (files/components likely touched):** ADRs 0016–0020 (target-manifest/v1; typed identity declarations + causal edges; business-invariant/v1 closed registry with corrected conservation semantics; headless CLI + rupturegrid-report/v1 + replay lifecycle + distribution honesty; Checkout Zero + repeat-not-retry safety model); new [checkout-zero.md](checkout-zero.md); status-banner and staleness repair across the living core docs (README publication status, root package.json description, Phase-0 banners, machine-specific path wording, this roadmap's v1.1 section).
- **Non-scope (explicit non-goals):** any runtime implementation; any migration; CHANGELOG entries (they belong to the Phase 19 release); rewriting anything under `docs/reports/` (historical evidence, byte-for-byte untouched); no third invariant kind; no reference-target example (ADR-0016 Decision 4).
- **Prerequisites:** v1.0.1 published and CI-green; roadmap direction accepted with mandated corrections (repeat ≠ retry; corrected conservation model; target claims never create truth; no hard-coded five-identity chain; source-only CLI honesty; no redundant reference target).
- **Acceptance:** all v1.1 documents internally consistent with the constitution and with each other; validation gates green (`format:check`, `lint`, `typecheck`, `unit`, `build`, `git diff --check`) with zero runtime changes.
- **Testing:** none (documentation phase) — consistency is verified by the gates above and the Phase 12 audit.
- **Security:** the design-level security deltas are fixed inside the ADRs (conservative generic contract semantics; target-declared metadata can never yield `KNOWN_ABSENT`; manifest ingestion is closed-schema data-only; fault-gate generalization keeps the LOCAL_DEVELOPMENT-only rule; the report is a canary-scanned secret-free surface).
- **Deliverables:** five ADRs, checkout-zero.md, updated roadmap, corrected living docs.
- **Exit criteria:** verdict "READY FOR INDEPENDENT PHASE 12 AUDIT" from the builder; independent audit pending (builder cannot self-accept).

## Phase 13 — Target Manifest + Control-Plane Support

- **Goal:** target-manifest/v1 registered, stored, and enforced end to end (ADR-0016).
- **Scope:** `packages/control-db` additive migration (manifest storage as registration provenance); `apps/api` registration endpoint accepting manifests; `packages/engine` validation changes (manifest-driven header/signature policy, conservative `GENERIC_HTTP` contract semantics, fault-gate generalization from the hard-coded `/webhooks/provider` path to the manifest-declared hook — environment gate unchanged); `packages/shared`/`packages/config` limits.
- **Non-scope:** generic inspection adapter/normalizer (Phase 14); invariant registry (Phase 15); demo-commerce (Phase 16); CLI (Phase 17).
- **Prerequisites:** Phase 12 accepted.
- **Acceptance:** enumerated manifest accept/reject cases (closed schema, unknown fields, size caps, refused versions); the golden Incident Zero and controlled-faults suites pass **unchanged** (back-compat proven by execution, never assumed — R-07); staging/production denial re-probed; a target-declared `noEffectOnRejection` demonstrably never produces `KNOWN_ABSENT` by itself.
- **Testing:** unit + integration + adversarial (destination/validation probes per testing-strategy §4.7).
- **Security:** security review gate per security-boundaries §10 — manifest ingestion and the generalized fault gate are the audited deltas.
- **Deliverables:** manifest schema, storage, registration API, engine policy changes.
- **Exit criteria:** independent audit including the security review.

## Phase 14 — Generic Inspection + Causal Derivation

- **Goal:** inspection/v1 evidence adapter and manifest-driven typed derivation (ADR-0017).
- **Scope:** `packages/evidence` (adapter registry, generic inspection adapter, generic normalizer emitting typed events, causal derivation by declared exact-equality edges with `identity-direct`/`identity-chain` bases); `apps/worker` adapter invocation seam.
- **Non-scope:** invariant registry (Phase 15); finding registry (Phase 15); UI changes; demo-commerce.
- **Prerequisites:** Phase 13.
- **Acceptance:** determinism (same observations ⇒ same events/relationships, idempotent derivation); undeclared/unknown shapes produce **no events**; the demo lineage adapter path is behavior-identical (frozen golden suites green); no timestamp, fuzzy, or inferred linkage anywhere in the new path.
- **Testing:** unit (normalizer/derivator purity) + integration (real evidence chain) + adversarial (identity mismatch ⇒ NOT_EVALUABLE inputs, malformed declarations).
- **Security:** read-only adapter posture; redaction-before-persistence unchanged; adapter use recorded as evidence provenance.
- **Deliverables:** generic adapter + manifest-driven derivation.
- **Exit criteria:** audit traces a foreign-manifest evidence set end-to-end from raw observations to causal relationships.

## Phase 15 — Invariant Registry + Finding Registry

- **Goal:** business-invariant/v1 with exactly two kinds, plus the finding-rule registry (ADR-0018).
- **Scope:** `packages/evidence` (invariant registry: `atMostOneAcceptedEffect`, `resourceConservation` with the corrected conservation model); `packages/forensics` (finding-rule registry, new bounded reason codes); `packages/control-db` additive migration (new enum values); `apps/api` analysis wiring; the Phase 15 conformance suite.
- **Non-scope:** a third invariant kind; user code/SQL/expressions; UI scenario builders; modifying the frozen INV-IZ-1 evaluator.
- **Prerequisites:** Phase 14.
- **Acceptance:** pure-evaluator truth tables for both kinds (exact PASS/FAIL/NOT_EVALUABLE rules incl. missing-baseline ⇒ NOT_EVALUABLE, never inferred); definition-time validation reject-cases (undeclared event types/fields, malformed params); **conformance test proves the generic `atMostOneAcceptedEffect` evaluator agrees with the frozen INV-IZ-1 evaluator on canonical Incident Zero fixtures, including NOT_EVALUABLE attribution-gap cases**; PASS/NOT_EVALUABLE produce no findings.
- **Testing:** unit truth tables + integration + adversarial (attribution gaps, fabricated-but-inconsistent remaining-state figures).
- **Security:** no new execution surface (evaluation is pure over persisted evidence); audit re-runs evaluations from persisted evidence.
- **Deliverables:** invariant registry, finding registry, conformance suite.
- **Exit criteria:** independent audit re-derives verdicts from persisted evidence.

## Phase 16 — Demo Commerce Target

- **Goal:** the second external-in-kind target (ADR-0020): `apps/demo-commerce`.
- **Scope:** `apps/demo-commerce` (checkout/inventory domain: checkout intents, request/processing attempts, orders, reservations, SKU stock) with its **own PostgreSQL instance** (compose service; own migrations); VULNERABLE/SECURE modes via the target's own admin API; inspection/v1 read-only API; `controlled-fault/v1` hooks at the manifest-declared fault surface; its target manifest; `packages/config` env schema; root lint rule (no RuptureGrid app imports the commerce DB — mirroring the demo-db rule).
- **Non-scope:** RuptureGrid-side scenario wiring (Phase 17); new fault kinds beyond `controlled-fault/v1`; UI.
- **Prerequisites:** Phase 15.
- **Acceptance:** external-ownership boundary proven (no commerce-DB credentials in any RuptureGrid app; lint-enforced); both modes behave per checkout-zero.md under deliberate concurrent duplicate submissions with measured overlap from persisted processing timestamps (testing-strategy §6 — barriers + authoritative state, never `Promise.all` optimism); inspection API read-only; **the audit confirms the target implements its own business logic and was not built around its invariant** (the invariant is RuptureGrid-side).
- **Testing:** real HTTP; concurrency measured; mode-switch; integer-unit tests (R-06).
- **Security:** LOCAL_DEVELOPMENT classification; staging fault-execution denial probed for the new target.
- **Deliverables:** demo-commerce app, migrations, compose service, manifest.
- **Exit criteria:** independent audit of external ownership and mode behavior.

## Phase 17 — Checkout Zero + Headless CLI + Report

- **Goal:** the golden v1.1 scenario executable headlessly with honest reporting (ADR-0019, ADR-0020).
- **Scope:** `packages/cli` (validate/run flow: revision → snapshot → dispatch → bounded-poll wait → idempotent analysis → evidence-integrity check → report → exit; the five-way exit contract); scenario-document loader + closed-schema validation; `rupturegrid-report/v1` emitter + published JSON Schema; Checkout Zero golden definitions for both modes; documentation.
- **Non-scope:** replay command (Phase 18); UI; public CLI distribution (deferred — source-only policy stands).
- **Prerequisites:** Phase 16.
- **Acceptance:** both modes produce deterministic, evidence-backed verdicts via the CLI alone; all five exit classes verified, including forced `NOT_EVALUABLE` and forced `EXECUTION_FAILURE` paths; the report validates against the published schema and is canary-clean (R-13); the canonical path proves repeat ≠ retry (duplicate pressure from declared concurrent repeats; **no automatic retry anywhere**); the separate response-loss proof shows INDETERMINATE persisted and zero unsafe retries.
- **Testing:** E2E over real processes (real HTTP, real queue, real PostgreSQL); exit-code decision table; report schema round-trip.
- **Security:** full destination/redaction validation on the new path; report included in canary leak-scan surfaces.
- **Deliverables:** CLI, report emitter, golden scenario.
- **Exit criteria:** independent audit reruns the scenario from scratch and re-derives every report number from durable Control-Plane truth.

## Phase 18 — Replay/Regression Lifecycle

- **Goal:** close the failure → reproduction → fix → replay → regression-proof loop (ADR-0019 Decision 4).
- **Scope:** `packages/cli` replay command (new run from the same hash-pinned snapshot); acceptance-expectation assertions; run-comparison surfacing; committed regression suites for BOTH domains; the external-CI recipe documentation (checkout-invoked, per the distribution-honesty rule).
- **Non-scope:** detecting scheduling variance beyond the incident-replay §4–§5 honesty table; automatic fix verification services.
- **Prerequisites:** Phase 17.
- **Acceptance:** the full lifecycle demonstrated on demo-commerce: discovered failure → reproduction definition → target fix through its own interfaces → same-snapshot replay → PASS; cross-intent comparison refused; credential-rotation fail-fast re-proven; both regression suites committed and green (vulnerable ⇒ deterministic FAIL + Finding; secure ⇒ PASS + 0 Findings).
- **Testing:** E2E replay + determinism checks.
- **Security:** replay authorization unchanged; credential references only, never values.
- **Deliverables:** replay command, regression suites, CI recipe.
- **Exit criteria:** independent audit performs the lifecycle end-to-end.

## Phase 19 — Independent v1.1 Audit + Release

- **Goal:** prove v1.1 against the constitution; release v1.1.0.
- **Scope:** full adversarial + security re-audit across both targets; the **stranger onboarding test via demo-commerce only** (a fresh contributor connects the target and runs one scenario using only its registered HTTP interface, manifest, inspection contract, credential references, and scenario definition); documentation truth-pass; version bump; CHANGELOG for v1.1.0; release per the source-only policy.
- **Non-scope:** production fault targeting (denied, unchanged); public npm/Docker/binary publication; third target domain (seat-booking exclusivity is the designated next proof); SaaS/multi-tenancy.
- **Prerequisites:** Phase 18.
- **Acceptance:** cross-target generalization suites green; production denial intact; canary + secrets scans clean; a stranger completes onboarding from docs alone; `pnpm release:verify` equivalent green on the release tree.
- **Testing:** fresh-environment E2E as the release gate.
- **Security:** final review; release artifacts verified (source-only).
- **Deliverables:** audit reports, release v1.1.0.
- **Exit criteria:** independent audit sign-off; tag + release per R-16.

---

**Post-v1.1 directions (not scheduled):** third target domain (reservation/seat exclusivity as a third invariant shape), public CLI distribution (npm/Docker/binary — requires its own release-policy ADR), self-hosted multi-user deployment, private-network execution agent, SaaS control plane ([product-spec.md](product-spec.md) §6) — each requires its own architecture phase and ADRs. Production fault targeting remains **denied** unless a dedicated future security architecture explicitly enables it.
