import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const aliases = {
  '@rupturegrid/shared': resolve('packages/shared/src/index.ts'),
  '@rupturegrid/config': resolve('packages/config/src/index.ts'),
  '@rupturegrid/logger': resolve('packages/logger/src/index.ts'),
  '@rupturegrid/control-db': resolve('packages/control-db/src/index.ts'),
  '@rupturegrid/demo-db': resolve('packages/demo-db/src/index.ts'),
  '@rupturegrid/queue': resolve('packages/queue/src/index.ts'),
  '@rupturegrid/engine': resolve('packages/engine/src/index.ts'),
  '@rupturegrid/evidence': resolve('packages/evidence/src/index.ts'),
  '@rupturegrid/forensics': resolve('packages/forensics/src/index.ts'),
  '@rupturegrid/incident-zero': resolve('packages/incident-zero/src/index.ts'),
  '@rupturegrid/control-db/client': resolve('packages/control-db/src/generated/client/client.ts'),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Real infrastructure needs more headroom than unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files coordinate SHARED infrastructure (e.g. the
    // Redis outage tests stop the resolved exact redis container);
    // they must not run concurrently with each other.
    fileParallelism: false,
  },
});
