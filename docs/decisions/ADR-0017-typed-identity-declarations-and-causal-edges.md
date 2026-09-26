# ADR-0017: Typed Identity Declarations and Causal Edges

## Status

Accepted (Phase 12 — design freeze; implementation in Phase 14).

## Context

RuptureGrid's analytical power comes from the distinction between logical business identity and
physical attempts (product-spec §7), and from the rule that causal relationships require explicit
identity linkage — never timestamp proximity (evidence-model §6). v1.0 implements this correctly
but with a Demo-Fintech-shaped vocabulary: normalizers emit `demo.*` event types, causal
derivation in `packages/evidence/src/derive.ts` hard-codes the Demo field names
(`providerPaymentId`, `providerEventId`, `deliveryAttemptId`, `processingAttemptId`,
`financialEffectId`) and relation kinds (`describes-payment` → `delivered-as` → `processed-as` →
`produced-effect`), and the invariant evaluators filter on literal `demo.*` event types.

The v1.1 goal is a second, independent domain. A hard-coded chain of exactly five identity roles
would be a false generalization: it would force every future target to contort its business model
into fintech's shape. The model must instead generalize the *mechanism* — typed identity
declarations, typed causal edges, exact field equality, provenance bases — while leaving the
*shape* (number of identities, number of edges) target-specific.

Constitutional constraints preserved unchanged:

- No timestamp-based causal guesses: `temporal-correlation` remains a weak hint that can never
  support a FAIL (evidence-model §6.2).
- No fuzzy matching, no probabilistic linkage, no inferred identity links: every edge must carry
  the exact field(s) that matched.
- Attribution bases and minimum strength are unchanged: a FAIL verdict requires every counted
  effect attributed at basis ≥ `identity-chain` (evidence-model §6.2, §7).
- Absence of linkage is itself evidence: where a target's records do not carry enough identity,
  the honest outcome is `NOT_EVALUABLE`, never a guessed verdict (evidence-model §6.4).

## Decision

1. **Targets declare identity nodes and causal edges; RuptureGrid does not assume a chain
   length.** The target manifest (ADR-0016) carries an `identityModel` declaration consisting of:
   - **Identity nodes** — a variable-length list (one node minimum, no maximum in the schema; the
     five-identity Incident Zero shape is one legal instance). Each node declares:
     `roleId` (a stable, target-chosen identifier such as `payment`, `checkoutIntent`,
     `requestAttempt`), `description`, and the **typed fields** carried by events of this node
     (field name → declared primitive type: `string` | `integer-minor-units` | `timestamp` |
     `boolean`; money-like fields are always integer minor units with an explicit currency field,
     R-06/ADR-0004 — never floats).
   - **Causal edges** — a variable-length list of typed edges between declared nodes. Each edge
     declares: `fromRoleId`, `toRoleId`, `edgeKind` (a stable target-chosen identifier such as
     `delivered-as`, `produced-order`), and `linkFields` — the exact event-payload field(s) whose
     **exact equality** establishes the edge (e.g. `deliveryAttemptId`). At least one link field
     is mandatory; edges with no identity basis are rejected at registration.
   - **Effect designation** — which node(s) are the business *effects* the invariants count or
     constrain, and which node is the *subject* a logical business action hangs from.
   - **Inspection queries** (`inspection/v1`, referenced from ADR-0016): for each named read-only
     query, the target declares the response entity schema — field names, types, and which fields
     are identity fields. RuptureGrid shape-validates responses against the declaration; values
     are checked, never interpreted. Unknown or undeclared shapes produce **no events** — the
     v1.0 honest-absence rule (normalizer comment: "unknown structure is never guessed into
     business meaning"), now made target-generic.
2. **Derivation is manifest-driven exact-equality joining.** The generic normalizer emits typed
   events (namespaced per target, e.g. `commerce.order-accepted-observed`) preserving declared
   identity fields; the generic causal derivator links events **only** when a declared edge's
   link fields match exactly between two events of the declared node types. Every derived edge
   records `basis: identity-direct` plus the matched field names and values (secret-free) in
   `evidenceJson` — the v1.0 provenance shape, unchanged. Multi-hop chains
   (`identity-chain` strength) are derived by walking `identity-direct` edges only.
3. **No new linkage mechanisms are introduced.** Timestamp proximity is never a link; ordering
   remains the timeline layer's concern with explicit ordering bases (evidence-model §9). No
   string-similarity, no normalization-of-identity heuristics, no cross-target identity
   conflation. If declared identity or cardinality constraints produce **ambiguous or
   conflicting causal candidates** (e.g. two different logical subjects claim the same node
   where the declaration implies one), RuptureGrid records the ambiguity and its provenance in
   evidence, derives **no guessed winning edge** — no timestamp tie-break, no first-row
   tie-break, no fuzzy selection — and forces every dependent invariant evaluation that requires
   the contested edge to `NOT_EVALUABLE` (evidence-model §6.3–§6.4).
4. **Both demonstration chains are declared, not built in.** The two reference declarations
   (documentation examples in the scenario docs, validated data at registration time):
   - **Incident Zero** (five nodes): `payment` → `providerEvent` → `delivery` →
     `processingAttempt` → `financialEffect`.
   - **Checkout Zero** (five nodes, different roles): `checkoutIntent` → `requestAttempt` →
     `processingAttempt` → `order` → `reservation`.
   The model requires no equal chain lengths; a three-node or seven-node target is equally
   expressible. The v1.0 Demo Fintech manifest is derived from its existing, accepted behavior —
   it changes no frozen semantics.
5. **The frozen v1.0 pipeline is untouched in its semantics.** The demo normalizers, demo causal
   derivation, and demo evaluators continue to produce byte-identical verdicts on Incident Zero
   evidence (frozen suites must stay green; R-07). The generic machinery is additive; Phase 14
   acceptance includes proving the demo path unchanged.

## Consequences

- The truth chain generalizes by *declaration*: a new domain onboards by writing manifest data,
  not by forking platform code. Causality, attribution strength, and honest-uncertainty rules are
  uniform across targets.
- The invariant registry (ADR-0018) can reference declared nodes/fields at definition time and
  reject invariants that name undeclared event types or fields — catching misconfiguration before
  any execution.
- Auditing stays concrete: every causal edge in evidence names the exact matched fields, so an
  investigator can always answer "why does RuptureGrid believe these two events are linked?"
- The declared-field validation adds a registration-time schema burden (Phase 13) — accepted as
  the price of closed, auditable vocabularies.
