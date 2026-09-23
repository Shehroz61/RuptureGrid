// =====================================================================
// RuptureGrid v1.0 — engine telemetry seam (Phase 9, ADR-0015)
// =====================================================================
// A NARROW seam through which the execution engine reports what REALLY
// happened — real events only (priority: observability without
// inventing truth). The event vocabulary is closed and versioned
// (`engine-telemetry/v1`); every event carries the correlation IDs that
// already exist (runId / stepRunId / invocationIdentity). Producers
// never fabricate events to make traces look richer, and telemetry
// NEVER writes execution/evidence/analysis truth (ADR-0015 §4).
//
// The default sink is the structured logger (durable, always on). An
// optional OpenTelemetry bridge maps the same events to spans/events
// when the API package is resolvable; with no SDK registered the OTel
// calls are no-ops and nothing is lost.

import { createRequire } from 'node:module';
import type { RuptureGridLogger } from '@rupturegrid/logger';

export const ENGINE_TELEMETRY_VERSION = 'engine-telemetry/v1';

/** The closed Phase 9 event vocabulary. */
export type EngineTelemetryEvent =
  | {
      readonly kind: 'step.lifecycle';
      readonly runId: string;
      readonly stepRunId: string;
      readonly phase: 'claimed' | 'executing' | 'terminal';
      readonly state?: string;
      readonly detail?: string;
    }
  | {
      readonly kind: 'invocation.executed';
      readonly runId: string;
      readonly stepRunId: string;
      readonly invocationIdentity: string;
      readonly waveIndex: number;
      readonly attempt: number;
      readonly transportStage: string | null;
      readonly httpStatus: number | null;
      readonly durationMs: number;
      readonly intentOutcome: string;
      readonly sideEffectKnowledge: string;
      readonly error: string | null;
    }
  | {
      readonly kind: 'wave.staggered';
      readonly runId: string;
      readonly stepRunId: string;
      readonly waveIndex: number;
      readonly staggerMs: number;
      readonly waitedMs: number;
    }
  | {
      readonly kind: 'fault.armed';
      readonly runId: string;
      readonly stepRunId: string;
      readonly faultKind: string;
      readonly maxTriggers: number;
    }
  | {
      readonly kind: 'fault.disarm.outcome';
      readonly runId: string;
      readonly stepRunId: string;
      readonly faultKind: string;
      readonly outcome: 'disarmed' | 'failed';
      readonly detail?: string;
    }
  | {
      readonly kind: 'fault.status.observed';
      readonly runId: string;
      readonly stepRunId: string;
      readonly outcome: 'captured' | 'failed';
      readonly detail?: string;
    }
  | {
      readonly kind: 'reconcile.sweep';
      readonly requeued: number;
      readonly settled: number;
      readonly leaseRecoveries: number;
      readonly analyzed?: number;
    };

/** The narrow sink the engine depends on (inversion — ADR-0015 §1). */
export interface EngineTelemetry {
  record(event: EngineTelemetryEvent): void;
}

/** Logger-backed sink: the durable default (structured, redacted). */
export function createLoggerTelemetry(logger: RuptureGridLogger): EngineTelemetry {
  return {
    record(event: EngineTelemetryEvent): void {
      logger.info(`engine-telemetry ${event.kind}`, {
        ...event,
        telemetryVersion: ENGINE_TELEMETRY_VERSION,
      });
    },
  };
}

export const noopTelemetry: EngineTelemetry = {
  record(): void {
    // Telemetry absence must never affect execution semantics.
  },
};

/**
 * Optional OpenTelemetry bridge. Dynamically imports `@opentelemetry/api`
 * so the engine has NO hard dependency on it; when the module (or a
 * tracer provider) is absent, events still flow to the wrapped sink
 * (the durable record) and OTel contributes nothing. Attributes carry
 * ONLY values already present on the event — nothing is synthesized.
 */
export function withOpenTelemetryBridge(
  inner: EngineTelemetry,
  loadApi: () => unknown = loadOtelApi,
): EngineTelemetry {
  let tracer: {
    startActiveSpan: (name: string, fn: (span: unknown) => unknown) => unknown;
  } | null = null;
  let probed = false;
  const probe = (): void => {
    if (probed) {
      return;
    }
    probed = true;
    try {
      const api = loadApi() as { trace?: { getTracer?: (name: string) => unknown } } | null;
      const traceApi = api?.trace;
      const getTracer = traceApi?.getTracer;
      if (typeof getTracer === 'function' && traceApi !== undefined) {
        tracer = getTracer.call(traceApi, 'rupturegrid-engine') as typeof tracer;
      }
    } catch {
      tracer = null; // No API installed: the structured sink remains the record.
    }
  };
  return {
    record(event: EngineTelemetryEvent): void {
      inner.record(event);
      probe();
      if (tracer === null) {
        return;
      }
      try {
        const spanName = `rupturegrid.${event.kind}`;
        const attributes = flattenAttributes(event);
        const activeTracer = tracer as NonNullable<typeof tracer>;
        activeTracer.startActiveSpan(spanName, (span: unknown) => {
          if (span !== null && span !== undefined && typeof span === 'object') {
            const setAttribute = (span as { setAttribute?: (k: string, v: string) => void })
              .setAttribute;
            if (typeof setAttribute === 'function') {
              for (const [key, value] of Object.entries(attributes)) {
                setAttribute.call(span, key, value);
              }
            }
          }
          // Events are instantaneous records; end immediately.
          const end = (span as { end?: () => void }).end;
          if (typeof end === 'function') {
            end.call(span);
          }
          return span;
        });
      } catch {
        // Telemetry must never break execution; the durable record above
        // already captured the event.
      }
    },
  };
}

function flattenAttributes(event: EngineTelemetryEvent): Record<string, string> {
  const attributes: Record<string, string> = { 'rg.telemetry.version': ENGINE_TELEMETRY_VERSION };
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) {
      continue;
    }
    attributes[`rg.${key}`] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return attributes;
}

/** Indirection so tests can stub the module resolution. */
function loadOtelApi(): unknown {
  try {
    // ESM-safe synchronous resolution of the OPTIONAL peer: when the
    // package is absent this throws and the bridge degrades to the
    // wrapped (durable) sink.
    const require = createRequire(import.meta.url);
    return require('@opentelemetry/api');
  } catch {
    return null;
  }
}
