import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId, YouTubeZeroStartPlatform } from '../../types/index.ts';
import {
  YouTubeAuthorityArmController,
  getYouTubeAuthorityPlatformLeadMsForTests,
  type YouTubeAuthorityArmPlayer,
} from '../authority-arm.ts';
import { makeFakeYtPlayer, ops, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111' as QueueItemId;
const VIDEO_ID = 'M7lc1UVf-VE';

const identity = {
  authorityKey: 'transition-1',
  queueItemId: QUEUE_ITEM_ID,
  videoId: VIDEO_ID,
  subIndex: 0,
};

function makeHarness(options?: {
  platform?: YouTubeZeroStartPlatform;
  videoId?: string;
  autoPlayOnLoad?: boolean;
  muted?: boolean;
  volume?: number;
}) {
  const player = makeFakeYtPlayer({
    __videoId: options?.videoId ?? VIDEO_ID,
    __state: 2,
    __autoPlayOnLoad: options?.autoPlayOnLoad ?? true,
    __muted: options?.muted ?? false,
    __volume: options?.volume ?? 37,
  });
  let currentPlayer: YouTubeAuthorityArmPlayer | null = player as YouTubeAuthorityArmPlayer;
  const phases: string[] = [];
  const controller = new YouTubeAuthorityArmController({
    getPlayer: () => currentPlayer,
    getPlatform: () => options?.platform ?? 'other',
    nowMs: () => Date.now(),
    onPhaseChange: (phase) => phases.push(phase),
  });
  player.__onStateChange = ({ data }) => {
    controller.handlePlayerStateChange(data);
  };
  return {
    controller,
    player,
    phases,
    setPlayer: (next: YouTubeAuthorityArmPlayer | null) => {
      currentPlayer = next;
    },
  };
}

async function prepareReady(
  controller: YouTubeAuthorityArmController,
  strategy: 'resident' | 'load',
  targetSeconds = 12,
) {
  const resultPromise = controller.prepare({ ...identity, strategy, targetSeconds });
  await vi.runAllTimersAsync();
  const result = await resultPromise;
  expect(result.status).toBe('ready');
  return result;
}

function count(player: FakeYtPlayer, op: FakeYtPlayer['__log'][number]['op']): number {
  return player.__log.filter((call) => call.op === op).length;
}

describe('YouTubeAuthorityArmController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('warms and settles resident media without issuing a physical load', async () => {
    const { controller, player } = makeHarness();

    const result = await prepareReady(controller, 'resident', 19.5);

    expect(result).toMatchObject({
      status: 'ready',
      prepared: {
        ...identity,
        strategy: 'resident',
        targetSeconds: 19.5,
      },
    });
    expect(count(player, 'loadVideoById')).toBe(0);
    expect(count(player, 'playVideo')).toBe(1);
    expect(player.__currentTime).toBe(19.5);
    expect(player.__state).toBe(2);
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(37);
  });

  it('warms a resident occurrence at its exact release target, not its old position', async () => {
    const { controller, player } = makeHarness();
    player.__currentTime = 140;

    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 42 });
    await vi.advanceTimersByTimeAsync(0);

    // A paused iframe can report a settled target before that region is
    // buffered. The muted warm-up therefore plays from the target itself, so
    // PLAYING proves the release region is loaded before READY.
    const order = ops(player);
    const warmSeek = order.indexOf('seekTo');
    const warmPlay = order.indexOf('playVideo');
    expect(warmSeek).toBeGreaterThan(order.indexOf('mute'));
    expect(warmSeek).toBeLessThan(warmPlay);
    expect(player.__log.find((call) => call.op === 'seekTo')?.args).toEqual([42, true]);

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    expect(player.__currentTime).toBe(42);
  });

  it('loads a non-resident target exactly once before marking it ready', async () => {
    const { controller, player } = makeHarness({ videoId: 'outgoing-video' });

    const result = await prepareReady(controller, 'load', 7);

    expect(result.status).toBe('ready');
    expect(count(player, 'loadVideoById')).toBe(1);
    expect(player.__log.find((call) => call.op === 'loadVideoById')?.args).toEqual([VIDEO_ID, 7]);
    expect(player.__videoId).toBe(VIDEO_ID);
    expect(player.__currentTime).toBe(7);
  });

  it('reports READY only after hard mute, real warm PLAYING, settle, and audio restore', async () => {
    const { controller, player, phases } = makeHarness({ videoId: 'outgoing-video' });
    let settled = false;
    const pending = controller
      .prepare({ ...identity, strategy: 'load', targetSeconds: 3 })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(259);
    expect(settled).toBe(false);
    expect(player.__muted).toBe(true);

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: 'ready' });

    const order = ops(player);
    const muteIndex = order.indexOf('mute');
    const loadIndex = order.indexOf('loadVideoById');
    const finalPauseIndex = order.lastIndexOf('pauseVideo');
    const seekIndex = order.lastIndexOf('seekTo');
    const unmuteIndex = order.lastIndexOf('unMute');
    expect(muteIndex).toBeLessThan(loadIndex);
    expect(loadIndex).toBeLessThan(finalPauseIndex);
    expect(finalPauseIndex).toBeLessThan(seekIndex);
    expect(seekIndex).toBeLessThan(unmuteIndex);
    expect(phases).toEqual(
      expect.arrayContaining(['muting', 'warming', 'settling', 'restoring-audio', 'prepared']),
    );
  });

  it('restores app-level audio intent instead of preserving a transient iframe hard mute', async () => {
    const { controller, player } = makeHarness({ muted: true, volume: 0 });

    const pending = controller.prepare({
      ...identity,
      strategy: 'resident',
      targetSeconds: 3,
      desiredMuted: false,
      desiredVolume: 64,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(64);
  });

  it('keeps hard mute owned while warming and restores the latest in-flight volume intent', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 31 });
    const pending = controller.prepare({
      ...identity,
      strategy: 'resident',
      targetSeconds: 3,
      desiredMuted: false,
      desiredVolume: 31,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.phase).toBe('warming');
    expect(controller.ownsHardMute()).toBe(true);
    expect(player.__muted).toBe(true);

    controller.updateDesiredAudioState({ muted: false, volume: 73 });
    player.setVolume(73);
    if (!controller.ownsHardMute()) player.unMute();

    expect(player.__muted).toBe(true);
    expect(player.__volume).toBe(73);

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    expect(controller.ownsHardMute()).toBe(false);
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(73);
  });

  it('commits an on-time prepared occurrence without a second seek', async () => {
    const { controller, player } = makeHarness();
    await prepareReady(controller, 'resident', 22);
    const seeksBeforeCommit = count(player, 'seekTo');
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 700,
      timingMode: 'scheduled-control',
    });

    await vi.advanceTimersByTimeAsync(699);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 0,
      catchUpSeconds: 0,
    });
    expect(count(player, 'seekTo')).toBe(seeksBeforeCommit);
    expect(count(player, 'loadVideoById')).toBe(0);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
  });

  it('supersedes a prepared occurrence when the iframe instance is replaced', async () => {
    const { controller, player, setPlayer } = makeHarness();
    await prepareReady(controller, 'resident', 22);
    const oldPlayerPlays = count(player, 'playVideo');
    const replacement = makeFakeYtPlayer({
      __videoId: VIDEO_ID,
      __state: 2,
      __muted: false,
      __volume: 37,
    });
    setPlayer(replacement as YouTubeAuthorityArmPlayer);

    await expect(
      controller.commit({
        ...identity,
        executeDelayMs: 700,
        timingMode: 'scheduled-control',
      }),
    ).resolves.toEqual({ status: 'superseded', reason: 'identity-mismatch' });
    await vi.runAllTimersAsync();

    expect(count(player, 'playVideo')).toBe(oldPlayerPlays);
    expect(count(replacement, 'playVideo')).toBe(0);
    expect(controller.phase).toBe('idle');
  });

  it('cancels a warm generation, pauses it, and restores its captured audio state', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 29 });
    let unmuteAttempts = 0;
    player.unMute = () => {
      player.__log.push({ op: 'unMute', at: Date.now() });
      unmuteAttempts += 1;
      if (unmuteAttempts >= 3) player.__muted = false;
    };
    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.phase).toBe('warming');
    expect(player.__muted).toBe(true);

    expect(controller.cancel(identity.authorityKey)).toBe(true);

    await expect(pending).resolves.toEqual({ status: 'superseded', reason: 'superseded' });
    expect(controller.phase).toBe('idle');
    expect(player.__state).toBe(2);
    expect(player.__volume).toBe(29);
    await vi.runAllTimersAsync();
    expect(unmuteAttempts).toBe(3);
    expect(player.__muted).toBe(false);
    expect(count(player, 'loadVideoById')).toBe(0);
  });

  it('transfers hard-mute ownership on cancelAll without any detached unmute attempt', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 43 });
    let unmuteAttempts = 0;
    player.unMute = () => {
      player.__log.push({ op: 'unMute', at: Date.now() });
      unmuteAttempts += 1;
      player.__muted = false;
    };

    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.phase).toBe('warming');
    expect(player.__muted).toBe(true);

    expect(controller.cancelAll(true)).toBe(true);

    await expect(pending).resolves.toEqual({ status: 'superseded', reason: 'superseded' });
    expect(controller.phase).toBe('idle');
    expect(player.__state).toBe(2);
    expect(player.__muted).toBe(true);
    expect(unmuteAttempts).toBe(0);

    await vi.runAllTimersAsync();
    expect(unmuteAttempts).toBe(0);
    expect(player.__muted).toBe(true);
  });

  it('retries captured audio restoration after a warm preparation timeout', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 41 });
    let unmuteAttempts = 0;
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
      // The iframe accepts the command but never exposes PLAYING.
    };
    player.unMute = () => {
      player.__log.push({ op: 'unMute', at: Date.now() });
      unmuteAttempts += 1;
      if (unmuteAttempts >= 3) player.__muted = false;
    };

    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
    await vi.advanceTimersByTimeAsync(2_300);

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'warm-timeout' });
    expect(controller.phase).toBe('idle');
    await vi.runAllTimersAsync();
    expect(unmuteAttempts).toBe(3);
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(41);
  });

  it('revokes detached audio retries on an external teardown', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 47 });
    let unmuteAttempts = 0;
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
    };
    player.unMute = () => {
      player.__log.push({ op: 'unMute', at: Date.now() });
      unmuteAttempts += 1;
      // Simulate WebKit ignoring every restore while this media is torn down.
    };

    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
    await vi.advanceTimersByTimeAsync(2_300);
    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'warm-timeout' });
    expect(unmuteAttempts).toBe(1);

    expect(controller.cancelAll()).toBe(true);
    await vi.runAllTimersAsync();
    expect(unmuteAttempts).toBe(1);
  });

  it('retries captured audio restoration after a release acknowledgement timeout', async () => {
    const { controller, player } = makeHarness({ muted: false, volume: 53 });
    await prepareReady(controller, 'resident', 8);
    let unmuteAttempts = 0;
    player.__muted = true;
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
      // The iframe never transitions from PAUSED to PLAYING.
    };
    player.unMute = () => {
      player.__log.push({ op: 'unMute', at: Date.now() });
      unmuteAttempts += 1;
      if (unmuteAttempts >= 3) player.__muted = false;
    };

    const committed = controller.commit({
      ...identity,
      executeDelayMs: 0,
      timingMode: 'scheduled-control',
    });
    await vi.advanceTimersByTimeAsync(1_800);

    await expect(committed).resolves.toEqual({ status: 'failed', reason: 'release-timeout' });
    expect(controller.phase).toBe('idle');
    await vi.runAllTimersAsync();
    expect(unmuteAttempts).toBe(3);
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(53);
  });

  it('keeps iOS on the canonical server release for a true zero-start', async () => {
    expect(getYouTubeAuthorityPlatformLeadMsForTests('ios')).toBe(0);
    expect(getYouTubeAuthorityPlatformLeadMsForTests('android')).toBe(250);
    expect(getYouTubeAuthorityPlatformLeadMsForTests('other')).toBe(0);

    const { controller, player } = makeHarness({ platform: 'ios' });
    await prepareReady(controller, 'resident', 10);
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 700,
      timingMode: 'zero-start',
    });

    await vi.advanceTimersByTimeAsync(699);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 0,
      catchUpSeconds: 0,
    });
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
  });

  it('preserves Android audible-output lead for a true zero-start', async () => {
    const { controller, player } = makeHarness({ platform: 'android' });
    await prepareReady(controller, 'resident', 10);
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 700,
      timingMode: 'zero-start',
    });

    await vi.advanceTimersByTimeAsync(449);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 250,
      catchUpSeconds: 0,
    });
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
  });

  it('adds a bounded learned timeline lead only to a later true zero-start', async () => {
    const { controller, player } = makeHarness({ platform: 'android' });
    await prepareReady(controller, 'resident', 10);
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 700,
      timingMode: 'zero-start',
      timelineLeadMs: 40,
    });

    await vi.advanceTimersByTimeAsync(409);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 250,
      timelineLeadMs: 40,
      releaseLeadMs: 290,
    });
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
  });

  it.each(['ios', 'android'] as const)(
    'applies only fixed output lead to a $platform scheduled control and catches up a late target',
    async (platform) => {
      const { controller, player } = makeHarness({ platform });
      await prepareReady(controller, 'resident', 10);
      const seekCount = count(player, 'seekTo');
      const playsBeforeCommit = count(player, 'playVideo');
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 700,
        targetSeconds: 10.25,
        timingMode: 'scheduled-control',
        timelineLeadMs: 300,
      });

      const platformLeadMs = platform === 'android' ? 250 : 0;
      await vi.advanceTimersByTimeAsync(699 - platformLeadMs);
      expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
      await vi.advanceTimersByTimeAsync(1);

      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        platformLeadMs,
        timelineLeadMs: 0,
        catchUpSeconds: 0.25,
      });
      expect(count(player, 'seekTo')).toBe(seekCount + 1);
      expect(player.__log.filter((call) => call.op === 'seekTo').at(-1)?.args).toEqual([
        10.25,
        true,
      ]);
    },
  );

  it.each([
    { timingMode: 'scheduled-control', delay: 0, hold: 0, learned: 300, advance: 250, wait: 0 },
    { timingMode: 'scheduled-control', delay: 100, hold: 0, learned: 0, advance: 150, wait: 0 },
    { timingMode: 'scheduled-control', delay: 0, hold: 100, learned: 0, advance: 150, wait: 0 },
    { timingMode: 'scheduled-control', delay: 0, hold: 500, learned: 0, advance: 0, wait: 250 },
    { timingMode: 'zero-start', delay: 200, hold: 0, learned: 100, advance: 50, wait: 0 },
    { timingMode: 'zero-start', delay: 100, hold: 0, learned: -100, advance: 50, wait: 0 },
  ] as const)(
    'supplies only unscheduled fixed output by position ($timingMode/$delay/$hold/$learned)',
    async ({ timingMode, delay, hold, learned, advance, wait }) => {
      const { controller, player } = makeHarness({ platform: 'android' });
      await prepareReady(controller, 'resident', 10);
      const seeks = count(player, 'seekTo');
      const plays = count(player, 'playVideo');
      const startedAt = Date.now();
      const committed = controller.commit({
        ...identity,
        executeDelayMs: delay,
        localStartDelayMs: hold,
        timingMode,
        timelineLeadMs: learned,
      });
      await vi.advanceTimersByTimeAsync(wait);
      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        playCallAtMs: startedAt + wait,
        scheduledLeadMs: delay + hold - wait,
        outputPositionAdvanceMs: expect.closeTo(advance, 6),
        targetSeconds: 10 + advance / 1000,
      });
      expect(count(player, 'playVideo')).toBe(plays + 1);
      expect(count(player, 'seekTo')).toBe(seeks + (advance > 0 ? 1 : 0));
    },
  );

  describe.each(['zero-start', 'scheduled-control'] as const)(
    '%s output seek tolerance',
    (timingMode) => {
      it.each([1, 20, 40, 41, 50, 150, 250])(
        'seeks only when the missing fixed output advance of %ims exceeds 40ms',
        async (missingMs) => {
          const { controller, player } = makeHarness({ platform: 'android' });
          await prepareReady(controller, 'resident', 10);
          const seeks = count(player, 'seekTo');
          const plays = count(player, 'playVideo');
          const committed = controller.commit({
            ...identity,
            executeDelayMs: 250 - missingMs,
            timingMode,
          });
          await vi.advanceTimersByTimeAsync(0);

          const appliedMs = missingMs > 40 ? missingMs : 0;
          const ignoredMs = missingMs > 40 ? 0 : missingMs;
          await expect(committed).resolves.toMatchObject({
            status: 'applied',
            platformLeadMs: 250,
            scheduledLeadMs: 250 - missingMs,
            outputPositionAdvanceMs: expect.closeTo(appliedMs, 6),
            ignoredOutputPositionAdvanceMs: expect.closeTo(ignoredMs, 6),
            targetSeconds: expect.closeTo(10 + appliedMs / 1000, 6),
            catchUpSeconds: expect.closeTo(appliedMs / 1000, 6),
          });
          expect(count(player, 'seekTo')).toBe(seeks + (appliedMs > 0 ? 1 : 0));
          expect(count(player, 'playVideo')).toBe(plays + 1);
          expect(player.__currentTime).toBeCloseTo(10 + appliedMs / 1000, 6);
        },
      );
    },
  );

  it.each([
    { missingMs: 20, targetAdvanceMs: 250, callbackMs: 0, expectedMs: 250 },
    { missingMs: 40, targetAdvanceMs: 250, callbackMs: 150, expectedMs: 400 },
    { missingMs: 20, targetAdvanceMs: 0, callbackMs: 150, expectedMs: 150 },
    { missingMs: 20, targetAdvanceMs: 20, callbackMs: 20, expectedMs: 0 },
    { missingMs: 41, targetAdvanceMs: 250, callbackMs: 150, expectedMs: 441 },
    { missingMs: 50, targetAdvanceMs: 250, callbackMs: 150, expectedMs: 450 },
    { missingMs: 150, targetAdvanceMs: 250, callbackMs: 150, expectedMs: 550 },
    { missingMs: 250, targetAdvanceMs: 250, callbackMs: 150, expectedMs: 650 },
  ])(
    'combines actual corrections into at most one seek without readding ignored fixed lead ($missingMs/$targetAdvanceMs/$callbackMs)',
    async ({ missingMs, targetAdvanceMs, callbackMs, expectedMs }) => {
      const { controller, player } = makeHarness({ platform: 'android' });
      await prepareReady(controller, 'resident', 10);
      const seeks = count(player, 'seekTo');
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 250 - missingMs,
        targetSeconds: 10 + targetAdvanceMs / 1000,
        timingMode: 'scheduled-control',
      });
      vi.setSystemTime(Date.now() + callbackMs);
      await vi.advanceTimersByTimeAsync(0);

      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        outputPositionAdvanceMs: expect.closeTo(missingMs > 40 ? missingMs : 0, 6),
        ignoredOutputPositionAdvanceMs: expect.closeTo(missingMs > 40 ? 0 : missingMs, 6),
        releaseLatenessMs: callbackMs > 40 ? callbackMs : 0,
        rawReleaseLatenessMs: callbackMs,
        targetSeconds: expect.closeTo(10 + expectedMs / 1000, 6),
        catchUpSeconds: expect.closeTo(expectedMs / 1000, 6),
      });
      expect(count(player, 'seekTo')).toBe(seeks + (expectedMs > 0 ? 1 : 0));
      expect(player.__currentTime).toBeCloseTo(10 + expectedMs / 1000, 6);
    },
  );

  it.each([1, 20, 40, 41, 50])(
    'uses the end-bounded fixed advance of %ims for the no-seek decision',
    async (remainingMs) => {
      const { controller, player } = makeHarness({ platform: 'android' });
      player.getDuration = () => 10;
      const target = 9.95 - remainingMs / 1000;
      await prepareReady(controller, 'resident', target);
      const seeks = count(player, 'seekTo');
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 0,
        timingMode: 'scheduled-control',
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        platformLeadMs: 250,
        scheduledLeadMs: 0,
        outputPositionAdvanceMs: expect.closeTo(remainingMs > 40 ? remainingMs : 0, 6),
        ignoredOutputPositionAdvanceMs: expect.closeTo(remainingMs > 40 ? 0 : remainingMs, 6),
        targetSeconds: expect.closeTo(remainingMs > 40 ? 9.95 : target, 6),
      });
      expect(count(player, 'seekTo')).toBe(seeks + (remainingMs > 40 ? 1 : 0));
      expect(player.__currentTime).toBeLessThan(10);
    },
  );

  it('does not let fixed output compensation seek across the media end', async () => {
    const { controller, player } = makeHarness({ platform: 'android' });
    player.getDuration = () => 10;
    await prepareReady(controller, 'resident', 9.9);
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 0,
      timingMode: 'scheduled-control',
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      targetSeconds: 9.95,
      outputPositionAdvanceMs: expect.closeTo(50, 6),
    });
    expect(player.__currentTime).toBeLessThan(10);
  });

  it('runs a late iOS zero-start immediately without inventing platform lead', async () => {
    const { controller, player } = makeHarness({ platform: 'ios' });
    await prepareReady(controller, 'resident', 10);
    const seekCount = count(player, 'seekTo');

    const committed = controller.commit({
      ...identity,
      executeDelayMs: 0,
      targetSeconds: 10.25,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 0,
      catchUpSeconds: 0.25,
    });
    expect(count(player, 'seekTo')).toBe(seekCount + 1);
  });

  it('runs an already-late scheduled control immediately without platform lead', async () => {
    const { controller, player } = makeHarness({ platform: 'ios' });
    await prepareReady(controller, 'resident', 10);
    const playsBeforeCommit = count(player, 'playVideo');

    const committed = controller.commit({
      ...identity,
      executeDelayMs: 0,
      targetSeconds: 10.25,
      timingMode: 'scheduled-control',
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 0,
      catchUpSeconds: 0.25,
    });
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
  });

  it.each([
    { platform: 'other', timingMode: 'zero-start', localStartDelayMs: 250, lead: 0 },
    { platform: 'ios', timingMode: 'zero-start', localStartDelayMs: 250, lead: 0 },
    { platform: 'android', timingMode: 'zero-start', localStartDelayMs: 250, lead: 250 },
    { platform: 'android', timingMode: 'scheduled-control', localStartDelayMs: 250, lead: 250 },
    { platform: 'other', timingMode: 'zero-start', localStartDelayMs: 9_999, lead: 0 },
  ] as const)(
    'preserves a negative manual offset using a local wait ($platform/$timingMode/$localStartDelayMs)',
    async ({ platform, timingMode, localStartDelayMs, lead }) => {
      const { controller, player } = makeHarness({ platform });
      await prepareReady(controller, 'resident', 0);
      const playsBefore = count(player, 'playVideo');
      const seeksBefore = count(player, 'seekTo');
      const startedAt = Date.now();
      const committed = controller.commit({
        ...identity,
        targetSeconds: 0,
        executeDelayMs: 699,
        localStartDelayMs,
        timingMode,
      });
      const callDelayMs = 699 + localStartDelayMs - lead;
      await vi.advanceTimersByTimeAsync(callDelayMs - 1);
      expect(controller.phase).toBe('scheduled');
      expect(count(player, 'playVideo')).toBe(playsBefore);
      expect(player.__currentTime).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        playCallAtMs: startedAt + callDelayMs,
        localStartDelayMs,
        releaseLeadMs: lead,
        catchUpSeconds: 0,
      });
      expect(count(player, 'seekTo')).toBe(seeksBefore);
      expect(count(player, 'playVideo')).toBe(playsBefore + 1);
    },
  );

  it.each([
    { targetSeconds: 0, localStartDelayMs: 150, expectedDelayMs: 150 },
    { targetSeconds: 0.25, localStartDelayMs: 0, expectedDelayMs: 0 },
  ])(
    'uses only the remaining negative-offset wait after a late COMMIT ($localStartDelayMs ms)',
    async ({ targetSeconds, localStartDelayMs, expectedDelayMs }) => {
      const { controller, player } = makeHarness();
      await prepareReady(controller, 'resident', 0);
      const playsBefore = count(player, 'playVideo');
      const committed = controller.commit({
        ...identity,
        targetSeconds,
        executeDelayMs: 0,
        localStartDelayMs,
        timingMode: 'zero-start',
      });
      if (expectedDelayMs > 0) {
        await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
        expect(count(player, 'playVideo')).toBe(playsBefore);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        await vi.advanceTimersByTimeAsync(0);
      }
      await expect(committed).resolves.toMatchObject({ status: 'applied', localStartDelayMs });
      expect(player.__currentTime).toBe(targetSeconds);
    },
  );

  it.each([
    { supplied: -250, normalized: 0 },
    { supplied: Number.NaN, normalized: 0 },
    { supplied: Number.POSITIVE_INFINITY, normalized: 0 },
    { supplied: 50_000, normalized: 9_999 },
  ])('bounds participant-only wait $supplied to $normalized', async ({ supplied, normalized }) => {
    const { controller } = makeHarness();
    await prepareReady(controller, 'resident', 0);
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 0,
      localStartDelayMs: supplied,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(normalized);
    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      localStartDelayMs: normalized,
    });
  });

  it('cancels a long negative-offset wait before a pause or room teardown can be undone', async () => {
    const { controller, player } = makeHarness();
    await prepareReady(controller, 'resident', 0);
    const playsBefore = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 699,
      localStartDelayMs: 9_999,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.cancelAll();
    await expect(committed).resolves.toMatchObject({ status: 'superseded' });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(count(player, 'playVideo')).toBe(playsBefore);
    expect(player.__state).toBe(2);
  });

  it('replaces a long negative-offset wait with the next exact occurrence', async () => {
    const { controller, player } = makeHarness();
    await prepareReady(controller, 'resident', 0);
    const first = controller.commit({
      ...identity,
      executeDelayMs: 699,
      localStartDelayMs: 9_999,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const nextIdentity = { ...identity, authorityKey: 'transition-2', videoId: 'next-video' };
    const preparing = controller.prepare({ ...nextIdentity, strategy: 'load', targetSeconds: 3 });
    await vi.runAllTimersAsync();
    await expect(first).resolves.toMatchObject({ status: 'superseded' });
    await expect(preparing).resolves.toMatchObject({ status: 'ready' });
    const next = controller.commit({
      ...nextIdentity,
      executeDelayMs: 699,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(699);
    await expect(next).resolves.toMatchObject({ status: 'applied', localStartDelayMs: 0 });
    const playsAfterNext = count(player, 'playVideo');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(count(player, 'playVideo')).toBe(playsAfterNext);
    expect(player.__videoId).toBe('next-video');
    expect(player.__currentTime).toBe(3);
  });

  it.each([
    { platform: 'other', target: 0, hold: 9_999, learned: 0 },
    { platform: 'other', target: 9.999, hold: 0, learned: 0 },
    { platform: 'android', target: 0, hold: 9_999, learned: 40 },
    { platform: 'android', target: 9.999, hold: 0, learned: -40 },
  ] as const)(
    'catches up only callback lateness while retaining $platform hold=$hold and learned=$learned',
    async ({ platform, target, hold, learned }) => {
      const { controller, player } = makeHarness({ platform });
      await prepareReady(controller, 'resident', target);
      const baseLead = getYouTubeAuthorityPlatformLeadMsForTests(platform);
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 699,
        localStartDelayMs: hold,
        timelineLeadMs: learned,
        timingMode: 'zero-start',
      });
      // Model a blocked event loop: the clock moves, but no timer can run.
      vi.setSystemTime(Date.now() + 1_500);
      await vi.advanceTimersByTimeAsync(699 + hold - baseLead - learned);
      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        platformLeadMs: baseLead,
        timelineLeadMs: learned,
        localStartDelayMs: hold,
        releaseLatenessMs: 1_500,
        rawReleaseLatenessMs: 1_500,
        targetSeconds: target + 1.5,
        catchUpSeconds: 1.5,
        callToPlayingMs: 0,
      });
      expect(player.__currentTime).toBeCloseTo(target + 1.5, 3);
    },
  );

  it('bounds delayed catch-up at the media end without changing the canonical wait', async () => {
    const { controller, player } = makeHarness();
    player.__duration = 3;
    await prepareReady(controller, 'resident', 2.5);
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 699,
      timingMode: 'zero-start',
    });
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(699);
    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      targetSeconds: 3,
      catchUpSeconds: 0.5,
      releaseLatenessMs: 1_500,
      rawReleaseLatenessMs: 1_500,
    });
    expect(player.__currentTime).toBe(3);
    expect(
      player.__log
        .filter((call) => call.op === 'seekTo')
        .every((call) => Number(call.args?.[0]) <= 3),
    ).toBe(true);
  });

  it('keeps ordinary callback jitter within the existing no-seek tolerance', async () => {
    const { controller, player } = makeHarness();
    await prepareReady(controller, 'resident', 0);
    const seeks = count(player, 'seekTo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 699,
      timingMode: 'zero-start',
    });
    vi.setSystemTime(Date.now() + 25);
    await vi.advanceTimersByTimeAsync(699);
    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      targetSeconds: 0,
      catchUpSeconds: 0,
      releaseLatenessMs: 0,
      rawReleaseLatenessMs: 25,
    });
    expect(count(player, 'seekTo')).toBe(seeks);
  });
});
