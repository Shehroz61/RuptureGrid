// =====================================================================
// Unit — Phase 9 target-owned fault control (docs/controlled-faults.md §3–§5)
// =====================================================================
// Deterministic activation: first-N-matching-deliveries via an atomic
// conditional increment. Exhausted budgets resume normal behavior; an
// expired plan is disarmed by definition; unsupported plans are refused
// at the boundary. The SQL semantics of consumeTrigger (atomic
// conditional UPDATE ... RETURNING) are proven against real PostgreSQL
// in the Phase 9 integration suite; here the increment logic is
// exercised through a faithful client shim.

import { describe, expect, it, vi } from 'vitest';
import {
  createFaultControlService,
  validateFaultPlanInput,
  FaultControlError,
  FAULT_PLAN_VERSION,
  FAULT_KINDS,
  FAULT_PLAN_TTL_MS,
} from './fault-control.js';
import type { FaultPlan } from './generated/client/client.js';

/** Faithful shim of the atomic conditional UPDATE inside consumeTrigger. */
function makeClient(rows: Map<string, FaultPlan>) {
  const client = {
    faultPlan: {
      upsert: vi.fn(async ({ where, update, create }: never) => {
        const kind = (where as { faultKind: string }).faultKind;
        const existing = rows.get(kind);
        if (existing !== undefined) {
          Object.assign(existing, update, { faultKind: kind });
          return existing;
        }
        // Mirror the schema defaults on create (triggersUsed @default(0)).
        const created = {
          triggersUsed: 0,
          lastTriggeredAt: null,
          ...(create as Record<string, unknown>),
          faultKind: kind,
        } as FaultPlan;
        rows.set(kind, created);
        return created;
      }),
      deleteMany: vi.fn(async ({ where }: never) => {
        const kind = (where as { faultKind: string }).faultKind;
        return rows.delete(kind) ? 1 : 0;
      }),
      findUnique: vi.fn(
        async ({ where }: never) => rows.get((where as { faultKind: string }).faultKind) ?? null,
      ),
      findMany: vi.fn(async () =>
        [...rows.values()].sort((a, b) => a.faultKind.localeCompare(b.faultKind)),
      ),
    }, // NOTE: the create path mirrors the schema defaults
    // (triggersUsed @default(0), lastTriggeredAt nullable).
    // consumeTrigger invokes $queryRaw as a TAGGED TEMPLATE:
    // (strings, at, at, kind, at). The shim extracts the interpolated
    // values (one string = faultKind, one Date = now) and applies the
    // same conditional increment the real SQL performs.
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      const values = args.slice(1); // drop the TemplateStringsArray
      const kind = values.find((value): value is string => typeof value === 'string');
      const at = values.find((value): value is Date => value instanceof Date);
      if (kind === undefined || at === undefined) {
        return [];
      }
      const plan = rows.get(kind);
      if (
        plan === undefined ||
        plan.expiresAt.getTime() <= at.getTime() ||
        plan.triggersUsed >= plan.maxTriggers
      ) {
        return [];
      }
      plan.triggersUsed += 1;
      plan.lastTriggeredAt = at;
      return [{ triggersUsed: plan.triggersUsed }];
    }),
    $executeRaw: vi.fn(),
  };
  return { client };
}

const PLAN = {
  planVersion: FAULT_PLAN_VERSION,
  faultKind: 'PRE_MUTATION_REJECTION',
  activation: 'first_n_matching_deliveries',
  maxTriggers: 1,
} as const;

function planFrom(input: typeof PLAN, armedAt: Date): FaultPlan {
  return {
    id: 'fp-' + input.faultKind,
    faultKind: input.faultKind,
    planVersion: input.planVersion,
    activation: input.activation,
    maxTriggers: input.maxTriggers,
    triggersUsed: 0,
    armedAt,
    expiresAt: new Date(armedAt.getTime() + FAULT_PLAN_TTL_MS),
    lastTriggeredAt: null,
    updatedAt: armedAt,
  } as FaultPlan;
}

describe('fault plan boundary validation', () => {
  it('accepts a valid v1 plan', () => {
    expect(validateFaultPlanInput(PLAN)).toEqual(PLAN);
  });

  it('refuses an unsupported version at the boundary', () => {
    expect(() => validateFaultPlanInput({ ...PLAN, planVersion: 'controlled-fault/v2' })).toThrow(
      FaultControlError,
    );
  });

  it('refuses unknown kinds and activations', () => {
    expect(() => validateFaultPlanInput({ ...PLAN, faultKind: 'KILL_PROCESS' })).toThrow(
      FaultControlError,
    );
    expect(() => validateFaultPlanInput({ ...PLAN, activation: 'random' })).toThrow(
      FaultControlError,
    );
  });

  it('refuses budgets outside [1, 10] and non-integers', () => {
    for (const maxTriggers of [0, -1, 11, 1.5, '3']) {
      expect(() => validateFaultPlanInput({ ...PLAN, maxTriggers })).toThrow(FaultControlError);
    }
  });
});

describe('fault control service (one-shot / exhaustion / expiry)', () => {
  it('arming replaces an existing plan with a fresh budget and TTL', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    const armedAt = new Date('2026-09-21T10:00:00Z');
    const stale = planFrom(PLAN, new Date('2026-09-21T09:00:00Z'));
    stale.triggersUsed = 1; // budget consumed by an earlier run
    rows.set(PLAN.faultKind, stale);
    vi.useFakeTimers({ now: armedAt });
    await service.arm(PLAN);
    const status = await service.status();
    vi.useRealTimers();
    expect(status.plans).toHaveLength(1);
    expect(status.plans[0]?.triggersUsed).toBe(0);
    expect(status.plans[0]?.maxTriggers).toBe(1);
    expect(status.plans[0]?.armedAt).toBe(armedAt.toISOString());
  });

  it('consumes exactly maxTriggers then BUDGET_EXHAUSTED (normal behavior resumes)', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    const armedAt = new Date('2026-09-21T10:00:00Z');
    vi.useFakeTimers({ now: armedAt });
    await service.arm({ ...PLAN, maxTriggers: 2 });
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('TRIGGERED');
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('TRIGGERED');
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('BUDGET_EXHAUSTED');
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('BUDGET_EXHAUSTED');
    expect(rows.get(PLAN.faultKind)?.triggersUsed).toBe(2);
    vi.useRealTimers();
  });

  it('one-shot plan triggers exactly once', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    vi.useFakeTimers({ now: new Date('2026-09-21T10:00:00Z') });
    await service.arm(PLAN);
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('TRIGGERED');
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('BUDGET_EXHAUSTED');
    vi.useRealTimers();
    void client;
  });

  it('reports DISARMED when no plan exists', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    expect(await service.consumeTrigger('CRASH_MID_PROCESSING')).toBe('DISARMED');
    void client;
  });

  it('treats an expired plan as DISARMED (lazy TTL)', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    const armedAt = new Date('2026-09-21T10:00:00Z');
    vi.useFakeTimers({ now: armedAt });
    await service.arm(PLAN);
    // Move past the TTL: consumption is refused and status reports expiry.
    vi.setSystemTime(new Date(armedAt.getTime() + FAULT_PLAN_TTL_MS + 1));
    expect(await service.consumeTrigger('PRE_MUTATION_REJECTION')).toBe('DISARMED');
    const status = await service.status();
    vi.useRealTimers();
    expect(status.plans[0]?.expired).toBe(true);
    expect(status.plans[0]?.triggersUsed).toBe(0); // never activated
  });

  it('disarm is idempotent and removes the plan entirely', async () => {
    const rows = new Map<string, FaultPlan>();
    const { client } = makeClient(rows);
    const service = createFaultControlService({ client: client as never });
    rows.set(PLAN.faultKind, planFrom(PLAN, new Date()));
    await service.disarm(PLAN.faultKind);
    await service.disarm(PLAN.faultKind); // second call: no row, no throw
    expect(await service.status()).toEqual({ plans: [] });
    void client;
  });
});

describe('fault kind vocabulary', () => {
  it('is the closed v1 set from the design doc', () => {
    expect([...FAULT_KINDS]).toEqual([
      'PRE_MUTATION_REJECTION',
      'CRASH_MID_PROCESSING',
      'RESPONSE_TRUNCATION',
    ]);
  });
});
