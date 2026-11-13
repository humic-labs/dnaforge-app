import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

export default defineConfig({
  resolve: {
    alias: {
      react: path.join(root, 'node_modules/react'),
      'react/jsx-runtime': path.join(root, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.join(root, 'node_modules/react/jsx-dev-runtime.js'),
      'react-dom': path.join(root, 'node_modules/react-dom'),
      'react-dom/client': path.join(root, 'node_modules/react-dom/client.js'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
