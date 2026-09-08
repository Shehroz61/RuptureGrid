# RuptureGrid v1.0 — Phase Roadmap

Status: **Phase 0 — roadmap definition only.**
This document is the ordered, gated plan from Phase 0 to public-ready product. Later phases must not begin until the prior phase's exit criteria are met ([AGENTS.md](../AGENTS.md) R-01, ADR-0013).

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

**Post-v1 directions (not scheduled):** CI/CD integration mode, self-hosted multi-user deployment, private-network execution agent, SaaS control plane ([product-spec.md](product-spec.md) §6) — each requires its own architecture phase and ADRs. Production fault targeting remains **denied** unless a dedicated future security architecture explicitly enables it.
