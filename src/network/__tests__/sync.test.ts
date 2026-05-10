/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { APP_STATE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { getTotalSyncOffsetMs, handleAutoSync, initSync } from '../sync.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  setCurrentAudioBuffer(null);
  bus.clear();
});

afterEach(() => {
  clearAllManagedTimers();
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

describe('audio activation bootstrap', () => {
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
