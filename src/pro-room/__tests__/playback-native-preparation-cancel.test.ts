/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as audioContext from '../../audio/context.ts';
import * as audioEngine from '../../audio/engine.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getCurrentAudioBuffer,
  getPlayerNode,
  setCurrentAudioBuffer,
} from '../../player/_state.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { stopAllMedia } from '../../player/transport.ts';
import { memoryReservationStatsForTests } from '../../player/decode-admission.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import { registerProRoomMediaHooks } from '../media-hooks.ts';
import * as serverClock from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';

const ROOM = '000001';
const A = '52000000-0000-4000-8000-000000000001' as QueueItemId;
const B = '52000000-0000-4000-8000-000000000002' as QueueItemId;
let controller: ProRoomPlaybackController | null = null;
let serverNow: number;

function playback(queueItemId: QueueItemId | null, revision: number): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: 1,
    revision,
    state: queueItemId ? 'playing' : 'idle',
    queueItemId,
    positionSeconds: 0,
    youtubeVideoId: null,
    youtubeSubIndex: null,
    updatedAtMs: serverNow,
  };
}

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetProPlaybackAuthorityHooks();
  setCurrentAudioBuffer(null);
  serverNow = 10_000;
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM,
    epoch: 1,
    role: 'member',
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState(
    'playlist.items',
    [A, B].map((queueItemId, index) => ({
      queueItemId,
      type: 'file' as const,
      name: `${index}.flac`,
      file: new File([new Uint8Array([index + 1])], `${index}.flac`, { type: 'audio/flac' }),
      videoId: null,
      playlistId: null,
    })),
  );
  registerProRoomMediaHooks({
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    handlesPersistentFile: () => true,
  });
  vi.spyOn(serverClock, 'isProRoomServerClockCalibrated').mockReturnValue(true);
  vi.spyOn(serverClock, 'getProRoomServerNow').mockImplementation(() => serverNow);
  vi.spyOn(serverClock, 'waitForFreshProRoomServerClockCalibration').mockResolvedValue(true);
  vi.spyOn(audioEngine, 'initAudio').mockResolvedValue(undefined);
  vi.spyOn(audioContext, 'ensureRunning').mockResolvedValue(undefined);
  vi.spyOn(audioContext, 'getCurrentTime').mockReturnValue(10);
  initPlaylist();
});

afterEach(() => {
  controller?.stopLifecycle();
  controller = null;
  stopAllMedia({ cancelInFlight: true, silent: true });
  setCurrentAudioBuffer(null);
  registerProRoomMediaHooks(null);
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('PRO canonical commits while native preparation is superseded', () => {
  it.each(['PREPARE', 'COMMIT', 'snapshot'] as const)(
    'applies a newer direct idle COMMIT while %s-origin native preparation is pending',
    async (origin) => {
      // After the server commits the last row at its deadline, another participant
      // can press Next. The server has no pending transition to CANCEL and sends
      // only the newer direct idle COMMIT.
      setState(
        'playlist.items',
        getState('playlist.items').filter((item) => item.queueItemId === A),
      );
      let finishDecode!: (buffer: AudioBuffer) => void;
      const nativeDecode = new Promise<AudioBuffer>((resolve) => {
        finishDecode = resolve;
      });
      const decode = vi.fn(() => nativeDecode);
      const createBufferSource = vi.fn();
      vi.spyOn(audioContext, 'getAudioContext').mockReturnValue({
        state: 'running',
        sampleRate: 48_000,
        currentTime: 10,
        decodeAudioData: decode,
        createBufferSource,
      } as unknown as AudioContext);
      let canonical = playback(null, 0);
      const getSnapshot = () =>
        ({
          roomCode: ROOM,
          playback: canonical,
          presence: { coordinatorEpoch: 1 },
        }) as ProRoomSnapshot;
      const applied = vi.fn();
      const reportReady = vi.fn().mockResolvedValue('waiting');
      bus.on('sync:diagnostic-pro-checkpoint', applied);
      controller = new ProRoomPlaybackController({
        isActive: () => true,
        getCanonicalSnapshot: getSnapshot,
        getPlaylistSnapshot: getSnapshot,
        capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
        isPlaylistLeaseCurrent: () => true,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: vi.fn().mockResolvedValue(undefined),
        reportPlaybackTransitionReady: reportReady,
        executePlaybackCommand: vi.fn(),
        recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
      });
      controller.startLifecycle();
      if (origin === 'PREPARE') {
        controller.acceptPrepare({
          type: 'pro-playback-prepare',
          transitionId: 'native_last',
          serverTimeMs: serverNow,
          deadlineAtMs: serverNow + 3_000,
          basePlaybackRevision: 0,
          target: playback(A, 1),
        });
        await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      }
      serverNow += 3_000;
      canonical = playback(A, 1);
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: origin === 'snapshot' ? null : 'native_last',
        serverTimeMs: serverNow,
        executeAtMs: serverNow,
        playback: canonical,
      });
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      const reservation = memoryReservationStatsForTests().decodeBytes;
      expect(reservation).toBeGreaterThan(0);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      canonical = playback(null, 2);
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: serverNow,
        executeAtMs: serverNow,
        playback: canonical,
      });
      try {
        await vi.waitFor(() =>
          expect(applied).toHaveBeenCalledWith(
            expect.objectContaining({ revision: 2, trackKey: null, state: 'idle' }),
          ),
        );
        expect(getState('playlist.currentQueueItemId')).toBeNull();
        expect(getCurrentAudioBuffer()).toBeNull();
        expect(getState('files.current')).toBeNull();
        expect(memoryReservationStatsForTests().decodeBytes).toBe(reservation);
      } finally {
        finishDecode({ duration: 120 } as AudioBuffer);
        await vi.waitFor(() =>
          expect(applied).toHaveBeenCalledWith(
            expect.objectContaining({ revision: 2, trackKey: null, state: 'idle' }),
          ),
        );
        await vi.waitFor(() => expect(memoryReservationStatsForTests().decodeBytes).toBe(0));
        expect(applied).toHaveBeenCalledOnce();
        expect.soft(reportReady).not.toHaveBeenCalled();
        expect(createBufferSource).not.toHaveBeenCalled();
        expect(getCurrentAudioBuffer()).toBeNull();
        expect(getState('playback.failedTrackKeys').size).toBe(0);
      }
    },
  );

  it.each(['success', 'failure'] as const)(
    'starts ready B before superseded A native decode returns %s',
    async (outcome) => {
      let finishA!: (buffer: AudioBuffer) => void;
      let rejectA!: (error: Error) => void;
      const oldNativeDecode = new Promise<AudioBuffer>((resolve, reject) => {
        finishA = resolve;
        rejectA = reject;
      });
      const bufferA = { duration: 120 } as AudioBuffer;
      const bufferB = { duration: 120 } as AudioBuffer;
      const decode = vi
        .fn()
        .mockImplementationOnce(() => oldNativeDecode)
        .mockResolvedValue(bufferB);
      const start = vi.fn();
      const source = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        start,
        stop: vi.fn(),
        onended: null,
        buffer: null,
      };
      vi.spyOn(audioContext, 'getAudioContext').mockReturnValue({
        state: 'running',
        sampleRate: 48_000,
        currentTime: 10,
        decodeAudioData: decode,
        createBufferSource: () => source,
      } as unknown as AudioContext);

      let canonical = playback(null, 0);
      const getSnapshot = () =>
        ({
          roomCode: ROOM,
          playback: canonical,
          presence: { coordinatorEpoch: 1 },
        }) as ProRoomSnapshot;
      const reportReady = vi.fn().mockResolvedValue('waiting');
      const applied = vi.fn();
      bus.on('sync:diagnostic-pro-checkpoint', applied);
      controller = new ProRoomPlaybackController({
        isActive: () => true,
        getCanonicalSnapshot: getSnapshot,
        getPlaylistSnapshot: getSnapshot,
        capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
        isPlaylistLeaseCurrent: () => true,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: vi.fn().mockResolvedValue(undefined),
        reportPlaybackTransitionReady: reportReady,
        executePlaybackCommand: vi.fn(),
        recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
      });
      controller.startLifecycle();
      const prepare = (queueItemId: QueueItemId, revision: number) => {
        const transitionId = `native_${revision}`;
        controller!.acceptPrepare({
          type: 'pro-playback-prepare',
          transitionId,
          serverTimeMs: serverNow,
          deadlineAtMs: serverNow + 3_000,
          basePlaybackRevision: revision - 1,
          target: playback(queueItemId, revision),
        });
        return transitionId;
      };
      const commit = (queueItemId: QueueItemId, revision: number, transitionId: string) => {
        canonical = playback(queueItemId, revision);
        controller!.acceptCommit({
          type: 'pro-playback-commit',
          transitionId,
          serverTimeMs: serverNow,
          executeAtMs: serverNow,
          playback: canonical,
        });
      };

      const first = prepare(A, 1);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      const oldNativeReservation = memoryReservationStatsForTests().decodeBytes;
      expect(oldNativeReservation).toBeGreaterThan(0);
      // The server reaches its real rendezvous deadline while native A remains
      // in progress. That uncancellable work still owns its decode reservation.
      serverNow += 3_000;
      commit(A, 1, first);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const second = prepare(B, 2);
      try {
        await vi.waitFor(() =>
          expect(reportReady).toHaveBeenCalledWith(
            expect.objectContaining({ transitionId: second, status: 'ready' }),
          ),
        );
        expect(decode).toHaveBeenCalledTimes(2);
        expect(getCurrentAudioBuffer()).toBe(bufferB);
        expect(getState('files.current')?.queueItemId).toBe(B);
        expect(getState('playback.activity')).toBe('paused');
        expect(memoryReservationStatsForTests().decodeBytes).toBe(oldNativeReservation);
        // B has already passed native decode and memory admission. Only the old
        // controller wait can prevent this newer canonical commit from applying.
        commit(B, 2, second);
        await vi.waitFor(() =>
          expect(applied).toHaveBeenCalledWith(
            expect.objectContaining({ revision: 2, trackKey: B }),
          ),
        );
        expect(start).toHaveBeenCalledOnce();
        expect(getState('playback.activity')).toBe('playing');
        expect(getPlayerNode()).toBe(source);
        expect(memoryReservationStatsForTests().decodeBytes).toBe(oldNativeReservation);
      } finally {
        if (outcome === 'success') finishA(bufferA);
        else rejectA(new Error('Late native decoder failure for retired A'));
        await vi.waitFor(() =>
          expect(applied).toHaveBeenCalledWith(
            expect.objectContaining({ revision: 2, trackKey: B }),
          ),
        );
        expect(getCurrentAudioBuffer()).toBe(bufferB);
        expect(applied.mock.calls.every(([event]) => event.revision === 2)).toBe(true);
        await vi.waitFor(() => expect(memoryReservationStatsForTests().decodeBytes).toBe(0));
        expect(getState('playback.failedTrackKeys').size).toBe(0);
        expect(reportReady).toHaveBeenCalledOnce();
        expect(reportReady).toHaveBeenCalledWith(
          expect.objectContaining({ transitionId: second, status: 'ready' }),
        );
        expect(getState('playback.activity')).toBe('playing');
        expect(start).toHaveBeenCalledOnce();
      }
    },
  );
});
