// =====================================================================
// RuptureGrid v1.0 — atomic claim, lease, fencing token, heartbeat
// =====================================================================
// Claiming is ONE conditional UPDATE inside one transaction
// (architecture §10, ADR-0009):
//
//   UPDATE experiment_step_run
//      SET lease_owner_id = $me, fencing_token = fencing_token + 1,
//          lease_expires_at = statement_timestamp() + $lease, ...
//    WHERE id = $id
//      AND state IN ('PENDING','DISPATCHED')         -- claimable
//      AND (lease_owner_id IS NULL OR lease_expires_at < now())
//
// Only one worker generation can ever hold a fencing token: the token
// monotonically increases on every successful claim, and every owner
// state write is conditioned on (owner, token). Lease expiry uses
// DATABASE time, not worker clocks (Phase 3 §33).

import type { PrismaClient, StepState } from '@rupturegrid/control-db';

export interface ClaimOptions {
  readonly ownerId: string;
  readonly leaseDurationMs: number;
}

export interface ClaimResult {
  readonly stepRunId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly name: string;
  readonly fencingToken: string;
  readonly leaseExpiresAt: Date;
  readonly state: StepState;
}

/**
 * Atomically claims a claimable step run. Returns the claim
 * (owner + fencing token + lease deadline) or null when the step is
 * not claimable (already claimed by a live lease, terminal, or
 * cancelled run). The fencing token increments on every successful
 * claim; the previous generation's writes can no longer match.
 */
export async function claimStep(
  prisma: PrismaClient,
  stepRunId: string,
  options: ClaimOptions,
): Promise<ClaimResult | null> {
  // The claim and the run's DISPATCHING → RUNNING transition are ONE
  // atomic UPDATE so a run can never be observed RUNNING without any
  // claimed step (and never stay DISPATCHING while a step executes).
  const rows = (await prisma.$queryRaw`
    WITH claimed AS (
      UPDATE "control"."experiment_step_run" AS s
         SET "state"           = 'CLAIMED',
             "leaseOwnerId"    = ${options.ownerId},
             "leaseExpiresAt"  = "statement_timestamp"() + (${options.leaseDurationMs} * interval '1 millisecond'),
             "fencingToken"    = "fencingToken" + 1,
             "claimedAt"       = "statement_timestamp"(),
             "dispatchState"   = 'DISPATCHED',
             "dispatchAttempts" = "dispatchAttempts" + 1,
             "updatedAt"       = "statement_timestamp"()
       WHERE s."id" = ${stepRunId}::uuid
         -- Claimable: never-dispatched work, or a CLAIMED/EXECUTING
         -- step whose lease has EXPIRED (takeover by a new owner
         -- generation — ADR-0009 §46). A live lease is never stealable.
         AND (
           s."state" IN ('PENDING', 'DISPATCHED')
           OR (
             s."state" IN ('CLAIMED', 'EXECUTING')
             AND s."leaseExpiresAt" < "statement_timestamp"()
           )
         )
         AND (s."leaseOwnerId" IS NULL OR s."leaseExpiresAt" < "statement_timestamp"())
         AND EXISTS (
           SELECT 1 FROM "control"."experiment_run" r
            WHERE r."id" = s."runId"
              AND r."state" NOT IN ('CANCELLED', 'FAILED', 'COMPLETED')
         )
         -- Ordered-step dependency: a step is claimable only when
         -- every earlier step of its run is already SUCCEEDED (or it
         -- is the first step). Premature deliveries (duplicate queue
         -- jobs, reconciler races) exit safely as not-claimable.
         -- NOTE: outer references MUST be qualified with "s" — inside
         -- this subquery, unqualified "runId"/"sequence" would bind to
         -- "prior" and make the guard vacuous.
         AND NOT EXISTS (
           SELECT 1 FROM "control"."experiment_step_run" prior
            WHERE prior."runId" = s."runId"
              AND prior."sequence" < s."sequence"
              AND prior."state" <> 'SUCCEEDED'
         )
      RETURNING s."id", s."runId", s."sequence", s."name",
                s."fencingToken"::text AS fencing_token,
                s."leaseExpiresAt", s."state"
    ), run_promoted AS (
      UPDATE "control"."experiment_run" r
         SET "state" = 'RUNNING', "updatedAt" = "statement_timestamp"()
       WHERE r."state" = 'DISPATCHING'
         AND EXISTS (
           SELECT 1 FROM claimed c WHERE c."runId" = r."id"
         )
      RETURNING 1
    )
    SELECT c."id", c."runId" AS run_id, c."sequence", c."name",
           c.fencing_token, c."leaseExpiresAt" AS lease_expires_at, c."state"
      FROM claimed c
  `) as Array<{
    id: string;
    run_id: string;
    sequence: number;
    name: string;
    fencing_token: string;
    lease_expires_at: Date;
    state: StepState;
  }>;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    stepRunId: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    name: row.name,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    state: row.state,
  };
}

export class LeaseLostError extends Error {
  public constructor(stepRunId: string, ownerId: string) {
    super(
      `lease lost for step ${stepRunId}: owner ${ownerId} no longer holds the claim ` +
        `(expired and taken over, fenced out, or step terminal)`,
    );
    this.name = 'LeaseLostError';
  }
}

/**
 * Renews the lease if (and only if) the calling generation still owns
 * the step. Uses database time. A zero-row update throws
 * LeaseLostError — the caller must abort its in-memory progress and
 * never write state again (ADR-0009).
 */
export async function heartbeatStep(
  prisma: PrismaClient,
  stepRunId: string,
  options: ClaimOptions & { readonly fencingToken: string },
): Promise<Date> {
  const rows = (await prisma.$queryRaw`
    UPDATE "control"."experiment_step_run"
       SET "leaseExpiresAt" = "statement_timestamp"() + (${options.leaseDurationMs} * interval '1 millisecond'),
           "updatedAt"      = "statement_timestamp"()
     WHERE "id" = ${stepRunId}::uuid
       AND "leaseOwnerId" = ${options.ownerId}
       AND "fencingToken" = ${options.fencingToken}::bigint
       AND "state" IN ('CLAIMED', 'EXECUTING')
     RETURNING "leaseExpiresAt" AS "lease_expires_at"
  `) as Array<{ lease_expires_at: Date }>;
  const row = rows[0];
  if (row === undefined) {
    throw new LeaseLostError(stepRunId, options.ownerId);
  }
  return row.lease_expires_at;
}
