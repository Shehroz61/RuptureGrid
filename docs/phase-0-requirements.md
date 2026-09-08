# RuptureGrid v1.0 — Phase 0 Requirements Matrix

Status: **Phase 0 — traceability record.**
Legend — **Status:** `DOCUMENTED` = Phase 0 documentation defines the contract in the authoritative section (implementation assigned via the *Impl. phase* column); `DONE` = completed action in Phase 0 itself. "Documented contract" never means "implemented" ([AGENTS.md](../AGENTS.md) R-07).

---

## 1. Workspace & boundary

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-001 | Verify workspace exists and is clean greenfield; report state honestly | [../docs/reports/phase-0-self-audit.md](reports/phase-0-self-audit.md) §2 | DONE | — |
| R0-002 | Initialize git repository on `main` (workspace lacked one; no commits) | Self-audit §2 (deviation note) | DONE | — |
| R0-003 | Phase 0 creates documentation only — no runtime artifacts | [../AGENTS.md](../AGENTS.md) R-01; self-audit §6 boundary audit | DONE | — |
| R0-004 | No dependencies installed, no commits/tags/pushes in Phase 0 | Self-audit §6 | DONE | — |

## 2. Product definition

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-010 | Define product purpose, question answered, failure classes | [product-spec.md](product-spec.md) §1–3 | DOCUMENTED | all |
| R0-011 | Define 12-stage product pipeline with owning components | [product-spec.md](product-spec.md) §4; [architecture.md](architecture.md) | DOCUMENTED | 3–5, 7 |
| R0-012 | Answer the nine product questions with mapped capabilities | [product-spec.md](product-spec.md) §5 | DOCUMENTED | 4–7 |
| R0-013 | Users/use cases and commercial direction with evolution seams | [product-spec.md](product-spec.md) §6 | DOCUMENTED | 11+ |
| R0-014 | Explicit non-goals with reasons | [product-spec.md](product-spec.md) §8 | DOCUMENTED | all |
| R0-015 | Truth hierarchy: real execution → … → optional AI interpretation | [product-spec.md](product-spec.md) §9; [evidence-model.md](evidence-model.md) §2 | DOCUMENTED | 4–5 |
| R0-016 | Business identity model (5 identities, collapse rules) | [product-spec.md](product-spec.md) §7; [incident-zero.md](incident-zero.md) §3 | DOCUMENTED | 2, 4 |
| R0-017 | Money as integer minor units (paisa); currency field; equivalence tuple | [product-spec.md](product-spec.md) §10; ADR-0004 | DOCUMENTED | 2, 4 |
| R0-018 | v1 success criteria | [product-spec.md](product-spec.md) §11 | DOCUMENTED | 7 |

## 3. Architecture

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-020 | Architecture principles (truth, ownership, durability, ambiguity, narrow targets, versioned derivation) | [architecture.md](architecture.md) §1 | DOCUMENTED | all |
| R0-021 | Five bounded contexts with responsibilities and why-boundaries rationale | [architecture.md](architecture.md) §2 | DOCUMENTED | 1–5 |
| R0-022 | Physical topology: API, worker(s), Demo Target, web; 3 infrastructure stores | [architecture.md](architecture.md) §3 | DOCUMENTED | 1–2 |
| R0-023 | Data ownership map; hard no-write rule to Target DB | [architecture.md](architecture.md) §4; ADR-0002 | DOCUMENTED | 1–2 |
| R0-024 | Target ownership: legitimate interfaces only; verification adapters read-only/auditable | [architecture.md](architecture.md) §5 | DOCUMENTED | 2–4 |
| R0-025 | Control Plane domain model (TargetSystem…InvariantDefinition, RunSnapshot) | [architecture.md](architecture.md) §6 | DOCUMENTED | 3 |
| R0-026 | Two-dimensional outcome semantics (intentOutcome × sideEffectKnowledge) | [architecture.md](architecture.md) §7.1 | DOCUMENTED | 3 |
| R0-027 | Repeat vs retry distinction; conservative default retry policy | [architecture.md](architecture.md) §7.2 | DOCUMENTED | 3 |
| R0-028 | Timeout as observation, not terminal outcome; server-side caps | [architecture.md](architecture.md) §7.3; [security-boundaries.md](security-boundaries.md) §8 | DOCUMENTED | 3 |
| R0-029 | Run/step state machines; terminal states set once, fenced | [architecture.md](architecture.md) §8 | DOCUMENTED | 3 |
| R0-030 | PostgreSQL durable authority; Redis/BullMQ coordination-only; Redis-outage reconciliation scenario | [architecture.md](architecture.md) §9; ADR-0003 | DOCUMENTED | 1, 3 |
| R0-031 | Execution ownership: leases, heartbeats, fencing tokens, stale-writer rejection; honest limitation stated | [architecture.md](architecture.md) §10; ADR-0009 | DOCUMENTED | 3 |
| R0-032 | RunSnapshot: pinned, canonicalized, hashed, credential references only | [architecture.md](architecture.md) §11; [incident-replay.md](incident-replay.md) §2; ADR-0010 | DOCUMENTED | 3 |
| R0-033 | Portability: no hard-coded paths; environment-driven validated config | [architecture.md](architecture.md) §13; [engineering-rules.md](engineering-rules.md) §6 | DOCUMENTED | 1 |
| R0-034 | Technology direction evaluated; no versions frozen in Phase 0 | [architecture.md](architecture.md) §14; ADR-0001 | DOCUMENTED | 1 |

## 4. Evidence & analysis

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-040 | Canonical evidence terminology (7 terms) | [evidence-model.md](evidence-model.md) §1 | DOCUMENTED | 4–5 |
| R0-041 | Observed / derived / AI-interpreted origin classes + provenance versions | [evidence-model.md](evidence-model.md) §2; ADR-0006, ADR-0007 | DOCUMENTED | 4–5 |
| R0-042 | Raw observation kinds contract | [evidence-model.md](evidence-model.md) §3 | DOCUMENTED | 3–4 |
| R0-043 | Integrity: append-only, content-addressed, hash-chained, with honest limits (not tamper-proof/non-repudiable) | [evidence-model.md](evidence-model.md) §4; ADR-0006 | DOCUMENTED | 4 |
| R0-044 | Causality: identity-based; attribution bases; temporal-correlation never sufficient for FAIL | [evidence-model.md](evidence-model.md) §6 | DOCUMENTED | 4 |
| R0-045 | Invariant evaluation contract incl. NOT_EVALUABLE as first-class verdict | [evidence-model.md](evidence-model.md) §7 | DOCUMENTED | 4 |
| R0-046 | Findings require provenance + confidence scope | [evidence-model.md](evidence-model.md) §8 | DOCUMENTED | 5 |
| R0-047 | Timeline ordering bases; retries vs repeats vs distinct actions | [evidence-model.md](evidence-model.md) §9 | DOCUMENTED | 5–6 |
| R0-048 | Evidence can/cannot-prove boundary | [evidence-model.md](evidence-model.md) §10 | DOCUMENTED | 4–5 |

## 5. Incident Zero & replay

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-060 | Incident Zero scenario definition (PKR 5000 = 500000 paisa; one equivalent credit) | [incident-zero.md](incident-zero.md) §1; ADR-0005 | DOCUMENTED | 2, 7 |
| R0-061 | Provider simulated via executor delivering webhooks through target's legitimate interface | [incident-zero.md](incident-zero.md) §2 | DOCUMENTED | 3, 7 |
| R0-062 | INV-IZ-1 exact formulation with attribution and verdict rules | [incident-zero.md](incident-zero.md) §5 | DOCUMENTED | 4 |
| R0-063 | Expected behavior matrix (vulnerable FAIL / secure PASS / NOT_EVALUABLE) | [incident-zero.md](incident-zero.md) §6 | DOCUMENTED | 2, 7 |
| R0-064 | Variants (timeout-retry, crash-mid-processing, worker-race) as separate experiments | [incident-zero.md](incident-zero.md) §8 | DOCUMENTED | 9 |
| R0-065 | Regression permanence: both modes as committed suites | [incident-zero.md](incident-zero.md) §9; [testing-strategy.md](testing-strategy.md) §8 | DOCUMENTED | 7 |
| R0-066 | Reproduction definition contents | [incident-replay.md](incident-replay.md) §1 | DOCUMENTED | 5 |
| R0-067 | Replay modes (exact-intent, post-fix, regression) as new runs | [incident-replay.md](incident-replay.md) §3 | DOCUMENTED | 7 |
| R0-068 | Honest replay guarantee table (what is and is not reproduced) | [incident-replay.md](incident-replay.md) §4 | DOCUMENTED | 5, 7 |
| R0-069 | Determinism policy: invariants over identity/counts, never scheduling luck | [incident-replay.md](incident-replay.md) §5 | DOCUMENTED | 4 |
| R0-070 | Replay failure semantics (rotated secrets fail fast; version substitution explicit) | [incident-replay.md](incident-replay.md) §8 | DOCUMENTED | 5, 7 |

## 6. Security

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-080 | Target authorization model; environment classification; production DENIED in v1 | [security-boundaries.md](security-boundaries.md) §2; ADR-0011 | DOCUMENTED | 3 |
| R0-081 | Destination validation contract (scheme, userinfo, origin, injection, Host pinning) | [security-boundaries.md](security-boundaries.md) §3 | DOCUMENTED | 3 |
| R0-082 | SSRF threat table (24 threats with required protections) | [security-boundaries.md](security-boundaries.md) §4 | DOCUMENTED | 3 |
| R0-083 | DNS: resolve-validate-pin; rebinding limitations honest; egress isolation primary | [security-boundaries.md](security-boundaries.md) §5 | DOCUMENTED | 1, 3 |
| R0-084 | Redirect policy: deny cross-origin by default; credential stripping | [security-boundaries.md](security-boundaries.md) §6 | DOCUMENTED | 3 |
| R0-085 | Credential handling: redaction before persistence; secret registry; fingerprints only | [security-boundaries.md](security-boundaries.md) §7; ADR-0012 | DOCUMENTED | 3–4 |
| R0-086 | Blast-radius server-side caps table | [security-boundaries.md](security-boundaries.md) §8 | DOCUMENTED | 3 |
| R0-087 | Security review gate per phase | [security-boundaries.md](security-boundaries.md) §10; [engineering-rules.md](engineering-rules.md) §1 | DOCUMENTED | all |

## 7. Testing

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-100 | Testing-as-evidence philosophy | [testing-strategy.md](testing-strategy.md) §1 | DOCUMENTED | all |
| R0-101 | Four-level taxonomy with mock boundaries | [testing-strategy.md](testing-strategy.md) §2 | DOCUMENTED | 1+ |
| R0-102 | Real-infrastructure mandates (PG, Redis, HTTP, browser, concurrency) | [testing-strategy.md](testing-strategy.md) §3 | DOCUMENTED | 1+ |
| R0-103 | Adversarial catalog (10 scenarios) | [testing-strategy.md](testing-strategy.md) §4 | DOCUMENTED | 3–10 |
| R0-104 | Concurrency rules: measured overlap, barriers, bounded polling, no sleep-proofs | [testing-strategy.md](testing-strategy.md) §6 | DOCUMENTED | 2–3 |
| R0-105 | Flake policy | [testing-strategy.md](testing-strategy.md) §5 | DOCUMENTED | 1+ |
| R0-106 | Coverage philosophy (risk-based, no fabricated %) | [testing-strategy.md](testing-strategy.md) §7 | DOCUMENTED | all |
| R0-107 | Permanent regression requirement | [testing-strategy.md](testing-strategy.md) §8 | DOCUMENTED | 7 |
| R0-108 | Test data rules (no real secrets, integer money, long IDs) | [testing-strategy.md](testing-strategy.md) §10 | DOCUMENTED | 2+ |

## 8. Process & constitution

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-120 | 14-gate phase development flow with definitions | [engineering-rules.md](engineering-rules.md) §1; ADR-0013 | DOCUMENTED | 1+ |
| R0-121 | Definitions of done per artifact type | [engineering-rules.md](engineering-rules.md) §2 | DOCUMENTED | 1+ |
| R0-122 | Verification honesty (no unperformed claims) | [engineering-rules.md](engineering-rules.md) §3; [AGENTS.md](../AGENTS.md) R-07 | DOCUMENTED | all |
| R0-123 | Git discipline | [engineering-rules.md](engineering-rules.md) §4; [AGENTS.md](../AGENTS.md) R-16 | DOCUMENTED | all |
| R0-124 | Migration rules (append-only, tested, ownership-visible) | [engineering-rules.md](engineering-rules.md) §5; [AGENTS.md](../AGENTS.md) R-12 | DOCUMENTED | 1+ |
| R0-125 | Dependency governance: verify against official docs; no memory-pinned versions | [engineering-rules.md](engineering-rules.md) §8 | DOCUMENTED | 1+ |
| R0-126 | Failure-semantics code rules (INDETERMINATE discipline as review blocker) | [engineering-rules.md](engineering-rules.md) §9 | DOCUMENTED | 3+ |
| R0-127 | Independent audit requirement; builder cannot self-accept | [engineering-rules.md](engineering-rules.md) §1, §10 | DOCUMENTED | all |

## 9. Product design

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-140 | Design philosophy + explicit anti-patterns | [product-design.md](product-design.md) §1–2 | DOCUMENTED | 6 |
| R0-141 | Question-first information architecture (8 screens) | [product-design.md](product-design.md) §3 | DOCUMENTED | 6 |
| R0-142 | Signature UX: causal view (attribution bases), timeline (investigation tool), comparison | [product-design.md](product-design.md) §4 | DOCUMENTED | 6–7 |
| R0-143 | Visual language direction (semantic color, monospace discipline) | [product-design.md](product-design.md) §5 | DOCUMENTED | 6 |
| R0-144 | Accessibility/responsiveness contract; INDETERMINATE states designed | [product-design.md](product-design.md) §6 | DOCUMENTED | 6 |
| R0-145 | Content rules: no fake data; integer money rendering | [product-design.md](product-design.md) §7 | DOCUMENTED | 6 |
| R0-146 | UI quality gate with failure criterion | [product-design.md](product-design.md) §8 | DOCUMENTED | 6, 8 |

## 10. Roadmap & Phase 0 mechanics

| ID | Requirement | Authoritative document/section | Status | Impl. phase |
|---|---|---|---|---|
| R0-160 | Phase roadmap 0–11 with all nine attributes per phase | [phase-roadmap.md](phase-roadmap.md) | DOCUMENTED | all |
| R0-161 | Phase 1–5 previews consistent with architecture decisions | [phase-roadmap.md](phase-roadmap.md); [architecture.md](architecture.md) | DOCUMENTED | 1–5 |
| R0-162 | Required document set exists, non-fragmented | This document §11 | DONE | — |
| R0-163 | ADRs for long-lived decisions only | [decisions/](decisions/) (13 ADRs) | DONE | — |
| R0-164 | Adversarial self-audit performed; contradictions fixed | [reports/phase-0-self-audit.md](reports/phase-0-self-audit.md) | DONE | — |
| R0-165 | Terminology audit performed | Self-audit §4 | DONE | — |
| R0-166 | Phase boundary audit (no runtime artifacts) | Self-audit §6 | DONE | — |
| R0-167 | Final Git checks without commit/tag/push | Self-audit §7 | DONE | — |
| R0-168 | Builder verdict limited to READY-FOR-AUDIT / NOT READY; no self-acceptance | Self-audit §1 | DONE | — |

## 11. Document set (R0-162)

README.md · AGENTS.md · docs/product-spec.md · docs/architecture.md · docs/engineering-rules.md · docs/testing-strategy.md · docs/security-boundaries.md · docs/evidence-model.md · docs/incident-zero.md · docs/incident-replay.md · docs/product-design.md · docs/phase-roadmap.md · docs/phase-0-requirements.md (this) · docs/reports/phase-0-self-audit.md · docs/decisions/ADR-0001…0013 · .gitignore · .gitattributes.

Totals: **89 requirements tracked**; 11 DONE (Phase 0 actions); 78 DOCUMENTED as contracts for implementation phases; 0 unresolved. These are traceability counts, not completion percentages — nothing is implemented yet.
