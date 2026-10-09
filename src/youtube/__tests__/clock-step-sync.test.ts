/** @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { setYouTubePlayer } from '../_state.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from '../__tests__/__helpers__/fake-yt-player.ts';
import {
  getHostNow,
  getClockOffset,
  registerPing,
  processSyncPong,
  resetClockState,
} from '../../network/shared-clock.ts';
import { guestRendezvousSync, initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import type { DataConnection } from '../../types/index.ts';
const harness = vi.hoisted(() => ({
  handlers: {} as Record<string, (x: Record<string, unknown>, c: DataConnection) => void>,
}));
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: (x: Record<string, unknown>) => Object.assign(harness.handlers, x),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  isRemoteGuest: () => false,
}));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (s: number) => String(s) }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const Q = '88333333-3333-4333-8333-333333333333';
let mono = 1000;
let player: FakeYtPlayer;
let host: DataConnection;
async function advance(ms: number) {
  mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
async function sample(id: number, hostSentAt: number) {
  registerPing(id);
  await advance(4);
  expect(processSyncPong(id, hostSentAt + 2)).not.toBeNull();
}
function heartbeat(position: number) {
  harness.handlers[MSG.YOUTUBE_SYNC](
    { queueItemId: Q, time: position, state: 1, videoId: 'FAKE_VIDEO_ID', hostClock: getHostNow() },
    host,
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  mono = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetClockState();
  host = {
    open: true,
    peer: 'clock-youtube-host',
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('playlist.items', [
    {
      queueItemId: Q,
      type: 'youtube',
      name: 'clock video',
      videoId: 'FAKE_VIDEO_ID',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', Q);
  player = makeFakeYtPlayer({ __state: 1, __currentTime: 10, __duration: 120 });
  setYouTubePlayer(player as never);
  setPlaybackYouTubePlaying();
  initYouTubeSync();
  resetYouTubeSyncState();
  for (let id = 1; id <= 3; id++) await sample(id, Date.now());
  heartbeat(10);
  expect(guestRendezvousSync().status).toBe('started');
  await advance(3500);
  expect(getManagedTimer('yt-rendezvous-calibrate')).toBeNull();
});
afterEach(() => {
  resetYouTubeSyncState();
  setYouTubePlayer(null);
  resetClockState();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([0, -60000, 60000])(
  'applies manual sync after a calibrated %ims wall step',
  async (step) => {
    const hostBefore = Date.now();
    vi.setSystemTime(Date.now() + step);
    await sample(10, hostBefore);
    expect(getClockOffset()).toBeCloseTo(-step, 3);
    expect(getHostNow()).toBeCloseTo(hostBefore + 4, 3);
    const start = player.__log.length;
    heartbeat(20);
    setState('sync.youtubeLocalOffset', 1);
    bus.emit('youtube:apply-manual-sync');
    const ops = () =>
      player.__log.slice(start).filter((x) => ['pauseVideo', 'seekTo', 'playVideo'].includes(x.op));
    expect(ops().some((x) => x.op === 'seekTo' && Number(x.args?.[0]) >= 22.5)).toBe(true);
    await advance(1600);
    expect(ops().some((x) => x.op === 'playVideo')).toBe(true);
  },
);

it.each([0, -60000, 60000])(
  'corrects a fresh heartbeat after a %ims wall step without extending suppression',
  async (step) => {
    const hostBefore = Date.now();
    vi.setSystemTime(Date.now() + step);
    await sample(10, hostBefore);
    const start = player.__log.length;
    heartbeat(40);
    expect(player.__log.slice(start).some((x) => x.op === 'seekTo' && x.args?.[0] === 40)).toBe(
      true,
    );
  },
);
