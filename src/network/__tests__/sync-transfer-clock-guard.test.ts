/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData, resetInboundRateLimit } from '../protocol.ts';
import { getClockOffset, isClockCalibrated, resetClockState } from '../shared-clock.ts';
import { initSync } from '../sync.ts';
import { setCurrentAudioBuffer, setLocalFilePaused, setPlayLocked } from '../../player/_state.ts';
import { setPlaybackFilePlaying, setPlaybackLifecycleState } from '../../player/ownership.ts';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from '../../diagnostics/standard-start-observations.ts';

const Q = '00000000-0000-4000-8000-0000000000c1';
const BASE = 1_700_000_000_000;
// The host wall clock is ahead of this guest; the estimate must recover it.
const TRUE_OFFSET_MS = 1_234;
// Host media position 0 played at this host time, so playback starts at 10s.
const HOST_TRACK_START_MS = BASE + TRUE_OFFSET_MS - 10_000;
const QUIET_LEG_MS = 4;

/** The guest's local audio follows the monotonic clock from its last start. */
const media = vi.hoisted(() => ({
  play: vi.fn(),
  mono: 0,
  anchorPosition: 0,
  anchorMono: 0,
}));

vi.mock('../../player/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../player/transport.ts')>();
  return {
    ...actual,
    play: media.play,
    getTrackPosition: () => media.anchorPosition + (media.mono - media.anchorMono) / 1000,
    isLocalFileStartPending: () => false,
    getStandardHostPendingFileStartAt: () => undefined,
    getLocalFilePendingStartDeadlineMs: () => undefined,
  };
});

type Decision = {
  decision: string;
  reason?: string;
  expectedPositionSeconds?: number;
  localPositionSeconds?: number;
};

let hostConn: DataConnection & { send: Mock<(data: unknown) => void> };
let decisions: Decision[];
let localWallStepMs = 0;
let hostWallStepMs = 0;

/** Reference host time: unaffected by either wall-clock edit. */
function hostMediaNow(): number {
  return Date.now() - localWallStepMs + TRUE_OFFSET_MS;
}

function hostPosition(): number {
  return (hostMediaNow() - HOST_TRACK_START_MS) / 1000;
}

function localPosition(): number {
  return media.anchorPosition + (media.mono - media.anchorMono) / 1000;
}

/** Positive when the guest's audio is ahead of the host's. */
function localErrorMs(): number {
  return (localPosition() - hostPosition()) * 1000;
}

function setGuestErrorMs(errorMs: number): void {
  media.anchorPosition = hostPosition() + errorMs / 1000;
  media.anchorMono = media.mono;
}

async function advance(ms: number): Promise<void> {
  media.mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

/** Deterministic 250..700ms queueing behind file data. */
function queueDelayMs(index: number): number {
  return 250 + ((index * 37) % 11) * 45;
}

/** Answer the newest SYNC_PING: the host samples on arrival, either leg may queue. */
async function answer(upMs: number, downMs: number): Promise<void> {
  const pings = hostConn.send.mock.calls
    .map(([message]) => message as { type?: string; pingId?: number })
    .filter((message) => message.type === MSG.SYNC_PING);
  const pingId = pings.at(-1)!.pingId!;
  await advance(upMs);
  const hostTime = hostMediaNow() + hostWallStepMs;
  const position = hostPosition();
  await advance(downMs);
  await handleData(
    {
      type: MSG.SYNC_PONG,
      pingId,
      hostTime,
      position,
      mode: 'file',
      activity: 'playing',
      queueItemId: Q,
    },
    hostConn,
  );
}

/** One worker tick: the guest pings once a second. */
async function tick(upMs: number, downMs: number): Promise<void> {
  bus.emit('worker:timer-tick', 'sync');
  await answer(upMs, downMs);
  await advance(1_000 - upMs - downMs);
}

async function transferTick(second: number, leg: 'ping' | 'pong' = 'pong'): Promise<void> {
  const queued = queueDelayMs(second);
  await tick(
    QUIET_LEG_MS + (leg === 'ping' ? queued : 0),
    QUIET_LEG_MS + (leg === 'pong' ? queued : 0),
  );
}

/** Starts aligned playback; its armed initial re-lock runs on the quiet clock. */
async function startAlignedPlayback(legMs = QUIET_LEG_MS, seconds = 10): Promise<void> {
  setGuestErrorMs(30);
  setPlaybackFilePlaying();
  setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
  // sync.ts remembers the previous test's playing state, so arm explicitly.
  bus.emit('sync:arm-initial');
  for (let second = 0; second < seconds; second += 1) await tick(legMs, legMs);
  expect(media.play).toHaveBeenCalledTimes(1);
  expect(decisions.filter((decision) => decision.decision === 'initial')).toHaveLength(1);
  expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
  media.play.mockClear();
  decisions.length = 0;
}

function decisionKinds(): string[] {
  return [...new Set(decisions.map((decision) => decision.decision))];
}

function restoredSelections() {
  return getStandardStartObservations().clock.filter(
    (record) => record.kind === 'clock-selection' && record.detail.reason === 'restore',
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  media.mono = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => media.mono);
  clearAllManagedTimers();
  resetState();
  resetClockState();
  resetStandardStartObservations();
  setCurrentAudioBuffer(null);
  setPlayLocked(false);
  setLocalFilePaused(false);
  bus.clear();
  localWallStepMs = hostWallStepMs = 0;
  media.play.mockReset();
  media.play.mockImplementation(async (position: number) => {
    media.anchorPosition = position;
    media.anchorMono = media.mono;
    return true;
  });
  hostConn = {
    peer: 'host-transfer',
    open: true,
    send: vi.fn<(data: unknown) => void>(),
    close: vi.fn(),
    on: vi.fn(),
  };
  resetInboundRateLimit(hostConn.peer);
  initSync();
  setState('network.hostConn', hostConn);
  setState('playlist.currentQueueItemId', Q);
  setCurrentAudioBuffer({ duration: 600 } as AudioBuffer);
  decisions = [];
  bus.on('sync:diagnostic-standard-decision', (decision) => decisions.push(decision));
});

afterEach(() => {
  clearAllManagedTimers();
  resetClockState();
  setCurrentAudioBuffer(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('local-file playback while the next file transfers', () => {
  it.each(['pong', 'ping'] as const)(
    'leaves aligned playback untouched through 100 seconds of %s queueing',
    async (leg) => {
      await startAlignedPlayback();
      for (let second = 0; second < 100; second += 1) await transferTick(second, leg);
      expect(media.play).not.toHaveBeenCalled();
      expect(decisions).toHaveLength(100);
      expect(decisionKinds()).toEqual(['observe']);
      expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
      expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    },
  );

  it('withholds soft correction once only queued replies remain past the 120s age limit', async () => {
    await startAlignedPlayback();
    for (let second = 0; second < 150; second += 1) await transferTick(second);
    expect(media.play).not.toHaveBeenCalled();
    const withheld = decisions.filter((decision) => decision.decision === 'skipped');
    expect(withheld.length).toBeGreaterThan(10);
    expect(new Set(withheld.map((decision) => decision.reason))).toEqual(
      new Set(['clock-uncertainty']),
    );
    // Each withheld drift is midpoint bias alone: the guest never moved.
    for (const decision of withheld) {
      const driftMs = (decision.expectedPositionSeconds! - decision.localPositionSeconds!) * 1000;
      expect(Math.abs(driftMs)).toBeGreaterThanOrEqual(50);
    }
    expect(decisionKinds().sort()).toEqual(['observe', 'skipped']);

    // Quiet replies after the transfer bring back the precise clock, still
    // without a correction because playback stayed aligned throughout.
    for (let second = 0; second < 5; second += 1) await tick(QUIET_LEG_MS, QUIET_LEG_MS);
    expect(media.play).not.toHaveBeenCalled();
    expect(decisions.at(-1)).toMatchObject({ decision: 'observe' });
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
  });

  it('still corrects genuine drift during a transfer while the quiet clock is retained', async () => {
    await startAlignedPlayback();
    for (let second = 0; second < 70; second += 1) await transferTick(second);
    setGuestErrorMs(-120);
    for (let second = 70; second < 72; second += 1) await transferTick(second);
    expect(media.play).not.toHaveBeenCalled();
    await transferTick(72);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(decisions.at(-1)).toMatchObject({ decision: 'soft' });
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
  });
});

describe('local-file soft resync clock admission', () => {
  it.each([4, 10, 20, 40])(
    'still soft-corrects a genuine 51ms drift on a quiet %ims RTT clock',
    async (rttMs) => {
      await startAlignedPlayback(rttMs / 2);
      setGuestErrorMs(51);
      await tick(rttMs / 2, rttMs / 2);
      await tick(rttMs / 2, rttMs / 2);
      expect(media.play).not.toHaveBeenCalled();
      await tick(rttMs / 2, rttMs / 2);
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(decisions.at(-1)).toMatchObject({ decision: 'soft' });
      expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
    },
  );

  it('requires strict improvement around the 2U boundary of a 110ms RTT clock', async () => {
    // U = 110 / 2 + 5 = 60ms, so 2U = 120ms.
    await startAlignedPlayback(55);
    setGuestErrorMs(118);
    for (let second = 0; second < 4; second += 1) await tick(55, 55);
    expect(media.play).not.toHaveBeenCalled();
    expect(decisions).toHaveLength(4);
    expect(decisions.every((decision) => decision.reason === 'clock-uncertainty')).toBe(true);

    setGuestErrorMs(122);
    for (let second = 0; second < 3; second += 1) await tick(55, 55);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(decisions.at(-1)).toMatchObject({ decision: 'soft' });
  });

  it('restarts the same-direction confirmation after a withheld sample', async () => {
    await startAlignedPlayback(55);
    for (const errorMs of [130, 130, 110, 130, 130]) {
      setGuestErrorMs(errorMs);
      await tick(55, 55);
    }
    expect(media.play).not.toHaveBeenCalled();
    setGuestErrorMs(130);
    await tick(55, 55);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it('withholds correction while the selected sample spans an unresolved local wall step', async () => {
    await startAlignedPlayback(3);
    // Too small to corroborate as a local edit, so the earlier precise sample
    // stays selected with a wall age that no longer matches monotonic time.
    localWallStepMs = 105;
    vi.setSystemTime(Date.now() + localWallStepMs);
    for (let second = 0; second < 3; second += 1) await tick(QUIET_LEG_MS, QUIET_LEG_MS);
    expect(media.play).not.toHaveBeenCalled();
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision).toMatchObject({ decision: 'skipped', reason: 'clock-discontinuity' });
      const driftMs = (decision.expectedPositionSeconds! - decision.localPositionSeconds!) * 1000;
      expect(driftMs).toBeCloseTo(localWallStepMs, 6);
    }
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
  });
});

describe('re-lock paths during a transfer', () => {
  it('re-locks a manual Sync on the retained quiet clock when its reply queued', async () => {
    await startAlignedPlayback();
    for (let second = 0; second < 30; second += 1) await transferTick(second);
    setGuestErrorMs(-40);
    bus.emit('sync:force-resync');
    expect(isClockCalibrated()).toBe(false);
    // The forced reply queued 600ms; alone it would bias the clock by -300ms.
    await answer(QUIET_LEG_MS, QUIET_LEG_MS + 600);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(decisions.at(-1)).toMatchObject({ decision: 'initial' });
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    expect(restoredSelections()).toHaveLength(1);
  });

  it('runs the post-PLAY initial re-lock 70 seconds into a transfer on the quiet clock', async () => {
    await startAlignedPlayback();
    for (let second = 0; second < 70; second += 1) await transferTick(second);
    setGuestErrorMs(30);
    bus.emit('sync:arm-initial');
    await transferTick(70);
    expect(media.play).not.toHaveBeenCalled();
    await transferTick(71);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(decisions.at(-1)).toMatchObject({ decision: 'initial' });
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
  });

  it('still starts a manual Sync cold when a precise reply shows the host clock stepped', async () => {
    await startAlignedPlayback();
    // The host wall clock jumps; its media timeline does not.
    hostWallStepMs = 300;
    bus.emit('sync:force-resync');
    await answer(QUIET_LEG_MS, QUIET_LEG_MS);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS + hostWallStepMs);
    expect(Math.abs(localErrorMs())).toBeLessThan(0.5);
    expect(restoredSelections()).toHaveLength(0);
  });
});
