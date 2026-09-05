/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import { leaveSession } from '../../network/peer.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../_state.ts';
import { initPlayback } from '../playback.ts';
import { createPlaylistSnapshot } from '../queue-model.ts';
import { initPlaylist, playTrack, toggleRepeat, toggleShuffle } from '../playlist.ts';
import { stopAllMedia, stopPlayback } from '../transport.ts';
import {
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../../storage/preload.ts';
import { resetAllStoredFiles, storedFileAdmissionStatsForTests } from '../../storage/storage.ts';
import { initTransfer } from '../../storage/transfer.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';

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

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();
  native.decode.mockReset();
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
  setCurrentAudioBuffer(null);
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('network.sessionCode', '123456');
  setState('player.isFirstTrackLoad', false);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  resetAllStoredFiles();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startPreloadActivation() {
  const file = new File(['audio'], 'song.mp3', { type: 'audio/mpeg' });
  const item: PlaylistItem = {
    queueItemId: '11111111-1111-4111-8111-111111111111',
    type: 'file',
    name: file.name,
    file,
    videoId: null,
    playlistId: null,
  };
  const previous: PlaylistItem = { ...item, queueItemId: '22222222-2222-4222-8222-222222222222' };
  const next: PlaylistItem = { ...item, queueItemId: '33333333-3333-4333-8333-333333333333' };
  setState('playlist.items', [previous, item, next]);
  setState('playlist.currentQueueItemId', previous.queueItemId);
  schedulePreload(0);
  await vi.waitFor(() => expect(getState('preload.ready')?.queueItemId).toBe(item.queueItemId));
  expect(getState('preload.ready')?.blob).toBe(file);
  let resolveDecode!: (buffer: AudioBuffer) => void;
  native.decode.mockImplementationOnce(
    () =>
      new Promise<AudioBuffer>((resolve) => {
        resolveDecode = resolve;
      }),
  );
  const loading = playTrack(item.queueItemId);
  await vi.waitFor(() => expect(native.decode).toHaveBeenCalledOnce());
  expect(getState('playback.lifecycle')).toBe('DECODING');
  return { item, next, loading, resolveDecode };
}

function decodedBuffer(): AudioBuffer {
  return {
    duration: 60,
    length: 60 * 48000,
    sampleRate: 48000,
    numberOfChannels: 2,
  } as AudioBuffer;
}

describe('queue mode changes during current preload activation', () => {
  it.each([
    ['complete', 'play'],
    ['receiving', 'play'],
    ['complete', 'stop'],
    ['complete', 'leave'],
  ] as const)(
    'isolates awaited late-join completion with future preload %s and %s',
    async (futureState, action) => {
      const file = new File(['audio'], 'selected.mp3', { type: 'audio/mpeg' });
      const item: PlaylistItem = {
        queueItemId: '11111111-1111-4111-8111-111111111111',
        type: 'file',
        name: file.name,
        file,
        videoId: null,
        playlistId: null,
      };
      const previous = { ...item, queueItemId: '22222222-2222-4222-8222-222222222222' };
      const nextFile = new File(['future'], 'next.mp3', { type: 'audio/mpeg' });
      const next = {
        ...item,
        queueItemId: '33333333-3333-4333-8333-333333333333',
        file: nextFile,
        name: nextFile.name,
      };
      setState('playlist.items', [previous, item, next]);
      setState('playlist.currentQueueItemId', previous.queueItemId);
      schedulePreload(0);
      await vi.waitFor(() => expect(getState('preload.ready')?.queueItemId).toBe(item.queueItemId));
      const resident = getState('preload.ready')!;
      const snapshot = createPlaylistSnapshot();
      const frames: Array<Record<string, unknown>> = [];
      const peer = {
        open: true,
        peer: 'late-guest',
        send: (frame: Record<string, unknown>) => frames.push(frame),
        dataChannel: { readyState: 'open', bufferedAmount: 0 },
      } as unknown as DataConnection;
      setState('network.connectedPeers', [
        {
          id: peer.peer,
          slot: 1,
          label: peer.peer,
          conn: peer,
          isOp: false,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: 0,
        } satisfies ConnectedPeer,
      ]);
      setState('network.activeHostConnByPeerId', new Map([[peer.peer, peer]]));
      // The same native Blob read used by the production late-join sender can
      // remain pending while the host promotes B and schedules C.
      const firstChunk = file.slice();
      let finishRead!: (bytes: ArrayBuffer) => void;
      vi.spyOn(file, 'slice').mockReturnValueOnce(firstChunk);
      vi.spyOn(firstChunk, 'arrayBuffer').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      let finishFutureRead!: (bytes: ArrayBuffer) => void;
      if (futureState === 'receiving') {
        const futureChunk = nextFile.slice();
        vi.spyOn(nextFile, 'slice').mockReturnValueOnce(futureChunk);
        vi.spyOn(futureChunk, 'arrayBuffer').mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishFutureRead = resolve;
            }),
        );
      }
      const sending = unicastPreload(peer, file, item.queueItemId, resident.sessionId);
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
      native.decode.mockResolvedValueOnce(decodedBuffer());
      await playTrack(item.queueItemId);
      await vi.advanceTimersByTimeAsync(600);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: MSG.PRELOAD_START, queueItemId: next.queueItemId }),
      );
      finishRead(await file.arrayBuffer());
      await sending;
      const selectedEnd = frames.findIndex(
        (frame) => frame.type === MSG.PRELOAD_END && frame.queueItemId === item.queueItemId,
      );
      expect(selectedEnd).toBeGreaterThan(
        frames.findIndex(
          (frame) => frame.type === MSG.PRELOAD_START && frame.queueItemId === next.queueItemId,
        ),
      );
      if (futureState === 'receiving') {
        expect(
          frames.some(
            (frame) => frame.type === MSG.PRELOAD_END && frame.queueItemId === next.queueItemId,
          ),
        ).toBe(false);
        finishFutureRead(await nextFile.arrayBuffer());
        await vi.waitFor(() =>
          expect(frames).toContainEqual(
            expect.objectContaining({ type: MSG.PRELOAD_END, queueItemId: next.queueItemId }),
          ),
        );
      }
      const emitted = frames.slice();
      stopPlayback();
      const stopFrames = frames.slice(emitted.length);
      stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      clearAllManagedTimers();
      resetPreloadReceiveAuthority();
      resetState();
      bus.clear();
      native.decode.mockClear();
      native.start.mockClear();
      const buffer = decodedBuffer();
      let finishDecode!: (value: AudioBuffer) => void;
      native.decode.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDecode = resolve;
          }),
      );
      const host = { open: true, peer: 'host', send: vi.fn() } as unknown as DataConnection;
      setState('network.appRole', 'guest');
      setState('network.hostConn', host);
      setState('network.connectionType', 'local');
      setState('setup.sessionStarted', true);
      initPlaylist();
      initPlayback();
      initPreload();
      initTransfer();
      await handleData({ type: MSG.PLAYLIST_UPDATE, ...snapshot, bootstrap: true }, host);
      for (const frame of emitted) {
        if (
          futureState === 'receiving' &&
          frame.type === MSG.PRELOAD_CHUNK &&
          frame.queueItemId === next.queueItemId
        ) {
          // C's next ordered frame may arrive after B finishes decoding. Its
          // current loader still needs its own bounded stall watchdog.
          finishDecode(buffer);
          await vi.waitFor(() => expect(getCurrentAudioBuffer()).toBe(buffer));
          expect(getManagedTimer('preloadUiWatchdog')).not.toBeNull();
        }
        await handleData(frame, host);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(host.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'preload_identity_mismatch' }),
      );
      await vi.waitFor(() => expect(native.decode).toHaveBeenCalledOnce());
      expect(getState('preload.ready')?.queueItemId).toBe(next.queueItemId);
      if (action === 'stop') {
        for (const frame of stopFrames) await handleData(frame, host);
      } else if (action === 'leave') leaveSession();
      finishDecode(buffer);
      if (action === 'leave') {
        await vi.advanceTimersByTimeAsync(10);
        expect(getCurrentAudioBuffer()).toBeNull();
        expect(getState('files.current')).toBeNull();
        expect(getState('preload.ready')).toBeNull();
        expect(native.start).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(getCurrentAudioBuffer()).toBe(buffer));
      expect(getState('files.current')?.queueItemId).toBe(item.queueItemId);
      expect(getState('preload.ready')?.queueItemId).toBe(next.queueItemId);
      expect(getState('preload.activeTarget')?.queueItemId).toBe(next.queueItemId);
      expect(getState('preload.nextQueueItemId')).toBe(next.queueItemId);
      await vi.waitFor(() =>
        expect(getState('playback.activity')).toBe(action === 'stop' ? 'paused' : 'playing'),
      );
      expect(native.start).toHaveBeenCalledTimes(action === 'stop' ? 0 : 1);
      expect(storedFileAdmissionStatsForTests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ queueItemId: item.queueItemId, owner: 'current' }),
          expect.objectContaining({ queueItemId: next.queueItemId, owner: 'preload-cache' }),
        ]),
      );
    },
  );

  it.each(['without-next', 'with-next', 'decode-failure', 'stop', 'select-next', 'leave'] as const)(
    'isolates slow guest activation and its speculative successor during %s',
    async (action) => {
      const frames: Array<Record<string, unknown>> = [];
      const peer = {
        open: true,
        peer: 'guest-preload',
        send: (frame: Record<string, unknown>) => frames.push(frame),
        dataChannel: { readyState: 'open', bufferedAmount: 0 },
      } as unknown as DataConnection;
      setState('network.connectedPeers', [
        {
          id: peer.peer,
          slot: 1,
          label: peer.peer,
          conn: peer,
          isOp: false,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: 0,
        } satisfies ConnectedPeer,
      ]);
      setState('network.activeHostConnByPeerId', new Map([[peer.peer, peer]]));
      const { item, next, loading, resolveDecode } = await startPreloadActivation();
      const snapshot = createPlaylistSnapshot();
      resolveDecode(decodedBuffer());
      await loading;
      await vi.advanceTimersByTimeAsync(600);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: MSG.PRELOAD_END, queueItemId: next.queueItemId }),
      );
      expect(frames).toContainEqual(
        expect.objectContaining({ type: MSG.PLAY, queueItemId: item.queueItemId }),
      );
      const emitted = frames.slice();
      stopPlayback();
      const stopFrames = frames.slice(emitted.length);
      const nextBuffer = decodedBuffer();
      native.decode.mockResolvedValueOnce(nextBuffer);
      const beforeSelect = frames.length;
      await playTrack(next.queueItemId, undefined, { explicitPlaybackIntent: true });
      const selectFrames = frames.slice(beforeSelect);
      stopAllMedia({ cancelInFlight: true, clearBuffer: true });
      clearAllManagedTimers();
      resetPreloadReceiveAuthority();
      resetState();
      bus.clear();
      native.start.mockClear();
      native.decode.mockClear();
      const host = { open: true, peer: 'host-preload', send: vi.fn() } as unknown as DataConnection;
      setState('network.appRole', 'guest');
      setState('network.hostConn', host);
      setState('network.connectionType', 'local');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);
      initPlaylist();
      initPlayback();
      initPreload();
      initTransfer();
      await handleData({ type: MSG.PLAYLIST_UPDATE, ...snapshot, bootstrap: true }, host);
      let resolveGuest!: (buffer: AudioBuffer) => void;
      let rejectGuest!: (error: Error) => void;
      native.decode.mockImplementationOnce(
        () =>
          new Promise<AudioBuffer>((resolve, reject) => {
            resolveGuest = resolve;
            rejectGuest = reject;
          }),
      );
      for (const frame of emitted) {
        if (frame.queueItemId === next.queueItemId) {
          if (action === 'without-next') continue;
          expect(native.decode).toHaveBeenCalledOnce();
        }
        await handleData(frame, host);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(native.decode).toHaveBeenCalledOnce();
      expect(getState('playback.lifecycle')).toBe('DECODING');
      expect(storedFileAdmissionStatsForTests()).toContainEqual(
        expect.objectContaining({
          queueItemId: item.queueItemId,
          owner: 'current',
        }),
      );
      if (action !== 'without-next') {
        // C has finalized and ACKed while B's native decoder is still pending.
        expect(getState('preload.ready')?.queueItemId).toBe(next.queueItemId);
        expect(host.send).toHaveBeenCalledWith(
          expect.objectContaining({ type: MSG.PRELOAD_ACK, queueItemId: next.queueItemId }),
        );
      }
      if (action === 'stop') {
        for (const frame of stopFrames) await handleData(frame, host);
      } else if (action === 'select-next') {
        native.decode.mockResolvedValueOnce(nextBuffer);
        for (const frame of selectFrames) await handleData(frame, host);
        await vi.waitFor(() => expect(getCurrentAudioBuffer()).toBe(nextBuffer));
      } else if (action === 'leave') leaveSession();
      const buffer = decodedBuffer();
      if (action === 'decode-failure') {
        rejectGuest(new Error('native decode failed'));
        await vi.waitFor(() => expect(getState('files.current')).toBeNull());
        expect(getCurrentAudioBuffer()).toBeNull();
        expect(getState('preload.ready')?.queueItemId).toBe(next.queueItemId);
        expect(storedFileAdmissionStatsForTests().map((entry) => entry.queueItemId)).toEqual([
          next.queueItemId,
        ]);
        expect(host.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MSG.REQUEST_CURRENT_FILE,
            queueItemId: item.queueItemId,
          }),
        );
        return;
      }
      resolveGuest(buffer);
      if (action === 'select-next' || action === 'leave') {
        await vi.advanceTimersByTimeAsync(10);
        expect(getCurrentAudioBuffer()).toBe(action === 'leave' ? null : nextBuffer);
        expect(getState('files.current')?.queueItemId).toBe(
          action === 'leave' ? undefined : next.queueItemId,
        );
        expect(getState('preload.ready')).toBeNull();
        expect(storedFileAdmissionStatsForTests().map((entry) => entry.queueItemId)).toEqual(
          action === 'leave' ? [] : [next.queueItemId],
        );
        return;
      }
      await vi.waitFor(() => expect(getCurrentAudioBuffer()).toBe(buffer));
      expect(getState('files.current')?.queueItemId).toBe(item.queueItemId);
      await vi.waitFor(() =>
        expect(getState('playback.activity')).toBe(action === 'stop' ? 'paused' : 'playing'),
      );
      if (action === 'stop') expect(native.start).not.toHaveBeenCalled();
      if (action !== 'without-next')
        expect(getState('preload.ready')?.queueItemId).toBe(next.queueItemId);
    },
  );

  it.each(['unchanged', 'repeat', 'shuffle', 'repeat-one', 'scheduled'] as const)(
    'keeps the selected decode alive after %s changes',
    async (mode) => {
      const { item, next, loading, resolveDecode } = await startPreloadActivation();
      if (mode === 'repeat') toggleRepeat();
      else if (mode === 'shuffle') toggleShuffle();
      else if (mode === 'repeat-one') {
        toggleRepeat();
        toggleShuffle();
        toggleRepeat();
      } else if (mode === 'scheduled') schedulePreload(0);
      // Native decode may outlive every ordinary next-preload timer.
      await vi.advanceTimersByTimeAsync(1100);
      expect.soft(getState('files.current')?.queueItemId).toBe(item.queueItemId);
      if (mode !== 'unchanged') {
        expect(getState('preload.ready')?.queueItemId).toBe(
          mode === 'repeat-one' ? undefined : next.queueItemId,
        );
      }
      expect(getState('playback.lifecycle')).toBe('DECODING');
      const buffer = decodedBuffer();
      resolveDecode(buffer);
      await loading;
      expect.soft(getCurrentAudioBuffer()).toBe(buffer);
      expect.soft(getState('playback.activity')).toBe('playing');
      expect.soft(native.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      expect(getState('preload.nextQueueItemId')).toBe(
        mode === 'repeat-one' ? null : next.queueItemId,
      );
    },
  );

  it.each(['stop', 'remove', 'select'] as const)(
    'lets explicit %s retire the old activation',
    async (action) => {
      const { item, next, loading, resolveDecode } = await startPreloadActivation();
      toggleRepeat();
      const replacement = decodedBuffer();
      native.decode.mockResolvedValue(replacement);
      if (action === 'stop') stopPlayback();
      else if (action === 'remove') {
        initPlaylist();
        bus.emit('playlist:remove-tracks', [item.queueItemId]);
        await vi.waitFor(() => expect(getCurrentAudioBuffer()).toBe(replacement));
      } else await playTrack(next.queueItemId, undefined, { explicitPlaybackIntent: true });
      resolveDecode(decodedBuffer());
      await loading;
      expect(getCurrentAudioBuffer()).toBe(action === 'stop' ? null : replacement);
      expect(getState('playlist.currentQueueItemId')).toBe(
        action === 'stop' ? item.queueItemId : next.queueItemId,
      );
      expect(getState('playback.activity')).toBe(action === 'stop' ? 'idle' : 'playing');
      expect(native.start).toHaveBeenCalledTimes(action === 'stop' ? 0 : 1);
    },
  );
});
