import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const handlersSource = readFileSync(
  fileURLToPath(new URL('../handlers.ts', import.meta.url)),
  'utf8',
);
const bridgeSource = readFileSync(
  fileURLToPath(new URL('../handler-runtime-bridge.ts', import.meta.url)),
  'utf8',
);
const appSource = readFileSync(fileURLToPath(new URL('../../app.ts', import.meta.url)), 'utf8');

describe('YouTube handler runtime bridge', () => {
  it('keeps the protocol handler graph independent from the player coordinator', () => {
    expect(handlersSource).not.toMatch(/from\s+['"]\.\/player\.ts['"]/u);
    expect(handlersSource).toContain("from './handler-runtime-bridge.ts'");
    expect(bridgeSource).not.toMatch(/\bimport\s*\(/u);
    expect(bridgeSource).not.toMatch(/from\s+['"]\.\/(?:handlers|player)\.ts['"]/u);
    expect(appSource).toContain('configureYouTubeHandlerRuntimeHooks({');
  });

  it('fails fast before player ownership is configured', async () => {
    vi.resetModules();
    const bridge = await import('../handler-runtime-bridge.ts');

    expect(() => bridge.scheduleYtAutoSyncFromHandler(12)).toThrow(
      'Handler runtime used before player initialization',
    );
    expect(() => bridge.tryBeginYouTubeZeroStartFromHandler('video-id', 3)).toThrow(
      'Handler runtime used before player initialization',
    );
  });

  it('forwards commands synchronously without changing their arguments or result', async () => {
    vi.resetModules();
    const bridge = await import('../handler-runtime-bridge.ts');
    const scheduleYtAutoSync = vi.fn();
    const tryBeginYouTubeZeroStart = vi.fn(() => true);

    bridge.configureYouTubeHandlerRuntimeHooks({
      scheduleYtAutoSync,
      tryBeginYouTubeZeroStart,
    });

    const overrides = {
      subIndex: 4,
      videoId: 'video-id',
      skipSeek: true,
      rendezvousDelayMs: 2750,
      state: 2,
    };
    bridge.scheduleYtAutoSyncFromHandler(17, overrides);

    expect(scheduleYtAutoSync).toHaveBeenCalledOnce();
    expect(scheduleYtAutoSync).toHaveBeenCalledWith(17, overrides);
    expect(bridge.tryBeginYouTubeZeroStartFromHandler('video-id', 4)).toBe(true);
    expect(tryBeginYouTubeZeroStart).toHaveBeenCalledOnce();
    expect(tryBeginYouTubeZeroStart).toHaveBeenCalledWith('video-id', 4);
  });
});
