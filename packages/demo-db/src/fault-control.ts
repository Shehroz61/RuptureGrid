// =====================================================================
// Demo Fintech — Phase 9 target-owned controlled-fault control
// =====================================================================
// docs/controlled-faults.md §3–§5, ADR-0014. The Demo Target OWNS its
// fault machinery: fault plans live in the target's own PostgreSQL and
// are armed/disarmed ONLY through the target's own admin API with the
// admin credential. RuptureGrid has no Demo DATABASE credentials
// (ADR-0002) and can never write this state directly.
//
// Determinism contract (v1): activation is exactly
// `first_n_matching_deliveries` — the first N matching deliveries
// since arming trigger, in physical arrival order, via an ATOMIC
// conditional UPDATE (triggersUsed < maxTriggers ⇒ consume). No
// probability anywhere. An unsupported plan version or kind is refused
// at the boundary (400) — an older target never silently accepts a
// newer plan.

import { Prisma } from './generated/client/client.js';
import type { PrismaClient } from './generated/client/client.js';

/** The single plan-semantics version (docs/controlled-faults.md §3). */
export const FAULT_PLAN_VERSION = 'controlled-fault/v1';

/** Closed v1 fault-kind vocabulary. */
export const FAULT_KINDS = [
  'PRE_MUTATION_REJECTION',
  'CRASH_MID_PROCESSING',
  'RESPONSE_TRUNCATION',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** Closed v1 activation vocabulary. */
export const FAULT_ACTIVATIONS = ['first_n_matching_deliveries'] as const;
export type FaultActivation = (typeof FAULT_ACTIVATIONS)[number];

/** Trigger budget bounds (mirrors the engine's fault-plan validation). */
export const FAULT_PLAN_MIN_TRIGGERS = 1;
export const FAULT_PLAN_MAX_TRIGGERS = 10;

/**
 * Arming TTL (ms): an armed plan auto-expires 15 minutes after arming.
 * Bounds blast-radius leakage if the arming caller dies mid-step; an
 * expired plan is disarmed by definition (lazy, evaluated per hook).
 */
export const FAULT_PLAN_TTL_MS = 900_000;

/** Shape of a plan as armed via the admin API (typed, no free-form code). */
export interface FaultPlanInput {
  readonly planVersion: string;
  readonly faultKind: string;
  readonly activation: string;
  readonly maxTriggers: number;
}

/** Target-observed fault status (read-only inspection surface). */
export interface FaultStatus {
  readonly plans: Array<{
    readonly faultKind: string;
    readonly planVersion: string;
    readonly activation: string;
    readonly maxTriggers: number;
    readonly triggersUsed: number;
    readonly armedAt: string;
    readonly expiresAt: string;
    readonly expired: boolean;
  }>;
}

/** One activation outcome of the atomic conditional increment. */
export type ConsumeOutcome = 'TRIGGERED' | 'BUDGET_EXHAUSTED' | 'DISARMED';

export class FaultControlError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'FaultControlError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a fault-plan arming request at the target boundary. Every
 * field is checked against the closed v1 vocabulary and bounds —
 * nothing free-form is ever persisted.
 */
export function validateFaultPlanInput(raw: unknown): FaultPlanInput {
  if (!isRecord(raw)) {
    throw new FaultControlError('fault plan must be a JSON object', 400, 'FAULT_PLAN_INVALID');
  }
  const { planVersion, faultKind, activation, maxTriggers } = raw as {
    planVersion?: unknown;
    faultKind?: unknown;
    activation?: unknown;
    maxTriggers?: unknown;
  };
  if (planVersion !== FAULT_PLAN_VERSION) {
    throw new FaultControlError(
      `unsupported fault plan version: ${
        typeof planVersion === 'string' ? planVersion.slice(0, 40) : 'missing'
      } (this target implements ${FAULT_PLAN_VERSION})`,
      400,
      'FAULT_PLAN_UNSUPPORTED_VERSION',
    );
  }
  if (typeof faultKind !== 'string' || !(FAULT_KINDS as readonly string[]).includes(faultKind)) {
    throw new FaultControlError(
      `unknown faultKind (supported: ${FAULT_KINDS.join(', ')})`,
      400,
      'FAULT_PLAN_UNKNOWN_KIND',
    );
  }
  if (
    typeof activation !== 'string' ||
    !(FAULT_ACTIVATIONS as readonly string[]).includes(activation)
  ) {
    throw new FaultControlError(
      `unsupported activation (supported: ${FAULT_ACTIVATIONS.join(', ')})`,
      400,
      'FAULT_PLAN_UNSUPPORTED_ACTIVATION',
    );
  }
  if (
    typeof maxTriggers !== 'number' ||
    !Number.isInteger(maxTriggers) ||
    maxTriggers < FAULT_PLAN_MIN_TRIGGERS ||
    maxTriggers > FAULT_PLAN_MAX_TRIGGERS
  ) {
    throw new FaultControlError(
      `maxTriggers must be an integer in [${FAULT_PLAN_MIN_TRIGGERS}, ${FAULT_PLAN_MAX_TRIGGERS}]`,
      400,
      'FAULT_PLAN_INVALID_BUDGET',
    );
  }
  return { planVersion, faultKind, activation, maxTriggers };
}

/** Narrow structural surface the fault service needs (client or tx client). */
export type FaultControlClient = Pick<PrismaClient, 'faultPlan' | '$queryRaw' | '$executeRaw'>;

export interface FaultControlService {
  /** Arms (or replaces) the plan of this kind. */
  arm(input: FaultPlanInput): Promise<void>;
  /** Disarms (deletes) the plan of this kind; idempotent. */
  disarm(kind: string): Promise<void>;
  /** Read-only status for the inspection API. */
  status(): Promise<FaultStatus>;
  /**
   * The per-delivery hook: atomically consumes one trigger of the
   * named kind if an armed, unexpired plan has budget left. DISARMED
   * also covers expired plans (lazy expiry). Never throws for the
   * normal disarmed case.
   */
  consumeTrigger(kind: FaultKind): Promise<ConsumeOutcome>;
}

export function createFaultControlService(options: {
  client: FaultControlClient;
  now?: () => Date;
}): FaultControlService {
  const { client } = options;
  const now = options.now ?? (() => new Date());

  return {
    async arm(input: FaultPlanInput): Promise<void> {
      const at = now();
      await client.faultPlan.upsert({
        where: { faultKind: input.faultKind },
        // Arming REPLACES any existing plan of this kind: a fresh
        // budget and TTL make arm-then-deliver deterministic and
        // repeatable on a reused target.
        update: {
          planVersion: input.planVersion,
          activation: input.activation,
          maxTriggers: input.maxTriggers,
          triggersUsed: 0,
          armedAt: at,
          expiresAt: new Date(at.getTime() + FAULT_PLAN_TTL_MS),
          lastTriggeredAt: null,
        },
        create: {
          faultKind: input.faultKind,
          planVersion: input.planVersion,
          activation: input.activation,
          maxTriggers: input.maxTriggers,
          armedAt: at,
          expiresAt: new Date(at.getTime() + FAULT_PLAN_TTL_MS),
        },
      });
    },

    async disarm(kind: string): Promise<void> {
      await client.faultPlan.deleteMany({ where: { faultKind: kind } });
    },

    async status(): Promise<FaultStatus> {
      const plans = await client.faultPlan.findMany({ orderBy: { faultKind: 'asc' } });
      const at = now();
      return {
        plans: plans.map((plan) => ({
          faultKind: plan.faultKind,
          planVersion: plan.planVersion,
          activation: plan.activation,
          maxTriggers: plan.maxTriggers,
          triggersUsed: plan.triggersUsed,
          armedAt: plan.armedAt.toISOString(),
          expiresAt: plan.expiresAt.toISOString(),
          expired: plan.expiresAt.getTime() <= at.getTime(),
        })),
      };
    },

    async consumeTrigger(kind: FaultKind): Promise<ConsumeOutcome> {
      const at = now();
      // Atomic conditional increment: exactly one in-flight delivery can
      // flip triggersUsed from n to n+1 while n < maxTriggers, so the
      // FIRST N matching deliveries trigger in physical arrival order —
      // even under the canonical 8-way concurrency. Budget-exhausted or
      // disarmed deliveries never touch the row (single cheap probe).
      const updated = (await client.$queryRaw`
        UPDATE "fault_plans"
           SET "triggersUsed" = "triggersUsed" + 1,
               "lastTriggeredAt" = ${at},
               "updatedAt" = ${at}
         WHERE "faultKind" = ${kind}
           AND "expiresAt" > ${at}
           AND "triggersUsed" < "maxTriggers"
        RETURNING "triggersUsed"
      `) as ReadonlyArray<{ triggersUsed: number }>;
      if (updated.length > 0) {
        return 'TRIGGERED';
      }
      const plan = await client.faultPlan.findUnique({ where: { faultKind: kind } });
      if (plan === null || plan.expiresAt.getTime() <= at.getTime()) {
        return 'DISARMED';
      }
      return 'BUDGET_EXHAUSTED';
    },
  };
}

/** Re-exported for typed route wiring. */
export { Prisma };
