import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import desktop from '../../../apps/desktop/vitest.config';

export default defineConfig(
  mergeConfig(desktop, {
    root: resolve(__dirname, '../../../apps/desktop'),
    test: {
      setupFiles: [resolve(__dirname, 'file-databases.ts')],
    },
  })
);
