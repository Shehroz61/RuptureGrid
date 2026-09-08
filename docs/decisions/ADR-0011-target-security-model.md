# ADR-0011 — Target Security Model (Narrow, Deny-by-Default, Production Denied)

Status: Accepted (Phase 0)

## Context
A tool that executes fault-laden HTTP traffic against systems is one design mistake away from being an SSRF platform or an arbitrary attack tool. The safe product is the narrow product.

## Decision
- Only **registered, authorized targets** are executable; destination validation is enforce-parsed-and-normalized origin matching, never string comparison ([security-boundaries.md](../security-boundaries.md) §3).
- **Production fault targeting is denied in v1**, enforced at run creation and re-checked pre-dispatch; enabling it later requires a dedicated security architecture and its own ADR.
- DNS-aware protections (resolve-validate-pin, address-class policy) are implemented in the executor, with **network egress isolation as the primary control** and the rebinding TOCTOU limitation documented honestly ([security-boundaries.md](../security-boundaries.md) §5).
- Later deployment models use **private-network execution agents** so the central service never needs broad egress.
- Blast-radius limits are server-side caps, re-checked at execution ([security-boundaries.md](../security-boundaries.md) §8).

## Consequences
- v1 supports local-development targets (the Demo Target) and explicitly authorized staging targets only — a deliberate product boundary ([product-spec.md](../product-spec.md) §8).
- Every destination-validation rule gets committed security probes (Phase 3 adversarial catalog).

## Alternatives considered
- **"Support everything" with user discretion** — rejected: unsafe and untrustworthy.
- **Rely on URL string checks only** — rejected: DNS rebinding and normalization bypasses make that theater.

## Deferred questions
- Multi-hop redirect handling details for read-only requests (Phase 3).
- Private-network agent architecture (post-v1; own ADR then).
