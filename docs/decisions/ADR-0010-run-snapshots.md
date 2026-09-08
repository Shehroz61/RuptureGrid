# ADR-0010 — Run Snapshots (Pinned Execution Intent)

Status: Accepted (Phase 0)

## Context
A historical run must forever answer "what exactly was supposed to happen?" — even after experiment definitions, target registration, limits, or engines change. Runs whose meaning silently shifts with later edits cannot support forensic conclusions or honest replay.

## Decision
- At run creation — before any execution — the Control Plane materializes a **RunSnapshot**: resolved target origin, full step templates (headers minus credentials), fault plan, repeat/concurrency/timeouts, ordering, expected outcome classes, invariant bindings, engine/normalizer/invariant versions, environment authorization record.
- Snapshots are **canonicalized, content-hashed, stored append-only**; runs and findings reference the hash ([incident-replay.md](../incident-replay.md) §2, §7).
- Snapshots store credential **references + fingerprints**, never values (ADR-0012).
- **Replay = new run from the stored snapshot** — exact-intent, post-fix, and regression modes ([incident-replay.md](../incident-replay.md) §3).
- Honest scope: replay reproduces **execution intent**; it cannot reproduce external network conditions, wall-clock timing, concurrency interleavings, or rotated secret values (fail-fast on fingerprint mismatch) ([incident-replay.md](../incident-replay.md) §4).

## Consequences
- Snapshots add storage and a versioning discipline; both are cheap relative to trustworthy forensics.
- Engine upgrades must either keep old versions runnable for replay or explicitly declare successors ([incident-replay.md](../incident-replay.md) §8).

## Alternatives considered
- **Re-run from live definitions** — rejected: silent drift; forensic meaning evaporates.
- **Persist full secrets for byte-faithful replay** — rejected: security over fidelity (ADR-0012); replay is semantic by design.

## Deferred questions
- Snapshot storage format details and canonicalization algorithm (Phase 3; must be stable and testable).
