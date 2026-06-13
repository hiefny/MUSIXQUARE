/**
 * STO-RESUME pin tests — handleFileResume store-authoritative baseline.
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
import { PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  ramStart,
  ramWrite,
  ramEnd,
  ramReadBlob,
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

/** Flush the queueMicrotask-deferred storage command dispatch. */
const flushStorage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const u8 = (...bytes: number[]) => new Uint8Array(bytes);

describe('handleFileResume — store-authoritative baseline (STO-RESUME)', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  const resumeMsg = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'file-resume',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    total: 4,
    size: 4,
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
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
    // Mid-download stall posture: guest was receiving under session 5.
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('transfer.localSessionId', 5);
    setState('transfer.meta', { name: 'song.mp3', size: 4, total: 4, sessionId: 5, index: 0 });
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

  // The original STO-RESUME shape: host re-broadcast advanced the session,
  // FILE_RESUME(newSid, k) arrives while the guest's slot still holds the
  // prefix under the OLD sid. The slot must be re-keyed (not recreated
  // empty), and the whole transfer must pass the STORAGE_END integrity gate
  // — pre-fix this exact flow looped forever on INTEGRITY_FAIL.
  it('preserves the guest prefix across a cross-session resume end-to-end', async () => {
    const { handleFileResume, handleFileChunk } = await import('../transfer-receive.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa));
    ramWrite('song.mp3', false, 5, 1, u8(0xbb));

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 2 }), conn);
    await flushStorage();

    expect(getState('transfer.localSessionId')).toBe(6);
    expect(getState('transfer.receivedCount')).toBe(2);

    // Host streams the tail under the new session.
    handleFileChunk(
      { type: 'file-chunk', chunk: u8(0xcc), index: 2, sessionId: 6, total: 4, name: 'song.mp3' },
      conn,
    );
    handleFileChunk(
      { type: 'file-chunk', chunk: u8(0xdd), index: 3, sessionId: 6, total: 4, name: 'song.mp3' },
      conn,
    );
    await flushStorage();

    expect(getState('transfer.receivedCount')).toBe(4);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);

    // Integrity gate passed: finalized blob = preserved prefix + new tail.
    const blob = ramReadBlob('song.mp3', false);
    expect(blob).not.toBeNull();
    expect(blob!.size).toBe(4);
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);

    // The loop is dead: no recovery round was needed at all.
    expect(recoverySpy).not.toHaveBeenCalled();
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

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 3 }), conn);

    expect(getState('transfer.receivedCount')).toBe(1);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', sessionId: 6, keepExisting: true }),
    );
    expect(seenAtEmit).toEqual([{ forceChunk: 1, receivedCount: 1 }]);
  });

  it('degrades to a fresh start from 0 when name+size identity does not hold', async () => {
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

  // STO-RESUME sibling (red-team finding): a recovery backoff armed before
  // finalization can fire after it — the resulting FILE_RESUME must not flip
  // the completed transfer back to RECEIVING (writes against a finalized
  // slot are silently dropped, so the drain re-counts a tail that never
  // lands and STORAGE_END integrity-fails forever).
  it('drops a resume against an already-finalized slot without re-entering RECEIVING', async () => {
    const { handleFileResume } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    // Completed transfer: slot finalized at the declared size.
    ramStart('song.mp3', false, 5, 16, false);
    ramWrite('song.mp3', false, 5, 0, u8(0xaa, 0xbb));
    ramWrite('song.mp3', false, 5, 1, u8(0xcc, 0xdd));
    ramEnd('song.mp3', false, 5, 4, 2);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);

    handleFileResume(resumeMsg({ sessionId: 6, startChunk: 1 }), conn);

    // Sid adopted so the host's tail stream hits the stale-completed guard...
    expect(getState('transfer.localSessionId')).toBe(6);
    // ...but the completed transfer is left alone.
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
    expect(postCommand).not.toHaveBeenCalled();
    expect(recoverySpy).not.toHaveBeenCalled();
    expect(clearManagedTimer).toHaveBeenCalledWith('chunkWatchdog');
    expect(clearManagedTimer).toHaveBeenCalledWith('prepareWatchdog');
  });
});

describe('handleFileChunk — reorder buffer OOM bound', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    __resetRamStoreForTests();
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
  });

  it('clears excessive out-of-order chunks and requests recovery without fast-forwarding counters', async () => {
    const { handleFileStart, handleFileChunk, getTransferMemoryStats } = await import(
      '../transfer-receive.ts'
    );
    const recoverySpy = vi.fn();
    bus.on('storage:request-recovery', recoverySpy);

    handleFileStart(
      {
        type: 'file-start',
        name: 'gap.mp3',
        mime: 'audio/mpeg',
        total: 10_000,
        size: 10_000,
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
          total: 10_000,
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
