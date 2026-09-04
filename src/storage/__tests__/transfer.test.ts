/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { CHUNK_SIZE, MSG, TRANSFER_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  freezeFileDeliveryMode,
  markLocalFileR2Capable,
  resetFileDeliveryPolicies,
} from '../../share/file-delivery-policy.ts';

const Q0 = '00000000-0000-4000-8000-000000000001';
const Q1 = '00000000-0000-4000-8000-000000000002';
type ConnectedTestPeer = ConnectedPeer & { conn: DataConnection };

function connectedPeer(
  id: string,
  conn: DataConnection,
  overrides: Partial<ConnectedPeer> = {},
): ConnectedTestPeer {
  const joinOrder = overrides.joinOrder ?? 1;
  return {
    id,
    slot: joinOrder,
    label: id,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder,
    connectionType: 'local',
    lastHeartbeat: 0,
    ...overrides,
    conn,
  };
}

function publishHostFile(file: File | Blob, queueItemId = Q0, sessionId = 1): void {
  setState('playlist.items', [
    { queueItemId: Q0, type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
    { queueItemId: Q1, type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', queueItemId);
  setState('files.current', {
    queueItemId,
    indexHint: queueItemId === Q0 ? 0 : 1,
    name: file instanceof File ? file.name : 'Track',
    sessionId,
    size: file.size,
    mime: file.type,
    blob: file,
  });
}

beforeEach(() => {
  resetState();
  resetFileDeliveryPolicies();
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

describe('host outgoing transfer routing', () => {
  it('marks capable mixed-room peers for R2 and rejects unadvertised overflow explicitly', async () => {
    const { sendFilePrepareByDelivery } = await import('../transfer.ts');
    const peers = Array.from({ length: 10 }, (_, index) => {
      const id = `mixed-peer-${index + 1}`;
      const conn = { open: true, peer: id, send: vi.fn() } as unknown as DataConnection;
      return connectedPeer(id, conn, { joinOrder: index + 1 });
    });
    const capable = peers[9]!;
    markLocalFileR2Capable(capable.id);
    setState('network.connectedPeers', peers);

    sendFilePrepareByDelivery(
      {
        type: MSG.FILE_PREPARE,
        name: 'mixed.mp3',
        queueItemId: Q0,
        sessionId: 30,
        mime: 'audio/mpeg',
      },
      30,
    );

    for (const peer of peers.slice(0, 8)) {
      expect(peer.conn.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_PREPARE }),
      );
      expect(peer.conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ delivery: 'r2' }));
    }
    expect(peers[8]!.conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REMOTE_FILE_UNAVAILABLE, delivery: 'r2' }),
    );
    expect(peers[8]!.conn.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_PREPARE }),
    );
    expect(capable.conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_PREPARE, delivery: 'r2' }),
    );
  });

  it('defers an unadvertised peer until ICE chooses remote R2 or local overflow', async () => {
    const { sendFilePrepareByDelivery } = await import('../transfer.ts');
    const conn = {
      open: true,
      peer: 'unknown-unadvertised',
      send: vi.fn(),
    } as unknown as DataConnection;
    const unknownPeer = connectedPeer(conn.peer, conn, {
      isDataTarget: false,
      connectionType: 'unknown',
    });
    setState('network.connectedPeers', [unknownPeer]);
    const prepare = {
      type: MSG.FILE_PREPARE,
      name: 'unknown.mp3',
      queueItemId: Q0,
      sessionId: 32,
      mime: 'audio/mpeg',
    } as const;

    sendFilePrepareByDelivery(prepare, 32);
    expect(conn.send).not.toHaveBeenCalled();

    setState('network.connectedPeers', [{ ...unknownPeer, connectionType: 'remote' as const }]);
    sendFilePrepareByDelivery(prepare, 32);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_PREPARE, delivery: 'r2' }),
    );
  });

  it('does not use capability alone to route an unknown small-room peer through R2', async () => {
    const { sendFilePrepareByDelivery } = await import('../transfer.ts');
    const conn = {
      open: true,
      peer: 'unknown-capable',
      send: vi.fn(),
    } as unknown as DataConnection;
    const peer = connectedPeer(conn.peer, conn, {
      isDataTarget: false,
      connectionType: 'unknown',
    });
    setState('network.connectedPeers', [peer]);
    markLocalFileR2Capable(peer.id);
    const prepare = {
      type: MSG.FILE_PREPARE,
      name: 'capable.mp3',
      queueItemId: Q0,
      sessionId: 33,
      mime: 'audio/mpeg',
    } as const;

    sendFilePrepareByDelivery(prepare, 33);
    expect(conn.send).not.toHaveBeenCalled();

    setState('network.connectedPeers', [
      { ...peer, connectionType: 'local' as const, isDataTarget: true },
    ]);
    sendFilePrepareByDelivery(prepare, 33);
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
    expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ delivery: 'r2' }));
  });

  it('keeps sending on a frozen direct connection after an ICE label changes', async () => {
    const { broadcastFile } = await import('../transfer.ts');
    const file = new File(['frozen-direct'], 'direct.mp3', { type: 'audio/mpeg' });
    const conn = {
      open: true,
      peer: 'frozen-direct-peer',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected', iceConnectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    const localPeer = connectedPeer(conn.peer, conn);
    setState('network.connectedPeers', [localPeer]);
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    publishHostFile(file, Q0, 31);
    expect(freezeFileDeliveryMode(31)).toBe('direct-local');

    setState('network.connectedPeers', [
      { ...localPeer, connectionType: 'remote' as const, isDataTarget: false },
    ]);
    await broadcastFile(file, Q0, 31);

    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });

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
        setState('network.connectedPeers', [connectedPeer('peer-current', currentConn)]);
        setState('network.activeHostConnByPeerId', new Map([['peer-current', currentConn]]));
      }),
    } as unknown as DataConnection;

    const file = new File(['abc'], 'song.mp3', { type: 'audio/mpeg' });
    publishHostFile(file, Q0, 1);
    setState('network.connectedPeers', [
      connectedPeer('peer-current', currentConn),
      connectedPeer('peer-stale', staleConn, { joinOrder: 2 }),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-current', currentConn],
        ['peer-stale', staleConn],
      ]),
    );

    await broadcastFile(file, Q0, 1);

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

      const fileA = new File(['aaa'], 'a.mp3', { type: 'audio/mpeg' });
      const fileB = new File(['bbb'], 'b.mp3', { type: 'audio/mpeg' });
      publishHostFile(fileA, Q0, 1);
      setState('network.connectedPeers', [
        connectedPeer('peer-slow', slowConn),
        connectedPeer('peer-healthy', healthyConn, { joinOrder: 2 }),
      ]);
      setState(
        'network.activeHostConnByPeerId',
        new Map([
          ['peer-slow', slowConn],
          ['peer-healthy', healthyConn],
        ]),
      );

      // Leave A pending in the slow peer's backpressure wait.
      const a = broadcastFile(fileA, Q0, 1);
      await vi.advanceTimersByTimeAsync(100);

      publishHostFile(fileB, Q1, 2);
      const b = broadcastFile(fileB, Q1, 2);
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

  it('does not let a canceled old room clear a same-SID successor broadcast', async () => {
    const { broadcastFile, cancelOutgoingFileTransfers } = await import('../transfer.ts');
    cancelOutgoingFileTransfers();
    const conn = {
      open: true,
      peer: 'same-sid-peer',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected', iceConnectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [connectedPeer(conn.peer, conn)]);
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));

    const fileA = new File(['old-room'], 'old.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['new-room'], 'new.mp3', { type: 'audio/mpeg' });
    let resolveA: (value: ArrayBuffer) => void = () => undefined;
    let resolveB: (value: ArrayBuffer) => void = () => undefined;
    const readA = new Promise<ArrayBuffer>((resolve) => {
      resolveA = resolve;
    });
    const readB = new Promise<ArrayBuffer>((resolve) => {
      resolveB = resolve;
    });
    vi.spyOn(fileA, 'slice').mockReturnValue({ arrayBuffer: () => readA } as Blob);
    vi.spyOn(fileB, 'slice').mockReturnValue({ arrayBuffer: () => readB } as Blob);

    publishHostFile(fileA, Q0, 1);
    const oldBroadcast = broadcastFile(fileA, Q0, 1);
    cancelOutgoingFileTransfers();

    publishHostFile(fileB, Q1, 1);
    const successorBroadcast = broadcastFile(fileB, Q1, 1);
    resolveA(new TextEncoder().encode('old-room').buffer);
    await oldBroadcast;
    expect(getState('transfer.activeBroadcastSession')).toBe(1);

    resolveB(new TextEncoder().encode('new-room').buffer);
    await successorBroadcast;

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_CHUNK, name: 'new.mp3', sessionId: 1 }),
    );
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_END, name: 'new.mp3', sessionId: 1 }),
    );
    expect(getState('transfer.activeBroadcastSession')).toBeNull();
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

    const file = new File(['abc'], 'song.mp3', { type: 'audio/mpeg' });
    publishHostFile(file, Q0, 1);
    setState('network.connectedPeers', [
      connectedPeer('peer-live', liveConn),
      connectedPeer('peer-disconnected', disconnectedConn, { joinOrder: 2 }),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['peer-live', liveConn],
        ['peer-disconnected', disconnectedConn],
      ]),
    );

    await broadcastFile(file, Q0, 1);

    expect(disconnectedConn.send).not.toHaveBeenCalled();
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
    expect(liveConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
  });
});

describe('host unicast source liveness', () => {
  function installUnicastPeer(id = 'peer-unicast'): DataConnection {
    const conn = {
      open: true,
      peer: id,
      send: vi.fn(),
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [connectedPeer(id, conn)]);
    setState('network.activeHostConnByPeerId', new Map([[id, conn]]));
    return conn;
  }

  it('freezes the queue item before transport classification awaits', async () => {
    const { unicastFile } = await import('../transfer.ts');
    const conn = installUnicastPeer();
    publishHostFile(new Blob(['old-track']), Q0, 4);

    const pending = unicastFile(conn, new Blob(['old-track']), 0, 4, { queueItemId: Q0 });
    // canSendFileTo is async even for a known-local peer. Switching tracks in
    // this microtask must invalidate the frozen queue occurrence instead of
    // relabeling the old bytes with Q1.
    setState('playlist.currentQueueItemId', Q1);
    await pending;

    expect(conn.send).not.toHaveBeenCalled();
  });

  it('revalidates an exact same-queue-item Blob replacement before FILE_START', async () => {
    const { unicastFile } = await import('../transfer.ts');
    const conn = installUnicastPeer();
    const selected = new Blob(['selected']);
    publishHostFile(selected, Q0, 4);

    const pending = unicastFile(conn, selected, 0, 4, {
      queueItemId: Q0,
      isSourceCurrent: () => getState('files.current')?.blob === selected,
    });
    publishHostFile(new Blob(['replacement']), Q0, 4);
    await pending;

    expect(conn.send).not.toHaveBeenCalled();
  });

  it('stops after a backpressure await when the selected source is superseded', async () => {
    vi.useFakeTimers();
    try {
      const { unicastFile } = await import('../transfer.ts');
      const conn = installUnicastPeer() as DataConnection & {
        dataChannel: { readyState: string; bufferedAmount: number };
      };
      conn.dataChannel.bufferedAmount = 1024 * 1024;
      publishHostFile(new Blob(['active']), Q0, 4);
      let sourceCurrent = true;

      const pending = unicastFile(conn, new Blob(['blocked']), 0, 4, {
        queueItemId: Q0,
        isSourceCurrent: () => sourceCurrent,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));

      sourceCurrent = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
      expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks source identity after an asynchronous slice read', async () => {
    vi.useFakeTimers();
    try {
      const { unicastFile } = await import('../transfer.ts');
      const conn = installUnicastPeer();
      let resolveRead: (value: ArrayBuffer) => void = () => undefined;
      const read = new Promise<ArrayBuffer>((resolve) => {
        resolveRead = resolve;
      });
      const deferredBlob = {
        size: 3,
        type: 'audio/mpeg',
        slice: vi.fn(() => ({ arrayBuffer: () => read })),
      } as unknown as Blob;
      publishHostFile(new Blob(['active']), Q0, 4);
      let sourceCurrent = true;

      const pending = unicastFile(conn, deferredBlob, 0, 4, {
        queueItemId: Q0,
        isSourceCurrent: () => sourceCurrent,
      });
      await vi.advanceTimersByTimeAsync(100);
      sourceCurrent = false;
      resolveRead(new Uint8Array([1, 2, 3]).buffer);
      await pending;

      expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
      expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks source identity between the final chunk and FILE_END', async () => {
    vi.useFakeTimers();
    try {
      const { unicastFile } = await import('../transfer.ts');
      const conn = installUnicastPeer();
      publishHostFile(new Blob(['active']), Q0, 4);
      let sourceCurrent = true;
      vi.mocked(conn.send).mockImplementation((message: unknown) => {
        if ((message as { type?: string }).type === MSG.FILE_CHUNK) sourceCurrent = false;
      });

      const pending = unicastFile(conn, new Blob(['one-chunk']), 0, 4, {
        queueItemId: Q0,
        isSourceCurrent: () => sourceCurrent,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_CHUNK }));
      expect(conn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_END }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('host active-file lane arbitration', () => {
  function installLanePeer(id: string): DataConnection {
    const conn = {
      open: true,
      peer: id,
      send: vi.fn(),
      peerConnection: { connectionState: 'connected', iceConnectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [connectedPeer(id, conn)]);
    setState('network.activeHostConnByPeerId', new Map([[id, conn]]));
    return conn;
  }

  it('finishes a healthy peer before a stalled sibling and fences duplicate bootstrap', async () => {
    vi.useFakeTimers();
    try {
      const { broadcastFile, unicastFile, cancelOutgoingFileTransfers } =
        await import('../transfer.ts');
      cancelOutgoingFileTransfers();
      const healthy = installLanePeer('independent-healthy');
      const stalled = installLanePeer('independent-stalled');
      Object.assign(stalled, {
        dataChannel: { readyState: 'open', bufferedAmount: 10 * 1024 * 1024 },
      });
      setState('network.connectedPeers', [
        connectedPeer(healthy.peer, healthy),
        connectedPeer(stalled.peer, stalled, { joinOrder: 2 }),
      ]);
      setState(
        'network.activeHostConnByPeerId',
        new Map([
          [healthy.peer, healthy],
          [stalled.peer, stalled],
        ]),
      );
      const file = new File([new Uint8Array(CHUNK_SIZE * 2 + 1)], 'independent.mp3', {
        type: 'audio/mpeg',
      });
      publishHostFile(file, Q0, 81);

      const broadcast = broadcastFile(file, Q0, 81);
      await vi.advanceTimersByTimeAsync(100);
      const healthyMessages = () =>
        vi.mocked(healthy.send).mock.calls.map(([message]) => message as Record<string, unknown>);
      expect(
        healthyMessages()
          .filter((message) => message.type === MSG.FILE_CHUNK)
          .map((message) => message.chunkIndex),
      ).toEqual([0, 1, 2]);
      expect(healthyMessages().filter((message) => message.type === MSG.FILE_END)).toHaveLength(1);
      expect(stalled.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_CHUNK }),
      );
      expect(stalled.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_END }),
      );
      expect(getState('transfer.activeBroadcastSession')).toBe(81);

      await unicastFile(healthy, file, 0, 81, { queueItemId: Q0, purpose: 'bootstrap' });
      expect(healthyMessages().filter((message) => message.type === MSG.FILE_START)).toHaveLength(
        1,
      );
      expect(healthyMessages().filter((message) => message.type === MSG.FILE_END)).toHaveLength(1);

      cancelOutgoingFileTransfers();
      await vi.advanceTimersByTimeAsync(100);
      await broadcast;
      expect(stalled.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_END }),
      );
      expect(getState('transfer.activeBroadcastSession')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins a bootstrap unicast to an in-flight exact broadcast', async () => {
    const { broadcastFile, unicastFile, cancelOutgoingFileTransfers } =
      await import('../transfer.ts');
    cancelOutgoingFileTransfers();
    const conn = installLanePeer('lane-broadcast-first');
    const file = new File(['broadcast-first'], 'lane.mp3', { type: 'audio/mpeg' });
    publishHostFile(file, Q0, 41);

    let resolveRead: (value: ArrayBuffer) => void = () => undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => read } as Blob);

    const broadcast = broadcastFile(file, Q0, 41);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_START, sessionId: 41 }),
    );

    await unicastFile(conn, file, 0, 41, {
      queueItemId: Q0,
      purpose: 'bootstrap',
    });
    resolveRead(new TextEncoder().encode('broadcast-first').buffer);
    await broadcast;

    const sent = vi.mocked(conn.send).mock.calls.map(([msg]) => msg as Record<string, unknown>);
    expect(sent.filter((msg) => msg.type === MSG.FILE_START)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_CHUNK)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_END)).toHaveLength(1);
  });

  it('keeps a completed bootstrap as the fence for a delayed exact broadcast', async () => {
    const { broadcastFile, unicastFile, cancelOutgoingFileTransfers } =
      await import('../transfer.ts');
    cancelOutgoingFileTransfers();
    const conn = installLanePeer('lane-unicast-first');
    const file = new File(['unicast-first'], 'lane.mp3', { type: 'audio/mpeg' });
    publishHostFile(file, Q0, 42);

    await unicastFile(conn, file, 0, 42, {
      queueItemId: Q0,
      purpose: 'bootstrap',
    });
    await broadcastFile(file, Q0, 42);

    const sent = vi.mocked(conn.send).mock.calls.map(([msg]) => msg as Record<string, unknown>);
    expect(sent.filter((msg) => msg.type === MSG.FILE_START)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_CHUNK)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_END)).toHaveLength(1);
  });

  it('lets explicit recovery take over only its peer from a stalled broadcast', async () => {
    const { broadcastFile, unicastFile, cancelOutgoingFileTransfers } =
      await import('../transfer.ts');
    cancelOutgoingFileTransfers();
    const conn = installLanePeer('lane-recovery');
    const healthyConn = {
      open: true,
      peer: 'lane-healthy',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected', iceConnectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      connectedPeer(conn.peer, conn),
      connectedPeer(healthyConn.peer, healthyConn, { joinOrder: 2 }),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        [conn.peer, conn],
        [healthyConn.peer, healthyConn],
      ]),
    );
    const bytes = new Uint8Array(CHUNK_SIZE + 1);
    const file = new File([bytes], 'lane.mp3', { type: 'audio/mpeg' });
    publishHostFile(file, Q0, 43);

    let resolveFirstRead: (value: ArrayBuffer) => void = () => undefined;
    const firstRead = new Promise<ArrayBuffer>((resolve) => {
      resolveFirstRead = resolve;
    });
    const realSlice = file.slice.bind(file);
    vi.spyOn(file, 'slice').mockImplementation((start, end, type) => {
      if (Number(start) === 0) return { arrayBuffer: () => firstRead } as Blob;
      return realSlice(start, end, type);
    });

    const broadcast = broadcastFile(file, Q0, 43);
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.FILE_START, sessionId: 43 }),
    );

    await unicastFile(conn, file, 1, 43, {
      queueItemId: Q0,
      purpose: 'recovery',
    });
    resolveFirstRead(new Uint8Array(CHUNK_SIZE).buffer);
    await broadcast;

    // The old broadcast's cleanup must not erase the recovery successor.
    await unicastFile(conn, file, 0, 43, {
      queueItemId: Q0,
      purpose: 'bootstrap',
    });

    const sent = vi.mocked(conn.send).mock.calls.map(([msg]) => msg as Record<string, unknown>);
    expect(sent.filter((msg) => msg.type === MSG.FILE_START)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_RESUME)).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === MSG.FILE_CHUNK && msg.chunkIndex === 0)).toHaveLength(
      0,
    );
    expect(sent.filter((msg) => msg.type === MSG.FILE_CHUNK && msg.chunkIndex === 1)).toHaveLength(
      1,
    );
    expect(sent.filter((msg) => msg.type === MSG.FILE_END)).toHaveLength(1);

    const healthySent = vi
      .mocked(healthyConn.send)
      .mock.calls.map(([msg]) => msg as Record<string, unknown>);
    expect(healthySent.filter((msg) => msg.type === MSG.FILE_START)).toHaveLength(1);
    expect(
      healthySent.filter((msg) => msg.type === MSG.FILE_CHUNK && msg.chunkIndex === 0),
    ).toHaveLength(1);
    expect(
      healthySent.filter((msg) => msg.type === MSG.FILE_CHUNK && msg.chunkIndex === 1),
    ).toHaveLength(1);
    expect(healthySent.filter((msg) => msg.type === MSG.FILE_END)).toHaveLength(1);
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
    setState('network.connectedPeers', [connectedPeer(id, conn)]);
    setState('network.activeHostConnByPeerId', new Map([[id, conn]]));
    return send;
  }

  it('parks the latest payload beyond 300 ms and sends it only after resume', async () => {
    vi.useFakeTimers();
    const {
      beginPendingBroadcastSuspension,
      broadcastFileDebounced,
      cancelOutgoingFileTransfers,
      resumePendingBroadcastSuspension,
    } = await import('../transfer.ts');
    try {
      cancelOutgoingFileTransfers();
      const send = installHealthyPeer('peer-slow-picker');
      const first = new File(['first'], 'first.mp3', { type: 'audio/mpeg' });
      const latest = new File(['latest'], 'latest.mp3', { type: 'audio/mpeg' });
      publishHostFile(first, Q0, 101);
      broadcastFileDebounced(first, Q0, 101, {
        type: MSG.FILE_PREPARE,
        name: first.name,
        queueItemId: Q0,
        sessionId: 101,
        mime: first.type,
      });

      const suspension = beginPendingBroadcastSuspension();
      publishHostFile(latest, Q1, 102);
      broadcastFileDebounced(latest, Q1, 102, {
        type: MSG.FILE_PREPARE,
        name: latest.name,
        queueItemId: Q1,
        sessionId: 102,
        mime: latest.type,
      });

      // A native display picker can remain open far beyond the normal
      // debounce. Neither metadata nor bytes may escape while it is open.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));

      resumePendingBroadcastSuspension(suspension);
      await vi.advanceTimersByTimeAsync(301);
      await vi.advanceTimersByTimeAsync(20);

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_PREPARE,
          name: latest.name,
          queueItemId: Q1,
          sessionId: 102,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_START,
          name: latest.name,
          queueItemId: Q1,
          sessionId: 102,
        }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_PREPARE, name: first.name }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_START, name: first.name }),
      );
    } finally {
      cancelOutgoingFileTransfers();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('drops a parked payload when its suspension is committed', async () => {
    vi.useFakeTimers();
    const {
      beginPendingBroadcastSuspension,
      broadcastFileDebounced,
      cancelOutgoingFileTransfers,
      discardPendingBroadcastSuspension,
    } = await import('../transfer.ts');
    try {
      cancelOutgoingFileTransfers();
      const send = installHealthyPeer('peer-picker-commit');
      const file = new File(['discarded'], 'discarded.mp3', { type: 'audio/mpeg' });
      publishHostFile(file, Q0, 103);
      broadcastFileDebounced(file, Q0, 103, {
        type: MSG.FILE_PREPARE,
        name: file.name,
        queueItemId: Q0,
        sessionId: 103,
        mime: file.type,
      });

      const suspension = beginPendingBroadcastSuspension();
      await vi.advanceTimersByTimeAsync(1_000);
      discardPendingBroadcastSuspension(suspension);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
      expect(getState('transfer.activeBroadcastSession')).toBeNull();
    } finally {
      cancelOutgoingFileTransfers();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('does not let a stale suspension resume or discard a newer parked payload', async () => {
    vi.useFakeTimers();
    const {
      beginPendingBroadcastSuspension,
      broadcastFileDebounced,
      cancelOutgoingFileTransfers,
      discardPendingBroadcastSuspension,
      resumePendingBroadcastSuspension,
    } = await import('../transfer.ts');
    try {
      cancelOutgoingFileTransfers();
      const send = installHealthyPeer('peer-stale-suspension');
      const first = new File(['first'], 'stale.mp3', { type: 'audio/mpeg' });
      const latest = new File(['latest'], 'current.mp3', { type: 'audio/mpeg' });
      publishHostFile(first, Q0, 104);
      broadcastFileDebounced(first, Q0, 104, {
        type: MSG.FILE_PREPARE,
        name: first.name,
        queueItemId: Q0,
        sessionId: 104,
        mime: first.type,
      });
      const staleSuspension = beginPendingBroadcastSuspension();

      publishHostFile(latest, Q1, 105);
      broadcastFileDebounced(latest, Q1, 105, {
        type: MSG.FILE_PREPARE,
        name: latest.name,
        queueItemId: Q1,
        sessionId: 105,
        mime: latest.type,
      });
      const currentSuspension = beginPendingBroadcastSuspension();

      resumePendingBroadcastSuspension(staleSuspension);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).not.toHaveBeenCalled();

      resumePendingBroadcastSuspension(currentSuspension);
      // The stale attempt may finish after the successor resumes. It must not
      // cancel the successor's newly armed timer.
      discardPendingBroadcastSuspension(staleSuspension);
      await vi.advanceTimersByTimeAsync(301);
      await vi.advanceTimersByTimeAsync(20);

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_PREPARE,
          name: latest.name,
          queueItemId: Q1,
          sessionId: 105,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_START,
          name: latest.name,
          queueItemId: Q1,
          sessionId: 105,
        }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_PREPARE, name: first.name }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_START, name: first.name }),
      );
    } finally {
      cancelOutgoingFileTransfers();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('cancelOutgoingFileTransfers also drops a broadcast parked in the debounce window', async () => {
    // Playlist teardown and demo entry depend on cancellation covering work
    // that is still queued in the debounce window.
    vi.useFakeTimers();
    try {
      const { broadcastFileDebounced, cancelOutgoingFileTransfers } =
        await import('../transfer.ts');
      const send = installHealthyPeer('peer-1');
      const file = new File(['abc'], 'gone.mp3', { type: 'audio/mpeg' });
      publishHostFile(file, Q0, 1);

      broadcastFileDebounced(file, Q0, 1, {
        type: MSG.FILE_PREPARE,
        name: 'gone.mp3',
        queueItemId: Q0,
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

  it('suppresses a delayed PREPARE and payload after exact bootstrap completion', async () => {
    vi.useFakeTimers();
    try {
      const { broadcastFileDebounced, unicastFile, cancelOutgoingFileTransfers } =
        await import('../transfer.ts');
      cancelOutgoingFileTransfers();
      const send = installHealthyPeer('peer-bootstrap-fence');
      const conn = getState('network.connectedPeers')[0]!.conn as DataConnection;
      const otherConn = {
        open: true,
        peer: 'peer-broadcast-target',
        send: vi.fn(),
        peerConnection: { connectionState: 'connected' },
        dataChannel: { readyState: 'open', bufferedAmount: 0 },
      } as unknown as DataConnection;
      setState('network.connectedPeers', [
        connectedPeer(conn.peer, conn),
        connectedPeer(otherConn.peer, otherConn, { joinOrder: 2 }),
      ]);
      setState(
        'network.activeHostConnByPeerId',
        new Map([
          [conn.peer, conn],
          [otherConn.peer, otherConn],
        ]),
      );
      const file = new File(['bootstrap-wins'], 'bootstrap.mp3', { type: 'audio/mpeg' });
      publishHostFile(file, Q0, 51);

      const prepare = {
        type: MSG.FILE_PREPARE,
        name: file.name,
        queueItemId: Q0,
        sessionId: 51,
        mime: file.type,
      } as const;
      // playback.ts sends this peer-specific bootstrap PREPARE immediately.
      conn.send(prepare);
      broadcastFileDebounced(file, Q0, 51, prepare);
      const bootstrap = unicastFile(conn, file, 0, 51, {
        queueItemId: Q0,
        purpose: 'bootstrap',
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(10);
      await bootstrap;
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(0);

      const sentTypes = send.mock.calls.map(([msg]) => (msg as { type: string }).type);
      expect(sentTypes.filter((type) => type === MSG.FILE_PREPARE)).toHaveLength(1);
      expect(sentTypes.filter((type) => type === MSG.FILE_START)).toHaveLength(1);
      expect(sentTypes.filter((type) => type === MSG.FILE_CHUNK)).toHaveLength(1);
      expect(sentTypes.filter((type) => type === MSG.FILE_END)).toHaveLength(1);

      const otherTypes = vi
        .mocked(otherConn.send)
        .mock.calls.map(([msg]) => (msg as { type: string }).type);
      expect(otherTypes.filter((type) => type === MSG.FILE_PREPARE)).toHaveLength(1);
      expect(otherTypes.filter((type) => type === MSG.FILE_START)).toHaveLength(1);
      expect(otherTypes.filter((type) => type === MSG.FILE_CHUNK)).toHaveLength(1);
      expect(otherTypes.filter((type) => type === MSG.FILE_END)).toHaveLength(1);
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('invalidates an old-room suspension before a new-room payload is armed', async () => {
    vi.useFakeTimers();
    const {
      beginPendingBroadcastSuspension,
      broadcastFileDebounced,
      cancelOutgoingFileTransfers,
      discardPendingBroadcastSuspension,
      initTransfer,
      resumePendingBroadcastSuspension,
    } = await import('../transfer.ts');
    try {
      cancelOutgoingFileTransfers();
      initTransfer();
      setState('network.sessionCode', '111111');
      const send = installHealthyPeer('new-room-peer');

      const oldFile = new File(['old'], 'old-room.mp3', { type: 'audio/mpeg' });
      publishHostFile(oldFile, Q0, 78);
      setState('transfer.localSessionId', 78);
      setState('transfer.currentSessionId', 78);
      broadcastFileDebounced(oldFile, Q0, 78, {
        type: MSG.FILE_PREPARE,
        name: oldFile.name,
        queueItemId: Q0,
        sessionId: 78,
        mime: oldFile.type,
      });
      const oldRoomSuspension = beginPendingBroadcastSuspension();

      // leaveSession() publishes the same session-code boundary synchronously.
      // It must invalidate the unresolved native picker's old-room token.
      setState('network.sessionCode', '');
      expect(getState('transfer.localSessionId')).toBe(0);
      expect(getState('transfer.currentSessionId')).toBe(0);
      expect(getState('transfer.activeBroadcastSession')).toBeNull();
      setState('network.sessionCode', '222222');

      const newFile = new File(['new'], 'new-room.mp3', { type: 'audio/mpeg' });
      publishHostFile(newFile, Q1, 79);
      broadcastFileDebounced(newFile, Q1, 79, {
        type: MSG.FILE_PREPARE,
        name: newFile.name,
        queueItemId: Q1,
        sessionId: 79,
        mime: newFile.type,
      });

      // The abandoned picker may settle either way after the new room starts.
      // Neither stale continuation may release or cancel new-room work.
      resumePendingBroadcastSuspension(oldRoomSuspension);
      discardPendingBroadcastSuspension(oldRoomSuspension);
      await vi.advanceTimersByTimeAsync(301);
      await vi.advanceTimersByTimeAsync(20);

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_PREPARE,
          name: newFile.name,
          queueItemId: Q1,
          sessionId: 79,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.FILE_START,
          name: newFile.name,
          queueItemId: Q1,
          sessionId: 79,
        }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_PREPARE, name: oldFile.name }),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.FILE_START, name: oldFile.name }),
      );
    } finally {
      cancelOutgoingFileTransfers();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('still coalesces rapid arms into exactly one PREPARE+START for the last file', async () => {
    vi.useFakeTimers();
    try {
      const { broadcastFileDebounced } = await import('../transfer.ts');
      const send = installHealthyPeer('peer-1');
      const fileA = new File(['aaa'], 'a.mp3', { type: 'audio/mpeg' });
      const fileB = new File(['bbb'], 'b.mp3', { type: 'audio/mpeg' });
      publishHostFile(fileA, Q0, 1);

      broadcastFileDebounced(fileA, Q0, 1, {
        type: MSG.FILE_PREPARE,
        name: 'a.mp3',
        queueItemId: Q0,
        sessionId: 1,
        mime: 'audio/mpeg',
      });
      publishHostFile(fileB, Q1, 2);
      broadcastFileDebounced(fileB, Q1, 2, {
        type: MSG.FILE_PREPARE,
        name: 'b.mp3',
        queueItemId: Q1,
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
