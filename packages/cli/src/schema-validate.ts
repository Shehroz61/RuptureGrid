// =====================================================================
// RuptureGrid v1.1 Phase 17 — report schema validation (ajv)
// =====================================================================
// Runtime self-check: EVERY emitted report is validated against the
// published rupturegrid-report/v1 JSON Schema before the file is
// written (§45: construct → validate → write; §41: a strongly
// centralized validation seam so the emitter cannot drift silently
// from the schema).
//
// ajv draft-07 is used because the schemas are authored as draft-07
// (`if/then`, `const`, `oneOf`), matching the repo's tooling surface.

import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { reportJsonSchema } from './schema-documents.js';

export class ReportSchemaValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`report failed rupturegrid-report/v1 schema validation:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ReportSchemaValidationError';
    this.issues = issues;
  }
}

let cachedValidate: ValidateFunction | null = null;

/**
 * RFC 3339 date-time (the same fast pattern the ajv-formats reference
 * implementation uses for `format: "date-time"`). Registered EXPLICITLY
 * so the format is genuinely validated — never silently ignored by the
 * validator (an unvalidated format is a false assurance).
 */
const DATE_TIME_FORMAT =
  /^\d\d\d\d-[0-1]\d-[0-3]\d[tT][0-2]\d:[0-5]\d:[0-5]\d(\.[0-9]+)?([zZ]|[+-][0-2]\d:[0-5]\d)$/;

function validator(): ValidateFunction {
  if (cachedValidate === null) {
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      formats: { 'date-time': DATE_TIME_FORMAT },
    });
    cachedValidate = ajv.compile(reportJsonSchema as object);
  }
  return cachedValidate;
}

/**
 * Validates a report object against the published schema. Throws
 * ReportSchemaValidationError with every issue when invalid.
 */
export function validateReportAgainstSchema(report: unknown): void {
  const validate = validator();
  const valid = validate(report);
  if (!valid) {
    const errors = validate.errors ?? [];
    const issues = errors.map(
      (error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`,
    );
    throw new ReportSchemaValidationError(issues);
  }
}
