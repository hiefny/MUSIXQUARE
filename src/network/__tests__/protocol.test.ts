/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, CHUNK_SIZE, REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';
import {
  validateMessage,
  registerHandlers,
  registerHandler,
  hasHandler,
  verifyOperator,
  handleData,
  initProtocol,
  registerInboundRateLimitExemptionGuard,
} from '../protocol.ts';
import type { MsgType } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';
const ZERO_START_RUN_ID = 'mzero-7-a1b2c3';
const YOUTUBE_VIDEO_ID = 'a1B2c3D4e5F';

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

describe('BOT chat frame validation', () => {
  const requestId = `mxqr-pro-${'a'.repeat(48)}`;
  const conn = makeConnection('guest-bot-1');

  it('accepts ordinary chat with an optional API-safe BOT request id', async () => {
    const handler = vi.fn();
    registerHandler(MSG.CHAT, handler);

    await handleData({ type: MSG.CHAT, text: '/bot play jazz', botRequestId: requestId }, conn);
    await handleData({ type: MSG.CHAT, text: 'ordinary chat' }, conn);
    for (const botRequestId of ['', 'short', `mxqr-pro-${'!'.repeat(48)}`, 'a'.repeat(129)]) {
      await handleData({ type: MSG.CHAT, text: '/bot rejected', botRequestId }, conn);
    }

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('accepts only exact, bounded terminal BOT result unions', async () => {
    const handler = vi.fn();
    registerHandler(MSG.CHAT_BOT_RESULT, handler);
    const base = {
      type: MSG.CHAT_BOT_RESULT,
      requestId,
      senderId: 'guest-bot-1',
    };

    for (const result of [
      { kind: 'answer', text: 'Done' },
      { kind: 'added', count: 3, playbackChanged: true },
      { kind: 'failed' },
      { kind: 'rate_limited', retryAfterSeconds: 30 },
      { kind: 'rate_limited', retryAfterSeconds: 3_601 },
      { kind: 'rate_limited', retryAfterSeconds: 86_400 },
    ]) {
      await handleData({ ...base, result }, conn);
    }
    expect(handler).toHaveBeenCalledTimes(6);

    for (const invalid of [
      { ...base, result: { kind: 'answer', text: '' } },
      { ...base, result: { kind: 'answer', text: 'x'.repeat(501) } },
      { ...base, result: { kind: 'added', count: 4, playbackChanged: false } },
      { ...base, result: { kind: 'failed', text: 'smuggled' } },
      { ...base, result: { kind: 'rate_limited', retryAfterSeconds: 0 } },
      { ...base, result: { kind: 'rate_limited', retryAfterSeconds: 1.5 } },
      { ...base, result: { kind: 'rate_limited', retryAfterSeconds: 86_401 } },
      { ...base, senderId: '<spoof>', result: { kind: 'failed' } },
      { ...base, requestId: 'short', result: { kind: 'failed' } },
      { ...base, result: { kind: 'failed' }, extra: true },
    ]) {
      await handleData(invalid, conn);
    }
    expect(handler).toHaveBeenCalledTimes(6);
  });
});

describe('verifyOperator', () => {
  beforeEach(() => {
    setState('network.appRole', 'host');
  });

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

  it('accepts the distinct physical-device disconnect request', async () => {
    const handler = vi.fn();
    const conn = makeConnection('pro-controller-1');
    registerHandler(MSG.REQUEST_KICK_PHYSICAL_DEVICE, handler);

    await handleData(
      { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'pro-member_00000001' },
      conn,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE },
    { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: '' },
    { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'member with spaces' },
    { type: MSG.REQUEST_KICK_PHYSICAL_DEVICE, targetPeerId: 'member-2', extra: true },
  ])('drops malformed physical-device frames: %o', async (message) => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_KICK_PHYSICAL_DEVICE, handler);

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

describe('YouTube zero-start protocol validation', () => {
  const identity = {
    version: 1 as const,
    runId: ZERO_START_RUN_ID,
    sequence: 7,
    queueItemId: QUEUE_ITEM_ID,
  };

  it('dispatches every strict v1 zero-start frame', async () => {
    const handler = vi.fn();
    const conn = makeConnection('zero-start-valid');
    const frames = [
      {
        type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
        version: 1,
        platform: 'android',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
        version: 2,
        platform: 'ios',
        ready: true,
      },
      {
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        subIndex: null,
        prepareAtHost: 1_000.25,
        decisionAtHost: 3_300.25,
        startDeadlineAtHost: 4_000.25,
        hostPlatform: 'other',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_ARMED,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        preparedMs: 1_381.5,
        warmLatencyMs: 338.25,
        positionSec: 0.02,
        playerState: 2,
        audioUnlocked: true,
        muted: false,
        volume: 100,
        loadedFraction: 0.081,
        startLeadMs: 250,
        audibleBaseLeadMs: 250,
        timelineLeadMs: 0,
        platform: 'android',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_COMMIT,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        startAtHost: 4_000.25,
        reason: 'all-ready',
        cohort: ['host-peer', 'guest-peer'],
      },
      {
        type: MSG.YOUTUBE_ZERO_START_ABORT,
        ...identity,
        reason: 'superseded',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_TIMELINE,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        hostTime: 6_000.75,
        positionSec: 2.125,
        playerState: 1,
      },
    ];

    for (const frame of frames) {
      registerHandler(frame.type, handler);
      await handleData(frame, conn);
    }

    expect(handler).toHaveBeenCalledTimes(frames.length);
  });

  it('drops malformed or extended zero-start frames before dispatch', async () => {
    const handler = vi.fn();
    const conn = makeConnection('zero-start-invalid');
    const basePrepare = {
      type: MSG.YOUTUBE_ZERO_START_PREPARE,
      ...identity,
      videoId: YOUTUBE_VIDEO_ID,
      subIndex: 0,
      prepareAtHost: 1_000,
      decisionAtHost: 3_300,
      startDeadlineAtHost: 4_000,
      hostPlatform: 'other',
    };
    const baseArmed = {
      type: MSG.YOUTUBE_ZERO_START_ARMED,
      ...identity,
      videoId: YOUTUBE_VIDEO_ID,
      preparedMs: 1_200,
      warmLatencyMs: 300,
      positionSec: 0,
      playerState: 2,
      audioUnlocked: true,
      muted: false,
      volume: 100,
      loadedFraction: 0.1,
      startLeadMs: 250,
      audibleBaseLeadMs: 250,
      timelineLeadMs: 0,
      platform: 'android',
    };
    const baseCommit = {
      type: MSG.YOUTUBE_ZERO_START_COMMIT,
      ...identity,
      videoId: YOUTUBE_VIDEO_ID,
      startAtHost: 4_000,
      reason: 'all-ready',
      cohort: ['host-peer', 'guest-peer'],
    };
    const malformedFrames = [
      { type: MSG.YOUTUBE_ZERO_START_CAPABILITY, version: 2, platform: 'android' },
      {
        type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
        version: 2,
        platform: 'android',
        ready: 'yes',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
        version: 3,
        platform: 'android',
        ready: true,
      },
      { type: MSG.YOUTUBE_ZERO_START_CAPABILITY, version: 1, platform: 'windows' },
      { type: MSG.YOUTUBE_ZERO_START_CAPABILITY, version: 1, platform: 'ios', extra: true },
      {
        type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
        version: 2,
        platform: 'ios',
        ready: true,
        extra: true,
      },
      { ...basePrepare, runId: '../bad-run' },
      { ...basePrepare, sequence: 0 },
      { ...basePrepare, videoId: 'too-short' },
      { ...basePrepare, subIndex: 5000 },
      { ...basePrepare, decisionAtHost: 999 },
      { ...basePrepare, startDeadlineAtHost: 20_001 },
      { ...basePrepare, prepareAtHost: Number.POSITIVE_INFINITY },
      { ...basePrepare, hostPlatform: 'windows' },
      { ...basePrepare, unexpected: 'field' },
      { ...baseArmed, preparedMs: -1 },
      { ...baseArmed, playerState: 4 },
      { ...baseArmed, audioUnlocked: 'yes' },
      { ...baseArmed, volume: 101 },
      { ...baseArmed, loadedFraction: 1.01 },
      { ...baseArmed, startLeadMs: 601 },
      { ...baseArmed, timelineLeadMs: Number.NaN },
      { ...baseCommit, startAtHost: Number.NEGATIVE_INFINITY },
      { ...baseCommit, reason: 'ready' },
      { ...baseCommit, cohort: [] },
      { ...baseCommit, cohort: ['same-peer', 'same-peer'] },
      { ...baseCommit, cohort: ['peer with spaces'] },
      {
        type: MSG.YOUTUBE_ZERO_START_ABORT,
        ...identity,
        reason: 'unknown-reason',
      },
      {
        type: MSG.YOUTUBE_ZERO_START_TIMELINE,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        hostTime: 6_000,
        positionSec: -0.1,
        playerState: 1,
      },
      {
        type: MSG.YOUTUBE_ZERO_START_TIMELINE,
        ...identity,
        videoId: YOUTUBE_VIDEO_ID,
        hostTime: Number.NaN,
        positionSec: 2,
        playerState: 1,
      },
    ];

    for (const type of [
      MSG.YOUTUBE_ZERO_START_CAPABILITY,
      MSG.YOUTUBE_ZERO_START_PREPARE,
      MSG.YOUTUBE_ZERO_START_ARMED,
      MSG.YOUTUBE_ZERO_START_COMMIT,
      MSG.YOUTUBE_ZERO_START_ABORT,
      MSG.YOUTUBE_ZERO_START_TIMELINE,
    ]) {
      registerHandler(type, handler);
    }
    for (const frame of malformedFrames) await handleData(frame, conn);

    expect(handler).not.toHaveBeenCalled();
  });

  it('caps the release cohort at 100 unique bounded peer identifiers', async () => {
    const handler = vi.fn();
    const conn = makeConnection('zero-start-cohort-cap');
    registerHandler(MSG.YOUTUBE_ZERO_START_COMMIT, handler);
    const commit = {
      type: MSG.YOUTUBE_ZERO_START_COMMIT,
      ...identity,
      videoId: YOUTUBE_VIDEO_ID,
      startAtHost: 4_000,
      reason: 'guest-timeout',
    };

    await handleData(
      { ...commit, cohort: Array.from({ length: 100 }, (_, index) => `peer-${index}`) },
      conn,
    );
    await handleData(
      { ...commit, cohort: Array.from({ length: 101 }, (_, index) => `peer-${index}`) },
      conn,
    );

    expect(handler).toHaveBeenCalledTimes(1);
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

describe('system-audio SFU frame validation', () => {
  it('accepts only the explicit current LAN capability marker', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-system-audio-capability');
    registerHandler(MSG.SYSTEM_AUDIO_SFU_CAPABILITY, handler);

    await handleData(
      { type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY, version: 1, localAudience: true },
      conn,
    );
    for (const invalid of [
      { type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY, version: 2, localAudience: true },
      { type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY, version: 1, localAudience: false },
      { type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY, version: 1, localAudience: 'true' },
    ]) {
      await handleData(invalid, conn);
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown SFU audience marker', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-system-audio-ready');
    registerHandler(MSG.SYSTEM_AUDIO_SFU_READY, handler);
    const valid = {
      type: MSG.SYSTEM_AUDIO_SFU_READY,
      version: 1,
      sessionId: 'publication-session',
      tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
    };

    for (const audience of [undefined, 'remote', 'all']) {
      await handleData({ ...valid, audience }, conn);
    }
    for (const audience of ['local', 'everyone', true]) {
      await handleData({ ...valid, audience }, conn);
    }

    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe('PRO system-audio control-frame validation', () => {
  const publication = {
    publicationId: 'publication_00001',
    sessionId: 'realtime_session_01',
    tracks: [
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ],
  };
  const live = {
    type: MSG.PRO_SYSTEM_AUDIO_STATE,
    version: 1,
    generation: 7,
    status: 'live',
    ownerParticipantId: 'participant_00001',
    ownerDisplayName: 'Peer 1',
    claimExpiresAt: null,
    liveExpiresAt: 1_900_000_000_000,
    publication,
  };

  it('accepts only the exact versioned lifecycle shape', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-pro-system-audio-state');
    registerHandler(MSG.PRO_SYSTEM_AUDIO_STATE, handler);

    await handleData(live, conn);
    await handleData(
      {
        ...live,
        generation: 8,
        status: 'preparing',
        claimExpiresAt: 1_800_000_045_000,
        liveExpiresAt: null,
        publication: null,
      },
      conn,
    );
    await handleData(
      {
        ...live,
        generation: 9,
        status: 'idle',
        ownerParticipantId: null,
        ownerDisplayName: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      },
      conn,
    );

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('rejects private, unknown, ambiguous, and cross-layer-incompatible fields', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-pro-system-audio-invalid');
    registerHandler(MSG.PRO_SYSTEM_AUDIO_STATE, handler);

    const invalidFrames = [
      { ...live, version: 0 },
      { ...live, version: 2 },
      { ...live, leaseId: 'must-not-cross-peer-wire' },
      { ...live, ownerPresenceIncarnationId: 'must-not-cross-peer-wire' },
      { ...live, ownerParticipantId: 'short' },
      { ...live, ownerDisplayName: ' Peer 1 ' },
      { ...live, claimExpiresAt: 1_800_000_000_000 },
      { ...live, publication: { ...publication, sessionOwnerToken: 'private-token' } },
      {
        ...live,
        publication: {
          ...publication,
          tracks: [
            { ...publication.tracks[0], transceiver: 'private-object' },
            publication.tracks[1],
          ],
        },
      },
      {
        ...live,
        publication: {
          ...publication,
          tracks: [{ ...publication.tracks[0], trackName: ' audio-L ' }, publication.tracks[1]],
        },
      },
      {
        ...live,
        publication: {
          ...publication,
          tracks: [publication.tracks[0], { ...publication.tracks[1], mid: ' 1 ' }],
        },
      },
      {
        ...live,
        publication: {
          ...publication,
          tracks: [publication.tracks[0], { ...publication.tracks[1], channel: 'L' }],
        },
      },
    ];
    for (const frame of invalidFrames) await handleData(frame, conn);

    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps refresh hints minimal and rejects credential smuggling', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-pro-system-audio-hint');
    registerHandler(MSG.PRO_SYSTEM_AUDIO_HINT, handler);

    await handleData({ type: MSG.PRO_SYSTEM_AUDIO_HINT, generation: 0 }, conn);
    await handleData(
      { type: MSG.PRO_SYSTEM_AUDIO_HINT, generation: 1, leaseId: 'must-not-cross-peer-wire' },
      conn,
    );
    await handleData({ type: MSG.PRO_SYSTEM_AUDIO_HINT, generation: -1 }, conn);

    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('file-transfer frame validation', () => {
  it('accepts only exact PRO file preload ownership hints', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-pro-preload');
    registerHandler(MSG.PRO_FILE_PRELOAD, handler);

    await handleData(
      { type: MSG.PRO_FILE_PRELOAD, queueItemId: QUEUE_ITEM_ID, sessionId: 1 },
      conn,
    );

    for (const invalid of [
      { type: MSG.PRO_FILE_PRELOAD, queueItemId: QUEUE_ITEM_ID, sessionId: 0 },
      { type: MSG.PRO_FILE_PRELOAD, queueItemId: 'not-a-queue-id', sessionId: 1 },
      {
        type: MSG.PRO_FILE_PRELOAD,
        queueItemId: QUEUE_ITEM_ID,
        sessionId: 1,
        unexpected: true,
      },
    ]) {
      await handleData(invalid, conn);
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts only the explicit current local R2 capability marker', async () => {
    const handler = vi.fn();
    const conn = makeConnection('peer-file-r2-capability');
    registerHandler(MSG.FILE_R2_CAPABILITY, handler);

    await handleData({ type: MSG.FILE_R2_CAPABILITY, version: 1, localAudience: true }, conn);
    for (const invalid of [
      { type: MSG.FILE_R2_CAPABILITY, version: 2, localAudience: true },
      { type: MSG.FILE_R2_CAPABILITY, version: 1, localAudience: false },
      { type: MSG.FILE_R2_CAPABILITY, version: 1, localAudience: 'true' },
    ]) {
      await handleData(invalid, conn);
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts only the exact authenticated whole-object descriptor', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REMOTE_FILE_SHARE, handler);
    const conn = makeConnection('peer-whole-remote-descriptor');
    const valid = {
      type: MSG.REMOTE_FILE_SHARE,
      roomId: '123456',
      objectId: '00000000-0000-4000-8000-000000000001',
      downloadUrl:
        'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
      storageFormat: 'whole-v1',
      storedSize: REMOTE_SHARE_MAX_BYTES,
      downloadToken: `eyJ2IjoxLCJraW5kIjoid2hvbGUtZG93bmxvYWQifQ.${'a'.repeat(43)}`,
      name: 'track.wav',
      mime: 'audio/wav',
      size: REMOTE_SHARE_MAX_BYTES,
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 1,
      expiresAt: Date.now() + 60_000,
      delivery: 'r2',
    };

    await handleData(valid, conn);
    await handleData({ ...valid, preload: true }, conn);

    for (const invalid of [
      { ...valid, storedSize: valid.size - 1 },
      { ...valid, size: 0, storedSize: 0 },
      { ...valid, size: REMOTE_SHARE_MAX_BYTES + 1, storedSize: REMOTE_SHARE_MAX_BYTES + 1 },
      { ...valid, roomId: 'room' },
      { ...valid, downloadToken: 'not-a-signed-token' },
      { ...valid, storageFormat: 'unknown-format' },
      { ...valid, preload: false },
      { ...valid, sessionId: 0 },
      { ...valid, sessionId: -1 },
      { ...valid, sessionId: 1.5 },
      { ...valid, sessionId: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, unexpected: true },
    ]) {
      await handleData(invalid, conn);
    }

    expect(handler).toHaveBeenCalledTimes(2);
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
    await handleData(
      {
        type: MSG.CHAT,
        text: 'a'.repeat(4000),
        senderMemberId: 'member_abcdefghijklmnopqrstuv',
      },
      conn,
    );
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
    await handleData({ type: MSG.CHAT, text: 'spoof', senderMemberId: 'acct_private' }, conn);

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

    // Unowned chunk frames no longer bypass the bucket merely because of their
    // message type.
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
    expect(chunk).not.toHaveBeenCalled();

    let activeTransfer = true;
    registerInboundRateLimitExemptionGuard(
      MSG.PRELOAD_CHUNK,
      (_message, candidate) => activeTransfer && candidate === conn,
    );
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
    activeTransfer = false;

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
