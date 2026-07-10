/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, CHUNK_SIZE } from '../../core/constants.ts';
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

beforeEach(() => {
  resetState();
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedIndexes: new Set<number>(),
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
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: 1 };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(true);
  });

  it('validates required fields — fails when a required field is missing', () => {
    const msg = { type: 'FILE_CHUNK', index: 5 };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is null', () => {
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: null };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is undefined', () => {
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: undefined };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
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
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when peer is found but isOp is false', () => {
    const conn = makeConnection('peer-456');
    const peers = getState('network.connectedPeers');
    peers.push(makeConnectedPeer('peer-456', false));
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns true when peer is found and isOp is true', () => {
    const conn = makeConnection('peer-789');
    const peers = getState('network.connectedPeers');
    peers.push(makeConnectedPeer('peer-789', true));
    expect(verifyOperator(conn)).toBe(true);
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
  // Every field is optional on the wire because production senders differ:
  // recovery.ts sends {nextChunk, fileName, index, sessionId}; the FILE_WAIT
  // timeout (transfer-receive.ts), playback-stall (playback.ts) and
  // preload-decode (preload.ts) paths send {nextChunk: 0, fileName, index}
  // without sessionId. All four shapes must remain valid.
  it('dispatches all four production sender shapes', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_DATA_RECOVERY, handler);
    const conn = makeConnection('peer-recovery-valid');

    const validMessages = [
      { nextChunk: 42, fileName: 'song.mp3', index: 0, sessionId: 7 },
      { nextChunk: 0, fileName: 'song.mp3', index: 2 },
      { nextChunk: 0, fileName: '', index: 0 },
      // recovery.ts freshIndex falls back to playlist.currentTrackIndex,
      // which is legitimately -1 before the first track — must NOT be dropped.
      { nextChunk: 0, fileName: 'song.mp3', index: -1, sessionId: 0 },
      {},
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
      { nextChunk: -1 },
      { nextChunk: 2.5 },
      { nextChunk: Infinity },
      { nextChunk: 'NaN' },
      { nextChunk: 0, sessionId: Infinity }, // non-finite session poison
      { nextChunk: 0, fileName: 42 },
      { nextChunk: 0, name: { evil: true } }, // handler falls back to data.name
      { nextChunk: 0, index: NaN }, // non-finite index poison
    ];

    for (const message of invalidMessages) {
      await handleData({ type: MSG.REQUEST_DATA_RECOVERY, ...message }, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('file-transfer frame validation', () => {
  it('dispatches host-shaped FILE_START and FILE_CHUNK frames', async () => {
    const startHandler = vi.fn();
    const chunkHandler = vi.fn();
    registerHandler(MSG.FILE_START, startHandler);
    registerHandler(MSG.FILE_CHUNK, chunkHandler);
    const conn = makeConnection('peer-file-valid');

    // total at the documented 200k cap and a chunk at exactly CHUNK_SIZE are
    // the host's own legitimate maxima — the caps must not reject them.
    await handleData({ type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: 1200 }, conn);
    await handleData(
      { type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: 200_000 },
      conn,
    );
    await handleData(
      { type: MSG.FILE_CHUNK, chunk: new Uint8Array(CHUNK_SIZE), index: 0, sessionId: 3 },
      conn,
    );
    await handleData(
      { type: MSG.FILE_CHUNK, chunk: new ArrayBuffer(16), index: 7, sessionId: 3 },
      conn,
    );

    expect(startHandler).toHaveBeenCalledTimes(2);
    expect(chunkHandler).toHaveBeenCalledTimes(2);
  });

  it('drops oversized, non-finite, or mistyped file frames before dispatch', async () => {
    const startHandler = vi.fn();
    const chunkHandler = vi.fn();
    registerHandler(MSG.FILE_START, startHandler);
    registerHandler(MSG.FILE_CHUNK, chunkHandler);
    const conn = makeConnection('peer-file-hostile');

    const hostileFrames = [
      // The sender never emits chunks larger than CHUNK_SIZE.
      { type: MSG.FILE_CHUNK, chunk: new Uint8Array(CHUNK_SIZE + 1), index: 0, sessionId: 3 },
      { type: MSG.FILE_CHUNK, chunk: 'AAAA', index: 0, sessionId: 3 },
      { type: MSG.FILE_CHUNK, chunk: new Uint8Array(8), index: -1, sessionId: 3 },
      { type: MSG.FILE_CHUNK, chunk: new Uint8Array(8), index: 2.5, sessionId: 3 },
      // Non-finite session IDs poison receiver session state.
      { type: MSG.FILE_CHUNK, chunk: new Uint8Array(8), index: 0, sessionId: Infinity },
      { type: MSG.FILE_START, name: 'song.mp3', sessionId: Infinity, total: 10 },
      // Oversized totals can force an excessive receiver reorder budget.
      { type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: 200_001 },
      { type: MSG.FILE_START, name: 'song.mp3', sessionId: 3, total: -1 },
      { type: MSG.FILE_START, sessionId: 3, total: 10 },
    ];

    for (const frame of hostileFrames) {
      await handleData(frame, conn);
    }

    expect(startHandler).not.toHaveBeenCalled();
    expect(chunkHandler).not.toHaveBeenCalled();
  });

  it('drops PRELOAD_START frames with a non-finite or missing sessionId, but dispatches a finite one (F-2408)', async () => {
    const startHandler = vi.fn();
    registerHandler(MSG.PRELOAD_START, startHandler);
    const conn = makeConnection('peer-preload-hostile');

    // PRELOAD_START keys per-session reorder state and therefore requires a
    // finite ID. PRELOAD_CHUNK remains optional-ID because its sink validates it.
    await handleData(
      { type: MSG.PRELOAD_START, name: 'song.mp3', sessionId: Infinity, total: 10 },
      conn,
    );
    await handleData({ type: MSG.PRELOAD_START, name: 'song.mp3', total: 10 }, conn);
    expect(startHandler).not.toHaveBeenCalled();

    await handleData({ type: MSG.PRELOAD_START, name: 'song.mp3', sessionId: 4, total: 10 }, conn);
    expect(startHandler).toHaveBeenCalledTimes(1);
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
    await handleData({ type: MSG.PRELOAD_CHUNK, chunk: new Uint8Array(16), index: 0 }, conn);
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
