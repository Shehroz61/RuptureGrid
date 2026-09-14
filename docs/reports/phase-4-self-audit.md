# RuptureGrid v1.0 — Phase 4 Self-Audit (Builder's Report)

Date: 2026-09-13. Branch: `phase-4-evidence-invariants` (created from `phase-3-accepted` = `e76c17e`). All Phase 4 work is **uncommitted** by design, awaiting a completely fresh independent audit. This report is factual: every claim below was performed and observed in the builder sessions; anything not verified is listed as a risk or gap, not claimed.

## 0. Independent acceptance (post-builder)

PHASE 4 was independently audited and **ACCEPTED** (independent audit verdict: `PHASE 4 ACCEPTED`, 2026-09-14). Sections 1–34 below are the builder's historical report, retained as written except where post-audit commit-preparation corrections (§0a, §35) were required to make this report factually match the final independently-audited working tree. The builder verdict (§1) is intentionally historical and is distinct from the independent acceptance.

## 0a. Commit-preparation correction history (post-audit, report-only)

After the independent acceptance, this document was corrected so every claim matches the final audited working tree: the worker-cleanup history (§26), the dead-helper history (§30.6), the final redaction contract and chain language (§8, §9), the runtime workload classification (§12), and the final test counts (§23). The independent audit's three working-tree corrections C1–C3 are recorded in §35. No implementation, source, schema, migration, or test file was modified by this report correction.

## 1. Verdict (builder's)

PHASE 4 READY FOR INDEPENDENT AUDIT.

The four deterministic truth layers — Raw Observation → Normalized Event → Causal Relationship → Invariant Evaluation — are implemented, durable in the Control PostgreSQL `evidence`/`analysis` contexts, exercised by committed rerunnable tests against real infrastructure, and proven end-to-end against the real running stack (API + worker + real Demo Fintech over HTTP). Real Incident Zero runs produce FAIL (vulnerable target), PASS (secure target), and honest `NOT_EVALUABLE` (insufficient evidence) deterministically. No Finding, no timeline, no AI, no fabricated anything.

## 2. Starting checkpoint

- repository = E:\RuptureGrid-v1.0 (Windows, pnpm monorepo)
- starting branch = `phase-3-execution-engine`, working tree clean
- phase-3 commit = `e76c17e`, tag `phase-3-accepted` → verified via `git rev-parse`
- phase-2 tag `phase-2-accepted` = `d80b2a3` verified
- Phase 4 branch = `phase-4-evidence-invariants` via `git switch -c phase-4-evidence-invariants phase-3-accepted`
- All accepted docs and ADRs were read before implementation; the implementation follows `docs/evidence-model.md`, `docs/incident-zero.md`, `docs/architecture.md`, ADR-0004 (integer money), ADR-0007 (AI never decides truth), ADR-0010 (canonicalization in engine), ADR-0012 (redaction before persistence).

## 3. Scope

Implemented:

- `RawObservation` — content-addressed, append-only observation store (`packages/evidence`) with per-run linked content hashes (`chainIndex` + `prevContentHash`), captured from every real HTTP invocation through a narrow `EvidenceSink` seam in the engine, plus explicit read-only target-state adapter capture (`demo-fintech-payment-lineage`).
- Redaction before persistence (headers + JSON + bounded text), policy versioned; stored representation is the REDACTED representation and hashes are computed over it.
- Deterministic normalization: `executor-invocation-normalizer/v1` and `demo-fintech-inspection-normalizer/v1` (pure functions; versioned rows; idempotent persistence).
- Causal derivation: identity-direct relationships (describes-payment / delivered-as / processed-as / produced-effect / recorded-as-entry).
- Deterministic invariant evaluation INV-IZ-1 (verdicts `PASS` / `FAIL` / `NOT_EVALUABLE`) with evaluator version, evidence-set fingerprint, per-subject independent evaluation, idempotent persistence, and concurrent-pass convergence.
- Integrity verifier over the per-run linked content-hash append log + `GET /api/v1/runs/:runId/integrity`.
- Minimal Phase 4 APIs: observations / events / relationships / invariants / analyze (POST) / integrity. No Finding/severity/CRITICAL/timeline vocabulary anywhere.
- Worker integration: evidence sink with writer provenance (ownerId + fencing token), adapter capture hook, post-settle analysis sweep.

Not implemented (per Phase 4 hard non-scope): Finding, severity, CRITICAL, forensic/timeline/causal-graph UI, reproduction definition, replay orchestration, AI anything, dashboard, screenshots/video, auth/org/RBAC/billing, Phase 5/6/7 material.

## 4. Evidence schema (migration `0003_phase4_evidence_invariants`)

- `evidence.raw_observation` — runId, stepRunId?, invocationId?, invocationIdentity, kind (enum: `http_response_observed`, `executor_error`, `target_observation`), adapterKind?, schemaVersion, observedAt, payload (jsonb, REDACTED), redactionApplied, redactionPolicyVersion, truncated, contentHash, chainIndex, prevContentHash?, origin (enum `OBSERVED`/`DETERMINISTIC_DERIVED`/`AI_INTERPRETED` — only OBSERVED is written), writerOwnerId, writerFencingToken?, createdAt. Unique: `(runId, kind, invocationIdentity)`; unique `(chainIndex, runId)`; FK to runs.
- `evidence.normalized_event` — runId, sourceObservationIds[], normalizerName, normalizerVersion, inputHash, eventType, subjectKey?, payload, createdAt. Unique `(runId, normalizerName, normalizerVersion, inputHash)`.
- `evidence.causal_relationship` — runId, fromEventId, toEventId, relationKind, basis (enum `identity-direct`/`identity-chain`/`temporal-correlation`), evidenceJson, createdAt. Unique `(fromEventId, toEventId, relationKind)`.
- `evidence.evidence_integrity_head` — runId, lastChainIndex, headContentHash, observationCount, lastVerifiedAt.

## 5. Analysis schema

- `analysis.invariant_definition` — invariantKey (PK), title, description, createdAt.
- `analysis.evaluation_batch` — id, runId, invariantKey, evaluatorVersion, startedAt, completedAt?, evaluationCount. Unique `(runId, invariantKey, evaluatorVersion)`.
- `analysis.invariant_evaluation` — id, batchId, runId, invariantKey, evaluatorVersion, subjectKey, verdict (enum `PASS`/`FAIL`/`NOT_EVALUABLE`), reason, evidenceSetHash, completenessBasis, details, sourceObservationHashes[], normalizedEventIds[], causalRelationshipIds[], createdAt. Unique `(runId, invariantKey, evaluatorVersion, subjectKey, evidenceSetHash)`.
- Finding / Timeline / ReproductionDefinition: ALL ABSENT (verified by schema inspection).

## 6. Migration

- `packages/control-db/prisma/migrations/0003_phase4_evidence_invariants/migration.sql` — reviewable SQL (R-12), consistent with `schema.prisma` (`migrate diff` empty; schema re-validated by Prisma).
- Schemas: `evidence`, `analysis` alongside existing `control`.
- DB-level append-only protection: BEFORE UPDATE/DELETE triggers on `raw_observation`, `normalized_event`, `causal_relationship` (application code additionally exposes only create paths).
- Clean-generation proof: all 3 migrations applied from an empty throwaway database (`rupturegrid_clean_proof`) via `prisma migrate deploy`; live schema inspected (tables + triggers present); proof database dropped afterwards.
- Demo DB changes: none. db push: not used as history.

## 7. Raw observation

- identity = provenance tuple `(runId, kind, invocationIdentity)` (scoped idempotency, evidence-model contract B+C): exact retry of the same provenance identity + same stored content returns the SAME row; same identity + different content ⇒ `EvidenceIntegrityConflictError`; different runs reusing an identity string are DIFFERENT rows (cross-run aliasing is impossible by construction). Regression tests cover all four cases (exact retry, content conflict, cross-run isolation, cross-invocation isolation) against real PostgreSQL (`packages/evidence/src/observation-identity.test.ts`).
- run/step/invocation relation: rows carry stepRunId/invocationId where the observation came from an invocation; adapter observations carry stepRunId and an adapter-scoped invocationIdentity.
- writer provenance: writerOwnerId + writerFencingToken persisted on every row (stale-generation reality is attributed, never erased, and never gains state authority).
- observation kinds: `http_response_observed` (successful transport observation), `executor_error` (invocation with failure detail), `target_observation` (explicit adapter read).
- stored representation: canonical JSON (sorted keys), bounded (16,000 chars payload cap; 8,000-char body cap with `truncated` flag).
- append semantics: create-only service API; no update/delete path exists in the store; DB triggers back it up; per-run advisory lock serializes chain appends (gap-free chainIndex, prevContentHash links, head row advanced atomically in one transaction).

## 8. Redaction

- policy: a header denylist (`authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-rupturegrid-provider-signature`) is removed and replaced with a presence marker, so the header's PRESENCE stays honest evidence while its value never persists; JSON object keys matching credential-name patterns are masked, and secret-VALUE shapes (bearer tokens, JWTs, URL-embedded credentials) are masked regardless of field name. Header redaction is denylist-based by accepted design (`security-boundaries.md` §7 documents the trade-off: unknown headers are kept; the denylist applies regardless). Policy version persisted (`redaction_policy_version`).
- hash/redaction order (final implementation): observe → redact (the full body source is parsed and redacted BEFORE any bounding) → canonicalize stored representation → hash → persist. Storage bounding (16,000-char payload cap; 8,000-char body cap with an honest `truncated` flag) is applied ONLY to the REDACTED representation. No durable unredacted copy exists anywhere; no durable identifier or hash is derived from secret-bearing content.
- canary tests: committed integration suites run unique canary secrets through a real execution and assert absence across all durable surfaces; the live runtime verification additionally scanned `raw_observation.payload`, `normalized_event.payload`, `causal_relationship.evidenceJson`, `invariant_evaluation.details/reason`, `evaluation_batch`, Phase 3 `step_invocation` snapshots, and API/worker/demo logs for the REAL inspection token: 0 occurrences on every surface (token never printed).
- durable secret occurrences: NONE found (DB + logs).

## 9. Integrity

- content hash: SHA-256 over the canonical REDACTED stored representation (`EVIDENCE_HASH_ALGORITHM = sha256`).
- canonicalization: engine-owned canonical JSON (`@rupturegrid/engine` per ADR-0010), deterministic key ordering.
- chain structure (precise language): a linked append log — each row stores its own `contentHash` plus a `prevContentHash` link to its predecessor, gap-free per run, with the `evidence_integrity_head` row. It is content-addressed, append-only under the application/trigger contract, and integrity-verifiable by recomputation. It is NOT a cryptographic accumulator in which the current row's hash digests previous chain material, and it is not claimed to be tamper-proof, immutable against database administrators, or non-repudiable. The append transaction holds `pg_advisory_xact_lock(hashtext(runId))` so concurrency cannot fork the chain.
- verification: `verifyRunEvidenceChain` recomputes every stored payload hash and every link, compares to the head; exposed as `GET /api/v1/runs/:runId/integrity`.
- honest guarantee (used in docs/API): "append-only chain intact: stored observations match their hashes and links". NOT claimed: tamper-proof, immutable against DB administrators, non-repudiable. A superuser can always alter database state; the verifier detects, not prevents.

## 10. Stale worker observation

Verified by a committed real-PostgreSQL integration test and by the live suite:

- old owner/token = generation A (lower fencing token) performs a real HTTP invocation;
- new owner/token = generation B takes the lease with a higher fencing token after A's lease expiry;
- stale state write = A's state finalization is rejected (Phase 3 fencing, unchanged);
- raw observation append = A's truthful observation of what actually happened IS appended;
- writer provenance = stored with A's ownerId + A's fencing token;
- authoritative execution state = remains B's, untouched by A's evidence;
- result = honest reality preserved, state authority preserved (test: "a stale generation's truthful observation appends WITH its provenance; authoritative state stays with the new owner").

## 11. Normalization

- adapter: exactly one explicit target evidence adapter, `demo-fintech-payment-lineage` (validated: `evidenceAdapter.kind` accepts only this value in Phase 4).
- adapter selection: explicit per-step `evidenceAdapter` declaration in the experiment document (validated at experiment creation, snapshot-frozen). No path-substring inference.
- normalizer versions: `executor-invocation-normalizer/v1`, `demo-fintech-inspection-normalizer/v1` (constants in `packages/evidence/src/versions.ts`).
- input validation: strict shape checks on inspection payloads; adapter kind + inspection contract required; malformed input raises, never guesses.
- determinism: pure functions (no Math.random, no clock reads for business derivation, no network); unit tests prove same input ⇒ same semantic output across repeated runs.
- idempotency: normalized events are unique per `(runId, normalizerName, normalizerVersion, inputHash)`; `inputHash` covers the source observations' hashes AND the event payload, so two events derived from one observation stay distinct; re-derivation converges (P2002-tolerant upsert), never duplicates.

## 12. Normalized Incident Zero (live runtime run, vulnerable target)

Observed via `GET /api/v1/runs/:runId/events` for run `0f12fed3…`:

- workload classification: a REAL MINIMAL duplicate-credit state — 1 logical payment, 3 deliveries, 3 processing attempts, 2 accepted equivalent effects. This is a valid minimal Phase 4 invariant proof, NOT the canonical 20-delivery Phase 2 replay workload (which remains separate).
- payments: 1 confirmed logical provider payment (`pp-6894cbc5be22796923236a406831c2a4`)
- provider events: 2 (confirmed + settled, both signed deliveries)
- deliveries: 3 delivery events (duplicate pressure repeat=2 + settled)
- processing attempts: 3 recorded by the target
- financial effects: 2 accepted `WALLET_CREDIT` effects (the duplicate credit — the vulnerability made real)
- ledger entries: 2; wallet states observed via the read-only inspection adapter
- money representation: integer paisa everywhere (`500000`), verified in payloads (ADR-0004)

## 13. Causality

- payment→event: `describes-payment` (identity-direct)
- event→delivery: `delivered-as` (identity-direct)
- delivery→processing: `processed-as` (identity-direct)
- processing→effect: `produced-effect` (identity-direct)
- attribution bases: only `identity-direct` hops walked; `identity-chain` is the conclusion recorded on attributions; `temporal-correlation` is never produced or used (adversarial test proves temporal-only evidence cannot produce FAIL).
- timestamp inference: none. Timestamps are recorded, never used for attribution.

## 14. Canonical invariant

- key = `INV-IZ-1`; version = `v1` (both persisted on every batch/evaluation + `invariant_definition` row)
- definition (incident-zero §5): for every confirmed logical provider payment, accepted equivalent wallet-credit effects causally attributable to it must be ≤ 1.
- equivalence tuple: payment identity + walletId + effect type (`WALLET_CREDIT`) + amountMinor + currency. Non-matching effects are recorded as nonEquivalent and never counted (two legitimate same-amount payments cannot collide).
- subject = confirmed logical payment (`providerPaymentId`).

## 15. Vulnerable evaluation (live run `0f12fed3…`)

- providerPaymentId = `pp-6894cbc5be22796923236a406831c2a4`
- complete evidence = 8 observations (7 invocation + 1 adapter lineage), 17 events, 10 relationships
- equivalent effects = 2 accepted WALLET_CREDIT, both chain-attributed (basis: identity-chain, every counted effect attributed)
- wallet = the payment's wallet; amount 500000 PKR each
- attribution = identity chain walked payment ← event ← delivery ← attempt ← effect
- result = **FAIL** — reason persisted: "2 accepted equivalent wallet credits of 500000 PKR attributed to one confirmed logical payment (basis: identity-chain, every counted effect chain-attributed)". Every HTTP response in the run was a transport success — business correctness failed, and only the evidence chain sees it.

## 16. Secure evaluation (live run `dd5bef18…`)

- providerPaymentId = `pp-1f131769d226b495a8ad7dba4b731b2f`
- complete evidence = same shape as vulnerable run
- equivalent effects = 1 accepted WALLET_CREDIT (idempotent target suppressed the duplicate delivery as `IDEMPOTENT_DUPLICATE`)
- attribution = identity-chain, complete
- result = **PASS** — "exactly one accepted equivalent wallet credit of 500000 PKR attributed to the confirmed logical payment (basis: identity-chain)".

## 17. Two legitimate payments (committed integration test)

- two payments, same wallet, identical amount, delivered independently
- effects per payment = exactly 1 each
- evaluation A = PASS for payment A; evaluation B = PASS for payment B
- collision = none: per-subject independent evaluation + the equivalence tuple keyed by payment identity means same-amount payments never merge.

## 18. Insufficient evidence

- evidence available = delivery observations only (lineage adapter not captured for the payment)
- completeness basis = `delivery-attributable` (declared)
- result = `NOT_EVALUABLE` — "payment observed in delivery evidence but target business-state verification (inspection lineage) was not captured for it; the invariant cannot be evaluated"
- reason = honest incompleteness; never collapsed into PASS. Also covered: missing lineage ⇒ NOT_EVALUABLE (§54).

## 19. Temporal-only attribution (adversarial, committed test)

- evidence = effects that correlate in time but have no identity chain to the payment
- attribution = none (only temporal-correlation hints exist, and they are not walked)
- result = `NOT_EVALUABLE` (effects exist but unattributable) — FAIL is NOT produced
- FAIL produced = never from timestamps alone (test asserts this).

## 20. Evaluation provenance

- raw observations: every evaluation references `sourceObservationHashes[]` (run-wide fingerprint at evaluation time)
- normalized events: `normalizedEventIds[]`
- relationships: `causalRelationshipIds[]`
- evidence-set hash: SHA-256 fingerprint over the full derived evidence state; identical state ⇒ identical fingerprint ⇒ same verdict persisted once
- evaluator version: persisted on batch + every evaluation row
- traceability: `details.evidenceSetFingerprint` links each verdict to the exact evidence state that produced it.

## 21. Analysis idempotency

- repeat processing: same evidence ⇒ same fingerprint ⇒ same evaluations returned, no duplicate rows (unique key + P2002-tolerant persistence)
- concurrent processing: worker sweep + API trigger racing on the same run converge (proven by a committed concurrency test and observed live: the sweep and an explicit analyze call produced exactly one batch/evaluation set)
- derived duplicates: impossible per unique keys; conflicts converge to the existing row
- result: idempotent, deterministic, history-preserving (a NEW evidence state creates NEW evaluation rows; earlier rows are never rewritten)

## 22. APIs (all read/analyze only, run-scoped)

- raw evidence: `GET /api/v1/runs/:runId/observations[?kind=]`
- normalized evidence: `GET /api/v1/runs/:runId/events`
- causal relationships: `GET /api/v1/runs/:runId/relationships`
- invariants: `GET /api/v1/runs/:runId/invariants`
- processing trigger: `POST /api/v1/runs/:runId/analyze` (idempotent)
- integrity: `GET /api/v1/runs/:runId/integrity`
- secret exposure: none — payloads are the stored REDACTED representations; the API layer cannot un-redact. No Finding/CRITICAL/"SYSTEM SURVIVED" vocabulary exists in any response.

## 23. Tests

- unit files (Phase 4): `redact.test.ts` (10, including the auditor C3 regression test), `normalize.test.ts` (6), `invariants.test.ts` (10), `observation-identity.test.ts` (6, real PostgreSQL)
- unit tests: 158 total workspace-wide (15 files), all passing (32 in evidence package) — final audited count; 157 before auditor correction C3 added its permanent regression test
- integration files (Phase 4): `evidence-capture.test.ts` (capture, chain, canary, idempotency/conflict, integrity, sink-failure honesty), `evidence-invariants.test.ts` (stale-worker evidence, vulnerable→FAIL, secure→PASS, two-payment, partial-evidence, temporal-only, idempotency/repeat, no-mutation-of-execution-history, API vocabulary safety)
- integration tests: 110 total workspace-wide, all passing
- real Control PostgreSQL: yes (all evidence tests)
- real Demo HTTP: yes (full-stack runs against the real Demo Fintech)
- real Redis/Worker: yes (runs dispatched through the real queue, executed by the real worker)
- real vulnerable/secure/two-payment: yes — all three real scenarios with actual verdicts
- actual result: VULNERABLE→FAIL, SECURE→PASS, two-payment→independent PASS, temporal-only→NOT_EVALUABLE, partial→NOT_EVALUABLE.

## 24. Prior-phase regression

- Phase 1 suite: green (databases, ownership, logger, worker-startup, config, redaction)
- Phase 2 suite: green (demo domain, incident-zero black-box, inspection)
- Phase 3 suite: green (execution mechanics, snapshot immutability, multi-worker, redis-outage reconciliation, API health, stale-writer)
- result: full integration run `17 files / 110 tests passed` after Phase 4 changes — no regressions.

## 25. Quality gates

- format: green (`prettier --check` clean)
- lint: green (`eslint` clean, including `consistent-type-imports` fix)
- typecheck: green (`pnpm -r typecheck`, strict)
- unit: green (158; 157 before auditor correction C3 added its regression test)
- integration: green (110)
- build: green (`pnpm build`)
- verify: green (`pnpm verify` = format+lint+typecheck+unit+build)
- clean generation: green (Prisma client regeneration; `migrate diff` migration-vs-schema empty)
- post-audit re-verification: after auditor corrections C1–C3, all gates were re-run and observed green (format, lint, typecheck, unit 158/15 files, integration 110/17 files, build, `pnpm verify` exit 0, clean migration apply + `migrate diff`)

## 26. Runtime verification (live stack, after all gates)

- API: booted from built dist (`:3001`), real NestJS app
- Worker: booted from built dist, real BullMQ processing + reconcile sweep with `analyzed` counter observed
- Demo: booted from built dist (`:3002`), `health/ready` = ready with demoPostgres ok
- raw capture: 8 observations (chain 0–7, writer worker-b) captured live via the real execution path
- normalization: 17 events derived live (executor + inspection normalizers)
- causality: 10 identity-direct relationships derived live
- vulnerable invariant: FAIL (via `POST /analyze`, subject `pp-6894cbc5…`)
- secure invariant: PASS (subject `pp-1f131769…`)
- integrity: `chainValid: true`, `contentHashesValid: true`, head = recomputed hash, 0 problems
- cleanup (factual history): the builder attempted process cleanup — API/worker/demo drivers stopped, ports 3001/3002 cleared, runtime logs and temp driver scripts deleted, proof database dropped. However, ONE worker process from a prior builder session remained alive, and its reconcile sweeps later caused transient integration-test interference. The independent auditor identified and surgically removed that leftover process; final audit cleanup confirmed no audit-owned processes remained and the suites then passed deterministically. The builder's original cleanup was therefore incomplete, not perfect.

## 27. Ownership / security

- Control DB: owns evidence + analysis contexts; RuptureGrid wrote nothing to Demo business state
- Demo DB: unchanged (no schema changes; read-only inspection adapter only)
- Demo inspection credential: referenced by name (`DEMO_INSPECTION_TOKEN`); value loaded from environment at runtime only
- secret persistence: none (DB audit 0 occurrences on all evidence/analysis/execution surfaces; log audit 0 occurrences in API/worker/demo logs)
- logs: no secrets; writer/owner identifiers only
- import boundaries: evidence → engine + control-db only; demo-db does not import control-db; no cycle (verified by successful builds + dependency list)
- result: credential REFERENCE architecture preserved end-to-end.

## 28. Phase boundary

- Finding: ABSENT (schema, code, API)
- Timeline: ABSENT
- ReproductionDefinition: ABSENT
- AI: ABSENT (no AI_INTERPRETED rows ever written; no AI code in the truth path — ADR-0007)
- product UI: ABSENT (no web changes)
- API vocabulary scan: an integration test asserts no Finding/severity/CRITICAL vocabulary is exposed.

Expected: ALL ABSENT — confirmed.

## 29. Dependencies added

- Production: NONE (packages/evidence uses only `@rupturegrid/control-db`, `@rupturegrid/engine`, and Node built-ins `node:crypto`).
- Development: NONE (reused existing typescript/vitest/eslint toolchain).
- Explanation: the workspace lockfile diff is workspace-link noise only; no new external package was introduced.

## 30. Self-audit findings (genuine defects found and fixed during the phase)

1. Cross-run idempotency aliasing (CRITICAL, fixed): the first draft keyed raw-observation idempotency on a globally-unique `contentHash` and returned the conflicting row on P2002 — identical observation content across different runs aliased evidence. Fixed: provenance-tuple identity `(runId, kind, invocationIdentity)`, non-unique content hash, explicit `EvidenceIntegrityConflictError` on same-identity/different-content. FILE = `packages/evidence/src/raw-observation-store.ts`, migration 0003; FIX = committed tests `observation-identity.test.ts` (exact retry / content conflict / cross-run isolation / cross-invocation isolation).
2. Unredacted-hash derivative (fixed): adapter observation identity derived from a hash of the UNREDACTED payload — a durable derivative of secret-bearing content. Fixed: identity now derives from the REDACTED representation's hash. FILE = `raw-observation-store.ts` (`appendTargetObservation`).
3. Derivation input-hash collapse (fixed): normalized-event `inputHash` did not include the event payload, so two events derived from one lineage observation collapsed onto one identity and silently lost an event. Fixed: inputHash covers source hashes + payload. FILE = `packages/evidence/src/normalize.ts`, `derive.ts`.
4. Concurrent-analysis non-convergence (fixed): `evaluationBatch.upsert` and derivation creates raced the worker sweep vs explicit analyze (observed as P2002 under the full integration suite). Fixed: P2002-tolerant convergence on batch upsert, event upserts, and relationship creates. FILE = `packages/evidence/src/analysis.ts`, `derive.ts`.
5. Stale header comment claiming unique-contentHash semantics (fixed) — doc-drift inside the file. FILE = `raw-observation-store.ts`.
6. Dead helper kept via `void isRecord`: the builder identified it, but the builder's claimed removal was INCOMPLETE — the dead `strArray` helper was still present in `packages/evidence/src/demo-adapter.ts` at audit time. The independent auditor removed it (correction C2, §35); final lint/typecheck/build/tests pass. FILES = `packages/evidence/src/invariants.ts`, `packages/evidence/src/demo-adapter.ts`.
7. Lint error `import()` type annotation (fixed with `import type`). FILE = `packages/engine/src/step-processor.ts`.
8. README status drift (fixed per R-17): status line now states Phase 4 truthfully. FILE = `README.md`.
9. Oversized-JSON redaction defect (found and fixed by the independent auditor, correction C3, §35): `redactBoundedText` in `packages/evidence/src/redact.ts` bounded/truncated an oversized JSON body BEFORE parsing and redaction; when the truncated prefix was no longer valid JSON, the parser fell back to storing that prefix as text, so secret values within the first storage-cap bytes could persist unredacted — a redaction-before-persistence violation (R-13). Auditor fix: parse/redact the full body source, then bound only the REDACTED representation; a permanent regression test proves a secret inside an oversized JSON body never persists. All unit/integration/verify gates re-run and observed green after the fix.

## 31. Remaining risks (genuine, non-blocking)

- The evidence chain detects tampering but cannot prevent a database superuser from rewriting state; docs and API language state detection-only guarantees (this is by design and documented).
- `pg_advisory_xact_lock(hashtext(runId))` uses a 32-bit text hash; two different run UUIDs could theoretically collide on the same lock key, serializing their appends unnecessarily (correctness unaffected — exclusion only, and the chain uniqueness is enforced by the `(chainIndex, runId)` unique key).
- Analysis sweep (`analyzeSettledRuns`) is triggered by the worker's reconcile interval; a Redis outage delays (never loses) analysis since derivation is idempotent and re-run on recovery.
- BullMQ payload content for queued steps is the same bounded reference-resolved structure as Phase 3 (unchanged); the canary suites cover the Phase 4 persistence paths.
- Automatic analysis-sweep recovery after a Redis outage remains a documented hardening gap: a Redis outage delays (never loses) analysis; later idempotent processing converges, because raw evidence and execution truth are durable in PostgreSQL.
- Header redaction is denylist-based by accepted design (unknown header names are kept; see §8) — a documented trade-off, not a stronger guarantee.
- The integrity chain is a linked content-hash append log, not a cryptographic accumulator (see §9); all guarantees are detection-only.
- The accepted Phase 3 reconciler has a pre-existing theoretical microsecond TOCTOU in terminal-write ordering — unmodified by Phase 4, noted for a future ADR.
- Integration timing tests are sensitive to heavily loaded environments (observed under multi-process load); they pass consistently on an unpolluted machine.

## 32. Phase 0/1/2/3 preservation

- accepted docs: untouched (README status line updated per R-17 to reflect Phase 4 — content, not decisions; no ADR contradicted)
- Phase 1 migration: untouched
- Phase 2 migrations: untouched (Demo DB unchanged)
- Phase 3 migration: untouched (0002 not modified)
- Demo schema: unchanged
- execution semantics: unchanged (evidence capture is additive; capture failure never blocks or alters execution outcomes — covered by a dedicated test)
- result: baseline `phase-3-accepted` diff contains only Phase 4 scope.

## 33. Git

- branch = `phase-4-evidence-invariants`
- files changed = 13 modified + 22 untracked source/config files (full list via `git status`; dist output gitignored)
- `git diff --check` = clean
- commit = NO
- tag = NO
- push = NO

## 34. Acceptance blockers

NONE.

## 35. Independent audit record and auditor corrections (present in the final uncommitted working tree)

Independent audit verdict (2026-09-14): **PHASE 4 ACCEPTED**. The audit independently reproduced the schema, migration, identity, idempotency, conflict, concurrency, redaction, chain, stale-worker, capture-failure, normalization, causality, invariant, provenance, API, runtime, and test claims, and made three minimal working-tree corrections, each re-verified against all quality gates:

- **AUDITOR C1 — migration EOF whitespace.** FILE = `packages/control-db/prisma/migrations/0003_phase4_evidence_invariants/migration.sql`. DEFECT = trailing blank line at EOF (`git diff --check` failure). CHANGE = removed. RE-VERIFIED = `git diff --check` clean; clean-apply 0001→0002→0003 reproduced on a fresh database; `migrate diff` migration-vs-schema consistent.
- **AUDITOR C2 — dead `strArray` helper removal.** FILE = `packages/evidence/src/demo-adapter.ts`. DEFECT = the dead helper that §30.6 claimed removed was still present. CHANGE = helper removed. RE-VERIFIED = typecheck, lint, format, build, unit, integration all green.
- **AUDITOR C3 — oversized-JSON redact-before-bound security correction.** FILE = `packages/evidence/src/redact.ts` (+ permanent regression test in `packages/evidence/src/redact.test.ts`). DEFECT = `redactBoundedText` bounded/truncated an oversized JSON body BEFORE parsing and redaction; if the truncated prefix was invalid JSON, the parser fell back to storing that prefix as text, so secret values within the first storage-cap bytes could persist unredacted — violating redaction-before-persistence (R-13). FIX (final implementation semantics): the full body source is parsed and redacted first; ONLY the REDACTED representation is then truncated to the storage cap (the cap and honest `truncated` flag remain — nothing implies unbounded storage). REGRESSION TEST = committed, proving a secret inside an oversized JSON body never persists. RE-VERIFIED = all unit/integration/verify gates re-run and observed green after the fix (unit 158/15 files, integration 110/17 files, `pnpm verify` exit 0).

All three corrections are present in the final uncommitted working tree.

Builder verdict (historical): PHASE 4 READY FOR INDEPENDENT AUDIT. Independent result: PHASE 4 ACCEPTED (2026-09-14).
