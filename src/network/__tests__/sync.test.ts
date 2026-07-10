/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData, resetInboundRateLimit } from '../protocol.ts';
import {
  getSyncPongPlaybackState,
  getTotalSyncOffsetMs,
  handleAutoSync,
  initSync,
  isSyncPongPlayingFile,
} from '../sync.ts';
import {
  getClockOffset,
  isClockCalibrated,
  processSyncPong,
  registerPing,
  resetClockState,
} from '../shared-clock.ts';
import { setCurrentAudioBuffer, setLocalFilePaused } from '../../player/_state.ts';
import {
  createSystemAudioTrackMeta,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackLifecycleState,
  setPlaybackSystemAudioPlaying,
  setPlaybackTrackMeta,
  setPlaybackYouTubePlaying,
} from '../../player/ownership.ts';

const transportMocks = vi.hoisted(() => ({
  play: vi.fn(),
}));

function makeConnection(peer = 'host'): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
}

vi.mock('../../player/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../player/transport.ts')>();
  return {
    ...actual,
    play: transportMocks.play,
  };
});

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  resetClockState();
  setCurrentAudioBuffer(null);
  bus.clear();
  resetInboundRateLimit('guest-1');
  transportMocks.play.mockReset();
  transportMocks.play.mockResolvedValue(undefined);
  setLocalFilePaused(false);
});

afterEach(() => {
  clearAllManagedTimers();
  resetClockState();
  setCurrentAudioBuffer(null);
  vi.useRealTimers();
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

  it('resets YouTube manual offset and requests an immediate rendezvous on guests', () => {
    const applySpy = vi.fn();
    bus.on('youtube:apply-manual-sync', applySpy);
    setPlaybackYouTubePlaying();
    setState('network.hostConn', { open: true } as DataConnection);
    setState('sync.youtubeLocalOffset', 0.25);

    handleAutoSync();

    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});

describe('manual sync nudge routing', () => {
  it('rejects YouTube nudges when the guest has no open host connection', () => {
    initSync();
    setPlaybackYouTubePlaying();

    bus.emit('sync:nudge', 10);

    expect(getState('sync.youtubeLocalOffset')).toBe(0);
  });

  it('rejects local-file nudges before a decoded buffer exists', () => {
    initSync();
    setPlaybackFilePlaying();
    setState('network.hostConn', { open: true } as DataConnection);

    bus.emit('sync:nudge', 10);

    expect(getState('sync.localOffset')).toBe(0);
  });

  it('clamps YouTube manual offset changes to the supported nudge range', () => {
    vi.useFakeTimers();
    initSync();
    setPlaybackYouTubePlaying();
    setState('network.hostConn', { open: true } as DataConnection);

    bus.emit('sync:nudge', 5000);

    expect(getState('sync.youtubeLocalOffset')).toBe(3);
  });

  it('debounces YouTube nudges and applies them through rendezvous once', () => {
    vi.useFakeTimers();
    initSync();
    const applySpy = vi.fn();
    bus.on('youtube:apply-manual-sync', applySpy);
    setPlaybackYouTubePlaying();
    setState('network.hostConn', { open: true } as DataConnection);

    bus.emit('sync:nudge', 10);
    expect(getState('sync.youtubeLocalOffset')).toBeCloseTo(0.01, 4);
    expect(applySpy).not.toHaveBeenCalled();

    bus.emit('sync:nudge', 1);
    expect(getState('sync.youtubeLocalOffset')).toBeCloseTo(0.011, 4);

    vi.advanceTimersByTime(999);
    expect(applySpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});

describe('SYNC_PING playback snapshot', () => {
  it('does not advertise PLAYING_AUDIO while host is decoded but waiting to start', async () => {
    initSync();
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playlist.currentTrackIndex', 2);

    const conn = makeConnection('guest-audible');
    await handleData({ type: MSG.SYNC_PING, pingId: 7 }, conn);

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PONG,
        pingId: 7,
        mode: 'file',
        activity: 'paused',
        position: 0,
        trackIndex: 2,
      }),
    );
    expect(vi.mocked(conn.send).mock.calls[0][0]).not.toHaveProperty('appState');
  });

  it('emits decomposed playback fields for audible file playback', async () => {
    initSync();
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 3);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    expect(getSyncPongPlaybackState()).toMatchObject({
      mode: 'file',
      activity: 'playing',
    });

    const conn = makeConnection('guest-audible');
    await handleData({ type: MSG.SYNC_PING, pingId: 8 }, conn);

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PONG,
        pingId: 8,
        mode: 'file',
        activity: 'playing',
        position: 0,
        trackIndex: 3,
      }),
    );
    expect(vi.mocked(conn.send).mock.calls[0][0]).not.toHaveProperty('appState');
  });

  it('prefers decomposed mode/activity when deciding whether a sync pong is file playback', () => {
    expect(
      isSyncPongPlayingFile({
        appState: 'PLAYING_AUDIO',
        mode: 'youtube',
        activity: 'playing',
      }),
    ).toBe(false);

    expect(
      isSyncPongPlayingFile({
        appState: 'PAUSED',
        mode: 'file',
        activity: 'playing',
      }),
    ).toBe(true);
  });

  it('rejects legacy-only appState when decomposed sync fields are absent', () => {
    expect(isSyncPongPlayingFile({ appState: 'PLAYING_AUDIO' })).toBe(false);
    expect(isSyncPongPlayingFile({ appState: 'PAUSED' })).toBe(false);
  });

  it('exposes the paused file shadow for silent file transition pongs', () => {
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);

    expect(getSyncPongPlaybackState()).toEqual({
      mode: 'file',
      activity: 'paused',
    });
  });

  it('does not let a stale file lifecycle advertise new wire-visible playback', () => {
    setPlaybackIdle();
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);

    expect(getSyncPongPlaybackState()).toEqual({
      mode: 'file',
      activity: 'pending',
    });
  });
});

describe('audio activation bootstrap', () => {
  it('arms and cancels initial sync from playback mode/activity transitions', () => {
    vi.useFakeTimers();
    initSync();

    setState('playback.mode', 'file');
    expect(getManagedTimer('initial-sync-arm')).toBeNull();

    setState('playback.activity', 'playing');
    expect(getManagedTimer('initial-sync-arm')).not.toBeNull();

    setState('playback.activity', 'paused');
    expect(getManagedTimer('initial-sync-arm')).toBeNull();
  });
});

describe('background resume recovery', () => {
  it('drops stale shared-clock samples before forced resync ping', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();
    const conn = { open: true, send: vi.fn() } as Partial<DataConnection>;
    setState('network.hostConn', conn as DataConnection);

    registerPing(1);
    vi.setSystemTime(1020);
    expect(processSyncPong(1, 5020)).not.toBeNull();
    expect(isClockCalibrated()).toBe(true);
    expect(getClockOffset()).not.toBe(0);

    bus.emit('sync:force-resync');

    expect(isClockCalibrated()).toBe(false);
    expect(getClockOffset()).toBe(0);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PING,
        pingId: expect.any(Number),
      }),
    );
  });

  it('requests an immediate host sync for forced resync', () => {
    initSync();
    const conn = { open: true, send: vi.fn() } as Partial<DataConnection>;
    setState('network.hostConn', conn as DataConnection);

    bus.emit('sync:force-resync');

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PING,
        pingId: expect.any(Number),
      }),
    );
  });
});

describe('local-file sync correction', () => {
  async function deliverPlayingFilePong(
    conn: DataConnection,
    pingId: number,
    sentAtMs: number,
    hostPositionSec: number,
  ): Promise<void> {
    vi.setSystemTime(sentAtMs);
    registerPing(pingId);
    vi.setSystemTime(sentAtMs + 50);

    await handleData(
      {
        type: MSG.SYNC_PONG,
        pingId,
        hostTime: sentAtMs + 50,
        position: hostPositionSec,
        mode: 'file',
        activity: 'playing',
      },
      conn,
    );
  }

  it('does not seek a guest to the decoded track end while waiting for host repeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 10 } as AudioBuffer);

    registerPing(77);
    vi.setSystemTime(1050);

    await handleData(
      {
        type: MSG.SYNC_PONG,
        pingId: 77,
        hostTime: 1050,
        position: 9.96,
        mode: 'file',
        activity: 'playing',
      },
      hostConn,
    );

    expect(transportMocks.play).not.toHaveBeenCalled();
  });

  it('does not auto-resume a guest that locally paused (lock-screen pause)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    // Guest locally paused: file/paused (PAUSED lifecycle, not a decode state)
    // with a decoded buffer — without the flag the SYNC_PONG bootstrap resumes
    // it via getPlayableFileSyncPosition.
    setPlaybackLifecycleState(PLAYBACK_STATE.PAUSED);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);
    setLocalFilePaused(true);

    registerPing(88);
    vi.setSystemTime(1050);

    await handleData(
      {
        type: MSG.SYNC_PONG,
        pingId: 88,
        hostTime: 1050,
        position: 30,
        mode: 'file',
        activity: 'playing',
      },
      hostConn,
    );

    expect(transportMocks.play).not.toHaveBeenCalled();
  });

  it('still bootstraps a guest that has not locally paused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    // Identical to the case above except the local-pause flag is clear, so the
    // bootstrap must fire (proves the guard above is what suppresses it).
    setPlaybackLifecycleState(PLAYBACK_STATE.PAUSED);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);
    setLocalFilePaused(false);

    registerPing(89);
    vi.setSystemTime(1050);

    await handleData(
      {
        type: MSG.SYNC_PONG,
        pingId: 89,
        hostTime: 1050,
        position: 30,
        mode: 'file',
        activity: 'playing',
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalled();
  });

  it('soft-resyncs after three same-direction 50ms+ drift samples', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);

    // With a 50ms RTT sample and hostTime captured at receive time, the best
    // shared-clock offset is +25ms. Host position 0.040s therefore estimates
    // to 0.065s locally, while this jsdom transport has local position 0.
    await deliverPlayingFilePong(hostConn, 101, 1000, 0.04);
    await deliverPlayingFilePong(hostConn, 102, 2000, 0.04);
    expect(transportMocks.play).not.toHaveBeenCalled();

    await deliverPlayingFilePong(hostConn, 103, 3000, 0.04);

    expect(transportMocks.play).toHaveBeenCalledTimes(1);
    expect(transportMocks.play.mock.calls[0][0]).toBeCloseTo(0.065, 3);
  });

  it('suppresses repeated soft-resync attempts during the cooldown window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);

    await deliverPlayingFilePong(hostConn, 201, 1000, 0.04);
    await deliverPlayingFilePong(hostConn, 202, 2000, 0.04);
    await deliverPlayingFilePong(hostConn, 203, 3000, 0.04);
    expect(transportMocks.play).toHaveBeenCalledTimes(1);

    await deliverPlayingFilePong(hostConn, 204, 4000, 0.04);
    await deliverPlayingFilePong(hostConn, 205, 5000, 0.04);
    await deliverPlayingFilePong(hostConn, 206, 6000, 0.04);
    expect(transportMocks.play).toHaveBeenCalledTimes(1);

    await deliverPlayingFilePong(hostConn, 207, 14_000, 0.04);
    await deliverPlayingFilePong(hostConn, 208, 15_000, 0.04);
    await deliverPlayingFilePong(hostConn, 209, 16_000, 0.04);
    expect(transportMocks.play).toHaveBeenCalledTimes(2);
  });
});

describe('guest host connection clock reset', () => {
  function calibrateClockSample(): void {
    setState('sync.lastLatencyMs', 42);
    setState('sync.latencyHistory', [42]);
    registerPing(1);
    vi.setSystemTime(1020);
    expect(processSyncPong(1, 5020)).not.toBeNull();
    expect(isClockCalibrated()).toBe(true);
    expect(getClockOffset()).not.toBe(0);
  }

  function expectClockRuntimeReset(): void {
    expect(isClockCalibrated()).toBe(false);
    expect(getClockOffset()).toBe(0);
    expect(getState('sync.lastLatencyMs')).toBe(0);
    expect(getState('sync.latencyHistory')).toEqual([]);
  }

  it('clears shared clock samples when a guest hostConn closes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    initSync();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);

    calibrateClockSample();
    setState('network.hostConn', null);

    expectClockRuntimeReset();
  });

  it('clears shared clock samples when a guest hostConn is replaced', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    initSync();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);

    calibrateClockSample();
    setState('network.hostConn', { open: true } as DataConnection);

    expectClockRuntimeReset();
  });
});

// External sink contract: SYNC_PONG playback state matrix.
//
// Production state always passes through ownership writers, which normalize
// (mode, activity) via deriveModeActivityFromSources before any sink reads
// it. The matrix below enumerates the realistic production scenarios. Each
// row uses an ownership writer (or a source-event mutation that the bus
// bridge reconciles) so the resulting state matches what real users hit.
//
// A new playback mode/activity introduced by a future migration must add a
// row here; one that falls through to a wrong wire shape would let guests
// treat a non-playing host as playing (or vice versa). The file silent
// track-switch row guards the carve-out documented in
// network/sync.ts::getSyncPongPlaybackState.
describe('SYNC_PONG playback state (production scenario matrix)', () => {
  type Scenario = {
    label: string;
    setup: () => void;
    wire: { mode: string | null; activity: string };
    fileAcceptedByReceiver: boolean;
  };

  const SCENARIOS: Scenario[] = [
    {
      label: 'idle (fresh boot, nothing claimed)',
      setup: () => setPlaybackIdle(),
      wire: { mode: null, activity: 'idle' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'file playing with lifecycle PLAYING (audible)',
      setup: () => {
        setPlaybackFilePlaying();
        setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
      },
      wire: { mode: 'file', activity: 'playing' },
      fileAcceptedByReceiver: true,
    },
    {
      label: 'file playing during silent track switch (lifecycle DECODING)',
      setup: () => {
        // stopAllMedia({silent:true}) keeps mode/activity at file/playing
        // while a new track decodes; the wire must show paused so late-join
        // guests do not bootstrap to a stale position.
        setPlaybackFilePlaying();
        setPlaybackLifecycleState(PLAYBACK_STATE.DECODING);
        // The lifecycle write above flips activity to 'pending' via the
        // ownership bus bridge. Reclaim file/playing afterwards to mirror
        // the production sequence (claim first, lifecycle moves through
        // DECODING while activity stays 'playing').
        setPlaybackFilePlaying();
      },
      wire: { mode: 'file', activity: 'paused' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'file paused',
      setup: () => setPlaybackFilePaused(),
      wire: { mode: 'file', activity: 'paused' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'file pending (guest mid-download)',
      setup: () => setPlaybackLifecycleState(PLAYBACK_STATE.DOWNLOADING),
      wire: { mode: 'file', activity: 'pending' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'youtube playing',
      setup: () => setPlaybackYouTubePlaying(),
      wire: { mode: 'youtube', activity: 'playing' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'system-audio playing (host sharing or guest receiving)',
      setup: () => setPlaybackSystemAudioPlaying(),
      wire: { mode: 'system-audio', activity: 'playing' },
      fileAcceptedByReceiver: false,
    },
    {
      label: 'system-audio placeholder (host signalled start, guest stream not yet arrived)',
      setup: () => {
        setPlaybackTrackMeta(createSystemAudioTrackMeta('receiving'));
      },
      wire: { mode: 'system-audio', activity: 'pending' },
      fileAcceptedByReceiver: false,
    },
  ];

  for (const scenario of SCENARIOS) {
    it(`${scenario.label} -> wire { mode: ${scenario.wire.mode ?? 'null'}, activity: ${scenario.wire.activity} }`, () => {
      scenario.setup();

      const wire = getSyncPongPlaybackState();
      expect(wire.mode).toBe(scenario.wire.mode);
      expect(wire.activity).toBe(scenario.wire.activity);
    });
  }

  it('isSyncPongPlayingFile accepts only the audible file-playing wire shape', () => {
    // The receiving guard must accept only the deliberate file/playing wire
    // shape and reject every other scenario from the matrix.
    for (const scenario of SCENARIOS) {
      const result = isSyncPongPlayingFile(scenario.wire);
      expect(result).toBe(scenario.fileAcceptedByReceiver);
    }

    // Legacy payloads without mode/activity must also be rejected.
    expect(isSyncPongPlayingFile({})).toBe(false);
    expect(isSyncPongPlayingFile({ mode: 'file' })).toBe(false);
    expect(isSyncPongPlayingFile({ activity: 'playing' })).toBe(false);
  });
});
