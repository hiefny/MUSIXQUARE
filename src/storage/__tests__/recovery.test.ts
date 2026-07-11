import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConn = any; // Partial mock for DataConnection in tests
import { bus } from '../../core/events.ts';
// ramstore is REAL in this file (only storage.ts/transfer.ts are mocked) —
// sendRecoveryRequest's ask clamp reads it as data-plane truth.
import { ramStart, ramWrite, __resetRamStoreForTests } from '../ramstore.ts';
import { isRemoteGuest } from '../../network/peer.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import {
  beginFileRequest,
  getCurrentFileRequestOwnerForTests,
  resetFileRequestAuthority,
} from '../../network/file-request-authority.ts';

const Q0 = '00000000-0000-4000-8000-000000000001';
const Q1 = '00000000-0000-4000-8000-000000000002';
const Q2 = '00000000-0000-4000-8000-000000000003';
let nextTestRequestId = 10_000;

type RegisteredHandler = (data: Record<string, unknown>, conn: AnyConn) => unknown;
const registeredHandlers = vi.hoisted(() => new Map<string, RegisteredHandler>());
const remoteShareMocks = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  shareRemoteFileIfNeeded: vi.fn(),
}));

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((handlers: Record<string, RegisteredHandler>) => {
    for (const [type, handler] of Object.entries(handlers)) {
      registeredHandlers.set(type, handler);
    }
  }),
}));

vi.mock('../storage.ts', () => ({
  ensureNamedFile: vi.fn((blob: unknown, name: string) => {
    if (!blob) return null;
    const source = blob as Blob;
    return new File([source], name, { type: source.type });
  }),
}));

vi.mock('../transfer.ts', () => ({
  unicastFile: vi.fn(async () => {}),
}));

vi.mock('../../network/peer.ts', () => ({
  isRemoteGuest: vi.fn(() => false),
}));

vi.mock('../../share/r2-client.ts', () => ({
  isRemoteShareConfigured: remoteShareMocks.isConfigured,
}));

vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: remoteShareMocks.shareRemoteFileIfNeeded,
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn((name: string, fn: () => void, delayMs: number) => {
    // Delegate to real setTimeout so vi.useFakeTimers() + advanceTimersByTime works
    setTimeout(fn, delayMs);
  }),
  clearManagedTimer: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  registeredHandlers.clear();
  vi.useFakeTimers();
  // Real ramstore holds module-level slots — without this, slots arranged in
  // one test leak into the next and skew the ask clamp.
  __resetRamStoreForTests();
  resetFileRequestAuthority();
  nextTestRequestId = 10_000;
  // restoreAllMocks does not restore vi.fn() factory mocks (only vi.spyOn) —
  // the remote-guest test's mockReturnValue(true) would otherwise leak into
  // every test that runs after it.
  vi.mocked(isRemoteGuest).mockReturnValue(false);
  remoteShareMocks.isConfigured.mockReturnValue(false);
  setState('playlist.items', [
    { queueItemId: Q0, type: 'file', name: 'same.mp3', videoId: null, playlistId: null },
    { queueItemId: Q1, type: 'file', name: 'same.mp3', videoId: null, playlistId: null },
    { queueItemId: Q2, type: 'file', name: 'remote.mp3', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q0);
});

/** Arrange `count` contiguous 1-byte chunks for `name` in the REAL ramstore. */
function arrangeStoreChunks(name: string, sid: number, count: number, queueItemId = Q0): void {
  ramStart(queueItemId, name, false, sid, 16, false);
  for (let i = 0; i < count; i++) {
    ramWrite(queueItemId, name, false, sid, i, new Uint8Array([i & 0xff]));
  }
  setState('transfer.localSessionId', sid);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('sendRecoveryRequest', () => {
  // Lazy import to ensure mocks are set up first
  async function getSendRecoveryRequest() {
    const mod = await import('../recovery.ts');
    return mod.sendRecoveryRequest;
  }

  it('skips when recovery is already pending', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    setState('recovery.pending', true);
    sendRecoveryRequest();
    // No state change should occur (retryCount stays 0)
    expect(getState('recovery.retryCount')).toBe(0);
  });

  it('gives up when max retries exceeded', async () => {
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const sendRecoveryRequest = await getSendRecoveryRequest();

    setState('recovery.retryCount', 3); // MAX_RECOVERY_RETRIES = 3
    sendRecoveryRequest();
    expect(getState('transfer.state')).toBe('IDLE');
    expect(getState('recovery.retryCount')).toBe(0);
    expect(clearManagedTimer).toHaveBeenCalledWith('chunkWatchdog');
  });

  it('does nothing without a healthy connection', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    setState('recovery.retryCount', 0);
    setState('network.hostConn', null);
    sendRecoveryRequest();
    // pending should not be set since we exit early
    expect(getState('recovery.pending')).toBeFalsy();
  });

  it('sends recovery request to host', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('recovery.retryCount', 0);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });

    sendRecoveryRequest();
    vi.advanceTimersByTime(2000);

    expect(hostSend).toHaveBeenCalledTimes(1);
    const request = hostSend.mock.calls[0][0];
    expect(request).toEqual(
      expect.objectContaining({
        type: MSG.REQUEST_DATA_RECOVERY,
        queueItemId: Q0,
        requestId: expect.any(Number),
      }),
    );
    expect(Number.isSafeInteger(request.requestId)).toBe(true);
    expect(request.requestId).toBeGreaterThan(0);
    expect(request).not.toHaveProperty('sessionId');
  });

  it('allocates a fresh requestId for each successive recovery request', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });

    sendRecoveryRequest();
    vi.advanceTimersByTime(2000);
    sendRecoveryRequest();
    vi.advanceTimersByTime(5000);

    expect(hostSend).toHaveBeenCalledTimes(2);
    const firstRequestId = hostSend.mock.calls[0][0].requestId;
    const secondRequestId = hostSend.mock.calls[1][0].requestId;
    expect(firstRequestId).toBeGreaterThan(0);
    expect(secondRequestId).toBeGreaterThan(0);
    expect(secondRequestId).not.toBe(firstRequestId);
  });

  it('applies progressive backoff timing', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    // RECOVERY_BACKOFF = [2000, 5000, 10000]
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });

    // First attempt — 2000ms backoff
    setState('recovery.retryCount', 0);
    sendRecoveryRequest();
    vi.advanceTimersByTime(1999);
    expect(hostSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hostSend).toHaveBeenCalledTimes(1);
  });

  it('aborts if track changed during backoff', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'original.mp3' });
    setState('recovery.retryCount', 0);

    sendRecoveryRequest();

    // Change the authoritative selection during backoff. Stale transfer.meta
    // may still point at Q0, so currentQueueItemId must win.
    setState('playlist.currentQueueItemId', Q1);
    setState('transfer.meta', { queueItemId: Q1, name: 'different.mp3' });
    vi.advanceTimersByTime(2000);

    expect(hostSend).not.toHaveBeenCalled();
    expect(getState('recovery.retryCount')).toBe(0); // reset
  });

  it('uses the selected target instead of stale transfer metadata and SID', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('playlist.currentQueueItemId', Q1);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: 'selected.mp3',
    });
    setState('transfer.meta', { queueItemId: Q0, name: 'stale.mp3', sessionId: 7 });
    setState('transfer.localSessionId', 7);
    setState('transfer.currentSessionId', 7);

    sendRecoveryRequest();
    vi.advanceTimersByTime(2000);

    expect(hostSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.REQUEST_DATA_RECOVERY,
        queueItemId: Q1,
        fileName: 'selected.mp3',
      }),
    );
    expect(hostSend.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });

  it('aborts if connection closed during backoff', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const conn = { open: true, send: vi.fn() } as AnyConn;
    setState('network.hostConn', conn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('recovery.retryCount', 0);

    sendRecoveryRequest();

    // Close connection during backoff
    conn.open = false;
    vi.advanceTimersByTime(2000);

    expect(conn.send).not.toHaveBeenCalled();
  });

  it('claims and sends through the exact fresh host connection after backoff', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const originalConn = { open: true, send: vi.fn() } as AnyConn;
    const freshConn = { open: true, send: vi.fn() } as AnyConn;
    setState('network.hostConn', originalConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });

    sendRecoveryRequest();
    setState('network.hostConn', freshConn);
    vi.advanceTimersByTime(2000);

    expect(originalConn.send).not.toHaveBeenCalled();
    expect(freshConn.send).toHaveBeenCalledTimes(1);
    expect(getCurrentFileRequestOwnerForTests()?.hostConn).toBe(freshConn);
  });

  it('uses forceChunk when provided', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 50);
    setState('recovery.retryCount', 0);

    sendRecoveryRequest(10);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(10);
  });

  it('uses receivedCount when forceChunk is null (counter backed by store truth)', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 42);
    setState('recovery.retryCount', 0);
    // The ask is bounded by both the counter and store's contiguous prefix.
    arrangeStoreChunks('test.mp3', 1, 42);

    sendRecoveryRequest(null);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(42);
  });

  // A control-plane counter ahead of stored data must not choose the recovery
  // offset; only the contiguous store prefix is safe.
  it('clamps a phantom receivedCount to the store contiguous count', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 500); // phantom — store holds far less
    setState('recovery.retryCount', 0);
    arrangeStoreChunks('test.mp3', 1, 3); // contiguous prefix [0..2]
    ramWrite(Q0, 'test.mp3', false, 1, 10, new Uint8Array([0xff])); // non-prefix chunk — must not count

    sendRecoveryRequest(null);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(3);
  });

  // Slot missing entirely → contiguous 0 → ask 0 (full resend) IS the
  // intended self-heal, not a case that bypasses the clamp.
  it('asks from 0 when the store has no slot for the file', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 42);
    setState('recovery.retryCount', 0);

    sendRecoveryRequest(null);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(0);
  });

  it('asks from 0 when a same-name RAM prefix belongs to another session', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3', sessionId: 2 });
    setState('transfer.localSessionId', 2);
    setState('transfer.receivedCount', 2);
    setState('recovery.retryCount', 0);
    ramStart(Q0, 'test.mp3', false, 1, 16, false);
    ramWrite(Q0, 'test.mp3', false, 1, 0, new Uint8Array([1]));
    ramWrite(Q0, 'test.mp3', false, 1, 1, new Uint8Array([2]));

    sendRecoveryRequest(null);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.sessionId).toBe(2);
    expect(msg.nextChunk).toBe(0);
  });

  it('suppresses same-wifi toast while a remote-share wait is active', async () => {
    const { isRemoteGuest } = await import('../../network/peer.ts');
    const { showLoader, showToast } = await import('../../ui/toast.ts');
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const sendRecoveryRequest = await getSendRecoveryRequest();

    vi.mocked(isRemoteGuest).mockReturnValue(true);
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: 'remote.mp3',
    });
    setState('transfer.state', TRANSFER_STATE.RECEIVING);

    sendRecoveryRequest();

    expect(clearManagedTimer).toHaveBeenCalledWith('chunkWatchdog');
    expect(showLoader).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  });
});

describe('initRecovery', () => {
  it('registers protocol handlers', async () => {
    const { registerHandlers } = await import('../../network/protocol.ts');
    const { initRecovery } = await import('../recovery.ts');
    initRecovery();
    expect(registerHandlers).toHaveBeenCalled();
  });

  it('cancels pending recovery ownership and backoff when the selection changes', async () => {
    const { initRecovery } = await import('../recovery.ts');
    const { clearManagedTimer } = await import('../../core/timers.ts');
    const conn = { open: true, send: vi.fn() } as AnyConn;
    initRecovery();
    beginFileRequest(conn, Q0, 7);
    setState('recovery.retryCount', 2);
    setState('recovery.pending', true);

    bus.emit('state:playlist.currentQueueItemId', Q1);

    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
    expect(getState('recovery.retryCount')).toBe(0);
    expect(getState('recovery.pending')).toBe(false);
    expect(clearManagedTimer).toHaveBeenCalledWith('recovery-backoff');
  });

  it('does not let an already queued A backoff callback overwrite request B', async () => {
    const { initRecovery, sendRecoveryRequest } = await import('../recovery.ts');
    const hostSend = vi.fn();
    const conn = { open: true, send: hostSend } as AnyConn;
    initRecovery();
    setState('network.hostConn', conn);
    setState('transfer.meta', { queueItemId: Q0, name: 'a.mp3' });

    sendRecoveryRequest();
    bus.emit('state:playlist.currentQueueItemId', Q1);
    const ownerB = beginFileRequest(conn, Q1, 8);
    vi.advanceTimersByTime(2000);

    expect(hostSend).not.toHaveBeenCalled();
    expect(getCurrentFileRequestOwnerForTests()).toBe(ownerB);
  });

  it('clears file-request ownership at a full recovery authority reset', async () => {
    const { resetRecoveryAuthority } = await import('../recovery.ts');
    const conn = { open: true, send: vi.fn() } as AnyConn;
    beginFileRequest(conn, Q0, 7);

    resetRecoveryAuthority();

    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  });

  // Ordinary bus events omit forceChunk; normalize the optional value before
  // forwarding it to the request builder.
  it('plain storage:request-recovery emit takes the clamped counter path', async () => {
    const { initRecovery } = await import('../recovery.ts');
    const hostSend = vi.fn();

    initRecovery();
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 500); // phantom
    arrangeStoreChunks('test.mp3', 1, 2);

    bus.emit('storage:request-recovery');
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(2); // store truth, never undefined
  });

  it('forwards a numeric forceChunk from the bus unclamped', async () => {
    const { initRecovery } = await import('../recovery.ts');
    const hostSend = vi.fn();

    initRecovery();
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { queueItemId: Q0, name: 'test.mp3' });
    setState('transfer.receivedCount', 500);

    bus.emit('storage:request-recovery', 7); // store-derived by construction
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(7);
  });
});

describe('host cached-blob recovery identity', () => {
  async function invokeRecoveryHandler(
    type: typeof MSG.REQUEST_CURRENT_FILE | typeof MSG.REQUEST_DATA_RECOVERY,
    data: Record<string, unknown>,
    conn: AnyConn,
  ): Promise<void> {
    const { initRecovery } = await import('../recovery.ts');
    initRecovery();
    const handler = registeredHandlers.get(type);
    expect(handler).toBeDefined();
    const request = {
      type,
      requestId: ++nextTestRequestId,
      ...data,
    };
    await handler?.(request, conn);

    // Every wait branch shares one response helper. Assert the full optional
    // correlation tuple for every FILE_WAIT frame produced by this invocation.
    for (const [message] of conn.send.mock.calls) {
      if (message?.type !== MSG.FILE_WAIT) continue;
      expect(message.requestId).toBe(request.requestId);
      expect(message.queueItemId).toBe(request.queueItemId);
      if (request.sessionId === undefined) {
        expect(message).not.toHaveProperty('sessionId');
      } else {
        expect(message.sessionId).toBe(request.sessionId);
      }
    }
  }

  function makeGuestConn(connectionType: 'local' | 'remote' | 'unknown' = 'local'): AnyConn {
    const conn = { open: true, peer: 'guest-identity', send: vi.fn() };
    setState('network.connectedPeers', [
      {
        id: conn.peer,
        status: 'connected',
        conn,
        isDataTarget: connectionType !== 'remote',
        connectionType,
        joinOrder: 1,
      },
    ]);
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    return conn;
  }

  function setResident(queueItemId: string, name: string, blob: Blob, sessionId: number): void {
    setState('playlist.currentQueueItemId', queueItemId);
    setState('files.current', {
      queueItemId,
      indexHint: getState('playlist.items').findIndex((item) => item.queueItemId === queueItemId),
      name,
      sessionId,
      size: blob.size,
      mime: blob.type,
      blob,
    });
    setState('transfer.currentSessionId', sessionId);
    setState('transfer.meta', { queueItemId, name, sessionId, size: blob.size });
  }

  it('does not send a future preload as the current main transfer', async () => {
    const currentBlob = new Blob(['current-index-zero']);
    const preloadBlob = new Blob(['preload-index-one']);
    setResident(Q0, 'same.mp3', currentBlob, 7);
    setState('preload.nextQueueItemId', Q1);
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 1,
      name: 'same.mp3',
      sessionId: 8,
      size: preloadBlob.size,
      mime: preloadBlob.type,
      blob: preloadBlob,
    });

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_DATA_RECOVERY,
      { fileName: 'same.mp3', queueItemId: Q1, sessionId: 8, nextChunk: 0 },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_WAIT }));
  });

  it('serves an exact current queue item and session with frozen unicast options', async () => {
    const currentBlob = new Blob(['current-index-zero'], { type: 'audio/mpeg' });
    setResident(Q0, 'current.mp3', currentBlob, 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_DATA_RECOVERY,
      { fileName: 'untrusted-name.mp3', queueItemId: Q0, sessionId: 7, nextChunk: 2 },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ name: 'current.mp3' }),
      0,
      7,
      expect.objectContaining({
        queueItemId: Q0,
        isSourceCurrent: expect.any(Function),
      }),
    );
  });

  it('does not reuse same-name bytes when queue identity differs', async () => {
    const currentBlob = new Blob(['index-zero']);
    setResident(Q0, 'same.mp3', currentBlob, 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_DATA_RECOVERY,
      { fileName: 'same.mp3', queueItemId: Q1, nextChunk: 0 },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_WAIT }));
  });

  it('does not use a filename-only current-file request as byte identity', async () => {
    setResident(Q0, 'same.mp3', new Blob(['index-zero']), 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(MSG.REQUEST_CURRENT_FILE, { name: 'same.mp3' }, conn);

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('does not repair a missing guest identity from positional host state', async () => {
    const currentBlob = new Blob(['host-current']);
    setResident(Q1, 'same.mp3', currentBlob, 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_CURRENT_FILE,
      { reason: 'missing_transfer_identity' },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
  });

  it('does not let the repair tag override an explicit different queue item', async () => {
    const currentBlob = new Blob(['host-current']);
    setResident(Q1, 'host.mp3', currentBlob, 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_CURRENT_FILE,
      { reason: 'missing_transfer_identity', queueItemId: Q0, name: 'host.mp3' },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_WAIT }));
    expect(conn.send.mock.calls.at(-1)?.[0]).toHaveProperty('reason', 'missing_transfer_identity');
  });

  it('revalidates the exact current Blob after asynchronous transport classification', async () => {
    const selectedBlob = new Blob(['selected']);
    setResident(Q0, 'selected.mp3', selectedBlob, 7);

    const conn = makeGuestConn('unknown');
    const pending = invokeRecoveryHandler(
      MSG.REQUEST_CURRENT_FILE,
      { reason: 'missing_transfer_identity', queueItemId: Q0 },
      conn,
    );
    await vi.advanceTimersByTimeAsync(0);

    setResident(Q0, 'selected.mp3', new Blob(['replacement']), 7);
    const [peer] = getState('network.connectedPeers');
    peer.connectionType = 'local';
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
  });

  it('uses the matched host queue item in a refreshed remote descriptor', async () => {
    const currentBlob = new Blob(['remote-current'], { type: 'audio/mpeg' });
    setResident(Q2, 'remote.mp3', currentBlob, 9);
    remoteShareMocks.isConfigured.mockReturnValue(true);

    const conn = makeGuestConn('remote');
    await invokeRecoveryHandler(MSG.REQUEST_CURRENT_FILE, { queueItemId: Q2 }, conn);

    expect(remoteShareMocks.shareRemoteFileIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'remote.mp3' }),
      9,
      conn,
      { queueItemId: Q2 },
    );
  });

  it('refreshes R2 for a user file whose name matches a bundled demo asset', async () => {
    const currentBlob = new Blob(['user-owned-demo-name'], { type: DEMO_TRACK.mime });
    setResident(Q2, DEMO_TRACK.fileName, currentBlob, 10);
    remoteShareMocks.isConfigured.mockReturnValue(true);

    const conn = makeGuestConn('remote');
    await invokeRecoveryHandler(MSG.REQUEST_CURRENT_FILE, { queueItemId: Q2 }, conn);

    expect(remoteShareMocks.shareRemoteFileIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ name: DEMO_TRACK.fileName }),
      10,
      conn,
      { queueItemId: Q2 },
    );
  });

  it('rejects an exact queue item when the requested transfer session differs', async () => {
    setResident(Q0, 'same.mp3', new Blob(['session-seven']), 7);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_DATA_RECOVERY,
      { fileName: 'same.mp3', queueItemId: Q0, sessionId: 8, nextChunk: 0 },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_WAIT }));
  });

  it('refuses a cached current Blob when the requested session disagrees', async () => {
    setResident(Q0, 'same.mp3', new Blob(['ambiguous-session']), 7);
    setState('transfer.currentSessionId', 8);

    const conn = makeGuestConn();
    await invokeRecoveryHandler(
      MSG.REQUEST_DATA_RECOVERY,
      { queueItemId: Q0, sessionId: 8, nextChunk: 0 },
      conn,
    );

    const { unicastFile } = await import('../transfer.ts');
    expect(unicastFile).not.toHaveBeenCalled();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_WAIT }));
  });
});
