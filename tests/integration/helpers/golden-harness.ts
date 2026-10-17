// =====================================================================
// Integration helpers — Phase 7 golden-scenario harness
// =====================================================================
// Reuses the accepted Phase 4 harness primitives (real compiled worker
// process; real Demo process; real TCP HTTP; credential references)
// on ISOLATED ports so the golden suites never collide with the
// Phase 4/5 suites' ports. The golden RUNNER's mode is an explicit
// option (packages/incident-zero run.ts) — display names here are
// labels only and never a mode convention.

export { startDemoProcess, createDemoClient } from './demo-harness.js';
export type { DemoClient, RunningDemo } from './demo-harness.js';
export { startPhase4Worker, incidentZeroSteps } from './phase4-harness.js';
export type { RunningWorker } from './phase4-harness.js';
export { getControlPrisma, uniqueName, waitFor } from './execution-harness.js';
export { loadTestEnv } from './env.js';
export type { TestEnv } from './env.js';

import { registerDemoTarget as phase4RegisterDemoTarget } from './phase4-harness.js';
import type { OwnedControlFixture } from './owned-control-fixture.js';
import type { RunningDemo } from './demo-harness.js';

/**
 * Acquires the real Demo registration from this fixture's owner.
 * Mode is explicit; the display name is metadata, never authority.
 */
export async function registerGoldenTarget(
  fixture: OwnedControlFixture,
  demo: RunningDemo,
  mode: 'VULNERABLE' | 'SECURE',
): Promise<{ targetId: string; displayName: string }> {
  const displayName = mode === 'SECURE' ? 'golden-secure' : 'golden-vulnerable';
  const registered = await phase4RegisterDemoTarget(fixture, demo, displayName);
  return { targetId: registered.targetId, displayName };
}
