# ADR-0026: Run-Owned Evaluation Eligibility + Multi-Subject Exit Truth

## Status

**PROPOSED — NOT ACCEPTED.** Design only. No runtime change, no migration,
no implementation in this change. Phase 17 remains uncommitted; no phase or
workflow has authorized implementation.

**Revision note (design-repair session).** The first proposal of this ADR
received an independent audit verdict of **FAIL — DESIGN REPAIR REQUIRED**
with eight findings (P-01 through P-08). This revision repairs the contract
against every finding: P-01 (subject-set laundering) by a frozen coverage
contract with four subject classes and a strict-coverage v1 mode; P-02 by an
exact single-scope-field rule with declaration-time type compatibility and an
explicit generation mapping; P-03 by fenced terminal-owner anchor authority
with preserved stale provenance and a fail-closed conflict rule; P-04 by an
exact numeric-bounds table grounded in existing constants; P-05 by a
ten-step step/origin authority procedure; P-06 by selecting the persisted
current-evaluation reference model (with an honest additive migration
proposal — the "no migration" claim of the first proposal is withdrawn);
P-07 by a single non-contradictory foreign-row anomaly rule; P-08 by frozen
legacy/generic coexistence with an explicit gated evaluator version. The
detailed alternatives and reasoning of the first proposal are preserved and
extended, not discarded. No section of the superseded proposal text is
retained where it contradicts this revision; where this revision and the
superseded text disagree, this revision governs.

**Revision note (final-closure session).** The independent design re-audit
returned exactly one blocking finding (B-1: the report-decision
evidence-advance race) with P-01–P-08 CLOSED/RESOLVED. This revision closes
B-1 with the §13 evidence-head linearization contract (shared per-run append
serialization, a DB-only authorization transaction, and explicit as-of
certification semantics) and applies ten non-blocking clarifications from
the same audit. The P-01–P-08 architectures are unchanged.

**Revision note (analysis-watermark closure session).** The report-side
linearization contract above was re-audited and found sound — but the audit
returned **FAIL — B-1 STILL OPEN**, because the design froze *when a report
decision is authorized* (Boundary B) without freezing *when an analysis pass
captures the evidence watermark its results belong to* (Boundary A). An
append committing during an analysis pass could therefore be excluded from a
decision whose pointer watermark was later published as if it covered that
evidence, with no report-side check able to see it. This revision freezes the
analysis-side watermark capture/publication contract (§13: before-read H0
capture, lock-scoped `Hcurrent == H0` publication validation,
confirmed-evaluation re-publication under a NEW generation + watermark, the
two explicit race boundaries, and cases 51–56), withdraws the pointer
"identical heads stay" wording that contradicted the authorization
watermark check, corrects every unsupported "immutable" phrasing to the
qualified logically-append-only / hash-pinned vocabulary (R-18), and applies
the five precision clarifications from the same audit (lastChainIndex
agreement, proof-watermark comparison, explicit READ COMMITTED, no
post-authorization live reads including `loadNormalizerVersions`, and a
defined bounded-retry/terminal-staleness rule). P-01–P-08 and the report-side
contract are unchanged in architecture.

**Revision note (B-3 truth-input closure session).** An independent re-audit
confirmed P-01–P-08 CLOSED and the B-1 analysis/report watermark repair
CLOSED *for the raw evidence chain*, and returned exactly one remaining
blocker: the analysis derives anchor authority and eligibility from
run-scoped execution provenance (`control.experiment_step_run`,
`control.step_invocation`, `control.stale_writer_event`) that is written
OUTSIDE the evidence chain and, today, OUTSIDE the per-run advisory lock — so
a late provenance append can invalidate anchor truth without changing the
chain head `H0`. This revision closes that class rather than one code path:
the §13 subsection **Composite run truth-input watermark (B-3 repair)**
defines `W = (C, P, D)` (chain identity + provenance revision + derivation
generation), the mandatory writer protocol that advances `P`/`D` in the SAME
transaction as every truth-bearing non-chain write under the shared per-run
advisory lock, the two-stage Boundary A capture, publication validation over
ALL components, the Boundary B composite comparison, derived-projection
completeness, and the honest epistemic limit of a watermark. It also
withdraws the stale-generation "recorded pre-send rows ⇒ immaterial"
exemption (unsound under the repo's own frozen F-1 rule, whose only
independent pre-send proof is `experiment_step_run.executingAt IS NULL`),
corrects the "Same `evidenceHeadHash` ⇒ no-op" sentence that contradicted the
confirmed-evaluation rule, and adds matrix cases 57–66. P-01–P-08, the
`runScope` contract, the report-side contract, and the B-1 chain-watermark
discipline are unchanged in architecture: this revision only ADDS truth-input
components, and it can only ever reduce a PASS, never create one.

## Context

Two independently reproduced HIGH-severity defects block Phase 17 acceptance.
Both concern what a run may claim as *its own* business truth when the
registered target honestly returns more than the run produced.

### Auditor counterexample 1 — F-3: foreign-scope evaluation (OPEN)

Old run A (VULNERABLE checkout, scope A): 2 orders, 2 reservations,
`remaining = -1`. Correct persisted results: `INV-CHK-1 = FAIL`,
`INV-INV-1 = FAIL`.

Later run B (SECURE checkout, scope B): 1 order, 1 reservation,
`remaining = 0`. Correct scope-B results: `INV-CHK-1 = PASS`,
`INV-INV-1 = PASS`.

Both business scopes are preserved on the same legitimate target. Run B's
complete-collection inspection observes BOTH (inspection/v1 paths are literal
and unfiltered by design — ADR-0022). The generic analysis evaluates scope A's
subjects again inside run B and persists foreign FAIL findings for run B.
Run-owned evaluation eligibility is missing.

Root-cause location (traced, not guessed):
`packages/evidence/src/generic-invariant-input.ts` →
`loadGenericEvaluationSubjects` groups **all** normalized role events of the
run by exact identity value, with no run-owned scope/generation filter and no
declared-subject domain. ADR-0023 §4 (`scopeBinding`) proves only that the
observations compared *within* one evaluation belong to one coherent
scope/generation — it does not prove that the coherent group belongs to the
current run. A foreign coherent group therefore evaluates and persists exactly
like an own group.

### Auditor counterexample 2 — EXIT-MAP-COLLAPSE-LAUNDERS-FAIL (OPEN)

`packages/cli/src/orchestrator.ts` (`executeScenario`, trusted-verdict-map
construction) builds:

```ts
new Map(evaluations.map((evaluation) => [evaluation.invariantKey, {...}]))
```

Multiple subject verdicts share one invariant key
(`packages/cli/src/report-input.ts` `loadReportEvaluations` correctly returns
one row per `(invariantKey, subjectKey)`, deterministically sorted — the
collapse happens downstream). After deterministic sorting, a later PASS
overwrites an earlier FAIL for the same key. Proven: own vulnerable subject
AAA FAIL + foreign secure subject ZZZ PASS → actual CLI process exit 0 PASS.
Expected: exit 1 INVARIANT_FAIL. The classifier
(`packages/cli/src/exit-code.ts` `classifyExit`) accepts
`boundVerdicts: ReadonlyMap<string, BoundVerdict>` keyed by invariant key only,
so it cannot even represent the multi-subject truth it is asked to classify.

### Auditor counterexample 3 — P-01: subject-set laundering (OPEN)

One run genuinely affects `SKU-A` and `SKU-B`. `SKU-A` evaluates PASS while
`SKU-B` evaluates FAIL. The scenario declares only `SKU-A`. The first
proposal evaluates the declared set and may return exit 0, silently excluding
the real `SKU-B` failure from a whole-run correctness claim. A declared set
alone, without a coverage contract over what else was observed in the same
run-owned scope, launders an in-scope failure into a PASS.

### Frozen contracts (weakened by nothing in this design)

AGENTS.md (R-01–R-20); product-spec §§7–9; architecture §§5, 7, 10–11;
evidence-model §§1–7; security-boundaries §§2–8; testing-strategy §§3–8;
engineering-rules §§1–10; checkout-zero §§2–5; incident-replay §§1–8; cli.md.
ADR-0008 (INDETERMINATE never laundered); ADR-0009 (fencing governs state, never
rewrites recorded reality); ADR-0010 (snapshots pin intent; replay = new run
from stored snapshot); ADR-0016 (manifest data-only; target claims never create
truth); ADR-0017 (declaration-only causality; contested identity ⇒
NOT_EVALUABLE); ADR-0018 (closed invariant registry; completeness/coherence
requirements); ADR-0019 (five-way exit contract; integrity dominates; missing
verdict ⇒ exit 2; expectations never truth); ADR-0020 (deliberate concurrency
driver; repeat ≠ retry); ADR-0021 (query → role binding; array responses;
unknown shapes ⇒ no events); ADR-0022 (literal inspection paths; identity,
scope, generation travel in returned evidence, never in the URL); ADR-0023
(observed-total completeness; scopeBinding internal coherence; lower-bound-safe
FAIL asymmetry; BS-1/BS-2 capture sets); ADR-0024 (platform-owned credential
authorization); ADR-0025 (commerce admin reference).

### Verified implementation facts this revision rests on (all observed in the tree)

- `EvaluationBatch` unique key: `(runId, invariantKey, evaluatorVersion)`;
  `InvariantEvaluation` unique key:
  `(runId, invariantKey, evaluatorVersion, subjectKey, evidenceSetHash)`
  (`packages/control-db/prisma/schema.prisma`). Multiple rows with DIFFERENT
  `evidenceSetHash` can and do exist for the SAME subject on the SAME batch.
- The pre-gating generic evaluator version constant is the bare string `'v1'`
  (`GENERIC_INVARIANT_EVALUATOR_VERSION`,
  `packages/evidence/src/generic-invariant-analysis.ts`); the definition
  vocabulary version is `'business-invariant/v1'`
  (`BUSINESS_INVARIANT_REGISTRY_VERSION`,
  `packages/engine/src/generic-invariant-registry.ts`). The two constants are
  distinct values with distinct meanings and are never interchangeable.
- `RawObservation` carries `(runId, stepRunId, invocationId,
  invocationIdentity, writerOwnerId, writerFencingToken)`; `StepInvocation`
  carries `(stepRunId, sequence, writtenByOwner, writtenByFencingToken,
  transportStage)`; `ExperimentStepRun` carries `(runId, sequence, name,
  state, leaseOwnerId, fencingToken, executingAt)` with unique
  `(runId, sequence)`. Fencing governs durable *state*; observations are
  attributed append-only records (architecture §10).
- Existing closed vocabularies reused verbatim: step-name grammar
  `^[a-z][a-z0-9-]{0,62}$` (`packages/engine/src/validate.ts`); field-name
  grammar `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` and identifier grammar
  `^[a-z][a-zA-Z0-9_-]{0,63}$`
  (`packages/engine/src/generic-invariant-registry.ts`,
  `packages/engine/src/manifest.ts`); `MANIFEST_LIMITS.maxIdentifierChars =
  64`; invariant key at most 80 characters (registry `MALFORMED_KEY` rule and
  `InvariantDefinition.invariantKey VarChar(80)`); `subjectKey VarChar(200)`
  (`NormalizedEvent`, `InvariantEvaluation`, `Finding`); scenario serialized
  cap `SCENARIO_MAX_SERIALIZED_BYTES = 64_000`
  (`packages/cli/src/scenario.ts`); `EvidenceIntegrityHead` is the accepted
  mutable-pointer precedent ("a mutable pointer row by design — it is
  coordination metadata, not observation truth").
- `EvidenceIntegrityHead` carries `(runId, lastChainIndex, headContentHash,
  observationCount)` — the run's current evidence-chain watermark, readable
  without recomputing business truth.
- Evidence appends are serialized per run by
  `SELECT pg_advisory_xact_lock(hashtext(runId::text))` inside one
  transaction that inserts the observation and advances
  `EvidenceIntegrityHead` atomically (15s transaction timeout) —
  `RawObservationStore.appendChainObservation`. `hashtext` collisions only
  add conservative false contention between runs, never false exclusion.
- `verifyRunEvidenceChain` recomputes the chain (gap-free links, content
  hashes, head identity/count); its recorded `lastVerified*` metadata is
  coordination metadata, never a decision input. A report certification is
  as-of a specific head identity, not a continuously-fresh claim.
- The frozen `ManifestEvidencePolicy` carries `sensitiveFields` (the target's
  redaction-registry extension), consumed from the frozen snapshot, never live
  registration.

## Decision

### 1. Three distinct concepts (frozen vocabulary for this ADR)

- **A. OBSERVED EVIDENCE** — everything honestly captured from the registered
  target, including historical/foreign subjects. Complete-collection inspection
  is preserved (§10). Observed evidence is never deleted, reinterpreted, or
  fabricated.
- **B. RUN-ELIGIBLE SUBJECTS** — the precise subjects the frozen run intended
  to verify (declared subject sets, §4) **and** has independently bound to
  itself through evidence-backed anchor equality (§5). A is not automatically B.
- **C. BUSINESS VERDICTS** — PASS / FAIL / NOT_EVALUABLE from the accepted
  generic evaluators over the eligible subjects and their complete relevant
  evidence. B does not decide C: eligibility selects *what* is evaluated; the
  unchanged evaluator decides the verdict. Expected verdicts (scenario
  expectations) never decide B or C (ADR-0019).

### 2. The missing mechanism, stated in one paragraph

ADR-0023 proves *internal* coherence (bound surfaces agree with each other).
This ADR adds the *external* binding: the coherent group must equal the run's
own observed anchor, and the subject must be a member of the run's frozen
declared subject set — and additionally the run must prove it did not silently
drop an in-scope subject (the coverage gate, §§6–7). Internal equality checks
are kept untouched; the run-eligibility gate and the coverage gate are
separate, preceding selection steps at the generic evaluation eligibility
boundary (`runGenericInvariantAnalysis`,
`packages/evidence/src/generic-invariant-analysis.ts`) — never a report-only
filter, never an evaluator rewrite (`evaluateGenericInvariant` is unchanged).
Current-truth selection over the resulting rows is a persisted,
analysis-materialized reference (§13), never a timestamp/UUID ordering, never a
report-side recomputation. Both ends of the pipeline are frozen in §13: the
analysis pass captures its composite truth-input watermark `W0 = (C0, P0, D0)`
BEFORE any business-evidence read and may publish only when the lock-scoped
current truth-input state still equals `W0` in every component (Boundary A);
report authorization is a single locked read of that composite state against
the published proof row and pointers (Boundary B). No
check-then-write window exists at either boundary.

### 3. Run-owned anchor intent (frozen `runScope` block, exact bounds)

**Source of frozen intent.** New OPTIONAL, closed, backward-compatible
`runScope` block in the experiment document (validated by the engine at
definition/freeze time, frozen into `snapshot.target.runScopeBinding`,
covered by `snapshotContentHash`):

```json
"runScope": {
  "version": "run-scope/v1",
  "setupStep": "establish-scenario",
  "declaredScope": "checkout-zero",
  "scopeField": "scopeToken",
  "generationField": "generationId",
  "subjects": {
    "INV-CHK-1": ["CHK-001"],
    "INV-INV-1": ["SKU-001"]
  }
}
```

`runScope.version` is exactly `"run-scope/v1"`; unknown versions are refused,
never guessed. The block's closed key set is exactly the six keys above;
unknown fields are definition-time rejections (`RUN_SCOPE_UNKNOWN_FIELD`),
never silently stripped.

Freeze-time rules (all definition-time rejections with the named issues;
every rule is fail-closed):

1. `version` exactly `"run-scope/v1"` (`RUN_SCOPE_UNKNOWN_VERSION`).
2. `setupStep` names exactly one step of the frozen steps array
   (`RUN_SCOPE_SETUP_STEP_UNKNOWN` when zero match). Step names are already
   unique by engine validation, so ambiguity is structurally impossible; a
   second match is a validation invariant violation, never resolved by order.
   The named step MUST declare `repeat: 1`
   (`RUN_SCOPE_SETUP_STEP_REPEAT`), `concurrency: 1`
   (`RUN_SCOPE_SETUP_STEP_CONCURRENCY`), and `retryPolicy: "NONE"`
   (`RUN_SCOPE_SETUP_STEP_RETRY_POLICY`): one anchor invocation by
   declaration. Declaration is not physical proof (see §5 on stale workers):
   crash/recovery can still append further observations, which is why anchor
   selection is fenced rather than positional.
3. `declaredScope`: 1..120 characters (`RUN_SCOPE_SCOPE_LENGTH`) matching
   `^[a-z][a-z0-9-]{0,119}$` (`RUN_SCOPE_SCOPE_GRAMMAR`). The 120-character
   ceiling reuses the existing name precedent (`displayName`,
   `ExperimentDefinition.name`, scenario name: all `VarChar(120)` / 120
   characters); the grammar reuses the step-name shape extended to that
   length. Any `$`, `{`, `}`, backtick, backslash, whitespace, or control
   character is therefore structurally impossible in a declared scope
   (`RUN_SCOPE_INTERPOLATION`).
4. `scopeField` / `generationField`: literal top-level JSON-object field
   names matching the existing field-name grammar
   `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` (at most 64 characters;
   `RUN_SCOPE_FIELD_GRAMMAR`). No dots, brackets, `$`, or path grammar —
   the ADR-0021/22 minimalism applied to response reading; nested extraction
   is a future `run-scope/v2`, never a compatible extension. Neither name may
   be a member of the frozen evidence policy's `sensitiveFields`
   (`RUN_SCOPE_SENSITIVE_FIELD`: the anchor must never be bound to a field
   that is redacted by construction), nor a member of
   `EXECUTOR_CREDENTIAL_REFS` (`RUN_SCOPE_CREDENTIAL_NAME`: the ADR-0025
   cross-target confusion lesson — credential names are never anchor fields).
5. `subjects`: keys ⊆ frozen generic invariant binding keys, and **every**
   generic binding key appears with a non-empty list of distinct bounded
   subject identity strings (fail-closed: a generic instance without declared
   subjects can never establish eligibility). Each key is at most 80
   characters (the existing registry `MALFORMED_KEY` rule). Each declared
   subject identity is 1..200 characters (`RUN_SCOPE_SUBJECT_LENGTH`; the
   200-character ceiling is the existing `subjectKey VarChar(200)` column
   bound shared by `NormalizedEvent`, `InvariantEvaluation`, and `Finding`),
   printable non-control, and MUST NOT contain `$`, `{`, `}`, backtick,
   backslash, CR, LF, or NUL, and MUST NOT contain the redaction marker
   `[Redacted]` (`RUN_SCOPE_INTERPOLATION`: no credential-reference syntax
   `${credential.…}`, no `${signature}`, no `${steps.…}`, no template form
   can survive declaration validation). At most 32 subjects per invariant key
   (`RUN_SCOPE_SUBJECTS_PER_KEY_LIMIT`; new number — precedent: the
   platform's standard bounded-collection caps `maxFieldsPerIdentityNode =
   32`, `maxHeaders = 32`, and the registry's `MAX_EQUIVALENCE_FIELDS =
   32`), and at most 64 subjects in total across all keys
   (`RUN_SCOPE_TOTAL_SUBJECTS_LIMIT`; new number — precedent: the
   `MANIFEST_LIMITS` 64-family `maxSensitiveFields` /
   `maxFieldsPerInspectionQuery` / `maxInspectionQueries`). The canonical
   serialized `runScope` block must not exceed 16_000 bytes
   (`RUN_SCOPE_SERIALIZED_LIMIT`; new number — an explicit sub-budget of the
   existing `SCENARIO_MAX_SERIALIZED_BYTES = 64_000`: worst-case identities
   occupy 64 × 200 = 12_800 bytes plus keys and structure, which fits the
   sub-budget with margin while leaving room for steps).
6. `runScope` present ⟺ generic `invariantBindings` present
   (`GENERIC_BINDINGS_WITHOUT_RUN_SCOPE` /
   `RUN_SCOPE_WITHOUT_GENERIC_BINDINGS`): no dead config, no implicit
   compatibility fallback for new generic definitions missing `runScope`;
   legacy Incident Zero / Controlled Faults documents carry neither and are
   byte-identical to today.
7. No cross-check against opaque step bodies is performed by the platform
   (bodies are target-shaped; target-specific parsing in platform code is
   forbidden). Authoring consistency is the scenario author's responsibility;
   inconsistency fails closed (§11: declared-but-unobserved ⇒ missing verdict
   ⇒ exit 2; observed-but-undeclared in the same scope ⇒ coverage anomaly ⇒
   exit 2).

A frozen declaration string alone is NOT proof (it is intent). A live
generation value alone is NOT proof (it is target data). Proof is their exact
conjunction with run attribution, below.

### 4. Eligibility algorithm — four subject classes (P-01 repair)

`selectEligibleSubjects(runId, frozenInstances, runScopeBinding, anchor,
entities)` — pure over persisted evidence + frozen snapshot; single
implementation shared by analysis (authoritative), with report and classifier
consuming only its persisted outputs (§18):

```
if runScopeBinding absent → mode LEGACY (compat, §17); return current behavior domain
if anchor unproven/conflicted → eligibleDomain = { key → declaredSubjects(key) },
                                evaluablePartitions = {}          # every declared subject → missing verdict path
for each generic instance k with scopeBinding (fields, generationField):
  for each declared subject s ∈ runScopeBinding.subjects[k]:
    partition = { entities e : identityField(k,s)(e) == s
                          AND scopeTuple(e) == (anchor.scope, anchor.generation) }
      where identityField = subjectIdentityField (atMostOneAcceptedEffect)
                            | resourceIdentityField (resourceConservation, over all
                              non-consumption roles — baseline, remaining, resource,
                              summary roles alike),
      and scopeTuple = exact values of the single scopeBinding field + generationField
      (missing/redacted/contested ⇒ not a member of any eligible partition)
    if partition nonempty → ELIGIBLE(k, s): evaluate with entities restricted to
                            partition (+ run-global captures, ACTIVE graph,
                            contested set, diagnostics — unchanged inputs)
    else → MISSING(k, s): no evaluation row (classifier §14 rule for missing)
```

Subject classes (frozen; every observed subject of a bound subject role in
the run's evidence falls in exactly one class):

- **A. Declared eligible subject.** Identity ∈ declared set for key `k` AND
  its entities carry exactly the anchor `(scope, generation)`. Evaluated; the
  verdict row is the run's truth for `(k, s)`.
- **B. Unexpected subject in the run-owned scope/generation.** Identity ∉
  declared set for key `k`, but its entities carry exactly the anchor
  `(scope, generation)` under a bound invariant's subject role. NEVER
  evaluated as a business verdict (the frozen intent did not declare it; the
  platform never expands the verification domain beyond frozen intent).
  Recorded as a **coverage anomaly** (`COVERAGE_ANOMALY` with the identity,
  key, scope, and generation): a coverage anomaly NEVER silently produces
  exit 0 — it forces the NOT_EVALUABLE path (exit 2), unless a trusted
  eligible FAIL already establishes exit 1 or an execution/integrity failure
  already establishes exit 3.
- **C. Foreign subject in another scope/generation.** Entities carry a
  `(scope, generation)` tuple that differs from the anchor tuple. Never
  evaluated; counted only in the foreign inventory (per `(scope,
  generation)`: distinct identity count — no verdicts, no findings). Foreign
  evidence is expected on a shared target and NEVER blocks exit 0 by itself.
- **D. Unidentifiable/contested evidence** whose scope or subject cannot
  safely be determined (missing/redacted scope or generation fields,
  missing/redacted SUBJECT identity fields, contested
  identity per ADR-0017 Decision 3, conflicting scope values within one
  subject group, mixed-generation groups). Fail closed: NEVER assumed
  foreign. Treated as a coverage anomaly (`COVERAGE_ANOMALY`, kind
  `scope-or-subject-indeterminate`) ⇒ NOT_EVALUABLE path, unless an
  independently sufficient trusted eligible FAIL already exists. Ambiguous
  evidence never disappears silently.

Properties preserved: the evaluator still receives ALL relevant evidence for
the exact `(subject, verificationScopeId, generationId)` (in-scope accepted
orders/reservations, contradictory summaries, missing surfaces, attribution
gaps); lower-bound-safe FAILs still fire without completeness; missing
completeness proof still yields NOT_EVALUABLE unless a lower-bound-safe FAIL
is independently proven. The evaluator function itself is byte-untouched; only
its input domain is restricted at the eligibility boundary, and the restriction
is provably semantics-preserving for the eligible partition (foreign entities
could never satisfy the instance's own scopeBinding coherence for the anchor
tuple).

Evaluation details for every eligible row carry (existing fields unchanged,
additive only): `eligibilityVersion: "run-eligibility/v1"`,
`runScopeAnchor: { declaredScope, observedScope, observedGeneration,
setupStep, setupStepRunId, setupObservationHashes, corroboratingSubmissionHashes,
anchorFencing: { leaseOwnerId, fencingToken } }`.
`genericEvidenceSetHash` input gains the anchor tuple
`(observedScope, observedGeneration)` and `eligibilityVersion` — same frozen
intent + new observed generation ⇒ new hash ⇒ new row under the existing
append-only discipline (history never rewritten; idempotent re-analysis
converges via the unchanged unique key + P2002 re-read). Because the hash
inputs change, gated evaluations MUST be stored under the new gated evaluator
version (§13): changed hash semantics under an indistinguishable old version
are forbidden.

### 5. Run-owned anchor authority with stale-worker discipline (P-03 repair)

**Candidate observations.** The setup step's captured step-response
observations, joined EXACTLY by `(runId, stepRunId, invocationId)` with writer
attribution `(writerOwnerId, writerFencingToken)`:

- `StepInvocation` rows keyed by `(runId, stepRunId, invocationId)` with
  `sideEffectKnowledge` and `transportStage` (existing durable provenance);
- `http_response_observed` raw observations (evidence-model §3: every
  observation carries run ID, step ID, invocation ID) for the setup stepRun —
  resolved by the frozen ordinal procedure of §11 (positions are stable;
  snapshots are logically append-only and hash-pinned), requiring stepRun
  terminal `SUCCEEDED` with valid
  owner/fencing provenance.
- The Demo Commerce setup surface returns exactly the needed fields today
  (`POST /demo/admin/scenario → 200 {scopeToken, generationId, sku,
  initialAvailableUnits, mode}`; scope establishment is atomic in the
  target's own transaction; generation increments per reset). The
  checkout-submit responses likewise carry
  `{checkoutIntentId, orderId, reservationId, scopeToken, generationId}` and
  are recorded as corroborating provenance in evaluation details (they are not
  the gate; the gate stays uniform across both invariant kinds).

`repeat: 1` (plus `concurrency: 1`, `retryPolicy: NONE` per §3) does NOT prove
physical uniqueness: crash/recovery, lease expiry with re-claim, and stale
generations can append further truthful observations for the same stepRun.
Row order, wall clock, and `createdAt`/`completedAt` NEVER select authority —
no first/last/newest selection exists anywhere in this section.

**Authoritative anchor selection (exact).**

1. Candidate anchors = setup-step response observations satisfying ALL of:
   origin `OBSERVED`; 2xx status; non-truncated (row and envelope);
   body parses as a JSON object whose top-level `scopeField` value is a
   string and whose top-level `generationField` value is a non-negative safe
   integer. A redacted (`[Redacted]`), missing, or type-invalid field is a
   gap, never a match (ADR-0023 §4 redaction rule, applied to the anchor).
   Candidates from another `runId`, another stepRun, or the
   `StepInvocation.responseBody` column are NEVER candidates (the
   `responseBody` column is a bounded executor convenience copy, not an
   alternative unhashed source of business authority — §11).
2. The **terminal-owner generation** is the stepRun's `(leaseOwnerId,
   fencingToken)` at its fenced terminal `SUCCEEDED` write. The candidate
   authoritative anchor set = candidates whose `(writerOwnerId,
   writerFencingToken)` equals the terminal-owner generation. Every other
   generation's candidates for the same stepRun are **stale candidates**:
   NOT automatically false (architecture §10: a stale worker still genuinely
   observed what it observed; a stale setup request may really have reset the
   target scope), preserved with full provenance, never erased, never
   reordered away.
3. Require at least one terminal-owner candidate with `scopeField value ==
   declaredScope` (exact equality, no coercion) — this proves the target
   established what the run asked, not merely that the run asked.
4. Require exactly one distinct `(scope, generation)` pair across the
   terminal-owner candidates. Zero ⇒ `ANCHOR_UNPROVEN`. Two or more distinct
   ⇒ `EVIDENCE_CONFLICT`. Multiplicity inside one generation is a target
   contradiction, never a selection problem.
5. The anchor is `(observedScope, observedGeneration, setupStepRunId,
   setupObservationHashes, leaseOwnerId, fencingToken)` — all durable row
   identities/hashes and fencing facts, no wall clock, no DB row order.

**The two separate questions (frozen).**

- **A. Which observed setup response is authoritative for the fenced
  terminal step outcome?** Answered by rules 1–5 above: the terminal owner's
  properly attributed response.
- **B. Could another stale or concurrent setup response have changed the
  same target scope after or during the run?** NEVER silently ignored. Every
  stale candidate for the same stepRun is compared against the authoritative
  anchor:
  - Stale candidate with an identical `(scope, generation)` pair and
    identical bound field values ⇒ **convergent**: the anchor stands; the
    stale provenance remains auditable (same BS-1 convergence discipline as
    ADR-0023 §2.4 — one fact, never summed, never order-selected).
  - Stale candidate with a conflicting scope value or a conflicting
    generation value ⇒ **EVIDENCE_CONFLICT** ⇒ the NOT_EVALUABLE path,
    UNLESS the stale generation is proven immaterial. Immateriality is
    proven ONLY by the INDEPENDENT durable step-level pre-send proof frozen
    in `engine-emergency.ts` (the F-1 repair):
    `experiment_step_run.executingAt IS NULL`, which proves that no action
    request was ever prepared for the step (`markExecuting` stamps the
    marker BEFORE any request is prepared and no state write ever clears
    it). A predicate over the RECORDED invocation set is NEVER that proof —
    neither zero recorded rows nor "every recorded row is below
    `REQUEST_SENT` (`PREPARED`/`CONNECTING`)" excludes an unrecorded send,
    because `recordInvocation` runs AFTER the physical send, so a sent
    attempt may have no row (the F-1 lesson: a persisted set is not a closed
    world, and a partial set coincidentally equal to `repeat` is refused for
    exactly this reason). Because a recorded invocation row for a step
    implies that step's executing marker is already set, the recorded-set
    exemption can NEVER coexist with the independent proof: in v1 every
    recorded stale generation is therefore a SUSTAINED CONFLICT unless its
    evidence is positively convergent (S-2/S-4), and a stale invocation at
    `REQUEST_SENT` or beyond likewise sustains the conflict. The recorded-set
    predicate remains NECESSARY for classification and reporting (an existing
    row is named; an absent row is never claimed as proof), and is never
    SUFFICIENT for immateriality.
    **A response-bearing generation can never be proven immaterial**: the
    accepted capture path writes `http_response_observed` only for a
    completed 2xx response (`observation.error === null`), and
    `recordInvocation` persists that invocation BEFORE the observation is
    captured, with `transportStage = RESPONSE_COMPLETE` and the same
    `(owner, fencingToken)` attribution — so the "every invocation below
    `REQUEST_SENT`" predicate necessarily fails for any generation that
    produced a stale candidate. The recorded-set exemption therefore never
    applies to a generation that produced a response candidate, and under the
    F-1 rule above it does not establish immateriality for a response-free
    generation either (matrix S-6); only the independent step-level proof does
    (S-6a).
    Attribution matching is **null-safe and fail-closed**: fencing-token
    comparisons use NULL-safe equality (SQL `IS NOT DISTINCT FROM`
    semantics; never `=` with a NULL operand, whose zero-row result could
    vacuously satisfy "every row is pre-send"); a generation with an
    unattributable (NULL) fencing token can never be proven immaterial.
  - No stale candidate but durable stale-generation invocations at
    `REQUEST_SENT` or beyond with no observable response (response lost,
    persistence failed) ⇒ the generation may have reset the scope with
    unknowable result ⇒ `EVIDENCE_CONFLICT` ⇒ NOT_EVALUABLE path. A sent
    setup request with unknowable outcome undermines generation coherence
    exactly like a conflicting response.
  - Stale-only responses with NO terminal-owner observation (setup stepRun
    never reached fenced terminal `SUCCEEDED`) ⇒ `ANCHOR_UNPROVEN` ⇒ the
    NOT_EVALUABLE path. Stale observations alone never anchor a run.

No latest-wins heuristic. No erasure of stale observation hashes. Stale
provenance remains auditable in the eligibility proof record (§13) and the
report.

**Stale/conflict outcome matrix (frozen).** All rows assume a COMPLETED run
with verified integrity unless stated; "→ NE" means the NOT_EVALUABLE path
(exit 2) unless a higher-precedence rule (§14) fires:

| # | Durable situation | Outcome |
|---|---|---|
| S-1 | One valid terminal-owner response; no stale candidates | Anchor established |
| S-2 | Terminal-owner response + duplicate identical stale response, same generation, identical values | Convergent; anchor stands |
| S-3 | Two different generation values among terminal-owner candidates | `EVIDENCE_CONFLICT` → NE |
| S-4 | Stale response identical to the owner response (same pair, same values) | Convergent; anchor stands |
| S-5 | Stale response with conflicting generation, stale generation NOT proven immaterial | `EVIDENCE_CONFLICT` → NE |
| S-6 | Stale generation with NO response candidate whose recorded rows are all pre-send (`transportStage` < `REQUEST_SENT`, ≥1 row), with NO independent step-level pre-send proof (`executingAt` set) | `EVIDENCE_CONFLICT` → NE: a recorded set is never proof that no request was sent (F-1), and a recorded row implies the executing marker is already set. Immateriality requires S-6a, which cannot coexist with any recorded invocation |
| S-6a | No generation ever prepared a request for the step (`executingAt IS NULL`) — no stale generation can exist at all | Anchor stands (S-1 path); the independent step-level proof is the only immateriality evidence v1 accepts |
| S-7 | Stale-only responses; no terminal-owner observation (setup never fenced `SUCCEEDED`) | `ANCHOR_UNPROVEN` → NE |
| S-8 | Setup step terminal `FAILED` | Anchor unproven → NE path (under the v1 ordered-dependency policy the run is then `FAILED` ⇒ exit 3 via §14 rule 1; the NE path applies if that policy ever admits a completed run here) |
| S-9 | Setup response received on the wire but observation persistence failed (no durable row) | Gap ⇒ `ANCHOR_UNPROVEN` → NE (never reconstructed from memory) |
| S-10 | Setup response truncated | Invalid candidate ⇒ gap ⇒ `ANCHOR_UNPROVEN` → NE |
| S-11 | Setup response scope redacted (`[Redacted]`) or generation redacted | Gap ⇒ `ANCHOR_UNPROVEN` → NE |
| S-12 | Terminal-owner candidates conflict on the scope value | `EVIDENCE_CONFLICT` → NE |
| S-13 | Setup response 2xx but body malformed JSON / not an object / wrong field types | Invalid candidate ⇒ gap ⇒ `ANCHOR_UNPROVEN` → NE |
| S-14 | Setup-looking response from another `runId` | Not a candidate (run join); ignored for THIS run's anchor, preserved as that run's own evidence |
| S-15 | Setup-looking response from a different step of the same run | Not a candidate (stepRun/name join — §11); no arbitrary step may anchor the run |
| S-16 | Physically sent stale setup attempt after lease loss (`REQUEST_SENT`+, no observable response) | `EVIDENCE_CONFLICT` → NE (unknowable scope reset) |
| S-17 | Stale generation sent setup, terminal owner later re-established the SAME scope string with a NEW generation | Conflict (S-5) → NE; the newer reset does not prove the older one's effects immaterial (no target-specific superset reasoning in platform code) |

### 6. Generic scope and generation mapping (P-02 repair)

ADR-0023 allows `scopeBinding.fields` to be a non-empty array (up to
`MAX_SCOPE_FIELDS = 16`). The run-owned anchor exposes exactly one declared
observed scope value. The mapping for multiple fields was undefined; it is
frozen here as an exact v1 rule, not a heuristic.

**Scope-field cardinality (frozen).** For any NEW definition combining
`runScope/v1` with a generic invariant binding, that binding's
`scopeBinding.fields.length` MUST equal 1 (`RUN_SCOPE_MULTI_SCOPE_FIELD`
otherwise — a named definition-time rejection, never a silent ignore of
additional fields). The anchor's observed scope value compares against the
value of that single declared inspection scope field:

```
anchor.scopeValue === inspectionEntity[scopeFieldName]
```

- The runScope `scopeField` (setup-response side) and the invariant's scope
  field (inspection side) are names in DIFFERENT declared schemas; the names
  MAY differ. The equality is value equality only — no field-name guessing,
  no implicit aliases, no target-specific branch.
- **Declaration-time type compatibility (frozen):** the invariant's single
  scope field MUST be declared `string` type on every bound surface that
  carries it (subject/effect/summary roles per ADR-0023 §4); the anchor-side
  check requires `typeof scopeValue === "string"` at observation time. No
  coercion in either direction (a numeric scope is never `String()`-ed into a
  match).
- A valid EXISTING invariant that requires multiple scope fields CANNOT be
  combined with `runScope/v1` in a new definition (rejected with
  `RUN_SCOPE_MULTI_SCOPE_FIELD`). Legacy snapshots (no `runScope`) keep their
  existing multi-field semantics untouched under compat mode (§17).

**Generation mapping (frozen).** The setup anchor's generation field maps to
the invariant's declared `generationField` as follows:

| Aspect | Frozen rule |
|---|---|
| Source field | The runScope `generationField` top-level field of the setup-step response object |
| Source type | MUST be a non-negative safe integer at observation time (`typeof number`, `Number.isSafeInteger`, `>= 0`); anything else is a gap, never a match |
| Target field | The invariant instance's `scopeBinding.generationField` (required whenever the runScope combination is used: a gated binding without a declared `generationField` is rejected with `RUN_SCOPE_GENERATION_REQUIRED`) |
| Target type | MUST be declared `integer-minor-units` on every bound surface (existing definition-time type discipline, ADR-0023 §6) |
| Exact equality | `anchor.generation === entity[generationField]` with `===` semantics; **no numeric-string coercion** — a run with generation 7 never evaluates generation `"7"` or `8` merely because the scope text matches |
| Missing value | Gap ⇒ the entity is not a member of any eligible partition (class D if the subject cannot otherwise be bound) |
| Invalid value (float, string, negative, unsafe integer) | Gap ⇒ same as missing; never coerced, never truncated |
| Redacted value (`[Redacted]`) | Gap ⇒ same as missing (ADR-0023 §4 redaction rule) |
| Conflicting values within one subject group | Contested ⇒ class D ⇒ coverage anomaly ⇒ NE path |

### 7. Coverage truth — what exit 0 claims (P-01 repair)

Even where every declared subject passes, the report states the scope of its
claim: **PASS over the declared, evidence-verified verification domain.**
Never "whole database verified", never "all target state correct", never "all
external business actions correct" (evidence-model §10).

**Coverage mode (frozen).** Exactly one strict mode exists in v1:
`strict-coverage/v1`. No narrower verification mode is permitted in v1 — no
mode matrix, no opt-out. Under `strict-coverage/v1`, exit 0 means ALL of:
run terminal `COMPLETED`; evidence integrity verified; every declared subject
of every bound generic key has a trusted current eligible PASS (§13); zero
coverage anomalies; zero foreign-row anomalies; zero missing verdicts; the
eligibility proof record is present and fresh. Any narrower claim ("PASS over
a subset") is a future ADR with its own mode string, never a silent
reinterpretation of exit 0.

**Mandatory coverage metadata.** The report carries a `coverage` block whose
every field is read from the persisted eligibility/coverage proof record
(§13) — never independently rederived from live target state, never
recomputed business truth:

- `coverageMode: "strict-coverage/v1"` and `coverageVersion` (tied to
  `eligibilityVersion`);
- declared subject set per invariant key (from the frozen snapshot);
- verified eligible subject set per key (subjects with trusted current
  evaluations);
- missing subject set per key (declared but unevaluated);
- unexpected same-scope subject identities + count (class B, named);
- foreign-scope inventory: per `(scope, generation)` distinct identity counts
  (class C, counts only);
- evidence gaps (named gap kinds: anchor gaps, capture gaps, attribution
  gaps, completeness gaps);
- the coverage limitation statement (fixed text): `"PASS is claimed only over
  the declared, evidence-verified verification domain named in this report;
  it proves nothing about other scopes, other subjects, other generations, or
  target state outside the verified domain."`

### 8. Anti-laundering matrix (frozen)

"NE" = NOT_EVALUABLE path (exit 2) unless a higher-precedence rule (§14)
fires. "Trusted FAIL" = a current eligible FAIL at the authoritative
evaluator version (§13). "NEVER PASS" means exit 0 is structurally
unreachable in that row.

| # | Situation | Frozen outcome |
|---|---|---|
| L-1 | Declared `SKU-A` PASS, undeclared same-scope `SKU-B` FAIL-state observed | Class B coverage anomaly ⇒ NE (exit 2). `SKU-B` is never evaluated (domain is frozen intent); its failure surfaces as the named anomaly, never as a verdict, and NEVER as exit 0 |
| L-2 | Declared `SKU-A` FAIL, undeclared same-scope `SKU-B` PASS-state observed | Trusted eligible FAIL ⇒ exit 1. `SKU-B` stays unevaluated inventory |
| L-3 | Declared `SKU-A` PASS, foreign-scope `SKU-B` FAIL-state observed | Class C foreign inventory only ⇒ exit 0 possible when all other required proofs complete |
| L-4 | Declared `SKU-A` PASS, foreign-scope `SKU-B` PASS-state observed | Class C ⇒ exit 0 possible |
| L-5 | Declared `SKU-A` PASS, undeclared same-scope `SKU-B` observed but truth unknown (no complete evidence) | Class B anomaly ⇒ NE (exit 2), NEVER PASS |
| L-6 | Declared intent A PASS, undeclared same-scope intent B with duplicate orders | Class B anomaly ⇒ NE (exit 2), NEVER PASS. B's duplicates are not evaluated (undeclared), so they cannot produce exit 1 here; the anomaly blocks exit 0 |
| L-7 | Missing declared subject (declared but unobserved) | Missing verdict ⇒ NE (exit 2), NEVER PASS |
| L-8 | Observed subject with contested identity/scope (class D) | Coverage anomaly ⇒ NE (exit 2), unless an independently sufficient trusted eligible FAIL already exists (⇒ exit 1) |
| L-9 | Declared `SKU-A` FAIL + undeclared same-scope `SKU-B` anything | Exit 1 (eligible FAIL dominates the anomaly) |
| L-10 | Any row above + execution/integrity failure | Exit 3 (integrity/execution dominates everything) |

### 9. Both invariant subject kinds

- **INV-CHK-1 (`atMostOneAcceptedEffect` → checkout-intent subject).**
  Subject role `checkoutIntent`; identity field `checkoutIntentId`; frozen
  selection intent `runScope.subjects["INV-CHK-1"]` (e.g. `["CHK-001"]`);
  run-specific observed anchor per §5 (setup response for the scope that owns
  the intent); target authority: target-authored setup response + inspection
  entities (values checked, never interpreted); scope identity
  `verificationScopeId == anchor.scope` via the §6 single-field mapping;
  generation identity `generationId == anchor.generation` via the §6
  generation mapping; exact equality, no coercion; provenance references
  (setup observation hashes + submission response hashes + entity/
  relationship ids + fencing facts); missing/contradictory evidence per §11.
- **INV-INV-1 (`resourceConservation` → SKU/resource subject).** Resource
  identity field `sku`; frozen selection intent
  `runScope.subjects["INV-INV-1"]` (e.g. `["SKU-001"]`); observed anchor per
  §5 (the same setup response that baselined the SKU — the setup call is what
  creates the `(scope, sku, generation, initialAvailableUnits)` fact, so one
  anchor binds both kinds); baseline/remaining/consumption/summary entities
  partitioned by exact `(sku, verificationScopeId, generationId)` equality
  against the anchor; same missing/conflict behavior. No hardcoded
  SKU/checkout logic in platform code: every role/field name above is read
  from the frozen instance params and the frozen evidence policy.

A mechanism binding only the intent but not the SKU would leave the
`INV-INV-1` F-3 residue in place; the shared setup anchor binds both.

### 10. Generation rules

- `snapshotContentHash` covers frozen intent only (including the new
  `runScopeBinding` block); observed generations never enter it (existing
  canonicalization; random runIds never enter it).
- The observed generation is recorded per analysis in evaluation details and
  the persisted eligibility proof (§13); the report reads it from there —
  the anchor is derived truth materialized once by analysis, not re-derived
  per consumer.
- Same scope string + different generation ⇒ different partitions, never
  conflated (§22 cases 16–17). Conflicting observed generations for one anchor
  ⇒ `EVIDENCE_CONFLICT` ⇒ NOT_EVALUABLE path (§5 matrix), unless a
  higher-precedence execution/integrity failure already decided exit 3.
- Existing snapshot rows are untouched; legacy snapshots without
  `runScopeBinding` evaluate under the labeled legacy-compat mode (§17).

### 11. Exact step and origin authority (P-05 repair)

The anchor procedure is frozen as ten ordered checks. Failure at any check
fails closed to `ANCHOR_UNPROVEN` (exit 2 path) or `EVIDENCE_CONFLICT`
(exit 2 path) as stated — never to a guessed anchor:

1. Locate `setupStep` name in the frozen snapshot `steps` array.
2. Require exactly one matching step name (uniqueness is enforced by engine
   validation; a second match is a validation invariant violation, never
   resolved by position).
3. Resolve the frozen ordinal `i` (0-based position in the snapshot array).
4. Load `ExperimentStepRun` by `(runId, sequence = i)` (the existing unique
   key — never by name search across runs).
5. Verify `stepRun.name === setupStep` (exact equality) AND stepRun terminal
   state `SUCCEEDED` AND valid owner/fencing provenance (`leaseOwnerId IS NOT
   NULL`: a fenced generation owned the terminal write).
6. Join `StepInvocation` rows by authoritative ids and run ownership:
   `(stepRunId)` with `(runId)` consistency (invocations belong to this run's
   stepRun; rows from other runs never join).
7. Join `RawObservation` rows by `(runId, stepRunId, invocationId)` with
   writer attribution `(writerOwnerId, writerFencingToken)`; the
   authoritative candidate set is the terminal-owner generation per §5.
8. Require an accepted `http_response_observed` row: origin `OBSERVED`, 2xx
   status, non-truncated (row and envelope), body parses as a JSON object
   with a string `scopeField` value and a non-negative safe-integer
   `generationField` value.
9. Parse ONLY the hashed/redacted `RawObservation` response payload
   according to its accepted envelope. The `StepInvocation.responseBody`
   column is NEVER an alternative unhashed source of business authority.
10. Confirm the response is associated with the frozen registered target
    origin and the accepted executor destination path through DURABLE
    JOINS, not a nonexistent per-observation origin field: the observation's
    `(runId, stepRunId, invocationId)` joins to a stepRun of THIS run, whose
    `(runId)` joins to the run, whose frozen snapshot carries exactly one
    `target.origin`; and the accepted executor resolves every invocation
    destination to that same frozen origin + a validated relative path
    through the shared destination seam (no per-invocation origin selection
    exists). The `RawObservation` row has no network-origin column (its
    `origin` column is the `EvidenceOrigin` enum); origin authority is
    established structurally by these joins and the executor's frozen-
    destination validation. No arbitrary response from another step,
    another run, or another origin may anchor the run.

### 12. Security bounds and secret safety (P-04 repair)

The phrases "bounded string", "bounded list", and "well-formed name" used in
the first proposal are withdrawn. The exact limits are frozen below. Every
"existing" value is already enforced in the cited code; every "new" value is
explicitly marked with its justification.

| Field | Exact bound | Grammar / rule | Source |
|---|---|---|---|
| `runScope.version` | exact match | `"run-scope/v1"`; unknown refused | new (this ADR) |
| `setupStep` | ≤63 chars | `^[a-z][a-z0-9-]{0,62}$`; exactly one frozen-step match; `repeat: 1`, `concurrency: 1`, `retryPolicy: "NONE"` | existing step-name rule (`validate.ts`) + new anchor rules |
| `declaredScope` | 1..120 chars | `^[a-z][a-z0-9-]{0,119}$` | 120 = existing name precedent (displayName/definition/scenario); grammar new, justified by interpolation exclusion |
| `scopeField`, `generationField` | ≤64 chars | existing `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; not in frozen `sensitiveFields`; not in `EXECUTOR_CREDENTIAL_REFS` | existing `FIELD_NAME_PATTERN` + `MANIFEST_LIMITS.maxIdentifierChars`; exclusions new (ADR-0023 redaction rule, ADR-0025 lesson) |
| subject-map key | ≤80 chars | ⊆ frozen generic binding keys | existing registry `MALFORMED_KEY` + `invariantKey VarChar(80)` |
| subjects per invariant key | ≤32 | distinct strings | new, justified: platform bounded-collection precedent (`maxFieldsPerIdentityNode`/`maxHeaders`/`MAX_EQUIVALENCE_FIELDS` = 32) |
| subject identity | 1..200 chars | printable non-control; MUST NOT contain `$ { } \` `` ` `` CR LF NUL; MUST NOT contain `[Redacted]` | 200 = existing `subjectKey VarChar(200)`; exclusions new, justified by interpolation/credential-syntax exclusion |
| total subjects (all keys) | ≤64 | — | new, justified: `MANIFEST_LIMITS` 64-family precedent |
| total serialized `runScope` | ≤16_000 bytes canonical JSON | — | new, justified: explicit sub-budget of `SCENARIO_MAX_SERIALIZED_BYTES = 64_000` (worst-case 64×200 + structure fits with margin) |

**Secret safety (frozen).**

- Allowed identifier grammar is exactly the table above; anything else is a
  named definition-time rejection. Unknown `runScope` fields are rejected
  (`RUN_SCOPE_UNKNOWN_FIELD`); oversized values are rejected (the length
  rules); no runtime code expressions exist anywhere in `runScope`
  (values are compared with `===`, never resolved, interpolated, or executed).
- Credential references are forbidden in subject identity and scope strings:
  any `${…}` (including `${credential.…}`, `${signature}`, `${steps.…}`),
  `{…}`, or `{{…}}` form in raw or percent-decoded shape is rejected at
  freeze time (`RUN_SCOPE_INTERPOLATION`, mirroring the ADR-0022 §3
  inspection-path prohibition). A declared value can therefore never become a
  credential-resolution seam.
- Sensitive field names are forbidden as anchor fields (§3 rule 4): the
  anchor must never be bound to a field the redaction registry will mask,
  checked declaration-time against the frozen evidence policy's
  `sensitiveFields`.
- Report redaction: the eligibility/coverage report blocks serialize only
  identifier values already stored as business evidence under
  redaction-before-persistence; any value observed as `[Redacted]` is
  reported as its named gap kind, never the underlying value (which was
  never persisted). Logs carry bounded secret-free reason strings only
  (existing `maxErrorMessageLength = 500` discipline; report `reason` ≤500
  per the existing `InvariantEvaluation.reason` column).
- Honest limitation (stated, not hidden): no grammar or regex can detect
  every possible secret — a syntactically valid arbitrary string may still
  BE secret. The design does not claim otherwise. Protection is structural,
  not syntactic: `runScope` values are comparison-only identifiers that can
  never enter a credential-resolution, header-substitution, URL-interpolation,
  or execution path; known credential-value interpolation syntax is rejected
  at the boundary above; and redaction-before-persistence still applies to
  every observed value before it becomes evidence.

### 13. Deterministic current evaluations (P-06 repair — selected model B)

**The defect.** `EvaluationBatch` is unique per
`(runId, invariantKey, evaluatorVersion)` and `InvariantEvaluation` per
`(runId, invariantKey, evaluatorVersion, subjectKey, evidenceSetHash)`:
multiple rows with DIFFERENT `evidenceSetHash` coexist for the SAME subject
on the SAME batch. The first proposal selected current truth by
`(completedAt, createdAt, id)` ordering. That selection is NOT authoritative:
timestamps order writes, not truth; UUIDs order nothing; row order is not a
correctness argument (evidence-model §6, ADR-0017). **The timestamp/UUID
ordering rule is withdrawn in full and MUST NOT be used for current-truth
selection anywhere** — not in analysis, not in `loadReportEvaluations`, not
in the classifier, not in any future query. Any surviving use is a defect
against this ADR.

**Options compared (frozen).**

- **A. Deterministic evidence-identity equality in the report path.**
  Rejected as the selection mechanism: comparing each evaluation's evidence
  fingerprint against the current accepted evidence snapshot inside the
  report emitter is business-evaluation recomputation in the report layer —
  a second truth engine by another name (§18 forbids it). Its equality
  predicate survives only as analysis-internal derivation logic (below).
- **B. Explicit persisted current-evaluation reference tied to a verified
  evidence-chain watermark. SELECTED.** One deterministic, analysis-owned,
  transactionally published pointer per eligible
  `(runId, invariantKey, evaluatorVersion, subjectKey)` names the current
  `InvariantEvaluation` row. Report and classifier read pointers; they never
  choose rows.
- **C. Additive analysis-generation records with deterministic
  current-generation identity and explicit supersession.** Rejected as
  heavier than needed: generation/supersession semantics are already carried
  by the pointer's `analysisGeneration` counter plus the append-only
  evaluation history — a separate generation-record layer adds surface
  without adding authority.

**Authoritative current evidence-set identity.** The pointer's
`evidenceHeadHash` is the SHA-256 over the canonical JSON of exactly:
`(runId, invariantKey, kind, evaluatorVersion, registryVersion,
eligibilityVersion, snapshotContentHash, targetId, subjectKey, anchorTuple,
sorted captureHashes, sorted proofEventIds, sorted proofRelationshipIds,
verdict, gap, failureMechanism)` — i.e. the existing `genericEvidenceSetHash`
discipline (which includes `kind`, `snapshotContentHash`, and `targetId`)
extended with the anchor tuple and `eligibilityVersion`. Same semantic evidence ⇒ same hash; new
truth-relevant evidence ⇒ new hash. The hash-algorithm change is precisely
why gated rows require the new gated evaluator version (§14 of this
section): changed hash semantics under an indistinguishable old version are
forbidden.

**Conceptual persistence (honest additive migration — designed here, NOT
implemented here).** Two records in the analysis schema; sizes mirror the
existing columns they reference:

1. `current_evaluation_pointer` — `(runId uuid, invariantKey VarChar(80),
   evaluatorVersion VarChar(32), subjectKey VarChar(200),
   currentEvaluationId uuid FK → InvariantEvaluation,
   evidenceHeadHash VarChar(64), eligibilityVersion VarChar(32),
   analysisGeneration bigint, integrityHeadHash VarChar(64),
   integrityObservationCount int, provenanceRevision bigint,
   derivationGeneration bigint)`; unique
   `(runId, invariantKey, evaluatorVersion, subjectKey)`; FKs to
   `ExperimentRun`, `InvariantEvaluation`, `EvaluationBatch`. A pointer is
   derived materialized selection — coordination metadata like the accepted
   `EvidenceIntegrityHead` — never a second invariant truth engine: verdicts
   live ONLY in `InvariantEvaluation` rows.
2. `run_eligibility_proof` — one row per `(runId, invariantKey,
   evaluatorVersion)`: a shared explicit `analysisGeneration bigint` (the
   SAME value as every pointer published by that pass — agreement is a
   report-time consistency check, §14 rule 5) and the publication watermark
   `(integrityHeadHash VarChar(64), integrityObservationCount int,
   provenanceRevision bigint, derivationGeneration bigint)`; a
   `mode` field (`"strict-coverage/v1"` for gated runs,
   `"legacy-compat"` for runs whose snapshot carries no `runScopeBinding`);
   for gated runs the anchor tuple + setup observation hashes + fencing
   facts; declared/eligible/missing subject sets; unexpected
   same-scope identities (class B, named); foreign inventory counts per
   `(scope, generation)`; evidence gaps (named kinds); `coverageMode =
   "strict-coverage/v1"`; the coverage limitation statement; the
   authoritative evaluator version marker for the key. For `legacy-compat`
   rows the anchor/declared/coverage fields are absent and the row carries
   the as-observed subject domain instead (legacy snapshots have no
   declared intent to prove coverage against — the row states that
   limitation explicitly). The report's `eligibilitySummary` + `coverage`
   blocks serialize THIS row — persisted analysis results, never rederived
   business truth.

**Frozen pointer semantics.**

- Unique key + transactional publication + stale-pointer detection +
  concurrent writer handling: publication runs in ONE transaction that FIRST
  takes the per-run transaction-scoped advisory lock
  (`pg_advisory_xact_lock(hashtext(runId::text))`) and THEN validates the
  pass's captured COMPOSITE analysis watermark `W0` against the current
  truth-input state in every component (the frozen
  analysis-side contract below; acquired-first, READ COMMITTED, so no
  statement can be served from a snapshot predating the lock grant). A
  publication is a NO-OP (idempotent re-publication) ONLY when the
  COMPLETE composite watermark `W0` matches what the stored proof row and
  every governed pointer already carry — chain identity AND provenance
  revision AND derivation generation — with the version and generation
  preconditions satisfied. A matching evaluation fingerprint
  (`evidenceHeadHash`) is NEVER by itself a no-op: it is an
  evaluation-identity fact, not authority over the truth-input state (a
  confirmed evaluation at a newer `W` still re-publishes proof and pointers;
  see the confirmed-evaluation rule below). Any other state ⇒ the pass may
  advance ONLY when (a) the locked current composite `Wcurrent` EQUALS its
  captured `W0` — i.e. the pass analyzes exactly the state it is about to
  publish — and (b) `W0` is the append-only descendant of the stored
  pointer/proof watermark (chain extension only ever grows; `P` and `D` are
  monotone and may only advance), or the pass is an explicitly flagged
  post-invalidation rebuild (B-2 tombstone exclusion) authorized by that rule. Any other case ⇒ DO NOT PUBLISH: the slot's stored
  pointer/watermark selection is left untouched (never advanced to stale
  results) and the pass runs the bounded re-analysis over a FRESHLY captured
  head; if that bound is exhausted, a staleness note is recorded as
  coordination metadata (`CURRENT_POINTER_STALE`) while the stored selection
  itself is never advanced, and the run fails closed through the report
  rules (§14), never a stale PASS. Concurrent passes serialize on the lock; the
  loser re-reads and re-validates its OWN captured `W0` under the same rule,
  so a publish of stale results can never overwrite a committed newer
  generation. Last-writer-wins by timing is forbidden; generation comparison
  uses the `analysisGeneration` counter only.
- Atomic publication: a pass publishes all of a run's pointers and the
  eligibility proof rows in one transaction, all carrying one shared
  `analysisGeneration`; a partially published pass is invisible (report
  reads only fully published generations). Report-side, a proof row whose
  `analysisGeneration` does not agree with every pointer it governs is an
  eligibility inconsistency (exit 2), never a mixed-generation read (§14
  rule 5; the finalization authorization below checks agreement under the
  per-run append lock).
- Missing pointer for a declared subject with completed analysis ⇒ missing
  verdict ⇒ NOT_EVALUABLE path (exit 2), never PASS.
- Stale pointer at report time: the report's consistency check compares each
  pointer's `(integrityHeadHash, integrityObservationCount)` watermark — AND
  the governing proof row's watermark — against the CURRENT
  `EvidenceIntegrityHead` (cheap metadata comparison — a consistency check,
  not business recomputation). Evidence advanced since publication (any
  proof/pointer watermark that no longer names the locked head) ⇒ bounded
  re-analysis is triggered; every pointer is then RE-PUBLISHED at the new
  truth-input state under the §13 analysis-side contract, carrying the new
  `analysisGeneration` and the new COMPOSITE watermark — a confirmed result
  reuses its historical `InvariantEvaluation` row, never its old pointer
  watermark. There is no path that leaves any component of a superseded
  watermark in place while claiming a successful newer publication. If pointers remain stale past the bound ⇒
  fail-closed exit 2 (eligibility uncertainty with completed execution — NOT
  exit 3; the execution truth is intact, the business domain proof is not).
  The check is NOT itself the decision's linearization point; the decision is
  authorized under the frozen finalization contract below (Boundary B), which
  makes the freshness check and the decision atomic with respect to evidence
  appends.
- No mutable business-verdict rewrite, ever: evaluation rows are logically
  append-only; pointers advance by naming newer rows; superseded rows remain
  as history with their generation intact.
- Legacy domains use the SAME pointer mechanism: for snapshots without
  `runScopeBinding`, analysis publishes pointers over the as-observed subject
  domain at the row's evaluator version (no anchor, no declared set, no
  coverage anomalies — there is no declared intent to prove coverage
  against) with a `legacy-compat` proof row. Pointer selection is therefore
  deterministic for every run; only the DOMAIN differs by mode. verdict rows
  themselves are untouched, so historical verdicts stand while the per-key
  collapse is fixed everywhere (see §14 rule 3).
- Analysis completion state: the `EvaluationBatch` (`completedAt`,
  `evaluationCount`) still marks pass completion; pointers reference only
  rows of completed batches. Analysis infrastructure failure (timeout/crash
  preventing completion) is EXECUTION_FAILURE (exit 3, ADR-0019 rule 1);
  completed analysis with stale/unresolvable pointers is NOT_EVALUABLE
  (exit 2).

**Evaluator version vs registry version (P-08 version contract, frozen).**

- `registryVersion = "business-invariant/v1"`: the definition vocabulary
  (params shapes). Source: `BUSINESS_INVARIANT_REGISTRY_VERSION`.
- `evaluatorVersion`: the semantic version of the actual evaluator +
  evidence-hash algorithm. Source: the evaluator implementation constant.
  The pre-gating constant `'v1'` is frozen history: rows stored under
  `'v1'` lack anchor/eligibility provenance and are NEVER current truth
  for gated runs. The first eligibility-gated evaluator version is
  `"generic-invariant/v1"` (evaluator identity + integer semantic version;
  successors increment the integer: `/v2`, …). Gated details ALWAYS carry
  the triple `(registryVersion, evaluatorVersion, eligibilityVersion =
  "run-eligibility/v1")`.
- The evaluator version is bound per run WITHOUT rewriting historical
  snapshots: snapshots carry `registryVersion` + `runScopeBinding` (intent),
  never evaluator versions. Analysis records the run's authoritative
  evaluator version per key in the eligibility proof row at publication;
  report and classifier read evaluations ONLY at that version via pointers.
  A new evaluator release produces new-version rows; pointers advance per
  version; cross-version verdict blends in comparison views are refused
  (extends the ADR-0019 §4 refusal: same `snapshotContentHash` AND same
  authoritative evaluator version AND same eligibility version, else refused
  with reason). When more than one eligibility-gated version coexists for
  one run (an evaluator upgrade after a first analysis), the run's
  authoritative version per key is the version of the LATEST analysis
  publication as ordered by the shared `analysisGeneration` counter — never
  timestamps, row order, or UUIDs. The authorization transaction reads proof
  and pointers ONLY for that single version; if one coherent authoritative
  version cannot be established (proof/pointer version mismatch or
  generation disagreement), the outcome is an eligibility inconsistency ⇒
  exit 2, never a cross-version blend.
- Historical compatibility: old rows (legacy keys, pre-gating `'v1'` generic
  rows) are never rewritten, never re-hashed, never re-pointed. Replay
  comparison across evaluator versions is refused, not coerced.
  Legacy-compat re-analysis preserves the PRE-GATING hash discipline under
  the pre-gating `'v1'` version for snapshots without `runScopeBinding`
  (the anchor tuple and `eligibilityVersion` never enter a legacy hash), so
  changed gated hash semantics can never hide under an indistinguishable old
  version, and legacy re-analysis converges idempotently on the historical
  hash inputs. On a GATED run, pre-gating `'v1'` rows are neither current
  truth nor foreign-row anomalies: the foreign-row rule (§15) is defined at
  the run's authoritative gated version only; `'v1'` rows remain labeled
  history, queryable and never selected.

**Analysis watermark capture and atomic publication (Boundary A — B-1 analysis-side repair).**

The finalization contract below fixes when a REPORT decision is authorized.
That is not sufficient alone: the design must also fix when an ANALYSIS pass
captures the truth-input state its results belong to (the B-3 composite
watermark immediately below extends that state beyond the raw chain). Without it, an append
committing inside an analysis pass — after the pass read evidence, before
its pointers were published — is excluded from a decision whose pointer
watermark is later published as if it covered that evidence: the same defect
class as B-1, one boundary earlier. Both boundaries are frozen here and are
load-bearing together; neither substitutes for the other, and no number of
extra reads substitutes for either.

- **H0 — the analysis watermark (frozen).** BEFORE any business-evidence
  read belonging to an analysis pass (subject discovery, eligibility
  derivation, evaluator inputs, completeness/proof derivation, findings),
  the pass captures the COMPOSITE truth-input watermark
  `W0 = (C0, P0, D0)` frozen in the B-3 subsection below. `C0` is the
  authoritative per-run `EvidenceIntegrityHead` identity
  `(headContentHash, observationCount, lastChainIndex)` — or, for a run with
  no observations at all, the empty-chain marker (count 0, no head hash, no
  head row; `lastChainIndex` then has the empty-chain meaning and no index
  value is compared); `P0` is the run's provenance revision and `D0` its
  derivation generation. W0 is read as ONE identity (see the two-stage
  capture in the B-3 subsection), never assembled from reads taken at
  different times. The capture is a bounded indexed read set; it does not
  verify the chain.
- **Snapshot discipline (frozen; why "read H0 first" is not enough).** The
  pass's evidence reads must not be served from a database snapshot older
  than the H0 capture. A READ COMMITTED statement always takes a fresh
  snapshot, so H0-then-read is sound at READ COMMITTED; a REPEATABLE READ or
  SERIALIZABLE transaction whose snapshot was established BEFORE the H0 read
  is FORBIDDEN for the analysis pass (it could serve evidence predating H0 —
  an old snapshot that silently excludes the very appends H0 attests to).
  Analysis evidence reads therefore run at READ COMMITTED (the PostgreSQL
  default, the same isolation the append path uses), each statement seeing a
  snapshot no older than the H0 capture. If a future implementation wants a
  stable analysis snapshot, it must take that snapshot AT or AFTER the H0
  read, and H0 must still be re-read and re-compared under the publication
  lock. This design introduces no transaction-isolation override anywhere.
- **Derived results belong to H0 ONLY (frozen).** The pass's evaluations,
  eligibility derivation, completeness proofs, current-evaluation pointers,
  and findings are results ABOUT H0. The pass MUST NEVER adopt whatever head
  happens to be current at publication time as its analysis watermark, and
  MUST NEVER publish H0-derived results under a watermark naming a head it
  did not analyze. "The evidence did not change meaningfully" is not a
  permitted inference: a changed head invalidates the pass's watermark claim
  regardless of whether the new observation looks unrelated.
- **Atomic publication validation (frozen; under the shared per-run lock).**
  Publication of the eligibility proof rows and the current-evaluation
  pointers runs in ONE transaction that acquires the SAME per-run
  transaction-scoped advisory lock the append primitive uses —
  `pg_advisory_xact_lock(hashtext(runId::text))` — acquired FIRST, before
  the authoritative current-head read, at READ COMMITTED. Under the lock:
  1. load the current composite watermark `Wcurrent = (Ccurrent, Pcurrent,
     Dcurrent)` (or confirm the empty chain);
  2. require `Wcurrent` to EXACTLY equal the pass's captured `W0` in EVERY
     component — a chain that advanced, was replaced, or differs in any
     single field (`headContentHash`, `observationCount`, `lastChainIndex`),
     and equally any provenance-revision or derivation-generation advance
     (with the chain byte-identical), is a mismatch;
  3. require the pass's evidence and eligibility derivation to be bound to
     H0 (its own frozen binding; this transaction never re-derives the
     derivation from `Hcurrent`);
  4. check the required run/version/generation preconditions: run terminal
     state, the single authoritative evaluator version per key, the
     `(registryVersion, evaluatorVersion, eligibilityVersion)` triple, and —
     when re-publishing — that H0 is the append-only descendant of the
     currently stored pointer/proof watermark (or that the pass is the
     explicitly flagged post-invalidation rebuild, B-2 rule);
  5. atomically write the eligibility proof row AND every current-evaluation
     pointer for ONE coherent analysis generation: a single shared
     `analysisGeneration`, the same version triple, and the SAME `W0`
     identity (all components: `headContentHash`, `observationCount`,
     `lastChainIndex`, `provenanceRevision`, `derivationGeneration`) as the
     watermark on the proof row and on every pointer;
  6. commit (releasing the lock).
  Because every append takes the same lock, no append can commit between the
  `Hcurrent` read and the commit: the validated state is exactly the state
  still visible when the publication commits. A publication without the
  lock, with the lock acquired after the lock-scoped head read, at an
  isolation level whose snapshot predates the lock, or that acquires a
  second lock while holding it, is a contract violation (one lock only ⇒ no
  deadlock cycle with the append path).
- **If `Wcurrent` ≠ `W0` (frozen): DO NOT PUBLISH.** The attempted publication
  is discarded in full — no proof row, no pointer, no generation advance, no
  partial write (the aborted transaction wrote nothing). The pass performs a
  bounded re-analysis beginning with a FRESH two-stage `W0` capture (the
  B-3 capture procedure plus steps 1–6 repeated against the new state); a
  mismatch confined to `P`/`D` with a byte-identical chain triggers EXACTLY
  the same rejection — the provenance and derivation components are
  load-bearing, never advisory. The bound is the frozen implementation constant
  below; EXHAUSTION fails closed under ADR-0019 — exit 2 when the run's
  execution truth is intact and the business-domain proof cannot be
  established, exit 3 when verification cannot be performed (database
  unavailable, lock/statement timeout, integrity unverifiable). Forbidden
  without exception: a stale PASS; a partial pointer publication;
  last-writer-wins by timing; and reinterpreting changed evidence as
  unchanged without a new complete analysis over the new head.
- **Bounded re-analysis / retry and terminal staleness (frozen).** "Bounded"
  means an implementation constant N (single-digit; proposed default 3) of
  COMPLETE cycles, each beginning with a fresh head read and running the
  full verification + analysis for that head; each cycle is itself
  time-bounded. A cycle that ends in a mismatch consumes one unit and starts
  the next only with a fresh capture. TERMINAL staleness classification is
  reached only when the bound is exhausted after the last complete cycle;
  the run is then classified exactly once, fail-closed, by §14 rule 5 (a
  business-domain staleness with intact execution truth ⇒ exit 2) or by
  rules 1–2 / "verification could not be performed" (⇒ exit 3). Repetition
  beyond the bound with no new analysis is forbidden — it would be an
  unbounded chase of a moving head, and it is never a path to exit 0.
- **Confirmed evaluation rows — reuse without stale watermarks (frozen;
  resolves the pointer-liveness contradiction).** Suppose an earlier composite
  watermark `W0` has current PASS evaluation row E, and new truth-input state
  advances the watermark to `W1` — where an "advance" is ANY component: a
  chain append, a provenance-revision increase, or a derivation-generation
  increase. The pass re-analyzes `W1` and the newly derived semantic
  `evidenceSetHash` equals E's. Reuse of the historical row E — it is never
  rewritten, never re-hashed, and its `evidenceSetHash` NEVER changes — is
  PERMITTED, but only after the pass rechecks every relevant evaluator
  input, the eligibility derivation, completeness, and the scope/coverage
  conditions against H1 under the publication contract above; reuse is NEVER
  justified by E's previous verdict having been PASS. When reuse is valid,
  the pass MUST publish, atomically in one transaction:
  - a NEW `analysisGeneration` (strictly greater than the stored one);
  - an eligibility proof row certified for `W1` (watermark = EVERY `W1`
    component, chain plus provenance revision plus derivation generation);
  - current pointers carrying `W1`'s watermark (all components);
  - the confirmed evaluation identity E (`currentEvaluationId` = E).
  Leaving an old `W0` watermark in place while claiming a successful `W1`
  publication is FORBIDDEN: an old watermark component on any pointer or
  proof row is stale with respect to the locked truth-input state and is an
  eligibility inconsistency (exit 2) at report time, never a PASS. A confirmed result
  therefore advances `analysisGeneration` and the watermark exactly like a
  changed result; only the referenced verdict row may be the same row. This
  corrects the ambiguity the previous revision left open: the phrase
  "pointers that confirm identical heads stay" is WITHDRAWN — a pointer
  never "stays" across an evidence advance; it is re-published at the new
  head, or the run fails closed.
- **The two race boundaries (frozen; both required).**
  - **BOUNDARY A — ANALYSIS PUBLICATION.** The analysis result is tied to
    the composite `W0` captured BEFORE its evidence reads. A concurrent
    append — or ANY protocol-conformant truth-bearing provenance or
    derivation write, which advances `P`/`D` — that moves `W0` to `W1` before
    publication prevents `W0` publication, even if the new write appears
    unrelated to the result. Publication happens only under the shared
    per-run lock with `Wcurrent == W0` in every component (steps 1–6). No
    stale PASS; no partial pointer publication; no last-writer-wins; no
    reinterpretation of changed evidence, provenance, or projection as
    unchanged without a new complete analysis.
  - **BOUNDARY B — REPORT AUTHORIZATION.** The report authorizes ONE
    verified truth-input state under the SAME per-run lock; its current
    proof row and every pointer it governs must match that state in every
    component. An append, provenance write, or derivation commit that lands
    before authorization invalidates a stale proof/pointer (checks 4–6
    below) and forces bounded re-analysis; one that lands after
    authorization belongs to a newer state, and the report certifies ONLY
    its explicitly identified as-of state. No finite number of extra reads
    substitutes for either boundary.
- **Verified-prefix binding (frozen).** `verifyRunEvidenceChain` is O(N) and
  runs OUTSIDE the lock. An out-of-lock verification NEVER authorizes a
  decision by itself — merely having matched an unchecked head value is not
  evidence of anything. The authorization transaction re-reads the locked
  head identity and requires it to EXACTLY equal the identity the
  verification covered `(lastChainIndex, headContentHash,
  observationCount)`; a verification whose identity cannot be reproduced
  under the lock is redone (bounded) or the run fails closed. Because the
  prefix is content-addressed and logically append-only, verification of one
  identity certifies exactly that locked prefix and no other. The verifier's
  recorded `lastVerified*` metadata is coordination metadata — never a
  decision input and never a substitute for this binding.
- **Relative order of the two boundaries (frozen).** In EVERY cycle of a
  report command, any triggered Boundary A publication completes and commits
  BEFORE that cycle's Boundary B authorization acquires the lock: stale
  proof/pointer detection ABORTS the authorization transaction first (it
  writes nothing and holds no decision), re-analysis publishes under
  Boundary A, and then a FRESH authorization is attempted. The authorization
  therefore always reads proof/pointers a committed publication produced; the reverse order — authorizing against a generation that is about to
    be superseded — is a contract violation. Both boundaries use the same
    frozen bound constant, so the number of cycles in one command is finite.

**Composite run truth-input watermark (B-3 repair — the analysis watermark's
coverage).**

*Why this exists.* The Boundary A contract above validated only the
raw-evidence chain. The pass does not derive truth from the chain alone: anchor
authority (§5), stale-generation immateriality (§5), step/origin authority
(§11), and the eligibility domain (§4) additionally read run-scoped execution
provenance — `control.experiment_step_run`, `control.step_invocation`,
`control.stale_writer_event` — which is written OUTSIDE the evidence chain and
(verified in the tree) outside the per-run advisory lock: `recordInvocation` is
a plain `stepInvocation.create` whose own contract states "The write itself is
NOT fenced", and the reconciler/recovery sweeps update step and run rows with
no advisory lock at all. A `step_invocation` row appended after the pass's read
therefore changes anchor truth while the chain head is byte-identical, and a
chain-only gate cannot see it. The same is true of a derived projection
committed by another process after the pass's own derivation. This subsection
freezes the coverage extension that closes the class: every truth-bearing
non-chain write is serialized on the SAME per-run lock and advances a durable
monotonic revision in the SAME transaction, so the analysis watermark can name
the whole truth-input state and publication can reject any change to it.

**Naming (frozen; removes the old ambiguity).** `C` is the chain/evidence
component. Every earlier occurrence of `H0`/`Hcurrent`/`H1` in this ADR denotes
that component and is NEVER, alone, "the analysis watermark": wherever this ADR
requires the analysis watermark to be captured, published, or validated, the
COMPOSITE below is required. `W`, not any single component, is the truth-input
watermark.

**The composite watermark (frozen).** `W = (C, P, D)`:

a. **`C` — the raw-evidence chain identity** — unchanged: gap-free, hash-pinned,
   advanced only by `appendChainObservation` under the per-run lock.
   `C = (headContentHash, observationCount, lastChainIndex)`, or the empty-chain
   marker (count 0, no head hash, no head row).

b. **`P` — the run's provenance revision** — a durable monotone `bigint`,
   initially 0, advanced by exactly +1 in the SAME transaction as ANY of these
   run-scoped mutations: `experiment_step_run` INSERT/UPDATE (claim, executing
   marker, dispatch marker, lease fields, state/terminal/outcome fields);
   `step_invocation` INSERT; `stale_writer_event` INSERT; `experiment_run`
   state/terminal/failure/cancel-request writes. Truth-bearing provenance state
   and `P` move together or not at all.

c. **`D` — the run's derivation generation** — a durable monotone `bigint`,
   initially 0, advanced by exactly +1 in the SAME transaction as every
   committed DERIVED-PROJECTION commit for the run (derived-projection rule
   below).

`W` is coordination metadata about WHAT HAS BEEN WRITTEN — never business truth,
never a verdict, never a substitute for evidence (R-18: it is a revision
counter, not a claim of tamper-proofness or physical immutability).

**Writer protocol (frozen — the write side of the contract).** Every writer of
a truth-bearing non-chain row of a run MUST, in ONE PostgreSQL transaction:
(1) acquire the SAME per-run transaction-scoped advisory lock the append
primitive uses — `SELECT pg_advisory_xact_lock(hashtext(runId::text))`;
(2) perform the authoritative insert/update; (3) advance the corresponding
component (`P = P + 1`, or `D = D + 1` for a derived commit) on the run's
truth-input head row (upsert; initial 0); (4) commit. Non-negotiables:

- Row write and revision advance are NEVER separate transactions. A rolled-back
  write never advances the revision; a committed write always does.
- The lock covers ONLY the DB-local write. It is NEVER held across the physical
  HTTP request: the executor's send boundary stays outside the lock, and
  `recordInvocation` still runs after the send, exactly as today.
- One lock only; no second lock is acquired while holding it (extends the
  existing no-deadlock-cycle rule to every provenance writer).
- This protocol does NOT fence the write (R-10/ADR-0009 unchanged): a stale
  generation still records honestly, and its row is still preserved and
  attributed. What changes is that the row now also invalidates any analysis
  that did not observe it.
- Multi-run atomicity is NOT supported in v1: a sweep or operation touching
  several runs MUST commit per run, one run's lock at a time, in a deterministic
  order (ascending `runId`); a transaction that would need two run locks at once
  fails closed rather than acquiring locks in a second order.
- If the revision cannot be advanced, the transaction aborts: the row is not
  written and the writer reports an infrastructure failure (for a decision,
  EXECUTION_FAILURE / exit 3 semantics under ADR-0019 rule 1 — verification
  could not be performed; execution truth is unchanged).

**Compatibility default (frozen).** An absent head row means `(P, D) = (0, 0)`.
This is sound because the revision proves the ABSENCE OF WRITES SINCE THE
CAPTURE, not the completeness of history: rows written before the protocol
existed are already durable before any capture, and any LATER write necessarily
passes through the protocol. No backfill is required and no historical row is
rewritten.

**Two-stage Boundary A capture (frozen).** The pass's own derivation is part of
establishing the state it analyzes, so the capture is two-stage and no read that
belongs to the analysis precedes stage 1:

1. **Stage 1 (before-read).** Under the per-run lock, in one short DB-only
   transaction, capture `C1` and `P1`. This extends the previously frozen
   before-read capture to the provenance component.
2. **Derivation completeness.** The pass runs the run's canonical derivation
   under the writer protocol (each derived commit advances `D`). The projection
   for `(C1, P1)` is complete only when the canonical derivation for it has
   committed.
3. **Stage 2 (final capture).** Under the lock, re-read `W0 = (C0, P0, D0)`. If
   `C0 ≠ C1` or `P0 ≠ P1`, the pass's own derivation raced a newer truth-input
   state and the pass restarts under the frozen bounded policy with a fresh
   stage-1 capture — it never reinterprets the difference. Otherwise `W0` IS the
   analysis watermark: every business read that follows (subject discovery,
   eligibility derivation, evaluator inputs, completeness/proof derivation,
   findings) happens after it, and every result is a result ABOUT `W0`.
4. Snapshot discipline is unchanged and extended: no read may be served from a
   database snapshot older than `W0`, and the REPEATABLE READ / SERIALIZABLE
   prohibition covers the provenance and derivation head reads as well. The
   publication-time state is NEVER adopted as the watermark.

**Publication validation (frozen).** The atomic publication rules above stand,
with every `W` component substituted for the chain-only comparison: under the
lock, read `Wcurrent`; require `Wcurrent == W0` in EVERY component (a chain
byte-identical to `C0` with `Pcurrent > P0` or `Dcurrent > D0` is a mismatch);
then write one proof row and every pointer carrying the same `W0` and one
`analysisGeneration`; commit. A mismatch publishes nothing.

**Derived projection — completeness, not optimism (frozen).**
`evidence.normalized_event`, `evidence.causal_relationship`, derivation
diagnostics and invalidation tombstones, and the forensic/finding projections
are DETERMINISTIC functions of (chain prefix + frozen policy + normalizer
versions), but the SET of derivation commits that have run is NOT derivable from
the chain — so a partially built projection must never be treated as complete:

- a derived commit writes under the writer protocol and advances `D`;
- a derivation that cannot commit atomically with `D` MUST record an explicit
  incompleteness marker that the analysis treats as fail-closed (never as
  "complete"); a projection observed while marked incomplete is a gap
  (NOT_EVALUABLE path), never a PASS;
- the pass's own derivation (stage 2 above) is the completeness proof for
  `(C1, P1)`;
- any foreign derived commit between stage 2 and publication advances `D` and
  therefore blocks publication.

Raw observations never advance `D`, and derived rows never advance `C`: the
chain stays the honest record of what was OBSERVED and the derivation
generation stays the honest record of what has been DERIVED.

**Epistemic limit of a watermark (frozen; honest boundary, R-02/R-07).** A
watermark is a statement about DURABLE ROWS. It detects (A) *a recorded
provenance write*. It can NEVER prove (B) *that a physically sent request was
not recorded*: the capture path writes the invocation row only AFTER the
physical send, so an unrecorded send may exist. `Wcurrent == W0` therefore
proves "the pass analyzed exactly the durable truth-input state it is
publishing" — never "no external effect occurred", and never "the anchor is
complete". Consequently: no absence of a row is ever proof that a request was
not sent; the ONLY independent durable pre-send proof the platform has is the
frozen step-level marker `experiment_step_run.executingAt IS NULL`
(`engine-emergency.ts`, the F-1 repair: "a persisted invocation row set is NOT a
closed world"), which is why a recorded pre-send invocation set is never
sufficient for immateriality (§5); and an anchor ambiguity that the durable
evidence cannot settle yields NOT_EVALUABLE, never a PASS. A database lock
serializes writers; it cannot recall an in-flight HTTP request, and this ADR
claims no such property.

**Persistence (honest additive migration; designed here, NOT implemented
here).**

- New run-scoped row `run_truth_input_head`: unique/PK `runId`
  (FK → `ExperimentRun`); `provenanceRevision bigint NOT NULL DEFAULT 0`;
  `derivationGeneration bigint NOT NULL DEFAULT 0`; `updatedAt`. Initial value 0
  for each component; monotone `+1` transitions only, inside the writer
  transaction; read protocol = one bounded read under the per-run lock (stage
  1, stage 2, publication, authorization); missing row ⇒ `(0, 0)`; concurrent
  writers serialize on the per-run advisory lock (read-modify-write inside it,
  or an atomic increment upsert); a failed advance aborts the whole
  transaction, so the revision never moves without the row and never lags a
  committed row.
- Additive columns on `current_evaluation_pointer` and `run_eligibility_proof`:
  `provenanceRevision bigint`, `derivationGeneration bigint` (the components the
  row was published at). Existing columns and rows are untouched; a historical
  row without the new columns is never current truth for a gated run.
- No other schema change; no backfill; historical rows, snapshots, and
  `ReproductionDefinition` rows remain byte-unchanged (R-12 additive only).

**Truth-input coverage (frozen claim; the whole point of this subsection).**
Every mutable durable input the analysis reads to derive eligibility, the
anchor, completeness, or a verdict lies in exactly one class — A (existing chain
+ append lock), B (the new writer protocol), C (a deterministic projection of an
already-covered input, with completeness marked by `D`), or D (frozen run
intent). Anything outside these classes must fail closed and be named as a
residual blocker rather than silently read:

| # | Truth-bearing input | Writer(s) | Class / coverage |
|---|---|---|---|
| 1 | `evidence.raw_observation` + `evidence.evidence_integrity_head` | `appendChainObservation` | A — per-run lock, chain identity `C` |
| 2 | `control.experiment_step_run` (state, terminal fields, `leaseOwnerId`, `fencingToken`, `executingAt`, dispatch marker, lease fields) | `markExecuting`, `writeTerminalState`, `recovery.ts` (lease resolve / run settle), `reconciler.ts` (dispatch marker), worker dispatch markers | B — writer protocol; `P` advance |
| 3 | `control.step_invocation` | `recordInvocation` (post-send, unfenced by design) | B — writer protocol; the `P` advance closes the late-append hole that chain-only `H0` could not see |
| 4 | `control.stale_writer_event` | `recordStaleWriter` | B — writer protocol (audit surface; not a decision input today, covered so no future reader inherits the hole) |
| 5 | `control.experiment_run` (state, `terminalAt`, `failureReason`, `cancelRequestedAt`) | run creation, `settleRuns`, `settleCancelledRun`, API cancel | B — writer protocol; `P` advance |
| 6 | `evidence.normalized_event`, `evidence.causal_relationship`, derivation diagnostics / tombstones | canonical derivation (`deriveRunEvidence` and the generic derivation passes) | C + `D` — deterministic projection; completeness by derivation generation |
| 7 | forensic derivations / findings / timeline projection | `deriveRunForensics` | C + `D` — projection of covered evidence and evaluations |
| 8 | `analysis.invariant_evaluation` / `evaluation_batch` | analysis persistence (idempotent unique keys) | C — deterministic evaluation of covered inputs; selection authority is the pointer, published atomically |
| 9 | `current_evaluation_pointer` / `run_eligibility_proof` (with the new watermark columns) | analysis publication | Atomic publication under the shared lock; one `analysisGeneration`; carries `W` |
| 10 | `control.run_snapshot` / `reproduction_definition` (frozen intent: steps, `runScope`, policy, `target`) | frozen at run creation; never rewritten | D — frozen run intent, pinned by `snapshotContentHash` |
| 11 | telemetry / worker logs | telemetry sinks | Not a decision input (ADR-0015); never read into eligibility, verdict, or report bytes |

**Unchanged by this revision (frozen).** `runScope/v1`, P-01 strict coverage,
P-02 scope/generation mapping, P-03 terminal-owner authority with preserved
stale provenance, P-04 exact bounds, P-05 step/origin authority, P-06
current-evaluation pointers, P-07 foreign-row anomaly rule, P-08 legacy/generic
coexistence, `snapshotContentHash`, replay identity, observed-total
completeness, lower-bound-safe FAIL, foreign-scope exclusion, the multi-subject
exit classification, as-of certification, production denial, credential
authorization, and fencing semantics are untouched in architecture. No
target-specific branch is introduced anywhere: the protocol is run-scoped and
domain-agnostic.


**Report finalization — the evidence-head linearization contract (Boundary B — report-side repair).**

The design above fixes WHAT current truth is; this contract fixes WHEN a
report decision is authorized, so that no check-then-write window can
exclude an already-committed evidence append from a decision that claims to
include it. It is the report-side half of the two-boundary contract; the
analysis-side half (Boundary A) is frozen immediately above, and neither
half substitutes for the other.

- **Certification model (frozen).** A report certifies exactly ONE
  logically append-only, hash-pinned evidence prefix TOGETHER WITH the exact
  provenance and derivation state it was analyzed against, identified by the
  run's COMPOSITE truth-input watermark `W` (§13 B-3 subsection): the
  `EvidenceIntegrityHead` identity `(lastChainIndex, headContentHash,
  observationCount)` — or, for a run with no observations at all, the empty
  chain (count 0, no head hash) — plus `provenanceRevision` and
  `derivationGeneration`. The prefix is hash-pinned: the chain is
  content-addressed and logically append-only, so the bytes of the prefix
  through a given head hash/count cannot change without changing the hash,
  and later appends only extend it. This is application-level logical
  append-only semantics (R-18 / ADR-0006), NOT a claim of physical database
  immutability, DBA-tamper-proofness, or cryptographic non-repudiation: the
  head row and observation rows are ordinary database records whose append
  discipline is enforced by the lock contract below, not by the storage
  engine. A report NEVER
  claims continuous or permanent freshness: it states its as-of watermark
  (the composite identity — `headContentHash`, `observationCount`,
  `provenanceRevision`, `derivationGeneration`, `analysisGeneration`, the
  single authoritative evaluator version, the eligibility version) and that
  later evidence, provenance, or derivation belongs to a newer analysis
  state. ADR-0019's exit contract is
  read accordingly: "run terminal COMPLETED + evidence chain verified +
  every bound verdict PASS" means verified AS OF the disclosed certified
  watermark (the accepted report envelope already carries the chain head
  hash and observation count), not "no evidence can ever be appended
  again".

- **Shared serialization (frozen).** The existing append primitive
  (`RawObservationStore.appendChainObservation`) already serializes every
  evidence append per run: one transaction executing the per-run
  transaction-scoped advisory lock
  `pg_advisory_xact_lock(hashtext(runId::text))` (`hashtext` collisions only
  add conservative false contention, never false exclusion), inserting the
  observation and advancing the `EvidenceIntegrityHead` row in the SAME
  transaction; every truth-bearing non-chain writer (provenance and derived
  projections) acquires the SAME key and advances its truth-input revision in
  the same transaction as its write — the B-3 writer protocol above. Report
  finalization uses THE SAME lock key, acquired FIRST:
  the authorization transaction takes that advisory lock before any decision
  read, and every operation inside it is database-local and read-only with
  respect to durable truth. It does NOT rely on an isolation snapshot that
  could predate lock acquisition (a snapshot taken before the lock could
  exclude an append that committed while waiting for the lock — exactly the
  defect class this contract closes): the decision reads run at the same
  READ COMMITTED semantics the append path uses, all while the lock is
  held, so the evidence head cannot move. Isolation is READ COMMITTED
  EXPLICITLY — PostgreSQL's default, with NO isolation-level override on
  either path (the append path's `$transaction` sets none, and the
  authorization path must set none): a REPEATABLE READ / SERIALIZABLE
  authorization read is a contract violation, because a snapshot taken
  before the lock grant could exclude an append that committed while waiting
  for the lock. Analysis publication (Boundary A) takes the SAME advisory
  lock, so it cannot commit during the authorization read either: a
  publication that committed before the grant is fully visible to checks
  4–6, and one waiting on the lock commits afterwards and necessarily
  belongs to a newer state (checks 4–6 reject the now-stale proof/pointers
  as an eligibility inconsistency, bounded retry, then fail closed). No
  other lock is acquired
  while holding it, so append↔authorization and authorization↔authorization
  serialize with no deadlock cycle. The hold is bounded: a bounded number of
  indexed reads plus the frozen set reduction — never filesystem, stdout,
  network, chain re-verification, or analysis inside the lock — and a
  configured lock/statement timeout bounds the wait; a timeout aborts the
  transaction cleanly (it writes nothing) as EXECUTION_FAILURE (exit 3 —
  verification could not be performed; ADR-0019 rule 1).

- **The authorization transaction (exact checklist).** Under the lock, read
  and verify:
  1. run terminal state `COMPLETED`;
  2. the locked COMPOSITE truth-input watermark `W` — the
     `EvidenceIntegrityHead` identity `(headContentHash, observationCount,
     lastChainIndex)` (or the verified empty-chain case: no head row and no
     observations) PLUS the current `provenanceRevision` and
     `derivationGeneration`, all read under the same lock in the same
     transaction. When a head row is
     present, `lastChainIndex` must agree with the chain ordinal implied by
     `observationCount` under the chain's gap-free numbering; a disagreement
     is a chain inconsistency ⇒ exit 3, never a decision. (If an accepted
     future chain design makes the index a non-contiguous counter, the index
     is display-only and NEVER enters any decision, comparison, or
     watermark check — it is not currently used as a decision input beyond
     this agreement check.);
  3. that the evidence-chain verification already performed against EXACTLY
     this identity is the one being certified. Chain re-verification is O(N)
     and runs OUTSIDE the lock; the locked identity re-read is the
     confirmation — because the prefix is content-addressed and logically
     append-only, a verification of the same `(lastChainIndex,
     headContentHash, observationCount)` certifies exactly this locked prefix
     and no other. Merely matching an unchecked head value is NOT proof: the
     verification must have covered the identical triple that the lock
     confirms, or it does not authorize anything. If the locked identity
     differs from the verified one (the head advanced while waiting for the
     lock), the verification is redone for the new identity within the
     bounded retry policy below — never skipped, never assumed. The
     verifier's recorded `lastVerified*` metadata on the head row is
     coordination metadata and never a decision input;
  4. the run's single authoritative evaluator version per key (frozen
     above), and the `run_eligibility_proof` row read ONLY at that version,
     including the proof row's own publication watermark: the chain
     components `(integrityHeadHash, integrityObservationCount)` must EQUAL
     the locked head identity (or the empty-chain marker) AND the row's
     `provenanceRevision` / `derivationGeneration` must EQUAL the locked
     provenance and derivation components. Each component is compared as a
     decision input, never merely read; an old provenance or derivation
     version paired with a current chain head is an eligibility
     inconsistency, NEVER a PASS;
  5. `analysisGeneration` agreement: the proof row and EVERY current pointer
     it governs carry the SAME `analysisGeneration` and the same version
     pair — disagreement is an eligibility inconsistency, never a mixed
     read;
  6. the proof row's watermark AND every pointer's
     `(integrityHeadHash, integrityObservationCount)` watermark each EQUAL
     the locked head identity (or the verified empty-chain marker), AND the
     proof row's and every pointer's `provenanceRevision` /
     `derivationGeneration` each EQUAL the locked provenance and derivation
     components. A proof or pointer watermark that cannot match the locked
     truth-input state — including any pointer left at a superseded chain,
     provenance, or derivation component (§13 confirmed-evaluation rule) —
     is an eligibility inconsistency ⇒ exit 2, never PASS;
  7. every pointer's `currentEvaluationId` resolves to an
     `InvariantEvaluation` row of a COMPLETED batch at the authoritative
     version, and the required subject verdicts, the missing set, the
     coverage/class-B state, and the foreign inventory from the proof row
     are present and serializable;
  8. the frozen five-way set reduction (§14) over exactly these locked
     values, producing the provisional exit class.
  The transaction COMMITS (releasing the lock), carrying the provisional
  decision in memory. Because appends cannot commit between the lock
  acquisition and the commit, and analysis publication is atomic, the
  decision is a pure deterministic function of one consistent committed
  state.

- **Linearization point (frozen).** The decision's linearization point is
  the authorization transaction's lock-scoped read of the COMPOSITE
  truth-input watermark `W` (check 2, after the per-run advisory lock is
  acquired and after the terminal-state precondition of check 1); the commit
  ends the exclusion window. The certified state is EXACTLY the state visible
  at that point: every append, provenance write, or derived commit that
  committed before it is included (and any such write that made pointers stale
  fails checks 5/6); every such write not committed by then is blocked on the
  lock and belongs to a strictly later state. There is no finite-read freshness claim: the
  contract pins one point; it does not chase a moving head.

- **Bounded pre-authorization retry (frozen; same frozen bound as
  Boundary A).** If the locked read finds a stale proof/pointer watermark
  (evidence advanced before authorization), the transaction aborts WITHOUT a
  decision; bounded re-analysis (the Boundary A discipline above, using the
  SAME frozen bound constant N — one bound governs both boundaries, never
  two competing bounds) runs over the now-current evidence and the
  authorization is retried. TERMINAL staleness classification is reached
  only when the bound is exhausted after the last complete cycle, and is
  applied exactly once: exit 2 when the inconsistency is business-domain
  (stale/unresolvable pointers — execution truth intact), exit 3 when
  verification cannot be performed (integrity unverifiable, lock timeout,
  database unavailable). An authorization is NEVER retried against a
  different head identity without re-verification, and no stale PASS exists
  on the retry path.

- **Post-authorization appends (frozen).** An append that commits after the
  authorization commit is, by definition, NOT part of the certified prefix.
  It creates a newer evidence state: the next report/analysis sees the
  watermark mismatch, triggers bounded re-analysis, and may certify a NEW
  decision at the new head. The emitted report states the as-of watermark
  and that later evidence is not covered. This is acceptable under ADR-0019
  because the exit contract's claims are made about a fixed, identified,
  verified evidence prefix — and it is NEVER acceptable (never exit 0) when
  checks 1–7 fail at the linearization point, in which case the outcome is
  the §14 class (2 or 3).

- **Output discipline (frozen).** The report artifact is built and written
  AFTER the authorization transaction commits, from the frozen in-memory
  values (no re-reads — so no output can mix watermarks). EVERY report byte
  (verdicts, findings, exit class, integrity identity, certified watermark,
  and  the run's version surfaces, and the certified COMPOSITE watermark —
  `headContentHash`, `observationCount`, `provenanceRevision`,
  `derivationGeneration`, `analysisGeneration`, the single authoritative
  evaluator version, and the eligibility version) must derive ONLY from values
  frozen by the authorization transaction: the transaction therefore resolves
  every database-resident report input WHILE the lock is held — including the
  version surfaces currently loaded lazily inside `buildReport` via
  `loadNormalizerVersions` (and `loadInvariantEvaluatorVersions`) — and hands
  them to the builder as frozen values. Post-commit `buildReport` MUST
  NOT issue a live read whose result can change an authorized field; a read
  that could alter the artifact after authorization is a contract violation,
  because it would let a version/evidence mutation leak into an authorized
  PASS. `reportId` and `generatedAt` are the ONLY envelope metadata
  permitted to be generated after the commit; neither enters the decision.
  These hoisted reads are DB-local and bounded, so they do not violate the
  lock-scope rule. The artifact write uses construct → schema-validate →
  temp-file write → atomic rename (the existing `packages/cli` discipline);
  no database lock is held over filesystem or stdout operations, and the
  contract does NOT serialize artifact publication through the evidence
  lock. If the artifact cannot be written, or stdout emission fails, the
  process MUST NOT exit 0: the authorized PASS was not delivered, and the
  process exits 3 (EXECUTION_FAILURE — delivery/infrastructure reality),
  leaving durable run truth untouched. A partial artifact must never become
  visible (temp + rename); re-running the command re-authorizes
  idempotently.

- **Concurrent report attempts (frozen).** Two report processes serialize on
  the same per-run advisory lock; each authorizes against one head; no mixed
  watermark or pointer generations are possible; the authorization writes
  nothing durable, so there is no lost update or decision race. Two reports
  may (only in strict serial order) certify different heads when an append
  interleaves; each is self-describing with its own watermark.

- **Durable certification record (frozen decision: NOT REQUIRED).** No new
  table is needed to establish the linearization point, and adding one is
  refused by default:
  1. the point is a read under an existing lock protocol, not a write;
  2. the certified snapshot identity is a hash-pinned, content-addressed
     prefix of the logically append-only chain — re-verifiable from durable
     rows at any later time (logical append-only discipline, not physical
     immutability);
  3. the report artifact IS the certification: it serializes the watermark,
     `analysisGeneration`, the authoritative version, the proof identity,
     and the exit class; together with the append-only evaluation/proof
     history it makes the decision auditable and recomputable;
  4. idempotence: re-authorization over the same head + generation is
     deterministic and yields the identical class; concurrent
     authorizations produce per-head decisions with no shared mutable
     state;
  5. a certification table would be a derived bookmark risking a second
     authority for decisions. If a future operational need for one arrives,
     it requires a new ADR; its identity must be the certified tuple
     `(runId, authoritative evaluator version, eligibilityVersion,
     analysisGeneration, headContentHash, observationCount, exitClass)` —
     never wall-clock order or random-UUID ordering — and it must never be
     read back as business truth.

- **Empty-chain edge (frozen).** A run with zero observations has no
  `EvidenceIntegrityHead` row; the advisory lock key still exists, so the
  authorization takes the same lock, confirms under it that no head row and no
  observations exist, and certifies the empty chain TOGETHER WITH the locked
  provenance and derivation components; any later append, provenance write, or
  derived commit is necessarily after authorization. A head row without observations, or
  observations without a head row, is a chain inconsistency ⇒ exit 3 (chain
  verification fails closed), never PASS.

### 14. Multi-subject exit aggregation (exact, eligibility-aware)

The eventual exit algorithm operates on the trusted CURRENT evaluations
(§13 pointers) of EACH eligible `(invariantKey, subject identity, scope,
generation)` — never one arbitrary verdict per key. The orchestrator's
per-key `Map` collapse is deleted with no replacement shape: the verdict
domain is keyed by `(key, subject)` end to end. `classifyExit` accepts
`boundVerdicts: Map<key, Map<subject, verdict>>` over current eligible rows,
plus the eligible domain, the anomaly sets, and the proof-record presence —
never a per-key collapse.

**Reduction (frozen precedence, set-based — sorting can never change it):**

```
1. runTerminalState != COMPLETED (incl. undefined/timeout) → 3 EXECUTION_FAILURE
2. evidenceIntegrityVerified != true                        → 3 (dominates durable FAIL)
3. legacy mode (snapshot without `runScopeBinding`, proof row mode
   `legacy-compat`) → per-SUBJECT set reduction over pointer-selected rows
   at the authoritative version with the as-observed domain (no anchor, no
   declared set, no coverage anomalies), labeled `legacy-compat` in the
   report. The per-key collapse is NOT preserved: it is the audited
   laundering defect and is fixed in every mode. What compat preserves is
   the verdict history and the absence of eligibility gating — historical
   rows are never rewritten and no declared domain is invented for old
   snapshots. A bound key — legacy or strict — with ZERO current subject
   pointers/evaluations is a missing verdict ⇒ exit 2, never a vacuous
   PASS; the as-observed domain is a domain of observed subjects, and its
   emptiness is uncertainty, not success.
4. strict: FAILS = {(k,s) current eligible pointer verdict FAIL}
   if any FAIL → 1 INVARIANT_FAIL (reason lists keys sorted; details list subjects sorted)
5. strict: NES = {(k,s): s ∈ domain(k) AND (no current pointer OR pointer verdict NE)}
              ∪ {missing declared subjects} ∪ {coverage anomalies} ∪ {foreign-row anomalies}
              ∪ {eligibility inconsistencies: proof row absent, version mismatch, stale past bound}
   if nonempty → 2 NOT_EVALUABLE (names missing subjects + gap/anomaly kinds)
6. strict: every bound key has ≥1 declared subject AND every eligible pointer verdict PASS
   AND anomaly sets empty → 0 PASS
   Anchor-unproven ⇒ domain evaluable-empty + missing set nonempty ⇒ rule 5 fires ⇒ never 0
```

This is NOT a `FAIL > PASS > NOT_EVALUABLE` rank rule: PASS never overwrites
NE or FAIL because verdicts are never collapsed across subjects — the sets are
reduced independently in precedence order. Report row order is display-only
(deterministic sort by `(key, subject)`); classification reads sets. No
empty-set success in ANY mode (rule 6 requires ≥1 declared subject per key
in strict mode; a legacy-compat key with an empty as-observed domain is a
missing verdict ⇒ exit 2, never a vacuous PASS; the zero-invariant scenario
guard from the accepted classifier is preserved).

**Worked case.** Eligible domain `{INV-CHK-1: {A, B}, INV-INV-1: {SKU-A,
SKU-B}}`; current pointers `CHK-1/A FAIL, CHK-1/B PASS, INV-1/SKU-A PASS,
INV-1/SKU-B NE` → rule 4 nonempty → **exit 1**; findings: exactly the eligible
FAIL rows (CHK-1/A); report lists all four rows + eligibilitySummary +
coverage. Reverse the row sort, reverse creation order, re-run analysis:
identical sets, identical exit. If instead `CHK-1/A PASS, CHK-1/B PASS` with
the same INV-1 rows → rule 4 empty, rule 5 `{INV-1/SKU-B}` → **exit 2**. If
all four PASS with empty anomaly sets → **exit 0**.

### 15. Foreign-row anomaly — single non-contradictory rule (P-07 repair)

The first proposal counted foreign rows in the FAIL set in one paragraph and
called them non-failures in another. Both cannot hold. The frozen rule is:

A persisted evaluation row at the run's authoritative evaluator version whose
subject is NOT eligible under the current run-owned domain (undeclared
identity, anchor-mismatched scope/generation, or contested binding) is a
**consistency anomaly** (`FOREIGN_ROW_ANOMALY`). It is NOT a proven business
failure in the current run. Therefore:

- foreign-row anomaly ⇒ NOT_EVALUABLE / exit 2 (§14 rule 5);
- unless evidence integrity / execution failure independently holds ⇒ exit 3
  (§14 rules 1–2);
- or unless an independent, trusted, eligible FAIL exists ⇒ exit 1 (§14
  rule 4 — the FAIL, not the anomaly, decides).

A foreign FAIL is NEVER converted into an eligible business FAIL (no finding
is derived from it; findings derive only from current eligible FAIL rows).
A persisted unexpected evaluation is NEVER silently omitted (the anomaly is
named in the report with key, subject, scope, generation, and evaluator
version). The rule is scoped to the run's AUTHORITATIVE evaluator version
only: pre-gating `'v1'` rows that exist on a newly gated run are labeled
history — never current truth, never foreign-row anomalies, never omitted
from the report's history surface. Under the gated implementation analysis
never creates such rows at the authoritative version; the rule exists so
any future writer bug there fails closed and auditable instead of vanishing
or laundering.

### 16. Mixed legacy/generic exit reduction (P-08 repair)

- Legacy invariant keys (null generic metadata triple: INV-IZ-1, INV-DF-1/2)
  retain legacy semantics: legacy subject discovery with per-subject
  pointer-selected set reduction labeled `legacy-compat`. The same compat
  shape covers generic keys on historical snapshots without `runScope`
  (as-observed domain, no gating). Nothing about historical verdicts
  changes; the per-key collapse is fixed in all modes.
- Generic keys on NEWLY frozen definitions REQUIRE `runScope` (§3 rule 6);
  a new generic definition missing `runScope` is freeze-time rejected, never
  compat-fallen-back.
- Legacy keys are NEVER added to generic subject sets and generic subjects
  are NEVER folded into legacy verdict sets: the two domains reduce
  separately over their own pointer-selected rows (per-subject sets in both
  domains), then combine under the global precedence
  (execution/integrity → 3; any FAIL either domain → 1; any NE/missing/
  anomaly either domain → 2; all PASS both domains → 0).
- Historical snapshots keep existing semantics; historical evaluations are
  never rewritten; old `ReproductionDefinition` rows remain valid; new
  snapshot versioning stays deterministic (canonicalization unchanged;
  `runScopeBinding` participates exactly like `invariantBindings` do).
- The generic gated evaluator version is explicit (§13); pre-gating `'v1'`
  generic rows are history for gated runs, never current truth.
- The report labels the reduction mode per key (`legacy` vs
  `strict-coverage/v1`) so a mixed run's exit is auditable key by key.

### 17. Legacy compatibility (frozen)

- Incident Zero / Controlled Faults (non-generic evaluators, manifest-less
  path): untouched, suites stay green.
- Phase 14 inspection captures / Phase 15 generic evaluations / Phase 16
  Commerce target + manifest: valid under the new design; manifest schema
  unchanged; evaluator function unchanged.
- Existing logically append-only, content-addressed snapshots +
  `ReproductionDefinition` rows: replay intent
  preserved; re-analysis of legacy snapshots publishes pointers over the
  as-observed domain under the labeled compat mode (`legacy-compat` proof
  row, per-subject sets, no collapse, no gating), never a silent semantic
  change. Pre-gating generic `'v1'` rows and legacy verdict rows are
  valid history and stay queryable; they are never selected as current truth
  for gated runs.
- `scenario/v1`: backward-compatible OPTIONAL `runScope` field (closed
  schema stays closed; unknown fields still rejected). No silent expansion:
  the field, its version string, and its requirement rule are frozen here.
- Scenario expectations stay per-key regression intent (FAIL ⇔ ≥1 eligible
  FAIL; PASS ⇔ all eligible PASS; NE ⇔ no FAIL and ≥1 NE/missing/anomaly)
  and never influence classification (ADR-0019).

### 18. Eligibility responsibility (frozen)

The pure selector MAY be shared as code, but authoritative decisions have
exactly one persisted, verifiable source:

- **Analysis owns:** the before-read composite truth-input capture
  `W0 = (C0, P0, D0)` (§13 Boundary A); run-anchor derivation; eligibility
  proof (eligible domain, missing set, class-B/foreign inventory, gaps);
  subject selection; invariant evaluation; current-evaluation publication
  (pointers) and the eligibility proof rows, published atomically only under
  `Wcurrent == W0` in every component with a shared `analysisGeneration`;
  findings (from current eligible FAIL rows only). The
  pass never adopts the publication-time head as its analysis watermark and
  never leaves a superseded watermark on a current pointer or proof row.
- **Report owns:** serialization of the persisted pointers + proof rows;
  schema validation; consistency checks (pointer freshness vs integrity
  head; declared-vs-pointer coverage reconciliation; unexpected-row scan at
  the authoritative version; mode labeling). The report NEVER recomputes
  business truth and NEVER chooses a different eligibility domain.
- **Classifier owns:** the five-way set reduction (§14) over authoritative
  current eligible persisted evaluations + domain + anomaly sets. It NEVER
  reads live target state and NEVER re-derives eligibility.

### 19. Completeness preservation (ADR-0023 untouched)

`observed-total` is preserved verbatim: for every eligible subject, all
relevant exact subject/scope/generation facts participate. No hidden effect
filtering. No incomplete enumeration PASS. No missing summary PASS. No
contradictory summary PASS. No falsely merged generations. No
attribution-by-timestamp. Lower-bound-safe FAIL stays valid exactly as
frozen (atMostOne rules 3/7–8; resourceConservation Cases A/B with the
B-1/B-2 disciplines). A foreign partition's evidence remains in
raw/normalized records for audit, even when it is not eligible for this
run's invariant domain. The BS-1 convergence rule and BS-2 capture-set rule
apply unchanged inside each eligible partition.

### 20. Inspection stays complete; foreign evidence stays auditable

`inspection/v1`, ADR-0022 literal paths, and the generic capture seam are
unchanged: the target may return all scopes; the platform observes them all
(raw observations + normalized events + derivation diagnostics persist
untouched, logically append-only). Only *business evaluation* is gated. The
report gains additive `eligibilitySummary` and `coverage` blocks (schema-
additive per ADR-0019; consumers ignore unknown fields — no report v2):
eligibility version, anchor proof (declared vs observed scope/generation,
setup stepRun/observation hashes, fencing facts), declared/evaluated/missing
subjects per key, the foreign inventory (distinct foreign subject identities
per `(scope, generation)` — counts only, never verdicts), the named class-B
unexpected identities, the authoritative evaluator version per key, pointer
generations and freshness, the CERTIFIED as-of watermark (head content hash,
observation count, chain index, `analysisGeneration`, the provenance
revision, the derivation generation, the single authoritative evaluator
version, the eligibility version — the §13 finalization linearization point),
the statement that later evidence, provenance, or derivation belongs to a
newer analysis state, and the coverage limitation statement. No foreign
business finding is ever persisted as if it proved the current run's scope.

### 21. No false PASS, no false FAIL (both properties)

- **False-FAIL prevention.** Run B (SECURE, scope B, generation Gb) observes
  foreign scope-A subjects: class C ⇒ never evaluated ⇒ scope-A FAIL
  cannot contaminate run B (§26 case 7). Own vulnerable AAA FAIL + foreign
  secure ZZZ PASS ⇒ ZZZ undeclared/anchor-mismatched ⇒ no PASS row to
  launder with (§26 case 8).
- **False-PASS prevention.** Declared-set laundering is closed by the
  coverage gate: an undeclared same-scope subject forces NE (§8 matrix),
  never silent exit 0. In-scope duplicates are always evaluated with
  complete partition evidence; extra foreign rows never enter counts and
  never dilute FAIL (§26 case 15). Same-key PASS rows for *other* subjects
  never merge with a FAIL row (no per-key collapse; §26 case 10). PASS with
  same-key NE ⇒ exit 2, never 0 (§26 case 11).

### 22. Missing-evidence rules (never PASS from absence; never evaluate the world)

| Situation | Behavior |
|---|---|
| `runScope` absent, generic bindings present (new freeze) | freeze-time rejection (fail-closed at definition) |
| Legacy snapshot (no `runScopeBinding`) | legacy-compat mode, labeled; historical verdicts stand |
| Setup stepRun missing / not SUCCEEDED | anchor unproven ⇒ no eligible evaluations |
| No valid setup response / fields redacted / type-invalid | anchor unproven |
| Declared scope ≠ observed scope | anchor unproven (target did not establish the run's scope) |
| Two conflicting observed generations (terminal owner) | `EVIDENCE_CONFLICT`, NE path |
| Conflicting stale generation, immateriality unproven | `EVIDENCE_CONFLICT`, NE path |
| Subject identity ambiguous/contested | class D ⇒ coverage anomaly ⇒ NE (ADR-0017 D3) |
| Subject observed but summary absent | existing evaluator NE (completeness gap), eligible row persists |
| Only foreign subjects observed | zero eligible partitions; declared set missing ⇒ exit 2 |
| Undeclared same-scope subject observed | coverage anomaly ⇒ exit 2 (never 0) |
| No eligible subject discovered (anchor unproven) | exit 2, never 0 |
| Current pointer missing / stale past bound / proof row absent | exit 2, never 0 |
| Authorization lock timeout / database unavailable / verification not performable | exit 3 (verification could not be performed — ADR-0019 rule 1), never PASS |
| Analysis publication truth-input mismatch (`Wcurrent != W0` in ANY component) | no publication of the attempted generation; bounded re-analysis over a fresh two-stage `W0`; bound exhausted ⇒ exit 2 (business staleness) or 3 (verification not performable), never PASS |
| Late provenance write (step / run / invocation row) with the chain byte-identical | mismatch on `P` ⇒ no publication; bounded re-analysis; the new row participates in §5 anchor judgment ⇒ exit 2 (or 1/3 by precedence), never a stale PASS |
| Foreign derived commit after the analysis capture | mismatch on `D` ⇒ no publication; bounded re-analysis over the COMPLETE projection, never a partial-projection PASS |
| Derivation that could not commit atomically with its `D` advance | explicit incompleteness marker ⇒ gap ⇒ NOT_EVALUABLE path (exit 2), never PASS |
| Run failed before binding completed | exit 3 via rules 1–2 (EXECUTION_FAILURE, ADR-0019), distinct from NE |

Fallbacks forbidden: never evaluate all target subjects; never convert
absence of proof into PASS.

### 23. Precise failure classification (NOT_EVALUABLE vs EXECUTION_FAILURE)

Missing/ambiguous business eligibility ⇒ exit 2. Trusted eligible business
FAIL ⇒ exit 1. Failed execution or failed integrity ⇒ exit 3. Analysis
infrastructure failure that prevents completion (timeout/crash, no completed
batches) ⇒ exit 3 under ADR-0019 rule 1 (prerequisite/infrastructure
reality). Completed analysis whose pointers cannot be confirmed fresh within
the bound ⇒ exit 2 (the execution truth is intact; the business-domain proof
is not). Finalization-specific: authorization lock timeout, database
unavailability, or an integrity verification that cannot be performed
against the locked identity ⇒ exit 3 (verification could not be performed —
ADR-0019 rule 1); a locked read that completes but fails a consistency check
(`analysisGeneration` disagreement, watermark mismatch, missing verdict)
⇒ exit 2. No exception-shaped blanket inference: each row of §§5/22 names its
class explicitly. A truth-input watermark mismatch is business-domain staleness (exit 2) when the execution truth is intact, and verification-not-performable (exit 3) when the locked read or the revision advance itself could not be performed.

### 24. Replay compatibility

Same `snapshotContentHash`; new execution run; new observed setup generation;
new evidence chain; new eligibility proof; new current-evaluation selection.
Observed generation never enters frozen intent hash. Replay under a new
evaluator version produces new-version rows and advances per-version
pointers; cross-version comparison is refused, not coerced (§13). Replay
itself is not implemented by this design. A replay certification is a new
report over the replay run's own new evidence chain, its own analysis
watermark (Boundary A), and its own authorization point (Boundary B) under
§13; the original report's as-of watermark remains valid for the original
run and is never extended to cover the replay's evidence.

### 25. Security / ownership (runScope grants nothing)

No `runScope` field grants target authority, credential authority, origin
override, production override, worker selection, SQL, JavaScript, or target
DB access. Run-specific observations remain tied to `(runId, stepRunId,
invocationId, writer owner, fencing token, registered origin)` (§11).
Stale observations are preserved as attributed evidence (§5). Credential
values never enter `runScope`, snapshots, pointers, proof rows, reports, or
logs (§12). Production environments stay denied for fault execution (R-14,
unchanged). Snapshot integrity is unchanged (canonicalization + content
hash; `runScopeBinding` participates like `invariantBindings`). Fencing
semantics are unchanged (ADR-0009; §5 extends attribution to anchor
selection without altering any state-write rule).

### 26. Adversarial regression matrix (future committed tests; durable truth + exit asserted)

E2E = real stack (PostgreSQL ×2, Redis/BullMQ, real HTTP, real CLI child
process); U = pure decision-table unit. All E2E assert durable rows AND the OS
exit. (Specified, not implemented — this ADR ships no tests.) Cases 1–22 are
preserved from the first proposal; cases 23–41 close the P-01–P-08 audit
findings; cases 42–50 close the report-side B-1 finding (§13 finalization,
Boundary B); cases 51–56 close the analysis-side watermark finding (§13
analysis watermark capture/publication, Boundary A) and the verified-prefix
binding. Cases 51–56 each state durable inputs, the timing/interleaving, the
expected publication result, the pointer/proof state after the attempt, and
the verdict/exit behavior. Cases 57–66 close the B-3 truth-input coverage
finding (§13 composite watermark: the writer protocol, the two-stage capture,
the provenance/derivation components, derived-projection completeness, and the
honest epistemic limit). Every case from 51 onward states durable inputs, the
synchronization barrier, the timing/interleaving, the expected publication
result, the pointer/proof/revision state after the attempt, the verdict and
exit, and the report provenance.

**Chain components in the cases.** From case 51 onward, `H0`/`H1` denote the
CHAIN component `C` of the composite watermark (§13 naming rule); every
publication, rejection, and authorization assertion in those cases is over the
COMPOSITE `W = (C, P, D)`, and the cases that turn purely on provenance or
derivation are 57–66.

**Barrier discipline (frozen for the future committed tests).** Concurrency
cases 42–66 MUST order their interleavings deterministically — never with
`sleep`, retry loops, or timing luck. The frozen barrier is the contract's own
per-run advisory lock: an external session acquires
`pg_advisory_xact_lock(hashtext(runId::text))` and holds it to force a named
stage to block at the exact point under test, then releases it (or commits /
rolls back the competing session) to produce each serial order; a stage's
progress is observed through durable state (rows, revisions, receipts), never
through wall-clock assumptions. Where a case needs an ordering point between
two reads of one session, the test drives that session's stages explicitly
through separate connections so the interleaving is reproducible on every run.

1. SECURE alone → 0 (E2E). 2. VULNERABLE alone → 1 (E2E).
3. VULNERABLE then SECURE → 1,0 (E2E, shared target).
4. SECURE then VULNERABLE → 0,1 (E2E, shared target).
5. V,S,S → 1,0,0 (E2E). 6. S,V,S → 0,1,0 (E2E).
7. Foreign vulnerable scope A preserved; secure scope B run: B's rows all
   PASS/eligible-only, exit 0; A's rows absent from B's evaluations; A's
   observations intact (E2E).
8. Own vulnerable AAA FAIL + foreign secure ZZZ PASS → exit 1, never 0 (E2E).
9. Foreign vulnerable AAA FAIL + own secure ZZZ PASS → own PASS, exit 0;
   foreign rows auditable, unevaluated (E2E).
10. Same key mixed eligible FAIL/PASS, both row orders + shuffled analysis →
    exit 1 (E2E + U reversal).
11. Same key mixed eligible PASS/NE, both orders → exit 2 (E2E + U reversal).
12. Integrity failure + eligible FAIL → exit 3, evaluations marked untrusted
    (E2E tamper, existing hatch discipline).
13. Missing required eligible verdict (declared subject unobserved) → exit 2,
    never 0 (E2E).
14. Anchor unproven (setup response absent/invalid) → zero eligible evaluations
    → exit 2, never 0 (E2E).
15. In-scope duplicate + extra foreign rows → FAIL preserved, exit 1 (E2E).
16. Wrong generation subject present → excluded, never aggregated (E2E).
17. Same scope string, different generation → no conflation; only anchor
    generation evaluated (E2E).
18. Conflicting observed generations → EVIDENCE_CONFLICT → exit 2 unless
    execution/integrity failure → 3 (E2E + U).
19. Missing observed-total completeness for eligible subject → NE unless
    lower-bound-safe FAIL independently proven (E2E; mirrors ADR-0023 rows).
20. Identical frozen snapshot on two runs, different observed generations →
    independent anchors, independent verdicts, same snapshot hash (E2E).
21. Historical Incident Zero suites unchanged (existing suites, green).
22. Report contains real persisted eligible findings + eligibilitySummary +
    coverage; foreign inventory carries counts only (E2E + schema validation).
23. Declared `SKU-A` PASS + undeclared same-scope `SKU-B` FAIL-state →
    exit 2 with named `COVERAGE_ANOMALY`, never 0 (E2E: the P-01
    counterexample).
24. Declared intent A PASS + undeclared same-scope intent B with duplicate
    orders → exit 2, never 0 and never 1 (E2E).
25. Declared subject missing from evidence → exit 2 naming the missing
    subject (E2E).
26. Same scope, conflicting generations across stale/owner setup responses →
    exit 2 (E2E with controlled stale setup generation; U for the
    immateriality predicate: recorded pre-send rows alone are NEVER immaterial ⇒
    the conflict is sustained (S-6); only the independent step-level proof
    (`executingAt IS NULL`, S-6a) lets the anchor stand).
27. Stale and owner setup responses identical → convergent; anchor stands;
    stale provenance auditable; exit follows eligible verdicts (E2E).
28. Concurrent re-analysis with distinct evidence hashes for one subject →
    one pointer, history preserved, deterministic exit across repetitions
    (E2E + U, all under the §13 COMPOSITE publication rule: an identical
    truth-input state is a no-op, a descendant state publishes a new
    generation, and a non-descendant state ⇒ no publication + bounded
    re-analysis or fail-closed).
29. Evidence appended after pointer publication → report freshness check
    triggers bounded re-analysis (Boundary A); confirmed-same ⇒ the
    evaluation row is reused but the pointers and proof row are RE-PUBLISHED
    at the new head under a new `analysisGeneration`, with the exit class
    unchanged; changed ⇒ new evaluation rows and pointers advance;
    unresolvable ⇒ exit 2 (E2E).
30. Two rows, same subject, different evidence hashes → pointer names exactly
    one; reversed insertion order yields the same pointer and exit (E2E + U).
31. Persisted foreign evaluation anomaly at the authoritative version →
    exit 2 naming `FOREIGN_ROW_ANOMALY`; never converted to FAIL; never
    omitted (E2E with seeded legacy-shape row + U).
32. Current-pointer stale evidence watermark → bounded re-analysis or
    fail-closed exit 2 (E2E + U).
33. Missing current-evaluation reference for a declared subject → exit 2,
    never 0 (E2E + U).
34. Old snapshot under compatibility mode → legacy reduction, labeled mode,
    historical verdicts unchanged (E2E).
35. New gated evaluator version vs old `'v1'` rows → old rows never current;
    pointers reference gated rows only; mixed-version comparison refused
    (E2E + U).
36. No eligible subjects (anchor unproven, empty declared sets rejected at
    freeze) → exit 2, never 0 (E2E).
37. Lower-bound-safe duplicate survives subject selection: eligible duplicate
    with foreign-row noise → FAIL, exit 1 (E2E).
38. Multi-field `scopeBinding` + `runScope/v1` in one new definition →
    freeze-time rejection `RUN_SCOPE_MULTI_SCOPE_FIELD`, exit 4 surface
    (U + E2E validate path).
39. Oversized/unknown/interpolated `runScope` fields → freeze-time rejection
    with the named issue; nothing frozen, nothing executed (U + E2E).
40. Sort-reversal over the full verdict domain (evaluations, pointers,
    anomalies) → identical exit and identical reason sets (U, all exits).
41. Mixed legacy + generic keys in one run → per-domain reduction, combined
    precedence, per-key mode labels in the report (E2E).

42. Evidence appended before final authorization (pointer watermark stale
    against the new head) → bounded re-analysis/retry or fail-closed exit 2;
    NEVER a stale PASS (E2E: append between analysis and authorization).
43. Append concurrent with authorization → the append and the authorization
    serialize on the per-run advisory lock: either the append committed
    before the locked read (included, case 42 outcome) or it commits after
    the authorization (case 44); no interleaving produces a mixed decision
    (E2E worker + CLI race).
44. Append after authorization → the emitted report states its as-of
    watermark; the later evidence belongs to a newer analysis state; a
    subsequent report re-authorizes at the new head; the earlier report
    never claims the newer head (E2E + schema assertion on the watermark
    fields).
45. Append during report file write → the file contains exactly the frozen
    authorized decision and watermark; the certification remains valid
    as-of that watermark (E2E).
46. Report artifact write failure → no successful exit despite an authorized
    PASS (exit 3); no partial artifact visible (temp+rename) (E2E fault
    injection).
47. Proof/pointer `analysisGeneration` disagreement → eligibility
    inconsistency ⇒ exit 2, never PASS (U + E2E seeded row).
48. Locked head identity ≠ verified identity (head advanced between
    verification and authorization) → bounded re-verification/retry or fail
    closed; never a decision against an unverified head (U + E2E).
49. Concurrent CLI report processes → both serialize on the per-run lock;
    each decision corresponds to exactly one head; no mixed watermark or
    pointer generations in either report (E2E two processes).
50. Stale worker appends after a run reached COMPLETED → the observation is
    preserved with its attribution; a certification made before the append
    remains valid as-of its watermark; a later report re-authorizes at the
    advanced head (E2E).
51. Analysis captures H0; a worker appends O, advancing the chain to H1,
    BEFORE the pass publishes. Durable inputs: a completed run, an H0-bound
    analysis result, a real append of an observation unrelated to the
    result. Timing: the append commits first; the publication transaction
    then reads `Hcurrent = H1 ≠ H0`. Expected publication: REJECTED — no
    proof row, no pointer, no `analysisGeneration` advance, no partial write;
    bounded re-analysis over H1. Pointer state: unchanged from the stored
    generation (no H0-watermarked pointer published as current). Verdict:
    the post-re-analysis state's verdict; NEVER a stale PASS over H0
    (E2E worker + analysis race; U for the `Hcurrent == H0` predicate).
52. Analysis captures H0; a worker appends AFTER the pass's evidence reads
    but BEFORE publication. Timing: publication's lock-scoped `Hcurrent`
    read observes H1. Expected publication: lock-scoped rejection, then
    bounded re-analysis with a FRESH H0 capture; either a coherent H1
    publication (if re-analysis completes in bound) or fail-closed exit 2/3.
    Pointer state: exactly one coherent generation at H1, or no new
    generation at all — never an H0 watermark published alongside claimed H1
    results. Verdict: H1's verdict, or NOT_EVALUABLE/EXECUTION_FAILURE on
    exhaustion (E2E, append timed between read and publish; U for the
    mismatch branch).
53. New-head (H1) analysis reproduces EXACTLY the earlier H0 analysis inputs
    and verdict (same semantic `evidenceSetHash`). Durable inputs: a
    historical PASS row E published at H0; H1 = H0 plus one append. Expected
    publication: E MAY be reused as `currentEvaluationId`, but the
    transaction writes a NEW `analysisGeneration`, a proof row certified for
    H1, and every pointer carrying H1's watermark — all atomically under the
    lock. Pointer state: all watermarks = H1; E's `evidenceSetHash`
    byte-unchanged; no H0 watermark survives on any pointer or proof row.
    Verdict: unchanged (E) and reported as-of H1 (E2E + U: reuse permitted
    only after the H1 recheck, never justified by E's prior PASS).
54. Two analysis publishers compete across H0/H1 (one analyzed H0, one H1).
    Timing: both attempt publication; they serialize on the per-run lock.
    Expected publication: only the pass whose captured H0 EQUALS the locked
    head publishes; the stale-H0 publisher is rejected and re-analyzed.
    Pointer state: one coherent current generation, no mixed proof/pointer
    rows, no stale overwrite of the newer generation. Verdict: the current
    generation's verdict, identical to the serial single-pass outcome
    (E2E two publishers; U for the loser's re-validation branch).
55. New evidence is appended between analysis publication and report
    authorization. Durable inputs: published H1 proof/pointers, then an
    append advancing to H2. Timing: the append commits before the
    authorization's lock-scoped read. Expected: the locked read finds the
    proof and/or pointer watermarks stale against H2 ⇒ bounded re-analysis
    (or fail-closed exit 2/3 on exhaustion); NEVER a stale exit 0, and never
    a report mixing H1 bytes with an H2 watermark (E2E + schema assertion on
    the watermark fields).
56. Same evidence head, two concurrent equivalent analyses. Timing: both
    passes capture the same H0 and attempt publication concurrently. Expected
    publication: idempotent convergence — a same-head publication is a no-op
    (or the bounded re-validation converges), producing exactly ONE coherent
    current generation. Pointer state: one generation, no mixed proof/pointer
    rows, no duplicate advance. Verdict: identical exit to the single-pass
    run (E2E two processes; U idempotence and same-head no-op).

57. Late provenance append during analysis (chain byte-identical, `P`
    advances). Durable inputs: terminal `COMPLETED` run; setup stepRun `S`
    fenced-terminal `SUCCEEDED` by G1 with one valid setup response (chain
    `C0`); the pass has committed stage 2 and captured `W0 = (C0, P0, D0)`; a
    stale generation G0 has no durable row yet. Barrier: a writer session takes
    the per-run advisory lock (blocking the pass's publication), inserts one
    `step_invocation` row for `S` attributed to G0
    (`transportStage = REQUEST_SENT`, no response, no raw observation), and
    commits; the pass's publication then proceeds. Expected publication:
    REJECTED on the provenance component — `Wcurrent = (C0, P0+1, D0) ≠ W0` —
    with no proof row, no pointer, no `analysisGeneration` advance, no partial
    write; then bounded re-analysis with a fresh stage-1 capture. Pointer/proof
    state: the stored generation is untouched; no pointer carries `W0`. Verdict:
    the re-analysis sees G0's `REQUEST_SENT` row with no independent pre-send
    proof ⇒ §5 `EVIDENCE_CONFLICT` ⇒ NOT_EVALUABLE (**exit 2**); never exit 0,
    never a stale PASS. Report provenance: the reason names the stale
    generation, its staged invocation, and the provenance revision observed
    (E2E two sessions + external-lock barrier; U for the `W0` comparison).

58. Provenance append between the pass's evidence reads and publication.
    Durable inputs: as case 57 plus one eligible declared subject PASSing at
    `W0`. Barrier: the `step_invocation` insert commits after the pass's
    evaluation reads complete and before its publication transaction acquires
    the lock (an external session orders the two). Expected: the publication
    observes the advanced `P` and rejects; bounded re-analysis re-runs
    derivation + evaluation at the new state; a pre-send-only recorded
    invocation does NOT establish immateriality under v1, so the asserted
    outcome is **exit 2** (or 1 when a trusted eligible FAIL exists at the
    re-analyzed state; or 3 by precedence). Pointer/proof state: exactly one
    coherent generation, or none — never a generation whose `P` is behind its
    proof/pointer components, and never a PASS published from the pre-append
    capture. Report provenance: the artifact's `provenanceRevision` /
    `derivationGeneration` equal the published composite; the late invocation is
    either inside the certified state or explicitly outside it (E2E; U for the
    serialization branch).

59. Writer starts before the publisher's lock attempt and commits after it.
    Durable inputs: published `W1` with an eligible PASS; a `step_invocation`
    insert held open in another transaction. Barrier: that writer takes the
    per-run lock FIRST and holds it, so the report's authorization blocks; the
    test then releases by committing OR rolling back, producing both serial
    orders deterministically. Expected (writer commits first): the authorization
    reads the advanced `W` and finds the proof/pointer watermarks stale ⇒
    eligibility inconsistency ⇒ **exit 2** (3 if verification cannot be
    performed), bounded retry. Expected (writer rolled back / authorization
    first): the authorization certifies exactly `W1`, and the test asserts the
    artifact names only `W1` — a rolled-back write never advances `P` and leaves
    no revision trace. Never: a PASS whose artifact claims a provenance or
    derivation component the decision did not read (E2E two sessions; U for the
    rollback branch).

60. Provenance unchanged, raw chain advances (B-1 regression guard). Durable
    inputs: published `W1`; a real `appendChainObservation` commit. Expected: a
    chain-component mismatch (`Ccurrent ≠ C1`) ⇒ publication/authorization
    rejection and bounded re-analysis — asserted independently of the new
    components, so the B-1 repair is proven not to have regressed. Pointer
    state: never a pointer naming the new chain head with results derived from
    the old one. Verdict: the post-append verdict; never a stale PASS (E2E).

61. Raw chain unchanged, provenance advances (new protection, isolated).
    Durable inputs: published `W1`; a legitimate `stale_writer_event` insert (or
    a step-row marker update) that advances `P` while the chain head is
    byte-identical. Expected: rejection named on the PROVENANCE component alone
    — proving the new protection is not a chain proxy — then bounded
    re-analysis (case 62's reuse rule applies when no evaluator input changed).
    Verdict/exit: the re-analyzed class; never an unchanged exit 0 surviving by
    accident of an identical chain (E2E; U for the comparison).

62. New provenance revision re-analysis confirms the same business verdict.
    Durable inputs: historical PASS row `E` published at `W1`; `W2 = (C1, P2,
    D1)` with `P2 > P1` from a provenance write that changes no evaluator input.
    Expected: `E` may be reused as `currentEvaluationId` ONLY after the complete
    recheck over `W2` (never because `E` was PASS); the transaction writes a NEW
    `analysisGeneration`, an eligibility proof row certified for `W2`, and every
    governed pointer carrying all `W2` components, atomically. Pointer state:
    every component = `W2`; `E.evidenceSetHash` byte-unchanged; NO pointer or
    proof row left at `W1`. This is the regression that proves no perpetual
    stale-pointer failure and that no-op is never "same evaluation fingerprint ⇒
    keep the old watermark". Verdict/exit: the unchanged class, reported as-of
    `W2` (E2E + U).

63. Concurrent provenance writer and raw-observation writer. Durable inputs:
    session A inserts a `step_invocation` row (writer protocol); session B
    appends a raw observation (`appendChainObservation`); same run. Barrier: both
    transactions are opened and ordered by the shared advisory lock (the test
    controls which acquires first). Expected: strict serialization on the one
    lock; no deadlock (one lock only, never held across network I/O, no second
    lock order); both commits land and the closing watermark reflects BOTH
    advances (`C` and `P` monotone); a transaction aborted mid-flight leaves its
    row absent AND its revision unadvanced; neither path exceeds the frozen 15 s
    transaction bound under a normal workload. Exit: per the run's final state;
    no report emitted afterwards carries a mixed watermark (E2E two sessions).

64. Derived events or causal graph update independently of a raw append.
    Durable inputs: chain at `C1` with its projection committed; a foreign
    normalization commit adds a `normalized_event` / `causal_relationship` row
    for the already-observed prefix AFTER the pass's stage 2. Expected: `D`
    advances ⇒ publication rejected ⇒ bounded re-analysis over the COMPLETE
    projection; the pre-commit PASS is never published; if the added projection
    is contradictory completeness evidence the re-analyzed verdict is
    NOT_EVALUABLE ⇒ **exit 2** (or FAIL when a lower-bound-safe FAIL is
    independently proven). Inverse assertion: a derivation that cannot commit
    atomically with `D` records the incompleteness marker, and an analysis
    observing a marked-incomplete projection fails closed (**exit 2/3**), never
    treating a partial projection as complete. Pointer/proof state: the
    stale-projection generation is superseded; nothing is published from it
    (E2E + U).

65. Setup stale-worker invocation appears after the terminal `SUCCEEDED`.
    Durable inputs: `S` fenced-terminal `SUCCEEDED` by G1 with a valid response;
    a late `step_invocation` row for `S` with `writtenByFencingToken IS NULL` at
    `REQUEST_SENT`, no response, no raw observation. Expected: the capture
    invalidates (`P`); per §5 null-safe attribution an unattributable generation
    can never be proven immaterial ⇒ `EVIDENCE_CONFLICT` ⇒ **exit 2**, unless a
    trusted eligible FAIL already exists (exit 1) or execution/integrity failure
    holds (exit 3). Durable state: the late row is preserved with its (null)
    attribution, the eligibility proof/report names it as a gap kind, and the
    anchor is never published as established. Never exit 0 (E2E; U for the
    null-safe predicate).

66. Unsent stale invocation with durable pre-send proof vs a sent or
    unrecorded invocation — three distinguishable variants. Barrier: three
    separately seeded durable states, each with an exact expected
    classification. (a) The step-level independent proof holds
    (`experiment_step_run.executingAt IS NULL`) and no generation has any
    recorded row ⇒ no stale generation exists ⇒ anchor stands (S-1/S-6a) and the
    eligible verdicts decide the exit. (b) A recorded stale generation with ONLY
    pre-send rows (`transportStage < REQUEST_SENT`, ≥1 row) and therefore no
    independent step-level proof ⇒ NOT immaterial under §5/v1 ⇒
    `EVIDENCE_CONFLICT` ⇒ **exit 2**, with its own named reason. (c) A stale
    generation with a `REQUEST_SENT`-or-beyond row, or no recorded row while a
    sent-but-unrecorded attempt is possible (the F-1 case: the row set is not a
    closed world) ⇒ `EVIDENCE_CONFLICT`, or `ANCHOR_UNPROVEN` when no
    terminal-owner response exists ⇒ **exit 2**. Assertions: (a) is the ONLY
    variant that can leave the anchor proven; the three variants produce
    DISTINGUISHABLE durable classifications and report reasons — a recorded row
    that exists is never conflated with a request that was physically sent but
    not recorded — and no variant produces exit 0 from an unsettled anchor. The
    ADR's epistemic-limit statement is asserted present in the report's
    limitation surface (E2E seeded three ways; U for the three predicates).

### 27. Implementation sequence (future phase; NOT this change)

1. Engine: `runScope` closed validation + freeze into `snapshot.target`
   (+ unit reject-cases for every named issue in §§3/6/12).
2. Evidence: fenced anchor derivation (§§5/11) + four-class
   `selectEligibleSubjects` at the analysis boundary (+ pure-function truth
   tables for §§4–6/8).
3. Evidence: anchor tuple + `eligibilityVersion` in `evidenceSetHash` +
   details; gated evaluator version `"generic-invariant/v1"`; old `'v1'`
   rows frozen as history.
4. Engine/worker: the truth-input head row + the §13 writer protocol — the
   `P` advance for EVERY truth-bearing non-chain writer (`markExecuting`,
   `writeTerminalState`, `recordInvocation`, `recordStaleWriter`, the
   `recovery.ts` lease/settle paths, the `reconciler.ts` dispatch markers, and
   the run terminal/cancel writes), acquired under the per-run lock FIRST,
   with per-run commits for multi-run sweeps (§26 cases 57–59/63/65).
5. Evidence: derived-projection commits advance `D` under the same protocol;
   a derivation that cannot commit atomically with `D` records the
   incompleteness marker (§26 case 64).
6. Persistence: the §13 additive migration (pointers + eligibility proof +
   `run_truth_input_head` + the watermark columns) + the two-stage Boundary A
   capture + the §13 composite publication validation (shared per-run advisory
   lock acquired first; `Wcurrent == W0` in every component; atomic proof +
   pointer generation write; bounded re-analysis) + freshness discipline (+
   concurrency tests, §26 cases 28–33/51–62).
7. CLI: `(key, subject)`-keyed verdict domain + set-based `classifyExit` +
   `eligibilitySummary` + `coverage` report surfaces (additive) +
   freshness-triggered bounded re-analysis + the §13 Boundary B finalization
   authorization transaction (shared per-run advisory lock; DB-only;
   READ COMMITTED; bounded; the composite watermark and all other DB-resident
   report inputs — including the normalizer/evaluator version surfaces —
   resolved under the lock; output strictly after commit) (§26 cases
   42–50/55/59).
8. Golden scenarios gain `runScope` (fixture-level addition; canonical
   experiment semantics unchanged).
9. Commit the §26 matrix (cases 1–66).
10. Independent audit.

### 28. Acceptance criteria

All 66 matrix cases green (E2E over real infrastructure where semantics
depend on it); the §13 finalization authorization holds its per-run lock
only over DB-local reads (never filesystem/stdout), output failure never
yields exit 0, and every report states a certified as-of watermark; the §13
analysis-side contract holds (a pass publishes only when its captured
composite `W0` equals the lock-scoped current truth-input state in every
component — chain, provenance revision, derivation generation — and every
proof row and pointer names the composite analysis state it was analyzed at,
with no component left at a superseded value; all report bytes derive from
values frozen by the authorization transaction); every truth-bearing
non-chain writer advances its revision in the same transaction as its write
under the per-run lock (cases 57–59/63/65) and no partially derived
projection is ever read as complete (case 64);
shuffle-seed order-independence demonstrated (including
pointer/publication order and verdict-row insertion order); Incident Zero +
Controlled Faults + Phase 16 suites green unchanged;
`target-manifest/v1` byte-unchanged; the §13 additive migration reviewed,
reproducible, and testable (R-12) with old rows provably untouched; no
evaluator-function change for the verdict core (proven by the Phase 15
truth tables staying green unmodified — only the input domain, hash inputs,
and version string change as frozen here); no timestamp/UUID ordering in
any current-truth path (proven by reversed-order tests); no staged/commit/
tag/push outside the authorizing phase workflow.

### 29. Risks

- **Worker `processJob` catch execution proof still outstanding** (audit gap):
  the 21 helper-driven tests exercise the production-used emergency
  function, not the actual catch block — a real BullMQ exception path with
  post-send persistence failure and authoritative fenced terminal outcome must
  still be committed. Independent verification obligation, not part of this
  design.
- Legacy-compat mode preserves the old hazard for pre-`runScope` snapshots by
  design (labeled, documented) — historical replay intent wins over retroactive
  strictness.
- Top-level-only response-field projection may prove too narrow for a future
  target (→ deliberate `run-scope/v2`, never silent extension).
- Single-setup-step assumption: multi-scope experiments are deferred beyond
  v1.1; a second scope needs a new ADR, not an ad-hoc second anchor.
- Target restore-from-backup reusing generations surfaces as anchor conflict
  ⇒ honest NE, never silent truth.
- Pointer staleness under write-heavy evidence appends: the bounded
  re-analysis discipline (§13) bounds report latency; pathological append
  rates fail closed to exit 2 rather than hanging the report.
- Finalization lock contention: the authorization transaction holds the
  per-run append lock only over bounded DB-local reads; lock/statement
  timeouts fail closed (exit 3) and release cleanly; append transactions
  keep their own independent 15s bound, so neither path can hang the other
  indefinitely.
- Analysis-side bounded re-analysis cost: a pass that keeps losing the
  publication race re-reads evidence at most the frozen bound times; at
  pathological append rates it fails closed (exit 2/3) rather than chasing
  the head. One bound constant governs both boundaries, so worst-case report
  latency stays finite and measurable.
- Strict-coverage authoring cost: scenarios must declare the complete
  intended subject set; under-declaration yields honest NE, which is the
  intended pressure toward complete declarations.
- Truth-input protocol cost (B-3): every truth-bearing non-chain write now
  takes the per-run advisory lock and does one extra row touch. The lock is
  held only over the DB-local write (never across the send), the append path's
  own lock discipline is unchanged, and there is still exactly one lock key, so
  append and provenance writers serialize without a second lock order or a
  deadlock cycle. A write-heavy run therefore serializes provenance writes per
  run; that is the price of making anchor truth detectable, and it fails closed
  (abort + exit 3) rather than writing a row whose revision could not be
  advanced.
- Tighter immateriality ⇒ more NOT_EVALUABLE (B-3/F-1): a run whose setup step
  had a stale generation can no longer be declared immaterial from recorded
  pre-send rows, so such runs fail closed to exit 2. This is deliberate
  conservative uncertainty (R-02), not a regression; the recorded invocation
  rows remain preserved and attributed, and the report names the exact reason.
- Derivation-protocol adoption: until every derived writer commits under the
  protocol, a foreign projection commit is covered only by the analysis's own
  derivation step and must be treated as unverified — the sequence above makes
  that adoption an explicit implementation obligation, not an assumption.

### 30. Rejected alternatives

1. **Observed-only binding (eligible = subjects named in the run's own step
   responses; no frozen declaration).** Authority: run's response observations.
   Rejected: response-loss/empty-response runs become structurally
   unevaluable; response shapes are target-specific (platform would parse
   target dialects); replay variance in response content. Kept only as
   corroborating provenance, not the gate.
2. **Target exclusivity/reset as precondition (option D — fresh/hermetic
   target per run, all observed subjects eligible).** Authority: environment
   hygiene. Rejected: contradicts complete-collection inspection and the
   audited shared-target reality; makes CI hermeticity a semantic
   requirement; cannot separate sequential runs on one target; the audit
   already cleared shared-target operation with scope reset + generation
   advance. Reset stays a *hygiene practice*, never proof.
3. **Global-latest-generation / last-observation-wins.** Authority: recency.
   Rejected (forbidden): racy under interleaved runs; cross-scope generation
   comparison is meaningless; DB-row-order and timestamp reasoning violate
   evidence-model §6 and ADR-0017.
4. **Causal reachability from run invocations as the sole gate (option C).**
   Authority: ACTIVE graph paths from own `requestAttemptId`s. Rejected as
   the gate (kept as corroboration): depends on target linkage completeness,
   so thin-linkage targets would be permanently NE despite a solid anchor;
   SKU/baseline facts have no invocation lineage to traverse; conflates
   attribution strength with eligibility. The anchor-equality gate is strictly
   smaller and covers both subject kinds uniformly.
5. **Durable `run_scope_binding` table as the SOLE anchor store (anchor
   persisted without evidence linkage).** Rejected in that form: the anchor
   is derived truth (frozen intent + observed evidence) and must remain
   re-derivable from those sources; the §13 records materialize the
   SELECTION (pointers + proof), never a standalone anchor divorced from
   its observation hashes and fencing facts (every proof row cites them).
6. **Report-only filtering (drop foreign findings at emission).** Rejected:
   persisted evaluations would still lie; the fix belongs at the evaluation
   eligibility boundary.
7. **Timestamp/UUID current-truth selection (`completedAt`/`createdAt`/`id`
   ordering).** Rejected (P-06): orders writes, not truth; racy under
   concurrent re-analysis; violates evidence-model §6. Replaced by §13
   pointers.
8. **Silent multi-field scope mapping (ignore additional `scopeBinding`
   fields, or guess aliases).** Rejected (P-02): replaced by the exact
   single-field rule with named rejection (§6).
9. **Latest-wins stale-anchor resolution.** Rejected (P-03): replaced by
   terminal-owner authority with preserved stale provenance and fail-closed
   conflict (§5).
10. **Foreign-FAIL-as-business-FAIL conversion (or silent omission).**
    Rejected (P-07): replaced by the single anomaly rule (§15).
11. **Vague bounds ("bounded string", "well-formed name").** Rejected (P-04):
    replaced by the exact table (§12).
12. **"No migration" as a design constraint.** Rejected where it costs
    authority: the first proposal's zero-migration preference produced the
    timestamp-ordering defect. The §13 additive migration is the honest
    price of deterministic current truth.

**Selected:** frozen `runScope` intent + observed fenced setup-response anchor
with exact equality + declared-membership partition gate with coverage
anomalies (§§3–8) + persisted current-evaluation references with
evidence-chain watermarks (§13) + set-based multi-subject exit reduction
(§14). It is the smallest mechanism that binds both subject kinds
generically with no manifest change and honest additive persistence.

### 31. Anti-laundering guarantees (normative MUST-NOT list)

The eventual implementation MUST NOT: pass `if secure then PASS`; delete or
recolor foreign findings at report time; drop a FAIL row because a PASS row
shares its key; sort PASS last to win a collapse; evaluate only the first
result per key; aggregate `latest per key` across distinct subjects; select
any current row by timestamps, DB order, UUID order, `first`/`last`/`winner`
heuristics, or generation recency; convert a foreign FAIL into an eligible
business FAIL; omit a persisted unexpected evaluation silently; adopt the
head current at publication time as the analysis watermark; publish
H0-derived results under a watermark naming a head the pass did not analyze;
leave a superseded-head watermark on a current pointer or proof row; mark a
pointer current by reusing a prior PASS without rechecking every evaluator
input, eligibility, completeness, and scope/coverage condition against the
new head; publish a partial proof/pointer generation; produce exit
0 with a coverage anomaly, a missing verdict, a missing pointer, or a stale
pointer past bound on record; interpolate scope into inspection URLs
(ADR-0022 stands); infer missing baselines/totals/generations; resolve
credential/secret material through `runScope` values; use
`StepInvocation.responseBody` as business authority; guess field-name
aliases across the anchor/inspection boundary; coerce types across the
anchor boundary; publish or authorize against a truth-input watermark whose
provenance-revision or derivation-generation component does not match the
locked state; treat a recorded pre-send invocation set as proof that no
request was sent (F-1); advance a revision without its write, or commit a
write without its revision; hold the per-run advisory lock across a physical
request; read a partially built derived projection as complete; claim that a
database lock prevents an in-flight external request. Persisted business
evaluations MUST equal the run-eligible
subject domain; current truth MUST equal the persisted pointers; the report
MUST serialize durable truth including the eligibility summary and coverage.

## Consequences

- F-3, EXIT-MAP-COLLAPSE-LAUNDERS-FAIL, and subject-set laundering become
  implementable without weakening any accepted contract: inspection stays
  complete, evaluators stay frozen, the manifest stays closed, snapshots stay
  logically append-only / hash-pinned, and replay stays intent-based.
- Exit 0 regains a statable meaning: COMPLETED + integrity-verified + every
  declared eligible subject evaluated PASS at the authoritative evaluator
  version + zero anomalies + fresh pointers — with the proof (anchor +
  domain + coverage + pointers) serialized in the report.
- Cost accepted: scenarios carrying generic bindings must declare `runScope`
  (one closed block with exact bounds); targets without a scope/generation
  surface yield honest NOT_EVALUABLE, never PASS; one honest additive
  migration materializes current truth instead of timestamp ordering.

## Self-audit addendum (analysis-watermark closure session)

Design-only. No runtime change, test, migration, staging, commit, tag, or
push was performed; this addendum records the repair reasoning for the next
independent sign-off.

**Audit finding accepted in full.** The prior revision froze Boundary B
(report authorization) soundly but left Boundary A (analysis watermark
capture) unfrozen. The concrete counterexample: an append committing during
an analysis pass — after the pass read evidence, before its pointers were
published — was excluded from a decision whose pointer watermark was later
published as if it covered that evidence; the report-side checks could not
see it, and exit 0 could be emitted over an unevaluated prefix. The report's
clause "pointers that confirm identical heads stay" also directly
contradicted authorization check 6 (every pointer watermark must equal the
locked head). Both are repaired in §13.

**Repairs made (design text only).**

1. **Before-read H0 capture** (§13, Boundary A): the pass captures
   `H0 = (headContentHash, observationCount, lastChainIndex)` from a single
   head-row read before any business-evidence read; derived results belong
   to H0 only and the publication-time head is never adopted as the analysis
   watermark. Snapshot discipline forbids a transaction snapshot older than
   the H0 capture (READ COMMITTED analysis reads; a stable snapshot, if ever
   wanted, must be taken at or after the H0 read and H0 re-compared under the
   publication lock).
2. **Lock-scoped publication validation** (§13): the SAME per-run advisory
   lock the append primitive uses, acquired FIRST at READ COMMITTED, then
   `Hcurrent == H0` (all three fields), the derivation binding, the
   run/version/generation preconditions, and one atomic write of the proof
   row plus every pointer under one `analysisGeneration` carrying H0.
3. **Rejection path** (§13): `Hcurrent != H0` ⇒ DO NOT PUBLISH; the
   attempted generation writes nothing; bounded re-analysis begins with a
   fresh H0; exhaustion fails closed (exit 2 business staleness / exit 3
   verification-not-performable); no stale PASS, no partial pointer
   publication, no last-writer-wins, no reinterpretation of changed evidence.
4. **Confirmed evaluation rows** (§13): the liveness contradiction is
   resolved — a historical row E may be reused only after a full recheck
   against the new head (never because it PASSed before), and reuse still
   publishes a NEW `analysisGeneration`, a proof row certified for the new
   head, and new-watermark pointers atomically; E's `evidenceSetHash` never
   changes; a superseded watermark is never left on a current pointer or
   proof row. The withdrawn wording is marked as withdrawn in place.
5. **Two boundaries** (§13): Boundary A and Boundary B are frozen
   explicitly, with the relative order (publication commits before
   authorization acquires the lock) and the statement that no finite extra
   reads substitutes for either.
6. **Verified-prefix binding** (§13): an out-of-lock chain verification
   authorizes nothing by itself; the locked identity must exactly equal the
   verified triple, or verification is redone (bounded) / the run fails
   closed.
7. **Cases 51–56** (§26) added with durable inputs, timing/interleaving,
   expected publication, resulting pointer/proof state, and verdict/exit
   behavior; §27 sequence and §28 acceptance updated to the 56-case matrix
   and the analysis-side acceptance criteria.
8. **R-18 terminology corrected**: the three overstated phrases
   ("immutable evidence prefix", "immutable by construction", "immutable,
   content-addressed") are replaced with logically-append-only / hash-pinned
   wording and an explicit disclaimer of physical database immutability,
   DBA-tamper-proofness, and cryptographic non-repudiation; the three
   remaining "immutable snapshot" phrasings are corrected to the repo's
   standard logically-append-only / content-addressed vocabulary
   (ADR-0006, phase-0 audit precedent).
9. **Precision clarifications applied**: `lastChainIndex` must agree with
   the count-implied ordinal (else exit 3) or is display-only and never a
   decision input; the proof row's watermark is compared (not merely read)
   against the locked head alongside every pointer watermark; READ COMMITTED
   is frozen explicitly with no isolation override on either path; no
   post-authorization live read may alter authorized bytes — the DB-resident
   report inputs including `loadNormalizerVersions` are resolved under the
   lock, with only `reportId`/`generatedAt` generated after commit; and the
   bounded-retry constant plus terminal staleness classification are defined
   and shared by both boundaries.

**Consistency sweep.** No contradictory older text remains for analysis
watermark capture, publication watermark, confirmed pointer reuse,
`analysisGeneration`, head consistency, as-of certification, or logical
append-only semantics: the only surviving occurrences of the superseded
phrasing are the explicit withdrawal note and the revision note that
documents the correction. P-01–P-08 and the report-side contract were not
reopened or altered in architecture.

**Known limitations of this addendum.** It is a design document; the bound
constant, the empty-chain `lastChainIndex` meaning, and the lock/statement
timeout values remain implementation constants to be fixed and tested in the
implementing phase (they are frozen here as *contract*, not as chosen
numbers). The ordinary-RLS/privilege-level mutation of database rows is
outside this ADR's guarantees (R-18): the append discipline is enforced by
the lock contract, not by the storage engine.

## Self-audit addendum (B-3 truth-input closure session)

Design-only. No runtime change, test, migration, staging, commit, tag, or push
was performed; this addendum records the repair reasoning for the next
independent sign-off.

**Audit finding accepted in full.** The prior revision froze Boundary A and
Boundary B over the raw-evidence chain only, and the independent audit's B-3
finding showed the consequence: the analysis also derives anchor authority and
eligibility from run-scoped execution provenance (`control.experiment_step_run`,
`control.step_invocation`, `control.stale_writer_event`) that is written
outside the chain and outside the per-run advisory lock, so a late
`step_invocation` append can invalidate a published anchor while the chain head
is byte-identical — the same defect class as B-1, one table over. The concrete
counterexample was a stale setup generation whose `recordInvocation` committed
after the pass's invocation read and before publication (response lost, so no
raw observation and no chain advance): the anchor was published as established
and exit 0 became reachable where §5 S-16 requires NOT_EVALUABLE.

**Repairs made (design text only).**

1. **Composite truth-input watermark** (§13): `W = (C, P, D)` — the chain
   identity, the provenance revision, and the derivation generation — replaces
   "the chain head is the analysis watermark"; a naming rule makes every earlier
   `H0`/`Hcurrent`/`H1` reference explicitly the chain COMPONENT.
2. **Writer protocol** (§13): every truth-bearing non-chain writer takes the
   same per-run advisory lock FIRST, performs its write, advances `P` (or `D`)
   in the SAME transaction, and commits; one lock only; never held across the
   network; the write stays unfenced (R-10/ADR-0009 preserved); multi-run
   atomicity is refused rather than reordered.
3. **Two-stage Boundary A capture** (§13): stage 1 before-read `(C1, P1)`, the
   pass's own derivation under the protocol, then a stage-2 `W0` capture; the
   publication-time state is never adopted; the snapshot discipline covers the
   new head reads.
4. **Publication validation** (§13): `Wcurrent == W0` in EVERY component, with
   one proof row and all pointers bound to `W0` and one `analysisGeneration`,
   atomically; a mismatch publishes nothing and re-analyzes under the shared
   bound.
5. **Boundary B** (§13): the authorization reads the composite under the lock
   and compares the proof row's AND every pointer's provenance/derivation
   components against it; an old provenance or derivation version with a
   current chain head is an eligibility inconsistency, never a PASS; the
   certified as-of statement and the output discipline now name the composite.
6. **Derived-projection completeness** (§13): derived commits advance `D`; a
   derivation that cannot commit atomically with `D` must record an
   incompleteness marker that fails closed; raw observations never advance `D`
   and derived rows never advance `C`.
7. **Epistemic limit stated** (§13): a watermark proves a statement about
   durable rows and never that an unrecorded send did not happen; the only
   independent durable pre-send proof is `experiment_step_run.executingAt IS
   NULL` (F-1).
8. **Stale-generation immateriality withdrawn** (§5): the "recorded rows all
   pre-send ⇒ immaterial" exemption is unsound under the repo's own frozen F-1
   rule and is replaced by the independent step-level proof (S-6a); S-6 now
   fails closed. This can only REDUCE PASS, never create one.
9. **No-op contradiction corrected** (§13): "Same `evidenceHeadHash` ⇒ no-op"
   is replaced by the complete-watermark no-op condition; a confirmed
   evaluation at a newer `W` re-publishes proof, pointers, and
   `analysisGeneration` atomically.
10. **Cases 57–66 + barrier discipline** (§26): durable inputs, deterministic
    advisory-lock barriers (never sleeps), expected publication, revision and
    pointer state, exit class, and report provenance; §27 sequence and §28
    acceptance updated to the 66-case matrix (cases 1–56 keep their content).

**Coverage proof.** §13's truth-input coverage table places every mutable
durable input the analysis reads in class A (chain + append lock), B (writer
protocol), C (deterministic projection marked by `D`), or D (frozen intent).
Nothing outside those classes is read by eligibility, the anchor, completeness,
or a verdict; an input that ever appears outside them must fail closed and be
named a residual blocker.

**Honest residuals.** (i) The derivation-generation rule requires derived
writers to commit under the protocol; until that lands, a projection committed
outside it is covered only by the analysis's own derivation (stage 2) and must
be treated as unverified. (ii) The tightened immateriality rule increases
NOT_EVALUABLE pressure for runs whose setup step had a stale generation —
deliberate, conservative, and reversible only by a future design that writes a
durable PRE-SEND marker before the physical send (out of scope here: it would
change execution semantics and needs its own ADR). (iii) The ordinary
RLS/privilege-level mutation of database rows remains outside this ADR's
guarantees (R-18): the revision discipline is enforced by the lock contract,
not by the storage engine.

**Consistency sweep.** No contradictory older text remains for the analysis
watermark's coverage, publication validation, pointer correctness, provenance
or derivation revisions, the stale-generation immateriality exemption, or the
no-op condition: the only surviving occurrences of the superseded wording are
the explicit withdrawal notes and the revision accounts above. P-01–P-08, the
`runScope` contract, the report-side contract, and the B-1 chain discipline are
reopened in no respect.
