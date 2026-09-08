# ADR-0001 — Technology Stack

Status: Accepted (Phase 0)

## Context
RuptureGrid needs: a typed API with strong module boundaries, dedicated long-running worker processes, a serious product UI, relational durable truth, queue-based coordination, and containerized local infrastructure — built by a small team/agent workflow where clarity and testability outrank novelty. The repository lives on a Windows machine today but must remain portable (AGENTS R-15).

## Decision
Evaluate and adopt, pending version verification at Phase 1 (no versions frozen now, AGENTS R-20):
- **TypeScript on Node.js** — one language across API, worker, target, UI; strong typing for the failure-semantics contracts.
- **pnpm workspace** monorepo — multi-package (api, worker, web, demo-target, shared) with shared types/config.
- **NestJS** for the API — module system maps naturally to bounded contexts ([architecture.md](../architecture.md) §2).
- **Dedicated worker process** (not in-API execution) — the execution plane's distinct failure domain (crashes, leases) must be a real process boundary.
- **Next.js** for the product UI.
- **PostgreSQL** as durable truth; **Prisma** for schema/migrations (migrations authoritative, AGENTS R-12).
- **Redis + BullMQ** for coordination only (ADR-0003).
- **Docker Compose** for local infrastructure; **Playwright** (UI E2E, later); **OpenTelemetry** (later); **FFmpeg** (demo video, later).
- Runtime validation library for configuration and payload schemas; structured logging from Phase 1.

## Consequences
- One toolchain to master; shared contracts/types reduce drift.
- Node's single-threaded event loop makes the worker's concurrency semantics explicit (semaphores + real processes), which we want to test honestly ([testing-strategy.md](../testing-strategy.md) §6).
- Prisma migration workflow must be respected; no schema push (R-12).

## Alternatives considered
- **Go/Rust backend** — excellent runtime properties, but splits the codebase across languages for a product whose bottleneck is semantic clarity, not raw throughput.
- **Python stack** — weaker fit for a typed, process-heavy execution engine.
- **No queue (in-process execution)** — rejected: lease/reconciliation semantics need a real dispatch boundary (ADR-0009).

## Deferred questions
- Exact package versions and compatibility matrix (Phase 1, verified against official docs).
- Validation library choice; logging library choice (Phase 1).
- CI platform (Phase 11 or earlier).
