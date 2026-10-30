/**
 * @vitest-environment jsdom
 *
 * H3 owner queries, pinned 2026-10-30 (tests first for Phase 6 increment 6A-1).
 *
 * native-control-authority.ts asks "does a synchronization owner hold the
 * iframe?" by reading seven managed-timer names (hasProtectedTransitionOwner,
 * native-control-authority.ts:138-160). Three sites use that answer: native
 * PLAY kept through the autoplay guard (:213), a native position jump sent to
 * the host (:260) and a native PLAY/PAUSE routed as a room action (:496). The
 * truth table below arms each owner through its real flow (the nudge alone
 * keeps a raw timer, PRE-4) and records each site's decision while the owner
 * is active and again after the owner has released, so the same table must
 * pass once 6A-1 replaces the names with owner queries.
 *
 * Real: player.ts and sync.ts wiring (initYouTube, initYouTubeSync), the
 * protocol dispatcher, the native-control authority and core/timers. Fakes:
 * a plain-function iframe whose state changes only when a callback is
 * delivered (so the native-control instrumentation applies), the network
 * sends, the shared clock (calibrated), log and toasts.
 *
 * The second and third parts pin the other users of the same owners: the
 * suppressions a host's stage-2 'yt-auto-sync' wait causes (PRE-2), the six
 * callers of isStandardHostYouTubeLocalStartPending() (PRE-2), and the direct
 * timer clears that skip their owner's retire today (PRE-5, "expected today").
 * A row marked "Looks like a defect" pins today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, setManagedTimer } from '../../core/timers.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initProtocol, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, PlaylistItem, QueueItemId } from '../../types/index.ts';
import { SEEK_PLAY_GAP_MS, STAGE2_RENDEZVOUS_BROADCAST_MS } from '../constants.ts';
import {
  getYtAutoplayIntent,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  isStandardHostYouTubeLocalStartPending,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  toCanonicalYouTubeTime,
} from '../local-offset.ts';
import {
  initYouTubeNativeControlAuthority,
  observeYouTubeNativeControlPosition,
  preserveNativeControllerPlayBeforeAutoplayGuard,
} from '../native-control-authority.ts';
import { clearYouTubeStableControlExpectations } from '../native-control-origin.ts';
import { adoptResidentYouTubeOccurrence } from '../iframe.ts';
import { initYouTube, scheduleYtAutoSync, stopYouTubeMode } from '../player.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import {
  broadcastYouTubeSync,
  guestRendezvousSync,
  initYouTubeSync,
  resetYouTubeSyncState,
} from '../sync.ts';
import {
  createFakeClockStarter,
  opTrace,
  setUpStandardRig,
  syntheticConnection,
  type StandardRig,
} from './__helpers__/standard-start-harness.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(() => true),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
  getClockCorrectionQuality: () => ({
    eligible: true,
    reason: 'fresh',
    epoch: 0,
    offsetMs: 0,
    rttMs: 0,
    uncertaintyMs: 5,
    precisionMs: 5,
    selectedAgeMs: 0,
    newestSampleAgeMs: 0,
  }),
}));

const QUEUE_ITEM_ID = '80000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'ownerQuery1';
const ROOM_CODE = '100001';

interface CallbackPlayer extends YouTubePlayerInstance {
  deliverState(state: number): void;
  /** Move the media position without a seekTo command (a native seek). */
  jump(seconds: number): void;
}

function createPlayer(initialState = 1): CallbackPlayer {
  let state = initialState;
  let position = 42.25;
  // Plain functions so the native-control instrumentation wraps them.
  // Commands stay asynchronous, as with the IFrame API: only a delivered
  // callback changes the reported state.
  return {
    playVideo: () => undefined,
    pauseVideo: () => undefined,
    loadVideoById: () => undefined,
    loadPlaylist: () => undefined,
    cueVideoById: () => undefined,
    cuePlaylist: () => undefined,
    stopVideo: () => undefined,
    destroy: () => undefined,
    mute: () => undefined,
    unMute: () => undefined,
    isMuted: () => false,
    getVolume: () => 100,
    seekTo: (seconds) => {
      position = seconds;
    },
    getCurrentTime: () => position,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => -1,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [],
    setVolume: () => undefined,
    deliverState(next) {
      state = next;
      if (next === 2) setPlaybackYouTubePaused();
      if (next === 1) setPlaybackYouTubePlaying();
    },
    jump(seconds) {
      position += seconds;
    },
  };
}

let hostConn: DataConnection;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));

function installQueueItem(): void {
  setState('setup.sessionStarted', true);
  setState('network.sessionCode', ROOM_CODE);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: VIDEO_ID,
      playlistId: null,
    } as PlaylistItem,
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
}

/** An operator guest of a Standard room, its iframe playing at 42.25 s. */
function installOperatorGuest(player: CallbackPlayer): void {
  hostConn = syntheticConnection('owner-host-1');
  setState('network.appRole', 'guest');
  setState('network.myId', 'owner-guest-1');
  setState('network.hostConn', hostConn);
  setState('network.isOperator', true);
  setState('network.standardRoomCapabilities', ['playback.control']);
  markQueueAuthorityReady(hostConn);
  resetInboundRateLimit(hostConn.peer);
  installQueueItem();
  startRuntime(player);
}

function startRuntime(player: CallbackPlayer): void {
  initYouTube();
  initYouTubeSync();
  initProtocol();
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(true);
  if (player.getPlayerState() === 1) setPlaybackYouTubePlaying();
  else setPlaybackYouTubePaused();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

function hostFrame(type: string, frame: Record<string, unknown>): void {
  bus.emit(
    'network:data',
    {
      type,
      queueItemId: QUEUE_ITEM_ID,
      videoId: VIDEO_ID,
      subIndex: -1,
      hostClock: Date.now(),
      ...frame,
    },
    hostConn,
  );
}

function requestsSentSince(index: number): string[] {
  return vi
    .mocked(safeSend)
    .mock.calls.slice(index)
    .map(([, frame]) => (frame as { type: string }).type)
    .filter((type) => type.startsWith('request-'));
}

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  setLocalYouTubePaused(false);
  vi.clearAllMocks();
  document.body.innerHTML =
    '<div id="youtube-player-container"><iframe id="owner-iframe" tabindex="0"></iframe></div>';
});

afterEach(() => {
  stopYouTubeMode({ silent: true });
  clearAllManagedTimers();
  resetYouTubeSyncState();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  bus.clear();
  resetState();
  document.body.innerHTML = '';
});

// ─── The seven owners, each armed through its own flow ─────────────

type OwnerName =
  | typeof PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER
  | 'yt-auto-sync'
  | 'yt-clock-action'
  | 'yt-seek-play'
  | 'yt-rendezvous-buffer'
  | 'yt-rendezvous-play'
  | 'yt-rendezvous-calibrate';

const OWNERS: readonly OwnerName[] = [
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  'yt-auto-sync',
  'yt-clock-action',
  'yt-seek-play',
  'yt-rendezvous-buffer',
  'yt-rendezvous-play',
  'yt-rendezvous-calibrate',
];

/**
 * Arm one owner through its real flow on the operator guest and return the
 * fake time after which it has released. The nudge keeps a raw timer (PRE-4
 * stays a timer-name read).
 */
async function armOwner(owner: OwnerName, player: CallbackPlayer): Promise<number> {
  switch (owner) {
    case PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER:
      setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 2_000);
      return 2_000;
    case 'yt-auto-sync':
      // A seek's stage-2 window, as the Standard host arms it.
      scheduleYtAutoSync(42.35);
      return STAGE2_RENDEZVOUS_BROADCAST_MS;
    case 'yt-clock-action':
      // A host PLAY one second in the future.
      hostFrame(MSG.YOUTUBE_STATE, { state: 1, time: 42.35, hostPlayAt: Date.now() + 1_000 });
      return 1_000;
    case 'yt-seek-play':
      // An immediate host PLAY: pause, seek, play after the seek gap.
      hostFrame(MSG.YOUTUBE_STATE, { state: 1, time: 42.35 });
      return 1_000;
    case 'yt-rendezvous-buffer':
    case 'yt-rendezvous-play':
    case 'yt-rendezvous-calibrate': {
      hostFrame(MSG.YOUTUBE_SYNC, { state: 1, time: 42.35 });
      expect(guestRendezvousSync({ silent: true }).status).toBe('started');
      if (owner === 'yt-rendezvous-buffer') return 6_000;
      // The iframe reports the rendezvous pause: the buffer gate opens.
      player.deliverState(2);
      await vi.advanceTimersByTimeAsync(60);
      if (owner === 'yt-rendezvous-play') return 6_000;
      // Let the scheduled play fire; the calibration stage then runs.
      await vi.advanceTimersByTimeAsync(1_500);
      player.deliverState(1);
      return 6_000;
    }
  }
}

// ─── The three protected-owner sites ───────────────────────────────

/**
 * The gap between the :260 site's two position samples. Both must fall inside
 * the shortest owner window, 'yt-seek-play', which ends with its own delayed
 * playVideo after SEEK_PLAY_GAP_MS; a sample after that command would differ
 * by control revision and hide the jump whatever the owner check answers.
 */
const POSITION_SAMPLE_GAP_MS = SEEK_PLAY_GAP_MS / 3;

type Site = ':213 native PLAY kept' | ':260 position jump sent' | ':496 native PAUSE routed';
const SITES: readonly Site[] = [
  ':213 native PLAY kept',
  ':260 position jump sent',
  ':496 native PAUSE routed',
];

/** Ask one site for its decision now, from a clean origin record. */
async function decide(site: Site, player: CallbackPlayer): Promise<boolean> {
  clearYouTubeStableControlExpectations(player);
  switch (site) {
    case ':213 native PLAY kept': {
      const intent = getYtAutoplayIntent();
      setYtAutoplayIntent(false);
      const kept = preserveNativeControllerPlayBeforeAutoplayGuard(player);
      setYtAutoplayIntent(intent || kept);
      return kept;
    }
    case ':260 position jump sent': {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      document.getElementById('owner-iframe')!.focus();
      const before = vi.mocked(safeSend).mock.calls.length;
      observeYouTubeNativeControlPosition(player);
      await vi.advanceTimersByTimeAsync(POSITION_SAMPLE_GAP_MS);
      player.jump(10);
      observeYouTubeNativeControlPosition(player);
      vi.mocked(document.hasFocus).mockRestore();
      return requestsSentSince(before).includes(MSG.REQUEST_SEEK);
    }
    case ':496 native PAUSE routed': {
      if (getState('playback.activity') !== 'playing') player.deliverState(1);
      clearYouTubeStableControlExpectations(player);
      const before = vi.mocked(safeSend).mock.calls.length;
      player.deliverState(2);
      const routed = requestsSentSince(before).includes(MSG.REQUEST_YOUTUBE_PAUSE);
      player.deliverState(1);
      return routed;
    }
  }
}

describe('H3 owner queries: seven owners x three sites (pinned 2026-10-30)', () => {
  it.each(SITES)('%s decides at once when no owner is armed (control row)', async (site) => {
    const player = createPlayer();
    installOperatorGuest(player);
    expect(await decide(site, player)).toBe(true);
  });

  const rows = OWNERS.flatMap((owner) => SITES.map((site) => [owner, site] as const));

  it.each(rows)('%s at %s: held while active, decided after release', async (owner, site) => {
    const player = createPlayer();
    installOperatorGuest(player);
    const releasedAfter = await armOwner(owner, player);
    const active = await decide(site, player);
    // Past the release and every 4 s origin/seek record of its commands.
    await vi.advanceTimersByTimeAsync(releasedAfter + 4_100);
    const inactive = await decide(site, player);
    expect({ active, inactive }).toEqual({ active: false, inactive: true });
  });
});

// ─── PRE-2: the other users of the same owners, on a Standard host ──

async function hostRig(localOffsetSeconds = 0): Promise<StandardRig> {
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  rig = await setUpStandardRig({
    role: 'host',
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: ROOM_CODE,
    queueItemId: QUEUE_ITEM_ID,
    videoId: VIDEO_ID,
    hostPeerId: 'owner-host-1',
    guestPeerId: 'owner-guest-1',
    localOffsetSeconds,
  });
  return rig;
}

let rig: StandardRig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  vi.unstubAllGlobals();
});

/** '<ms since t0> <type>[ state <n>][ manual]' for frames sent from index on. */
function sentSince(current: StandardRig, index: number): string[] {
  return current.sent.slice(index).map(({ at, type, frame }) => {
    const state = typeof frame.state === 'number' ? ` state ${frame.state}` : '';
    return `${at} ${type}${state}${frame.isManual === true ? ' manual' : ''}`;
  });
}

describe("H3 owner queries: what a Standard host's stage-2 'yt-auto-sync' wait suppresses (pinned 2026-10-30)", () => {
  // Play at +100 arms the wait until +2100, which ends with the manual
  // Stage-2 frame. +2700 is past the 500 ms in which a heartbeat after a
  // manual frame is dropped, so each control row reads the open path.
  it('holds the non-manual heartbeat during the wait and sends it after (sync.ts:409)', async () => {
    const current = await hostRig();
    await current.advanceTo(100);
    scheduleYtAutoSync(10);
    const from = current.sent.length;
    await current.advanceTo(600);
    bus.emit('youtube:broadcast-sync');
    await current.advanceTo(2_700);
    bus.emit('youtube:broadcast-sync');
    expect(sentSince(current, from)).toEqual([
      '2100 youtube-sync state 1 manual',
      '2700 youtube-sync state 1',
    ]);
  });

  it('holds the auxiliary host YOUTUBE_STATE of an iframe state change during the wait (iframe.ts:3372)', async () => {
    const current = await hostRig();
    await current.advanceTo(100);
    scheduleYtAutoSync(10);
    const from = current.sent.length;
    await current.advanceTo(600);
    current.iframe().__setState(2);
    await current.advanceTo(2_700);
    current.iframe().__setState(1);
    expect(sentSince(current, from)).toEqual([
      '2100 youtube-sync state 1 manual',
      '2700 youtube-state state 1',
    ]);
  });

  it('holds youtube:sub-video-advanced during the wait (iframe.ts:3760)', async () => {
    const current = await hostRig();
    const advanced: number[] = [];
    bus.on('youtube:sub-video-advanced', () => advanced.push(current.now()));
    await current.advanceTo(100);
    scheduleYtAutoSync(10);
    await current.advanceTo(600);
    current.iframe().__playlistIdx = 1;
    await current.advanceTo(1_600);
    expect(advanced).toEqual([]);
    await current.advanceTo(2_700);
    current.iframe().__playlistIdx = 2;
    await current.advanceTo(3_300);
    // The next UI tick after the wait detects the change.
    expect(advanced).toEqual([3_000]);
  });

  it('takes the midSync seek path during the wait and the paused path after (player.ts:1862)', async () => {
    const current = await hostRig();
    await current.advanceTo(100);
    scheduleYtAutoSync(10);
    await current.advanceTo(600);
    current.iframe().__setState(3, false);
    const during = current.sent.length;
    bus.emit('youtube:seek-to', 30);
    // A buffering host reschedules the rendezvous: the iframe's PLAYING
    // broadcast, then Stage 1.
    expect(sentSince(current, during)).toEqual([
      '600 youtube-state state 1',
      '600 youtube-state state 1',
    ]);
    await current.advanceTo(5_000);
    current.iframe().__setState(3, false);
    const after = current.sent.length;
    bus.emit('youtube:seek-to', 40);
    expect(sentSince(current, after)).toEqual(['5000 youtube-state state 2']);
  });
});

describe('H3 owner queries: the six callers of isStandardHostYouTubeLocalStartPending() (pinned 2026-10-30)', () => {
  // The hold always comes with the stage-2 wait (5 s hold + 2 s), so the
  // control rows read the host after both, paused for real at 7.9 s.
  /** A host at a -5 s local offset holds its speaker at 0:00 for 5 s after play at +100. */
  async function heldHost(): Promise<StandardRig> {
    const current = await hostRig(-5);
    await current.advanceTo(100);
    scheduleYtAutoSync(0);
    await current.advanceTo(600);
    return current;
  }

  /** The same host after the hold (+5100) and the stage-2 wait (+7100), paused for real. */
  async function releasedPausedHost(): Promise<StandardRig> {
    const current = await heldHost();
    await current.advanceTo(8_000);
    bus.emit('youtube:toggle-play');
    await current.advanceTo(8_100);
    return current;
  }

  const build = (hold: 'pending' | 'not pending') =>
    hold === 'pending' ? heldHost() : releasedPausedHost();

  it.each([
    ['pending', []],
    ['not pending', [false]],
  ] as const)('iframe.ts:3122 swallows the iframe state event while %s', async (hold, expected) => {
    const current = await build(hold);
    const updates: boolean[] = [];
    bus.on('ui:update-play-state', (playing) => updates.push(playing));
    current.iframe().__setState(2);
    expect(updates).toEqual(expected);
  });

  it.each([
    ['pending', []],
    ['not pending', [{ targetTime: 7.9, skipSeek: false, zeroStart: false, state: 2 }]],
  ] as const)(
    'native-control-authority.ts:148 counts the hold as an owner of a native PAUSE while %s',
    async (hold, expected) => {
      const current = await build(hold);
      // The native-control instrumentation needs the full stable-control surface.
      Object.assign(current.iframe(), {
        loadPlaylist: () => undefined,
        cuePlaylist: () => undefined,
      });
      initYouTubeNativeControlAuthority();
      bus.emit('youtube:player-ready');
      setPlaybackYouTubePlaying();
      clearYouTubeStableControlExpectations(current.iframe() as unknown as YouTubePlayerInstance);
      const promoted: unknown[] = [];
      bus.on('youtube:auto-play', (intent) => promoted.push(intent));
      setPlaybackYouTubePaused();
      expect(promoted).toEqual(expected);
    },
  );

  it.each([
    ['pending', ['600 youtube-state state 1', '600 youtube-state state 1']],
    ['not pending', ['8100 youtube-state state 2']],
  ] as const)('player.ts:1860 seeks with midSync while %s', async (hold, expected) => {
    const current = await build(hold);
    const from = current.sent.length;
    bus.emit('youtube:seek-to', 30);
    expect(sentSince(current, from)).toEqual(expected);
  });

  it.each([
    ['pending', ['600 youtube-state state 2', '600 youtube-state state 2']],
    ['not pending', ['8100 youtube-state state 1', '8100 youtube-state state 1']],
  ] as const)(
    'player.ts:3396 reads a toggle as a pause of the virtually playing room while %s',
    async (hold, expected) => {
      const current = await build(hold);
      const from = current.sent.length;
      bus.emit('youtube:toggle-play');
      expect(sentSince(current, from)).toEqual(expected);
    },
  );

  it.each([
    ['pending', ['600 youtube-sync state 1 manual']],
    ['not pending', ['8100 youtube-sync state 2 manual']],
  ] as const)('sync.ts:441 publishes heartbeat state 1 while %s', async (hold, expected) => {
    const current = await build(hold);
    const from = current.sent.length;
    broadcastYouTubeSync(true);
    expect(sentSince(current, from)).toEqual(expected);
  });

  it.each([
    // The held start's canonical 0.5 s minus 4 s clamps to the media start.
    ['pending', ['+600 cueVideoById(ownerQuery1,0)']],
    ['not pending', ['+8100 cueVideoById(ownerQuery1,3.9)']],
  ] as const)(
    'standard-host-manual-offset-runtime.ts:587 reads a manual offset edit while %s',
    async (hold, expected) => {
      await prepareStandardHostManualOffsetRuntimeForTests();
      const current = await build(hold);
      const from = current.iframe().__log.length;
      bus.emit('youtube:set-coordinator-manual-offset', -4, 'committed');
      await current.advanceTo(current.now() + 1_000);
      expect(opTrace(current.iframe(), current.t0, from)).toEqual(expected);
      resetStandardHostManualOffsetTransaction();
    },
  );
});

describe('H3 owner queries: direct timer clears that skip their owner retire, expected today (PRE-5, pinned 2026-10-30)', () => {
  it('keeps the legacy local-start hold, its time reader and its delayed play after adoptResidentYouTubeOccurrence (iframe.ts:1654-1656)', async () => {
    const current = await hostRig(-5);
    await current.advanceTo(100);
    scheduleYtAutoSync(0);
    await current.advanceTo(1_000);
    const from = current.iframe().__log.length;
    // resetResidentYouTubeSync clears yt-auto-sync but runs no player.ts
    // retire: the hold, its reader and the delayed play survive. Today's
    // behaviour; the only production caller (handlers.ts:167) runs
    // cancelYtAutoSync first, which retires the hold.
    adoptResidentYouTubeOccurrence(VIDEO_ID);
    expect(isStandardHostYouTubeLocalStartPending()).toBe(true);
    expect(toCanonicalYouTubeTime(current.iframe().getCurrentTime(), 240)).toBeCloseTo(0.9, 6);
    await current.advanceTo(6_000);
    expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
    expect(opTrace(current.iframe(), current.t0, from)).toEqual([
      '+1000 pauseVideo()',
      '+5100 playVideo()',
    ]);
  });

  it('retires the hold with the session when a YouTube-to-YouTube load resets the resident iframe', async () => {
    const current = await hostRig(-5);
    await current.advanceTo(100);
    scheduleYtAutoSync(0);
    await current.advanceTo(1_000);
    const from = current.iframe().__log.length;
    bus.emit('youtube:load', VIDEO_ID, null, QUEUE_ITEM_ID, false, 0);
    // The new load session fences the hold's reader and its delayed play.
    expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
    expect(toCanonicalYouTubeTime(current.iframe().getCurrentTime(), 240)).toBe(0);
    await current.advanceTo(6_000);
    expect(opTrace(current.iframe(), current.t0, from)).toEqual([
      '+1000 pauseVideo()',
      '+1000 cueVideoById(ownerQuery1,0)',
    ]);
  });

  /** An operator guest whose host scheduled PLAY one second ahead (a clock action). */
  function guestWithClockAction(): { player: CallbackPlayer; loading: string[]; plays: number[] } {
    const player = createPlayer();
    const plays: number[] = [];
    const play = player.playVideo;
    const armedAt = Date.now();
    player.playVideo = () => {
      plays.push(Date.now() - armedAt);
      play();
    };
    installOperatorGuest(player);
    const loading: string[] = [];
    bus.on('youtube:sync-loading', (busy, owner) => loading.push(`${busy} ${owner ?? '-'}`));
    hostFrame(MSG.YOUTUBE_STATE, { state: 1, time: 42.35, hostPlayAt: Date.now() + 1_000 });
    return { player, loading, plays };
  }

  it('lets stopYouTubeMode clear a pending clock action and its spinner (player.ts:1619-1620)', async () => {
    const { loading, plays } = guestWithClockAction();
    await vi.advanceTimersByTimeAsync(200);
    stopYouTubeMode();
    await vi.advanceTimersByTimeAsync(2_000);
    // The direct clear skips cancelClockAction; the unscoped false of
    // cancelYtAutoSync clears every spinner owner instead.
    expect(loading).toEqual([
      'false clock-action',
      'true clock-action',
      'false -',
      'false clock-action',
      'false -',
    ]);
    expect(plays).toEqual([]);
  });

  it('cancels a pending clock action through its owner when a zero-start PREPARE is accepted (player.ts:2326-2327)', async () => {
    const { loading, plays } = guestWithClockAction();
    await vi.advanceTimersByTimeAsync(200);
    bus.emit(
      'network:data',
      {
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        version: 1,
        runId: 'pre5-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost: Date.now(),
        decisionAtHost: Date.now() + 1,
        startDeadlineAtHost: Date.now() + 2,
        hostPlatform: 'other',
      },
      hostConn,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    // invalidateGuestYouTubeTimeline retires the clock action before the
    // direct clear runs.
    expect(loading).toEqual([
      'false clock-action',
      'true clock-action',
      'false clock-action',
      'true zero-start',
    ]);
    expect(plays).toEqual([]);
  });

  it('leaves the clock-action spinner owner set when a host zero-start attempt clears a clock action that a setState role flip kept from the guest role (player.ts:651-652, no known production path)', async () => {
    const { player, loading, plays } = guestWithClockAction();
    await vi.advanceTimersByTimeAsync(200);
    const guest = syntheticConnection('owner-guest-2');
    setState('network.hostConn', null);
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[guest.peer, guest]]));
    resetInboundRateLimit(guest.peer);
    bus.emit(
      'network:data',
      { type: MSG.YOUTUBE_ZERO_START_CAPABILITY, version: 2, platform: 'other', ready: true },
      guest,
    );
    player.seekTo(0, true);
    player.deliverState(2);
    bus.emit('youtube:toggle-play');
    await vi.advanceTimersByTimeAsync(2_000);
    // Expected today (PRE-5), not a listed defect: no production path to this
    // state is known. network.appRole becomes 'host' only in startHostFlow
    // (setup-host.ts:73-74) with no session running, setup.ts refuses a role
    // reset during a session, only the guest YOUTUBE_STATE handler arms
    // 'yt-clock-action' (sync.ts:2561, :2593), and leaving a guest session
    // clears every managed timer and runs stopYouTubeMode, which resets every
    // spinner owner. The row flips the role with setState to pin what the
    // direct clear does: it drops the scheduled play without its
    // 'clock-action' false, so that owner stays until the next unscoped
    // reset (a pause or stop).
    expect(loading).toEqual(['false clock-action', 'true clock-action']);
    expect(plays).toEqual([]);
  });
});
