/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../../player/_state.ts';
import { initPlayback } from '../../player/playback.ts';
import {
  initPlaylist,
  clearPreloadState,
  playTrack,
  setRepeatMode,
  setShuffle,
} from '../../player/playlist.ts';
import { stopAllMedia } from '../../player/transport.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import { resetAllStoredFiles } from '../storage.ts';

const native = vi.hoisted(() => ({ decode: vi.fn(), start: vi.fn() }));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => undefined),
  getFilePlaybackDestination: () => null,
}));
vi.mock('../../audio/context.ts', () => ({
  ensureRunning: vi.fn(async () => undefined),
  getCurrentTime: () => 10,
  getPendingForegroundAudioContextClockHealthCheck: () => null,
  getAudioContext: () => ({
    state: 'running',
    sampleRate: 48000,
    currentTime: 10,
    decodeAudioData: native.decode,
    createBufferSource: () => ({
      start: native.start,
      stop() {},
      disconnect() {},
      connect() {},
      buffer: null,
      onended: null,
    }),
  }),
}));

const CURRENT = '30000000-0000-4000-8000-000000000001';
const NEXT = '30000000-0000-4000-8000-000000000002';
const FUTURE = '30000000-0000-4000-8000-000000000003';

function fileItem(queueItemId: string, name: string): PlaylistItem {
  return {
    queueItemId,
    name,
    type: 'file',
    file: new File([new Uint8Array(CHUNK_SIZE + 1)], name, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  };
}

function connectGuest() {
  const frames: Record<string, unknown>[] = [];
  const conn = {
    open: true,
    peer: 'queue-io-guest',
    send: vi.fn((message: unknown) => frames.push(message as Record<string, unknown>)),
    dataChannel: { readyState: 'open', bufferedAmount: 0 },
  } as unknown as DataConnection;
  const peer: ConnectedPeer = {
    id: conn.peer,
    conn,
    slot: 1,
    label: conn.peer,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
  return { conn, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  resetFileDeliveryPolicies();
  native.decode.mockReset();
  native.start.mockReset();
  setCurrentAudioBuffer(null);
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('network.sessionCode', '123456');
  setState('player.isFirstTrackLoad', false);
  setState('playlist.repeatMode', 0);
  setState('playlist.isShuffle', false);
  initPreload();
  initPlayback();
  initPlaylist();
});

afterEach(async () => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  cancelPreloadTransfer();
  await vi.advanceTimersByTimeAsync(100);
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('queue edits across native preload I/O', () => {
  it.each([
    { lane: 'broadcast', mode: 'unchanged' },
    { lane: 'broadcast', mode: 'repeat-all' },
    { lane: 'broadcast', mode: 'repeat-one' },
    { lane: 'broadcast', mode: 'shuffle' },
    { lane: 'unicast', mode: 'repeat-all' },
    { lane: 'unicast', mode: 'repeat-one' },
    { lane: 'unicast', mode: 'shuffle' },
    { lane: 'unicast', mode: 'remove-future' },
    { lane: 'broadcast', mode: 'force-reset' },
    { lane: 'unicast', mode: 'force-reset' },
    { lane: 'broadcast', mode: 'navigate-back' },
    { lane: 'unicast', mode: 'navigate-back' },
  ])('keeps current $lane ownership scoped correctly after $mode', async ({ lane, mode }) => {
    const previous = fileItem(CURRENT, 'previous.mp3');
    const selected = fileItem(NEXT, 'selected.mp3');
    const future = fileItem(FUTURE, 'future.mp3');
    setState('playlist.items', [previous, selected, future]);
    setState('playlist.currentQueueItemId', CURRENT);
    if (lane === 'unicast') {
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(100);
    }
    const { conn, frames } = connectGuest();
    const file = selected.file!;
    const firstChunk = file.slice(0, CHUNK_SIZE);
    const bytes = await firstChunk.arrayBuffer();
    let finishRead!: (value: ArrayBuffer) => void;
    vi.spyOn(file, 'slice').mockReturnValueOnce(firstChunk);
    vi.spyOn(firstChunk, 'arrayBuffer').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const sending =
      lane === 'unicast'
        ? unicastPreload(conn, file, NEXT, getState('preload.sessionId'))
        : Promise.resolve();
    if (lane === 'broadcast') schedulePreload(0);
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    const sessionId = getState('preload.sessionId');
    const decoded = {
      duration: 60,
      length: 60 * 48000,
      sampleRate: 48000,
      numberOfChannels: 2,
    } as AudioBuffer;
    native.decode.mockResolvedValue(decoded);
    try {
      // Real playTrack/loadPreloadedTrack promotes the host's resident while
      // the guest's real pump remains inside its uncancellable Blob read.
      await playTrack(NEXT);
      expect(getState('files.current')).toMatchObject({ queueItemId: NEXT, sessionId });
      expect(getCurrentAudioBuffer()).toBe(decoded);
      // A promoted late-join unicast can coexist with the next background
      // owner; let the real scheduler claim that speculative lane first.
      await vi.advanceTimersByTimeAsync(600);
      const speculativeSession = getState('preload.activeTarget')?.sessionId;
      if (mode === 'repeat-all') setRepeatMode(1, false);
      else if (mode === 'repeat-one') setRepeatMode(2, false);
      else if (mode === 'shuffle') setShuffle(true, false, [CURRENT, NEXT, FUTURE]);
      else if (mode === 'remove-future') bus.emit('playlist:remove-tracks', [FUTURE]);
      else if (mode === 'force-reset') clearPreloadState(true);
      else if (mode === 'navigate-back') await playTrack(CURRENT);
      await vi.advanceTimersByTimeAsync(600);
      finishRead(bytes);
      await sending;
      await vi.advanceTimersByTimeAsync(1000);

      expect(getState('playlist.currentQueueItemId')).toBe(
        mode === 'navigate-back' ? CURRENT : NEXT,
      );
      expect(getState('playback.activity')).toBe('playing');
      expect(getCurrentAudioBuffer()).toBe(decoded);
      const selectedFrames = frames.filter(
        (frame) => frame.queueItemId === NEXT && frame.sessionId === sessionId,
      );
      if (mode === 'force-reset' || mode === 'navigate-back') {
        expect(selectedFrames.filter((frame) => frame.type === MSG.PRELOAD_ABORT)).toHaveLength(1);
        expect(
          selectedFrames.some(
            (frame) => frame.type === MSG.PRELOAD_CHUNK || frame.type === MSG.PRELOAD_END,
          ),
        ).toBe(false);
        return;
      }
      expect(selectedFrames.filter((frame) => frame.type === MSG.PRELOAD_ABORT)).toEqual([]);
      expect(
        selectedFrames
          .filter((frame) => frame.type === MSG.PRELOAD_CHUNK)
          .map((frame) => frame.chunkIndex),
      ).toEqual([0, 1]);
      expect(selectedFrames.filter((frame) => frame.type === MSG.PRELOAD_END)).toHaveLength(1);
      expect(getState('preload.nextQueueItemId')).toBe(
        mode === 'repeat-one' || mode === 'remove-future' ? null : FUTURE,
      );
      if (lane === 'unicast' && mode !== 'unchanged') {
        expect(
          frames.filter(
            (frame) =>
              frame.queueItemId === FUTURE &&
              frame.sessionId === speculativeSession &&
              frame.type === MSG.PRELOAD_ABORT,
          ),
        ).toHaveLength(1);
        expect(
          frames.some(
            (frame) =>
              frame.queueItemId === FUTURE &&
              frame.sessionId === speculativeSession &&
              (frame.type === MSG.PRELOAD_CHUNK || frame.type === MSG.PRELOAD_END),
          ),
        ).toBe(false);
      }
    } finally {
      finishRead?.(bytes);
      await sending;
      await vi.advanceTimersByTimeAsync(100);
    }
  });
});
