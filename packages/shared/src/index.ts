// =====================================================================
// RuptureGrid v1.0 — shared service identities and constants
// =====================================================================
// Cross-cutting, non-domain primitives only (AGENTS R-05; Phase 1
// non-scope §6). Domain types (Wallet, ExperimentRun, Evidence, …)
// deliberately DO NOT live here.

/** Canonical service names used in structured logs and health metadata. */
export const SERVICE_NAMES = {
  api: 'rupturegrid-api',
  worker: 'rupturegrid-worker',
  web: 'rupturegrid-web',
  demoFintech: 'demo-fintech',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/** The Phase 1 foundation smoke queue (BullMQ). */
export const FOUNDATION_QUEUE_NAME = 'foundation-smoke';

/**
 * Default BullMQ key prefix. Every queue participant (Queue, Worker,
 * QueueEvents) must use the same prefix or they will not see each
 * other's keys.
 */
export const DEFAULT_QUEUE_PREFIX = 'rupturegrid';

/**
 * Money is always an integer amount of minor units (paisa for PKR) with
 * an explicit currency code — never a float (AGENTS R-06, ADR-0004).
 * Phase 1 establishes the type contract; business logic arrives later.
 */
export type CurrencyCode = 'PKR';

export interface MoneyMinorUnits {
  /** Integer amount in the currency's minor unit. Never a float. */
  readonly amountMinorUnits: number;
  readonly currency: CurrencyCode;
}

export { isSensitiveKey, maskSensitiveFields, maskValue, redactUrlPassword } from './redact.js';
