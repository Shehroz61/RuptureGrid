# ADR-0013 — Phase-Gated Development

Status: Accepted (Phase 0)

## Context
The dominant failure mode of agent-driven (and human) development is the uncontrolled jump: "implement everything", claim success, leave unverifiable damage. RuptureGrid's subject matter — trust, evidence, correctness — demands the opposite discipline.

## Decision
- Development proceeds through the gated roadmap ([phase-roadmap.md](../phase-roadmap.md)) with the 14-gate flow per phase ([engineering-rules.md](../engineering-rules.md) §1): plan → implement → unit → integration → adversarial → security review → lint → typecheck → build → real runtime verification → git diff review → **independent audit** → fix blockers → accepted checkpoint.
- **The author never accepts their own phase** — including AI agents self-accepting. Acceptance requires an independent audit against the phase's documented acceptance criteria, with evidence.
- Phase 0 likewise ends at "READY FOR INDEPENDENT AUDIT", not "accepted".

## Consequences
- Slower, deliberate progress; every phase leaves committed tests, evidence, and an audit report under `docs/reports/`.
- Roadmap phases are contracts: scope and acceptance criteria may be refined by ADR, not quietly ignored.

## Alternatives considered
- **Continuous flow without gates** — rejected: unverifiable claims become inevitable.
- **Audit-only at the end (Phase 10)** — rejected: defects compound; per-phase audits catch divergence while it is cheap.

## Deferred questions
- Independent-auditor mechanics per phase (separate agent session vs human reviewer) — decided per phase by the operator.
