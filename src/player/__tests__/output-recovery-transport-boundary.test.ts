/**
 * @vitest-environment jsdom
 */
/**
 * The local-file PLAY's foreground clock check and the background output
 * inspection, over the real AudioContext owners (RO-01, structural plan
 * C1-I7; Phase 7 T2).
 *
 * transport.ts, context.ts, context-recovery.ts and output-health.ts are real
 * and share one FakeNativeAudioContext as the singleton. Only transport's
 * external seams are mocked, as in concurrency-invariants.test.ts, without its
 * context.ts factory. A foreground incident is armed the way the page arms
 * one: the engine's context binding and a hidden -> visible return.
 * Observations are public: PLAY, retry and inspection results, the sources
 * PLAY starts, the fake's op log and the bus. Harness (its harness part only):
 * src/audio/__tests__/__helpers__/audio-output-owners.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_CLOCK_SAMPLE_MS } from '../../audio/context-protocol.ts';
import { FakeNativeAudioContext } from '../../audio/__tests__/__helpers__/fake-audio-context.ts';
import {
  QUEUE_A,
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

/** The native calls a frozen clock's restart or recovery makes to park the context. */
const ONE_SUSPEND = ['suspend()', 'statechange:suspended', 'suspend:resolved'];

const STALE = {
  status: 'stale',
  reason: 'superseded',
  rejoinRequired: false,
  rejoinEmitted: false,
  isCurrent: null,
  isPlaybackCurrent: null,
};

/**
 * Transform transport's and output health's module graphs once per file, from
 * a beforeAll with its own time budget; the listeners that evaluation adds
 * are removed, and every row still evaluates a fresh graph.
 */
async function warmGraphs(): Promise<void> {
  const targets = [document, window] as EventTarget[];
  const spies = targets.map((target) => vi.spyOn(target, 'addEventListener'));
  try {
    await import('../transport.ts');
    await import('../../audio/output-health.ts');
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

interface FileRoom {
  readonly fake: FakeNativeAudioContext;
  readonly o: Owners;
  readonly transport: typeof import('../transport.ts');
  readonly health: typeof import('../../audio/output-health.ts');
  readonly bus: BusRecord;
  /** Every audio:output-recovery-needed request, as published. */
  readonly requests: RecoveryRequest[];
  readonly sources: () => number;
}

/**
 * A started session with a decoded local file, paused (ready for PLAY) or
 * playing, over the engine's binding of the shared context.
 */
async function openFile(activity: 'paused' | 'playing'): Promise<FileRoom> {
  const fake = new FakeNativeAudioContext();
  const sources = countSources(fake);
  const o = await loadOwners(fake);
  const transport = await import('../transport.ts');
  const health = await import('../../audio/output-health.ts');
  stageFile(o);
  if (activity === 'paused') {
    o.ownership.setPlaybackFilePaused();
    o.setState('playback.lifecycle', o.PLAYBACK_STATE.READY);
  }
  const bus = recordBus(o);
  const requests: RecoveryRequest[] = [];
  o.bus.on('audio:output-recovery-needed', (request) => {
    requests.push(request);
  });
  bind(o, fake);
  return { fake, o, transport, health, bus, requests, sources };
}

/** The page goes to the background and comes back; the binding arms one foreground incident. */
async function returnToForeground(hiddenMs = 1_000): Promise<void> {
  setVisibility('hidden');
  await vi.advanceTimersByTimeAsync(hiddenMs);
  setVisibility('visible');
  await vi.advanceTimersByTimeAsync(0);
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

describe('the local-file PLAY clock check after a foreground return (real owners)', () => {
  it('checks and consumes the one foreground clock incident before starting a file source', async () => {
    const { fake, transport, bus, sources } = await openFile('paused');
    await returnToForeground();
    const before = fake.ops.length;

    // The PLAY samples the clock of the incident the return armed before it
    // starts the source, with no native call (the context is running).
    const first = track(transport.play(4));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(first.settled()).toBe(false);
    expect(sources()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first.promise).resolves.toBe(true);
    expect(sources()).toBe(1);

    // The healthy sample consumed that one incident: the next PLAY starts at
    // once, even on a frozen clock, because nothing is left to check.
    transport.pause(4, { showToast: false });
    fake.freezeClock();
    const second = transport.play(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(true);
    expect(sources()).toBe(2);

    expect(fake.ops.slice(before)).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
  });

  it('prepares a frozen foreground clock and retries only after its exact gesture token', async () => {
    const { fake, o, transport, bus, requests, sources } = await openFile('paused');
    const buffer = o.playerState.getCurrentAudioBuffer();
    await returnToForeground();
    fake.freezeClock();
    const before = fake.ops.length;

    const started = transport.play(5);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(started).resolves.toBe(false);

    // Two frozen samples: the owner parks the context with one native
    // suspend, and PLAY announces exactly one request carrying its restart.
    expect(fake.ops.slice(before)).toEqual(ONE_SUSPEND);
    expect(fake.state).toBe('suspended');
    expect(bus.needed).toEqual(['play:clock-stalled']);
    const request = requests[0]!;
    const attemptToken = request.foregroundRestartAttemptToken!;
    expect(request.queueItemId).toBe(QUEUE_A);
    expect(attemptToken).toEqual(expect.any(Object));
    expect(request.isCurrent?.()).toBe(true);
    expect(sources()).toBe(0);
    expect(o.playerState.getPlayerNode()).toBeNull();
    // Nothing to confirm before the tap resumes the parked context.
    expect(request.confirmForegroundRestart?.(attemptToken)).toBe(false);

    // The dialog's tap. Its production caller is app.ts, which unit tests
    // cannot load, and a raw resume of the parked context is an outside
    // resume that the attempt does not take as its tap; until the owner
    // function of Phase 7 7C-2 this one sub-step stands in for the tap. When
    // 7C-4 withdraws the export it rewrites this stand-in together with the
    // clock probe and the confirm checks below, which that owner function
    // then makes itself.
    await o.context.resumePreparedForegroundAudioContextRestartFromGesture(attemptToken);
    expect(fake.ops.slice(before)).toEqual([
      ...ONE_SUSPEND,
      'resume()',
      'statechange:running',
      'resume:resolved',
    ]);
    // The dialog's own clock probe after the tap (app.ts) passes on a clock
    // that runs again.
    fake.runClock();

    expect(request.confirmForegroundRestart?.({})).toBe(false);
    expect(request.confirmForegroundRestart?.(attemptToken)).toBe(true);
    expect(request.confirmForegroundRestart?.(attemptToken)).toBe(false);
    expect(request.isCurrent?.()).toBe(true);

    const retry = request.retry!();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retry).resolves.toBe(true);
    expect(sources()).toBe(1);
    expect(o.playerState.getPlayerNode()?.buffer).toBe(buffer);
    await expect(request.retry!()).resolves.toBe(false);
    expect(sources()).toBe(1);

    // One suspend, one resume, one request, no rejoin.
    expect(fake.ops.slice(before)).toEqual([
      ...ONE_SUSPEND,
      'resume()',
      'statechange:running',
      'resume:resolved',
    ]);
    expect(bus.needed).toEqual(['play:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
  });

  it('does not block PLAY on an inconclusive foreground clock sample', async () => {
    const { fake, transport, bus, sources } = await openFile('paused');
    await returnToForeground();
    const before = fake.ops.length;

    // An early timer: the sample's timeout fires while the wall clock has not
    // moved, which proves nothing about the native clock (context.ts).
    const wall = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    const first = track(transport.play(6));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(first.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first.promise).resolves.toBe(true);
    wall.mockRestore();
    expect(sources()).toBe(1);
    expect(fake.ops.slice(before)).toEqual([]);
    expect(bus.needed).toEqual([]);

    // The incident was kept for a later PLAY: with conclusive samples, the
    // next PLAY checks it and finds the frozen clock.
    transport.pause(6, { showToast: false });
    fake.freezeClock();
    const second = transport.play(6);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(false);
    expect(sources()).toBe(1);
    expect(fake.ops.slice(before)).toEqual(ONE_SUSPEND);
    expect(bus.needed).toEqual(['play:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
  });
});

describe('the background output inspection beside these owners (real owners)', () => {
  it('requests gesture recovery for a frozen demo clock with one native suspend', async () => {
    const { fake, o, health, bus } = await openFile('playing');
    o.setState('demo.active', true);
    o.setState('demo.currentTrackIndex', 0);
    o.setState('playlist.currentQueueItemId', null);
    o.setState('files.current', null);
    fake.freezeClock();

    // One clock check (its two frozen samples), then the playback scope parks
    // the context once for the gesture; the caller (app.ts) publishes the
    // request.
    const inspection = track(health.inspectBackgroundFileOutput());
    await vi.advanceTimersByTimeAsync(2 * AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(inspection.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(inspection.settled()).toBe(true);
    await expect(inspection.promise).resolves.toEqual({
      status: 'needs-gesture',
      reason: 'clock-stalled',
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: null,
      isPlaybackCurrent: null,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.ops).toEqual(ONE_SUSPEND);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);

    // That one attempt waits for the gesture: an outside resume of the parked
    // context, its clock running again, is parked again and announced rather
    // than taken as a recovery.
    fake.runClock();
    fake.transition('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.ops).toEqual([...ONE_SUSPEND, 'os:running', 'statechange:running', ...ONE_SUSPEND]);
    expect(fake.state).toBe('suspended');
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
  });

  it('defers without a native call while a play-request restart owns the context', async () => {
    const { fake, transport, health, bus, requests } = await openFile('playing');
    await returnToForeground();
    fake.freezeClock();
    const play = transport.play(3);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(play).resolves.toBe(false);
    expect(fake.state).toBe('suspended');
    const before = fake.ops.length;

    // It answers at once, without a clock sample.
    const inspection = track(health.inspectBackgroundFileOutput());
    await vi.advanceTimersByTimeAsync(0);
    expect(inspection.settled()).toBe(true);
    await expect(inspection.promise).resolves.toEqual(STALE);
    await vi.advanceTimersByTimeAsync(1_000);

    // No resume of the parked context, no clock check, no second suspend,
    // and the restart and its request stay current for their tap.
    expect(fake.ops.slice(before)).toEqual([]);
    expect(fake.state).toBe('suspended');
    expect(requests[0]?.isCurrent?.()).toBe(true);
    expect(bus.needed).toEqual(['play:clock-stalled']);
    expect(bus.rejoins).toEqual([]);

    // Nor did it arm a playback-scope attempt of its own on that context:
    // when the OS resumes it, no second owner parks it again or asks for a
    // gesture (no dialog has taken this restart).
    fake.transition('running');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.ops.slice(before)).toEqual(['os:running', 'statechange:running']);
    expect(bus.needed).toEqual(['play:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
  });

  it('defers entirely to a semantic recovery that already owns the incident', async () => {
    const { fake, health, bus } = await openFile('playing');
    fake.planResume({ outcome: 'reject' });
    fake.transition('suspended');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state).toBe('suspended');

    // It answers at once, without a clock sample.
    const inspection = track(health.inspectBackgroundFileOutput());
    await vi.advanceTimersByTimeAsync(0);
    expect(inspection.settled()).toBe(true);
    await expect(inspection.promise).resolves.toEqual(STALE);
    await vi.advanceTimersByTimeAsync(1_000);

    // The inspection left the attempt to its owner: when the OS resumes the
    // context, the owner verifies the clock and publishes the one rejoin.
    fake.transition('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.ops).toEqual([
      'os:suspended',
      'statechange:suspended',
      'resume()',
      'resume:rejected',
      'os:running',
      'statechange:running',
    ]);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(bus.needed).toEqual([]);
  });

  it('does not adopt a semantic recovery that appears during its foreground probe', async () => {
    const { fake, health, bus } = await openFile('playing');

    const inspection = track(health.inspectBackgroundFileOutput());
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    // An OS interruption inside the inspection's clock sample; the playback
    // scope resumes it at once and verifies the clock itself.
    fake.transition('suspended');
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2 - 1);
    expect(inspection.settled()).toBe(false);
    // One sample: the inspection ends while the owner's own check still runs.
    await vi.advanceTimersByTimeAsync(1);
    expect(inspection.settled()).toBe(true);
    await expect(inspection.promise).resolves.toEqual(STALE);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fake.ops).toEqual([
      'os:suspended',
      'statechange:suspended',
      'resume()',
      'statechange:running',
      'resume:resolved',
    ]);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(bus.needed).toEqual([]);
  });

  it('consumes one pre-armed foreground incident without requesting a healthy rejoin', async () => {
    const { fake, transport, health, bus, sources } = await openFile('paused');
    const started = transport.play(3);
    await vi.advanceTimersByTimeAsync(0);
    await expect(started).resolves.toBe(true);
    // Ten seconds away with the clock running all the while.
    await returnToForeground(10_000);

    // One clock sample.
    const inspection = track(health.inspectBackgroundFileOutput());
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(inspection.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(inspection.settled()).toBe(true);
    await expect(inspection.promise).resolves.toEqual({
      status: 'healthy',
      reason: 'healthy',
      rejoinRequired: false,
      rejoinEmitted: false,
      isCurrent: expect.any(Function),
      isPlaybackCurrent: expect.any(Function),
    });

    // The inspection consumed the incident: the next PLAY starts at once,
    // even on a frozen clock, because nothing is left to check.
    transport.pause(3, { showToast: false });
    fake.freezeClock();
    const again = transport.play(3);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(again).resolves.toBe(true);
    expect(sources()).toBe(2);
    expect(fake.ops).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
  });

  it('drops its clock sample when a newer foreground incident replaces the one it checks', async () => {
    const { fake, transport, health, bus, sources } = await openFile('paused');
    const started = transport.play(3);
    await vi.advanceTimersByTimeAsync(0);
    await expect(started).resolves.toBe(true);
    await returnToForeground(10_000);

    // The page is hidden and visible again inside the inspection's clock
    // sample: the binding arms a newer incident, so the sample no longer
    // speaks for the incident the inspection read, even on a running clock.
    const inspection = health.inspectBackgroundFileOutput();
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(inspection).resolves.toEqual(STALE);
    expect(fake.ops).toEqual([]);

    // The newer incident is left to the next PLAY, which finds the frozen
    // clock: one native suspend and one request.
    transport.pause(3, { showToast: false });
    fake.freezeClock();
    const again = transport.play(3);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(again).resolves.toBe(false);
    expect(sources()).toBe(1);
    expect(fake.ops).toEqual(ONE_SUSPEND);
    expect(bus.needed).toEqual(['play:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
  });
});
