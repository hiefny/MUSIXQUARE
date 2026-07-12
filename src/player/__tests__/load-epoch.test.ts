/**
 * @vitest-environment jsdom
 *
 * Load-epoch and preload-activation ownership invariants.
 *
 * concurrency-invariants.test.ts covers the wider protocol. This file covers
 * the M1/M4 ownership corner documented in
 * docs/design/playback-concurrency-invariants.md:
 *
 *   (h) activation ownership is compared by handle IDENTITY, not epoch
 *       currency: an unrelated epoch allocation mid-activation (watchdog
 *       fire, cancelInFlight stop) must NOT prevent the superseded
 *       activation's own abort path from clearing playPreloadedInProgress.
 *       Deriving "is current owner" from `epoch === latest` would strand the
 *       flag true forever here — every subsequent PLAY queues into the
 *       mailbox and file playback remains blocked. The complementary case,
 *       two activations sharing one epoch, is covered in the main suite.
 *
 * Mock surface mirrors concurrency-invariants.test.ts: transport.ts /
 * decode.ts / lifecycle.ts / ownership.ts are REAL; only the audio layer,
 * network peer, storage, share, chat, and toast seams are mocked. Module
 * boundaries remain unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getState, resetState, setState } from '../../core/state.ts';
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
  getFilePlaybackDestination: vi.fn(() => null),
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
  postCommand: vi.fn(),
  cleanupStoredFile: vi.fn(),
  discardResidentStoredFileAdmission: vi.fn(() => false),
  promoteStoredFileAdmission: vi.fn(() => false),
  readStoredFile: vi.fn(),
  retainStoredFileAdmission: vi.fn(() => false),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
  unicastFile: vi.fn(),
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
  isPlayPreloadedInProgress,
  newLoadEpoch,
  setCurrentAudioBuffer,
  setPlayerNode,
  setPlayLocked,
  setPlayPreloadedInProgress,
} from '../_state.ts';
import { loadPreloadedTrack } from '../decode.ts';

// ─── Helpers (mirrors concurrency-invariants.test.ts) ────────────────

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

function stagePreload(index: number, file: File): QueueItemId {
  const item = getState('playlist.items')[index];
  if (!item) throw new Error(`missing queue item at index ${index}`);
  const sessionId = index + 1;
  const meta: FileMeta = {
    queueItemId: item.queueItemId,
    indexHint: index,
    name: file.name,
    type: file.type,
    mime: file.type,
    size: file.size,
    total: 1,
    sessionId,
  };
  const ready: ResidentFile = { ...meta, blob: file };
  setState('preload.nextQueueItemId', item.queueItemId);
  setState('preload.activeTarget', meta);
  setState('preload.ready', ready);
  return item.queueItemId;
}

const hostConn = { open: true, peer: 'host-1' } as DataConnection;

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();

  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  setPlayLocked(false);
  setPlayPreloadedInProgress(false);

  mocks.ensureRunning.mockResolvedValue(undefined);
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.decodeAudioData.mockResolvedValue({ duration: 120 } as AudioBuffer);
  mocks.getCurrentTime.mockReturnValue(100);
  mocks.safeSend.mockReturnValue(true);
  mocks.isRemoteGuest.mockReturnValue(false);

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:load-epoch-pin'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });

  setState('playlist.items', [makeTrack('t0.mp3'), makeTrack('t1.mp3'), makeTrack('t2.mp3')]);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

// ─── Pin (h): ownership by handle identity, not epoch currency ───────

describe('pin (h) — unrelated epoch bump mid-activation must not strand the flag', () => {
  it('superseded activation still clears its own flag on the epoch-supersession abort path', async () => {
    setState('network.hostConn', hostConn);
    const queueItemId = stagePreload(2, makeFile('t2.mp3'));
    setState('playlist.currentQueueItemId', queueItemId);

    const decodeH = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeH.promise);

    const myEpoch = newLoadEpoch();
    const p = loadPreloadedTrack(queueItemId, myEpoch);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));
    expect(isPlayPreloadedInProgress()).toBe(true);

    // An UNRELATED epoch allocation lands mid-decode (watchdog fire /
    // cancelInFlight stop elsewhere). No new activation begins, so flag
    // ownership stays with the in-flight activation.
    newLoadEpoch();

    decodeH.resolve({ duration: 80 } as AudioBuffer);
    expect(await p).toBe(false); // epoch superseded → abort, per pin (e)

    // The aborting OWNER must clear its own flag (handle-identity match in
    // finishPreloadActivation). An "is current = epoch equality" owner check
    // would no-op here and strand the flag true, blocking every future PLAY
    // behind handlePlayMsg's flag gate.
    expect(isPlayPreloadedInProgress()).toBe(false);
  });
});
