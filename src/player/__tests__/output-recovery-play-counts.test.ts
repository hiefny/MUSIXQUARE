/**
 * @vitest-environment jsdom
 */
/**
 * The `/debug sync` counts around a local-file PLAY's foreground clock check
 * (RO-01, structural plan C1-I7; Phase 7 7C-3), path by path, over the real
 * AudioContext owners: every slot before the PLAY and once the PLAY and
 * everything it started have settled, with PLAY's answer, the recovery
 * notices and the fake's native op log. The last two rows pin which currency
 * a failed PLAY reads once its restart is prepared.
 *
 * Set up as output-recovery-transport-boundary.test.ts: transport.ts,
 * context.ts and context-recovery.ts are real and share one
 * FakeNativeAudioContext as the singleton; only transport's external seams
 * are mocked, without a context.ts factory; a foreground incident is armed
 * the way the page arms one (the engine's context binding and a hidden ->
 * visible return). The counts are read through readAudioRecoveryCounts, the
 * source of the `/debug sync` lines.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CLOCK_SAMPLE_MS,
  AUDIO_SUSPEND_PREPARE_DEADLINE_MS,
} from '../../audio/context-protocol.ts';
import { FakeNativeAudioContext } from '../../audio/__tests__/__helpers__/fake-audio-context.ts';
import {
  bind,
  loadOwners,
  recordBus,
  setVisibility,
  setupOwnerTest,
  stageFile,
  teardownOwnerTest,
  type BusRecord,
  type Owners,
} from '../../audio/__tests__/__helpers__/audio-output-owners.ts';
import type { EventMap } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  safeSend: vi.fn(() => true),
  isRemoteGuest: vi.fn(() => false),
  initAudio: vi.fn(),
  sendRecoveryRequest: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
  readStoredFile: vi.fn(),
  cleanupStoredFile: vi.fn(),
  unicastFile: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: mocks.initAudio,
  getFilePlaybackDestination: vi.fn(() => null),
  getWidener: vi.fn(() => null),
  getSurroundSplitter: vi.fn(() => null),
}));

vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: vi.fn(() => false),
  stopSystemAudioCapture: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
  safeSend: mocks.safeSend,
  isRemoteGuest: mocks.isRemoteGuest,
  waitForGuestConnectionType: vi.fn(async () => 'local' as const),
}));

vi.mock('../../storage/storage.ts', () => ({
  admitIncomingStoredFile: vi.fn(),
  postCommand: vi.fn(),
  cleanupStoredFile: mocks.cleanupStoredFile,
  discardResidentStoredFileAdmission: vi.fn(() => false),
  promoteStoredFileAdmission: vi.fn(() => false),
  readStoredFile: mocks.readStoredFile,
  retainStoredFileAdmission: vi.fn(() => false),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
  unicastFile: mocks.unicastFile,
}));

vi.mock('../../storage/preload.ts', () => ({
  schedulePreload: vi.fn(),
  unicastPreload: vi.fn(),
}));

vi.mock('../../storage/recovery.ts', () => ({
  sendRecoveryRequest: mocks.sendRecoveryRequest,
}));

vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: vi.fn(async () => undefined),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => false),
}));

vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: vi.fn(),
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
  showLoader: mocks.showLoader,
  updateLoader: mocks.updateLoader,
}));

vi.mock('../video.ts', () => ({
  setEngineMode: vi.fn(),
}));

type RecoveryRequest = EventMap['audio:output-recovery-needed'][0];
type Counters = typeof import('../../audio/output-recovery-counters.ts');

/** The native calls a frozen clock's restart makes to park the context. */
const ONE_SUSPEND = ['suspend()', 'statechange:suspended', 'suspend:resolved'];
/** A frozen clock's two samples, before the restart starts. */
const TWO_SAMPLES_MS = 2 * AUDIO_CLOCK_SAMPLE_MS;
/** Long enough for every deadline a PLAY's restart starts to settle. */
const SETTLE_MS = 3_000;
/** What the restart's suspend preparation counts when its suspend lands inside the window. */
const ONE_PREPARATION = ['DEADLINES_WATCHED:2', 'SUSPEND_CALLS:1', 'LEASES_AT_ONCE_MAX:1'];

/**
 * Transform transport's module graph once per file, from a beforeAll with its
 * own time budget; the listeners that evaluation adds are removed, and every
 * row still evaluates a fresh graph.
 */
async function warmGraphs(): Promise<void> {
  const targets = [document, window] as EventTarget[];
  const spies = targets.map((target) => vi.spyOn(target, 'addEventListener'));
  try {
    await import('../transport.ts');
    await import('../../audio/output-recovery-counters.ts');
  } finally {
    targets.forEach((target, index) => {
      const spy = spies[index]!;
      for (const [type, listener, options] of spy.mock.calls) {
        target.removeEventListener(type, listener, options);
      }
      spy.mockRestore();
    });
    vi.resetModules();
  }
}

beforeAll(warmGraphs, 30_000);
beforeEach(() => {
  vi.clearAllMocks();
  setupOwnerTest();
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.safeSend.mockReturnValue(true);
  mocks.isRemoteGuest.mockReturnValue(false);
});
afterEach(teardownOwnerTest);

/**
 * Count the file sources PLAY starts on `fake`. The native double models no
 * node graph; this gives it the one node transport builds for a resident
 * buffer. `fake.ops` stays the native log.
 */
function countSources(fake: FakeNativeAudioContext): () => number {
  let started = 0;
  Object.assign(fake, {
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => {
        started += 1;
      },
      stop: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return () => started;
}

function track<T>(promise: Promise<T>): { readonly promise: Promise<T>; settled(): boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, settled: () => settled };
}

interface PlayRoom {
  readonly fake: FakeNativeAudioContext;
  readonly o: Owners;
  readonly transport: typeof import('../transport.ts');
  readonly bus: BusRecord;
  /** Every audio:output-recovery-needed request, as published. */
  readonly requests: RecoveryRequest[];
  readonly sources: () => number;
  /** The `/debug sync` slots now. */
  counts(): readonly number[];
  /** Every slot that moved since `before`, as `NAME:delta`; all slots are read. */
  moved(before: readonly number[]): string[];
}

/** A started session with a decoded local file, paused and ready for PLAY, over the engine's binding. */
async function openPausedFile(): Promise<PlayRoom> {
  const fake = new FakeNativeAudioContext();
  const sources = countSources(fake);
  const o = await loadOwners(fake);
  const transport = await import('../transport.ts');
  const counters: Counters = await import('../../audio/output-recovery-counters.ts');
  stageFile(o);
  o.ownership.setPlaybackFilePaused();
  o.setState('playback.lifecycle', o.PLAYBACK_STATE.READY);
  const bus = recordBus(o);
  const requests: RecoveryRequest[] = [];
  o.bus.on('audio:output-recovery-needed', (request) => {
    requests.push(request);
  });
  bind(o, fake);
  // Every numbered slot the module exports, by name.
  const slots: Array<readonly [name: string, slot: number]> = [];
  for (const [name, value] of Object.entries(counters)) {
    if (typeof value === 'number' && !name.startsWith('AUDIO_RECOVERY_')) slots.push([name, value]);
  }
  const counts = (): readonly number[] => counters.readAudioRecoveryCounts()[0];
  return {
    fake,
    o,
    transport,
    bus,
    requests,
    sources,
    counts,
    moved: (before) => {
      const now = counts();
      expect(slots.map(([, slot]) => slot).sort((a, b) => a - b)).toEqual(
        Array.from({ length: counters.AUDIO_RECOVERY_SLOTS }, (_, slot) => slot),
      );
      return slots
        .filter(([, slot]) => now[slot] !== before[slot])
        .map(([name, slot]) => `${name}:${now[slot]! - before[slot]!}`);
    },
  };
}

/** The page goes to the background and comes back; the binding arms one foreground incident. */
async function returnToForeground(hiddenMs = 1_000): Promise<void> {
  setVisibility('hidden');
  await vi.advanceTimersByTimeAsync(hiddenMs);
  setVisibility('visible');
  await vi.advanceTimersByTimeAsync(0);
}

describe("the /debug sync counts of a local-file PLAY's foreground clock check (real owners)", () => {
  it('counts nothing when no foreground incident is pending', async () => {
    const room = await openPausedFile();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = room.transport.play(4);
    await vi.advanceTimersByTimeAsync(0);
    await expect(started).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(1);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts nothing for a healthy clock: one sample, the incident consumed, the source started', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(4));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(started.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started.promise).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(1);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts one preparation race, one suspend and its lease for a frozen clock parked at once', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS - 1);
    expect(started.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Two frozen samples; the restart parks the context inside its window and
    // PLAY announces its one request at once.
    await expect(started.promise).resolves.toBe(false);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(ONE_SUSPEND);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    expect(room.bus.rejoins).toEqual([]);
    expect(room.requests[0]?.isCurrent?.()).toBe(true);
    expect(room.moved(before)).toEqual(ONE_PREPARATION);
  });

  it('counts the preparation deadline when the window ends first, and announces once parked', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    room.fake.planSuspend({ latencyMs: AUDIO_SUSPEND_PREPARE_DEADLINE_MS + 100 });
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + AUDIO_SUSPEND_PREPARE_DEADLINE_MS - 1);
    expect(started.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The window ended with the suspend in flight: no request yet.
    await expect(started.promise).resolves.toBe(false);
    expect(room.bus.needed).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(ONE_SUSPEND);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    expect(room.bus.rejoins).toEqual([]);
    expect(room.requests[0]?.isCurrent?.()).toBe(true);
    expect(room.moved(before)).toEqual(['DEADLINE_PLAY_REQUEST_PREPARE:1', ...ONE_PREPARATION]);
  });

  it('counts both lost suspends and announces nothing when the restart never parks', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    room.fake.planSuspend({ outcome: 'never' }, { outcome: 'never' });
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + AUDIO_SUSPEND_PREPARE_DEADLINE_MS);
    await expect(started.promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(['suspend()', 'suspend()']);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([
      'DEADLINE_PLAY_REQUEST_PREPARE:1',
      'DEADLINE_PLAY_REQUEST_WATCHDOG:2',
      'DEADLINE_LATE_SUSPEND_FENCE:2',
      'DEADLINES_WATCHED:5',
      'SUSPEND_CALLS:2',
      'SECOND_SUSPENDS:1',
      'LEASES_AT_ONCE_MAX:1',
    ]);
  });

  it('keeps the restart through a hidden and visible bounce inside its window, and announces it once parked', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    room.fake.planSuspend({ latencyMs: 300 });
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + 50);
    expect(room.fake.ops.slice(ops)).toEqual(['suspend()']);
    // The restart owns the incident: neither edge arms a newer one.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(239);
    expect(started.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started.promise).resolves.toBe(false);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(ONE_SUSPEND);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    expect(room.requests[0]?.isCurrent?.()).toBe(true);
    expect(room.moved(before)).toEqual(ONE_PREPARATION);
  });

  it('counts nothing and announces one context-not-running request when the context stops in the sample', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(6));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    room.fake.transition('suspended', { statechange: false });
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    await expect(started.promise).resolves.toBe(false);
    expect(room.bus.needed).toEqual(['play:context-not-running']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(['os:suspended', 'state:suspended']);
    expect(room.bus.needed).toEqual(['play:context-not-running']);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts nothing for an inconclusive sample, and the source starts', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    const before = room.counts();
    const ops = room.fake.ops.length;

    // An early timer: the sample's timeout fires while the wall clock has not
    // moved, which proves nothing about the native clock.
    const wall = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    const started = track(room.transport.play(6));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(started.promise).resolves.toBe(true);
    wall.mockRestore();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(1);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts nothing and announces nothing when the page is hidden as the check starts', async () => {
    const room = await openPausedFile();
    // The hidden edge arms the incident; a PLAY arrives while the page stays hidden.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1_000);
    const before = room.counts();
    const ops = room.fake.ops.length;

    // No sample is taken: the check ends at once.
    const started = track(room.transport.play(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(started.settled()).toBe(true);
    await expect(started.promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts nothing and announces nothing when a newer incident replaces the one it samples', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(7));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(started.promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });

  it('counts nothing and announces nothing when a PAUSE inside the sample makes the PLAY stale', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(7));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    room.transport.pause(7, { showToast: false });
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2 - 1);
    expect(started.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started.promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual([]);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual([]);
  });
});

describe('the currency a failed PLAY reads once its restart is prepared (real owners)', () => {
  it('announces nothing when a PAUSE makes the PLAY stale while its restart prepares', async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    room.fake.planSuspend({ latencyMs: 100 });
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + 50);
    expect(room.fake.ops.slice(ops)).toEqual(['suspend()']);
    room.transport.pause(5, { showToast: false });
    await vi.advanceTimersByTimeAsync(50);
    await expect(started.promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(ONE_SUSPEND);
    expect(room.bus.needed).toEqual([]);
    expect(room.moved(before)).toEqual(ONE_PREPARATION);
  });

  it("announces the restart when only the PLAY's output changed while it prepared, and that request is not current", async () => {
    const room = await openPausedFile();
    await returnToForeground();
    room.fake.freezeClock();
    room.fake.planSuspend({ latencyMs: 100 });
    const before = room.counts();
    const ops = room.fake.ops.length;

    const started = track(room.transport.play(5));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + 50);
    expect(room.fake.ops.slice(ops)).toEqual(['suspend()']);
    // The resident file's record is replaced for the same queue item.
    room.o.setState('files.current', { ...room.o.getState('files.current')! });
    await vi.advanceTimersByTimeAsync(50);
    await expect(started.promise).resolves.toBe(false);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    const request = room.requests[0]!;
    expect(request.isCurrent?.()).toBe(false);
    await expect(request.retry!()).resolves.toBe(false);
    expect(room.sources()).toBe(0);
    expect(room.fake.ops.slice(ops)).toEqual(ONE_SUSPEND);
    expect(room.bus.needed).toEqual(['play:clock-stalled']);
    expect(room.moved(before)).toEqual(ONE_PREPARATION);
  });
});
