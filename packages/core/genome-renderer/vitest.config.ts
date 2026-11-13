import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  },
  test: {
    projects: [
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'pixi-browser',
          include: ['src/renderers/pixi/**/*.test.{ts,tsx}', 'src/react/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'renderer-node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/renderers/pixi/**/*.test.{ts,tsx}', 'src/react/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
  },
});
