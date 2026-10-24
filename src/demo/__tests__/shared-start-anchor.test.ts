/**
 * @vitest-environment jsdom
 *
 * Shared-start anchor investigation: the guided demo against the queue.
 *
 * A Standard host keeps two records of a pending shared start: the queue's
 * canonical anchor in player/transport.ts (getStandardHostPendingFileStartAt)
 * and the demo's published start in demo/host-start-anchor.ts. The late-join
 * SYNC_PONG reads one of them by demo.active, DEMO_PLAY carries the demo one,
 * and the queue bootstrap PLAY reads the queue one. This file checks, with the
 * real modules, whether the two records can make those frames disagree.
 *
 * Real: demo/mode.ts, transport.ts, decode.ts, playback.ts (late-join
 * bootstrap), network/sync.ts (SYNC_PING) and the protocol dispatcher. Fakes
 * sit at the edges only: the AudioContext and its nodes, the audio engine and
 * effect chain, the network send, the demo download, storage and the demo
 * page chrome.
 *
 * Tests named "expected today" characterize what the owner decision P4-D9 A
 * (2026-10-24, investigate first) asked to establish. They pass on today's
 * code on purpose; a later anchor change updates them in the same change.
 *
 * Not established here (inferred, not measured): how far apart the two
 * records are in real use. They come from different clocks (the wall clock
 * at the source start against the audio-clock lead remaining at publish) and
 * agree below only because the fake clocks are frozen. Nor whether the queue
 * canonical timeline governing the demo host's position is a defect or
 * intended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  broadcast: vi.fn((_frame: unknown) => undefined),
  safeSend: vi.fn((_conn: unknown, _frame: unknown) => true),
  ensureRunning: vi.fn(),
  getCurrentTime: vi.fn(() => 100),
  decodeAudioData: vi.fn(),
  createBufferSource: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../audio/context.ts', () => ({
  ensureRunning: edges.ensureRunning,
  getCurrentTime: edges.getCurrentTime,
  getPendingForegroundAudioContextClockHealthCheck: vi.fn(() => null),
  probeAudioContextHealth: vi.fn(),
  consumeForegroundAudioContextClockHealthCheck: vi.fn(),
  confirmForegroundAudioContextRestartHealth: vi.fn(() => true),
  prepareForegroundAudioContextRestart: vi.fn(),
  getAudioContext: vi.fn(() => ({
    state: 'running',
    currentTime: 0,
    decodeAudioData: edges.decodeAudioData,
    createBufferSource: edges.createBufferSource,
  })),
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => undefined),
  getFilePlaybackDestination: vi.fn(() => null),
  getWidener: vi.fn(() => null),
  getSurroundSplitter: vi.fn(() => null),
}));
vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: vi.fn(() => false),
  stopSystemAudioCapture: vi.fn(),
}));
vi.mock('../../audio/effects.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audio/effects.ts')>();
  return {
    getAppliedRoomEffectsAuthority: actual.getAppliedRoomEffectsAuthority,
    applySettingsAsync: vi.fn(),
    syncRoomEffectsUI: vi.fn(),
  };
});
vi.mock('../../network/peer.ts', () => ({
  broadcast: edges.broadcast,
  safeSend: edges.safeSend,
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
  waitForGuestConnectionType: vi.fn(async () => 'local' as const),
}));
// The host is the room clock: its host time is its own wall clock.
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  isClockCalibrated: () => true,
}));
vi.mock('../../storage/storage.ts', () => ({
  admitIncomingStoredFile: vi.fn(),
  postCommand: vi.fn(),
  cleanupStoredFile: vi.fn(),
  discardResidentStoredFileAdmission: vi.fn(() => false),
  promoteStoredFileAdmission: vi.fn(() => false),
  readStoredFile: vi.fn(async () => null),
  retainStoredFileAdmission: vi.fn(() => false),
}));
vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
  unicastFile: vi.fn(),
  cancelOutgoingFileTransfers: vi.fn(),
}));
vi.mock('../../storage/preload.ts', () => ({
  schedulePreload: vi.fn(),
  unicastPreload: vi.fn(),
}));
vi.mock('../../storage/recovery.ts', () => ({ sendRecoveryRequest: vi.fn() }));
vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: vi.fn(async () => undefined),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => false),
}));
vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: vi.fn(),
  broadcastSystemMessage: vi.fn(),
}));
vi.mock('../../player/video.ts', () => ({ setEngineMode: vi.fn() }));
vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../../ui/setup-shared.ts', () => ({ hideSetupOverlay: vi.fn() }));
vi.mock('../../ui/dom.ts', () => ({
  beginBackSurfaceTransition: vi.fn(() => vi.fn()),
  updateOverlayOpenClass: vi.fn(),
  animateTransition: vi.fn((fn: () => void) => fn()),
}));
vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { initSync } from '../../network/sync.ts';
import { setCurrentAudioBuffer, setPlayerNode, setPlayLocked } from '../../player/_state.ts';
import { initPlayback } from '../../player/playback.ts';
import { getStandardHostPendingFileStartAt } from '../../player/transport.ts';
import type { DataConnection, PlaylistItem, QueueItemId } from '../../types/index.ts';
import { getPendingDemoHostStartAt } from '../host-start-anchor.ts';

/** Manually resolved stand-in for the demo track download. */
class FakeXHR {
  static pending: FakeXHR[] = [];
  status = 200;
  response: Blob = new Blob(['demo-bytes']);
  responseType = '';
  timeout = 0;
  onprogress: ((event: unknown) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    FakeXHR.pending.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
}

const QUEUE_ITEM_ID = '77777777-7777-4777-8777-777777777777' as QueueItemId;
/** The demo starts at fake time 10,001 ms; guests make the host lead by 200 ms. */
const SHARED_START_AT = 10_201;

function connection(peer: string, send = vi.fn()): DataConnection {
  return { open: true, peer, send, close: vi.fn(), on: () => undefined } as DataConnection;
}

let guest: DataConnection;

function fakeSourceNode() {
  return {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    onended: null,
  };
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** An active Standard room host with one connected guest. */
async function installHost({ selectQueueItem }: { selectQueueItem: boolean }): Promise<void> {
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-1',
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'file',
      name: 'queue.mp3',
      title: 'queue.mp3',
      videoId: null,
      playlistId: null,
    } as PlaylistItem,
  ]);
  // The host had a queue item selected before entering the demo.
  if (selectQueueItem) setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('network.activeHostConnByPeerId', new Map([[guest.peer, guest]]));
  setState('network.connectedPeers', [
    {
      id: guest.peer,
      slot: 1,
      label: 'Guest',
      conn: guest,
      isOp: false,
      preloadedQueueItemIds: new Set<QueueItemId>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    },
  ]);
  initSync();
  initPlayback();
  const { initDemoMode } = await import('../mode.ts');
  initDemoMode();
}

/** Enter the demo from the Demo button; its first track starts with the lead. */
async function startDemo(options: { selectQueueItem: boolean }): Promise<void> {
  await installHost(options);
  bus.emit('demo:enter');
  await vi.advanceTimersByTimeAsync(1);
  FakeXHR.pending[0]!.onload?.();
  await vi.advanceTimersByTimeAsync(0);
}

function demoPlayFrames(): Record<string, unknown>[] {
  return edges.broadcast.mock.calls
    .map(([frame]) => frame as Record<string, unknown>)
    .filter((frame) => frame.type === MSG.DEMO_PLAY);
}

let nextPingId = 1;

/** One late-join clock probe from the connected guest; returns the host's reply. */
async function syncPong(): Promise<Record<string, unknown>> {
  const pingId = nextPingId++;
  await handleData({ type: MSG.SYNC_PING, pingId }, guest);
  const reply = vi
    .mocked(guest.send)
    .mock.calls.map(([frame]) => frame as Record<string, unknown>)
    .find((frame) => frame.type === MSG.SYNC_PONG && frame.pingId === pingId);
  if (!reply) throw new Error(`no SYNC_PONG for ping ${pingId}`);
  return reply;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  setPlayLocked(false);
  edges.ensureRunning.mockResolvedValue(undefined);
  edges.getCurrentTime.mockReturnValue(100);
  edges.decodeAudioData.mockResolvedValue({ duration: 120 } as AudioBuffer);
  edges.createBufferSource.mockImplementation(() => fakeSourceNode());
  guest = connection('anchor-guest');
  FakeXHR.pending = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  // jsdom has no matchMedia; the demo layout falls back to it.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:shared-start-anchor'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  setVisibility('visible');
  delete document.body.dataset.demoBound;
  document.body.innerHTML = '';
});

afterEach(() => {
  bus.emit('demo:authority-reset');
  setCurrentAudioBuffer(null);
  resetInboundRateLimit(guest.peer);
  clearAllManagedTimers();
  setVisibility('visible');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('P4-D9: the demo and queue shared-start anchors', () => {
  it.each([{ selectQueueItem: true }, { selectQueueItem: false }])(
    'expected today: DEMO_PLAY, SYNC_PONG and a late-join bootstrap carry one demo start (queue item selected: $selectQueueItem)',
    async ({ selectQueueItem }) => {
      await startDemo({ selectQueueItem });

      const [demoPlay, ...extra] = demoPlayFrames();
      expect(extra).toEqual([]);
      const demoStartAt = demoPlay?.hostStartAt;
      expect(demoStartAt).toBeCloseTo(SHARED_START_AT, 6);
      expect(getPendingDemoHostStartAt()).toBe(demoStartAt);

      // The late-join PONG reads the demo record, never the queue one.
      const pong = await syncPong();
      expect(pong).toMatchObject({ queueItemId: null, demoTrackIndex: 0 });
      expect(pong.hostStartAt).toBe(demoStartAt);

      // A guest connecting during the lead gets the demo bootstrap with the
      // same start; the queue bootstrap PLAY stays silent in the demo.
      const send = vi.fn();
      const newcomer = connection('anchor-newcomer', send);
      bus.emit('network:peer-connected', newcomer);
      const bootstrap = edges.safeSend.mock.calls
        .filter(([conn]) => conn === newcomer)
        .map(([, frame]) => frame as Record<string, unknown>);
      expect(bootstrap.map((frame) => frame.type)).toEqual([MSG.DEMO_ENTER, MSG.DEMO_PLAY]);
      expect(bootstrap[1]?.hostStartAt).toBe(demoStartAt);
      const directTypes = send.mock.calls.map(([frame]) => (frame as { type?: unknown }).type);
      expect(directTypes).not.toContain(MSG.PLAY);
      expect(directTypes).not.toContain(MSG.PAUSE);
    },
  );

  it('reads the demo record, not the queue one, when the two records differ', async () => {
    // The audio clock moves 50 ms between the source start (the queue anchor
    // is armed from the wall clock there) and the DEMO_PLAY publish (which
    // reads the audio-clock lead remaining); the frozen wall clock does not.
    // Whole milliseconds apart, the records tell which one each frame reads.
    let advanced = false;
    bus.on('visualizer:start', () => {
      if (advanced) return;
      advanced = true;
      edges.getCurrentTime.mockReturnValue(100.05);
    });
    await startDemo({ selectQueueItem: true });

    const demoStartAt = getPendingDemoHostStartAt();
    expect(getStandardHostPendingFileStartAt()).toBe(SHARED_START_AT);
    expect(demoStartAt).toBeCloseTo(SHARED_START_AT - 50, 6);
    expect(demoPlayFrames().map((frame) => frame.hostStartAt)).toEqual([demoStartAt]);
    expect((await syncPong()).hostStartAt).toBe(demoStartAt);

    const newcomer = connection('anchor-newcomer');
    bus.emit('network:peer-connected', newcomer);
    const bootstrap = edges.safeSend.mock.calls
      .filter(([conn]) => conn === newcomer)
      .map(([, frame]) => frame as Record<string, unknown>);
    expect(bootstrap.map((frame) => [frame.type, frame.hostStartAt])).toEqual([
      [MSG.DEMO_ENTER, undefined],
      [MSG.DEMO_PLAY, demoStartAt],
    ]);
  });

  it.each([
    { selectQueueItem: true, queueStartAt: SHARED_START_AT },
    { selectQueueItem: false, queueStartAt: undefined },
  ])(
    'expected today: demo playback arms the queue anchor only when a queue item was selected ($selectQueueItem)',
    async ({ selectQueueItem, queueStartAt }) => {
      await startDemo({ selectQueueItem });

      // The demo neither clears the selected queue occurrence nor owns a
      // resident file, so transport arms the queue canonical anchor against
      // the demo buffer. That record is computed separately (wall clock at
      // the source start) from the demo record (audio-clock lead remaining
      // at publish); with frozen fake clocks the two agree within 1e-6 ms.
      // Their real-world gap is inferred, not measured.
      expect(getState('demo.active')).toBe(true);
      expect(getState('files.current')).toBeNull();
      expect(getState('playlist.currentQueueItemId')).toBe(selectQueueItem ? QUEUE_ITEM_ID : null);
      expect(getStandardHostPendingFileStartAt()).toBe(queueStartAt);
      expect(getPendingDemoHostStartAt()).toBeCloseTo(SHARED_START_AT, 6);
    },
  );

  it.each(['the lead elapsing', 'a demo pause', 'a track advance', 'exit'] as const)(
    'carries no host start in either record or the PONG after %s',
    async (transition) => {
      await startDemo({ selectQueueItem: true });
      expect(getStandardHostPendingFileStartAt()).toBe(SHARED_START_AT);

      if (transition === 'the lead elapsing') {
        edges.getCurrentTime.mockReturnValue(100.3);
        await vi.advanceTimersByTimeAsync(300);
      } else if (transition === 'a demo pause') {
        bus.emit('demo:toggle-play');
      } else if (transition === 'a track advance') {
        bus.emit('demo:next-track');
      } else {
        bus.emit('demo:request-exit');
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(getPendingDemoHostStartAt()).toBeUndefined();
      expect(getStandardHostPendingFileStartAt()).toBeUndefined();
      expect(await syncPong()).not.toHaveProperty('hostStartAt');
    },
  );

  it.each([
    { selectQueueItem: true, hiddenPosition: 4.8, visiblePosition: 4.8 },
    { selectQueueItem: false, hiddenPosition: 0, visiblePosition: 2.8 },
  ])(
    'expected today: the queue canonical timeline governs the demo position when selected ($selectQueueItem)',
    async ({ selectQueueItem, hiddenPosition, visiblePosition }) => {
      await startDemo({ selectQueueItem });

      // Hidden for 5 s while the audio clock does not advance.
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(Number((await syncPong()).position)).toBeCloseTo(hiddenPosition, 6);

      // Visible again with only 3 s of audio clock behind it.
      setVisibility('visible');
      edges.getCurrentTime.mockReturnValue(103);
      expect(Number((await syncPong()).position)).toBeCloseTo(visiblePosition, 6);
      // This pins the difference only; whether the selected case is a
      // defect or intended is not established here.
    },
  );
});
