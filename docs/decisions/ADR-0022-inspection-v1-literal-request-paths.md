# ADR-0022: Inspection/v1 Literal Request Paths

## Status

Accepted (pre-Phase-14 contract closure; extends [ADR-0021](ADR-0021-phase-14-inspection-entity-binding.md)
without rewriting it; enforced by the manifest validator from this change, consumed at runtime in
Phase 14).

## Context

ADR-0021 froze the inspection/v1 query → identity-node role binding and the JSON-array response
grammar, but no accepted document defined the semantics of the declared `path` itself. An inspection
query could carry a string resembling `/inspection/orders?orderId=${orderId}`, and nothing in the
manifest validator or any ADR answered: what `${orderId}` means, where its value would come from,
who binds it, when it is bound, whether step-response references are legal, what URL-encoding rules
apply, what happens when a value is missing, or whether credential/identity material could enter the
path. The existing `${steps.<stepName>.response.<json path>}` reference grammar belongs to
*experiment execution* (executor body and adapter-identity resolution); it is not a target-manifest
templating language, and letting Phase 14 reinterpret an accepted manifest path through some
binding mechanism would silently convert registration data into an expression surface.

ADR-0016 already forbids exactly that: the manifest is closed-schema and data-only — no executable
content, no expressions, no template languages (ADR-0016 §2). Leaving the path semantics undefined
was the remaining gap through which a template surface could have been invented later.

## Decision

1. **Inspection/v1 paths are LITERAL.** A manifest-declared inspection path is the final relative
   request target the generic adapter uses — after the existing relative-path authority/SSRF
   validation — with **zero runtime parameter binding or interpolation of any kind**. The adapter
   executes `GET <registered origin><declared path>` and never rewrites, parses, or re-resolves the
   declared string.
2. **Fixed literal query strings are permitted.** A query string may appear in the declared path
   (e.g. `/inspection/orders?view=accepted`); it is static manifest data and every character of it
   is fixed at registration. No query parameter value may be derived at runtime. No new URL parser
   is introduced; the existing relative-path validation remains the authority.
3. **Forbidden, in raw or percent-decoded form:** `${…}` (the experiment-execution reference
   grammar), `{…}`/`{{…}}` placeholder forms, and any equivalent runtime/template placeholder
   syntax. The manifest validator enforces this at registration, auditing both the raw string and
   its percent-decoded form so encoded braces cannot smuggle the grammar past validation. The
   manifest validator MUST NOT reuse or extend `resolveBodyReferences` or any execution-time
   reference mechanism for inspection paths; no such seam exists.
4. **No substitution sources exist.** The adapter MUST NOT substitute step responses, experiment
   variables, identity fields, environment variables, credential references, target metadata, prior
   normalized events, or arbitrary runtime values into an inspection/v1 path. Credential values
   never enter paths at all (ADR-0012; only header/value seams resolve credentials, unchanged).
5. **Identity, scope, and generation travel in returned evidence — never in the URL.** Returned
   entities carry the declared identity/scope/generation fields (ADR-0017, ADR-0021). Later
   derivation and invariant layers select and relate evidence using declared exact identities, never
   URL-template semantics. A URL path never establishes subject identity, verification scope, or
   experiment generation.
6. **No truth is created by endpoint shape or path.** A static collection endpoint does not prove
   exhaustiveness; an array response is not completeness; an empty array is not absence of effects;
   a target declaration is not completeness; URL filtering is not causal attribution. ADR-0018 truth
   rules and the completeness-provenance requirements of checkout-zero.md §5 remain unchanged.
7. **Dynamic request binding is deferred, not smuggled.** If a future target genuinely requires
   runtime-bound request parameters, that is a deliberately designed future inspection version
   (e.g. `inspection/v2`) behind a new ADR — never a compatible extension of v1. Within
   `target-manifest/v1` no v1 manifest has ever been executed against, so freezing the path grammar
   now breaks nothing (same reasoning as ADR-0021 §6).

## Consequences

- The inspection declaration is now fully closed: literal `GET` path (this ADR), declared entity
  schema and role binding (ADR-0021), JSON-array response grammar (ADR-0021). Phase 14 can implement
  the generic adapter with no discretionary interpretation left on the request side.
- The validator rejects template-like inspection paths at registration — an old manifest carrying
  placeholder syntax can never be reinterpreted by a later adapter build (fail-closed provenance
  re-validation already enforces this on every execution-policy derivation).
- The enforcement is inspection-specific: `faultHook` paths and experiment action paths keep the
  existing `validateRelativePath` grammar unchanged; no accepted behavior outside the inspection
  surface changes.
- Demo Commerce (Phase 16) should expose target-owned read-only static collection surfaces
  sufficient for the v1.1 proof (conceptually: `/inspection/checkout-intents`,
  `/inspection/request-attempts`, `/inspection/processing-attempts`, `/inspection/orders`,
  `/inspection/reservations`, `/inspection/sku-state` — exact routes fixed at Phase 16). The generic
  adapter does not manufacture subject-specific URLs; returned entities carry the declared
  identity/scope/generation fields, and later layers relate evidence by declared exact identities.

## Alternatives considered

- **Runtime parameter binding in v1 (e.g. `${param}` placeholders bound at capture time)** —
  rejected: it creates a template surface the manifest constitution forbids (ADR-0016 §2), invents
  missing-value and encoding semantics under time pressure, and would let execution-specific data
  shape target registration documents.
- **Reusing the `${steps…}` grammar for inspection paths** — rejected: that grammar resolves from
  recorded step responses of a *run*; inspection queries are reusable *target* declarations that
  must not depend on experiment-specific step names, and binding at capture time would tie target
  registration to experiment execution.
- **Restricting paths to bare path-no-query strings** — rejected as over-narrow: a static query
  string is inert literal data (no runtime semantics), targets legitimately expose fixed-view
  collection endpoints, and forbidding it would push targets to encode views in path segments
  instead.
