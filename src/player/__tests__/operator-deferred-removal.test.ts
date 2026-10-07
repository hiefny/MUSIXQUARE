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
import { initPlaylist } from '../playlist.ts';

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

const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

function removeRequest(queueItemIds: string[], requestId = REQUEST_ID) {
  return {
    type: MSG.REQUEST_PLAYLIST_REMOVE,
    requestId,
    baseRevision: getState('playlist.revision'),
    queueItemIds,
  };
}

function mutationResults(conn: FiringConn) {
  return conn.send.mock.calls
    .map(([frame]) => frame as Record<string, unknown>)
    .filter((frame) => frame.type === MSG.OPERATOR_QUEUE_MUTATION_RESULT);
}

describe.each([
  { label: 'current row', ids: [CURRENT_ID], remaining: [PREVIOUS_ID, NEXT_ID] },
  { label: 'all visible rows', ids: [PREVIOUS_ID, CURRENT_ID, NEXT_ID], remaining: [] },
])('operator removal of $label during the host iframe seek', ({ ids, remaining }) => {
  it('rejects the blocked removal, replays that rejection, and accepts a new request after settlement', async () => {
    const conn = connectOperator();
    const seek = beginPhysicalSeek();
    const revision = getState('playlist.revision');
    const request = removeRequest(ids);
    conn.send.mockClear();

    await handleData(request, conn);

    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      PREVIOUS_ID,
      CURRENT_ID,
      NEXT_ID,
    ]);
    expect(mutationResults(conn)).toContainEqual(
      expect.objectContaining({ requestId: REQUEST_ID, phase: 'accepted' }),
    );
    expect.soft(mutationResults(conn)).toContainEqual(
      expect.objectContaining({
        phase: 'settled',
        outcome: 'rejected',
        code: 'conflict',
        revision,
      }),
    );
    expect
      .soft(conn.send.mock.calls.map(([frame]) => frame))
      .toContainEqual(
        expect.objectContaining({ type: MSG.PLAYLIST_UPDATE, revision, refresh: true }),
      );

    await seek.finish();
    await handleData(request, conn);

    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      PREVIOUS_ID,
      CURRENT_ID,
      NEXT_ID,
    ]);
    expect(getState('playlist.revision')).toBe(revision);
    expect
      .soft(mutationResults(conn).filter((frame) => frame.phase === 'settled'))
      .toEqual([
        expect.objectContaining({ outcome: 'rejected', code: 'conflict', revision }),
        expect.objectContaining({ outcome: 'rejected', code: 'conflict', revision }),
      ]);

    const retryId = '55555555-5555-4555-8555-555555555555';
    await handleData(removeRequest(ids, retryId), conn);

    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual(remaining);
    expect(getState('playlist.revision')).toBe(revision + 1);
    expect.soft(mutationResults(conn)).toContainEqual(
      expect.objectContaining({
        requestId: retryId,
        phase: 'settled',
        outcome: 'applied',
        revision: revision + 1,
      }),
    );
  });
});

it('still removes a noncurrent row while the physical seek remains pending', async () => {
  const conn = connectOperator();
  const seek = beginPhysicalSeek();
  const revision = getState('playlist.revision');

  await handleData(removeRequest([NEXT_ID]), conn);

  expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
    PREVIOUS_ID,
    CURRENT_ID,
  ]);
  expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
  expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
  expect(mutationResults(conn)).toContainEqual(
    expect.objectContaining({ phase: 'settled', outcome: 'applied', revision: revision + 1 }),
  );

  await seek.finish();

  expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_ID);
  expect(getState('playlist.revision')).toBe(revision + 1);
  expect(loadAndBroadcastFile).not.toHaveBeenCalled();
});

it.each(['revoked', 'replaced'] as const)(
  'checks the %s requester before reporting a blocked-removal conflict',
  async (boundary) => {
    const conn = connectOperator();
    const seek = beginPhysicalSeek();
    if (boundary === 'revoked') {
      bus.emit('network:revoke-standard-room-administrator', { memberId: MEMBER_ID });
    } else {
      const replacement = connectOperator();
      expect(verifyPeerCapability(replacement, 'queue.mutate')).toBe(true);
    }
    expect(verifyPeerCapability(conn, 'queue.mutate')).toBe(false);
    conn.send.mockClear();

    await handleData(removeRequest([CURRENT_ID]), conn);

    expect(mutationResults(conn)).toEqual(
      boundary === 'revoked'
        ? [expect.objectContaining({ phase: 'settled', outcome: 'rejected', code: 'unauthorized' })]
        : [],
    );
    await seek.finish();
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      PREVIOUS_ID,
      CURRENT_ID,
      NEXT_ID,
    ]);
    expect(getState('playlist.revision')).toBe(0);
    expect(loadAndBroadcastFile).not.toHaveBeenCalled();
  },
);
