# RuptureGrid v1.0 — Engineering Rules

Status: **Phase 0 — process contract only.**
Authoritative for: the development flow per phase, definitions of done, verification rules, Git discipline, migrations, observability, dependency governance.

Related: [AGENTS.md](../AGENTS.md) (hard rules — this document expands, never contradicts), [testing-strategy.md](testing-strategy.md), [security-boundaries.md](security-boundaries.md) §10, ADR-0013.

---

## 1. The phase development flow

Every implementation phase follows this flow; a phase is not "done" until each gate below has genuinely passed:

```
PLAN → IMPLEMENT → UNIT TEST → INTEGRATION TEST → ADVERSARIAL TEST
     → SECURITY REVIEW → LINT → TYPECHECK → BUILD
     → REAL RUNTIME VERIFICATION → GIT DIFF REVIEW
     → INDEPENDENT AUDIT → FIX BLOCKERS → ACCEPTED CHECKPOINT
```

Gate definitions:

- **REAL RUNTIME VERIFICATION** — the feature runs in the real topology (real PostgreSQL, Redis, processes); "it compiles" is not verification.
- **GIT DIFF REVIEW** — the full diff is read before any commit; no unrelated changes ride along; no debug residue.
- **INDEPENDENT AUDIT** — a review that is not the author: a separate agent session, a different reviewer, or an audit checklist executed against the phase's acceptance criteria. The author never accepts their own phase (this includes AI agents self-accepting).
- **ACCEPTED CHECKPOINT** — the phase's acceptance criteria ([phase-roadmap.md](phase-roadmap.md)) are demonstrably met, with evidence.

No agent may implement the whole product in one uncontrolled jump. Phases are ordered, gated, and audited (ADR-0013).

## 2. Definitions of done

- **Code** — implements the documented contract; unit tests; integration tests where semantics depend on real infrastructure; adversarial coverage where the phase's catalog applies ([testing-strategy.md](testing-strategy.md) §4); lint/typecheck/build clean; runtime-verified; security-reviewed if it touches execution, destinations, credentials, or evidence.
- **Schema** — delivered as a **migration** (reproducible, inspectable, testable); no schema-push mechanisms as the authoritative history ([AGENTS.md](../AGENTS.md) R-12); migration tested forward (and, where the phase requires, rollback-safe by forward-fix).
- **Documentation** — updated in the same change when behavior or decisions change; ADR added or amended when a decision changes ([AGENTS.md](../AGENTS.md) R-17); no stale statements of "current" architecture.

## 3. Verification rules

- Typecheck, lint, and build are run and shown clean — every phase, no exceptions.
- Runtime verification uses the real stack; simulated environments cannot satisfy runtime gates for correctness-relevant behavior ([testing-strategy.md](testing-strategy.md) §3).
- "Verified" means: the command was run, its output was observed, and it is referenced in the phase's evidence. An agent must never claim verification it did not perform ([AGENTS.md](../AGENTS.md) R-07).

## 4. Git discipline

- Atomic commits per logical change; messages describe the **why**; no generated noise.
- Never commit: secrets, `.env` values, lockfile churn unrelated to a dependency change, machine-specific paths.
- No force-push to shared branches; no rewriting history others may build on; tags only at accepted checkpoints ([AGENTS.md](../AGENTS.md) R-16).
- No push, PR, or remote mutation unless the phase/workflow explicitly authorizes it.

## 5. Migration rules

- Every schema change ships as a migration in the same change; migrations are append-only history; a migration once committed is never edited — corrections are new migrations.
- Migrations run in CI/test harnesses before suites ([testing-strategy.md](testing-strategy.md) §3).
- Schema ownership boundaries ([architecture.md](architecture.md) §4) are visible in the migration set: RuptureGrid schemas vs Target schemas are separate migration histories in separate applications.

## 6. Portability and configuration

- No hard-coded paths (including `E:\RuptureGrid-v1.0`), home directories, hostnames, ports, or credentials in source.
- All environment-specific configuration is environment-driven, schema-validated at startup, fail-fast on missing/invalid values.
- Any developer (or agent) with the repository plus documented prerequisites must be able to run the stack (ADR-0001).

## 7. Observability rules

- Structured logging with correlation IDs (run/step/invocation) from Phase 1 onward.
- Logs are subject to the same redaction rules as evidence ([security-boundaries.md](security-boundaries.md) §7) — secrets never reach logs.
- Log volume is deliberate: operational events, outcome transitions, stale-writer events, reconciliation actions — not per-request noise.
- OpenTelemetry is deferred ([phase-roadmap.md](phase-roadmap.md) Phase 9) but correlation IDs and structured events are designed in from Phase 1 so instrumentation is additive, not invasive.

## 8. Dependency governance

- Versions are **never frozen from model memory**: before introducing or upgrading a dependency, verify current official documentation (the phase's documentation-lookup policy in [AGENTS.md](../AGENTS.md)).
- Prefer boring, well-documented dependencies; every dependency must map to a documented need ([architecture.md](architecture.md) §14).
- Dependency upgrades are their own changes, tested by the phase's suites; unexplained lockfile churn is a review blocker.

## 9. Failure-semantics discipline (code rules)

- Any code that performs a mutating remote action must classify outcomes per the §7.1 table of [architecture.md](architecture.md) — including the INDETERMINATE rows. It is a review blocker to collapse INDETERMINATE into FAILED or SUCCEEDED.
- Retries of ambiguous mutations are forbidden unless the declared contract makes them safe ([architecture.md](architecture.md) §7.2).
- Terminal states are written fenced and once ([architecture.md](architecture.md) §10); code that overwrites terminal state outside the fencing contract is a defect.

## 10. Review and audit standards

- Reviews check: contract adherence, ownership boundaries, failure semantics, redaction, test honesty (real overlap measured, no sleep-proofs), and documentation currency.
- The independent audit at phase end (§1) verifies acceptance criteria **with evidence** — rerunning suites where feasible — and produces a written report under `docs/reports/`.
