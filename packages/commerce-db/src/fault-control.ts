// =====================================================================
// Demo Commerce — controlled-fault control (closed v1 vocabulary)
// =====================================================================
// Target-owned fault machinery (ADR-0014), Phase 16 Commerce edition.
// The SAME closed vocabulary and semantics as the accepted Demo Fintech
// implementation — the fault hook DECLARATION moves to the target
// manifest (ADR-0016 faultHook), the TARGET-SIDE machinery stays
// target-owned, LOCAL_DEVELOPMENT-scoped, and deterministic. Fault
// plans live in the Commerce target's own PostgreSQL and are armed and
// disarmed ONLY through the target's own admin API. No new fault kind
// exists (prompt §40: reuse ONLY existing controlled-fault/v1
// vocabulary).

import { Prisma } from './generated/client/client.js';
import type { PrismaClient } from './generated/client/client.js';

/** The single plan-semantics version (docs/controlled-faults.md §3). */
export const FAULT_PLAN_VERSION = 'controlled-fault/v1';

/** Closed v1 fault-kind vocabulary — UNCHANGED. */
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
 * Bounds leakage if the arming caller dies mid-step.
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

/** Validates an arming request against the closed v1 vocabulary. */
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

/** Narrow structural surface the fault service needs. */
export type FaultControlClient = Pick<
  PrismaClient,
  'commerceFaultPlan' | '$queryRaw' | '$executeRaw'
>;

export interface FaultControlService {
  /** Arms (or replaces) the plan of this kind. */
  arm(input: FaultPlanInput): Promise<void>;
  /** Disarms (deletes) the plan of this kind; idempotent. */
  disarm(kind: string): Promise<void>;
  /** Read-only status for the inspection API. */
  status(): Promise<FaultStatus>;
  /** The per-request hook: atomically consumes one trigger if armed. */
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
      await client.commerceFaultPlan.upsert({
        where: { faultKind: input.faultKind },
        // Arming REPLACES any existing plan of this kind: a fresh budget
        // and TTL make arm-then-deliver deterministic and repeatable.
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
      await client.commerceFaultPlan.deleteMany({ where: { faultKind: kind } });
    },

    async status(): Promise<FaultStatus> {
      const plans = await client.commerceFaultPlan.findMany({ orderBy: { faultKind: 'asc' } });
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
      // Atomic conditional increment: the FIRST N matching checkouts
      // trigger in physical arrival order, even under full concurrency.
      const updated = (await client.$queryRaw`
        UPDATE "commerce_fault_plans"
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
      const plan = await client.commerceFaultPlan.findUnique({ where: { faultKind: kind } });
      if (plan === null || plan.expiresAt.getTime() <= at.getTime()) {
        return 'DISARMED';
      }
      return 'BUDGET_EXHAUSTED';
    },
  };
}

/** Re-exported for typed route wiring. */
export { Prisma };
