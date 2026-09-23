// =====================================================================
// Unit — Phase 9 engine telemetry seam (ADR-0015)
// =====================================================================
// Telemetry is operational observation only: a closed, versioned event
// vocabulary, real events only, no execution/evidence mutation.

import { describe, expect, it, vi } from 'vitest';
import {
  createLoggerTelemetry,
  noopTelemetry,
  withOpenTelemetryBridge,
  ENGINE_TELEMETRY_VERSION,
} from './telemetry.js';
import type { EngineTelemetryEvent } from './telemetry.js';

const BASE = {
  runId: 'r-1',
  stepRunId: 's-1',
} as const;

describe('engine telemetry seam', () => {
  it('exposes a closed, versioned event vocabulary', () => {
    expect(ENGINE_TELEMETRY_VERSION).toBe('engine-telemetry/v1');
    const events: EngineTelemetryEvent[] = [
      { kind: 'step.lifecycle', ...BASE, phase: 'claimed' },
      {
        kind: 'invocation.executed',
        ...BASE,
        invocationIdentity: 'i-1',
        waveIndex: 0,
        attempt: 1,
        transportStage: 'REQUEST_SENT',
        httpStatus: 502,
        durationMs: 12,
        intentOutcome: 'FAILED',
        sideEffectKnowledge: 'INDETERMINATE',
        error: null,
      },
      { kind: 'wave.staggered', ...BASE, waveIndex: 1, staggerMs: 250, waitedMs: 251 },
      { kind: 'fault.armed', ...BASE, faultKind: 'PRE_MUTATION_REJECTION', maxTriggers: 1 },
      {
        kind: 'fault.disarm.outcome',
        ...BASE,
        faultKind: 'PRE_MUTATION_REJECTION',
        outcome: 'disarmed',
      },
      { kind: 'fault.status.observed', ...BASE, outcome: 'captured' },
      { kind: 'reconcile.sweep', requeued: 0, settled: 0, leaseRecoveries: 0 },
    ];
    const sink = vi.fn();
    for (const event of events) {
      sink({ ...event, telemetryVersion: ENGINE_TELEMETRY_VERSION });
    }
    expect(sink).toHaveBeenCalledTimes(events.length);
  });

  it('logger sink records events with the telemetry version (durable default)', () => {
    const logged: unknown[] = [];
    const logger = { info: (...args: unknown[]) => logged.push(args) };
    const telemetry = createLoggerTelemetry(logger as never);
    telemetry.record({
      kind: 'fault.armed',
      ...BASE,
      faultKind: 'CRASH_MID_PROCESSING',
      maxTriggers: 2,
    });
    expect(logged).toHaveLength(1);
    const [message, fields] = logged[0] as [string, Record<string, unknown>];
    expect(message).toContain('fault.armed');
    expect(fields['telemetryVersion']).toBe(ENGINE_TELEMETRY_VERSION);
    expect(fields['faultKind']).toBe('CRASH_MID_PROCESSING');
  });

  it('noop sink swallows everything without effects', () => {
    expect(() =>
      noopTelemetry.record({ kind: 'fault.status.observed', ...BASE, outcome: 'failed' }),
    ).not.toThrow();
  });

  it('OTel bridge degrades to the wrapped sink when no API is resolvable', () => {
    const inner = vi.fn();
    const telemetry = withOpenTelemetryBridge({ record: inner as never }, () => null);
    telemetry.record({
      kind: 'fault.armed',
      ...BASE,
      faultKind: 'RESPONSE_TRUNCATION',
      maxTriggers: 1,
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('OTel bridge never lets span failures break the durable record', () => {
    const inner = vi.fn();
    const telemetry = withOpenTelemetryBridge({ record: inner as never }, () => {
      throw new Error('module resolution exploded');
    });
    expect(() =>
      telemetry.record({
        kind: 'fault.armed',
        ...BASE,
        faultKind: 'RESPONSE_TRUNCATION',
        maxTriggers: 1,
      }),
    ).not.toThrow();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
