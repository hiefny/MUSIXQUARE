/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routeProPlaybackCommand: vi.fn(() => true),
  safeSend: vi.fn(() => true),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pro-room/playback-authority-hooks.ts')>()),
  routeProPlaybackCommand: mocks.routeProPlaybackCommand,
}));
vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: mocks.safeSend,
  sendToHost: vi.fn(() => true),
}));
// The rows that arm a real synchronization owner read a calibrated clock.
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
}));

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { initProtocol, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { STAGE2_RENDEZVOUS_BROADCAST_MS } from '../constants.ts';
import { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER } from '../local-offset.ts';
import { initYouTubeNativeControlAuthority } from '../native-control-authority.ts';
import { clearYouTubeStableControlExpectations } from '../native-control-origin.ts';
import { initYouTube, scheduleYtAutoSync, stopYouTubeMode } from '../player.ts';
import { guestRendezvousSync, initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface CallbackPlayer extends YouTubePlayerInstance {
  deliverState(state: number): void;
}

function createPlayer(): CallbackPlayer {
  let state = 1;
  let position = 42.25;
  // Plain functions are intentional: vi.fn player methods bypass production
  // native-control instrumentation. Commands also stay asynchronous, as the
  // IFrame API does; only a delivered callback changes its reported state.
  return {
    playVideo: () => undefined,
    pauseVideo: () => undefined,
    loadVideoById: () => undefined,
    loadPlaylist: () => undefined,
    cueVideoById: () => undefined,
    cuePlaylist: () => undefined,
    stopVideo: () => undefined,
    destroy: () => undefined,
    seekTo: (seconds) => {
      position = seconds;
    },
    getCurrentTime: () => position,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => -1,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [],
    setVolume: () => undefined,
    deliverState(next) {
      state = next;
      // Match iframe.ts projection: BUFFERING does not change activity;
      // PAUSED and PLAYING synchronously reach the native-authority listener.
      if (next === 2) setPlaybackYouTubePaused();
      if (next === 1) setPlaybackYouTubePlaying();
    },
  };
}

function installCurrentYouTube(player: CallbackPlayer, room: 'standard' | 'pro'): void {
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  if (room === 'pro') {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
  }
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: VIDEO_ID,
      playlistId: null,
    } as PlaylistItem,
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(true);
  setPlaybackYouTubePlaying();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  vi.clearAllMocks();
});

afterEach(() => {
  stopYouTubeMode({ silent: true });
  resetYouTubeSyncState();
  clearAllManagedTimers();
  vi.useRealTimers();
});

/** The player.ts and sync.ts wiring the real synchronization owners run on. */
function startSyncRuntime(): void {
  initYouTube();
  initYouTubeSync();
  initProtocol();
}

/** Turn the installed endpoint into an operator guest of a Standard room. */
function becomeOperatorGuest(): DataConnection {
  const hostConn = {
    peer: 'seek-feedback-host',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('network.isOperator', true);
  setState('network.standardRoomCapabilities', ['playback.control']);
  markQueueAuthorityReady(hostConn);
  resetInboundRateLimit(hostConn.peer);
  return hostConn;
}

function hostFrame(hostConn: DataConnection, type: string, frame: Record<string, unknown>): void {
  bus.emit(
    'network:data',
    {
      type,
      queueItemId: QUEUE_ITEM_ID,
      videoId: VIDEO_ID,
      subIndex: -1,
      hostClock: Date.now(),
      ...frame,
    },
    hostConn,
  );
}

describe('seek callback ownership at the native-control boundary', () => {
  it.each(['standard', 'pro'] as const)(
    'does not promote a PAUSED/PLAYING seek callback trace during a %s local nudge',
    (room) => {
      const player = createPlayer();
      installCurrentYouTube(player, room);
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 7_000);

      player.seekTo(42.35, true);
      vi.advanceTimersByTime(100);
      player.deliverState(3);
      vi.advanceTimersByTime(100);
      player.deliverState(2);
      vi.advanceTimersByTime(100);
      player.deliverState(1);

      expect(autoPlay).not.toHaveBeenCalled();
      expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
      expect(mocks.safeSend).not.toHaveBeenCalled();
    },
  );

  it('does not promote a seek PLAYING callback while a host rendezvous owns playback', () => {
    const player = createPlayer();
    installCurrentYouTube(player, 'standard');
    startSyncRuntime();
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    // The host's own seek arms the real rendezvous: its stage-2 wait
    // (STAGE2_RENDEZVOUS_BROADCAST_MS) owns playback for the rows below.
    scheduleYtAutoSync(45);

    player.pauseVideo();
    player.seekTo(45, true);
    vi.advanceTimersByTime(100);
    player.deliverState(2);
    expect(autoPlay).not.toHaveBeenCalled();
    // A PLAYING straggler during the seek-buffer window precedes the
    // scheduled playVideo. It is part of that operation, not a new OS PLAY.
    vi.advanceTimersByTime(100);
    player.deliverState(3);
    vi.advanceTimersByTime(100);
    player.deliverState(1);

    expect(autoPlay).not.toHaveBeenCalled();
  });

  // The nudge keeps a raw timer: PRE-4 stays a timer-name read.
  it.each([PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER])(
    'restores native PAUSE immediately after %s releases playback',
    (owner) => {
      const player = createPlayer();
      installCurrentYouTube(player, 'standard');
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      setManagedTimer(owner, () => undefined, 2_000);
      player.seekTo(42.35, true);
      player.deliverState(2);
      player.deliverState(1);
      expect(autoPlay).not.toHaveBeenCalled();

      clearManagedTimer(owner);
      player.deliverState(2);

      expect(autoPlay).toHaveBeenCalledExactlyOnceWith({
        targetTime: 42.35,
        skipSeek: false,
        zeroStart: false,
        state: 2,
      });
    },
  );

  it.each(['yt-auto-sync'])(
    'restores native PAUSE immediately after %s releases playback',
    async () => {
      const player = createPlayer();
      installCurrentYouTube(player, 'standard');
      startSyncRuntime();
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      // A Standard host seek: its stage-2 wait is the real 'yt-auto-sync' owner.
      scheduleYtAutoSync(42.35);
      player.seekTo(42.35, true);
      player.deliverState(2);
      player.deliverState(1);
      expect(autoPlay).not.toHaveBeenCalled();

      // The owner releases when its stage-2 precision frame has been sent.
      await vi.advanceTimersByTimeAsync(STAGE2_RENDEZVOUS_BROADCAST_MS);
      player.deliverState(2);

      expect(autoPlay).toHaveBeenCalledExactlyOnceWith({
        targetTime: 42.35,
        skipSeek: false,
        zeroStart: false,
        state: 2,
      });
    },
  );

  // These five owners run only on a Standard guest, so they arm through the
  // guest's own flows and a released native PAUSE reaches the host as the
  // operator guest's REQUEST_YOUTUBE_PAUSE (a host never holds them). The
  // flows' own pauseVideo, seekTo and playVideo leave stable-control records
  // that would read the callbacks below as programmatic whatever the owner
  // check answers, so each row clears them before its callbacks, and no
  // request of either kind may leave while the owner holds the iframe. The
  // released PAUSE is delivered once the owner has released and the 4 s
  // records of its commands have expired.
  it.each([
    'yt-clock-action',
    'yt-seek-play',
    'yt-rendezvous-buffer',
    'yt-rendezvous-play',
    'yt-rendezvous-calibrate',
  ] as const)('restores native PAUSE after %s has released playback', async (owner) => {
    const player = createPlayer();
    installCurrentYouTube(player, 'standard');
    const hostConn = becomeOperatorGuest();
    startSyncRuntime();
    const sent = () =>
      mocks.safeSend.mock.calls as unknown as Array<[DataConnection, { type: string }]>;
    const requestTypes = () =>
      sent()
        .map(([, frame]) => frame.type)
        .filter((type) => type.startsWith('request-'));
    if (owner === 'yt-clock-action') {
      hostFrame(hostConn, MSG.YOUTUBE_STATE, {
        state: 1,
        time: 42.35,
        hostPlayAt: Date.now() + 1_000,
      });
    } else if (owner === 'yt-seek-play') {
      hostFrame(hostConn, MSG.YOUTUBE_STATE, { state: 1, time: 42.35 });
    } else {
      hostFrame(hostConn, MSG.YOUTUBE_SYNC, { state: 1, time: 42.35 });
      expect(guestRendezvousSync({ silent: true }).status).toBe('started');
      if (owner !== 'yt-rendezvous-buffer') {
        // The iframe reports the rendezvous pause and the buffer gate opens.
        player.deliverState(2);
        await vi.advanceTimersByTimeAsync(60);
        if (owner === 'yt-rendezvous-calibrate') {
          await vi.advanceTimersByTimeAsync(1_500);
          player.deliverState(1);
        }
      }
    }
    // Only the owner check can hold these two callbacks now.
    clearYouTubeStableControlExpectations(player);
    player.deliverState(2);
    player.deliverState(1);
    expect(requestTypes()).toEqual([]);

    // Past the owner's release (a timed-out buffer gate owes one follow-up
    // rendezvous 3.25 s later) and every 4 s origin record of its commands.
    await vi.advanceTimersByTimeAsync(10_100);
    player.deliverState(2);

    expect(sent().filter(([, frame]) => frame.type.startsWith('request-'))).toEqual([
      [hostConn, { type: MSG.REQUEST_YOUTUBE_PAUSE, queueItemId: QUEUE_ITEM_ID }],
    ]);
  });

  it.each(['standard', 'pro'] as const)(
    'does not swallow a native %s PAUSE when a completed seek never emitted PAUSED',
    (room) => {
      const player = createPlayer();
      installCurrentYouTube(player, room);
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 500);
      player.seekTo(42.35, true);
      player.deliverState(3);
      player.deliverState(1);
      vi.advanceTimersByTime(500);

      player.deliverState(2);

      if (room === 'standard') {
        expect(autoPlay).toHaveBeenCalledOnce();
        expect(autoPlay.mock.calls[0][0].state).toBe(2);
      } else {
        expect(mocks.routeProPlaybackCommand).toHaveBeenCalledExactlyOnceWith(
          { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 42.35 },
          { wasPlaying: true },
        );
      }
    },
  );
});
