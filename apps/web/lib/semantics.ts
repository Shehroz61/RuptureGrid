// =====================================================================
// RuptureGrid v1.0 — verdict / state semantics (Phase 6)
// =====================================================================
// One mapping from durable backend states to presentation labels.
// Color is NEVER the sole carrier: every badge pairs a text label with
// its semantic tint. INDETERMINATE and NOT_EVALUABLE are first-class
// uncertain states — never smoothed into success/failure (ADR-0008,
// evidence-model §7). All values here come from the backend enums.

import type { RunState } from './api-client';

export type SemanticClass = 'fail' | 'pass' | 'uncertain' | 'running' | 'neutral';

export function runStateClass(state: RunState): SemanticClass {
  switch (state) {
    case 'COMPLETED':
      return 'pass';
    case 'FAILED':
      return 'fail';
    case 'CANCELLED':
      return 'neutral';
    case 'RUNNING':
    case 'DISPATCHING':
    case 'RECONCILING':
      return 'running';
    case 'CREATED':
    case 'SNAPSHOT_PINNED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function verdictClass(verdict: string): SemanticClass {
  switch (verdict) {
    case 'FAIL':
      return 'fail';
    case 'PASS':
      return 'pass';
    case 'NOT_EVALUABLE':
      return 'uncertain';
    default:
      return 'neutral';
  }
}

export function knowledgeClass(knowledge: string | null): SemanticClass {
  switch (knowledge) {
    case 'KNOWN_OCCURRED':
      return 'pass';
    case 'KNOWN_ABSENT':
      return 'neutral';
    case 'INDETERMINATE':
      return 'uncertain';
    case 'NOT_APPLICABLE':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function stepStateClass(state: string): SemanticClass {
  switch (state) {
    case 'SUCCEEDED':
      return 'pass';
    case 'FAILED':
      return 'fail';
    case 'CANCELLED':
      return 'neutral';
    case 'PENDING':
    case 'DISPATCHED':
      return 'neutral';
    case 'CLAIMED':
    case 'EXECUTING':
      return 'running';
    default:
      return 'neutral';
  }
}

export function orderingBasisLabel(basis: string): string {
  switch (basis) {
    case 'sequence':
      return 'sequence';
    case 'wall_clock':
      return 'wall-clock';
    case 'unordered_overlap':
      return 'unordered / overlapping';
    default:
      return basis;
  }
}

export function timeMeaningLabel(meaning: string): string {
  switch (meaning) {
    case 'execution':
      return 'execution time';
    case 'observedAt':
      return 'observed at';
    case 'derivedAt':
      return 'derived at';
    default:
      return meaning;
  }
}

/** Formats an integer minor-unit amount with its currency (ADR-0004):
 *  renders FROM the integer; never parses floats. */
export function formatMinorUnits(amountMinor: string | number, currency: string): string {
  const minor = typeof amountMinor === 'number' ? amountMinor.toString() : amountMinor;
  if (!/^\d+$/.test(minor)) {
    return `${minor} ${currency} (raw)`;
  }
  const major = minor.slice(0, -2);
  const fraction = minor.slice(-2).padStart(2, '0');
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped === '' ? '0' : grouped}.${fraction}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toISOString().replace('T', ' ').replace('Z', ' Z');
}

export function formatDuration(startedAt: string, endedAt: string | null): string | null {
  if (endedAt === null) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  const seconds = (end - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Truncates a long identifier for table cells; the full value is
 *  always available via title/expandable detail (product-design §6). */
export function shortenId(id: string, keep = 8): string {
  if (id.length <= keep * 2 + 3) {
    return id;
  }
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
