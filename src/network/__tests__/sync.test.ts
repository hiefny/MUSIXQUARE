/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { APP_STATE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { handleData } from '../protocol.ts';
import { getTotalSyncOffsetMs, handleAutoSync, initSync } from '../sync.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('getTotalSyncOffsetMs', () => {
  it('returns 0 initially', () => {
    expect(getTotalSyncOffsetMs()).toBe(0);
  });

  it('calculates from localOffset', () => {
    setState('sync.localOffset', 0.15);
    expect(getTotalSyncOffsetMs()).toBe(150);
  });

  it('handles negative offsets', () => {
    setState('sync.localOffset', -0.05);
    expect(getTotalSyncOffsetMs()).toBe(-50);
  });
});

describe('handleAutoSync', () => {
  it('resets localOffset to 0', () => {
    setState('sync.localOffset', 0.5);
    handleAutoSync();
    expect(getState('sync.localOffset')).toBe(0);
  });
});

describe('SYNC_PING playback snapshot', () => {
  it('does not advertise PLAYING_AUDIO while host is decoded but waiting to start', async () => {
    initSync();
    setState('appState', APP_STATE.PLAYING_AUDIO);
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playlist.currentTrackIndex', 2);

    const conn = { peer: 'guest-1', open: true, send: vi.fn() };
    await handleData({ type: MSG.SYNC_PING, pingId: 7 }, conn as any);

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PONG,
        pingId: 7,
        appState: APP_STATE.PAUSED,
        position: 0,
        trackIndex: 2,
      }),
    );
  });
});
