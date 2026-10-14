// =====================================================================
// RuptureGrid v1.1 Phase 17 — rupturegrid-report/v1 JSON Schemas
// =====================================================================
// The PUBLISHED JSON Schema for the machine-readable report envelope
// (ADR-0019 §3). Path: packages/cli/schemas/rupturegrid-report-v1.schema.json
// — an obvious, stable repository path; the schema is NOT draft/internal
// after acceptance. The schema enforces:
//   - required core fields (no null-vs-missing ambiguity on truth),
//   - closed enums (verdicts, exit classes, side-effect knowledge),
//   - hash formats (SHA-256 hex) and integer/non-negative counts,
//   - exit code/class consistency as far as JSON Schema can express,
//   - ADDITIVE EVOLUTION (§40): no "additionalProperties": false at the
//     top level or inside future-extensible objects — consumers must
//     ignore unknown fields, and a future additive property must never
//     invalidate an otherwise-valid v1 report. Closed enums guard the
//     closed vocabularies instead.
// A breaking change mints rupturegrid-report/v2 (NOT created here).
export const reportJsonSchema: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://rupturegrid.dev/schemas/rupturegrid-report-v1.schema.json',
  title: 'rupturegrid-report/v1',
  description:
    'RuptureGrid v1.1 machine-readable report (ADR-0019 §3): a serialization of durable Control-Plane truth — never a new truth engine. Additive-only evolution: consumers must ignore unknown fields.',
  type: 'object',
  required: [
    'schemaVersion',
    'reportId',
    'generatedAt',
    'tool',
    'target',
    'run',
    'sideEffectSummary',
    'evidenceIntegrity',
    'invariantEvaluations',
    'findings',
    'reproductionReference',
    'exit',
  ],
  // Deliberately NOT closed (additive evolution): unknown fields are
  // allowed and must be ignored by consumers.
  properties: {
    schemaVersion: { const: 'rupturegrid-report/v1' },
    reportId: { type: 'string', minLength: 1, maxLength: 64 },
    generatedAt: { type: 'string', format: 'date-time' },
    tool: {
      type: 'object',
      required: ['name', 'version'],
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
        // Additive tool metadata allowed.
      },
    },
    target: {
      type: 'object',
      required: ['targetId', 'displayName', 'environment', 'origins'],
      properties: {
        targetId: { type: 'string', minLength: 1 },
        displayName: { type: 'string', minLength: 1 },
        environment: { type: 'string', enum: ['LOCAL_DEVELOPMENT', 'STAGING', 'PRODUCTION'] },
        // Sorted normalized origins (deterministic ordering, §38).
        origins: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', pattern: '^(http|https)://[^\\s]+$' },
        },
      },
    },
    run: {
      type: 'object',
      required: [
        'runId',
        'experimentName',
        'experimentDefinitionId',
        'revisionId',
        'revisionNumber',
        'snapshotId',
        'snapshotContentHash',
        'terminalState',
        'engineVersion',
      ],
      properties: {
        runId: { type: 'string', minLength: 1 },
        experimentName: { type: 'string', minLength: 1 },
        experimentDefinitionId: { type: 'string', minLength: 1 },
        revisionId: { type: 'string', minLength: 1 },
        revisionNumber: { type: 'integer', minimum: 1 },
        snapshotId: { type: 'string', minLength: 1 },
        snapshotContentHash: { $ref: '#/definitions/sha256Hex' },
        terminalState: {
          type: 'string',
          enum: [
            'CREATED',
            'SNAPSHOT_PINNED',
            'DISPATCHING',
            'RUNNING',
            'RECONCILING',
            'COMPLETED',
            'FAILED',
            'CANCELLED',
          ],
        },
        engineVersion: { type: 'string', minLength: 1 },
        normalizerVersions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'version'],
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
            },
          },
        },
        invariantEvaluatorVersions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['invariantKey', 'evaluatorVersion'],
            properties: {
              invariantKey: { type: 'string' },
              evaluatorVersion: { type: 'string' },
            },
          },
        },
      },
    },
    // Side-effect knowledge summary counts (§36): honest INDETERMINATE
    // counts are first-class (never laundered).
    sideEffectSummary: {
      type: 'object',
      required: ['KNOWN_OCCURRED', 'KNOWN_ABSENT', 'INDETERMINATE', 'NOT_APPLICABLE'],
      properties: {
        KNOWN_OCCURRED: { type: 'integer', minimum: 0 },
        KNOWN_ABSENT: { type: 'integer', minimum: 0 },
        INDETERMINATE: { type: 'integer', minimum: 0 },
        NOT_APPLICABLE: { type: 'integer', minimum: 0 },
      },
    },
    evidenceIntegrity: {
      type: 'object',
      required: ['verified', 'chainHeadHash', 'observationCount'],
      properties: {
        verified: { type: 'boolean' },
        // Null only when the run recorded no evidence at all (honest
        // absence — never conflated with verified).
        chainHeadHash: {
          oneOf: [{ $ref: '#/definitions/sha256Hex' }, { type: 'null' }],
        },
        observationCount: { type: 'integer', minimum: 0 },
        problems: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'detail'],
            properties: {
              chainIndex: { type: 'integer', minimum: 0 },
              kind: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
    invariantEvaluations: {
      type: 'array',
      // Deterministically ordered (by invariant key, then subject) by
      // the emitter; ordering itself is not expressible in JSON Schema.
      items: {
        type: 'object',
        required: [
          'invariantKey',
          'evaluatorVersion',
          'subjectKey',
          'verdict',
          'reason',
          'evidenceSetHash',
        ],
        properties: {
          invariantKey: { type: 'string', minLength: 1 },
          evaluatorVersion: { type: 'string', minLength: 1 },
          subjectKey: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_EVALUABLE'] },
          reason: { type: 'string', maxLength: 500 },
          evidenceSetHash: { $ref: '#/definitions/sha256Hex' },
          // Additive (ADR-0026 §16): the key's authoritative publication
          // mode label (`strict-coverage/v1` or `legacy-compat`).
          mode: { type: ['string', 'null'] },
          details: { type: 'object' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'findingId',
          'invariantKey',
          'reasonCode',
          'subjectKey',
          'title',
          'summary',
          'proofReferences',
          'provenScope',
          'uncertainScope',
        ],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          invariantEvaluationId: { type: 'string', minLength: 1 },
          invariantKey: { type: 'string', minLength: 1 },
          evaluatorVersion: { type: 'string', minLength: 1 },
          findingRuleVersion: { type: 'string', minLength: 1 },
          reasonCode: { type: 'string', minLength: 1 },
          subjectKey: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 200 },
          summary: { type: 'string', maxLength: 500 },
          proofReferences: {
            type: 'array',
            items: {
              type: 'object',
              required: ['subject', 'sourceId', 'role'],
              properties: {
                subject: { type: 'string' },
                sourceId: { type: 'string' },
                role: { type: 'string' },
                position: { type: 'integer', minimum: 1 },
              },
            },
          },
          provenScope: { type: 'object' },
          uncertainScope: { type: 'object' },
          details: { type: 'object' },
        },
      },
    },
    // Reproduction reference (ADR-0019 §3): the durable
    // ReproductionDefinition binding — id, snapshot hash, and the
    // run's own acceptance expectations. Reference NAMES only (never
    // credential values — ADR-0012). Phase 18 executes replays; this
    // report only references the durable definition.
    reproductionReference: {
      // Honest absence is representable: a run whose forensic derivation
      // has not completed (or that produced no durable reproduction
      // definition) emits { absent: true, reason } — never an invented
      // definition (ADR-0019 §3; R-02).
      oneOf: [
        {
          type: 'object',
          required: [
            'reproductionDefinitionId',
            'snapshotId',
            'snapshotContentHash',
            'acceptanceExpectations',
          ],
          properties: {
            reproductionDefinitionId: { type: 'string', minLength: 1 },
            snapshotId: { type: 'string', minLength: 1 },
            snapshotContentHash: { $ref: '#/definitions/sha256Hex' },
            targetModeRequirement: { type: ['string', 'null'] },
            credentialRefs: { type: 'array', items: { type: 'string' } },
            invariantBindings: { type: 'object' },
            acceptanceExpectations: { type: 'object' },
          },
        },
        {
          type: 'object',
          required: ['absent', 'reason'],
          properties: {
            absent: { type: 'boolean', const: true },
            reason: { type: 'string', minLength: 1 },
          },
        },
      ],
    },
    // Additive eligibility/certification block (ADR-0026 §20): the
    // CERTIFIED as-of composite watermark, the bound-domain coverage
    // facts, the named anomalies, the unbound current evaluations
    // (never silently omitted), and the coverage limitation statement.
    // Optional in the schema: a report without a persisted publication
    // (e.g. a pre-report failure path) omits it — consumers ignore
    // unknown/absent additive fields per §40.
    eligibility: {
      type: 'object',
      required: [
        'eligibilityVersions',
        'analysisGeneration',
        'certified',
        'certifiedAsOf',
        'boundKeys',
        'unboundCurrentEvaluations',
        'anomalies',
        'freshnessStatement',
      ],
      properties: {
        eligibilityVersions: { type: 'array', items: { type: 'string' } },
        analysisGeneration: { type: 'string' },
        certified: { type: 'boolean' },
        certifiedAsOf: {
          type: 'object',
          required: [
            'headContentHash',
            'observationCount',
            'lastChainIndex',
            'provenanceRevision',
            'derivationGeneration',
          ],
          properties: {
            headContentHash: {
              oneOf: [{ $ref: '#/definitions/sha256Hex' }, { type: 'null' }],
            },
            observationCount: { type: 'integer', minimum: 0 },
            lastChainIndex: { type: ['integer', 'null'], minimum: 0 },
            provenanceRevision: { type: 'string' },
            derivationGeneration: { type: 'string' },
          },
        },
        boundKeys: {
          type: 'array',
          items: {
            type: 'object',
            required: ['invariantKey', 'mode', 'evaluatorVersion'],
            properties: {
              invariantKey: { type: 'string', minLength: 1 },
              mode: { type: 'string', minLength: 1 },
              evaluatorVersion: { type: 'string', minLength: 1 },
              declaredSubjects: { type: 'array', items: { type: 'string' } },
              eligibleSubjects: { type: 'array', items: { type: 'string' } },
              missingSubjects: { type: 'array', items: { type: 'string' } },
              unexpectedSubjectCount: { type: 'integer', minimum: 0 },
              foreignInventoryCount: { type: 'integer', minimum: 0 },
              evidenceGapCount: { type: 'integer', minimum: 0 },
            },
          },
        },
        unboundCurrentEvaluations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['invariantKey', 'subjectKey', 'verdict'],
            properties: {
              invariantKey: { type: 'string', minLength: 1 },
              subjectKey: { type: 'string', minLength: 1 },
              verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_EVALUABLE'] },
            },
          },
        },
        anomalies: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'detail'],
            properties: {
              kind: { type: 'string', minLength: 1 },
              invariantKey: { type: ['string', 'null'] },
              subjectKey: { type: ['string', 'null'] },
              detail: { type: 'string' },
            },
          },
        },
        coverageLimitation: { type: ['string', 'null'] },
        freshnessStatement: { type: 'string', minLength: 1 },
      },
    },
    exit: {
      type: 'object',
      required: ['code', 'class'],
      properties: {
        code: { type: 'integer', minimum: 0, maximum: 4 },
        class: {
          type: 'string',
          enum: ['PASS', 'INVARIANT_FAIL', 'NOT_EVALUABLE', 'EXECUTION_FAILURE', 'USAGE_ERROR'],
        },
        reason: { type: 'string' },
      },
      // Exit code/class consistency as far as JSON Schema can express:
      allOf: [
        {
          if: { properties: { class: { const: 'PASS' } }, required: ['class'] },
          then: { properties: { code: { const: 0 } } },
        },
        {
          if: { properties: { class: { const: 'INVARIANT_FAIL' } }, required: ['class'] },
          then: { properties: { code: { const: 1 } } },
        },
        {
          if: { properties: { class: { const: 'NOT_EVALUABLE' } }, required: ['class'] },
          then: { properties: { code: { const: 2 } } },
        },
        {
          if: { properties: { class: { const: 'EXECUTION_FAILURE' } }, required: ['class'] },
          then: { properties: { code: { const: 3 } } },
        },
        {
          if: { properties: { class: { const: 'USAGE_ERROR' } }, required: ['class'] },
          then: { properties: { code: { const: 4 } } },
        },
      ],
    },
  },
  definitions: {
    sha256Hex: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const;
