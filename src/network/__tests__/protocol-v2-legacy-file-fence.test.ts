import { beforeEach, describe, expect, it, vi } from 'vitest';

const applicationSessions = vi.hoisted(() => ({
  isKnownConnection: vi.fn(() => true),
  phase: vi.fn(() => 'established' as const),
}));

vi.mock('../../player/file-playback-engine-gate.ts', () => ({
  isFilePlaybackEngineV2Enabled: () => true,
  getFilePlaybackEngineMode: () => 'v2',
}));

vi.mock('../file-playback-application-session.ts', () => ({
  getFilePlaybackApplicationSessionManager: () => applicationSessions,
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MSG, type MsgType } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import { handleData, registerHandler } from '../protocol.ts';

const QUEUE_ITEM_ID = '98000000-0000-4000-8000-000000000001';

const LEGACY_FILE_MEDIA_FRAMES = [
  { type: MSG.PLAY },
  { type: MSG.PAUSE },
  { type: MSG.PLAY_PRELOADED },
  { type: MSG.FILE_PREPARE },
  { type: MSG.FILE_START },
  { type: MSG.FILE_RESUME },
  { type: MSG.FILE_CHUNK },
  { type: MSG.FILE_END },
  { type: MSG.FILE_WAIT },
  { type: MSG.PRELOAD_START },
  { type: MSG.PRELOAD_CHUNK },
  { type: MSG.PRELOAD_END },
  { type: MSG.PRELOAD_ABORT },
  { type: MSG.PRELOAD_ACK },
  { type: MSG.REMOTE_FILE_SHARE },
  { type: MSG.REMOTE_FILE_UNAVAILABLE },
  { type: MSG.REQUEST_CURRENT_FILE },
  { type: MSG.REQUEST_DATA_RECOVERY },
  { type: MSG.GUEST_DECODE_FAILED },
] as const;

const PRESERVED_APPLICATION_FRAMES: readonly Readonly<{
  label: string;
  type: MsgType;
  frame: Readonly<Record<string, unknown>>;
}>[] = [
  {
    label: 'operator play request',
    type: MSG.REQUEST_PLAY,
    frame: { type: MSG.REQUEST_PLAY, queueItemId: QUEUE_ITEM_ID, time: 0 },
  },
  {
    label: 'operator pause request',
    type: MSG.REQUEST_PAUSE,
    frame: { type: MSG.REQUEST_PAUSE, queueItemId: QUEUE_ITEM_ID },
  },
  {
    label: 'operator seek request',
    type: MSG.REQUEST_SEEK,
    frame: { type: MSG.REQUEST_SEEK, queueItemId: QUEUE_ITEM_ID, time: 12 },
  },
  {
    label: 'operator skip request',
    type: MSG.REQUEST_SKIP_TIME,
    frame: { type: MSG.REQUEST_SKIP_TIME, queueItemId: QUEUE_ITEM_ID, sec: 5 },
  },
  {
    label: 'playlist snapshot',
    type: MSG.PLAYLIST_UPDATE,
    frame: {
      type: MSG.PLAYLIST_UPDATE,
      list: [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'file',
          name: 'kept.mp3',
          videoId: null,
          playlistId: null,
        },
      ],
      currentQueueItemId: QUEUE_ITEM_ID,
      revision: 1,
    },
  },
  {
    label: 'chat',
    type: MSG.CHAT,
    frame: { type: MSG.CHAT, text: 'kept' },
  },
  {
    label: 'YouTube stop',
    type: MSG.YOUTUBE_STOP,
    frame: { type: MSG.YOUTUBE_STOP, queueItemId: QUEUE_ITEM_ID },
  },
  {
    label: 'system audio start',
    type: MSG.SYSTEM_AUDIO_START,
    frame: { type: MSG.SYSTEM_AUDIO_START },
  },
];

function guestConnection(): DataConnection {
  return {
    peer: 'v2-authoritative-host',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
});

describe('V2 guest legacy file-media fence', () => {
  it.each(LEGACY_FILE_MEDIA_FRAMES)('drops $type before its generic handler', async (frame) => {
    const conn = guestConnection();
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    markQueueAuthorityReady(conn);
    const handler = vi.fn();
    registerHandler(frame.type, handler);

    await handleData(frame, conn);

    expect(applicationSessions.isKnownConnection).toHaveBeenCalledWith(conn);
    expect(applicationSessions.phase).toHaveBeenCalledWith(conn);
    expect(handler).not.toHaveBeenCalled();
    expect(conn.close).not.toHaveBeenCalled();
  });

  it.each(PRESERVED_APPLICATION_FRAMES)(
    'keeps $label on the generic path',
    async ({ type, frame }) => {
      const conn = guestConnection();
      setState('network.appRole', 'guest');
      setState('network.hostConn', conn);
      markQueueAuthorityReady(conn);
      const handler = vi.fn();
      registerHandler(type, handler);

      await handleData(frame, conn);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(frame, conn);
      expect(conn.close).not.toHaveBeenCalled();
    },
  );
});
