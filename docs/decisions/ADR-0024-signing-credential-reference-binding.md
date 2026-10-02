# ADR-0024: Platform-Owned Target Credential Authorization and Signing Credential Reference Binding

## Status

Accepted (pre-Phase-16 contract closure; closes the explicitly deferred Phase 13 NB-1 — "the
manifest signature seam still resolves the hard-coded `DEMO_PROVIDER_SIGNING_SECRET` credential
reference"). **REPAIRED after the first independent audit returned FAIL — CONTRACT REPAIR
REQUIRED** with exactly one blocker: the draft froze only global capability sets and the exact-one
signing intersection, leaving **no per-target credential authorization** — registration's
`credentialRefs` equality is caller-side consistency only, so any target could have declared any
globally allowed (and signing-capable) reference and been accepted. This revision freezes
platform-owned, per-target credential authorization keyed by the target's normalized origin
authority. Design/contract only: **no runtime change, no schema change, no migration, no
implementation in this change.** Implementation happens with the Phase 16 Demo Commerce target.
Forward references: [ADR-0016](ADR-0016-external-target-integration-target-manifest.md) §2
(target-manifest/v1 closed schema; `signatureHeader` declaration),
[ADR-0012](ADR-0012-credential-handling-and-redaction.md) (credential references, request-time
resolution), [ADR-0010](ADR-0010-run-snapshots.md) (frozen execution intent),
[phase-roadmap.md](../phase-roadmap.md) Phase 16 (implementation phase).

## Context

Phase 13 delivered `target-manifest/v1` (ADR-0016): a target may declare `signatureHeader` — the
header NAME carrying the executor-computed HMAC over the final body bytes — and `credentialRefs`
(names only). One seam was left explicitly deferred (the Phase 13 NB-1):

**Confirmed current behavior (all observed in the accepted Phase 13–15 code):**

1. Manifest validation accepts an arbitrary validated header name for `signatureHeader`, but its
   cross-field rule is Demo-specific: `signatureHeader` requires `credentialRefs` to include
   exactly the hard-coded `DEMO_PROVIDER_SIGNING_SECRET` reference
   (`packages/engine/src/manifest.ts` — "signatureHeader requires the DEMO_PROVIDER_SIGNING_SECRET
   credentialRef").
2. `ManifestExecutionPolicy` — the execution policy frozen into the run snapshot — carries
   `manifestVersion`, `signatureHeader`, `faultHook`, `contractMetadata`. It does **not** carry
   the credential reference the signature seam uses.
3. The executor's `${signature}` seam resolves the key with a hard-coded reference:
   `signDemoWebhookBody(finalBody, credentials.resolve('DEMO_PROVIDER_SIGNING_SECRET'))`
   (`packages/engine/src/executor.ts`, `buildHeaders`). The step's headers, the manifest, and the
   frozen policy never choose the signing key — the constant does.
4. The platform allowlist `EXECUTOR_CREDENTIAL_REFS` (`@rupturegrid/config`) is enforced
   server-side at registration and in manifest validation; today it contains exactly the three
   Demo Fintech references.
5. `credentialRefs` arrive **from the caller** on BOTH channels: the registration body and the
   manifest it carries are the same request (`apps/api/src/execution/execution.controller.ts`
   passes both through untouched). Registration checks the two lists for set equality
   (`packages/engine/src/target.ts` — "manifest.credentialRefs must equal the registration
   credentialRefs"). **That equality is consistency, not authorization**: it proves only that a
   document agrees with the request that submitted it. No code anywhere answers "is this credential
   reference authorized for THIS target's destination?"
6. The only per-target execution authority that exists is origin authority: normalized origins are
   stored per target, globally unique across all targets (`target_origin.origin` unique), and
   enforced by the executor's destination seam on every request (security-boundaries §3;
   `packages/engine/src/destination.ts`).

The consequence (the audit's cross-target scenario): if Phase 16 adds both
`DEMO_PROVIDER_SIGNING_SECRET` and `DEMO_COMMERCE_SIGNING_SECRET` to the global executor/signing
sets, a Commerce registration could declare the **Provider** signing reference — globally
executable and, under a capability-only exact-one rule, even signing-capable — and be accepted.
The Demo provider-webhook secret would then be transmitted, by design, to a different target's
origin. A global allowlist means "the deployment can potentially resolve this"; it was never "this
destination may use this". That gap is the blocker this ADR closes.

Constitutional constraints unchanged: credential VALUES never persist anywhere (R-13, ADR-0012);
credential REFERENCE names may; resolution happens only inside the executor at request time; the
run snapshot freezes execution intent (ADR-0010); historical runs never change (R-01/R-07);
`target-manifest/v1` is a closed, versioned, data-only schema (ADR-0016); the algorithm stays the
accepted HMAC-SHA256 hex over exact final body bytes (no algorithm agility in v1).

## Decision

### 1. Credential use and signing binding are PLATFORM-OWNED, not target-declared, and require no manifest schema change

`target-manifest/v1` is **unchanged**: no new JSON property (`signatureCredentialRef`,
`signingSecretRef`, `credentialPurpose`, an authorization block, or anything else) is added, and no
`target-manifest/v2` is minted. The contract-compatibility argument:

- ADR-0016 §2 already defines `credentialRefs` as "names only; a subset of the executor's
  server-side reference allowlist — ADR-0012 unchanged". Membership in the global allowlist is
  **capability** — platform-owned operational policy (`EXECUTOR_CREDENTIAL_REFS` in
  `@rupturegrid/config`), not manifest schema — and it is not authorization (§12).
- WHICH credentials a target may actually use, and WHICH credential reference supplies the HMAC
  key, are execution-policy properties owned by the platform and frozen into the run snapshot
  (ADR-0010) — the same place `signatureHeader` itself already lives. Manifest declarations remain
  names-in/names-out data. **A target's own declaration can never grant, widen, or relocate its
  credential authorization** — authorization is independent, server-owned policy (§4–§6), and
  lives OUTSIDE `target-manifest/v1` like every other security control (R-14: UI/target-side
  validation is never the security control).

### 2. Three platform-owned concepts, frozen apart (capability ≠ authorization)

The platform owns three distinct concepts. They are deliberately frozen apart because collapsing
any two of them recreates the audited blocker:

**A. GLOBAL EXECUTOR CAPABILITY — `EXECUTOR_CREDENTIAL_REFS`.** The credential reference names the
deployment can potentially resolve. Exists today (exactly the three Demo Fintech references). This
authorizes **nobody**: it is a resolution-capability fact about the deployment, not a per-target
permission.

**B. TARGET-ORIGIN CREDENTIAL GRANT — the authorization policy.** A platform-owned policy, OUTSIDE
`target-manifest/v1`, answering exactly: "May credential reference X be used on requests sent to
this normalized origin authority?" Only the grant confers target access (§4).

**C. SIGNING CAPABILITY — `EXECUTOR_SIGNING_CREDENTIAL_REFS`.** A platform-owned **subset** of the
executor set whose values may serve as `${signature}` HMAC keys; seeded in Phase 16 as exactly
`['DEMO_PROVIDER_SIGNING_SECRET']` (the v1.0 Demo signing reference). Signing capability is a
classification of credentials — it is NOT target authorization and grants access to nothing by
itself (§19).

Frozen invariants (enforced in platform configuration validation, NOT per request — §18):

    EXECUTOR_SIGNING_CREDENTIAL_REFS ⊆ EXECUTOR_CREDENTIAL_REFS
    every grant's reference name ∈ EXECUTOR_CREDENTIAL_REFS

A configuration violating either invariant is platform misconfiguration: startup/config validation
fails fast. The sets are never silently unioned, and signing capability is never an escape hatch
around credential authorization — a signing ref is an ordinary executor credential ref in every
other respect (it remains usable for normal `${credential.<REF>}` header substitution, where it is
subject to the same target-origin authorization as every other declared reference, §13).

### 3. The authorization principal: the NORMALIZED TARGET ORIGIN AUTHORITY

The security principal for credential authorization is the target's **normalized origin
authority** — the stored, normalized `scheme://host[:port]` rows of the registered target. Frozen
reasons:

- `displayName` is caller-provided metadata — it is NEVER a security principal.
- A target `id` does not exist until registration completes; authorization is evaluated DURING
  registration, before any durable row is written.
- The origin is where credential material is actually transmitted; the executor's destination seam
  already refuses to send anything anywhere except a registered normalized origin.
- Origins are normalized at registration (lowercase host, explicit port preserved), so the grant's
  stored origin and the origin the executor compares are the same canonical string.
- Origin authority is globally unique (`target_origin.origin` unique — one origin, one target),
  making the authorization question unambiguous.

Credential authorization therefore answers the one question the executor faces at send time:
"May credential reference X be transmitted in requests sent to this normalized origin authority?"
A credential granted to an origin is usable by the target that owns the origin; a credential
granted nowhere near an origin is unusable there — regardless of what any caller declared.

Explicitly frozen negatives: `displayName` is not the principal. Caller-supplied authorization —
any authorization claim inside the manifest or the registration body — is NEVER authorization. The
platform alone owns grants.

### 4. The grant model: reference names × normalized origins, platform-owned

A **target-origin credential grant** binds a credential reference NAME to authorized normalized
origins. Conceptually:

    credential ref → authorized normalized origins
    (equivalently: normalized origin → authorized credential refs)

- **Contents:** reference NAMES and normalized origins ONLY. No secret values, no key material, no
  environment contents — R-13 / ADR-0012 apply to the grant store like every durable store (§17).
- **Referential integrity:** every granted reference must be a member of
  `EXECUTOR_CREDENTIAL_REFS`; a grant naming an unknown reference fails platform configuration
  validation (§18).
- **Ownership:** grants are platform configuration, created and maintained OUTSIDE the
  target-registration request path. In the v1 single-operator trust model the operator seeds them;
  the durable representation (configuration, migration-seeded rows, or a dedicated table) is an
  implementation-time decision NOT frozen here — only the content model above is.
- **Consultation points:** registration validation (§5) and execution-policy derivation for new
  runs (§8, §16). NEVER per-request: the executor consumes the frozen snapshot policy; a
  historical run's credential use is fixed (§15–§16).

### 5. Registration authorization rule

For every NEW manifest-declaring target, for every declared credentialRef R:

1. R must be in `EXECUTOR_CREDENTIAL_REFS` (the existing allowlist rule), **AND**
2. R must be platform-authorized — a target-origin grant (§4) — for EVERY registered normalized
   origin of that target (§6).

If either fails, registration is REJECTED with bounded, name-only issues — and **no durable
registration row may be written when authorization fails** (validation precedes the transaction,
exactly as every other registration rule already does). The target/manifest declaration itself
NEVER grants credential access; neither does the equality check of §12. An authorization failure
is a registration failure, not a warning.

### 6. Multi-origin semantics: INTERSECTION, not union

`credentialRefs` are declared target-wide (one list, applied to every request the target
receives), while grants are per-origin. The target-authorized reference set is therefore the
INTERSECTION across ALL registered normalized origins of the target:

    authorizedRefsForTarget =
      ⋂ ( granted refs of each registered normalized origin of the target )

Require:

    manifest.credentialRefs ⊆ authorizedRefsForTarget

— NOT the union. A credential allowed for origin A must not automatically become usable for
origin B merely because both origins belong to one target. A reference missing from ANY origin's
grant set is not target-authorized; to use one reference across multiple origins, the platform
grants it on every one of them.

### 7. Credential-less targets stay legal

`credentialRefs: []` remains legal with no grants of any kind. Credentials are never mandatory;
the authorization requirement is vacuously satisfied by an empty declared set, and no signature
seam can exist without declared refs (§8). This closure must not be read as making credentials
required.

### 8. The repaired signing pipeline: authorization FIRST, then the exact-one capability intersection

For a manifest that declares `signatureHeader`, the platform computes at validation/derivation
time in TWO stages:

**Stage 1 — authorization.** ALL manifest `credentialRefs` are validated against platform-owned
target-origin authorization (§5–§6). A manifest that fails Stage 1 is rejected before any signing
question is asked; registration writes nothing.

**Stage 2 — capability, over the authorized subset only:**

    declaredSigningRefs =
      AUTHORIZED manifest.credentialRefs  ∩  EXECUTOR_SIGNING_CREDENTIAL_REFS

requiring `declaredSigningRefs.length === 1`:

- **Zero** → the manifest is REJECTED: no signing credential can back the declared signature seam.
  This replaces the Demo-specific rule "signatureHeader requires `DEMO_PROVIDER_SIGNING_SECRET`"
  with the generic platform-policy rule.
- **More than one** → the manifest is REJECTED: the signing-key binding would be ambiguous. No
  selection among candidates exists — not first, not last, not lexicographic, not
  name-convention-based (no `contains SECRET`/`contains SIGNING` heuristic, no prefix/suffix
  convention, no environment scanning, no "whatever resolves", no header-name- or action-path-based
  choice, and no choice from live registration at execution time). No ordering or naming heuristic
  may ever determine cryptographic key identity.
- **Exactly one** → that reference NAME is the deterministic signature credential binding, frozen
  into the derived execution policy.

The Stage 2 input is the **authorized** declared subset, never the raw declared list: a signing
classification can never resurrect a reference that authorization removed. For re-derivation from
a stored manifest (new runs), Stage 1 re-runs under the CURRENT grants — a manifest whose
authorization no longer holds fails closed and freezes no new snapshot (§16).

The intersection is with **manifest-declared** refs, never the platform signing set alone: a
signing-capable ref the manifest does not declare is unavailable to that target's signature seam.
The TARGET declares which credentials it uses; the PLATFORM alone decides whether the target may
use them at all and which of them are signing-capable. A target declaration can never elevate an
arbitrary credential into a signing key — nor into a usable credential of any kind.

### 9. Frozen execution policy gains `signatureCredentialRef` (internal field, not manifest JSON)

For manifest-derived policies derived AFTER this closure, `ManifestExecutionPolicy` carries BOTH:

- `signatureHeader` — the declared header name (unchanged field), and
- `signatureCredentialRef` — the already-resolved, NON-SECRET reference NAME selected by the
  two-stage rule (§8) — a reference that is BOTH authorized for the target destination AND
  signing-capable (new internal policy field).

Example internal policy shape (values illustrative):

```json
{
  "signatureHeader": "x-commerce-signature",
  "signatureCredentialRef": "DEMO_COMMERCE_SIGNING_SECRET"
}
```

This is platform-derived execution policy frozen into the run snapshot — it is NOT a manifest JSON
extension and never enters a target-manifest/v1 document. The secret VALUE is structurally absent
(ADR-0012; the policy layer never sees values at all).

**Pair invariant (frozen):** in every NEWLY derived policy,

    signatureHeader present  ⟺  signatureCredentialRef present

A header without a ref is invalid; a ref without a header is invalid; a policy builder MUST be
unable to emit either half-state. A manifest without `signatureHeader` has no signature seam at
all: the derived policy carries neither field, and no implicit signing is ever activated by the
mere presence of signing-capable names in `credentialRefs`.

**Manifest without `signatureHeader` but declaring a signing-capable ref:** legal and unused for
signing (option A). The ref remains an ordinary credential ref usable by normal
`${credential.<REF>}` substitution — subject, as everywhere, to target-origin authorization
(§5, §13); declaring it creates no signature seam. This is the smallest rule consistent with
current credential semantics — the exact-one rule fires only when `signatureHeader` is declared —
and it does not over-constrain unrelated credential use.

### 10. Runtime semantics (implementation contract for the seam)

When a step header on the executor-owned signature header contains the literal `${signature}`
token, the executor:

1. requires the final request body (existing fail-closed behavior — `${signature}` signs the
   exact FINAL body bytes; a body-less request with `${signature}` fails before send, unchanged);
2. uses the FROZEN `signatureCredentialRef` from the snapshot's execution policy — a reference
   that was authorized for the target's origins at derivation time by construction (§8);
3. resolves that reference at request time through the `CredentialResolver`
   (ADR-0012: values only ever exist inside the executor environment/request-time call frame);
4. computes HMAC-SHA256 hex over the final body bytes (accepted v1 algorithm, unchanged —
   `signDemoWebhookBody` semantics);
5. places the result in the frozen `signatureHeader`.

Step/request data MUST NOT choose the signing reference: `${signature}` is and remains a bare
reserved token selecting the platform-frozen seam. The signature header may ONLY carry the
literal `${signature}` token (already enforced at definition validation); parameterized forms
(`${signature.SOME_REF}`, `${signature:REF}`, `${hmac:REF}`, key-id selections, algorithm
selections) do not exist in v1 and are forbidden — scenario data must never become a
secret-selection surface.

**Missing runtime secret:** if the frozen `signatureCredentialRef` is legitimate but the executor
environment cannot resolve it, execution fails BEFORE request transmission through the existing
`CredentialResolutionError` / pre-send semantics. No fallback to another ref, no unsigned send,
no literal-token send, no environment contents revealed. The reference NAME may appear in the
bounded error (consistent with current ADR-0012 behavior); the secret VALUE never does.

**Legacy manifest-less targets are byte-semantically unchanged:** the manifest-less path keeps
its explicit constants — `LEGACY_SIGNATURE_HEADER` (`x-rupturegrid-provider-signature`) and the
`DEMO_PROVIDER_SIGNING_SECRET` resolution — exactly as accepted (§14). Legacy behavior is not
NB-1; the v1.0 Demo Fintech path retains the historical constants where compatibility requires
them. The hard-coded reference may persist ONLY on that legacy path and in the Phase-13
historical compatibility rule (§15); it MUST NOT be required by the generic manifest path.

### 11. Cross-target credential attacks fail closed (frozen scenarios)

Phase 16 deployment shape: both `DEMO_PROVIDER_SIGNING_SECRET` and
`DEMO_COMMERCE_SIGNING_SECRET` are members of `EXECUTOR_CREDENTIAL_REFS` AND of
`EXECUTOR_SIGNING_CREDENTIAL_REFS`; grants authorize the Provider reference for the Provider
target's origin(s) and the Commerce reference for the Commerce origin(s) — and nothing else.

- **Commerce → Provider (the audited attack):** Commerce attempts to register declaring
  `credentialRefs: ['DEMO_PROVIDER_SIGNING_SECRET']` with its own `signatureHeader`
  (`X-Commerce-Signature`). Expected: **REJECT REGISTRATION.** The reference is globally
  executable and signing-capable, but it is NOT granted for the Commerce origin; Stage 1 rejects
  before the exact-one rule is even evaluated, and no registration row is written.
- **Provider → Commerce (reverse):** Provider attempts to register declaring
  `DEMO_COMMERCE_SIGNING_SECRET`. Expected: **REJECT.** Both directions are frozen.
- **Globally allowed but ungranted, any use:** any declared reference without a grant for the
  target's origins is rejected with or without a `signatureHeader` — ordinary
  `${credential.<REF>}` substitution is covered by the same Stage 1 (§13).

### 12. Global sets are not authorization; the equality rule is CONSISTENCY

Stated explicitly, because the pre-repair draft permitted the blunder:

- `EXECUTOR_CREDENTIAL_REFS` — the deployment can potentially resolve this reference.
- `EXECUTOR_SIGNING_CREDENTIAL_REFS` — this reference may serve as a signing key (for targets
  authorized to use it at all).
- TARGET-ORIGIN CREDENTIAL GRANT — this target destination is authorized to use this reference.

**Only the third grants target access.** Membership in either global set never implies it.

The existing registration rule is KEPT unchanged:

    manifest.credentialRefs == registration.credentialRefs

but documented honestly as **CONSISTENCY**: both lists are supplied by the SAME caller in the
same request, so equality proves only that the manifest describes the registration it arrived
with. It is not, and must never be implemented or documented as, authorization. Authorization is
independent, server-owned policy (§4), evaluated in addition to — never instead of — the
consistency check.

### 13. Ordinary `${credential.<REF>}` substitution is equally covered

For NEW manifest-declaring targets, target-origin authorization governs ALL declared credential
refs — not only signing refs. An ordinary `${credential.<REF>}` substitution in a step header can
no more transmit an ungranted cross-target reference than the signature seam can (§11, attack
three). The substitution mechanism itself is NOT redesigned: same request-time resolution
(ADR-0012), same redaction-before-persistence, same fail-fast `CredentialResolutionError`. This
closure freezes only the authorization boundary in front of registration and derivation.

### 14. Legacy manifest-less targets are unchanged

The v1.0 Demo Fintech manifest-less path keeps its explicit constants —
`LEGACY_SIGNATURE_HEADER` (`x-rupturegrid-provider-signature`), the `DEMO_PROVIDER_SIGNING_SECRET`
resolution, and the legacy fault gate — exactly as accepted. Target-origin grants are NOT
consulted on the legacy path; no grants are required for the already-accepted v1.0 registration;
nothing about it is rewritten by this closure. Legacy behavior is not NB-1. The hard-coded
reference may persist ONLY on that legacy path and in the Phase-13 historical compatibility rule
(§15); it MUST NOT be required by the generic manifest path. New external-target onboarding in
v1.1 is manifest-declaring by definition (ADR-0016 §1) and is therefore fully governed by this
authorization model.

### 15. Historical frozen policies — explicit compatibility, no rewrite

Accepted Phase 13–15 code already froze manifest policies of the OLD shape:
`signatureHeader` present, `signatureCredentialRef` absent. Stored snapshots are never mutated,
rewritten, or re-hashed (R-01, ADR-0010); their behavior is preserved by ONE explicit rule:

> A frozen manifest-derived execution policy with `signatureHeader` present and
> `signatureCredentialRef` absent is a **Phase-13 historical policy**: its signature seam resolves
> `DEMO_PROVIDER_SIGNING_SECRET` — exactly what the accepted Phase 13–15 executor did for every
> such policy that could ever have been frozen.

This is an explicit, named historical-policy compatibility path, distinguished structurally by
the absence of the field in the frozen policy object — not a heuristic, not a general fallback,
and not a re-selection (the executor environment is never scanned for alternatives). The fallback
exists ONLY to preserve accepted historical snapshot behavior: newly derived policies always
freeze the ref (pair invariant), so a newly built policy can never rely on or trigger the
fallback, and the pair invariant is what makes the old shape unambiguous (an old-shape policy
could only ever have been derived from a manifest whose signing ref was
`DEMO_PROVIDER_SIGNING_SECRET`, because the accepted Phase 13 validation enforced exactly that).
Historical policies are never re-evaluated against grants: grant changes do not reach them
(§16).

Two honest consequences, frozen:

- Re-deriving execution policy from an unchanged stored manifest (definition-time re-validation
  and any NEW snapshot freeze of the same revision) now yields the NEW shape with
  `signatureCredentialRef` set — for every manifest accepted to date that resolves to
  `DEMO_PROVIDER_SIGNING_SECRET`, the frozen binding is byte-equivalent to the Phase-13
  behavior (provided the platform has granted that reference for the Demo target's origins — a
  Phase 16 seeding obligation, §20). Content-addressing means such a new freeze is a NEW snapshot
  row (new content hash); existing snapshot rows and the runs that reference them are untouched.
  This is the documented ADR-0010 model: a run's intent is the snapshot it was created from, and
  replay creates new runs from the stored snapshot.
- Fail-closed provenance re-validation (the existing `deriveExecutionPolicy` discipline) applies
  unchanged: stored provenance that no longer validates — including manifest data whose
  credential authorization no longer holds (§16) — can never silently become policy.

### 16. Drift model — ref identity is frozen per run; policy is re-derived per new run

The snapshot freezes the REFERENCE NAME, never the value (ADR-0012). Frozen, separated concerns:

- **Ref identity: FROZEN.** Once a snapshot carries `signatureCredentialRef = X`, execution uses
  X. Later changes to registration, the target's manifest, the platform signing classification,
  or grants MUST NOT cause a frozen run to reselect a ref (no live-registration lookup during
  execution; the signing set and grants are consulted only at policy derivation — manifest
  validation, registration, and snapshot freeze — never at execution).
- **Secret value: RUNTIME-RESOLVED.** The value behind the frozen ref may rotate; resolution at
  request time uses the current environment value, exactly as ADR-0012 permits (credential
  rotation is a supported operation; fingerprint mismatch handling is unchanged).
- **New runs use the policy appropriate at their creation.** At T1 a manifest declares refs
  A + B and the platform resolves the authorized signing ref A into the frozen policy; at T2
  registration, manifest, grants, or the signing set change — the old run still uses frozen A; a
  new run freezes the newly validated policy.
- **Grant drift, historical runs: NONE.** Grants are consulted at registration and derivation,
  never at execution. A later grant change (addition or revocation) never rewrites,
  re-evaluates, or re-derives a frozen run's policy — including the Phase-13 historical fallback
  of §15.
- **Grant drift, new runs: re-validated, fail closed.** Policy derivation for a NEW run re-runs
  Stage 1 (§8) under the CURRENT grants, with the same fail-closed discipline as manifest
  re-validation. A stored manifest whose declared refs are no longer authorized for the target's
  registered origins cannot freeze a new snapshot; no new run is created from it. No snapshot
  row is ever rewritten.
- **Signing-set drift, historical runs: NONE.** Unchanged from the frozen model: the signing set
  is consulted only at policy derivation — never at execution.

### 17. Secret persistence surface (unchanged by this closure, enumerated)

Allowed to persist: the signature header NAME; the signature credential REFERENCE NAME (snapshot
policy, registration rows, manifest provenance); credential grant records (reference names +
normalized origins ONLY — §4); credential fingerprints if already allowed; redaction metadata.
Forbidden everywhere (manifest, registration JSON, snapshots, logs, evidence, errors, timeline,
AI inputs, and the grant store): signing secret VALUES, HMAC key material, substituted
credential-bearing header values before redaction, environment dumps. The reference name is
non-secret by construction (it is an environment-variable-style name, validated as such, and
already persists in `credentialRefs` today).

### 18. Platform configuration invariants (subset + grant referential integrity)

The following are enforced once, at platform configuration/startup validation (`packages/config` —
the same fail-fast environment validation discipline as every other config invariant); individual
requests never rediscover them; manifest/registration validation may rely on them:

    EXECUTOR_SIGNING_CREDENTIAL_REFS ⊆ EXECUTOR_CREDENTIAL_REFS
    every grant's reference name ∈ EXECUTOR_CREDENTIAL_REFS

A platform configuration where a signing ref is not an executor ref — or where a grant names a
reference the deployment cannot resolve (a stale grant) — is internally invalid and refuses to
start.

### 19. What this closure does NOT do (non-generalization, and the no-overclaim rule)

It generalizes ONLY which platform-approved credential reference supplies the HMAC key, and it
adds the per-target authorization that makes credential use sound. It does NOT create algorithm
agility and does not solve problems Phase 16 does not need: no algorithm field, no SHA-variant
selection, no asymmetric signatures, no key ids, no multiple simultaneous signatures, no encoding
options, no canonical request signing. Accepted v1 behavior stays: HMAC-SHA256, hex, over the
exact final body bytes. Signing stays an executor-owned computation (triggered solely by the
reserved `${signature}` token on the frozen signature header); there is no business-truth impact —
no evidence truth, no invariant truth, no completeness effect, no attribution change, no
PASS/FAIL/NOT_EVALUABLE semantics change (Phase 15 untouched).

**No-overclaim rule (frozen):** this closure does NOT claim that signing capability alone
prevents arbitrary credential selection. By itself, a signing classification over a global set
would still let any target declare any signing-capable reference — that is exactly the audited
blocker. Signing capability only classifies which authorized references may serve as HMAC keys;
TARGET-ORIGIN AUTHORIZATION (§4–§6) is the mechanism that scopes credential use per destination.
Neither mechanism alone is sufficient; both are required, evaluated in the order Stage 1 →
Stage 2 (§8).

### 20. Phase 16 readiness (the point of the closure)

After implementation, Demo Commerce onboards with zero business-specific executor code:

- `packages/config` gains the Commerce signing reference (conceptually
  `DEMO_COMMERCE_SIGNING_SECRET` — the exact name is fixed at implementation) in BOTH platform
  sets, plus its environment wiring; the executor learns no Commerce constant and no
  Commerce-specific branch (`if commerce` is not required and must not exist).
- The platform also gains the target-origin grant model (§4) with its configuration invariants
  (§18), seeded with grants for the Commerce origin(s) (`DEMO_COMMERCE_SIGNING_SECRET`) and for
  the Demo Fintech origin(s) (`DEMO_PROVIDER_SIGNING_SECRET` — required for manifest-declaring
  registrations of the Demo target, which already exist in the accepted Phase 13 suites).
- Registration (§5–§6) and policy derivation (§8) enforce authorization; the executor consumes
  frozen policy only (§10).
- The Commerce target registers a `target-manifest/v1` manifest declaring its own
  `signatureHeader` and `credentialRefs` containing the platform-approved, origin-granted
  Commerce signing ref; the two-stage rule freezes it into the run snapshot at run creation.
- The credential resolver construction (currently Demo-shaped) generalizes to resolve any
  platform-allowed reference from the validated executor environment; this is an implementation
  obligation of the implementing phase, not a new seam in this contract.

## Consequences

- NB-1 is closed at the contract level: the manifest signature seam's credential binding is
  deterministic, platform-owned, frozen per run, target-generic — and now rests on per-target
  authorization instead of global capability alone.
- A target can no longer be accepted with (a) a signature header the platform cannot back (zero
  declared authorized signing refs), (b) an ambiguous one (two or more), or (c) ANY declared
  credential the platform has not granted to the target's origins — rejection happens at
  registration/manifest validation with deterministic, bounded, name-only issues, not at
  execution.
- The frozen policy grows one internal field; snapshots for newly frozen manifest runs with
  signature seams change content hash accordingly (§15) — honest, versioned, and never applied to
  stored snapshots.
- Cost accepted: the platform maintains a second allowlist AND a per-origin grant model, and every
  future credential must be both globally classified and explicitly granted per origin — this is
  the intended friction: resolution capability is a deployment fact, target authorization is a
  security decision, and signing capability is a security classification; none of them is a
  naming convention.

## Required implementation test matrix (frozen acceptance tests)

The implementing phase (Phase 16) commits tests proving at least:

1. Legacy manifest-less target → old header + `DEMO_PROVIDER_SIGNING_SECRET` behavior unchanged;
   grants are never consulted on the legacy path.
2. Manifest `signatureHeader` + exactly one declared signing-capable ref, authorized for the
   target's origins → valid; policy freezes that ref.
3. Manifest `signatureHeader` + zero declared signing-capable refs → rejected.
4. Manifest `signatureHeader` + two declared signing-capable refs → rejected (ambiguity; the
   bounded issue may name the reference NAMES, never values).
5. Signing-capable ref platform-configured but NOT declared by the manifest → rejected /
   unavailable to that target's signature seam.
6. Declared ref outside `EXECUTOR_CREDENTIAL_REFS` → rejected (existing allowlist rule).
7. `EXECUTOR_SIGNING_CREDENTIAL_REFS` not a subset of `EXECUTOR_CREDENTIAL_REFS` →
   config/startup rejection.
8. Manifest without `signatureHeader` → no signature seam, no signature policy fields, and a
   declared signing-capable ref remains usable for ordinary `${credential.<REF>}` substitution
   without activating signing.
9. New manifest-derived snapshot freezes `signatureCredentialRef` alongside `signatureHeader`.
10. Live registration changed after run creation → the old run still uses the frozen ref.
11. Platform signing classification changed after run creation → the old run does not reselect.
12. Secret VALUE rotated behind the same frozen ref → runtime resolver uses the current value
    (ADR-0012), replay semantics unchanged.
13. Frozen ref missing from the runtime environment → pre-send `CredentialResolutionError`; no
    send, no fallback, no secret/environment exposure.
14. Secret value absent from: snapshot, stored manifest JSON, logs, evidence, error messages,
    grant records.
15. `${signature}` signs the exact FINAL body bytes using the frozen ref (HMAC-SHA256 hex).
16. Body missing with `${signature}` → existing fail-closed pre-send behavior.
17. Historical frozen manifest policy (header present, ref field absent) → explicit Phase-13
    compatibility path resolves `DEMO_PROVIDER_SIGNING_SECRET`; stored snapshot bytes untouched;
    replay from the historical snapshot behaves identically to accepted Phase 13–15 behavior.
18. New policy builder can NEVER emit header-present + ref-absent.
19. New policy builder can NEVER emit ref-present + header-absent.
20. Demo Commerce conceptual fixture uses a non-Fintech signing ref end-to-end with no
    business-specific executor branch and no engine-known Commerce constant.
21. Cross-target attack (Commerce → Provider): both signing refs globally executable and
    signing-capable; Commerce registers declaring `DEMO_PROVIDER_SIGNING_SECRET` with its own
    `signatureHeader` → registration REJECTED (not granted for the Commerce origin); no durable
    registration row; the bounded issue names references/origins, never values.
22. Reverse attack (Provider → Commerce): Provider registers declaring
    `DEMO_COMMERCE_SIGNING_SECRET` → REJECTED. Both directions are frozen.
23. Globally allowed but ungranted, ordinary use: a manifest declares an executor-allowed,
    non-granted ref with NO `signatureHeader` (intended for ordinary `${credential.<REF>}`
    substitution) → registration REJECTED (authorization governs all declared refs, not only
    signing).
24. Equality without authorization: `manifest.credentialRefs == registration.credentialRefs`, all
    refs globally allowed, no origin grant → REJECTED (the equality rule is consistency, never
    authorization).
25. Credential-less target: `credentialRefs: []` and an empty grant set → registration ACCEPTED;
    no signature seam; no policy signature fields.
26. Multi-origin intersection, reject: a ref granted for origin A only; the target registers
    origins A + B declaring it → REJECTED (intersection semantics — missing from B's grant set).
27. Multi-origin intersection, accept: a ref granted for EVERY registered origin → accepted;
    `declaredSigningRefs` computed over the intersection.
28. Grant revoked after registration → historical runs and stored snapshots unchanged; a NEW run
    from the unchanged stored manifest fails closed at policy re-derivation (no new snapshot
    row, no rewrite of any existing row).
29. Grant lifecycle: the identical registration bytes are rejected before the grant exists and
    accepted once it does — declarations enable nothing; grants do.
30. Grant-store hygiene: grants persist reference NAMES + normalized origins ONLY; a grant naming
    a ref outside `EXECUTOR_CREDENTIAL_REFS` fails platform configuration validation; no secret
    value ever enters the grant store.

## Alternatives considered

- **Keep the fixed Demo reference as the generic contract** — rejected: it is the NB-1 defect;
  Demo Commerce would either share Demo Fintech's provider-webhook secret or force a second
  hard-coded executor branch.
- **No per-target authorization (global capability sets only)** — rejected: that is the audited
  blocker; "the deployment can potentially resolve this reference" is a capability fact about the
  deployment, not a decision about a destination.
- **A new manifest field (`signatureCredentialRef`/`signingSecretRef`/`credentialPurpose`/an
  authorization block) in target-manifest/v1** — rejected: the manifest is a closed data-only
  schema (ADR-0016 §2), and caller-declared authorization is not authorization; it would make
  target data a secret-capability/policy declaration and require either schema extension under
  the same version (forbidden) or a v2 that nothing needs (§1). The platform already owns the
  allowlist the names live in; classification and authorization belong there.
- **`displayName` as the authorization principal** — rejected: caller-provided display metadata is
  not a security identity; renames would break or force rewrites of authorization; displayName
  uniqueness is a registration convention, not a security property.
- **`targetId` as the authorization principal** — rejected: authorization is evaluated during
  registration, before any target id exists; ids are internal surrogates, while origins are the
  stable authorities the executor actually enforces at send time.
- **Per-origin UNION semantics (a ref usable if granted on ANY of the target's origins)** —
  rejected: a credential allowed for origin A must not silently become usable for origin B.
- **Scenario- or step-selected credential authorization** — rejected: scenario data must never
  become a credential-selection surface (consistent with `${signature}` staying bare).
- **Ordering/name heuristics (`credentialRefs[0]`, last, lexicographic, `contains SECRET`,
  `contains SIGNING`, prefix/suffix conventions, "first ref that resolves", environment scanning,
  "any available credential", header-name- or action-path-based choice)** — rejected: no ordering
  or naming heuristic may determine cryptographic key identity; all are ambiguous, spoofable by
  declaration order or naming, and none is deterministic platform policy.
- **Live-registration lookup at execution time to pick the signing ref** — rejected: violates the
  frozen-intent model (ADR-0010); historical runs would silently change meaning with registration
  edits.
- **Scenario-selected signing (`${signature.<REF>}` token parameterization)** — rejected:
  converts scenario data into a secret-selection surface; the reserved `${signature}` token stays
  bare.
- **Algorithm agility (algorithm field, key ids, asymmetric signatures, encodings)** — rejected:
  out of scope for v1.1 (§19); the accepted HMAC-SHA256 mechanism is not the defect.
- **Mint `target-manifest/v2`** — rejected: no compatibility break exists that requires it; the
  internal binding and platform-owned authorization (§1–§8) solve NB-1 entirely inside
  platform-owned policy.
- **Reject manifests that declare a signing-capable ref without a `signatureHeader`** — rejected
  as over-constraining: such refs remain ordinary credential refs for `${credential.<REF>}`
  substitution (§9).
