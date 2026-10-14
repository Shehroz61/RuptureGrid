// =====================================================================
// RuptureGrid v1.1 Phase 17 — rupturegrid-scenario/v1 JSON Schema
// =====================================================================
// The PUBLISHED JSON Schema for the closed scenario-document contract
// (packages/cli/src/scenario.ts is the authoritative implementation
// validator; this schema documents and additionally enforces the same
// closed shape for external authors and editors).
//
// Closed-schema discipline: every object in the scenario is closed
// ("additionalProperties": false) EXCEPT the embedded experiment
// envelope's `steps`/`invariantBindings` arrays, whose ELEMENTS are
// owned by the existing accepted experiment vocabulary (validated
// authoritatively by @rupturegrid/engine validateExperimentDocument —
// this schema deliberately does NOT re-describe that vocabulary, so
// the two can never drift apart).

export const scenarioJsonSchema: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://rupturegrid.dev/schemas/rupturegrid-scenario-v1.schema.json',
  title: 'rupturegrid-scenario/v1',
  description:
    'RuptureGrid v1.1 scenario document (Phase 17, ADR-0019): pure data binding the accepted experiment vocabulary to a stable target selector, with optional acceptance EXPECTATIONS that never influence evaluation or exit classification.',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'name', 'description', 'target', 'experiment'],
  properties: {
    schemaVersion: { const: 'rupturegrid-scenario/v1' },
    name: { type: 'string', minLength: 3, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['displayName'],
      description:
        'Stable, portable target selector. displayName is a USER-FACING lookup convenience ONLY (registration makes it unique) — NEVER a security principal. The resolved registration (id, origins, environment, manifest, credential refs, platform authorization) remains authoritative; no scenario field grants target authority.',
      properties: {
        displayName: { type: 'string', minLength: 3, maxLength: 120 },
      },
    },
    experiment: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        steps: {
          description:
            'The EXISTING accepted ExperimentDocument step vocabulary (validated authoritatively by @rupturegrid/engine). Not re-described here.',
          type: 'array',
          minItems: 1,
          items: { type: 'object' },
        },
        invariantBindings: {
          description:
            'Optional business-invariant/v1 instances (ADR-0018/ADR-0023 §6 exact schemas). Validated authoritatively against the target manifest evidence policy by @rupturegrid/engine.',
          type: 'array',
          minItems: 1,
          items: { type: 'object' },
        },
        runScope: {
          description:
            'Optional run-scope/v1 anchor intent (ADR-0026 §3 closed declaration). Validated authoritatively against the frozen steps, generic bindings, and evidence policy by @rupturegrid/engine; frozen into target.runScopeBinding and covered by snapshotContentHash.',
          type: 'object',
        },
      },
    },
    expectations: {
      type: 'object',
      additionalProperties: false,
      description:
        'Acceptance expectations for committed regression assertions (Phase 18 consumption). They NEVER influence evaluation, findings, report truth, or exit classification — durable truth alone decides.',
      properties: {
        exitClass: {
          type: 'string',
          enum: ['PASS', 'INVARIANT_FAIL', 'NOT_EVALUABLE', 'EXECUTION_FAILURE', 'USAGE_ERROR'],
        },
        invariantVerdicts: {
          type: 'object',
          additionalProperties: {
            type: 'string',
            enum: ['PASS', 'FAIL', 'NOT_EVALUABLE'],
          },
        },
      },
    },
  },
} as const;
