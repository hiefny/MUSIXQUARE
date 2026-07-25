#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


write(
    "src/youtube/native-control-policy.ts",
    r'''/** Pure routing policy for an iframe-native YouTube play/pause observation. */

export type NativeYouTubeMediaAction = 'play' | 'pause';
type NativeYouTubeControlRoute = 'standard-host-rejoin' | 'local-rejoin';

export interface NativeYouTubeControlContext {
  roomKind: 'standard' | 'pro';
  hasStandardHostConnection: boolean;
}

/**
 * Native OS/headphone controls never receive room authority.
 *
 * A standard host needs a small local self-heal because it has no external
 * authority endpoint to query. Every other participant can rejoin through the
 * standard host or the PRO server without publishing a room command.
 */
export function decideNativeYouTubeControlRoute(
  context: Readonly<NativeYouTubeControlContext>,
): NativeYouTubeControlRoute {
  if (context.roomKind === 'standard' && !context.hasStandardHostConnection) {
    return 'standard-host-rejoin';
  }
  return 'local-rejoin';
}
''',
)

write(
    "src/youtube/native-control-authority.ts",
    r'''/**
 * Repairs unowned YouTube iframe play/pause observations locally.
 *
 * iOS may route AirPods/lock-screen controls to the iframe's own media session
 * and never call the top-level navigator.mediaSession handler. These controls
 * are endpoint-output disturbances, not room commands: application buttons
 * retain the only path that can mutate room-wide playback.
 */

import type { PlaybackActivityValue } from '../core/constants.ts';
import { bus, createBusScope, type BusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { isPlaybackActivityValue } from '../player/ownership.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getYouTubePlayer,
  getYtAutoplayIntent,
  isYtIndexing,
  isYtLoadInProgress,
  isYtPrimeBouncePending,
  isYtPriming,
  setLocalYouTubePaused,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from './_state.ts';
import { toCanonicalYouTubeTime } from './local-offset.ts';
import {
  classifyYouTubeStableStateOrigin,
  clearYouTubeStableControlExpectations,
  expectYouTubeStableActivity,
  instrumentYouTubeStableControls,
  type YouTubeStableActivity,
} from './native-control-origin.ts';
import {
  decideNativeYouTubeControlRoute,
  type NativeYouTubeMediaAction,
} from './native-control-policy.ts';

const RECENT_NATIVE_ACTION_MS = 2_500;
const LOCAL_REJOIN_DELAY_MS = 250;
const LOCAL_REJOIN_TIMER = 'yt-native-control-local-rejoin';
const STANDARD_HOST_REJOIN_DELAY_MS = 250;
const STANDARD_HOST_SETTLE_MS = 1_000;

/**
 * Existing YouTube synchronization code treats this timer as the sole owner of
 * host-side transient iframe states. Reusing the key is intentional: it keeps
 * native recovery from leaking PAUSED/PLAYING observations to guests, and a
 * later in-app action atomically supersedes the recovery via last-action-wins.
 */
const STANDARD_HOST_SYNC_OWNER_TIMER = 'yt-auto-sync';

interface RecentNativeAction {
  action: NativeYouTubeMediaAction;
  queueItemId: QueueItemId;
  handledAt: number;
}

interface PendingLocalRejoin {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
}

interface PendingStandardHostRecovery {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
  videoId: string;
  canonicalActivity: YouTubeStableActivity;
  anchorPositionSeconds: number;
  anchorHostClockMs: number;
}

let scope: BusScope | null = null;
let previousActivity: PlaybackActivityValue = getState('playback.activity');
let recentNativeAction: RecentNativeAction | null = null;
let pendingLocalRejoin: PendingLocalRejoin | null = null;
let pendingStandardHostRecovery: PendingStandardHostRecovery | null = null;

function stableActivity(value: PlaybackActivityValue): YouTubeStableActivity | null {
  if (value === 'playing' || value === 'paused') return value;
  return null;
}

function mediaAction(activity: YouTubeStableActivity): NativeYouTubeMediaAction {
  return activity === 'playing' ? 'play' : 'pause';
}

function ensureCurrentPlayerInstrumented(): boolean {
  const player = getYouTubePlayer();
  if (!player) return false;
  const supported = instrumentYouTubeStableControls(player);
  if (!supported) {
    log.debug('[YouTube Native Control] Stable player methods are not instrumentable');
  }
  return supported;
}

function handlePlayerReady(): void {
  const player = getYouTubePlayer();
  if (!player || !ensureCurrentPlayerInstrumented()) return;
  expectYouTubeStableActivity(player, getYtAutoplayIntent() ? 'playing' : 'paused');
}

function hasProtectedTransitionOwner(): boolean {
  return isYtLoadInProgress() || isYtIndexing() || isYtPriming() || isYtPrimeBouncePending();
}

function resolveIntendedVideoId(queueItemId: QueueItemId): string | null {
  const item = getQueueItemById(queueItemId);
  if (!item || item.type !== 'youtube') return null;
  const subIndex = getState('youtube.currentSubIndex') ?? 0;
  if (item.playlistId) {
    const ids = getState('youtube.subItemsMap')?.[item.playlistId]?.ids;
    const subVideoId = ids?.[subIndex];
    if (subVideoId) return subVideoId;
    if (subIndex > 0) return null;
  }
  return item.videoId || null;
}

function readLiveVideoId(player: YouTubePlayerInstance): string {
  try {
    return player.getVideoData?.()?.video_id || '';
  } catch {
    return '';
  }
}

function playerMatchesCurrentOccurrence(
  player: YouTubePlayerInstance,
  queueItemId: QueueItemId,
): boolean {
  const liveVideoId = readLiveVideoId(player);
  const intendedVideoId = resolveIntendedVideoId(queueItemId);
  return !(liveVideoId && intendedVideoId && liveVideoId !== intendedVideoId);
}

function readCanonicalPosition(player: YouTubePlayerInstance): number {
  try {
    const current = player.getCurrentTime?.() || 0;
    const duration = player.getDuration?.() || 0;
    return toCanonicalYouTubeTime(current, duration);
  } catch {
    return 0;
  }
}

function clampPlayerPosition(player: YouTubePlayerInstance, seconds: number): number {
  const normalized = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  try {
    const duration = player.getDuration?.() || 0;
    if (duration > 0) return Math.min(normalized, Math.max(0, duration - 0.001));
  } catch {
    /* retain the non-negative value */
  }
  return normalized;
}

function rememberNativeAction(action: NativeYouTubeMediaAction, queueItemId: QueueItemId): void {
  recentNativeAction = { action, queueItemId, handledAt: Date.now() };
}

function flushPendingLocalRejoin(): void {
  const pending = pendingLocalRejoin;
  pendingLocalRejoin = null;
  clearManagedTimer(LOCAL_REJOIN_TIMER);
  if (!pending) return;
  if (
    getState('playback.mode') !== 'youtube' ||
    getCurrentQueueItemId() !== pending.queueItemId ||
    getYouTubePlayer() !== pending.player
  ) {
    return;
  }
  bus.emit('youtube:set-local-paused', false, 'media-session-play');
}

function queueLocalRejoin(player: YouTubePlayerInstance, queueItemId: QueueItemId): void {
  setLocalYouTubePaused(true);
  pendingLocalRejoin = { player, queueItemId };
  try {
    player.pauseVideo?.();
  } catch (error) {
    log.debug('[YouTube Native Control] Corrective local pause failed', error);
  }
  clearManagedTimer(LOCAL_REJOIN_TIMER);
  setManagedTimer(LOCAL_REJOIN_TIMER, flushPendingLocalRejoin, LOCAL_REJOIN_DELAY_MS);
}

function standardHostRecoveryStillCurrent(recovery: PendingStandardHostRecovery): boolean {
  const room = getRoomContext();
  return (
    pendingStandardHostRecovery === recovery &&
    room.kind === 'standard' &&
    getState('network.appRole') === 'host' &&
    !getState('network.hostConn') &&
    getState('playback.mode') === 'youtube' &&
    getCurrentQueueItemId() === recovery.queueItemId &&
    getYouTubePlayer() === recovery.player &&
    playerMatchesCurrentOccurrence(recovery.player, recovery.queueItemId)
  );
}

function performStandardHostRecovery(recovery: PendingStandardHostRecovery): void {
  if (!standardHostRecoveryStillCurrent(recovery)) {
    if (pendingStandardHostRecovery === recovery) pendingStandardHostRecovery = null;
    return;
  }

  // Clear the semantic owner before issuing wrapped API calls. Their resulting
  // stable transitions are programmatic and must not be mistaken for a second
  // native action. The short settle owner suppresses host broadcasts while the
  // iframe accepts pause/seek/play.
  pendingStandardHostRecovery = null;
  setManagedTimer(STANDARD_HOST_SYNC_OWNER_TIMER, () => undefined, STANDARD_HOST_SETTLE_MS);
  setLocalYouTubePaused(false);

  const player = recovery.player;
  try {
    if (recovery.canonicalActivity === 'playing') {
      const elapsedSeconds = Math.max(0, getHostNow() - recovery.anchorHostClockMs) / 1_000;
      const targetSeconds = clampPlayerPosition(
        player,
        recovery.anchorPositionSeconds + elapsedSeconds,
      );
      setYtAutoplayIntent(true);
      player.pauseVideo?.();
      player.seekTo?.(targetSeconds, true);
      player.playVideo?.();
      log.info('[YouTube Native Control] Standard host rejoined the running room timeline');
      return;
    }

    setYtAutoplayIntent(false);
    player.pauseVideo?.();
    player.seekTo?.(clampPlayerPosition(player, recovery.anchorPositionSeconds), true);
    log.info('[YouTube Native Control] Standard host restored the paused room state');
  } catch (error) {
    log.warn('[YouTube Native Control] Standard host local recovery failed', error);
  }
}

function queueStandardHostRecovery(
  player: YouTubePlayerInstance,
  queueItemId: QueueItemId,
  previous: YouTubeStableActivity,
): void {
  const now = getHostNow();
  const existing = pendingStandardHostRecovery;
  const sameExisting =
    existing?.player === player &&
    existing.queueItemId === queueItemId &&
    existing.videoId === readLiveVideoId(player);
  const canonicalActivity = sameExisting ? existing.canonicalActivity : previous;

  let anchorPositionSeconds = readCanonicalPosition(player);
  if (sameExisting) {
    anchorPositionSeconds = existing.anchorPositionSeconds;
    if (existing.canonicalActivity === 'playing') {
      anchorPositionSeconds = clampPlayerPosition(
        player,
        anchorPositionSeconds + Math.max(0, now - existing.anchorHostClockMs) / 1_000,
      );
    }
  }

  const recovery: PendingStandardHostRecovery = {
    player,
    queueItemId,
    videoId: readLiveVideoId(player),
    canonicalActivity,
    anchorPositionSeconds,
    anchorHostClockMs: now,
  };
  pendingStandardHostRecovery = recovery;
  setLocalYouTubePaused(true);

  // Arming this existing synchronization-owner key happens synchronously inside
  // the playback-state event, before iframe.ts reaches its host broadcast block.
  // The native PAUSED/PLAYING observation therefore remains endpoint-local.
  setManagedTimer(
    STANDARD_HOST_SYNC_OWNER_TIMER,
    () => performStandardHostRecovery(recovery),
    canonicalActivity === 'playing' ? STANDARD_HOST_REJOIN_DELAY_MS : 0,
  );
}

function routeNativeAction(
  player: YouTubePlayerInstance,
  action: NativeYouTubeMediaAction,
  previous: YouTubeStableActivity,
  queueItemId: QueueItemId,
): void {
  const room = getRoomContext();
  const route = decideNativeYouTubeControlRoute({
    roomKind: room.kind,
    hasStandardHostConnection: !!getState('network.hostConn'),
  });
  rememberNativeAction(action, queueItemId);

  if (route === 'standard-host-rejoin') {
    queueStandardHostRecovery(player, queueItemId, previous);
    log.info(`[YouTube Native Control] Kept standard-host ${action} endpoint-local`);
    return;
  }

  queueLocalRejoin(player, queueItemId);
  log.info(`[YouTube Native Control] Rejoining ${action} endpoint to room authority`);
}

function handlePlaybackActivity(nextActivity: unknown): void {
  if (!isPlaybackActivityValue(nextActivity)) return;
  const previous = stableActivity(previousActivity);
  previousActivity = nextActivity;
  const next = stableActivity(nextActivity);
  if (getState('playback.mode') !== 'youtube' || !previous || !next || previous === next) return;

  const player = getYouTubePlayer();
  const queueItemId = getCurrentQueueItemId();
  if (!player || !queueItemId) return;

  const origin = classifyYouTubeStableStateOrigin(player, next);
  if (origin === 'programmatic') {
    if (
      pendingStandardHostRecovery?.player === player &&
      pendingStandardHostRecovery.queueItemId === queueItemId
    ) {
      pendingStandardHostRecovery = null;
    }
    if (next === 'paused' && pendingLocalRejoin?.player === player) flushPendingLocalRejoin();
    return;
  }
  if (origin === 'unsupported' || hasProtectedTransitionOwner()) return;
  if (!playerMatchesCurrentOccurrence(player, queueItemId)) return;

  routeNativeAction(player, mediaAction(next), previous, queueItemId);
}

export function initYouTubeNativeControlAuthority(): void {
  scope?.dispose();
  scope = createBusScope();
  previousActivity = getState('playback.activity');
  recentNativeAction = null;
  pendingLocalRejoin = null;
  pendingStandardHostRecovery = null;
  clearManagedTimer(LOCAL_REJOIN_TIMER);

  scope.on('youtube:player-ready', handlePlayerReady);
  scope.on('state:playback.mode', () => {
    const player = getYouTubePlayer();
    if (getState('playback.mode') !== 'youtube') {
      clearYouTubeStableControlExpectations(player);
      pendingLocalRejoin = null;
      pendingStandardHostRecovery = null;
      recentNativeAction = null;
      clearManagedTimer(LOCAL_REJOIN_TIMER);
    } else {
      ensureCurrentPlayerInstrumented();
    }
    previousActivity = getState('playback.activity');
  });
  scope.on('state:playback.activity', handlePlaybackActivity);
  ensureCurrentPlayerInstrumented();
}

export function shouldIgnoreRecentNativeYouTubeMediaAction(
  action: NativeYouTubeMediaAction,
): boolean {
  const recent = recentNativeAction;
  if (!recent) return false;
  if (
    Date.now() - recent.handledAt > RECENT_NATIVE_ACTION_MS ||
    recent.queueItemId !== getCurrentQueueItemId()
  ) {
    recentNativeAction = null;
    return false;
  }
  return recent.action === action;
}
''',
)

write(
    "src/youtube/__tests__/native-control-policy.test.ts",
    r'''import { describe, expect, it } from 'vitest';

import { decideNativeYouTubeControlRoute } from '../native-control-policy.ts';

describe('native YouTube control routing policy', () => {
  it('gives a standard host a local self-rejoin path', () => {
    expect(
      decideNativeYouTubeControlRoute({
        roomKind: 'standard',
        hasStandardHostConnection: false,
      }),
    ).toBe('standard-host-rejoin');
  });

  it('keeps delegated standard-controller controls endpoint-local', () => {
    expect(
      decideNativeYouTubeControlRoute({
        roomKind: 'standard',
        hasStandardHostConnection: true,
      }),
    ).toBe('local-rejoin');
  });

  it('keeps every PRO participant control endpoint-local', () => {
    expect(
      decideNativeYouTubeControlRoute({
        roomKind: 'pro',
        hasStandardHostConnection: false,
      }),
    ).toBe('local-rejoin');
  });
});
''',
)

write(
    "src/youtube/__tests__/native-control-authority.test.ts",
    r'''/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { initYouTubeNativeControlAuthority } from '../native-control-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
  currentTime: number;
  playCalls: number;
  pauseCalls: number;
  seekCalls: number[];
}

function createPlayer(initialState = 1, initialTime = 42.25): FakePlayer {
  let state = initialState;
  let currentTime = initialTime;
  const player = {
    playCalls: 0,
    pauseCalls: 0,
    seekCalls: [] as number[],
    get state() {
      return state;
    },
    set state(value: number) {
      state = value;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    playVideo: () => {
      player.playCalls += 1;
      state = 1;
    },
    pauseVideo: () => {
      player.pauseCalls += 1;
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
    seekTo: (seconds: number) => {
      player.seekCalls.push(seconds);
      currentTime = seconds;
    },
    getCurrentTime: () => currentTime,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => 0,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [VIDEO_ID],
    setVolume: () => undefined,
  } as FakePlayer;
  return player;
}

function installCurrentYouTube(
  player: FakePlayer,
  activity: 'playing' | 'paused' = 'playing',
): void {
  const item = {
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: VIDEO_ID,
    playlistId: null,
  } as PlaylistItem;
  setState('setup.sessionStarted', true);
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(activity === 'playing');
  if (activity === 'playing') setPlaybackYouTubePlaying();
  else setPlaybackYouTubePaused();
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
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('iframe-native YouTube control recovery', () => {
  it('self-heals a standard-host native PAUSE without publishing room authority', () => {
    const player = createPlayer();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    installCurrentYouTube(player);
    const autoPlay = vi.fn();
    const localRejoin = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    bus.on('playback:local-output-rejoin', localRejoin);

    player.state = 2;
    setPlaybackYouTubePaused();

    expect(getManagedTimer('yt-auto-sync')).not.toBeNull();
    expect(autoPlay).not.toHaveBeenCalled();
    expect(localRejoin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(player.state).toBe(1);
    expect(player.playCalls).toBeGreaterThan(0);
    expect(player.seekCalls.at(-1)).toBeGreaterThan(42.25);
    expect(autoPlay).not.toHaveBeenCalled();
  });

  it('restores a paused standard room after an iframe-native PLAY', () => {
    const player = createPlayer(2);
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    installCurrentYouTube(player, 'paused');
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    player.state = 1;
    player.currentTime = 42.35;
    setPlaybackYouTubePlaying();
    vi.advanceTimersByTime(0);

    expect(player.state).toBe(2);
    expect(player.seekCalls.at(-1)).toBeCloseTo(42.35, 5);
    expect(autoPlay).not.toHaveBeenCalled();
  });

  it('rejoins a PRO controller locally instead of sending a room command', () => {
    const player = createPlayer();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
    installCurrentYouTube(player);
    const localRejoin = vi.fn();
    bus.on('playback:local-output-rejoin', localRejoin);

    player.state = 2;
    setPlaybackYouTubePaused();
    vi.advanceTimersByTime(250);

    expect(localRejoin).toHaveBeenCalledWith({
      reason: 'media-session-play',
      mode: 'youtube',
    });
  });

  it('rejoins a delegated standard controller locally', () => {
    const player = createPlayer();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host' } as never);
    setState('network.standardRoomCapabilities', ['playback.control']);
    installCurrentYouTube(player);
    const localRejoin = vi.fn();
    bus.on('playback:local-output-rejoin', localRejoin);

    player.state = 2;
    setPlaybackYouTubePaused();
    vi.advanceTimersByTime(250);

    expect(localRejoin).toHaveBeenCalledOnce();
  });

  it('does not treat an application-owned pauseVideo transition as native', () => {
    const player = createPlayer();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    installCurrentYouTube(player);
    const localRejoin = vi.fn();
    bus.on('playback:local-output-rejoin', localRejoin);

    player.pauseVideo();
    setPlaybackYouTubePaused();
    vi.advanceTimersByTime(500);

    expect(localRejoin).not.toHaveBeenCalled();
    expect(getManagedTimer('yt-auto-sync')).toBeNull();
  });
});
''',
)

replace_once(
    "public/service-worker.js",
    "const CACHE_VERSION = 'v277';",
    "const CACHE_VERSION = 'v278';",
    "service-worker cache version",
)
replace_once(
    "src/core/__tests__/service-worker-cache.test.ts",
    "const ACTIVE_CACHE_VERSION = 'v277';",
    "const ACTIVE_CACHE_VERSION = 'v278';",
    "service-worker test cache version",
)
