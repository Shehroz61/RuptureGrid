// =====================================================================
// RuptureGrid v1.0 — controlled-faults assertions (Phase 9)
// =====================================================================
// Every assertion reads DURABLE Control-Plane truth: engine rows,
// raw/normalized evidence, invariant evaluations, timeline entries,
// reproduction definitions, and target-authored fault-status
// observations. A fault is "activated" ONLY when the target's OWN
// captured accounting shows budget consumption — never inferred from
// error shapes. Configured and activated remain separate facts.

import type { PrismaClient } from '@rupturegrid/control-db';

export interface AssertionResult {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

export function assertEq(name: string, expected: unknown, actual: unknown): AssertionResult {
  const pass = expected === actual;
  return {
    name,
    expected: String(expected),
    actual: String(actual),
    pass,
  };
}

/** Latest target-authored fault-status observation captured by the run. */
export async function runFaultStatusObservation(
  prisma: PrismaClient,
  runId: string,
): Promise<{ plans: Array<Record<string, unknown>> } | null> {
  const rows = await prisma.rawObservation.findMany({
    where: { runId, kind: 'target_observation', adapterKind: 'demo-fintech-fault-status' },
    orderBy: { chainIndex: 'desc' },
    take: 1,
  });
  const payload = rows[0]?.payload as { plans?: Array<Record<string, unknown>> } | undefined;
  if (payload === undefined || !Array.isArray(payload.plans)) {
    return null;
  }
  return { plans: payload.plans };
}

export async function faultPlanFromRunObservation(
  prisma: PrismaClient,
  runId: string,
  faultKind: string,
): Promise<Record<string, unknown> | null> {
  const status = await runFaultStatusObservation(prisma, runId);
  return status?.plans.find((plan) => plan['faultKind'] === faultKind) ?? null;
}

/** Assertions shared by both scenarios. */
export async function commonAssertions(
  prisma: PrismaClient,
  runId: string,
  faultKind: string,
  expectedTriggersUsed: number,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  // Target-authored configured/activated facts (separate, from the SAME
  // observation): configured = the plan is reported armed; activated =
  // triggersUsed equals the consumed budget.
  const plan = await faultPlanFromRunObservation(prisma, runId, faultKind);
  results.push(assertEq(`target-observed.plan-armed(${faultKind})`, true, plan !== null));
  if (plan !== null) {
    results.push(
      assertEq('target-observed.triggersUsed', expectedTriggersUsed, plan['triggersUsed']),
      assertEq('target-observed.maxTriggers', 1, plan['maxTriggers']),
    );
  }

  // Timeline: CONFIGURED and ACTIVATED are separate entries, derived
  // only from the target's own captured state.
  const configured = await prisma.forensicTimelineEntry.count({
    where: { runId, entryKind: 'FAULT_PLAN_CONFIGURED' },
  });
  const activated = await prisma.forensicTimelineEntry.count({
    where: { runId, entryKind: 'FAULT_PLAN_ACTIVATED' },
  });
  results.push(
    assertEq('timeline.fault-plan-configured>=1', true, configured >= 1),
    assertEq('timeline.fault-plan-activated>=1', true, activated >= 1),
  );

  // Evidence chain integrity (hash chain + provenance).
  const { verifyRunEvidenceChain } = await import('@rupturegrid/evidence');
  const integrity = await verifyRunEvidenceChain(prisma, runId);
  results.push(assertEq('evidence.chain-valid', true, integrity.chainValid));

  // Reproduction: the frozen fault intent carries the typed plan.
  const reproduction = await prisma.reproductionDefinition.findUnique({
    where: { runId },
    select: { faultIntent: true },
  });
  const faultIntent = reproduction?.faultIntent as
    { steps?: Array<{ faultKind?: string; maxTriggers?: number }> } | null | undefined;
  const frozenStep = Array.isArray(faultIntent?.steps)
    ? faultIntent.steps.find((step) => step['faultKind'] === faultKind)
    : undefined;
  results.push(assertEq('reproduction.fault-intent-frozen', true, frozenStep !== undefined));
  if (frozenStep !== undefined) {
    results.push(assertEq('reproduction.maxTriggers', 1, frozenStep['maxTriggers']));
  }

  return results;
}

/** PRE_MUTATION_REJECTION scenario assertions. */
export async function preMutationAssertions(
  prisma: PrismaClient,
  runId: string,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  // The run terminally FAILED (definitive contract rejection under the
  // accepted ordered-dependency policy).
  const run = await prisma.experimentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { state: true },
  });
  results.push(assertEq('run.state', 'FAILED', run.state));

  // The fault-bearing step: KNOWN_ABSENT (definitive 4xx under the Demo
  // contract proves no effect), exactly ONE network attempt (one-shot
  // budget; no retry), terminal FAILED.
  const steps = await prisma.experimentStepRun.findMany({
    where: { runId },
    orderBy: { sequence: 'asc' },
  });
  const faultStep = steps.find((step) => step.state === 'FAILED');
  results.push(assertEq('fault-step.exists', true, faultStep !== undefined));
  if (faultStep !== undefined) {
    results.push(
      assertEq('fault-step.sideEffectKnowledge', 'KNOWN_ABSENT', faultStep.sideEffectKnowledge),
      assertEq('fault-step.attemptCount', 1, faultStep.attemptCount),
      assertEq('fault-step.intentOutcome', 'FAILED', faultStep.intentOutcome),
    );
    // Invocation-level: the same single attempt, KNOWN_ABSENT, no retry.
    const invocations = await prisma.stepInvocation.findMany({
      where: { stepRunId: faultStep.id },
      orderBy: { sequence: 'asc' },
    });
    results.push(
      assertEq('invocation.count', 1, invocations.length),
      assertEq(
        'invocation.sideEffectKnowledge',
        'KNOWN_ABSENT',
        invocations[0]?.sideEffectKnowledge,
      ),
    );
  }

  // The eventual intended business effect (the retried attempt never
  // happened here because the scenario does not declare SAFE retry):
  // the run stops at the fault step, so exactly ZERO effects exist.
  const stepsAfterFault = steps
    .filter((step) => faultStep !== undefined && step.sequence > faultStep.sequence)
    .map((step) => step.state);
  results.push(
    assertEq(
      'ordered-dependency.no-further-delivery',
      true,
      stepsAfterFault.every((state) => state === 'CANCELLED' || state === 'PENDING'),
    ),
  );

  // New invariant evaluations must exist and none may be a fake Finding.
  const evaluations = await prisma.invariantEvaluation.findMany({ where: { runId } });
  results.push(assertEq('analysis.evaluations>=1', true, evaluations.length >= 1));
  const findings = await prisma.finding.count({ where: { runId } });
  results.push(assertEq('analysis.finding-count', 0, findings));

  results.push(...(await commonAssertions(prisma, runId, 'PRE_MUTATION_REJECTION', 1)));
  return results;
}

/** POST_MUTATION response-loss scenario assertions. */
export async function responseLossAssertions(
  prisma: PrismaClient,
  runId: string,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  const run = await prisma.experimentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { state: true },
  });
  results.push(assertEq('run.state', 'FAILED', run.state));

  const steps = await prisma.experimentStepRun.findMany({
    where: { runId },
    orderBy: { sequence: 'asc' },
  });
  const faultStep = steps.find((step) => step.state === 'FAILED');
  results.push(assertEq('fault-step.exists', true, faultStep !== undefined));
  if (faultStep !== undefined) {
    // Sent ⇒ response lost ⇒ INDETERMINATE at step AND invocation level;
    // exactly ONE attempt (automatic retries = 0; never collapsed).
    results.push(
      assertEq('fault-step.sideEffectKnowledge', 'INDETERMINATE', faultStep.sideEffectKnowledge),
      assertEq('fault-step.attemptCount', 1, faultStep.attemptCount),
    );
    const invocations = await prisma.stepInvocation.findMany({
      where: { stepRunId: faultStep.id },
      orderBy: { sequence: 'asc' },
    });
    results.push(
      assertEq('invocation.count', 1, invocations.length),
      assertEq(
        'invocation.sideEffectKnowledge',
        'INDETERMINATE',
        invocations[0]?.sideEffectKnowledge,
      ),
      assertEq('invocation.httpStatus', 'null', String(invocations[0]?.httpStatus)),
    );
  }

  // The mutation objectively committed: the run's OWN captured lineage
  // evidence shows exactly one accepted financial effect (later
  // inspection is separate evidence and never rewrote the invocation).
  const effectEvents = await prisma.normalizedEvent.findMany({
    where: { runId, eventType: 'demo.financial-effect-observed' },
  });
  results.push(assertEq('target-inspection.accepted-effects', 1, effectEvents.length));

  // INV-DF-1/INV-DF-2 evaluate PASS over the committed truth; the
  // canonical duplicate-credit Finding count stays 0.
  const dfEvaluations = await prisma.invariantEvaluation.findMany({
    where: { runId, invariantKey: { in: ['INV-DF-1', 'INV-DF-2'] } },
  });
  results.push(assertEq('analysis.inv-df-evaluations>=2', true, dfEvaluations.length >= 2));
  for (const evaluation of dfEvaluations) {
    results.push(
      assertEq(`analysis.${evaluation.invariantKey}.verdict`, 'PASS', evaluation.verdict),
    );
  }
  // INV-IZ-1 stays authoritative for duplicate-credit correctness and
  // must be UNCHANGED in kind by Phase 9: a single legitimate credit can
  // only PASS or NOT_EVALUABLE — never FAIL — for the response-loss run.
  const iz1Evaluations = await prisma.invariantEvaluation.findMany({
    where: { runId, invariantKey: 'INV-IZ-1' },
  });
  for (const evaluation of iz1Evaluations) {
    results.push(
      assertEq(
        'analysis.INV-IZ-1.not-a-duplicate-credit-failure',
        true,
        evaluation.verdict !== 'FAIL',
      ),
    );
  }
  const findings = await prisma.finding.count({ where: { runId } });
  results.push(assertEq('analysis.finding-count', 0, findings));

  // The invocation-level knowledge was NEVER retro-changed by later
  // inspection: still INDETERMINATE in the durable engine rows.
  results.push(
    assertEq(
      'invocation.knowledge-not-retroactively-changed',
      'INDETERMINATE',
      faultStep !== undefined
        ? ((
            await prisma.stepInvocation.findFirst({
              where: { stepRunId: faultStep.id },
              orderBy: { sequence: 'desc' },
            })
          )?.sideEffectKnowledge ?? 'missing')
        : 'missing',
    ),
  );

  results.push(...(await commonAssertions(prisma, runId, 'RESPONSE_TRUNCATION', 1)));
  return results;
}
