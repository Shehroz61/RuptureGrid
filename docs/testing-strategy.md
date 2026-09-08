# RuptureGrid v1.0 — Testing Strategy

Status: **Phase 0 — testing constitution only. No tests or runtime implementation exist.**
Authoritative for: test taxonomy, real-infrastructure mandates, adversarial testing, concurrency testing rules, permanent regression policy.

Related: [architecture.md](architecture.md), [incident-zero.md](incident-zero.md) §9, [engineering-rules.md](engineering-rules.md) §1, ADR-0013.

---

## 1. Testing is engineering evidence

Tests are not ceremony; they are the verifiable record that a property holds. A claim about system behavior that is not backed by a committed, rerunnable test is an unverified hypothesis — regardless of who made it (human or agent).

## 2. Test taxonomy

| Level | Definition | May mock | Must never mock |
|---|---|---|---|
| **Unit tests** | Pure deterministic logic (classification tables, canonicalization, hashing, invariant math, redaction rules) | Everything external | — |
| **Integration tests** | Real dependency semantics: PostgreSQL transactions/leases/fencing, Redis/BullMQ enqueue/claim/outage, real TCP HTTP | Process boundaries where irrelevant | PostgreSQL, Redis, HTTP semantics |
| **End-to-end tests** | Real workflows across real processes: API + worker + Demo Target + (later) browser via Playwright | Nothing in the execution path | The system under test itself |
| **Adversarial tests** | Deliberate attempts to break guarantees: races, crashes, duplicates, stale ownership, outages, ambiguous outcomes, security boundaries | — | The guarantee being tested |

Mocks are legitimate for unit tests. Mocks must never be the **sole** acceptance evidence for infrastructure semantics ([architecture.md](architecture.md) §14).

## 3. Real-infrastructure mandates

- Correctness depends on **PostgreSQL** → tests run against **real PostgreSQL** (leases, fencing, conditional updates, transaction isolation).
- Correctness depends on **Redis/BullMQ** → tests run against **real Redis/BullMQ** (claim, retry, outage, recovery).
- Correctness depends on **HTTP** → tests use **real TCP HTTP** (the Demo Target is a real HTTP server; the executor makes real requests).
- Correctness depends on **browser behavior** → real browser via Playwright (later UI phases).
- Correctness depends on **concurrency** → real concurrent execution is measured (§6), not asserted.

Test environments use ephemeral containerized infrastructure (Docker Compose in later phases) with migrations applied as part of setup — never hand-built schemas.

## 4. Adversarial test catalog (minimum, per phase)

Each relevant phase must include tests from this catalog:

1. **Duplicate delivery** — same logical webhook delivered N times concurrently; assert effect count obeys the invariant (Incident Zero).
2. **Post-send timeout ambiguity** — mutating request times out after send; assert INDETERMINATE is recorded and no blind retry occurred.
3. **Stale ownership / fencing** — worker A's lease expires, worker B claims, A wakes and attempts writes; assert zero-row rejection and a stale-writer event; assert B's state is intact.
4. **Crash-mid-execution** — kill a worker mid-step (real process kill); assert reconciliation produces a consistent run state with honest outcomes (INDETERMINATE where applicable).
5. **Redis outage mid-run** — kill Redis between dispatch and completion; assert the run survives in PostgreSQL and completes via reconciliation after Redis recovers ([architecture.md](architecture.md) §9).
6. **Duplicate dispatch race** — two workers attempt the same step simultaneously; assert exactly one claim succeeds per fencing token generation.
7. **Security boundary probes** — unregistered origin denied; userinfo URL denied; private/metadata address denied; production-classified target denied; oversized request/response rejected; credential headers absent from persisted evidence.
8. **Invariant determinism** — same evidence inputs ⇒ same verdict across repeated evaluations and evaluator restarts.
9. **Evidence integrity** — tamper with a stored observation byte in a test fixture; assert chain verification detects it.
10. **Redaction completeness** — requests carrying credentials; assert no secret appears anywhere in the evidence store or logs.

## 5. Flake policy

A flaky test is a defect — either in the test (nondeterministic construction) or in the system (a real race). Quarantine is allowed only with a tracked issue; silent skipping is forbidden. Tests must construct determinism where they need it (fixed seeds, controlled targets) and accept variance where reality has it (scheduling — asserted over outcomes, not interleavings, per [incident-replay.md](incident-replay.md) §5).

## 6. Concurrency testing rules

- **Never claim concurrency because code uses `Promise.all`.** Tests that depend on real overlap must **measure** it:
  - coordinate starts with barriers/latches (all requests released simultaneously);
  - assert overlap from **authoritative persisted state** (e.g., the Demo Target's recorded processing-attempt timestamps show real interleaving), not from executor optimism;
  - for multi-process claims, actually run multiple worker processes.
- **No arbitrary sleeps as correctness proof.** Waiting is done by **bounded polling against authoritative persisted state** (e.g., "poll the target's inspection API until processing quiesces, with a cap"), never fixed delays.
- Concurrency limits in the executor are tested by measuring achieved parallelism against the cap (at most N in flight, measured; and ≥2 in flight where the test requires real overlap).

## 7. Coverage philosophy

- No ritual percentage targets; no fabricated coverage claims.
- Coverage effort follows risk: execution ownership, outcome classification, money, invariant evaluation, redaction, and destination validation get the deepest test investment.
- Every fixed defect that could regress gets a regression test before the fix is accepted ([engineering-rules.md](engineering-rules.md) §2).

## 8. Permanent regression tests

Properties important enough to accept a phase are important enough to keep verifying. Therefore:

- Incident Zero in **both modes** is a committed automated suite from Phase 7 ([incident-zero.md](incident-zero.md) §9).
- The Redis-outage reconciliation scenario, the fencing scenario, and the redaction probes become committed suites in their introducing phases.
- A one-time terminal demonstration by an AI agent is **never** acceptance evidence ([AGENTS.md](../AGENTS.md) R-07).

## 9. CI contract (later phase)

When CI is introduced (roadmap Phase 11 or earlier): the full adversarial catalog runs on real containerized infrastructure; PRs cannot merge with failing security or invariant suites; flake quarantine requires explicit tracking. Until then, every phase's acceptance includes local execution of the same suites.

## 10. Test data rules

- Seeds and fixtures contain **no real secrets** ([security-boundaries.md](security-boundaries.md) §7).
- Financial fixtures use integer minor units (paisa), never floats (ADR-0004).
- Long identifiers (64+ char IDs) are part of fixture data by default, to force honest UI/format handling ([product-design.md](product-design.md) §6).
