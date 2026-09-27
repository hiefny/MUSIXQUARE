/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as audioContext from '../../audio/context.ts';
import * as audioEngine from '../../audio/engine.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import * as systemAudioSfu from '../../network/pro-system-audio-sfu.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { stopAllMedia } from '../../player/transport.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  getYouTubePlayer,
  resetYouTubeModuleState,
  type YouTubePlayerInstance,
  type YTPlayerConfig,
} from '../../youtube/_state.ts';
import {
  makeFakeYtPlayer,
  type FakeYtPlayer,
} from '../../youtube/__tests__/__helpers__/fake-yt-player.ts';
import { initYouTube } from '../../youtube/player.ts';
import { ProRoomApiClient } from '../api.ts';
import type { ProRoomSnapshot } from '../contracts.ts';
import * as serverClock from '../network-bridge.ts';
import { resetProPlaybackAuthorityHooks } from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import {
  bindProSystemAudioSession,
  configureProSystemAudioService,
  getProSystemAudioViewState,
  refreshProSystemAudioState,
  resetProSystemAudioService,
} from '../system-audio-service.ts';

const ROOM_CODE = '000001';
const QUEUE_ITEM_ID = '43000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const SERVER_NOW = 10_000;
let controller: ProRoomPlaybackController | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetProPlaybackAuthorityHooks();
  resetYouTubeModuleState();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    epoch: 1,
    role: 'member',
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      videoId: VIDEO_ID,
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  vi.spyOn(audioEngine, 'initAudio').mockResolvedValue(undefined);
  vi.spyOn(audioContext, 'ensureRunning').mockResolvedValue(undefined);
  vi.spyOn(audioContext, 'getCurrentTime').mockReturnValue(10);
  vi.spyOn(serverClock, 'getProRoomServerNow').mockReturnValue(SERVER_NOW);
  // Prototype spying is intentional: the service keeps its first API instance
  // across session resets, just as the production runtime does.
  vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
    generation: 1,
    status: 'live',
    ownerParticipantId: 'participant_00002',
    claimExpiresAt: null,
    liveExpiresAt: Date.now() + 60_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'session_000000001',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
  });
  // The SFU has not delivered a track yet. Test the real trusted receiving
  // placeholder and renderer ownership, not native WebRTC/audio behavior.
  vi.spyOn(systemAudioSfu, 'subscribeProSystemAudioSfu').mockResolvedValue(undefined);
  vi.spyOn(systemAudioSfu, 'stopProSystemAudioSfuSubscriber').mockImplementation(() => {});
  document.body.innerHTML = '<div class="video-wrapper"></div>';
  vi.stubGlobal('YT', {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: class {
      constructor(_id: string, options: YTPlayerConfig) {
        const player = makeFakeYtPlayer({
          __videoId: options.videoId || VIDEO_ID,
          __duration: 180,
          __state: 5,
          __advanceClock: true,
          __autoPlayOnLoad: true,
          __onStateChange: options.events
            ?.onStateChange as unknown as FakeYtPlayer['__onStateChange'],
        });
        queueMicrotask(() => {
          options.events?.onReady?.({ target: player as unknown as YouTubePlayerInstance });
          options.events?.onStateChange?.({
            target: player as unknown as YouTubePlayerInstance,
            data: 5,
          });
        });
        return player as unknown as this;
      }
    },
  });
  initPlaylist();
  initYouTube();
});

afterEach(() => {
  controller?.stopLifecycle();
  controller = null;
  resetProSystemAudioService();
  stopAllMedia({ cancelInFlight: true, silent: true });
  resetProPlaybackAuthorityHooks();
  resetYouTubeModuleState();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native YouTube adapter during PRO live-share join restoration', () => {
  it.each([false, true])(
    'keeps the receiving placeholder when initial clock completion is delayed=%s',
    async (delayedClock) => {
      const playback = {
        coordinatorEpoch: 1,
        revision: 1,
        state: 'playing' as const,
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 37.5,
        youtubeVideoId: VIDEO_ID,
        youtubeSubIndex: 0,
        updatedAtMs: SERVER_NOW,
      };
      // These ports supply an already accepted snapshot. The companion runtime
      // regression exercises HTTP/session validation and actual joinProRoom.
      const snapshot = {
        roomCode: ROOM_CODE,
        status: 'active',
        playback,
        viewer: {
          participantId: 'participant_00001',
          presenceIncarnationId: 'presence_0000000001',
        },
        presence: {
          coordinatorEpoch: 1,
          participants: [
            { participantId: 'participant_00001', displayName: 'Joining listener' },
            { participantId: 'participant_00002', displayName: 'Sharing owner' },
          ],
        },
        playlist: [
          {
            queueItemId: QUEUE_ITEM_ID,
            name: 'Video',
            source: { kind: 'youtube', videoId: VIDEO_ID },
          },
        ],
      } as ProRoomSnapshot;
      let calibrated = !delayedClock;
      let resolveClock!: (ready: boolean) => void;
      const clock = new Promise<boolean>((resolve) => {
        resolveClock = resolve;
      });
      vi.spyOn(serverClock, 'isProRoomServerClockCalibrated').mockImplementation(() => calibrated);
      vi.spyOn(serverClock, 'waitForFreshProRoomServerClockCalibration').mockImplementation(
        () => clock,
      );
      configureProSystemAudioService(new ProRoomApiClient());
      bindProSystemAudioSession(snapshot);
      const executeCommand = vi.fn().mockResolvedValue({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'unchanged',
        transition: null,
        playback,
        serverTimeMs: SERVER_NOW,
      });
      controller = new ProRoomPlaybackController({
        isActive: () => true,
        getCanonicalSnapshot: () => snapshot,
        getPlaylistSnapshot: () => snapshot,
        capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM_CODE }),
        isPlaylistLeaseCurrent: () => true,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: vi.fn().mockResolvedValue(undefined),
        reportPlaybackTransitionReady: vi.fn(),
        executePlaybackCommand: executeCommand,
        recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
      });
      controller.startLifecycle();
      const restoring = controller.restorePersistedPlayback(snapshot);
      if (!delayedClock) {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(getYouTubePlayer()?.getPlayerState()).toBe(1);
      }
      await refreshProSystemAudioState();
      expect(getProSystemAudioViewState().phase).toBe('live');
      expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('receiving');
      expect(getYouTubePlayer()).toBeNull();

      calibrated = true;
      resolveClock(true);
      await restoring;
      await vi.advanceTimersByTimeAsync(3_000);

      expect(getProSystemAudioViewState().phase).toBe('live');
      expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('receiving');
      expect(getYouTubePlayer()).toBeNull();
      // Receiving server state never requires the listener to create a room
      // playback command, regardless of whether playback was locally prepared.
      expect(executeCommand).not.toHaveBeenCalled();
    },
  );
});
