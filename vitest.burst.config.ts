import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Replace the broad include; keep the shared network guard and defaults.
    include: [
      'src/core/__tests__/standard-room-burst.test.ts',
      'src/core/__tests__/pro-room-burst.test.ts',
    ],
    maxWorkers: 2,
    reporters: ['verbose'],
  },
});
