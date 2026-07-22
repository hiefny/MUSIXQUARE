/**
 * @vitest-environment jsdom
 *
 * A remote guest entering remote-share wait from a host PLAY must notify the
 * host via REQUEST_CURRENT_FILE so the descriptor can be resent. Existing
 * waits remain deduplicated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { initPlayback } from '../playback.ts';
import { handleData } from '../../network/protocol.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import type { DataConnection } from '../../types/index.ts';

const QID_A = '00000000-0000-4000-8000-000000000001';
const QID_B = '00000000-0000-4000-8000-000000000002';
const QID_C = '00000000-0000-4000-8000-000000000003';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  exactHostSend: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  shouldWaitForRemoteShare: vi.fn(() => true),
  prepareRemoteShareWait: vi.fn(),
  cancelRemoteShareWait: vi.fn(),
}));

function expectCorrelatedRequest(
  send: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
): void {
  expect(send).toHaveBeenCalledWith({
    ...expected,
    requestId: expect.any(Number),
  });
  const matchingCall = send.mock.calls.find(([message]) =>
    Object.entries(expected).every(
      ([key, value]) => (message as Record<string, unknown> | undefined)?.[key] === value,
    ),
  );
  const requestId = (matchingCall?.[0] as { requestId?: unknown } | undefined)?.requestId;
  expect(requestId).toEqual(expect.any(Number));
  expect(requestId as number).toBeGreaterThan(0);
}

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
  const hostConn: DataConnection = {
    open: true,
    peer: 'host-1',
    send: mocks.exactHostSend,
    close: vi.fn(),
    on: () => undefined,
  };

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
      {
        queueItemId: QID_A,
        type: 'file',
        name: 'a.mp3',
        title: 'A',
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: QID_B,
        type: 'file',
        name: 'b.mp3',
        title: 'B',
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: QID_C,
        type: 'file',
        name: 'c.mp3',
        title: 'C',
        videoId: null,
        playlistId: null,
      },
    ]);
    initPlayback();
  });

  it('escalates a NEW wait to the host on queue-item change PLAY', async () => {
    setState('playlist.currentQueueItemId', QID_A);

    await handleData({ type: MSG.PLAY, time: 5, queueItemId: QID_C }, hostConn);

    expect(mocks.prepareRemoteShareWait).toHaveBeenCalledWith(QID_C, 'c.mp3', expect.any(Number));
    expectCorrelatedRequest(mocks.exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: QID_C,
      name: 'c.mp3',
      reason: 'remote_share_wait',
    });
  });

  it('uses remote share when a user filename matches a bundled demo asset', async () => {
    setState('playlist.currentQueueItemId', QID_A);
    setState(
      'playlist.items',
      getState('playlist.items').map((item) =>
        item.queueItemId === QID_C
          ? { ...item, name: DEMO_TRACK.fileName, title: DEMO_TRACK.title }
          : item,
      ),
    );

    await handleData(
      { type: MSG.PLAY, time: 5, queueItemId: QID_C, name: DEMO_TRACK.fileName },
      hostConn,
    );

    expect(mocks.prepareRemoteShareWait).toHaveBeenCalledWith(
      QID_C,
      DEMO_TRACK.fileName,
      expect.any(Number),
    );
    expectCorrelatedRequest(mocks.exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: QID_C,
      name: DEMO_TRACK.fileName,
      reason: 'remote_share_wait',
    });
  });

  it('escalates a NEW wait on selected-item PLAY with no buffer (post-demo leg)', async () => {
    setState('playlist.currentQueueItemId', QID_C);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);

    await handleData({ type: MSG.PLAY, time: 5, queueItemId: QID_C }, hostConn);

    expect(mocks.prepareRemoteShareWait).toHaveBeenCalledWith(QID_C, 'c.mp3', expect.any(Number));
    expectCorrelatedRequest(mocks.exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: QID_C,
      name: 'c.mp3',
      reason: 'remote_share_wait',
    });
  });

  it('does NOT re-request while already waiting for the same queue item', async () => {
    setState('playlist.currentQueueItemId', QID_A);
    await handleData({ type: MSG.PLAY, time: 5, queueItemId: QID_C }, hostConn);
    expect(mocks.exactHostSend).toHaveBeenCalledTimes(1);

    // Mimic what the real prepareRemoteShareWait establishes for the dedup.
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: QID_C,
      indexHint: 2,
      name: 'c.mp3',
    });
    mocks.exactHostSend.mockClear();

    await handleData({ type: MSG.PLAY, time: 9, queueItemId: QID_C }, hostConn);

    expect(mocks.exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
    // The repeat PLAY is absorbed (deferred by the lifecycle gate).
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  });
});
