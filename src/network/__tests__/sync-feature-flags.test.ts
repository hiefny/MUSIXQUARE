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

  it('omits legacy appState from SYNC_PONG payloads by default', async () => {
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

  it('rejects legacy-only appState sync by default while accepting decomposed playback fields', async () => {
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

  it('can re-enable legacy sync emit and accept as rollback switches', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'true');
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT', 'true');
    const { state, constants, ownership, protocol, sync } = await loadFreshSyncModules();

    sync.initSync();
    ownership.setPlaybackAppState(constants.APP_STATE.PLAYING_AUDIO);
    state.setState('playback.lifecycle', constants.PLAYBACK_STATE.PLAYING);

    const conn = { peer: 'guest-1', open: true, send: vi.fn() };
    await protocol.handleData({ type: constants.MSG.SYNC_PING, pingId: 92 }, conn as never);

    expect(conn.send.mock.calls[0][0]).toMatchObject({
      type: constants.MSG.SYNC_PONG,
      pingId: 92,
      appState: constants.APP_STATE.PLAYING_AUDIO,
      mode: 'file',
      activity: 'playing',
    });
    expect(sync.isSyncPongPlayingFile({ appState: constants.APP_STATE.PLAYING_AUDIO })).toBe(true);
  });
});
