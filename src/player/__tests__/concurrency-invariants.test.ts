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
 *       on external-owner/no-blob aborts, so a uniform-clear refactor and a
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
import { getState, resetState, setState } from '../../core/state.ts';
import { handleData } from '../../network/protocol.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';

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
  broadcastSystemNotice: vi.fn(),
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
  postCommand: vi.fn(),
  cleanupStoredFile: vi.fn(),
  readStoredFile: vi.fn(),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
  unicastFile: vi.fn(),
  fetchDemoFromServer: vi.fn(() => Promise.resolve()),
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
  broadcastSystemNotice: mocks.broadcastSystemNotice,
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
  newLoadEpoch,
  isPlayLocked,
  isPlayPreloadedInProgress,
  setCurrentAudioBuffer,
  setPendingPlayTime,
  setPlayerNode,
  setPlayLocked,
  setPlayPreloadedInProgress,
} from '../_state.ts';
import { play, stopAllMedia } from '../transport.ts';
import { finalizeGuestFile, loadPreloadedTrack } from '../decode.ts';
import { initPlayback } from '../playback.ts';
import { transition } from '../lifecycle.ts';
import { setPlaybackTransferState, setPlaybackYouTubePlaying } from '../ownership.ts';

// ─── Helpers ─────────────────────────────────────────────────────────

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
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

function makeTrack(name: string): PlaylistItem {
  return { type: 'file', name, title: name, videoId: null, playlistId: null };
}

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' });
}

/** Populate a ready-to-activate preload slot for `index`. */
function stagePreload(index: number, file: File): void {
  setState('preload.nextFileBlob', file);
  setState('preload.meta', { name: file.name, index, sessionId: index + 1 });
  setState('preload.nextTrackIndex', index);
}

const hostConn = { open: true, peer: 'host-1' } as DataConnection;

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
  mocks.ensureRunning.mockResolvedValue(undefined);
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.decodeAudioData.mockResolvedValue({ duration: 120 } as AudioBuffer);
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

    // A: activation for index 4 starts and blocks inside its decode.
    setState('playlist.currentTrackIndex', 4);
    stagePreload(4, makeFile('t4.mp3'));
    bus.emit('storage:use-preloaded', 4, 't4.mp3');
    expect(isPlayPreloadedInProgress()).toBe(true);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // B: a preload for a DIFFERENT index arrives while A is still decoding.
    setState('playlist.currentTrackIndex', 5);
    stagePreload(5, makeFile('t5.mp3'));
    const tokenBeforeB = getCurrentLoadEpoch();
    bus.emit('storage:use-preloaded', 5, 't5.mp3');

    // Supersession must NOT clear the flag (stomp rule C1) and must bump the
    // token so A self-resolves at its post-decode checkpoint.
    expect(isPlayPreloadedInProgress()).toBe(true);
    expect(getCurrentLoadEpoch()).toBe(tokenBeforeB + 1);
    // B's decode must actually be running, not merely staged in memory.
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));

    // Host PLAY lands inside the supersession window → flag gate defers it.
    await handleData({ type: MSG.PLAY, time: 33, index: 5, name: 't5.mp3' }, hostConn);
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

// ─── Pin (b): watchdog fire — full reset tuple (contract C3 + C6) ────

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

// ─── Pin (d): finalizeGuestFile sessionId staleness checkpoints ──────

describe('pin (d) — finalizeGuestFile staleness at both sessionId checkpoints', () => {
  it('aborts at the PRE-decode checkpoint: no decode, no buffer publish', async () => {
    setState('network.hostConn', hostConn);
    const prevBuffer = { duration: 50 } as AudioBuffer;
    setCurrentAudioBuffer(prevBuffer);

    // Hold finalization inside initAudio so a newer load invocation can
    // enter before the pre-decode checkpoint runs.
    const hangInit = deferred<void>();
    mocks.initAudio.mockReturnValueOnce(hangInit.promise);

    const p = finalizeGuestFile(makeFile('t1.mp3'));
    incrementLoadSessionId(); // any newer load invocation (self-bump pattern)
    hangInit.resolve();
    await p;

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(getCurrentAudioBuffer()).toBe(prevBuffer);
  });

  it('aborts at the POST-decode checkpoint: stale buffer unpublished, mailbox untouched', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 1);
    setPendingPlayTime(21);
    const prevBuffer = { duration: 50 } as AudioBuffer;
    setCurrentAudioBuffer(prevBuffer);

    const decodeD = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeD.promise);

    const p = finalizeGuestFile(makeFile('t1.mp3'));
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    incrementLoadSessionId(); // superseded mid-decode
    decodeD.resolve({ duration: 200 } as AudioBuffer);
    await p;

    // Stale finalize must not publish, must not consume, must not start play.
    expect(getCurrentAudioBuffer()).toBe(prevBuffer);
    expect(getState('files.currentFileBlob')).toBeNull();
    expect(getPendingPlayTime()).toBe(21);
    expect(getState('playback.activity')).not.toBe('playing');
  });
});

// ─── Pin (e): pendingPlayTime preserve/clear policy (BIDIRECTIONAL) ──
// The mailbox policy is asymmetric BY DESIGN (invariants doc §4). These pins
// fail BOTH under a uniform-clear refactor (preserve cases break) AND under a
// uniform-preserve refactor (clear cases break).

describe('pin (e) — loadPreloadedTrack pendingPlayTime policy matrix', () => {
  it('PRESERVES on index-mismatch abort (pre-decode)', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 3); // current ≠ target
    stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const ok = await loadPreloadedTrack(2);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // belongs to the LATEST MSG.PLAY
    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(isPlayPreloadedInProgress()).toBe(false); // own abort → own clear
  });

  it('PRESERVES on token-mismatch abort (post-decode)', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 2);
    stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(2, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    newLoadEpoch(); // a newer load supersedes mid-decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // the newer load owns consumption
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('PRESERVES on index-changed-during-decode abort', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 2);
    stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(2, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    setState('playlist.currentTrackIndex', 5); // track changed during decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBe(12); // preserved for the new track's loader
  });

  it('CLEARS on external-owner abort (pre-decode)', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 2);
    stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);
    setPlaybackYouTubePlaying(); // external owner takes over before activation

    const ok = await loadPreloadedTrack(2);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined(); // nobody will consume it
  });

  it('CLEARS on external-owner abort (post-decode)', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 2);
    stagePreload(2, makeFile('t2.mp3'));
    setPendingPlayTime(12);

    const decodeE = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeE.promise);
    const myToken = newLoadEpoch();
    const p = loadPreloadedTrack(2, myToken);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    setPlaybackYouTubePlaying(); // external owner takes over mid-decode
    decodeE.resolve({ duration: 80 } as AudioBuffer);

    expect(await p).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
  });

  it('CLEARS on no-blob abort', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 2);
    setState('preload.nextFileBlob', null);
    setPendingPlayTime(12);

    const ok = await loadPreloadedTrack(2);

    expect(ok).toBe(false);
    expect(getPendingPlayTime()).toBeUndefined();
  });
});

// ─── Pin (f): superseded activation's catch path is inert ────────────

describe('pin (f) — superseded activation failure cannot clear the live activation', () => {
  it("a superseded activation's decode failure leaves flag + mailbox to the superseder", async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 4);
    stagePreload(4, makeFile('t4.mp3'));

    const decodeA = deferred<AudioBuffer>();
    const decodeB = deferred<AudioBuffer>();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise)
      .mockImplementationOnce(() => decodeB.promise);

    const pA = loadPreloadedTrack(4);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // B begins a NEW activation while A is still decoding — B takes ownership
    // of the flag. The tripwire this pin actually exercises is the catch-path
    // isCurrentPreloadActivation early-return (stale A's failure path goes
    // inert); finish()'s compare-before-clear guard is pinned by pin (a).
    // The pair is complementary — both must hold.
    const pB = loadPreloadedTrack(4);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));
    expect(isPlayPreloadedInProgress()).toBe(true);
    setPendingPlayTime(44);

    // A dies AFTER being superseded — its catch path must be fully inert.
    decodeA.reject(new Error('decode blew up'));
    expect(await pA).toBe(false);
    expect(isPlayPreloadedInProgress()).toBe(true); // B still owns the flag
    expect(getPendingPlayTime()).toBe(44); // stale catch must not clear it
    // ...and no failure side effects fired on behalf of the live activation.
    expect(mocks.sendToHost).not.toHaveBeenCalledWith(
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
    setState('playlist.currentTrackIndex', 1);
    setState('transfer.localSessionId', 5);
    setPendingPlayTime(42);

    // t1's pipeline, the way storage:file-ready drives it.
    transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 1, name: 't1.mp3' });
    transition({ type: 'FILE_END' });
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);

    const decodeJ = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeJ.promise);

    const p = finalizeGuestFile(makeFile('t1.mp3'));
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1));

    // Host switches to t2 mid-decode: transfer-receive's new-session reset +
    // FILE_START, condensed. Note: no epoch bump, no M2 bump.
    setState('transfer.localSessionId', 6);
    transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 2, name: 't2.mp3' });
    setState('playlist.currentTrackIndex', 2);
    setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
    const watchdog = vi.fn();
    setManagedTimer('chunkWatchdog', watchdog, 60_000);

    decodeJ.resolve({ duration: 200 } as AudioBuffer);
    await p;

    // Stale finalize must be fully inert:
    expect(getCurrentAudioBuffer()).toBeNull(); // no stale buffer publish
    expect(getState('files.currentFileBlob')).toBeNull(); // no stale blob publish
    expect(getState('player.currentTrackMeta')).toBeNull(); // t2's meta not bound to t1's audio
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING); // chunk-drop guard NOT armed
    expect(getManagedTimer('chunkWatchdog')).not.toBeNull(); // recovery path intact
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING); // t2's download phase intact
    expect(getPendingPlayTime()).toBe(42); // don't-touch policy (§4)
  });
});

describe('pin (g) — owner decision: finalizeGuestFile is immune to loadToken bumps', () => {
  it('publishes buffer + DECODE_SUCCESS + consumes pendingPlayTime despite mid-decode token bumps', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.currentTrackIndex', 1);
    setPendingPlayTime(30);

    // Drive the FSM the way the storage:file-ready handler does, so the
    // DECODE_SUCCESS assertion below exercises the real transition table.
    transition({ type: 'FILE_PREPARE', variant: 'fresh', index: 1, name: 't1.mp3' });
    transition({ type: 'FILE_END' });
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);

    const decodeG = deferred<AudioBuffer>();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeG.promise);

    const p = finalizeGuestFile(makeFile('t1.mp3'));
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
