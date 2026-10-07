/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleHostIncomingConnection } from '../../network/host.ts';
import { handleData } from '../../network/protocol.ts';
import { verifyPeerCapability } from '../../rooms/authority.ts';
import type { DataConnection } from '../../types/index.ts';
import { setYouTubePlayer, type YouTubePlayerInstance } from '../../youtube/_state.ts';
import { initYouTube } from '../../youtube/player.ts';
import {
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  requestUserStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
} from '../../youtube/standard-host-manual-offset-gate.ts';
import { loadAndBroadcastFile } from '../decode.ts';
import { setPlaybackYouTubePaused } from '../ownership.ts';
import { initPlaylist, playTrack } from '../playlist.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
// Decoding is downstream of the selection and FILE_PREPARE under test. The
// asynchronous boundary exercised here is the real iframe seek verifier.
vi.mock('../decode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../decode.ts')>()),
  loadAndBroadcastFile: vi.fn(async () => false),
}));

const PREVIOUS_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_ID = '33333333-3333-4333-8333-333333333333';
const BOOTSTRAP_ID = '12345678-1234-4abc-8def-1234567890ab';
const MEMBER_ID = 'peer:operator-device';

type FiringConn = DataConnection & {
  send: Mock<(data: unknown) => void>;
  close: Mock<() => void>;
  fire: (event: string, ...args: unknown[]) => void;
};

function connectOperator(): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const conn = {
    peer: 'operator-device',
    open: true,
    send: vi.fn<(data: unknown) => void>(),
    close: vi.fn(() => {
      conn.open = false;
      conn.fire('close');
    }),
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(listener);
      handlers.set(event, listeners);
    },
    fire(event: string, ...args: unknown[]) {
      for (const listener of [...(handlers.get(event) ?? [])]) listener(...args);
    },
  } as unknown as FiringConn;
  handleHostIncomingConnection(conn);
  conn.fire('open');
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1, bootstrapId: BOOTSTRAP_ID });
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_APPLIED, version: 1, bootstrapId: BOOTSTRAP_ID });
  expect(getState('network.connectedPeers').find((peer) => peer.conn === conn)?.status).toBe(
    'connected',
  );
  bus.emit('network:grant-standard-room-administrator', { memberId: MEMBER_ID });
  expect(verifyPeerCapability(conn, 'playback.control')).toBe(true);
  return conn;
}

function beginPhysicalSeek() {
  let state = 2;
  // Stay below the real previous-button restart threshold so PREV navigates
  // to the preceding queue row rather than restarting this YouTube item.
  let position = 1;
  let pendingTarget = position;
  const player = {
    getCurrentTime: vi.fn(() => position),
    getDuration: vi.fn(() => 120),
    getPlayerState: vi.fn(() => state),
    getPlaylistIndex: vi.fn(() => -1),
    getVideoData: vi.fn(() => ({ video_id: 'video-a', title: 'Current YouTube' })),
    seekTo: vi.fn((target: number) => {
      pendingTarget = target;
      state = 3;
    }),
    pauseVideo: vi.fn(),
    stopVideo: vi.fn(),
  } as unknown as YouTubePlayerInstance;
  setYouTubePlayer(player);
  requestUserStandardHostManualOffsetTransaction(player, 0.25, 'committed');
  expect(player.seekTo).toHaveBeenCalledWith(1.25, true);
  expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
  return {
    async finish() {
      // The iframe now reports the commanded physical position. The production
      // verifier, not a test callback or deferred Promise, releases navigation.
      position = pendingTarget;
      state = 2;
      await vi.advanceTimersByTimeAsync(700);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    },
  };
}

beforeAll(async () => {
  await prepareStandardHostManualOffsetRuntimeForTests();
  initPlaylist();
  initYouTube();
});

beforeEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  resetState();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  setState('network.appRole', 'host');
  setState('network.myId', 'host-device');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('player.isFirstTrackLoad', false);
  setState('playlist.items', [
    {
      queueItemId: PREVIOUS_ID,
      type: 'file',
      name: 'Previous.wav',
      file: new File([new Uint8Array([1])], 'Previous.wav', { type: 'audio/wav' }),
      videoId: null,
      playlistId: null,
    },
    {
      queueItemId: CURRENT_ID,
      type: 'youtube',
      name: 'Current YouTube',
      videoId: 'video-a',
      playlistId: null,
    },
    {
      queueItemId: NEXT_ID,
      type: 'file',
      name: 'Next.wav',
      file: new File([new Uint8Array([2])], 'Next.wav', { type: 'audio/wav' }),
      videoId: null,
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', CURRENT_ID);
  setState('youtube.currentSubIndex', -1);
  setPlaybackYouTubePaused();
});

afterEach(() => {
  resetStandardHostManualOffsetTransaction();
  setYouTubePlayer(null);
  clearAllManagedTimers();
  vi.useRealTimers();
});

const requests = [
  {
    label: 'track selection',
    type: MSG.REQUEST_TRACK_CHANGE,
    queueItemId: NEXT_ID,
    target: NEXT_ID,
  },
  { label: 'next', type: MSG.REQUEST_NEXT_TRACK, queueItemId: CURRENT_ID, target: NEXT_ID },
  { label: 'previous', type: MSG.REQUEST_PREV_TRACK, queueItemId: CURRENT_ID, target: PREVIOUS_ID },
];

describe.each(requests)('operator $label during the host iframe seek', (request) => {
  async function deferRequest(conn: FiringConn) {
    const seek = beginPhysicalSeek();
    await handleData({ type: request.type, queueItemId: request.queueItemId }, conn);
    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(getState('youtube.currentSubIndex')).toBe(-1);
    expect(loadAndBroadcastFile).not.toHaveBeenCalled();
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    return seek;
  }

  it('drops the deferred request after the host revokes playback authority', async () => {
    const conn = connectOperator();
    const seek = await deferRequest(conn);
    bus.emit('network:revoke-standard-room-administrator', { memberId: MEMBER_ID });
    expect(verifyPeerCapability(conn, 'playback.control')).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('youtube.currentSubIndex')).toBe(-1);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);

    await seek.finish();

    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(loadAndBroadcastFile).not.toHaveBeenCalled();
    expect(conn.send.mock.calls.map(([frame]) => frame)).not.toContainEqual(
      expect.objectContaining({ type: MSG.FILE_PREPARE }),
    );
  });

  it('does not carry an old request onto a newly authorized connection with the same peer ID', async () => {
    const conn = connectOperator();
    const seek = await deferRequest(conn);
    const replacement = connectOperator();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(verifyPeerCapability(conn, 'playback.control')).toBe(false);
    expect(verifyPeerCapability(replacement, 'playback.control')).toBe(true);
    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('youtube.currentSubIndex')).toBe(-1);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);

    await seek.finish();

    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(loadAndBroadcastFile).not.toHaveBeenCalled();
    expect(replacement.send.mock.calls.map(([frame]) => frame)).not.toContainEqual(
      expect.objectContaining({ type: MSG.FILE_PREPARE }),
    );
  });

  it('executes once after the physical seek settles while the same operator remains authorized', async () => {
    const conn = connectOperator();
    const seek = await deferRequest(conn);

    await seek.finish();

    expect(getState('playlist.currentQueueItemId')).toBe(request.target);
    expect(loadAndBroadcastFile).toHaveBeenCalledOnce();
    expect(vi.mocked(loadAndBroadcastFile).mock.calls[0]?.[1]).toBe(request.target);
    expect(conn.send.mock.calls.map(([frame]) => frame)).toContainEqual(
      expect.objectContaining({ type: MSG.FILE_PREPARE, queueItemId: request.target }),
    );
  });
});

it('retains only the latest authorized navigation during the real iframe wait', async () => {
  const conn = connectOperator();
  const seek = beginPhysicalSeek();
  await handleData({ type: MSG.REQUEST_NEXT_TRACK, queueItemId: CURRENT_ID }, conn);
  await handleData({ type: MSG.REQUEST_PREV_TRACK, queueItemId: CURRENT_ID }, conn);

  await seek.finish();

  expect(getState('playlist.currentQueueItemId')).toBe(PREVIOUS_ID);
  expect(loadAndBroadcastFile).toHaveBeenCalledOnce();
  expect(vi.mocked(loadAndBroadcastFile).mock.calls[0]?.[1]).toBe(PREVIOUS_ID);
});

it('keeps a later host-local selection when the earlier requester loses authority', async () => {
  const conn = connectOperator();
  const seek = beginPhysicalSeek();
  await handleData({ type: MSG.REQUEST_PREV_TRACK, queueItemId: CURRENT_ID }, conn);
  await playTrack(NEXT_ID);
  bus.emit('network:revoke-standard-room-administrator', { memberId: MEMBER_ID });

  await seek.finish();

  expect(getState('playlist.currentQueueItemId')).toBe(NEXT_ID);
  expect(loadAndBroadcastFile).toHaveBeenCalledOnce();
  expect(vi.mocked(loadAndBroadcastFile).mock.calls[0]?.[1]).toBe(NEXT_ID);
});
