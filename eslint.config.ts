import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'warn',
      // Application timers must be registered for lifecycle cleanup.
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message: 'Use setManagedTimer() from core/timers.ts or delay() for awaitable delays.',
        },
        {
          name: 'setInterval',
          message: 'Use setManagedTimer(name, fn, ms, { interval: true }) from core/timers.ts.',
        },
      ],
    },
  },
  {
    files: ['src/core/log.ts', 'src/core/events.ts', 'src/ui/toast.ts', 'src/core/timers.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Managed-timer internals require the native timer APIs.
    files: ['src/core/timers.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // AudioWorklet assets run in AudioWorkletGlobalScope rather than the DOM
    // or the TypeScript project. Keep them linted as plain modules with only
    // the platform globals the processor is allowed to use.
    files: ['src/audio/worklets/**/*.js'],
    languageOptions: {
      parserOptions: { project: false },
      globals: {
        AudioWorkletProcessor: 'readonly',
        currentFrame: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    // Dedicated workers use their own WebWorker-only TypeScript project.
    // Keeping them in the normal lint run is important because decoder and
    // transport workers are production code, not generated assets.
    files: ['src/workers/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './src/workers/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Worker lifetimes are owned by their parent and do not use the window
      // timer registry.
      'no-restricted-globals': 'off',
    },
  },
  {
    // Tests have their own TypeScript project and deliberately use native
    // timers/console while exercising lifecycle and failure behavior. Keep
    // the production rules everywhere else while still linting test code for
    // unsafe constructs, undefined bindings, and unused values.
    files: ['src/**/__tests__/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'off',
      'no-restricted-globals': 'off',
      // Self-referential harnesses intentionally assign controllers after
      // their callbacks close over the binding, which prefer-const cannot
      // distinguish from an unnecessary mutable declaration.
      'prefer-const': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '_legacy/'],
  },
);
