// =====================================================================
// Unit — precise P2002 unique-constraint matching (p2002.ts, §70/§15)
// =====================================================================
// Only the INTENDED constraint may signal idempotent convergence:
//   - classic Prisma shape (meta.target field list),
//   - Prisma 7 driver-adapter shape (DDL index name, including the
//     PostgreSQL 63-char truncation actually emitted by the migration).
// An unrelated unique/primary-key violation MUST propagate — it is
// never misread as convergence.

import { describe, expect, it } from 'vitest';
import { isUniqueConstraint } from './index.js';

const FINDING_DDL = 'finding_invariantEvaluationId_findingRuleVersion_key';
const FINDING_FIELDS = ['invariantEvaluationId', 'findingRuleVersion'];

function classicP2002(target: string[]): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
}

function adapterP2002(indexName: string): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: {
      driverAdapterError: { cause: { constraint: { index: indexName } } },
    },
  });
}

describe('P2002 matcher — intended constraint, both shapes (§70)', () => {
  it('matches the classic meta.target field list', () => {
    expect(isUniqueConstraint(classicP2002(FINDING_FIELDS), FINDING_FIELDS, FINDING_DDL)).toBe(
      true,
    );
    // Field order and case do not matter; the field SET does.
    expect(
      isUniqueConstraint(
        classicP2002(['findingruleversion', 'invariantevaluationid']),
        FINDING_FIELDS,
        FINDING_DDL,
      ),
    ).toBe(true);
  });

  it('matches the Prisma 7 driver-adapter DDL index name', () => {
    expect(isUniqueConstraint(adapterP2002(FINDING_DDL), FINDING_FIELDS, FINDING_DDL)).toBe(true);
  });

  it('accounts for PostgreSQL 63-char identifier truncation', () => {
    // The untruncated constraint name would be ...inputFingerprint_key;
    // PostgreSQL kept exactly 63 characters — the migration's actual
    // DDL name is this truncated string, and the matcher must compare
    // against what the DATABASE emits.
    const truncated = 'forensic_derivation_runId_derivationVersion_inputFingerprin_key';
    expect(truncated.length).toBe(63); // the PostgreSQL identifier limit
    expect(
      isUniqueConstraint(
        adapterP2002(truncated),
        ['runId', 'derivationVersion', 'inputFingerprint'],
        'forensic_derivation_runId_derivationVersion_inputFingerprin_key',
      ),
    ).toBe(true);
  });

  it('rejects a different constraint in both shapes', () => {
    // Classic shape: different field list.
    expect(
      isUniqueConstraint(classicP2002(['runId']), ['runId'], 'reproduction_definition_runId_key'),
    ).toBe(true);
    expect(
      isUniqueConstraint(
        classicP2002(['runId', 'extra']),
        ['runId'],
        'reproduction_definition_runId_key',
      ),
    ).toBe(false);
    // Adapter shape: a DIFFERENT constraint's name.
    expect(isUniqueConstraint(adapterP2002('finding_pkey'), FINDING_FIELDS, FINDING_DDL)).toBe(
      false,
    );
    // A truncated-but-different DDL name must not match.
    expect(
      isUniqueConstraint(
        adapterP2002('finding_invariantEvaluationId_findingRuleVersion_ke'),
        FINDING_FIELDS,
        FINDING_DDL,
      ),
    ).toBe(false);
  });

  it('never swallows non-P2002 errors or P2002s without meta', () => {
    expect(isUniqueConstraint(new Error('nope'), FINDING_FIELDS, FINDING_DDL)).toBe(false);
    expect(
      isUniqueConstraint(
        Object.assign(new Error('x'), { code: 'P2002' }),
        FINDING_FIELDS,
        FINDING_DDL,
      ),
    ).toBe(false);
    expect(isUniqueConstraint(null, FINDING_FIELDS, FINDING_DDL)).toBe(false);
  });
});
