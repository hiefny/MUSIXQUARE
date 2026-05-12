/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
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
import { setCurrentAudioBuffer } from '../../player/_state.ts';
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

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  resetClockState();
  setCurrentAudioBuffer(null);
  bus.clear();
  resetInboundRateLimit('guest-1');
});

afterEach(() => {
  clearAllManagedTimers();
  resetClockState();
  setCurrentAudioBuffer(null);
  vi.useRealTimers();
});

function makeConnectedPeer(conn: Partial<DataConnection>, lastHeartbeat: number): ConnectedPeer {
  return {
    id: 'guest-1',
    slot: 1,
    label: 'GUEST',
    conn: conn as DataConnection,
    isOp: false,
    preloadedIndexes: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'remote',
    lastHeartbeat,
  };
}

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
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playlist.currentTrackIndex', 2);

    const conn = { peer: 'guest-audible', open: true, send: vi.fn() } as DataConnection;
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
    expect(conn.send.mock.calls[0][0]).not.toHaveProperty('appState');
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

    const conn = { peer: 'guest-audible', open: true, send: vi.fn() } as DataConnection;
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
    expect(conn.send.mock.calls[0][0]).not.toHaveProperty('appState');
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

  it('requests a fresh host sync when a guest unlocks audio with a decoded buffer', () => {
    initSync();
    const conn = { open: true, send: vi.fn() } as Partial<DataConnection>;
    setState('network.hostConn', conn as DataConnection);
    setCurrentAudioBuffer({ duration: 30 } as AudioBuffer);

    bus.emit('audio:activated');

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PING,
        pingId: expect.any(Number),
      }),
    );
  });
});

describe('background resume recovery', () => {
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

describe('host heartbeat monitor', () => {
  it('keeps a heartbeat-stale peer while the transport is still open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T00:00:00.000Z'));

    const conn = {
      peer: 'guest-1',
      open: true,
      close: vi.fn(),
      send: vi.fn(),
      peerConnection: { connectionState: 'connected' },
    } as Partial<DataConnection>;
    const peer = makeConnectedPeer(conn, Date.now() - 46_000);
    setState('network.connectedPeers', [peer]);
    setState('network.activeHostConnByPeerId', new Map([['guest-1', conn as DataConnection]]));

    initSync();
    setState('setup.sessionStarted', true);
    vi.advanceTimersByTime(10_000);

    expect(getState('network.connectedPeers')).toEqual([peer]);
    expect(conn.close).not.toHaveBeenCalled();
  });

  it('cleans up a heartbeat-stale peer when the transport has failed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T00:00:00.000Z'));

    const conn = {
      peer: 'guest-1',
      open: true,
      close: vi.fn(),
      send: vi.fn(),
      peerConnection: { connectionState: 'failed' },
    } as Partial<DataConnection>;
    setState('network.connectedPeers', [makeConnectedPeer(conn, Date.now() - 46_000)]);
    setState('network.activeHostConnByPeerId', new Map([['guest-1', conn as DataConnection]]));

    initSync();
    setState('setup.sessionStarted', true);
    vi.advanceTimersByTime(10_000);

    expect(getState('network.connectedPeers')).toEqual([]);
    expect(getState('network.activeHostConnByPeerId').has('guest-1')).toBe(false);
    expect(conn.close).toHaveBeenCalledTimes(1);
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
