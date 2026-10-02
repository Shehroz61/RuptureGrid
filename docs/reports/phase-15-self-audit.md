# Phase 15 Self-Audit — Invariant Registry + Finding Registry

Session: Phase 15 builder on branch `main` (starting HEAD `3123321`
= "docs: freeze Phase 15 completeness and scope proof"). Uncommitted
by phase-boundary design. Every number in this report was observed in
a terminal in this working tree during this session; nothing is
claimed that was not run.

> **REPAIR SESSION ADDENDUM (read first).** The first INDEPENDENT
> adversarial audit of this phase returned **FAIL — REPAIR REQUIRED**
> with exactly two blockers and a set of narrow hardening findings.
> This fact is not erased: the original claims below stand as the
> builder's first-pass record, and the repair session that follows the
> original report describes exactly what changed in response. The two
> blockers were contract-level, not gate failures — all execution gates
> had passed independently before the audit verdict.

Starting-state proof (run at session start and re-verified at end):

- `git rev-parse HEAD` → `312332156e31a42188e6e55afb92261e076caf1b`
- `git log -1 --oneline` → `3123321 docs: freeze Phase 15 completeness and scope proof`
- `git rev-parse 'phase-14-accepted^{commit}'` → `ea26e31c389beaae1ff4df6fb2482287e6e59f81`
- working tree: only Phase 15 changes; nothing staged.

## A. Starting state / pre-flight

Pre-flight passed fail-closed: HEAD matched the required commit, the
historical tag resolved to `ea26e31c…`, the tree was clean apart from
Phase 15 work, and `git diff --check` was clean. No historical tag was
moved; no commit, stage, tag, or push was performed.

## B. Authoritative contracts read

Read in full before editing: `AGENTS.md`; `docs/product-spec.md`;
`docs/architecture.md`; `docs/evidence-model.md`;
`docs/testing-strategy.md`; `docs/phase-roadmap.md`;
`docs/checkout-zero.md`; ADR-0004, ADR-0006, ADR-0007, ADR-0010,
ADR-0016, ADR-0017, ADR-0018, ADR-0020, ADR-0021, ADR-0022, ADR-0023.

## C. Existing implementation inspected

Read before design: `packages/evidence/src/{invariants,derive,
generic-derive,generic-normalizer,generic-inspection,index,versions}.ts`;
`packages/engine/src/{manifest,snapshot,types}.ts`;
`packages/forensics/src/{finding,index}.ts`;
`packages/control-db/prisma/schema.prisma` and all prior analysis
migrations; the actual analysis/API wiring in `apps/api`
(`runRunAnalysis` in the evidence package, invoked by the API analysis
endpoints; forensics derivation via `deriveRunForensics`). All prior
INV-IZ-1 / INV-DF-1 / INV-DF-2, finding-derivation, persistence,
idempotency, and hashing tests were read.

## D. Closed registry (business-invariant/v1)

- One authoritative registry module:
  [generic-invariant-registry.ts](../../packages/engine/src/generic-invariant-registry.ts).
  It lives in `packages/engine` (not `packages/evidence`) because
  definition-time validation runs where experiment documents and run
  snapshots are produced, and the engine must not import the evidence
  package. ADR-0023 does not name a package for the registry, so this
  placement does not contradict any documented decision.
- One platform constant:
  `BUSINESS_INVARIANT_REGISTRY_VERSION = 'business-invariant/v1'`.
  `registryVersion` (definition protocol identity) is kept strictly
  distinct from `evaluatorVersion` (evaluation semantics:
  `GENERIC_INVARIANT_EVALUATOR_VERSION = 'v1'` in evidence; legacy
  evaluators keep their frozen versions) and from
  `GENERIC_FINDING_RULE_VERSION = 'generic-finding-rule/v1'` in
  forensics.
- Exactly two kinds — `atMostOneAcceptedEffect`, `resourceConservation`
  — with the exact ADR-0023 §6 params shapes. JSON objects are closed:
  unknown keys are rejected, nothing is silently dropped or coerced.
- Definition validator produces deterministic named issues, including
  `UNKNOWN_REGISTRY_VERSION`, `UNKNOWN_INVARIANT_KIND`,
  `UNKNOWN_PARAMS_KEY`, `UNDECLARED_ROLE`, `UNDECLARED_QUERY_ID`,
  `MALFORMED_COMPLETENESS_PROOF`, `MALFORMED_SCOPE_BINDING`,
  `MALFORMED_ACCEPTED_MATCH`, `INVALID_GENERATION_FIELD`,
  `MALFORMED_INVARIANT_BINDINGS`, `DUPLICATE_INVARIANT_KEY`.
- Validation fires at definition time (`createExperiment` validates
  `invariantBindings` against the frozen manifest evidence policy) and
  again at the snapshot freeze seam (`packages/engine/src/snapshot.ts`
  rejects bindings on a manifest-less target and freezes derived,
  re-validated instances into `target.invariantBindings` when
  non-empty). A definition that fails validation can never be frozen
  and never reaches evaluation — verified by integration tests.

## E. atMostOneAcceptedEffect evaluator

Pure evaluator in
[generic-invariant-evaluate.ts](../../packages/evidence/src/generic-invariant-evaluate.ts);
truth table: 25 tests.

- Candidate population from the declared subject role; semantic dedup:
  convergent duplicate observations of one effect identity count once
  (ORD-D1 + ORD-D2 are distinct identities and count as 2; a
  duplicated observation of one reservation counts once — resource
  row 4b proves the same machinery).
- Attribution only through the active Phase 14 causal graph.
- Lower-bound-safe FAIL: missing additional captures never undo an
  already-proven FAIL (integration rows 17/18).
- Completeness PASS gate: PASS requires the `observed-total` summary
  to converge with the attributed count; a valid `[]` with summary
  total 0 PASSES (zero-effect completeness, §3).
- Scope/generation coherence enforced via `scopeBinding`.
- Capture requirements: a failed required capture degrades every
  verdict to honest `NOT_EVALUABLE` — never a `[]` PASS (row 14).
- Gaps: contested identity ⇒ `CONTESTED_IDENTITY` (fires on
  candidate-worthiness, including derivation-contested events);
  contested baseline ⇒ `BASELINE_MISSING`; foreign-scope summaries are
  skipped as unbound per §2.4 and surface as an enumeration-
  completeness gap, never `SCOPE_INCOHERENT`.

## F. resourceConservation evaluator

Pure evaluator, same module; truth table: 38 tests.

- Baseline and remaining authority are the explicitly declared roles
  (§5) — never event order or timestamps.
- Consumption sum is over distinct attributed accepted reservations
  with semantic dedup.
- Case A: attributable consumption > baseline ⇒
  `RESOURCE_CONSERVATION_EXCEEDED_BASELINE` (no completeness needed —
  lower bound). Case B: authoritative remaining < 0 ⇒
  `RESOURCE_CONSERVATION_NEGATIVE_REMAINING`. Case C: complete
  evidence with baseline − consumption ≠ remaining ⇒
  `RESOURCE_CONSERVATION_MISMATCH`.
- PASS requires every gate, including no invalid remaining records and
  proven completeness.
- Failure priority (rule-9 order): contested evidence → type-invalid
  units → scope mismatch → `BASELINE_MISSING` → contested remaining →
  remaining contradiction → `REMAINING_MISSING` → capture gap →
  summary conflict → attribution gap → enumeration gap. Case A
  outranks Case B when both fire (precedence test, row at
  `generic-invariant.resource.test.ts:737`).

## G. Completeness proof

- `observed-total` is a CHECKED count, not a trusted claim: the
  summary row must be a captured, valid, bound observation whose total
  converges with the attributed count.
- Summary cardinality (§2.4): multiple bound coherent summaries
  converge; conflicting totals ⇒ summary conflict (contradiction, not
  selection); foreign-scope summaries are skipped as unbound.
- Zero-effect completeness proven by CHK-ZERO (valid `[]` orders +
  summary total 0 ⇒ PASS) in integration.
- Valid `[]` vs failed capture: integration rows 14/17/18 prove a
  valid empty set PASSES while a failed effect-surface capture can
  never PASS and never undoes a FAIL.
- Multi-query behavior: failed primary effect surface ⇒ every verdict
  degrades to honest `NOT_EVALUABLE` (integration test).

## H. Active graph

- Stale relationships are excluded from the active graph before
  attribution (Phase 14 discipline, reused unchanged).
- Late conflict: a contested identity endpoint removes its edges from
  the active graph and forces `CONTESTED_IDENTITY` — proven by the
  integration test that injects a conflicting archive row for ORD-D1
  (B-2/B-3).
- Restart reconstruction: analysis reruns read durable rows only and
  reproduce identical evaluation hashes and verdicts (integration
  restart-determinism test).

## I. Evaluation persistence

- Evaluator version `v1` for generic evaluators; `registryVersion` is
  copied into evaluation details, and `isGenericEvaluation`
  discriminates generic rows by `details.registryVersion ===
  'business-invariant/v1'` + kind — required because legacy evaluators
  also report `'v1'`.
- `evidenceSetHash` is a deterministic canonicalized hash of the
  evaluation input evidence (`genericEvidenceSetHash`).
- Idempotency: upsert keyed by
  `(runId, invariantKey, evaluatorVersion, subjectKey, evidenceSetHash)`
  with P2002 re-read; three concurrent analysis passes leave the row
  count unchanged (integration).
- Frozen definition source: evaluation reads the snapshot's frozen
  invariant bindings, re-validated against the frozen policy
  (fail-closed); the live manifest is never consulted during analysis.
- Target HTTP during analysis: **NO** — the analysis modules contain
  no HTTP client usage (verified by source scan) and the
  restart-determinism test runs the full analysis twice against
  durable rows only.

## J. Finding registry

- Exactly four new `FindingReasonCode` values:
  `TOO_MANY_ACCEPTED_EFFECTS`,
  `RESOURCE_CONSERVATION_EXCEEDED_BASELINE`,
  `RESOURCE_CONSERVATION_NEGATIVE_REMAINING`,
  `RESOURCE_CONSERVATION_MISMATCH`
  ([generic-finding.ts](../../packages/forensics/src/generic-finding.ts)).
- PASS findings: **zero**. NOT_EVALUABLE findings: **zero**. Only
  persisted FAIL evaluations route to finding derivation
  (`deriveRunForensics`), and the frozen legacy
  `DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT` rule is untouched.
- Minimal proof sets (evaluation, counted effect events, attribution
  relationships, source observations) and a deterministic input
  fingerprint (canonicalized `{findingRuleVersion, sourceEvaluation,
  proofReferences}`); persistence idempotent on
  `(invariantEvaluationId, findingRuleVersion)`.

## K. INV-IZ-1 conformance

Conformance suite: 7 tests — PASS, FAIL, and NOT_EVALUABLE
attribution-gap cases agree with the frozen `evaluateInvIz1` on
equivalent evidence semantics (verdicts only, never reason strings).
`evaluateInvIz1` was NOT modified; the frozen evaluator's implicit
Demo-lineage completeness is supplied explicitly to the generic
evaluator, never by weakening the new completeness requirement.

## L. Truth-table tests (committed, rerunnable)

- `atMostOneAcceptedEffect`: 25 tests.
- `resourceConservation`: 38 tests.
- Definition reject matrix: 15 tests.
- Conformance: 7 tests.
- Adversarial additions beyond the frozen table: semantic-dedup
  double-count guard (4b), Case A/B precedence, contested-twin
  identity incoherence, foreign-summary skip behavior, restart
  determinism, concurrency idempotency.
- Total generic suites: 85/85 green.

## M. Integration proofs (real PostgreSQL + real HTTP fixture)

13 tests in
[phase15-generic-invariants.test.ts](../../../tests/integration/phase15-generic-invariants.test.ts),
all passing: frozen-binding round-trip; definition-time rejection
(never stored, frozen, or evaluated); manifest-less-target rejection;
atMostOne PASS (CHK-ONE); atMostOne FAIL with deterministic Finding
(CHK-DUP, finding linked by `invariantEvaluationId`); semantic dedup;
Case A/B/C verdicts with per-case mechanisms (SKU-A PASS; SKU-B
`RESOURCE_CONSERVATION_NEGATIVE_REMAINING`; SKU-C
`RESOURCE_CONSERVATION_MISMATCH`) and per-case finding reason codes;
idempotency + concurrency; restart determinism (identical hashes from
durable rows); valid `[]` vs failed capture; multi-query denial;
contested identity; registry closure.

Honest note: the integration fixtures carry complete evidence, so
Case A *incomplete enumeration* is proven by the unit truth table
(lower-bound-safe rows 3/4/15 in `generic-invariant.resource.test.ts`),
not by an integration scenario.

## N. Legacy compatibility

- INV-IZ-1 / INV-DF-1 / INV-DF-2 suites re-run this session: legacy
  evidence/invariant suites 81/81; forensics suites 53/53 (includes
  reproduction tests over the timeline fingerprint); full unit suite
  564/564.
- Legacy finding rule untouched; Incident Zero verifier **PASS**
  (frozen intent 5/5; VULNERABLE 25/25; SECURE 21/21); Controlled
  Faults verifier **PASS** (PRE_MUTATION_REJECTION 18/18 ×2;
  RESPONSE_LOSS 22/22 ×2; leakage: none).

## O. Phase boundaries

Demo Commerce: not implemented. CLI: not implemented. Replay: not
implemented. Third invariant kind: none. target-manifest/v1: unchanged.
AI as truth: none. No Phase 16–18 features were pulled in.

## P. Phase 13 NB-1

OPEN. Not solved here, per scope.

## Q. Gates (all run in this session, exact counts)

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS (after formatting the 11 new files) |
| `pnpm lint` | PASS (0 errors) |
| `pnpm typecheck` | PASS (incl. `tsc -p tsconfig.checks.json` clean) |
| `pnpm test:unit` | PASS — 564/564 across 49 files |
| `pnpm build` | PASS (db:generate + build:packages + build:apps) |
| Migration apply | PASS — control-db: 7 migrations, none pending (0007 additive only) |
| `pnpm test:integration` | PASS — 198/198 across 27 files (includes Phase 15's 13/13) |
| `pnpm incident-zero:verify` | PASS (assertion counts above) |
| `pnpm controlled-faults:verify` | PASS (assertion counts above) |
| `git diff --check` | clean |

Generic suites individually: atMostOne 25/25, resource 38/38, rejects
15/15, conformance 7/7, integration 13/13.

## R. First-run flakes/failures

NONE. All gates passed on the runs reported above. Defects found and
fixed during the session (not flakes): test-side lookup used a
non-existent `evaluationId` field (actual: `invariantEvaluationId`);
a mechanism expectation asserted Case A where the fixture proves Case
C; the restart-determinism row filter matched legacy `'v1'` rows and
was narrowed to the generic invariant keys; a dead local counter and
an unused type import were removed; a test mutated a readonly fixture
field that was already in the required state.

## S. Remaining known limitations

1. Case A incomplete enumeration is covered by unit tests only (see
   M's honest note).
2. Legacy and generic evaluators share `evaluatorVersion = 'v1'`
   because legacy semantics are frozen; discrimination is via
   `details.registryVersion` + kind (`isGenericEvaluation`), and the
   restart test filters by invariant-key whitelist. Phase 15 evaluator
   semantics changes must increment `evaluatorVersion`.
3. `invariant_definition` generic columns are nullable by design
   (additive migration; legacy rows keep null kind/params).
4. The integration fixture registers its origin persistently; the
   harness is idempotent on origin reuse (`ensureManifestTarget`).

## T. Independent audit focus

1. **False PASS from incomplete multi-query capture** — attack the
   capture-status gate: every declared PASS-required query must be
   valid+captured; see integration rows 14/17/18 and unit capture
   rows.
2. **Semantic-effect double counting** — convergent duplicates count
   once; distinct identities never collapse (ORD-D1/ORD-D2; 4b).
3. **Stale relationship use** — active-graph exclusion before
   attribution; contested endpoints removed (B-2/B-3 integration).
4. **Completeness-summary contradiction precedence** — conflicting
   summaries must contradict, never select (§2.4); foreign summaries
   skip, not conflict.
5. **Resource failure priority** — rule-9 order and Case A > Case B
   precedence (resource row at :737).
6. **Case B remaining authority** — remaining comes only from the
   declared remaining role; negative authoritative remaining is Case B
   even when arithmetic looks fine.
7. **Frozen-snapshot vs live-definition drift** — evaluation must read
   frozen bindings only; `loadFrozenGenericInstances` re-validates
   fail-closed; live manifest never read at analysis time.
8. **Finding layer re-evaluating truth** — findings derive only from
   persisted FAIL rows; details are copied, never recomputed.
9. **evidenceSetHash determinism** — canonicalized input hash;
   restart test asserts hash equality across analysis passes.
10. **Legacy evaluator regression** — frozen evaluators untouched;
    conformance suite plus 81/81 legacy evidence/invariant tests and
    Incident Zero/Controlled Faults verifiers.

## U. Repository state

- staged: **NONE**
- commit: **NONE**
- tag: **NONE**
- push: **NONE**

HEAD remains `312332156e31a42188e6e55afb92261e076caf1b`;
`phase-14-accepted` remains `ea26e31c389beaae1ff4df6fb2482287e6e59f81`;
all Phase 15 work is left uncommitted in the working tree.

## V. Final decision

**READY FOR PHASE 15 INDEPENDENT AUDIT**

---

# Repair Session — Phase 15 Blocker Repair + Narrow Forensic Hardening

Base HEAD unchanged: `312332156e31a42188e6e55afb92261e076caf1b`
(`phase-14-accepted` = `ea26e31c389beaae1ff4df6fb2482287e6e59f81`).
Nothing staged, committed, tagged, or pushed. No Phase 16 content, no
third invariant kind, no target-manifest/v1 change, no frozen legacy
evaluator modification.

## R-1. What the independent audit found (FAIL — REPAIR REQUIRED)

- **B-1 (contract blocker).** ADR-0023 §8 `resourceConservation` rule 1
  stated a verdict-terminal "no authoritative baseline ⇒ NOT_EVALUABLE
  (BASELINE_MISSING)" BEFORE Case B, contradicting ADR-0018's explicit
  "except where a lower-bound-safe FAIL (Case A; Case B with an
  authoritative remaining observation) is already independently
  proven" and ADR-0023's own Case-B paragraph ("baseline and
  consumption completeness are not required") and truth-table rows 5/17
  (baseline absent + remaining −1 ⇒ FAIL Case B). The implementation
  already implemented the intended semantics; the accepted contract
  text contradicted it.
- **B-2 (unfrozen truth-relevant semantics).** Negative baseline and
  negative consumption-unit semantics were not frozen in any ADR. The
  implementation treated a negative baseline as EVIDENCE_CONFLICT but
  a negative consumption-unit value as countable — a theoretical
  fabricated-remaining PASS surface. No ADR froze either choice.
- **Narrow non-blockers adopted in this repair (N-1, N-3, N-6).**
  N-1: the Case-B finding rule read `details['remainingEventIds']`, a
  key the evaluator never persisted, and fell back to the full
  evaluation proof set. N-3: one truth-table test asserted
  `expect(['FAIL','NOT_EVALUABLE']).toContain(verdict)` — two verdicts
  where the contract defines one. N-6: the finding layer re-sorted
  identities and unit values independently and paired them
  positionally, which can pair the wrong amount with the wrong effect.
- Deliberately NOT chased (per repair scope): `entity.contested`
  test-only flag cleanup, evidence-set-hash scoping, N+1 chain-read
  performance.

## R-2. B-1 repair — Case-B contract ordering (ADR-0023 §8 + ADR-0018)

The ADR-0023 §8 baseline-authority paragraph now freezes the
establish-facts vs terminate-verdict distinction: a baseline authority
gap or contradictory baseline fact is RECORDED (voiding baseline
authority for Case A/C/PASS) and terminates the verdict ONLY at rule 6,
after Case A (rule 2) and Case B (rule 3) have had their
independent-proof opportunities — mirroring ADR-0018's exception clause
and rule 6's existing REMAINING_MISSING-unless-Case-A-proved-FAIL
exception. The Case-B paragraph now states explicitly that a recorded
baseline gap/conflict never blocks the direct proof, the primary
mechanism stays `RESOURCE_CONSERVATION_NEGATIVE_REMAINING`, and the
finding reason is unchanged. ADR-0018 Decision 3's Case-B bullet now
carries the same statement (baseline fact recorded, never blocking,
finding proof cites only the authoritative remaining surface). ADR-0023
rule 6's gap vocabulary now names `BASELINE_MISSING` OR the recorded
baseline `EVIDENCE_CONFLICT`, each terminating only after Cases A and B
had their opportunities. Priority A > B > C is unchanged.

Committed tests pin the exact primary mechanism for: baseline absent +
authoritative −1 (Case B), baseline capture-invalid + authoritative −1
(Case B), baseline absent + remaining +5 (BASELINE_MISSING), Case A
with remaining −1 (A outranks B), and sum ≤ baseline + remaining −1
(B outranks C). All single-verdict, single-mechanism assertions.

## R-3. B-2 repair — non-negative baseline/consumption sign discipline

ADR-0023 §8 type discipline now freezes the business sign rule:
baseline units and each counted accepted consumption effect's units
MUST be non-negative safe integers; a negative value on either surface
is contradictory business evidence (`EVIDENCE_CONFLICT` ⇒
NOT_EVALUABLE unless an independent Case A/B FAIL is already proven);
negative consumption is never summed, never reinterpreted as
release/restock, never subtracted, never coerced;
`remainingAvailableUnits` MAY legitimately be negative (that is Case
B); the manifest primitive `integer-minor-units` is UNCHANGED (business
sign semantics live in the pure evaluator over declared roles, so
remaining stays observable). ADR-0018 Case A and the NOT_EVALUABLE
clause now carry the same frozen rule (negative baseline =
contradictory evidence, never authoritative, never inferred).

Evaluator changes: negative baseline sets a recorded
`baselineConflict` (`EVIDENCE_CONFLICT` / `negative-baseline-units`)
instead of terminating early; negative accepted consumption units are
excluded from `acceptedReservedUnits`, recorded as
`consumptionNegativeUnits`, and block Case C and PASS (new
`EVIDENCE_CONFLICT` gap when no independent A/B FAIL fired); Case B
remains eligible over both. Six committed tests pin: negative baseline
alone ⇒ NOT_EVALUABLE EVIDENCE_CONFLICT; negative baseline +
authoritative −1 ⇒ FAIL Case B with conflict recorded; negative
consumption + reconciling arithmetic ⇒ NOT_EVALUABLE, MUST NOT PASS;
valid 6+5 subset + a −2 effect ⇒ Case A stands with sum 11 (never 9);
negative consumption + authoritative −1 ⇒ Case B stands; remaining −1
is never rejected merely for being negative.

## R-4. N-1 — Case-B finding minimal proof

The evaluator now persists the deterministic minimal Case-B proof
shape: `remainingEventIds` (the authoritative negative remaining
events), `remainingObservationHashes` (their source observations), and
`resourceProofEventIds` (the resource-identity proof). The finding
rule now requires this persisted shape and FAILS CLOSED when absent —
the full-proof-set fallback was removed. A committed test pins that
the Case-B finding cites exactly the remaining observation + resource
proof events and only the remaining surface's observation hashes
(unrelated evaluation provenance is excluded), plus determinism and
fail-closed behavior.

## R-5. N-3 — single-verdict assertions

The weak resource-suite test now pins the deterministic verdict the
fixture actually proves: the unaccepted-reservation fixture has
observedCount 0 == observedTotal 0 (enumeration complete), a valid
required capture set, and remaining 8 != 10 − 0 ⇒ exactly
`FAIL` / `RESOURCE_CONSERVATION_MISMATCH`. A sweep over the Phase 15
suites found no remaining assertion that accepts multiple
verdicts/mechanisms.

## R-6. N-6 — intact proof tuples (no positional mispairing)

The evaluator now persists `minimalProofEffects` — ONE intact tuple per
minimal proof effect (`effectIdentity`, `units`, `eventId`,
`relationshipIds`, `observationHashes`) — for Case A (canonical
running-sum subset over intact tuples) and atMostOne (canonical max+1
subset). The finding layer consumes ONLY those tuples: the
independently-sorted identity/amount positional pairing is gone
(structurally impossible to mispair), proof references derive from the
tuples themselves, and a persisted shape that is missing, wrong-sized,
or contradicts the evaluation (`sum ≤ baseline`, count ≤ max) fails
closed. An adversarial test with intentionally non-correlated
ordering (identities A,B,C with units 1,100,2) proves the running sum
pairs A→1, B→100 and stops at 101 > 10, and that finding proof
references carry exactly those effects' event ids.

## R-7. Verification (this session, this tree)

Targeted (first runs after each repair): finding rules 11/11, resource
table 50/50, atMostOne 25/25, conformance 7/7, rejects 15/15 (108
combined). One first-run failure occurred during repair (B-1 test B
observed the recorded code before the captured-invalid distinction was
implemented); it was investigated and fixed, not rerun into green —
the final targeted run is all green. Legacy forensics/timeline suites:
64/64. Full gates: see the table below — all run in this session on
the exact final tree.

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS (0 errors) |
| `pnpm typecheck` | PASS |
| `pnpm test:unit` | PASS — see count below |
| `pnpm build` | PASS |
| Migration state | 0007 applied; no pending migrations (unchanged by repair — schema untouched) |
| `pnpm test:integration` | PASS — see count below |
| `pnpm incident-zero:verify` | PASS |
| `pnpm controlled-faults:verify` | PASS |
| `git diff --check` | clean |

## R-8. Honest remaining limitations (updated)

1. Case A incomplete enumeration is still covered by unit truth-table
   rows only (no integration scenario) — unchanged from the original
   session.
2. Legacy and generic evaluators share `evaluatorVersion = 'v1'`;
   discrimination is via `details.registryVersion` + kind — unchanged.
3. `entity.contested` remains effectively test-only (the loader
   resolves contested semantics via `contestedEventIds` + graph
   exclusion + payload conflicts); documented, deliberately not
   repaired here (out of repair scope).
4. `evidenceSetHash` spans all run captures (append-only, benign) and
   the active-graph chain check re-reads chain rows individually —
   recorded as known non-blockers, deliberately not repaired here.
5. `remainingObservationHashes` are filtered against the evaluation's
   own provenance set in the finding rule; a mismatched persisted hash
   would shrink (never invent) the cited proof set.

## R-9. Repository state

- staged: **NONE** — commit: **NONE** — tag: **NONE** — push: **NONE**
- HEAD remains `312332156e31a42188e6e55afb92261e076caf1b`

## R-10. Repair-session decision

**READY FOR PHASE 15 RE-AUDIT**
