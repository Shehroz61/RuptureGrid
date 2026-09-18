// RuptureGrid v1.0 — semantic badge (Phase 6).
// Pairs a text label with a semantic tint; state is never color-alone.

import type { SemanticClass } from '@/lib/semantics';

export function Badge({
  label,
  semantic,
  mono = false,
}: {
  readonly label: string;
  readonly semantic: SemanticClass;
  readonly mono?: boolean;
}) {
  return <span className={`badge badge-${semantic}${mono ? ' badge-mono' : ''}`}>{label}</span>;
}
