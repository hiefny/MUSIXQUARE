/**
 * The shared YouTube start timing homes in src/youtube/constants.ts (Phase 6
 * 6A-3, C2-1; registry RO-02, RO-03 and RO-12) and their parity with the
 * receiver's copies in src/network/protocol.ts.
 *
 * Before 6A-3 the Standard zero-start controller (zero-start.ts), the PRO arm
 * (authority-arm.ts), the PRO prepare seam (iframe.ts) and the Standard
 * recovery paths (player.ts) each typed these numbers. The first block pins
 * every home to the value its copies held, so the move changes no number.
 *
 * The wire is frozen, so protocol.ts keeps its own bounds for the zero-start
 * frames. The second block ties each bound to the sender: it drives the real
 * controller to the edge of what it can send, hands that frame to the
 * receiver through registerHandler and handleData, and checks that the frame
 * reaches its handler while one step past the sender's edge does not (a
 * frame the sender can send follows every dropped one, so the receiver's
 * per-peer inbound bucket cannot pass for its validator). A receiver bound
 * that drifts from its sender fails here. protocol.test.ts "YouTube
 * zero-start protocol validation" pins the receiver's edges on their own.
 *
 * This suite loads no Worker code (see ci-quality-gates.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, type MsgType } from '../../core/constants.ts';
import { resetState } from '../../core/state.ts';
import { handleData, registerHandler } from '../../network/protocol.ts';
import type { DataConnection, YouTubeZeroStartPlatform } from '../../types/index.ts';
import {
  ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS,
  PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS,
  PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS,
  STANDARD_ZERO_START_BARRIER,
  STANDARD_ZERO_START_COMMIT_LEAD_MS,
  STANDARD_ZERO_START_GUEST_DECISION_MS,
  STANDARD_ZERO_START_GUEST_TOTAL_WAIT_MS,
  STANDARD_ZERO_START_LATE_FALLBACK_LEAD_MS,
  STANDARD_ZERO_START_PREPARE_BUDGET_MS,
  YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS,
  YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS,
  YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
  YOUTUBE_ARM_HARD_MUTE_POLL_MS,
  YOUTUBE_ARM_PAUSE_SEEK_GAP_MS,
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
  YOUTUBE_ARM_SETTLE_EPSILON_SEC,
  YOUTUBE_ARM_SETTLE_POLL_MS,
  YOUTUBE_ARM_SETTLE_RESEEK_EVERY,
  YOUTUBE_ARM_SETTLE_STABLE_SAMPLES,
  YOUTUBE_ARM_TIMING,
  YOUTUBE_ARM_WARM_PLAY_MS,
  YOUTUBE_FRESH_START_MAX_SEC,
  YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS,
  YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC,
} from '../constants.ts';
import {
  YouTubeZeroStartControllerForTests as YouTubeZeroStartController,
  getYouTubeZeroStartRelativeLeadForTests as getYouTubeZeroStartRelativeLead,
  type YouTubeZeroStartDependenciesForTests as YouTubeZeroStartDependencies,
  type YouTubeZeroStartPlayer,
  type YouTubeZeroStartWireMessage,
} from '../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

type WireType = YouTubeZeroStartWireMessage['type'];
type WireFrame<T extends WireType> = Extract<YouTubeZeroStartWireMessage, { type: T }>;
type PrepareFrame = WireFrame<typeof MSG.YOUTUBE_ZERO_START_PREPARE>;

const HOST_ID = 'parity-host';
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'M7lc1UVf-VE';
/** More than one whole arm: hard mute, warm play, pause and seek, settle, audio restore. */
const ARM_RUN_MS = 1_000;
const LEAD_FIELDS = ['startLeadMs', 'audibleBaseLeadMs', 'timelineLeadMs'] as const;

function guestId(index: number): string {
  return `parity-guest-${String(index).padStart(2, '0')}`;
}

interface Endpoint {
  readonly controller: YouTubeZeroStartController;
  readonly player: FakeYtPlayer;
  readonly sent: YouTubeZeroStartWireMessage[];
}

interface EndpointOptions {
  readonly guests?: readonly string[];
  readonly platform?: YouTubeZeroStartPlatform;
  readonly learnedTimelineLeadMs?: number;
  readonly deps?: Partial<YouTubeZeroStartDependencies>;
}

/** A real controller on a fake iframe; every frame it sends is recorded, none is delivered. */
function endpoint(role: 'host' | 'guest', peerId: string, options: EndpointOptions = {}): Endpoint {
  const sent: YouTubeZeroStartWireMessage[] = [];
  const player = makeFakeYtPlayer({ __autoPlayOnLoad: true, __muted: false, __volume: 80 });
  const controller = new YouTubeZeroStartController({
    getRole: () => role,
    getLocalPeerId: () => peerId,
    getHostPeerId: () => (role === 'guest' ? HOST_ID : null),
    getLiveGuestPeerIds: () => [...(options.guests ?? [])],
    getPlayer: () => player as YouTubeZeroStartPlayer,
    isPlayerReady: () => true,
    isAudioUnlocked: () => true,
    isClockCalibrated: () => true,
    getHostNow: () => Date.now(),
    getClockOffsetMs: () => 0,
    getLocalPlatform: () => options.platform ?? 'other',
    getLearnedTimelineLeadMs: () => options.learnedTimelineLeadMs ?? null,
    sendToPeer: (_peerId, message) => {
      sent.push(message);
      return true;
    },
    sendToHost: (message) => {
      sent.push(message);
      return true;
    },
    createRunId: (sequence) => `parity-run-${sequence}`,
    ...options.deps,
  });
  player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
  return { controller, player, sent };
}

function framesOf<T extends WireType>(source: Endpoint, type: T): WireFrame<T>[] {
  return source.sent.filter((frame): frame is WireFrame<T> => frame.type === type);
}

function lastFrame<T extends WireType>(source: Endpoint, type: T): WireFrame<T> {
  const frame = framesOf(source, type).at(-1);
  if (!frame) {
    throw new Error(`Expected a ${type} frame; sent ${source.sent.map((f) => f.type).join(', ')}`);
  }
  return frame;
}

/** A host whose live guests have all advertised zero-start capability. */
function hostWith(guestCount: number): Endpoint {
  const guests = Array.from({ length: guestCount }, (_, index) => guestId(index));
  const host = endpoint('host', HOST_ID, { guests });
  for (const peerId of guests) {
    host.controller.handleCapability(peerId, {
      type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
      version: 2,
      platform: 'other',
      ready: true,
    });
  }
  return host;
}

function beginRun(host: Endpoint): boolean {
  return host.controller.beginHostTransition({
    queueItemId: QUEUE_ITEM_ID,
    videoId: VIDEO_ID,
    subIndex: null,
  });
}

/** The PREPARE a real host sends its one guest. */
function hostPrepare(): PrepareFrame {
  const host = hostWith(1);
  expect(beginRun(host)).toBe(true);
  return lastFrame(host, MSG.YOUTUBE_ZERO_START_PREPARE);
}

/** A real guest that took the PREPARE and then ran for one whole arm. */
function armedGuest(prepare: PrepareFrame, options: EndpointOptions = {}): Endpoint {
  const guest = endpoint('guest', guestId(0), options);
  expect(guest.controller.handlePrepare(HOST_ID, prepare)).toBe(true);
  vi.advanceTimersByTime(ARM_RUN_MS);
  return guest;
}

function advanceUntil(condition: () => boolean, limitMs = 5_000): void {
  for (let elapsed = 0; !condition(); elapsed += 10) {
    if (elapsed >= limitMs) throw new Error(`Condition not met within ${limitMs} ms`);
    vi.advanceTimersByTime(10);
  }
}

/**
 * Hands each frame to the receiver (handleData) from one synthetic peer and
 * returns the frames its handler got. Every check uses its own peer.
 */
async function received(peer: string, frames: readonly object[]): Promise<unknown[]> {
  const got: unknown[] = [];
  const conn = { peer } as DataConnection;
  for (const frame of frames) {
    registerHandler((frame as { type: MsgType }).type, (data) => {
      got.push(data);
    });
    await handleData(frame, conn);
  }
  return got;
}

/** The receiver takes `edge` and drops `past`; `edge` again shows the drop is the validator's. */
async function expectEdge(peer: string, edge: object, past: object): Promise<void> {
  expect(await received(peer, [edge, past, edge])).toEqual([edge, edge]);
}

beforeEach(() => {
  resetState();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('YouTube start timing homes (C2-1)', () => {
  it('pins every shared start timing to the value its copies held before they moved', () => {
    expect({ ...YOUTUBE_ARM_TIMING }).toStrictEqual({
      hardMutePollMs: 30,
      hardMuteMaxAttempts: 12,
      warmPlayMs: 260,
      pauseSeekGapMs: 80,
      settlePollMs: 80,
      settleEpsilonSec: 0.12,
      settleStableSamples: 2,
      settleReseekEvery: 6,
      audioRestorePollMs: 120,
      audioRestoreMaxAttempts: 8,
      releaseAckTimeoutMs: 1_800,
      releaseCatchUpToleranceMs: 40,
    });
    expect(Object.isFrozen(YOUTUBE_ARM_TIMING)).toBe(true);
    expect({ ...STANDARD_ZERO_START_BARRIER }).toStrictEqual({
      guestTotalWaitMs: 3_000,
      guestDecisionMs: 2_300,
      startLeadMs: 700,
      prepareBudgetMs: 10_000,
      lateFallbackLeadMs: 800,
    });
    expect(Object.isFrozen(STANDARD_ZERO_START_BARRIER)).toBe(true);
    // The PRO barriered budget and the Standard guest decision are both 2.3 s
    // but stay separate homes, linked by comment only.
    expect(PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS).toBe(2_300);
    expect(PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS).toBe(10_000);
    // A separate name from the settle epsilon, which has the same value.
    expect(YOUTUBE_FRESH_START_MAX_SEC).toBe(0.12);
  });

  it('derives the 7.7 s a cohort-excluded guest adopts as the Standard prepare budget minus the guest decision', () => {
    expect(
      STANDARD_ZERO_START_BARRIER.prepareBudgetMs - STANDARD_ZERO_START_BARRIER.guestDecisionMs,
    ).toBe(7_700);
  });

  it('keeps the release catch-up tolerance in seconds at exactly the double 0.04 the literals held', () => {
    expect(YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC).toBe(
      YOUTUBE_ARM_TIMING.releaseCatchUpToleranceMs / 1_000,
    );
    expect(YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC).toBe(0.04);
  });
});

describe('YouTube start timing homes, one named export each (C2-1)', () => {
  it('pins every shared start timing to the value its copies held before they moved', () => {
    expect({
      YOUTUBE_ARM_HARD_MUTE_POLL_MS,
      YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
      YOUTUBE_ARM_WARM_PLAY_MS,
      YOUTUBE_ARM_PAUSE_SEEK_GAP_MS,
      YOUTUBE_ARM_SETTLE_POLL_MS,
      YOUTUBE_ARM_SETTLE_EPSILON_SEC,
      YOUTUBE_ARM_SETTLE_STABLE_SAMPLES,
      YOUTUBE_ARM_SETTLE_RESEEK_EVERY,
      YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS,
      YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS,
      YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
      YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS,
    }).toStrictEqual({
      YOUTUBE_ARM_HARD_MUTE_POLL_MS: 30,
      YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS: 12,
      YOUTUBE_ARM_WARM_PLAY_MS: 260,
      YOUTUBE_ARM_PAUSE_SEEK_GAP_MS: 80,
      YOUTUBE_ARM_SETTLE_POLL_MS: 80,
      YOUTUBE_ARM_SETTLE_EPSILON_SEC: 0.12,
      YOUTUBE_ARM_SETTLE_STABLE_SAMPLES: 2,
      YOUTUBE_ARM_SETTLE_RESEEK_EVERY: 6,
      YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS: 120,
      YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS: 8,
      YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS: 1_800,
      YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS: 40,
    });
    expect({
      STANDARD_ZERO_START_GUEST_TOTAL_WAIT_MS,
      STANDARD_ZERO_START_GUEST_DECISION_MS,
      STANDARD_ZERO_START_COMMIT_LEAD_MS,
      STANDARD_ZERO_START_PREPARE_BUDGET_MS,
      STANDARD_ZERO_START_LATE_FALLBACK_LEAD_MS,
    }).toStrictEqual({
      STANDARD_ZERO_START_GUEST_TOTAL_WAIT_MS: 3_000,
      STANDARD_ZERO_START_GUEST_DECISION_MS: 2_300,
      STANDARD_ZERO_START_COMMIT_LEAD_MS: 700,
      STANDARD_ZERO_START_PREPARE_BUDGET_MS: 10_000,
      STANDARD_ZERO_START_LATE_FALLBACK_LEAD_MS: 800,
    });
    // The PRO barriered budget and the Standard guest decision are both 2.3 s
    // but stay separate homes, linked by comment only.
    expect(PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS).toBe(2_300);
    expect(PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS).toBe(10_000);
    // A separate name from the settle epsilon, which has the same value.
    expect(YOUTUBE_FRESH_START_MAX_SEC).toBe(0.12);
  });

  it('derives the 7.7 s a cohort-excluded guest adopts as the Standard prepare budget minus the guest decision', () => {
    expect(STANDARD_ZERO_START_PREPARE_BUDGET_MS - STANDARD_ZERO_START_GUEST_DECISION_MS).toBe(
      7_700,
    );
  });

  it('keeps the release catch-up tolerance in seconds at exactly the double 0.04 the literals held', () => {
    expect(YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC).toBe(
      YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS / 1_000,
    );
    expect(YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC).toBe(0.04);
  });
});

describe('zero-start sender edges inside the receiver bounds (protocol.ts, wire frozen)', () => {
  it("sends the guest total wait as the PREPARE window; the receiver's window bound is the 10 s Standard prepare budget", async () => {
    const host = hostWith(1);
    expect(beginRun(host)).toBe(true);
    const prepare = lastFrame(host, MSG.YOUTUBE_ZERO_START_PREPARE);
    expect(await received('parity-prepare', [prepare])).toEqual([prepare]);

    expect(prepare.decisionAtHost - prepare.prepareAtHost).toBe(
      STANDARD_ZERO_START_BARRIER.guestDecisionMs,
    );
    expect(prepare.startDeadlineAtHost - prepare.prepareAtHost).toBe(
      STANDARD_ZERO_START_BARRIER.guestTotalWaitMs,
    );
    const atBudget = {
      ...prepare,
      startDeadlineAtHost: prepare.prepareAtHost + STANDARD_ZERO_START_BARRIER.prepareBudgetMs,
    };
    await expectEdge('parity-prepare-budget', atBudget, {
      ...atBudget,
      startDeadlineAtHost: atBudget.startDeadlineAtHost + 1,
    });
  });

  it.each(['other', 'android'] as const)(
    'sends ARMED leads up to the ±600 ms sender clamp from a real %s guest; the receiver takes the clamp and drops 1 ms past it',
    async (platform) => {
      const clampMs = getYouTubeZeroStartRelativeLead('other', 'other', 10_000).totalLeadMs;
      expect(clampMs).toBe(600);
      expect(getYouTubeZeroStartRelativeLead('other', 'other', -10_000).totalLeadMs).toBe(-clampMs);
      const prepare = hostPrepare();

      for (const learnedTimelineLeadMs of [10_000, -10_000]) {
        const guest = armedGuest(prepare, { platform, learnedTimelineLeadMs });
        const armed = lastFrame(guest, MSG.YOUTUBE_ZERO_START_ARMED);
        const lead = getYouTubeZeroStartRelativeLead(
          platform,
          prepare.hostPlatform,
          learnedTimelineLeadMs,
        );
        expect(armed).toMatchObject({
          platform,
          startLeadMs: lead.totalLeadMs,
          audibleBaseLeadMs: lead.audibleBaseLeadMs,
          timelineLeadMs: lead.timelineLeadMs,
        });
        // The Android output delay goes out unclamped as the audible base.
        expect(armed.audibleBaseLeadMs).toBe(
          platform === 'android' ? ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS : 0,
        );
        const leads = LEAD_FIELDS.map((field) => Math.abs(armed[field]));
        expect(Math.max(...leads)).toBe(clampMs);

        const peer = `parity-lead-${platform}-${learnedTimelineLeadMs > 0 ? 'up' : 'down'}`;
        expect(await received(peer, [armed])).toEqual([armed]);
        for (const field of LEAD_FIELDS) {
          const value = armed[field];
          if (Math.abs(value) !== clampMs) continue;
          await expectEdge(`${peer}-${field}`, armed, {
            ...armed,
            [field]: value + Math.sign(value),
          });
        }
      }
    },
  );

  it('clamps ARMED position, volume and loaded fraction to exactly the bounds the receiver takes', async () => {
    const prepare = hostPrepare();
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly read: Pick<FakeYtPlayer, '__currentTime' | '__volume' | '__loadedFraction'>;
      readonly sent: { positionSec: number; volume: number; loadedFraction: number };
      readonly past: { positionSec: number; volume: number; loadedFraction: number };
    }> = [
      {
        label: 'high',
        read: { __currentTime: 40_000_000, __volume: 250, __loadedFraction: 7 },
        sent: { positionSec: 31_536_000, volume: 100, loadedFraction: 1 },
        past: { positionSec: 31_536_000.001, volume: 100.001, loadedFraction: 1.001 },
      },
      {
        label: 'low',
        read: { __currentTime: -5, __volume: -20, __loadedFraction: -1 },
        sent: { positionSec: 0, volume: 0, loadedFraction: 0 },
        past: { positionSec: -0.001, volume: -0.001, loadedFraction: -0.001 },
      },
    ];

    for (const { label, read, sent, past } of cases) {
      // An uncalibrated clock holds the guest's ARMED after the arm, so the
      // iframe can report out-of-range values to the report itself.
      let calibrated = false;
      const guest = armedGuest(prepare, { deps: { isClockCalibrated: () => calibrated } });
      expect(guest.controller.getSnapshot().phase).toBe('armed');
      expect(framesOf(guest, MSG.YOUTUBE_ZERO_START_ARMED)).toEqual([]);
      Object.assign(guest.player, read);
      calibrated = true;
      advanceUntil(() => framesOf(guest, MSG.YOUTUBE_ZERO_START_ARMED).length > 0);

      const armed = lastFrame(guest, MSG.YOUTUBE_ZERO_START_ARMED);
      expect(armed).toMatchObject(sent);
      expect(await received(`parity-clamp-${label}`, [armed])).toEqual([armed]);
      for (const field of ['positionSec', 'volume', 'loadedFraction'] as const) {
        await expectEdge(`parity-clamp-${label}-${field}`, armed, {
          ...armed,
          [field]: past[field],
        });
      }
    }
  });

  it('clamps ARMED preparedMs to the 60,000 ms the receiver takes, across a device clock jump', async () => {
    const prepare = hostPrepare();
    let jumpMs = 0;
    const guest = armedGuest(prepare, {
      deps: {
        now: () => Date.now() + jumpMs,
        // The device clock jumps 70 s while the arm restores audio.
        onPhaseChange: (snapshot) => {
          if (snapshot.phase === 'restoring-audio') jumpMs = 70_000;
        },
      },
    });
    const armed = lastFrame(guest, MSG.YOUTUBE_ZERO_START_ARMED);
    expect(armed.preparedMs).toBe(60_000);
    // A run whose warm-up outlasts its prepare budget never arms, so the warm
    // latency the same clamp bounds stays far below it.
    expect(armed.warmLatencyMs).toBeGreaterThanOrEqual(0);
    expect(armed.warmLatencyMs).toBeLessThan(60_000);
    expect(await received('parity-prepared', [armed])).toEqual([armed]);
    await expectEdge('parity-prepared-past', armed, { ...armed, preparedMs: 60_001 });
    await expectEdge(
      'parity-warm-past',
      { ...armed, warmLatencyMs: 60_000 },
      { ...armed, warmLatencyMs: 60_001 },
    );
  });

  it('commits at most its 99 live guests and itself, the 100 peers the receiver takes', async () => {
    // A room of 100 live guests keeps the rendezvous path: no PREPARE at all.
    const crowded = hostWith(100);
    expect(beginRun(crowded)).toBe(false);
    expect(crowded.sent).toEqual([]);

    const host = hostWith(99);
    expect(beginRun(host)).toBe(true);
    const armed = lastFrame(
      armedGuest(lastFrame(host, MSG.YOUTUBE_ZERO_START_PREPARE)),
      MSG.YOUTUBE_ZERO_START_ARMED,
    );
    for (let index = 0; index < 99; index += 1) {
      expect(host.controller.handleArmed(guestId(index), armed)).toBe(true);
    }
    advanceUntil(() => framesOf(host, MSG.YOUTUBE_ZERO_START_COMMIT).length > 0);

    const commit = lastFrame(host, MSG.YOUTUBE_ZERO_START_COMMIT);
    expect(commit.reason).toBe('all-ready');
    expect(commit.cohort).toHaveLength(100);
    expect(new Set(commit.cohort).size).toBe(100);
    await expectEdge('parity-cohort', commit, {
      ...commit,
      cohort: [...commit.cohort, guestId(99)],
    });
  });

  it('clamps TIMELINE positions to exactly the bound the receiver takes', async () => {
    const host = hostWith(1);
    expect(beginRun(host)).toBe(true);
    const armed = lastFrame(
      armedGuest(lastFrame(host, MSG.YOUTUBE_ZERO_START_PREPARE)),
      MSG.YOUTUBE_ZERO_START_ARMED,
    );
    expect(host.controller.handleArmed(guestId(0), armed)).toBe(true);
    advanceUntil(() => host.controller.getSnapshot().phase === 'playing');

    host.player.__currentTime = 40_000_000;
    advanceUntil(() => framesOf(host, MSG.YOUTUBE_ZERO_START_TIMELINE).length === 1);
    host.player.__currentTime = -5;
    advanceUntil(() => framesOf(host, MSG.YOUTUBE_ZERO_START_TIMELINE).length === 2);

    const [high, low] = framesOf(host, MSG.YOUTUBE_ZERO_START_TIMELINE);
    expect(high).toMatchObject({ positionSec: 31_536_000 });
    expect(low).toMatchObject({ positionSec: 0 });
    await expectEdge('parity-timeline-high', high, { ...high, positionSec: 31_536_000.001 });
    await expectEdge('parity-timeline-low', low, { ...low, positionSec: -0.001 });
  });
});
