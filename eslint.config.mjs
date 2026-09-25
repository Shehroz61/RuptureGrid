// RuptureGrid — ESLint flat config (ESLint 10 + typescript-eslint).
// Deliberately small: strict typing, no unused code, no dangerous escapes.
//
// Phase 11 release gate: the default block below matches every tracked
// TypeScript file in the repository (tests/** included — closing the Phase
// 10 lint blind spot AUDIT-4, where tests/integration/** accumulated
// invisible lint debt). The per-package `lint` scripts still lint exactly
// their own src; this root config adds repository-wide coverage without
// loosening anything.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/src/generated/**',
      'eslint.config.mjs',
      'vitest.config.ts',
      'tests/integration/vitest.config.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'packages/*/src/**/*.test.ts'],
    rules: {
      // Vitest tests legitimately reference globals (describe/it/expect) via
      // imports only; this repo intentionally does not enable the
      // vitest globals plugin. No test-specific relaxations are granted.
    },
  },
  // Ownership boundaries (ADR-0002, AGENTS R-05): RuptureGrid applications
  // must never import the Demo Target's database client, the Demo Target
  // must never import RuptureGrid's Control DB client, and the browser
  // bundle must never import server-only database/config packages. These
  // are lint errors, not comments.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@rupturegrid/demo-db', '@rupturegrid/demo-db/*'],
              message:
                'RuptureGrid apps must never import the Demo Target database (ADR-0002, R-05).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/demo-fintech/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@rupturegrid/control-db',
                '@rupturegrid/control-db/*',
                '@rupturegrid/queue',
                '@rupturegrid/queue/*',
              ],
              message:
                'Demo Fintech is external to RuptureGrid and must never import Control DB or queue packages (ADR-0002, R-05).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@rupturegrid/control-db',
                '@rupturegrid/control-db/*',
                '@rupturegrid/demo-db',
                '@rupturegrid/demo-db/*',
                '@rupturegrid/config',
                '@rupturegrid/config/*',
                '@rupturegrid/queue',
                '@rupturegrid/queue/*',
              ],
              message: 'Browser code must never import server-only DB/config/queue packages.',
            },
          ],
        },
      ],
    },
  },
);
