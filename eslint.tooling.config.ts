import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const workerTypescriptFiles = ['cloudflare/**/*.ts'];
const browserTypescriptFiles = ['browser/**/*.{ts,tsx}'];
const nodeTypescriptFiles = ['scripts/**/*.{ts,mts}', '*.config.ts'];
const e2eTypescriptFiles = ['e2e/**/*.ts'];
const workshopBrowserTypescriptFiles = ['.workshop/landing/**/*.ts'];
const workshopNodeTypescriptFiles = ['.workshop/promo/**/*.ts'];
const typescriptFiles = [
  ...browserTypescriptFiles,
  ...workerTypescriptFiles,
  ...nodeTypescriptFiles,
  ...e2eTypescriptFiles,
  ...workshopBrowserTypescriptFiles,
  ...workshopNodeTypescriptFiles,
];

const typescriptRecommended = defineConfig({
  files: typescriptFiles,
  extends: tseslint.configs.recommended,
  languageOptions: {
    parserOptions: {
      project: false,
    },
  },
});

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'release-artifacts/**',
      'test-results/**',
      '.wrangler/**',
      'cloudflare/.wrangler/**',
      'cloudflare/types/**',
      'e2e/fixtures/**',
    ],
  },
  ...typescriptRecommended,
  {
    files: typescriptFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },
  {
    files: e2eTypescriptFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
