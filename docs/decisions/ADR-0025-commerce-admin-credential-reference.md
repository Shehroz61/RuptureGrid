# ADR-0025: Commerce admin credential reference joins the executor set

- **Status:** Accepted (Phase 17)
- **Date:** 2026-10-06
- **Deciders:** Phase 17 implementation review
- **Supersedes:** nothing (extends ADR-0024)
- **Related:** ADR-0012 (credential reference indirection), ADR-0016
  (target manifests), ADR-0020 (Checkout Zero), ADR-0024 (signing
  credential reference binding), docs/security-boundaries.md,
  docs/checkout-zero.md

## Context

Phase 17 wires the Checkout Zero golden scenarios for real headless
execution (ADR-0019/ADR-0020). The scenarios' setup step authenticates
to the Demo Commerce target's own admin API (`POST
/demo/admin/scenario`) with a bearer token. The v1.0 implementation of
that target trusts exactly one admin secret — `COMMERCE_ADMIN_TOKEN`
(apps/demo-commerce/src/auth.ts, commerceConfigSchema) — which is a
DIFFERENT secret from the Demo Fintech admin token (`DEMO_ADMIN_TOKEN`).

Phase 16 never surfaced this: its matrix only exercised the engine's
SIGNING seam (`${signature}` bound to
`DEMO_COMMERCE_SIGNING_SECRET`), and registration/authorization
semantics — no experiment step ever authenticated to a Commerce admin
route. The Phase 17 scenarios initially carried
`DEMO_ADMIN_TOKEN`/`credential.DEMO_ADMIN_TOKEN`; against the real
target this is a guaranteed 401: a cross-target trust confusion, not a
config typo. Two distinct targets must not share one admin secret, and
a generic HTTP experiment must never silently authenticate to a target
with another target's credential.

## Decision

1. `COMMERCE_ADMIN_TOKEN` joins `EXECUTOR_CREDENTIAL_REFS`
   (packages/config) as the FIFTH reference. The set stays CLOSED and
   explicit — the reference exists because the Commerce target owns and
   exposes an admin trust boundary that real scenario steps must
   satisfy. No naming heuristic is introduced; the set is extended by
   exactly one reviewed constant.
2. The worker's generic credential resolver gains the
   `COMMERCE_ADMIN_TOKEN` value from validated worker config
   (`COMMERCE_ADMIN_TOKEN: demoSecretOptional`). Resolution stays
   request-time-only, secret-free in errors and logs (ADR-0012, R-13).
   A missing value fails the step pre-send with a bounded
   `CredentialResolutionError`.
3. The committed Commerce manifest declares
   `["DEMO_COMMERCE_SIGNING_SECRET", "COMMERCE_ADMIN_TOKEN"]` — the
   exact references its real protocol surface needs. Registration
   consistency (equality of registration and manifest refs), platform
   grants (per-origin intersection), and the two-stage signing binding
   are UNCHANGED (ADR-0024 §6–§12): `COMMERCE_ADMIN_TOKEN` is ordinary
   (non-signing-capable); `EXECUTOR_SIGNING_CREDENTIAL_REFS` is NOT
   extended.
4. The Checkout Zero golden scenarios authenticate admin steps with
   `${credential.COMMERCE_ADMIN_TOKEN}` and declare
   `credentialRefs: ["COMMERCE_ADMIN_TOKEN"]` on exactly those steps.
5. `.env.example`'s `TARGET_ORIGIN_CREDENTIAL_GRANTS` grants
   `COMMERCE_ADMIN_TOKEN` (not `DEMO_ADMIN_TOKEN`) for the Commerce
   origin.

## Consequences

- Cross-target admin-token confusion is structurally impossible: a
  step naming `DEMO_ADMIN_TOKEN` against the Commerce target fails
  authorization (undeclared) even if the platform granted it, and
  could never authenticate (different secret).
- The engine's generic machinery needed NO change: declaration,
  authorization, resolution, and execution treat the new reference
  identically to every existing one (the resolver's documented
  extension point).
- `EXECUTOR_CREDENTIAL_REFS` consumers (destination seam, B-1 token
  boundary, grant validation) accept the larger closed set without
  code change; existing grants remain valid.
- Phase 16's integration suite updates its fixture constant
  `COMMERCE_ADMIN_REF` from `DEMO_ADMIN_TOKEN` to
  `COMMERCE_ADMIN_TOKEN` — the audited boundary shape itself is
  unchanged (declared refs must be authorized, manifest/registration
  refs must be equal).

## Alternatives considered

- **Reuse `DEMO_ADMIN_TOKEN` for Commerce** — rejected: collapses two
  targets' admin trust boundaries into one secret (blast-radius and
  audit-identity defect; contradicts the target-owned-boundary model
  of ADR-0020 §3).
- **A per-target ad-hoc header value in the scenario** — rejected:
  reintroduces literal secrets into scenario documents (R-13, ADR-0012
  reference indirection exists precisely to prevent this).
- **Treat the commerce admin token as signing-capable** — rejected:
  it signs nothing; the two-stage signing binding stays exactly as
  ADR-0024 defined it.
