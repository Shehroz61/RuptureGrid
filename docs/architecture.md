# RuptureGrid v1.0 — Architecture

Status: **Phase 0 — architectural design only. No runtime implementation exists.**
Authoritative for: bounded contexts, physical topology, data ownership, execution semantics, durability, coordination, failure semantics, and snapshots.

Related: [product-spec.md](product-spec.md), [evidence-model.md](evidence-model.md), [incident-replay.md](incident-replay.md), [security-boundaries.md](security-boundaries.md), ADRs in [decisions/](decisions/).

---

## 1. Architecture principles

1. **Truth comes only from real execution.** Every downstream artifact (events, causality, findings, UI numbers) is derived from actually captured observations of actually executed work. Nothing is simulated into existence.
2. **Ownership is explicit.** Every durable datum has exactly one owning context and one owning store. Cross-ownership writes are forbidden (§4).
3. **PostgreSQL owns durable truth.** The queue/coordination layer never becomes the only record of work (§9, ADR-0003).
4. **Ambiguity is represented, not hidden.** A mutating action whose outcome is unknowable is `INDETERMINATE` — a real, persisted, visible outcome (§7, ADR-0008).
5. **Narrow targets, deny by default.** RuptureGrid executes only against registered, authorized target origins; production is denied in v1 (security-boundaries.md).
6. **Derivation is versioned.** Normalizers, invariant evaluators, and finding engines are versioned; derived artifacts record which version produced them (evidence-model.md §2).
7. **Bounded contexts are logical before they are physical.** Do not create microservices to feel distributed; separate processes only where failure domains, trust boundaries, or scaling semantics genuinely differ (§3).
8. **The target owns its business state.** RuptureGrid causes failures through the target's legitimate interfaces; it never secretly mutates target business tables (§5, ADR-0002).

## 2. Bounded contexts

Five logical bounded contexts. Responsibilities and rationale:

### A. Control Plane
- Target registration and authorization records.
- Experiment definitions and versioning.
- Run creation, **run snapshots** (pinned execution intent), run/step lifecycle metadata.
- Invariant definitions and bindings.
- Server-side blast-radius limits (enforced at snapshot creation and at execution).

### B. Execution Plane
- Dispatch of executable work.
- Worker execution, target adapters (HTTP executor).
- Concurrency, repeats, timeouts, cancellation.
- Deliberate fault injection (e.g., duplicate delivery, post-send timeout).
- Durable leases, heartbeats, fencing tokens, recovery/reconciliation participation.

### C. Evidence System
- Ingestion and durable storage of raw observations captured during execution.
- Content addressing and per-run hash chaining (evidence-model.md §4).
- Redaction-before-persistence enforcement (security-boundaries.md §7).

### D. Analysis System
- Normalization of raw observations into normalized events (versioned normalizers).
- Causal reconstruction (identity-based; evidence-model.md §6).
- Business invariant evaluation (deterministic engine; PASS / FAIL / NOT_EVALUABLE).
- Findings with provenance. Timeline assembly.

### E. Demo Target
- A purpose-built, deliberately vulnerable-then-fixable distributed fintech application used to prove RuptureGrid works (incident-zero.md, roadmap Phase 2).
- Runs as a **separate application with its own database**. From RuptureGrid's perspective it is an external system under test, indistinguishable in kind from any other authorized target.

**Why these boundaries.** Control/Evidence/Analysis are one product's data with a shared lifecycle and are separated as *logical* contexts (module boundaries, separate schema ownership, no cross-context table access) inside the API process. The Execution Plane is a separate *physical* process because its failure domain is fundamentally different (it must crash, be killed, lose leases, and recover without corrupting control truth — these properties must be testable, which requires an actual process boundary). The Demo Target is a separate *physical and logical* application because the product's core claim ("we treat the target as external") is only honest if the target really is external.

## 3. Physical topology (v1)

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│  Web (UI)   │────▶│  API process (Control + Evidence + Analysis) │
│  Next.js    │     │  NestJS modules per bounded context          │
└─────────────┘     └───────┬───────────────────────┬──────────────┘
                            │ dispatch / claim      │ ingest observations
                            ▼                       │
                    ┌───────────────┐               │
                    │ Redis + BullMQ│               │
                    │ (coordination │               │
                    │  ONLY)        │               │
                    └───────┬───────┘               │
                            │ claim work (lease)    │
                            ▼                       │
                    ┌───────────────────────────────┴─┐
                    │  Worker process(es)             │
                    │  (Execution Plane)              │
                    └───────┬─────────────────────────┘
                            │ HTTP via registered adapter ONLY
                            ▼
                    ┌─────────────────────┐        ┌──────────────────────┐
                    │  Demo Target app    │───────▶│ Target PostgreSQL    │
                    │  (separate process, │        │ (target-owned schema)│
                    │   separate DB)      │        └──────────────────────┘
                    └─────────────────────┘

     RuptureGrid PostgreSQL (control / evidence / analysis schemas)
     — owned exclusively by the API + worker processes
```

Process count in v1: **API, Worker(s), Demo Target, Web** — four deployable applications plus three infrastructure stores (RuptureGrid PostgreSQL, Target PostgreSQL, Redis). This is the minimum set that makes the architectural claims testable. Additional processes (dedicated analysis worker, provider simulator service) are deferred until load or isolation demands them.

## 4. Data ownership

| Store | Owner | Contents | Others may... |
|---|---|---|---|
| RuptureGrid PostgreSQL — schema `control` | Control Plane | targets, experiment definitions, snapshots, runs, steps, invariant definitions | read via Control Plane APIs only |
| RuptureGrid PostgreSQL — schema `evidence` | Evidence System | raw observations, integrity chains, redaction records | read via Evidence APIs; append via ingestion API only |
| RuptureGrid PostgreSQL — schema `analysis` | Analysis System | normalized events, causal relationships, invariant evaluations, findings, timelines | read via Analysis APIs |
| Target PostgreSQL | Demo Target | customers, wallets, ledger entries, provider payments/events, deliveries, processing attempts, financial effects | **NOBODY. Not RuptureGrid. Ever.** (read exceptions in §5) |

Hard rules:

- RuptureGrid never opens a write connection to Target PostgreSQL. There is no shared schema, no cross-database foreign key, no "helper" write path.
- One RuptureGrid database instance hosts the three RuptureGrid schemas; schema-level ownership boundaries are enforced by separate Prisma schema ownership and module rules. The Target database is a separate instance. If a future scale phase splits RuptureGrid schemas into separate instances, no application code may assume co-location.
- Redis holds **no authoritative state**: queue payloads reference durable row IDs; the row is the truth (§9).

## 5. Target ownership and observation

- Failures are created **through the target's legitimate interfaces**: its HTTP API, its webhook endpoint, and (for experiment configuration) its own administrative API — e.g., switching the Demo Target between vulnerable and secure processing modes is done via a target-owned configuration endpoint, never by editing target state behind its back.
- **Business-state verification** (needed to evaluate invariants) uses, in order of preference:
  1. A **target-authored read-only inspection API** (the Demo Target exposes one; external targets are expected to expose equivalent interfaces).
  2. An **optional, explicitly configured, read-only observation adapter** (e.g., read-only SQL observer) for authorized environments, recorded in the run metadata whenever used.
- Any observation adapter is: explicitly configured per target, read-only, auditable (its use is recorded as provenance on evidence), and never a mutation path.
- Hidden cross-database mutations are an architectural violation, not a shortcut (ADR-0002).

## 6. Control Plane domain model (concepts, not DDL)

- **TargetSystem** — a registered, authorized target: identity, base origin(s), environment classification (`local-development` | `staging` | `production`), credentials *references* (never values), declared sensitive fields, permitted experiment classes.
- **ExperimentDefinition (versioned)** — ordered **steps**; each step declares an action (HTTP request template against the registered origin), optional fault plan (duplicate delivery, post-send timeout, connection drop), repeat count, concurrency, timeout, expected outcome class, and **declared-retry policy**.
- **RunSnapshot** — the append-only, canonicalized, hash-pinned materialization of everything a run needs: resolved target origin, steps with full request templates (credentials as *references* + fingerprints), fault plan, repeat/concurrency/timeout, invariant bindings, engine/normalizer/invariant versions, environment authorization record (ADR-0010).
- **ExperimentRun** — one execution of one snapshot: state machine (§8), ownership record, reconciliation state, evidence chain head.
- **StepRun** — one step of one run: state, attempts, outcome, side-effect knowledge (§7), timing, observation references.
- **Invocation** — one physical attempt of one step (including deliberate repeats); carries `deliveryAttemptId`-style identity for evidence correlation.
- **InvariantDefinition (versioned)** — a declared business rule, its parameter bindings (e.g., target wallet, logical payment reference), and the evaluation contract it binds to.

## 7. Execution failure semantics

### 7.1 Two orthogonal outcome dimensions

Every mutating invocation records **two** independent facts:

- `intentOutcome` — did the executor complete its own work? (`SUCCEEDED` | `FAILED` | `CANCELLED`)
- `sideEffectKnowledge` — what is known about the remote mutation? (`KNOWN_OCCURRED` | `KNOWN_ABSENT` | `INDETERMINATE`; `NOT_APPLICABLE` for read-only actions)

Classification rules (executor's obligation, enforced in Phase 3):

| Situation | intentOutcome | sideEffectKnowledge |
|---|---|---|
| Request sent, definitive success response | SUCCEEDED | KNOWN_OCCURRED (per response semantics) |
| Definitive error response (4xx/5xx per contract) | FAILED | KNOWN_ABSENT *only if* the target contract guarantees no effect for that response; otherwise INDETERMINATE |
| Connection refused / DNS failure / TLS failure **before send** | FAILED | KNOWN_ABSENT |
| Timeout or connection reset **after request sent** | FAILED (intent) | **INDETERMINATE** |
| Worker crash mid-request (recovered later) | FAILED (intent) | **INDETERMINATE** |
| Run cancelled before dispatch | CANCELLED | KNOWN_ABSENT |
| Run cancelled mid-flight | CANCELLED | INDETERMINATE if a mutating request was in flight |

The INDETERMINATE rows are the point: **a lease cannot know what a dead worker's in-flight request did** (ADR-0008).

### 7.2 Repeat vs retry (distinct concepts)

- **Repeat** — *experiment-declared* additional executions of a step (e.g., deliver the same webhook 20 times). Intentional experiment content; modeled as first-class invocations with distinct `deliveryAttemptId`s.
- **Retry** — *executor-driven* re-execution following an ambiguous or failed outcome. Governed by the step's declared policy, defaulting to **conservative**:

| Situation | Default retry behavior |
|---|---|
| Provably not sent (pre-send failure) | Retry allowed |
| Read-only action, transient failure | Retry allowed |
| Mutating action, `INDETERMINATE` | **Do not auto-retry** unless the step declares target-contract idempotency (e.g., idempotency key semantics) or the experiment explicitly accepts the risk |
| Mutating action, definitive failure per contract | Retry allowed per declared policy |

Blind retries of ambiguous mutations are forbidden by default: they would manufacture exactly the duplicates RuptureGrid is designed to detect — as an accident rather than as an experiment.

### 7.3 Timeouts

Per-step timeout and per-invocation timeout are distinct configuration; both have server-side caps (security-boundaries.md §8). A timeout is an *observation* (input to the classification table above), not itself a terminal outcome.

## 8. Run and step state machines

Run: `CREATED → SNAPSHOT_PINNED → DISPATCHING → RUNNING → (RECONCILING ⇄ RUNNING) → { COMPLETED | FAILED | CANCELLED }`

Step: `PENDING → DISPATCHED → CLAIMED (lease held) → EXECUTING → { SUCCEEDED | FAILED | CANCELLED }` — with `sideEffectKnowledge` recorded per §7.1 as an orthogonal field.

Rules:

- Terminal states are set once, by the lease-holding owner, subject to fencing (§10). A terminal state is never silently overwritten; a conflicting write attempt is rejected at the database level and recorded as a stale-writer event.
- A mutating step whose `sideEffectKnowledge` is `INDETERMINATE` is surfaced as an **INDETERMINATE step** in every derived view (summaries, timelines, findings, UI) — a first-class presentation of the orthogonal fields, never a rewrite of `intentOutcome` ([evidence-model.md](evidence-model.md) §9, [product-design.md](product-design.md) §6).
- `RECONCILING` covers recovery work: finding runs/steps whose lease expired mid-flight, resolving their outcomes (often to INDETERMINATE for mutating steps), and re-dispatching only what is safe to re-dispatch (§7.2).
- A run may complete with individual INDETERMINATE steps; the run's own summary reports them — it must not launder them into "passed".

## 9. Durability and coordination (PostgreSQL + Redis/BullMQ)

- **PostgreSQL owns durable truth**: runs, execution intent, step state, evidence, invariant results, findings all live in PostgreSQL and survive any queue or cache failure (ADR-0003).
- **Redis/BullMQ is coordination only**: job payloads carry durable row IDs (run/step), never authoritative state. Losing Redis loses scheduling convenience, not work.
- Required failure behavior (acceptance scenario, Phase 3):
  1. API durably creates a run and its steps.
  2. Queue becomes unavailable.
  3. Run remains persisted in `DISPATCHING`.
  4. Queue recovers.
  5. **Reconciliation** discovers undispatched/under-dispatched durable work and dispatches it.
  6. Execution continues without operator intervention and without data loss.

```mermaid
sequenceDiagram
    participant API as API (Control)
    participant PG as PostgreSQL
    participant Q as Redis/BullMQ
    participant W as Worker
    participant T as Target

    API->>PG: insert run + steps + snapshot (durable)
    API->>Q: enqueue step jobs (IDs only)
    Note over Q: queue unavailable — enqueue fails
    API-->>PG: run stays DISPATCHING (durable)
    Note over Q: queue recovers
    Q->>W: reconciliation sweeps DISPATCHING runs
    W->>PG: claim step (lease, fencing token)
    W->>T: execute HTTP action (observe everything)
    W->>PG: observations → evidence; step outcome (fenced write)
```

## 10. Execution ownership: leases and fencing

Multiple workers are a design requirement from the start. Ownership of executable work is durable and concurrency-safe:

- Each claimable unit (step) has a lease row: `ownerId`, `expiresAt`, `fencingToken` (monotonically increasing generation, incremented on every successful claim).
- Workers heartbeat to extend the lease before expiry.
- Every state transition by a worker **must** carry its `ownerId` + `fencingToken`; the durable write is conditional (`WHERE owner = :me AND fencing_token = :myToken`). Worker-appended raw observations are **content-addressed, append-only records of what was actually observed** — they are not durable *state* and must not be dropped by fencing: a stale worker still genuinely observed what it observed. Correctness instead requires: (a) observations are keyed by their owning invocation/step and tagged with the writing owner + fencing token, so analysis can attribute and, where needed, discount superseded attempts; (b) all *state* writes (step/run transitions, terminal outcomes) remain fenced and zero-row-rejected. The fencing contract governs durable state; it never silently rewrites or discards recorded reality.
- If the lease expired and another worker claimed (new fencing token), the stale worker's write matches **zero rows** → it must abort, discard its in-memory progress, and report a stale-writer event. It must never overwrite newer state.

```mermaid
sequenceDiagram
    participant A as Worker A
    participant PG as PostgreSQL
    participant B as Worker B

    A->>PG: claim step (token=1)
    Note over A: A stalls; lease expires
    B->>PG: claim step (token=2, owner=B)
    B->>PG: fenced writes (token=2) accepted
    Note over A: A wakes up, tries to write
    A->>PG: write WHERE owner=A AND token=1
    PG-->>A: 0 rows affected → ABORT, report stale-writer event
```

**Honest limitation (documented, not hidden):** leasing prevents *stale workers from corrupting durable state*. It does **not** un-know what a stale worker's in-flight mutating request did to the target. That is why §7's `INDETERMINATE` semantics exist: the two mechanisms solve different problems (ADR-0009, ADR-0008).

## 11. Snapshots and reproducibility

- At run creation, the Control Plane materializes a **RunSnapshot**: canonicalized JSON, content-hashed, stored append-only, referenced by every downstream artifact. Later edits to experiment definitions, target configuration, or limits never change a historical run (ADR-0010).
- The snapshot stores credential **references + fingerprints**, never values; at execution time values are resolved from the live environment. If a secret has rotated, replay fails fast with an explicit mismatch, not silently.
- Replay = create a **new run from the stored snapshot**. What replay reproduces: execution intent. What it cannot reproduce: external network conditions, wall-clock timing, concurrency interleavings, prior target state. See [incident-replay.md](incident-replay.md) for the exact guarantee table and honest limits.

## 12. Evidence flow

Workers capture observations at execution time (HTTP wire facts, timing, executor errors, target-observation events). Observations are redacted **before** persistence (security-boundaries.md §7), appended to the evidence store, content-hashed, and chained per run (evidence-model.md §4). Analysis reads observations through Evidence APIs and produces derived artifacts carrying provenance. The full model, terminology, and integrity guarantees are in [evidence-model.md](evidence-model.md).

## 13. Portability and configuration

- No hard-coded paths, machine-specific database locations, or checked-in secrets. All runtime configuration is environment-driven with validated schemas; startup fails fast on missing/invalid configuration (engineering-rules.md §3).
- The repository lives at `E:\RuptureGrid-v1.0` on this machine; **nothing in the implementation may assume that path** or any other machine-specific detail (ADR-0001, engineering-rules.md §6).
- Local development targets (including the Demo Target) use containerized infrastructure via Docker Compose in later phases; ports, credentials, and URLs come from environment configuration, never from source constants.

## 14. Technology direction

Evaluated stack (rationale and alternatives in ADR-0001; **no versions frozen in Phase 0**):

- **TypeScript / Node.js**, **pnpm workspace** monorepo
- **NestJS** API process, dedicated **worker** process
- **Next.js** product UI
- **PostgreSQL** via **Prisma** (migrations as the authoritative schema history)
- **Redis + BullMQ** for coordination
- Runtime validation (schema-validated configuration and payloads), structured logging
- **Docker Compose** for local infrastructure; **Playwright** for UI E2E later; **OpenTelemetry** later; **FFmpeg** later for the demo video phase

Every correctness-relevant dependency (PostgreSQL semantics, Redis/BullMQ behavior, HTTP stack) is tested against **real** infrastructure per [testing-strategy.md](testing-strategy.md) §3.
