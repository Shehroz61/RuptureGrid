// =====================================================================
// RuptureGrid v1.1 Phase 17 — schema documents (runtime re-export)
// =====================================================================
// Single source module so both the emitter (schema-emit.ts), the
// validator (schema-validate.ts), and the tests import the SAME
// objects. The authored schema literals live in report-schema.ts and
// scenario-schema.ts.

import { reportJsonSchema as reportSchema } from './report-schema.js';
import { scenarioJsonSchema as scenarioSchema } from './scenario-schema.js';

export const reportJsonSchema = reportSchema;
export const scenarioJsonSchema = scenarioSchema;

export const REPORT_SCHEMA_FILE = 'rupturegrid-report-v1.schema.json';
export const SCENARIO_SCHEMA_FILE = 'rupturegrid-scenario-v1.schema.json';
