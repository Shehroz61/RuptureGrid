# ADR-0006 — Evidence Truth Model (Honest Guarantees)

Status: Accepted (Phase 0)

## Context
RuptureGrid's findings are only as credible as their evidence. It is tempting to describe stored evidence as "immutable" or "tamper-proof". Those claims would be false — database records with hashes are not cryptographic proof of authorship or non-repudiation. Overstating guarantees would be the same class of defect the product exists to expose in others.

## Decision
Evidence storage is designed as ([evidence-model.md](../evidence-model.md) §4):
- **logically append-only** (no application update/delete paths; corrections supersede, never rewrite);
- **content-addressed** (SHA-256 over canonical serialized bytes);
- **hash-chained per run** (each observation links its predecessor's hash; runs store the chain head);
- **versioned** (observation schemas, redaction policy).

Honest statement, part of the contract: this detects post-hoc modification by application writers. It does **not** prove authorship, prevent privileged storage-level rewriting, or constitute legal non-repudiation. Stronger guarantees (external anchoring, signing, WORM) are future, explicit extensions.

## Consequences
- Terminology is constrained repo-wide (AGENTS R-18): never "immutable"/"tamper-proof"/"non-repudiable" for these records.
- Chain verification becomes a testable, committed behavior (Phase 4).

## Alternatives considered
- **Plain rows without hashing** — rejected: detectable modification is cheap and materially valuable.
- **Merkle-tree anchoring now** — deferred: real value, but premature complexity before evidence volumes exist.

## Deferred questions
- External anchoring / signed evidence (unscheduled; requires its own ADR).
