// =====================================================================
// Unit — run-scope/v1 closed declaration (ADR-0026 §3/§6/§12)
// =====================================================================
// Every named rejection of the frozen declaration contract is asserted
// here, plus the accept path. Real bounds, real grammars, no mocks.

import { describe, expect, it } from 'vitest';
import type { ManifestEvidencePolicy } from './manifest.js';
import type { GenericInvariantInstance } from './generic-invariant-registry.js';
import type { ExperimentStep } from './types.js';
import {
  RUN_SCOPE_LIMITS,
  RUN_SCOPE_VERSION,
  RunScopeDefinitionError,
  validateRunScopeDeclaration,
} from './run-scope.js';

const policy = (overrides: Partial<ManifestEvidencePolicy> = {}): ManifestEvidencePolicy => ({
  manifestVersion: 'target-manifest/v1',
  inspection: [
    {
      queryId: 'orders',
      roleId: 'order',
      description: 'orders',
      path: '/inspection/orders',
      fields: { verificationScopeId: 'string', generationId: 'integer-minor-units' },
      identityFields: ['orderId'],
    },
  ],
  identityModel: {
    nodes: [
      {
        roleId: 'checkoutIntent',
        description: 'intents',
        fields: {
          checkoutIntentId: 'string',
          verificationScopeId: 'string',
          generationId: 'integer-minor-units',
        },
      },
    ],
    causalEdges: [],
    effectRoleIds: ['order'],
    subjectRoleId: 'checkoutIntent',
  },
  sensitiveFields: [],
  ...overrides,
});

const steps: readonly ExperimentStep[] = [
  {
    name: 'establish-scenario',
    action: {
      method: 'POST',
      relativePath: '/demo/admin/scenario',
      mutation: 'MUTATING',
      contract: 'GENERIC_HTTP',
      repeat: 1,
      concurrency: 1,
      retryPolicy: 'NONE',
    },
  },
  {
    name: 'checkout-submit',
    action: {
      method: 'POST',
      relativePath: '/checkout/submit',
      mutation: 'MUTATING',
      contract: 'GENERIC_HTTP',
      repeat: 2,
      concurrency: 2,
    },
  },
];

const binding = (scopeBinding: unknown, key = 'INV-CHK-1'): GenericInvariantInstance =>
  ({
    key,
    kind: 'atMostOneAcceptedEffect',
    registryVersion: 'business-invariant/v1',
    params: { scopeBinding },
  }) as unknown as GenericInvariantInstance;

const singleFieldBinding = (overrides: Record<string, unknown> = {}, key = 'INV-CHK-1') =>
  binding({ fields: ['verificationScopeId'], generationField: 'generationId', ...overrides }, key);

const validRaw = (overrides: Record<string, unknown> = {}, subjects?: Record<string, unknown>) => ({
  version: RUN_SCOPE_VERSION,
  setupStep: 'establish-scenario',
  declaredScope: 'checkout-zero',
  // The anchor field name is a REAL, READABLE surface field
  // (`verificationScopeId`, exactly what every bound inspection surface
  // and the Commerce target expose). `scopeToken` would be redacted to the
  // marker before persistence by the platform's own name pattern, so it can
  // never anchor a run — rejected explicitly in the sensitive-field test
  // below.
  scopeField: 'verificationScopeId',
  generationField: 'generationId',
  subjects: subjects ?? { 'INV-CHK-1': ['CHK-001'] },
  ...overrides,
});

const codesOf = (error: unknown): string[] =>
  error instanceof RunScopeDefinitionError ? error.issues.map((issue) => issue.code) : [];

function expectCode(
  raw: unknown,
  code: string,
  options?: {
    policy?: ManifestEvidencePolicy;
    steps?: readonly ExperimentStep[];
    bindings?: readonly GenericInvariantInstance[];
  },
): void {
  let thrown: unknown;
  try {
    validateRunScopeDeclaration({
      rawRunScope: raw,
      steps: options?.steps ?? steps,
      invariantBindings: options?.bindings ?? [singleFieldBinding()],
      policy: options?.policy ?? policy(),
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunScopeDefinitionError);
  expect(codesOf(thrown)).toContain(code);
}

describe('run-scope/v1 — accept path', () => {
  it('accepts a well-formed declaration and freezes it deterministically (sorted subjects)', () => {
    const frozen = validateRunScopeDeclaration({
      rawRunScope: validRaw({}, { 'INV-CHK-1': ['CHK-002', 'CHK-001'] }),
      steps,
      invariantBindings: [singleFieldBinding()],
      policy: policy(),
    });
    expect(frozen.version).toBe(RUN_SCOPE_VERSION);
    expect(frozen.setupStep).toBe('establish-scenario');
    expect(frozen.declaredScope).toBe('checkout-zero');
    expect(frozen.scopeField).toBe('verificationScopeId');
    expect(frozen.generationField).toBe('generationId');
    expect(frozen.subjects).toEqual({ 'INV-CHK-1': ['CHK-002', 'CHK-001'] });
  });

  it('accepts an explicit repeat/concurrency/retryPolicy default (absent = 1/NONE)', () => {
    const bareSteps: readonly ExperimentStep[] = [
      {
        name: 'establish-scenario',
        action: {
          method: 'POST',
          relativePath: '/x',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
        },
      },
    ];
    expect(() =>
      validateRunScopeDeclaration({
        rawRunScope: validRaw(),
        steps: bareSteps,
        invariantBindings: [singleFieldBinding()],
        policy: policy(),
      }),
    ).not.toThrow();
  });
});

describe('run-scope/v1 — closed shape and version', () => {
  it('rejects unknown fields (never silently stripped)', () => {
    expectCode(validRaw({ surprise: true }), 'RUN_SCOPE_UNKNOWN_FIELD');
  });

  it('rejects an unknown version (never guessed)', () => {
    expectCode(validRaw({ version: 'run-scope/v2' }), 'RUN_SCOPE_UNKNOWN_VERSION');
  });

  it('rejects a non-object declaration', () => {
    expectCode(['not', 'an', 'object'], 'RUN_SCOPE_MALFORMED');
  });
});

describe('run-scope/v1 — setup step authority', () => {
  it('rejects an unknown setup step', () => {
    expectCode(validRaw({ setupStep: 'nope-step' }), 'RUN_SCOPE_SETUP_STEP_UNKNOWN');
  });

  it('rejects a setup step that does not match the step-name grammar', () => {
    expectCode(validRaw({ setupStep: 'Establish_Scenario' }), 'RUN_SCOPE_SETUP_STEP_GRAMMAR');
  });

  it('rejects a setup step declaring repeat != 1', () => {
    const repeatSteps: readonly ExperimentStep[] = [
      {
        name: 'establish-scenario',
        action: {
          method: 'POST',
          relativePath: '/x',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
          repeat: 2,
        },
      },
    ];
    expectCode(validRaw(), 'RUN_SCOPE_SETUP_STEP_REPEAT', { steps: repeatSteps });
  });

  it('rejects a setup step declaring concurrency != 1', () => {
    const concSteps: readonly ExperimentStep[] = [
      {
        name: 'establish-scenario',
        action: {
          method: 'POST',
          relativePath: '/x',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
          concurrency: 2,
        },
      },
    ];
    expectCode(validRaw(), 'RUN_SCOPE_SETUP_STEP_CONCURRENCY', { steps: concSteps });
  });

  it('rejects a setup step declaring retryPolicy != NONE', () => {
    const retrySteps: readonly ExperimentStep[] = [
      {
        name: 'establish-scenario',
        action: {
          method: 'POST',
          relativePath: '/x',
          mutation: 'MUTATING',
          contract: 'GENERIC_HTTP',
          retryPolicy: 'SAFE',
        },
      },
    ];
    expectCode(validRaw(), 'RUN_SCOPE_SETUP_STEP_RETRY_POLICY', { steps: retrySteps });
  });
});

describe('run-scope/v1 — declaredScope and anchor fields', () => {
  it('rejects a scope longer than the bound', () => {
    expectCode(
      validRaw({ declaredScope: 'a'.repeat(RUN_SCOPE_LIMITS.maxDeclaredScopeChars + 1) }),
      'RUN_SCOPE_SCOPE_LENGTH',
    );
  });

  it('rejects an empty scope', () => {
    expectCode(validRaw({ declaredScope: '' }), 'RUN_SCOPE_SCOPE_LENGTH');
  });

  it('rejects an interpolation-shaped scope (grammar)', () => {
    expectCode(validRaw({ declaredScope: 'scope${x}' }), 'RUN_SCOPE_SCOPE_GRAMMAR');
  });

  it('rejects a whitespace-bearing scope', () => {
    expectCode(validRaw({ declaredScope: 'scope zero' }), 'RUN_SCOPE_SCOPE_GRAMMAR');
  });

  it('rejects an invalid scopeField grammar', () => {
    expectCode(validRaw({ scopeField: 'scope.token' }), 'RUN_SCOPE_FIELD_GRAMMAR');
  });

  it('rejects an invalid generationField grammar', () => {
    expectCode(validRaw({ generationField: '1generation' }), 'RUN_SCOPE_FIELD_GRAMMAR');
  });

  it('rejects a sensitive anchor field', () => {
    expectCode(validRaw({ scopeField: 'customerEmail' }), 'RUN_SCOPE_SENSITIVE_FIELD', {
      policy: policy({ sensitiveFields: ['customerEmail'] }),
    });
  });

  it('rejects a credential-reference-named anchor field', () => {
    expectCode(validRaw({ generationField: 'DEMO_ADMIN_TOKEN' }), 'RUN_SCOPE_CREDENTIAL_NAME');
  });

  it('rejects an anchor field the platform redaction NAME pattern masks by construction', () => {
    // Checkpoint C: `scopeToken` is the real-world configuration that made
    // the anchor unreadable after persistence — the platform redacts every
    // `*token*`-named field to the marker before hashing/storage, so no
    // terminal-owner candidate could ever carry the declared scope. Both
    // anchor names are checked, and the failure is the ADR's existing
    // "redacted by construction" rejection.
    expectCode(validRaw({ scopeField: 'scopeToken' }), 'RUN_SCOPE_SENSITIVE_FIELD');
    expectCode(validRaw({ generationField: 'generationToken' }), 'RUN_SCOPE_SENSITIVE_FIELD');
    // A non-sensitive name that merely CONTAINS a masked substring is a
    // different field: the pattern is matched on the name's own shape, so
    // names like `verificationScopeId`/`generationId` stay usable.
    expect(() =>
      validateRunScopeDeclaration({
        rawRunScope: validRaw(),
        steps,
        invariantBindings: [singleFieldBinding()],
        policy: policy(),
      }),
    ).not.toThrow();
  });
});

describe('run-scope/v1 — subjects', () => {
  it('rejects a subjects key that is not a frozen binding key', () => {
    expectCode(
      validRaw({}, { 'INV-CHK-1': ['CHK-001'], 'INV-OTHER': ['X'] }),
      'RUN_SCOPE_SUBJECT_KEY_UNKNOWN',
    );
  });

  it('rejects a frozen binding key with no declared subjects (fail-closed)', () => {
    expectCode(validRaw({}, {}), 'RUN_SCOPE_MISSING_BINDING_KEY');
  });

  it('rejects an empty subject list', () => {
    expectCode(validRaw({}, { 'INV-CHK-1': [] }), 'RUN_SCOPE_SUBJECTS_EMPTY');
  });

  it('rejects duplicate subject identities', () => {
    expectCode(
      validRaw({}, { 'INV-CHK-1': ['CHK-001', 'CHK-001'] }),
      'RUN_SCOPE_SUBJECT_DUPLICATE',
    );
  });

  it('rejects a subject identity containing interpolation syntax', () => {
    expectCode(
      validRaw({}, { 'INV-CHK-1': ['${credential.COMMERCE_ADMIN_TOKEN}'] }),
      'RUN_SCOPE_INTERPOLATION',
    );
  });

  it('rejects the redaction marker in a subject identity', () => {
    expectCode(validRaw({}, { 'INV-CHK-1': ['[Redacted]'] }), 'RUN_SCOPE_INTERPOLATION');
  });

  it('rejects an oversized subject identity', () => {
    expectCode(
      validRaw({}, { 'INV-CHK-1': ['a'.repeat(RUN_SCOPE_LIMITS.maxSubjectIdentityChars + 1)] }),
      'RUN_SCOPE_SUBJECT_LENGTH',
    );
  });

  it('rejects more subjects than the per-key limit', () => {
    const many = Array.from(
      { length: RUN_SCOPE_LIMITS.maxSubjectsPerKey + 1 },
      (_, i) => `CHK-${i}`,
    );
    expectCode(validRaw({}, { 'INV-CHK-1': many }), 'RUN_SCOPE_SUBJECTS_PER_KEY_LIMIT');
  });

  it('rejects more total subjects than the total limit', () => {
    // Three keys × 32 = 96 subjects, each within the per-key limit, but
    // above the total limit of 64.
    const ids = (prefix: string) =>
      Array.from(
        { length: RUN_SCOPE_LIMITS.maxSubjectsPerKey },
        (_, i) => `${prefix}-${String(i)}`,
      );
    expectCode(
      validRaw({}, { 'INV-CHK-1': ids('A'), 'INV-INV-1': ids('B'), 'INV-CHK-2': ids('C') }),
      'RUN_SCOPE_TOTAL_SUBJECTS_LIMIT',
      {
        bindings: [
          singleFieldBinding(),
          singleFieldBinding({}, 'INV-INV-1'),
          singleFieldBinding({}, 'INV-CHK-2'),
        ],
      },
    );
  });
});

describe('run-scope/v1 — §6 generic scope/generation mapping', () => {
  it('rejects a multi-field scopeBinding combined with run-scope/v1', () => {
    expectCode(validRaw(), 'RUN_SCOPE_MULTI_SCOPE_FIELD', {
      bindings: [binding({ fields: ['a', 'b'], generationField: 'generationId' })],
    });
  });

  it('rejects a binding without a generationField', () => {
    expectCode(validRaw(), 'RUN_SCOPE_GENERATION_REQUIRED', {
      bindings: [binding({ fields: ['verificationScopeId'] })],
    });
  });

  it('rejects a non-string scope field', () => {
    expectCode(validRaw(), 'RUN_SCOPE_SCOPE_FIELD_TYPE', {
      policy: policy({
        identityModel: {
          nodes: [
            {
              roleId: 'checkoutIntent',
              description: 'x',
              fields: {
                verificationScopeId: 'integer-minor-units',
                generationId: 'integer-minor-units',
              },
            },
          ],
          causalEdges: [],
          effectRoleIds: [],
          subjectRoleId: 'checkoutIntent',
        },
      }),
    });
  });

  it('rejects a generation field not declared integer-minor-units', () => {
    expectCode(validRaw(), 'RUN_SCOPE_GENERATION_FIELD_TYPE', {
      policy: policy({
        identityModel: {
          nodes: [
            {
              roleId: 'checkoutIntent',
              description: 'x',
              fields: { verificationScopeId: 'string', generationId: 'string' },
            },
          ],
          causalEdges: [],
          effectRoleIds: [],
          subjectRoleId: 'checkoutIntent',
        },
      }),
    });
  });
});

describe('run-scope/v1 — serialized sub-budget', () => {
  it('rejects a declaration exceeding the canonical serialized sub-budget', () => {
    // 96 subjects × ~199-char identities ≈ 19 kB, above the 16_000-byte
    // canonical sub-budget (and above the total-subject limit — both
    // codes are legitimate; the serialized code must be present).
    const longId = (prefix: string) => `${prefix}${'x'.repeat(190)}`;
    const ids = (prefix: string) =>
      Array.from({ length: RUN_SCOPE_LIMITS.maxSubjectsPerKey }, (_, i) =>
        longId(`${prefix}${String(i)}-`),
      );
    expectCode(
      validRaw({}, { 'INV-CHK-1': ids('A'), 'INV-INV-1': ids('B'), 'INV-CHK-2': ids('C') }),
      'RUN_SCOPE_SERIALIZED_LIMIT',
      {
        bindings: [
          singleFieldBinding(),
          singleFieldBinding({}, 'INV-INV-1'),
          singleFieldBinding({}, 'INV-CHK-2'),
        ],
      },
    );
  });
});
