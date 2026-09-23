# Controlled Faults (Phase 9)

Status: Phase 9 implementation contract. Decisions: [ADR-0014](decisions/ADR-0014-controlled-faults-target-owned.md).
Roadmap source: [phase-roadmap.md](phase-roadmap.md) Phase 9 ("connection drop, response truncation,
staggered redelivery waves, crash-mid-processing via a target-owned fault hook").

## 1. Purpose and non-scope

Phase 9 extends RuptureGrid with a SMALL, CONTROLLED set of distributed-system failure modes and
the observability needed to explain their execution accurately. The core question is unchanged:

> Did the target remain BUSINESS-CORRECT when realistic distributed-system failures occurred?

Non-scope (hard): generic chaos engineering, production fault injection, infrastructure chaos,
arbitrary network tooling, scripted demo modes, AI root-cause analysis. Every activation below is
deterministic; no probability is used anywhere in the fault path.

## 2. Ownership and safety boundaries

- **The target owns its faults.** All fault state (plan, budget, trigger counts) lives in the Demo
  Target's own PostgreSQL (`fault_plans`, migration `20260921_phase9_fault_control`) and is armed /
  disarmed through the target's OWN admin API with the admin credential. RuptureGrid never writes
  target business state directly (ADR-0002, AGENTS R-05). Faults can only exist where the target
  itself implements the hook.
- **Engine-enforced safety gate.** A step action carrying a `faultPlan` is accepted by experiment
  validation ONLY when the action's contract is `DEMO_FINTECH_WEBHOOK`, the declared mutation is
  `MUTATING`, the relative path is exactly `/webhooks/provider`, and the registered target
  environment is `LOCAL_DEVELOPMENT` (security-boundaries §2; R-14). The same gate is re-derived at
  execution time from the frozen snapshot (defense in depth, mirroring the PRODUCTION denial).
  One `faultKind` may appear on at most one step per document. UI absence of these checks is never
  the control.
- **No arbitrary fault targeting.** There is no mechanism to fault any endpoint other than the
  target's own webhook delivery path, and no mechanism to arm a fault on any target that has not
  itself implemented the hook (unknown paths 404; unknown kinds are refused by target validation).

## 3. Fault plan model — `controlled-fault/v1`

A fault plan is a typed, versioned, frozen part of the experiment step action:

```jsonc
{
  "planVersion": "controlled-fault/v1",
  "faultKind": "PRE_MUTATION_REJECTION" | "CRASH_MID_PROCESSING" | "RESPONSE_TRUNCATION",
  "activation": "first_n_matching_deliveries",
  "maxTriggers": 1        // integer, 1..10 (EXECUTION_LIMITS.maxFaultTriggersPerStep)
}
```

- `planVersion` determines interpretation. A target that does not recognize the version refuses to
  arm (`400 FAULT_PLAN_UNSUPPORTED_VERSION`). Semantics are never silently changed under `v1`.
- `activation` is a closed vocabulary in v1: exactly `first_n_matching_deliveries`. "Matching" is
  per-kind and defined in §4. The FIRST N matching deliveries since arming trigger, in physical
  arrival order; deliveries after the budget is exhausted behave normally. This is fully
  deterministic and repeatable.
- No free-form code, no shell, no network scripting, no user-provided expressions exist anywhere in
  the plan.
- **Arming TTL.** An armed plan auto-expires 900,000 ms (15 min) after arming (target-side
  constant `FAULT_PLAN_TTL_MS`). Expired plans are treated as disarmed at every hook evaluation.
  This bounds blast radius and covers worker-crash leakage (armed-but-never-disarmed).

## 4. The Phase 9 fault catalog (complete)

Roadmap-faithful and minimal. "Connection drop" is implemented as the stage-targeted drop produced
by `CRASH_MID_PROCESSING` (drop before any response bytes) and `RESPONSE_TRUNCATION` (drop after
response headers, mid-body); it is not a separate fourth kind.

### 4.1 `PRE_MUTATION_REJECTION` — provable pre-mutation failure

- **Hook point:** in the target's webhook processing, after provider authenticity + payload +
  business-consistency validation, BEFORE any persistence (no delivery row, no processing attempt,
  no financial effect).
- **Behavior:** the target refuses with its definitive contract rejection: HTTP `409`, code
  `CONTROLLED_FAULT_REJECTION`, message naming the controlled fault (secret-free, honest).
- **Expected classification** (architecture §7.1, unchanged): definitive 4xx under
  `DEMO_FINTECH_WEBHOOK` — a contract that guarantees no effect ⇒ `intentOutcome=FAILED`,
  `sideEffectKnowledge=KNOWN_ABSENT`.
- **Retry:** a step declaring `retryPolicy=SAFE` retries (permitted for KNOWN_ABSENT failures,
  within `SAFE_RETRY_MAX_ATTEMPTS`); because activation is budgeted, a retried attempt after the
  budget is exhausted succeeds — proving safe retry is applied exactly where the contract permits.
- **Purpose:** a failure where the side effect is provably absent, and retry policy can be safe
  where accepted.

### 4.2 `CRASH_MID_PROCESSING` — genuine remote-mutation ambiguity

- **Hook point:** AFTER the target's financial transaction has committed and the processing attempt
  has been finalized, BEFORE any response bytes are written. The target then destroys the TCP
  connection (the client-observable signature of a mid-processing crash).
- **Expected classification:** the executor's request was sent; the connection died in flight ⇒
  conservative `transportStage=REQUEST_SENT` ⇒ mutating action ⇒
  `intentOutcome=FAILED`, `sideEffectKnowledge=INDETERMINATE` (never laundered; ADR-0008).
- **Retry:** NEVER auto-retried, even if `SAFE` is declared (INDETERMINATE mutating outcome is
  never retried — ADR-0008). Exactly one attempt is made per repeat slot.
- **Run semantics (honest):** under the accepted ordered-dependency policy a step whose invocation
  terminally fails marks the step FAILED; subsequent steps are CANCELLED (KNOWN_ABSENT). The run
  ends FAILED. RuptureGrid does NOT collapse the ambiguity into success.
- **Later inspection (separate, out-of-band):** the target's committed truth (the credit DID occur)
  is proven afterward through the target's read-only inspection API — a distinct observation that
  is never merged into the run's execution record.
- **Purpose:** prove genuine remote-mutation ambiguity: INDETERMINATE persisted and displayed, no
  unsafe retry, later inspection distinguished from execution observation.

### 4.3 `RESPONSE_TRUNCATION` — response cannot be observed

- **Hook point:** after the financial transaction committed and the target begins writing its
  success response: it writes the real headers with an inflated `Content-Length`, a body prefix,
  then destroys the connection mid-body.
- **Expected classification:** response headers were received, then the body read failed in flight
  ⇒ conservative `transportStage=REQUEST_SENT` (a truncated body cannot prove what the target did)
  ⇒ mutating ⇒ `intentOutcome=FAILED`, `sideEffectKnowledge=INDETERMINATE`.
- **Retry:** never auto-retried (same ADR-0008 rule). Run semantics identical to §4.2.
- **Purpose:** exercise the boundary where PARTIAL response evidence exists but business truth
  still cannot be concluded from it — headers are not knowledge.

### 4.4 `STAGGERED_WAVES` — deterministic redelivery-wave spacing (engine primitive)

- **Mechanism:** step-level `waveStaggerMs` (integer 0..`EXECUTION_LIMITS.maxWaveStaggerMs`).
  The executor spaces consecutive repeat WAVES of the step by exactly this delay (no probability).
  Wave 1 starts immediately; each later wave starts ≥ `waveStaggerMs` after the previous wave
  started.
- **Classification:** none — deliveries behave normally; this primitive exercises duplicate
  pressure spread over time and the wave-timing observability of the engine.
- **Purpose:** roadmap "staggered redelivery waves"; deterministic timing primitive for the
  observability deliverable. A bounded response-delay fault is deliberately NOT added as a separate
  kind in v1: wave staggering is the deterministic timing primitive of this phase, and no roadmap
  item requires target response-latency injection.

## 5. Execution flow (who does what)

1. **Definition time** (`validate.ts`): the plan is typed, bounded, and gated (§2). The gate
   failures are `ExperimentValidationError` issues — the definition never persists.
2. **Snapshot time** (ADR-0010): the validated plan freezes into the run snapshot; the snapshot
   content hash covers the fault intent (reproduction §17: fault intent is snapshot-derived).
3. **Execution time** (`step-processor.ts`):
   - ARM (once per step, before the first delivery): the worker sends the FROZEN plan to
     `PUT /demo/admin/faults` with the admin credential. Arming failure is a hard precondition:
     the step fails BEFORE any delivery (nothing is sent un-faulted); terminal state
     `FAILED`, `sideEffectKnowledge=KNOWN_ABSENT` (nothing left the executor).
   - RUN: deliveries trigger the target-side hook per §4. Every physical attempt is recorded as an
     honest `StepInvocation` row (transport stage, status, error) — including fault-produced ones.
   - DISARM (best-effort, in a `finally` after the terminal write): `DELETE /demo/admin/faults/:kind`.
     Disarm failure is honest incompleteness (logged; the TTL bounds any leakage). Disarm outcome
     never rewrites execution truth.
4. **Evidence time:** the target's own fault state is captured through the read-only inspection API
   by the EXPLICIT adapter kind `demo-fintech-fault-status` (`GET /inspection/faults`), stored as a
   `target_observation` raw observation (redacted, hash-chained, provenance-recorded). This is
   target-authored activation truth — configured-vs-activated is never inferred from error shapes.

## 6. Evidence, provenance, causality (unchanged rules)

- Raw observations remain the only OBSERVED tier; fault-state observations are `target_observation`
  rows with `adapterKind=demo-fintech-fault-status`. No new observation origin class exists.
- The normalizer derives `demo.fault-plan-state-observed` events (deterministic, versioned). A
  triggerCount ≥ 1 in the observed state is the persisted basis for "activated"; absence of budget
  consumption is never reported as activation.
- Forensic timeline entries `FAULT_PLAN_CONFIGURED` / `FAULT_PLAN_ACTIVATED` are derived ONLY from
  those observations (explicit basis `wall_clock`, timeMeaning `target-observed-at`); timeline
  adjacency still asserts no causality.
- INV-IZ-1 semantics are untouched. Fault-produced duplicate/missing deliveries are evaluated by
  the same pure evaluator; insufficient evidence stays NOT_EVALUABLE.
- **New invariant kinds (v2, deterministic, pure):**
  - `INV-DF-1 BALANCE_CONSERVATION` — for the wallet of an observed payment lineage:
    Σ(accepted WALLET_CREDIT ledger entries) equals the observed wallet balance (integer minor
    units; R-06). PASS / FAIL / NOT_EVALUABLE per lineage completeness.
  - `INV-DF-2 NO_NEGATIVE_BALANCE` — every observed wallet balance ≥ 0.
  - These are evaluation-tier verdicts only; Phase 5 Finding generation remains INV-IZ-1-specific
    (no new reason codes in Phase 9).

## 7. Observability (Phase 9 deliverable)

- A structured telemetry seam in the engine emits REAL events only (no synthetic metrics):
  step lifecycle, per-invocation transport stage/status/duration/classification, wave staggering,
  fault arm/disarm outcomes — each carrying the run/step/invocation correlation IDs that already
  exist (nothing is invented to make traces look richer).
- OpenTelemetry API-level instrumentation is applied at the same seams (ADR-0015); spans export
  when an OTel SDK is registered, and the structured sink always records the events durably in
  worker logs.
- Durable truth boundary: telemetry is OPERATIONAL observation. It never rewrites execution rows,
  evidence rows, or verdicts; analysis and findings read only persisted truth.

## 8. Verifier and acceptance

`packages/controlled-faults` provides the scenario runner and the one-command verifier
(`pnpm controlled-faults:verify`) that executes every scenario against the real stack (real
PostgreSQL ×2, real Redis, real worker, real Demo target), each scenario twice (repeatability),
and asserts: the deterministic activation counts, the exact classification semantics (§4), the
no-unsafe-retry property, the later-inspection distinction, the new invariant verdicts, the
production/STAGING denial, and invalid-plan refusal. Structured JSON output; non-zero exit on any
failure. Verifier reads are read-only with respect to RuptureGrid truth.
