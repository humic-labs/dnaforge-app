import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'webgl-browser',
          include: ['src/components/webgl-map/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'plasmid-node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/components/webgl-map/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
  },
});
