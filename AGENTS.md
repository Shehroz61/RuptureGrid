# AGENTS.md — RuptureGrid v1.0 Engineering Constitution

Binding rules for **all contributors — human and AI**. Expanded process detail lives in [docs/engineering-rules.md](docs/engineering-rules.md); architecture in [docs/architecture.md](docs/architecture.md). If a task instruction conflicts with this constitution, the constitution wins until a documented ADR change is made (R-17).

**R-01 Phase boundaries.** Work happens phase by phase per [docs/phase-roadmap.md](docs/phase-roadmap.md). Never skip phases, never begin a phase before the prior phase's exit criteria are independently audited, never implement a future phase "while you're in there".

**R-02 No fabricated truth.** Never invent requests, failures, concurrency, traces, metrics, evidence, effects, database state, findings, verdicts, timeline entries, screenshots, or counts. If RuptureGrid reports "20 requests executed", 20 real requests executed. Fabricating operational truth is the cardinal defect of this project.

**R-03 No fake evidence of any kind.** No fake runtime evidence, no fake metrics, no fake demo data in the product, no scripted "demo modes" presented as real behavior. Demos run against the real stack.

**R-04 No silent architecture substitutions.** The documented architecture is the contract. If implementation reality requires deviation, stop, write/revise the ADR, update the docs, then implement. Quiet divergence between docs and code is a defect.

**R-05 Data ownership is absolute.** RuptureGrid never writes to the Demo Target's database or any target's business state ([docs/architecture.md](docs/architecture.md) §4). Failures are created only through the target's legitimate interfaces. Observation adapters are read-only, explicitly configured, and audited. No shared schemas, no cross-database mutations, no "fix-up" writes behind a target's back.

**R-06 Money is integer minor units.** All financial amounts are integers in the smallest unit (paisa for PKR; PKR 5,000 = `500000`). Floats are forbidden for money, everywhere, including tests and fixtures ([docs/product-spec.md](docs/product-spec.md) §10, [ADR-0004](docs/decisions/ADR-0004-money-as-integer-minor-units.md)).

**R-07 Verification before claims.** Never claim implementation, verification, test passage, or performance that has not been performed and observed in this session. "Documented" never means "implemented". A one-time agent demonstration is never acceptance evidence — acceptance properties become committed, rerunnable tests ([docs/testing-strategy.md](docs/testing-strategy.md) §8).

**R-08 Real infrastructure for real semantics.** If correctness depends on PostgreSQL, Redis/BullMQ, TCP HTTP, a browser, or concurrency, tests exercise the real thing. Mocks never serve as the sole acceptance evidence for infrastructure semantics ([docs/testing-strategy.md](docs/testing-strategy.md) §3).

**R-09 PostgreSQL owns durable truth; the queue is coordination-only.** Runs, execution intent, step state, evidence, findings survive queue/cache failure. A Redis outage must never lose durable work — reconciliation recovers it ([docs/architecture.md](docs/architecture.md) §9).

**R-10 Execution ownership is fenced.** Stale workers must never overwrite newer durable state; all worker *state* writes carry owner + fencing token and are conditionally applied. Worker-appended raw observations remain honest records of what was observed — attributed to their invocation and writer, never silently discarded or rewritten. Ambiguous mutating outcomes are `INDETERMINATE` and must never be collapsed into success/failure or blind-retried ([docs/architecture.md](docs/architecture.md) §7, §10).

**R-11 AI never decides truth.** AI may summarize, explain, suggest causes and remediation. It may never invent evidence, alter deterministic results, or convert uncertainty into certainty ([ADR-0007](docs/decisions/ADR-0007-ai-interpretation-never-authority.md)).

**R-12 Migrations are the schema history.** Every schema change ships as a reviewable, reproducible, testable migration. Schema-push mechanisms are never the authoritative history ([docs/engineering-rules.md](docs/engineering-rules.md) §5).

**R-13 Secrets never persist.** Credentials are environment-referenced, redacted before durable persistence, and excluded from logs, evidence, snapshots, and AI inputs ([docs/security-boundaries.md](security-boundaries.md) §7).

**R-14 Security boundaries are enforced server-side.** Registered targets only; destination validation per [docs/security-boundaries.md](docs/security-boundaries.md) §3–§6; production environments denied for fault execution in v1; blast-radius caps enforced in the Control Plane and executor. UI validation is never a security control.

**R-15 Portability.** No hard-coded paths (including `E:\RuptureGrid-v1.0`), machine-specific locations, or checked-in secrets. Configuration is environment-driven and validated. Any contributor can run the stack from a clean checkout.

**R-16 Git safety.** No force-push to shared branches, no history rewrites others build on, no commits/tags/pushes unless the phase or user workflow authorizes them, never commit secrets or unrelated changes. Diff-review before every commit.

**R-17 Documentation stays current.** Changing a documented decision requires an ADR (new or amended) in the same change. Stale docs contradicting implementation are defects to fix immediately.

**R-18 Terminology integrity.** Use the canonical terms precisely: `INDETERMINATE` (ambiguous side effects), `NOT_EVALUABLE` (insufficient evidence), `logically append-only` (never claim "immutable"/"tamper-proof"/"non-repudiable" for database records), `repeat` vs `retry`, the five identity names from [docs/product-spec.md](docs/product-spec.md) §7. Loose terminology that overstates guarantees is a defect.

**R-19 The UI is a product, not a template.** The frontend must pass the human-design quality gate ([docs/product-design.md](docs/product-design.md) §8): no generic AI-dashboard appearance, no fake data, no decorative metrics; information hierarchy and domain-specific investigation tools are the standard.

**R-20 Dependencies are verified, not remembered.** Version-sensitive APIs are checked against current official documentation before consequential use; versions are never frozen from memory in design docs ([docs/engineering-rules.md](docs/engineering-rules.md) §8).
