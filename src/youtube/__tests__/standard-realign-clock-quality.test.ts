/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import {
  getClockOffset,
  processSyncPong,
  registerPing,
  resetClockState,
} from '../../network/shared-clock.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { setLocalYouTubePaused, setYouTubePlayer } from '../_state.ts';
import {
  RENDEZVOUS_MARGIN_SEC,
  STANDARD_AUTO_REALIGN_COOLDOWN_MS,
  STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE,
} from '../constants.ts';
import { guestRendezvousSync, initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import { makeFakeYtPlayer, mutationOps, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const harness = vi.hoisted(() => ({
  android: false,
  handlers: {} as Record<string, (data: Record<string, unknown>, conn?: DataConnection) => void>,
}));
vi.mock('../../core/platform.ts', async (original) => ({
  ...(await original<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return harness.android;
  },
}));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  isRemoteGuest: () => false,
}));
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: (handlers: Record<string, unknown>) =>
    Object.assign(harness.handlers, handlers),
}));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (seconds: number) => String(seconds) }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));

const BASE = 1_700_000_000_000;
const Q = '88888888-8888-4888-8888-888888888888';
const VIDEO = 'QUALITY_VID';
let elapsed = 0;
let mono = 0;
let ping = 0;
let starts = 0;
let hostStep = 0;
let host: DataConnection;
let player: FakeYtPlayer;

function advance(ms: number): void {
  const startWall = Date.now();
  const startElapsed = elapsed;
  const startMono = mono;
  vi.spyOn(performance, 'now').mockImplementation(() => startMono + Date.now() - startWall);
  vi.advanceTimersByTime(ms);
  elapsed = startElapsed + ms;
  mono = startMono + ms;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
}

/** Host wall time and the media timeline continue independently of local wall edits. */
function trueHostNow(): number {
  return BASE + elapsed + hostStep;
}

function sample(upMs = 2, downMs = 2): void {
  const hostSentAt = trueHostNow();
  registerPing(++ping);
  advance(upMs + downMs);
  expect(processSyncPong(ping, hostSentAt + upMs)).not.toBeNull();
}

function heartbeat(trueDriftMs = 0, extra: Record<string, unknown> = {}): void {
  const position = 30 + elapsed / 1000;
  // A delivered frame is one second old, while the iframe remains aligned
  // with true host time. A fresh frame would hit projection's nonnegative
  // elapsed clamp and conceal a negative clock bias rather than reproduce it.
  const frameAgeMs = 1000;
  player.__currentTime = position + (harness.android ? 0.25 : 0) + trueDriftMs / 1000;
  harness.handlers[MSG.YOUTUBE_SYNC](
    {
      queueItemId: Q,
      videoId: VIDEO,
      subIndex: -1,
      time: position - frameAgeMs / 1000,
      state: 1,
      hostClock: trueHostNow() - frameAgeMs,
      ...extra,
    },
    host,
  );
}

function freshHeartbeat(driftMs = 0): void {
  sample();
  heartbeat(driftMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  elapsed = mono = ping = starts = hostStep = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  localStorage.removeItem('musixquare-yt-play-latency');
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetClockState();
  vi.mocked(log.error).mockClear();
  harness.android = false;
  host = {
    peer: 'quality-host',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('playlist.items', [
    { queueItemId: Q, type: 'youtube', name: 'Quality', videoId: VIDEO, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q);
  setPlaybackYouTubePlaying();
  setLocalYouTubePaused(false);
  player = makeFakeYtPlayer({ __state: 1, __currentTime: 30, __duration: 900, __videoId: VIDEO });
  setYouTubePlayer(player as never);
  initYouTubeSync();
  resetYouTubeSyncState();
  bus.on('youtube:sync-loading', (loading, owner) => {
    if (loading && owner === 'rendezvous') starts++;
  });
  for (let i = 0; i < 3; i++) sample();
});

afterEach(() => {
  expect(log.error).not.toHaveBeenCalled();
  resetYouTubeSyncState();
  setYouTubePlayer(null);
  clearAllManagedTimers();
  resetClockState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('automatic precision with real clock uncertainty', () => {
  it.each([false, true])(
    'sustained asymmetric queueing beyond 120 seconds does not interrupt aligned playback (Android %s)',
    (android) => {
      harness.android = android;
      // 100/700ms asymmetry yields -300ms midpoint error once the good samples
      // reach their 120s age bound. Keep going beyond it.
      for (let i = 0; i < 190; i++) {
        sample(100, 700);
        advance(200);
        if (i % 3 === 0) heartbeat();
      }
      expect(elapsed).toBeGreaterThan(120_000);
      expect(getClockOffset()).toBe(-300);
      expect(starts).toBe(0);
      expect(mutationOps(player)).toEqual([]);
    },
  );

  it.each([-400, 400])(
    'preserves genuine %ims drift correction with a fresh precise clock',
    (drift) => {
      freshHeartbeat(drift);
      expect(starts).toBe(0);
      advance(3000);
      freshHeartbeat(drift);
      expect(starts).toBe(1);
      advance(RENDEZVOUS_MARGIN_SEC * 1000);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
    },
  );

  it.each([
    { drift: 149, expected: 0 },
    { drift: 151, expected: 1 },
    { drift: -149, expected: 0 },
    { drift: -151, expected: 1 },
  ])('preserves the existing trigger with a precise clock: $drift ms', ({ drift, expected }) => {
    // RTT4 => U=7; the existing 150ms trigger dominates 2U=14.
    freshHeartbeat(drift);
    advance(3000);
    freshHeartbeat(drift);
    expect(starts).toBe(expected);
  });

  it.each([
    { drift: 250, expected: 0 },
    { drift: 251, expected: 1 },
    { drift: -250, expected: 0 },
    { drift: -251, expected: 1 },
  ])('requires strict improvement at the 2U boundary: $drift ms', ({ drift, expected }) => {
    resetClockState();
    sample(120, 120); // U=125ms; equality at 2U cannot guarantee improvement.
    heartbeat(drift);
    advance(3000);
    sample(120, 120);
    heartbeat(drift);
    expect(starts).toBe(expected);
  });

  it('does not spend a pause when drift evidence exceeds U but not 2U', () => {
    resetClockState();
    sample(400, 400);
    heartbeat(700);
    advance(3000);
    sample(400, 400);
    heartbeat(700);
    expect(starts).toBe(0);
    expect(mutationOps(player)).toEqual([]);
  });

  it('still corrects sufficiently large genuine drift with a high but symmetric RTT', () => {
    resetClockState();
    sample(400, 400);
    heartbeat(1200);
    advance(3000);
    sample(400, 400);
    heartbeat(1200);
    expect(starts).toBe(1);
  });

  it('does not carry a confirmation across clock epochs', () => {
    freshHeartbeat(400);
    advance(1000);
    resetClockState();
    sample();
    heartbeat(400);
    expect(starts).toBe(0);
    advance(3000);
    freshHeartbeat(400);
    expect(starts).toBe(1);
  });

  it('does not confuse a corroborated remote clock step with media drift', () => {
    freshHeartbeat(400);
    advance(1000);
    hostStep = 3000;
    sample();
    expect(getClockOffset()).toBe(3000);
    heartbeat(400);
    expect(starts).toBe(0);
    advance(3000);
    freshHeartbeat(400);
    expect(starts).toBe(1);
  });

  it('does not carry a confirmation across a changed selected offset', () => {
    freshHeartbeat(400);
    advance(1000);
    // New equal-RTT sample selects +8ms without changing the clock epoch.
    registerPing(++ping);
    const sent = trueHostNow();
    advance(4);
    expect(processSyncPong(ping, sent + 10)).not.toBeNull();
    expect(getClockOffset()).toBe(8);
    heartbeat(400);
    expect(starts).toBe(0);
    advance(1000);
    heartbeat(400);
    expect(starts).toBe(1);
  });

  it('starts confirmation over after stale replies, then recovers with fresh samples', () => {
    freshHeartbeat(400);
    advance(5001);
    heartbeat(400);
    expect(starts).toBe(0);
    advance(1000);
    sample();
    heartbeat(400);
    expect(starts).toBe(0);
    advance(3000);
    freshHeartbeat(400);
    expect(starts).toBe(1);
  });

  it.each([-1000, 1000])(
    'rebases a local %ims wall-clock step before admitting fresh genuine drift',
    (step) => {
      freshHeartbeat(400);
      vi.setSystemTime(Date.now() + step);
      heartbeat(400);
      expect(starts).toBe(0);
      sample();
      expect(getClockOffset()).toBe(-step);
      heartbeat();
      expect(starts).toBe(0);
      advance(1000);
      freshHeartbeat(400);
      expect(starts).toBe(0);
      advance(3000);
      freshHeartbeat(400);
      expect(starts).toBe(1);
    },
  );

  it.each([true, false])(
    'does not reuse a pre-sleep confirmation (monotonic advances %s)',
    (monotonicAdvances) => {
      freshHeartbeat(400);
      if (monotonicAdvances) advance(30_000);
      else {
        elapsed += 30_000;
        vi.setSystemTime(Date.now() + 30_000);
      }
      heartbeat(400);
      expect(starts).toBe(0);
      // A new better precise exchange is independent of the slept interval.
      advance(1000);
      sample(1, 1);
      heartbeat(400);
      expect(starts).toBe(0);
      advance(3000);
      sample(1, 1);
      heartbeat(400);
      expect(starts).toBe(1);
    },
  );

  it('rejected quality samples do not consume the per-occurrence automatic budget', () => {
    for (let i = 0; i < 190; i++) {
      sample(100, 700);
      advance(200);
      if (i % 3 === 0) heartbeat();
    }
    expect(starts).toBe(0);
    advance(1000);
    for (let i = 0; i < STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE; i++) {
      freshHeartbeat(400);
      advance(3000);
      freshHeartbeat(400);
      expect(starts).toBe(i + 1);
      advance(STANDARD_AUTO_REALIGN_COOLDOWN_MS);
    }
    freshHeartbeat(400);
    advance(3000);
    freshHeartbeat(400);
    expect(starts).toBe(STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE);
    expect(getManagedTimer('yt-rendezvous-follow-up')).toBeNull();
  });

  it('does not gate explicit user Sync on automatic-correction quality', () => {
    resetClockState();
    sample(400, 400);
    heartbeat(700);
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    expect(starts).toBe(1);
  });

  it('does not gate host PAUSE or state recovery on automatic-correction quality', () => {
    resetClockState();
    sample(400, 400);
    heartbeat(0, { state: 2 });
    expect(player.__state).toBe(2);
    heartbeat();
    expect(player.__state).toBe(1);
    expect(starts).toBe(0);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'playVideo']);
  });

  it('does not change the separate coarse seek policy for drift over three seconds', () => {
    resetClockState();
    sample(400, 400);
    heartbeat(4000);
    expect(mutationOps(player)).toEqual(['seekTo']);
    expect(starts).toBe(0);
  });
});
