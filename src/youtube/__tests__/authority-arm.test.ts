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

  it.each([
    { platform: 'ios' as const, leadMs: 270 },
    { platform: 'android' as const, leadMs: 250 },
  ])(
    'applies the $platform platform lead to a true zero-start release',
    async ({ platform, leadMs }) => {
      expect(getYouTubeAuthorityPlatformLeadMsForTests('ios')).toBe(270);
      expect(getYouTubeAuthorityPlatformLeadMsForTests('android')).toBe(250);
      expect(getYouTubeAuthorityPlatformLeadMsForTests('other')).toBe(0);

      const { controller, player } = makeHarness({ platform });
      await prepareReady(controller, 'resident', 10);
      const playsBeforeCommit = count(player, 'playVideo');
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 700,
        timingMode: 'zero-start',
      });

      await vi.advanceTimersByTimeAsync(700 - leadMs - 1);
      expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
      await vi.advanceTimersByTimeAsync(1);

      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        platformLeadMs: leadMs,
        catchUpSeconds: 0,
      });
      expect(count(player, 'playVideo')).toBe(playsBeforeCommit + 1);
    },
  );

  it('does not apply platform lead to a scheduled control and still catches up a late target', async () => {
    const { controller, player } = makeHarness({ platform: 'ios' });
    await prepareReady(controller, 'resident', 10);
    const seekCount = count(player, 'seekTo');
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: 700,
      targetSeconds: 10.25,
      timingMode: 'scheduled-control',
    });

    await vi.advanceTimersByTimeAsync(699);
    expect(count(player, 'playVideo')).toBe(playsBeforeCommit);
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      platformLeadMs: 0,
      catchUpSeconds: 0.25,
    });
    expect(count(player, 'seekTo')).toBe(seekCount + 1);
    expect(player.__log.filter((call) => call.op === 'seekTo').at(-1)?.args).toEqual([10.25, true]);
  });

  it('keeps platform lead on a late true zero-start while rebasing its target', async () => {
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
      platformLeadMs: 270,
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
});
