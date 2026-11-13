import { defineConfig } from 'vitest/config';
import path from 'path';
import { assemblyCatalogExclusions } from './scripts/assembly-catalog-tests.mjs';
import {
  createRendererDefines,
  testRendererDefineValues,
} from './src/shared/renderer-build-defines';

export default defineConfig({
  define: createRendererDefines(testRendererDefineValues({ appVersion: '1.0.0' })),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@waypoint/platform': path.resolve(__dirname, '../../packages/core/platform/src'),
      '@waypoint/sequence-utils': path.resolve(__dirname, '../../packages/core/sequence-utils/src'),
      '@waypoint/genome-renderer/pure': path.resolve(
        __dirname,
        '../../packages/core/genome-renderer/src/pure.ts'
      ),
      '@waypoint/genome-renderer/react': path.resolve(
        __dirname,
        '../../packages/core/genome-renderer/src/react/index.ts'
      ),
      '@waypoint/workspace-editor/shift-click-range': path.resolve(
        __dirname,
        '../../packages/core/workspace-editor/src/selection-model.ts'
      ),
      '@waypoint/workspace-editor/find-bar': path.resolve(
        __dirname,
        '../../packages/core/workspace-editor/src/FindBar.tsx'
      ),
      '@waypoint/plasmid-viewer': path.resolve(
        __dirname,
        '../../packages/features/plasmid-viewer/src'
      ),
      '@waypoint/ui-components': path.resolve(__dirname, '../../packages/ui/components/src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    runner: './scripts/assembly-corpus-test-runner.mjs',
    globals: true,
    environment: 'jsdom',

    environmentMatchGlobs: [['src/main/**', 'node']],
    include: ['src/**/*.test.{ts,tsx}', '../../e2e/helpers/**/*.test.ts'],
    exclude: ['src/features/ai/__tests__/integration/**/*.test.ts', ...assemblyCatalogExclusions()],

    globalSetup: ['./vitest.globalSetup.mjs'],
    setupFiles: ['./src/test/setup.ts'],

    testTimeout: process.env.CI ? 20000 : 5000,
    retry: 0,
    maxWorkers: 2,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
});
