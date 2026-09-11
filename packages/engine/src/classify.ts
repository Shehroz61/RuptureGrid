// =====================================================================
// RuptureGrid v1.0 — side-effect knowledge classification (§7.1)
// =====================================================================
// Classification is a PURE function of (transport stage reached,
// intent outcome, mutation declaration, target contract) — never of
// optimism. The accepted table (architecture §7.1):
//
// | Situation                                   | intent    | sideEffectKnowledge |
// |---------------------------------------------|-----------|---------------------|
// | sent, definitive success response           | SUCCEEDED | KNOWN_OCCURRED      |
// | definitive 4xx/5xx per contract w/ no-effect guarantee | FAILED | KNOWN_ABSENT |
// | definitive 4xx/5xx without such a contract  | FAILED    | INDETERMINATE       |
// | connection refused / DNS / TLS BEFORE send  | FAILED    | KNOWN_ABSENT       |
// | timeout or reset AFTER send                 | FAILED    | INDETERMINATE      |
// | cancelled before dispatch                   | CANCELLED | KNOWN_ABSENT       |
// | cancelled mid-flight, mutating in flight    | CANCELLED | INDETERMINATE      |
//
// INDETERMINATE is persisted and displayed — never laundered into a
// success-looking status (ADR-0008).

import type { ContractKind } from './target.js';

export type IntentOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type SideEffectKnowledge =
  'KNOWN_OCCURRED' | 'KNOWN_ABSENT' | 'INDETERMINATE' | 'NOT_APPLICABLE';

export type TransportStage =
  'PREPARED' | 'CONNECTING' | 'REQUEST_SENT' | 'RESPONSE_HEADERS' | 'RESPONSE_COMPLETE';

const STAGE_ORDER: readonly TransportStage[] = [
  'PREPARED',
  'CONNECTING',
  'REQUEST_SENT',
  'RESPONSE_HEADERS',
  'RESPONSE_COMPLETE',
];

export function stageReached(actual: string | null): boolean {
  if (actual === null) {
    return false;
  }
  return STAGE_ORDER.includes(actual as TransportStage);
}

export function stageAtLeast(actual: string | null, stage: TransportStage): boolean {
  if (actual === null) {
    return false;
  }
  return STAGE_ORDER.indexOf(actual as TransportStage) >= STAGE_ORDER.indexOf(stage);
}

export interface ClassifyInput {
  readonly mutation: 'READ_ONLY' | 'MUTATING';
  readonly contractKind: ContractKind;
  /** Furthest transport stage the invocation reached (null = never started). */
  readonly transportStage: string | null;
  readonly intentOutcome: IntentOutcome;
  readonly httpStatus: number | null;
}

export interface ClassifyResult {
  readonly intentOutcome: IntentOutcome;
  readonly sideEffectKnowledge: SideEffectKnowledge;
}

/**
 * Contracts whose definitive 4xx responses guarantee no side effect
 * (§27: "a definitive target rejection with a contract guaranteeing no
 * effect"). The Demo Fintech webhook contract validates BEFORE any
 * business resolution and guarantees zero financial effect on its
 * definitive transport rejections (Phase 2 contract §56).
 */
const NO_EFFECT_4XX_CONTRACTS: ReadonlySet<string> = new Set(['DEMO_FINTECH_WEBHOOK']);

/**
 * Classifies side-effect knowledge for one invocation. Pure.
 */
export function classifyInvocation(input: ClassifyInput): ClassifyResult {
  const { mutation, contractKind, transportStage, httpStatus } = input;
  if (mutation === 'READ_ONLY') {
    return {
      intentOutcome: input.intentOutcome,
      sideEffectKnowledge: 'NOT_APPLICABLE',
    };
  }

  const sent = stageAtLeast(transportStage, 'REQUEST_SENT');

  if (input.intentOutcome === 'SUCCEEDED') {
    // A definitive 2xx on a mutating action, per contract.
    return { intentOutcome: 'SUCCEEDED', sideEffectKnowledge: 'KNOWN_OCCURRED' };
  }

  if (input.intentOutcome === 'CANCELLED') {
    return {
      intentOutcome: 'CANCELLED',
      sideEffectKnowledge: sent ? 'INDETERMINATE' : 'KNOWN_ABSENT',
    };
  }

  // intentOutcome === 'FAILED'
  if (!sent) {
    // Provable pre-send failure (connection refused, DNS, TLS,
    // validation, size cap, timeout before the request was sent).
    return { intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' };
  }
  if (
    httpStatus !== null &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    NO_EFFECT_4XX_CONTRACTS.has(contractKind)
  ) {
    // Definitive rejection under a contract that guarantees no effect.
    return { intentOutcome: 'FAILED', sideEffectKnowledge: 'KNOWN_ABSENT' };
  }
  // Post-send ambiguity (timeout after send, connection reset after
  // send, crash mid-request, 5xx without a no-effect contract).
  return { intentOutcome: 'FAILED', sideEffectKnowledge: 'INDETERMINATE' };
}

export interface RetryDecisionInput {
  readonly declaredPolicy: 'NONE' | 'SAFE';
  readonly mutation: 'READ_ONLY' | 'MUTATING';
  readonly sideEffectKnowledge: SideEffectKnowledge;
  readonly intentOutcome: IntentOutcome;
  /** Attempts already consumed (including the first). */
  readonly attemptsSoFar: number;
  readonly maxAttempts: number;
}

export interface RetryDecision {
  readonly willRetry: boolean;
  readonly reason: string;
}

/**
 * Executor retry policy (§7.2) — conservative by construction:
 *   - declared NONE → never retry
 *   - INDETERMINATE mutating outcome → NEVER auto-retry (ADR-0008)
 *   - SAFE + KNOWN_ABSENT failure → retry within budget
 *   - SAFE + read-only transient failure → retry within budget
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (input.attemptsSoFar >= input.maxAttempts) {
    return { willRetry: false, reason: 'retry budget exhausted' };
  }
  if (input.declaredPolicy === 'NONE') {
    return { willRetry: false, reason: 'declared policy NONE' };
  }
  if (input.mutation === 'MUTATING' && input.sideEffectKnowledge === 'INDETERMINATE') {
    return {
      willRetry: false,
      reason: 'INDETERMINATE mutating outcome is never auto-retried (ADR-0008)',
    };
  }
  if (input.intentOutcome === 'FAILED' && input.sideEffectKnowledge === 'KNOWN_ABSENT') {
    return { willRetry: true, reason: 'safe retry: provably not sent' };
  }
  if (input.mutation === 'READ_ONLY' && input.intentOutcome === 'FAILED') {
    return { willRetry: true, reason: 'safe retry: read-only transient failure' };
  }
  return { willRetry: false, reason: 'no retry condition met' };
}

export const SAFE_RETRY_MAX_ATTEMPTS = 3;
