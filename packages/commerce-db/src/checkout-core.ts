// =====================================================================
// Demo Commerce — the checkout business core (Phase 16, ADR-0020)
// =====================================================================
// The target's OWN business logic. There is no RuptureGrid concept in
// this file: no invariant names, no PASS/FAIL/NOT_EVALUABLE, no
// truth vocabulary — the target reports commerce FACTS only (prompt
// §56). The vulnerable/secure distinction is a property of this
// business core, switchable ONLY through the target's own admin API.
//
// VULNERABLE (a REALISTIC naive bug — docs/checkout-zero.md §6):
//   Each submission runs an independent, non-serialized
//   check-then-reserve pipeline:
//     1. read the SKU row (its current remaining units),
//     2. decide "there is stock" from that READ COMMITTED snapshot,
//     3. create the order + reservation and decrement stock.
//   Under two genuinely overlapping submissions both pipelines read
//   remaining = 1 BEFORE either decrement lands, both decide "stock
//   available", and both commit an accepted order + reservation —
//   reserving a unit that does not exist (remaining = −1). The bug is
//   ordinary per-request processing under real overlap: one request →
//   one processing path; two overlapping requests → the race. There is
//   no "if vulnerable create two" code, no test-id special case, and no
//   post-hoc fabrication (prompt §55).
//
// SECURE (the SAME flow, corrected with target-owned correctness):
//   The reserve step runs inside ONE PostgreSQL transaction whose FIRST
//   statement is a CONDITIONAL settlement UPDATE of the logical intent
//   row (checkoutIntentId is unique WITHIN the verification scope, and
//   only a non-SETTLED intent matches). That statement takes the intent
//   row lock for the whole transaction, so a concurrent duplicate of
//   the SAME logical intent blocks, then matches ZERO rows once the
//   winner has committed: its transaction rolls back COMPLETELY and the
//   pipeline resolves to INTENT_ALREADY_ACCEPTED — exactly one accepted
//   order + reservation, remaining = 0. The protection is business
//   logic (the DB-enforced scoped identity plus the conditional
//   settlement and stock arithmetic), not a fixture (prompt §28).
//
// REAL overlap is provable from target state alone: every processing
// attempt persists startedAt/finishedAt and a monotonic startSequence
// (testing-strategy §6 — overlap is MEASURED from authoritative
// persisted timestamps, never asserted from Promise.all).

import { Prisma } from './generated/client/client.js';
import type {
  CheckoutEvent,
  CheckoutIntent,
  CommerceSettings,
  PrismaClient,
} from './generated/client/client.js';
import { randomId } from './signature.js';

export type CommerceMode = 'VULNERABLE' | 'SECURE';

export class CheckoutDomainError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'CheckoutDomainError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Scenario context (target-owned test/admin boundary — legitimate
// target interfaces only; RuptureGrid never touches this state)
// ---------------------------------------------------------------------

export interface ProcessingConfiguration {
  readonly mode: CommerceMode;
  readonly processingRevision: string;
  readonly targetInstanceId: string;
}

function configurationOf(settings: CommerceSettings): ProcessingConfiguration {
  return {
    mode: settings.processingMode,
    processingRevision: settings.processingRevision.toString(),
    targetInstanceId: settings.targetInstanceId,
  };
}

export interface ScenarioContext extends ProcessingConfiguration {
  readonly scopeId: string;
  readonly scopeToken: string;
  readonly generationId: number;
  readonly sku: string;
  readonly initialAvailableUnits: number;
}

/**
 * Initializes (or RESETS) the experiment context for a scope token:
 * a fresh generation with a fresh SKU baseline. In ONE transaction it
 *   (1) advances the scope's monotonic integer generation,
 *   (2) clears this scope's business rows (children first) so the new
 *       generation starts from a genuinely clean logical context —
 *       the canonical setup step's "clean logical context" is a real
 *       reset through the target's OWN admin interface, never an
 *       out-of-band edit (R-05),
 *   (3) re-baselines the SKU (initial = remaining = declared units) and
 *       re-binds it to this scope row,
 *   (4) applies the declared processing mode atomically.
 * The current generation value is what every inspection surface
 * reports (derived from each row's own scope relation — the reset
 * guarantees a single coherent generation exists at a time), which is
 * what makes baseline, effects, and remaining state exactly bindable
 * later (ADR-0018 Decision 7, ADR-0023 §4). No timestamp is any part
 * of the identity — the scope token and the integer generation are.
 */
export async function initializeScenarioContext(
  db: { client: PrismaClient },
  input: {
    readonly scopeToken: string;
    readonly sku: string;
    readonly initialAvailableUnits: number;
    readonly mode: CommerceMode;
  },
): Promise<ScenarioContext> {
  return resetScenarioContext(db, input);
}

/** New Phase 18 setup: reset business context without selecting a mode. */
export async function initializeScenarioContextPreservingMode(
  db: { client: PrismaClient },
  input: {
    readonly scopeToken: string;
    readonly sku: string;
    readonly initialAvailableUnits: number;
  },
): Promise<ScenarioContext> {
  return resetScenarioContext(db, {
    scopeToken: input.scopeToken,
    sku: input.sku,
    initialAvailableUnits: input.initialAvailableUnits,
  });
}

async function resetScenarioContext(
  db: { client: PrismaClient },
  input: {
    readonly scopeToken: string;
    readonly sku: string;
    readonly initialAvailableUnits: number;
    readonly mode?: CommerceMode;
  },
): Promise<ScenarioContext> {
  if (
    !Number.isInteger(input.initialAvailableUnits) ||
    input.initialAvailableUnits < 0 ||
    input.initialAvailableUnits > 9_007_199_254_740_991
  ) {
    throw new CheckoutDomainError(
      'initialAvailableUnits must be a non-negative safe integer (units, R-06 discipline)',
      400,
      'SCENARIO_INVALID_UNITS',
    );
  }
  const result = await db.client.$transaction(async (tx) => {
    // Serialize setup for this SKU, including concurrent first creation.
    // This is target-owned setup coordination, never a business-effect write.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'commerce-scenario-sku:' + input.sku}))`;
    // All setup writers acquire settings before scope/SKU, so mode
    // setters cannot race this context's observed configuration.
    let settings: CommerceSettings;
    if (input.mode === undefined) {
      const rows = await tx.$queryRaw<CommerceSettings[]>`
        SELECT * FROM commerce_settings WHERE id = 'default' FOR SHARE
      `;
      const existing = rows[0];
      if (existing === undefined) {
        throw new CheckoutDomainError(
          'processing configuration must be initialized first',
          409,
          'PROCESSING_NOT_INITIALIZED',
        );
      }
      settings = existing;
      const skuOwner = await tx.sku.findUnique({
        where: { sku: input.sku },
        include: { scope: true },
      });
      if (skuOwner !== null && skuOwner.scope.scopeId !== input.scopeToken) {
        throw new CheckoutDomainError(
          'SKU belongs to a different scenario scope',
          409,
          'SKU_SCOPE_CONFLICT',
        );
      }
    } else {
      settings = await tx.commerceSettings.upsert({
        where: { id: 'default' },
        update: { processingMode: input.mode, processingRevision: { increment: 1 } },
        create: { processingMode: input.mode, processingRevision: 1 },
      });
    }
    // One scope row per token; every legitimate reset ADVANCES the
    // integer generation (monotonic, target-owned — never a clock).
    const scope = await tx.verificationScope.upsert({
      where: { scopeId: input.scopeToken },
      update: { generationId: { increment: 1 } },
      create: { scopeId: input.scopeToken },
    });
    // Clear THIS scope's business rows, children first (reservations →
    // orders → processing attempts → request attempts → events →
    // intents). Deletion precedes re-baselining so the new generation
    // contains exactly its own rows; no prior-generation residue can
    // ever be mistaken for current evidence.
    await tx.reservation.deleteMany({
      where: { order: { intent: { scopeId: scope.id } } },
    });
    await tx.order.deleteMany({ where: { intent: { scopeId: scope.id } } });
    await tx.processingAttempt.deleteMany({
      where: { requestAttempt: { intent: { scopeId: scope.id } } },
    });
    await tx.requestAttempt.deleteMany({ where: { intent: { scopeId: scope.id } } });
    await tx.checkoutEvent.deleteMany({ where: { intent: { scopeId: scope.id } } });
    await tx.checkoutIntent.deleteMany({ where: { scopeId: scope.id } });
    const sku = await tx.sku.upsert({
      where: { sku: input.sku },
      update: {
        scopeId: scope.id,
        initialAvailableUnits: input.initialAvailableUnits,
        remainingAvailableUnits: input.initialAvailableUnits,
      },
      create: {
        sku: input.sku,
        scopeId: scope.id,
        initialAvailableUnits: input.initialAvailableUnits,
        remainingAvailableUnits: input.initialAvailableUnits,
      },
    });
    return { scope, sku, settings };
  });
  return {
    scopeId: result.scope.id,
    scopeToken: result.scope.scopeId,
    generationId: result.scope.generationId,
    sku: result.sku.sku,
    initialAvailableUnits: result.sku.initialAvailableUnits,
    ...configurationOf(result.settings),
  };
}

export async function getProcessingMode(db: { client: PrismaClient }): Promise<CommerceMode> {
  return (await getProcessingConfiguration(db)).mode;
}

export async function getProcessingConfiguration(db: {
  client: PrismaClient;
}): Promise<ProcessingConfiguration> {
  const settings = await db.client.commerceSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {},
  });
  return configurationOf(settings);
}

export async function setProcessingMode(
  db: { client: PrismaClient },
  mode: CommerceMode,
): Promise<CommerceMode> {
  return (await setProcessingConfiguration(db, mode)).mode;
}

export async function setProcessingConfiguration(
  db: { client: PrismaClient },
  mode: CommerceMode,
): Promise<ProcessingConfiguration> {
  const settings = await db.client.commerceSettings.upsert({
    where: { id: 'default' },
    update: { processingMode: mode, processingRevision: { increment: 1 } },
    create: { processingMode: mode, processingRevision: 1 },
  });
  return configurationOf(settings);
}

// ---------------------------------------------------------------------
// One physical submission → one processing path
// ---------------------------------------------------------------------

export interface SubmitCheckoutInput {
  readonly rawBody: Buffer;
  readonly requestAttemptId: string;
  readonly payload: {
    readonly checkoutIntentId: string;
    readonly customerId: string;
    readonly cartId: string;
    readonly totalMinor: bigint;
    readonly currency: string;
    readonly sku: string;
  };
}

export interface SubmitCheckoutResult extends ProcessingConfiguration {
  readonly requestAttemptId: string;
  readonly checkoutIntentId: string;
  readonly checkoutEventId: string;
  readonly processingAttemptId: string;
  readonly scopeToken: string | null;
  readonly generationId: number | null;
  readonly outcome: 'ACCEPTED' | 'INTENT_ALREADY_ACCEPTED' | 'STOCK_UNAVAILABLE';
  readonly orderId: string | null;
  readonly reservationId: string | null;
}

/**
 * Processes one physical checkout submission synchronously and returns
 * the definitive business outcome (the HTTP response never precedes
 * the outcome). Records the physical requestAttemptId verbatim, the
 * target-assigned processingAttemptId, and authoritative timing.
 */
export async function submitCheckout(
  db: { client: PrismaClient },
  input: SubmitCheckoutInput,
): Promise<SubmitCheckoutResult> {
  const configuration = await getProcessingConfiguration(db);
  const mode = configuration.mode;
  const payload = input.payload;

  // ---- Logical identity resolution ----
  // The verification scope is derived from the SKU's OWN current scope
  // binding (a reset re-binds the SKU to the fresh generation). The
  // logical intent identity is SCOPE-bound: the same stable
  // checkoutIntentId in two distinct scopes is two distinct logical
  // intents — one scope's intent can never shadow, or receive effects
  // from, another scope's submission. The intent is resolved/created
  // FIRST (logical business identity must exist before any physical
  // attempt is recorded); concurrent duplicate submissions race here
  // only on the intent ROW, which is shared — never on the business
  // effects.
  const scope = await currentScope(db, payload.sku);
  let intent: CheckoutIntent;
  try {
    intent = await db.client.checkoutIntent.upsert({
      where: {
        scopeId_checkoutIntentId: {
          scopeId: scope.id,
          checkoutIntentId: payload.checkoutIntentId,
        },
      },
      update: {},
      create: {
        checkoutIntentId: payload.checkoutIntentId,
        scopeId: scope.id,
        customerId: payload.customerId,
        cartId: payload.cartId,
        totalMinor: payload.totalMinor,
        currency: payload.currency,
        sku: payload.sku,
      },
    });
  } catch (error) {
    // Two genuinely concurrent FIRST submissions of the same logical
    // intent (both resolved "no intent yet"): the loser resolves to the
    // row the winner created — one logical identity, created exactly
    // once. Any other unique violation remains a genuine error.
    if (isIntentScopeUniqueViolation(error)) {
      intent = await db.client.checkoutIntent.findUniqueOrThrow({
        where: {
          scopeId_checkoutIntentId: {
            scopeId: scope.id,
            checkoutIntentId: payload.checkoutIntentId,
          },
        },
      });
    } else {
      throw error;
    }
  }
  // The logical event: exactly ONE row per logical intent (DB-enforced);
  // its deterministic VALUE is scope-qualified so two scopes can never
  // collide on it, and later submissions of the same intent correlate
  // to the SAME event row. Concurrent FIRST submissions race the insert
  // (unique intentId) — the loser resolves to the winner's row.
  const checkoutEventId = `CE-${scope.scopeId}-${payload.checkoutIntentId}`;
  let event: CheckoutEvent;
  try {
    event = await db.client.checkoutEvent.upsert({
      where: { intentId: intent.id },
      update: {},
      create: { checkoutEventId, intentId: intent.id, eventType: 'CHECKOUT_SUBMITTED' },
    });
  } catch (error) {
    if (isEventIntentUniqueViolation(error)) {
      event = await db.client.checkoutEvent.findUniqueOrThrow({
        where: { intentId: intent.id },
      });
    } else {
      throw error;
    }
  }
  // The physical attempt: caller-assigned requestAttemptId recorded
  // verbatim (never replaced); a repeated physical identity is a
  // contract conflict, distinct from a legitimate repeat submission.
  let requestAttemptRowId: string;
  try {
    const requestAttempt = await db.client.requestAttempt.create({
      data: { requestAttemptId: input.requestAttemptId, intentId: intent.id, eventId: event.id },
    });
    requestAttemptRowId = requestAttempt.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      isRequestAttemptIdentityConflict(error)
    ) {
      throw new CheckoutDomainError(
        'requestAttemptId was already recorded: one physical identity per request',
        409,
        'REQUEST_ATTEMPT_IDENTITY_CONFLICT',
      );
    }
    throw error;
  }
  // The target-assigned processing attempt with authoritative timing.
  const startSequence = await nextStartSequence(db);
  const attempt = await db.client.processingAttempt.create({
    data: {
      processingAttemptId: randomId('pa'),
      requestAttemptId: requestAttemptRowId,
      startSequence,
      processingModeUsed: mode,
      processingRevisionUsed: BigInt(configuration.processingRevision),
      targetInstanceIdUsed: configuration.targetInstanceId,
    },
  });

  // ---- The business core: mode-dependent reserve pipeline ----
  try {
    const result =
      mode === 'VULNERABLE'
        ? await reserveNaiveCheckThenAct(db, { intent, attemptId: attempt.id, payload })
        : await reserveIdempotentIntentScoped(db, { intent, attemptId: attempt.id, payload });
    await db.client.processingAttempt.update({
      where: { id: attempt.id },
      data: {
        finishedAt: new Date(),
        outcome:
          result.outcome === 'ACCEPTED'
            ? 'ACCEPTED'
            : result.outcome === 'INTENT_ALREADY_ACCEPTED'
              ? 'INTENT_ALREADY_ACCEPTED'
              : 'FAILED',
      },
    });
    // The intent's OWN scope relation is the scope/generation fact for
    // the response (identical for both processing modes; never derived
    // from anything but the stored foreign key). Re-read at response
    // time so the generation reported is the CURRENT durable one.
    const scopeRow = await db.client.verificationScope.findUniqueOrThrow({
      where: { id: intent.scopeId },
      select: { scopeId: true, generationId: true },
    });
    return {
      ...configuration,
      requestAttemptId: input.requestAttemptId,
      checkoutIntentId: payload.checkoutIntentId,
      checkoutEventId,
      processingAttemptId: attempt.processingAttemptId,
      scopeToken: scopeRow.scopeId,
      generationId: scopeRow.generationId,
      outcome: result.outcome,
      orderId: result.orderId,
      reservationId: result.reservationId,
    };
  } catch (error) {
    // Honest failure: record it, then surface a stable error. No
    // business mutation can have survived — the failed transaction
    // rolled back atomically.
    await db.client.processingAttempt
      .update({
        where: { id: attempt.id },
        data: {
          outcome: 'FAILED',
          finishedAt: new Date(),
          failureReason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

async function currentScope(
  db: { client: PrismaClient },
  sku: string,
): Promise<{ id: string; scopeId: string }> {
  const skuRow = await db.client.sku.findUnique({
    where: { sku },
    select: { scope: { select: { id: true, scopeId: true } } },
  });
  if (skuRow === null) {
    throw new CheckoutDomainError(
      'the requested SKU has no initialized scenario context (initialize through the target admin API first)',
      409,
      'SKU_NOT_INITIALIZED',
    );
  }
  return skuRow.scope;
}

/**
 * Monotonic start ordinal from a dedicated PostgreSQL sequence —
 * authoritative persisted ordering evidence for overlap analysis.
 */
async function nextStartSequence(db: { client: PrismaClient }): Promise<bigint> {
  const rows = (await db.client.$queryRaw`
    SELECT nextval('processing_attempt_start_seq')::bigint AS "seq"
  `) as ReadonlyArray<{ seq: bigint | number }>;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('start sequence returned no value');
  }
  return BigInt(row.seq);
}

function isRequestAttemptIdentityConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  const constraint = uniqueViolationConstraint(error);
  return (
    constraint.includes('request_attempts_requestAttemptId_key') ||
    constraint.includes('requestAttemptId')
  );
}

// ---------------------------------------------------------------------
// VULNERABLE pipeline — naive non-serialized check-then-reserve
// ---------------------------------------------------------------------

interface ReserveOutcome {
  readonly outcome: 'ACCEPTED' | 'INTENT_ALREADY_ACCEPTED' | 'STOCK_UNAVAILABLE';
  readonly orderId: string | null;
  readonly reservationId: string | null;
}

async function reserveNaiveCheckThenAct(
  db: { client: PrismaClient },
  input: {
    readonly intent: {
      id: string;
      checkoutIntentId: string;
      customerId: string;
      cartId: string;
      totalMinor: bigint;
      currency: string;
      sku: string;
    };
    readonly attemptId: string;
    readonly payload: SubmitCheckoutInput['payload'];
  },
): Promise<ReserveOutcome> {
  // Step 1: the naive CHECK — a READ COMMITTED read OUTSIDE any
  // transaction that could serialize it against the act below. This is
  // the entire bug: between this read and step 3's write, another
  // request can reserve the same last unit.
  const skuRow = await db.client.sku.findUniqueOrThrow({
    where: { sku: input.intent.sku },
    select: { id: true, remainingAvailableUnits: true },
  });
  // Step 2: the naive decision from the stale snapshot.
  if (skuRow.remainingAvailableUnits <= 0) {
    return { outcome: 'STOCK_UNAVAILABLE', orderId: null, reservationId: null };
  }
  // Step 3: the ACT — order + reservation + decrement, each committed
  // independently. PostgreSQL applies NO serialization between step 1's
  // read and this write, exactly like any ordinary naive
  // check-then-act code path. No artificial two-order code exists: two
  // genuinely overlapping submissions both pass step 2 and both commit.
  const orderId = randomId('ord');
  const reservationId = randomId('res');
  await db.client.$transaction(async (tx) => {
    // The reservation's `orderId` column is the FK to the order ROW; the
    // order's BUSINESS identity is `orderId` on the order row itself
    // (never collapsed — docs/checkout-zero.md §3).
    const orderRow = await tx.order.create({
      data: {
        orderId,
        intentId: input.intent.id,
        processingAttemptId: input.attemptId,
        customerId: input.intent.customerId,
        cartId: input.intent.cartId,
        orderTotalMinor: input.intent.totalMinor,
        currency: input.intent.currency,
        status: 'ACCEPTED',
      },
    });
    await tx.reservation.create({
      data: {
        reservationId,
        orderId: orderRow.id,
        sku: input.intent.sku,
        skuRowId: skuRow.id,
        reservedUnits: 1,
        status: 'ACCEPTED',
      },
    });
    // The decrement is UNCONDITIONAL — the check happened earlier
    // against a possibly-stale snapshot (the classic lost-update race).
    await tx.sku.update({
      where: { id: skuRow.id },
      data: { remainingAvailableUnits: { decrement: 1 } },
    });
  });
  return { outcome: 'ACCEPTED', orderId, reservationId };
}

// ---------------------------------------------------------------------
// SECURE pipeline — scoped-intent idempotency + conditional stock
// ---------------------------------------------------------------------

async function reserveIdempotentIntentScoped(
  db: { client: PrismaClient },
  input: {
    readonly intent: {
      id: string;
      checkoutIntentId: string;
      customerId: string;
      cartId: string;
      totalMinor: bigint;
      currency: string;
      sku: string;
    };
    readonly attemptId: string;
    readonly payload: SubmitCheckoutInput['payload'];
  },
): Promise<ReserveOutcome> {
  const orderId = randomId('ord');
  const reservationId = randomId('res');
  try {
    await db.client.$transaction(async (tx) => {
      // The DB-ENFORCED idempotency scope: one acceptance per logical
      // intent (checkoutIntentId is unique WITHIN the scope). The
      // conditional settlement UPDATE is this transaction's
      // serialization point: it takes the intent row lock, so a
      // concurrent duplicate of the SAME intent blocks here and — after
      // the winner commits — matches ZERO rows (the intent is already
      // SETTLED). Its transaction then rolls back COMPLETELY: no second
      // order, no second reservation, no second decrement. PostgreSQL's
      // default READ COMMITTED is sufficient — the row lock plus the
      // conditional predicate provide the correctness, not isolation-
      // level luck.
      await tx.checkoutIntent.update({
        where: { id: input.intent.id, status: { not: 'SETTLED' } },
        data: { status: 'SETTLED' },
      });
      // Conditional stock arithmetic: the unit is taken only if it is
      // actually there. The UPDATE re-checks availability atomically.
      const decremented = await tx.sku.updateMany({
        where: { sku: input.intent.sku, remainingAvailableUnits: { gt: 0 } },
        data: { remainingAvailableUnits: { decrement: 1 } },
      });
      if (decremented.count === 0) {
        // Nothing was consumed; surface the honest business outcome.
        throw new StockUnavailableSignal();
      }
      const skuRow = await tx.sku.findUniqueOrThrow({
        where: { sku: input.intent.sku },
        select: { id: true },
      });
      // Same discipline as the vulnerable path: the FK column carries
      // the order ROW id; the business orderId lives on the row.
      const orderRow = await tx.order.create({
        data: {
          orderId,
          intentId: input.intent.id,
          processingAttemptId: input.attemptId,
          customerId: input.intent.customerId,
          cartId: input.intent.cartId,
          orderTotalMinor: input.intent.totalMinor,
          currency: input.intent.currency,
          status: 'ACCEPTED',
        },
      });
      await tx.reservation.create({
        data: {
          reservationId,
          orderId: orderRow.id,
          sku: input.intent.sku,
          skuRowId: skuRow.id,
          reservedUnits: 1,
          status: 'ACCEPTED',
        },
      });
    });
    return { outcome: 'ACCEPTED', orderId, reservationId };
  } catch (error) {
    // A concurrent duplicate of the SAME logical intent: the
    // conditional settlement UPDATE above matched zero rows (P2025) or
    // lost the scoped-identity uniqueness race, and the pipeline
    // resolves honestly to INTENT_ALREADY_ACCEPTED — the duplicate's
    // transaction rolled back completely with NO second effect. Any
    // other failure remains a genuine error.
    if (isIntentAlreadySettled(error)) {
      return {
        outcome: 'INTENT_ALREADY_ACCEPTED',
        orderId: null,
        reservationId: null,
      };
    }
    if (error instanceof StockUnavailableSignal) {
      return {
        outcome: 'STOCK_UNAVAILABLE',
        orderId: null,
        reservationId: null,
      };
    }
    throw error;
  }
}

/** Internal control-flow signal (never leaked to the HTTP layer raw). */
class StockUnavailableSignal extends Error {
  public constructor() {
    super('stock unavailable');
    this.name = 'StockUnavailableSignal';
  }
}

/**
 * True when the failure is the conditional settlement update matching
 * ZERO rows (P2025: the logical intent is already SETTLED) or the
 * scoped intent-identity uniqueness race — in both cases the physical
 * submission is a duplicate of an already-accepted logical intent.
 */
function isIntentAlreadySettled(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  // P2025 (record not found for the conditional update) → the intent
  // is already SETTLED: an already-accepted logical intent, resolved
  // honestly — never a crash, never a second effect.
  if (error.code === 'P2025') {
    return true;
  }
  if (error.code !== 'P2002') {
    return false;
  }
  return uniqueViolationConstraint(error).includes('checkoutIntentId');
}

/** True when the failure is the scoped intent-identity uniqueness race. */
function isIntentScopeUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    uniqueViolationConstraint(error).includes('checkoutIntentId')
  );
}

/** True when the failure is the one-event-per-intent uniqueness race. */
function isEventIntentUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    uniqueViolationConstraint(error).includes('intentId')
  );
}

/**
 * The violated unique constraint identifier for ONE P2002 failure across
 * Prisma meta shapes: the classic `meta.target` (array or string) and
 * the Prisma 7 driver-adapter shape, which nests the PostgreSQL
 * constraint name under `meta.driverAdapterError.cause.constraint`.
 * The error MESSAGE always names the constraint and is the final
 * fallback, so detection never silently misses a uniqueness race.
 */
function uniqueViolationConstraint(error: Prisma.PrismaClientKnownRequestError): string {
  const meta = error.meta as
    | {
        target?: string[] | string;
        driverAdapterError?: { cause?: { constraint?: { index?: string } } };
      }
    | undefined;
  const target = meta?.target;
  if (Array.isArray(target)) {
    return target.join(',');
  }
  if (typeof target === 'string') {
    return target;
  }
  const index = meta?.driverAdapterError?.cause?.constraint?.index;
  if (typeof index === 'string') {
    return index;
  }
  return error.message;
}
