/**
 * @vitest-environment jsdom
 *
 * Regression pins for delayed ordinary YouTube heartbeats. The original 21
 * cases reproduced two age-blind correction paths before the runtime fix.
 * Real sync.ts handler, SharedClock, state and managed timers; fake IFrame API.
 * No transfer or actual Android audio is simulated here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getClockOffset,
  getHostNow,
  isClockCalibrated,
  processSyncPong,
  registerPing,
  resetClockState,
} from '../../network/shared-clock.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { setLocalYouTubePaused, setYouTubePlayer } from '../_state.ts';
import { SEEK_PLAY_GAP_MS } from '../constants.ts';
import { initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import { makeFakeYtPlayer, mutationOps, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const harness = vi.hoisted(() => ({
  android: false,
  handlers: {} as Record<string, (data: Record<string, unknown>, conn?: DataConnection) => void>,
}));

vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
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

const Q = '88333333-3333-4333-8333-333333333333';
const VIDEO = 'FAKE_VIDEO_ID';
const HOST_POSITION_AT_SEND = 60;
let mono = 1000;
let host: DataConnection;

async function advance(ms: number): Promise<void> {
  mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  mono = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  localStorage.removeItem('musixquare-yt-play-latency');
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetClockState();
  vi.mocked(log.error).mockClear();
  harness.android = false;
  host = {
    open: true,
    peer: 'heartbeat-delay-host',
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('playlist.items', [
    { queueItemId: Q, type: 'youtube', name: 'Heartbeat video', videoId: VIDEO, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', Q);
  setState('sync.youtubeLocalOffset', 0);
  setPlaybackYouTubePlaying();
  setLocalYouTubePaused(false);
  initYouTubeSync();
  resetYouTubeSyncState();

  // Three real SharedClock samples: symmetric 2ms each way, zero true offset.
  for (let id = 1; id <= 3; id += 1) {
    const sentAt = Date.now();
    registerPing(id);
    await advance(4);
    expect(processSyncPong(id, sentAt + 2)).toEqual({ rtt: 4, offset: 0 });
  }
  expect(isClockCalibrated()).toBe(true);
  expect(getClockOffset()).toBe(0);
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

function installGuest(android: boolean, extraLeadSec = 0): FakeYtPlayer {
  harness.android = android;
  const player = makeFakeYtPlayer({
    __state: 1,
    __currentTime: HOST_POSITION_AT_SEND + (android ? 0.25 : 0) + extraLeadSec,
    __duration: 300,
    __videoId: VIDEO,
    __advanceClock: true,
  });
  setYouTubePlayer(player as never);
  return player;
}

function heartbeat(sentAt: number | undefined, frame: Record<string, unknown> = {}): void {
  harness.handlers[MSG.YOUTUBE_SYNC](
    {
      queueItemId: Q,
      time: HOST_POSITION_AT_SEND,
      state: 1,
      videoId: VIDEO,
      subIndex: -1,
      ...(sentAt === undefined ? {} : { hostClock: sentAt }),
      ...frame,
    },
    host,
  );
}

function seekTargets(player: FakeYtPlayer): number[] {
  return player.__log.filter((call) => call.op === 'seekTo').map((call) => Number(call.args?.[0]));
}

describe('aligned PLAYING guest receiving an aged heartbeat', () => {
  for (const android of [false, true]) {
    it.each([0, 2999, 3000, 3001, 4000])(
      `${android ? 'Android' : 'other platform'}: age %i ms must not rewind an aligned player`,
      async (ageMs) => {
        const player = installGuest(android);
        const sentAt = getHostNow();
        await advance(ageMs);
        const expectedNow = HOST_POSITION_AT_SEND + ageMs / 1000 + (android ? 0.25 : 0);
        // Establish no actual clock/media drift before delivering the stale frame.
        expect(player.getCurrentTime()).toBeCloseTo(expectedNow, 8);
        heartbeat(sentAt);
        expect(getState('playlist.currentQueueItemId')).toBe(Q);
        expect(getState('playback.mode')).toBe('youtube');
        expect(mutationOps(player), JSON.stringify(player.__log)).toEqual([]);
        expect(player.getCurrentTime()).toBeCloseTo(expectedNow, 8);
      },
    );

    it(`${android ? 'Android' : 'other platform'}: a fresh frame still corrects a real four-second lead`, () => {
      const player = installGuest(android, 4);
      heartbeat(getHostNow());
      expect(mutationOps(player)).toEqual(['seekTo']);
      expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND + (android ? 0.25 : 0)]);
    });
  }
});

describe('heartbeat projection boundaries', () => {
  it.each([-60_000, 60_000])(
    'uses the calibrated host clock with offset %i ms',
    async (offsetMs) => {
      resetClockState();
      for (let id = 10; id <= 12; id += 1) {
        const sentAt = Date.now();
        registerPing(id);
        await advance(4);
        expect(processSyncPong(id, sentAt + 2 + offsetMs)).toEqual({ rtt: 4, offset: offsetMs });
      }
      expect(getClockOffset()).toBe(offsetMs);
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(4000);
      heartbeat(sentAt);
      expect(mutationOps(player)).toEqual([]);
      expect(player.getCurrentTime()).toBeCloseTo(64.25, 8);
    },
  );

  it.each([2, 3, 5])('does not advance a host state %i snapshot with its age', async (state) => {
    const player = installGuest(true);
    const sentAt = getHostNow();
    await advance(4000);
    heartbeat(sentAt, { state });
    expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND]);
    expect(mutationOps(player)).toEqual(state === 2 ? ['seekTo', 'pauseVideo'] : ['seekTo']);
  });

  it.each([-1.5, 1.5])(
    'keeps manual offset %s separate from frame age and Android lead',
    async (manual) => {
      setState('sync.youtubeLocalOffset', manual);
      const player = installGuest(true, manual);
      const sentAt = getHostNow();
      await advance(4000);
      heartbeat(sentAt);
      expect(mutationOps(player)).toEqual([]);
      expect(player.getCurrentTime()).toBeCloseTo(HOST_POSITION_AT_SEND + 4 + manual + 0.25, 8);
    },
  );

  it.each([-1.5, 1.5])(
    'buffer recovery applies manual offset %s and Android lead only once',
    async (manual) => {
      setState('sync.youtubeLocalOffset', manual);
      const player = installGuest(true, manual);
      const sentAt = getHostNow();
      await advance(200);
      player.__setState(3, false);
      heartbeat(sentAt);
      expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND + 0.2 + manual + 0.25]);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
    },
  );

  for (const buffering of [false, true]) {
    it.each([
      ['missing', undefined],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ] as const)(
      `${buffering ? 'BUFFERING' : 'PLAYING'}: %s host clock keeps legacy raw-position fallback`,
      async (_label, hostClock) => {
        const player = installGuest(true, buffering ? 0 : 4);
        if (buffering) player.__setState(3, false);
        heartbeat(hostClock);
        expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND + 0.25]);
        await advance(SEEK_PLAY_GAP_MS);
        expect(mutationOps(player)).toEqual(
          buffering ? ['pauseVideo', 'seekTo', 'playVideo'] : ['seekTo'],
        );
      },
    );

    it(`${buffering ? 'BUFFERING' : 'PLAYING'}: future host clock never projects backward`, async () => {
      const player = installGuest(true, buffering ? 0 : 4);
      if (buffering) player.__setState(3, false);
      heartbeat(getHostNow() + 1000);
      expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND + 0.25]);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual(
        buffering ? ['pauseVideo', 'seekTo', 'playVideo'] : ['seekTo'],
      );
    });

    it(`${buffering ? 'BUFFERING' : 'PLAYING'}: uncalibrated clock does not invent elapsed time`, async () => {
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(4000);
      resetClockState();
      expect(isClockCalibrated()).toBe(false);
      if (buffering) player.__setState(3, false);
      heartbeat(sentAt);
      expect(seekTargets(player)).toEqual([HOST_POSITION_AT_SEND + 0.25]);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual(
        buffering ? ['pauseVideo', 'seekTo', 'playVideo'] : ['seekTo'],
      );
    });

    it(`${buffering ? 'BUFFERING' : 'PLAYING'}: neutralizes Android lead at the projected tail`, async () => {
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(500);
      if (buffering) player.__setState(3, false);
      // Sent position permits a 250ms lead, but projected 299.9s does not.
      heartbeat(sentAt, { time: 299.4 });
      expect(seekTargets(player)).toHaveLength(1);
      expect(seekTargets(player)[0]).toBeCloseTo(299.9, 8);
    });

    it(`${buffering ? 'BUFFERING' : 'PLAYING'}: clamps a projected position beyond duration`, async () => {
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(1000);
      if (buffering) player.__setState(3, false);
      heartbeat(sentAt, { time: 299.8 });
      expect(seekTargets(player)).toEqual([300]);
    });
  }

  it('keeps an already-ended Android guest in its projected output-tail hold', async () => {
    const player = installGuest(true);
    const sentAt = getHostNow();
    await advance(500);
    player.seekTo(300, true);
    player.__setState(0, false);
    player.__log.length = 0;
    heartbeat(sentAt, { time: 299.4 });
    expect(mutationOps(player)).toEqual([]);
  });
});

describe('BUFFERING guest receiving an aged PLAYING heartbeat', () => {
  it.each([0, 200, 500])(
    'Android: age %i ms recovery seek must include elapsed host playback',
    async (ageMs) => {
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(ageMs);
      // A transient BUFFERING event at delivery, after aligned playback so far.
      player.__setState(3, false);
      const receivedAt = Date.now();
      heartbeat(sentAt);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual(['pauseVideo', 'seekTo', 'playVideo']);
      expect(player.__log.map((call) => call.at - receivedAt)).toEqual([0, 0, SEEK_PLAY_GAP_MS]);
      // This assertion isolates the heartbeat age at seek time. The existing
      // 150ms pause/play gap and actual output latency are separate questions.
      const expectedTargetAtSeek = HOST_POSITION_AT_SEND + ageMs / 1000 + 0.25;
      expect(seekTargets(player), JSON.stringify(player.__log)).toEqual([expectedTargetAtSeek]);
    },
  );

  it.each([0, 200, 500])(
    'other platform: age %i ms buffering recovery does not insert an old-position seek',
    async (ageMs) => {
      const player = installGuest(false);
      const sentAt = getHostNow();
      await advance(ageMs);
      player.__setState(3, false);
      heartbeat(sentAt);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual(['playVideo']);
      expect(seekTargets(player)).toEqual([]);
    },
  );

  it.each([0, 200, 500])(
    'Android: age %i ms with the player still PLAYING does not enter buffering recovery',
    async (ageMs) => {
      const player = installGuest(true);
      const sentAt = getHostNow();
      await advance(ageMs);
      heartbeat(sentAt);
      await advance(SEEK_PLAY_GAP_MS);
      expect(mutationOps(player)).toEqual([]);
    },
  );
});
