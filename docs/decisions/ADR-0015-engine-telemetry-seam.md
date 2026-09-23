# ADR-0015: Observability via a Structured Engine Telemetry Seam (OTel-Compatible)

## Status

Accepted (Phase 9).

## Context

Phase 9 requires "OpenTelemetry instrumentation; observability of the engine itself (queues,
leases, reconciliation metrics)" (phase-roadmap Phase 9) under the priority "observability
without inventing truth". RuptureGrid already emits structured, redacted, correlation-ID-bearing
logs (designed in from Phase 1; engineering-rules §10). What is missing is a unified seam through
which the execution engine reports what REALLY happened — step lifecycles, invocation transport
stages, wave timing, fault arm/disarm — in a form that (a) is durable, (b) carries the existing
correlation IDs, and (c) can flow to OpenTelemetry without the engine depending on an SDK.

## Decision

1. **A narrow telemetry seam lives in the engine** (`@rupturegrid/engine/telemetry`): a typed
   event emitter interface (`EngineTelemetry`) with a closed, versioned event vocabulary
   (`engine-telemetry/v1`). Producers call it at real execution points only; there is no metric
   that is not derived from a real event.
2. **The default sink is the structured logger.** Worker-registered sinks record every event as
   structured, redacted log lines carrying `runId` / `stepRunId` / `invocationIdentity` — durable,
   greppable, and always on. No event is invented to fill a dashboard.
3. **OpenTelemetry at the API boundary.** If the OpenTelemetry API is present, the worker
   registers a bridge that maps each event to a span/event with the same attributes; with no SDK
   registered, OTel calls are no-ops and nothing is lost (the structured sink is the durable
   record). The engine never links the OTel SDK itself.
4. **Durable truth boundary.** Telemetry is operational observation. It never writes execution
   rows, evidence rows, evaluations, or findings, and it is never an input to any evaluator
   (ADR-0007). Analysis reads only persisted truth.
5. **Engine-observable surfaces in v1:** step claim/executing/terminal transitions; per-invocation
   transport stage, HTTP status, duration, and side-effect classification; repeat-wave start and
   stagger; fault arm/disarm outcomes; reconciliation sweep results and lease recoveries
   (counted from real sweep returns, never estimated).

## Consequences

- Real traces exist for real runs (roadmap acceptance: "telemetry shows real traces for real
  runs") without the engine importing vendor SDKs; export can be enabled purely by configuration.
- The closed event vocabulary keeps dashboards honest: a panel can only show what an event
  actually recorded. There is no "synthetic demo mode".
- Future phases (e.g. Phase 10 drills) can consume the same seam without new engine surgery.

## Alternatives considered

- **Full OTel SDK inside the engine package**: rejected — would force an SDK dependency on every
  consumer and couple core semantics to a vendor surface; the seam + bridge achieves the same
  with inversion.
- **Metrics-only observability** (counters without per-event records): rejected — counters
  without the underlying events cannot explain an INDETERMINATE outcome, which is precisely the
  Phase 9 investigation story.
