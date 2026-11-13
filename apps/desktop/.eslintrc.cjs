module.exports = {
  root: true,
  extends: ['../../.eslintrc.js'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: [
    'out/**/*',
    'dist/**/*',
    '**/*.test.ts',
    '**/*.test.tsx',

    'src/features/assembly-graph/__tests__/inference/generate-browser-data.generator.ts',
    'scripts/**/*',
    '**/*.d.ts',
  ],
  overrides: [
    {
      files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
      parserOptions: {
        project: './tsconfig.node.json',
        tsconfigRootDir: __dirname,
      },
      rules: {
        '@typescript-eslint/no-require-imports': 'error',
        'no-console': 'off',
      },
    },
  ],
};
