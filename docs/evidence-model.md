# RuptureGrid v1.0 — Evidence Model

Status: **Phase 0 — terminology and contracts only. No runtime implementation exists.**
Authoritative for: evidence terminology, observed-vs-derived-vs-AI semantics, integrity guarantees (stated honestly), causality rules, invariant evaluation contracts.

Related: [architecture.md](architecture.md) §12, [product-spec.md](product-spec.md) §9, [security-boundaries.md](security-boundaries.md) §7 (redaction), ADR-0006, ADR-0007.

---

## 1. Canonical terminology

These definitions are canonical. Other documents link here rather than redefining.

### RAW OBSERVATION
Information **actually observed during execution** by RuptureGrid's executor or explicitly configured observation adapters. Examples: HTTP request wire facts, HTTP response wire facts, delivery emission events, timing measurements, executor errors, target-observation adapter reads. Raw observations are the only source of new truth.

### NORMALIZED EVENT
A **deterministic, versioned** structured projection derived from one or more raw observations. Produced by a versioned normalizer. Re-running the same normalizer version on the same observations must produce the same events (idempotent derivation).

### CAUSAL RELATIONSHIP
A relationship between events **supported by explicit identity/context linkage** (identities carried in payloads, headers, or target records) — never by timestamp proximity alone. Timestamp proximity may be recorded only as a *weak hint* with `basis: temporal-correlation` and must never be the sole support for a finding (§6).

### INVARIANT EVALUATION
A **deterministic evaluation** of a declared business rule against evidence (normalized events + target business-state verification). Verdict is exactly one of: `PASS`, `FAIL`, `NOT_EVALUABLE`. `NOT_EVALUABLE` is a first-class outcome: when evidence is insufficient, the honest verdict is "cannot determine", never a silent pass (§7).

### FINDING
A **derived technical conclusion** supported by evidence references and invariant evaluation results, carrying full provenance (§2, §8). A finding is the deterministic layer; it may be *interpreted* by AI but never *decided* by AI (ADR-0007).

### TIMELINE
The **investigation representation** of relevant ordering, overlap, retries, and ambiguity within a run. Every ordering carries an explicit basis label (§9): deterministic sequence/order keys where they exist, wall-clock timestamps where only they exist, and explicit markers for genuinely unordered/overlapping events.

### REPRODUCTION DEFINITION
The information required to **intentionally execute the same experiment intent again**: the run snapshot plus experiment parameters, target mode, and environment requirements. Defined precisely in [incident-replay.md](incident-replay.md).

## 2. Observed vs derived vs AI-interpreted

Every stored artifact declares its **origin class**:

| Origin class | Meaning | Examples |
|---|---|---|
| `OBSERVED` | Captured from real execution; not computable from other stored data | HTTP wire facts, timings, delivery emissions, target-state reads |
| `DERIVED` | Deterministically computed from observed data by a versioned engine | Normalized events, causal relationships, invariant evaluations, findings |
| `AI_INTERPRETED` | Generated interpretation, explicitly labeled, never authoritative | Summaries, root-cause hypotheses, remediation suggestions |

Provenance rules:

- Every `DERIVED` artifact records: input evidence references, engine identifier, **engine version**, and derivation timestamp.
- Every `AI_INTERPRETED` artifact records: model/agent identity, generation timestamp, the evidence/finding references it is *about*, and an `interpretationId` that ties it to — but never mutates — the deterministic layer.
- AI artifacts are stored in a separate namespace/surface and are visually and API-wise distinguishable from derived truth. An AI artifact can never be an input to invariant evaluation.

## 3. Raw observation kinds (initial contract)

| Kind | Captured by | Contains |
|---|---|---|
| `http_request_observed` | Executor | method, resolved URL, headers (redacted), body (per redaction policy), wire timing, invocation identity |
| `http_response_observed` | Executor | status, headers (redacted), body (per redaction policy), timing, correlation to its request |
| `delivery_emitted` | Executor | which logical event, which `deliveryAttemptId`, fault-plan context (e.g., "duplicate delivery 2 of 20") |
| `executor_error` | Executor | classification (pre-send / post-send), error kind, timing — the input to §7-style outcome classification |
| `target_observation` | Explicitly configured read-only adapter | target-state reads (e.g., inspection API response), adapter identity, read-only proof-of-scope metadata |

Every observation carries: run ID, step ID, invocation ID, capture timestamp, schema version, and (after ingestion) its content hash and chain position.

## 4. Integrity — honest guarantees

Design intent for evidence storage:

- **Logically append-only**: the application exposes no update or delete path for persisted observations. Corrections happen by appending superseding records, never by rewriting.
- **Content-addressed**: each observation stores the SHA-256 of its canonical serialized bytes.
- **Hash-chained per run**: each observation records the hash of its predecessor; the run stores the final chain head. Any modification of stored bytes breaks the chain detectably.
- **Versioned**: observation schemas and redaction policies are versioned so old evidence remains interpretable.

**What this does NOT mean (stated plainly):**

- Hash chains detect post-hoc modification by the application's writers. They do **not** prove authorship, and they do **not** prevent a database administrator or storage-level actor from rewriting rows and recomputing chains.
- Evidence records are **not** "magically immutable", **not** "tamper-proof", **not** "non-repudiable", and **not** legal forensic proof. They are engineering evidence with detectable-modification guarantees.
- If a future phase needs stronger guarantees (external anchoring, signed evidence, WORM storage), that is a deliberate, separately designed extension — not something to claim implicitly now.

## 5. Redaction interplay

Redaction happens **before durable persistence** (security-boundaries.md §7): credential headers and registered sensitive fields never enter the evidence store. Consequence, stated honestly: evidence supports **semantic** reproduction of requests, not byte-for-byte reproduction of everything that crossed the wire. Security wins over literal fidelity (ADR-0012).

## 6. Causality rules

1. **Identity first.** A causal relationship requires explicit linkage: the same `providerPaymentId`/`providerEventId` carried through delivery → processing → effect, or an effect record that names its provenance, or an invocation identity that a target record references.
2. **Attribution strength is explicit.** Each causal relationship records its basis:
   - `identity-direct` — the effect record itself carries the logical identity.
   - `identity-chain` — identity linkage reconstructed through the delivery→processing→effect chain.
   - `temporal-correlation` — weak hint only; recorded, labeled, and **never sufficient** for a deterministic FAIL verdict on its own.
3. **Conflicts are recorded, not resolved silently.** If evidence supports two contradictory causal readings, both are stored with their bases; the finding layer must either resolve with declared reasoning or return `NOT_EVALUABLE`.
4. **Absence of linkage is itself evidence.** If the target's effects cannot be attributed because the target does not record provenance, the invariant evaluation reports the gap honestly rather than assuming attribution.

## 7. Invariant evaluation contract

- An invariant definition is **versioned** and bound to parameters (e.g., logical payment identity, wallet, expected amount).
- The evaluation function is **deterministic**: same inputs (same evidence set + same target-state verification results + same evaluator version) ⇒ same verdict, always.
- Inputs: normalized events, causal relationships, and target business-state verification results (via the target-authored inspection API or an explicitly configured read-only adapter — [architecture.md](architecture.md) §5).
- Verdicts: `PASS` | `FAIL` | `NOT_EVALUABLE`, each with the evidence references that justify it.
- A `FAIL` verdict requires attribution basis of at least `identity-chain` (§6) for every counted duplicate effect.
- Evaluations record the evaluator version; stored evaluations can be re-run under a new version without mutating history (new evaluation row, linked to the same inputs).

## 8. Findings

A finding must contain:

- The invariant evaluation(s) it rests on (references + verdicts).
- The causal relationships involved (references + bases).
- The business statement in product language ("One confirmed payment produced two accepted credits of 500000 paisa each to wallet W").
- Provenance: finding-engine version, input references, derivation timestamp.
- Confidence scope: what is proven versus what remains uncertain (explicitly listing any INDETERMINATE steps or `temporal-correlation` dependencies).

Severity/prioritization is a later-phase concern; v1 findings are engineering conclusions, not ticketing metadata.

## 9. Timeline rules

- Every timeline entry carries an **ordering basis**: `sequence` (deterministic per-run ordinal), `wall-clock` (capture timestamp), or `unordered/overlapping` (events known concurrent; relative order not knowable and not asserted).
- The timeline renders retries vs repeats vs distinct business actions as distinct, using the identity model ([product-spec.md](product-spec.md) §7).
- INDETERMINATE outcomes appear in the timeline as first-class entries — visibly uncertain, never smoothed over ([product-design.md](product-design.md) §6).
- The timeline is an investigation tool: identifiers, timestamps, statuses, filtering, and comparison are requirements, not decorations ([product-design.md](product-design.md) §4).

## 10. What evidence can and cannot prove

Can: that specific requests were sent and specific responses received; that specific business state existed at specific verification points; that specific causal chains are supported by identity linkage; that a declared invariant held or failed on that evidence.

Cannot (honestly): prove what happened inside the target between observations; prove a negative beyond the verification surface queried; prove system-wide correctness from one experiment; prove anything about execution that was never captured.

Every RuptureGrid claim must stay inside line 1. This boundary is what makes the product trustworthy.
