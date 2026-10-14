/**
 * @vitest-environment jsdom
 *
 * Standard-room guest re-alignment without user action.
 *
 *   - A precision rendezvous whose buffer gate times out falls back to a plain
 *     pause/seek/play. That start is late by YouTube's own seek->play latency,
 *     so the guest owes itself exactly one silent follow-up rendezvous.
 *   - Host heartbeats projected through their `hostClock` expose small, stable
 *     drift that the 3s corrective seek ignores. Two consecutive same-sign
 *     samples above 150ms earn one silent rendezvous, bounded by a cooldown
 *     and a per-occurrence budget.
 *
 * Real sync.ts, managed timers, state and bus. The fake iframe's media clock
 * follows fake time, and the shared clock tracks Date.now().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { showToast } from '../../ui/toast.ts';
import type { DataConnection } from '../../types/index.ts';
import { setLocalYouTubePaused, setYouTubePlayer } from '../_state.ts';
import {
  HEARTBEAT_INTERVAL_MS,
  MANUAL_RENDEZVOUS_RETRY_MAX_MS,
  MANUAL_RENDEZVOUS_RETRY_MS,
  RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS,
  RENDEZVOUS_BUFFER_DEADLINE_OFFSET_MS,
  RENDEZVOUS_DRIFT_SUPPRESS_MS,
  RENDEZVOUS_MARGIN_SEC,
  RENDEZVOUS_SNAPSHOT_MAX_AGE_MS,
  STANDARD_AUTO_REALIGN_COOLDOWN_MS,
  STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE,
  STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS,
} from '../constants.ts';
import {
  cancelGuestRendezvous,
  guestRendezvousSync,
  initYouTubeSync,
  invalidateGuestYouTubeTimeline,
  resetYouTubeSyncState,
} from '../sync.ts';
import { makeFakeYtPlayer, mutationOps, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const harness = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: Record<string, unknown>, conn?: DataConnection) => void>,
  clockCalibrated: true,
  zeroStartActive: false,
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
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => harness.clockCalibrated,
}));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (seconds: number) => String(seconds) }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));
vi.mock('../zero-start.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../zero-start.ts')>()),
  isYouTubeZeroStartProtocolActive: () => harness.zeroStartActive,
}));

const Q = '44444444-4444-4444-8444-444444444444';
const SECOND_Q = '55555555-5555-4555-8555-555555555555';
const VIDEO = 'REALIGN_VID';
const FOLLOW_UP_TIMER = 'yt-rendezvous-follow-up';
/** First buffer poll after the gate deadline (the 1.5s margin minus its 150ms offset). */
const GATE_TIMEOUT_MS =
  RENDEZVOUS_MARGIN_SEC * 1000 -
  RENDEZVOUS_BUFFER_DEADLINE_OFFSET_MS +
  RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS;

let host: DataConnection;
let rendezvousStarts = 0;

function connection(peer: string): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  localStorage.removeItem('musixquare-yt-play-latency');
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(showToast).mockClear();
  harness.clockCalibrated = true;
  harness.zeroStartActive = false;
  host = connection('realign-host');
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState(
    'playlist.items',
    [Q, SECOND_Q].map((queueItemId) => ({
      queueItemId,
      type: 'youtube',
      name: 'Realign video',
      videoId: VIDEO,
      playlistId: null,
    })),
  );
  setState('playlist.currentQueueItemId', Q);
  setPlaybackYouTubePlaying();
  initYouTubeSync();
  resetYouTubeSyncState();
  rendezvousStarts = 0;
  bus.on('youtube:sync-loading', (loading, owner) => {
    if (loading && owner === 'rendezvous') rendezvousStarts += 1;
  });
});

afterEach(() => {
  resetYouTubeSyncState();
  setYouTubePlayer(null);
  clearAllManagedTimers();
  vi.useRealTimers();
});

function installGuest({ position = 30, duration = 300 } = {}): FakeYtPlayer {
  const player = makeFakeYtPlayer({
    __state: 1,
    __currentTime: position,
    __duration: duration,
    __videoId: VIDEO,
    __advanceClock: true,
  });
  setYouTubePlayer(player as never);
  return player;
}

function heartbeat(time: number, frame: Record<string, unknown> = {}): void {
  harness.handlers[MSG.YOUTUBE_SYNC](
    {
      queueItemId: Q,
      time,
      state: 1,
      videoId: VIDEO,
      subIndex: -1,
      hostClock: Date.now(),
      ...frame,
    },
    host,
  );
}

/** A PLAYING heartbeat whose host position sits `driftSec` behind (+) or ahead of (-) this guest. */
function heartbeatWithDrift(
  player: FakeYtPlayer,
  driftSec: number,
  frame: Record<string, unknown> = {},
): number {
  const hostTime = player.getCurrentTime() - driftSec;
  heartbeat(hostTime, frame);
  return hostTime;
}

function hostStateFrame(frame: Record<string, unknown>): void {
  harness.handlers[MSG.YOUTUBE_STATE](
    { queueItemId: Q, videoId: VIDEO, subIndex: -1, hostClock: Date.now(), ...frame },
    host,
  );
}

/** An iframe that keeps BUFFERING after a paused seek, so the precision gate times out. */
function stallPausedSeeks(player: FakeYtPlayer, count = Number.POSITIVE_INFINITY): void {
  const seek = player.seekTo;
  let remaining = count;
  player.seekTo = (time, allowAhead) => {
    seek(time, allowAhead);
    if (player.__state === 2 && remaining > 0) {
      remaining -= 1;
      player.__state = 3;
    }
  };
}

function seekTargets(player: FakeYtPlayer): number[] {
  return player.__log.filter((call) => call.op === 'seekTo').map((call) => Number(call.args?.[0]));
}

function playCount(player: FakeYtPlayer): number {
  return player.__log.filter((call) => call.op === 'playVideo').length;
}

function toastKeys(): unknown[] {
  return vi.mocked(showToast).mock.calls.map(([key]) => key);
}

function heartbeatsWithDrift(player: FakeYtPlayer, drifts: readonly number[]): void {
  for (const drift of drifts) {
    heartbeatWithDrift(player, drift);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
  }
}

describe('follow-up rendezvous after a buffer-gate fallback', () => {
  /** A user Sync whose precision buffer gate times out into the plain fallback. */
  function fallBackFromPrecision(player: FakeYtPlayer, stalls?: number): number {
    stallPausedSeeks(player, stalls);
    const hostTime = player.getCurrentTime();
    heartbeat(hostTime);
    expect(guestRendezvousSync().status).toBe('started');
    vi.advanceTimersByTime(GATE_TIMEOUT_MS);
    // Live host position when the fallback joined it.
    return hostTime + GATE_TIMEOUT_MS / 1000;
  }

  it('re-aligns exactly once, silently, after the late fallback start', () => {
    const player = installGuest();
    const fallbackHostTime = fallBackFromPrecision(player, 1);
    expect(rendezvousStarts).toBe(1);
    // The established fallback still joins the live position right away.
    expect(seekTargets(player).at(-1)).toBeCloseTo(fallbackHostTime, 6);
    expect(getManagedTimer('yt-seek-play')).not.toBeNull();
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();

    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS - 1);
    expect(player.__state).toBe(1);
    expect(rendezvousStarts).toBe(1);

    vi.advanceTimersByTime(1);
    expect(rendezvousStarts).toBe(2);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    // A full precision pre-seek: projected host position plus the margin.
    expect(seekTargets(player).at(-1)).toBeCloseTo(
      fallbackHostTime + STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS / 1000 + RENDEZVOUS_MARGIN_SEC,
      6,
    );
    const plays = playCount(player);
    vi.advanceTimersByTime(RENDEZVOUS_MARGIN_SEC * 1000);
    expect(playCount(player)).toBe(plays + 1);
    expect(player.__state).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(rendezvousStarts).toBe(2);
    // Only the user's own Sync attempt announced itself.
    expect(toastKeys()).toEqual(['toast.yt_rendezvous_start']);
  });

  it('does not chain another follow-up when the follow-up also falls back', () => {
    const player = installGuest();
    fallBackFromPrecision(player);
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS);
    expect(rendezvousStarts).toBe(2);

    vi.advanceTimersByTime(GATE_TIMEOUT_MS);
    // The follow-up fell back to a plain start too, and owes nothing more.
    expect(getManagedTimer('yt-seek-play')).not.toBeNull();
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(rendezvousStarts).toBe(2);
    expect(player.__state).toBe(1);
    expect(toastKeys()).toEqual(['toast.yt_rendezvous_start']);
  });

  it.each([
    ['a host pause', () => hostStateFrame({ state: 2, time: 31 })],
    ['a host seek command', () => hostStateFrame({ state: 1, time: 80, hostPlayAt: 0 })],
    ['cancelGuestRendezvous', () => cancelGuestRendezvous()],
    ['timeline invalidation', () => invalidateGuestYouTubeTimeline()],
    ['the full sync reset', () => resetYouTubeSyncState()],
  ] as const)('is retired by %s', (_name, retire) => {
    const player = installGuest();
    fallBackFromPrecision(player);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();

    retire();
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS + MANUAL_RENDEZVOUS_RETRY_MAX_MS);
    expect(rendezvousStarts).toBe(1);
  });

  it.each([
    ['a native local pause', () => setLocalYouTubePaused(true)],
    ['a replaced host connection', () => setState('network.hostConn', connection('next-host'))],
    ['a new queue occurrence', () => setState('playlist.currentQueueItemId', SECOND_Q)],
    // Inside the fallback's drift suppression this only refreshes the snapshot.
    ['a host snapshot for another video', () => heartbeat(32, { videoId: 'OTHER_VIDEO' })],
  ] as const)('is dropped when it fires after %s', (_name, change) => {
    const player = installGuest();
    fallBackFromPrecision(player);
    change();
    player.__log.length = 0;

    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS + MANUAL_RENDEZVOUS_RETRY_MAX_MS);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    expect(rendezvousStarts).toBe(1);
    expect(mutationOps(player).filter((op) => op === 'pauseVideo')).toEqual([]);
  });

  it('is dropped when the host snapshot has gone stale', () => {
    const player = installGuest();
    stallPausedSeeks(player);
    heartbeat(player.getCurrentTime());
    // The host goes quiet; its last snapshot is still fresh enough to start.
    vi.advanceTimersByTime(8_000);
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    vi.advanceTimersByTime(GATE_TIMEOUT_MS);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();

    // 8s + 1.4s + 3.25s exceeds RENDEZVOUS_SNAPSHOT_MAX_AGE_MS.
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    expect(rendezvousStarts).toBe(1);
  });

  it('stops waiting on host buffering once that snapshot goes stale', () => {
    const player = installGuest();
    stallPausedSeeks(player);
    heartbeat(player.getCurrentTime());
    vi.advanceTimersByTime(8_000);
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    vi.advanceTimersByTime(100);
    // The host's last word before going quiet: BUFFERING.
    const bufferingAt = Date.now();
    heartbeat(player.getCurrentTime(), { state: 3 });
    vi.advanceTimersByTime(GATE_TIMEOUT_MS - 100 + STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();

    // Dropped on the first retry past the snapshot age limit, before its window ends.
    vi.advanceTimersByTime(bufferingAt + RENDEZVOUS_SNAPSHOT_MAX_AGE_MS + 300 - Date.now());
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    expect(rendezvousStarts).toBe(1);
  });

  it('waits out host buffering inside its bounded window, then re-aligns', () => {
    const player = installGuest();
    const fallbackHostTime = fallBackFromPrecision(player, 1);
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS - 500);
    heartbeat(fallbackHostTime + 2.75, { state: 3 });

    vi.advanceTimersByTime(1_000);
    expect(rendezvousStarts).toBe(1);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();

    heartbeat(fallbackHostTime + 3.75);
    vi.advanceTimersByTime(MANUAL_RENDEZVOUS_RETRY_MS);
    expect(rendezvousStarts).toBe(2);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
  });

  it('expires if the host never settles inside its window', () => {
    const player = installGuest();
    const fallbackHostTime = fallBackFromPrecision(player, 1);
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS - 500);
    heartbeat(fallbackHostTime + 2.75, { state: 3 });

    // The retry due at the window's last instant still waits; the next one expires.
    vi.advanceTimersByTime(500 + MANUAL_RENDEZVOUS_RETRY_MAX_MS - 1);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(MANUAL_RENDEZVOUS_RETRY_MS + 1);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    expect(rendezvousStarts).toBe(1);
  });

  it('owes no follow-up when the fallback lands near the end of the media', () => {
    const player = installGuest({ position: 291 });
    fallBackFromPrecision(player);
    expect(getManagedTimer('yt-seek-play')).not.toBeNull();
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
  });

  it('leaves re-alignment to a retained host precision request', () => {
    const player = installGuest();
    stallPausedSeeks(player, 1);
    const hostStart = player.getCurrentTime();
    heartbeat(hostStart);
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    vi.advanceTimersByTime(500);
    // Host Stage 2 lands while precision is still buffering and is retained.
    heartbeat(hostStart + 0.5, { isManual: true });
    expect(getManagedTimer('yt-manual-rendezvous-retry')).not.toBeNull();

    vi.advanceTimersByTime(GATE_TIMEOUT_MS - 500);
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS + MANUAL_RENDEZVOUS_RETRY_MAX_MS);
    // The retained request ran after the cooldown; no follow-up ran as well.
    expect(rendezvousStarts).toBe(2);
  });
});

describe('automatic precision rendezvous for small stable drift', () => {
  it.each([0.4, -0.4, 2.9])(
    're-aligns silently once %ss of drift holds for two heartbeats',
    (drift) => {
      const player = installGuest();
      heartbeatWithDrift(player, drift);
      expect(rendezvousStarts).toBe(0);
      expect(mutationOps(player)).toEqual([]);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      const hostTime = heartbeatWithDrift(player, drift);
      expect(rendezvousStarts).toBe(1);
      expect(seekTargets(player)).toHaveLength(1);
      expect(seekTargets(player)[0]).toBeCloseTo(hostTime + RENDEZVOUS_MARGIN_SEC, 6);

      vi.advanceTimersByTime(RENDEZVOUS_MARGIN_SEC * 1000);
      expect(playCount(player)).toBe(1);
      expect(toastKeys()).toEqual([]);
    },
  );

  it.each([
    ['a lone sample', [0.4, 0, 0.4, 0, 0.4]],
    ['alternating signs', [0.4, -0.4, 0.4, -0.4, 0.4]],
    ['drift below 150ms', [0.12, 0.12, 0.12, 0.12, 0.12]],
  ] as const)('leaves %s alone', (_name, drifts) => {
    const player = installGuest();
    heartbeatsWithDrift(player, drifts);
    expect(rendezvousStarts).toBe(0);
    expect(mutationOps(player)).toEqual([]);
  });

  it('leaves drift of 3s or more to the corrective heartbeat seek', () => {
    const player = installGuest();
    for (let i = 0; i < 3; i++) {
      const hostTime = heartbeatWithDrift(player, 3.5);
      expect(player.__log.at(-1)).toMatchObject({ op: 'seekTo', args: [hostTime, true] });
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    }
    expect(rendezvousStarts).toBe(0);
    expect(mutationOps(player)).toEqual(['seekTo', 'seekTo', 'seekTo']);
  });

  it.each([
    { rawDriftSec: 0.4, starts: 0 },
    { rawDriftSec: 0.8, starts: 1 },
  ])(
    'projects each heartbeat through its 400ms-old hostClock (raw $rawDriftSec s)',
    ({ rawDriftSec, starts }) => {
      const player = installGuest();
      for (let i = 0; i < 4; i++) {
        // The host read its position 400ms before this frame was handled, so
        // that much of the raw lag is delivery delay rather than drift.
        heartbeatWithDrift(player, rawDriftSec, { hostClock: Date.now() - 400 });
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      }
      expect(rendezvousStarts).toBe(starts);
    },
  );

  it.each([
    { name: 'this speaker is locally paused', arrange: () => setLocalYouTubePaused(true) },
    { name: 'zero-start owns the iframe', arrange: () => (harness.zeroStartActive = true) },
    { name: 'the shared clock is uncalibrated', arrange: () => (harness.clockCalibrated = false) },
    { name: 'heartbeats carry no hostClock', frame: { hostClock: undefined } },
  ])('does not act while $name', ({ arrange, frame }) => {
    const player = installGuest();
    arrange?.();
    for (let i = 0; i < 4; i++) {
      heartbeatWithDrift(player, 0.4, frame);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    }
    expect(rendezvousStarts).toBe(0);
    expect(mutationOps(player)).toEqual([]);
  });

  it('does not confirm drift across host-ad suspicion or the ad-resume heartbeat', () => {
    const player = installGuest({ position: 42 });
    heartbeatWithDrift(player, 0.4);
    // The host clock freezes (an ad). Stale frames read as growing guest lead
    // before the detector pauses this guest on the third one.
    heartbeat(41.61);
    heartbeat(41.62);
    expect(rendezvousStarts).toBe(0);
    heartbeat(41.63);
    expect(player.__state).toBe(2);

    // The ad ends: this heartbeat only restores playback.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    heartbeat(47.6);
    expect(player.__state).toBe(1);
    expect(rendezvousStarts).toBe(0);

    // Confirmation starts over from the first clean heartbeat after it.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    heartbeatsWithDrift(player, [0.4]);
    expect(rendezvousStarts).toBe(0);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(1);
  });

  it('restarts confirmation after any precision rendezvous', () => {
    const player = installGuest();
    heartbeatWithDrift(player, 0.4);
    vi.advanceTimersByTime(1_000);
    // The user presses Sync, and no heartbeat lands inside its suppression.
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    vi.advanceTimersByTime(RENDEZVOUS_MARGIN_SEC * 1000 + RENDEZVOUS_DRIFT_SUPPRESS_MS + 100);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(1);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(2);
  });

  it('restarts confirmation after a host state frame', () => {
    const player = installGuest();
    heartbeatWithDrift(player, 0.4);
    // Raw host iframe PLAYING feedback re-seeks this guest the rough way.
    hostStateFrame({ state: 1, time: player.getCurrentTime() - 0.4 });
    // Past that seek's drift suppression, the next sample is a first one again.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    heartbeatsWithDrift(player, [0.4]);
    expect(rendezvousStarts).toBe(0);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(1);
  });

  it('waits out its cooldown before confirming again', () => {
    const player = installGuest();
    heartbeatsWithDrift(player, [0.4]);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(1);

    // The re-aligned guest keeps reading 0.4s ahead (e.g. a biased host clock).
    const firstAt = Date.now();
    while (Date.now() - firstAt < STANDARD_AUTO_REALIGN_COOLDOWN_MS) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      heartbeatWithDrift(player, 0.4);
    }
    // The heartbeat at exactly 30s is the first one that may count.
    expect(rendezvousStarts).toBe(1);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(2);
  });

  it('spends at most its budget on one occurrence', () => {
    const player = installGuest({ position: 10, duration: 600 });
    heartbeatsWithDrift(player, Array<number>(60).fill(0.4));
    expect(rendezvousStarts).toBe(STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE);

    // Another occurrence of the same video starts with a fresh budget.
    setState('playlist.currentQueueItemId', SECOND_Q);
    for (let i = 0; i < 2; i++) {
      heartbeatWithDrift(player, 0.4, { queueItemId: SECOND_Q });
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    }
    expect(rendezvousStarts).toBe(STANDARD_AUTO_REALIGN_MAX_PER_OCCURRENCE + 1);
  });

  it('never owes a follow-up when its own buffer gate falls back', () => {
    const player = installGuest();
    stallPausedSeeks(player);
    heartbeatsWithDrift(player, [0.4]);
    heartbeatWithDrift(player, 0.4);
    expect(rendezvousStarts).toBe(1);

    vi.advanceTimersByTime(GATE_TIMEOUT_MS);
    expect(getManagedTimer('yt-seek-play')).not.toBeNull();
    expect(getManagedTimer(FOLLOW_UP_TIMER)).toBeNull();
    vi.advanceTimersByTime(STANDARD_RENDEZVOUS_FOLLOW_UP_DELAY_MS + MANUAL_RENDEZVOUS_RETRY_MAX_MS);
    expect(rendezvousStarts).toBe(1);
  });
});
