import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATE_YOUTUBE_COMMIT_LEAD_MS } from '../../pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts';
import { PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS } from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import type { QueueItemId, YouTubeZeroStartPlatform } from '../../types/index.ts';
import {
  YouTubeAuthorityArmController,
  getYouTubeAuthorityPlatformLeadMsForTests,
  type YouTubeAuthorityArmPlayer,
} from '../authority-arm.ts';
import {
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
  YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS,
} from '../constants.ts';
import { makeFakeYtPlayer, ops, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

// The arm's release timing, read from its home.
const LATE_YOUTUBE_RELEASE_TOLERANCE_MS = YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS;
const RELEASE_ACK_TIMEOUT_MS = YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS;

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111' as QueueItemId;
const VIDEO_ID = 'M7lc1UVf-VE';

const identity = {
  authorityKey: 'transition-1',
  queueItemId: QUEUE_ITEM_ID,
  videoId: VIDEO_ID,
  subIndex: 0,
};

/**
 * The zero-start COMMIT lead of PRO Workers before PRO snapshot schemaVersion
 * 2, one below the Worker's COMMIT lead (PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS, from
 * the copy pro-room-playback-timing.test.ts pins). Several rows release at it;
 * the arm takes any delay as given.
 */
const PRE_V2_ZERO_START_LEAD_MS = PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 1;

function makeHarness(options?: {
  platform?: YouTubeZeroStartPlatform;
  videoId?: string;
  autoPlayOnLoad?: boolean;
  muted?: boolean;
  volume?: number;
  onPhaseChange?: (phase: string) => void;
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
    onPhaseChange: (phase) => {
      phases.push(phase);
      options?.onPhaseChange?.(phase);
    },
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

  // The active restore reads the desired audio as each attempt runs, so a
  // volume change between two attempts is what the next attempt writes and
  // checks. WebKit ignores the first unMute here, so a second attempt runs.
  it('writes a volume changed during the active audio restore on its next attempt', async () => {
    let restoreAt: number | null = null;
    const timeline: string[] = [];
    const harness = makeHarness({
      onPhaseChange: (phase) => {
        if (phase === 'restoring-audio' && restoreAt === null) {
          restoreAt = Date.now();
          harness.player.__unMuteIgnoreCount = 1;
          harness.player.__log.length = 0;
          setTimeout(() => harness.controller.updateDesiredAudioState({ volume: 55 }), 60);
        }
        if (restoreAt !== null) timeline.push(`+${Date.now() - restoreAt} ${phase}`);
      },
    });
    const { controller, player } = harness;
    const pending = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    const origin = restoreAt ?? Number.NaN;
    expect(
      player.__log.map(({ op, args, at }) => `+${at - origin} ${op}(${(args ?? []).join(',')})`),
    ).toEqual(['+0 setVolume(37)', '+0 unMute()', '+120 setVolume(55)', '+120 unMute()']);
    expect(timeline).toEqual(['+0 restoring-audio', '+240 prepared']);
    expect(player.__muted).toBe(false);
    expect(player.__volume).toBe(55);
  });

  // The check after the last attempt's wait reads this run's own player and
  // fences only on the run, not on the iframe (the next write would cancel
  // the run for a new iframe; after the last attempt there is none). An
  // iframe change inside that wait therefore ends the prepare as a failed
  // restore, and neither iframe is written again.
  it('fails the prepare when the iframe changes during the last audio restore wait', async () => {
    let restoreAt: number | null = null;
    const replacement = makeFakeYtPlayer({
      __videoId: VIDEO_ID,
      __state: 2,
      __muted: false,
      __volume: 37,
    });
    const harness = makeHarness({
      onPhaseChange: (phase) => {
        if (phase !== 'restoring-audio' || restoreAt !== null) return;
        restoreAt = Date.now();
        // Every unMute is ignored: eight attempts, the last written at +840.
        harness.player.__unMuteIgnoreCount = 8;
        setTimeout(() => {
          // The replaced iframe's state events no longer reach the arm.
          harness.player.__onStateChange = undefined;
          harness.player.__log.length = 0;
          harness.setPlayer(replacement as YouTubeAuthorityArmPlayer);
        }, 900);
      },
    });
    const pending = harness.controller.prepare({
      ...identity,
      strategy: 'resident',
      targetSeconds: 4,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'audio-restore-timeout' });
    const origin = restoreAt ?? Number.NaN;
    expect(harness.player.__log.map(({ op, at }) => `+${at - origin} ${op}`)).toEqual([
      '+960 pauseVideo',
    ]);
    expect(replacement.__log).toEqual([]);
    expect(harness.controller.phase).toBe('idle');
  });

  // An iframe that takes every seekTo but never reaches the target: the
  // settle loop polls every 80 ms from +420, and every sixth unsettled poll
  // pauses and seeks again, until the 2.3 s prepare budget ends.
  it('pauses and seeks again on every sixth unsettled settle poll until the prepare budget', async () => {
    const { controller, player } = makeHarness();
    player.__currentTime = 140;
    player.seekTo = (seconds, allowSeekAhead) => {
      player.__log.push({ op: 'seekTo', args: [seconds, allowSeekAhead], at: Date.now() });
    };
    const startedAt = Date.now();
    let settledAt: number | null = null;
    const pending = controller
      .prepare({ ...identity, strategy: 'resident', targetSeconds: 4 })
      .then((result) => {
        settledAt = Date.now();
        return result;
      });

    await vi.advanceTimersByTimeAsync(2_500);

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'settle-timeout' });
    expect((settledAt ?? Number.NaN) - startedAt).toBe(2_300);
    const at = (op: string): number[] =>
      player.__log.filter((call) => call.op === op).map((call) => call.at - startedAt);
    // The warm-up pause and seek at +0 and the settle pause at +260 and seek
    // at +340; then the 6th, 12th, 18th and 24th polls; then the failure pause.
    expect(at('pauseVideo')).toEqual([0, 260, 820, 1300, 1780, 2260, 2300]);
    expect(at('seekTo')).toEqual([0, 340, 820, 1300, 1780, 2260]);
  });

  it('commits an on-time prepared occurrence without a second seek', async () => {
    const { controller, player } = makeHarness();
    await prepareReady(controller, 'resident', 22);
    const seeksBeforeCommit = count(player, 'seekTo');
    const playsBeforeCommit = count(player, 'playVideo');
    const committed = controller.commit({
      ...identity,
      executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
      timingMode: 'scheduled-control',
    });

    await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 1);
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
        executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
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

  // A detached restore whose iframe is no longer current ends at its next
  // attempt and keeps no target: nothing is left for cancelAll() to revoke,
  // and when the same iframe comes back, the next prepare captures that
  // iframe's own audio instead of the abandoned restore's target.
  it.each(['cancelAll', 'next prepare'] as const)(
    'drops a detached restore whose iframe changed before its retry (%s)',
    async (check) => {
      const { controller, player, setPlayer } = makeHarness({ muted: false, volume: 41 });
      player.playVideo = () => {
        player.__log.push({ op: 'playVideo', at: Date.now() });
        // The iframe accepts the command but never exposes PLAYING.
      };
      const failed = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
      await vi.advanceTimersByTimeAsync(2_295);
      // The detached restore's first unMute (+2300) is ignored, so it would retry at +2420.
      player.__unMuteIgnoreCount = 1;
      await vi.advanceTimersByTimeAsync(5);
      await expect(failed).resolves.toEqual({ status: 'failed', reason: 'warm-timeout' });
      const other = makeFakeYtPlayer({ __videoId: VIDEO_ID, __muted: false, __volume: 90 });
      setPlayer(other as YouTubeAuthorityArmPlayer);
      await vi.advanceTimersByTimeAsync(120);
      expect(other.__log).toEqual([]);

      if (check === 'cancelAll') {
        expect(controller.cancelAll()).toBe(false);
        return;
      }
      setPlayer(player as YouTubeAuthorityArmPlayer);
      player.__muted = false;
      player.__volume = 23;
      player.__log.length = 0;
      const next = controller.prepare({ ...identity, strategy: 'resident', targetSeconds: 4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(player.__log.find((call) => call.op === 'setVolume')?.args).toEqual([23]);
      await vi.advanceTimersByTimeAsync(2_300);
      await expect(next).resolves.toEqual({ status: 'failed', reason: 'warm-timeout' });
      await vi.runAllTimersAsync();
      expect(player.__muted).toBe(false);
      expect(player.__volume).toBe(23);
    },
  );

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
      executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
      timingMode: 'zero-start',
    });

    await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 1);
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
      executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
      timingMode: 'zero-start',
    });

    await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 250 - 1);
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
      executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
      timingMode: 'zero-start',
      timelineLeadMs: 40,
    });

    await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 290 - 1);
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
        executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
        targetSeconds: 10.25,
        timingMode: 'scheduled-control',
        timelineLeadMs: 300,
      });

      const platformLeadMs = platform === 'android' ? 250 : 0;
      await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS - 1 - platformLeadMs);
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
        executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
        localStartDelayMs,
        timingMode,
      });
      const callDelayMs = PRE_V2_ZERO_START_LEAD_MS + localStartDelayMs - lead;
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
      executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
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
      executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
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
      executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
      timingMode: 'zero-start',
    });
    await vi.advanceTimersByTimeAsync(PRE_V2_ZERO_START_LEAD_MS);
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
        executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
        localStartDelayMs: hold,
        timelineLeadMs: learned,
        timingMode: 'zero-start',
      });
      // Model a blocked event loop: the clock moves, but no timer can run.
      vi.setSystemTime(Date.now() + 1_500);
      await vi.advanceTimersByTimeAsync(PRE_V2_ZERO_START_LEAD_MS + hold - baseLead - learned);
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
      executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
      timingMode: 'zero-start',
    });
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(PRE_V2_ZERO_START_LEAD_MS);
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
      executeDelayMs: PRE_V2_ZERO_START_LEAD_MS,
      timingMode: 'zero-start',
    });
    vi.setSystemTime(Date.now() + 25);
    await vi.advanceTimersByTimeAsync(PRE_V2_ZERO_START_LEAD_MS);
    await expect(committed).resolves.toMatchObject({
      status: 'applied',
      targetSeconds: 0,
      catchUpSeconds: 0,
      releaseLatenessMs: 0,
      rawReleaseLatenessMs: 25,
    });
    expect(count(player, 'seekTo')).toBe(seeks);
  });

  describe('PRO late cohort join (pinned 2026-10-30)', () => {
    // The COMMIT lead is the Worker's (the copy pro-room-playback-timing.test.ts
    // pins); the App's late-join lead comes from
    // pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts and the
    // arm's release timing from its home, src/youtube/constants.ts.
    //
    // These rows run the arm on 'other' (the harness default), where the fixed
    // output lead is 0. The device-level Android rows are in
    // pro-manual-zero-start.test.ts and pro-late-prepare-reload.test.ts.

    // (b) Scenario: at the release the iframe buffers, and its PLAYING report
    // is still in flight 1.8 s later although media started after 1 s. The
    // arm pauses and fails the commit at exactly 1.8 s but never re-mutes, so
    // whatever the iframe played inside that window was audible. This is the
    // row that pins the arm's release acknowledgement through the real arm.
    it('(b) pauses an unacknowledged release after exactly 1.8 s without re-muting it', async () => {
      const { controller, player } = makeHarness();
      await prepareReady(controller, 'resident', 0);
      player.playVideo = () => {
        player.__log.push({ op: 'playVideo', at: Date.now() });
        player.__setState(3);
      };
      const committed = controller.commit({
        ...identity,
        executeDelayMs: PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS,
        timingMode: 'zero-start',
      });
      await vi.advanceTimersByTimeAsync(PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS);
      const releasedAt = Date.now();
      expect(player.__log.at(-1)).toEqual({ op: 'playVideo', at: releasedAt });
      expect(player.__muted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      player.__setState(1, false);
      await vi.advanceTimersByTimeAsync(RELEASE_ACK_TIMEOUT_MS - 1_000 - 1);
      expect(controller.phase).toBe('starting');
      expect(player.__state).toBe(1);
      expect(player.__muted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(committed).resolves.toEqual({ status: 'failed', reason: 'release-timeout' });
      expect(player.__log.filter((call) => call.op === 'pauseVideo').at(-1)?.at).toBe(
        releasedAt + RELEASE_ACK_TIMEOUT_MS,
      );
      expect(player.__state).toBe(2);
      expect(player.__muted).toBe(false);
      expect(player.__log.filter((call) => call.op === 'mute' && call.at > releasedAt)).toEqual([]);
      expect(controller.phase).toBe('idle');
      // The PLAYING report that finally arrives is no longer the arm's.
      expect(controller.handlePlayerStateChange(1)).toBe(false);
    });

    // (d) Scenario: a device ready up to 40 ms after executeAt commits the
    // room position then (here 0.040 s) to a release prepared at 0:00. The
    // arm ignores a target change of 40 ms or less and plays from 0:00 at
    // once, that many ms behind the room. The 41 ms row pins only the arm's
    // side of that edge: a commit 41 ms past its target would seek first, but
    // the controller never sends one, because a device ready 41 ms after
    // executeAt re-arms instead (playback-late-cohort-join.test.ts '(d)
    // re-arms a device ready 41 ms after executeAt for a mid-track join 3 s
    // later' pins that 3.041 s join).
    it.each([
      { lateMs: LATE_YOUTUBE_RELEASE_TOLERANCE_MS, seeks: 0, startsAt: 0 },
      {
        lateMs: LATE_YOUTUBE_RELEASE_TOLERANCE_MS + 1,
        seeks: 1,
        startsAt: (LATE_YOUTUBE_RELEASE_TOLERANCE_MS + 1) / 1_000,
      },
    ])(
      '(d) releases a commit $lateMs ms past its prepared 0:00 target with $seeks seek',
      async ({ lateMs, seeks, startsAt }) => {
        const { controller, player } = makeHarness();
        await prepareReady(controller, 'resident', 0);
        const seeksBefore = count(player, 'seekTo');
        const committed = controller.commit({
          ...identity,
          executeDelayMs: 0,
          targetSeconds: lateMs / 1_000,
          timingMode: 'zero-start',
        });
        await vi.advanceTimersByTimeAsync(0);
        await expect(committed).resolves.toMatchObject({
          status: 'applied',
          targetSeconds: startsAt,
          catchUpSeconds: startsAt,
        });
        expect(count(player, 'seekTo')).toBe(seeksBefore + seeks);
        expect(player.__currentTime).toBe(startsAt);
      },
    );

    // (c) Scenario: a late join whose re-arm ended inside the last 400 ms of
    // its plan commits the room position then (2.0 s) to a release settled at
    // its planned 2.3 s (src/pro-room/__tests__/playback-late-cohort-join.test.ts).
    // Looks like a defect: the arm never seeks backward, so the device plays
    // from 2.3 s at once, 0.3 s ahead of the room.
    it('(c) releases a commit target behind its prepared target from the prepared target', async () => {
      // The controller row's values: settled at the late join's planned
      // position (2.3 s), committed at the room position 300 ms before it.
      const settledSeconds =
        (LATE_YOUTUBE_COMMIT_LEAD_MS - PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS) / 1_000;
      const roomSeconds =
        (LATE_YOUTUBE_COMMIT_LEAD_MS - 300 - PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS) / 1_000;
      const { controller, player } = makeHarness();
      await prepareReady(controller, 'resident', settledSeconds);
      const seeksBefore = count(player, 'seekTo');
      const committed = controller.commit({
        ...identity,
        executeDelayMs: 0,
        targetSeconds: roomSeconds,
        timingMode: 'scheduled-control',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(committed).resolves.toMatchObject({
        status: 'applied',
        targetSeconds: settledSeconds,
        catchUpSeconds: 0,
      });
      expect(count(player, 'seekTo')).toBe(seeksBefore);
      expect(player.__currentTime).toBe(settledSeconds);
    });
  });
});
