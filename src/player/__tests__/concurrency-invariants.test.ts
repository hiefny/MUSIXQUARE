/**
 * @vitest-environment jsdom
 *
 * Cross-mechanism playback concurrency invariants.
 *
 * The load epoch, active load session, play lock/watchdog, preload activation
 * owner, lifecycle FSM, and pending-play mailbox have distinct scopes. This
 * suite covers their interactions. Full matrix:
 * docs/design/playback-concurrency-invariants.md. Static writer-set guard:
 * scripts/check-lifecycle-writes.mjs.
 *
 * Contract cases (letters also identify the describe blocks):
 *   (a) use-preloaded(B) superseding in-flight load(A): flag stays true
 *       through the window (stomp rule C1), handlePlayMsg defers, A's stale
 *       finish is a no-op, B consumes the pending play.
 *   (b) 15s navigator-lock-watchdog fire = FULL reset tuple (C3): unlock +
 *       pendingPlayTime cleared + stopPlayerNode + token +1 + semantic IDLE,
 *       and the blocked _internalPlay aborts without writing PLAYING.
 *   (c) stopAllMedia({cancelInFlight}) during _internalPlay's await window
 *       releases the lock immediately and leaves no phantom node (C4).
 *   (d) finalizeGuestFile staleness at BOTH sessionId checkpoints (pre/post
 *       decode) — abort without publishing, without consuming the mailbox.
 *   (e) loadPreloadedTrack pendingPlayTime policy is asymmetric BY DESIGN —
 *       BIDIRECTIONAL pins: preserve on supersession-class aborts AND clear
 *       on external-owner/live-failure aborts, so a uniform-clear refactor and a
 *       uniform-preserve behavior are both rejected by this suite.
 *   (f) a SUPERSEDED activation's decode-failure catch path is inert: it must
 *       not clear the superseding activation's flag nor its pending play.
 *   (g) OWNER DECISION (binding): newLoadEpoch() fired during
 *       finalizeGuestFile's decode await must NOT abort the finalize —
 *       buffer swap, DECODE_SUCCESS, and pendingPlayTime consumption all
 *       still happen. This keeps activeLoadSessionId separate from the epoch.
 *   (j) a NEW transfer session (FILE_PREPARE new-session reset — bumps
 *       neither M1 nor M2) starting during finalizeGuestFile's decode await
 *       aborts the stale finalize via its transfer.localSessionId entry
 *       snapshot: the new download keeps RECEIVING + its chunkWatchdog, no
 *       stale buffer/blob/meta publish, mailbox untouched.
 *
 * transport.ts, decode.ts, playback.ts, lifecycle.ts, and ownership.ts remain
 * real so lock/watchdog behavior is exercised. Only external seams are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { batchSetState, getState, resetState, setState } from '../../core/state.ts';
import { handleData } from '../../network/protocol.ts';
import type {
  DataConnection,
  FileMeta,
  PlaylistItem,
  QueueItemId,
  ResidentFile,
} from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  safeSend: vi.fn(() => true),
  isRemoteGuest: vi.fn(() => false),
  decodeAudioData: vi.fn(),
  createBufferSource: vi.fn(),
  ensureRunning: vi.fn(),
  getCurrentTime: vi.fn(() => 100),
  initAudio: vi.fn(),
  sendRecoveryRequest: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
  readStoredFile: vi.fn(),
  cleanupStoredFile: vi.fn(),
  unicastFile: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  ensureRunning: mocks.ensureRunning,
  getCurrentTime: mocks.getCurrentTime,
  getAudioContext: vi.fn(() => ({
    state: 'running',
    currentTime: 0,
    decodeAudioData: mocks.decodeAudioData,
    createBufferSource: mocks.createBufferSource,
  })),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: mocks.initAudio,
  getWidener: vi.fn(() => null),
  getSurroundSplitter: vi.fn(() => null),
}));

vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: vi.fn(() => false),
  stopSystemAudioCapture: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
  safeSend: mocks.safeSend,
  isRemoteGuest: mocks.isRemoteGuest,
}));

vi.mock('../../storage/storage.ts', () => ({
  admitIncomingStoredFile: vi.fn(),
  postCommand: vi.fn(),
  cleanupStoredFile: mocks.cleanupStoredFile,
  discardResidentStoredFileAdmission: vi.fn(() => false),
  promoteStoredFileAdmission: vi.fn(() => false),
  readStoredFile: mocks.readStoredFile,
  retainStoredFileAdmission: vi.fn(() => false),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
  unicastFile: mocks.unicastFile,
}));

vi.mock('../../storage/preload.ts', () => ({
  schedulePreload: vi.fn(),
  unicastPreload: vi.fn(),
}));

vi.mock('../../storage/recovery.ts', () => ({
  sendRecoveryRequest: mocks.sendRecoveryRequest,
}));

vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => false),
}));

vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
  showLoader: mocks.showLoader,
  updateLoader: mocks.updateLoader,
}));

vi.mock('../video.ts', () => ({
  setEngineMode: vi.fn(),
}));

import {
  getCurrentAudioBuffer,
  getCurrentLoadEpoch,
  getPendingPlayTime,
  getPlayerNode,
  incrementLoadSessionId,
  liveAudioBufferCount,
  liveAudioBufferPcmBytes,
  newLoadEpoch,
  isPlayLocked,
  isPlayPreloadedInProgress,
  setCurrentAudioBuffer,
  setPendingPlayTime,
  setPlayerNode,
  setPlayLocked,
  setPlayPreloadedInProgress,
} from '../_state.ts';
import { pause, play, stopAllMedia } from '../transport.ts';
import { finalizeGuestFile, loadPreloadedTrack } from '../decode.ts';
import { initPlayback } from '../playback.ts';
import { transition } from '../lifecycle.ts';
import { setPlaybackTransferState, setPlaybackYouTubePlaying } from '../ownership.ts';

// ─── Helpers ─────────────────────────────────────────────────────────

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deterministically drain pending microtask chains (continuations after a
 *  deferred resolve) before asserting. vi.waitFor would be vacuous here: it
 *  resolves on the FIRST passing poll, which can happen before the
 *  continuation under test has run at all. */
async function flushAsync(hops = 3): Promise<void> {
  for (let i = 0; i < hops; i++) {
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
  }
}

interface FakeSourceNode {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  onended: null;
}

function makeFakeSourceNode(): FakeSourceNode {
  return {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    onended: null,
  };
}

let nextQueueItemIdValue = 1;

function nextQueueItemId(): QueueItemId {
  const suffix = String(nextQueueItemIdValue++).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function makeTrack(name: string): PlaylistItem {
  return {
    queueItemId: nextQueueItemId(),
    type: 'file',
    name,
    title: name,
    videoId: null,
    playlistId: null,
  };
}

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' });
}

function itemAt(index: number): PlaylistItem {
  const item = getState('playlist.items')[index];
  if (!item) throw new Error(`missing queue item at index ${index}`);
  return item;
}

function queueItemIdAt(index: number): QueueItemId {
  return itemAt(index).queueItemId;
}

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

function selectIndex(index: number): QueueItemId | null {
  const queueItemId = getState('playlist.items')[index]?.queueItemId ?? null;
  setState('playlist.currentQueueItemId', queueItemId);
  return queueItemId;
}

function fileMetaFor(
  item: PlaylistItem,
  file: Blob,
  sessionId: number,
  indexHint = getState('playlist.items').findIndex(
    (candidate) => candidate.queueItemId === item.queueItemId,
  ),
): FileMeta {
  const mime = file.type || 'audio/mpeg';
  return {
    queueItemId: item.queueItemId,
    indexHint,
    name: item.name,
    type: mime,
    mime,
    size: file.size,
    total: 1,
    sessionId,
  };
}

/** Populate a ready-to-activate preload slot for `index`. */
function stagePreload(index: number, file: File, sessionId = index + 1): ResidentFile {
  const item = itemAt(index);
  const meta = fileMetaFor(item, file, sessionId, index);
  const ready: ResidentFile = { ...meta, blob: file };
  batchSetState({
    'preload.nextQueueItemId': item.queueItemId,
    'preload.activeTarget': meta,
    'preload.ready': ready,
  });
  return ready;
}

/** Establish the stable queue/session owner required by guest finalization. */
function stageGuestTransfer(index: number, file: File, sessionId: number): QueueItemId {
  const item = itemAt(index);
  selectIndex(index);
  setState('transfer.localSessionId', sessionId);
  setState('transfer.meta', fileMetaFor(item, file, sessionId, index));
  return item.queueItemId;
}

const exactHostSend = vi.fn();
const hostConn: DataConnection = {
  open: true,
  peer: 'host-1',
  send: exactHostSend,
  close: vi.fn(),
  on: () => undefined,
};

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();

  // Reset _state.ts module-level fields that resetState() cannot reach.
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  setPlayLocked(false);
  setPlayPreloadedInProgress(false);

  // Default mock behaviour (clearAllMocks wipes calls only, but the per-test
  // mockImplementationOnce queues must start empty and defaults re-primed).
  mocks.ensureRunning.mockReset();
  mocks.initAudio.mockReset();
  mocks.decodeAudioData.mockReset();
  mocks.readStoredFile.mockReset();
  mocks.cleanupStoredFile.mockReset();
  mocks.ensureRunning.mockResolvedValue(undefined);
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.decodeAudioData.mockResolvedValue({ duration: 120 } as AudioBuffer);
  mocks.readStoredFile.mockResolvedValue(null);
  mocks.createBufferSource.mockImplementation(() => makeFakeSourceNode());
  mocks.getCurrentTime.mockReturnValue(100);
  mocks.safeSend.mockReturnValue(true);
  mocks.isRemoteGuest.mockReturnValue(false);

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:concurrency-pin'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });

  setState('playlist.items', [
    makeTrack('t0.mp3'),
    makeTrack('t1.mp3'),
    makeTrack('t2.mp3'),
    makeTrack('t3.mp3'),
    makeTrack('t4.mp3'),
    makeTrack('t5.mp3'),
  ]);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

// ─── Pin (a): use-preloaded supersession protocol (contract C1) ──────

describe('pin (a) — use-preloaded supersession keeps the activation flag owned', () => {
  it('B supersedes in-flight A without stomping the flag; PLAY defers; A cannot clear; B consumes', async () => {
    setState('network.hostConn', hostConn);
    initPlayback();

    const decodeA = deferred<AudioBuffer>();
    const decodeB = deferred<AudioBuffer>();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise)
      .mockImplementationOnce(() => decodeB.promise);

    // A: activation for queue item 4 starts and blocks inside its decode.
    const queueItemIdA = selectIndex(4)!;
    const readyA = stagePreload(4, makeFile('t4.mp3'));
    bus.emit('storage:use-preloaded', queueItemIdA, 't4.mp3', readyA.sessionId);
    expect(isPlayPreloadedInProgress()).toBe(true);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // B: a preload for a DIFFERENT queue item arrives while A is still decoding.
    const queueItemIdB = selectIndex(5)!;
    const readyB = stagePreload(5, makeFile('t5.mp3'));
    const tokenBeforeB = getCurrentLoadEpoch();
    bus.emit('storage:use-preloaded', queueItemIdB, 't5.mp3', readyB.sessionId);

    // Supersession must NOT clear the flag (stomp rule C1) and must bump the
    // token so A self-resolves at its post-decode checkpoint.
    expect(isPlayPreloadedInProgress()).toBe(true);
    expect(getCurrentLoadEpoch()).toBe(tokenBeforeB + 1);
    // B's decode must actually be running, not merely staged in memory.
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));

    // Host PLAY lands inside the supersession window → flag gate defers it.
    await handleData(
      { type: MSG.PLAY, time: 33, queueItemId: queueItemIdB, name: 't5.mp3' },
      hostConn,
    );
    expect(getPendingPlayTime()).toBe(33);
    expect(getState('playback.activity')).not.toBe('playing');

    // A's decode finally lands → token-mismatch abort. A's stale finish must
    // be a no-op (B owns the activation) and A must PRESERVE the mailbox.
    decodeA.resolve({ duration: 90 } as AudioBuffer);
    await flushAsync(); // deterministic: A's abort continuation HAS run
    expect(isPlayPreloadedInProgress()).toBe(true);
    expect(getPendingPlayTime()).toBe(33);

    // B completes → consumes the pending play and clears the flag exactly once.
    decodeB.resolve({ duration: 120 } as AudioBuffer);
    await vi.waitFor(() => expect(isPlayPreloadedInProgress()).toBe(false));
    expect(getPendingPlayTime()).toBeUndefined();
    await vi.waitFor(() => expect(getState('playback.activity')).toBe('playing'));
  });
});

describe('direct PLAY preload activation deduplication', () => {
  it('does not decode the same Blob again when preload-ready re-emits use-preloaded', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(3);
    initPlayback();

    const file = makeFile('t4.mp3');
    const decode = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decode.promise);
    const ready = stagePreload(4, file);

    // The authoritative PLAY mismatch takes playback.ts's direct preload fast
    // path before preload.ts can deliver its completion notification.
    await handleData(
      { type: MSG.PLAY, time: 12, queueItemId: ready.queueItemId, name: file.name },
      hostConn,
    );
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));
    const epochAfterDirectActivation = getCurrentLoadEpoch();

    // The same finalized Blob can then arrive through the normal preload-ready
    // bridge. It must join the live activation rather than allocating a second
    // decode and superseding the first one.
    bus.emit('storage:use-preloaded', ready.queueItemId, file.name, ready.sessionId);
    await flushAsync(1);

    expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(getCurrentLoadEpoch()).toBe(epochAfterDirectActivation);

    decode.resolve({ duration: 120 } as AudioBuffer);
    await vi.waitFor(() => expect(isPlayPreloadedInProgress()).toBe(false));
    expect(getCurrentAudioBuffer()).toEqual({ duration: 120 });
  });

  it('keeps deduping the same Blob after teardown clears only the public flag', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(3);
    initPlayback();

    const file = makeFile('t4.mp3');
    const decode = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decode.promise);
    const ready = stagePreload(4, file);

    await handleData(
      { type: MSG.PLAY, time: 12, queueItemId: ready.queueItemId, name: file.name },
      hostConn,
    );
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // stopAllMedia/teardown can clear M4, but cannot cancel the browser's
    // native decoder. A duplicate notification must still join that target.
    setPlayPreloadedInProgress(false);
    bus.emit('storage:use-preloaded', ready.queueItemId, file.name, ready.sessionId);
    await flushAsync(1);
    expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1);

    decode.resolve({ duration: 120 } as AudioBuffer);
    await flushAsync();
  });

  it('restarts the same Blob after cancelInFlight invalidates the activation epoch', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(3);
    initPlayback();

    const file = makeFile('t4.mp3');
    const firstDecode = deferred<AudioBuffer>();
    const secondDecode = deferred<AudioBuffer>();
    mocks.decodeAudioData
      .mockImplementationOnce(() => firstDecode.promise)
      .mockImplementationOnce(() => secondDecode.promise);
    const ready = stagePreload(4, file);

    await handleData(
      { type: MSG.PLAY, time: 12, queueItemId: ready.queueItemId, name: file.name },
      hostConn,
    );
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    stopAllMedia({ cancelInFlight: true });
    bus.emit('storage:use-preloaded', ready.queueItemId, file.name, ready.sessionId);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));

    firstDecode.resolve({ duration: 90 } as AudioBuffer);
    await flushAsync();
    expect(getCurrentAudioBuffer()).not.toEqual({ duration: 90 });

    secondDecode.resolve({ duration: 120 } as AudioBuffer);
    await vi.waitFor(() => expect(getCurrentAudioBuffer()).toEqual({ duration: 120 }));
    expect(isPlayPreloadedInProgress()).toBe(false);
  });
});

describe('progress-aware preload waiter identity', () => {
  function waitingSession(sessionId: number, progress: number) {
    const queueItemId = queueItemIdAt(4);
    return {
      skipped: false,
      finalized: false,
      progress,
      total: 100,
      name: 'same.mp3',
      queueItemId,
      indexHint: 4,
      size: 100,
      mime: 'audio/mpeg',
      nextExpectedChunk: progress,
      sessionId,
    };
  }

  it('does not let a stale same-index/name session postpone the awaited session stall', async () => {
    vi.useFakeTimers();
    setState('network.hostConn', hostConn);
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    const queueItemId = selectIndex(4)!;
    initPlayback();

    bus.emit('storage:use-preloaded', queueItemId, 'same.mp3', 10);
    setState(
      'preload.sessionState',
      new Map([
        [11, waitingSession(11, 0)],
        [10, waitingSession(10, 0)],
      ]),
    );

    await vi.advanceTimersByTimeAsync(9_000);
    setState(
      'preload.sessionState',
      new Map([
        [11, waitingSession(11, 1)],
        [10, waitingSession(10, 0)],
      ]),
    );
    await vi.advanceTimersByTimeAsync(1_001);

    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_DATA_RECOVERY,
      nextChunk: 0,
      fileName: 'same.mp3',
      queueItemId,
      sessionId: 10,
    });
  });

  it('keeps a healthy exact-session transfer alive beyond sixty seconds', async () => {
    vi.useFakeTimers();
    setState('network.hostConn', hostConn);
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    const queueItemId = selectIndex(4)!;
    initPlayback();

    bus.emit('storage:use-preloaded', queueItemId, 'same.mp3', 10);
    for (let progress = 1; progress <= 7; progress++) {
      await vi.advanceTimersByTimeAsync(9_000);
      setState('preload.sessionState', new Map([[10, waitingSession(10, progress)]]));
    }
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_DATA_RECOVERY }),
    );

    await vi.advanceTimersByTimeAsync(10_001);
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_DATA_RECOVERY,
      nextChunk: 0,
      fileName: 'same.mp3',
      queueItemId,
      sessionId: 10,
    });
  });
});

describe('storage:file-ready transfer identity', () => {
  it('drops a stale same-name completion instead of treating the filename as identity', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeTrack('same.mp3')]);
    const queueItemId = selectIndex(0)!;
    setState('transfer.localSessionId', 8);
    setState('transfer.meta', fileMetaFor(itemAt(0), makeFile('same.mp3'), 8));
    initPlayback();

    bus.emit('storage:file-ready', 'same.mp3', 7, false, queueItemId);
    await flushAsync(1);

    expect(mocks.readStoredFile).not.toHaveBeenCalled();
    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects a completion whose queue occurrence disagrees with the active transfer', async () => {
    const { handleFileStart } = await import('../../storage/transfer-receive.ts');
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeTrack('same.mp3'), makeTrack('same.mp3')]);
    const selectedQueueItemId = selectIndex(0)!;
    const wrongQueueItemId = queueItemIdAt(1);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState('transfer.localSessionId', 8);
    setState('transfer.meta', fileMetaFor(itemAt(0), makeFile('same.mp3'), 8));
    setPlaybackTransferState(TRANSFER_STATE.PROCESSING);
    initPlayback();

    bus.emit('storage:file-ready', 'same.mp3', 8, false, wrongQueueItemId);
    await flushAsync(1);

    expect(mocks.cleanupStoredFile).toHaveBeenCalledWith(wrongQueueItemId, 'same.mp3', false, 8);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
    expect(mocks.readStoredFile).not.toHaveBeenCalled();
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: selectedQueueItemId,
      name: 'same.mp3',
      reason: 'file_ready_identity_mismatch',
    });

    handleFileStart(
      {
        type: MSG.FILE_START,
        name: 'same.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 3,
        sessionId: 8,
        queueItemId: selectedQueueItemId,
      },
      hostConn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({
        name: 'same.mp3',
        sessionId: 8,
        queueItemId: selectedQueueItemId,
        indexHint: 0,
      }),
    );
  });

  it('reads the active completion through its exact RAM-store session', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeTrack('same.mp3')]);
    const item = itemAt(0);
    selectIndex(0);
    setState('transfer.localSessionId', 8);
    setState('transfer.meta', fileMetaFor(item, makeFile(item.name), 8));
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    initPlayback();

    bus.emit('storage:file-ready', 'same.mp3', 8, false, item.queueItemId);
    await vi.waitFor(() =>
      expect(mocks.readStoredFile).toHaveBeenCalledWith(item.queueItemId, 'same.mp3', false, 8),
    );
  });

  it('records fresh-join PLAY as an exact pending recovery target', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentQueueItemId', null);
    const queueItemId = queueItemIdAt(4);
    initPlayback();

    await handleData({ type: MSG.PLAY, time: 12, queueItemId, name: 't4.mp3' }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({
      queueItemId,
      indexHint: 4,
      name: 't4.mp3',
    });
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });

  it('finalizes after chunk metadata recovers a lost FILE_START without losing the track index', async () => {
    const { resetIncomingTransferAuthority, handleFileChunk } =
      await import('../../storage/transfer-receive.ts');
    resetIncomingTransferAuthority();

    const file = makeFile('t4.mp3');
    setState('network.hostConn', hostConn);
    const queueItemId = selectIndex(4)!;
    setState('playback.pendingRecoveryTarget', { queueItemId, indexHint: 4, name: file.name });
    setState('transfer.localSessionId', 8);
    setState('transfer.meta', fileMetaFor(itemAt(4), file, 8));
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
    mocks.readStoredFile.mockResolvedValue(file);
    initPlayback();

    handleFileChunk(
      {
        type: MSG.FILE_CHUNK,
        name: file.name,
        mime: file.type,
        total: 1,
        size: file.size,
        sessionId: 8,
        queueItemId,
        chunkIndex: 0,
        chunk: new Uint8Array([1, 2, 3]),
      },
      hostConn,
    );
    expect(getState('transfer.meta')?.queueItemId).toBe(queueItemId);

    bus.emit('storage:file-ready', file.name, 8, false, queueItemId);

    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getCurrentAudioBuffer()).toEqual({ duration: 120 }));
    expect(mocks.readStoredFile).toHaveBeenCalledWith(queueItemId, file.name, false, 8);
  });

  it('carries authoritative PLAY identity through a newer chunk-only session and preserves play time', async () => {
    const { resetIncomingTransferAuthority, handleFileChunk } =
      await import('../../storage/transfer-receive.ts');
    resetIncomingTransferAuthority();

    const file = makeFile('t4.mp3');
    setState('network.hostConn', hostConn);
    selectIndex(3);
    const oldQueueItemId = queueItemIdAt(3);
    const queueItemId = queueItemIdAt(4);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', {
      ...fileMetaFor(itemAt(3), file, 7),
      queueItemId: oldQueueItemId,
      name: 't3.mp3',
    });
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
    mocks.readStoredFile.mockResolvedValue(file);
    initPlayback();

    await handleData({ type: MSG.PLAY, time: 12, queueItemId, name: file.name }, hostConn);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({
      queueItemId,
      indexHint: 4,
      name: file.name,
    });

    handleFileChunk(
      {
        type: MSG.FILE_CHUNK,
        name: file.name,
        mime: file.type,
        total: 1,
        size: file.size,
        sessionId: 8,
        queueItemId,
        chunkIndex: 0,
        chunk: new Uint8Array([1, 2, 3]),
      },
      hostConn,
    );
    expect(getState('transfer.meta')?.queueItemId).toBe(queueItemId);
    expect(getPendingPlayTime()).toBe(12);

    bus.emit('storage:file-ready', file.name, 8, false, queueItemId);

    await vi.waitFor(() => expect(getCurrentAudioBuffer()).toEqual({ duration: 120 }));
    expect(mocks.readStoredFile).toHaveBeenCalledWith(queueItemId, file.name, false, 8);
    expect(getPendingPlayTime()).toBeUndefined();
  });
});

// ─── Pin (b): watchdog fire — full reset tuple (contract C3 + C6) ────

describe('authoritative PAUSE bootstrap', () => {
  it('retains the host pause position even before a file transport exists', async () => {
    setState('network.hostConn', hostConn);
    initPlayback();

    await handleData({ type: MSG.PAUSE, time: 42, queueItemId: null, reason: 'pause' }, hostConn);

    expect(getState('player.pausedAt')).toBe(42);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('normalizes a negative host pause position instead of retaining invalid state', async () => {
    setState('network.hostConn', hostConn);
    setState('player.pausedAt', 17);
    initPlayback();

    await handleData({ type: MSG.PAUSE, time: -4, queueItemId: null, reason: 'pause' }, hostConn);

    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });
});

describe('late-join file bootstrap identity', () => {
  it('pins the exact host slot, Blob, and session across unicast transport awaits', async () => {
    const conn = { open: true, peer: 'guest-1' } as DataConnection;
    const file = makeFile('same.mp3');
    setState('playlist.items', [makeTrack(file.name)]);
    const item = itemAt(0);
    selectIndex(0);
    const currentResident: ResidentFile = {
      ...fileMetaFor(item, file, 7, 0),
      blob: file,
    };
    setState('files.current', currentResident);
    setState('network.connectedPeers', [
      {
        id: 'guest-1',
        slot: 0,
        label: 'Guest',
        conn,
        isOp: false,
        preloadedQueueItemIds: new Set<QueueItemId>(),
        status: 'connected',
        isDataTarget: true,
        joinOrder: 1,
        connectionType: 'local',
        lastHeartbeat: Date.now(),
      },
    ]);
    initPlayback();

    bus.emit('orchestrator:peer-joined', 'guest-1');
    await vi.waitFor(() => expect(mocks.unicastFile).toHaveBeenCalledTimes(1));

    expect(mocks.unicastFile).toHaveBeenCalledWith(
      conn,
      file,
      0,
      7,
      expect.objectContaining({
        queueItemId: item.queueItemId,
        isSourceCurrent: expect.any(Function),
      }),
    );
    const options = mocks.unicastFile.mock.calls[0]?.[4] as {
      isSourceCurrent: () => boolean;
    };
    expect(options.isSourceCurrent()).toBe(true);

    setState('files.current', { ...currentResident, blob: makeFile(file.name) });
    expect(options.isSourceCurrent()).toBe(false);

    setState('files.current', { ...currentResident, sessionId: 8 });
    expect(options.isSourceCurrent()).toBe(false);
  });
});

describe('pin (b) — 15s navigator-lock-watchdog resets the full tuple', () => {
  it('unlocks, clears pendingPlayTime, stops the node, bumps the token, idles, and the wedged play aborts', async () => {
    vi.useFakeTimers();

    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const { setPlaybackFilePlaying } = await import('../ownership.ts');
    setPlaybackFilePlaying();

    // A lingering node from previous playback — the watchdog must stop it.
    const staleNode = makeFakeSourceNode();
    setPlayerNode(staleNode as unknown as AudioBufferSourceNode);

    // Hold _internalPlay inside ensureRunning.
    const hang = deferred<void>();
    mocks.ensureRunning.mockReturnValue(hang.promise);

    const tokenBefore = getCurrentLoadEpoch();
    const playPromise = play(5);
    expect(isPlayLocked()).toBe(true);

    // A second play during the lock queues into the mailbox.
    await play(7);
    expect(getPendingPlayTime()).toBe(7);

    await vi.advanceTimersByTimeAsync(15_000);

    // Full reset tuple — all five together (contract C3). pendingPlayTime is
    // cleared (NOT consumed/replayed) so the unlock-delay consumer (C6) sees
    // a consistent no-pending state.
    expect(isPlayLocked()).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
    expect(staleNode.stop).toHaveBeenCalled();
    expect(getPlayerNode()).toBeNull();
    expect(getCurrentLoadEpoch()).toBe(tokenBefore + 1);
    expect(getState('playback.activity')).toBe('idle');

    // The blocked play resumes and must abort at its token checkpoint without
    // creating a node or writing PLAYING over the post-watchdog IDLE.
    hang.resolve();
    await playPromise;
    await vi.advanceTimersByTimeAsync(20); // unlock-delay window
    expect(mocks.createBufferSource).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('player.startedAt')).toBe(0);
    expect(isPlayLocked()).toBe(false);
  });
});

// ─── Pin (c): stopAllMedia during _internalPlay's await window (C4) ──

describe('pin (c) — stopAllMedia during the in-flight play window', () => {
  it('releases the lock immediately, resets the C4 tuple, and the aborted play leaves no phantom node', async () => {
    vi.useFakeTimers();

    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const hang = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(hang.promise);

    const playPromise = play(4);
    expect(isPlayLocked()).toBe(true);
    setPlayPreloadedInProgress(true); // part of the must-reset-together tuple

    stopAllMedia({ cancelInFlight: true });

    // stopAllMedia releases the lock immediately.
    expect(isPlayLocked()).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
    expect(isPlayPreloadedInProgress()).toBe(false);

    // The in-flight play resumes → token mismatch (cancelInFlight bumped it)
    // → no node, no PLAYING write.
    hang.resolve();
    await playPromise;
    await vi.advanceTimersByTimeAsync(20); // unlock-delay window
    expect(mocks.createBufferSource).not.toHaveBeenCalled();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.startedAt')).toBe(0);
  });
});

describe('play invocation owner — stale unlock/watchdog isolation', () => {
  it('does not revive a queued PLAY after its authority revision is superseded', async () => {
    vi.useFakeTimers();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const runningPlay = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(runningPlay.promise);

    const first = play(1);
    await vi.waitFor(() => expect(mocks.ensureRunning).toHaveBeenCalledOnce());

    let authorityRevision = 1;
    await play(7, 0, performance.now() + 1_000, () => authorityRevision === 1);
    expect(getPendingPlayTime()).toBe(7);

    // A newer authoritative PAUSE/revision invalidates the queued PLAY while
    // the original node start still owns the page-global lock.
    authorityRevision = 2;
    pause(4, { showToast: false });
    expect(getPendingPlayTime()).toBeUndefined();

    runningPlay.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(20);

    expect(mocks.ensureRunning).toHaveBeenCalledOnce();
    // PAUSE revokes the active async node start as well as the queued intent.
    // The invocation still owns and releases the lock through its finally,
    // but it must not make a stale source audible after the pause.
    expect(mocks.createBufferSource).not.toHaveBeenCalled();
    expect(getPendingPlayTime()).toBeUndefined();
  });

  it('does not let an older finally clear the replacement play watchdog or unlock its mailbox', async () => {
    vi.useFakeTimers();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const hangA = deferred<void>();
    const hangB = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(hangA.promise).mockReturnValueOnce(hangB.promise);

    const playA = play(1);
    expect(isPlayLocked()).toBe(true);

    stopAllMedia({ cancelInFlight: true });
    const playB = play(2);
    expect(isPlayLocked()).toBe(true);
    expect(getManagedTimer('navigator-lock-watchdog')).not.toBeNull();

    hangA.resolve();
    await playA;

    // A's stale finally used to clear B's named watchdog and arm an unlock
    // callback that released B ten milliseconds later.
    expect(getManagedTimer('navigator-lock-watchdog')).not.toBeNull();
    expect(getManagedTimer('playback-unlock-delay')).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(isPlayLocked()).toBe(true);

    await play(9);
    expect(mocks.ensureRunning).toHaveBeenCalledTimes(2);
    expect(getPendingPlayTime()).toBe(9);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(isPlayLocked()).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();

    hangB.resolve();
    await playB;
  });

  it('cancels an already-armed stale unlock before a replacement play claims the lock', async () => {
    vi.useFakeTimers();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    await play(1);
    expect(isPlayLocked()).toBe(true);
    expect(getManagedTimer('playback-unlock-delay')).not.toBeNull();

    stopAllMedia({ cancelInFlight: true });
    expect(getManagedTimer('playback-unlock-delay')).toBeNull();

    const hangB = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(hangB.promise);
    const playB = play(2);
    await vi.advanceTimersByTimeAsync(20);

    expect(isPlayLocked()).toBe(true);
    expect(getManagedTimer('navigator-lock-watchdog')).not.toBeNull();

    stopAllMedia({ cancelInFlight: true });
    hangB.resolve();
    await playB;
  });
});

// ─── Pin (d): finalizeGuestFile sessionId staleness checkpoints ──────

describe('pin (d) — finalizeGuestFile staleness at both sessionId checkpoints', () => {
  it('aborts at the PRE-decode checkpoint: no decode, no buffer publish', async () => {
    setState('network.hostConn', hostConn);
    const file = makeFile('t1.mp3');
    const queueItemId = stageGuestTransfer(1, file, 7);
    const prevBuffer = { duration: 50 } as AudioBuffer;
    setCurrentAudioBuffer(prevBuffer);

    // Hold finalization inside initAudio so a newer load invocation can
    // enter before the pre-decode checkpoint runs.
    const hangInit = deferred<void>();
    mocks.initAudio.mockReturnValueOnce(hangInit.promise);

    const p = finalizeGuestFile(file, queueItemId, 7);
    incrementLoadSessionId(); // any newer load invocation (self-bump pattern)
    hangInit.resolve();
    await p;

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(prevBuffer);
  });

  it('aborts at the POST-decode checkpoint: stale buffer unpublished, mailbox untouched', async () => {
    setState('network.hostConn', hostConn);
    const file = makeFile('t1.mp3');
    const queueItemId = stageGuestTransfer(1, file, 7);
    setPendingPlayTime(21);
    const prevBuffer = { duration: 50 } as AudioBuffer;
    setCurrentAudioBuffer(prevBuffer);

    const decodeD = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeD.promise);

    const p = finalizeGuestFile(file, queueItemId, 7);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    incrementLoadSessionId(); // superseded mid-decode
    decodeD.resolve({ duration: 200 } as AudioBuffer);
    await p;

    // Once decode detached the prior buffer, a newer transfer owner must not
    // let the stale finalize restore old-room/old-track PCM.
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('files.current')).toBeNull();
    expect(getPendingPlayTime()).toBe(21);
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('keeps PCM cleared when room teardown wins a pending native decode', async () => {
    initPlayback();
    setState('network.hostConn', hostConn);
    const file = makeFile('t1.mp3');
    const queueItemId = stageGuestTransfer(1, file, 7);
    setCurrentAudioBuffer({ duration: 50 } as AudioBuffer);
    const decodeD = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeD.promise);

    const p = finalizeGuestFile(file, queueItemId, 7);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true });
    setState('transfer.localSessionId', 0);
    setState('network.sessionCode', '');
    decodeD.resolve({ duration: 200 } as AudioBuffer);
    await p;

    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('files.current')).toBeNull();
  });

  it('tracks repeated unpublished native decode results for later iOS admission', async () => {
    setState('network.hostConn', hostConn);
    const queueItemId = stageGuestTransfer(1, makeFile('t1.mp3'), 7);
    const before = liveAudioBufferCount();
    const survivors: AudioBuffer[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const decodeD = deferred<AudioBuffer>();
      mocks.decodeAudioData.mockImplementationOnce(() => decodeD.promise);
      const pending = finalizeGuestFile(makeFile(`stale-${attempt}.mp3`), queueItemId, 7);
      await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(attempt + 1));
      incrementLoadSessionId();
      const decoded = { duration: 200 + attempt } as AudioBuffer;
      survivors.push(decoded);
      decodeD.resolve(decoded);
      await pending;
      expect(getCurrentAudioBuffer()).toBeNull();
    }

    const after = liveAudioBufferCount();
    expect(after.everSeen).toBe(before.everSeen + 2);
    // WeakRefs from earlier tests may be collected between these two snapshots,
    // so only assert the two buffers this test keeps strongly reachable.
    expect(after.live).toBeGreaterThanOrEqual(survivors.length);
    expect(liveAudioBufferPcmBytes(survivors[0])).toBeGreaterThanOrEqual(
      201 * 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT,
    );
    expect(liveAudioBufferPcmBytes(survivors[1])).toBeGreaterThanOrEqual(
      200 * 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT,
    );
  });
});

// ─── Pin (e): pendingPlayTime preserve/clear policy (BIDIRECTIONAL) ──
// The mailbox policy is asymmetric BY DESIGN (invariants doc §4). These pins
// fail BOTH under a uniform-clear refactor (preserve cases break) AND under a
// uniform-preserve refactor (clear cases break).

describe('pin (e) — loadPreloadedTrack pendingPlayTime policy matrix', () => {
  it('PRESERVES when selection no longer owns the requested queue item (pre-decode)', async () => {
    setState('network.hostConn', hostConn);
    const ready = stagePreload(2, makeFile('t2.mp3'));
    selectIndex(3); // current queue item no longer owns the ready resident
    setPendingPlayTime(12);

    const ok = await loadPreloadedTrack(ready.queueItemId);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // belongs to the LATEST MSG.PLAY
    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(isPlayPreloadedInProgress()).toBe(false); // own abort → own clear
  });

  it('PRESERVES on token-mismatch abort (post-decode)', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(2);
    const ready = stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(ready.queueItemId, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    newLoadEpoch(); // a newer load supersedes mid-decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // the newer load owns consumption
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('PRESERVES when queue selection changes during decode', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(2);
    const ready = stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(ready.queueItemId, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    selectIndex(5); // queue ownership changed during decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // preserved for the new track's loader
  });

  it('CLEARS on external-owner abort (pre-decode)', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(2);
    const ready = stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);
    setPlaybackYouTubePlaying(); // external owner takes over before activation

    const ok = await loadPreloadedTrack(ready.queueItemId);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined(); // nobody will consume it
  });

  it('CLEARS on external-owner abort (post-decode)', async () => {
    setState('network.hostConn', hostConn);
    selectIndex(2);
    const ready = stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(ready.queueItemId, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    setPlaybackYouTubePlaying(); // external owner takes over mid-decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
  });

  it('PRESERVES while a missing resident is recovered for the selected queue item', async () => {
    setState('network.hostConn', hostConn);
    const queueItemId = selectIndex(2)!;
    setPendingPlayTime(12);

    const ok = await loadPreloadedTrack(queueItemId);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBe(12);
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId,
      name: 't2.mp3',
      reason: 'preload_resident_missing',
    });
  });
});

// ─── Pin (f): superseded activation's catch path is inert ────────────

describe('pin (f) — superseded activation failure cannot clear the live activation', () => {
  it("a superseded activation's decode failure leaves flag + mailbox to the superseder", async () => {
    setState('network.hostConn', hostConn);
    selectIndex(4);
    const ready = stagePreload(4, makeFile('t4.mp3'));

    const decodeA = deferred<AudioBuffer>();
    const decodeB = deferred<AudioBuffer>();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise)
      .mockImplementationOnce(() => decodeB.promise);

    const pA = loadPreloadedTrack(ready.queueItemId);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // B begins a NEW activation while A is still decoding — B takes ownership
    // of the flag. The tripwire this pin actually exercises is the catch-path
    // isCurrentPreloadActivation early-return (stale A's failure path goes
    // inert); finish()'s compare-before-clear guard is pinned by pin (a).
    // The pair is complementary — both must hold.
    const pB = loadPreloadedTrack(ready.queueItemId);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));
    expect(isPlayPreloadedInProgress()).toBe(true);
    setPendingPlayTime(44);

    // A dies AFTER being superseded — its catch path must be fully inert.
    decodeA.reject(new Error('decode blew up'));
    expect(await pA).toBe(false);
    expect(isPlayPreloadedInProgress()).toBe(true); // B still owns the flag
    expect(getPendingPlayTime()).toBe(44); // stale catch must not clear it
    // ...and no failure side effects fired on behalf of the live activation.
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );

    // B completes normally → the owner clears exactly once and consumes.
    decodeB.resolve({ duration: 120 } as AudioBuffer);
    expect(await pB).toBe(true);
    expect(isPlayPreloadedInProgress()).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
  });
});

// ─── Pin (g): OWNER DECISION — finalize immunity to token bumps ──────
// Guest finalization must survive unrelated load-epoch bumps from watchdog or
// cancellation paths, which keeps activeLoadSessionId as a separate scope.

// ─── Pin (j): finalize aborts when a NEW transfer session starts ─────
// FILE_PREPARE changes neither the load epoch nor activeLoadSessionId, so guest
// finalization also snapshots transfer.localSessionId. A stale finalize must
// not publish READY or clear watchdogs for the replacement transfer.

describe('pin (j) — finalizeGuestFile aborts when a new transfer session starts mid-decode', () => {
  it('leaves the new download untouched: RECEIVING + chunkWatchdog stay, nothing published', async () => {
    setState('network.hostConn', hostConn);
    const file = makeFile('t1.mp3');
    const queueItemId = stageGuestTransfer(1, file, 5);
    setPendingPlayTime(42);

    // t1's pipeline, the way storage:file-ready drives it.
    transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name: 't1.mp3' });
    transition({ type: 'FILE_END', queueItemId });
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);

    const decodeJ = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeJ.promise);

    const p = finalizeGuestFile(file, queueItemId, 5);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // Host switches to t2 mid-decode: transfer-receive's new-session reset +
    // FILE_START, condensed. Note: no epoch bump, no M2 bump.
    const replacementFile = makeFile('t2.mp3');
    const replacementQueueItemId = stageGuestTransfer(2, replacementFile, 6);
    transition({
      type: 'FILE_PREPARE',
      variant: 'fresh',
      queueItemId: replacementQueueItemId,
      name: 't2.mp3',
    });
    setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
    const watchdog = vi.fn();
    setManagedTimer('chunkWatchdog', watchdog, 60_000);

    decodeJ.resolve({ duration: 200 } as AudioBuffer);
    await p;

    // Stale finalize must be fully inert:
    expect(getCurrentAudioBuffer()).toBeNull(); // no stale buffer publish
    expect(getState('files.current')).toBeNull(); // no stale resident publish
    expect(getState('player.currentTrackMeta')).toBeNull(); // t2's meta not bound to t1's audio
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING); // chunk-drop guard NOT armed
    expect(getManagedTimer('chunkWatchdog')).not.toBeNull(); // recovery path intact
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING); // t2's download phase intact
    expect(getPendingPlayTime()).toBe(42); // don't-touch policy (§4)
  });
});

describe('completion consumers — exact post-play ownership', () => {
  it('does not let an old finalizer consume a newer same-qid transfer mailbox', async () => {
    setState('network.hostConn', hostConn);
    const fileA = makeFile('same.mp3');
    const queueItemId = stageGuestTransfer(1, fileA, 5);
    setPendingPlayTime(30);
    transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name: fileA.name });
    transition({ type: 'FILE_END', queueItemId });

    const hangPlay = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(hangPlay.promise);
    const armInitial = vi.fn();
    bus.on('sync:arm-initial', armInitial);

    const finalizeA = finalizeGuestFile(fileA, queueItemId, 5);
    await vi.waitFor(() => expect(mocks.ensureRunning).toHaveBeenCalledTimes(1));

    // A fresh FILE_START for the same queue occurrence does not allocate a
    // load epoch, but it does replace the exact transfer/session owner and
    // publishes a new PLAY intent for its eventual finalizer.
    const fileB = makeFile('same.mp3');
    setState('transfer.localSessionId', 6);
    setState('transfer.meta', fileMetaFor(itemAt(1), fileB, 6, 1));
    setState('files.current', null);
    setCurrentAudioBuffer(null);
    setPendingPlayTime(44);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);

    hangPlay.resolve();
    await finalizeA;

    expect(getPendingPlayTime()).toBe(44);
    expect(armInitial).not.toHaveBeenCalled();
    expect(getManagedTimer('playback-finalize-host-sync')).toBeNull();
  });

  it('does not let an old preload completion consume or sync a replacement resident', async () => {
    vi.useFakeTimers();
    setState('network.hostConn', hostConn);
    const fileA = makeFile('same.mp3');
    setState('playlist.items', [makeTrack('t0.mp3'), makeTrack(fileA.name)]);
    selectIndex(1);
    const readyA = stagePreload(1, fileA, 5);
    setPendingPlayTime(30);

    const hangPlay = deferred<void>();
    mocks.ensureRunning.mockReturnValueOnce(hangPlay.promise);
    const armInitial = vi.fn();
    const forceResync = vi.fn();
    bus.on('sync:arm-initial', armInitial);
    bus.on('sync:force-resync', forceResync);

    const activationA = loadPreloadedTrack(readyA.queueItemId, getCurrentLoadEpoch());
    await vi.waitFor(() => expect(mocks.ensureRunning).toHaveBeenCalledTimes(1));

    const fileB = makeFile('same.mp3');
    newLoadEpoch();
    setState('files.current', {
      ...fileMetaFor(itemAt(1), fileB, 6, 1),
      blob: fileB,
    });
    setCurrentAudioBuffer(null);
    setPendingPlayTime(44);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);

    hangPlay.resolve();
    await activationA;
    await vi.advanceTimersByTimeAsync(600);

    expect(getPendingPlayTime()).toBe(44);
    expect(armInitial).not.toHaveBeenCalled();
    expect(forceResync).not.toHaveBeenCalled();
    expect(getManagedTimer('playback-preload-host-sync')).toBeNull();
  });
});

describe('pin (g) — owner decision: finalizeGuestFile is immune to loadToken bumps', () => {
  it('publishes buffer + DECODE_SUCCESS + consumes pendingPlayTime despite mid-decode token bumps', async () => {
    setState('network.hostConn', hostConn);
    const file = makeFile('t1.mp3');
    const queueItemId = stageGuestTransfer(1, file, 5);
    setPendingPlayTime(30);

    // Drive the FSM the way the storage:file-ready handler does, so the
    // DECODE_SUCCESS assertion below exercises the real transition table.
    transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name: 't1.mp3' });
    transition({ type: 'FILE_END', queueItemId });
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);

    const decodeG = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeG.promise);

    const p = finalizeGuestFile(file, queueItemId, 5);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // Watchdog-/cancelInFlight-style token bumps land mid-decode.
    newLoadEpoch();
    newLoadEpoch();

    const decoded = { duration: 120 } as AudioBuffer;
    decodeG.resolve(decoded);
    await p;

    // The finalize must complete in full: buffer swap...
    expect(getCurrentAudioBuffer()).toBe(decoded);
    // ...DECODE_SUCCESS transition...
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.READY);
    // ...and pendingPlayTime consumption → playback actually starts.
    expect(getPendingPlayTime()).toBeUndefined();
    await vi.waitFor(() => expect(getState('playback.activity')).toBe('playing'));
    expect(mocks.createBufferSource).toHaveBeenCalled();
  });
});

describe('unbounded decode accounting', () => {
  it('does not stall a preload activation behind a large receive lease', async () => {
    const { reserveEncodedReceiveMemoryWithinBudget, resolveDecodeMemoryBudget } =
      await import('../decode-admission.ts');
    const budget = resolveDecodeMemoryBudget({ userAgent: 'desktop' });
    const blocker = reserveEncodedReceiveMemoryWithinBudget(384 * 1024 * 1024, { budget });
    try {
      const file = makeFile('blocked.mp3');
      const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
      setState('network.hostConn', hostConn);
      setState('playlist.items', [makeTrack(file.name)]);
      selectIndex(0);
      const ready = stagePreload(0, file);

      const activation = loadPreloadedTrack(ready.queueItemId);

      await expect(activation).resolves.toBe(true);
      expect(arrayBuffer).toHaveBeenCalledOnce();
      expect(mocks.decodeAudioData).toHaveBeenCalledOnce();
    } finally {
      blocker.release();
    }
  });
});

describe('PRO scheduled-file commit deadline compensation', () => {
  it('advances the file position when async setup reaches an already-late deadline', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    selectIndex(0);

    await play(5, 0, 750, () => true);

    expect(getState('player.pausedAt')).toBeCloseTo(5.25, 5);
    now.mockRestore();
  });
});
