import { defineConfig } from 'eslint/config';
import type { Linter } from 'eslint';
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

const promiseOwnershipRules: Linter.RulesRecord = {
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
  '@typescript-eslint/no-misused-promises': 'error',
};

const cloudflareProjects = [
  './tsconfig.cloudflare-leaves.json',
  './cloudflare/tsconfig.app.json',
  './cloudflare/tsconfig.pro-room.json',
  './cloudflare/tsconfig.remote-share.json',
  './cloudflare/tsconfig.developer-api.json',
  './cloudflare/tsconfig.developer-api-facade.json',
  './cloudflare/tsconfig.signaling.json',
];

const typeAwarePromiseProjects = defineConfig(
  {
    files: ['browser/classic-runtime/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.browser-classic.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['browser/auxiliary-runtime/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.auxiliary-browser.json', './tsconfig.auxiliary-browser-remote.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['browser/service-worker.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.service-worker.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['browser/ui-kit/app/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.ui-kit.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['cloudflare/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: cloudflareProjects,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['scripts/**/*.mts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.node-scripts.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: [
      '.workshop/promo/**/*.ts',
      'scripts/**/*.ts',
      'eslint*.config.ts',
      'vite.config.ts',
      'vitest*.config.ts',
    ],
    ignores: ['scripts/types/**/*.d.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.tooling.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['.workshop/landing/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.workshop-landing.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
  {
    files: ['e2e/**/*.ts', 'playwright*.config.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.e2e.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: promiseOwnershipRules,
  },
);

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
  ...typeAwarePromiseProjects,
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
