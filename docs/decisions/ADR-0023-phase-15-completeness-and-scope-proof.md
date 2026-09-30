# ADR-0023: Phase 15 Completeness and Scope-Proof Contract (business-invariant/v1 Closure)

## Status

Accepted (pre-Phase-15 contract closure; design only — no runtime change, no migration, no
implementation in this change). Implementation in Phase 15. Forward references:
[ADR-0018](ADR-0018-business-invariant-v1-closed-registry.md) (closed invariant registry; its
completeness and scope-coherence REQUIREMENTS are frozen there — this ADR freezes the
MECHANISM), [checkout-zero.md](../../docs/checkout-zero.md) §5 (the two v1.1 invariant
instances), [phase-roadmap.md](../../docs/phase-roadmap.md) Phase 15 (implementation scope and
gates).

## Context

ADR-0018 freezes *requirements* whose *mechanism* it explicitly defers: PASS for
`atMostOneAcceptedEffect` requires effect-enumeration completeness provenance; PASS for
`resourceConservation` requires a coherent baseline, a complete attributable consumption
enumeration, and a coherent remaining state; Case C FAIL additionally requires complete
enumeration; and all state evidence must be proven to belong to one coherent verification
scope (run/snapshot, declared target, resource/subject identity, verification scope/window,
and a target generation/reset epoch where the target provides one). Phase 14 (accepted) built
the evidence plane that such a mechanism must consume: inspection/v1 captures are literal-GET
JSON arrays of declared entities (ADR-0021), normalized into typed events whose event type IS
the declared `roleId`, and related only by declared exact-equality causal edges with an ACTIVE
graph that excludes contested identities (ADR-0017; derivation-gap and invalidation provenance
persisted as diagnostics).

What no accepted document fixes is: which observed fields prove scope/generation binding, how
an effect enumeration is PROVEN complete (as opposed to declared complete), how zero-effect
cases prove PASS, how baseline vs final state are bound to declared sources without
order/time guessing, the exact instance JSON shape of the two invariant kinds, and the finding
reason-code vocabulary. Phase 15 must not invent these ad hoc inside evaluator code, and per
ADR-0021 §6 the `target-manifest/v1` inspection declaration is frozen from Phase 14 onward —
any further change to it requires a new manifest/inspection version.

This closure freezes the smallest deterministic mechanism that answers all of the above
without: a general DSL, executable selectors, expressions, filters, JSONPath, SQL, templates,
timestamp matching, or any weakening of the declaration-only causal model.

## Central truth rule (binding for Phase 15)

**DECLARATION tells RuptureGrid how to interpret observed evidence. OBSERVED TARGET DATA
supplies the values. PLATFORM CHECKS establish whether the proof is valid.**

A manifest or invariant declaration alone must NEVER mean `complete = true`, `authoritative =
true`, `scope coherent = true`, `generation valid = true`, or `PASS`. Concretely:

- No "the query is declared exhaustive, therefore complete" — completeness requires an
  **observed** completeness fact as frozen below (§Completeness), shape-validated and bound to
  the same subject and scope as the counted effects.
- No "the manifest says the target is experiment-exclusive, therefore scope coherent" — scope
  coherence requires observed, exactly-equal declared scope/generation field values across all
  bound evidence (§Scope coherence). A target declaration of exclusivity remains
  provenance-only metadata (ADR-0016 Decision 7; ADR-0018 Decision 7).
- Declarations may specify WHICH observed fields carry proof (field-name references only);
  the proof itself must exist in captured, shape-valid evidence.

## Decision

### 1. The mechanism lives in business-invariant/v1 instance params — the manifest is not extended

`target-manifest/v1` is unchanged (ADR-0021 §6 freezes its semantics; no v1 manifest has ever
been executed against in the frozen sense, but the accepted Phase 14 artifacts consume it as
frozen). The completeness/scope mechanism is expressed entirely inside
**business-invariant/v1 invariant instance `params`**, which reference — by exact declared
names only — inspection queries, identity-model roles, and typed fields that the frozen
manifest already declares (ADR-0017). Definition-time validation rejects any reference to an
undeclared role, undeclared field, or wrongly-typed field against the target's frozen
`ManifestEvidencePolicy` (the same fail-closed re-validation discipline as
`deriveExecutionPolicy`/`deriveEvidencePolicy`). No new manifest field, no new query
attribute, no new version is minted; a future neutral `integer` manifest type or richer proof
surface arrives only via a deliberately designed future version behind a new ADR.

**Type vocabulary note (intentional, not a substitution):** the manifest's closed field-type
vocabulary has exactly one integer primitive, `integer-minor-units` (its name carries its
R-06 money origin). Counts and unit quantities bound by invariant params therefore use
`integer-minor-units`; capture-time shape validation already enforces safe-integer values
with no coercion, so floats and numeric strings can never enter. The ADR-0018 integer-unit
semantics are satisfied exactly; only the type NAME is reused.

### 2. Completeness mechanism — `observed-total` (a CHECKED count, not a trusted claim)

The ONLY completeness mechanism in v1 is **`kind: "observed-total"`**:

```json
"completenessProof": {
  "kind": "observed-total",
  "queryId": "<declared inspection queryId>",
  "subjectField": "<field on the summary entity carrying the subject identity value>",
  "totalField": "<field on the summary entity carrying the observed total>"
}
```

Semantics, frozen:

1. `queryId` must be a declared inspection query of the frozen evidence policy (its declared
   `roleId` binding per ADR-0021 §1 determines the events its entities normalize into; the
   evaluator consumes those entities — no separate role reference is needed or permitted).
2. The summary entity must carry `subjectField` with exactly the subject's identity value
   (exact equality, no coercion) and the declared `scopeBinding` fields (§4) — a summary not
   bound to   the evaluated subject AND scope AND generation proves nothing. A valid capture of the
   `queryId` returning `[]` (a REAL empty observed enumeration) is distinct from a missing or
   failed capture (§8), but both leave zero matching valid summary entities: completeness is
   NOT proven.
3. `totalField` must be shape-valid: a non-negative safe integer (declared
   `integer-minor-units`). A negative total is contradictory evidence (§8), never a count.
4. **Summary cardinality is frozen (BS-1).** For one completeness-proof identity — the
   (invariant instance, subject, scope, generation-when-declared,
   `completenessProof.queryId`, `completenessProof.subjectField`,
   `completenessProof.totalField`) tuple — the evaluator considers every valid bound summary
   entity (identity §2.2, binding §4) and applies exactly this deterministic rule:
   - **Exactly zero** matching valid summary entities ⇒ completeness is NOT proven ⇒
     `NOT_EVALUABLE` (`ENUMERATION_COMPLETENESS_GAP`), unless a lower-bound-safe FAIL was
     already independently proven under §8 (a FAIL does not need completeness).
   - **Exactly one** ⇒ that summary is the completeness surface, subject to all existing
     checks (shape-valid `totalField`, exact subject/scope/generation binding, coherence).
   - **Two or more with identical subject binding, scope binding, generation binding, and
     observed total** ⇒ semantically **convergent**. They represent ONE summary fact for
     evaluation purposes: no summation of totals, no multiplicity in any count, no
     first/last/newest/earliest/latest/DB-row-order selection — the converged fact is the
     (identical) observed total, used exactly as a single summary would be.
   - **Two or more for the same bound subject/scope/generation with different observed
     totals** ⇒ contradictory evidence ⇒ **`EVIDENCE_CONFLICT` / `NOT_EVALUABLE`**, unless a
     lower-bound-safe FAIL has already independently established the business violation under
     §8 AND the contradiction is confined to enumeration-total evidence (§8 lower-bound
     precedence) — i.e. it does not undermine the subject identity, effect
     identity/distinctness, attribution, resource identity, or required scope/generation
     binding facts that the lower-bound proof rests on. If the contradiction touches any of
     those facts ⇒ `NOT_EVALUABLE`.
   - **Summaries bound to a DIFFERENT subject/scope/generation** ⇒ they do not satisfy this
     subject's completeness proof. They are not winner/loser candidates for this subject;
     they belong to a different evaluation binding (and are never summed, selected, or
     merged into this one).
   No timestamp selection, no DB-row-order selection, no first/last semantics exist anywhere
   in this rule.
5. The evaluator independently counts the matching observed effects for the same
   subject/scope/generation from the effect-role evidence (§6) and requires:
   **observedCount == observedTotal** (where `observedTotal` is the single converged summary
   fact of §2.4). Equality establishes enumeration completeness for that subject and scope;
   inequality is NOT silently resolved in either direction (§8).
6. The mechanism is a CHECK, not a trust: a target claiming `acceptedOrderTotal = 1` while
   two valid accepted-order entities for the same subject/scope are observed produces a
   contradiction (`EVIDENCE_CONFLICT` / `NOT_EVALUABLE`, §8) — never a PASS that ignores the
   extra entity and never a completeness grant from the claim alone. The lower-bound-safe
   FAIL rules (§8) still apply first where they prove a violation.

**Rejected alternative — observed boolean `enumerationComplete = true`:** a boolean converts
a target claim directly into RuptureGrid truth (the exact boundary ADR-0016 Decision 5 and
ADR-0018 forbid). A count that RuptureGrid CHECKS against independently observed entities
cannot be blindly trusted. Rejected.

**Never completeness (frozen, non-exhaustive echoes of ADR-0018):** `[]`; a short array; a
missing `next` page or pagination absence; HTTP 200 alone; the literal declared query path;
query registration; the manifest or invariant declaration alone; "no rows observed";
`observed-total` bound to a different subject, scope, or generation; a total field that is
redacted, missing, or type-invalid.

### 3. Zero-effect completeness (load-bearing for `atMostOneAcceptedEffect` PASS with zero effects)

An empty array is NEVER complete proof (ADR-0021 §5: absence of entities is never interpreted
as absence of effects). PASS with zero effects requires an observed summary entity for the
SAME subject/scope/generation whose `totalField` value is `0`, with the effect-role query
captured validly (an empty capture is valid) and zero matching effect events observed:

    observedCount == 0 == observedTotal   ⇒ enumeration proven complete ⇒ PASS eligible.

Without the observed zero-total summary: **NOT_EVALUABLE**. This is the mechanism that makes
`atMostOneAcceptedEffect` PASS decidable for a legitimate zero-effect subject.

### 4. Subject/scope binding and verification-scope coherence

Every invariant instance carries a REQUIRED `scopeBinding` (fail-closed: an instance without
one could never establish coherence, so it is rejected at definition time):

```json
"scopeBinding": {
  "fields": ["verificationScopeId"],
  "generationField": "generationId"
}
```

- `fields` (non-empty): declared field NAMES that must exist — with the same declared
  primitive type — on every bound surface: the subject-role fields, the effect/consumption
  role fields, and the completeness-summary query fields. v1 requires the SAME names across
  surfaces (a target owns its schema and can satisfy this; per-surface name mapping is
  deferred — not needed for the two v1.1 instances).
- `generationField` (optional): the target state generation/reset epoch field. When absent,
  the invariant simply has no generation mechanism — all other coherence rules still apply,
  and instances whose targets provide a generation mechanism SHOULD declare it. When declared
  and any bound surface misses it, redacts it, or mismatches it: **NOT_EVALUABLE**.
- Coherence rule (the ONLY one): every bound entity/effect/summary used by one evaluation
  carries EXACTLY equal values on all `fields` and the `generationField`. Platform truth
  (runId, snapshot id/content hash, frozen target id) is known from the evaluation context
  and is not comparand data — the declared fields bind the evidence to each other and to the
  subject. Timestamps, ordering, row counts, and request paths are NEVER comparands
  (ADR-0022 §5–§6 preserved).
- A redacted (`[Redacted]`) scope/generation value is a gap: **NOT_EVALUABLE**, never a
  match. Contested identity on any bound surface (generic derivation diagnostics, B-2/B-3)
  marks the surface incoherent: **NOT_EVALUABLE**.
- Subject binding is exact-equality on the declared subject/resource identity field(s); no
  fuzzy matching, no normalization of identity spelling beyond exact equality (the generic
  edge rule), no inference from `subjectKey` (a convenience index, never causal authority).

A completeness summary is bound by: `subjectField` exact-equality to the subject identity,
plus `scopeBinding.fields`/`generationField` exact-equality to the evaluation's scope. One
global summary can never prove per-subject completeness unless the instance declares the
summary as a global scope — v1 does NOT include that configuration; `subjectField` is
required, so summaries are per-subject by construction.

### 5. Baseline vs final state — explicit declared roles, never order/time

`resourceConservation` binds baseline and remaining state by DECLARED ROLES (Phase 14
rule: the event type IS the declared `roleId`):

- `baselineRole` — the role whose events carry the initial baseline fact
  (`initialAvailableUnitsField`).
- `remainingRole` — the role whose events carry the final remaining fact
  (`remainingAvailableUnitsField`).
- `consumptionEffectRole` — the role whose accepted events are the counted consumption
  effects (`consumptionUnitsField` per effect).

The evaluator NEVER selects baseline vs final by earliest/latest timestamp, DB row order,
first/last entity, or any ordering heuristic. Same-role duplicate observations for one
resource/scope/generation are judged by the same convergence rule as completeness summaries
(§2.4): identical declared payload values are convergent (ONE observation — the value is used
once, never summed, never selected by order); conflicting values are contradictory evidence
(§8). For `atMostOneAcceptedEffect`, the
analogous binding is `subjectRole` and `effectRole` — equally explicit.

### 6. Exact instance schemas — business-invariant/v1

An invariant instance is pure data (ADR-0018 Decision 1): `key`, `kind`, `params`. Exactly
TWO kinds exist in v1. Field-name references are validated at definition time against the
frozen manifest evidence policy (§7). JSON shapes are EXACT; unknown params keys are
definition-time rejections.

Generic-instance metadata is ALL-OR-NONE: a generic instance carries the full metadata set —
`kind`, `registryVersion`, and `paramsJson` — or it is a legacy row carrying none of them
(all null). No partial hybrid (e.g. `kind` set with null `paramsJson`, or `paramsJson` present
with null `kind`) is valid; a partial row is a definition/persistence-time rejection, and
legacy rows (INV-IZ-1, INV-DF-1/2) keep all three null with semantics untouched (§11).

**Kind 1 — `atMostOneAcceptedEffect`**

```json
{
  "key": "INV-CHK-1",
  "kind": "atMostOneAcceptedEffect",
  "params": {
    "subjectRole": "checkoutIntent",
    "subjectIdentityField": "checkoutIntentId",
    "effectRole": "order",
    "effectIdentityField": "orderId",
    "acceptedMatch": { "field": "status", "value": "ACCEPTED" },
    "equivalenceFields": ["checkoutIntentId", "customerId", "cartId", "totalMinor", "currency"],
    "maxAcceptedEffects": 1,
    "completenessProof": {
      "kind": "observed-total",
      "queryId": "acceptedOrders",
      "subjectField": "checkoutIntentId",
      "totalField": "acceptedOrderTotal"
    },
    "scopeBinding": {
      "fields": ["verificationScopeId"],
      "generationField": "generationId"
    }
  }
}
```

**Kind 2 — `resourceConservation`**

```json
{
  "key": "INV-INV-1",
  "kind": "resourceConservation",
  "params": {
    "resourceIdentityField": "sku",
    "baselineRole": "skuBaseline",
    "baselineUnitsField": "initialAvailableUnits",
    "remainingRole": "skuRemaining",
    "remainingUnitsField": "remainingAvailableUnits",
    "consumptionEffectRole": "reservation",
    "consumptionEffectIdentityField": "reservationId",
    "consumptionUnitsField": "reservedUnits",
    "consumptionAcceptedMatch": { "field": "status", "value": "ACCEPTED" },
    "completenessProof": {
      "kind": "observed-total",
      "queryId": "acceptedReservations",
      "subjectField": "sku",
      "totalField": "acceptedReservationTotal"
    },
    "scopeBinding": {
      "fields": ["verificationScopeId"],
      "generationField": "generationId"
    }
  }
}
```

Exact constraints (all definition-time rejections when violated):

- Every referenced role (`subjectRole`, `effectRole`, `baselineRole`, `remainingRole`,
  `consumptionEffectRole`) is a declared `identityModel.nodes[].roleId`. Every referenced
  field is declared on the referenced role's node fields (hence on its bound inspection
  queries per the B-4A superset rule) with the required primitive type:
  identity/equivalence/scope/generation/match fields per their declared type;
  `totalField`, `baselineUnitsField`, `remainingUnitsField`, `consumptionUnitsField` MUST be
  `integer-minor-units`.
- `subjectIdentityField` / `resourceIdentityField`: exactly one field, declared on the
  subject role (and, via `completenessProof.subjectField`, present on the summary query
  fields with the same declared type; the summary field NAME may differ and is what the
  summary is read through).
- `equivalenceFields`: 1..N distinct fields, each declared on BOTH the subject role and the
  effect role with the same primitive type. Equivalence of an effect to a subject S =
  exact equality of every equivalence field value between the effect event and the subject
  event (the product-spec §10 tuple, generalized; INV-CHK-1's tuple includes the intent
  identity itself).
- `acceptedMatch` / `consumptionAcceptedMatch`: exactly one `{ field, value }`; `field`
  declared on the effect role; `value` a JSON scalar whose primitive type matches the
  field's declared type (no coercion — `"ACCEPTED"` is not `true`, `5` is not `"5"`). The
  match field MUST NOT be any identity, equivalence, scope, generation, or total field.
- `maxAcceptedEffects`: safe integer ≥ 0 (the v1.1 instances use 1).
- `completenessProof.kind`: exactly `"observed-total"` (the only v1 value). Its `queryId`
  declared; `subjectField`/`totalField` declared on that query's entity schema with the
  required types.
- `scopeBinding` REQUIRED; `fields` non-empty (§4). `generationField` optional.
- No arbitrary predicates, no second match clause, no negation, no arithmetic, no
  cross-references between fields: the accepted-status selection is exact-equality only.

### 7. Attribution — the ACTIVE Phase 14 generic causal graph only

An effect is attributable to a subject only when the **ACTIVE generic causal graph** of the
run (direct edges and identity-chain reachability rows with basis `identity-direct` or
`identity-chain`, none of whose endpoints is contested or invalidation-marked — the B-2/B-3
ACTIVE-graph exclusion) contains an identity-backed **directed path** (following declared
edge direction) from an event of the declared subject role carrying the subject identity
value to the effect event. For `resourceConservation`, each counted reservation must carry
`resourceIdentityField` exactly equal to the resource identity AND be attributable in the
same sense from a declared non-consumption-role ancestor event. Subject keys, timestamps,
stale/tombstoned edges, and derivation-gap events are never attribution inputs. Any
attribution gap among candidate accepted effects is **NOT_EVALUABLE** (reported with the
named gap), never silently dropped to manufacture a lower count and never guessed around to
manufacture a FAIL — except where a lower-bound-safe FAIL is already independently proven
from fully attributable counted effects (§8).

### 8. Lower-bound-safe FAIL asymmetry — exact verdict algorithms

Evaluation is PURE over persisted evidence, the frozen policy, the frozen instance params,
and platform context. Per evaluation surface: a missing/invalid capture of a required query
(negative validation, non-2xx, truncated, never captured) means the surface is ABSENT —
**NOT_EVALUABLE** inputs, never "empty". The following capture rules are frozen (BS-2).

**Capture validity and `queriesForRole` (BS-2, no evaluator discretion).** The relevant
capture set for a role is derived ONLY from the frozen ManifestEvidencePolicy:

    queriesForRole(roleId) = all declared inspection queries whose declared roleId
                             exactly equals roleId

The evaluator inspects the durable Phase 14 capture provenance for exactly those `queryId`s.
A capture is usable only when the accepted Phase 14 contract (ADR-0021) makes it a valid
inspection capture: OBSERVED origin; successful 2xx eligibility; non-truncated;
shape/schema-valid (ADR-0021 §4); correct declared query provenance (the capture is
attributed to exactly that declared `queryId`). A malformed, non-2xx, truncated, or
not-captured query surface is ABSENT/INVALID — it is **never equivalent to `[]`** and never
contributes zero entities.

**Valid `[]` vs missing/failed capture (frozen distinction).** A valid inspection capture
with response `[]` is a REAL empty observed enumeration: it contributes zero entities, and
it proves completeness only when the bound observed-total summary (§2.4) also proves total
= 0 for the same subject/scope/generation. By contrast — no RawObservation,
`NO_RESPONSE_OBSERVED`, non-2xx, truncated body, invalid JSON, invalid schema — are
ABSENT/INVALID surfaces and MUST NOT be interpreted as zero entities. No normalized summary
event may conceal the fact that its source capture was invalid: the evaluator uses the
persisted Phase 14 capture provenance to distinguish a valid `[]` from a failed capture that
merely normalized to zero events. The exact `completenessProof.queryId` capture is ALWAYS
required — and must be valid — whenever completeness is required; its matching summary
cardinality then follows §2.4.

**Required capture sets are verdict-dependent (the critical asymmetry).** The rule is NOT
"any missing query for any referenced role always means NOT_EVALUABLE" — that would break
ADR-0018's lower-bound-safe FAIL asymmetry. The frozen sets are:

- **PASS (both kinds) requires the complete evaluation surface.**
  `atMostOneAcceptedEffect`: ALL declared queries bound to `subjectRole` AND `effectRole`
  (every element of `queriesForRole` for each), PLUS `completenessProof.queryId`, must have
  valid usable captures for the evaluated scope. `resourceConservation`: ALL declared
  queries bound to `baselineRole`, `remainingRole`, AND `consumptionEffectRole`, PLUS
  `completenessProof.queryId`, must have valid usable captures. Any required capture
  absent/invalid/non-2xx/truncated ⇒ **NOT_EVALUABLE — never PASS**.
- **`atMostOneAcceptedEffect` lower-bound FAIL.** If a set of distinct, fully attributable,
  equivalent accepted effects already satisfies `count > maxAcceptedEffects`, then
  missing/invalid ADDITIONAL effect-role enumeration captures do NOT undo the FAIL. Every
  counted proof effect itself MUST originate from valid persisted evidence and satisfy
  identity/attribution/scope requirements; the logical subject must be unambiguous and
  sufficiently evidenced. Enumeration completeness is never required merely to prove this
  FAIL.
- **`resourceConservation` Case A.** If observed distinct attributable accepted consumption
  already yields `sum(consumptionUnits) > initialAvailableUnits`, incomplete ADDITIONAL
  consumption enumeration does not undo Case A. Still required: coherent authoritative
  baseline (§5), exact resource identity, coherent scope/generation, each counted
  consumption effect from valid evidence, each counted effect distinct, each counted effect
  accepted, each counted effect attributable, exact safe-integer units. Missing final
  remaining-state evidence does NOT block Case A.
- **`resourceConservation` Case B — remaining-state authority.** A negative remaining state
  may independently prove Case B only when the remaining-state surface itself is
  authoritative and coherent: ALL declared queries whose `roleId == remainingRole` and which
  are relevant to that bound resource/scope must be validly captured and converge on the
  same remaining-state fact (§2.4 convergence). If another required remaining-role surface
  is absent/invalid or contradicts the fact, the negative observation is NOT sufficiently
  authoritative ⇒ **NOT_EVALUABLE**. Case B does NOT require baseline or consumption
  completeness merely to prove a negative authoritative remaining state.
- **`resourceConservation` Case C** requires the full relevant surfaces — `baselineRole`,
  `remainingRole`, `consumptionEffectRole`, `completenessProof.queryId` — with all required
  captures valid, consumption enumeration complete, attribution complete, and scope
  coherent. Otherwise: **NOT_EVALUABLE**.

**`atMostOneAcceptedEffect`, per subject S** (order of rules is normative):

1. Gather candidate effects: valid effect-role events with `acceptedMatch` matching exactly,
   all equivalence fields exactly equal to S's, and coherent scope/generation (§4). Distinct
   effects are distinct by `effectIdentityField` exact value (convergent duplicate
   observations collapse; conflicting payloads ⇒ contested ⇒ NOT_EVALUABLE inputs).
2. Attribute each candidate (§7). Unattributable candidates ⇒ **NOT_EVALUABLE**
   (`ATTRIBUTION_GAP`), except rule 3.
3. **FAIL** (`TOO_MANY_ACCEPTED_EFFECTS`) when the fully attributable candidates >
   `maxAcceptedEffects` — even without enumeration completeness (additional unseen effects
   cannot undo the violation).
4. **Contradictory evidence:** the bound completeness summaries are resolved by §2.4
   cardinality. If the bound summary's `totalField` is negative, or valid bound summaries
   conflict on the observed total (§2.4), or observedCount > observedTotal, ⇒
   **NOT_EVALUABLE** (`EVIDENCE_CONFLICT`). MUST NOT PASS. (Rule 3 still fired first if a
   lower-bound-safe violation existed — §2.4 precedence: a total-conflict confined to
   enumeration-total evidence never converts a proven FAIL, and an incorrect completeness
   total never converts a demonstrable duplicate-effect violation into PASS.)
5. **PASS** requires: rule 3 not fired, no attribution gap, coherent scope/generation, the
   COMPLETE required capture set of §8 (all `queriesForRole` surfaces for `subjectRole` and
   `effectRole` plus `completenessProof.queryId` validly captured for the evaluated scope),
   AND completeness proven (`observedCount == observedTotal`, §2.4) — then observedCount ≤
   `maxAcceptedEffects` ⇒ PASS.
6. Everything else (summary absent/unbound per §2.4, scope/generation mismatch,
   missing/invalid required-capture surfaces per §8): **NOT_EVALUABLE** with the named gap
   (`ATTRIBUTION_GAP`, `ENUMERATION_COMPLETENESS_GAP`, `SCOPE_INCOHERENT`,
   `EVIDENCE_CONFLICT`, `CAPTURE_INVALID_OR_ABSENT`, `EVALUATION_SURFACE_ABSENT`).

**`resourceConservation`, per resource R** (order of rules is normative):

1. Gather baseline events, remaining events, and candidate consumption effects for R
   (`consumptionAcceptedMatch` exact; `resourceIdentityField` == R; coherent
   scope/generation).

   **Baseline authority (frozen).** For a baseline to be used in Case A, Case C, or PASS:
   ALL valid observations for the bound resource/scope from declared queries bound to
   `baselineRole` (every element of `queriesForRole` for that role) must CONVERGE on one
   baseline fact (§2.4 convergence; §5). If a declared baseline-role query required for that
   resource/scope was not captured, was captured invalidly (non-2xx, truncated,
   shape-invalid, wrong provenance), baseline authority is NOT established. If two valid
   baseline observations conflict on the baseline value: **`EVIDENCE_CONFLICT` ⇒
   NOT_EVALUABLE**. Never first/last/earliest/latest/DB-order selection.

   No authoritative baseline for R ⇒ **NOT_EVALUABLE** (`BASELINE_MISSING`; never inferred —
   R-02/ADR-0018). Conflicting baseline or remaining values for one R/scope/generation ⇒
   **NOT_EVALUABLE** (`EVIDENCE_CONFLICT`).
2. Attribute each candidate reservation (§7). **FAIL Case A**
   (`RESOURCE_CONSERVATION_EXCEEDED_BASELINE`) when the attributable candidates' unit sum >
   baseline value — enumeration completeness NOT required (lower-bound-safe; unobserved
   reservations cannot undo the violation). Unattributable candidates that are not needed
   for an already-proven lower-bound FAIL leave a gap ⇒ **NOT_EVALUABLE** later (rule 6).
3. **FAIL Case B** (`RESOURCE_CONSERVATION_NEGATIVE_REMAINING`) when the remaining-state
   surface is authoritative (§8: ALL declared `queriesForRole` queries for `remainingRole`
   relevant to that bound resource/scope validly captured and CONVERGED on the same
   remaining-state fact) and a coherent, scope/generation-bound remaining observation has
   `remainingAvailableUnits < 0` — an authoritative negative remaining state proves the
   violation directly; baseline and consumption completeness are not required. A negative
   remaining observation whose remaining-role surface is incomplete, invalid, or
   unconverged/contradicted is NOT authoritative ⇒ **NOT_EVALUABLE** (rule 6), never FAIL. A
   negative remaining observation that is NOT scope/generation-bound to R ⇒ **NOT_EVALUABLE**
   (rule 6), never FAIL.
4. **FAIL Case C** (`RESOURCE_CONSERVATION_MISMATCH`) when `remaining != initial −
   acceptedReservedUnits` — valid ONLY when baseline and remaining are coherent, ALL
   counted reservations are attributable, AND completeness is proven for R
   (observedCount == observedTotal on the bound summary, §2.4). Case C requires the FULL
   required capture set of §8 (`baselineRole`, `remainingRole`, `consumptionEffectRole`,
   `completenessProof.queryId` — all `queriesForRole` surfaces validly captured for the
   evaluated scope), with consumption enumeration and attribution complete and scope
   coherent. Without completeness or with any required capture absent/invalid ⇒
   **NOT_EVALUABLE** (`ENUMERATION_COMPLETENESS_GAP` / `CAPTURE_INVALID_OR_ABSENT`), never
   FAIL.
5. **PASS** requires: no rule 2–4 fired; no attribution gap; the COMPLETE required capture
   set of §8 (all `queriesForRole` surfaces for `baselineRole`, `remainingRole`, and
   `consumptionEffectRole` plus `completenessProof.queryId` validly captured for the
   evaluated scope); authoritative converged baseline (rule 1); completeness proven; coherent
   scope/generation; and `remaining == initial − sum` AND `sum ≤ initial` AND `remaining ≥ 0`
   (exact integer arithmetic; R-06).
6. Everything else: **NOT_EVALUABLE** with the specific named gap
   (`BASELINE_MISSING`, `REMAINING_MISSING` — unless Case A already proved FAIL —
   `ATTRIBUTION_GAP`, `ENUMERATION_COMPLETENESS_GAP`, `SCOPE_INCOHERENT`,
   `EVIDENCE_CONFLICT`, `CAPTURE_INVALID_OR_ABSENT`, `EVALUATION_SURFACE_ABSENT`).

Type discipline: units fields are declared `integer-minor-units`; a float or numeric-string
unit value can never enter the evidence (capture-time rejection, no coercion) and a params
reference to a non-integer-typed field is rejected at definition time. There is no
runtime coercion path in either direction.

### 9. Event/role/field naming and definition-time validation

Phase 14 made the generic `eventType` exactly the manifest `roleId`; Phase 15 definitions
reference declared roleIds and declared field names only. There is NO separate event-name
namespace, no alias table, no renaming layer. Definition-time validation (at scenario
definition / snapshot freeze, against the target's frozen evidence policy) rejects with
named issues: undeclared roles; undeclared or wrongly-typed fields (identity, equivalence,
scope, generation, total, units, match); unknown params keys; unknown `completenessProof`
kinds; empty/absent `scopeBinding`; non-integer `maxAcceptedEffects`; a `queryId` not in the
frozen policy. A definition that fails validation can never be frozen into a snapshot and
never reaches evaluation.

### 10. Finding registry — vocabulary and rules

Exactly two generic finding-rule families, corresponding to the two kinds. A Finding exists
ONLY for FAIL; PASS and NOT_EVALUABLE never produce findings (ADR-0018 Decision 4). Each
rule deterministically produces: bounded reasonCode (below), fixed bounded title, fixed
bounded summary template over the persisted evaluation's own details (no AI prose,
ADR-0007), details copied from the persisted evaluation, the minimal sufficient proof
references (the evaluation, the counted effect events, the attribution relationships, the
source observations — the v1.0 proof-role discipline), and the deterministic input
fingerprint. The frozen INV-IZ-1 finding rule (`DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT`) is
untouched.

New `FindingReasonCode` enum values (exactly four; per-case conservation codes are kept
because they name the proven failure mechanism — forensic clarity — while staying bounded):

- `TOO_MANY_ACCEPTED_EFFECTS` — `atMostOneAcceptedEffect` FAIL.
- `RESOURCE_CONSERVATION_EXCEEDED_BASELINE` — Case A.
- `RESOURCE_CONSERVATION_NEGATIVE_REMAINING` — Case B.
- `RESOURCE_CONSERVATION_MISMATCH` — Case C.

### 11. Persistence and migration intent (NO migration in this closure)

Phase 15 reuses `InvariantDefinition`, `EvaluationBatch`, `InvariantEvaluation`, `Finding`,
and `FindingEvidenceReference`. No parallel evaluation tables. The intended smallest additive
migration (Phase 15, per the roadmap's allowance for the reason-code enum):

1. `FindingReasonCode` gains exactly the four values of §10.
2. `InvariantDefinition` gains three nullable columns: `kind` (VarChar(40), null for legacy
   rows), `registryVersion` (VarChar(24)), `paramsJson` (Json). Legacy rows (INV-IZ-1,
   INV-DF-1/2) remain exactly as accepted — null kind/params, semantics untouched. Generic
   instances are one row per instance: `invariantKey` is the instance key, `kind`/`paramsJson`
   carry the §6 data.
3. No evaluation-table change: the evaluation row's existing `details` Json carries the
   verdict provenance (completeness basis actually established as
   `observed-total:<queryId>`, scope/generation binding values' presence, counted ids,
   gap reasons); `registryVersion` is copied into details from the definition at evaluation
   time. Instances are validated and frozen into the snapshot's invariant bindings at
   definition time (ADR-0010); evaluation reads the frozen copy, never live rows.

### 12. Analysis API wiring (intent only — NOT implemented in this closure)

Phase 15 `apps/api` analysis wiring: read the frozen snapshot policy; load active persisted
evidence; validate the invariant definition against the frozen manifest; evaluate
deterministically (§8); persist `InvariantEvaluation` rows (idempotent by evidence-set hash,
the existing discipline); derive a Finding only for FAIL (§10). No runtime target calls
during evaluation; no live target manifest; no AI; no mutation of execution truth.

### 13. INV-IZ-1 conformance (binding for Phase 15)

The frozen `evaluateInvIz1` is NOT modified. The generic `atMostOneAcceptedEffect` evaluator
MUST agree with it on the canonical Incident Zero cases used for the conformance suite:
PASS, FAIL, and the NOT_EVALUABLE attribution-gap cases. Where the old evaluator's PASS
implicitly treats the Demo lineage inspection as complete, the conformance adapter/fixture
supplies the equivalent EXPLICIT completeness provenance to the generic evaluator (an
observed-total summary bound to the payment subject and scope) — the new completeness
requirement is NEVER weakened to make old PASS fixtures match. Conformance compares verdicts
(PASS / FAIL / NOT_EVALUABLE) for equivalent evidence semantics; it does not compare reason
strings.

### 14. Phase boundaries

This closure is a DESIGN/CONTRACT artifact only: zero runtime behavior change, no migration,
no generated artifacts, no evaluator change. Phase 15 implements §6–§13 with its own gates
and the mandatory truth tables of §15; Phase 16 provides the demo-commerce target whose
inspection surface carries the declared scope/generation/summary fields; Phase 17–18 consume
the verdicts in the CLI report and regression suites.

## Mandatory truth tables (Phase 15 acceptance — committed tests)

**`atMostOneAcceptedEffect`** (all per subject, coherent scope unless stated):

| # | Evidence | Verdict |
|---|---|---|
| 1 | 0 effects, no completeness summary | NOT_EVALUABLE |
| 2 | 0 effects + observed total 0 bound to subject/scope/generation | PASS |
| 3 | 1 effect, complete, attributed | PASS |
| 4 | 1 effect, attribution ok, enumeration incomplete (no/foreign summary) | NOT_EVALUABLE |
| 5 | 2 equivalent accepted effects, both attributed | FAIL (no completeness needed) |
| 6 | 2 observed, 1 unattributable, attributable ≤ max | NOT_EVALUABLE (attribution gap) |
| 7 | 2 observed, 1 unattributable, fully-attributable subset > max | FAIL (lower-bound-safe) |
| 8 | non-equivalent effects (equivalence tuple differs) | not counted (they never enter the candidate set) |
| 9 | conflicting subject identity payloads (contested) | NOT_EVALUABLE |
| 10 | stale/invalidated chain to an effect | effect unattributable ⇒ rule 6/7 semantics |
| 11 | scope or generation mismatch on any bound surface | NOT_EVALUABLE |
| 12 | summary total < observed count (contradiction) | NOT_EVALUABLE (EVIDENCE_CONFLICT) — MUST NOT PASS; lower-bound FAIL still precedes |
| 13 | summary total negative / type-invalid | NOT_EVALUABLE (EVIDENCE_CONFLICT) |
| 14 | effect capture invalid/never ran | NOT_EVALUABLE (surface absent) |
| 15 | two valid bound summary entities, identical subject/scope/generation binding and identical observed total | summaries CONVERGE (§2.4): ONE summary fact — never summed, never double-counted, no first/last/newest selection — and the evaluation proceeds exactly as with a single summary |
| 16 | two bound summaries, same binding, totals 1 vs 2 | EVIDENCE_CONFLICT / NOT_EVALUABLE — unless an independent lower-bound-safe FAIL has already been proven (§2.4/§8 precedence) |
| 17 | 1 accepted effect observed; a second effect-role query failed; summary total 1 | NOT_EVALUABLE — never PASS (PASS requires the complete §8 capture set: all effect-role queries plus the summary query) |
| 18 | 2 fully-attributable distinct accepted effects, max = 1; another effect-role query failed | FAIL (lower-bound-safe; missing/invalid ADDITIONAL effect-role captures do not undo the FAIL) |

**`resourceConservation`** (per resource, coherent scope unless stated):

| # | Evidence | Verdict |
|---|---|---|
| 1 | missing baseline | NOT_EVALUABLE (BASELINE_MISSING; never inferred) |
| 2 | missing remaining, no independent FAIL | NOT_EVALUABLE |
| 3 | missing remaining BUT attributable consumption > baseline | FAIL Case A (completeness not required) |
| 4 | initial 10, attributable consumption 11 | FAIL Case A (no completeness needed) |
| 5 | remaining −1, coherent + bound to R | FAIL Case B |
| 6 | remaining −1, incoherent/unbound scope | NOT_EVALUABLE |
| 7 | initial 10, complete consumption 2, remaining 5 | FAIL Case C |
| 8 | initial 10, incomplete consumption 2, remaining 5 | NOT_EVALUABLE (completeness gap) |
| 9 | initial 10, complete consumption 2, remaining 8 | PASS |
| 10 | initial 1, complete consumption 1, remaining 0 | PASS |
| 11 | mismatched scope/generation on any bound surface | NOT_EVALUABLE |
| 12 | float or numeric-string units (captured) | rejected at capture — never evidence; params referencing non-integer fields rejected at definition |
| 13 | invalidated/contested attribution path | NOT_EVALUABLE (unless a lower-bound-safe FAIL is already proven) |
| 14 | conflicting baseline or remaining values for one R/scope/generation | NOT_EVALUABLE (EVIDENCE_CONFLICT) |
| 15 | Case A already proven by observed distinct attributable consumption > baseline; another consumption-role query missing | FAIL Case A (lower-bound-safe; incomplete ADDITIONAL consumption enumeration does not undo it) |
| 16 | remaining −1 from one remaining-role query; another required remaining-role query missing | NOT_EVALUABLE — the authoritative remaining surface is not fully established; Case B never fires on a partial remaining surface |
| 17 | remaining-role queries all valid and converged on −1 | FAIL Case B eligible (authoritative negative remaining state; baseline/consumption completeness not required) |
| 18 | baseline-role observations conflict on the baseline value | EVIDENCE_CONFLICT / NOT_EVALUABLE — baseline authority not established; never first/last/earliest/latest selection |
| 19 | Case C arithmetic mismatch but one consumption-role query invalid | NOT_EVALUABLE (CAPTURE_INVALID_OR_ABSENT / completeness gap) — never FAIL |
| 20 | PASS arithmetic correct but any required relevant query (baselineRole, remainingRole, consumptionEffectRole, or completenessProof.queryId) invalid | NOT_EVALUABLE — never PASS |

Plus the definition-time reject-cases of §9 and the conformance suite of §13. Rows 15–18
(`atMostOneAcceptedEffect`) and 15–20 (`resourceConservation`) are the mandatory BS-1/BS-2
cardinality/capture-set rows of this closure.

## Consequences

- Every ADR-0018 requirement has a deterministic, checkable mechanism: completeness via a
  CHECKED observed total; scope coherence via exact declared field equality; baseline/final
  via declared roles; attribution via the ACTIVE generic graph. A declaration can shape the
  proof but never substitute for it.
- Zero-effect PASS is honestly decidable (§3) — the case that would otherwise force either
  false PASS from empty arrays or permanent NOT_EVALUABLE.
- The manifest stays frozen and data-only; the invariant registry stays closed (two kinds);
  the evaluator stays pure and AI-free; findings stay deterministic with bounded vocabulary.
- Cost accepted: targets must expose per-subject summary surfaces carrying the declared
  scope/generation fields (demo-commerce does in Phase 16); targets without them produce
  honest NOT_EVALUABLE, never PASS.
- Summary cardinality (§2.4) and the verdict-dependent required capture sets (§8) are frozen
  and deterministic: convergent duplicate summaries are ONE fact, conflicting totals are
  EVIDENCE_CONFLICT, PASS always requires the complete declared capture surface, and
  lower-bound-safe FAILs are never converted by missing additional captures or by
  contradictory totals — an incorrect completeness total can never turn a demonstrable
  duplicate-effect violation into PASS.

## Alternatives considered

- **Observed boolean `enumerationComplete`** — rejected: converts a target claim into truth
  (§2); a checked count cannot be blindly trusted.
- **Completeness fields on the manifest inspection declaration** — rejected: ADR-0021 §6
  froze the v1 inspection schema from Phase 14; a new version for an unneeded surface is
  speculative versioning, and ADR-0018 locates completeness in the invariant layer.
- **Global-scope summaries (declare once, prove every subject)** — rejected for v1:
  per-subject binding (`subjectField` required) is the smallest shape that cannot
  over-claim; a global mode is a future ADR if ever genuinely needed.
- **State-kind field on one query to distinguish baseline vs remaining** — rejected: two
  explicit roles are already exactly typed by Phase 14; a discriminator field re-introduces
  a selection rule the evaluator would have to trust.
- **A neutral `integer` manifest field type for counts** — deferred: it would alter the
  frozen v1 declared-type vocabulary; reusing `integer-minor-units` (the vocabulary's only
  integer primitive) is honest and safe. A future manifest version may add it.
