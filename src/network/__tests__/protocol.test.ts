/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  MSG,
  CHUNK_SIZE,
  REMOTE_SHARE_AES_GCM_TAG_BYTES,
  REMOTE_SHARE_MAX_BYTES,
} from '../../core/constants.ts';
import {
  validateMessage,
  registerHandlers,
  registerHandler,
  hasHandler,
  verifyOperator,
  handleData,
  initProtocol,
} from '../protocol.ts';
import type { ConnectedPeer, DataConnection, MsgType } from '../../types/index.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  resetState();
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(
  id: string,
  isOp: boolean,
  conn: DataConnection | null = null,
): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn,
    isOp,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

describe('validateMessage', () => {
  it('returns true for a valid object with a type property', () => {
    expect(validateMessage({ type: 'PLAY' })).toBe(true);
  });

  it('returns true for object with type and extra fields', () => {
    expect(validateMessage({ type: 'VOLUME', value: 80 })).toBe(true);
  });

  it('returns false for null', () => {
    expect(validateMessage(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(validateMessage(undefined)).toBe(false);
  });

  it('returns false for an empty object (no type field)', () => {
    expect(validateMessage({})).toBe(false);
  });

  it('returns false for a non-object (string)', () => {
    expect(validateMessage('hello')).toBe(false);
  });

  it('returns false for a non-object (number)', () => {
    expect(validateMessage(42)).toBe(false);
  });

  it('returns false for a non-object (boolean)', () => {
    expect(validateMessage(true)).toBe(false);
  });

  it('returns false when type field is missing', () => {
    expect(validateMessage({ name: 'test', value: 123 })).toBe(false);
  });

  it('returns false when type field is empty string (falsy)', () => {
    expect(validateMessage({ type: '' })).toBe(false);
  });

  it('returns false when type field is 0 (falsy)', () => {
    expect(validateMessage({ type: 0 })).toBe(false);
  });

  it('validates required fields — passes when all present', () => {
    const msg = { type: 'FILE_CHUNK', chunkIndex: 5, sessionId: 1 };
    expect(validateMessage(msg, ['chunkIndex', 'sessionId'])).toBe(true);
  });

  it('validates required fields — fails when a required field is missing', () => {
    const msg = { type: 'FILE_CHUNK', chunkIndex: 5 };
    expect(validateMessage(msg, ['chunkIndex', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is null', () => {
    const msg = { type: 'FILE_CHUNK', chunkIndex: 5, sessionId: null };
    expect(validateMessage(msg, ['chunkIndex', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is undefined', () => {
    const msg = { type: 'FILE_CHUNK', chunkIndex: 5, sessionId: undefined };
    expect(validateMessage(msg, ['chunkIndex', 'sessionId'])).toBe(false);
  });
});

describe('registerHandlers', () => {
  it('registers handlers without throwing', () => {
    expect(() => {
      registerHandlers({
        [MSG.PLAY]: () => {},
        [MSG.PAUSE]: () => {},
      });
    }).not.toThrow();
  });

  it('registers a single handler via registerHandler', () => {
    expect(() => {
      registerHandler(MSG.PLAY, () => {});
    }).not.toThrow();
  });

  it('hasHandler returns true after registration', () => {
    const uniqueType = ('test-has-handler-' + Date.now()) as MsgType;
    registerHandler(uniqueType, () => {});
    expect(hasHandler(uniqueType)).toBe(true);
  });

  it('hasHandler returns false for unregistered type', () => {
    expect(hasHandler('never-registered-type-xyz' as MsgType)).toBe(false);
  });
});

describe('verifyOperator', () => {
  it('returns false when connection is null', () => {
    expect(verifyOperator(null as unknown as DataConnection)).toBe(false);
  });

  it('returns false when connection is undefined', () => {
    expect(verifyOperator(undefined as unknown as DataConnection)).toBe(false);
  });

  it('returns false when conn.peer is empty', () => {
    const conn = makeConnection('');
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when no operator in connectedPeers', () => {
    const conn = makeConnection('peer-123');
    setState('network.activeHostConnByPeerId', new Map([['peer-123', conn]]));
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when peer is found but isOp is false', () => {
    const conn = makeConnection('peer-456');
    setState('network.activeHostConnByPeerId', new Map([['peer-456', conn]]));
    setState('network.connectedPeers', [makeConnectedPeer('peer-456', false, conn)]);
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns true when peer is found and isOp is true', () => {
    const conn = makeConnection('peer-789');
    setState('network.activeHostConnByPeerId', new Map([['peer-789', conn]]));
    setState('network.connectedPeers', [makeConnectedPeer('peer-789', true, conn)]);
    expect(verifyOperator(conn)).toBe(true);
  });

  it('does not inherit operator status from a replacement connection with the same peer id', () => {
    const stale = makeConnection('peer-op');
    const active = makeConnection('peer-op');
    setState('network.activeHostConnByPeerId', new Map([['peer-op', active]]));
    setState('network.connectedPeers', [makeConnectedPeer('peer-op', true, active)]);

    expect(verifyOperator(stale)).toBe(false);
    expect(verifyOperator(active)).toBe(true);
  });

  it('uses server-issued playback capability for a PRO room peer', () => {
    const conn = makeConnection('pro-controller');
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [
      {
        ...makeConnectedPeer(conn.peer, false, conn),
        roomCapabilities: ['playback.control'],
      },
    ]);

    expect(verifyOperator(conn)).toBe(true);
    setState('network.connectedPeers', [makeConnectedPeer(conn.peer, true, conn)]);
    expect(verifyOperator(conn)).toBe(false);
  });
});

describe('PRO member kick request validation', () => {
  it('accepts only one bounded opaque target identifier', async () => {
    const handler = vi.fn();
    const conn = makeConnection('pro-controller-1');
    registerHandler(MSG.REQUEST_KICK_DEVICE, handler);

    await handleData({ type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'pro-member_00000001' }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: MSG.REQUEST_KICK_DEVICE },
    { type: MSG.REQUEST_KICK_DEVICE, targetPeerId: '' },
    { type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'member with spaces' },
    { type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'x'.repeat(97) },
    { type: MSG.REQUEST_KICK_DEVICE, targetPeerId: 'member-2', targetConn: {} },
  ])('drops malformed or extended member-management frames: %o', async (message) => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_KICK_DEVICE, handler);

    await handleData(message, makeConnection('pro-controller-1'));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('YOUTUBE_PLAYLIST_INFO validation', () => {
  it('allows large playlist IDs while titles are still lazy-filling', async () => {
    const handler = vi.fn();
    registerHandler(MSG.YOUTUBE_PLAYLIST_INFO, handler);
    const conn = makeConnection('host-youtube-playlist-info');
    const ids = Array.from({ length: 201 }, (_, i) => `v${String(i).padStart(10, '0')}`);

    await handleData(
      {
        type: MSG.YOUTUBE_PLAYLIST_INFO,
        playlistId: 'PL1234567890',
        ids,
        titles: ['Known title'],
      },
      conn,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops playlist info when titles outgrow the matching ID list', async () => {
    const handler = vi.fn();
    registerHandler(MSG.YOUTUBE_PLAYLIST_INFO, handler);
    const conn = makeConnection('host-youtube-playlist-info-invalid');

    await handleData(
      {
        type: MSG.YOUTUBE_PLAYLIST_INFO,
        playlistId: 'PL1234567890',
        ids: ['v0000000000'],
        titles: ['Known title', 'Stale extra title'],
      },
      conn,
    );

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('REQUEST_DATA_RECOVERY validation', () => {
  // Stable queue identity and the transport offset are mandatory. sessionId
  // remains optional only for the initial recovery request.
  it('dispatches strict recovery requests with and without sessionId', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_DATA_RECOVERY, handler);
    const conn = makeConnection('peer-recovery-valid');

    const validMessages = [
      {
        requestId: 1,
        nextChunk: 42,
        fileName: 'song.mp3',
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 7,
      },
      { requestId: 2, nextChunk: 0, fileName: 'other.mp3', queueItemId: OTHER_QUEUE_ITEM_ID },
    ];

    for (const message of validMessages) {
      await handleData({ type: MSG.REQUEST_DATA_RECOVERY, ...message }, conn);
    }

    expect(handler).toHaveBeenCalledTimes(validMessages.length);
  });

  it('drops malformed asks before they reach the host handler', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_DATA_RECOVERY, handler);
    const conn = makeConnection('peer-recovery-invalid');

    const invalidMessages = [
      { nextChunk: -1, fileName: 'song.mp3', queueItemId: QUEUE_ITEM_ID },
      { nextChunk: 2.5, fileName: 'song.mp3', queueItemId: QUEUE_ITEM_ID },
      { nextChunk: Infinity, fileName: 'song.mp3', queueItemId: QUEUE_ITEM_ID },
      { nextChunk: 'NaN', fileName: 'song.mp3', queueItemId: QUEUE_ITEM_ID },
      {
        nextChunk: 0,
        fileName: 'song.mp3',
        queueItemId: QUEUE_ITEM_ID,
        sessionId: Infinity,
      },
      { nextChunk: 0, fileName: 42, queueItemId: QUEUE_ITEM_ID },
      { nextChunk: 0, fileName: '', queueItemId: QUEUE_ITEM_ID },
      { nextChunk: 0, fileName: 'song.mp3' },
      { nextChunk: 0, fileName: 'song.mp3', queueItemId: 'legacy-index-2' },
      { fileName: 'song.mp3', queueItemId: QUEUE_ITEM_ID },
    ];

    for (const message of invalidMessages) {
      await handleData({ type: MSG.REQUEST_DATA_RECOVERY, requestId: 1, ...message }, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('track-scoped playback request validation', () => {
  it('dispatches control requests only with a strict queueItemId', async () => {
    const conn = makeConnection('peer-playback-requests');
    const validFrames = [
      { type: MSG.REQUEST_PLAY, queueItemId: QUEUE_ITEM_ID, time: 12 },
      { type: MSG.REQUEST_PAUSE, queueItemId: QUEUE_ITEM_ID },
      { type: MSG.REQUEST_SEEK, queueItemId: QUEUE_ITEM_ID, time: 24 },
      { type: MSG.REQUEST_SKIP_TIME, queueItemId: QUEUE_ITEM_ID, sec: -10 },
    ];
    const handlers = new Map(validFrames.map((frame) => [frame.type, vi.fn()]));
    for (const [type, handler] of handlers) registerHandler(type, handler);

    for (const frame of validFrames) await handleData(frame, conn);

    for (const handler of handlers.values()) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, positional, or malformed queue identity', async () => {
    const conn = makeConnection('peer-playback-requests-invalid');
    const types = [
      MSG.REQUEST_PLAY,
      MSG.REQUEST_PAUSE,
      MSG.REQUEST_SEEK,
      MSG.REQUEST_SKIP_TIME,
    ] as const;
    const handlers = new Map(types.map((type) => [type, vi.fn()]));
    for (const [type, handler] of handlers) registerHandler(type, handler);

    const invalidFrames = [
      { type: MSG.REQUEST_PLAY, time: 12 },
      { type: MSG.REQUEST_PAUSE, queueItemId: 0 },
      { type: MSG.REQUEST_SEEK, queueItemId: 'legacy-index-0', time: 24 },
      { type: MSG.REQUEST_SKIP_TIME, queueItemId: null, sec: -10 },
    ];
    for (const frame of invalidFrames) await handleData(frame, conn);

    for (const handler of handlers.values()) expect(handler).not.toHaveBeenCalled();
  });
});

describe('file-transfer frame validation', () => {
  it('enforces the exact 200 MiB whole-file AES-GCM descriptor contract', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REMOTE_FILE_SHARE, handler);
    const conn = makeConnection('peer-remote-descriptor');
    const valid = {
      type: MSG.REMOTE_FILE_SHARE,
      roomId: '123456',
      objectId: '00000000-0000-4000-8000-000000000001',
      downloadUrl:
        'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
      keyB64: 'a2V5',
      ivB64: 'aXY=',
      name: 'track.wav',
      mime: 'audio/wav',
      size: REMOTE_SHARE_MAX_BYTES,
      encryptedSize: REMOTE_SHARE_MAX_BYTES + REMOTE_SHARE_AES_GCM_TAG_BYTES,
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 1,
      expiresAt: Date.now() + 60_000,
    };

    await handleData(valid, conn);
    expect(handler).toHaveBeenCalledOnce();

    for (const invalid of [
      { ...valid, size: 0, encryptedSize: REMOTE_SHARE_AES_GCM_TAG_BYTES },
      {
        ...valid,
        size: REMOTE_SHARE_MAX_BYTES + 1,
        encryptedSize: REMOTE_SHARE_MAX_BYTES + 1 + REMOTE_SHARE_AES_GCM_TAG_BYTES,
      },
      { ...valid, encryptedSize: valid.encryptedSize - 1 },
      { ...valid, preload: true },
      { ...valid, sessionId: 0 },
      { ...valid, sessionId: -1 },
      { ...valid, sessionId: 1.5 },
      { ...valid, sessionId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await handleData(invalid, conn);
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it('dispatches host-shaped FILE_START and FILE_CHUNK frames', async () => {
    const startHandler = vi.fn();
    const chunkHandler = vi.fn();
    registerHandler(MSG.FILE_START, startHandler);
    registerHandler(MSG.FILE_CHUNK, chunkHandler);
    const conn = makeConnection('peer-file-valid');

    // total at the documented 200k cap and a chunk at exactly CHUNK_SIZE are
    // the host's own legitimate maxima — the caps must not reject them.
    await handleData(
      {
        type: MSG.FILE_START,
        name: 'song.mp3',
        sessionId: 3,
        total: 1200,
        size: 1199 * CHUNK_SIZE + 1,
        queueItemId: QUEUE_ITEM_ID,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.FILE_START,
        name: 'song.mp3',
        sessionId: 3,
        total: 200_000,
        size: 199_999 * CHUNK_SIZE + 1,
        queueItemId: QUEUE_ITEM_ID,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.FILE_CHUNK,
        chunk: new Uint8Array(CHUNK_SIZE),
        chunkIndex: 0,
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 3,
        name: 'song.mp3',
        total: 1,
        size: CHUNK_SIZE,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.FILE_CHUNK,
        chunk: new ArrayBuffer(16),
        chunkIndex: 7,
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 3,
        name: 'song.mp3',
        total: 8,
        size: 7 * CHUNK_SIZE + 16,
      },
      conn,
    );

    expect(startHandler).toHaveBeenCalledTimes(2);
    expect(chunkHandler).toHaveBeenCalledTimes(2);
  });

  it('requires a strict queueItemId on FILE_START and FILE_RESUME', async () => {
    const startHandler = vi.fn();
    const resumeHandler = vi.fn();
    registerHandler(MSG.FILE_START, startHandler);
    registerHandler(MSG.FILE_RESUME, resumeHandler);
    const conn = makeConnection('peer-file-identity');

    for (const queueItemId of [QUEUE_ITEM_ID, OTHER_QUEUE_ITEM_ID]) {
      await handleData(
        { type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: 1, size: 1, queueItemId },
        conn,
      );
      await handleData(
        {
          type: MSG.FILE_RESUME,
          name: 'song.mp3',
          sessionId: 3,
          startChunk: 0,
          total: 1,
          size: 1,
          queueItemId,
        },
        conn,
      );
    }

    expect(startHandler).toHaveBeenCalledTimes(2);
    expect(resumeHandler).toHaveBeenCalledTimes(2);

    for (const queueItemId of [undefined, null, '', 'legacy-index-0', 0]) {
      await handleData(
        { type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: 1, size: 1, queueItemId },
        conn,
      );
      await handleData(
        {
          type: MSG.FILE_RESUME,
          name: 'song.mp3',
          sessionId: 3,
          startChunk: 0,
          total: 1,
          size: 1,
          queueItemId,
        },
        conn,
      );
    }

    expect(startHandler).toHaveBeenCalledTimes(2);
    expect(resumeHandler).toHaveBeenCalledTimes(2);
  });

  it('drops oversized, non-finite, or mistyped file frames before dispatch', async () => {
    const startHandler = vi.fn();
    const chunkHandler = vi.fn();
    registerHandler(MSG.FILE_START, startHandler);
    registerHandler(MSG.FILE_CHUNK, chunkHandler);
    const conn = makeConnection('peer-file-hostile');

    const validChunk = {
      type: MSG.FILE_CHUNK,
      chunk: new Uint8Array(8),
      chunkIndex: 0,
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 3,
      name: 'song.mp3',
      total: 1,
      size: 8,
    };
    const validStart = {
      type: MSG.FILE_START,
      name: 'song.mp3',
      sessionId: 3,
      total: 1,
      size: 1,
      queueItemId: QUEUE_ITEM_ID,
    };
    const hostileFrames = [
      // The sender never emits chunks larger than CHUNK_SIZE.
      {
        ...validChunk,
        chunk: new Uint8Array(CHUNK_SIZE + 1),
        total: 2,
        size: CHUNK_SIZE + 1,
      },
      { ...validChunk, chunk: 'AAAA' },
      { ...validChunk, chunkIndex: -1 },
      { ...validChunk, chunkIndex: 2.5 },
      // Non-finite session IDs poison receiver session state.
      { ...validChunk, sessionId: Infinity },
      { ...validStart, sessionId: Infinity },
      // Oversized totals can force an excessive receiver reorder budget.
      { ...validStart, total: 200_001, size: 200_000 * CHUNK_SIZE + 1 },
      { ...validStart, total: -1 },
      { ...validStart, name: undefined },
    ];

    for (const frame of hostileFrames) {
      await handleData(frame, conn);
    }

    expect(startHandler).not.toHaveBeenCalled();
    expect(chunkHandler).not.toHaveBeenCalled();
  });

  it('drops PRELOAD_START frames without a positive safe sessionId', async () => {
    const startHandler = vi.fn();
    registerHandler(MSG.PRELOAD_START, startHandler);
    const conn = makeConnection('peer-preload-hostile');

    // Every preload frame keys per-session state and requires the same strict ID.
    await handleData(
      {
        type: MSG.PRELOAD_START,
        name: 'song.mp3',
        queueItemId: QUEUE_ITEM_ID,
        sessionId: Infinity,
        total: 1,
        size: 1,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.PRELOAD_START,
        name: 'song.mp3',
        queueItemId: QUEUE_ITEM_ID,
        total: 1,
        size: 1,
      },
      conn,
    );
    expect(startHandler).not.toHaveBeenCalled();

    await handleData(
      {
        type: MSG.PRELOAD_START,
        name: 'song.mp3',
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 4,
        total: 1,
        size: 1,
      },
      conn,
    );
    expect(startHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects non-positive, fractional, and unsafe IDs on every local transfer frame', async () => {
    const types = [
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
      MSG.FILE_RESUME,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
      MSG.PRELOAD_ABORT,
      MSG.REMOTE_FILE_UNAVAILABLE,
    ] as const;
    const handlers = new Map(types.map((type) => [type, vi.fn()]));
    for (const [type, handler] of handlers) registerHandler(type, handler);
    const conn = makeConnection('peer-invalid-session-ids');

    for (const sessionId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const frames = [
        {
          type: MSG.FILE_START,
          name: 'x.mp3',
          sessionId,
          total: 1,
          size: 1,
          queueItemId: QUEUE_ITEM_ID,
        },
        {
          type: MSG.FILE_CHUNK,
          name: 'x.mp3',
          sessionId,
          total: 1,
          size: 1,
          chunkIndex: 0,
          queueItemId: QUEUE_ITEM_ID,
          chunk: new Uint8Array([1]),
        },
        {
          type: MSG.FILE_END,
          name: 'x.mp3',
          mime: 'audio/mpeg',
          queueItemId: QUEUE_ITEM_ID,
          sessionId,
        },
        {
          type: MSG.FILE_RESUME,
          name: 'x.mp3',
          sessionId,
          total: 1,
          size: 1,
          startChunk: 0,
          queueItemId: QUEUE_ITEM_ID,
        },
        {
          type: MSG.PRELOAD_START,
          name: 'x.mp3',
          sessionId,
          queueItemId: QUEUE_ITEM_ID,
          total: 1,
          size: 1,
        },
        {
          type: MSG.PRELOAD_CHUNK,
          sessionId,
          chunkIndex: 0,
          queueItemId: QUEUE_ITEM_ID,
          chunk: new Uint8Array([1]),
        },
        { type: MSG.PRELOAD_END, name: 'x.mp3', sessionId, queueItemId: QUEUE_ITEM_ID },
        { type: MSG.PRELOAD_ABORT, sessionId, queueItemId: QUEUE_ITEM_ID },
        {
          type: MSG.REMOTE_FILE_UNAVAILABLE,
          name: 'x.mp3',
          sessionId,
          queueItemId: QUEUE_ITEM_ID,
        },
      ];
      for (const frame of frames) await handleData(frame, conn);
    }

    for (const handler of handlers.values()) expect(handler).not.toHaveBeenCalled();
  });
});

describe('broadcast amplification caps', () => {
  it('caps YOUTUBE_SUB_TITLE_UPDATE subIdx and CHAT text length before dispatch', async () => {
    const titleHandler = vi.fn();
    const chatHandler = vi.fn();
    registerHandler(MSG.YOUTUBE_SUB_TITLE_UPDATE, titleHandler);
    registerHandler(MSG.CHAT, chatHandler);
    const conn = makeConnection('peer-amplification');

    await handleData(
      { type: MSG.YOUTUBE_SUB_TITLE_UPDATE, playlistId: 'PL1', subIdx: 4999, title: 'ok' },
      conn,
    );
    await handleData({ type: MSG.CHAT, text: 'a'.repeat(4000) }, conn);
    expect(titleHandler).toHaveBeenCalledTimes(1);
    expect(chatHandler).toHaveBeenCalledTimes(1);

    // Oversized sub-indexes can expand the receiver's sparse title array;
    // oversized chat frames amplify work across every connected peer.
    await handleData(
      { type: MSG.YOUTUBE_SUB_TITLE_UPDATE, playlistId: 'PL1', subIdx: 5000, title: 'ok' },
      conn,
    );
    await handleData(
      { type: MSG.YOUTUBE_SUB_TITLE_UPDATE, playlistId: 'PL1', subIdx: -1, title: 'ok' },
      conn,
    );
    await handleData({ type: MSG.CHAT, text: 'a'.repeat(4001) }, conn);
    await handleData({ type: MSG.CHAT, text: 42 }, conn);

    expect(titleHandler).toHaveBeenCalledTimes(1);
    expect(chatHandler).toHaveBeenCalledTimes(1);
  });
});

describe('inbound per-peer rate limit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops control frames past the 60-frame burst, refills one token per 50ms, and resets on disconnect', async () => {
    vi.useFakeTimers();
    // Disconnect events release the peer's bucket; bus.clear handles teardown.
    initProtocol();
    const control = vi.fn();
    const chunk = vi.fn();
    registerHandler('rate-limit-control-probe' as MsgType, control);
    registerHandler(MSG.PRELOAD_CHUNK, chunk);
    const conn = makeConnection('peer-flood');

    for (let i = 0; i < 61; i++) {
      await handleData({ type: 'rate-limit-control-probe' }, conn);
    }
    expect(control).toHaveBeenCalledTimes(60);

    // Chunk frames bypass the bucket — transfer-layer backpressure throttles
    // them, and dropping them here would stall legitimate transfers.
    await handleData(
      {
        type: MSG.PRELOAD_CHUNK,
        chunk: new Uint8Array(16),
        chunkIndex: 0,
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 1,
      },
      conn,
    );
    expect(chunk).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    await handleData({ type: 'rate-limit-control-probe' }, conn);
    await handleData({ type: 'rate-limit-control-probe' }, conn);
    expect(control).toHaveBeenCalledTimes(61);

    bus.emit('network:peer-disconnected', 'peer-flood');
    await handleData({ type: 'rate-limit-control-probe' }, conn);
    expect(control).toHaveBeenCalledTimes(62);
  });
});

describe('handler exception containment', () => {
  it('contains throwing and rejecting handlers so dispatch neither rejects nor stalls later messages', async () => {
    registerHandler('throwing-probe' as MsgType, () => {
      throw new Error('handler boom');
    });
    registerHandler('rejecting-probe' as MsgType, async () => {
      throw new Error('async handler boom');
    });
    const after = vi.fn();
    registerHandler('post-throw-probe' as MsgType, after);
    const conn = makeConnection('peer-throwing');

    await expect(handleData({ type: 'throwing-probe' }, conn)).resolves.toBeUndefined();
    await expect(handleData({ type: 'rejecting-probe' }, conn)).resolves.toBeUndefined();
    await handleData({ type: 'post-throw-probe' }, conn);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('REQUEST_SETTING validation', () => {
  it('dispatches known setting types with in-range typed values', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_SETTING, handler);
    const conn = makeConnection('peer-request-setting-valid');

    const validMessages = [
      { settingType: 'repeat-mode', value: 2 },
      { settingType: 'shuffle-mode', value: true },
      { settingType: 'eq', band: 4, value: -12 },
      { settingType: MSG.PREAMP, value: -48 },
      { settingType: MSG.STEREO_WIDTH, value: 200 },
      { settingType: MSG.VBASS, value: 100 },
      { settingType: MSG.REVERB, value: 100 },
      { settingType: MSG.REVERB_TYPE, value: 'arena' },
      { settingType: MSG.REVERB_DECAY, value: 10 },
      { settingType: MSG.REVERB_PREDELAY, value: 0.5 },
      { settingType: MSG.REVERB_LOWCUT, value: 100 },
      { settingType: MSG.REVERB_HIGHCUT, value: 100 },
    ];

    for (const message of validMessages) {
      await handleData({ type: MSG.REQUEST_SETTING, ...message }, conn);
    }

    expect(handler).toHaveBeenCalledTimes(validMessages.length);
  });

  it('drops unknown setting types and out-of-range values before dispatch', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_SETTING, handler);
    const conn = makeConnection('peer-request-setting-invalid');

    const invalidMessages = [
      { settingType: 'stereo', value: 120 },
      { settingType: 'eq', band: 5, value: 0 },
      { settingType: 'eq', band: 0, value: 13 },
      { settingType: MSG.STEREO_WIDTH, value: 201 },
      { settingType: MSG.REVERB_TYPE, value: 'advanced' },
      { settingType: MSG.REVERB_DECAY, value: 30 },
      { settingType: MSG.REVERB_PREDELAY, value: 1 },
      { settingType: MSG.REVERB_LOWCUT, value: -1 },
      { settingType: 'repeat-mode', value: 3 },
      { settingType: 'shuffle-mode', value: 'true' },
    ];

    for (const message of invalidMessages) {
      await handleData({ type: MSG.REQUEST_SETTING, ...message }, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });
});
