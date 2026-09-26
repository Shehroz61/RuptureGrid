# ADR-0021: Phase 14 Inspection/v1 Entity Binding and Response-Shape Closure

## Status

Accepted (pre-Phase-14 contract closure; supersedes the open point in ADR-0017 Decision 1's
inspection-query declaration; implementation in Phase 14).

## Context

ADR-0017 (accepted Phase 12) freezes the typed-identity mechanism: the generic normalizer emits
typed events for declared identity-node roles, and generic causal derivation joins events only on
declared exact-equality link fields. Its inspection-query declaration, however, names only the
response entity schema — `queryId`, `description`, `path`, `fields`, `identityFields`. Nothing in
any accepted document states which declared `identityModel.nodes[].roleId` a query's entities
represent, and no accepted document fixes the response cardinality of an inspection/v1 query
response.

Phase 14 is the first runtime interpretation of that previously structural declaration. Without an
explicit binding, RuptureGrid would have to choose a node role for each query's events. Choosing
one from the declaration data is forbidden: role inference from field-name matching, field-count
overlap, identity-field overlap, queryId naming, timestamps, or any heuristic shape matching would
violate the declaration-only causal model (R-02/R-03; evidence-model §6 — identity first, never
inferred; ADR-0017 Decision 3 — no fuzzy or inferred linkage).

Two distinct ambiguities therefore require closure before Phase 14 implementation:

1. **Query → role binding.** An inspection query declares an entity schema but not the identity
   node it represents.
2. **Response cardinality/shape.** Phase 14's generic adapter must know whether a query response
   is one entity, an array of entities, an envelope, or something else. ADR-0016 §2 names
   `inspection` only as "named read-only lineage queries"; it freezes no response grammar.

Constitutional constraints unchanged: no executable content in the manifest — no JSONPath, envelope
selectors, user-provided extraction code, SQL, expression, or template languages (ADR-0016 §2);
closed schema; values are checked, never interpreted; unknown or undeclared shapes produce **no
events** (evidence-model honesty rule, ADR-0017 Decision 1).

## Decision

1. **Explicit query → role binding.** Every `inspection` query declares exactly one
   `roleId`, and that `roleId` MUST reference a declared `identityModel.nodes[].roleId`. The
   manifest validator enforces this at registration: `roleId` is required for each query, must
   match the same identifier pattern as other role references, and an unknown `roleId` is rejected
   exactly like an undeclared role reference elsewhere in the manifest. No default, no fallback,
   no inference path exists.
2. **Role inference is forbidden.** RuptureGrid never derives a query's role from field names,
   identity-field overlap, field counts, queryId naming, timestamps, or any shape heuristic. The
   declaration is the only mapping.
3. **The response shape of an inspection/v1 query is a JSON array.** A query response body is a
   single JSON array whose elements are the declared entity objects (`[]` on empty result). No
   envelope, wrapper, selector, or extraction mechanism is introduced in v1. This is the smallest
   deterministic contract: HTTP GET, response body is a JSON array of entity objects. If envelope
   support becomes useful for a future target, it is a new inspection version — `inspection/v2` —
   designed and ADR'd then, not a compatible extension.
4. **Shape-validation failure behavior.** Each returned element must carry exactly the declared
   `fields` with the declared types. A response whose non-array structure, undeclared/unknown
   fields, or type mismatches in any element fails validation of that capture. Per the evidence-
   model honesty rule (unknown or undeclared shapes produce no events), the capture is recorded as
   an honest raw observation, but it produces **no normalized events** for that query. No partial
   per-element salvage, no guessed field mapping.
5. **Empty response.** An empty array is a valid, empty result: no entities, no events, no error.
   RuptureGrid never distinguishes "no rows" from "not found" beyond what the response itself
   carries; absence of entities is never interpreted as absence or presence of business effects.
6. **Versioning: stays within target-manifest/v1.** `target-manifest/v1` is accepted, stored as
   registration provenance, and consumed at runtime for the first time in Phase 14. No v1 manifest
   has ever been executed against, so adding `roleId` to the inspection declaration and freezing
   the response grammar introduces no compatibility break: every accepted Phase 13 declaration
   remains valid after adding its `roleId` (a fixture-level addition only), and the frozen-v1.0
   demo path never consumed the inspection declaration at all. Minting `target-manifest/v2` or
   `inspection/v2` here would be speculative versioning for a change no executed artifact depends
   on. v1 manifest semantics are frozen from Phase 14 onward: any further change to the inspection
   declaration or response grammar requires a new version (per ADR-0016 §2: unknown versions are
   refused, never guessed).
7. **Phase 14 implementation obligations.** The generic inspection adapter executes a query as an
   HTTP GET against the query's declared path on a registered origin, validates the array and each
   element against `fields`, and emits one typed event per valid entity carrying the query's
   `roleId` and its declared `identityFields`. The generic causal derivator and invariant layers
   (Phases 14–15) consume only declared role/field names — never inferred ones.

## Consequences

- The declaration chain query → declared entity schema → declared identity node is fully explicit
  and auditable: every normalized event of an inspection capture names the `roleId` it was declared
  under, with no inference step to audit away.
- Existing Phase 13 manifests and fixtures gain `roleId` in their inspection queries; runtime truth
  semantics are unchanged (the frozen v1.0 suites stay green, per R-07).
- `deriveExecutionPolicy` re-validates stored manifests with the same closed schema, so a stored
  pre-`roleId` manifest from an earlier build now fails validation — the only accepted Phase 13
  manifests are test fixtures, no executed run ever froze one, and re-validation failing closed on
  undeclared documents is the documented defense-in-depth behavior (frozen snapshots unaffected).
- A future envelope/extraction need arrives as `inspection/v2` behind a new ADR; v1 stays closed.

## Alternatives considered

- **Infer the role from identity-field overlap** — rejected: heuristic matching is exactly what
  the declaration-only causal model forbids; it would make event typing a guess.
- **Envelope + JSONPath/selector extraction in v1** — rejected: executable/expressive extraction
  content is forbidden in the manifest (ADR-0016 §2), and every selector grammar is a new
  interpretation surface. Deferred to a future inspection version if ever needed.
- **Mint `target-manifest/v2`** — rejected: no executed artifact depends on the v1 inspection
  declaration; speculative versioning without a compatibility break violates the project's
  conservative versioning discipline.
