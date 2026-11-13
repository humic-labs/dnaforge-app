import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/features/sequence/coverage-corridor-floor.cross-runtime.test.ts'],
    testTimeout: 20_000,
  },
});
