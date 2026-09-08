# ADR-0012 — Credential Handling and Redaction-before-Persistence

Status: Accepted (Phase 0)

## Context
Experiments may carry credentials to authorized targets. Persisted request evidence that faithfully stores `Authorization`/`Cookie` headers turns the evidence store into a secret leak. But redaction reduces literal byte-for-byte reproducibility. The trade-off must be explicit.

## Decision
- Credentials are stored as **references** (target registration) resolved from the environment only inside the executor at request time; **fingerprints** (truncated hashes) may be recorded for rotation detection — never reversible, never secret-equivalent.
- **Redaction happens before durable persistence** ([security-boundaries.md](../security-boundaries.md) §7): credential headers, query credentials, and target-declared sensitive fields never enter evidence or logs. A per-target secret registry declares sensitive fields; the denylist applies regardless.
- Therefore: replay is **semantic**, not byte-faithful, for redacted content — an accepted, documented trade-off. **Security wins over literal fidelity** ([incident-replay.md](../incident-replay.md) §4; [evidence-model.md](../evidence-model.md) §5).
- Secrets are excluded from snapshots, logs, timeline entries, and AI inputs (ADR-0007).

## Consequences
- Evidence consumers must be told redaction occurred (redaction notices on evidence views, [product-design.md](../product-design.md) §3 Evidence screen).
- Redaction completeness is a committed adversarial test, not a hope ([testing-strategy.md](../testing-strategy.md) §4 item 10).

## Alternatives considered
- **Persist everything for perfect replay** — rejected: secret leakage risk in a security tool is disqualifying.
- **Redact at read time** — rejected: secrets at rest remain exposed to any DB/store access; redaction must happen before persistence.

## Deferred questions
- Secret manager integration options (post-v1; environment references suffice for v1).
