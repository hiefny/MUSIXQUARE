/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const v2 = vi.hoisted(() => {
  const state: {
    room: unknown;
    renderer: unknown;
    position: unknown;
    terminal: unknown;
  } = {
    room: null,
    renderer: null,
    position: null,
    terminal: null,
  };
  return {
    state,
    runtime: {
      enabled: vi.fn(() => true),
      hostRoomSnapshot: vi.fn(() => state.room),
      seekPlaying: vi.fn(),
      seekPaused: vi.fn(),
      pauseCurrent: vi.fn(),
      resumeCurrent: vi.fn(),
      stopCurrent: vi.fn(),
      settleEndedCurrent: vi.fn(),
      startLocalTrack: vi.fn(),
      replayCurrent: vi.fn(),
      currentHostRendererSnapshot: vi.fn(() => state.renderer),
      currentHostTerminalRendererObservation: vi.fn(() => state.terminal),
    },
  };
});

vi.mock('../file-playback-engine-gate.ts', () => ({
  isFilePlaybackEngineV2Enabled: () => true,
}));

vi.mock('../file-playback-product-runtime.ts', () => ({
  getFilePlaybackProductRuntime: () => v2.runtime,
}));

vi.mock('../file-playback-runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-playback-runtime.ts')>();
  return {
    ...actual,
    getActiveFilePlaybackSnapshot: vi.fn(() => v2.state.renderer),
    getManagedFilePlaybackPosition: vi.fn((queueItemId: string) => {
      const position = v2.state.position as { readonly queueItemId?: unknown } | null;
      return position?.queueItemId === queueItemId ? position : null;
    }),
    hasPlayableFileSource: vi.fn(() => true),
  };
});

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
}));

import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, sendToHost } from '../../network/peer.ts';
import { handleData } from '../../network/protocol.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  QueueItemId,
} from '../../types/index.ts';
import { isPlayLocked, setCurrentAudioBuffer, setPlayerNode } from '../_state.ts';
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackSystemAudioPlaying,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';
import { initPlayback } from '../playback.ts';
import { initPlaylist, playNextTrack, playTrack } from '../playlist.ts';
import {
  adjustSync,
  getTrackPosition,
  pause,
  play,
  seekTo,
  skipTime,
  stopAllMediaAsync,
  stopPlayback,
  handleEnded,
  togglePlay,
} from '../transport.ts';

const Q1 = '99000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '99000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_ID = 'transport-v2-run-1';

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function room(applicationSessionId = 'transport-v2-session-1') {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: applicationSessionId.endsWith('-2') ? 2 : 1,
    applicationSessionId,
    hostParticipantId: 'transport-v2-host',
  });
}

function sourceSnapshot(
  phase: 'playing' | 'paused',
  revision: number,
  positionSeconds: number,
  durationSeconds = 120,
  queueItemId = Q1,
  runId = RUN_ID,
) {
  const run = freezeCanonical({ queueItemId, runId, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    queueItemId,
    backend: 'audio-buffer' as const,
    phase,
    revision,
    run,
    durationSeconds,
    positionSeconds,
    bufferedAheadSeconds: 8,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
}

function positionProjection(
  phase: 'playing' | 'paused',
  revision: number,
  positionSeconds: number,
  queueItemId = Q1,
  runId = RUN_ID,
) {
  return freezeCanonical({
    queueItemId,
    run: freezeCanonical({ queueItemId, runId, revision }),
    phase,
    positionSeconds,
    bufferedAheadSeconds: 8,
    underrunCount: 0,
  });
}

function publishProjection(
  phase: 'playing' | 'paused',
  revision: number,
  positionSeconds: number,
  durationSeconds = 120,
): void {
  v2.state.renderer = sourceSnapshot(phase, revision, positionSeconds, durationSeconds);
  v2.state.position = positionProjection(phase, revision, positionSeconds);
}

function playingCommit(positionSeconds: number, revision: number) {
  const run = freezeCanonical({ queueItemId: Q1, runId: RUN_ID });
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    backend: 'audio-buffer' as const,
    asset: freezeCanonical({ queueItemId: Q1 }),
    attempt: freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision }),
    schedule: freezeCanonical({ positionSeconds }),
    startEvidence: freezeCanonical({ kind: 'webaudio-schedule-passed' as const }),
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'playing' as const,
      revision,
      run,
      positionSeconds,
      anchorMonotonicMs: 1_000,
      rate: 1,
    }),
  });
}

function pausedCommit(positionSeconds: number, revision: number) {
  const run = freezeCanonical({ queueItemId: Q1, runId: RUN_ID });
  const from = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision: revision - 1 });
  const to = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    kind: 'seek' as const,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    evidence: freezeCanonical({
      kind: 'seek-applied' as const,
      from,
      to,
      positionSeconds,
    }),
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'paused' as const,
      revision,
      run,
      positionSeconds,
      anchorMonotonicMs: 1_000,
      rate: 1,
    }),
  });
}

function pauseCommit(positionSeconds: number, revision: number) {
  const run = freezeCanonical({ queueItemId: Q1, runId: RUN_ID });
  const from = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision: revision - 1 });
  const to = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    kind: 'pause' as const,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    evidence: freezeCanonical({
      kind: 'pause-applied' as const,
      from,
      to,
    }),
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'paused' as const,
      revision,
      run,
      positionSeconds,
      anchorMonotonicMs: 1_000,
      rate: 1,
    }),
  });
}

function stoppedCommit(kind: 'stop' | 'ended', revision: number) {
  const from = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision: revision - 1 });
  const to = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  const evidence =
    kind === 'stop'
      ? freezeCanonical({
          kind: 'stop-applied' as const,
          observation: 'webaudio-schedule-passed' as const,
          from,
          to,
          targetFrame: 48_000,
          appliedFrame: 48_000,
        })
      : freezeCanonical({
          kind: 'ended-renderer-retired' as const,
          from,
          to,
          observedAtRoomTimeMs: 2_000,
        });
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    kind,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    evidence,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'stopped' as const,
      revision,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 2_000,
      rate: 0,
    }),
  });
}

function terminalSnapshot(revision: number, positionSeconds = 120) {
  const run = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    queueItemId: Q1,
    backend: 'audio-buffer' as const,
    phase: 'ended' as const,
    revision,
    run,
    durationSeconds: 120,
    positionSeconds,
    bufferedAheadSeconds: 0,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
}

function playlistTrackCommit(queueItemId: QueueItemId, revision: number) {
  const runId = `playlist-run-${revision}`;
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    backend: 'audio-buffer' as const,
    asset: freezeCanonical({ queueItemId }),
    attempt: freezeCanonical({ queueItemId, runId, revision }),
    schedule: freezeCanonical({ positionSeconds: 0 }),
    startEvidence: freezeCanonical({ kind: 'webaudio-schedule-passed' as const }),
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'playing' as const,
      revision,
      run: freezeCanonical({ queueItemId, runId }),
      positionSeconds: 0,
      anchorMonotonicMs: 3_000,
      rate: 1,
    }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 48): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function fileItem(queueItemId = Q1): PlaylistItem {
  const file = new File(['audio'], 'transport-v2.mp3', { type: 'audio/mpeg' });
  return {
    queueItemId,
    type: 'file',
    name: file.name,
    title: 'Transport V2',
    videoId: null,
    playlistId: null,
    file,
  };
}

function setSelectedFile(): void {
  setState('playlist.items', [fileItem()]);
  setState('playlist.currentQueueItemId', Q1);
}

function setPlaying(positionSeconds = 5, revision = 1, durationSeconds = 120): void {
  publishProjection('playing', revision, positionSeconds, durationSeconds);
  setPlaybackFilePlaying();
  setState('player.pausedAt', positionSeconds);
}

function setPaused(positionSeconds = 5, revision = 1, durationSeconds = 120): void {
  publishProjection('paused', revision, positionSeconds, durationSeconds);
  setPlaybackFilePaused();
  setState('player.pausedAt', positionSeconds);
}

function operatorConnection(): DataConnection {
  const conn = {
    peer: 'transport-v2-op',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  const peer: ConnectedPeer = {
    id: conn.peer,
    slot: 1,
    label: 'OP',
    conn,
    isOp: true,
    preloadedQueueItemIds: new Set<QueueItemId>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: Date.now(),
  };
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
  return conn;
}

beforeEach(async () => {
  await drainMicrotasks();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  v2.state.room = room();
  v2.state.renderer = null;
  v2.state.position = null;
  v2.state.terminal = null;
  v2.runtime.hostRoomSnapshot.mockImplementation(() => v2.state.room);
  v2.runtime.seekPlaying.mockImplementation(async ({ positionSeconds }) => {
    const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
    const revision = current.revision + 1;
    const commit = playingCommit(positionSeconds, revision);
    publishProjection('playing', revision, positionSeconds, current.durationSeconds ?? 120);
    return commit;
  });
  v2.runtime.seekPaused.mockImplementation(async ({ positionSeconds }) => {
    const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
    const revision = current.revision + 1;
    const commit = pausedCommit(positionSeconds, revision);
    publishProjection('paused', revision, positionSeconds, current.durationSeconds ?? 120);
    return commit;
  });
  v2.runtime.pauseCurrent.mockImplementation(async () => {
    const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
    const revision = current.revision + 1;
    const positionSeconds = (v2.state.position as ReturnType<typeof positionProjection>)
      .positionSeconds;
    const commit = pauseCommit(positionSeconds, revision);
    publishProjection('paused', revision, positionSeconds, current.durationSeconds ?? 120);
    return commit;
  });
  v2.runtime.resumeCurrent.mockImplementation(async () => {
    const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
    const revision = current.revision + 1;
    const positionSeconds = (v2.state.position as ReturnType<typeof positionProjection>)
      .positionSeconds;
    const commit = playingCommit(positionSeconds, revision);
    publishProjection('playing', revision, positionSeconds, current.durationSeconds ?? 120);
    return commit;
  });
  v2.runtime.stopCurrent.mockImplementation(async () => {
    const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
    const commit = stoppedCommit('stop', current.revision + 1);
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = null;
    return commit;
  });
  v2.runtime.settleEndedCurrent.mockImplementation(async () => {
    const current = v2.state.terminal as ReturnType<typeof terminalSnapshot>;
    const commit = stoppedCommit('ended', current.revision + 1);
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = null;
    return commit;
  });
  setSelectedFile();
});

describe('V2 host-local file transport seek boundary', () => {
  it('projects track position exclusively from the exact product run', () => {
    setPlaying(12.5);
    setState('player.startedAt', 1);
    setState('player.pausedAt', 91);
    setCurrentAudioBuffer({ duration: 999 } as AudioBuffer);

    expect(getTrackPosition()).toBe(12.5);
  });

  it('fails closed when product projection is missing or belongs to another occurrence', async () => {
    setPlaybackFilePlaying();
    setState('player.pausedAt', 77);
    setCurrentAudioBuffer({ duration: 999 } as AudioBuffer);
    const stop = vi.fn();
    const disconnect = vi.fn();
    setPlayerNode({
      stop,
      disconnect,
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);
    v2.state.renderer = sourceSnapshot('playing', 1, 50, 120, Q2);
    v2.state.position = positionProjection('playing', 1, 50, Q2);

    expect(getTrackPosition()).toBe(0);
    seekTo(30);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(77);
    expect(broadcast).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('commits a playing seek before publishing compatibility position', async () => {
    setPlaying(5);
    const stop = vi.fn();
    const disconnect = vi.fn();
    setPlayerNode({
      stop,
      disconnect,
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);

    seekTo(30);
    expect(getState('player.pausedAt')).toBe(5);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).toHaveBeenCalledWith({
      positionSeconds: 30,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(30);
    expect(stop).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('uses the paused transition without any legacy PAUSE publication', async () => {
    setPaused(8);

    seekTo(44);
    expect(getState('player.pausedAt')).toBe(8);
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).toHaveBeenCalledWith({
      positionSeconds: 44,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(44);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('pauses through the product transition before publishing semantic state', async () => {
    setPlaying(12);
    const stop = vi.fn();
    const disconnect = vi.fn();
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    setPlayerNode({
      stop,
      disconnect,
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);

    pause(undefined, { showToast: false });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(12);
    await drainMicrotasks();

    expect(v2.runtime.pauseCurrent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(12);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(isPlayLocked()).toBe(false);
    expect(hold).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('resumes the same paused position without an intermediate seek', async () => {
    setPaused(18);
    const visualizer = vi.fn();
    const loop = vi.fn();
    bus.on('visualizer:start', visualizer);
    bus.on('ui:loop-start', loop);

    await play(18);
    expect(getState('playback.activity')).toBe('paused');
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(18);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(isPlayLocked()).toBe(false);
    expect(visualizer).toHaveBeenCalledOnce();
    expect(loop).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('seeks a different paused position, re-reads its revision, then resumes', async () => {
    setPaused(8);

    await play(42);
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).toHaveBeenCalledWith({
      positionSeconds: 42,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledWith({
      signal: v2.runtime.seekPaused.mock.calls[0]?.[0].signal,
    });
    expect((v2.state.renderer as ReturnType<typeof sourceSnapshot>).revision).toBe(3);
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(42);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('toggles product playing to paused and paused back to playing', async () => {
    setPlaying(11);

    togglePlay();
    await drainMicrotasks();
    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');

    togglePlay();
    await drainMicrotasks();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('publishes stop semantics only after the exact product stop commit', async () => {
    setPlaying(12);
    const pending = deferred<ReturnType<typeof stoppedCommit>>();
    const nodeStop = vi.fn();
    const disconnect = vi.fn();
    const seekReset = vi.fn();
    bus.on('ui:seek-reset', seekReset);
    setPlayerNode({
      stop: nodeStop,
      disconnect,
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);
    v2.runtime.stopCurrent.mockImplementationOnce(() => pending.promise);

    stopPlayback();
    await drainMicrotasks();
    expect(v2.runtime.stopCurrent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(12);
    expect(seekReset).not.toHaveBeenCalled();

    v2.state.renderer = null;
    v2.state.position = null;
    pending.resolve(stoppedCommit('stop', 2));
    await drainMicrotasks();

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
    expect(seekReset).toHaveBeenCalledOnce();
    expect(nodeStop).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('lets an ordered cross-mode caller continue only after product stop settles', async () => {
    setPlaying(7);
    const pending = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pending.promise);

    let continued = false;
    const ordered = stopAllMediaAsync({ silent: true }).then((stopped) => {
      continued = stopped;
    });
    await drainMicrotasks();
    expect(continued).toBe(false);
    expect(getState('playback.activity')).toBe('playing');

    v2.state.renderer = null;
    v2.state.position = null;
    pending.resolve(stoppedCommit('stop', 2));
    await ordered;

    expect(continued).toBe(true);
    expect(getState('playback.activity')).toBe('idle');
  });

  it('keeps a selected row authoritative until its exact V2 stop commits before removal', async () => {
    setPlaying(9);
    const pending = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pending.promise);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [Q1]);
    await drainMicrotasks();
    expect(v2.runtime.stopCurrent).toHaveBeenCalledOnce();
    expect(getState('playlist.items')).toHaveLength(1);
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);

    v2.state.renderer = null;
    v2.state.position = null;
    pending.resolve(stoppedCommit('stop', 2));
    await drainMicrotasks();

    expect(getState('playlist.items')).toHaveLength(0);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('does not start a newly selected local file before the prior V2 stop commits', async () => {
    const next = fileItem(Q2);
    setState('playlist.items', [fileItem(Q1), next]);
    setState('playlist.currentQueueItemId', Q1);
    setPlaying(4);
    const pendingStop = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pendingStop.promise);
    v2.runtime.startLocalTrack.mockResolvedValueOnce(playlistTrackCommit(Q2, 3));

    const pendingPlay = playTrack(Q2);
    await drainMicrotasks();
    expect(v2.runtime.stopCurrent).toHaveBeenCalledOnce();
    expect(v2.runtime.startLocalTrack).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);

    v2.state.renderer = null;
    v2.state.position = null;
    pendingStop.resolve(stoppedCommit('stop', 2));
    await pendingPlay;

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q2,
      file: next.file,
      positionSeconds: 0,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playlist.currentQueueItemId')).toBe(Q2);
    expect(getState('playback.activity')).toBe('playing');
  });

  it('cancels a not-yet-committed local start when stop is requested from product idle', async () => {
    const next = fileItem(Q2);
    setState('playlist.items', [fileItem(Q1), next]);
    setState('playlist.currentQueueItemId', Q1);
    const pendingStart = deferred<ReturnType<typeof playlistTrackCommit>>();
    let startSignal: AbortSignal | null = null;
    v2.runtime.startLocalTrack.mockImplementationOnce((options: { signal: AbortSignal }) => {
      startSignal = options.signal;
      return pendingStart.promise;
    });
    initPlaylist();

    const pendingPlay = playTrack(Q2);
    await drainMicrotasks();
    expect(startSignal?.aborted).toBe(false);

    stopPlayback();
    expect(startSignal?.aborted).toBe(true);
    pendingStart.reject(new Error('start cancelled'));
    await pendingPlay;

    expect(v2.runtime.stopCurrent).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(getState('playback.activity')).toBe('idle');
  });

  it('serializes a rapid seek then stop from the physical seek revision', async () => {
    setPlaying(5);
    const pendingSeek = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.seekPlaying.mockImplementationOnce(() => pendingSeek.promise);

    seekTo(25);
    await drainMicrotasks();
    const seekSignal = v2.runtime.seekPlaying.mock.calls[0]?.[0].signal as AbortSignal;
    stopPlayback();
    expect(seekSignal.aborted).toBe(true);
    expect(v2.runtime.stopCurrent).not.toHaveBeenCalled();

    publishProjection('playing', 2, 25);
    pendingSeek.resolve(playingCommit(25, 2));
    await drainMicrotasks();

    expect(v2.runtime.stopCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reconciles a physically committed stop superseded by seek, pause, and play', async () => {
    setPlaying(5);
    const pendingStop = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pendingStop.promise);

    stopPlayback();
    await drainMicrotasks();
    const stopSignal = v2.runtime.stopCurrent.mock.calls[0]?.[0].signal as AbortSignal;
    seekTo(30);
    pause(undefined, { showToast: false });
    await play(30);
    expect(stopSignal.aborted).toBe(true);

    v2.state.renderer = null;
    v2.state.position = null;
    pendingStop.resolve(stoppedCommit('stop', 2));
    await drainMicrotasks();

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('deduplicates one exact natural-end observation and advances only after settlement', async () => {
    setPlaybackFilePlaying();
    setState('player.pausedAt', 120);
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = terminalSnapshot(1);
    const pending = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.settleEndedCurrent.mockImplementationOnce(() => pending.promise);
    const ended = vi.fn();
    bus.on('player:ended', ended);

    handleEnded();
    handleEnded();
    await drainMicrotasks();
    expect(v2.runtime.settleEndedCurrent).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('playing');

    v2.state.terminal = null;
    pending.resolve(stoppedCommit('ended', 2));
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('idle');
    expect(ended).toHaveBeenCalledOnce();
    handleEnded();
    await drainMicrotasks();
    expect(v2.runtime.settleEndedCurrent).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('treats an explicit stop at the terminal renderer as stop, not auto-advance', async () => {
    setPlaybackFilePlaying();
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = terminalSnapshot(9);
    const ended = vi.fn();
    bus.on('player:ended', ended);

    stopPlayback();
    await drainMicrotasks();

    expect(v2.runtime.stopCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.settleEndedCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('idle');
    expect(ended).not.toHaveBeenCalled();
  });

  it('does not advance when exact natural-end settlement fails', async () => {
    setPlaybackFilePlaying();
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = terminalSnapshot(7);
    v2.runtime.settleEndedCurrent.mockRejectedValueOnce(new Error('retirement failed'));
    const ended = vi.fn();
    bus.on('player:ended', ended);

    handleEnded();
    await drainMicrotasks();

    expect(v2.runtime.settleEndedCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
    expect(ended).not.toHaveBeenCalled();
  });

  it('ends the V2 playlist only after stopped truth and never broadcasts legacy PAUSE', async () => {
    setPlaying(5);
    setState('playlist.repeatMode', 0);
    setState('playlist.isShuffle', false);
    const pending = deferred<ReturnType<typeof stoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pending.promise);

    playNextTrack();
    await drainMicrotasks();
    expect(v2.runtime.stopCurrent).toHaveBeenCalledOnce();
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);

    v2.state.renderer = null;
    v2.state.position = null;
    pending.resolve(stoppedCommit('stop', 2));
    await drainMicrotasks();

    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PAUSE, endOfPlaylist: true }),
    );
  });

  it('fails closed for pause, resume, and toggle when the selected renderer is missing', async () => {
    setPlaybackFilePlaying();
    setState('player.pausedAt', 15);
    const stop = vi.fn();
    setPlayerNode({
      stop,
      disconnect: vi.fn(),
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);

    pause(undefined, { showToast: false });
    await play(15);
    togglePlay();
    await drainMicrotasks();

    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(15);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not reinterpret a stopped selected occurrence as playlist restart', async () => {
    setPlaybackFilePaused();
    setState('player.pausedAt', 0);

    togglePlay();
    await drainMicrotasks();

    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not publish a pause whose commit revision mismatches the physical projection', async () => {
    setPlaying(10);
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    v2.runtime.pauseCurrent.mockImplementationOnce(async () => {
      publishProjection('paused', 2, 10);
      return pauseCommit(10, 3);
    });

    pause(undefined, { showToast: false });
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(10);
    expect(hold).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not publish a resume whose commit revision mismatches the physical projection', async () => {
    setPaused(10);
    const visualizer = vi.fn();
    bus.on('visualizer:start', visualizer);
    v2.runtime.resumeCurrent.mockImplementationOnce(async () => {
      publishProjection('playing', 2, 10);
      return playingCommit(10, 3);
    });

    await play(10);
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(10);
    expect(visualizer).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('lets a rapid play intent recover from an aborted but physically committed pause', async () => {
    setPlaying(5);
    const pauseGate = deferred<ReturnType<typeof pauseCommit>>();
    const resumeGate = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.pauseCurrent.mockImplementationOnce(() => pauseGate.promise);
    v2.runtime.resumeCurrent.mockImplementationOnce(() => resumeGate.promise);

    pause(undefined, { showToast: false });
    await drainMicrotasks();
    const pauseSignal = v2.runtime.pauseCurrent.mock.calls[0]?.[0].signal as AbortSignal;
    await play(5);
    expect(pauseSignal.aborted).toBe(true);
    await drainMicrotasks();
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();

    publishProjection('paused', 2, 5);
    pauseGate.resolve(pauseCommit(5, 2));
    await drainMicrotasks();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');

    publishProjection('playing', 3, 5);
    resumeGate.resolve(playingCommit(5, 3));
    await drainMicrotasks();
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(5);
  });

  it('re-reads a physical pause before applying a superseding seek', async () => {
    setPlaying(5);
    const pauseGate = deferred<ReturnType<typeof pauseCommit>>();
    v2.runtime.pauseCurrent.mockImplementationOnce(() => pauseGate.promise);

    pause(undefined, { showToast: false });
    await drainMicrotasks();
    seekTo(30);
    publishProjection('paused', 2, 5);
    pauseGate.resolve(pauseCommit(5, 2));
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).toHaveBeenCalledWith({
      positionSeconds: 30,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(30);
  });

  it('re-reads a physical paused seek before applying a superseding play', async () => {
    setPaused(5);
    const seekGate = deferred<ReturnType<typeof pausedCommit>>();
    v2.runtime.seekPaused.mockImplementationOnce(() => seekGate.promise);

    seekTo(20);
    await drainMicrotasks();
    await play(20);
    publishProjection('paused', 2, 20);
    seekGate.resolve(pausedCommit(20, 2));
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).toHaveBeenCalledOnce();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(20);
  });

  it('serializes supersession and resolves a relative skip from the physical predecessor', async () => {
    setPlaying(5);
    const first = deferred<ReturnType<typeof playingCommit>>();
    const second = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.seekPlaying
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    seekTo(20);
    await drainMicrotasks();
    const firstSignal = v2.runtime.seekPlaying.mock.calls[0]?.[0].signal as AbortSignal;
    skipTime(10);

    expect(firstSignal.aborted).toBe(true);
    await drainMicrotasks();
    expect(v2.runtime.seekPlaying).toHaveBeenCalledTimes(1);

    publishProjection('playing', 2, 20);
    first.resolve(playingCommit(20, 2));
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).toHaveBeenCalledTimes(2);
    expect(v2.runtime.seekPlaying.mock.calls[1]?.[0].positionSeconds).toBe(30);
    expect(getState('player.pausedAt')).toBe(5);

    publishProjection('playing', 3, 30);
    second.resolve(playingCommit(30, 3));
    await drainMicrotasks();

    expect(getState('player.pausedAt')).toBe(30);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('clamps skip to the product duration without consulting AudioBuffer', async () => {
    setPlaying(95, 1, 100);
    setCurrentAudioBuffer({ duration: 1_000 } as AudioBuffer);

    skipTime(10);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying.mock.calls[0]?.[0].positionSeconds).toBeCloseTo(99.9, 8);
    expect(getState('player.pausedAt')).toBeCloseTo(99.9, 8);
  });

  it('keeps a stale post-commit room completion inert', async () => {
    setPlaying(5);
    const pending = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.seekPlaying.mockImplementationOnce(() => pending.promise);
    seekTo(40);
    await drainMicrotasks();

    const oldCommit = playingCommit(40, 2);
    publishProjection('playing', 2, 40);
    v2.state.room = room('transport-v2-session-2');
    pending.resolve(oldCommit);
    await drainMicrotasks();

    expect(getState('player.pausedAt')).toBe(5);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(['queueItemId', 'runId', 'revision', 'phase'] as const)(
    'keeps a post-commit %s projection mismatch inert',
    async (kind) => {
      setPlaying(5);
      const pending = deferred<ReturnType<typeof playingCommit>>();
      v2.runtime.seekPlaying.mockImplementationOnce(() => pending.promise);
      seekTo(40);
      await drainMicrotasks();

      const commit = playingCommit(40, 2);
      if (kind === 'queueItemId') {
        v2.state.renderer = sourceSnapshot('playing', 2, 40, 120, Q2);
        v2.state.position = positionProjection('playing', 2, 40, Q2);
      } else if (kind === 'runId') {
        v2.state.renderer = sourceSnapshot('playing', 2, 40, 120, Q1, 'stale-run');
        v2.state.position = positionProjection('playing', 2, 40, Q1, 'stale-run');
      } else if (kind === 'revision') {
        publishProjection('playing', 3, 40);
      } else {
        publishProjection('paused', 2, 40);
      }
      pending.resolve(commit);
      await drainMicrotasks();

      expect(getState('player.pausedAt')).toBe(5);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('rejects a commit whose revision does not match the physical projection', async () => {
    setPlaying(5);
    v2.runtime.seekPlaying.mockImplementationOnce(async ({ positionSeconds }) => {
      publishProjection('playing', 2, positionSeconds);
      return playingCommit(positionSeconds, 3);
    });

    seekTo(40);
    await drainMicrotasks();

    expect(getState('player.pausedAt')).toBe(5);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('preserves current state when the product seek rejects', async () => {
    setPaused(9);
    v2.runtime.seekPaused.mockRejectedValueOnce(new Error('physical seek failed'));

    seekTo(33);
    await drainMicrotasks();

    expect(getState('player.pausedAt')).toBe(9);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('routes an authorized OP seek through the same product lane with no immediate frame', async () => {
    setPlaying(6);
    const conn = operatorConnection();
    initPlayback();

    await handleData({ type: MSG.REQUEST_SEEK, time: 36, queueItemId: Q1 }, conn);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).toHaveBeenCalledWith({
      positionSeconds: 36,
      signal: expect.any(AbortSignal),
    });
    expect(getState('player.pausedAt')).toBe(36);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('routes authorized OP play through paused seek and resume with no legacy frame', async () => {
    setPaused(6);
    const conn = operatorConnection();
    initPlayback();

    await handleData({ type: MSG.REQUEST_PLAY, time: 36, queueItemId: Q1 }, conn);
    await drainMicrotasks();

    expect(v2.runtime.seekPaused).toHaveBeenCalledWith({
      positionSeconds: 36,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(36);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('routes authorized OP pause through the product transition with no legacy frame', async () => {
    setPlaying(16);
    const conn = operatorConnection();
    initPlayback();

    await handleData({ type: MSG.REQUEST_PAUSE, queueItemId: Q1 }, conn);
    await drainMicrotasks();

    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(16);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps REQUEST_SKIP_TIME on the product seek family', async () => {
    setPlaying(10);
    const conn = operatorConnection();
    initPlayback();

    await handleData({ type: MSG.REQUEST_SKIP_TIME, sec: 7, queueItemId: Q1 }, conn);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying.mock.calls[0]?.[0].positionSeconds).toBe(17);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not reinterpret a local sync nudge as a canonical V2 seek', async () => {
    setPlaying(14);
    setState('sync.localOffset', 0.25);

    adjustSync(0.1);
    await drainMicrotasks();

    expect(getState('sync.localOffset')).toBe(0.25);
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
  });

  it('preserves operator guest request routing under the selected V2 build', () => {
    setPlaying(5);
    const host = {
      peer: 'transport-v2-host',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection;
    setState('network.hostConn', host);
    setState('network.isOperator', true);

    seekTo(28);

    expect(sendToHost).toHaveBeenCalledWith({ type: MSG.REQUEST_SEEK, time: 28, queueItemId: Q1 });
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
  });

  it('preserves operator guest toggle routing under the selected V2 build', () => {
    setPlaying(5);
    const host = {
      peer: 'transport-v2-host',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection;
    setState('network.hostConn', host);
    setState('network.isOperator', true);

    togglePlay();

    expect(sendToHost).toHaveBeenCalledWith({ type: MSG.REQUEST_PAUSE, queueItemId: Q1 });
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
  });

  it('keeps demo pause on its legacy node transport', async () => {
    setPlaying(9);
    setState('demo.active', true);
    const stop = vi.fn();
    const disconnect = vi.fn();
    setPlayerNode({
      stop,
      disconnect,
      onended: null,
      buffer: {},
    } as unknown as AudioBufferSourceNode);

    pause(undefined, { showToast: false });
    await drainMicrotasks();

    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
  });

  it('keeps external and demo controls on their existing transports', async () => {
    const youtubeSeek = vi.fn();
    bus.on('youtube:seek-to', youtubeSeek);
    setPlaybackYouTubePlaying();
    seekTo(18);
    expect(youtubeSeek).toHaveBeenCalledWith(18);
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();

    setPlaybackSystemAudioPlaying();
    seekTo(20);
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();

    setPaused(4);
    setState('demo.active', true);
    seekTo(22);
    await drainMicrotasks();
    expect(getState('player.pausedAt')).toBe(22);
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 22,
      queueItemId: Q1,
      reason: 'seek',
    });
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
  });
});
