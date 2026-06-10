/**
 * @vitest-environment jsdom
 *
 * DV-2 (device-test find): a remote guest entering the remote-share wait
 * from a bare host PLAY (post-demo resume, missed descriptor) was a passive
 * dead-end — nothing was sent to the host, no descriptor re-broadcast ever
 * came, and the guest sat on AWAITING_PRELOAD forever. The wait branches
 * must escalate NEW waits via REQUEST_CURRENT_FILE (the host routes remote
 * requesters to a targeted descriptor re-send) and stay quiet on repeats.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { initPlayback } from '../playback.ts';
import { handleData } from '../../network/protocol.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  shouldWaitForRemoteShare: vi.fn(() => true),
  prepareRemoteShareWait: vi.fn(),
  cancelRemoteShareWait: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
  isRemoteGuest: mocks.isRemoteGuest,
}));

vi.mock('../../share/remote-share.ts', () => ({
  shouldWaitForRemoteShare: mocks.shouldWaitForRemoteShare,
  prepareRemoteShareWait: mocks.prepareRemoteShareWait,
  cancelRemoteShareWait: mocks.cancelRemoteShareWait,
}));

describe('remote guest PLAY → remote-share wait escalation (DV-2)', () => {
  const hostConn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.isRemoteGuest.mockReturnValue(true);
    mocks.shouldWaitForRemoteShare.mockReturnValue(true);
    setCurrentAudioBuffer(null);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', title: 'A', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', title: 'B', videoId: null, playlistId: null },
      { type: 'file', name: 'c.mp3', title: 'C', videoId: null, playlistId: null },
    ]);
    initPlayback();
  });

  it('escalates a NEW wait to the host on index-mismatch PLAY', async () => {
    setState('playlist.currentTrackIndex', 0);

    await handleData({ type: MSG.PLAY, time: 5, index: 2 }, hostConn);

    expect(mocks.prepareRemoteShareWait).toHaveBeenCalled();
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.REQUEST_CURRENT_FILE,
      name: 'c.mp3',
      index: 2,
      reason: 'remote_share_wait',
    });
  });

  it('escalates a NEW wait on index-match PLAY with no buffer (post-demo leg)', async () => {
    setState('playlist.currentTrackIndex', 2);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);

    await handleData({ type: MSG.PLAY, time: 5, index: 2 }, hostConn);

    expect(mocks.prepareRemoteShareWait).toHaveBeenCalled();
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.REQUEST_CURRENT_FILE,
      name: 'c.mp3',
      index: 2,
      reason: 'remote_share_wait',
    });
  });

  it('does NOT re-request while already waiting for the same index', async () => {
    setState('playlist.currentTrackIndex', 0);
    await handleData({ type: MSG.PLAY, time: 5, index: 2 }, hostConn);
    expect(mocks.sendToHost).toHaveBeenCalledTimes(1);

    // Mimic what the real prepareRemoteShareWait establishes for the dedup.
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', { index: 2, name: '' });
    mocks.sendToHost.mockClear();

    await handleData({ type: MSG.PLAY, time: 9, index: 2 }, hostConn);

    expect(mocks.sendToHost).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
    // The repeat PLAY is absorbed (deferred by the lifecycle gate).
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  });
});
