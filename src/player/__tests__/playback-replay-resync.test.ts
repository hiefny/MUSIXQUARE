/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { resetClockState } from '../../network/shared-clock.ts';
import type { DataConnection } from '../../types/index.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { setPlaybackLifecycleState } from '../ownership.ts';

const transportMocks = vi.hoisted(() => ({
  play: vi.fn(),
}));

vi.mock('../transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport.ts')>();
  return {
    ...actual,
    play: transportMocks.play,
  };
});

const { initPlayback } = await import('../playback.ts');
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

function setResidentFile(name: string): void {
  const blob = new File(['audio'], name, { type: 'audio/mpeg' });
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    name,
    sessionId: 1,
    blob,
    mime: blob.type,
    size: blob.size,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetClockState();
  resetInboundRateLimit('host-1');
  transportMocks.play.mockReset();
  transportMocks.play.mockResolvedValue(undefined);
  setCurrentAudioBuffer(null);
});

afterEach(() => {
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  vi.useRealTimers();
});

describe('same-track zero replay resync', () => {
  it('forces a fresh host sync after a current-track PLAY from 0', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    const forceResync = vi.fn();

    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'file',
        name: 'loop.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setResidentFile('loop.mp3');
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    bus.on('sync:force-resync', forceResync);

    initPlayback();
    await handleData(
      { type: MSG.PLAY, time: 0, queueItemId: QUEUE_ITEM_ID, name: 'loop.mp3' },
      hostConn,
    );

    expect(getManagedTimer('playback-repeat-auto-sync')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);

    expect(forceResync).toHaveBeenCalledTimes(1);
  });
});

describe('hostPlayAt local-file scheduling', () => {
  function arrangePlayableGuest(): DataConnection {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'file',
        name: 'song.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setResidentFile('song.mp3');
    setPlaybackLifecycleState(PLAYBACK_STATE.READY);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    initPlayback();
    return hostConn;
  }

  it('compensates by the full host scheduling window, not just remaining wait', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1050);

    await handleData(
      {
        type: MSG.PLAY,
        time: 10,
        queueItemId: QUEUE_ITEM_ID,
        name: 'song.mp3',
        hostPlayAt: 1200,
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalledTimes(1);
    expect(transportMocks.play.mock.calls[0][0]).toBeCloseTo(10.2, 3);
    expect(transportMocks.play.mock.calls[0][1]).toBeCloseTo(0.15, 3);
  });

  it('compensates late hostPlayAt messages by the overdue time too', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1250);

    await handleData(
      {
        type: MSG.PLAY,
        time: 10,
        queueItemId: QUEUE_ITEM_ID,
        name: 'song.mp3',
        hostPlayAt: 1200,
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalledTimes(1);
    expect(transportMocks.play.mock.calls[0][0]).toBeCloseTo(10.25, 3);
    expect(transportMocks.play.mock.calls[0][1]).toBe(0);
  });
});
