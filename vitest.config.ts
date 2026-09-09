import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Workspace packages are consumed from source here so unit tests never
// require a prior build. Runtime/builds consume the built `dist` output.
const aliases = {
  '@rupturegrid/shared': resolve('packages/shared/src/index.ts'),
  '@rupturegrid/config': resolve('packages/config/src/index.ts'),
  '@rupturegrid/logger': resolve('packages/logger/src/index.ts'),
  '@rupturegrid/control-db': resolve('packages/control-db/src/index.ts'),
  '@rupturegrid/demo-db': resolve('packages/demo-db/src/index.ts'),
  '@rupturegrid/queue': resolve('packages/queue/src/index.ts'),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
  },
});
