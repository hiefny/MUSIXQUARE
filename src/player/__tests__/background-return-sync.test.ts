/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type RendezvousStatus =
  'started' | 'completed' | 'busy' | 'not-ready' | 'no-data' | 'awaiting-snapshot';

const mocks = vi.hoisted(() => ({
  proSync: vi.fn(),
  broadcast: vi.fn((_isManual?: boolean) => undefined),
  rendezvous: vi.fn(
    (_options?: {
      silent?: boolean;
      suppressProgressToast?: boolean;
      deferMissingHostSnapshot?: boolean;
    }): { status: RendezvousStatus; retryAfterMs?: number } => ({ status: 'started' }),
  ),
  zeroStartOwned: vi.fn(() => false),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestProRoomBackgroundReturnSync: mocks.proSync,
}));
vi.mock('../../youtube/sync.ts', () => ({
  broadcastYouTubeSync: mocks.broadcast,
  guestRendezvousSync: mocks.rendezvous,
}));
vi.mock('../../youtube/zero-start-ownership.ts', () => ({
  isYouTubeZeroStartSyncOwned: mocks.zeroStartOwned,
}));

import { initBackgroundResumeGuard } from '../../core/background-resume-guard.ts';
import { runBackgroundResumeRecovery } from '../../core/background-resume-recovery.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import type { TransportBackgroundRecoveryResult } from '../../network/transport/types.ts';
import type { PlaylistItem } from '../../types/index.ts';
import {
  isLocalYouTubePaused,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../../youtube/_state.ts';
import { initYouTubeNativeControlAuthority } from '../../youtube/native-control-authority.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { runBackgroundReturnSync } from '../background-return-sync.ts';
import { initLocalOutputRejoin } from '../local-output-rejoin.ts';
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackSystemAudioPlaying,
  setPlaybackYouTubePaused,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';

type Room = 'standard' | 'pro';
type Media = 'file' | 'youtube';
type Role = 'host' | 'guest';
type Activity = 'playing' | 'paused';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const hostConnection = { open: true };

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

function arrange(room: Room, media: Media, role: Role, activity: Activity): void {
  setState('setup.sessionStarted', true);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('network.sessionCode', room === 'pro' ? '000001' : '123456');
  if (room === 'pro') {
    // PRO endpoints are coordinator-free media engines with no host socket.
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: role === 'host' ? 'coordinator' : 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
  } else {
    setState('network.appRole', role);
    setState('network.hostConn', role === 'guest' ? (hostConnection as never) : null);
  }
  if (media === 'file') {
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    if (activity === 'playing') setPlaybackFilePlaying();
    else setPlaybackFilePaused();
  } else if (activity === 'playing') {
    setPlaybackYouTubePlaying();
  } else {
    setPlaybackYouTubePaused();
  }
}

interface ActionCounts {
  pro: number;
  hostBroadcast: number;
  guestRendezvous: number;
  guestFileResync: number;
}

let forceResync: Mock<(options?: { preserveClock?: boolean }) => void>;

function counts(): ActionCounts {
  return {
    pro: mocks.proSync.mock.calls.length,
    hostBroadcast: mocks.broadcast.mock.calls.length,
    guestRendezvous: mocks.rendezvous.mock.calls.length,
    guestFileResync: forceResync.mock.calls.length,
  };
}

const NONE: ActionCounts = { pro: 0, hostBroadcast: 0, guestRendezvous: 0, guestFileResync: 0 };

function expected(room: Room, media: Media, role: Role): ActionCounts {
  if (room === 'pro') return { ...NONE, pro: 1 };
  if (media === 'youtube') {
    return role === 'host' ? { ...NONE, hostBroadcast: 1 } : { ...NONE, guestRendezvous: 1 };
  }
  // A Standard host's Sync button has no room-wide file action.
  return role === 'host' ? NONE : { ...NONE, guestFileResync: 1 };
}

/** The app wiring: guard -> recovery -> background-return Sync. */
function installApp(
  options: {
    peerRecovery?: () => TransportBackgroundRecoveryResult;
    fileOutputOwned?: () => boolean | Promise<boolean>;
  } = {},
) {
  return initBackgroundResumeGuard({
    recover: ({ hiddenMs }) =>
      runBackgroundResumeRecovery(hiddenMs, {
        recoverPeer: (): TransportBackgroundRecoveryResult =>
          options.peerRecovery?.() ?? { status: 'not-applicable' },
        reacquireWakeLock: () => undefined,
        recoverAudio: async () => (await options.fileOutputOwned?.()) ?? false,
        syncRoom: ({ peer, audio }) => {
          runBackgroundReturnSync({ peerRecovery: peer, fileOutputOwned: audio === true });
        },
      }),
    warn: () => undefined,
    shouldHandle: () => true,
  });
}

const VIDEO_ID = 'abcdefghijk';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
}

/** A current guest iframe under the real native-control authority. */
function installGuestIframe(): FakePlayer {
  let state = 1;
  const player: FakePlayer = {
    get state() {
      return state;
    },
    set state(value: number) {
      state = value;
    },
    playVideo: () => {
      state = 1;
    },
    pauseVideo: () => {
      state = 2;
    },
    loadVideoById: () => {
      state = 1;
    },
    loadPlaylist: () => {
      state = 1;
    },
    cueVideoById: () => {
      state = 2;
    },
    cuePlaylist: () => {
      state = 2;
    },
    stopVideo: () => {
      state = 0;
    },
    destroy: () => undefined,
    seekTo: () => undefined,
    getCurrentTime: () => 42.25,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => 0,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [VIDEO_ID],
    setVolume: () => undefined,
  };
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
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
  return player;
}

/** The iframe reports PAUSED without an application pauseVideo call. */
function nativeIframePause(player: FakePlayer): void {
  player.state = 2;
  setPlaybackYouTubePaused();
}

/** The iframe reports PLAYING without an application playVideo call. */
function nativeIframePlay(player: FakePlayer): void {
  player.state = 1;
  setPlaybackYouTubePlaying();
}

/**
 * The real local-output rejoin router behind player.ts's resume branch, which
 * hands a local PLAY to it instead of calling playVideo early.
 */
function installLocalPlayRejoin(): void {
  initLocalOutputRejoin();
  bus.on('youtube:set-local-paused', (paused, reason) => {
    if (paused) return;
    bus.emit('playback:local-output-rejoin', {
      reason: reason ?? 'media-session-play',
      mode: 'youtube',
    });
  });
}

/** Rendezvous attempts by the return's chain, the only caller that defers. */
function chainAttempts(): number {
  return mocks.rendezvous.mock.calls.filter(
    ([options]) => options?.deferMissingHostSnapshot === true,
  ).length;
}

async function returnFromBackground(hiddenMs: number): Promise<void> {
  setVisibility('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(hiddenMs);
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
}

let guard: { dispose: () => void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.rendezvous.mockReturnValue({ status: 'started' });
  mocks.zeroStartOwned.mockReturnValue(false);
  forceResync = vi.fn();
  bus.on('sync:force-resync', forceResync);
  setVisibility('visible');
});

afterEach(() => {
  guard?.dispose();
  guard = null;
  clearManagedTimer('background-return-sync-rendezvous-retry');
  setCurrentAudioBuffer(null);
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  vi.useRealTimers();
});

describe('background-return Sync matrix', () => {
  const rooms: Room[] = ['standard', 'pro'];
  const medias: Media[] = ['file', 'youtube'];
  const roles: Role[] = ['host', 'guest'];
  const activities: Activity[] = ['playing', 'paused'];
  const cases = rooms.flatMap((room) =>
    medias.flatMap((media) =>
      roles.flatMap((role) => activities.map((activity) => ({ room, media, role, activity }))),
    ),
  );

  it.each(cases)(
    '$room $media $role $activity runs the Sync-button action exactly once per return',
    async ({ room, media, role, activity }) => {
      arrange(room, media, role, activity);
      guard = installApp();

      await returnFromBackground(5_000);
      await vi.advanceTimersByTimeAsync(10);

      const once = expected(room, media, role);
      expect(counts()).toEqual(once);
      if (once.hostBroadcast) expect(mocks.broadcast).toHaveBeenCalledWith(true);
      if (once.guestRendezvous) {
        expect(mocks.rendezvous).toHaveBeenCalledWith({
          silent: true,
          suppressProgressToast: true,
          deferMissingHostSnapshot: true,
        });
      }

      // A second, separate return performs the action once more.
      await returnFromBackground(5_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(counts()).toEqual({
        pro: once.pro * 2,
        hostBroadcast: once.hostBroadcast * 2,
        guestRendezvous: once.guestRendezvous * 2,
        guestFileResync: once.guestFileResync * 2,
      });
    },
  );

  it.each(rooms)('%s system audio performs no Sync on return', async (room) => {
    arrange(room, 'youtube', 'guest', 'playing');
    setPlaybackSystemAudioPlaying();
    guard = installApp();

    await returnFromBackground(5_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(counts()).toEqual(NONE);
  });

  it('ignores a sub-second visibility bounce that is not a background return', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    guard = installApp();

    await returnFromBackground(400);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(counts()).toEqual(NONE);
  });
});

describe('background-return Sync ownership and coalescing', () => {
  it('coalesces rapid hide/show while a return is still recovering into one follow-up', async () => {
    arrange('standard', 'file', 'guest', 'playing');
    let releaseAudio!: () => void;
    let audioCalls = 0;
    guard = installApp({
      fileOutputOwned: () => {
        audioCalls += 1;
        if (audioCalls > 1) return false;
        return new Promise<boolean>((resolve) => {
          releaseAudio = () => resolve(false);
        });
      },
    });

    await returnFromBackground(5_000);
    // Four more quick round trips land while the first recovery is pending.
    for (let index = 0; index < 4; index += 1) await returnFromBackground(1_500);
    expect(forceResync).not.toHaveBeenCalled();

    releaseAudio();
    await vi.advanceTimersByTimeAsync(10);

    // The first return, then exactly one coalesced follow-up.
    expect(forceResync).toHaveBeenCalledTimes(2);
    expect(audioCalls).toBe(2);
  });

  it('leaves local-file alignment to audio recovery that owns this return', async () => {
    arrange('standard', 'file', 'guest', 'playing');
    guard = installApp({ fileOutputOwned: () => true });

    await returnFromBackground(5_000);

    expect(forceResync).not.toHaveBeenCalled();

    arrange('pro', 'file', 'guest', 'playing');
    await returnFromBackground(5_000);
    expect(mocks.proSync).not.toHaveBeenCalled();
  });

  it('still syncs YouTube when the file-output owner flag is set by an unrelated dialog', () => {
    arrange('standard', 'youtube', 'guest', 'playing');

    expect(runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: true })).toBe(
      'guest-youtube-rendezvous',
    );
  });

  it('runs the guest rendezvous while the transport probes a long-hidden connection', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    // Every pre-suspension snapshot is stale: wait for the live heartbeat.
    mocks.rendezvous
      .mockReturnValueOnce({ status: 'awaiting-snapshot' })
      .mockReturnValueOnce({ status: 'awaiting-snapshot' })
      .mockReturnValue({ status: 'started' });
    guard = installApp({ peerRecovery: () => ({ status: 'monitoring' }) });

    await returnFromBackground(20_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.rendezvous).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(mocks.rendezvous).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.rendezvous).toHaveBeenCalledTimes(3);
  });

  it('stops a monitoring retry once the probe closes the stale host connection', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    mocks.rendezvous.mockReturnValue({ status: 'awaiting-snapshot' });
    guard = installApp({ peerRecovery: () => ({ status: 'monitoring' }) });

    await returnFromBackground(20_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    setState('network.hostConn', { open: false } as never);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it('hands a closed stale guest connection to the reconnect path', async () => {
    arrange('standard', 'file', 'guest', 'playing');
    guard = installApp({ peerRecovery: () => ({ status: 'stale-connection-closed' }) });

    await returnFromBackground(20_000);

    expect(forceResync).not.toHaveBeenCalled();
  });

  it('retries a busy or snapshot-less guest rendezvous on a bounded schedule', async () => {
    arrange('standard', 'youtube', 'guest', 'paused');
    mocks.rendezvous
      .mockReturnValueOnce({ status: 'busy', retryAfterMs: 1_200 })
      .mockReturnValueOnce({ status: 'no-data' })
      .mockReturnValue({ status: 'awaiting-snapshot' });
    guard = installApp();

    await returnFromBackground(5_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    // Busy honours the rendezvous cooldown it reports.
    await vi.advanceTimersByTimeAsync(1_199);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.rendezvous).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    // The first attempt plus five bounded retries.
    expect(mocks.rendezvous).toHaveBeenCalledTimes(6);
  });

  it('lets a local YouTube pause during the retry wait end the chain', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    const player = installGuestIframe();
    // The live heartbeat has not arrived yet, so the chain waits to retry.
    mocks.rendezvous.mockReturnValue({ status: 'awaiting-snapshot' });
    guard = installApp();

    await returnFromBackground(5_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    // The guest pauses from the lock screen, a media key or the iframe's own
    // controls before the next retry, and the heartbeat then arrives.
    nativeIframePause(player);
    expect(isLocalYouTubePaused()).toBe(true);
    mocks.rendezvous.mockReturnValue({ status: 'started' });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it('lets a lock-screen or media-key pause during the retry wait end the chain', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    mocks.rendezvous.mockReturnValue({ status: 'awaiting-snapshot' });
    guard = installApp();

    await returnFromBackground(5_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    // media-session.ts delivers a non-operator guest's PAUSE as this intent.
    bus.emit('youtube:set-local-paused', true);
    mocks.rendezvous.mockReturnValue({ status: 'started' });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it('lets a repeated local pause end the chain even while the pause bit is stale', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    const player = installGuestIframe();
    // For example the guest's own Sync played past an earlier local pause and
    // left the bit set. The return still aligns ...
    setLocalYouTubePaused(true);
    mocks.rendezvous.mockReturnValue({ status: 'awaiting-snapshot' });
    guard = installApp();

    await returnFromBackground(5_000);
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    // ... and a new pause during the wait still wins.
    nativeIframePause(player);
    mocks.rendezvous.mockReturnValue({ status: 'started' });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it('still aligns a guest whose hidden iframe the browser stopped while away', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    const player = installGuestIframe();
    guard = installApp();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    // WebKit stops the hidden iframe; nothing in the app called pauseVideo, so
    // the native-control route records it as a local pause.
    nativeIframePause(player);
    expect(isLocalYouTubePaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it.each(['iframe native PLAY', 'lock-screen PLAY'] as const)(
    'stale snapshot, guest presses PLAY (%s) while the local rejoin returns no-data, then the heartbeat arrives: the background chain still aligns',
    async (play) => {
      arrange('standard', 'youtube', 'guest', 'playing');
      const player = installGuestIframe();
      installLocalPlayRejoin();
      // Until the live heartbeat arrives the chain waits for it, and a local
      // PLAY's rejoin finds no fresh host time.
      mocks.rendezvous.mockImplementation((options) =>
        options?.deferMissingHostSnapshot ? { status: 'awaiting-snapshot' } : { status: 'no-data' },
      );
      guard = installApp();

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1_000);
      // WebKit stops the hidden iframe.
      nativeIframePause(player);
      await vi.advanceTimersByTimeAsync(29_000);
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(chainAttempts()).toBe(1);

      if (play === 'iframe native PLAY') {
        nativeIframePlay(player);
        // The native-control route pauses the iframe back and rejoins on the
        // resulting PAUSED callback.
        setPlaybackYouTubePaused();
      } else {
        // media-session.ts delivers a non-operator guest's PLAY as this request.
        bus.emit('youtube:set-local-paused', false, 'media-session-play');
      }
      await vi.advanceTimersByTimeAsync(0);
      // The rejoin found no fresh host time and put the local pause back.
      expect(mocks.rendezvous.mock.calls.length - chainAttempts()).toBe(1);
      expect(isLocalYouTubePaused()).toBe(true);

      mocks.rendezvous.mockReturnValue({ status: 'started' });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(chainAttempts()).toBe(2);
    },
  );

  it('still aligns a guest who held a local pause across the return', async () => {
    arrange('standard', 'youtube', 'guest', 'paused');
    setLocalYouTubePaused(true);
    guard = installApp();

    await returnFromBackground(5_000);
    await vi.advanceTimersByTimeAsync(10);

    // Owner decision 2026-10-20: every return aligns, whatever the play/pause
    // state; only a pause made after the return started ends its chain.
    expect(mocks.rendezvous).toHaveBeenCalledOnce();
  });

  it('replaces the previous return retry chain instead of stacking a second one', async () => {
    arrange('standard', 'youtube', 'guest', 'playing');
    mocks.rendezvous.mockReturnValue({ status: 'awaiting-snapshot' });

    // For example a return and its coalesced follow-up, both while visible.
    runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: false });
    await vi.advanceTimersByTimeAsync(100);
    runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: false });
    expect(mocks.rendezvous).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    // Two returns, but only the newer chain's five retries.
    expect(mocks.rendezvous).toHaveBeenCalledTimes(7);
  });

  it('skips YouTube while zero-start owns its synchronized warm-up', async () => {
    arrange('standard', 'youtube', 'host', 'playing');
    mocks.zeroStartOwned.mockReturnValue(true);

    expect(runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: false })).toBe('none');
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('does not run outside a started session or during the demo', () => {
    arrange('standard', 'file', 'guest', 'playing');
    setState('demo.active', true);
    expect(runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: false })).toBe('none');
    setState('demo.active', false);
    setState('setup.sessionStarted', false);
    expect(runBackgroundReturnSync({ peerRecovery: null, fileOutputOwned: false })).toBe('none');
    expect(forceResync).not.toHaveBeenCalled();
  });
});
