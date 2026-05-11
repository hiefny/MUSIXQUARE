/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFreshSyncModules() {
  vi.resetModules();
  const [state, timers, constants, ownership, protocol, sync, sharedClock, playerState] =
    await Promise.all([
      import('../../core/state.ts'),
      import('../../core/timers.ts'),
      import('../../core/constants.ts'),
      import('../../player/ownership.ts'),
      import('../protocol.ts'),
      import('../sync.ts'),
      import('../shared-clock.ts'),
      import('../../player/_state.ts'),
    ]);

  state.resetState();
  timers.clearAllManagedTimers();
  sharedClock.resetClockState();
  playerState.setCurrentAudioBuffer(null);

  return { state, timers, constants, ownership, protocol, sync, sharedClock, playerState };
}

describe('sync feature flags', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { timers, sharedClock, playerState } = await loadFreshSyncModules();
    timers.clearAllManagedTimers();
    sharedClock.resetClockState();
    playerState.setCurrentAudioBuffer(null);
  });

  it('can disable legacy appState emission in SYNC_PONG payloads', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'false');
    const { state, constants, ownership, protocol, sync } = await loadFreshSyncModules();

    sync.initSync();
    ownership.setPlaybackAppState(constants.APP_STATE.PLAYING_AUDIO);
    state.setState('playback.lifecycle', constants.PLAYBACK_STATE.PLAYING);

    const conn = { peer: 'guest-1', open: true, send: vi.fn() };
    await protocol.handleData({ type: constants.MSG.SYNC_PING, pingId: 91 }, conn as never);

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: constants.MSG.SYNC_PONG,
        pingId: 91,
        mode: 'file',
        activity: 'playing',
      }),
    );
    expect(conn.send.mock.calls[0][0]).not.toHaveProperty('appState');
  });

  it('can disable legacy appState accept while still accepting decomposed playback fields', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT', 'false');
    const { constants, sync } = await loadFreshSyncModules();

    expect(sync.isSyncPongPlayingFile({ appState: constants.APP_STATE.PLAYING_AUDIO })).toBe(false);
    expect(
      sync.isSyncPongPlayingFile({
        appState: constants.APP_STATE.IDLE,
        mode: 'file',
        activity: 'playing',
      }),
    ).toBe(true);
  });
});
