/**
 * Store-authoritative FILE_RESUME tests.
 *
 * The FILE_RESUME handler is the ONLY site where transfer.receivedCount is
 * set from a protocol message field. These tests pin the reconciliation
 * invariant: no resume baseline may exceed the ramstore's contiguous prefix,
 * counters (receivedCount + nextExpectedChunk) move together, and a
 * baseline shortfall re-asks the host from store truth via the bus.
 *
 * ramstore is REAL here; ../storage.ts is a delegating spy (vi.fn wrapping
 * the actual postCommand) so payload assertions AND real store effects both
 * work. postCommand defers dispatch via queueMicrotask — flush before
 * asserting ramstore effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { CHUNK_SIZE, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  ramStart,
  ramWrite,
  ramEnd,
  ramReadBlob,
  ramContiguousCount,
  __resetRamStoreForTests,
} from '../ramstore.ts';

vi.mock('../storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage.ts')>();
  return {
    ...actual,
    postCommand: vi.fn(actual.postCommand),
    cleanupStoredFile: vi.fn(),
  };
});

vi.mock('../../network/peer.ts', () => ({
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
  waitForGuestConnectionType: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  cancelRemoteShareWait: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => true),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
}));

const u8 = (...bytes: number[]) => new Uint8Array(bytes);
const FOUR_CHUNK_FILE_SIZE = 3 * CHUNK_SIZE + 1;
const TWO_CHUNK_FILE_SIZE = CHUNK_SIZE + 1;

describe('handleFileResume — store-authoritative baseline (STO-RESUME)', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  const resumeMsg = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'file-resume',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    total: 4,
    size: FOUR_CHUNK_FILE_SIZE,
    startChunk: 2,
    sessionId: 6,
    index: 0,
    ...overrides,
  });

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    __resetRamStoreForTests();
    const { resetStoredFileAdmissionsForTests } = await import('../storage.ts');
    resetStoredFileAdmissionsForTests();
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
    // Mid-download stall posture: guest was receiving under session 5.
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('transfer.localSessionId', 5);
    setState('transfer.meta', {
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 5,
      index: 0,
    });
  });

  it('honors startChunk on a same-session resume backed by the store prefix', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    // Guest really holds chunks [0..1] under the same session.
    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));

    handleFileResume(resumeMsg({ sessionId: 5 }), conn);

    expect(getState('transfer.receivedCount')).toBe(2);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        filename: 'song.mp3',
        isPreload: false,
        sessionId: 5,
        keepExisting: true,
      }),
    );
    // Baseline matches the assertion — no re-ask needed.
    expect(recoverySpy).not.toHaveBeenCalled();
  });

  it('does not reuse a prefix when the playlist index differs inside the same session', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));

    handleFileResume(resumeMsg({ sessionId: 5, index: 1 }), conn);

    expect(getState('transfer.receivedCount')).toBe(0);
    expect(getState('playlist.currentTrackIndex')).toBe(1);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 5, keepExisting: false }),
    );
    expect(recoverySpy).toHaveBeenCalledWith(0);
  });

  it('discards a same-name/same-size prefix from a different session', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));
    // FILE_PREPARE for B arrived, but FILE_START did not. State now names B
    // while the physical RAM slot still belongs to same-name session A.
    setState('transfer.meta', {
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 6,
      index: 0,
    });

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 2 }), conn);

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.receivedCount')).toBe(0);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 6, keepExisting: false }),
    );
    expect(recoverySpy).toHaveBeenCalledWith(0);
  });

  it('does not mistake a same-name finalized blob from another session for the resume target', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa, 0xbb));
    ramWrite('song.mp3', false, 5, 1, u8(0xcc, 0xdd));
    ramEnd('song.mp3', false, 5, 4, 2);
    setState('transfer.meta', {
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 6,
      index: 0,
    });

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 2 }), conn);

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.receivedCount')).toBe(0);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 6, keepExisting: false }),
    );
    expect(recoverySpy).toHaveBeenCalledWith(0);
  });

  it('adopts the authoritative FILE_START index when FILE_PREPARE was lost', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    setState('playlist.currentTrackIndex', 3);

    handleFileStart(
      {
        type: 'file-start',
        name: 'replacement.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        index: 4,
      },
      conn,
    );

    expect(getState('playlist.currentTrackIndex')).toBe(4);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({
      index: 4,
      name: 'replacement.mp3',
    });
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ sessionId: 6, index: 4, name: 'replacement.mp3' }),
    );
  });

  it('enters DOWNLOADING when FILE_START is the first surviving control frame', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);

    handleFileStart(
      {
        type: 'file-start',
        name: 'first-control.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        index: 2,
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentTrackIndex')).toBe(2);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  });

  it('enters DOWNLOADING when FILE_RESUME is the first surviving control frame', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);

    handleFileResume(resumeMsg({ sessionId: 6, index: 2, startChunk: 0 }), conn);

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentTrackIndex')).toBe(2);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  });

  it('replaces a finalized same-session RAM slot when FILE_START requests a fresh stream', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa, 0xbb));
    ramWrite('song.mp3', false, 5, 1, u8(0xcc, 0xdd));
    ramEnd('song.mp3', false, 5, 4, 2);
    expect(ramReadBlob('song.mp3', false, 5)?.size).toBe(4);

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 4,
        sessionId: 5,
        index: 0,
      },
      conn,
    );
    await Promise.resolve();

    expect(ramReadBlob('song.mp3', false, 5)).toBeNull();
    expect(ramContiguousCount('song.mp3', false, 5)).toBe(0);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  });

  it('clamps a phantom startChunk to store truth and re-asks from the real base', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    // Counters claimed 3, store only holds chunk 0.
    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));

    // Trap-warning pin: by the time the re-ask goes out, counters must
    // already be rebased — the host's stale in-flight tail otherwise drains
    // against the phantom baseline.
    const seenAtEmit: Array<{ forceChunk: number | undefined; receivedCount: number }> = [];
    bus.on('storage:request-recovery', (forceChunk?: number) => {
      seenAtEmit.push({ forceChunk, receivedCount: getState('transfer.receivedCount') });
    });

    handleFileResume(resumeMsg({ sessionId: 5, startChunk: 3 }), conn);

    expect(getState('transfer.receivedCount')).toBe(1);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 5, keepExisting: true }),
    );
    expect(seenAtEmit).toEqual([{ forceChunk: 1, receivedCount: 1 }]);
  });

  it('degrades to a fresh start from 0 when exact session identity does not hold', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    // Store has a prefix, but the in-flight meta says different bytes.
    setState('transfer.meta', { name: 'song.mp3', size: 999, total: 4, sessionId: 5, index: 0 });
    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 2 }), conn);

    expect(getState('transfer.receivedCount')).toBe(0);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 6, keepExisting: false }),
    );
    // Without this forceChunk=0 ask, the host streams only [startChunk..)
    // and convergence would depend on FILE_END surviving.
    expect(recoverySpy).toHaveBeenCalledWith(0);
  });

  it('still drops a stale-session resume', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);
    setState('transfer.receivedCount', 1);

    handleFileResume(resumeMsg({ sessionId: 4, startChunk: 2 }), conn);

    expect(postCommand).not.toHaveBeenCalled();
    expect(getState('transfer.receivedCount')).toBe(1);
    expect(getState('transfer.localSessionId')).toBe(5);
    expect(recoverySpy).not.toHaveBeenCalled();
  });

  // A recovery timer armed before finalization may fire afterward. Its resume
  // response must not reopen an already finalized transfer.
  it('drops a resume against an already-finalized slot without re-entering RECEIVING', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    // Completed transfer: slot finalized at the declared size.
    ramStart('song.mp3', false, 6, CHUNK_SIZE, false);
    ramWrite('song.mp3', false, 6, 0, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 6, 1, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 6, 2, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 6, 3, u8(0xdd));
    ramEnd('song.mp3', false, 6, FOUR_CHUNK_FILE_SIZE, 4);
    setState('transfer.meta', {
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 6,
      index: 0,
    });
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('playlist.currentTrackIndex', 3);
    setState('playback.pendingRecoveryTarget', { index: 3, name: 'other.mp3' });

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 1 }), conn);

    expect(getState('transfer.localSessionId')).toBe(5);
    // The exact completed transfer is left alone.
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playlist.currentTrackIndex')).toBe(3);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({ index: 3, name: 'other.mp3' });
    expect(postCommand).not.toHaveBeenCalled();
    expect(recoverySpy).not.toHaveBeenCalled();
    expect(clearManagedTimer).toHaveBeenCalledWith('chunkWatchdog');
    expect(clearManagedTimer).toHaveBeenCalledWith('prepareWatchdog');
  });
});

describe('handleFileWait - identity repair isolation', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
  });

  it('does not arm the generic data-recovery retry for a tagged identity FILE_WAIT', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');

    handleFileWait({ type: 'file-wait', reason: 'missing_transfer_identity' }, conn);

    expect(clearManagedTimer).toHaveBeenCalledWith('fileWaitTimeout');
    expect(setManagedTimer).not.toHaveBeenCalled();
  });
});

describe('handleFileChunk — reorder buffer OOM bound', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    __resetRamStoreForTests();
    const { resetStoredFileAdmissionsForTests } = await import('../storage.ts');
    resetStoredFileAdmissionsForTests();
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
  });

  it('caps all pre-START sessions globally and replays the newest contiguous prefix', async () => {
    const { handleFileChunk, handleFileStart, getTransferMemoryStats } =
      await import('../transfer-receive.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.localSessionId', 0);
    setState('playback.pendingRecoveryTarget', null);

    for (let sessionId = 1; sessionId <= 5; sessionId++) {
      for (let index = 0; index < 20; index++) {
        handleFileChunk(
          {
            type: 'file-chunk',
            name: `s${sessionId}.mp3`,
            sessionId,
            index,
            total: 100,
            size: 99 * CHUNK_SIZE + 1,
            chunk: u8(index),
          },
          conn,
        );
      }
    }

    expect(getTransferMemoryStats()).toMatchObject({
      pendingEarlySessions: 3,
      pendingEarlyChunks: 60,
      pendingEarlyBytes: 60,
    });

    handleFileStart(
      {
        type: 'file-start',
        name: 's5.mp3',
        sessionId: 5,
        index: 4,
        total: 100,
        size: 99 * CHUNK_SIZE + 1,
      },
      conn,
    );
    await Promise.resolve();

    expect(getState('transfer.receivedCount')).toBe(20);
    expect(ramContiguousCount('s5.mp3', false, 5)).toBe(20);
    expect(getTransferMemoryStats().pendingEarlyChunks).toBe(0);
  });

  it('terminates a prepared transfer when RAM admission rejects and reports the track index', async () => {
    const { handleFilePrepare, handleFileStart, handleFileChunk } =
      await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { sendToHost } = await import('../../network/peer.ts');
    const encodedSize = 400 * 1024 * 1024;
    const total = Math.ceil(encodedSize / CHUNK_SIZE);

    await handleFilePrepare(
      { type: 'file-prepare', name: 'huge.wav', index: 2, sessionId: 10 },
      conn,
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);

    handleFileStart(
      {
        type: 'file-start',
        name: 'huge.wav',
        index: 2,
        sessionId: 10,
        total,
        size: encodedSize,
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
    expect(postCommand).toHaveBeenCalledWith({ command: 'STORAGE_RESET', isPreload: false });
    expect(sendToHost).toHaveBeenCalledWith({ type: 'guest-decode-failed', index: 2 });

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'huge.wav',
        sessionId: 10,
        index: 999,
        total,
        size: encodedSize,
        chunk: u8(1),
      },
      conn,
    );
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
    expect(sendToHost).toHaveBeenCalledTimes(1);
  });

  it('preserves the FILE_PREPARE playlist index when chunk metadata replaces a lost FILE_START', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 6);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.currentTrackIndex', 4);
    setState('playback.pendingRecoveryTarget', { index: 4, name: 'song.mp3' });
    setState('transfer.meta', {
      name: 'song.mp3',
      index: 4,
      sessionId: 6,
      size: 1,
      mime: 'audio/mpeg',
    });

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        index: 0,
        chunk: u8(0xaa),
      },
      conn,
    );

    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'song.mp3', sessionId: 6, index: 4, total: 1 }),
    );
  });

  it('preserves the pending playlist index when a newer chunk stream replaces RECEIVING without FILE_START', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 5);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.currentTrackIndex', 4);
    setState('playback.pendingRecoveryTarget', { index: 4, name: 'new.mp3' });
    setState('transfer.meta', {
      name: 'old.mp3',
      index: 3,
      sessionId: 5,
      size: 1,
      total: 1,
      mime: 'audio/mpeg',
    });

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'new.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        index: 0,
        chunk: u8(0xbb),
      },
      conn,
    );

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'new.mp3', sessionId: 6, index: 4, total: 1 }),
    );
  });

  it('bootstraps a truly fresh IDLE transfer from a self-describing chunk after authoritative PLAY', async () => {
    const { handleFileChunk, getTransferMemoryStats } = await import('../transfer-receive.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.localSessionId', 5);
    setState('playlist.currentTrackIndex', 4);
    // This is the exact atomic identity left by the authoritative PLAY frame.
    setState('playback.pendingRecoveryTarget', { index: 4, name: 'fresh.mp3' });
    setState('transfer.meta', null);

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'fresh.mp3',
        mime: 'audio/mpeg',
        total: 2,
        size: TWO_CHUNK_FILE_SIZE,
        sessionId: 6,
        index: 0,
        chunk: u8(0xaa),
      },
      conn,
    );
    await Promise.resolve();

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('playlist.currentTrackIndex')).toBe(4);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'fresh.mp3', sessionId: 6, index: 4, total: 2 }),
    );
    expect(ramContiguousCount('fresh.mp3', false, 6)).toBe(1);
    expect(getTransferMemoryStats().pendingEarlyChunks).toBe(0);
  });

  it('does not bind ambiguous same-name chunk-only bytes to the stale current index', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 5);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.items', [
      { type: 'file', name: 'same.mp3', title: 'A', videoId: null, playlistId: null },
      { type: 'file', name: 'same.mp3', title: 'B', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 0);
    setState('playback.pendingRecoveryTarget', null);
    setState('transfer.meta', {
      name: 'same.mp3',
      index: 0,
      sessionId: 5,
      size: 1,
      total: 1,
      mime: 'audio/mpeg',
    });

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'same.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        index: 0,
        chunk: u8(0xcc),
      },
      conn,
    );

    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'same.mp3', sessionId: 6, total: 1 }),
    );
    expect(getState('transfer.meta')?.index).toBeUndefined();
    expect(getState('playlist.currentTrackIndex')).toBe(0);
  });

  it('clears excessive out-of-order chunks and requests recovery without fast-forwarding counters', async () => {
    const { handleFileStart, handleFileChunk, getTransferMemoryStats } =
      await import('../transfer-receive.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    handleFileStart(
      {
        type: 'file-start',
        name: 'gap.mp3',
        mime: 'audio/mpeg',
        total: 1_000,
        size: 999 * CHUNK_SIZE + 1,
        index: 0,
        sessionId: 9,
      },
      conn,
    );

    // Missing chunk 0 keeps the drain pointer at the true base while future
    // chunks accumulate. Crossing MAX_REORDER_BUFFER must clear + recover,
    // not pretend those future chunks were received.
    for (let index = 1; index <= 502; index++) {
      handleFileChunk(
        {
          type: 'file-chunk',
          chunk: u8(index % 256),
          index,
          sessionId: 9,
          total: 1_000,
          size: 999 * CHUNK_SIZE + 1,
          name: 'gap.mp3',
        },
        conn,
      );
    }

    expect(recoverySpy).toHaveBeenCalledOnce();
    expect(getState('transfer.receivedCount')).toBe(0);
    expect(getTransferMemoryStats()).toMatchObject({
      reorderChunks: 0,
      nextExpectedChunk: 0,
    });
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  });
});

describe('HTTP demo preload identity', () => {
  it('publishes a fresh positive safe session for exact preload activation', async () => {
    class FakeXMLHttpRequest {
      status = 200;
      response = new Blob([new Uint8Array([1])], { type: 'audio/mp4' });
      responseType = '';
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onprogress:
        | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
        | null = null;
      open(): void {}
      send(): void {
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      resetState();
      bus.clear();
      setState('network.connectionType', 'local');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      const usePreloaded = vi.fn();
      bus.on('storage:use-preloaded', usePreloaded);
      const { fetchDemoFromServer } = await import('../transfer-receive.ts');

      await fetchDemoFromServer(0);

      const meta = getState('preload.meta');
      expect(meta?.sessionId).toSatisfy(
        (sessionId: unknown) =>
          typeof sessionId === 'number' && Number.isSafeInteger(sessionId) && sessionId > 0,
      );
      expect(getState('preload.nextTrackIndex')).toBe(0);
      expect(usePreloaded).toHaveBeenCalledWith(0, expect.any(String), meta?.sessionId);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
