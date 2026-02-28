import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConn = any; // Partial mock for DataConnection in tests
import { bus } from '../../core/events.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
}));

vi.mock('../opfs.ts', () => ({
  ensureNamedFile: vi.fn((blob: unknown, name: string) => {
    if (!blob) return null;
    return { name, size: (blob as Blob).size };
  }),
}));

vi.mock('../transfer.ts', () => ({
  unicastFile: vi.fn(async () => {}),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  vi.useFakeTimers();
});

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
    setState('relay.upstreamDataConn', null);
    sendRecoveryRequest();
    // pending should not be set since we exit early
    expect(getState('recovery.pending')).toBeFalsy();
  });

  it('prefers upstream connection over host', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const upstreamSend = vi.fn();
    const hostSend = vi.fn();

    setState('relay.upstreamDataConn', { open: true, send: upstreamSend } as AnyConn);
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('recovery.retryCount', 0);
    setState('transfer.meta', { name: 'test.mp3' });

    sendRecoveryRequest();
    expect(getState('recovery.pending')).toBe(true);

    // Advance past backoff (first backoff = 2000ms)
    vi.advanceTimersByTime(2000);

    expect(upstreamSend).toHaveBeenCalled();
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('falls back to host when upstream is closed', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('relay.upstreamDataConn', { open: false, send: vi.fn() } as AnyConn);
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('recovery.retryCount', 0);
    setState('transfer.meta', { name: 'test.mp3' });

    sendRecoveryRequest();
    vi.advanceTimersByTime(2000);

    expect(hostSend).toHaveBeenCalled();
  });

  it('applies progressive backoff timing', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    // RECOVERY_BACKOFF = [2000, 5000, 10000]
    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { name: 'test.mp3' });

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
    setState('transfer.meta', { name: 'original.mp3' });
    setState('recovery.retryCount', 0);

    sendRecoveryRequest();

    // Change track during backoff
    setState('transfer.meta', { name: 'different.mp3' });
    vi.advanceTimersByTime(2000);

    expect(hostSend).not.toHaveBeenCalled();
    expect(getState('recovery.retryCount')).toBe(0); // reset
  });

  it('aborts if connection closed during backoff', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const conn = { open: true, send: vi.fn() } as AnyConn;
    setState('network.hostConn', conn);
    setState('transfer.meta', { name: 'test.mp3' });
    setState('recovery.retryCount', 0);

    sendRecoveryRequest();

    // Close connection during backoff
    conn.open = false;
    vi.advanceTimersByTime(2000);

    expect(conn.send).not.toHaveBeenCalled();
  });

  it('uses forceChunk when provided', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { name: 'test.mp3' });
    setState('transfer.receivedCount', 50);
    setState('recovery.retryCount', 0);

    sendRecoveryRequest(10);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(10);
  });

  it('uses receivedCount when forceChunk is null', async () => {
    const sendRecoveryRequest = await getSendRecoveryRequest();
    const hostSend = vi.fn();

    setState('network.hostConn', { open: true, send: hostSend } as AnyConn);
    setState('transfer.meta', { name: 'test.mp3' });
    setState('transfer.receivedCount', 42);
    setState('recovery.retryCount', 0);

    sendRecoveryRequest(null);
    vi.advanceTimersByTime(2000);

    const msg = hostSend.mock.calls[0][0];
    expect(msg.nextChunk).toBe(42);
  });
});

describe('initRecovery', () => {
  it('registers protocol handlers', async () => {
    const { registerHandlers } = await import('../../network/protocol.ts');
    const { initRecovery } = await import('../recovery.ts');
    initRecovery();
    expect(registerHandlers).toHaveBeenCalled();
  });
});
