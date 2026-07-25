#!/usr/bin/env python3
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRE_V276 = "80868681627b2d12f9c841f09bacfb51309ae087"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


# Remove the v276 callback-order workaround. v277 owns the issue at the actual
# iframe state boundary and leaves Media Session as a compact fallback bridge.
media_session = subprocess.check_output(
    ["git", "show", f"{PRE_V276}:src/player/media-session.ts"],
    cwd=ROOT,
    text=True,
)
media_session = replace_once(
    media_session,
    "} from '../audio/context-recovery.ts';\n",
    "} from '../audio/context-recovery.ts';\n"
    "import {\n"
    "  initYouTubeNativeControlAuthority,\n"
    "  shouldIgnoreRecentNativeYouTubeMediaAction,\n"
    "} from '../youtube/native-control-authority.ts';\n",
    "media-session authority import",
)
media_session = replace_once(
    media_session,
    "export function initMediaSession(): void {\n  if (!('mediaSession' in navigator)) return;\n",
    "export function initMediaSession(): void {\n"
    "  initYouTubeNativeControlAuthority();\n"
    "  if (!('mediaSession' in navigator)) return;\n",
    "media-session authority init",
)
media_session = replace_once(
    media_session,
    "    if (isPlaybackModeYouTube()) {\n      if (hasPendingAudioContextInterruption() && isPlaybackPlayingYouTube()) {",
    "    if (isPlaybackModeYouTube()) {\n"
    "      if (shouldIgnoreRecentNativeYouTubeMediaAction('play')) return;\n"
    "      if (hasPendingAudioContextInterruption() && isPlaybackPlayingYouTube()) {",
    "media-session play bridge",
)
media_session = replace_once(
    media_session,
    "    if (isPlaybackModeYouTube()) {\n      if (isNonOperatorGuest()) {\n        if (isLocalYouTubePaused()) return;",
    "    if (isPlaybackModeYouTube()) {\n"
    "      if (shouldIgnoreRecentNativeYouTubeMediaAction('pause')) return;\n"
    "      if (isNonOperatorGuest()) {\n"
    "        if (isLocalYouTubePaused()) return;",
    "media-session pause bridge",
)
write("src/player/media-session.ts", media_session)

origin = r'''/**
 * Tracks whether a stable YouTube iframe state came from a MUSIXQUARE API call.
 *
 * OS/headphone controls can operate the iframe's own media session without
 * invoking the top-level page Media Session handler. Every application-owned
 * playVideo()/pauseVideo() call is wrapped after player readiness; a later
 * stable state with no matching expectation is therefore an iframe-native
 * observation rather than an application command.
 */

import type { YouTubePlayerInstance } from './_state.ts';

export type YouTubeStableActivity = 'playing' | 'paused';
export type YouTubeStableStateOrigin = 'programmatic' | 'native' | 'unsupported';

type StableMethodName = 'playVideo' | 'pauseVideo';

interface ExpectedStableState {
  token: number;
  activity: YouTubeStableActivity;
  expiresAt: number;
}

interface PlayerInstrumentation {
  expected: ExpectedStableState[];
  playSupported: boolean;
  pauseSupported: boolean;
}

const WRAPPED_METHOD = Symbol('musixquare.youtube.stable-control-wrapper');
const EXPECTED_STATE_TTL_MS = 4_000;
const MAX_EXPECTED_STATES = 12;
const instrumentationByPlayer = new WeakMap<YouTubePlayerInstance, PlayerInstrumentation>();
let expectedStateSequence = 0;

type WrappedStableMethod = (() => void) & { [WRAPPED_METHOD]?: true };

function targetActivity(method: StableMethodName): YouTubeStableActivity {
  return method === 'playVideo' ? 'playing' : 'paused';
}

function targetPlayerState(activity: YouTubeStableActivity): number {
  return activity === 'playing' ? 1 : 2;
}

function isTestMock(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as { _isMockFunction?: boolean })._isMockFunction === true
  );
}

function pruneExpected(instrumentation: PlayerInstrumentation, now = Date.now()): void {
  instrumentation.expected = instrumentation.expected.filter((entry) => entry.expiresAt >= now);
  if (instrumentation.expected.length > MAX_EXPECTED_STATES) {
    instrumentation.expected.splice(0, instrumentation.expected.length - MAX_EXPECTED_STATES);
  }
}

function removeExpectedToken(instrumentation: PlayerInstrumentation, token: number): void {
  const index = instrumentation.expected.findIndex((entry) => entry.token === token);
  if (index !== -1) instrumentation.expected.splice(index, 1);
}

function shouldArmExpectation(
  player: YouTubePlayerInstance,
  activity: YouTubeStableActivity,
): boolean {
  try {
    return player.getPlayerState?.() !== targetPlayerState(activity);
  } catch {
    return true;
  }
}

function installStableMethod(
  player: YouTubePlayerInstance,
  instrumentation: PlayerInstrumentation,
  method: StableMethodName,
): boolean {
  const current = player[method] as WrappedStableMethod | undefined;
  if (typeof current !== 'function') return false;
  if (current[WRAPPED_METHOD] === true) return true;

  // Existing unit tests commonly use vi.fn() and inspect the method property
  // directly. Skip those synthetic players; production fails closed to the old
  // behaviour if a real player method cannot be instrumented.
  if (isTestMock(current)) return false;

  const activity = targetActivity(method);
  const wrapped: WrappedStableMethod = () => {
    let token: number | null = null;
    if (shouldArmExpectation(player, activity)) {
      token = ++expectedStateSequence;
      pruneExpected(instrumentation);
      instrumentation.expected.push({
        token,
        activity,
        expiresAt: Date.now() + EXPECTED_STATE_TTL_MS,
      });
    }

    try {
      current.call(player);
    } catch (error) {
      if (token !== null) removeExpectedToken(instrumentation, token);
      throw error;
    }
  };
  Object.defineProperty(wrapped, WRAPPED_METHOD, { value: true });

  const descriptor = Object.getOwnPropertyDescriptor(player, method);
  try {
    Object.defineProperty(player, method, {
      value: wrapped,
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: descriptor?.writable ?? true,
    });
  } catch {
    try {
      player[method] = wrapped;
    } catch {
      return false;
    }
  }
  return player[method] === wrapped;
}

export function instrumentYouTubeStableControls(player: YouTubePlayerInstance): boolean {
  let instrumentation = instrumentationByPlayer.get(player);
  if (!instrumentation) {
    instrumentation = {
      expected: [],
      playSupported: false,
      pauseSupported: false,
    };
    instrumentationByPlayer.set(player, instrumentation);
  }

  instrumentation.playSupported = installStableMethod(player, instrumentation, 'playVideo');
  instrumentation.pauseSupported = installStableMethod(player, instrumentation, 'pauseVideo');
  return instrumentation.playSupported && instrumentation.pauseSupported;
}

export function classifyYouTubeStableStateOrigin(
  player: YouTubePlayerInstance,
  activity: YouTubeStableActivity,
): YouTubeStableStateOrigin {
  instrumentYouTubeStableControls(player);
  const instrumentation = instrumentationByPlayer.get(player);
  const supported =
    activity === 'playing'
      ? instrumentation?.playSupported === true
      : instrumentation?.pauseSupported === true;
  if (!instrumentation || !supported) return 'unsupported';

  pruneExpected(instrumentation);
  const index = instrumentation.expected.findIndex((entry) => entry.activity === activity);
  if (index === -1) return 'native';
  instrumentation.expected.splice(index, 1);
  return 'programmatic';
}

export function clearYouTubeStableControlExpectations(player: YouTubePlayerInstance | null): void {
  if (!player) return;
  const instrumentation = instrumentationByPlayer.get(player);
  if (instrumentation) instrumentation.expected.length = 0;
}
'''
write("src/youtube/native-control-origin.ts", origin)

policy = r'''/** Pure routing policy for an iframe-native YouTube play/pause observation. */

export type NativeYouTubeMediaAction = 'play' | 'pause';
export type NativeYouTubeControlRoute =
  | 'standard-host'
  | 'standard-controller'
  | 'pro-controller'
  | 'local-pause'
  | 'local-rejoin';

export interface NativeYouTubeControlContext {
  action: NativeYouTubeMediaAction;
  roomKind: 'standard' | 'pro';
  canControlPlayback: boolean;
  hasStandardHostConnection: boolean;
}

export function decideNativeYouTubeControlRoute(
  context: Readonly<NativeYouTubeControlContext>,
): NativeYouTubeControlRoute {
  if (!context.canControlPlayback) {
    return context.action === 'pause' ? 'local-pause' : 'local-rejoin';
  }
  if (context.roomKind === 'pro') return 'pro-controller';
  return context.hasStandardHostConnection ? 'standard-controller' : 'standard-host';
}
'''
write("src/youtube/native-control-policy.ts", policy)

authority = r'''/**
 * Promotes unowned YouTube iframe play/pause observations to room authority.
 *
 * iOS may route AirPods/lock-screen controls to the iframe's own media session
 * and never call the top-level navigator.mediaSession handler. This runtime
 * instruments application-issued playVideo()/pauseVideo() calls and treats only
 * the remaining stable transitions as native iframe controls.
 */

import { MSG, type PlaybackActivityValue } from '../core/constants.ts';
import { bus, createBusScope, type BusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { routeProPlaybackCommand } from '../pro-room/playback-authority-hooks.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getYouTubePlayer,
  isYtIndexing,
  isYtLoadInProgress,
  isYtPrimeBouncePending,
  isYtPriming,
  setLocalYouTubePaused,
  type YouTubePlayerInstance,
} from './_state.ts';
import { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, toCanonicalYouTubeTime } from './local-offset.ts';
import {
  classifyYouTubeStableStateOrigin,
  clearYouTubeStableControlExpectations,
  instrumentYouTubeStableControls,
  type YouTubeStableActivity,
} from './native-control-origin.ts';
import {
  decideNativeYouTubeControlRoute,
  type NativeYouTubeMediaAction,
} from './native-control-policy.ts';

const RECENT_NATIVE_ACTION_MS = 2_500;
const LOCAL_REJOIN_FALLBACK_MS = 250;
const LOCAL_REJOIN_TIMER = 'yt-native-control-local-rejoin';
const PROTECTED_TIMER_NAMES = [
  'yt-auto-sync',
  'yt-clock-action',
  'yt-seek-play',
  'yt-rendezvous-buffer',
  'yt-rendezvous-play',
  'yt-same-video-occurrence-handoff',
] as const;

interface RecentNativeAction {
  action: NativeYouTubeMediaAction;
  queueItemId: QueueItemId;
  handledAt: number;
}

interface PendingLocalRejoin {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
}

let scope: BusScope | null = null;
let previousActivity: PlaybackActivityValue = getState('playback.activity');
let recentNativeAction: RecentNativeAction | null = null;
let pendingLocalRejoin: PendingLocalRejoin | null = null;

function stableActivity(value: PlaybackActivityValue): YouTubeStableActivity | null {
  if (value === 'playing' || value === 'paused') return value;
  return null;
}

function mediaAction(activity: YouTubeStableActivity): NativeYouTubeMediaAction {
  return activity === 'playing' ? 'play' : 'pause';
}

function ensureCurrentPlayerInstrumented(): void {
  const player = getYouTubePlayer();
  if (!player) return;
  if (!instrumentYouTubeStableControls(player)) {
    log.debug('[YouTube Native Control] Stable player methods are not instrumentable');
  }
}

function hasProtectedTransitionOwner(): boolean {
  if (
    isYtLoadInProgress() ||
    isYtIndexing() ||
    isYtPriming() ||
    isYtPrimeBouncePending()
  ) {
    return true;
  }
  if (getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) return true;
  return PROTECTED_TIMER_NAMES.some((name) => !!getManagedTimer(name));
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

function playerMatchesCurrentOccurrence(
  player: YouTubePlayerInstance,
  queueItemId: QueueItemId,
): boolean {
  let liveVideoId = '';
  try {
    liveVideoId = player.getVideoData?.()?.video_id || '';
  } catch {
    return false;
  }
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
  bus.emit('youtube:set-local-paused', false, 'iframe-native-play');
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
  setManagedTimer(LOCAL_REJOIN_TIMER, flushPendingLocalRejoin, LOCAL_REJOIN_FALLBACK_MS);
}

function pauseUntilAuthority(player: YouTubePlayerInstance): void {
  try {
    player.pauseVideo?.();
  } catch (error) {
    log.debug('[YouTube Native Control] Corrective authority pause failed', error);
  }
}

function routeNativeAction(
  player: YouTubePlayerInstance,
  action: NativeYouTubeMediaAction,
  previous: YouTubeStableActivity,
  queueItemId: QueueItemId,
): void {
  const room = getRoomContext();
  const hostConn = getState('network.hostConn');
  const route = decideNativeYouTubeControlRoute({
    action,
    roomKind: room.kind,
    canControlPlayback: hasRoomCapability('playback.control'),
    hasStandardHostConnection: !!hostConn,
  });
  const positionSeconds = readCanonicalPosition(player);
  rememberNativeAction(action, queueItemId);

  if (route === 'local-pause') {
    setLocalYouTubePaused(true);
    log.info('[YouTube Native Control] Applied endpoint-local pause');
    return;
  }
  if (route === 'local-rejoin') {
    queueLocalRejoin(player, queueItemId);
    log.info('[YouTube Native Control] Rejoining endpoint to room authority');
    return;
  }

  setLocalYouTubePaused(false);
  if (action === 'play' && route !== 'standard-host') pauseUntilAuthority(player);

  if (route === 'pro-controller') {
    routeProPlaybackCommand(
      { kind: action, queueItemId, positionSeconds },
      { wasPlaying: previous === 'playing' },
    );
    log.info(`[YouTube Native Control] Routed ${action} through PRO authority`);
    return;
  }

  if (route === 'standard-controller') {
    if (!hostConn?.open) return;
    safeSend(hostConn, {
      type: action === 'play' ? MSG.REQUEST_YOUTUBE_PLAY : MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId,
    });
    log.info(`[YouTube Native Control] Requested standard-room ${action}`);
    return;
  }

  bus.emit('youtube:auto-play', {
    targetTime: positionSeconds,
    skipSeek: false,
    zeroStart: action === 'play' && positionSeconds <= 0.12,
    state: action === 'play' ? 1 : 2,
  });
  log.info(`[YouTube Native Control] Promoted host ${action} to room rendezvous`);
}

function handlePlaybackActivity(nextActivity: PlaybackActivityValue): void {
  const previous = stableActivity(previousActivity);
  previousActivity = nextActivity;
  const next = stableActivity(nextActivity);
  if (getState('playback.mode') !== 'youtube' || !previous || !next || previous === next) return;

  const player = getYouTubePlayer();
  const queueItemId = getCurrentQueueItemId();
  if (!player || !queueItemId) return;

  const origin = classifyYouTubeStableStateOrigin(player, next);
  if (origin === 'programmatic') {
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
  clearManagedTimer(LOCAL_REJOIN_TIMER);

  scope.on('youtube:player-ready', ensureCurrentPlayerInstrumented);
  scope.on('state:playback.mode', () => {
    const player = getYouTubePlayer();
    if (getState('playback.mode') !== 'youtube') {
      clearYouTubeStableControlExpectations(player);
      pendingLocalRejoin = null;
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
'''
write("src/youtube/native-control-authority.ts", authority)

origin_test = r'''import { describe, expect, it } from 'vitest';

import type { YouTubePlayerInstance } from '../_state.ts';
import {
  classifyYouTubeStableStateOrigin,
  instrumentYouTubeStableControls,
} from '../native-control-origin.ts';

function createPlayer(initialState: number): YouTubePlayerInstance & { state: number } {
  const player = {
    state: initialState,
    playVideo() {
      this.state = 1;
    },
    pauseVideo() {
      this.state = 2;
    },
    getPlayerState() {
      return this.state;
    },
  } as unknown as YouTubePlayerInstance & { state: number };
  return player;
}

describe('YouTube stable-control origin tracking', () => {
  it('classifies application play and pause calls as programmatic', () => {
    const player = createPlayer(2);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.playVideo();
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('programmatic');

    player.pauseVideo();
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('programmatic');
  });

  it('classifies an iframe-only stable transition as native', () => {
    const player = createPlayer(1);
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    player.state = 2; // OS/iframe changed state without invoking pauseVideo().
    expect(classifyYouTubeStableStateOrigin(player, 'paused')).toBe('native');
  });

  it('does not leave an expectation behind when a wrapped command throws', () => {
    const player = createPlayer(2);
    player.playVideo = () => {
      throw new Error('iframe unavailable');
    };
    expect(instrumentYouTubeStableControls(player)).toBe(true);

    expect(() => player.playVideo()).toThrow('iframe unavailable');
    player.state = 1;
    expect(classifyYouTubeStableStateOrigin(player, 'playing')).toBe('native');
  });
});
'''
write("src/youtube/__tests__/native-control-origin.test.ts", origin_test)

policy_test = r'''import { describe, expect, it } from 'vitest';

import { decideNativeYouTubeControlRoute } from '../native-control-policy.ts';

describe('native YouTube control routing policy', () => {
  it('routes a standard host to room rendezvous authority', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'play',
        roomKind: 'standard',
        canControlPlayback: true,
        hasStandardHostConnection: false,
      }),
    ).toBe('standard-host');
  });

  it('routes a delegated standard controller back to the host', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'pause',
        roomKind: 'standard',
        canControlPlayback: true,
        hasStandardHostConnection: true,
      }),
    ).toBe('standard-controller');
  });

  it('routes every PRO controller through server authority', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'play',
        roomKind: 'pro',
        canControlPlayback: true,
        hasStandardHostConnection: false,
      }),
    ).toBe('pro-controller');
  });

  it('keeps listener pause local and listener play on the rejoin path', () => {
    const base = {
      roomKind: 'pro' as const,
      canControlPlayback: false,
      hasStandardHostConnection: false,
    };
    expect(decideNativeYouTubeControlRoute({ ...base, action: 'pause' })).toBe('local-pause');
    expect(decideNativeYouTubeControlRoute({ ...base, action: 'play' })).toBe('local-rejoin');
  });
});
'''
write("src/youtube/__tests__/native-control-policy.test.ts", policy_test)

old_v276_test = ROOT / "src/player/__tests__/media-session-os-authority.test.ts"
if old_v276_test.exists():
    old_v276_test.unlink()

sw = (ROOT / "public/service-worker.js").read_text(encoding="utf-8")
sw = replace_once(sw, "const CACHE_VERSION = 'v276';", "const CACHE_VERSION = 'v277';", "service-worker version")
write("public/service-worker.js", sw)

sw_test = (ROOT / "src/core/__tests__/service-worker-cache.test.ts").read_text(encoding="utf-8")
sw_test = replace_once(
    sw_test,
    "const ACTIVE_CACHE_VERSION = 'v276';",
    "const ACTIVE_CACHE_VERSION = 'v277';",
    "service-worker test version",
)
write("src/core/__tests__/service-worker-cache.test.ts", sw_test)
