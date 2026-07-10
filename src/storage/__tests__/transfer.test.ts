/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, TRANSFER_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('TRANSFER_STATE constants', () => {
  it('has IDLE state', () => {
    expect(TRANSFER_STATE.IDLE).toBe('IDLE');
  });

  it('has RECEIVING state', () => {
    expect(TRANSFER_STATE.RECEIVING).toBe('RECEIVING');
  });

  it('has PROCESSING state', () => {
    expect(TRANSFER_STATE.PROCESSING).toBe('PROCESSING');
  });

  it('has READY state', () => {
    expect(TRANSFER_STATE.READY).toBe('READY');
  });

  it('has exactly 4 states', () => {
    expect(Object.keys(TRANSFER_STATE)).toHaveLength(4);
  });
});

describe('initial transfer state', () => {
  it('transfer.state defaults to IDLE', () => {
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('transfer.receivedCount defaults to 0', () => {
    expect(getState('transfer.receivedCount')).toBe(0);
  });

  it('transfer.localSessionId defaults to 0', () => {
    expect(getState('transfer.localSessionId')).toBe(0);
  });

  it('transfer.currentSessionId defaults to 0', () => {
    expect(getState('transfer.currentSessionId')).toBe(0);
  });

  it('transfer.activeBroadcastSession defaults to null', () => {
    expect(getState('transfer.activeBroadcastSession')).toBeNull();
  });

  it('transfer.meta defaults to empty object', () => {
    const meta = getState('transfer.meta');
    expect(meta).toBeDefined();
    expect(typeof meta).toBe('object');
  });
});

describe('transfer state reset', () => {
  it('resetState restores transfer.state to IDLE', () => {
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);

    resetState();
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('resetState restores transfer.receivedCount to 0', () => {
    setState('transfer.receivedCount', 42);
    expect(getState('transfer.receivedCount')).toBe(42);

    resetState();
    expect(getState('transfer.receivedCount')).toBe(0);
  });
});

describe('transfer module exports', () => {
  it('imports broadcastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.broadcastFile).toBe('function');
  });

  it('imports unicastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.unicastFile).toBe('function');
  });

  it('imports initTransfer without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.initTransfer).toBe('function');
  });
});

describe('host outgoing transfer routing', () => {
  it('stops sending chunks to a peer that disconnects after FILE_START', async () => {
    const { broadcastFile } = await import('../transfer.ts');
    const currentConn = {
      open: true,
      peer: 'peer-current',
      send: vi.fn(),
    } as unknown as DataConnection;
    const staleConn = {
      open: true,
      peer: 'peer-stale',
      send: vi.fn((msg: Record<string, unknown>) => {
        if (msg.type !== MSG.FILE_START) return;
        setState('network.connectedPeers', [
          {
            id: 'peer-current',
            status: 'connected',
            conn: currentConn,
            isDataTarget: true,
            connectionType: 'local',
            joinOrder: 1,
          },
        ]);
        setState('network.activeHostConnByPeerId', new Map([['peer-current', currentConn]]));
      }),
    } as unknown as DataConnection;

    setState('playlist.currentTrackIndex', 0);
    setState('network.connectedPeers', [
      {
        id: 'peer-current',
        status: 'connected',
        conn: currentConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
      {
        id: 'peer-stale',
        status: 'connected',
        conn: staleConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 2,
      },
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-current', currentConn],
        ['peer-stale', staleConn],
      ]),
    );

    await broadcastFile(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }), 1);

    expect(staleConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(staleConn.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK }),
    );
    expect(currentConn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK }),
    );
    expect(currentConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });

  it('does not let a superseded broadcast stomp the successor session (FILE_END canary)', async () => {
    // Broadcast A can still be awaiting a slow peer when B replaces its scope.
    // A may clear only the session it owns; clearing B's session would stop B
    // at its supersession check before FILE_END.
    //
    // The backpressure timeout reads Date.now(), so fake timers must include
    // Date while advancing both broadcasts' exclusion windows.
    vi.useFakeTimers();
    try {
      const { broadcastFile } = await import('../transfer.ts');
      const slowConn = {
        open: true,
        peer: 'peer-slow',
        send: vi.fn(),
        peerConnection: { connectionState: 'connected' },
        dataChannel: { readyState: 'open', bufferedAmount: 10 * 1024 * 1024 },
      } as unknown as DataConnection;
      const healthyConn = {
        open: true,
        peer: 'peer-healthy',
        send: vi.fn(),
        peerConnection: { connectionState: 'connected' },
        dataChannel: { readyState: 'open', bufferedAmount: 0 },
      } as unknown as DataConnection;

      setState('playlist.currentTrackIndex', 0);
      setState('network.connectedPeers', [
        {
          id: 'peer-slow',
          status: 'connected',
          conn: slowConn,
          isDataTarget: true,
          connectionType: 'local',
          joinOrder: 1,
        },
        {
          id: 'peer-healthy',
          status: 'connected',
          conn: healthyConn,
          isDataTarget: true,
          connectionType: 'local',
          joinOrder: 2,
        },
      ]);
      setState(
        'network.activeHostConnByPeerId',
        new Map([
          ['peer-slow', slowConn],
          ['peer-healthy', healthyConn],
        ]),
      );

      // Leave A pending in the slow peer's backpressure wait.
      const a = broadcastFile(new File(['aaa'], 'a.mp3', { type: 'audio/mpeg' }), 1);
      await vi.advanceTimersByTimeAsync(100);

      const b = broadcastFile(new File(['bbb'], 'b.mp3', { type: 'audio/mpeg' }), 2);
      // Advance past both broadcasts' waits on the slow peer.
      await vi.advanceTimersByTimeAsync(12_000);
      await a;
      await b;

      // FILE_END proves A's cleanup did not clear B's active session.
      expect(healthyConn.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_START, sessionId: 2 }),
      );
      expect(healthyConn.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_CHUNK, sessionId: 2 }),
      );
      expect(healthyConn.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_END, sessionId: 2 }),
      );
      expect(getState('transfer.activeBroadcastSession')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips disconnected peer connections before bulk file broadcast starts', async () => {
    const { broadcastFile } = await import('../transfer.ts');
    const liveConn = {
      open: true,
      peer: 'peer-live',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    const disconnectedConn = {
      open: true,
      peer: 'peer-disconnected',
      send: vi.fn(),
      peerConnection: { connectionState: 'disconnected' },
      dataChannel: { readyState: 'open', bufferedAmount: 1024 * 1024 },
    } as unknown as DataConnection;

    setState('playlist.currentTrackIndex', 0);
    setState('network.connectedPeers', [
      {
        id: 'peer-live',
        status: 'connected',
        conn: liveConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
      {
        id: 'peer-disconnected',
        status: 'connected',
        conn: disconnectedConn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 2,
      },
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-live', liveConn],
        ['peer-disconnected', disconnectedConn],
      ]),
    );

    await broadcastFile(new File(['abc'], 'song.mp3', { type: 'audio/mpeg' }), 1);

    expect(disconnectedConn.send).not.toHaveBeenCalled();
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });
});

describe('debounced broadcast cancellation', () => {
  /** One healthy, fully writable local peer; returns its send spy. */
  function installHealthyPeer(id: string): ReturnType<typeof vi.fn> {
    const send = vi.fn();
    const conn = {
      open: true,
      peer: id,
      send,
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      {
        id,
        status: 'connected',
        conn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
    ]);
    setState('network.activeHostConnByPeerId', new Map([[id, conn]]));
    return send;
  }

  it('cancelOutgoingFileTransfers also drops a broadcast parked in the debounce window', async () => {
    // Playlist teardown and demo entry depend on cancellation covering work
    // that is still queued in the debounce window.
    vi.useFakeTimers();
    try {
      const { broadcastFileDebounced, cancelOutgoingFileTransfers } = await import('../transfer.ts');
      const send = installHealthyPeer('peer-1');
      setState('playlist.currentTrackIndex', 0);

      broadcastFileDebounced(new File(['abc'], 'gone.mp3', { type: 'audio/mpeg' }), 1, {
        type: MSG.FILE_PREPARE,
        name: 'gone.mp3',
        index: 0,
        sessionId: 1,
        mime: 'audio/mpeg',
      });
      cancelOutgoingFileTransfers();
      await vi.advanceTimersByTimeAsync(301);

      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
      expect(getState('transfer.activeBroadcastSession')).toBeNull();
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('still coalesces rapid arms into exactly one PREPARE+START for the last file', async () => {
    vi.useFakeTimers();
    try {
      const { broadcastFileDebounced } = await import('../transfer.ts');
      const send = installHealthyPeer('peer-1');
      setState('playlist.currentTrackIndex', 1);

      broadcastFileDebounced(new File(['aaa'], 'a.mp3', { type: 'audio/mpeg' }), 1, {
        type: MSG.FILE_PREPARE,
        name: 'a.mp3',
        index: 0,
        sessionId: 1,
        mime: 'audio/mpeg',
      });
      broadcastFileDebounced(new File(['bbb'], 'b.mp3', { type: 'audio/mpeg' }), 2, {
        type: MSG.FILE_PREPARE,
        name: 'b.mp3',
        index: 1,
        sessionId: 2,
        mime: 'audio/mpeg',
      });
      await vi.advanceTimersByTimeAsync(301);
      // Allow the fire-and-forget transfer to finish after the debounce fires.
      await vi.advanceTimersByTimeAsync(5_000);

      const sentTypes = send.mock.calls.map(([msg]) => (msg as { type: string }).type);
      expect(sentTypes.filter((t) => t === MSG.FILE_PREPARE)).toHaveLength(1);
      expect(sentTypes.filter((t) => t === MSG.FILE_START)).toHaveLength(1);
      expect(sentTypes.indexOf(MSG.FILE_PREPARE)).toBeLessThan(sentTypes.indexOf(MSG.FILE_START));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_PREPARE, name: 'b.mp3', sessionId: 2 }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_START, name: 'b.mp3', sessionId: 2 }),
      );
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });
});
