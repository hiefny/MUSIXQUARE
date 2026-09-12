import { defineConfig } from 'vitest/config';
import broadConfig from './vitest.config.ts';

// A shard cannot satisfy whole-suite coverage floors on its own. Collect the
// same instrumented sources, then enforce the original config when merging.
const coverage = { ...broadConfig.test?.coverage };
delete coverage.thresholds;

export default defineConfig({
  ...broadConfig,
  test: {
    ...broadConfig.test,
    reporters: ['default', 'blob'],
    coverage: {
      ...coverage,
      provider: 'v8',
      enabled: true,
      reporter: [],
      reportsDirectory: 'coverage/ci-shard',
    },
  },
});
