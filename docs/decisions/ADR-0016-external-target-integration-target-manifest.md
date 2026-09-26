# ADR-0016: External Target Integration — target-manifest/v1

## Status

Accepted (Phase 12 — design freeze; implementation in Phase 13).

## Context

v1.0 proves RuptureGrid deeply against one purpose-built target. The platform's biggest remaining
product risk is generalization: every business-truth vocabulary above the executor (contract
semantics, evidence adapters, normalizers, causal derivation, invariant evaluators, finding rules)
is currently Demo-Fintech-shaped (see the Phase 12 audit: `ContractKind` closed to
`DEMO_FINTECH_WEBHOOK`/`GENERIC_HTTP`, two `demo-fintech-*` adapter kinds, `demo.*` event
vocabularies, a finding rule that refuses any invariant other than INV-IZ-1). A second target
cannot be onboarded today without either rewriting frozen v1.0 truth or hardcoding a second copy
of everything.

The v1.1 theme (Second-Domain Generalization Proof) requires a second, independent domain to be tested
end-to-end. Constitution constraints that shape any onboarding mechanism:

- R-05 / ADR-0002: RuptureGrid never touches target business state; targets stay external in kind.
- ADR-0012 / R-13: credentials are references, redacted before persistence; secrets never persist.
- R-03: no fake evidence — a target's own declarations cannot manufacture RuptureGrid truth
  (this ADR's most important consequence; see Decision 5).
- R-14 / ADR-0011: production fault targeting stays denied; fault execution stays
  LOCAL_DEVELOPMENT-only; UI validation is never the security control.
- The v1.0 golden suites must keep passing unchanged (frozen history; R-01).

A manifest is metadata about an external system. It must never become executable content
(no code, no SQL, no expressions), must be closed-schema, and must be validated server-side
at registration (R-14).

## Decision

1. **`target-manifest/v1` is the single integration surface for external targets.** A target
   integrates by registering with a pure-JSON manifest. It imports no RuptureGrid package, shares
   no database, and exposes only its own legitimate HTTP interfaces. RuptureGrid holds no target
   database credentials (lint-enforced per target, as already done for `demo-db`).
2. **The manifest schema is closed, versioned, and data-only.** v1 fields:
   - `manifestVersion` (exactly `target-manifest/v1`; unknown versions are refused, never guessed),
   - `displayName`, `environment` (`LOCAL_DEVELOPMENT` | `STAGING`; production registration is
     refused in v1.x — unchanged from ADR-0011),
   - `origins` (normalized `scheme://host:port` list; global origin uniqueness unchanged),
   - `credentialRefs` (names only; a subset of the executor's server-side reference allowlist —
     ADR-0012 unchanged),
   - `contract`: the response-semantics class plus optional target-declared metadata (Decision 5),
   - `signatureHeader` (optional): the header name carrying the executor-computed HMAC over the
     final body bytes. The `${signature}` token mechanism, raw-byte HMAC computation, and
     secret-never-in-document guarantees are unchanged from v1.0; only the header NAME becomes
     declarable instead of hard-coded. The name must pass the validated header-name rules
     (no CR/LF, no forbidden framing headers).
   - `inspection`: named read-only lineage queries (`inspection/v1`; the typed field declarations
     they carry are defined in ADR-0017),
   - `faultHook` (optional): declares the target-owned controlled-fault surface (endpoint + kinds)
     the target itself implements under `controlled-fault/v1`. This REPLACES the v1.0 hard-coded
     gate (contract `DEMO_FINTECH_WEBHOOK` AND path exactly `/webhooks/provider`): a fault plan is
     accepted only when the step targets the manifest-declared hook of a manifest-declaring
     target. The environment gate is unchanged (LOCAL_DEVELOPMENT only), and the plan vocabulary,
     TTL, trigger budgets, and target-side ownership (ADR-0014) are unchanged. The gate is
     re-derived at execution time from the frozen snapshot (defense in depth, unchanged).
   - `sensitiveFields`: the target's redaction-registry extension (security-boundaries §7).

   Unknown fields are rejected. Size caps apply. The manifest is stored as registration
   provenance; it is never executable and is never interpreted beyond the declared vocabularies.
3. **Conservative generic contract semantics are preserved.** For a mutating action under
   `GENERIC_HTTP`: definitive 2xx ⇒ `KNOWN_OCCURRED`; any post-send failure (timeout after send,
   connection reset, 5xx without a platform-defined no-effect guarantee) ⇒ `INDETERMINATE`;
   pre-send failures ⇒ `KNOWN_ABSENT`. This is exactly the v1.0 conservative table and does not
   change (architecture §7.1).
4. **Demonstration target, not a sample zoo.** `apps/demo-commerce` (Phase 16) is the second
   external-in-kind target and the sole subject of the Phase 19 stranger onboarding test: a fresh
   contributor must be able to connect it and run one scenario using only its registered HTTP
   interface, manifest, inspection contract, credential references, and a scenario definition.
   No separate `examples/reference-target` is created in v1.1 (redundant with demo-commerce; the
   audit that would justify one has not happened).
5. **Target claims never create truth.** A target MAY declare `noEffectOnRejection: true` inside
   `contract` metadata. This is recorded as **target-declared contract metadata** — provenance
   about what the target claims about its own responses. It is NOT RuptureGrid truth and MUST NOT
   by itself allow `KNOWN_ABSENT` classification of a rejection. For a mutating action,
   `KNOWN_ABSENT` remains available only through platform-defined mechanisms that already exist:
   (a) a definitive rejection under a contract class whose no-effect guarantee is
   **platform-defined** (in v1.0, `DEMO_FINTECH_WEBHOOK` — established and adversarially audited
   in Phase 3); or (b) direct executor observation that the request never crossed transport
   (`transportStage` below `REQUEST_SENT`). A generic `GENERIC_HTTP` target that merely asserts
   `noEffectOnRejection` still receives `INDETERMINATE` for post-send definitive rejections.
   A platform-defined contract class with a no-effect guarantee may be added later only through a
   new ADR with adversarial evidence (controlled faults are the probe class that exercises such
   guarantees). The declaration is persisted so the classification basis of every invocation is
   auditable from evidence.
6. **Registration remains deny-by-default.** A manifest grants nothing by itself: executable work
   still requires registered origins, server-side blast-radius caps, and environment authorization
   exactly as in v1.0 (security-boundaries §2, §8).
7. **Scope/exclusivity declarations are provenance, never truth.** A manifest may declare facts
   about its own state behavior (for example, that a target is experiment-exclusive, or that its
   inspection surface returns a state generation/epoch identifier). Every such declaration is
   target-declared metadata — recorded provenance about what the target claims, exactly like
   `noEffectOnRejection` (Decision 5). A declaration MUST NOT by itself create platform truth:
   verification-scope coherence for state/conservation invariants must be *established* from
   observed evidence under the declared inspection contract (ADR-0018 Decision 7); where the
   evaluator cannot establish that baseline, effects, and final state belong to one coherent
   verification scope, the verdict is `NOT_EVALUABLE`. The implementation mechanism (state
   generation/reset token, snapshot/generation identifier, verified experiment-exclusive state,
   or another deterministic mechanism) is a Phase 14/15 decision; Phase 12 freezes only the
   requirement and this declaration/truth boundary. Timestamps are never used as causal identity
   for scope binding.

## Consequences

- One seam unlocks the later v1.1 phases: Phase 13 (manifest storage + registration API),
  Phase 14 (generic inspection adapter + manifest-driven derivation), Phase 16 (demo-commerce as
  the proof target).
- The v1.0 golden path keeps working unchanged: the Demo Fintech target's manifest is derived
  from its existing registration; `DEMO_FINTECH_WEBHOOK` semantics are untouched; the frozen
  verifier suites must stay green in Phase 13 (back-compat proven by the existing suites, never
  assumed — R-07).
- The claim/provenance split (Decision 5) keeps the conservative execution model intact: a lying
  or mistaken target cannot make RuptureGrid classify ambiguity as absence. `INDETERMINATE`
  remains the honest default for the generic case (ADR-0008).
- Future targets with different identity structures are onboardable without changes to the truth
  chain (ADR-0017).
