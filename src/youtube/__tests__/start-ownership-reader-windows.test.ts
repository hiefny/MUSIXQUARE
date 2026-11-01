/**
 * @vitest-environment jsdom
 *
 * The start-ownership readers where two derived queries differ, pinned
 * 2026-11-01 (Phase 6 6B, tests only): what each reader does today in the
 * window that separates them, so a reader moved to the wrong ledger query
 * fails a row.
 *
 * The window is a Standard guest's timeline calibration. The real zero-start
 * run (guest all-ready scenario of standard-start-harness.ts, room 000001)
 * releases PLAYING about 1.42 s after the rig's t0 and stays protocol-active
 * until about 4.18 s, so there isYouTubeStartSyncOwned holds while
 * isYouTubeStartTimelineHeld and isYouTubeStartArmBusy do not. The rows act
 * at 2 s:
 * - the guest heartbeat hold (sync.ts, isYouTubeStartTimelineHeld) lets a host
 *   heartbeat through;
 * - the guest auxiliary YOUTUBE_STATE hold (sync.ts, isYouTubeStartTimelineHeld)
 *   lets the frame through, and the guest state action it makes is not current
 *   (isCurrentStateAction, isYouTubeStartSyncOwned), so the iframe is left alone;
 * - a manual-offset apply is retired without a rendezvous or a toast
 *   (isCurrentManualOffsetApply, isYouTubeStartSyncOwned);
 * - the manual-sync panel is unavailable (canUseManualSyncPanelRuntime,
 *   isYouTubeStartSyncOwned), and available again once the window ends.
 * The delayed rendezvous steps' check (matchesRendezvousOccurrence) has no row:
 * in this window its follow-up asks isYouTubeStartSyncOwned again through
 * guestRendezvousSync, which also refuses to begin a rendezvous, and no row
 * carries a rendezvous begun before the run into the window.
 *
 * Real: initYouTube's wiring, the iframe state dispatch behind a scripted
 * IFrame API, core/timers, the protocol dispatcher and both zero-start
 * controllers. Fakes at the edges only: the iframes, the network sends, the
 * shared clock (calibrated, reading Date.now()), log and toasts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { isPlaybackModeYouTube } from '../../player/ownership.ts';
import type { QueueItemId } from '../../types/index.ts';
import { canUseManualSyncPanelRuntime } from '../../ui/manual-sync-overlay-runtime.ts';
import { showToast } from '../../ui/toast.ts';
import { stopYouTubeMode } from '../player.ts';
import { getYtAutoplayIntent, resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import { isYouTubeZeroStartInFlight, isYouTubeZeroStartProtocolActive } from '../zero-start.ts';
import {
  appZeroStartPhase,
  createFakeClockStarter,
  opTrace,
  setUpStandardRig,
  standardScenarios,
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
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
}));

/** A synthetic room code; the App device is the guest, so no coordinator check reads it. */
const ROOM_CODE = '000001';
const HOST_PEER_ID = 'host-1';
const GUEST_PEER_ID = 'guest-1';
const IDENTITY = {
  queueItemId: '70000000-0000-4000-8000-000000000011' as QueueItemId,
  videoId: 'readerWin01',
  nextQueueItemId: '70000000-0000-4000-8000-000000000012' as QueueItemId,
  nextVideoId: 'readerWin02',
};
const SCENARIO = standardScenarios(IDENTITY).guestAllReady;
/** Inside the calibration window: the run released PLAYING at +1422 ms and is protocol-active until +4180 ms. */
const IN_WINDOW_MS = 2_000;
const AFTER_WINDOW_MS = 4_500;

let rig: StandardRig | null = null;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 1, 0, 0, 0));

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  rig?.dispose();
  rig = null;
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
});

/** Start the guest all-ready run and advance into its calibration window. */
async function enterCalibrationWindow(): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role: SCENARIO.role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: ROOM_CODE,
    ...IDENTITY,
    hostPeerId: HOST_PEER_ID,
    guestPeerId: GUEST_PEER_ID,
  });
  const current = rig;
  for (const step of SCENARIO.steps) {
    await current.advanceTo(step.at);
    step.run(current);
  }
  await current.advanceTo(IN_WINDOW_MS);
  return current;
}

/** A host frame the protocol dispatcher accepts, for the current occurrence. */
function hostFrame(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type,
    queueItemId: IDENTITY.queueItemId,
    videoId: IDENTITY.videoId,
    time: 0.6,
    hostClock: Date.now(),
    ...fields,
  };
}

function trackTitle(): string | undefined {
  return (getState('player.currentTrackMeta') as { title?: string } | null)?.title;
}

describe('start-ownership readers in a Standard guest calibration window (pinned 2026-11-01)', () => {
  it('is the window that separates the derived queries: protocol-active, not in flight', async () => {
    await enterCalibrationWindow();
    // No recovery runs in this scenario, so the ledger's sync-owned query
    // answers from the protocol and its timeline and arm queries from the run
    // in flight (the run's own facades, read here as the T0b tables do).
    expect({
      phase: appZeroStartPhase(),
      protocolActive: isYouTubeZeroStartProtocolActive(),
      inFlight: isYouTubeZeroStartInFlight(),
      youtube: isPlaybackModeYouTube(),
    }).toEqual({ phase: 'playing', protocolActive: true, inFlight: false, youtube: true });
  });

  it('lets a host heartbeat through the guest heartbeat hold', async () => {
    const current = await enterCalibrationWindow();
    expect(getYtAutoplayIntent()).toBe(true);
    // A heartbeat that reports the host paused clears the guest's autoplay
    // intent right after the hold.
    current.deliver(hostFrame(MSG.YOUTUBE_SYNC, { state: 2, isManual: false }));
    expect(getYtAutoplayIntent()).toBe(false);
  });

  it('lets an auxiliary host state through, and its state action leaves the iframe alone', async () => {
    const current = await enterCalibrationWindow();
    const opsBefore = current.iframe().__log.length;
    // Raw host iframe feedback: PLAYING without hostPlayAt is not a transport action.
    current.deliver(hostFrame(MSG.YOUTUBE_STATE, { state: 1, title: 'Synthetic retitled' }));
    expect(trackTitle()).toBe('Synthetic retitled');
    await current.advanceTo(IN_WINDOW_MS + 500);
    expect(opTrace(current.iframe(), current.t0, opsBefore)).toEqual([]);
    expect(isYouTubeZeroStartProtocolActive()).toBe(true);
  });

  it('retires a manual-offset apply without a rendezvous or a toast', async () => {
    const current = await enterCalibrationWindow();
    const opsBefore = current.iframe().__log.length;
    // The load's effects notice is not this row's.
    vi.mocked(showToast).mockClear();
    bus.emit('youtube:apply-manual-sync');
    await current.advanceTo(IN_WINDOW_MS + 500);
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
    expect(opTrace(current.iframe(), current.t0, opsBefore)).toEqual([]);
  });

  it('keeps the manual-sync panel unavailable until the window ends', async () => {
    const current = await enterCalibrationWindow();
    expect(canUseManualSyncPanelRuntime()).toBe(false);
    await current.advanceTo(AFTER_WINDOW_MS);
    expect({
      phase: appZeroStartPhase(),
      protocolActive: isYouTubeZeroStartProtocolActive(),
    }).toEqual({ phase: 'idle', protocolActive: false });
    expect(canUseManualSyncPanelRuntime()).toBe(true);
  });
});
