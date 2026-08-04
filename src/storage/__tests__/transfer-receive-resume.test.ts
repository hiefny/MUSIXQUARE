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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { CHUNK_SIZE, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  registerProRoomDirectFileHandler,
  registerProRoomMediaHooks,
  type ProRoomMediaHooks,
} from '../../pro-room/media-hooks.ts';
import {
  ramStart as rawRamStart,
  ramWrite as rawRamWrite,
  ramEnd as rawRamEnd,
  ramReadBlob as rawRamReadBlob,
  ramContiguousCount as rawRamContiguousCount,
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
const Q = Array.from(
  { length: 6 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const ramStart = (
  name: string,
  isPreload: boolean,
  sid: number,
  chunkSize: number,
  keepExisting: boolean,
  queueItemId = Q[0]!,
) => rawRamStart(queueItemId, name, isPreload, sid, chunkSize, keepExisting);
const ramWrite = (
  name: string,
  isPreload: boolean,
  sid: number,
  chunkIndex: number,
  chunk: Uint8Array,
  queueItemId = Q[0]!,
) => rawRamWrite(queueItemId, name, isPreload, sid, chunkIndex, chunk);
const ramEnd = (
  name: string,
  isPreload: boolean,
  sid: number,
  totalSize?: number,
  total?: number,
  queueItemId = Q[0]!,
) => rawRamEnd(queueItemId, name, isPreload, sid, totalSize, total);
const ramReadBlob = (_name: string, isPreload: boolean, sid: number, queueItemId = Q[0]!) =>
  rawRamReadBlob(queueItemId, isPreload, sid);
const ramContiguousCount = (_name: string, isPreload: boolean, sid: number, queueItemId = Q[0]!) =>
  rawRamContiguousCount(queueItemId, isPreload, sid);
const FOUR_CHUNK_FILE_SIZE = 3 * CHUNK_SIZE + 1;
const TWO_CHUNK_FILE_SIZE = CHUNK_SIZE + 1;

afterEach(() => {
  registerProRoomDirectFileHandler(null);
  registerProRoomMediaHooks(null);
});

async function expectCompletedMime(
  name: string,
  sessionId: number,
  queueItemId: string,
  mime: string,
): Promise<void> {
  const blob = ramReadBlob(name, false, sessionId, queueItemId);
  expect(blob).not.toBeNull();
  expect(blob?.type).toBe(mime);

  const { readStoredFile } = await import('../storage.ts');
  const file = await readStoredFile(queueItemId, name, false, sessionId);
  expect(file).not.toBeNull();
  expect(file?.type).toBe(mime);
}

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
    queueItemId: Q[0],
    ...overrides,
  });

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    __resetRamStoreForTests();
    const { resetStoredFileAdmissionsForTests } = await import('../storage.ts');
    resetStoredFileAdmissionsForTests();
    const { resetIncomingTransferAuthority } = await import('../transfer-receive.ts');
    resetIncomingTransferAuthority();
    setState('network.hostConn', conn);
    setState(
      'playlist.items',
      Q.map((queueItemId, index) => ({
        queueItemId,
        type: 'file' as const,
        name: index === 0 ? 'song.mp3' : `track-${index}.mp3`,
        videoId: null,
        playlistId: null,
      })),
    );
    setState('playlist.currentQueueItemId', Q[0]!);
    // Mid-download stall posture: guest was receiving under session 5.
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('transfer.localSessionId', 5);
    setState('transfer.meta', {
      name: 'song.mp3',
      queueItemId: Q[0],
      indexHint: 0,
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 5,
    });
  });

  it('accepts a replacement host SID 1 after resetting the previous SID 92 authority', async () => {
    const { handleFileStart, resetIncomingTransferAuthority } =
      await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 92);
    setState('transfer.currentSessionId', 92);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);

    resetIncomingTransferAuthority();
    handleFileStart(
      {
        type: 'file-start',
        name: 'new-host.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 1,
        queueItemId: Q[1],
      },
      conn,
    );

    expect(getState('transfer.localSessionId')).toBe(1);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ sessionId: 1, queueItemId: Q[1], name: 'new-host.mp3' }),
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('reports the first visible progress again when a replacement host reuses the same SID', async () => {
    const { handleFileStart, handleFileChunk, resetIncomingTransferAuthority } =
      await import('../transfer-receive.ts');
    const progress = vi.fn();
    bus.on('storage:transfer-progress', progress);
    const start = {
      type: 'file-start',
      name: 'replacement.mp3',
      mime: 'audio/mpeg',
      total: 200,
      size: 199 * CHUNK_SIZE + 1,
      sessionId: 1,
      queueItemId: Q[1],
    };
    const chunk = {
      ...start,
      type: 'file-chunk',
      chunkIndex: 0,
      chunk: u8(0xaa),
    };

    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    resetIncomingTransferAuthority();
    handleFileStart(start, conn);
    handleFileChunk(chunk, conn);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(0, 200);

    resetIncomingTransferAuthority();
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    handleFileStart(start, conn);
    handleFileChunk(chunk, conn);

    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(0, 200);
  });

  it('keeps exact completed direct receive in DECODING when duplicate PREPARE arrives', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const stopSpy = vi.fn();
    bus.on('player:stop-all-media', stopSpy);
    setState('transfer.receivedCount', 4);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setState('player.decodeFailureCount', 7);

    await handleFilePrepare(
      resumeMsg({
        type: 'file-prepare',
        sessionId: 5,
        queueItemId: Q[0],
      }),
      conn,
    );

    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
    expect(getState('player.decodeFailureCount')).toBe(7);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('drops stale full-recovery FILE_START after exact slot finalized during decode', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const stopSpy = vi.fn();
    bus.on('player:stop-all-media', stopSpy);

    ramStart('song.mp3', false, 5, CHUNK_SIZE, false);
    ramWrite('song.mp3', false, 5, 0, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 1, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 2, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 3, u8(0xdd));
    ramEnd('song.mp3', false, 5, FOUR_CHUNK_FILE_SIZE, 4);
    setState('transfer.receivedCount', 4);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 4,
        size: FOUR_CHUNK_FILE_SIZE,
        sessionId: 5,
        queueItemId: Q[0],
      },
      conn,
    );

    expect(getState('transfer.receivedCount')).toBe(4);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 5 }),
    );
  });

  it('accepts exact FILE_START after decode failure requests a full retry', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    ramStart('song.mp3', false, 5, CHUNK_SIZE, false);
    ramWrite('song.mp3', false, 5, 0, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 1, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 2, new Uint8Array(CHUNK_SIZE));
    ramWrite('song.mp3', false, 5, 3, u8(0xdd));
    ramEnd('song.mp3', false, 5, FOUR_CHUNK_FILE_SIZE, 4);
    setState('transfer.receivedCount', 0);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    vi.mocked(postCommand).mockClear();

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 4,
        size: FOUR_CHUNK_FILE_SIZE,
        sessionId: 5,
        queueItemId: Q[0],
      },
      conn,
    );

    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 5 }),
    );
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

  it('preserves MIME through a FILE_RESUME receive', async () => {
    const { handleFileResume, handleFileChunk } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    setState('transfer.meta', {
      queueItemId: Q[0],
      indexHint: 0,
      name: 'resumed.flac',
      mime: 'audio/flac',
      size: 2,
      total: 1,
      sessionId: 5,
    });

    handleFileResume(
      resumeMsg({
        name: 'resumed.flac',
        mime: 'audio/flac',
        size: 2,
        total: 1,
        startChunk: 0,
        sessionId: 5,
      }),
      conn,
    );

    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        queueItemId: Q[0],
        sessionId: 5,
        mime: 'audio/flac',
      }),
    );

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'resumed.flac',
        mime: 'audio/flac',
        size: 2,
        total: 1,
        sessionId: 5,
        queueItemId: Q[0],
        chunkIndex: 0,
        chunk: u8(0xaa, 0xbb),
      },
      conn,
    );
    await Promise.resolve();

    await expectCompletedMime('resumed.flac', 5, Q[0]!, 'audio/flac');
  });

  it('does not reuse a prefix when the queue item differs inside the same session', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));

    handleFileResume(resumeMsg({ sessionId: 5, queueItemId: Q[1] }), conn);

    expect(getState('transfer.receivedCount')).toBe(0);
    expect(getState('playlist.currentQueueItemId')).toBe(Q[1]);
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
      queueItemId: Q[0],
      indexHint: 0,
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 6,
    });

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 2 }), conn);

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.receivedCount')).toBe(0);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 6, keepExisting: false }),
    );
    expect(recoverySpy).toHaveBeenCalledWith(0);
  });

  it('adopts the authoritative FILE_START queue item when FILE_PREPARE was lost', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    setState('playlist.currentQueueItemId', Q[3]!);

    handleFileStart(
      {
        type: 'file-start',
        name: 'replacement.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        queueItemId: Q[4],
      },
      conn,
    );

    expect(getState('playlist.currentQueueItemId')).toBe(Q[4]);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({
      queueItemId: Q[4],
      indexHint: 4,
      name: 'replacement.mp3',
    });
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ sessionId: 6, queueItemId: Q[4], name: 'replacement.mp3' }),
    );
  });

  it('preserves MIME through a fresh FILE_START receive', async () => {
    const { handleFileStart, handleFileChunk } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
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
        queueItemId: Q[2],
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentQueueItemId')).toBe(Q[2]);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        queueItemId: Q[2],
        sessionId: 6,
        mime: 'audio/mpeg',
      }),
    );

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'first-control.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 1,
        sessionId: 6,
        queueItemId: Q[2],
        chunkIndex: 0,
        chunk: u8(0xaa),
      },
      conn,
    );
    await Promise.resolve();

    await expectCompletedMime('first-control.mp3', 6, Q[2]!, 'audio/mpeg');
  });

  it('enters DOWNLOADING when FILE_RESUME is the first surviving control frame', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);

    handleFileResume(resumeMsg({ sessionId: 6, queueItemId: Q[2], startChunk: 0 }), conn);

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentQueueItemId')).toBe(Q[2]);
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
        queueItemId: Q[0],
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
    setState('transfer.meta', {
      queueItemId: Q[0],
      indexHint: 0,
      name: 'song.mp3',
      size: 999,
      total: 4,
      sessionId: 5,
    });
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
      queueItemId: Q[0],
      indexHint: 0,
      name: 'song.mp3',
      size: FOUR_CHUNK_FILE_SIZE,
      total: 4,
      sessionId: 6,
    });
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('playlist.currentQueueItemId', Q[3]!);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q[3]!,
      indexHint: 3,
      name: 'other.mp3',
    });

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 1 }), conn);

    expect(getState('transfer.localSessionId')).toBe(5);
    // The exact completed transfer is left alone.
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playlist.currentQueueItemId')).toBe(Q[3]);
    expect(getState('playback.pendingRecoveryTarget')).toEqual({
      queueItemId: Q[3],
      indexHint: 3,
      name: 'other.mp3',
    });
    expect(postCommand).not.toHaveBeenCalled();
    expect(recoverySpy).not.toHaveBeenCalled();
    expect(clearManagedTimer).toHaveBeenCalledWith('chunkWatchdog');
    expect(clearManagedTimer).toHaveBeenCalledWith('prepareWatchdog');
  });

  it('does not let an old preload watchdog overwrite a newer file request owner', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { setManagedTimer } = await import('../../core/timers.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests, resetFileRequestAuthority } =
      await import('../../network/file-request-authority.ts');
    resetFileRequestAuthority();
    setState('preload.isPreloading', true);
    setState('preload.activeTarget', {
      queueItemId: Q[0],
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 5,
    });

    await handleFilePrepare(
      {
        type: 'file-prepare',
        queueItemId: Q[0],
        sessionId: 5,
        name: 'song.mp3',
        mime: 'audio/mpeg',
      },
      conn,
    );
    const watchdog = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === 'preloadWatchdog')?.[1];
    expect(watchdog).toBeTypeOf('function');

    setState('playlist.currentQueueItemId', Q[1]!);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q[1]!,
      indexHint: 1,
      name: 'track-1.mp3',
    });
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    const ownerB = beginFileRequest(conn, Q[1]!, 8);
    watchdog?.();

    expect(getCurrentFileRequestOwnerForTests()).toBe(ownerB);
  });
});

describe('handleFileWait - identity repair isolation', () => {
  const hostSend = vi.fn();
  const conn = { open: true, peer: 'host-1', send: hostSend } as unknown as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    const { resetFileRequestAuthority } = await import('../../network/file-request-authority.ts');
    resetFileRequestAuthority();
    const { resetIncomingTransferAuthority } = await import('../transfer-receive.ts');
    resetIncomingTransferAuthority();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      {
        queueItemId: Q[0]!,
        type: 'file',
        name: 'a.mp3',
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: Q[1]!,
        type: 'file',
        name: 'b.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', Q[0]!);
  });

  it('ignores an unowned stale FILE_WAIT without UI or a timer', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { beginFileRequest } = await import('../../network/file-request-authority.ts');
    const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');
    const { showToast } = await import('../../ui/toast.ts');
    const owner = beginFileRequest(conn, Q[0]!, 7);

    handleFileWait(
      {
        type: 'file-wait',
        message: 'not ready',
        requestId: owner.requestId + 1,
        queueItemId: owner.queueItemId,
        sessionId: owner.sessionId,
      },
      conn,
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(clearManagedTimer).not.toHaveBeenCalledWith('fileWaitTimeout');
    expect(setManagedTimer).not.toHaveBeenCalled();
  });

  it('does not arm the generic data-recovery retry for a tagged identity FILE_WAIT', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { beginFileRequest } = await import('../../network/file-request-authority.ts');
    const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');
    const owner = beginFileRequest(conn, Q[0]!, 7);

    handleFileWait(
      {
        type: 'file-wait',
        message: 'identity missing',
        reason: 'missing_transfer_identity',
        requestId: owner.requestId,
        queueItemId: owner.queueItemId,
        sessionId: owner.sessionId,
      },
      conn,
    );

    expect(clearManagedTimer).toHaveBeenCalledWith('fileWaitTimeout');
    expect(setManagedTimer).not.toHaveBeenCalled();
  });

  it('prevents an old FILE_WAIT timer from acting after request B supersedes A', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { beginFileRequest } = await import('../../network/file-request-authority.ts');
    const { setManagedTimer } = await import('../../core/timers.ts');
    const ownerA = beginFileRequest(conn, Q[0]!, 7);

    handleFileWait(
      {
        type: 'file-wait',
        message: 'not ready',
        requestId: ownerA.requestId,
        queueItemId: ownerA.queueItemId,
        sessionId: ownerA.sessionId,
      },
      conn,
    );
    const timer = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === 'fileWaitTimeout')?.[1];
    expect(timer).toBeTypeOf('function');

    beginFileRequest(conn, Q[1]!, 8);
    timer?.();

    expect(hostSend).not.toHaveBeenCalled();
  });

  it('starts the follow-up recovery from the captured owner tuple', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');
    const { setManagedTimer } = await import('../../core/timers.ts');
    const ownerA = beginFileRequest(conn, Q[0]!, 7);

    handleFileWait(
      {
        type: 'file-wait',
        message: 'not ready',
        requestId: ownerA.requestId,
        queueItemId: ownerA.queueItemId,
        sessionId: ownerA.sessionId,
      },
      conn,
    );
    const timer = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === 'fileWaitTimeout')?.[1];
    timer?.();

    expect(hostSend).toHaveBeenCalledWith({
      type: 'request-data-recovery',
      nextChunk: 0,
      fileName: 'a.mp3',
      requestId: expect.any(Number),
      queueItemId: Q[0],
      sessionId: 7,
    });
    expect(getCurrentFileRequestOwnerForTests()).toEqual(
      expect.objectContaining({
        hostConn: conn,
        queueItemId: Q[0],
        sessionId: 7,
      }),
    );
    expect(getCurrentFileRequestOwnerForTests()?.requestId).not.toBe(ownerA.requestId);
  });

  it('keeps a remote PRO persistent FILE_WAIT on direct-R2 recovery', async () => {
    const { handleFileWait } = await import('../transfer-receive.ts');
    const { beginFileRequest } = await import('../../network/file-request-authority.ts');
    const { setManagedTimer } = await import('../../core/timers.ts');
    const hooks: ProRoomMediaHooks = {
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile: () => null,
      handlesPersistentFile: (queueItemId) => queueItemId === Q[0],
    };
    registerProRoomMediaHooks(hooks);
    setState('network.connectionType', 'remote');
    const owner = beginFileRequest(conn, Q[0]!, 7);

    handleFileWait(
      {
        type: 'file-wait',
        message: 'coordinator preparing R2 asset',
        requestId: owner.requestId,
        queueItemId: owner.queueItemId,
        sessionId: owner.sessionId,
      },
      conn,
    );
    const timer = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === 'fileWaitTimeout')?.[1];
    timer?.();

    expect(hostSend).toHaveBeenCalledWith({
      type: 'request-data-recovery',
      nextChunk: 0,
      fileName: 'a.mp3',
      requestId: expect.any(Number),
      queueItemId: Q[0],
      sessionId: 7,
    });
  });

  it('clears only the exact request owner on an accepted FILE_START', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');
    const resident = (queueItemId: string, sessionId: number, name: string) => ({
      queueItemId,
      indexHint: queueItemId === Q[0] ? 0 : 1,
      name,
      sessionId,
      size: 1,
      mime: 'audio/mpeg',
      blob: new Blob([u8(1)], { type: 'audio/mpeg' }),
    });
    const frame = (queueItemId: string, sessionId: number, name: string) => ({
      type: 'file-start',
      queueItemId,
      sessionId,
      name,
      mime: 'audio/mpeg',
      total: 1,
      size: 1,
    });

    const ownerB = beginFileRequest(conn, Q[1]!, 8);
    setState('files.current', resident(Q[0]!, 7, 'a.mp3'));
    handleFileStart(frame(Q[0]!, 7, 'a.mp3'), conn);
    expect(getCurrentFileRequestOwnerForTests()).toBe(ownerB);

    setState('playlist.currentQueueItemId', Q[1]!);
    setState('files.current', resident(Q[1]!, 8, 'b.mp3'));
    handleFileStart(frame(Q[1]!, 8, 'b.mp3'), conn);
    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
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
    const { resetIncomingTransferAuthority } = await import('../transfer-receive.ts');
    resetIncomingTransferAuthority();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState(
      'playlist.items',
      Q.map((queueItemId, index) => ({
        queueItemId,
        type: 'file' as const,
        name: `track-${index}.mp3`,
        videoId: null,
        playlistId: null,
      })),
    );
    setState('playlist.currentQueueItemId', Q[0]!);
  });

  it('adopts self-describing queue-item chunks without retaining pre-START buffers', async () => {
    const { handleFileChunk, getTransferMemoryStats } = await import('../transfer-receive.ts');
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
            queueItemId: Q[4],
            chunkIndex: index,
            total: 100,
            size: 99 * CHUNK_SIZE + 1,
            chunk: u8(index),
          },
          conn,
        );
      }
    }
    await Promise.resolve();

    expect(getState('transfer.receivedCount')).toBe(20);
    expect(ramContiguousCount('s5.mp3', false, 5, Q[4])).toBe(20);
    expect(getTransferMemoryStats()).toMatchObject({
      ownerSessions: 1,
      reorderChunks: 0,
      reorderBytes: 0,
    });
  });

  it('drops already committed duplicate chunks without masking recovery progress', async () => {
    const { handleFileStart, handleFileChunk, getTransferMemoryStats } =
      await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const start = {
      type: 'file-start',
      name: 'duplicate.mp3',
      mime: 'audio/mpeg',
      sessionId: 12,
      queueItemId: Q[0],
      total: 3,
      size: 2 * CHUNK_SIZE + 1,
    };
    const firstChunk = {
      ...start,
      type: 'file-chunk',
      chunkIndex: 0,
      chunk: u8(0xaa),
    };

    handleFileStart(start, conn);
    handleFileChunk(firstChunk, conn);
    await Promise.resolve();
    expect(getState('transfer.receivedCount')).toBe(1);

    vi.mocked(postCommand).mockClear();
    setState('recovery.retryCount', 2);
    handleFileChunk(firstChunk, conn);
    await Promise.resolve();

    expect(getState('transfer.receivedCount')).toBe(1);
    expect(getState('recovery.retryCount')).toBe(2);
    expect(postCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_WRITE', chunkIndex: 0 }),
    );
    expect(getTransferMemoryStats()).toMatchObject({ reorderChunks: 0, reorderBytes: 0 });
  });

  it('accepts a large prepared transfer without predictive RAM rejection', async () => {
    const { handleFilePrepare, handleFileStart, handleFileChunk } =
      await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { sendToHost } = await import('../../network/peer.ts');
    const encodedSize = 400 * 1024 * 1024;
    const total = Math.ceil(encodedSize / CHUNK_SIZE);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'huge.wav',
        queueItemId: Q[2],
        sessionId: 10,
        mime: 'audio/wav',
      },
      conn,
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);

    handleFileStart(
      {
        type: 'file-start',
        name: 'huge.wav',
        queueItemId: Q[2],
        sessionId: 10,
        total,
        size: encodedSize,
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        filename: 'huge.wav',
        isPreload: false,
        queueItemId: Q[2],
        sessionId: 10,
        size: CHUNK_SIZE,
      }),
    );
    expect(sendToHost).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'guest-decode-failed' }),
    );

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'huge.wav',
        sessionId: 10,
        queueItemId: Q[2],
        chunkIndex: 999,
        total,
        size: encodedSize,
        chunk: u8(1),
      },
      conn,
    );
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(sendToHost).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'guest-decode-failed' }),
    );
  });

  it('preserves the FILE_PREPARE queue item when chunk metadata replaces a lost FILE_START', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    setState('transfer.localSessionId', 6);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.currentQueueItemId', Q[4]!);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q[4]!,
      indexHint: 4,
      name: 'song.mp3',
    });
    setState('transfer.meta', {
      name: 'song.mp3',
      queueItemId: Q[4],
      indexHint: 4,
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
        queueItemId: Q[4],
        chunkIndex: 0,
        chunk: u8(0xaa),
      },
      conn,
    );
    await Promise.resolve();

    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'song.mp3', sessionId: 6, queueItemId: Q[4], total: 1 }),
    );
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        queueItemId: Q[4],
        sessionId: 6,
        mime: 'audio/mpeg',
      }),
    );
    await expectCompletedMime('song.mp3', 6, Q[4]!, 'audio/mpeg');
  });

  it('preserves the pending queue item when a newer chunk stream replaces RECEIVING without FILE_START', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 5);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.currentQueueItemId', Q[4]!);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q[4]!,
      indexHint: 4,
      name: 'new.mp3',
    });
    setState('transfer.meta', {
      name: 'old.mp3',
      queueItemId: Q[3],
      indexHint: 3,
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
        queueItemId: Q[4],
        chunkIndex: 0,
        chunk: u8(0xbb),
      },
      conn,
    );

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'new.mp3', sessionId: 6, queueItemId: Q[4], total: 1 }),
    );
  });

  it('bootstraps a truly fresh IDLE transfer from a self-describing chunk after authoritative PLAY', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.localSessionId', 5);
    setState('playlist.currentQueueItemId', Q[4]!);
    // This is the exact atomic identity left by the authoritative PLAY frame.
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q[4]!,
      indexHint: 4,
      name: 'fresh.mp3',
    });
    setState('transfer.meta', null);

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'fresh.mp3',
        mime: 'audio/mpeg',
        total: 2,
        size: TWO_CHUNK_FILE_SIZE,
        sessionId: 6,
        queueItemId: Q[4],
        chunkIndex: 0,
        chunk: u8(0xaa),
      },
      conn,
    );
    await Promise.resolve();

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('playlist.currentQueueItemId')).toBe(Q[4]);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'fresh.mp3', sessionId: 6, queueItemId: Q[4], total: 2 }),
    );
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        queueItemId: Q[4],
        sessionId: 6,
        mime: 'audio/mpeg',
      }),
    );
    expect(ramContiguousCount('fresh.mp3', false, 6, Q[4])).toBe(1);
  });

  it('uses the authenticated queue item on a self-describing newer chunk stream', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    setState('transfer.localSessionId', 5);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('playlist.items', [
      {
        queueItemId: Q[0]!,
        type: 'file',
        name: 'same.mp3',
        title: 'A',
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: Q[1]!,
        type: 'file',
        name: 'same.mp3',
        title: 'B',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', Q[0]!);
    setState('playback.pendingRecoveryTarget', null);
    setState('transfer.meta', {
      name: 'same.mp3',
      queueItemId: Q[0],
      indexHint: 0,
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
        queueItemId: Q[1],
        chunkIndex: 0,
        chunk: u8(0xcc),
      },
      conn,
    );

    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ name: 'same.mp3', sessionId: 6, queueItemId: Q[1], total: 1 }),
    );
    expect(getState('playlist.currentQueueItemId')).toBe(Q[1]);
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
        queueItemId: Q[0],
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
          chunkIndex: index,
          queueItemId: Q[0],
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

describe('persistent PRO file receive routing', () => {
  const conn = { open: true, peer: 'pro-coordinator' } as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    const { resetIncomingTransferAuthority } = await import('../transfer-receive.ts');
    resetIncomingTransferAuthority();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'remote');
    setState('playlist.items', [
      {
        queueItemId: Q[0],
        type: 'file',
        name: 'persistent.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', Q[0]!);
  });

  it('downloads on the participant and never enters P2P chunk or remote-share receive', async () => {
    let finishDownload!: (file: File) => void;
    const download = new Promise<File>((resolve) => {
      finishDownload = resolve;
    });
    const hooks: ProRoomMediaHooks = {
      addFiles: () => false,
      addYouTube: () => false,
      updateTrackMetadata: () => false,
      removeTracks: () => false,
      reorderTrack: () => false,
      resolveFile: () => download,
      handlesPersistentFile: (queueItemId) => queueItemId === Q[0],
    };
    const finalize = vi.fn(async () => undefined);
    registerProRoomMediaHooks(hooks);
    registerProRoomDirectFileHandler(finalize);

    const { handleFilePrepare, handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { prepareRemoteShareWait } = await import('../../share/remote-share.ts');
    const file = new File([u8(1, 2, 3)], 'persistent.flac', { type: 'audio/flac' });
    const prepared = handleFilePrepare(
      {
        type: 'file-prepare',
        queueItemId: Q[0],
        sessionId: 12,
        name: file.name,
        mime: file.type,
        size: file.size,
      },
      conn,
    );

    await Promise.resolve();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(prepareRemoteShareWait).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalled();

    finishDownload(file);
    await prepared;

    expect(finalize).toHaveBeenCalledWith(file, Q[0], 12);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ queueItemId: Q[0], sessionId: 12, mime: 'audio/flac' }),
    );

    // A stale coordinator that still emits byte frames cannot reopen the
    // legacy RAM chunk pipeline for a persistent PRO occurrence.
    handleFileStart(
      {
        type: 'file-start',
        queueItemId: Q[0],
        sessionId: 12,
        name: file.name,
        mime: file.type,
        size: file.size,
        total: 1,
      },
      conn,
    );
    expect(postCommand).not.toHaveBeenCalled();
  });
});
