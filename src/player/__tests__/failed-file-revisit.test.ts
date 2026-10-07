/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { resetClockState } from '../../network/shared-clock.ts';
import {
  getCurrentAudioBuffer,
  getPlayerNode,
  setCurrentAudioBuffer,
  setPlayerNode,
} from '../_state.ts';
import type { DataConnection } from '../../types/index.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import { initPlayback } from '../playback.ts';
import { setPlaybackLifecycleState } from '../ownership.ts';

const mocks = vi.hoisted(() => ({
  downloadRemoteFile: vi.fn(
    async (_descriptor: unknown, _progress: unknown, _signal: AbortSignal) =>
      new Promise<Blob>(() => {}),
  ),
  classify: vi.fn<() => Promise<'local' | 'remote'>>(async () => 'local'),
  nativeStop: vi.fn(),
  currentTime: 100,
  contextState: 'running' as AudioContextState,
  monotonicMs: 1_000,
  start: vi.fn(),
  broadcast: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  sendToHost: vi.fn(),
  announceSystemMessageLocally: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  playTrack: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.currentTime,
  getAudioContext: () => ({
    get state() {
      return mocks.contextState;
    },
    get currentTime() {
      return mocks.currentTime;
    },
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      start: mocks.start,
      stop: mocks.nativeStop,
      onended: null,
    }),
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
  isRemoteGuest: () => false,
  waitForGuestConnectionType: mocks.classify,
  safeSend: (conn: DataConnection, data: unknown) => {
    conn.send(data);
    return true;
  },
}));
vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: mocks.announceSystemMessageLocally,
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
}));
vi.mock('../playlist-loader.ts', () => ({
  loadPlaylistModule: async () => ({ playTrack: mocks.playTrack }),
}));

import { play, startHostFileAndBroadcastPlay, stopAllMedia } from '../transport.ts';

const QUEUE_ITEM_ID = '97111111-1111-4111-8111-111111111111';

function controlledTrack() {
  const pending: Array<{
    position: number;
    signal?: AbortSignal;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  const outputs: Array<Parameters<LargeAudioTrack['createPlayback']>[0]> = [];
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    bufferedPcmBytes: 4_096,
    prepare: vi.fn(
      (position, signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('superseded', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          pending.push({
            position,
            signal,
            resolve: () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            reject: (error) => {
              signal?.removeEventListener('abort', abort);
              reject(error);
            },
          });
        }),
    ),
    createPlayback: vi.fn((options) => {
      outputs.push(options);
      return { ended: false, stop: vi.fn(), disconnect: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  return { track, pending, outputs };
}

async function advance(ms = 0): Promise<void> {
  mocks.currentTime += ms / 1_000;
  mocks.monotonicMs += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.monotonicMs);
  bus.emit('state:network.sessionCode', null, 'network.sessionCode');
  resetState();
  resetClockState();
  bus.clear();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  mocks.classify.mockResolvedValue('local');
  mocks.currentTime = 100;
  mocks.contextState = 'running';
  mocks.monotonicMs = 1_000;
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-1',
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('playlist.items', [
    { queueItemId: QUEUE_ITEM_ID, type: 'file', videoId: '', playlistId: '', name: 'large.mp3' },
  ]);
  const blob = new Blob(['large file']);
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    name: 'large.mp3',
    sessionId: 1,
    blob,
    mime: 'audio/mpeg',
    size: blob.size,
  });
  setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

import { initTransfer, resetIncomingTransferAuthority } from '../../storage/transfer.ts';
import { resetInboundRateLimit } from '../../network/protocol.ts';
import { getTrackKeyFromItem, isTrackFailed } from '../_state.ts';
import { sendFilePrepareByDelivery } from '../../storage/transfer-send.ts';
const B = '97111111-1111-4111-8111-222222222222';
const C = '97111111-1111-4111-8111-333333333333';
const makeItem = (queueItemId: string, name: string) => ({
  queueItemId,
  name,
  type: 'file' as const,
  videoId: null,
  playlistId: null,
});
function guestSetup() {
  resetIncomingTransferAuthority();
  resetInboundRateLimit('host-1');
  const conn = {
    peer: 'host-1',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: () => {},
  } as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('network.connectionType', 'local');
  setState('room.context', { ...getState('room.context'), role: 'member', capabilities: [] });
  setState('playlist.items', [
    makeItem(QUEUE_ITEM_ID, 'large.mp3'),
    makeItem(B, 'healthy.mp3'),
    makeItem(C, 'third.mp3'),
  ]);
  markQueueAuthorityReady(conn);
  initPlayback();
  initTransfer();
  return conn;
}
async function failAThenPlayB() {
  const conn = guestSetup();
  const { track, pending, outputs } = controlledTrack();
  setCurrentAudioBuffer(track);
  const first = play(20);
  await advance();
  pending[0]!.resolve();
  await expect(first).resolves.toBe(true);
  outputs[0]!.onerror(new Error('real bounded decoder rejects later frame'));
  expect(isTrackFailed(getTrackKeyFromItem(getState('playlist.items')[0]))).toBe(true);
  expect(getState('playback.activity')).toBe('paused');
  const blob = new Blob(['healthy']);
  setState('playlist.currentQueueItemId', B);
  setState('files.current', {
    queueItemId: B,
    indexHint: 1,
    name: 'healthy.mp3',
    sessionId: 2,
    size: blob.size,
    mime: 'audio/mpeg',
    blob,
  });
  setState('transfer.localSessionId', 2);
  setCurrentAudioBuffer({
    duration: 120,
    sampleRate: 48000,
    length: 5760000,
    numberOfChannels: 2,
  } as AudioBuffer);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
  await handleData({ type: MSG.PLAY, queueItemId: B, time: 0, name: 'healthy.mp3' }, conn);
  expect(getState('playback.activity')).toBe('playing');
  const source = getPlayerNode();
  expect(source).not.toBeNull();
  return { conn, source, track };
}
it.each(['prepare-first', 'play-first', 'start-only'] as const)(
  'stops healthy B when authority returns to failed A (%s)',
  async (order) => {
    const { conn, source } = await failAThenPlayB();
    const prepare = {
      type: MSG.FILE_PREPARE,
      queueItemId: QUEUE_ITEM_ID,
      name: 'large.mp3',
      size: 10,
      total: 1,
      sessionId: 3,
      mime: 'audio/mpeg',
    };
    const start = { ...prepare, type: MSG.FILE_START };
    const msg = { type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, name: 'large.mp3', time: 0 };
    if (order === 'prepare-first') {
      await handleData(prepare, conn);
      await handleData(start, conn);
      await handleData(msg, conn);
    }
    if (order === 'play-first') {
      await handleData(msg, conn);
      await handleData(prepare, conn);
      await handleData(start, conn);
    }
    if (order === 'start-only') {
      await handleData(start, conn);
    }
    expect.soft(getPlayerNode()).not.toBe(source);
    expect.soft(getState('playback.activity')).not.toBe('playing');
    expect.soft(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
  },
);
it('control: new healthy C PREPARE retires B', async () => {
  const { conn, source } = await failAThenPlayB();
  await handleData(
    {
      type: MSG.FILE_PREPARE,
      queueItemId: C,
      name: 'third.mp3',
      size: 10,
      total: 1,
      sessionId: 3,
      mime: 'audio/mpeg',
    },
    conn,
  );
  expect(getPlayerNode()).not.toBe(source);
  expect(getState('playback.activity')).not.toBe('playing');
  expect(getState('playlist.currentQueueItemId')).toBe(C);
});
it('control: unauthorized failed-A messages do not stop B', async () => {
  const { source } = await failAThenPlayB();
  const attacker = {
    peer: 'other',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: () => {},
  } as DataConnection;
  await handleData(
    {
      type: MSG.FILE_PREPARE,
      queueItemId: QUEUE_ITEM_ID,
      name: 'large.mp3',
      size: 10,
      total: 1,
      sessionId: 3,
      mime: 'audio/mpeg',
    },
    attacker,
  );
  await handleData({ type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, time: 0 }, attacker);
  expect(getPlayerNode()).toBe(source);
  expect(getState('playback.activity')).toBe('playing');
});

it('sender-composed: emitted host PREPARE and PLAY for A must retire the guest B source', async () => {
  const sent: unknown[] = [];
  const guestConn = {
    peer: 'guest-1',
    open: true,
    send: (data: unknown) => {
      sent.push(data);
    },
    close: vi.fn(),
    on: () => {},
  } as DataConnection;
  setState('network.connectedPeers', [
    {
      id: 'guest-1',
      conn: guestConn,
      status: 'connected',
      connectionType: 'local',
      isDataTarget: true,
      slot: 1,
      label: 'guest',
      isOp: false,
      joinOrder: 1,
      lastHeartbeat: 0,
      preloadedQueueItemIds: new Set(),
    },
  ]);
  setState('network.activeHostConnByPeerId', new Map([['guest-1', guestConn]]));
  setCurrentAudioBuffer({
    duration: 120,
    sampleRate: 48000,
    length: 5760000,
    numberOfChannels: 2,
  } as AudioBuffer);
  sendFilePrepareByDelivery(
    {
      type: MSG.FILE_PREPARE,
      queueItemId: QUEUE_ITEM_ID,
      name: 'large.mp3',
      size: 10,
      sessionId: 3,
      mime: 'audio/mpeg',
    },
    3,
  );
  await expect(
    startHostFileAndBroadcastPlay({
      time: 0,
      queueItemId: QUEUE_ITEM_ID,
      context: 'host returns to playable A',
    }),
  ).resolves.toBe(true);
  const prepare = sent.find((m: any) => m.type === MSG.FILE_PREPARE);
  const playMessage = mocks.broadcast.mock.calls.map(([m]) => m).find((m) => m.type === MSG.PLAY);
  expect(prepare).toBeDefined();
  expect(playMessage).toBeDefined();
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  setState('network.connectedPeers', []);
  const { conn, source } = await failAThenPlayB();
  // playTrack selects A before its transition PAUSE; B rejects that PAUSE.
  // The ensuing PREPARE/PLAY must therefore retire B themselves.
  await handleData({ type: MSG.PAUSE, queueItemId: QUEUE_ITEM_ID, time: 0 }, conn);
  expect(getPlayerNode()).toBe(source);
  await handleData(prepare, conn);
  await handleData(playMessage, conn);
  expect.soft(getPlayerNode()).not.toBe(source);
  expect.soft(getState('playback.activity')).not.toBe('playing');
  expect.soft(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
});

it.each([MSG.FILE_PREPARE, MSG.FILE_START])(
  'control: stale failed-A %s cannot stop B',
  async (type) => {
    const { conn, source } = await failAThenPlayB();
    await handleData(
      {
        type,
        queueItemId: QUEUE_ITEM_ID,
        name: 'large.mp3',
        size: 10,
        total: 1,
        sessionId: 1,
        mime: 'audio/mpeg',
      },
      conn,
    );
    expect(getPlayerNode()).toBe(source);
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('playlist.currentQueueItemId')).toBe(B);
  },
);
it('control: repeats of the currently failed A do not reopen its decoder', async () => {
  const conn = guestSetup();
  const { track, pending, outputs } = controlledTrack();
  setCurrentAudioBuffer(track);
  const first = play(20);
  await advance();
  pending[0]!.resolve();
  await expect(first).resolves.toBe(true);
  outputs[0]!.onerror(new Error('terminal frame rejection'));
  for (let i = 1; i <= 3; i++) {
    await handleData(
      {
        type: MSG.FILE_PREPARE,
        queueItemId: QUEUE_ITEM_ID,
        name: 'large.mp3',
        size: 10,
        total: 1,
        sessionId: i,
        mime: 'audio/mpeg',
      },
      conn,
    );
    await handleData({ type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, time: i }, conn);
  }
  expect(getPlayerNode()).toBeNull();
  expect(getCurrentAudioBuffer()).toBeNull();
  expect(getState('playback.activity')).not.toBe('playing');
  expect(track.prepare).toHaveBeenCalledOnce();
  expect(mocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
});

vi.mock('../../share/remote-download.ts', () => ({ downloadRemoteFile: mocks.downloadRemoteFile }));
vi.mock('../../share/r2-client.ts', () => ({ isRemoteShareConfigured: () => true }));
import { initRemoteShare } from '../../share/remote-share.ts';
import { initPreload } from '../../storage/preload.ts';
it('adjacent: foreground R2 descriptor must not redownload failed A', async () => {
  const { conn, source } = await failAThenPlayB();
  initRemoteShare();
  const descriptorTask = handleData(
    {
      type: MSG.REMOTE_FILE_SHARE,
      roomId: '123456',
      objectId: '00000000-0000-4000-8000-000000000001',
      downloadUrl:
        'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
      downloadToken: `eyJ2IjoxLCJraW5kIjoid2hvbGUtZG93bmxvYWQifQ.${'a'.repeat(43)}`,
      storageFormat: 'whole-v1',
      storedSize: 10,
      name: 'large.mp3',
      mime: 'audio/mpeg',
      size: 10,
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 3,
      expiresAt: Date.now() + 300000,
      delivery: 'r2',
    },
    conn,
  );
  await advance();
  expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
  await descriptorTask;
  expect.soft(getPlayerNode()).not.toBe(source);
  expect.soft(getState('playback.activity')).not.toBe('playing');
});
it('adjacent: preloaded replay must not restart failed A preparation', async () => {
  const { conn } = await failAThenPlayB();
  initPreload();
  await handleData(
    { type: MSG.PLAY_PRELOADED, queueItemId: QUEUE_ITEM_ID, name: 'large.mp3' },
    conn,
  );
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  expect(getState('playback.pendingRecoveryTarget')).toBeNull();
});

function fileHeader(type: string = MSG.FILE_PREPARE, queueItemId = QUEUE_ITEM_ID, sessionId = 3) {
  return {
    type,
    queueItemId,
    sessionId,
    name: queueItemId === QUEUE_ITEM_ID ? 'large.mp3' : 'healthy.mp3',
    size: 10,
    total: 1,
    mime: 'audio/mpeg',
  };
}
function remoteDescriptor(queueItemId = QUEUE_ITEM_ID, sessionId = 3, preload = false) {
  const objectId = '00000000-0000-4000-8000-000000000001';
  return {
    type: MSG.REMOTE_FILE_SHARE,
    roomId: '123456',
    objectId,
    downloadUrl: `https://share.musixquare.com/download/123456/${objectId}`,
    downloadToken: `eyJ2IjoxLCJraW5kIjoid2hvbGUtZG93bmxvYWQifQ.${'a'.repeat(43)}`,
    storageFormat: 'whole-v1',
    storedSize: 10,
    name: 'large.mp3',
    mime: 'audio/mpeg',
    size: 10,
    queueItemId,
    sessionId,
    expiresAt: Date.now() + 300_000,
    delivery: 'r2',
    ...(preload ? { preload: true } : {}),
  };
}

it.each([MSG.FILE_PREPARE, MSG.FILE_START, MSG.FILE_RESUME])(
  'failed revisit %s fences delayed outgoing bytes and permits a healthy successor',
  async (type) => {
    const { conn, track } = await failAThenPlayB();
    const recover = vi.fn();
    setManagedTimer('chunkWatchdog', recover, 1_000);
    setManagedTimer('prepareWatchdog', recover, 1_000);
    mocks.showLoader.mockClear();
    await handleData({ ...fileHeader(type), startChunk: 0 }, conn);
    expect(mocks.nativeStop).toHaveBeenCalledOnce();
    expect(getState('transfer.localSessionId')).toBe(3);
    expect(getManagedTimer('chunkWatchdog')).toBeNull();
    expect(getManagedTimer('prepareWatchdog')).toBeNull();
    expect(mocks.showLoader).toHaveBeenCalledWith(false);
    await advance(1_001);
    expect(recover).not.toHaveBeenCalled();
    const chunk = { type: MSG.FILE_CHUNK, chunk: new Uint8Array(10), chunkIndex: 0 };
    await handleData({ ...fileHeader(MSG.FILE_CHUNK, B, 2), ...chunk }, conn);
    await handleData({ ...fileHeader(MSG.FILE_CHUNK), ...chunk }, conn);
    expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('files.current')).toBeNull();
    expect(getState('playback.pendingRecoveryTarget')).toBeNull();
    expect(track.prepare).toHaveBeenCalledOnce();
    await handleData(fileHeader(MSG.FILE_PREPARE, C, 4), conn);
    expect(getState('playlist.currentQueueItemId')).toBe(C);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  },
);

it('headerless failed PLAY fences equal-session outgoing bytes before the new header arrives', async () => {
  const { conn } = await failAThenPlayB();
  await handleData({ type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, time: 0 }, conn);
  await handleData(
    { ...fileHeader(MSG.FILE_CHUNK, B, 2), chunk: new Uint8Array(10), chunkIndex: 0 },
    conn,
  );
  expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  expect(getPlayerNode()).toBeNull();
});

it('a pending healthy output cannot finish its preparation after failed-A selection', async () => {
  const { conn } = await failAThenPlayB();
  const preparing = controlledTrack();
  setCurrentAudioBuffer(preparing.track);
  const task = play(30);
  await advance();
  expect(preparing.pending).toHaveLength(1);
  await handleData(fileHeader(), conn);
  preparing.pending[0]!.resolve();
  await expect(task).resolves.toBe(false);
  expect(preparing.track.createPlayback).not.toHaveBeenCalled();
  expect(getPlayerNode()).toBeNull();
  expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
});

it.each(['stale', 'unauthorized', 'speculative'] as const)(
  'R2 %s failed descriptor preserves healthy current output',
  async (kind) => {
    const { conn, source } = await failAThenPlayB();
    initRemoteShare();
    const sender = kind === 'unauthorized' ? { ...conn, peer: 'other' } : conn;
    await handleData(
      remoteDescriptor(QUEUE_ITEM_ID, kind === 'stale' ? 1 : 3, kind === 'speculative'),
      sender,
    );
    expect(getPlayerNode()).toBe(source);
    expect(getState('playlist.currentQueueItemId')).toBe(B);
    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
  },
);

it('repeating an already retired A leaves the healthy speculative R2 successor alive', async () => {
  const { conn } = await failAThenPlayB();
  initRemoteShare();
  await handleData(fileHeader(), conn);
  setState('network.connectionType', 'unknown');
  let classify!: (value: 'local' | 'remote') => void;
  mocks.classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        classify = resolve;
      }),
  );
  const { delivery: _delivery, ...nextPreload } = remoteDescriptor(C, 4, true);
  mocks.downloadRemoteFile.mockResolvedValueOnce(
    new File(['0123456789'], 'large.mp3', { type: 'audio/mpeg' }),
  );
  const descriptorTask = handleData(nextPreload, conn);
  expect(mocks.classify).toHaveBeenCalledOnce();
  await handleData(fileHeader(), conn);
  await handleData({ type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, time: 20 }, conn);
  classify('remote');
  await advance();
  await descriptorTask;
  expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
  expect(mocks.downloadRemoteFile.mock.calls[0]?.[0]).toMatchObject({
    queueItemId: C,
    preload: true,
  });
  expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
});

it('failed PLAY_PRELOADED does not activate an already-ready Blob or schedule recovery', async () => {
  const { conn } = await failAThenPlayB();
  initPreload();
  const ready = {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    sessionId: 3,
    name: 'large.mp3',
    mime: 'audio/mpeg',
    size: 10,
    blob: new Blob(['0123456789']),
  };
  setState('preload.ready', ready);
  setState('preload.activeTarget', ready);
  const activate = vi.fn();
  bus.on('storage:use-preloaded', activate);
  await handleData(
    { type: MSG.PLAY_PRELOADED, queueItemId: QUEUE_ITEM_ID, name: 'large.mp3' },
    conn,
  );
  await advance(20_000);
  expect(activate).not.toHaveBeenCalled();
  expect(getState('playback.pendingRecoveryTarget')).toBeNull();
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  expect(getPlayerNode()).toBeNull();
});
