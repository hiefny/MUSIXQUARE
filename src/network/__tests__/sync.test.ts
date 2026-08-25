/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
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
  getSharedClockDiagnostics,
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
import { grantStandardRoomAdministrator } from '../standard-room-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

type MockDataConnection = DataConnection & {
  send: Mock<(data: unknown) => void>;
  close: Mock<() => void>;
};

function mockDataConnection(peer = 'host'): MockDataConnection {
  return {
    peer,
    open: true,
    send: vi.fn<(data: unknown) => void>(),
    close: vi.fn<() => void>(),
    on: vi.fn(),
  };
}

function setActiveStandardHost(): void {
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
}

const transportMocks = vi.hoisted(() => ({
  play: vi.fn(),
}));
const zeroStartFacade = vi.hoisted(() => ({ active: false }));

vi.mock('../../player/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../player/transport.ts')>();
  return {
    ...actual,
    play: transportMocks.play,
  };
});

vi.mock('../../youtube/zero-start.ts', () => ({
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
}));

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  resetClockState();
  setCurrentAudioBuffer(null);
  bus.clear();
  resetInboundRateLimit('guest-1');
  transportMocks.play.mockReset();
  transportMocks.play.mockResolvedValue(true);
  zeroStartFacade.active = false;
  setLocalFilePaused(false);
});

afterEach(() => {
  clearAllManagedTimers();
  resetClockState();
  setCurrentAudioBuffer(null);
  vi.restoreAllMocks();
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

  it('rejects YouTube nudge and reset actions while zero-start owns the iframe', () => {
    initSync();
    const applySpy = vi.fn();
    bus.on('youtube:apply-manual-sync', applySpy);
    setPlaybackYouTubePlaying();
    setState('network.hostConn', { open: true } as DataConnection);
    setState('sync.youtubeLocalOffset', 0.25);
    zeroStartFacade.active = true;

    bus.emit('sync:nudge', 10);
    bus.emit('sync:auto-sync');

    expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('lets a PRO coordinator nudge its decoded local file without hostConn', () => {
    initSync();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'participant-0',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setPlaybackFilePlaying();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    bus.emit('sync:nudge', 10);

    expect(getState('sync.localOffset')).toBeCloseTo(0.01, 4);
  });

  it('lets an active standard host nudge only its decoded local file output', () => {
    initSync();
    setActiveStandardHost();
    setPlaybackFilePlaying();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    bus.emit('sync:nudge', 10);

    expect(getState('sync.localOffset')).toBeCloseTo(0.01, 4);
  });

  it('rejects a stale standard-host nudge before the room is active', () => {
    initSync();
    setState('network.appRole', 'host');
    setState('network.sessionCode', '123456');
    setPlaybackFilePlaying();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    bus.emit('sync:nudge', 10);

    expect(getState('sync.localOffset')).toBe(0);
  });

  it('keeps standard-host YouTube local nudge fail-closed at the canonical boundary', () => {
    initSync();
    const localApply = vi.fn();
    const guestApply = vi.fn();
    bus.on('youtube:set-coordinator-manual-offset', localApply);
    bus.on('youtube:apply-manual-sync', guestApply);
    setActiveStandardHost();
    setPlaybackYouTubePlaying();

    bus.emit('sync:nudge', 10);

    expect(localApply).not.toHaveBeenCalled();
    expect(guestApply).not.toHaveBeenCalled();
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
  });

  it('applies and resets a PRO coordinator YouTube nudge locally', () => {
    initSync();
    const coordinatorApply = vi.fn();
    const guestApply = vi.fn();
    bus.on('youtube:set-coordinator-manual-offset', coordinatorApply);
    bus.on('youtube:apply-manual-sync', guestApply);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'participant-0',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setPlaybackYouTubePlaying();

    bus.emit('sync:nudge', 10);

    // The iframe-side handler commits only the offset that can actually be
    // applied at media boundaries; this routing unit test observes the request.
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(coordinatorApply).toHaveBeenLastCalledWith(0.01);
    expect(guestApply).not.toHaveBeenCalled();

    bus.emit('sync:auto-sync');

    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(coordinatorApply).toHaveBeenLastCalledWith(0);
    expect(guestApply).not.toHaveBeenCalled();
  });
});

describe('SYNC_PING playback snapshot', () => {
  it('records transport liveness without replacing the global peer list', async () => {
    initSync();
    const conn = mockDataConnection('guest-liveness');
    const peer = {
      id: conn.peer,
      slot: 1,
      label: 'Guest',
      conn,
      isOp: false,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: 1,
    } satisfies ConnectedPeer;
    const connectedPeers = [peer];
    setState('network.connectedPeers', connectedPeers);

    await handleData({ type: MSG.SYNC_PING, pingId: 6 }, conn);

    expect(getState('network.connectedPeers')).toBe(connectedPeers);
    expect(getState('network.connectedPeers')[0]).toBe(peer);
    expect(conn.send).toHaveBeenCalledTimes(1);
  });

  it('does not advertise PLAYING_AUDIO while host is decoded but waiting to start', async () => {
    initSync();
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

    const conn = mockDataConnection('guest-audible');
    await handleData({ type: MSG.SYNC_PING, pingId: 7 }, conn);

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PONG,
        pingId: 7,
        mode: 'file',
        activity: 'paused',
        position: 0,
        queueItemId: QUEUE_ITEM_ID,
      }),
    );
    expect(conn.send.mock.calls[0][0]).not.toHaveProperty('appState');
  });

  it('emits decomposed playback fields for audible file playback', async () => {
    initSync();
    setPlaybackFilePlaying();
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    expect(getSyncPongPlaybackState()).toMatchObject({
      mode: 'file',
      activity: 'playing',
    });

    const conn = mockDataConnection('guest-audible');
    await handleData({ type: MSG.SYNC_PING, pingId: 8 }, conn);

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SYNC_PONG,
        pingId: 8,
        mode: 'file',
        activity: 'playing',
        position: 0,
        queueItemId: QUEUE_ITEM_ID,
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

describe('host heartbeat cleanup ordering', () => {
  it('fences a stale connection before close can synchronously report an error', () => {
    vi.useFakeTimers();
    const disconnected = vi.fn();
    bus.on('network:peer-disconnected', disconnected);
    const conn = {
      peer: 'guest-stale',
      open: true,
      send: vi.fn(),
      close: vi.fn(() => {
        expect(getState('network.activeHostConnByPeerId').has('guest-stale')).toBe(false);
        expect(getState('network.connectedPeers')).toHaveLength(0);
      }),
    } as unknown as DataConnection;
    const peer = {
      id: 'guest-stale',
      slot: 1,
      label: 'Peer 1',
      conn,
      isOp: false,
      preloadedQueueItemIds: new Set<string>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now() - 9000,
    } as ConnectedPeer;
    const slots = [...getState('network.peerSlots')];
    slots[1] = peer.id;
    setState('network.peerSlots', slots);
    setState('network.peerSlotByPeerId', new Map([[peer.id, 1]]));
    setState('network.peerLabels', { [peer.id]: peer.label });
    setState('network.connectedPeers', [peer]);
    setState('network.activeHostConnByPeerId', new Map([[peer.id, conn]]));
    setState('setup.sessionStarted', true);

    initSync();
    bus.emit('state:setup.sessionStarted', true, 'setup.sessionStarted');
    vi.advanceTimersByTime(5000);

    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith(peer.id);
    expect(getState('network.peerLabels')[peer.id]).toBeUndefined();
  });

  it('does not evict a background-suspended guest while its RTC transport is still live', () => {
    vi.useFakeTimers();
    const disconnected = vi.fn();
    bus.on('network:peer-disconnected', disconnected);
    const conn = {
      peer: 'guest-backgrounded',
      open: true,
      send: vi.fn(),
      close: vi.fn(),
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open' },
      controlChannel: { readyState: 'open' },
    } as unknown as DataConnection;
    const peer = {
      id: conn.peer,
      slot: 1,
      label: 'Background guest',
      conn,
      isOp: false,
      preloadedQueueItemIds: new Set<string>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now() - 9000,
    } as ConnectedPeer;
    const slots = [...getState('network.peerSlots')];
    slots[1] = peer.id;
    setState('network.peerSlots', slots);
    setState('network.peerSlotByPeerId', new Map([[peer.id, 1]]));
    setState('network.peerLabels', { [peer.id]: peer.label });
    setState('network.connectedPeers', [peer]);
    setState('network.activeHostConnByPeerId', new Map([[peer.id, conn]]));
    setState('setup.sessionStarted', true);

    initSync();
    bus.emit('state:setup.sessionStarted', true, 'setup.sessionStarted');
    vi.advanceTimersByTime(5000);

    expect(conn.close).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(getState('network.connectedPeers')).toHaveLength(1);

    // The grace remains bounded: a permanently silent zombie still releases
    // its room slot even if the browser never reports a terminal RTC state.
    vi.advanceTimersByTime(80_000);

    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith(peer.id);
    expect(getState('network.connectedPeers')).toHaveLength(0);
  });

  it('revokes only anonymous grants when stale connections bypass normal close handlers', () => {
    vi.useFakeTimers();
    const anonymousConn = mockDataConnection('anonymous-stale');
    const authenticatedConn = mockDataConnection('authenticated-stale');
    const authenticatedMemberId = 'member_abcdefghijklmnopqrstuv';
    const anonymousPeer = {
      id: anonymousConn.peer,
      slot: 1,
      label: 'Anonymous admin',
      conn: anonymousConn,
      isOp: true,
      isAuthenticated: false,
      preloadedQueueItemIds: new Set<string>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now() - 9000,
    } as ConnectedPeer;
    const authenticatedPeer = {
      ...anonymousPeer,
      id: authenticatedConn.peer,
      slot: 2,
      label: 'Account admin',
      conn: authenticatedConn,
      memberId: authenticatedMemberId,
      memberDisplayNumber: 1,
      isAuthenticated: true,
      joinOrder: 2,
    } as ConnectedPeer;
    const slots = [...getState('network.peerSlots')];
    slots[1] = anonymousPeer.id;
    slots[2] = authenticatedPeer.id;
    setState('network.peerSlots', slots);
    setState(
      'network.peerSlotByPeerId',
      new Map([
        [anonymousPeer.id, 1],
        [authenticatedPeer.id, 2],
      ]),
    );
    setState('network.peerLabels', {
      [anonymousPeer.id]: anonymousPeer.label,
      [authenticatedPeer.id]: authenticatedPeer.label,
    });
    setState('network.connectedPeers', [anonymousPeer, authenticatedPeer]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        [anonymousPeer.id, anonymousConn],
        [authenticatedPeer.id, authenticatedConn],
      ]),
    );
    grantStandardRoomAdministrator(anonymousPeer);
    grantStandardRoomAdministrator(authenticatedPeer);
    setState('setup.sessionStarted', true);

    initSync();
    bus.emit('state:setup.sessionStarted', true, 'setup.sessionStarted');
    vi.advanceTimersByTime(5000);

    expect(getState('network.standardRoomAdministrators').has('peer:anonymous-stale')).toBe(false);
    expect(getState('network.standardRoomAdministrators').has(authenticatedMemberId)).toBe(true);
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(anonymousConn.close).toHaveBeenCalledTimes(1);
    expect(authenticatedConn.close).toHaveBeenCalledTimes(1);
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
    expect(getSharedClockDiagnostics()).toMatchObject({
      calibrated: true,
      sampleCount: 1,
      pendingPingCount: 0,
      pongsReceived: 1,
      bestRttMs: 20,
    });

    bus.emit('sync:force-resync');

    expect(isClockCalibrated()).toBe(false);
    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({
      calibrated: false,
      sampleCount: 0,
      pendingPingCount: 1,
      pongsReceived: 0,
      bestRttMs: null,
      newestSampleAgeMs: null,
    });
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
  beforeEach(() => {
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  });

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
        queueItemId: QUEUE_ITEM_ID,
      },
      conn,
    );
  }

  it('does not seek a guest to the decoded track end while waiting for host repeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
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
        queueItemId: QUEUE_ITEM_ID,
      },
      hostConn,
    );

    expect(transportMocks.play).not.toHaveBeenCalled();
  });

  it('does not auto-resume a guest that locally paused (lock-screen pause)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
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
        queueItemId: QUEUE_ITEM_ID,
      },
      hostConn,
    );

    expect(transportMocks.play).not.toHaveBeenCalled();
  });

  it('still bootstraps a guest that has not locally paused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
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
        queueItemId: QUEUE_ITEM_ID,
      },
      hostConn,
    );

    expect(transportMocks.play).toHaveBeenCalled();
  });

  it('soft-resyncs after three same-direction 50ms+ drift samples', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
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

    const hostConn = mockDataConnection('host-1');
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

  it.each(['false', 'reject'] as const)(
    'keeps initial-sync retry ownership after a %s play result',
    async (failureMode) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      initSync();

      const hostConn = mockDataConnection('host-1');
      setState('network.hostConn', hostConn);
      setPlaybackFilePlaying();
      setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
      setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);
      const decisions: Array<{ decision: string; reason?: string }> = [];
      bus.on('sync:diagnostic-standard-decision', (decision) => decisions.push(decision));
      bus.emit('sync:arm-initial');
      await vi.advanceTimersByTimeAsync(1000);

      if (failureMode === 'false') {
        transportMocks.play.mockResolvedValueOnce(false);
      } else {
        transportMocks.play.mockRejectedValueOnce(new Error('source start failed'));
      }
      transportMocks.play.mockResolvedValueOnce(true);

      await deliverPlayingFilePong(hostConn, 301, 3000, 1);
      expect(decisions.some((decision) => decision.decision === 'initial')).toBe(false);
      expect(decisions.at(-1)?.reason).toBe(
        failureMode === 'false' ? 'play-not-started' : 'play-rejected',
      );

      await deliverPlayingFilePong(hostConn, 302, 4000, 1);

      expect(transportMocks.play).toHaveBeenCalledTimes(2);
      expect(decisions.filter((decision) => decision.decision === 'initial')).toHaveLength(1);
    },
  );

  it('retries a failed soft correction without consuming its samples or cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
    setState('network.hostConn', hostConn);
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);
    transportMocks.play.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await deliverPlayingFilePong(hostConn, 401, 1000, 0.04);
    await deliverPlayingFilePong(hostConn, 402, 2000, 0.04);
    await deliverPlayingFilePong(hostConn, 403, 3000, 0.04);
    expect(transportMocks.play).toHaveBeenCalledTimes(1);

    await deliverPlayingFilePong(hostConn, 404, 4000, 0.04);

    expect(transportMocks.play).toHaveBeenCalledTimes(2);
  });

  it('lets only the newest concurrent PONG commit initial-sync diagnostics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    initSync();

    const hostConn = mockDataConnection('host-1');
    setState('network.hostConn', hostConn);
    setPlaybackFilePlaying();
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setCurrentAudioBuffer({ duration: 300 } as AudioBuffer);
    const decisions: Array<{ decision: string; reason?: string }> = [];
    bus.on('sync:diagnostic-standard-decision', (decision) => decisions.push(decision));
    bus.emit('sync:arm-initial');
    await vi.advanceTimersByTimeAsync(1000);

    let releaseOlder!: (started: boolean) => void;
    const olderStart = new Promise<boolean>((resolve) => {
      releaseOlder = resolve;
    });
    transportMocks.play.mockReturnValueOnce(olderStart).mockResolvedValueOnce(true);

    const olderPong = deliverPlayingFilePong(hostConn, 501, 3000, 1);
    await vi.waitFor(() => expect(transportMocks.play).toHaveBeenCalledTimes(1));
    const newerPong = deliverPlayingFilePong(hostConn, 502, 4000, 2);
    await newerPong;
    releaseOlder(true);
    await olderPong;

    expect(decisions.filter((decision) => decision.decision === 'initial')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.reason === 'play-not-started')).toHaveLength(0);
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

function memberManagementPeer(
  id: string,
  conn: DataConnection,
  capabilities: ConnectedPeer['roomCapabilities'] = ['members.manage'],
): ConnectedPeer {
  return {
    id,
    slot: id === 'controller-member' ? 1 : 2,
    label: id,
    conn,
    isOp: true,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: id === 'controller-member' ? 1 : 2,
    connectionType: 'local',
    lastHeartbeat: Date.now(),
    roomCapabilities: capabilities,
  };
}

describe('standard owner-sibling chat control routing', () => {
  function openConnection(peer: string): DataConnection & { send: ReturnType<typeof vi.fn> } {
    return {
      peer,
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection & { send: ReturnType<typeof vi.fn> };
  }

  it('applies a verified room.configure request on the physical host', async () => {
    const sender = openConnection('owner-sibling');
    setState('network.appRole', 'host');
    setState('network.connectedPeers', [
      memberManagementPeer(sender.peer, sender, ['room.configure']),
    ]);
    setState('network.activeHostConnByPeerId', new Map([[sender.peer, sender]]));
    initSync();

    await handleData({ type: MSG.REQUEST_CHAT_COMMAND, command: 'freeze', args: ['on'] }, sender);

    expect(getState('network.chatFrozen')).toBe(true);
    expect(sender.send).toHaveBeenCalledWith({ type: MSG.CHAT_FREEZE });
  });

  it('rejects the same request without the projected owner capability', async () => {
    const sender = openConnection('ordinary-guest');
    setState('network.appRole', 'host');
    setState('network.connectedPeers', [memberManagementPeer(sender.peer, sender, [])]);
    setState('network.activeHostConnByPeerId', new Map([[sender.peer, sender]]));
    initSync();

    await handleData({ type: MSG.REQUEST_CHAT_COMMAND, command: 'freeze', args: ['on'] }, sender);

    expect(getState('network.chatFrozen')).toBe(false);
    expect(sender.send).not.toHaveBeenCalled();
  });
});

function configureProKickTopology(
  senderConn: DataConnection,
  targetConn: DataConnection,
  senderCapabilities: ConnectedPeer['roomCapabilities'] = ['members.manage'],
): void {
  setState('network.appRole', 'host');
  setState('network.myId', '000001');
  setState('network.sessionCode', '000001');
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'coordinator',
    coordinatorId: 'owner-participant',
    epoch: 4,
    snapshotRevision: 12,
    capabilities: ['members.manage'],
  });
  setState('network.connectedPeers', [
    memberManagementPeer('controller-member', senderConn, senderCapabilities),
    memberManagementPeer('target-member', targetConn),
  ]);
  setState(
    'network.activeHostConnByPeerId',
    new Map([
      ['controller-member', senderConn],
      ['target-member', targetConn],
    ]),
  );
}

function configureStandardKickTopology(
  senderConn: DataConnection,
  targetConn: DataConnection,
  senderOverrides: Partial<ConnectedPeer> = {},
  targetOverrides: Partial<ConnectedPeer> = {},
): void {
  setState('network.appRole', 'host');
  setState('network.myId', 'standard-host');
  setState('network.sessionCode', '123456');
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'standard-host',
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
  setState('network.connectedPeers', [
    {
      ...memberManagementPeer('controller-member', senderConn, ['members.manage']),
      memberId: 'member-controller',
      isAuthenticated: true,
      ...senderOverrides,
    },
    {
      ...memberManagementPeer('target-member', targetConn),
      memberId: 'member-target',
      isAuthenticated: true,
      ...targetOverrides,
    },
  ]);
  setState(
    'network.activeHostConnByPeerId',
    new Map([
      ['controller-member', senderConn],
      ['target-member', targetConn],
    ]),
  );
}

describe('PRO controller member kick requests', () => {
  function openConnection(peer: string): DataConnection {
    return { peer, open: true } as DataConnection;
  }

  it('lets an active authenticated PRO controller ask the coordinator to kick a live member', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureProKickTopology(senderConn, targetConn);
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);

    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith('target-member');
  });

  it('rejects a forged PRO sender without the server-projected capability', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureProKickTopology(senderConn, targetConn, ['playback.control']);
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);

    expect(kick).not.toHaveBeenCalled();
  });

  it('rejects a request from a replaced sender connection with the same peer id', async () => {
    const staleSender = openConnection('controller-member');
    const liveSender = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureProKickTopology(liveSender, targetConn);
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, staleSender);

    expect(kick).not.toHaveBeenCalled();
  });

  it.each(['controller-member', '000001', 'owner-participant'])(
    'rejects self or coordinator target %s',
    async (targetPeerId) => {
      const senderConn = openConnection('controller-member');
      const targetConn = openConnection('target-member');
      configureProKickTopology(senderConn, targetConn);
      initSync();
      const kick = vi.fn();
      bus.on('network:kick-device', kick);

      await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId }, senderConn);

      expect(kick).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown and stale target connections', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    const replacementTarget = openConnection('target-member');
    configureProKickTopology(senderConn, targetConn);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['controller-member', senderConn],
        ['target-member', replacementTarget],
      ]),
    );
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);
    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'unknown-member' }, senderConn);

    expect(kick).not.toHaveBeenCalled();
  });

  it('lets a delegated standard-room administrator request an ordinary member kick', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(senderConn, targetConn, {}, { isOp: false });
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);

    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith('target-member');
  });

  it('allows an exact physical disconnect of a verified same-account administrator sibling', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(
      senderConn,
      targetConn,
      { memberId: 'member-shared' },
      { memberId: 'member-shared' },
    );
    initSync();
    const memberKick = vi.fn();
    const physicalKick = vi.fn();
    bus.on('network:kick-device', memberKick);
    bus.on('network:kick-physical-device', physicalKick);

    await handleData(
      { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'target-member' },
      senderConn,
    );

    expect(physicalKick).toHaveBeenCalledTimes(1);
    expect(physicalKick).toHaveBeenCalledWith('target-member');
    expect(memberKick).not.toHaveBeenCalled();
  });

  it('keeps an account-wide kick of the current authenticated member blocked', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(
      senderConn,
      targetConn,
      { memberId: 'member-shared' },
      { memberId: 'member-shared' },
    );
    initSync();
    const memberKick = vi.fn();
    const physicalKick = vi.fn();
    bus.on('network:kick-device', memberKick);
    bus.on('network:kick-physical-device', physicalKick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);

    expect(memberKick).not.toHaveBeenCalled();
    expect(physicalKick).not.toHaveBeenCalled();
  });

  it('does not treat an unverified matching member id as ownership of another device', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(
      senderConn,
      targetConn,
      { memberId: 'member-unverified', isAuthenticated: false },
      { memberId: 'member-unverified', isAuthenticated: false },
    );
    initSync();
    const physicalKick = vi.fn();
    bus.on('network:kick-physical-device', physicalKick);

    await handleData(
      { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'target-member' },
      senderConn,
    );

    expect(physicalKick).not.toHaveBeenCalled();
  });

  it('does not let a standard-room administrator exactly disconnect another administrator', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(senderConn, targetConn);
    initSync();
    const physicalKick = vi.fn();
    bus.on('network:kick-physical-device', physicalKick);

    await handleData(
      { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'target-member' },
      senderConn,
    );

    expect(physicalKick).not.toHaveBeenCalled();
  });

  it.each(['controller-member', 'standard-host'])(
    'keeps the current sender and physical host protected from an exact disconnect: %s',
    async (targetPeerId) => {
      const senderConn = openConnection('controller-member');
      const targetConn = openConnection('target-member');
      configureStandardKickTopology(senderConn, targetConn);
      initSync();
      const physicalKick = vi.fn();
      bus.on('network:kick-physical-device', physicalKick);

      await handleData({ type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId }, senderConn);

      expect(physicalKick).not.toHaveBeenCalled();
    },
  );

  it('rejects a physical-device peer frame in PRO rooms so the server stays authoritative', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureProKickTopology(senderConn, targetConn);
    initSync();
    const physicalKick = vi.fn();
    bus.on('network:kick-physical-device', physicalKick);

    await handleData(
      { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'target-member' },
      senderConn,
    );

    expect(physicalKick).not.toHaveBeenCalled();
  });

  it('does not let a delegated standard-room administrator kick another administrator', async () => {
    const senderConn = openConnection('controller-member');
    const targetConn = openConnection('target-member');
    configureStandardKickTopology(senderConn, targetConn);
    initSync();
    const kick = vi.fn();
    bus.on('network:kick-device', kick);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'target-member' }, senderConn);

    expect(kick).not.toHaveBeenCalled();
  });
});
