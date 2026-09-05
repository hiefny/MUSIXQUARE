/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import type {
  ConnectedPeer,
  DataConnection,
  StandardOperatorFileUplinkProgress,
} from '../../types/index.ts';
import { handleData, resetInboundRateLimit } from '../protocol.ts';
import {
  initStandardOperatorFileUplink,
  uploadStandardOperatorFiles,
} from '../operator-file-uplink.ts';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000001';

function makeConnection(peer: string, onSend?: (message: Record<string, unknown>) => void) {
  const send = vi.fn((value: unknown) => onSend?.(value as Record<string, unknown>));
  const conn = {
    peer,
    open: true,
    send,
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  return { conn, send };
}

function queueInboundData(
  data: Record<string, unknown>,
  conn: DataConnection,
  pending: Promise<void>[],
): void {
  queueMicrotask(() => {
    pending.push(handleData(data, conn));
  });
}

function makeConnectedPeer(conn: DataConnection, isOp = true): ConnectedPeer {
  return {
    id: conn.peer,
    slot: 1,
    label: conn.peer,
    conn,
    isOp,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: Date.now(),
  };
}

function enterHost(connections: Array<{ conn: DataConnection; isOp?: boolean }>): void {
  const peers = connections.map(({ conn, isOp }) => makeConnectedPeer(conn, isOp ?? true));
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('network.hostConn', null);
  setState(
    'network.activeHostConnByPeerId',
    new Map(peers.map((peer) => [peer.id, peer.conn!] as const)),
  );
  setState('network.connectedPeers', peers);
}

function enterOperatorGuest(conn: DataConnection): void {
  setState('network.appRole', 'guest');
  setState('network.sessionCode', '123456');
  setState('network.hostConn', conn);
  setState('network.isOperator', true);
}

function startMessage(size: number, overrides: Record<string, unknown> = {}) {
  return {
    type: MSG.OPERATOR_FILE_UPLOAD_START,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    name: 'admin.mp3',
    mime: 'audio/mpeg',
    size,
    total: Math.ceil(size / CHUNK_SIZE),
    ...overrides,
  };
}

function sentStatuses(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_STATUS);
}

beforeAll(() => {
  initStandardOperatorFileUplink();
});

beforeEach(() => {
  resetState();
});

afterEach(() => {
  // Drives the module's lifecycle cleanup without clearing its registered bus
  // listeners (the singleton is intentionally initialized only once).
  setState('network.appRole', 'idle');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('standard operator file uplink host receiver', () => {
  it('keeps strict metadata and own-key admission before reserving an upload', async () => {
    const { conn, send } = makeConnection('admin-metadata-boundaries');
    enterHost([{ conn }]);
    const invalid = [
      { name: 42 },
      { name: '' },
      { name: ' leading.mp3' },
      { name: 'path/file.mp3' },
      { name: 'path\\file.mp3' },
      { name: 'control\u001f.mp3' },
      { name: 'control\u007f.mp3' },
      { name: `${'a'.repeat(252)}.mp3` },
      { mime: null },
      { mime: '' },
      { mime: 'audio/mpeg ' },
      { mime: `audio/${'a'.repeat(123)}` },
    ];
    for (const fields of invalid) await handleData(startMessage(1, fields), conn);
    const inheritedName = startMessage(1) as Record<string, unknown>;
    delete inheritedName.name;
    Object.setPrototypeOf(inheritedName, { name: 'inherited.mp3' });
    await handleData(inheritedName, conn);
    expect(sentStatuses(send)).toEqual([]);

    // UTF-16 length and MIME limits retain their inclusive boundaries; the
    // parser must not normalize metadata into a different admission policy.
    await handleData(
      startMessage(1, {
        name: `🎵${'a'.repeat(249)}.mp3`,
        mime: `audio/${'a'.repeat(122)}`,
      }),
      conn,
    );
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'ready', loaded: 0, total: 1 });
  });

  it('accepts real cross-realm buffers after rejecting unsupported and out-of-bounds chunks', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const foreign = iframe.contentWindow as unknown as {
      ArrayBuffer: new (length: number) => ArrayBuffer;
      Uint8Array: new (buffer: ArrayBuffer) => Uint8Array;
    };
    const chunk = new foreign.ArrayBuffer(3);
    new foreign.Uint8Array(chunk).set([4, 5, 6]);
    expect(chunk instanceof ArrayBuffer).toBe(false);
    const { conn, send } = makeConnection('admin-cross-realm');
    enterHost([{ conn }]);
    const received = vi.fn((_file: File, acknowledge: (accepted: boolean) => void) => {
      acknowledge(true);
    });
    const off = bus.on('standard-room:operator-file-received', received);
    try {
      await handleData(startMessage(3), conn);
      for (const candidate of [
        new DataView(new ArrayBuffer(3)),
        new Uint8Array(0),
        new Uint8Array(CHUNK_SIZE + 1),
        chunk,
      ]) {
        await handleData(
          {
            type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
            requestId: REQUEST_ID,
            sessionId: SESSION_ID,
            chunkIndex: 0,
            chunk: candidate,
          },
          conn,
        );
      }
      await handleData(
        { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
        conn,
      );
      expect(received).toHaveBeenCalledTimes(1);
      const file = received.mock.calls[0]![0];
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([4, 5, 6]);
      expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'complete', loaded: 3, total: 3 });
    } finally {
      off();
      iframe.remove();
    }
  });

  it('appends only after strict full assembly and ACKs after synchronous commit', async () => {
    const order: string[] = [];
    const { conn, send } = makeConnection('admin-1', (message) => {
      if (message.type === MSG.OPERATOR_FILE_UPLOAD_STATUS && message.status === 'complete') {
        order.push('complete-ack');
      }
    });
    enterHost([{ conn }]);

    const receipt: { file: File | null } = { file: null };
    const off = bus.on('standard-room:operator-file-received', (file, acknowledge) => {
      order.push('playlist-commit');
      receipt.file = file;
      acknowledge(true);
    });

    await handleData(startMessage(3), conn);
    expect(receipt.file).toBeNull();
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'ready', loaded: 0, total: 3 });

    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([1, 2, 3]),
      },
      conn,
    );
    expect(receipt.file).toBeNull();

    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );

    expect(receipt.file).not.toBeNull();
    if (!receipt.file) throw new Error('Expected the assembled operator upload');
    expect(receipt.file.name).toBe('admin.mp3');
    expect(receipt.file.type).toBe('audio/mpeg');
    expect([...new Uint8Array(await receipt.file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(order).toEqual(['playlist-commit', 'complete-ack']);
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'complete', loaded: 3, total: 3 });
    off();
  });

  it('waits for trailing bulk chunks when FINISH arrives on control first', async () => {
    const { conn, send } = makeConnection('admin-early-finish');
    enterHost([{ conn }]);
    const received = vi.fn((_file: File, acknowledge: (accepted: boolean) => void) => {
      acknowledge(true);
    });
    const off = bus.on('standard-room:operator-file-received', received);

    await handleData(startMessage(3), conn);
    send.mockClear();
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );

    expect(received).not.toHaveBeenCalled();
    expect(sentStatuses(send)).toEqual([]);

    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([1, 2, 3]),
      },
      conn,
    );

    expect(received).toHaveBeenCalledTimes(1);
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'complete', loaded: 3, total: 3 });

    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'complete', loaded: 3, total: 3 });
    off();
  });

  it('summarizes a negotiated multi-file batch once at its terminal frame', async () => {
    const { conn } = makeConnection('admin-batch');
    enterHost([{ conn }]);
    const additions: Array<{ conn: DataConnection; count: number; firstTitle?: string }> = [];
    const offReceived = bus.on('standard-room:operator-file-received', (_file, acknowledge) => {
      acknowledge(true);
    });
    const offAdded = bus.on('standard-room:operator-files-added', (source, count, firstTitle) => {
      additions.push({ conn: source, count, firstTitle });
    });

    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_BATCH_START,
        requestId: REQUEST_ID,
        fileCount: 2,
      },
      conn,
    );
    for (const [index, sessionId] of [
      SESSION_ID,
      '20000000-0000-4000-8000-000000000002',
    ].entries()) {
      await handleData(
        startMessage(1, {
          sessionId,
          name: `track-${index + 1}.mp3`,
        }),
        conn,
      );
      await handleData(
        {
          type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
          requestId: REQUEST_ID,
          sessionId,
          chunkIndex: 0,
          chunk: new Uint8Array([index + 1]),
        },
        conn,
      );
      await handleData(
        { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId },
        conn,
      );
    }

    expect(additions).toEqual([]);
    const terminal = {
      type: MSG.OPERATOR_FILE_UPLOAD_BATCH_COMPLETE,
      requestId: REQUEST_ID,
      committedCount: 2,
    } as const;
    await handleData(terminal, conn);
    await handleData(terminal, conn);
    expect(additions).toEqual([{ conn, count: 2, firstTitle: 'track-1' }]);
    offAdded();
    offReceived();
  });

  it('keeps pre-batch clients compatible with one notice per committed file', async () => {
    const { conn } = makeConnection('admin-legacy');
    enterHost([{ conn }]);
    const additions: number[] = [];
    const offReceived = bus.on('standard-room:operator-file-received', (_file, acknowledge) => {
      acknowledge(true);
    });
    const offAdded = bus.on('standard-room:operator-files-added', (_source, count) => {
      additions.push(count);
    });

    await handleData(startMessage(1), conn);
    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([1]),
      },
      conn,
    );
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );

    expect(additions).toEqual([1]);
    offAdded();
    offReceived();
  });

  it('rejects instead of reporting success when the playlist does not acknowledge commit', async () => {
    const { conn, send } = makeConnection('admin-2');
    enterHost([{ conn }]);
    const off = bus.on('standard-room:operator-file-received', (_file, acknowledge) => {
      acknowledge(false);
    });

    await handleData(startMessage(1), conn);
    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([7]),
      },
      conn,
    );
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );

    expect(sentStatuses(send).at(-1)).toMatchObject({
      status: 'rejected',
      code: 'upload-failed',
    });
    expect(sentStatuses(send).some((message) => message.status === 'complete')).toBe(false);
    off();
  });

  it('aborts an out-of-order stream before publishing any File', async () => {
    const { conn, send } = makeConnection('admin-3');
    enterHost([{ conn }]);
    const received = vi.fn();
    const off = bus.on('standard-room:operator-file-received', received);

    await handleData(startMessage(CHUNK_SIZE + 1), conn);
    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 1,
        chunk: new Uint8Array([1]),
      },
      conn,
    );

    expect(received).not.toHaveBeenCalled();
    expect(sentStatuses(send).at(-1)).toMatchObject({
      status: 'rejected',
      code: 'protocol-error',
    });
    off();
  });

  it('revalidates the exact live operator connection and aborts immediately on revoke', async () => {
    const { conn, send } = makeConnection('admin-4');
    enterHost([{ conn }]);
    await handleData(startMessage(8), conn);

    setState('network.connectedPeers', [makeConnectedPeer(conn, false)]);

    expect(sentStatuses(send).at(-1)).toMatchObject({
      status: 'rejected',
      code: 'operator-revoked',
    });
  });

  it('reserves at most 200 MiB across all administrators and releases on abort', async () => {
    const first = makeConnection('admin-5');
    const second = makeConnection('admin-6');
    enterHost([{ conn: first.conn }, { conn: second.conn }]);
    const mib = 1024 * 1024;

    await handleData(startMessage(150 * mib), first.conn);
    await handleData(
      startMessage(60 * mib, {
        requestId: '30000000-0000-4000-8000-000000000001',
        sessionId: '40000000-0000-4000-8000-000000000001',
      }),
      second.conn,
    );
    expect(sentStatuses(second.send).at(-1)).toMatchObject({
      status: 'rejected',
      code: 'host-busy',
    });

    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_ABORT,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        reason: 'cancelled',
      },
      first.conn,
    );
    await handleData(
      startMessage(60 * mib, {
        requestId: '30000000-0000-4000-8000-000000000002',
        sessionId: '40000000-0000-4000-8000-000000000002',
      }),
      second.conn,
    );
    expect(sentStatuses(second.send).at(-1)).toMatchObject({ status: 'ready' });
  });

  it('replays a settled COMPLETE for duplicate FINISH and START without republishing', async () => {
    const { conn, send } = makeConnection('admin-replay');
    enterHost([{ conn }]);
    const received = vi.fn((_file: File, acknowledge: (accepted: boolean) => void) => {
      acknowledge(true);
    });
    const off = bus.on('standard-room:operator-file-received', received);

    await handleData(startMessage(1), conn);
    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([1]),
      },
      conn,
    );
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );
    expect(received).toHaveBeenCalledTimes(1);

    send.mockClear();
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );
    await handleData(startMessage(1), conn);

    expect(received).toHaveBeenCalledTimes(1);
    expect(sentStatuses(send)).toEqual([
      expect.objectContaining({ status: 'complete', loaded: 1, total: 1 }),
      expect.objectContaining({ status: 'complete', loaded: 1, total: 1 }),
    ]);
    off();
  });

  it('releases bytes and the active slot when File assembly throws', async () => {
    const { conn, send } = makeConnection('admin-assembly-failure');
    enterHost([{ conn }]);

    await handleData(startMessage(1), conn);
    await handleData(
      {
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        chunkIndex: 0,
        chunk: new Uint8Array([1]),
      },
      conn,
    );

    const NativeFile = File;
    class ThrowingFile extends NativeFile {
      constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
        if (parts.length > 0) throw new DOMException('out of memory', 'QuotaExceededError');
        super(parts, name, options);
      }
    }
    vi.stubGlobal('File', ThrowingFile);
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );
    vi.stubGlobal('File', NativeFile);

    expect(sentStatuses(send).at(-1)).toMatchObject({
      status: 'rejected',
      code: 'upload-failed',
    });

    await handleData(
      startMessage(1, {
        requestId: '30000000-0000-4000-8000-000000000003',
        sessionId: '40000000-0000-4000-8000-000000000003',
      }),
      conn,
    );
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'ready' });
  });

  it('rejects a full queue before accepting any file bytes', async () => {
    const { conn, send } = makeConnection('admin-queue-full');
    enterHost([{ conn }]);
    setState(
      'playlist.items',
      Array.from({ length: 1000 }, () => ({}) as never),
    );

    await handleData(startMessage(1), conn);

    expect(sentStatuses(send).at(-1)).toMatchObject({
      status: 'rejected',
      loaded: 0,
      code: 'queue-full',
    });
  });

  it('does not exempt ordinary guests from the inbound chunk token bucket', async () => {
    const { conn, send } = makeConnection('ordinary-chunk-flood');
    enterHost([{ conn, isOp: false }]);
    resetInboundRateLimit(conn.peer);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    for (let index = 0; index < 60; index++) {
      await handleData(
        {
          type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          chunkIndex: index,
          chunk: new Uint8Array([1]),
        },
        conn,
      );
    }
    await handleData(startMessage(1), conn);

    expect(send).not.toHaveBeenCalled();
    now.mockRestore();
    resetInboundRateLimit(conn.peer);
  });

  it('exempts only chunks for the exact active authorized upload session', async () => {
    const { conn, send } = makeConnection('authorized-chunk-stream');
    enterHost([{ conn }]);
    resetInboundRateLimit(conn.peer);
    const received = vi.fn((_file: File, acknowledge: (accepted: boolean) => void) => {
      acknowledge(true);
    });
    const off = bus.on('standard-room:operator-file-received', received);
    const chunk = new Uint8Array(CHUNK_SIZE);
    const chunkCount = 61;

    await handleData(startMessage(CHUNK_SIZE * chunkCount), conn);
    for (let index = 0; index < chunkCount; index++) {
      await handleData(
        {
          type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          chunkIndex: index,
          chunk,
        },
        conn,
      );
    }
    await handleData(
      { type: MSG.OPERATOR_FILE_UPLOAD_FINISH, requestId: REQUEST_ID, sessionId: SESSION_ID },
      conn,
    );

    expect(received).toHaveBeenCalledTimes(1);
    expect(sentStatuses(send).at(-1)).toMatchObject({ status: 'complete' });
    off();
    resetInboundRateLimit(conn.peer);
  });
});

describe('standard operator file uplink sender', () => {
  it('reports sender-side validation failures instead of silently dropping the file', async () => {
    const { conn, send } = makeConnection('host-invalid');
    enterOperatorGuest(conn);
    const oversized = new File([new Uint8Array([1])], 'too-large.flac', {
      type: 'audio/flac',
    });
    Object.defineProperty(oversized, 'size', { value: 200 * 1024 * 1024 + 1 });
    const progress: StandardOperatorFileUplinkProgress[] = [];
    const off = bus.on('standard-room:operator-file-uplink-progress', (value) => {
      if (value.direction === 'send') progress.push(value);
    });

    await uploadStandardOperatorFiles([oversized]);

    expect(send).not.toHaveBeenCalled();
    expect(progress.at(-1)).toMatchObject({
      phase: 'error',
      fileName: 'too-large.flac',
      loaded: 0,
      total: 200 * 1024 * 1024 + 1,
      code: 'file-too-large',
    });
    off();
  });

  it('queues a multi-file selection strictly one at a time and reports progress', async () => {
    const messages: Record<string, unknown>[] = [];
    const inboundDeliveries: Promise<void>[] = [];
    const { conn } = makeConnection('host-1', (message) => {
      messages.push(message);
      if (message.type === MSG.OPERATOR_FILE_UPLOAD_START) {
        queueInboundData(
          {
            type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
            requestId: message.requestId,
            sessionId: message.sessionId,
            status: 'ready',
            loaded: 0,
            total: message.size,
            code: null,
          },
          conn,
          inboundDeliveries,
        );
      }
      if (message.type === MSG.OPERATOR_FILE_UPLOAD_FINISH) {
        const start = messages.find(
          (candidate) =>
            candidate.type === MSG.OPERATOR_FILE_UPLOAD_START &&
            candidate.sessionId === message.sessionId,
        );
        queueInboundData(
          {
            type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
            requestId: message.requestId,
            sessionId: message.sessionId,
            status: 'complete',
            loaded: start?.size,
            total: start?.size,
            code: null,
          },
          conn,
          inboundDeliveries,
        );
      }
    });
    enterOperatorGuest(conn);
    const progress: StandardOperatorFileUplinkProgress[] = [];
    const off = bus.on('standard-room:operator-file-uplink-progress', (value) => {
      if (value.direction === 'send') progress.push(value);
    });

    await uploadStandardOperatorFiles([
      new File([new Uint8Array([1, 2])], 'one.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array([3, 4, 5])], 'two.flac', { type: 'audio/flac' }),
    ]);
    await Promise.all(inboundDeliveries);

    expect(messages[0]).toMatchObject({
      type: MSG.OPERATOR_FILE_UPLOAD_BATCH_START,
      fileCount: 2,
    });
    expect(messages.at(-1)).toMatchObject({
      type: MSG.OPERATOR_FILE_UPLOAD_BATCH_COMPLETE,
      committedCount: 2,
    });

    const wirePhases = messages
      .filter((message) =>
        [
          MSG.OPERATOR_FILE_UPLOAD_START,
          MSG.OPERATOR_FILE_UPLOAD_CHUNK,
          MSG.OPERATOR_FILE_UPLOAD_FINISH,
        ].includes(message.type as never),
      )
      .map((message) => message.type);
    expect(wirePhases).toEqual([
      MSG.OPERATOR_FILE_UPLOAD_START,
      MSG.OPERATOR_FILE_UPLOAD_CHUNK,
      MSG.OPERATOR_FILE_UPLOAD_FINISH,
      MSG.OPERATOR_FILE_UPLOAD_START,
      MSG.OPERATOR_FILE_UPLOAD_CHUNK,
      MSG.OPERATOR_FILE_UPLOAD_FINISH,
    ]);
    expect(
      new Set(
        messages.filter((m) => m.type === MSG.OPERATOR_FILE_UPLOAD_START).map((m) => m.requestId),
      ),
    ).toHaveLength(1);
    expect(
      new Set(
        messages.filter((m) => m.type === MSG.OPERATOR_FILE_UPLOAD_START).map((m) => m.sessionId),
      ).size,
    ).toBe(2);
    expect(progress.filter((value) => value.phase === 'complete')).toHaveLength(2);
    off();
  });

  it('discards not-yet-started files when operator authority is revoked', async () => {
    const messages: Record<string, unknown>[] = [];
    const { conn } = makeConnection('host-2', (message) => messages.push(message));
    enterOperatorGuest(conn);

    const promise = uploadStandardOperatorFiles([
      new File([new Uint8Array([1])], 'one.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array([2])], 'two.mp3', { type: 'audio/mpeg' }),
    ]);
    await Promise.resolve();
    setState('network.isOperator', false);
    await promise;

    expect(
      messages.filter((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_START),
    ).toHaveLength(1);
    expect(messages.some((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_ABORT)).toBe(true);
  });

  it('settles safely when revoke arrives after acceptance during backpressure', async () => {
    const messages: Record<string, unknown>[] = [];
    const inboundDeliveries: Promise<void>[] = [];
    const { conn } = makeConnection('host-3', (message) => {
      messages.push(message);
      if (message.type !== MSG.OPERATOR_FILE_UPLOAD_START) return;
      queueInboundData(
        {
          type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
          requestId: message.requestId,
          sessionId: message.sessionId,
          status: 'ready',
          loaded: 0,
          total: message.size,
          code: null,
        },
        conn,
        inboundDeliveries,
      );
    });
    Object.assign(conn, {
      dataChannel: {
        readyState: 'open',
        bufferedAmount: 5 * 1024 * 1024,
      } as RTCDataChannel,
    });
    enterOperatorGuest(conn);

    const promise = uploadStandardOperatorFiles([
      new File([new Uint8Array([1, 2, 3])], 'accepted.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array([4])], 'queued.mp3', { type: 'audio/mpeg' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    setState('network.isOperator', false);
    await expect(promise).resolves.toBeUndefined();
    await Promise.all(inboundDeliveries);

    expect(
      messages.filter((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_START),
    ).toHaveLength(1);
    expect(messages.some((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_ABORT)).toBe(true);
  });

  it('retries FINISH once and accepts replayed COMPLETE after the first ACK is lost', async () => {
    vi.useFakeTimers();
    const messages: Record<string, unknown>[] = [];
    const inboundDeliveries: Promise<void>[] = [];
    let finishCount = 0;
    const { conn } = makeConnection('host-complete-replay', (message) => {
      messages.push(message);
      if (message.type === MSG.OPERATOR_FILE_UPLOAD_START) {
        queueInboundData(
          {
            type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
            requestId: message.requestId,
            sessionId: message.sessionId,
            status: 'ready',
            loaded: 0,
            total: message.size,
            code: null,
          },
          conn,
          inboundDeliveries,
        );
      }
      if (message.type === MSG.OPERATOR_FILE_UPLOAD_FINISH) {
        finishCount += 1;
        if (finishCount === 2) {
          queueInboundData(
            {
              type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
              requestId: message.requestId,
              sessionId: message.sessionId,
              status: 'complete',
              loaded: 1,
              total: 1,
              code: null,
            },
            conn,
            inboundDeliveries,
          );
        }
      }
    });
    enterOperatorGuest(conn);

    const promise = uploadStandardOperatorFiles([
      new File([new Uint8Array([1])], 'retry.mp3', { type: 'audio/mpeg' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(finishCount).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    await Promise.all(inboundDeliveries);

    expect(finishCount).toBe(2);
    expect(
      messages.filter((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_START),
    ).toHaveLength(1);
  });

  it('stops the remaining batch immediately when the host is busy', async () => {
    const messages: Record<string, unknown>[] = [];
    const inboundDeliveries: Promise<void>[] = [];
    const { conn } = makeConnection('host-busy-batch', (message) => {
      messages.push(message);
      if (message.type !== MSG.OPERATOR_FILE_UPLOAD_START) return;
      queueInboundData(
        {
          type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
          requestId: message.requestId,
          sessionId: message.sessionId,
          status: 'rejected',
          loaded: 0,
          total: message.size,
          code: 'host-busy',
        },
        conn,
        inboundDeliveries,
      );
    });
    enterOperatorGuest(conn);

    await uploadStandardOperatorFiles([
      new File([new Uint8Array([1])], 'one.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array([2])], 'two.mp3', { type: 'audio/mpeg' }),
    ]);
    await Promise.all(inboundDeliveries);

    expect(
      messages.filter((message) => message.type === MSG.OPERATOR_FILE_UPLOAD_START),
    ).toHaveLength(1);
  });
});
