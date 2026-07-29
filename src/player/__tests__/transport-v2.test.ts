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
    failure: unknown;
  } = {
    room: null,
    renderer: null,
    position: null,
    terminal: null,
    failure: null,
  };
  return {
    state,
    runtime: {
      enabled: vi.fn(() => true),
      warmNextLocalTrack: vi.fn(async () => false),
      clearNextLocalTrackWarm: vi.fn(async () => false),
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
      currentHostFailedRendererObservation: vi.fn(() => state.failure),
      currentHostTerminalRendererObservation: vi.fn(() => state.terminal),
    },
  };
});

const boundedV1 = vi.hoisted(() => {
  const state: {
    snapshot: {
      schemaVersion: 1;
      active: boolean;
      role: 'idle' | 'host' | 'guest' | 'bypass';
      roomKind: 'standard' | 'pro' | null;
      roomEpoch: string | null;
      generation: number;
      current: {
        queueItemId: string;
        legacySessionId: number;
        state: 'preparing' | 'ready' | 'fallback' | 'failed';
        phase: 'stopped' | 'playing' | 'paused';
        positionSeconds: number;
        durationSeconds: number | null;
        pendingControl: 'play' | 'seek-playing' | 'pause' | 'seek-paused' | 'stop' | null;
      } | null;
      hostConnections: number;
      guestCapabilityAnnounced: boolean;
    };
    nowRoomTimeMs: number;
  } = {
    snapshot: {
      schemaVersion: 1,
      active: false,
      role: 'idle',
      roomKind: null,
      roomEpoch: null,
      generation: 0,
      current: null,
      hostConnections: 0,
      guestCapabilityAnnounced: false,
    },
    nowRoomTimeMs: 10_000,
  };
  return {
    state,
    product: {
      initialize: vi.fn(() => false),
      registerLegacyFallbackDispatcher: vi.fn(),
      registerGuestDescriptorObserver: vi.fn(),
      prepareHost: vi.fn(),
      offerHostCurrentSettled: vi.fn(),
      ownsSession: vi.fn(() => false),
      ownsGuestTransfer: vi.fn(() => false),
      beginGuestTransfer: vi.fn(() => false),
      abandonGuestTransfer: vi.fn(async () => false),
      hasReadyRenderer: vi.fn(() => false),
      snapshot: vi.fn(() => state.snapshot),
      positionSeconds: vi.fn(() => state.snapshot.current?.positionSeconds ?? null),
      applyControl: vi.fn(),
      scheduleHostControl: vi.fn(),
      cancelPendingHostControl: vi.fn(),
      retireCurrent: vi.fn(),
      settleHostNaturalEnd: vi.fn(),
      removeQueueItem: vi.fn(async () => true),
    },
    getHostNow: vi.fn(() => state.nowRoomTimeMs),
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

vi.mock('../../network/shared-clock.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../network/shared-clock.ts')>();
  return {
    ...actual,
    getHostNow: boundedV1.getHostNow,
  };
});

vi.mock('../legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: boundedV1.product,
}));

import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, sendToHost } from '../../network/peer.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  QueueItemId,
  V2HostSeekPendingEvent,
  V2HostSeekSettledEvent,
  V2HostUiControlPendingEvent,
  V2HostUiControlSettledEvent,
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
  requestV2HostFilePause,
  requestV2HostFileOutputRejoin,
  requestV2HostFileResume,
  requestV2HostFileSeek,
  requestV2HostFileStop,
  applyLegacyBoundedV1GuestPlay,
  requestLegacyBoundedV1HostOutputRejoin,
  requestLegacyBoundedV1HostPause,
  requestLegacyBoundedV1HostPlay,
  requestLegacyBoundedV1HostSeek,
  requestLegacyBoundedV1OwnerSwitchRetirement,
  requestLegacyBoundedV1OwnerSwitchStop,
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

function pauseCommit(positionSeconds: number, revision: number, queueItemId = Q1, runId = RUN_ID) {
  const run = freezeCanonical({ queueItemId, runId });
  const from = freezeCanonical({ queueItemId, runId, revision: revision - 1 });
  const to = freezeCanonical({ queueItemId, runId, revision });
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

function failedStoppedCommit(revision: number) {
  const from = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision: revision - 1 });
  const to = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    status: 'committed' as const,
    kind: 'stop' as const,
    roomGeneration: (v2.state.room as ReturnType<typeof room>).roomGeneration,
    applicationSessionId: (v2.state.room as ReturnType<typeof room>).applicationSessionId,
    hostParticipantId: 'transport-v2-host',
    evidence: freezeCanonical({
      kind: 'failed-stop-applied' as const,
      observation: 'source-failed-retired' as const,
      from,
      to,
    }),
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

function failureSnapshot(revision: number, positionSeconds = 19.25) {
  const run = freezeCanonical({ queueItemId: Q1, runId: RUN_ID, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    queueItemId: Q1,
    backend: 'bounded-stream' as const,
    phase: 'failed' as const,
    revision,
    run,
    durationSeconds: 120,
    positionSeconds,
    bufferedAheadSeconds: 0,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 1,
    errorCode: 'audio-context-interrupted',
  });
}

function playlistTrackCommit(queueItemId: QueueItemId, revision: number, positionSeconds = 0) {
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
    schedule: freezeCanonical({ positionSeconds }),
    startEvidence: freezeCanonical({ kind: 'webaudio-schedule-passed' as const }),
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      phase: 'playing' as const,
      revision,
      run: freezeCanonical({ queueItemId, runId }),
      positionSeconds,
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

function requireAssigned<T>(read: () => T | null, message: string): T {
  const value = read();
  if (value === null) throw new Error(message);
  return value;
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

type BoundedV1Phase = 'stopped' | 'playing' | 'paused';
type BoundedV1Role = 'host' | 'guest';

function setBoundedV1Current(
  role: BoundedV1Role,
  phase: BoundedV1Phase,
  positionSeconds = 5,
  durationSeconds = 120,
): void {
  boundedV1.state.snapshot = {
    schemaVersion: 1,
    active: true,
    role,
    roomKind: 'standard',
    roomEpoch: 'transport-bounded-v1-room',
    generation: 1,
    current: {
      queueItemId: Q1,
      legacySessionId: 17,
      state: 'ready',
      phase,
      positionSeconds,
      durationSeconds,
      pendingControl: null,
    },
    hostConnections: role === 'host' ? 1 : 0,
    guestCapabilityAnnounced: role === 'guest',
  };
  boundedV1.product.positionSeconds.mockImplementation(
    () => boundedV1.state.snapshot.current?.positionSeconds ?? null,
  );
  if (phase === 'playing') setPlaybackFilePlaying();
  else setPlaybackFilePaused();
  setState('player.pausedAt', positionSeconds);
}

function updateBoundedV1Current(
  phase: BoundedV1Phase,
  positionSeconds: number,
): NonNullable<(typeof boundedV1.state.snapshot)['current']> {
  const current = boundedV1.state.snapshot.current;
  if (!current) throw new Error('Bounded V1 current is required');
  const next = {
    ...current,
    phase,
    positionSeconds,
    pendingControl: null,
  };
  boundedV1.state.snapshot = {
    ...boundedV1.state.snapshot,
    current: next,
  };
  return next;
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

function setFailed(positionSeconds = 19.25, revision = 1): void {
  v2.state.renderer = null;
  v2.state.position = null;
  v2.state.terminal = null;
  v2.state.failure = failureSnapshot(revision, positionSeconds);
  setPlaybackFilePlaying();
  setState('player.pausedAt', positionSeconds);
}

function installSuccessfulFailureRecovery(positionSeconds: number, revision = 2): void {
  v2.runtime.startLocalTrack.mockImplementationOnce(
    async (options: { queueItemId: QueueItemId; positionSeconds: number }) => {
      const runId = `playlist-run-${revision}`;
      v2.state.failure = null;
      v2.state.renderer = sourceSnapshot(
        'playing',
        revision,
        options.positionSeconds,
        120,
        options.queueItemId,
        runId,
      );
      v2.state.position = positionProjection(
        'playing',
        revision,
        options.positionSeconds,
        options.queueItemId,
        runId,
      );
      return playlistTrackCommit(options.queueItemId, revision, positionSeconds);
    },
  );
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
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  setState('network.myId', 'transport-v2-host');
  v2.state.room = room();
  v2.state.renderer = null;
  v2.state.position = null;
  v2.state.terminal = null;
  v2.state.failure = null;
  boundedV1.state.snapshot = {
    schemaVersion: 1,
    active: false,
    role: 'idle',
    roomKind: null,
    roomEpoch: null,
    generation: 0,
    current: null,
    hostConnections: 0,
    guestCapabilityAnnounced: false,
  };
  boundedV1.state.nowRoomTimeMs = 10_000;
  boundedV1.product.snapshot.mockImplementation(() => boundedV1.state.snapshot);
  boundedV1.product.positionSeconds.mockImplementation(
    () => boundedV1.state.snapshot.current?.positionSeconds ?? null,
  );
  boundedV1.product.applyControl.mockImplementation(async (control) => {
    const phase =
      control.kind === 'play' || control.kind === 'seek-playing'
        ? 'playing'
        : control.kind === 'stop'
          ? 'stopped'
          : 'paused';
    const snapshot = updateBoundedV1Current(phase, control.positionSeconds);
    return { status: 'applied', snapshot };
  });
  boundedV1.product.scheduleHostControl.mockImplementation(async (control) => ({
    status: 'scheduled' as const,
    startAtRoomTimeMs: control.startAtRoomTimeMs,
    snapshot: boundedV1.state.snapshot.current!,
    settled: boundedV1.product.applyControl(control),
  }));
  boundedV1.product.cancelPendingHostControl.mockReturnValue(null);
  boundedV1.product.retireCurrent.mockResolvedValue(false);
  boundedV1.product.settleHostNaturalEnd.mockResolvedValue({ status: 'not-ended' });
  boundedV1.product.removeQueueItem.mockResolvedValue(true);
  boundedV1.getHostNow.mockImplementation(() => boundedV1.state.nowRoomTimeMs);
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
    const runId = current.run?.runId ?? RUN_ID;
    const commit = pauseCommit(positionSeconds, revision, current.queueItemId, runId);
    v2.state.renderer = sourceSnapshot(
      'paused',
      revision,
      positionSeconds,
      current.durationSeconds ?? 120,
      current.queueItemId,
      runId,
    );
    v2.state.position = positionProjection(
      'paused',
      revision,
      positionSeconds,
      current.queueItemId,
      runId,
    );
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
    v2.state.failure = null;
    return commit;
  });
  v2.runtime.settleEndedCurrent.mockImplementation(async () => {
    const current = v2.state.terminal as ReturnType<typeof terminalSnapshot>;
    const commit = stoppedCommit('ended', current.revision + 1);
    v2.state.renderer = null;
    v2.state.position = null;
    v2.state.terminal = null;
    v2.state.failure = null;
    return commit;
  });
  setSelectedFile();
});

describe('V2 host-local file transport seek boundary', () => {
  it('claims controls only for the exact active standard-room V2 host', async () => {
    expect(requestV2HostFileSeek(12)).toBe(true);
    expect(
      requestV2HostFilePause({
        holdVisualizer: true,
        showToast: false,
      }),
    ).toBe(true);
    expect(requestV2HostFileResume(12)).toBe(true);
    expect(requestV2HostFileStop()).toBeInstanceOf(Promise);

    await drainMicrotasks();
  });

  it('does not claim PRO file play, pause, seek, or stop controls', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'transport-v2-host',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });

    expect(requestV2HostFileResume(12)).toBe(false);
    expect(
      requestV2HostFilePause({
        holdVisualizer: true,
        showToast: false,
      }),
    ).toBe(false);
    expect(requestV2HostFileSeek(12)).toBe(false);
    expect(requestV2HostFileStop()).toBeNull();

    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.seekPaused).not.toHaveBeenCalled();
    expect(v2.runtime.stopCurrent).not.toHaveBeenCalled();
  });

  it('projects track position exclusively from the exact product run', () => {
    setPlaying(12.5);
    setState('player.startedAt', 1);
    setState('player.pausedAt', 91);
    setCurrentAudioBuffer({ duration: 999 } as AudioBuffer);

    expect(getTrackPosition()).toBe(12.5);
  });

  it('projects the exact failed-renderer position instead of the legacy zero fallback', () => {
    setFailed(43.75);
    setState('player.pausedAt', 91);

    expect(getTrackPosition()).toBe(43.75);
  });

  it('projects a playing guest from its native renderer without legacy re-anchoring', () => {
    setSelectedFile();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);
    setPlaybackFilePlaying();
    setState('player.startedAt', 1);
    setState('player.pausedAt', 19);
    setState('sync.localOffset', -20);
    v2.state.position = positionProjection('playing', 3, 20.25);

    expect(getTrackPosition()).toBe(20.25);
    expect(getTrackPosition()).toBe(20.25);

    v2.state.position = positionProjection('playing', 3, 20.75);
    expect(getTrackPosition()).toBe(20.75);
    expect(getState('player.pausedAt')).toBe(19);
    expect(getState('sync.localOffset')).toBe(-20);
  });

  it('projects a paused guest from its native renderer instead of a stale compatibility anchor', () => {
    setSelectedFile();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);
    setPlaybackFilePaused();
    setState('player.startedAt', 1);
    setState('player.pausedAt', 19);
    v2.state.position = positionProjection('paused', 4, 20.5);

    expect(getTrackPosition()).toBe(20.5);
    expect(getTrackPosition()).toBe(20.5);
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

  it('publishes an immediate pending token and settles it only after the exact seek commit', async () => {
    setPlaying(5);
    const gate = deferred<ReturnType<typeof playingCommit>>();
    const pending: V2HostSeekPendingEvent[] = [];
    const settled: V2HostSeekSettledEvent[] = [];
    bus.on('player:v2-host-seek-pending', (event) => pending.push(event));
    bus.on('player:v2-host-seek-settled', (event) => settled.push(event));
    v2.runtime.seekPlaying.mockImplementationOnce(() => gate.promise);

    seekTo(30);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ queueItemId: Q1, targetSeconds: 30 });
    expect(Object.isFrozen(pending[0])).toBe(true);
    expect(settled).toHaveLength(0);

    await drainMicrotasks();
    expect(v2.runtime.seekPlaying).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(0);

    publishProjection('playing', 2, 30);
    gate.resolve(playingCommit(30, 2));
    await drainMicrotasks();

    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        queueItemId: Q1,
        status: 'committed',
        positionSeconds: 30,
      }),
    ]);
    expect(Object.isFrozen(settled[0])).toBe(true);
  });

  it('settles a rejected admitted seek as failed at the last exact position', async () => {
    setPlaying(9);
    const gate = deferred<ReturnType<typeof playingCommit>>();
    const pending: V2HostSeekPendingEvent[] = [];
    const settled: V2HostSeekSettledEvent[] = [];
    bus.on('player:v2-host-seek-pending', (event) => pending.push(event));
    bus.on('player:v2-host-seek-settled', (event) => settled.push(event));
    v2.runtime.seekPlaying.mockImplementationOnce(() => gate.promise);

    seekTo(40);
    expect(pending).toHaveLength(1);
    await drainMicrotasks();
    gate.reject(new Error('seek rejected'));
    await drainMicrotasks();

    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        status: 'failed',
        positionSeconds: 9,
      }),
    ]);
  });

  it('supersedes the old UI token without letting its completion settle the newer seek', async () => {
    setPlaying(5);
    const first = deferred<ReturnType<typeof playingCommit>>();
    const second = deferred<ReturnType<typeof playingCommit>>();
    const pending: V2HostSeekPendingEvent[] = [];
    const settled: V2HostSeekSettledEvent[] = [];
    bus.on('player:v2-host-seek-pending', (event) => pending.push(event));
    bus.on('player:v2-host-seek-settled', (event) => settled.push(event));
    v2.runtime.seekPlaying
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    seekTo(20);
    await drainMicrotasks();
    seekTo(30);

    expect(pending).toHaveLength(2);
    expect(pending[1]?.targetSeconds).toBe(30);
    expect(settled).toEqual([
      expect.objectContaining({ token: pending[0]?.token, status: 'superseded' }),
    ]);

    publishProjection('playing', 2, 20);
    first.resolve(playingCommit(20, 2));
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).toHaveBeenCalledTimes(2);
    expect(settled).toHaveLength(1);

    publishProjection('playing', 3, 30);
    second.resolve(playingCommit(30, 3));
    await drainMicrotasks();

    expect(settled).toEqual([
      expect.objectContaining({ token: pending[0]?.token, status: 'superseded' }),
      expect.objectContaining({
        token: pending[1]?.token,
        status: 'committed',
        positionSeconds: 30,
      }),
    ]);
  });

  it('publishes pause feedback immediately without advancing canonical truth before commit', async () => {
    setPlaying(12);
    const applied = deferred<ReturnType<typeof pauseCommit>>();
    const pending: V2HostUiControlPendingEvent[] = [];
    const settled: V2HostUiControlSettledEvent[] = [];
    bus.on('player:v2-host-ui-control-pending', (event) => pending.push(event));
    bus.on('player:v2-host-ui-control-settled', (event) => settled.push(event));
    v2.runtime.pauseCurrent.mockImplementationOnce(() => applied.promise);

    pause(undefined, { showToast: false });

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'pause', queueItemId: Q1 });
    expect(Object.isFrozen(pending[0])).toBe(true);
    expect(settled).toHaveLength(0);
    expect(getState('playback.activity')).toBe('playing');

    await drainMicrotasks();
    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(0);
    expect(getState('playback.activity')).toBe('playing');

    publishProjection('paused', 2, 12);
    applied.resolve(pauseCommit(12, 2));
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('paused');
    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        kind: 'pause',
        queueItemId: Q1,
        status: 'committed',
      }),
    ]);
    expect(Object.isFrozen(settled[0])).toBe(true);
  });

  it('publishes play feedback synchronously while the paused renderer resumes', async () => {
    setPaused(18);
    const applied = deferred<ReturnType<typeof playingCommit>>();
    const pending: V2HostUiControlPendingEvent[] = [];
    const settled: V2HostUiControlSettledEvent[] = [];
    bus.on('player:v2-host-ui-control-pending', (event) => pending.push(event));
    bus.on('player:v2-host-ui-control-settled', (event) => settled.push(event));
    v2.runtime.resumeCurrent.mockImplementationOnce(() => applied.promise);

    void play(18);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'play', queueItemId: Q1 });
    expect(Object.isFrozen(pending[0])).toBe(true);
    expect(settled).toHaveLength(0);
    expect(getState('playback.activity')).toBe('paused');

    await drainMicrotasks();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(0);

    publishProjection('playing', 2, 18);
    applied.resolve(playingCommit(18, 2));
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('playing');
    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        kind: 'play',
        queueItemId: Q1,
        status: 'committed',
      }),
    ]);
  });

  it('keeps a newer play token active when a superseded pause settles late', async () => {
    setPlaying(5);
    const pauseApplied = deferred<ReturnType<typeof pauseCommit>>();
    const playApplied = deferred<ReturnType<typeof playingCommit>>();
    const pending: V2HostUiControlPendingEvent[] = [];
    const settled: V2HostUiControlSettledEvent[] = [];
    bus.on('player:v2-host-ui-control-pending', (event) => pending.push(event));
    bus.on('player:v2-host-ui-control-settled', (event) => settled.push(event));
    v2.runtime.pauseCurrent.mockImplementationOnce(() => pauseApplied.promise);
    v2.runtime.resumeCurrent.mockImplementationOnce(() => playApplied.promise);

    pause(undefined, { showToast: false });
    await drainMicrotasks();
    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();

    void play(5);

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ kind: 'pause', queueItemId: Q1 });
    expect(pending[1]).toMatchObject({ kind: 'play', queueItemId: Q1 });
    expect(pending[1]?.token).not.toBe(pending[0]?.token);
    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        kind: 'pause',
        status: 'superseded',
      }),
    ]);

    publishProjection('paused', 2, 5);
    pauseApplied.resolve(pauseCommit(5, 2));
    await drainMicrotasks();

    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(1);

    publishProjection('playing', 3, 5);
    playApplied.resolve(playingCommit(5, 3));
    await drainMicrotasks();

    expect(settled).toEqual([
      expect.objectContaining({
        token: pending[0]?.token,
        kind: 'pause',
        status: 'superseded',
      }),
      expect.objectContaining({
        token: pending[1]?.token,
        kind: 'play',
        status: 'committed',
      }),
    ]);
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

  it('projects an exact paused revision despite independent renderer position sampling', async () => {
    setPlaying(0.5);
    const playButtonStates: boolean[] = [];
    bus.on('ui:play-btn-state', (enabled) => playButtonStates.push(enabled));
    const committedPositionSeconds = 0.6509;
    const renderedPositionSeconds = 0.6509791667;
    v2.runtime.pauseCurrent.mockImplementationOnce(async () => {
      const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
      const revision = current.revision + 1;
      const commit = pauseCommit(committedPositionSeconds, revision);
      v2.state.renderer = sourceSnapshot(
        'paused',
        revision,
        renderedPositionSeconds,
        current.durationSeconds ?? 120,
      );
      v2.state.position = positionProjection('paused', revision, renderedPositionSeconds);
      return commit;
    });

    pause(undefined, { showToast: false });
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(committedPositionSeconds);
    expect(playButtonStates).toEqual([true]);
  });

  it('never leaves the UI playing after an exact paused revision with a position skew', async () => {
    setPlaying(0.5);
    const committedPositionSeconds = 0.6509;
    const renderedPositionSeconds = committedPositionSeconds + 9 / 48_000;
    v2.runtime.pauseCurrent.mockImplementationOnce(async () => {
      const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
      const revision = current.revision + 1;
      const commit = pauseCommit(committedPositionSeconds, revision);
      v2.state.renderer = sourceSnapshot(
        'paused',
        revision,
        renderedPositionSeconds,
        current.durationSeconds ?? 120,
      );
      v2.state.position = positionProjection('paused', revision, renderedPositionSeconds);
      return commit;
    });

    pause(undefined, { showToast: false });
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(committedPositionSeconds);
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

  it('projects an exact resumed revision despite independent paused and renderer position sampling', async () => {
    setPaused(18);
    const committedPositionSeconds = 18.0001;
    const renderedPositionSeconds = 18.0001791667;
    const playButtonStates: boolean[] = [];
    bus.on('ui:play-btn-state', (enabled) => playButtonStates.push(enabled));
    v2.runtime.resumeCurrent.mockImplementationOnce(async () => {
      const current = v2.state.renderer as ReturnType<typeof sourceSnapshot>;
      const revision = current.revision + 1;
      const commit = playingCommit(committedPositionSeconds, revision);
      publishProjection(
        'playing',
        revision,
        renderedPositionSeconds,
        current.durationSeconds ?? 120,
      );
      return commit;
    });

    await play(18);
    await drainMicrotasks();

    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(committedPositionSeconds);
    expect(playButtonStates).toEqual([true]);
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

  it('re-arms a playing V2 host at its exact position after local output recovery', async () => {
    setPlaying(27);

    await expect(requestV2HostFileOutputRejoin('audio-context-recovered')).resolves.toBe(true);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).toHaveBeenCalledWith({
      positionSeconds: 27,
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('playing');
  });

  it('does not resume room-paused V2 truth for automatic context recovery', async () => {
    setPaused(18);

    await expect(requestV2HostFileOutputRejoin('audio-context-recovered')).resolves.toBe(true);
    await drainMicrotasks();

    expect(v2.runtime.seekPlaying).not.toHaveBeenCalled();
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('paused');
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

  it('publishes stopped truth after an exact failed renderer retirement commit', async () => {
    setFailed(19.25);
    v2.runtime.stopCurrent.mockImplementationOnce(async () => {
      v2.state.failure = null;
      return failedStoppedCommit(2);
    });

    const stopped = stopAllMediaAsync({ silent: true });
    await expect(stopped).resolves.toBe(true);

    expect(v2.runtime.stopCurrent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
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
    expect(boundedV1.product.removeQueueItem).toHaveBeenCalledWith(Q1);
  });

  it('keeps the prior selection authoritative until the atomic V2 replacement commits', async () => {
    const next = fileItem(Q2);
    setState('playlist.items', [fileItem(Q1), next]);
    setState('playlist.currentQueueItemId', Q1);
    setPlaying(4);
    const pendingStart = deferred<ReturnType<typeof playlistTrackCommit>>();
    v2.runtime.startLocalTrack.mockImplementationOnce(() => pendingStart.promise);

    const pendingPlay = playTrack(Q2);
    await drainMicrotasks();
    expect(v2.runtime.stopCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q2,
      file: next.file,
      positionSeconds: 0,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);

    v2.state.renderer = sourceSnapshot('playing', 3, 0, 120, Q2, 'playlist-run-3');
    v2.state.position = positionProjection('playing', 3, 0, Q2, 'playlist-run-3');
    pendingStart.resolve(playlistTrackCommit(Q2, 3));
    await pendingPlay;

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
    const exactStartSignal = requireAssigned(
      () => startSignal,
      'Expected the pending local start signal',
    );
    expect(exactStartSignal.aborted).toBe(false);

    stopPlayback();
    expect(exactStartSignal.aborted).toBe(true);
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

  it('freezes a failed committed renderer and rebuilds it once at the exact position', async () => {
    setFailed(19.25);
    installSuccessfulFailureRecovery(19.25);
    const pending: Array<{ owner: string; token: string | number }> = [];
    const settled: Array<{ owner: string; token: string | number }> = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));

    handleEnded();
    handleEnded();
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q1,
      file: expect.any(File),
      positionSeconds: 19.25,
      signal: expect.any(AbortSignal),
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ owner: 'host-recover' });
    expect(settled).toEqual(pending);
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(19.25);
  });

  it('turns a failed-renderer pause into canonical stopped truth and resumes from its checkpoint', async () => {
    setFailed(31.5);
    const durationUpdate = vi.fn();
    const timeUpdate = vi.fn();
    bus.on('ui:duration-update', durationUpdate);
    bus.on('ui:time-update', timeUpdate);
    v2.runtime.stopCurrent.mockImplementationOnce(async () => {
      v2.state.failure = null;
      return failedStoppedCommit(2);
    });

    expect(
      requestV2HostFilePause({
        holdVisualizer: true,
        showToast: false,
      }),
    ).toBe(true);
    await drainMicrotasks();

    expect(v2.runtime.stopCurrent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(v2.runtime.startLocalTrack).not.toHaveBeenCalled();
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(31.5);
    expect(getTrackPosition()).toBe(31.5);
    expect(durationUpdate).toHaveBeenLastCalledWith(120);
    expect(timeUpdate).toHaveBeenLastCalledWith('0:31', '2:00', 31.5, 120);

    expect(requestV2HostFileSeek(46.25)).toBe(true);
    expect(getState('player.pausedAt')).toBe(46.25);
    expect(getTrackPosition()).toBe(46.25);
    skipTime(-10);
    expect(getState('player.pausedAt')).toBe(36.25);
    expect(getTrackPosition()).toBe(36.25);

    installSuccessfulFailureRecovery(36.25, 3);
    expect(requestV2HostFileResume()).toBe(true);
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q1,
      file: expect.any(File),
      positionSeconds: 36.25,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(36.25);
  });

  it('discards a failed-pause checkpoint on explicit stop', async () => {
    setFailed(28);
    v2.runtime.stopCurrent.mockImplementationOnce(async () => {
      v2.state.failure = null;
      return failedStoppedCommit(2);
    });

    requestV2HostFilePause({
      holdVisualizer: true,
      showToast: false,
    });
    await drainMicrotasks();
    expect(getTrackPosition()).toBe(28);

    await expect(requestV2HostFileStop()).resolves.toBe(true);
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
    expect(getTrackPosition()).toBe(0);

    await expect(requestV2HostFileOutputRejoin('media-session-play')).resolves.toBe(false);
    expect(v2.runtime.startLocalTrack).not.toHaveBeenCalled();
  });

  it('resumes from the checkpoint when PLAY supersedes a commit-dominant failed pause stop', async () => {
    setFailed(20);
    const pendingStop = deferred<ReturnType<typeof failedStoppedCommit>>();
    v2.runtime.stopCurrent.mockImplementationOnce(() => pendingStop.promise);
    installSuccessfulFailureRecovery(20, 3);

    requestV2HostFilePause({
      holdVisualizer: true,
      showToast: false,
    });
    await drainMicrotasks();
    const stopSignal = v2.runtime.stopCurrent.mock.calls[0]?.[0].signal as AbortSignal;

    const resume = requestV2HostFileOutputRejoin('media-session-play');
    expect(stopSignal.aborted).toBe(true);

    v2.state.failure = null;
    pendingStop.resolve(failedStoppedCommit(2));
    await expect(resume).resolves.toBe(true);
    await drainMicrotasks();

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q1,
      file: expect.any(File),
      positionSeconds: 20,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(20);
  });

  it('retries a failed renderer on automatic context recovery even after its compatibility UI froze', async () => {
    setFailed(22.25);
    installSuccessfulFailureRecovery(22.25);

    const settlement = requestV2HostFileOutputRejoin('audio-context-recovered');
    expect(settlement).toBeInstanceOf(Promise);
    await expect(settlement).resolves.toBe(true);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(22.25);
  });

  it('honors an explicit failed-renderer pause until a trusted Media Session PLAY', async () => {
    setFailed(24);
    v2.runtime.stopCurrent.mockImplementationOnce(async () => {
      v2.state.failure = null;
      return failedStoppedCommit(2);
    });
    expect(
      requestV2HostFilePause({
        holdVisualizer: true,
        showToast: false,
      }),
    ).toBe(true);
    await drainMicrotasks();

    await expect(requestV2HostFileOutputRejoin('audio-context-recovered')).resolves.toBe(true);
    expect(v2.runtime.startLocalTrack).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(24);

    installSuccessfulFailureRecovery(24, 3);
    await expect(requestV2HostFileOutputRejoin('media-session-play')).resolves.toBe(true);
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('playing');
  });

  it('physically pauses a commit-dominant recovery successor instead of losing the user pause', async () => {
    setFailed(31.5);
    const recovery = deferred<ReturnType<typeof playlistTrackCommit>>();
    let recoverySignal: AbortSignal | null = null;
    const successorRunId = 'playlist-run-2';
    v2.runtime.startLocalTrack.mockImplementationOnce((options: { signal: AbortSignal }) => {
      recoverySignal = options.signal;
      return recovery.promise;
    });
    v2.runtime.pauseCurrent.mockImplementationOnce(async () => {
      v2.state.renderer = sourceSnapshot('paused', 3, 31.5, 120, Q1, successorRunId);
      v2.state.position = positionProjection('paused', 3, 31.5, Q1, successorRunId);
      return pauseCommit(31.5, 3, Q1, successorRunId);
    });

    expect(requestV2HostFileResume()).toBe(true);
    await drainMicrotasks();
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();

    expect(
      requestV2HostFilePause({
        holdVisualizer: true,
        showToast: false,
      }),
    ).toBe(true);
    expect(requireAssigned(() => recoverySignal, 'Expected a recovery signal').aborted).toBe(true);
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();

    v2.state.failure = null;
    v2.state.renderer = sourceSnapshot('playing', 2, 31.5, 120, Q1, successorRunId);
    v2.state.position = positionProjection('playing', 2, 31.5, Q1, successorRunId);
    recovery.resolve(playlistTrackCommit(Q1, 2, 31.5));
    await drainMicrotasks(128);

    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(31.5);
  });

  it('reports an output-rejoin request as superseded while reconciling its physical seek commit', async () => {
    setPlaying(27);
    const rejoinSeek = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.seekPlaying.mockImplementationOnce(() => rejoinSeek.promise);

    const settlement = requestV2HostFileOutputRejoin('audio-context-recovered');
    await drainMicrotasks();
    expect(v2.runtime.seekPlaying).toHaveBeenCalledOnce();

    pause(undefined, { showToast: false });
    publishProjection('playing', 2, 27);
    rejoinSeek.resolve(playingCommit(27, 2));
    await expect(settlement).resolves.toBe(false);
    await drainMicrotasks();

    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
  });

  it('reports a paused output-rejoin resume as superseded when a newer pause wins', async () => {
    setPaused(18);
    const rejoinResume = deferred<ReturnType<typeof playingCommit>>();
    v2.runtime.resumeCurrent.mockImplementationOnce(() => rejoinResume.promise);

    const settlement = requestV2HostFileOutputRejoin('media-session-play');
    await drainMicrotasks();
    expect(v2.runtime.resumeCurrent).toHaveBeenCalledOnce();

    pause(undefined, { showToast: false });
    publishProjection('playing', 2, 18);
    rejoinResume.resolve(playingCommit(18, 2));

    await expect(settlement).resolves.toBe(false);
    await drainMicrotasks();

    expect(v2.runtime.pauseCurrent).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(18);
  });

  it('uses a failed-renderer seek target as the fresh rendezvous position', async () => {
    setFailed(44);
    installSuccessfulFailureRecovery(72);

    expect(requestV2HostFileSeek(72)).toBe(true);
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith(
      expect.objectContaining({ positionSeconds: 72 }),
    );
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(72);
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

  it('keeps an incoherent paused selection fail-closed instead of exposing legacy playback', async () => {
    setPlaybackFilePaused();
    setState('player.pausedAt', 0);

    togglePlay();
    await drainMicrotasks();

    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(v2.runtime.startLocalTrack).not.toHaveBeenCalled();
    expect(v2.runtime.resumeCurrent).not.toHaveBeenCalled();
    expect(v2.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('fresh-starts the selected V2 occurrence after an exact explicit stop', async () => {
    setPlaying(12);

    await expect(requestV2HostFileStop()).resolves.toBe(true);
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(v2.state.renderer).toBeNull();

    installSuccessfulFailureRecovery(0, 3);
    togglePlay();
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q1,
      file: expect.any(File),
      positionSeconds: 0,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('fresh-starts after a pre-commit V2 preparation failure', async () => {
    const playButtonStates: boolean[] = [];
    bus.on('ui:play-btn-state', (enabled) => playButtonStates.push(enabled));
    v2.runtime.startLocalTrack.mockRejectedValueOnce(new Error('pre-commit preparation failed'));

    await playTrack(Q1);
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(v2.state.renderer).toBeNull();
    expect(playButtonStates).toEqual([true]);

    installSuccessfulFailureRecovery(0, 2);
    togglePlay();
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledTimes(2);
    expect(v2.runtime.startLocalTrack.mock.calls[1]?.[0]).toMatchObject({
      queueItemId: Q1,
      positionSeconds: 0,
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(playButtonStates).toEqual([true, true]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('preserves an explicit direct-play offset when fresh-starting a stopped selection', async () => {
    installSuccessfulFailureRecovery(37, 2);

    await play(37);
    await drainMicrotasks(96);

    expect(v2.runtime.startLocalTrack).toHaveBeenCalledWith({
      queueItemId: Q1,
      file: expect.any(File),
      positionSeconds: 37,
      signal: expect.any(AbortSignal),
    });
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.pausedAt')).toBe(37);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('serializes rapid fresh-start requests through the shared V2 mutation lane', async () => {
    const first = deferred<ReturnType<typeof playlistTrackCommit>>();
    const second = deferred<ReturnType<typeof playlistTrackCommit>>();
    v2.runtime.startLocalTrack
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    togglePlay();
    await drainMicrotasks(48);
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledOnce();
    const firstSignal = v2.runtime.startLocalTrack.mock.calls[0]?.[0].signal as AbortSignal;

    togglePlay();
    await drainMicrotasks(48);
    expect(firstSignal.aborted).toBe(true);
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledTimes(1);

    first.reject(new Error('superseded before commit'));
    await drainMicrotasks(96);
    expect(v2.runtime.startLocalTrack).toHaveBeenCalledTimes(2);

    v2.state.renderer = sourceSnapshot('playing', 2, 0, 120, Q1, 'playlist-run-2');
    v2.state.position = positionProjection('playing', 2, 0, Q1, 'playlist-run-2');
    second.resolve(playlistTrackCommit(Q1, 2));
    await drainMicrotasks(96);

    expect(getState('playback.activity')).toBe('playing');
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
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
    expect(getState('playback.activity')).toBe('paused');

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
    // The physically committed predecessor is reconciled before the latest
    // relative seek runs, so the compatibility UI cannot remain at stale 5s.
    expect(getState('player.pausedAt')).toBe(20);

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
    setState('network.appRole', 'guest');
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
    setState('network.appRole', 'guest');
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

describe('bounded V1 transport integration', () => {
  it('stops demo PCM without retiring its retained bounded owner', async () => {
    setSelectedFile();
    setBoundedV1Current('host', 'stopped', 0);
    setState('demo.active', true);

    await expect(
      stopAllMediaAsync({
        cancelInFlight: true,
        preserveLegacyBoundedOwner: true,
      }),
    ).resolves.toBe(true);

    expect(boundedV1.product.applyControl).not.toHaveBeenCalled();
    expect(boundedV1.product.retireCurrent).not.toHaveBeenCalled();
    expect(boundedV1.state.snapshot.current).toMatchObject({
      queueItemId: Q1,
      legacySessionId: 17,
    });
  });

  it('keeps demo controls on the visible PCM node while a stopped bounded source is retained', async () => {
    setSelectedFile();
    setBoundedV1Current('host', 'playing', 31);
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
    expect(boundedV1.product.applyControl).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('paused');
  });

  it('resumes a restored stopped bounded source from its canonical checkpoint', async () => {
    setSelectedFile();
    setBoundedV1Current('host', 'stopped', 41.25, 204.5);

    togglePlay();
    await drainMicrotasks();

    expect(boundedV1.product.scheduleHostControl).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 41.25,
      startAtRoomTimeMs: 10_400,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PLAY,
      time: 41.25,
      queueItemId: Q1,
      name: undefined,
      hostPlayAt: 10_400,
    });
  });

  it('captures the exact bounded guest before terminal PAUSE deselects it', async () => {
    const conn = {
      peer: 'transport-bounded-v1-host',
      open: true,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as DataConnection;
    setSelectedFile();
    setBoundedV1Current('guest', 'playing', 119);
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    markQueueAuthorityReady(conn);
    initPlayback();

    const retirement = deferred<boolean>();
    let selectedWhenRetirementStarted: QueueItemId | null = null;
    boundedV1.product.retireCurrent.mockImplementationOnce(() => {
      selectedWhenRetirementStarted = getState('playlist.currentQueueItemId');
      return retirement.promise;
    });

    await handleData(
      {
        type: MSG.PAUSE,
        time: 0,
        queueItemId: Q1,
        endOfPlaylist: true,
        reason: 'end-of-playlist',
      },
      conn,
    );

    expect(boundedV1.product.retireCurrent).toHaveBeenNthCalledWith(1, Q1, 17);
    expect(selectedWhenRetirementStarted).toBe(Q1);
    expect(getState('playlist.currentQueueItemId')).toBeNull();

    boundedV1.state.snapshot = {
      ...boundedV1.state.snapshot,
      current: {
        ...boundedV1.state.snapshot.current!,
        queueItemId: Q2,
        legacySessionId: 18,
      },
    };
    retirement.resolve(true);
    await drainMicrotasks();

    expect(boundedV1.state.snapshot.current?.queueItemId).toBe(Q2);
    expect(boundedV1.product.retireCurrent).not.toHaveBeenCalledWith(Q2, 18);
  });

  it('publishes host PLAY after scheduling and projects UI only after exact start evidence', async () => {
    setBoundedV1Current('host', 'paused', 4);
    const visualizerStart = vi.fn();
    const loopStart = vi.fn();
    bus.on('visualizer:start', visualizerStart);
    bus.on('ui:loop-start', loopStart);
    const applied = deferred<{
      status: 'applied';
      snapshot: NonNullable<(typeof boundedV1.state.snapshot)['current']>;
    }>();
    boundedV1.product.applyControl.mockImplementationOnce(() => applied.promise);
    boundedV1.product.scheduleHostControl.mockImplementationOnce(async (control) => ({
      status: 'scheduled' as const,
      startAtRoomTimeMs: 10_900,
      snapshot: boundedV1.state.snapshot.current!,
      settled: boundedV1.product.applyControl(control),
    }));

    expect(requestLegacyBoundedV1HostPlay(12, 10_500)).toBe(true);
    await drainMicrotasks(4);

    expect(boundedV1.product.scheduleHostControl).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 12,
      startAtRoomTimeMs: 10_500,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PLAY,
      time: 12,
      queueItemId: Q1,
      name: undefined,
      hostPlayAt: 10_900,
    });
    expect(visualizerStart).not.toHaveBeenCalled();
    expect(loopStart).not.toHaveBeenCalled();

    const snapshot = updateBoundedV1Current('playing', 12);
    applied.resolve({ status: 'applied', snapshot });
    await drainMicrotasks();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(visualizerStart).toHaveBeenCalledTimes(1);
    expect(loopStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['superseded', { status: 'superseded' as const }],
    ['failed', { status: 'failed' as const, error: new Error('renderer failed') }],
  ])('does not publish PLAY when host scheduling is %s', async (_label, outcome) => {
    setBoundedV1Current('host', 'paused', 4);
    boundedV1.product.scheduleHostControl.mockResolvedValueOnce(outcome);

    expect(requestLegacyBoundedV1HostPlay(12, 10_500)).toBe(true);
    await drainMicrotasks();

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
  });

  it('retires and publishes one compensating PAUSE when a published host start fails', async () => {
    setBoundedV1Current('host', 'paused', 4);
    boundedV1.product.scheduleHostControl.mockResolvedValueOnce({
      status: 'scheduled',
      startAtRoomTimeMs: 10_500,
      snapshot: boundedV1.state.snapshot.current!,
      settled: Promise.resolve({
        status: 'failed',
        error: new Error('native start failed'),
      }),
    });
    boundedV1.product.retireCurrent.mockResolvedValueOnce(true);

    expect(requestLegacyBoundedV1HostPlay(12, 10_500)).toBe(true);
    await drainMicrotasks(8);

    expect(boundedV1.product.retireCurrent).toHaveBeenCalledWith(Q1, 17);
    const publications = vi.mocked(broadcast).mock.calls.map(([message]) => message);
    expect(publications.filter((message) => message.type === MSG.PLAY)).toHaveLength(1);
    expect(publications.filter((message) => message.type === MSG.PAUSE)).toEqual([
      {
        type: MSG.PAUSE,
        time: 12,
        queueItemId: Q1,
        reason: 'transition',
      },
    ]);
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(12);
  });

  it('orders immediate PAUSE after an already-published scheduled PLAY', async () => {
    setBoundedV1Current('host', 'paused', 4);
    const pendingPlay = deferred<{ status: 'superseded' }>();
    boundedV1.product.applyControl
      .mockImplementationOnce(() => pendingPlay.promise)
      .mockImplementationOnce(async (control) => {
        const snapshot = updateBoundedV1Current('paused', control.positionSeconds);
        return { status: 'applied' as const, snapshot };
      });

    expect(requestLegacyBoundedV1HostPlay(8, 10_500)).toBe(true);
    await drainMicrotasks(4);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, queueItemId: Q1 }),
    );

    expect(requestLegacyBoundedV1HostPause(8)).toBe(true);
    expect(boundedV1.product.applyControl).toHaveBeenNthCalledWith(2, {
      kind: 'pause',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 8,
      atRoomTimeMs: 10_000,
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, {
      type: MSG.PAUSE,
      time: 8,
      queueItemId: Q1,
      reason: 'pause',
    });

    pendingPlay.resolve({ status: 'superseded' });
    await drainMicrotasks();

    expect(
      vi.mocked(broadcast).mock.calls.filter(([message]) => message.type === MSG.PLAY),
    ).toHaveLength(1);
    expect(boundedV1.state.snapshot.current?.phase).toBe('paused');
  });

  it('cancels a same-tick queued PLAY before PAUSE can take the stopped fast path', async () => {
    setBoundedV1Current('host', 'stopped', 4);

    expect(requestLegacyBoundedV1HostPlay(8, 10_500)).toBe(true);
    expect(requestLegacyBoundedV1HostPause(8)).toBe(true);
    await drainMicrotasks();

    expect(boundedV1.product.applyControl).not.toHaveBeenCalled();
    expect(
      vi.mocked(broadcast).mock.calls.filter(([message]) => message.type === MSG.PLAY),
    ).toHaveLength(0);
    expect(getState('player.pausedAt')).toBe(8);
  });

  it('keeps terminal IDLE after delayed bounded renderer retirement settles', async () => {
    setSelectedFile();
    setBoundedV1Current('host', 'playing', 12);
    const stopped = deferred<{
      status: 'applied';
      snapshot: NonNullable<(typeof boundedV1.state.snapshot)['current']>;
    }>();
    boundedV1.product.applyControl.mockImplementationOnce(() => stopped.promise);

    const stopping = stopAllMediaAsync({ cancelInFlight: true });
    expect(getState('playback.activity')).toBe('idle');

    const snapshot = updateBoundedV1Current('stopped', 0);
    stopped.resolve({ status: 'applied', snapshot });
    await expect(stopping).resolves.toBe(true);

    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
  });

  it('invalidates a pending cross-owner continuation on explicit STOP', async () => {
    setSelectedFile();
    setBoundedV1Current('host', 'playing', 12);
    const retiring = deferred<boolean>();
    boundedV1.product.retireCurrent.mockReturnValueOnce(retiring.promise);

    const ownerSwitch = requestLegacyBoundedV1OwnerSwitchRetirement();
    expect(ownerSwitch).not.toBeNull();
    expect(ownerSwitch!.isCurrent()).toBe(true);

    await expect(stopAllMediaAsync({ cancelInFlight: true })).resolves.toBe(true);

    expect(ownerSwitch!.isCurrent()).toBe(false);
    retiring.resolve(true);
    await expect(ownerSwitch!.settled).resolves.toBe(true);
  });

  it('physically retires a preparing guest instead of accepting a buffered overlay STOP', async () => {
    setBoundedV1Current('guest', 'stopped', 0);
    boundedV1.state.snapshot = {
      ...boundedV1.state.snapshot,
      current: {
        ...boundedV1.state.snapshot.current!,
        state: 'preparing',
      },
    };
    const retiring = deferred<boolean>();
    boundedV1.product.retireCurrent.mockReturnValueOnce(retiring.promise);

    const ownerSwitch = requestLegacyBoundedV1OwnerSwitchStop();

    expect(ownerSwitch).not.toBeNull();
    expect(boundedV1.product.applyControl).not.toHaveBeenCalled();
    expect(boundedV1.product.retireCurrent).toHaveBeenCalledWith(Q1, 17);
    let settled = false;
    void ownerSwitch!.settled.then(() => {
      settled = true;
    });
    await drainMicrotasks();
    expect(settled).toBe(false);

    retiring.resolve(true);
    await expect(ownerSwitch!.settled).resolves.toBe(true);
  });

  it('routes playing seek through a committed seek-playing control before PLAY', async () => {
    setBoundedV1Current('host', 'playing', 5);
    const applied = deferred<{
      status: 'applied';
      snapshot: NonNullable<(typeof boundedV1.state.snapshot)['current']>;
    }>();
    boundedV1.product.applyControl.mockImplementationOnce(() => applied.promise);

    expect(requestLegacyBoundedV1HostSeek(30)).toBe(true);
    await drainMicrotasks(4);

    expect(boundedV1.product.scheduleHostControl).toHaveBeenCalledWith({
      kind: 'seek-playing',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 30,
      startAtRoomTimeMs: 10_400,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PLAY,
      time: 30,
      queueItemId: Q1,
      hostPlayAt: 10_400,
    });

    const snapshot = updateBoundedV1Current('playing', 30);
    applied.resolve({ status: 'applied', snapshot });
    await drainMicrotasks();

    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('rejoins a playing host output with a fresh same-position rendezvous', async () => {
    setBoundedV1Current('host', 'playing', 18);

    const rejoined = requestLegacyBoundedV1HostOutputRejoin('audio-context-recovered');

    await expect(rejoined).resolves.toBe(true);
    expect(boundedV1.product.scheduleHostControl).toHaveBeenCalledWith({
      kind: 'seek-playing',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 18,
      startAtRoomTimeMs: 10_400,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PLAY,
      time: 18,
      queueItemId: Q1,
      hostPlayAt: 10_400,
    });
  });

  it('does not manufacture PLAY while paused context recovery only restores output', async () => {
    setBoundedV1Current('host', 'paused', 18);

    await expect(requestLegacyBoundedV1HostOutputRejoin('audio-context-recovered')).resolves.toBe(
      true,
    );

    expect(boundedV1.product.scheduleHostControl).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
  });

  it('lets an explicit Media Session PLAY rendezvous a paused bounded host', async () => {
    setBoundedV1Current('host', 'paused', 18);

    await expect(requestLegacyBoundedV1HostOutputRejoin('media-session-play')).resolves.toBe(true);

    expect(boundedV1.product.scheduleHostControl).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 18,
      startAtRoomTimeMs: 10_400,
    });
  });

  it('routes paused seek through seek-paused and publishes the paused target immediately', async () => {
    setBoundedV1Current('host', 'paused', 5);

    expect(requestLegacyBoundedV1HostSeek(40)).toBe(true);

    expect(boundedV1.product.applyControl).toHaveBeenCalledWith({
      kind: 'seek-paused',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 40,
      atRoomTimeMs: 10_000,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 40,
      queueItemId: Q1,
      reason: 'seek',
    });
    await drainMicrotasks();
  });

  it('catches up an overdue guest PLAY while keeping its local arm in the future', async () => {
    setBoundedV1Current('guest', 'paused', 0);

    expect(applyLegacyBoundedV1GuestPlay(Q1, 5, 9_000)).toBe(true);

    expect(boundedV1.product.applyControl).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: Q1,
      legacySessionId: 17,
      positionSeconds: 6.075,
      startAtRoomTimeMs: 10_075,
    });
    await drainMicrotasks();
  });

  it('emits one natural end only after the exact settlement despite duplicate polling', async () => {
    setBoundedV1Current('host', 'playing', 120, 120);
    const settlement = deferred<{
      status: 'settled';
      snapshot: NonNullable<(typeof boundedV1.state.snapshot)['current']>;
    }>();
    boundedV1.product.settleHostNaturalEnd.mockImplementation(() => settlement.promise);
    const ended = vi.fn();
    bus.on('player:ended', ended);

    handleEnded();
    handleEnded();
    await drainMicrotasks(4);

    expect(boundedV1.product.settleHostNaturalEnd).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();

    const snapshot = updateBoundedV1Current('stopped', 0);
    settlement.resolve({ status: 'settled', snapshot });
    await drainMicrotasks();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(getState('player.pausedAt')).toBe(0);
  });
});
