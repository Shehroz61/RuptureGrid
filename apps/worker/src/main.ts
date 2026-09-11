// =====================================================================
// RuptureGrid v1.0 — worker process (Phase 3 execution worker)
// =====================================================================
// No HTTP server: the worker validates configuration, connects to its
// owned dependencies (Control PostgreSQL, Redis/BullMQ), consumes the
// experiment-execution queue, and runs the reconciler loop. The start/
// shutdown sequence lives in execution-worker.ts so tests exercise the
// genuine graceful path in-process (Windows cannot deliver SIGTERM to
// a process killed from outside).

import { startExecutionWorkerRuntime } from './execution-worker.js';

async function main(): Promise<void> {
  const runtime = await startExecutionWorkerRuntime();
  await runtime.ready;
  console.log(`[rupturegrid-worker] ready (owner=${runtime.workerId})`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void runtime.shutdown().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Worker failed to start: ${message}`);
  process.exit(1);
});
