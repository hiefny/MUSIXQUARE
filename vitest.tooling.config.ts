import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for the release and operations tooling that can change
 * production state. Keep this profile narrow: it complements the application
 * and Worker profiles without treating every repository utility as runtime.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/core/__tests__/network-guard.setup.ts'],
    include: [
      'src/core/__tests__/d1-migration-contract.test.ts',
      'src/core/__tests__/durable-object-migration-contract.test.ts',
      'src/core/__tests__/emergency-deploy-guard.test.ts',
      'src/core/__tests__/emergency-deploy-orchestrator.test.ts',
      'src/core/__tests__/ops-drift-audit.test.ts',
      'src/core/__tests__/release-deployment-state.test.ts',
      'src/core/__tests__/release-identity.test.ts',
      'src/core/__tests__/release-manifest.test.ts',
      'src/core/__tests__/release-r2-policy-state.test.ts',
      'src/core/__tests__/release-worker-floor-state.test.ts',
    ],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage/release-tooling',
      include: [
        'scripts/audit-ops-drift.mts',
        'scripts/check-d1-migration-contract.mts',
        'scripts/check-durable-object-migration-contract.mts',
        'scripts/emergency-deploy.mts',
        'scripts/guard-emergency-deploy.mts',
        'scripts/release-deployment-state.mts',
        'scripts/release-identity.mts',
        'scripts/release-manifest.mts',
        'scripts/release-r2-policy-state.mts',
        'scripts/release-worker-floor-state.mts',
      ],
      thresholds: {
        // Initial Node 24 baseline (2026-08-10): statements 75.31,
        // branches 68.96, functions 86.09, lines 76.71. Two consecutive
        // focused runs produced the same counts. Keep a small instrumentation
        // margin while making these production-mutation tools shrink-only.
        statements: 74,
        branches: 68,
        functions: 85,
        lines: 75,
        'scripts/audit-ops-drift.mts': {
          statements: 72,
          branches: 71,
          functions: 82,
          lines: 73,
        },
        'scripts/check-d1-migration-contract.mts': {
          statements: 79,
          branches: 74,
          functions: 95,
          lines: 80,
        },
        'scripts/check-durable-object-migration-contract.mts': {
          statements: 80,
          branches: 77,
          functions: 95,
          lines: 82,
        },
        'scripts/emergency-deploy.mts': {
          statements: 81,
          branches: 82,
          functions: 82,
          lines: 81,
        },
        'scripts/guard-emergency-deploy.mts': {
          statements: 70,
          branches: 57,
          functions: 65,
          lines: 72,
        },
        'scripts/release-deployment-state.mts': {
          statements: 70,
          branches: 60,
          functions: 83,
          lines: 71,
        },
        'scripts/release-identity.mts': {
          statements: 77,
          branches: 78,
          functions: 74,
          lines: 80,
        },
        'scripts/release-manifest.mts': {
          statements: 69,
          branches: 68,
          functions: 79,
          lines: 70,
        },
        'scripts/release-r2-policy-state.mts': {
          statements: 74,
          branches: 61,
          functions: 87,
          lines: 75,
        },
        'scripts/release-worker-floor-state.mts': {
          statements: 81,
          branches: 74,
          functions: 83,
          lines: 81,
        },
      },
    },
  },
});
