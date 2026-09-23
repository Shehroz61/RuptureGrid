# ADR-0014: Controlled Faults Are Target-Owned, Local-Only, Deterministic

## Status

Accepted (Phase 9).

## Context

Phase 9 adds additional controlled failure modes (phase-roadmap Phase 9: "connection drop,
response truncation, staggered redelivery waves, crash-mid-processing via a target-owned fault
hook"). The constitution forbids writing target business state (R-05), forbids fabricated or
scripted outcomes (R-02/R-03), and confines fault execution to safe environment classifications
(R-14). Any fault mechanism must therefore answer: who arms the fault, where fault state lives,
who triggers it, and what classification the resulting outcomes receive. A generic
"enter any URL and drop packets" design would violate all three rules at once.

## Decision

1. **Fault state is target-owned.** Fault plans and trigger budgets live in the Demo Target's own
   PostgreSQL (`fault_plans`); arming/disarming happens through the target's own admin API with
   the admin credential. RuptureGrid never writes Demo state directly (ADR-0002). RuptureGrid's
   role is to declare the fault intent — a typed, versioned plan frozen into the run snapshot
   (ADR-0010) — and to execute deliveries; the target decides, per request, whether to fail,
   using its own durable state and its own validation.
2. **The fault surface is closed.** v1 supports exactly three target-side kinds —
   `PRE_MUTATION_REJECTION`, `CRASH_MID_PROCESSING`, `RESPONSE_TRUNCATION` — plus the engine-side
   deterministic timing primitive `waveStaggerMs` ("staggered redelivery waves"). "Connection
   drop" is realized as the stage-targeted connection destruction of the two post-commit kinds;
   no fourth kind, no arbitrary targeting, no shell/code/network scripting anywhere in the plan.
3. **Activation is deterministic.** The v1 activation vocabulary is exactly
   `first_n_matching_deliveries` with an integer budget (1..10). The first N matching deliveries
   since arming trigger, in physical arrival order; the rest behave normally. No probability.
4. **Engine-enforced safety gate.** A `faultPlan` is accepted by experiment validation only when
   the action's contract is `DEMO_FINTECH_WEBHOOK`, the declared mutation is `MUTATING`, the
   relative path is exactly `/webhooks/provider`, and the registered target environment is
   `LOCAL_DEVELOPMENT` (R-14, security-boundaries §2). The same gate is re-derived at execution
   time from the frozen snapshot (defense in depth). STAGING and PRODUCTION snapshot targets are
   refused a fault-bearing step before any delivery. UI validation is never the control.
5. **Arm is a precondition; disarm is best-effort.** The worker arms the frozen plan before the
   step's first delivery; arming failure fails the step BEFORE any request is sent
   (`KNOWN_ABSENT`). Disarm runs after the terminal write, best-effort, with a bounded arming TTL
   (target-side, 15 min) as the leakage backstop. Disarm/TTL outcomes never rewrite execution
   truth.
6. **Outcomes stay honest and classified by the accepted table.** `PRE_MUTATION_REJECTION`
   produces a definitive contract rejection ⇒ `KNOWN_ABSENT` (retryable only under the accepted
   SAFE policy). `CRASH_MID_PROCESSING` and `RESPONSE_TRUNCATION` occur after the target's
   financial commit and destroy the connection ⇒ conservative `REQUEST_SENT` ⇒ `INDETERMINATE`,
   never auto-retried (ADR-0008), never collapsed into success or failure. Later target
   inspection is a separate, clearly-attributed observation — it never retro-fixes the
   invocation's classification.
7. **Activation truth is target-observed, not inferred.** Configured-vs-activated is proven only
   through the target's own read-only inspection API (explicit adapter kind
   `demo-fintech-fault-status`, stored as a redacted, hash-chained `target_observation`). Error
   shapes are never treated as activation proof.

## Consequences

- Fault coverage grows only when a target implements and exposes the hook; there is no path to
  fault an unknown target, an arbitrary URL, or a non-local environment.
- The same experiment document replays deterministically on a clean target (repeatability
  contract of incident-replay §5); the arming TTL bounds leakage if a worker dies mid-step.
- The Demo Target gains a small fault-control surface (admin routes + a `fault_plans` table).
  This is demo-scenario machinery, explicitly non-production, and its persistence stays inside
  the target's own database (R-05 intact).
- INDETERMINATE visibility (step, run, UI, timeline) becomes a first-class acceptance property
  rather than a rare edge.

## Alternatives considered

- **Executor-side fault injection** (drop requests inside the executor): rejected — it would let
  RuptureGrid fabricate failure semantics for any registered target, decouple the fault from the
  target's real commit boundary, and blur what the target actually observed. The target-owned
  hook keeps the failure a real target behavior.
- **Postgres-level fault injection against the demo database**: rejected — RuptureGrid holds no
  Demo DB credentials (ADR-0002) and must never gain any.
- **Probability/seeded-random activation**: rejected for v1 — deterministic activation is the
  Phase 9 acceptance mechanism (R-07); probabilistic support can be added later behind a new
  plan version with an explicit seed.
