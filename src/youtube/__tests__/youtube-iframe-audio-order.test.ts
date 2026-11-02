/**
 * @vitest-environment jsdom
 *
 * The App's own iframe audio writes and the holds that keep them closed
 * (pinned 2026-11-02): what a youtube:set-volume event, the PRO pause gate's
 * two events and the PRO direct commit write to the iframe, in which order,
 * which holds they ask, and the two mute rules below 0.5 % master volume, as
 * the App answers today. Since 2026-11-03 also the audio a guest's new run
 * takes when a remote host PREPARE arrives during the guest's local recovery,
 * with and without an ABORT before it.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts behind a scripted IFrame API,
 * the retained player controller, core/timers, the protocol dispatcher, the
 * zero-start controller, the PRO authority arm, the start ledger and, for the
 * PRO rows, the ProRoomPlaybackController with the playlist media endpoint.
 * The Standard rows run on the C2-0 boundary rig (standard-start-harness.ts),
 * the PRO rows on the start-ownership table's PRO participant
 * (pro-endpoint-harness.ts). Fakes at the edges only: the iframe, the network
 * sends, the shared and PRO server clocks, log and toasts.
 *
 * A trace lists, in the order they happen inside one action:
 * - the iframe's own commands ('setVolume(40)', 'mute()', ...);
 * - the desired audio pushed into the two start machines
 *   ('push zero-start ...' for updateYouTubeZeroStartDesiredAudioState,
 *   'push pro ...' for updateProYouTubeAuthorityDesiredAudioState);
 * - the holds asked: 'parked? <answer>' (isRetainedYouTubePlayerParked),
 *   'parking proof' (ensureRetainedYouTubePlayerHardMuted, the retained
 *   player controller's verified hard mute) and 'start hold? <answer>'
 *   (the start ledger's isYouTubeStartHardMuteOwned).
 * Each is recorded at its public seam by a wrapper that calls the real
 * function (partial mocks of iframe.ts, zero-start.ts and the start ledger),
 * and only inside the action a row traces.
 *
 * engine.ts's two youtube:set-volume emitters (audio:set-volume and
 * audio:apply-youtube-volume) are the real listeners, captured as engine.ts
 * registers them and put back after each setup clears the bus; without an
 * audio graph their applyMasterVolume returns at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../audio/engine.ts';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initProtocol } from '../../network/protocol.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS as BARRIER_MS } from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState, setYtPrimed } from '../_state.ts';
import { isYouTubeStartRecoveryActive } from '../start-ownership.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer, FakeYtPlayerCall } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardRigOptions,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

/** The open trace, if any: its lines and how it adds the iframe commands logged since its last line. */
const audioTrace = vi.hoisted(() => {
  const trace = {
    open: null as { lines: string[]; flush: () => void; stamp: () => string } | null,
    note(line: string): void {
      const open = trace.open;
      if (!open) return;
      open.flush();
      open.lines.push(`${open.stamp()}${line}`);
    },
    push(owner: string, update: { muted?: boolean; volume?: number }): void {
      const parts: string[] = [];
      if (update.muted !== undefined) parts.push(`muted:${update.muted}`);
      if (update.volume !== undefined) parts.push(`volume:${update.volume}`);
      trace.note(`push ${owner} ${parts.join(' ')}`);
    },
  };
  return trace;
});

/** engine.ts's listeners of the two events that send youtube:set-volume. */
const engineVolume = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; listener: unknown }>,
}));

vi.mock('../../audio/engine.ts', async (importOriginal) => {
  const { bus: eventBus } = await import('../../core/events.ts');
  const on = vi.spyOn(eventBus, 'on');
  try {
    return await importOriginal<typeof import('../../audio/engine.ts')>();
  } finally {
    for (const [event, listener] of on.mock.calls) {
      if (event === 'audio:set-volume' || event === 'audio:apply-youtube-volume') {
        engineVolume.listeners.push({ event, listener });
      }
    }
    on.mockRestore();
  }
});
vi.mock('../iframe.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../iframe.ts')>();
  return {
    ...actual,
    isRetainedYouTubePlayerParked: (
      player: Parameters<typeof actual.isRetainedYouTubePlayerParked>[0],
    ) => {
      const parked = actual.isRetainedYouTubePlayerParked(player);
      audioTrace.note(`parked? ${parked}`);
      return parked;
    },
    ensureRetainedYouTubePlayerHardMuted: (
      player: Parameters<typeof actual.ensureRetainedYouTubePlayerHardMuted>[0],
    ) => {
      audioTrace.note('parking proof');
      return actual.ensureRetainedYouTubePlayerHardMuted(player);
    },
    updateProYouTubeAuthorityDesiredAudioState: (
      update: Parameters<typeof actual.updateProYouTubeAuthorityDesiredAudioState>[0],
    ) => {
      audioTrace.push('pro', update);
      actual.updateProYouTubeAuthorityDesiredAudioState(update);
    },
  };
});
vi.mock('../zero-start.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zero-start.ts')>();
  return {
    ...actual,
    updateYouTubeZeroStartDesiredAudioState: (
      update: Parameters<typeof actual.updateYouTubeZeroStartDesiredAudioState>[0],
    ) => {
      audioTrace.push('zero-start', update);
      actual.updateYouTubeZeroStartDesiredAudioState(update);
    },
  };
});
vi.mock('../start-ownership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../start-ownership.ts')>();
  return {
    ...actual,
    isYouTubeStartHardMuteOwned: () => {
      const held = actual.isYouTubeStartHardMuteOwned();
      audioTrace.note(`start hold? ${held}`);
      return held;
    },
  };
});
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
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
}));
// A calibrated PRO server clock that reads this device's own time.
vi.mock('../../pro-room/network-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pro-room/network-bridge.ts')>();
  const snapshot = () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: performance.now(),
    roundId: 1,
    source: 'ready' as const,
  });
  return {
    ...actual,
    getProRoomServerNow: () => Date.now(),
    isProRoomServerClockCalibrated: () => true,
    captureProRoomServerClockSnapshot: () => snapshot(),
    isProRoomClockSnapshotCurrent: () => true,
    acquireProRoomServerClock: async (options: {
      serverDeadlineAtMs?: number;
      signal?: AbortSignal;
    }) =>
      !options.signal?.aborted && Date.now() <= (options.serverDeadlineAtMs ?? Infinity)
        ? snapshot()
        : null,
  };
});

const IDENTITY = {
  queueItemId: '73000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'audioOrder1',
  nextQueueItemId: '73000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'audioOrder2',
};
const SCENARIOS = standardScenarios(IDENTITY);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 8,
  queueItemId: '73000000-0000-4000-8000-000000000003' as QueueItemId,
  videoId: 'audioOrderP',
  transitionId: `transition_${'h'.repeat(22)}`,
});

const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 2, 0, 0, 0));
let rig: StandardRig | null = null;

function setUpWorld(): void {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  // As at App startup, engine.ts listens before initYouTube does.
  wireEngineVolumeListeners();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  registerProPlaybackMediaEndpoint(null);
  audioTrace.open = null;
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
}

function tearDownWorld(): void {
  audioTrace.open = null;
  rig?.dispose();
  rig = null;
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  // Also drops a PRO pause gate a row left held.
  stopYouTubeMode({ silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  bus.clear();
  resetState();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete window.onYouTubeIframeAPIReady;
}

beforeEach(setUpWorld);
afterEach(tearDownWorld);

// ─── Rigs ──────────────────────────────────────────────────────────

async function startRig(
  role: 'host' | 'guest',
  extra: Partial<StandardRigOptions> = {},
): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...extra,
  });
  return rig;
}

/** A Standard host with no start owner holding, at +100 ms. */
async function idleHost(masterVolume = 1): Promise<StandardRig> {
  const current = await startRig('host', { masterVolume });
  await current.advanceTo(100);
  return current;
}

/** A Standard host whose zero-start warm-up holds the hard mute (+200 ms, play at +100). */
async function warmingHost(): Promise<StandardRig> {
  const current = await startRig('host');
  await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 200 });
  return current;
}

/** A Standard host whose primed iframe stopYouTubeMode has parked on the silent prime video. */
async function parkedHost(): Promise<StandardRig> {
  const current = await startRig('host');
  setYtPrimed(true);
  await current.advanceTo(100);
  stopYouTubeMode();
  await current.advanceTo(200);
  return current;
}

/** The start-ownership table's PRO participant: a resident iframe ready and paused at 0:00. */
async function setUpPro(masterVolume = 1) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  initPlayback();
  initYouTube();
  initPlaylist();
  initProtocol();
  setState('room.context', {
    kind: 'pro',
    roomId: PRO.identity.roomCode,
    role: 'member',
    coordinatorId: null,
    epoch: PRO.identity.roomEpoch,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('setup.sessionStarted', true);
  setState('audio.masterVolume', masterVolume);
  setState('playlist.items', [
    {
      queueItemId: PRO.identity.queueItemId,
      type: 'youtube',
      name: 'Synthetic video',
      videoId: PRO.identity.videoId,
      playlistId: null,
    },
  ]);
  const api = installScriptedIframeApi();
  const fake = await loadResidentIframe(api, {
    queueItemId: PRO.identity.queueItemId,
    videoId: PRO.identity.videoId,
    positionSeconds: 0,
  });
  return { fake, t0: Date.now(), participant: PRO.createParticipant() };
}

// ─── Traces ────────────────────────────────────────────────────────

function formatOp({ op, args }: FakeYtPlayerCall): string {
  const shown = (args ?? []).map((arg) =>
    typeof arg === 'number' ? String(Math.round(arg * 1_000) / 1_000) : String(arg),
  );
  return `${op}(${shown.join(',')})`;
}

/** Opens a trace of `fake`; instants are '+<ms since origin> ' when origin is given. */
function openTrace(fake: FakeYtPlayer, origin: number | null): () => string[] {
  const lines: string[] = [];
  let cursor = fake.__log.length;
  const stampAt = (at: number) => (origin === null ? '' : `+${at - origin} `);
  const flush = () => {
    for (; cursor < fake.__log.length; cursor += 1) {
      const call = fake.__log[cursor]!;
      lines.push(`${stampAt(call.at)}${formatOp(call)}`);
    }
  };
  audioTrace.open = { lines, flush, stamp: () => stampAt(Date.now()) };
  return () => {
    flush();
    audioTrace.open = null;
    return lines;
  };
}

/** The trace of one synchronous action. */
function traceOf(fake: FakeYtPlayer, act: () => void): string[] {
  const close = openTrace(fake, null);
  try {
    act();
  } finally {
    audioTrace.open = null;
  }
  return close();
}

/** The trace of an action that runs over fake time, each line at its instant. */
async function traceDuring(
  fake: FakeYtPlayer,
  origin: number,
  act: () => Promise<void>,
): Promise<string[]> {
  const close = openTrace(fake, origin);
  try {
    await act();
  } finally {
    audioTrace.open = null;
  }
  return close();
}

// ─── Events ────────────────────────────────────────────────────────

function pausePending(token: number, kind: 'pause' | 'play' | 'seek' = 'pause'): void {
  bus.emit('pro-playback:ui-control-pending', {
    token,
    kind,
    queueItemId: null,
    targetSeconds: 0,
    wasPlaying: true,
  });
}

function pauseSettled(token: number, kind: 'pause' | 'play' | 'seek' = 'pause'): void {
  bus.emit('pro-playback:ui-control-settled', {
    token,
    kind,
    queueItemId: null,
    status: 'applied',
    positionSeconds: 0,
  });
}

/** Make the iframe's next setVolume() throw after it is logged (one call only). */
function throwOnNextSetVolume(fake: FakeYtPlayer): void {
  const setVolume = fake.setVolume;
  fake.setVolume = (volume: number) => {
    fake.setVolume = setVolume;
    fake.__log.push({ op: 'setVolume', args: [volume], at: Date.now() });
    throw new Error('synthetic setVolume fault');
  };
}

/** The iframe's audio commands and plays in [fromMs, toMs) since origin, from fromIndex of its log. */
function audioOps(
  fake: FakeYtPlayer,
  origin: number,
  fromMs: number,
  toMs: number,
  fromIndex = 0,
): string[] {
  return fake.__log
    .slice(fromIndex)
    .filter(
      ({ op, at }) =>
        (op === 'setVolume' || op === 'mute' || op === 'unMute' || op === 'playVideo') &&
        at - origin >= fromMs &&
        at - origin < toMs,
    )
    .map((call) => `+${call.at - origin} ${formatOp(call)}`);
}

/** Put engine.ts's own youtube:set-volume emitters back on the cleared bus. */
function wireEngineVolumeListeners(): void {
  for (const { event, listener } of engineVolume.listeners) {
    bus.on(event as 'audio:set-volume', listener as (volume: number) => void);
  }
}

// ─── Rows ──────────────────────────────────────────────────────────

describe('the App iframe audio writes and holds, in order (pinned 2026-11-02)', () => {
  it('O1 a youtube:set-volume event pushes to both start machines, writes setVolume, then unMute, or mute at 0', async () => {
    const fake = (await idleHost()).iframe();
    expect({
      at40: traceOf(fake, () => bus.emit('youtube:set-volume', 40)),
      at0: traceOf(fake, () => bus.emit('youtube:set-volume', 0)),
      rounded: traceOf(fake, () => bus.emit('youtube:set-volume', 63.4)),
      clamped: traceOf(fake, () => bus.emit('youtube:set-volume', 150)),
      notFinite: traceOf(fake, () => bus.emit('youtube:set-volume', Number.NaN)),
    }).toEqual(O1_ROWS);
  });

  it('O2 a held PRO pause gate turns the unMute of a youtube:set-volume write into mute', async () => {
    const fake = (await idleHost()).iframe();
    pausePending(702);
    expect(traceOf(fake, () => bus.emit('youtube:set-volume', 40))).toEqual([
      'push zero-start muted:false volume:40',
      'push pro muted:true volume:40',
      'setVolume(40)',
      'parked? false',
      'mute()',
    ]);
  });

  it('O3 a parked iframe takes the volume, then the verified hard mute, never unMute', async () => {
    const fake = (await parkedHost()).iframe();
    expect({
      at40: traceOf(fake, () => bus.emit('youtube:set-volume', 40)),
      at0: traceOf(fake, () => bus.emit('youtube:set-volume', 0)),
    }).toEqual(O3_ROWS);
  });

  it('O4 a start owner holding the hard mute keeps the volume and holds only the unMute', async () => {
    const warming = (await warmingHost()).iframe();
    const zeroStart = traceOf(warming, () => bus.emit('youtube:set-volume', 40));
    tearDownWorld();
    setUpWorld();
    const recovering = await startRig('guest');
    await runStandardScenario(recovering, {
      ...SCENARIOS.guestCohortExcluded(60_000),
      endAt: 3_000,
    });
    const recovery = traceOf(recovering.iframe(), () => bus.emit('youtube:set-volume', 40));
    tearDownWorld();
    setUpWorld();
    const { fake, participant } = await setUpPro();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    const proArm = traceOf(fake, () => bus.emit('youtube:set-volume', 40));
    const held = [
      'push zero-start muted:false volume:40',
      'push pro muted:false volume:40',
      'setVolume(40)',
      'parked? false',
      'start hold? true',
    ];
    expect({ zeroStart, recovery, proArm }).toEqual({
      zeroStart: held,
      recovery: held,
      proArm: held,
    });
  });

  it('O5 without an iframe, or with one whose handshake has not completed, only the pushes apply', async () => {
    initPlayback();
    initYouTube();
    const none = {
      lines: [] as string[],
      fake: { __log: [] } as unknown as FakeYtPlayer,
    };
    none.lines = [
      ...traceOf(none.fake, () => bus.emit('youtube:set-volume', 40)),
      ...traceOf(none.fake, () => pausePending(705)),
      ...traceOf(none.fake, () => pauseSettled(705)),
    ];
    setState('playlist.items', [
      {
        queueItemId: IDENTITY.queueItemId,
        type: 'youtube',
        name: 'Synthetic video',
        videoId: IDENTITY.videoId,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', IDENTITY.queueItemId);
    const api = installScriptedIframeApi();
    bus.emit('youtube:load', IDENTITY.videoId, null, IDENTITY.queueItemId, false, 0);
    const facade = api.iframes.at(-1)!.fake;
    expect({
      none: none.lines,
      facade: traceOf(facade, () => bus.emit('youtube:set-volume', 40)),
    }).toEqual(O5_ROWS);
  });

  it('O6 a PRO pause gate opening holds its token, pushes muted, then mutes at once, whatever holds', async () => {
    const free = traceOf((await idleHost()).iframe(), () => pausePending(761));
    tearDownWorld();
    setUpWorld();
    const parked = traceOf((await parkedHost()).iframe(), () => pausePending(762));
    tearDownWorld();
    setUpWorld();
    const held = traceOf((await warmingHost()).iframe(), () => pausePending(763));
    tearDownWorld();
    setUpWorld();
    const fake = (await idleHost()).iframe();
    const otherKinds = traceOf(fake, () => {
      pausePending(764, 'play');
      pausePending(765, 'seek');
    });
    const volumeAfter = traceOf(fake, () => bus.emit('youtube:set-volume', 40));
    expect({ free, parked, held, otherKinds, volumeAfter }).toEqual(O6_ROWS);
  });

  it('O7 the matching settlement releases the gate and writes the app audio through the holds', async () => {
    const parkedFake = (await parkedHost()).iframe();
    pausePending(771);
    const parked = traceOf(parkedFake, () => pauseSettled(771));
    tearDownWorld();
    setUpWorld();
    const freeFake = (await idleHost(0.734)).iframe();
    pausePending(772);
    const free = traceOf(freeFake, () => pauseSettled(772));
    tearDownWorld();
    setUpWorld();
    const heldFake = (await warmingHost()).iframe();
    pausePending(773);
    const held = traceOf(heldFake, () => pauseSettled(773));
    tearDownWorld();
    setUpWorld();
    const silentFake = (await idleHost(0)).iframe();
    pausePending(774);
    const atZero = traceOf(silentFake, () => pauseSettled(774));
    tearDownWorld();
    setUpWorld();
    const fake = (await idleHost()).iframe();
    pausePending(776);
    const others = traceOf(fake, () => {
      pauseSettled(775);
      pauseSettled(776, 'seek');
      pauseSettled(776, 'play');
    });
    const stillGated = traceOf(fake, () => bus.emit('youtube:set-volume', 40));
    const matching = traceOf(fake, () => pauseSettled(776));
    const again = traceOf(fake, () => pauseSettled(776));
    expect({ parked, free, held, atZero, others, stillGated, matching, again }).toEqual(O7_ROWS);
  });

  it('O8 the PRO direct commit writes the app audio as asked, the gate muting it, and asks no other hold', async () => {
    const commit = async (masterVolume: number, gateToken: number | null) => {
      const { fake, t0, participant } = await setUpPro(masterVolume);
      if (gateToken !== null) pausePending(gateToken);
      const lines = await traceDuring(fake, t0, async () => {
        participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'scheduled-control', null));
        await vi.advanceTimersByTimeAsync(1_500);
      });
      tearDownWorld();
      setUpWorld();
      return lines;
    };
    expect({
      free: await commit(1, null),
      gated: await commit(1, 781),
      atZero: await commit(0, null),
    }).toEqual(O8_ROWS);
  });

  it('O9 a youtube:set-volume write whose setVolume throws has already pushed the desired audio, which the restore writes', async () => {
    const standard = await warmingHost();
    throwOnNextSetVolume(standard.iframe());
    const standardWrite = traceOf(standard.iframe(), () => bus.emit('youtube:set-volume', 40));
    await standard.advanceTo(1_500);
    const standardRestore = audioOps(standard.iframe(), standard.t0, 500, 1_500);
    tearDownWorld();
    setUpWorld();
    const { fake, t0, participant } = await setUpPro();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    throwOnNextSetVolume(fake);
    const proWrite = traceOf(fake, () => bus.emit('youtube:set-volume', 40));
    await vi.advanceTimersByTimeAsync(900);
    const proRestore = audioOps(fake, t0, 400, 1_000);
    expect({ standardWrite, standardRestore, proWrite, proRestore }).toEqual(O9_ROWS);
  });

  it('O10 stopYouTubeMode drops a held PRO pause gate, so its late settlement writes nothing', async () => {
    const current = await startRig('host');
    setYtPrimed(true);
    await current.advanceTo(100);
    pausePending(791);
    stopYouTubeMode();
    await current.advanceTo(200);
    expect(traceOf(current.iframe(), () => pauseSettled(791))).toEqual([]);
  });
});

describe('two mute rules below 0.5 % master volume, as today (pinned 2026-11-02)', () => {
  /**
   * Each cell runs on its own fresh App device at this master volume. The
   * 'rounded' rule mutes when the master volume rounds to 0 %; the
   * 'non-positive' rule mutes only at 0. They differ only for
   * 0 < masterVolume < 0.005.
   */
  async function cell<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } finally {
      tearDownWorld();
      setUpWorld();
    }
  }

  async function standardStart(role: 'host' | 'guest', masterVolume: number) {
    const current = await startRig(role, { masterVolume });
    const scenario = role === 'host' ? SCENARIOS.hostAllReady : SCENARIOS.guestAllReady;
    await runStandardScenario(current, { ...scenario, endAt: 2_000 });
    return audioOps(current.iframe(), current.t0, 500, 2_000);
  }

  async function standardRecovery(scenario: StandardScenario, masterVolume: number) {
    const current = await startRig(scenario.role, { masterVolume, ...scenario.rig });
    await runStandardScenario(current, { ...scenario, endAt: 4_000 });
    return audioOps(current.iframe(), current.t0, 300, 4_000);
  }

  it.each([0, 0.004, 0.005] as const)('at master volume %s', async (masterVolume) => {
    const hostZeroStart = await cell(() => standardStart('host', masterVolume));
    const guestZeroStart = await cell(() => standardStart('guest', masterVolume));
    const proPrepare = await cell(async () => {
      const { fake, t0, participant } = await setUpPro(masterVolume);
      const ready: string[] = [];
      participant.reportReady.mockImplementation(async (report: { status: string }) => {
        ready.push(`+${Date.now() - t0} ${report.status} muted:${fake.__muted}`);
        return 'waiting';
      });
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
      await vi.advanceTimersByTimeAsync(BARRIER_MS);
      return { ready, ops: audioOps(fake, t0, 400, BARRIER_MS) };
    });
    const engineBridge = await cell(async () => {
      const fake = (await idleHost()).iframe();
      return traceOf(fake, () => bus.emit('audio:set-volume', masterVolume));
    });
    const gateSettlement = await cell(async () => {
      const fake = (await idleHost(masterVolume)).iframe();
      pausePending(801);
      return traceOf(fake, () => pauseSettled(801));
    });
    const directCommit = await cell(async () => {
      const { fake, t0, participant } = await setUpPro(masterVolume);
      const from = fake.__log.length;
      participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'scheduled-control', null));
      await vi.advanceTimersByTimeAsync(1_500);
      return audioOps(fake, t0, 0, 1_500, from);
    });
    const replacementRecovery = await cell(() =>
      standardRecovery(SCENARIOS.hostPeerReplaced, masterVolume),
    );
    const hostLegacyRecovery = await cell(() =>
      standardRecovery(SCENARIOS.hostPrepareFailure, masterVolume),
    );
    const guestRecovery = await cell(() =>
      standardRecovery(SCENARIOS.guestCohortExcluded(2_600), masterVolume),
    );
    expect({
      hostZeroStart,
      guestZeroStart,
      proPrepare,
      engineBridge,
      gateSettlement,
      directCommit,
      replacementRecovery,
      hostLegacyRecovery,
      guestRecovery,
    }).toEqual(TWO_RULE_ROWS[masterVolume]);
  });
});

describe('a remote host PREPARE during a guest local recovery, below 0.5 % master volume (pinned 2026-11-03)', () => {
  /**
   * The guest's next-track load reports the new track only 9 s after it is
   * issued, so the remote host commits without this guest at +2401 and the
   * guest's local recovery waits on that load. The remote host then starts
   * the first occurrence again (still the guest's resident video) at one of
   * two instants, and each cell runs on its own fresh App device:
   * - abortFirst (+3000): the remote host's own run is still inside its
   *   timeline window, so it sends ABORT before the PREPARE. The ABORT ends
   *   the guest recovery without a hand-over (its cleanup and the cancelled
   *   run's restore write the run's audio), and the new run captures its own
   *   desired audio;
   * - transferred (+6000): the remote host's run has left that window, so the
   *   PREPARE comes alone. The new run takes over the recovery's iframe and
   *   player.ts pushes the app audio into it as the run turns busy (the
   *   transferred intent).
   * A cell lists the zero-start frames the App receives, its iframe's audio
   * commands, plays and the desired audio pushed into the zero-start machine,
   * and the muted value of its ARMED, from the instant the remote host starts
   * for 1.4 s.
   */
  const WINDOW_MS = 1_400;

  async function prepareDuringRecovery(masterVolume: number, at: number) {
    try {
      const scenario = SCENARIOS.guestCohortExcluded(9_000);
      const current = await startRig('guest', { masterVolume });
      const inbound: string[] = [];
      bus.on('network:data', (data) => {
        const type = String((data as { type?: unknown } | null)?.type);
        const ms = current.now();
        if (type.startsWith('youtube-zero-start-') && ms >= at && ms < at + WINDOW_MS) {
          inbound.push(`+${ms} ${type.slice('youtube-zero-start-'.length)}`);
        }
      });
      let recovery: boolean | null = null;
      const restart = {
        at,
        run: (started: StandardRig) => {
          recovery = isYouTubeStartRecoveryActive();
          const begun = started.remote.beginHostTransition({
            queueItemId: IDENTITY.queueItemId,
            videoId: IDENTITY.videoId,
            subIndex: null,
          });
          if (!begun) throw new Error('the remote host could not start again');
        },
      };
      const lines = await traceDuring(current.iframe(), current.t0, async () => {
        await runStandardScenario(current, {
          ...scenario,
          steps: [...scenario.steps, restart],
          endAt: at + WINDOW_MS,
        });
      });
      const ops = lines.filter((line) => {
        const ms = Number(line.slice(1, line.indexOf(' ')));
        return ms >= at && /^\+\d+ (push |setVolume\(|mute\(|unMute\(|playVideo\()/.test(line);
      });
      const armed = current.sent
        .filter(({ type, at: sentAt }) => type === MSG.YOUTUBE_ZERO_START_ARMED && sentAt >= at)
        .map(({ at: sentAt, frame }) => `+${sentAt} muted:${String(frame.muted)}`);
      return { recovery, inbound, ops, armed };
    } finally {
      tearDownWorld();
      setUpWorld();
    }
  }

  it.each([0, 0.004, 0.005] as const)('at master volume %s', async (masterVolume) => {
    const abortFirst = await prepareDuringRecovery(masterVolume, 3_000);
    const transferred = await prepareDuringRecovery(masterVolume, 6_000);
    expect({ abortFirst, transferred }).toEqual(RECOVERY_PREPARE_ROWS[masterVolume]);
  });
});

describe('Phase 7 contract (a): one youtube:set-volume per engine volume event, written once (pinned 2026-11-02)', () => {
  /**
   * The whole trace of one youtube:set-volume write of `percent` on an idle
   * host, as O1 pins it: no other iframe command, push or hold question.
   */
  const idleWrite = (percent: number): string[] => [
    `push zero-start muted:${percent === 0} volume:${percent}`,
    `push pro muted:${percent === 0} volume:${percent}`,
    `setVolume(${percent})`,
    'parked? false',
    ...(percent === 0 ? ['mute()'] : ['start hold? false', 'unMute()']),
  ];

  it.each([0, 0.004, 0.005, 0.734, 1] as const)(
    'at master volume %s, audio:set-volume and audio:apply-youtube-volume each send Math.round(v * 100) once',
    async (masterVolume) => {
      const fake = (await idleHost()).iframe();
      const sent: number[] = [];
      bus.on('youtube:set-volume', (volume) => {
        sent.push(volume);
      });
      const onSet = traceOf(fake, () => bus.emit('audio:set-volume', masterVolume));
      const sentOnSet = sent.splice(0);
      const onApply = traceOf(fake, () => bus.emit('audio:apply-youtube-volume'));
      const percent = Math.round(masterVolume * 100);
      expect({
        listeners: engineVolume.listeners.map(({ event }) => event),
        sentOnSet,
        onSet,
        sentOnApply: sent,
        onApply,
      }).toEqual({
        listeners: ['audio:set-volume', 'audio:apply-youtube-volume'],
        sentOnSet: [percent],
        onSet: idleWrite(percent),
        sentOnApply: [percent],
        onApply: idleWrite(percent),
      });
    },
  );

  it('an engine volume event reaches a held start owner and a parked iframe only through the holds', async () => {
    const warming = traceOf((await warmingHost()).iframe(), () =>
      bus.emit('audio:set-volume', 0.4),
    );
    tearDownWorld();
    setUpWorld();
    const parked = traceOf((await parkedHost()).iframe(), () => bus.emit('audio:set-volume', 0.4));
    expect({ warming, parked }).toEqual({
      // The zero-start warm-up holds the unMute: no unMute and no other write.
      warming: [
        'push zero-start muted:false volume:40',
        'push pro muted:false volume:40',
        'setVolume(40)',
        'parked? false',
        'start hold? true',
      ],
      // The parked iframe gets the verified hard mute, never unMute.
      parked: [
        'push zero-start muted:false volume:40',
        'push pro muted:false volume:40',
        'setVolume(40)',
        'parked? true',
        'parking proof',
        'mute()',
      ],
    });
  });
});

// ─── Expected traces (today's values) ──────────────────────────────

const UNMUTED_40 = [
  'push zero-start muted:false volume:40',
  'push pro muted:false volume:40',
  'setVolume(40)',
  'parked? false',
  'start hold? false',
  'unMute()',
];

const O1_ROWS = {
  at40: UNMUTED_40,
  at0: [
    'push zero-start muted:true volume:0',
    'push pro muted:true volume:0',
    'setVolume(0)',
    'parked? false',
    'mute()',
  ],
  rounded: [
    'push zero-start muted:false volume:63',
    'push pro muted:false volume:63',
    'setVolume(63)',
    'parked? false',
    'start hold? false',
    'unMute()',
  ],
  clamped: [
    'push zero-start muted:false volume:100',
    'push pro muted:false volume:100',
    'setVolume(100)',
    'parked? false',
    'start hold? false',
    'unMute()',
  ],
  notFinite: [],
};

const O3_ROWS = {
  at40: [
    'push zero-start muted:false volume:40',
    'push pro muted:false volume:40',
    'setVolume(40)',
    'parked? true',
    'parking proof',
    'mute()',
  ],
  at0: [
    'push zero-start muted:true volume:0',
    'push pro muted:true volume:0',
    'setVolume(0)',
    'parked? true',
    'parking proof',
    'mute()',
  ],
};

const O5_ROWS = {
  none: [
    'push zero-start muted:false volume:40',
    'push pro muted:false volume:40',
    'push pro muted:true',
    'push pro muted:false volume:100',
  ],
  facade: ['push zero-start muted:false volume:40', 'push pro muted:false volume:40'],
};

const O6_ROWS = {
  free: ['push pro muted:true', 'mute()'],
  parked: ['push pro muted:true', 'mute()'],
  held: ['push pro muted:true', 'mute()'],
  otherKinds: [],
  volumeAfter: UNMUTED_40,
};

const O7_ROWS = {
  parked: ['push pro muted:false volume:100', 'parked? true', 'parking proof', 'mute()'],
  free: [
    'push pro muted:false volume:73',
    'parked? false',
    'setVolume(73)',
    'start hold? false',
    'unMute()',
  ],
  held: ['push pro muted:false volume:100', 'parked? false', 'setVolume(100)', 'start hold? true'],
  atZero: ['push pro muted:true volume:0', 'parked? false', 'setVolume(0)', 'mute()'],
  others: [],
  stillGated: [
    'push zero-start muted:false volume:40',
    'push pro muted:true volume:40',
    'setVolume(40)',
    'parked? false',
    'mute()',
  ],
  matching: [
    'push pro muted:false volume:100',
    'parked? false',
    'setVolume(100)',
    'start hold? false',
    'unMute()',
  ],
  again: [],
};

const O8_ROWS = {
  free: ['+700 seekTo(0,true)', '+700 setVolume(100)', '+700 unMute()', '+700 playVideo()'],
  gated: ['+700 seekTo(0,true)', '+700 setVolume(100)', '+700 mute()', '+700 playVideo()'],
  atZero: ['+700 seekTo(0,true)', '+700 setVolume(0)', '+700 mute()', '+700 playVideo()'],
};

const O9_ROWS = {
  standardWrite: [
    'push zero-start muted:false volume:40',
    'push pro muted:false volume:40',
    'setVolume(40)',
  ],
  standardRestore: ['+600 setVolume(40)', '+600 unMute()', '+1422 playVideo()', '+1422 unMute()'],
  proWrite: [
    'push zero-start muted:false volume:40',
    'push pro muted:false volume:40',
    'setVolume(40)',
  ],
  proRestore: ['+500 setVolume(40)', '+500 unMute()'],
};

/**
 * The host run's hard-mute polls inside the recovery rows' window in
 * SCENARIOS.hostPrepareFailure, which the iframe never confirms, before its
 * legacy recovery takes the start at +481.
 */
const HOST_HARD_MUTE_POLLS = [
  '+310 mute()',
  '+340 mute()',
  '+370 mute()',
  '+400 mute()',
  '+431 mute()',
] as const;

/** setVolume(0), then mute(), at every instant from fromMs to toMs, stepMs apart. */
function mutedWritesEvery(fromMs: number, toMs: number, stepMs: number): string[] {
  const lines: string[] = [];
  for (let at = fromMs; at <= toMs; at += stepMs) {
    lines.push(`+${at} setVolume(0)`, `+${at} mute()`);
  }
  return lines;
}

/**
 * At 0 both rules mute and at 0.005 (1 %) both unmute. At 0.004 the volume is
 * 0 % everywhere, and:
 * - the 'non-positive' rule unmutes: the Standard zero-start run's desired
 *   audio, which its restores, its release unmute, its cancel restore and
 *   both recoveries' intents take when the run captured it: the guest local
 *   recovery and a host's legacy recovery after its own run fails (the
 *   restore at +600 or +601 and the release unMute at +1422, the restore
 *   when a peer replacement cancels the host's run at +400, the host's
 *   legacy recovery at +481 and the guest local recovery at +3100); and the
 *   PRO prepare's (its restore at +500, READY at 620 unmuted);
 * - the 'rounded' rule mutes: a youtube:set-volume write (here from
 *   engine.ts's audio:set-volume), the PRO pause gate's settlement, the PRO
 *   direct commit and the replacement fallback's own recovery intent (+1951),
 *   which has no run audio to take.
 * The host's legacy recovery runs on an iframe that never confirms a mute
 * (its run's prepare failed on that): at 0 its restore before the release
 * writes the muted audio every 50 ms until its 3 s deadline, then its
 * verified cleanup every 120 ms, and it never plays inside the window.
 */
const TWO_RULE_ROWS = {
  0: {
    hostZeroStart: ['+600 setVolume(0)', '+600 mute()', '+1422 playVideo()'],
    guestZeroStart: ['+601 setVolume(0)', '+601 mute()', '+1422 playVideo()'],
    proPrepare: { ready: ['+620 ready muted:true'], ops: ['+500 setVolume(0)', '+500 mute()'] },
    engineBridge: [
      'push zero-start muted:true volume:0',
      'push pro muted:true volume:0',
      'setVolume(0)',
      'parked? false',
      'mute()',
    ],
    gateSettlement: ['push pro muted:true volume:0', 'parked? false', 'setVolume(0)', 'mute()'],
    directCommit: ['+700 setVolume(0)', '+700 mute()', '+700 playVideo()'],
    replacementRecovery: [
      '+400 setVolume(0)',
      '+400 mute()',
      '+1901 mute()',
      '+1951 setVolume(0)',
      '+1951 mute()',
      '+1951 playVideo()',
    ],
    hostLegacyRecovery: [
      ...HOST_HARD_MUTE_POLLS,
      ...mutedWritesEvery(481, 3_431, 50),
      ...mutedWritesEvery(3_551, 3_911, 120),
    ],
    guestRecovery: [
      '+2752 mute()',
      '+3100 setVolume(0)',
      '+3100 mute()',
      '+3100 setVolume(0)',
      '+3100 mute()',
      '+3100 playVideo()',
    ],
  },
  0.004: {
    hostZeroStart: ['+600 setVolume(0)', '+600 unMute()', '+1422 playVideo()', '+1422 unMute()'],
    guestZeroStart: ['+601 setVolume(0)', '+601 unMute()', '+1422 playVideo()', '+1422 unMute()'],
    proPrepare: { ready: ['+620 ready muted:false'], ops: ['+500 setVolume(0)', '+500 unMute()'] },
    engineBridge: [
      'push zero-start muted:true volume:0',
      'push pro muted:true volume:0',
      'setVolume(0)',
      'parked? false',
      'mute()',
    ],
    gateSettlement: ['push pro muted:true volume:0', 'parked? false', 'setVolume(0)', 'mute()'],
    directCommit: ['+700 setVolume(0)', '+700 mute()', '+700 playVideo()'],
    replacementRecovery: [
      '+400 setVolume(0)',
      '+400 unMute()',
      '+1901 mute()',
      '+1951 setVolume(0)',
      '+1951 mute()',
      '+1951 playVideo()',
    ],
    hostLegacyRecovery: [
      ...HOST_HARD_MUTE_POLLS,
      '+481 setVolume(0)',
      '+481 unMute()',
      '+481 playVideo()',
    ],
    guestRecovery: [
      '+2752 mute()',
      '+3100 setVolume(0)',
      '+3100 unMute()',
      '+3100 setVolume(0)',
      '+3100 unMute()',
      '+3100 playVideo()',
    ],
  },
  0.005: {
    hostZeroStart: ['+600 setVolume(1)', '+600 unMute()', '+1422 playVideo()', '+1422 unMute()'],
    guestZeroStart: ['+601 setVolume(1)', '+601 unMute()', '+1422 playVideo()', '+1422 unMute()'],
    proPrepare: { ready: ['+620 ready muted:false'], ops: ['+500 setVolume(1)', '+500 unMute()'] },
    engineBridge: [
      'push zero-start muted:false volume:1',
      'push pro muted:false volume:1',
      'setVolume(1)',
      'parked? false',
      'start hold? false',
      'unMute()',
    ],
    gateSettlement: [
      'push pro muted:false volume:1',
      'parked? false',
      'setVolume(1)',
      'start hold? false',
      'unMute()',
    ],
    directCommit: ['+700 setVolume(1)', '+700 unMute()', '+700 playVideo()'],
    replacementRecovery: [
      '+400 setVolume(1)',
      '+400 unMute()',
      '+1901 mute()',
      '+1951 setVolume(1)',
      '+1951 unMute()',
      '+1951 playVideo()',
    ],
    hostLegacyRecovery: [
      ...HOST_HARD_MUTE_POLLS,
      '+481 setVolume(1)',
      '+481 unMute()',
      '+481 playVideo()',
    ],
    guestRecovery: [
      '+2752 mute()',
      '+3100 setVolume(1)',
      '+3100 unMute()',
      '+3100 setVolume(1)',
      '+3100 unMute()',
      '+3100 playVideo()',
    ],
  },
} as const;

/**
 * A remote host PREPARE during the guest local recovery of
 * SCENARIOS.guestCohortExcluded(9_000), at +3000 and at +6000.
 * - abortFirst: the ABORT's cleanup and the cancelled run's restore write the
 *   audio the recovery took from its run (+3000), and the new run's restore
 *   (+3501) and release (+4322) its own capture: today the 'non-positive'
 *   rule, so 0.004 unmutes and its ARMED reports muted false;
 * - transferred: no ABORT, no cleanup; the new run takes the transferred
 *   intent ('push zero-start' at +6000) as it turns busy: today the
 *   'rounded' rule, so 0.004 mutes, like 0, and reports muted true.
 * The new run hard-mutes (+3000 or +6000), warms the resident video (+3001
 * or +6001), restores, reports ARMED, and plays at the remote host's commit.
 */
const RECOVERY_PREPARE_ROWS = {
  0: {
    abortFirst: {
      recovery: true,
      inbound: ['+3000 abort', '+3000 prepare', '+3623 commit'],
      ops: [
        '+3000 setVolume(0)',
        '+3000 mute()',
        '+3000 setVolume(0)',
        '+3000 mute()',
        '+3000 mute()',
        '+3001 setVolume(0)',
        '+3001 mute()',
        '+3001 playVideo()',
        '+3501 setVolume(0)',
        '+3501 mute()',
        '+4322 playVideo()',
      ],
      armed: ['+3621 muted:true'],
    },
    transferred: {
      recovery: true,
      inbound: ['+6000 prepare', '+6623 commit'],
      ops: [
        '+6000 push zero-start muted:true volume:0',
        '+6000 mute()',
        '+6001 setVolume(0)',
        '+6001 mute()',
        '+6001 playVideo()',
        '+6501 setVolume(0)',
        '+6501 mute()',
        '+7322 playVideo()',
      ],
      armed: ['+6621 muted:true'],
    },
  },
  0.004: {
    abortFirst: {
      recovery: true,
      inbound: ['+3000 abort', '+3000 prepare', '+3623 commit'],
      ops: [
        '+3000 setVolume(0)',
        '+3000 unMute()',
        '+3000 setVolume(0)',
        '+3000 unMute()',
        '+3000 mute()',
        '+3001 setVolume(0)',
        '+3001 mute()',
        '+3001 playVideo()',
        '+3501 setVolume(0)',
        '+3501 unMute()',
        '+4322 playVideo()',
        '+4322 unMute()',
      ],
      armed: ['+3621 muted:false'],
    },
    transferred: {
      recovery: true,
      inbound: ['+6000 prepare', '+6623 commit'],
      ops: [
        '+6000 push zero-start muted:true volume:0',
        '+6000 mute()',
        '+6001 setVolume(0)',
        '+6001 mute()',
        '+6001 playVideo()',
        '+6501 setVolume(0)',
        '+6501 mute()',
        '+7322 playVideo()',
      ],
      armed: ['+6621 muted:true'],
    },
  },
  0.005: {
    abortFirst: {
      recovery: true,
      inbound: ['+3000 abort', '+3000 prepare', '+3623 commit'],
      ops: [
        '+3000 setVolume(1)',
        '+3000 unMute()',
        '+3000 setVolume(1)',
        '+3000 unMute()',
        '+3000 mute()',
        '+3001 setVolume(1)',
        '+3001 mute()',
        '+3001 playVideo()',
        '+3501 setVolume(1)',
        '+3501 unMute()',
        '+4322 playVideo()',
        '+4322 unMute()',
      ],
      armed: ['+3621 muted:false'],
    },
    transferred: {
      recovery: true,
      inbound: ['+6000 prepare', '+6623 commit'],
      ops: [
        '+6000 push zero-start muted:false volume:1',
        '+6000 mute()',
        '+6001 setVolume(1)',
        '+6001 mute()',
        '+6001 playVideo()',
        '+6501 setVolume(1)',
        '+6501 unMute()',
        '+7322 playVideo()',
        '+7322 unMute()',
      ],
      armed: ['+6621 muted:false'],
    },
  },
} as const;
