/**
 * Tracks whether a stable YouTube iframe state came from a MUSIXQUARE API call.
 *
 * iOS can route AirPods and lock-screen controls to the iframe's own media
 * session without invoking the top-level page handler. Application-owned player
 * methods are instrumented once; a later stable state with no matching expected
 * transition is therefore an iframe-native observation.
 */

import type { YouTubePlayerInstance } from './_state.ts';

export type YouTubeStableActivity = 'playing' | 'paused';
type YouTubeStableStateOrigin = 'programmatic' | 'native' | 'unsupported';
type StableMethodName =
  'playVideo' | 'pauseVideo' | 'loadVideoById' | 'loadPlaylist' | 'cueVideoById' | 'cuePlaylist';

type PlayerMethod = (...args: unknown[]) => unknown;

interface ExpectedStableState {
  token: number;
  activity: YouTubeStableActivity;
  expiresAt: number;
}

interface PlayerInstrumentation {
  expected: ExpectedStableState[];
  supported: boolean;
  seekSupported: boolean;
  revision: number;
  seek: {
    target: number;
    state: number;
    videoId: string;
    expiresAt: number;
    deadlineAt: number;
    buffering: boolean;
  } | null;
  seekCallback: YouTubeStableActivity | null;
}

interface StableMethodSpec {
  name: StableMethodName;
  activity: YouTubeStableActivity;
  required: boolean;
  alwaysExpect?: boolean;
}

const WRAPPED_METHOD = Symbol('musixquare.youtube.stable-control-wrapper');
const EXPECTED_STATE_TTL_MS = 4_000;
const MAX_EXPECTED_STATES = 12;
// A bare seek has no completion promise. Stable target feedback releases it
// immediately; this bound also releases silent/failed provider operations.
const SEEK_OWNERSHIP_MS = 1_000;
const SEEK_FEEDBACK_DEADLINE_MS = 4_000;
const STABLE_METHODS: readonly StableMethodSpec[] = [
  { name: 'playVideo', activity: 'playing', required: true },
  { name: 'pauseVideo', activity: 'paused', required: true },
  { name: 'loadVideoById', activity: 'playing', required: true, alwaysExpect: true },
  { name: 'loadPlaylist', activity: 'playing', required: true, alwaysExpect: true },
  { name: 'cueVideoById', activity: 'paused', required: false, alwaysExpect: true },
  { name: 'cuePlaylist', activity: 'paused', required: true, alwaysExpect: true },
];
const instrumentationByPlayer = new WeakMap<YouTubePlayerInstance, PlayerInstrumentation>();
let expectedStateSequence = 0;

function isTestMock(fn: unknown): boolean {
  return typeof fn === 'function' && Reflect.get(fn, '_isMockFunction') === true;
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
    const targetState = activity === 'playing' ? 1 : 2;
    return player.getPlayerState?.() !== targetState;
  } catch {
    return true;
  }
}

function armExpectedState(
  player: YouTubePlayerInstance,
  instrumentation: PlayerInstrumentation,
  activity: YouTubeStableActivity,
  alwaysExpect = false,
): number | null {
  if (!alwaysExpect && !shouldArmExpectation(player, activity)) return null;
  const token = ++expectedStateSequence;
  pruneExpected(instrumentation);
  instrumentation.expected.push({
    token,
    activity,
    expiresAt: Date.now() + EXPECTED_STATE_TTL_MS,
  });
  return token;
}

function installStableMethod(
  player: YouTubePlayerInstance,
  instrumentation: PlayerInstrumentation,
  spec: StableMethodSpec,
): boolean {
  const current: unknown = Reflect.get(player, spec.name);
  if (typeof current !== 'function') return !spec.required;
  if (Reflect.get(current, WRAPPED_METHOD) === true) return true;

  // Existing tests often expose vi.fn() methods and assert against the exact
  // function object. Skip those synthetic players. A real player that cannot
  // be instrumented fails closed and leaves the old behaviour untouched.
  if (isTestMock(current)) return false;

  const wrapped: PlayerMethod = (...args) => {
    instrumentation.revision += 1;
    if (spec.alwaysExpect) instrumentation.seek = null;
    const token = armExpectedState(
      player,
      instrumentation,
      spec.activity,
      spec.alwaysExpect === true,
    );
    try {
      return Reflect.apply(current, player, args);
    } catch (error) {
      if (token !== null) removeExpectedToken(instrumentation, token);
      throw error;
    }
  };
  Object.defineProperty(wrapped, WRAPPED_METHOD, { value: true });

  const descriptor = Object.getOwnPropertyDescriptor(player, spec.name);
  try {
    Object.defineProperty(player, spec.name, {
      value: wrapped,
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: descriptor?.writable ?? true,
    });
  } catch {
    try {
      if (!Reflect.set(player, spec.name, wrapped)) return false;
    } catch {
      return false;
    }
  }
  return Reflect.get(player, spec.name) === wrapped;
}

export function instrumentYouTubeStableControls(player: YouTubePlayerInstance): boolean {
  let instrumentation = instrumentationByPlayer.get(player);
  if (!instrumentation) {
    instrumentation = {
      expected: [],
      supported: false,
      seekSupported: false,
      revision: 0,
      seek: null,
      seekCallback: null,
    };
    instrumentationByPlayer.set(player, instrumentation);
  }

  instrumentation.supported = STABLE_METHODS.every((spec) =>
    installStableMethod(player, instrumentation, spec),
  );
  instrumentation.seekSupported =
    instrumentation.supported && installSeekMethod(player, instrumentation);
  return instrumentation.supported;
}

function installSeekMethod(player: YouTubePlayerInstance, owner: PlayerInstrumentation): boolean {
  const original = player.seekTo;
  if (typeof original !== 'function' || isTestMock(original)) return false;
  if (Reflect.get(original, WRAPPED_METHOD)) return true;
  const wrapped = (target: number, allowSeekAhead: boolean): void => {
    owner.revision += 1;
    owner.seekCallback = null;
    owner.seek = null;
    try {
      const expected = owner.expected[owner.expected.length - 1]?.activity;
      const state = expected ? (expected === 'playing' ? 1 : 2) : player.getPlayerState?.();
      const position = player.getCurrentTime?.();
      if (Number.isFinite(target) && Number.isFinite(position)) {
        owner.seek = {
          target,
          state,
          videoId: player.getVideoData?.()?.video_id || '',
          expiresAt: performance.now() + SEEK_OWNERSHIP_MS,
          deadlineAt: performance.now() + SEEK_FEEDBACK_DEADLINE_MS,
          buffering: false,
        };
      }
      Reflect.apply(original, player, [target, allowSeekAhead]);
    } catch (error) {
      owner.seek = null;
      throw error;
    }
  };
  Object.defineProperty(wrapped, WRAPPED_METHOD, { value: true });
  // The IFrame API exposes writable own methods. Do not break a provider
  // facade that deliberately disallows instrumentation.
  try {
    return Reflect.set(player, 'seekTo', wrapped) && player.seekTo === wrapped;
  } catch {
    return false;
  }
}

export function canObserveYouTubeNativeSeek(player: YouTubePlayerInstance): boolean {
  return instrumentationByPlayer.get(player)?.seekSupported === true;
}

export function getYouTubeControlRevision(player: YouTubePlayerInstance): number {
  return instrumentationByPlayer.get(player)?.revision ?? 0;
}

export function isYouTubeProgrammaticSeekPending(player: YouTubePlayerInstance): boolean {
  const owner = instrumentationByPlayer.get(player);
  if (!owner?.seek) return false;
  if (
    performance.now() > owner.seek.deadlineAt ||
    player.getVideoData?.()?.video_id !== owner.seek.videoId
  ) {
    owner.seek = null;
  }
  if (!owner.seek) return false;
  // A buffering provider still owns its unfinished seek. A silent stable
  // provider releases after one second so a subsequent real PAUSE works.
  return performance.now() <= owner.seek.expiresAt || owner.seek.buffering;
}

/** Called for every raw provider state, including PLAYING→PLAYING. Preserve
 * this callback's origin even when it completes and releases the operation. */
export function observeYouTubeProgrammaticSeekState(
  player: YouTubePlayerInstance,
  state: number,
): boolean {
  const owner = instrumentationByPlayer.get(player);
  if (!owner) return false;
  owner.seekCallback = null;
  if (!isYouTubeProgrammaticSeekPending(player)) {
    // Late BUFFERING at the issued target is further operation evidence,
    // unlike an isolated PAUSED that could be a fresh user action. Reattach
    // only within the original absolute deadline; never refresh it forever.
    if (!owner.seek || state !== 3 || Math.abs(player.getCurrentTime() - owner.seek.target) > 1)
      return false;
    owner.seek.expiresAt = Math.min(performance.now() + SEEK_OWNERSHIP_MS, owner.seek.deadlineAt);
  }
  const seek = owner.seek!;
  if (state === 3) seek.buffering = true;
  if (state === 1 || state === 2) {
    owner.seekCallback = state === 1 ? 'playing' : 'paused';
    if (
      (state === seek.state || ![1, 2].includes(seek.state)) &&
      Math.abs(player.getCurrentTime() - seek.target) <= 1
    )
      owner.seek = null;
  }
  return true;
}

/** Arm the initial state expected from a newly-ready iframe instance. */
export function expectYouTubeStableActivity(
  player: YouTubePlayerInstance,
  activity: YouTubeStableActivity,
): boolean {
  if (!instrumentYouTubeStableControls(player)) return false;
  const instrumentation = instrumentationByPlayer.get(player);
  if (!instrumentation) return false;
  armExpectedState(player, instrumentation, activity);
  return true;
}

export function classifyYouTubeStableStateOrigin(
  player: YouTubePlayerInstance,
  activity: YouTubeStableActivity,
): YouTubeStableStateOrigin {
  if (!instrumentYouTubeStableControls(player)) return 'unsupported';
  const instrumentation = instrumentationByPlayer.get(player);
  if (!instrumentation?.supported) return 'unsupported';

  pruneExpected(instrumentation);
  const index = instrumentation.expected.findIndex((entry) => entry.activity === activity);
  if (index === -1) return instrumentation.seekCallback === activity ? 'programmatic' : 'native';

  // Consuming through the matched entry removes superseded expectations that
  // preceded it (for example cue→play where CUED never produced PAUSED).
  instrumentation.expected.splice(0, index + 1);
  return 'programmatic';
}

export function clearYouTubeStableControlExpectations(player: YouTubePlayerInstance | null): void {
  if (!player) return;
  const instrumentation = instrumentationByPlayer.get(player);
  if (instrumentation) {
    instrumentation.expected.length = 0;
    instrumentation.seek = null;
    instrumentation.seekCallback = null;
    instrumentation.revision += 1;
  }
}
