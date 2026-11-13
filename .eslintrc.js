module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'user-messages'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    'user-messages/approved-text': 'error',
    'no-empty': ['error', { allowEmptyCatch: true }],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',

    'react/prop-types': 'off',
    'react/display-name': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '.nx/',
    'coverage/',
    '*.config.js',
    '*.config.ts',
    'vite.config.ts',
  ],
  overrides: [
    {
      files: [
        'apps/desktop/src/**/*.{ts,tsx,js,jsx}',
        'src/**/*.{ts,tsx,js,jsx}',
        'apps/web/**/*.{ts,tsx,js,jsx}',
      ],
      excludedFiles: [
        'apps/desktop/src/main/sentry.ts',
        'apps/desktop/src/lib/sentry.ts',
        'src/main/sentry.ts',
        'src/lib/sentry.ts',
        'apps/web/lib/error-reporting.ts',
        'apps/web/instrumentation.ts',
        'apps/web/instrumentation-client.ts',
        '**/*.{test,spec,e2e}.{ts,tsx,js,jsx}',
        '**/__tests__/**',
        '**/test/**',
        '**/e2e/**',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@sentry/*'],
                message:
                  'Use application reporting helpers; the Sentry SDK belongs to its adapters.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: 'ImportExpression[source.value=/^@sentry\\//]',
            message: 'Load the Sentry SDK only inside its reporting adapters.',
          },
          {
            selector: "CallExpression[callee.type='Import'][arguments.0.value=/^@sentry\\//]",
            message: 'Load the Sentry SDK only inside its reporting adapters.',
          },
          {
            selector: "CallExpression[callee.name='require'][arguments.0.value=/^@sentry\\//]",
            message: 'Load the Sentry SDK only inside its reporting adapters.',
          },
          {
            selector: 'TSImportEqualsDeclaration[moduleReference.expression.value=/^@sentry\\//]',
            message: 'Load the Sentry SDK only inside its reporting adapters.',
          },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      files: ['e2e/**/*.spec.ts'],
      rules: {
        'no-restricted-syntax': [
          'warn',
          {
            selector: "CallExpression[callee.property.name='waitForTimeout']",
            message:
              'Avoid waitForTimeout - use proper assertions like expect(locator).toBeVisible() instead. See docs/E2E_BEST_PRACTICES.md',
          },
        ],
      },
    },
    {
      files: ['*.js', '*.cjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
