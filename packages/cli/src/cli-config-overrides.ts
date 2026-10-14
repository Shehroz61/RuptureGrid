// =====================================================================
// RuptureGrid v1.1 Phase 17 — CLI environment overrides (E2E harness)
// =====================================================================
// Opt-in, EXPLICIT test-only knobs used by the committed E2E suites to
// point the CLI child process at the harness's isolated infrastructure
// (port discipline §81). Production invocations never set them; the
// values are ordinary validated-config environment variables by name:
//
//   RUPTUREGRID_CLI_CONTROL_DATABASE_URL
//   RUPTUREGRID_CLI_REDIS_URL
//   RUPTUREGRID_CLI_QUEUE_PREFIX
//
// These are NOT credential surfaces: database/queue URLs are
// documented dev defaults already present in .env.example; the CLI
// never receives target credential VALUES at all (the executor
// resolves those in the worker, ADR-0012).

export interface CliEnvOverrides {
  readonly controlDatabaseUrl: string | null;
  readonly redisUrl: string | null;
  readonly queuePrefix: string | null;
}

export function loadTestExitOverrides(): CliEnvOverrides | null {
  const controlDatabaseUrl = process.env['RUPTUREGRID_CLI_CONTROL_DATABASE_URL'];
  const redisUrl = process.env['RUPTUREGRID_CLI_REDIS_URL'];
  const queuePrefix = process.env['RUPTUREGRID_CLI_QUEUE_PREFIX'];
  if (controlDatabaseUrl === undefined && redisUrl === undefined && queuePrefix === undefined) {
    return null;
  }
  return {
    controlDatabaseUrl: controlDatabaseUrl ?? null,
    redisUrl: redisUrl ?? null,
    queuePrefix: queuePrefix ?? null,
  };
}
