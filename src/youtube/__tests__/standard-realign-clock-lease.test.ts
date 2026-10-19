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
const VIDEO = 'LEASE_VIDEO';
let wallStep = 0;
let ping = 0;
let host: DataConnection;
let player: FakeYtPlayer;
let mediaAnchor = 0;
function now() {
  return performance.now();
}
function hostNow() {
  return BASE + now();
}
function hostPosition() {
  return 30 + now() / 1000;
}
function advance(ms: number) {
  vi.advanceTimersByTime(ms);
}
function sample(up = 2, down = 2, offset = 0) {
  const sent = hostNow();
  registerPing(++ping);
  advance(up + down);
  expect(processSyncPong(ping, sent + up + offset)).not.toBeNull();
}
function heartbeat(drift: number | null = null) {
  if (drift !== null) {
    player.__currentTime = hostPosition() + (harness.android ? 0.25 : 0) + drift / 1000;
    mediaAnchor = now();
  }
  harness.handlers[MSG.YOUTUBE_SYNC](
    {
      queueItemId: Q,
      videoId: VIDEO,
      subIndex: -1,
      time: hostPosition() - 1,
      state: 1,
      hostClock: hostNow() - 1000,
    },
    host,
  );
}
function startAuto(drift = 300, rtt = 4) {
  if (rtt !== 4) resetClockState();
  sample(rtt / 2, rtt / 2);
  heartbeat(drift);
  advance(3000);
  sample(rtt / 2, rtt / 2);
  heartbeat(drift);
  expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo']);
  return now();
}
function command(state: number, position: number) {
  harness.handlers[MSG.YOUTUBE_STATE](
    {
      queueItemId: Q,
      videoId: VIDEO,
      subIndex: -1,
      time: position,
      state,
      hostClock: hostNow(),
      hostPlayAt: 0,
    },
    host,
  );
}
function residual() {
  return (player.getCurrentTime() - hostPosition() - (harness.android ? 0.25 : 0)) * 1000;
}

/** Arm after heartbeat confirmation, so the injected read belongs to admission. */
function atAdmissionRead(getter: 'getDuration' | 'getVideoData', inject: () => void) {
  let armed = false;
  vi.mocked(log.debug).mockImplementation((message) => {
    if (
      armed ||
      typeof message !== 'string' ||
      !message.includes('Automatic precision rendezvous')
    ) {
      return;
    }
    armed = true;
    const read = player[getter];
    Object.assign(player, {
      [getter]: () => {
        const value = read();
        Object.assign(player, { [getter]: read });
        inject();
        // A provider callback can return the value read before a newer action.
        return value;
      },
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  wallStep = ping = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - BASE - wallStep);
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetClockState();
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.error).mockClear();
  localStorage.removeItem('musixquare-yt-play-latency');
  harness.android = false;
  host = {
    peer: 'lease-host',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('playlist.items', [
    { queueItemId: Q, type: 'youtube', name: 'Lease', videoId: VIDEO, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q);
  setState('youtube.guestPlayLatency', 0);
  setPlaybackYouTubePlaying();
  setLocalYouTubePaused(false);
  player = makeFakeYtPlayer({ __state: 1, __currentTime: 30, __duration: 900, __videoId: VIDEO });
  // Media progresses on monotonic time, independently of local wall-clock edits.
  mediaAnchor = now();
  player.getCurrentTime = () =>
    player.__currentTime + (player.__state === 1 ? (now() - mediaAnchor) / 1000 : 0);
  const pause = player.pauseVideo;
  player.pauseVideo = () => {
    const position = player.getCurrentTime();
    pause();
    player.__currentTime = position;
    mediaAnchor = now();
  };
  const play = player.playVideo;
  player.playVideo = () => {
    play();
    mediaAnchor = now();
  };
  const seek = player.seekTo;
  player.seekTo = (position, ahead) => {
    seek(position, ahead);
    mediaAnchor = now();
  };
  setYouTubePlayer(player as never);
  initYouTubeSync();
  resetYouTubeSyncState();
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

describe('automatic rendezvous owns one monotonic clock lease', () => {
  it.each([-300, 300, -1200, 1200])('corrects actual %ims drift with precise clock', (drift) => {
    const admitted = startAuto(drift);
    advance(1600);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
    const play = player.__log.find((x) => x.op === 'playVideo')!;
    expect(play.at - BASE - admitted).toBe(1500);
    expect(Math.abs(residual())).toBeLessThan(1);
  });
  it.each([-300, 300])(
    'retains Android output lead while correcting actual %ims drift',
    (drift) => {
      harness.android = true;
      const admitted = startAuto(drift);
      advance(1600);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
      expect(player.__log.find((x) => x.op === 'playVideo')!.at - BASE - admitted).toBe(1250);
      expect(Math.abs(residual())).toBeLessThan(1);
    },
  );
  it('rejects a clock epoch change before the first player mutation', () => {
    bus.on('youtube:sync-loading', (loading, owner) => {
      if (loading && owner === 'rendezvous') resetClockState();
    });
    sample();
    heartbeat(300);
    advance(3000);
    sample();
    heartbeat(300);
    advance(2000);
    expect(mutationOps(player)).toEqual([]);
    expect(player.__state).toBe(1);
  });
  it('a release timer held past its deadline resumes the original local timeline', () => {
    startAuto(300);
    advance(60);
    // Both clocks progress while queued timers make no progress (main-thread stall).
    vi.setSystemTime(Date.now() + 2000);
    advance(1600);
    expect(player.__state).toBe(1);
    expect(residual()).toBeCloseTo(300, 5);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'seekTo', 'playVideo']);
  });
  it('a newer PAUSE delivered by the pre-pause getter owns the player', () => {
    let commandedPosition = 0;
    bus.on('youtube:sync-loading', (loading, owner) => {
      if (!loading || owner !== 'rendezvous') return;
      const read = player.getCurrentTime;
      player.getCurrentTime = () => {
        player.getCurrentTime = read;
        const position = read();
        commandedPosition = position;
        command(2, position);
        return position;
      };
    });
    sample();
    heartbeat(300);
    advance(3000);
    sample();
    heartbeat(300);
    advance(2000);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo']);
    expect(player.__log.find((x) => x.op === 'seekTo')?.args?.[0]).toBe(commandedPosition);
    expect(player.__state).toBe(2);
  });
  it('a newer seek delivered by the recovery duration getter owns the player', () => {
    startAuto();
    advance(60);
    resetClockState();
    const read = player.getDuration;
    player.getDuration = () => {
      player.getDuration = read;
      command(1, 80);
      return read();
    };
    advance(2500);
    const seeks = player.__log.filter((x) => x.op === 'seekTo').map((x) => Number(x.args?.[0]));
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toBe(80);
    expect(player.__state).toBe(1);
  });
  it('a local pause during recovery seek cannot be followed by stale recovery play', () => {
    startAuto();
    advance(60);
    resetClockState();
    const seek = player.seekTo;
    player.seekTo = (position, ahead) => {
      player.seekTo = seek;
      seek(position, ahead);
      setLocalYouTubePaused(true);
      player.pauseVideo();
    };
    advance(2500);
    expect(player.__state).toBe(2);
    expect(player.__log.filter((x) => x.op === 'playVideo')).toEqual([]);
    expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
  });
  it.each([-200, 200])(
    'keeps aligned playback intact when selected sample changes by %ims',
    (offset) => {
      heartbeat(0);
      advance(3000);
      // The precise samples now leave only by their 120s age limit.
      for (let i = 0; i < 300; i++) sample(offset < 0 ? 2 : 402, offset < 0 ? 402 : 2);
      expect(getClockOffset()).toBe(offset);
      heartbeat(0);
      advance(3000);
      heartbeat(0);
      expect(mutationOps(player)).toEqual([]);
    },
  );
  it.each([-200, 200])(
    'does not reinterpret target while buffer preparation sees an offset change %ims',
    (offset) => {
      const admitted = startAuto(1200, 600);
      player.__state = 3;
      advance(98);
      sample(offset < 0 ? 1 : 401, offset < 0 ? 401 : 1);
      expect(getClockOffset()).toBe(offset);
      advance(400);
      player.__state = 2;
      advance(1100);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
      expect(player.__log.find((x) => x.op === 'playVideo')!.at - BASE - admitted).toBe(1500);
      expect(Math.abs(residual())).toBeLessThan(1);
    },
  );
  it.each([-200, 200])(
    'does not invalidate an already scheduled release after offset change %ims',
    (offset) => {
      const admitted = startAuto(1200, 600);
      advance(98);
      sample(offset < 0 ? 1 : 401, offset < 0 ? 401 : 1);
      advance(1500);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
      expect(player.__log.find((x) => x.op === 'playVideo')!.at - BASE - admitted).toBe(1500);
      expect(Math.abs(residual())).toBeLessThan(1);
    },
  );
  it.each(['buffer', 'release'])(
    'clock epoch reset after pause restores original local timeline at %s boundary',
    (stage) => {
      startAuto(300);
      if (stage === 'release') advance(60);
      resetClockState();
      advance(1600);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'seekTo', 'playVideo']);
      expect(player.__state).toBe(1);
      expect(residual()).toBeCloseTo(300, 5);
      expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
    },
  );
  it.each([-60_000, 60_000])(
    'local wall step %ims after pause resumes prior monotonic media timeline',
    (step) => {
      startAuto(-300);
      advance(60);
      wallStep += step;
      vi.setSystemTime(Date.now() + step);
      advance(1600);
      expect(player.__state).toBe(1);
      expect(residual()).toBeCloseTo(-300, 5);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'seekTo', 'playVideo']);
    },
  );
  it.each([2, 0])('new explicit state %i wins over invalid-clock recovery', (state) => {
    startAuto();
    advance(60);
    resetClockState();
    command(state, 42);
    const count = player.__log.length;
    advance(2000);
    expect(player.__log.slice(count).filter((x) => ['playVideo', 'seekTo'].includes(x.op))).toEqual(
      [],
    );
    expect(player.__state).toBe(state);
  });
  it('new explicit PLAY/seek replaces the old automatic target without later stale play', () => {
    startAuto();
    advance(60);
    resetClockState();
    command(1, 80);
    advance(500);
    const count = player.__log.length;
    advance(2000);
    expect(player.__log.slice(count).filter((x) => ['playVideo', 'seekTo'].includes(x.op))).toEqual(
      [],
    );
    expect(player.__state).toBe(1);
    expect(player.getCurrentTime()).toBeGreaterThan(80);
  });
  it.each(['leave', 'connection', 'track'])('does not recover the old player after %s', (kind) => {
    startAuto();
    advance(60);
    resetClockState();
    if (kind === 'leave') {
      setState('network.hostConn', null);
      resetYouTubeSyncState();
    }
    if (kind === 'connection') setState('network.hostConn', { ...host } as DataConnection);
    if (kind === 'track') setState('playlist.currentQueueItemId', null);
    advance(2000);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo']);
  });
  it('quality refusal is not called success: genuine 300ms at RTT400 remains until quality recovers', () => {
    resetClockState();
    sample(200, 200);
    heartbeat(300);
    advance(3000);
    sample(200, 200);
    heartbeat(300);
    expect(mutationOps(player)).toEqual([]);
    expect(residual()).toBeCloseTo(300, 5);
    advance(3000);
    sample();
    heartbeat(300);
    advance(3000);
    sample();
    heartbeat(300);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo']);
    advance(1600);
    expect(Math.abs(residual())).toBeLessThan(1);
  });
  it('explicit user Sync still bypasses quality refusal', () => {
    resetClockState();
    sample(200, 200);
    heartbeat(300);
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    advance(1600);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
  });
});

describe('automatic release reentrancy keeps the newest owner and clock', () => {
  it.each(
    (['getDuration', 'getPlayerState'] as const).flatMap((getter) =>
      (['pause', 'stop', 'seek', 'leave'] as const).map((action) => ({ getter, action })),
    ),
  )('$getter cannot revive automatic playback after a newer $action', ({ getter, action }) => {
    startAuto();
    advance(60); // Buffer is ready; the next getter read belongs to scheduled release.
    const read = player[getter];
    let injected = false;
    let afterCommand = -1;
    player[getter] = () => {
      const value = read();
      player[getter] = read;
      injected = true;
      if (action === 'pause') command(2, 42);
      if (action === 'stop') command(0, 42);
      if (action === 'seek') command(1, 80);
      if (action === 'leave') {
        setState('network.hostConn', null);
        resetYouTubeSyncState();
      }
      afterCommand = player.__log.length;
      // A provider read may finish with its earlier snapshot after the callback.
      return value;
    };
    advance(2000);
    expect(injected).toBe(true);
    const laterMutations = player.__log
      .slice(afterCommand)
      .filter((x) => ['seekTo', 'playVideo'].includes(x.op))
      .map((x) => x.op);
    // Explicit PLAY/seek owns its queued play; the old automatic release must
    // not add a second play. PAUSE/STOP/leave permit no later player mutation.
    expect(laterMutations).toEqual(action === 'seek' ? ['playVideo'] : []);
    if (action === 'pause') expect(player.__state).toBe(2);
    if (action === 'stop') expect(player.__state).toBe(0);
    if (action === 'seek') expect(player.getCurrentTime()).toBeGreaterThanOrEqual(80);
    expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
    expect(getManagedTimer('yt-rendezvous-calibrate')).toBeNull();
  });

  it.each(
    (['getDuration', 'getPlayerState'] as const).flatMap((getter) =>
      (['epoch', -60_000, 60_000] as const).map((change) => ({ getter, change })),
    ),
  )(
    '$getter clock change $change restores the prior local timeline at release',
    ({ getter, change }) => {
      startAuto(300);
      advance(60);
      const read = player[getter];
      let injected = false;
      player[getter] = () => {
        const value = read();
        player[getter] = read;
        injected = true;
        if (change === 'epoch') resetClockState();
        else {
          wallStep += change;
          vi.setSystemTime(Date.now() + change);
        }
        return value;
      };
      advance(2000);
      expect(injected).toBe(true);
      expect(player.__state).toBe(1);
      expect(residual()).toBeCloseTo(300, 5);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'seekTo', 'playVideo']);
      expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
      expect(getManagedTimer('yt-rendezvous-calibrate')).toBeNull();
    },
  );

  it.each(['epoch', -60_000, 60_000] as const)(
    'buffer-timeout getter clock change %s cannot fall back through an invalid lease',
    (change) => {
      const admitted = startAuto(300);
      player.__state = 3;
      const read = player.getPlayerState;
      let injected = false;
      player.getPlayerState = () => {
        const value = read();
        if (now() - admitted <= 1350) return value;
        player.getPlayerState = read;
        injected = true;
        if (change === 'epoch') resetClockState();
        else {
          wallStep += change;
          vi.setSystemTime(Date.now() + change);
        }
        return value;
      };
      advance(2000);
      expect(injected).toBe(true);
      expect(player.__state).toBe(1);
      expect(residual()).toBeCloseTo(300, 5);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'seekTo', 'playVideo']);
      expect(getManagedTimer('yt-rendezvous-follow-up')).toBeNull();
      expect(getManagedTimer('yt-rendezvous-buffer')).toBeNull();
      expect(getManagedTimer('yt-rendezvous-calibrate')).toBeNull();
    },
  );
});

describe('independent minimum and uncertainty admission policy', () => {
  it.each(
    ([-300, 300] as const).flatMap((drift) => [false, true].map((android) => ({ drift, android }))),
  )('corrects genuine $drift ms at RTT218 (Android $android)', ({ drift, android }) => {
    harness.android = android;
    const admitted = startAuto(drift, 218);
    advance(1600);
    expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
    expect(player.__log.find((x) => x.op === 'playVideo')!.at - BASE - admitted).toBe(
      android ? 1250 : 1500,
    );
    expect(Math.abs(residual())).toBeLessThan(1);
  });

  it.each([-300, 300])(
    'withholds genuine %ims when asymmetry masks part of it, then recovers on precise samples',
    (drift) => {
      resetClockState();
      // A physically valid midpoint error of the same sign reduces observed
      // drift from +/-300 to +/-200ms. RTT204 gives U107, so |m| <= 2U.
      const up = drift > 0 ? 202 : 2;
      const down = drift > 0 ? 2 : 202;
      sample(up, down);
      heartbeat(drift);
      advance(3000);
      sample(up, down);
      heartbeat(drift);
      expect(getClockOffset()).toBe(drift > 0 ? 100 : -100);
      expect(mutationOps(player)).toEqual([]);
      expect(residual()).toBeCloseTo(drift, 5);

      advance(3000);
      sample();
      heartbeat();
      expect(mutationOps(player)).toEqual([]); // One fresh confirmation is insufficient.
      advance(3000);
      sample();
      heartbeat();
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo']);
      advance(1600);
      expect(Math.abs(residual())).toBeLessThan(1);
    },
  );
});

describe('automatic admission cannot overwrite a changed measurement or command', () => {
  it.each(
    (['getDuration', 'getVideoData'] as const).flatMap((getter) =>
      (['epoch', -200, 200] as const).map((change) => ({ getter, change })),
    ),
  )('$getter rejects clock change $change before physical pause', ({ getter, change }) => {
    resetClockState();
    sample(300, 300);
    heartbeat(1200);
    advance(3000);
    sample(300, 300);
    let injected = false;
    atAdmissionRead(getter, () => {
      injected = true;
      if (change === 'epoch') {
        resetClockState();
        sample(); // A fresh calibrated epoch must not revive the earlier measurement.
      } else {
        sample(change < 0 ? 1 : 401, change < 0 ? 401 : 1);
        expect(getClockOffset()).toBe(change);
      }
    });
    heartbeat(1200);
    advance(2000);
    expect(injected).toBe(true);
    expect(mutationOps(player)).toEqual([]);
    expect(player.__state).toBe(1);
    expect(residual()).toBeCloseTo(1200, 5);
    expect(getManagedTimer('yt-rendezvous-buffer')).toBeNull();
    expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
  });

  it.each(
    (['getDuration', 'getVideoData'] as const).flatMap((getter) =>
      (['pause', 'stop', 'seek', 'leave'] as const).map((action) => ({ getter, action })),
    ),
  )('$getter preserves a newer $action before automatic ownership', ({ getter, action }) => {
    sample();
    heartbeat(300);
    advance(3000);
    sample();
    let afterCommand = -1;
    atAdmissionRead(getter, () => {
      if (action === 'pause') command(2, 42);
      if (action === 'stop') command(0, 42);
      if (action === 'seek') command(1, 80);
      if (action === 'leave') {
        setState('network.hostConn', null);
        resetYouTubeSyncState();
      }
      afterCommand = player.__log.length;
    });
    heartbeat(300);
    advance(2000);
    expect(afterCommand).toBeGreaterThanOrEqual(0);
    const later = player.__log.slice(afterCommand).map((entry) => entry.op);
    expect(later).toEqual(action === 'seek' ? ['playVideo'] : []);
    if (action === 'pause') expect(player.__state).toBe(2);
    if (action === 'stop') expect(player.__state).toBe(0);
    if (action === 'seek') expect(player.getCurrentTime()).toBeGreaterThanOrEqual(80);
    expect(getManagedTimer('yt-rendezvous-buffer')).toBeNull();
    expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    'rejects interrupted position %s without touching playback',
    (position) => {
      let injected = false;
      bus.on('youtube:sync-loading', (loading, owner) => {
        if (!loading || owner !== 'rendezvous') return;
        const read = player.getCurrentTime;
        player.getCurrentTime = () => {
          player.getCurrentTime = read;
          injected = true;
          return position;
        };
      });
      sample();
      heartbeat(300);
      advance(3000);
      sample();
      heartbeat(300);
      advance(2000);
      expect(injected).toBe(true);
      expect(mutationOps(player)).toEqual([]);
      expect(player.__state).toBe(1);
      expect(residual()).toBeCloseTo(300, 5);
      expect(getManagedTimer('yt-rendezvous-buffer')).toBeNull();
      expect(getManagedTimer('yt-rendezvous-play')).toBeNull();
      expect(getManagedTimer('yt-rendezvous-follow-up')).toBeNull();
    },
  );
});
