# RuptureGrid v1.0 — Phase 5 Self-Audit (Forensic Analysis + Timeline + Findings)

Status: **implemented on branch `phase-5-forensics`, uncommitted, awaiting independent audit.**
Everything below is factual and was observed in this session. Where a claim has a number, that
number came from a command run here.

> **Independent audit addendum (post-audit, audited counts):** the independent Phase 5 audit
> corrected two defects and re-proved all gates; the numbers below are the FINAL audited totals.
> - `packages/forensics/src/reproduction.ts` — `persistReproductionDefinition` was
>   check-then-create with no P2002 convergence: truly concurrent FIRST derivations of one run
>   could surface a raw P2002 instead of converging. Fixed: precise P2002 matcher
>   (extracted to shared `packages/forensics/src/p2002.ts`, also used by finding/timeline/derivation
>   persistence) + re-fetch outside any aborted transaction; rebind refusal preserved.
>   Regression-proven by a parallel first-derivation integration test.
> - `packages/control-db/prisma/migrations/0004_phase5_forensics/migration.sql` — trailing blank
>   lines at EOF failed `git diff --check`; removed.
> - `packages/forensics/src/p2002.ts` — the matcher was made null-safe (a non-object error inside
>   a catch handler must never throw and mask the original failure).
> Final gates: format/lint/typecheck/build/verify green; **unit 202/202 (20 files)**,
> **integration 119/119 (18 files)** over real PostgreSQL + Redis + real Demo over TCP HTTP.
> Live `pg_indexes`/`pg_enum` inspected: every unique index name matches the P2002 matchers'
> DDL strings exactly (including the PostgreSQL 63-char truncated names); all enum taxonomies
> match the code. Prior migrations 0001–0003 byte-identical to `phase-4-accepted`; Demo schema
> untouched.

---

## 1. Scope delivered

- **`packages/forensics`** (new): deterministic Finding derivation, forensic timeline derivation,
  reproduction definitions, computed-on-read run comparison, idempotent persistence with
  precise P2002 convergence.
- **Migration `0004_phase5_forensics`** (new, append-only): `analysis.finding`,
  `analysis.finding_evidence_reference`, `analysis.forensic_timeline_entry`,
  `analysis.forensic_derivation`, `analysis.reproduction_definition` + three enums.
  Run comparison is deliberately NOT persisted (computed on read — see §5).
- **API surface** (new controller `apps/api/src/forensics/forensics.controller.ts`):
  derivation trigger, findings list, finding detail (full proof), keyset-paginated timeline,
  causal-relationships pass-through, reproduction definition, run comparison.
- **Phase 4 evaluator addition** (`packages/evidence/src/invariants.ts`, +3 lines): the FAIL
  details now carry `equivalentEffectEventIds` (the counted effects by id) so the Finding
  cites the minimal sufficient proof set, not every derivation input. No verdict semantics
  changed; the evaluator's own tests still pass.

## 2. Finding contract

- Rule: `INV-IZ-1` FAIL ⇒ one `DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT` Finding per evaluation.
  PASS and NOT_EVALUABLE produce NO Finding (unit-proven, §finding.test.ts).
- Version: `FINDING_RULE_VERSION = 'v1'` (`packages/forensics/src/versions.ts`).
- Identity/idempotency: database unique `(invariantEvaluationId, findingRuleVersion)`; repeat
  and concurrent derivations converge on one row (integration-proven with 3 parallel callers).
- Input fingerprint: SHA-256 over canonical (rule version, evaluation semantic identity,
  confidence-scope inputs, ordered proof set) via `canonicalizeJson` — wall-clock never enters.
- Provenance: every Finding references its `InvariantEvaluation` plus typed proof references
  (`FindingEvidenceReference.subject` ∈ `EvidenceSubjectKind`), deterministically ordered.
- Confidence scope (evidence-model §8): `provenScope` (verdict, counts, attribution basis,
  evidence-set hash, completeness basis) and `uncertainScope` (INDETERMINATE invocation ids,
  non-equivalent action count, `attributionBelowIdentityChain: 0`, `schedulingOrderAsserted:
  false`) persisted on every Finding.
- No severity, no AI, no recomputation: the Finding copies the evaluation's own details
  (amountMinor echoed exactly as persisted — `"500000"` string from the demo target, R-06
  fidelity) and never re-evaluates evidence.

## 3. Timeline contract

- Derivation version `TIMELINE_DERIVATION_VERSION = 'v1'`; persisted and recomputable;
  unique `(runId, derivationVersion, sourceKind, sourceId, entryKind)` converges repeats.
- Entry kinds (bounded taxonomy, §20): RUN/STEP terminal states, INVOCATION_EXECUTED,
  HTTP_REQUEST/RESPONSE_OBSERVED, EXECUTOR_ERROR_OBSERVED, PROVIDER_PAYMENT/EVENT/
  WEBHOOK_DELIVERY/PROCESSING_ATTEMPT/FINANCIAL_EFFECT/LEDGER_ENTRY/PAYMENT_DELIVERY observed,
  TARGET_STATE_OBSERVED, INVARIANT_EVALUATED, FINDING_DERIVED. Unknown event types are never
  invented into entries.
- Ordering: time-primary `(occurredAt, orderingBasis, sourceKind, sourceId, entryKind)` with
  explicit bases (`sequence` | `wall_clock` | `unordered_overlap`). Events derived from one
  target-state capture are `unordered_overlap` siblings (relative order not knowable —
  observed live: 15 of 53 entries in the vulnerable run). Unit tests prove insertion-order
  independence for tied timestamps.
- Time semantics: `timeMeaning` distinguishes `execution` / `observedAt` / `derivedAt`;
  a normalized event's occurredAt is its source observation's capture time, not the
  derivation instant.
- FINDING_DERIVED entries cite the Finding row itself (`sourceKind = FINDING`).

## 4. Forensic derivation pipeline

`deriveRunForensics(prisma, runId)` is offline (Control-DB truth only; proven by the
demo-stopped integration test), reads Phase 3 execution rows and Phase 4 evidence read-only,
derives Findings for every persisted evaluation, persists timeline entries + the reproduction
definition, and records a `ForensicDerivation` row (version + input fingerprint + counts).

## 5. Reproduction + comparison

- `ReproductionDefinition`: derived from the run's frozen snapshot (mode requirement from the
  snapshot's own mode-step body; credential REFERENCES only, ADR-0012; invariant bindings +
  acceptance expectations from the run's own verdicts). unique(runId) converges; a differing
  snapshot hash on rebind is REFUSED.
- Run comparison (incident-replay §6): computed on read from the two runs' persisted verdicts;
  deterministic latest-evaluation selection (max by `(createdAt, evaluationId)`); refuses
  self-comparison; the API refuses cross-intent comparison with SNAPSHOT_MISMATCH. Deliberately
  not persisted: the persisted-table design contradicted its own honest semantics (derived
  rows would need rewriting as runs gain evaluations) — removed before first integration run.

## 6. API surface (all live-tested)

- `POST /api/v1/runs/:runId/forensics/derive` — idempotent trigger.
- `GET  .../findings` — list with proof references; `GET .../findings/:findingId` — full proof
  (evaluation + confidence scopes + ordered references + fingerprint).
- `GET  .../timeline?limit=&cursor=&subjectKey=` — keyset pagination over the FULL composite
  sort key via a raw tuple comparison `(occurredAt, sourceKind, sourceId, entryKind) > cursor`
  (Prisma 7's typed API cannot express enum `gt`; cursor values are validated against the
  known enum sets and bound as typed casts, never interpolated). Cursor encodes all four key
  components — tied rows are never skipped (proven: paged walk of 53 entries returned exactly
  the stored set).
- `GET  .../causal-relationships` — the ONLY causal truth (Phase 4 relationships pass-through).
- `GET  .../reproduction-definition`; `GET .../compare/:otherRunId`.
- Vocabulary boundary: Phase 4 surfaces remain Finding-free (regression still green); Phase 5
  surfaces expose no credential values (live-checked: no `bearer`, `${credential`, `sk-`).

## 7. Live runtime evidence (observed in this session)

Vulnerable-mode Incident Zero run (repeat 5, concurrency 1) through the real worker + demo:

- Evaluation `c8b24f74…` FAIL; Finding rule v1, reason `DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT`,
  title `Duplicate wallet credit for confirmed provider payment`, summary
  `Invariant INV-IZ-1 (v1) FAILED for confirmed logical payment pp-9599…: 2 accepted
  equivalent wallet-credit effects of 500000 PKR were attributed to it (basis:
  identity-chain)`.
- Proof references by subject: `INVARIANT_EVALUATION: 1, NORMALIZED_EVENT: 2` (exactly the two
  counted equivalent effects — SQL-verified by event type), `CAUSAL_RELATIONSHIP: 12,
  RAW_OBSERVATION: 9`.
- Provenance walk: evaluation → 9 observation content hashes → 9 RESOLVED raw observations;
  timeline 53 entries, 1 FINDING_DERIVED, 15 unordered_overlap; reproduction definition
  `VULNERABLE`, snapshot hash pinned, 3 credential references (no values).
- Database counts after the full suite: 20 runs, 5 findings, 375 timeline entries,
  7 derivations, 7 reproduction definitions.

## 8. Gates (all run in this session)

- `pnpm format:check` — green. `pnpm lint` — green. `pnpm typecheck` — green (strict).
- `pnpm test:unit` — **202/202 green (20 files**; includes 44 new forensics unit tests**)**.
- `pnpm build` — green. `pnpm verify` — green (format + lint + typecheck + unit + build).
- `pnpm test:integration` — **119/119 green (18 files)** — Phase 1 (databases, queue, ownership,
  snapshot), Phase 2 (demo-*), Phase 3 (execution mechanics, multi-worker 45.5s, redis-outage
  reconciliation, worker startup), Phase 4 (evidence capture, evidence invariants) and the
  8 new Phase 5 forensics tests.
- Clean migration proof: `migrate reset` applies 0001→0004 cleanly; `migrate diff
  --from-migrations --to-schema` = "No difference detected"; `migrate status` = "Database
  schema is up to date!"; `prisma generate` reproducible (no diff in generated client).
- Prior migrations 0001/0002/0003 untouched (`git diff` empty); Demo schema untouched
  (`git status packages/demo-db apps/demo-fintech` empty).

## 9. Self-audit findings (defects found and fixed in-session)

1. `packages/control-db/prisma/migrations/0004…/migration.sql` — enum `TimelineEntryKind`
   drifted from `timeline.ts` (WALLET_STATE_OBSERVED vs TARGET_STATE_OBSERVED) → runtime
   insert failure. Fixed both files; schema ↔ migration diff re-proven empty.
2. `packages/forensics/src/derive.ts` — precise P2002 matcher relied on `meta.target`,
   which Prisma 7 + driver adapters does NOT emit (probed live: meta carries
   `driverAdapterError.cause.constraint.index` with the DDL index name instead). Rewrote the
   matcher to accept BOTH shapes against exact expected constraint fields/DDL index names
   (`finding_invariantEvaluationId_findingRuleVersion_key`,
   `forensic_timeline_entry_runId_derivationVersion_sourceKind__key`,
   `forensic_derivation_runId_derivationVersion_inputFingerprin_key`); any other P2002 still
   propagates. One-off probe script deleted after use.
3. `apps/api/src/forensics/forensics.controller.ts` — initial occurredAt-only cursor skipped
   tied rows (53 stored vs 38 paged). Replaced with composite-keyset raw tuple pagination
   (see §6); walk now returns exactly the stored set.
4. `tests/integration/forensics.test.ts` — initial same-intent comparison created two
   separate revisions (different snapshot hashes by design). Rewritten to ONE experiment
   revision executed twice (`createExperiment` once, `createRun` twice) — verdicts agree,
   `sameIntent: true` proven; cross-intent refusal proven against a SECURE-mode revision.
5. `packages/evidence/src/invariants.test.ts` — determinism test needed the new
   `equivalentEffectEventIds` excluded as graph-local identity (same class as
   `paymentEventId`), semantics unchanged.

## 10. Remaining risks (legitimate non-blockers)

- Timeline `details` JSON is schema-flexible by design (bounded identities + source-copied
  redacted payloads); its shape is stabilized by the derivation version, not a SQL contract.
- The composite-keyset timeline pagination uses a raw SQL tuple comparison (parameterized,
  enum-validated). If Prisma later supports enum range predicates natively, it can be
  replaced without changing the cursor contract.
- `FINDING_DERIVED` timeline entries derive `occurredAt` from pipeline wall-clock (`new Date()`)
  at Finding persistence; the Finding's semantic identity remains wall-clock-free
  (inputFingerprint excludes it).

## 11. Phase boundary

No AI anywhere (source-audited). No Phase 6 UI, no replay execution, no auth/billing, no
new runtime dependencies (`@rupturegrid/forensics` uses only workspace packages + node:crypto;
`apps/api` gained the workspace dep `@rupturegrid/forensics` only).

## 12. Git

Branch `phase-5-forensics` (from `phase-4-accepted` = d01978f). Changed: schema.prisma,
control-db/src/index.ts (exported model types), evidence invariants (+3 lines + test),
api app.module/package.json, integration vitest alias. New: migration 0004, packages/forensics,
api forensics controller, integration forensics test. `git diff --check` — clean.
No commit, no tag, no push.
