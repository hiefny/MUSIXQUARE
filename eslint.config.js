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
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'warn',
      // 3.0: raw setTimeout/setInterval 금지 — setManagedTimer() 또는 delay() 사용
      'no-restricted-globals': ['error',
        { name: 'setTimeout', message: 'Use setManagedTimer() from core/timers.ts or delay() for awaitable delays.' },
        { name: 'setInterval', message: 'Use setManagedTimer(name, fn, ms, { interval: true }) from core/timers.ts.' },
      ],
    },
  },
  {
    files: ['src/core/log.ts', 'src/core/events.ts', 'src/ui/toast.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // timers.ts is the managed timer implementation — it must use raw setTimeout/setInterval
    files: ['src/core/timers.ts', 'src/core/blob-manager.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    ignores: ['dist/', 'node_modules/', '_legacy/', 'src/workers/', 'src/**/__tests__/'],
  },
);
