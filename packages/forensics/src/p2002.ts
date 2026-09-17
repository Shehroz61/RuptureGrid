// =====================================================================
// RuptureGrid v1.0 — precise P2002 unique-constraint matching (§70)
// =====================================================================
// Shared by every Phase 5 persistence path. Idempotent convergence is
// enforced at the DATABASE level, and a P2002 is swallowed ONLY when it
// provably belongs to the intended unique constraint — never
// generically:
//
//   - Prisma's classic shape: `meta.target` = the constraint's field
//     list (e.g. ['invariantEvaluationId', 'findingRuleVersion']).
//   - Prisma 7 + driver-adapter shape: no `target`; the underlying pg
//     error carries `meta.driverAdapterError.cause.constraint.index` =
//     the DATABASE constraint name as created by the migration DDL
//     (PostgreSQL truncates identifiers to 63 chars, so the exact DDL
//     string — including any truncation — is what must be compared).
//
// A P2002 from ANY OTHER constraint propagates as a genuine failure;
// an unrelated unique violation is never misread as convergence.

export function isUniqueConstraint(
  error: unknown,
  constraintFields: readonly string[],
  ddlIndexName: string,
): boolean {
  // Null-safe: this matcher runs inside catch handlers — it must never
  // throw and mask the original failure.
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code !== 'P2002') {
    return false;
  }
  const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};

  // Matcher 1: classic field-list target.
  const target = meta['target'];
  if (Array.isArray(target)) {
    const normalized = target
      .map((field) =>
        typeof field === 'string' ? field.toLowerCase() : String(field).toLowerCase(),
      )
      .sort();
    const expected = [...constraintFields].map((field) => field.toLowerCase()).sort();
    if (
      normalized.length === expected.length &&
      normalized.every((field, index) => field === expected[index])
    ) {
      return true;
    }
  }

  // Matcher 2: driver-adapter constraint name (exact DDL identifier).
  const adapterError = meta['driverAdapterError'] as
    { cause?: { constraint?: { index?: unknown } } } | undefined;
  const indexName = adapterError?.cause?.constraint?.index;
  if (typeof indexName === 'string') {
    return indexName.toLowerCase() === ddlIndexName.toLowerCase();
  }
  return false;
}
