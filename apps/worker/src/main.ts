// =====================================================================
// RuptureGrid v1.0 — worker process (Phase 1 shell)
// =====================================================================
// No HTTP server: the worker validates configuration, connects to its
// owned dependencies (Control PostgreSQL, Redis/BullMQ), and emits a
// structured ready event only after successful startup (Phase 1 §25).
// The real start/shutdown sequence lives in lifecycle.ts so tests can
// exercise the genuine graceful-shutdown path in-process (Windows
// cannot deliver SIGTERM to a process killed from outside).

import { startWorker } from './lifecycle.js';

async function main(): Promise<void> {
  const runtime = await startWorker();
  await runtime.ready;

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
