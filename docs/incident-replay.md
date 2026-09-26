# RuptureGrid v1.0 — Incident Replay & Reproducibility

Status: **Living contract — accepted through Phase 11 (released v1.0.1). Phases 0–11 accepted and frozen.**
Authoritative for: reproduction definitions, snapshot semantics, replay modes, and the honest limits of replay.

Related: [architecture.md](architecture.md) §11, [evidence-model.md](evidence-model.md) §1 (reproduction definition), ADR-0010, [incident-zero.md](incident-zero.md), [testing-strategy.md](testing-strategy.md) §8.

---

## 1. Reproduction definition

The complete, self-describing description of "how to intentionally execute the same experiment intent again". Contents:

1. **Run snapshot reference** — the hash-pinned, append-only snapshot created at the original run ([architecture.md](architecture.md) §11).
2. **Target binding** — registered target identity, environment class, and the target processing mode the experiment requires (e.g., Demo Target `vulnerable` | `secure`).
3. **Credential requirements** — references + fingerprints of required credentials (never values); replay fails fast with an explicit mismatch if a referenced secret has rotated or is missing.
4. **Environment requirements** — infrastructure prerequisites the run depends on (e.g., containerized PostgreSQL/Redis for the Demo Target deployment).
5. **Invariant bindings** — which invariant definitions (versioned) the replay must evaluate.
6. **Acceptance expectations** — what outcome classes are expected (used by regression suites; e.g., "vulnerable mode must produce INV-IZ-1 FAIL").

## 2. Snapshot contract

- **Pinned at run creation, before any execution.** The snapshot is the resolved, canonicalized execution intent: target origin, step templates (method, path, headers minus credentials, bodies), fault plan, repeat, concurrency, timeouts, ordering, expected outcome classes, invariant bindings, engine/normalizer versions in effect, and the environment authorization record.
- **Canonicalized and content-hashed**; stored append-only. Any later edit to experiment definitions, target registration, or limits produces new versions — historical snapshots are never modified.
- **Credentials are references, never values.** A fingerprint of the resolved secret value is recorded for drift detection at replay time. No secret is persisted to achieve literal replay (ADR-0012).
- **Runs reference snapshots, not live definitions.** A historical run can always answer: "what exactly was supposed to happen?"

## 3. Replay modes

| Mode | Purpose | Semantics |
|---|---|---|
| **Exact-intent replay** | Reproduce the incident for investigation | New run created *from the stored snapshot* against the same target binding |
| **Post-fix replay** | Verify a remediation | Same snapshot, re-run after the target was fixed via its legitimate interfaces; finding must reflect the new reality |
| **Regression replay** | Permanent automated verification | Snapshot executed in CI/local suites with explicit acceptance expectations; committed test ([testing-strategy.md](testing-strategy.md) §8) |

A replay is a **new run** with its own evidence — it never merges into or rewrites the original run's history. Comparison between the original and replay runs is an explicit investigation view, not an implicit data blend.

## 4. What replay does and does not reproduce (honest table)

| Dimension | Reproduced? | Notes |
|---|---|---|
| Execution intent (steps, payloads, fault plan, repeat/concurrency/timeouts) | **Yes** | This is the contract |
| Target-side processing mode | **Yes, by binding** | Replay requires the declared mode to be set via the target's own admin API, verified by the setup step |
| Credential values | **Never persisted; resolved at execution** | Rotation causes explicit fail-fast, not silent drift |
| Wall-clock timing / network latency profile | **No** | Timing is real per execution, never simulated |
| Concurrency scheduling (exact interleavings) | **No — and must not be** | Scheduling variance is expected; findings must not depend on it (§5) |
| Prior target state | **Setup step responsibility** | The experiment declares its own preconditions; replay re-establishes them through target interfaces |
| External network conditions (provider behavior beyond the simulated payloads) | **No** | The provider is simulated by the executor ([incident-zero.md](incident-zero.md) §2) |

## 5. Determinism policy

- **Deterministic:** normalization (same inputs + same normalizer version ⇒ same events), invariant evaluation (same inputs + same evaluator version ⇒ same verdict), snapshot canonicalization and hashing.
- **Non-deterministic by nature:** thread/connection scheduling, arrival ordering under concurrency, real timing. These are *observed and recorded*, never asserted.
- Therefore: invariants must be formulated over **identity and counts of effects** (e.g., INV-IZ-1 counts accepted credits attributable to a logical payment), never over scheduling luck. If a finding would change merely because threads interleaved differently, the invariant or the experiment is wrong.

## 6. Comparing runs

Post-fix replay evaluation centers on comparison: original run vs replay run — same snapshot hash, same invariant definitions (or explicitly versioned successors), side-by-side verdicts, effect counts, timelines. Differences in evidence are expected (new timestamps, new identities); differences in **verdicts for the same invariant** are the signal.

## 7. Snapshot integrity semantics

Honest statement: snapshots are **logically append-only** (append-only storage, content-addressed, hash-referenced by runs and findings). The same caveat as evidence applies ([evidence-model.md](evidence-model.md) §4): this is application-level discipline with detectable modification, not cryptographic tamper-proofing or non-repudiation.

## 8. Failure semantics on replay

- Missing/rotated credential ⇒ replay refuses to start (explicit mismatch error).
- Target unreachable or wrong processing mode ⇒ setup step fails the replay before any experiment delivery occurs.
- Snapshot's engine versions no longer available ⇒ replay records the version mismatch and either uses explicitly declared successors or fails — never silently substitutes engines.
- Replay infrastructure outage ⇒ same durability rules as any run ([architecture.md](architecture.md) §9): the replay run survives in PostgreSQL and resumes via reconciliation.
