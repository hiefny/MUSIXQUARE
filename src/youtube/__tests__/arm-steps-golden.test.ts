/**
 * Arm steps golden (pinned 2026-11-02).
 *
 * Two machines arm the YouTube iframe before a start: the Standard zero-start
 * run (zero-start.ts; here a guest's local prepare) and the coordinator-free
 * PRO arm (authority-arm.ts). Both hard-mute the iframe, poll until it
 * reports the mute, warm it under that mute until it reports PLAYING, settle
 * it paused at the target and restore the audio. Each script below sets the
 * same knobs on one fake iframe for both machines, and each row records on
 * one timeline from the PREPARE: every command the machine sends the iframe
 * (`throws` when the iframe throws it), each state the iframe reports and
 * whether the machine consumed it, the machine's phases, its debug lines and
 * errors, and its outcome (the guest's ARMED or the arm's prepare result).
 * Neutral changes to the steps leave every array unchanged.
 *
 * The rows also show where the two machines' own policies differ:
 * - the clock: zero-start reads Date.now(), the PRO arm performance.now();
 *   both are the fake clock here, so every instant is relative to the PREPARE;
 * - the captured volume: zero-start keeps the iframe's own volume (37 here),
 *   the PRO arm the App's desired volume (80 here, as iframe.ts passes it);
 * - the warm command: zero-start plays a resident iframe where it is (or
 *   loads the target into another one), the PRO arm pauses, seeks to its
 *   target and plays, and refuses an iframe that holds another video;
 * - the failures: zero-start's 10 s prepare watchdog and its reasons, the PRO
 *   arm's 2.3 s deadline and its reasons;
 * - a PLAYING reported before the warm command: zero-start refuses it, the
 *   PRO arm accepts any PLAYING of its video while it warms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import { YouTubeAuthorityArmController, type YouTubeAuthorityArmPlayer } from '../authority-arm.ts';
import {
  YouTubeZeroStartControllerForTests as YouTubeZeroStartController,
  type YouTubeZeroStartPlayer,
  type YouTubeZeroStartWireMessage,
} from '../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const QUEUE_ITEM_ID = '66000000-0000-4000-8000-000000000001' as QueueItemId;
/** The occurrence's video, which both machines arm. */
const TARGET = 'armGolden01';
/** Another video, held by a cold iframe. */
const OTHER = 'armGolden02';
/** The video an iframe reports after a scripted change. */
const CHANGED = 'armGolden03';

/** One fake iframe's script; every knob is off unless set. */
interface Script {
  /** The video the iframe holds at the PREPARE. */
  video: string;
  /** Its state then: 0 ENDED (at the end of the video), 1 PLAYING or 2 PAUSED (at 140 s). */
  state: 0 | 1 | 2;
  /**
   * isMuted() answers false until this long after the PREPARE, whatever the
   * iframe's mute; null: no mute() ever takes.
   */
  muteReportedAfterMs?: number | null;
  /** isMuted() throws on its first reads, this many. */
  isMutedThrows?: number;
  /** mute() throws without effect: always, or from its second call. */
  muteThrows?: 'always' | 'after-first';
  /** seekTo() throws without effect. */
  seekThrows?: boolean;
  /**
   * playVideo() and loadVideoById() reach PLAYING this long after the
   * command; null: never. Unset: at once, as the fake iframe does.
   */
  playingAfterMs?: number | null;
  /** The iframe reports each change of state one task later, as the real API does. */
  async?: boolean;
  /** When the machine enters 'warming', a PLAYING of the target arrives first. */
  stalePlayingAtWarm?: boolean;
  /** From this instant the iframe holds CHANGED. */
  videoChangesAtMs?: number;
  /** From this instant the App holds a replacement iframe ('B'). */
  replacedAtMs?: number;
  /** From this instant the App holds no iframe. */
  goneAtMs?: number;
  /** How long the row records after the PREPARE. */
  horizonMs: number;
}

const SCRIPTS = {
  residentPaused: { video: TARGET, state: 2, horizonMs: 2_000 },
  residentPlaying: { video: TARGET, state: 1, horizonMs: 2_000 },
  residentPlayingAsync: { video: TARGET, state: 1, async: true, horizonMs: 2_000 },
  residentEnded: { video: TARGET, state: 0, horizonMs: 2_000 },
  residentEndedSeekThrows: { video: TARGET, state: 0, seekThrows: true, horizonMs: 2_000 },
  cold: { video: OTHER, state: 2, horizonMs: 2_000 },
  muteReported70msLate: { video: TARGET, state: 2, muteReportedAfterMs: 70, horizonMs: 2_000 },
  muteNever: { video: TARGET, state: 2, muteReportedAfterMs: null, horizonMs: 2_000 },
  isMutedThrowsTwice: { video: TARGET, state: 2, isMutedThrows: 2, horizonMs: 2_000 },
  muteAlwaysThrows: { video: TARGET, state: 2, muteThrows: 'always', horizonMs: 2_000 },
  muteThrowsAfterFirst: {
    video: TARGET,
    state: 2,
    muteThrows: 'after-first',
    muteReportedAfterMs: 70,
    horizonMs: 2_000,
  },
  videoChangesBeforeWarm: {
    video: TARGET,
    state: 2,
    muteReportedAfterMs: 70,
    videoChangesAtMs: 40,
    horizonMs: 2_000,
  },
  warmNeverPlays: { video: TARGET, state: 2, playingAfterMs: null, horizonMs: 11_000 },
  stalePlayingBeforeWarm: {
    video: TARGET,
    state: 2,
    playingAfterMs: 100,
    stalePlayingAtWarm: true,
    horizonMs: 2_000,
  },
  replacedWhileWarming: { video: TARGET, state: 2, replacedAtMs: 100, horizonMs: 2_000 },
  goneWhileMuting: {
    video: TARGET,
    state: 2,
    muteReportedAfterMs: 70,
    goneAtMs: 40,
    horizonMs: 2_000,
  },
  replacedWhileMuting: {
    video: TARGET,
    state: 2,
    muteReportedAfterMs: 70,
    replacedAtMs: 40,
    horizonMs: 2_000,
  },
} satisfies Record<string, Script>;

const COMMANDS = [
  'playVideo',
  'pauseVideo',
  'stopVideo',
  'seekTo',
  'cueVideoById',
  'loadVideoById',
  'setVolume',
  'mute',
  'unMute',
] as const;

let t0 = 0;
let trace: string[] = [];

function at(): string {
  return `+${Date.now() - t0}`;
}

function detail(value: unknown): string {
  if (value === undefined) return '';
  const json = JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? `Error: ${item.message}` : item,
  );
  return ` ${json}`;
}

/**
 * The script's iframe. Its commands, and the states it reports with the
 * machine's answer, go to the trace; `label` marks a replacement iframe.
 */
function scriptedIframe(
  script: Script,
  label: string,
  onState: (state: number) => boolean,
): FakeYtPlayer {
  const player = makeFakeYtPlayer({
    __videoId: script.video,
    __state: script.state,
    __currentTime: script.state === 0 ? 300 : 140,
    __duration: 300,
    __muted: false,
    __volume: 37,
    __autoPlayOnLoad: true,
    __hardMuteFails: script.muteReportedAfterMs === null,
    __stateNotifyDelayMs: script.async ? 0 : null,
  });

  const readMuted = player.isMuted;
  let isMutedFaults = script.isMutedThrows ?? 0;
  player.isMuted = () => {
    if (isMutedFaults > 0) {
      isMutedFaults -= 1;
      throw new Error('scripted isMuted fault');
    }
    const lateMs = script.muteReportedAfterMs;
    if (typeof lateMs === 'number' && Date.now() - t0 < lateMs) return false;
    return readMuted();
  };

  if (script.muteThrows) {
    const mute = player.mute;
    let calls = 0;
    player.mute = () => {
      calls += 1;
      if (script.muteThrows === 'after-first' && calls === 1) {
        mute();
        return;
      }
      player.__log.push({ op: 'mute', at: Date.now() });
      throw new Error('scripted mute fault');
    };
  }

  if (script.seekThrows) {
    player.seekTo = (seconds, allowSeekAhead) => {
      player.__log.push({ op: 'seekTo', args: [seconds, allowSeekAhead], at: Date.now() });
      throw new Error('scripted seekTo fault');
    };
  }

  const playingAfterMs = script.playingAfterMs;
  if (playingAfterMs !== undefined) {
    const reachPlaying = (): void => {
      if (playingAfterMs !== null) setTimeout(() => player.__setState(1), playingAfterMs);
    };
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
      reachPlaying();
    };
    player.loadVideoById = (id, startSeconds) => {
      player.__log.push({ op: 'loadVideoById', args: [id, startSeconds], at: Date.now() });
      player.__videoId = id;
      player.__currentTime = startSeconds ?? 0;
      reachPlaying();
    };
  }

  for (const name of COMMANDS) {
    const command = player[name] as (...args: unknown[]) => void;
    Object.assign(player, {
      [name]: (...args: unknown[]) => {
        const line = trace.push(`${at()} ${label}${name}(${args.join(',')})`) - 1;
        try {
          command(...args);
        } catch (error) {
          trace[line] += ' throws';
          throw error;
        }
      },
    });
  }

  player.__onStateChange = ({ data }) => {
    const line = trace.push(`${at()} ${label}state ${data}`) - 1;
    trace[line] += onState(data) ? ' consumed' : ' passed';
  };
  return player;
}

/** A PLAYING of the target that the iframe reports from before the warm command. */
function deliverStalePlaying(player: FakeYtPlayer): void {
  player.__onStateChange?.({ data: 1, target: player });
}

/**
 * The App's iframe: the scripted one, then the replacement from replacedAtMs
 * or none from goneAtMs.
 */
function scheduleScript(
  script: Script,
  player: FakeYtPlayer,
  replace: (replacement: FakeYtPlayer | null) => void,
  onState: (state: number) => boolean,
): void {
  const goneAt = script.goneAtMs;
  if (goneAt !== undefined) setTimeout(() => replace(null), goneAt);
  const changesAt = script.videoChangesAtMs;
  if (changesAt !== undefined) {
    setTimeout(() => {
      player.__videoId = CHANGED;
    }, changesAt);
  }
  const replacedAt = script.replacedAtMs;
  if (replacedAt !== undefined) {
    const replacement = scriptedIframe({ video: TARGET, state: 2, horizonMs: 0 }, 'B ', onState);
    setTimeout(() => replace(replacement), replacedAt);
  }
}

function armedSummary(message: YouTubeZeroStartWireMessage): string {
  if (message.type !== 'youtube-zero-start-armed') return message.type;
  return (
    `${message.type} prepared=${message.preparedMs} warm=${message.warmLatencyMs} ` +
    `pos=${message.positionSec} state=${message.playerState} muted=${message.muted} ` +
    `volume=${message.volume}`
  );
}

/** A Standard guest's local prepare of TARGET from canonical 0:00, as player.ts wires it. */
async function runZeroStart(
  script: Script,
  mediaAction: 'replace-media' | 'resident-reposition',
): Promise<string[]> {
  trace = [];
  t0 = Date.now();
  let controller: YouTubeZeroStartController | null = null;
  const onState = (state: number): boolean => controller?.handlePlayerStateChange(state) ?? false;
  const player = scriptedIframe(script, '', onState);
  let current: FakeYtPlayer | null = player;
  let lastPhase = 'idle';
  controller = new YouTubeZeroStartController({
    getRole: () => 'guest',
    getLocalPeerId: () => GUEST_ID,
    getHostPeerId: () => HOST_ID,
    getLiveGuestPeerIds: () => [],
    getPlayer: () => current as YouTubeZeroStartPlayer | null,
    isPlayerReady: () => true,
    isAudioUnlocked: () => true,
    isClockCalibrated: () => true,
    getHostNow: () => Date.now(),
    getClockOffsetMs: () => 0,
    getLocalPlatform: () => 'other',
    getDesiredAudioState: () => ({ muted: false, volume: 80 }),
    sendToPeer: () => false,
    sendToHost: (message) => {
      trace.push(`${at()} send ${armedSummary(message)}`);
      return true;
    },
    onPrepareSelection: () => mediaAction,
    onPhaseChange: ({ phase }) => {
      if (phase === lastPhase) return;
      lastPhase = phase;
      trace.push(`${at()} phase ${phase}`);
      if (phase === 'warming' && script.stalePlayingAtWarm) deliverStalePlaying(player);
    },
    onError: (reason, error) => {
      trace.push(`${at()} error ${reason}${detail(error)}`);
    },
    onDebug: (message, value) => {
      trace.push(`${at()} debug ${message}${detail(value)}`);
    },
    resolveLocalTargetSec: (canonical) => canonical,
    toCanonicalPositionSec: (local) => local,
    createRunId: (sequence) => `run-${sequence}`,
  });
  scheduleScript(
    script,
    player,
    (replacement) => {
      current = replacement;
    },
    onState,
  );
  const line = trace.push('+0 PREPARE') - 1;
  const accepted = controller.handlePrepare(HOST_ID, {
    type: 'youtube-zero-start-prepare',
    version: 1,
    runId: 'run-1',
    sequence: 1,
    queueItemId: QUEUE_ITEM_ID,
    videoId: TARGET,
    subIndex: null,
    prepareAtHost: t0,
    decisionAtHost: t0 + 2_300,
    startDeadlineAtHost: t0 + 3_000,
    hostPlatform: 'other',
  });
  trace[line] += accepted ? ' accepted' : ' refused';
  await vi.advanceTimersByTimeAsync(script.horizonMs);
  return trace;
}

type ArmPrepareResult = Awaited<ReturnType<YouTubeAuthorityArmController['prepare']>>;

function resultSummary(result: ArmPrepareResult): string {
  if (result.status !== 'ready') return `${result.status} ${result.reason}`;
  const { preparedMs, warmLatencyMs, targetSeconds } = result.prepared;
  return `ready prepared=${preparedMs} warm=${warmLatencyMs} target=${targetSeconds}`;
}

/** The PRO arm's resident prepare of TARGET at 0:00, as iframe.ts asks it. */
async function runProArm(script: Script): Promise<string[]> {
  trace = [];
  t0 = Date.now();
  let controller: YouTubeAuthorityArmController | null = null;
  const onState = (state: number): boolean => controller?.handlePlayerStateChange(state) ?? false;
  const player = scriptedIframe(script, '', onState);
  let current: FakeYtPlayer | null = player;
  controller = new YouTubeAuthorityArmController({
    getPlayer: () => current as YouTubeAuthorityArmPlayer | null,
    getPlatform: () => 'other',
    onPhaseChange: (phase) => {
      trace.push(`${at()} phase ${phase}`);
      if (phase === 'warming' && script.stalePlayingAtWarm) deliverStalePlaying(player);
    },
  });
  scheduleScript(
    script,
    player,
    (replacement) => {
      current = replacement;
    },
    onState,
  );
  trace.push('+0 PREPARE');
  const outcome = controller
    .prepare({
      authorityKey: 'transition-1',
      queueItemId: QUEUE_ITEM_ID,
      videoId: TARGET,
      subIndex: 0,
      targetSeconds: 0,
      strategy: 'resident',
      desiredMuted: false,
      desiredVolume: 80,
    })
    .then((result) => {
      trace.push(`${at()} result ${resultSummary(result)}`);
    });
  await vi.advanceTimersByTimeAsync(script.horizonMs);
  // Every script's prepare has settled within its horizon.
  await outcome;
  return trace;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Standard zero-start run (a guest prepare)', () => {
  it('resident paused iframe: mute reported at once', async () => {
    expect(await runZeroStart(SCRIPTS.residentPaused, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('resident playing iframe: its repeated PLAYING is the warm PLAYING', async () => {
    expect(await runZeroStart(SCRIPTS.residentPlaying, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('resident playing iframe, states reported a task later: the warm reads PLAYING itself', async () => {
    expect(await runZeroStart(SCRIPTS.residentPlayingAsync, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 playVideo()',
      '+260 pauseVideo()',
      '+260 phase settling',
      '+261 state 2 consumed',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('resident iframe at the end: seeks to the target before the warm play', async () => {
    expect(await runZeroStart(SCRIPTS.residentEnded, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('resident iframe at the end whose seek throws: loads the target instead', async () => {
    expect(await runZeroStart(SCRIPTS.residentEndedSeekThrows, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 seekTo(0,true) throws',
      '+0 debug resident-seek-failed {"runId":"run-1","videoId":"armGolden01","target":0,"error":"Error: scripted seekTo fault"}',
      '+0 loadVideoById(armGolden01,0)',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true) throws',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('cold iframe: loads the target', async () => {
    expect(await runZeroStart(SCRIPTS.cold, 'replace-media')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 loadVideoById(armGolden01,0)',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('cold iframe with a stale resident decision: loads the target and says why', async () => {
    expect(await runZeroStart(SCRIPTS.cold, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 debug resident-media-mismatch {"runId":"run-1","expectedVideoId":"armGolden01","currentVideoId":"armGolden02"}',
      '+0 loadVideoById(armGolden01,0)',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(37)',
      '+500 unMute()',
      '+620 phase armed',
      '+620 send youtube-zero-start-armed prepared=620 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('mute reported 70 ms late: three unconfirmed polls, each muting again', async () => {
    expect(await runZeroStart(SCRIPTS.muteReported70msLate, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 setVolume(37)',
      '+90 mute()',
      '+90 phase warming',
      '+90 playVideo()',
      '+90 state 1 consumed',
      '+350 pauseVideo()',
      '+350 state 2 consumed',
      '+350 phase settling',
      '+430 seekTo(0,true)',
      '+590 phase restoring-audio',
      '+590 setVolume(37)',
      '+590 unMute()',
      '+710 phase armed',
      '+710 send youtube-zero-start-armed prepared=710 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('mute never reported: hard-mute-timeout after the twelfth poll', async () => {
    expect(await runZeroStart(SCRIPTS.muteNever, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 mute()',
      '+120 mute()',
      '+150 mute()',
      '+180 mute()',
      '+210 mute()',
      '+240 mute()',
      '+270 mute()',
      '+300 mute()',
      '+330 error hard-mute-timeout',
      '+330 debug prepare-failed {"reason":"hard-mute-timeout"}',
      '+330 pauseVideo()',
      '+330 state 2 consumed',
      '+330 phase error',
      '+330 setVolume(37)',
      '+330 unMute()',
      '+450 debug audio-restore-complete {"runId":"run-1","attempts":1}',
    ]);
  });
  it('isMuted() throws on its first two reads: each counts as not muted', async () => {
    expect(await runZeroStart(SCRIPTS.isMutedThrowsTwice, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 setVolume(37)',
      '+60 mute()',
      '+60 phase warming',
      '+60 playVideo()',
      '+60 state 1 consumed',
      '+320 pauseVideo()',
      '+320 state 2 consumed',
      '+320 phase settling',
      '+400 seekTo(0,true)',
      '+560 phase restoring-audio',
      '+560 setVolume(37)',
      '+560 unMute()',
      '+680 phase armed',
      '+680 send youtube-zero-start-armed prepared=680 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('the first mute() throws: hard-mute-command-failed, no poll', async () => {
    expect(await runZeroStart(SCRIPTS.muteAlwaysThrows, 'resident-reposition')).toEqual([
      '+0 PREPARE refused',
      '+0 phase muting',
      '+0 mute() throws',
      '+0 error hard-mute-command-failed "Error: scripted mute fault"',
      '+0 debug prepare-failed {"reason":"hard-mute-command-failed","error":"Error: scripted mute fault"}',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 phase error',
      '+0 setVolume(37)',
      '+0 unMute()',
      '+120 debug audio-restore-complete {"runId":"run-1","attempts":1}',
    ]);
  });
  it('mute() throws from its second call: the polls go on, the warm fails', async () => {
    expect(await runZeroStart(SCRIPTS.muteThrowsAfterFirst, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute() throws',
      '+30 mute() throws',
      '+60 mute() throws',
      '+90 setVolume(37)',
      '+90 mute() throws',
      '+90 error youtube-load-failed "Error: scripted mute fault"',
      '+90 debug prepare-failed {"reason":"youtube-load-failed","error":"Error: scripted mute fault"}',
      '+90 pauseVideo()',
      '+90 state 2 consumed',
      '+90 phase error',
      '+90 setVolume(37)',
      '+90 unMute()',
      '+210 debug audio-restore-complete {"runId":"run-1","attempts":1}',
    ]);
  });
  it('video changed while muting: loads the target and says why', async () => {
    expect(await runZeroStart(SCRIPTS.videoChangesBeforeWarm, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 setVolume(37)',
      '+90 mute()',
      '+90 phase warming',
      '+90 debug resident-media-mismatch {"runId":"run-1","expectedVideoId":"armGolden01","currentVideoId":"armGolden03"}',
      '+90 loadVideoById(armGolden01,0)',
      '+90 state 1 consumed',
      '+350 pauseVideo()',
      '+350 state 2 consumed',
      '+350 phase settling',
      '+430 seekTo(0,true)',
      '+590 phase restoring-audio',
      '+590 setVolume(37)',
      '+590 unMute()',
      '+710 phase armed',
      '+710 send youtube-zero-start-armed prepared=710 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('warm never reaches PLAYING: prepare-timeout 10 s after the PREPARE', async () => {
    expect(await runZeroStart(SCRIPTS.warmNeverPlays, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 playVideo()',
      '+10000 error prepare-timeout {"phase":"warming","videoId":"armGolden01","mediaAction":"resident-reposition"}',
      '+10000 debug prepare-failed {"reason":"prepare-timeout","error":{"phase":"warming","videoId":"armGolden01","mediaAction":"resident-reposition"}}',
      '+10000 pauseVideo()',
      '+10000 state 2 consumed',
      '+10000 phase error',
      '+10000 setVolume(37)',
      '+10000 unMute()',
      '+10120 debug audio-restore-complete {"runId":"run-1","attempts":1}',
    ]);
  });
  it('a PLAYING before the warm command is refused; the warm PLAYING 100 ms later is accepted', async () => {
    expect(await runZeroStart(SCRIPTS.stalePlayingBeforeWarm, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 state 1 consumed',
      '+0 playVideo()',
      '+100 state 1 consumed',
      '+360 pauseVideo()',
      '+360 state 2 consumed',
      '+360 phase settling',
      '+440 seekTo(0,true)',
      '+600 phase restoring-audio',
      '+600 setVolume(37)',
      '+600 unMute()',
      '+720 phase armed',
      '+720 send youtube-zero-start-armed prepared=720 warm=100 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('no iframe at a poll: player-unavailable, the muted iframe left as it is', async () => {
    expect(await runZeroStart(SCRIPTS.goneWhileMuting, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 error player-unavailable',
      '+60 debug prepare-failed {"reason":"player-unavailable"}',
      '+60 phase error',
    ]);
  });
  it('iframe replaced while muting: the polls go on with the replacement, which the run warms', async () => {
    expect(await runZeroStart(SCRIPTS.replacedWhileMuting, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 B mute()',
      '+90 B setVolume(37)',
      '+90 B mute()',
      '+90 phase warming',
      '+90 B playVideo()',
      '+90 B state 1 consumed',
      '+350 B pauseVideo()',
      '+350 B state 2 consumed',
      '+350 phase settling',
      '+430 B seekTo(0,true)',
      '+590 phase restoring-audio',
      '+590 B setVolume(37)',
      '+590 B unMute()',
      '+710 phase armed',
      '+710 send youtube-zero-start-armed prepared=710 warm=0 pos=0 state=2 muted=false volume=37',
    ]);
  });
  it('iframe replaced while warming: player-replaced, neither iframe touched again', async () => {
    expect(await runZeroStart(SCRIPTS.replacedWhileWarming, 'resident-reposition')).toEqual([
      '+0 PREPARE accepted',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(37)',
      '+0 mute()',
      '+0 phase warming',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 error player-replaced',
      '+260 debug prepare-failed {"reason":"player-replaced"}',
      '+260 phase error',
    ]);
  });
});

describe('PRO arm (a resident prepare)', () => {
  it('resident paused iframe: mute reported at once', async () => {
    expect(await runProArm(SCRIPTS.residentPaused)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(80)',
      '+500 unMute()',
      '+620 phase prepared',
      '+620 result ready prepared=620 warm=0 target=0',
    ]);
  });
  it('resident playing iframe', async () => {
    expect(await runProArm(SCRIPTS.residentPlaying)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(80)',
      '+500 unMute()',
      '+620 phase prepared',
      '+620 result ready prepared=620 warm=0 target=0',
    ]);
  });
  it('resident playing iframe, states reported a task later: the warm reads PLAYING itself', async () => {
    expect(await runProArm(SCRIPTS.residentPlayingAsync)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+1 state 2 consumed',
      '+1 state 1 consumed',
      '+260 pauseVideo()',
      '+260 phase settling',
      '+261 state 2 consumed',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(80)',
      '+500 unMute()',
      '+620 phase prepared',
      '+620 result ready prepared=620 warm=0 target=0',
    ]);
  });
  it('resident iframe at the end', async () => {
    expect(await runProArm(SCRIPTS.residentEnded)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(80)',
      '+500 unMute()',
      '+620 phase prepared',
      '+620 result ready prepared=620 warm=0 target=0',
    ]);
  });
  it('resident iframe at the end whose seek throws: player-command-failed', async () => {
    expect(await runProArm(SCRIPTS.residentEndedSeekThrows)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true) throws',
      '+0 pauseVideo()',
      '+0 state 2 passed',
      '+0 phase failed',
      '+0 setVolume(80)',
      '+0 unMute()',
      '+0 phase idle',
      '+0 result failed player-command-failed',
    ]);
  });
  it('cold iframe: identity-mismatch before any command', async () => {
    expect(await runProArm(SCRIPTS.cold)).toEqual([
      '+0 PREPARE',
      '+0 result failed identity-mismatch',
    ]);
  });
  it('mute reported 70 ms late: three unconfirmed polls, each muting again', async () => {
    expect(await runProArm(SCRIPTS.muteReported70msLate)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 setVolume(80)',
      '+90 mute()',
      '+90 phase warming',
      '+90 pauseVideo()',
      '+90 state 2 consumed',
      '+90 seekTo(0,true)',
      '+90 playVideo()',
      '+90 state 1 consumed',
      '+350 pauseVideo()',
      '+350 state 2 consumed',
      '+350 phase settling',
      '+430 seekTo(0,true)',
      '+590 phase restoring-audio',
      '+590 setVolume(80)',
      '+590 unMute()',
      '+710 phase prepared',
      '+710 result ready prepared=710 warm=0 target=0',
    ]);
  });
  it('mute never reported: hard-mute-timeout after the twelfth poll', async () => {
    expect(await runProArm(SCRIPTS.muteNever)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 mute()',
      '+120 mute()',
      '+150 mute()',
      '+180 mute()',
      '+210 mute()',
      '+240 mute()',
      '+270 mute()',
      '+300 mute()',
      '+330 pauseVideo()',
      '+330 state 2 passed',
      '+330 phase failed',
      '+330 setVolume(80)',
      '+330 unMute()',
      '+330 phase idle',
      '+330 result failed hard-mute-timeout',
    ]);
  });
  it('isMuted() throws on its first two reads: each counts as not muted', async () => {
    expect(await runProArm(SCRIPTS.isMutedThrowsTwice)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 setVolume(80)',
      '+60 mute()',
      '+60 phase warming',
      '+60 pauseVideo()',
      '+60 state 2 consumed',
      '+60 seekTo(0,true)',
      '+60 playVideo()',
      '+60 state 1 consumed',
      '+320 pauseVideo()',
      '+320 state 2 consumed',
      '+320 phase settling',
      '+400 seekTo(0,true)',
      '+560 phase restoring-audio',
      '+560 setVolume(80)',
      '+560 unMute()',
      '+680 phase prepared',
      '+680 result ready prepared=680 warm=0 target=0',
    ]);
  });
  it('the first mute() throws: player-command-failed, no poll', async () => {
    expect(await runProArm(SCRIPTS.muteAlwaysThrows)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute() throws',
      '+0 pauseVideo()',
      '+0 state 2 passed',
      '+0 phase failed',
      '+0 setVolume(80)',
      '+0 unMute()',
      '+0 phase idle',
      '+0 result failed player-command-failed',
    ]);
  });
  it('mute() throws from its second call: the polls go on, the warm fails', async () => {
    expect(await runProArm(SCRIPTS.muteThrowsAfterFirst)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute() throws',
      '+30 mute() throws',
      '+60 mute() throws',
      '+90 setVolume(80)',
      '+90 mute() throws',
      '+90 pauseVideo()',
      '+90 state 2 passed',
      '+90 phase failed',
      '+90 setVolume(80)',
      '+90 unMute()',
      '+90 phase idle',
      '+90 result failed player-command-failed',
    ]);
  });
  it('video changed while muting: identity-mismatch at the warm', async () => {
    expect(await runProArm(SCRIPTS.videoChangesBeforeWarm)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 mute()',
      '+90 setVolume(80)',
      '+90 mute()',
      '+90 phase warming',
      '+90 pauseVideo()',
      '+90 state 2 passed',
      '+90 phase failed',
      '+90 setVolume(80)',
      '+90 unMute()',
      '+90 phase idle',
      '+90 result failed identity-mismatch',
    ]);
  });
  it('warm never reaches PLAYING: warm-timeout at the 2.3 s deadline', async () => {
    expect(await runProArm(SCRIPTS.warmNeverPlays)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+2300 pauseVideo()',
      '+2300 state 2 passed',
      '+2300 phase failed',
      '+2300 setVolume(80)',
      '+2300 unMute()',
      '+2300 phase idle',
      '+2300 result failed warm-timeout',
    ]);
  });
  it('a PLAYING before the warm command is accepted as the warm PLAYING', async () => {
    expect(await runProArm(SCRIPTS.stalePlayingBeforeWarm)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 state 1 consumed',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+100 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 consumed',
      '+260 phase settling',
      '+340 seekTo(0,true)',
      '+500 phase restoring-audio',
      '+500 setVolume(80)',
      '+500 unMute()',
      '+620 phase prepared',
      '+620 result ready prepared=620 warm=0 target=0',
    ]);
  });
  it('no iframe at a poll: superseded', async () => {
    expect(await runProArm(SCRIPTS.goneWhileMuting)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 pauseVideo()',
      '+60 state 2 passed',
      '+60 phase idle',
      '+60 result superseded superseded',
    ]);
  });
  it('iframe replaced while muting: superseded, the replacement untouched', async () => {
    expect(await runProArm(SCRIPTS.replacedWhileMuting)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 mute()',
      '+30 mute()',
      '+60 pauseVideo()',
      '+60 state 2 passed',
      '+60 phase idle',
      '+60 result superseded superseded',
    ]);
  });
  it('iframe replaced while warming: superseded, the replacement untouched', async () => {
    expect(await runProArm(SCRIPTS.replacedWhileWarming)).toEqual([
      '+0 PREPARE',
      '+0 phase muting',
      '+0 mute()',
      '+0 setVolume(80)',
      '+0 mute()',
      '+0 phase warming',
      '+0 pauseVideo()',
      '+0 state 2 consumed',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+0 state 1 consumed',
      '+260 pauseVideo()',
      '+260 state 2 passed',
      '+260 phase idle',
      '+260 result superseded superseded',
    ]);
  });
});
