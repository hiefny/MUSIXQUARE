/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { processSyncPong, registerPing, resetClockState } from '../../network/shared-clock.ts';
import type { DataConnection } from '../../types/index.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { setPlaybackFilePlaying, setPlaybackLifecycleState } from '../ownership.ts';

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
  transportMocks.play.mockResolvedValue(true);
  setCurrentAudioBuffer(null);
});

afterEach(() => {
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  vi.useRealTimers();
});

describe('same-track zero replay resync', () => {
  function arrangePlayableGuest(): {
    hostConn: DataConnection;
    forceResync: ReturnType<typeof vi.fn>;
  } {
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
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    bus.on('sync:force-resync', forceResync);

    initPlayback();
    return { hostConn, forceResync };
  }

  it('forces a fresh host sync after a current-track PLAY from 0', async () => {
    const { hostConn, forceResync } = arrangePlayableGuest();
    await handleData(
      { type: MSG.PLAY, time: 0, queueItemId: QUEUE_ITEM_ID, name: 'loop.mp3' },
      hostConn,
    );

    expect(getManagedTimer('playback-repeat-auto-sync')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);

    expect(forceResync).toHaveBeenCalledTimes(1);
  });

  it('does not arm successful-start sync effects when play returns false or rejects', async () => {
    const { hostConn } = arrangePlayableGuest();
    const armInitial = vi.fn();
    bus.on('sync:arm-initial', armInitial);
    transportMocks.play
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('start failed'));

    await handleData(
      { type: MSG.PLAY, time: 0, queueItemId: QUEUE_ITEM_ID, name: 'loop.mp3' },
      hostConn,
    );
    await handleData(
      { type: MSG.PLAY, time: 0, queueItemId: QUEUE_ITEM_ID, name: 'loop.mp3' },
      hostConn,
    );

    expect(armInitial).not.toHaveBeenCalled();
    expect(getManagedTimer('playback-repeat-auto-sync')).toBeNull();
  });

  it('arms sync exactly once after a false start succeeds through recovery', async () => {
    const { hostConn } = arrangePlayableGuest();
    const armInitial = vi.fn();
    bus.on('sync:arm-initial', armInitial);
    transportMocks.play.mockResolvedValueOnce(false);

    await handleData(
      { type: MSG.PLAY, time: 0, queueItemId: QUEUE_ITEM_ID, name: 'loop.mp3' },
      hostConn,
    );
    const recovery = transportMocks.play.mock.calls[0]?.[4] as
      { onRecoveredStarted?: () => void } | undefined;
    expect(armInitial).not.toHaveBeenCalled();

    recovery?.onRecoveredStarted?.();
    recovery?.onRecoveredStarted?.();

    expect(armInitial).toHaveBeenCalledTimes(1);
    expect(getManagedTimer('playback-repeat-auto-sync')).not.toBeNull();
  });
});

describe('hostPlayAt local-file scheduling', () => {
  function arrangePlayableGuest(): DataConnection {
    registerPing(1);
    processSyncPong(1, Date.now());
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

  it('starts a ready guest from zero at the shared host start, without skipping its lead', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1050);
    const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(5_000);

    await handleData(
      {
        type: MSG.PLAY,
        time: 0,
        queueItemId: QUEUE_ITEM_ID,
        hostStartAt: 1200,
        hostPlayAt: 1400,
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalledWith(
      0,
      0.15,
      5_150,
      expect.any(Function),
      expect.objectContaining({ timing: 'catch-up' }),
    );
    monotonicNow.mockRestore();
  });

  it('preserves the host start anchor while a guest is decoding', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1050);
    setPlaybackLifecycleState(PLAYBACK_STATE.DECODING);

    await handleData(
      {
        type: MSG.PLAY,
        time: 0,
        queueItemId: QUEUE_ITEM_ID,
        hostStartAt: 1200,
        hostPlayAt: 1400,
      },
      hostConn,
    );

    expect(transportMocks.play).not.toHaveBeenCalled();
    expect(getState('playback.pendingPlayTime')).toBe(0);
    expect(getState('playback.pendingPlayTimeSetAt')).toBe(1200);
  });

  it('uses only the short local lead until a cold clock is calibrated', async () => {
    const hostConn = arrangePlayableGuest();
    resetClockState();
    vi.setSystemTime(100_000);
    const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    const immediatePing = vi.fn();
    bus.on('sync:request-immediate-ping', immediatePing);

    await handleData(
      {
        type: MSG.PLAY,
        time: 0,
        queueItemId: QUEUE_ITEM_ID,
        hostStartAt: 1200,
        hostPlayAt: 1400,
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalledWith(
      0,
      0.2,
      5_200,
      expect.any(Function),
      expect.any(Object),
    );
    expect(immediatePing).toHaveBeenCalledOnce();
    monotonicNow.mockRestore();
  });

  it('compensates by the full host scheduling window, not just remaining wait', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1050);
    const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(5_000);

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
    expect(transportMocks.play.mock.calls[0][2]).toBe(5_150);
    monotonicNow.mockRestore();
  });

  it('preserves the absolute rendezvous deadline across a queued or slow local start', async () => {
    const hostConn = arrangePlayableGuest();
    vi.setSystemTime(1050);
    const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(8_000);
    transportMocks.play.mockResolvedValueOnce(false);

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

    expect(transportMocks.play).toHaveBeenCalledWith(
      expect.closeTo(10.2, 3),
      expect.closeTo(0.15, 3),
      8_150,
      expect.any(Function),
      expect.objectContaining({ timing: 'catch-up' }),
    );
    monotonicNow.mockRestore();
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

  it.each(['false', 'rejected'] as const)(
    'does not log a scheduled success when the source start is %s',
    async (outcome) => {
      const hostConn = arrangePlayableGuest();
      vi.setSystemTime(1050);
      const debug = vi.spyOn(log, 'debug');
      if (outcome === 'false') {
        transportMocks.play.mockResolvedValueOnce(false);
      } else {
        transportMocks.play.mockRejectedValueOnce(new Error('source start failed'));
      }

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

      expect(debug).not.toHaveBeenCalledWith(
        expect.stringContaining('[SharedClock] Scheduled play'),
      );
    },
  );
});
