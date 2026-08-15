import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const setupSource = readFileSync(new URL('../setup-flow.ts', import.meta.url), 'utf8');

describe('PRO setup runtime import boundary', () => {
  it('latches one runtime import and reports a terminal failure for reload', () => {
    expect(setupSource.match(/import\('\.\/runtime\.ts'\)/gu)).toHaveLength(2);
    // One occurrence is type-only; exactly one executable import owns the
    // document-scoped flight used by ordinary and one-time-claim entries.
    expect(setupSource.match(/proRoomRuntimeFlight \?\?= import/gu)).toHaveLength(1);
    expect(setupSource).toContain(
      "bus.emit('app:lazy-feature-load-failed', 'pro-room', terminalError)",
    );
    expect(setupSource).toContain(
      'runClaimProtectedOperation(loadProRoomRuntime, existingOwnerLoginPolicy)',
    );
    expect(setupSource).toContain('isLazyFeatureLoadError(error)');
    expect(setupSource).not.toContain("value: await import('./runtime.ts')");
  });
});
