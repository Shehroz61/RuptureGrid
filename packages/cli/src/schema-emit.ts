// =====================================================================
// RuptureGrid v1.1 Phase 17 — schema emission (B2 repair)
// =====================================================================
// Writes the PUBLISHED JSON Schema files (stable repository paths):
//   packages/cli/schemas/rupturegrid-report-v1.schema.json
//   packages/cli/schemas/rupturegrid-scenario-v1.schema.json
// The schemas are authored as typed TS modules (report-schema.ts /
// scenario-schema.ts) so the emitter and the schema can never drift;
// this module serializes them deterministically (sorted object keys
// are NOT applied — property order is authored order; JSON.stringify
// is deterministic for the same input).
//
// B2 repair: the serialized text is passed through the REPOSITORY'S
// OWN Prettier configuration (3.x, the package.json/format gate's
// toolchain, evaluated against the emitted file's real path so the
// repo's overrides resolve exactly as the repo's formatter applies
// them). Emitted artifacts are therefore Prettier-STABLE BY
// CONSTRUCTION: `pnpm format:check` cannot flag a fresh emission, and
// `pnpm rupturegrid schemas emit` re-creates byte-identical files
// (pinned by the committed unit test). The formatter is a dependency
// of the emission contract, not of report/step VALIDATION semantics —
// no schema field is added, removed, or reinterpreted here.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportJsonSchema, scenarioJsonSchema } from './schema-documents.js';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** The committed report-schema file name (the config-resolution anchor). */
const REPORT_FILE_NAME = 'rupturegrid-report-v1.schema.json';

interface PrettierModule {
  format: (source: string, options?: Record<string, unknown>) => Promise<string>;
  readonly getFileInfo?: (filePath: string) => Promise<{ inferredParser: string | null }>;
}

interface PrettierConfigModule extends PrettierModule {
  /** Prettier 3 config API ({@link https://prettier.io/docs/en/api}). */
  readonly resolveConfig: (
    filePath: string,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}

/**
 * Loads the repository's OWN Prettier (the same version the
 * format:check gate runs) via createRequire so the workspace-resolved
 * devDependency never depends on ESM interop details.
 */
async function loadPrettier(): Promise<PrettierConfigModule> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require('prettier') as {
    default?: Partial<PrettierConfigModule>;
  } & Partial<PrettierConfigModule>;
  return (mod.default ?? mod) as PrettierConfigModule;
}

/**
 * Deterministically serializes one schema document to stable text:
 * the byte-stable canonical JSON serialization passed through the
 * REPOSITORY'S resolved Prettier configuration (the same resolution
 * the format:check gate performs, including .prettierrc.json's
 * printWidth and trailing-comma behavior applied to short arrays).
 * Passing the config values directly (not just the filepath) avoids
 * any resolution divergence between the emitter and the formatter.
 */
export async function serializeSchemaDocumentStable(
  schema: Record<string, unknown>,
  filePath: string,
): Promise<string> {
  const raw = `${JSON.stringify(schema, null, 2)}\n`;
  const prettier = await loadPrettier();
  const fileInfo = await prettier.getFileInfo?.(filePath);
  const parser = fileInfo && fileInfo.inferredParser !== null ? fileInfo.inferredParser : 'json';
  // The repository config is the SOURCE OF TRUTH for the committed
  // artifacts' format — the emitter MUST NOT override the repo's
  // printWidth (the B2 defect was exactly a formatting rule applied on
  // top of the repository configuration).
  //
  // Config anchoring: the format gate resolves .pretierrc.json by
  // walking up from the FILE INSIDE THIS REPOSITORY. Emission targets
  // may live outside it (tests emit into temp dirs; every real target
  // is packages/cli/schemas), so resolution must anchor at the
  // COMMITTED schemas directory — the fixed, repo-visible emission
  // root — never at the arbitrary write location. Anchor lookup:
  // resolveConfig walks up from anchorDir and finds the repo config;
  // if a caller someday anchors emission elsewhere in the repo, the
  // same rule applies (an emission contract change would be an ADR).
  const anchorDir = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]dist$/, '');
  const anchorPath = join(anchorDir, 'schemas', REPORT_FILE_NAME);
  const [anchoredConfig, directConfig] = await Promise.all([
    prettier.resolveConfig(anchorPath, { editorconfig: false }),
    prettier.resolveConfig(filePath, { editorconfig: false }).catch(() => null),
  ]);
  const repoConfig = directConfig ?? anchoredConfig;
  return prettier.format(raw, {
    ...(repoConfig ?? {}),
    parser,
    filepath: filePath,
  });
}

/** Emits both published schema files; returns the written paths. */
export async function emitSchemas(targetDir: string = SCHEMAS_DIR): Promise<readonly string[]> {
  mkdirSync(targetDir, { recursive: true });
  const paths = [
    join(targetDir, REPORT_FILE_NAME),
    join(targetDir, 'rupturegrid-scenario-v1.schema.json'),
  ];
  writeFileSync(
    paths[0] as string,
    await serializeSchemaDocumentStable(reportJsonSchema, paths[0] as string),
    'utf8',
  );
  writeFileSync(
    paths[1] as string,
    await serializeSchemaDocumentStable(scenarioJsonSchema, paths[1] as string),
    'utf8',
  );
  return paths;
}

export { reportJsonSchema, scenarioJsonSchema };
