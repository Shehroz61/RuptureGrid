// =====================================================================
// RuptureGrid v1.1 Phase 17 — composite truth-input watermark, P only
// (ADR-0026 §13 "Writer protocol"; Checkpoint B1)
// =====================================================================
// The run-scoped composite truth-input watermark is `W = (C, P, D)`:
//
//   C — the raw-evidence chain identity (advanced by
//       `appendChainObservation` under the same per-run advisory lock);
//   P — the PROVENANCE revision (Checkpoint B1), advanced by +1 in the
//       SAME transaction as every truth-bearing non-chain write;
//   D — the DERIVATION generation (Checkpoint B2), advanced by +1 in the
//       SAME transaction as every committed derived-projection commit
//       (`advanceDerivationGeneration` below + the derivation-attempt
//       protocol in `@rupturegrid/evidence`).
//
// The writer protocol (frozen, ADR-0026 §13): every writer of a
// truth-bearing non-chain row of a run MUST, in ONE PostgreSQL
// transaction:
//   1. acquire the SAME per-run transaction-scoped advisory lock the
//      append primitive uses — `SELECT pg_advisory_xact_lock(hashtext
//      (runId::text))` — FIRST;
//   2. perform the authoritative insert/update;
//   3. advance `provenanceRevision = provenanceRevision + 1` on
//      `control.run_truth_input_head` (upsert; missing row ⇒ 0);
//   4. commit.
//
// Non-negotiables (ADR-0026 §13):
//   - Row write and revision advance are NEVER separate transactions: a
//     rolled-back write never advances the revision, and a committed
//     truth-bearing write always does.
//   - The lock covers ONLY the DB-local write; it is NEVER held across
//     the physical HTTP request (`recordInvocation` still runs AFTER the
//     send, exactly as today).
//   - One lock only; no second lock is acquired while holding it.
//   - The protocol does NOT fence the write (R-10/ADR-0009 unchanged): a
//     stale generation still records honestly and its row is preserved
//     and attributed.
//   - P is COORDINATION METADATA about what has been written — never
//     business truth, never a verdict, never evidence (R-18).
//   - An operation that writes NO truth-bearing row (an idempotent
//     no-op, a rejected guarded transition) must NOT advance P: the
//     caller advances P only when its guarded write actually changed a
//     row (or when it wrote an attributed row such as a
//     `stale_writer_event`).
//
// The advisory-lock identity is EXACTLY the one used by
// `RawObservationStore.appendChainObservation`; `hashtext` collisions
// only add conservative false contention between runs, never false
// exclusion.

import type { PrismaClient } from '@rupturegrid/control-db';

/**
 * The minimal transaction-client surface the protocol needs. Both the
 * generated `PrismaClient` and an interactive `$transaction` client are
 * structurally assignable, so the helpers can be called with either —
 * avoiding any accidental nested `$transaction`.
 */
export interface RunLockedTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** Interactive-transaction bounds for provenance writers (bounded hold). */
export const PROVENANCE_TRANSACTION_TIMEOUT_MS = 15_000;
export const PROVENANCE_TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * Bounded wait for the per-run advisory lock. PostgreSQL's `lock_timeout`
 * applies to advisory-lock acquisition, so a holder that never releases
 * cannot hang a provenance writer indefinitely. A timeout aborts the
 * whole transaction (it writes nothing) — the caller classifies it as an
 * infrastructure failure (verification/write could not be performed).
 */
export const DEFAULT_RUN_LOCK_TIMEOUT_MS = 5_000;

/** The run's P/D revision pair. Missing head row ⇒ `(0n, 0n)`. */
export interface TruthInputHead {
  readonly provenanceRevision: bigint;
  readonly derivationGeneration: bigint;
}

/**
 * The minimal raw-read surface `readTruthInputHead` needs. Both the
 * generated `PrismaClient` and an interactive `$transaction` client are
 * structurally assignable, so the same bounded head read can run inside
 * a lock-scoped transaction (the writer protocol) or standalone.
 */
export interface RawReadable {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * Acquires the per-run transaction-scoped advisory lock — the EXACT
 * identity the append primitive uses, plus a bounded lock wait. MUST be
 * called as the first DB operation of the writer transaction.
 */
export async function acquireRunLock(
  tx: RunLockedTx,
  runId: string,
  lockTimeoutMs: number = DEFAULT_RUN_LOCK_TIMEOUT_MS,
): Promise<void> {
  const timeout =
    Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0
      ? Math.floor(lockTimeoutMs)
      : DEFAULT_RUN_LOCK_TIMEOUT_MS;
  // `set_config(..., true)` is transaction-local; a parameter is used
  // (never string concatenation) so there is no SQL-injection surface.
  // Both statements go through `$executeRaw` — the EXACT primitive the
  // append path uses for the advisory lock (`pg_advisory_xact_lock`
  // returns `void`, which `$queryRaw` cannot deserialize).
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${timeout}ms`}, true)`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${runId}::text))`;
}

/**
 * Advances `P` by EXACTLY 1 in the caller's transaction (upsert; the
 * initial value is 1 because this call accompanies the run's first
 * truth-bearing write, or an increment of an existing head). MUST run in
 * the SAME transaction as the write it accompanies.
 */
export async function advanceProvenanceRevision(tx: RunLockedTx, runId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "control"."run_truth_input_head"
      ("runId", "provenanceRevision", "derivationGeneration", "updatedAt")
    VALUES (${runId}::uuid, 1::bigint, 0::bigint, now())
    ON CONFLICT ("runId") DO UPDATE
      SET "provenanceRevision" =
            "control"."run_truth_input_head"."provenanceRevision" + 1,
          "updatedAt" = now()
  `;
}

/**
 * B2 (ADR-0026 §13 derived-projection rule): advances `D` by EXACTLY 1
 * in the caller's transaction — the SAME transaction as the committed
 * derived-projection write it accompanies. MUST be called (a) after
 * `acquireRunLock` inside that transaction and (b) ONLY when the
 * transaction actually committed a truth-changing derived row: an
 * idempotent no-op (the deterministic row already existed) advances
 * nothing, so repeat derivation never churns the generation (§26 case
 * on idempotent convergence; case 62's "no-op is never a generation").
 * A rolled-back derived write advances nothing (same transaction).
 *
 * `D` is coordination metadata about what has been DERIVED — never
 * business truth, never a verdict (R-18). Raw observations never advance
 * `D`; derived rows never advance `C`.
 */
export async function advanceDerivationGeneration(tx: RunLockedTx, runId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "control"."run_truth_input_head"
      ("runId", "provenanceRevision", "derivationGeneration", "updatedAt")
    VALUES (${runId}::uuid, 0::bigint, 1::bigint, now())
    ON CONFLICT ("runId") DO UPDATE
      SET "derivationGeneration" =
            "control"."run_truth_input_head"."derivationGeneration" + 1,
          "updatedAt" = now()
  `;
}

/**
 * Reads the run's `(P, D)` revision pair. A missing head row is `(0n, 0n)`
 * (the frozen compatibility default). Returned as `bigint` — never coerced
 * through JS Number.
 */
export async function readTruthInputHead(
  prisma: RawReadable,
  runId: string,
): Promise<TruthInputHead> {
  const rows = (await prisma.$queryRaw`
    SELECT "provenanceRevision" AS "p", "derivationGeneration" AS "d"
      FROM "control"."run_truth_input_head"
     WHERE "runId" = ${runId}::uuid
  `) as Array<{ p: bigint; d: bigint }>;
  const row = rows[0];
  if (row === undefined) {
    return { provenanceRevision: 0n, derivationGeneration: 0n };
  }
  return {
    provenanceRevision: BigInt(row.p),
    derivationGeneration: BigInt(row.d),
  };
}

/**
 * Resolves the immutable `runId` of a step run (a bootstrap read used to
 * pick the advisory-lock key; the runId never changes). Returns null when
 * the step does not exist.
 */
export async function resolveRunIdOfStep(
  prisma: PrismaClient,
  stepRunId: string,
): Promise<string | null> {
  const rows = (await prisma.$queryRaw`
    SELECT "runId" FROM "control"."experiment_step_run" WHERE "id" = ${stepRunId}::uuid
  `) as Array<{ runId: string }>;
  return rows[0]?.runId ?? null;
}
