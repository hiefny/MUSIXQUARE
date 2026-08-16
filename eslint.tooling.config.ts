import js from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const workerJavaScriptFiles = ['cloudflare/**/*.js'];
const nodeJavaScriptFiles = ['scripts/**/*.{js,mjs}', '*.config.{js,mjs}'];
const e2eJavaScriptFiles = ['e2e/**/*.{js,mjs}'];
const publicJavaScriptFiles = ['public/*.js'];
const javascriptFiles = [
  ...workerJavaScriptFiles,
  ...nodeJavaScriptFiles,
  ...e2eJavaScriptFiles,
  ...publicJavaScriptFiles,
];

const workerTypescriptFiles = ['cloudflare/**/*.ts'];
const browserTypescriptFiles = ['browser/**/*.{ts,tsx}'];
const nodeTypescriptFiles = ['scripts/**/*.{ts,mts}', '*.config.ts'];
const e2eTypescriptFiles = ['e2e/**/*.ts'];
const typescriptFiles = [
  ...browserTypescriptFiles,
  ...workerTypescriptFiles,
  ...nodeTypescriptFiles,
  ...e2eTypescriptFiles,
];

const workerGlobals = Object.fromEntries(
  [
    'AbortController',
    'AbortSignal',
    'atob',
    'Blob',
    'btoa',
    'caches',
    'clearInterval',
    'clearTimeout',
    'CloseEvent',
    'console',
    'crypto',
    'DOMException',
    'Event',
    'fetch',
    'File',
    'FormData',
    'Headers',
    'HTMLRewriter',
    'MessageChannel',
    'MessageEvent',
    'navigator',
    'performance',
    'queueMicrotask',
    'ReadableStream',
    'Request',
    'Response',
    'setInterval',
    'setTimeout',
    'structuredClone',
    'TextDecoder',
    'TextEncoder',
    'TransformStream',
    'URL',
    'URLSearchParams',
    'WebSocket',
    'WebSocketPair',
  ].map((name) => [name, 'readonly'] as const),
) satisfies Linter.Globals;
const nodeGlobals = globals.nodeBuiltin;
const e2eGlobals = { ...nodeGlobals, ...globals.browser };
const publicGlobals = { ...globals.browser, ...globals.serviceworker };

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
      'e2e/e2e-report-data.js',
    ],
  },
  {
    ...js.configs.recommended,
    files: javascriptFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      ...js.configs.recommended.rules,
      // Worker validators intentionally match ASCII control bytes. The newer
      // ESLint rule cannot distinguish those security filters from mistakes.
      'no-control-regex': 'off',
      'no-console': 'off',
      // These rules were introduced after most Worker/script code was
      // written. Keep the new profile focused on syntax, undefined globals,
      // and unsafe constructs without forcing an unrelated mass rewrite. The
      // package script pins the reviewed warning baseline at 28 so this debt
      // can shrink but cannot grow silently.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...typescriptRecommended,
  {
    files: [...workerJavaScriptFiles, ...workerTypescriptFiles],
    languageOptions: { globals: workerGlobals },
  },
  {
    files: [...nodeJavaScriptFiles, ...nodeTypescriptFiles],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: [...e2eJavaScriptFiles, ...e2eTypescriptFiles],
    languageOptions: { globals: e2eGlobals },
  },
  {
    files: browserTypescriptFiles,
    languageOptions: { globals: globals.browser },
  },
  {
    files: publicJavaScriptFiles,
    languageOptions: {
      globals: publicGlobals,
      sourceType: 'script',
    },
  },
  {
    files: typescriptFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
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
);
