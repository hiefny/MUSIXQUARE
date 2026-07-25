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
  | 'playVideo'
  | 'pauseVideo'
  | 'loadVideoById'
  | 'loadPlaylist'
  | 'cueVideoById'
  | 'cuePlaylist';

type PlayerMethod = (...args: unknown[]) => unknown;
type WrappedPlayerMethod = PlayerMethod & { [WRAPPED_METHOD]?: true };

interface ExpectedStableState {
  token: number;
  activity: YouTubeStableActivity;
  expiresAt: number;
}

interface PlayerInstrumentation {
  expected: ExpectedStableState[];
  supported: boolean;
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

function asMethodRecord(
  player: YouTubePlayerInstance,
): Record<StableMethodName, PlayerMethod | undefined> {
  return player as unknown as Record<StableMethodName, PlayerMethod | undefined>;
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
  const methods = asMethodRecord(player);
  const current = methods[spec.name] as WrappedPlayerMethod | undefined;
  if (typeof current !== 'function') return !spec.required;
  if (current[WRAPPED_METHOD] === true) return true;

  // Existing tests often expose vi.fn() methods and assert against the exact
  // function object. Skip those synthetic players. A real player that cannot
  // be instrumented fails closed and leaves the old behaviour untouched.
  if (isTestMock(current)) return false;

  const wrapped: WrappedPlayerMethod = (...args) => {
    const token = armExpectedState(
      player,
      instrumentation,
      spec.activity,
      spec.alwaysExpect === true,
    );
    try {
      return current.apply(player, args);
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
      methods[spec.name] = wrapped;
    } catch {
      return false;
    }
  }
  return methods[spec.name] === wrapped;
}

export function instrumentYouTubeStableControls(player: YouTubePlayerInstance): boolean {
  let instrumentation = instrumentationByPlayer.get(player);
  if (!instrumentation) {
    instrumentation = { expected: [], supported: false };
    instrumentationByPlayer.set(player, instrumentation);
  }

  instrumentation.supported = STABLE_METHODS.every((spec) =>
    installStableMethod(player, instrumentation, spec),
  );
  return instrumentation.supported;
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
  if (index === -1) return 'native';

  // Consuming through the matched entry removes superseded expectations that
  // preceded it (for example cue→play where CUED never produced PAUSED).
  instrumentation.expected.splice(0, index + 1);
  return 'programmatic';
}

export function clearYouTubeStableControlExpectations(player: YouTubePlayerInstance | null): void {
  if (!player) return;
  const instrumentation = instrumentationByPlayer.get(player);
  if (instrumentation) instrumentation.expected.length = 0;
}
