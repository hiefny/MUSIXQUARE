import { describe, expect, it, vi } from 'vitest';
import {
  LegacyBoundedFileV1BridgeForTests,
  createLegacyBoundedFileV1Bridge,
  type LegacyBoundedV1BridgeSnapshot,
} from '../legacy-bounded-file-v1-bridge.ts';
import type {
  LegacyBoundedFileControlOutcome,
  LegacyBoundedFileLease,
  LegacyBoundedFilePortContract,
  LegacyBoundedFilePrepareOutcome,
  LegacyBoundedFileScope,
} from '../legacy-bounded-file-port-contract.ts';
import type { FilePlaybackSourceSnapshot } from '../file-playback-source.ts';

const Q1 = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function scope(overrides: Partial<LegacyBoundedFileScope> = {}): LegacyBoundedFileScope {
  return {
    roomEpoch: 'room-epoch-1',
    bridgeGeneration: 'bridge-generation-1',
    bindingId: 'binding-1',
    queueItemId: Q1,
    sourceIdentity: 'source-1',
    descriptorId: 'descriptor-1',
    descriptorVersion: 1,
    ...overrides,
  };
}

function applied(): LegacyBoundedFileControlOutcome {
  return { status: 'applied', snapshot: null };
}

function ready(durationSeconds = 120): LegacyBoundedFilePrepareOutcome {
  return {
    status: 'ready',
    snapshot: {
      schemaVersion: 1,
      queueItemId: Q1,
      backend: 'bounded-stream',
      phase: 'ready',
      revision: 0,
      run: null,
      durationSeconds,
      positionSeconds: 0,
      bufferedAheadSeconds: 0,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      underrunCount: 0,
      errorCode: null,
    } satisfies FilePlaybackSourceSnapshot,
  };
}

function fakePort() {
  const preparations: Array<{
    readonly lease: LegacyBoundedFileLease;
    readonly outcome: ReturnType<typeof deferred<LegacyBoundedFilePrepareOutcome>>;
  }> = [];
  let gatePreparation = false;
  let commitImpl: () => Promise<LegacyBoundedFileControlOutcome> = async () => applied();
  let pauseImpl: () => Promise<LegacyBoundedFileControlOutcome> = async () => applied();
  let seekImpl: () => Promise<LegacyBoundedFileControlOutcome> = async () => applied();
  let stopImpl: () => Promise<LegacyBoundedFileControlOutcome> = async () => applied();

  const port: LegacyBoundedFilePortContract = {
    prepare: vi.fn(() => {
      const lease = Object.freeze(Object.create(null)) as LegacyBoundedFileLease;
      const outcome = deferred<LegacyBoundedFilePrepareOutcome>();
      preparations.push({ lease, outcome });
      if (!gatePreparation) outcome.resolve(ready());
      return { lease, ready: outcome.promise };
    }),
    schedulePlay: vi.fn((_lease, _scope, input) => {
      const settled = commitImpl();
      const prepared = ready();
      if (prepared.status !== 'ready') throw new Error('fake ready source is invalid');
      return Promise.resolve({
        status: 'scheduled' as const,
        startAtRoomTimeMs: input.startAtRoomTimeMs,
        snapshot: prepared.snapshot,
        settled,
      });
    }),
    commitPlay: vi.fn(() => commitImpl()),
    pause: vi.fn(() => pauseImpl()),
    seek: vi.fn(() => seekImpl()),
    stop: vi.fn(() => stopImpl()),
    snapshot: vi.fn(() => null),
    position: vi.fn(() => null),
    retire: vi.fn(async () => undefined),
    clearRoom: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };

  return {
    port,
    preparations,
    gateNextPreparation() {
      gatePreparation = true;
    },
    releasePreparation(index = preparations.length - 1, outcome = ready()) {
      preparations[index]?.outcome.resolve(outcome);
    },
    setCommit(impl: () => Promise<LegacyBoundedFileControlOutcome>) {
      commitImpl = impl;
    },
    setPause(impl: () => Promise<LegacyBoundedFileControlOutcome>) {
      pauseImpl = impl;
    },
    setSeek(impl: () => Promise<LegacyBoundedFileControlOutcome>) {
      seekImpl = impl;
    },
    setStop(impl: () => Promise<LegacyBoundedFileControlOutcome>) {
      stopImpl = impl;
    },
  };
}

function harness() {
  let roomTimeMs = 1_000;
  const fake = fakePort();
  const bridge = new LegacyBoundedFileV1BridgeForTests({
    port: fake.port,
    nowRoomTimeMs: () => roomTimeMs,
  });
  return {
    bridge,
    fake,
    setRoomTimeMs(value: number) {
      roomTimeMs = value;
    },
  };
}

async function start(
  h: ReturnType<typeof harness>,
  exactScope = scope(),
  positionSeconds = 10,
  startAtRoomTimeMs = 2_000,
) {
  const outcome = await h.bridge.play({
    scope: exactScope,
    positionSeconds,
    startAtRoomTimeMs,
    open: async () => null,
  });
  expect(outcome.status).toBe('applied');
}

function expectCanonical(
  snapshot: LegacyBoundedV1BridgeSnapshot,
  expected: Readonly<Record<string, unknown>>,
) {
  expect(snapshot).toMatchObject(expected);
  expect(Object.isFrozen(snapshot)).toBe(true);
}

describe('LegacyBoundedFileV1Bridge', () => {
  it('constructs product code through a narrow injected factory contract', () => {
    const fake = fakePort();
    const bridge = createLegacyBoundedFileV1Bridge({
      port: fake.port,
      nowRoomTimeMs: () => 1_000,
    });

    expect(Object.keys(bridge).sort()).toEqual([]);
    expect(bridge.snapshot()).toMatchObject({ phase: 'idle', scope: null });
    expect(typeof bridge.play).toBe('function');
    expect(typeof bridge.retire).toBe('function');
  });

  it('publishes exact current scope and authoritative duration after prepare-ready', async () => {
    const h = harness();
    const prepared = await h.bridge.prepare({
      scope: scope(),
      open: async () => null,
    });

    expect(prepared).toMatchObject({
      status: 'ready',
      snapshot: {
        scope: { queueItemId: Q1, descriptorId: 'descriptor-1' },
        phase: 'stopped',
        positionSeconds: 0,
        durationSeconds: 120,
        anchorRoomTimeMs: null,
        pending: null,
        renderer: { hasCurrent: false, hasCandidate: true },
      },
    });
  });

  it('projects only the canonical V1 timeline and keeps immutable metadata duration', async () => {
    const h = harness();
    const playing = h.bridge.play({
      scope: scope(),
      positionSeconds: 10,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });

    expectCanonical(h.bridge.snapshot(), {
      phase: 'playing',
      positionSeconds: 10,
      durationSeconds: null,
      anchorRoomTimeMs: 2_000,
      pending: { kind: 'play' },
      fallbackRequired: false,
    });
    await expect(playing).resolves.toMatchObject({ status: 'applied' });

    h.setRoomTimeMs(3_500);
    expectCanonical(h.bridge.snapshot(), {
      phase: 'playing',
      positionSeconds: 11.5,
      durationSeconds: 120,
      pending: null,
      renderer: { hasCurrent: true, hasCandidate: false },
    });
    expect(h.fake.port.position).not.toHaveBeenCalled();
    expect(h.fake.port.snapshot).not.toHaveBeenCalled();
  });

  it('exposes native scheduling before start evidence and promotes only after settlement', async () => {
    const h = harness();
    const started = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setCommit(() => started.promise);

    const scheduled = await h.bridge.schedulePlay({
      scope: scope(),
      positionSeconds: 10,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      startAtRoomTimeMs: 2_000,
      snapshot: {
        phase: 'playing',
        renderer: { hasCurrent: false, hasCandidate: true },
      },
    });
    expect(h.bridge.snapshot()).toMatchObject({
      pending: { kind: 'play' },
      renderer: { hasCurrent: false, hasCandidate: true },
    });

    started.resolve(applied());
    if (scheduled.status !== 'scheduled') throw new Error('expected scheduled outcome');
    await expect(scheduled.settled).resolves.toMatchObject({ status: 'applied' });
    expect(h.bridge.snapshot()).toMatchObject({
      pending: null,
      renderer: { hasCurrent: true, hasCandidate: false },
    });
  });

  it('makes a scheduled first PLAY inert when PAUSE supersedes it before start evidence', async () => {
    const h = harness();
    const started = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setCommit(() => started.promise);
    const scheduled = await h.bridge.schedulePlay({
      scope: scope(),
      positionSeconds: 10,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });
    if (scheduled.status !== 'scheduled') throw new Error('expected scheduled outcome');

    const pausing = h.bridge.pause({
      scope: scope(),
      positionSeconds: 10,
      atRoomTimeMs: 1_150,
    });
    await expect(scheduled.settled).resolves.toMatchObject({ status: 'superseded' });
    await expect(pausing).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'paused',
        fallbackRequired: false,
        renderer: { hasCurrent: false, hasCandidate: true },
      },
    });

    started.resolve(applied());
    await Promise.resolve();
    expect(h.bridge.snapshot()).toMatchObject({
      phase: 'paused',
      fallbackRequired: false,
      renderer: { hasCurrent: false, hasCandidate: true },
    });
  });

  it('coalesces an exact repeated play into one preparation and one commit', async () => {
    const h = harness();
    h.fake.gateNextPreparation();
    const input = {
      scope: scope(),
      positionSeconds: 5,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    };
    const first = h.bridge.play(input);
    const duplicate = h.bridge.play({ ...input, open: async () => null });

    expect(duplicate).toBe(first);
    expect(h.fake.port.prepare).toHaveBeenCalledOnce();
    h.fake.releasePreparation();
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    expect(h.fake.port.schedulePlay).toHaveBeenCalledOnce();
  });

  it('lets play claim an exact in-flight preload without opening a second source', async () => {
    const h = harness();
    h.fake.gateNextPreparation();
    const exactScope = scope();
    const preparing = h.bridge.prepare({
      scope: exactScope,
      open: async () => null,
    });
    const playing = h.bridge.play({
      scope: exactScope,
      positionSeconds: 4,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });

    expect(h.fake.port.prepare).toHaveBeenCalledOnce();
    h.fake.releasePreparation();
    await expect(preparing).resolves.toMatchObject({ status: 'superseded' });
    await expect(playing).resolves.toMatchObject({ status: 'applied' });
  });

  it('turns an immediate first-PLAY pause into a fresh resumable candidate', async () => {
    const h = harness();
    h.fake.gateNextPreparation();
    const playing = h.bridge.play({
      scope: scope(),
      positionSeconds: 4,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });

    const pausing = h.bridge.pause({
      scope: scope(),
      positionSeconds: 4,
      atRoomTimeMs: 1_100,
    });
    await expect(playing).resolves.toMatchObject({ status: 'superseded' });
    await vi.waitFor(() => expect(h.fake.port.prepare).toHaveBeenCalledTimes(2));
    h.fake.releasePreparation(1);
    await expect(pausing).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'paused',
        positionSeconds: 4,
        fallbackRequired: false,
        renderer: { hasCurrent: false, hasCandidate: true },
      },
    });
    expect(h.fake.port.retire).toHaveBeenCalled();
    expect(h.fake.preparations[0]?.outcome.promise).toBeInstanceOf(Promise);

    await expect(
      h.bridge.play({
        scope: scope(),
        positionSeconds: 4,
        startAtRoomTimeMs: 2_000,
        open: async () => null,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'playing',
        fallbackRequired: false,
        renderer: { hasCurrent: true, hasCandidate: false },
      },
    });
    expect(h.fake.port.prepare).toHaveBeenCalledTimes(2);
  });

  it('keeps first-play paused positioning canonical without requiring a native current', async () => {
    const h = harness();
    await expect(
      h.bridge.prepare({
        scope: scope(),
        open: async () => null,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    await expect(
      h.bridge.pause({
        scope: scope(),
        positionSeconds: 20,
        atRoomTimeMs: 1_100,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'paused',
        positionSeconds: 20,
        renderer: { hasCurrent: false, hasCandidate: true },
      },
    });
    await expect(
      h.bridge.seekPaused({
        scope: scope(),
        positionSeconds: 41,
        atRoomTimeMs: 1_200,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'paused',
        positionSeconds: 41,
        fallbackRequired: false,
      },
    });
    expect(h.fake.port.seek).not.toHaveBeenCalled();

    await expect(
      h.bridge.play({
        scope: scope(),
        positionSeconds: 41,
        startAtRoomTimeMs: 2_000,
        open: async () => null,
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(h.fake.port.schedulePlay).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ queueItemId: Q1 }),
      { positionSeconds: 41, startAtRoomTimeMs: 2_000 },
    );
  });

  it('keeps only the successor candidate when an immediate resume supersedes candidate pause', async () => {
    const h = harness();
    await expect(
      h.bridge.prepare({
        scope: scope(),
        open: async () => null,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    const pausing = h.bridge.pause({
      scope: scope(),
      positionSeconds: 20,
      atRoomTimeMs: 1_100,
    });
    const playing = h.bridge.play({
      scope: scope(),
      positionSeconds: 20,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });

    await expect(pausing).resolves.toMatchObject({ status: 'superseded' });
    await expect(playing).resolves.toMatchObject({
      status: 'applied',
      snapshot: {
        phase: 'playing',
        renderer: { hasCurrent: true, hasCandidate: false },
      },
    });
  });

  it('publishes pause immediately and serializes a following stop behind native pause', async () => {
    const h = harness();
    await start(h);
    const pauseGate = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setPause(() => pauseGate.promise);

    const pausing = h.bridge.pause({
      scope: scope(),
      positionSeconds: 40,
      atRoomTimeMs: 3_000,
    });
    expectCanonical(h.bridge.snapshot(), {
      phase: 'paused',
      positionSeconds: 40,
      pending: { kind: 'pause' },
    });
    await vi.waitFor(() => expect(h.fake.port.pause).toHaveBeenCalledOnce());

    const stopping = h.bridge.stop({
      scope: scope(),
      positionSeconds: 0,
      atRoomTimeMs: 3_010,
    });
    expectCanonical(h.bridge.snapshot(), {
      phase: 'stopped',
      positionSeconds: 0,
      pending: { kind: 'stop' },
    });
    await Promise.resolve();
    expect(h.fake.port.stop).not.toHaveBeenCalled();

    pauseGate.resolve(applied());
    await expect(pausing).resolves.toMatchObject({ status: 'superseded' });
    await expect(stopping).resolves.toMatchObject({ status: 'applied' });
    expect(h.fake.port.stop).toHaveBeenCalledOnce();
    expect(h.bridge.snapshot().renderer.hasCurrent).toBe(false);
  });

  it('treats a second exact STOP as applied after the first native STOP drains', async () => {
    const h = harness();
    await start(h);
    const firstStop = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setStop(() => firstStop.promise);

    const stoppingFirst = h.bridge.stop({
      scope: scope(),
      positionSeconds: 0,
      atRoomTimeMs: 3_000,
    });
    await vi.waitFor(() => expect(h.fake.port.stop).toHaveBeenCalledOnce());
    const stoppingSecond = h.bridge.stop({
      scope: scope(),
      positionSeconds: 0,
      atRoomTimeMs: 3_010,
    });
    await Promise.resolve();
    expect(h.fake.port.stop).toHaveBeenCalledOnce();

    firstStop.resolve(applied());
    await expect(stoppingFirst).resolves.toMatchObject({ status: 'superseded' });
    await expect(stoppingSecond).resolves.toMatchObject({ status: 'applied' });
    expect(h.fake.port.stop).toHaveBeenCalledOnce();
    expect(h.bridge.snapshot()).toMatchObject({
      phase: 'stopped',
      renderer: { hasCurrent: false, hasCandidate: false },
      fallbackRequired: false,
    });
  });

  it('applies a paused seek from V1 truth without consulting native position', async () => {
    const h = harness();
    await start(h);
    await h.bridge.pause({ scope: scope(), positionSeconds: 20, atRoomTimeMs: 2_100 });
    const seekGate = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setSeek(() => seekGate.promise);

    const seeking = h.bridge.seekPaused({
      scope: scope(),
      positionSeconds: 73,
      atRoomTimeMs: 2_200,
    });
    expectCanonical(h.bridge.snapshot(), {
      phase: 'paused',
      positionSeconds: 73,
      pending: { kind: 'seek-paused' },
    });
    seekGate.resolve(applied());
    await expect(seeking).resolves.toMatchObject({ status: 'applied' });
    expect(h.fake.port.seek).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ queueItemId: Q1 }),
      { positionSeconds: 73, atRoomTimeMs: 2_200 },
    );
    expect(h.fake.port.position).not.toHaveBeenCalled();
  });

  it('uses a fresh candidate for a playing seek and promotes only after commit evidence', async () => {
    const h = harness();
    await start(h);
    const firstLease = h.fake.preparations[0]?.lease;
    const commitGate = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setCommit(() => commitGate.promise);

    const seeking = h.bridge.seekPlaying({
      scope: scope(),
      positionSeconds: 88,
      startAtRoomTimeMs: 4_000,
      open: async () => null,
    });
    await vi.waitFor(() => expect(h.fake.port.schedulePlay).toHaveBeenCalledTimes(2));
    expect(h.fake.port.prepare).toHaveBeenCalledTimes(2);
    expect(h.bridge.snapshot().renderer).toEqual({
      hasCurrent: true,
      hasCandidate: true,
    });

    commitGate.resolve(applied());
    await expect(seeking).resolves.toMatchObject({ status: 'applied' });
    expect(h.bridge.snapshot().renderer).toEqual({
      hasCurrent: true,
      hasCandidate: false,
    });
    expect(h.fake.preparations[1]?.lease).not.toBe(firstLease);
  });

  it('makes a late replacement completion inert after immediate stop', async () => {
    const h = harness();
    await start(h);
    const commitGate = deferred<LegacyBoundedFileControlOutcome>();
    h.fake.setCommit(() => commitGate.promise);
    const seeking = h.bridge.seekPlaying({
      scope: scope(),
      positionSeconds: 70,
      startAtRoomTimeMs: 4_000,
      open: async () => null,
    });
    await vi.waitFor(() => expect(h.fake.port.schedulePlay).toHaveBeenCalledTimes(2));

    const stopping = h.bridge.stop({
      scope: scope(),
      positionSeconds: 0,
      atRoomTimeMs: 4_010,
    });
    expect(h.bridge.snapshot()).toMatchObject({ phase: 'stopped', positionSeconds: 0 });
    commitGate.resolve(applied());

    await expect(seeking).resolves.toMatchObject({ status: 'superseded' });
    await expect(stopping).resolves.toMatchObject({ status: 'applied' });
    expectCanonical(h.bridge.snapshot(), {
      phase: 'stopped',
      positionSeconds: 0,
      pending: null,
      renderer: { hasCurrent: false, hasCandidate: false },
    });
  });

  it('localizes renderer failures without changing or exposing transport authority', async () => {
    const h = harness();
    await start(h);
    h.fake.setPause(async () => ({ status: 'failed', error: new Error('decoder failed') }));

    const outcome = await h.bridge.pause({
      scope: scope(),
      positionSeconds: 31,
      atRoomTimeMs: 2_100,
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      snapshot: {
        phase: 'paused',
        positionSeconds: 31,
        fallbackRequired: true,
        renderer: { hasCurrent: false },
      },
    });
    expect(h.fake.port.retire).toHaveBeenCalled();
    expect(Reflect.ownKeys(h.bridge)).toEqual([]);
  });

  it('reports unsupported preparation as compatibility fallback without taking current authority', async () => {
    const h = harness();
    h.fake.gateNextPreparation();
    const playing = h.bridge.play({
      scope: scope(),
      positionSeconds: 9,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });
    h.fake.releasePreparation(0, { status: 'fallback', reason: 'unsupported-source' });

    await expect(playing).resolves.toMatchObject({
      status: 'fallback',
      reason: 'unsupported-source',
      snapshot: {
        phase: 'playing',
        durationSeconds: null,
        fallbackRequired: true,
        renderer: { hasCurrent: false, hasCandidate: false },
      },
    });
    expect(h.fake.port.schedulePlay).not.toHaveBeenCalled();
  });

  it('falls back when a ready renderer cannot provide a positive authoritative duration', async () => {
    const h = harness();
    h.fake.gateNextPreparation();
    const playing = h.bridge.play({
      scope: scope(),
      positionSeconds: 0,
      startAtRoomTimeMs: 2_000,
      open: async () => null,
    });
    h.fake.releasePreparation(0, ready(0));

    await expect(playing).resolves.toMatchObject({
      status: 'fallback',
      reason: 'unsupported-source',
      snapshot: {
        durationSeconds: null,
        fallbackRequired: true,
        renderer: { hasCurrent: false, hasCandidate: false },
      },
    });
    expect(h.fake.port.schedulePlay).not.toHaveBeenCalled();
    expect(h.fake.port.retire).toHaveBeenCalledOnce();
  });

  it('keeps exact scope mismatches inert and retires only the owned incarnation', async () => {
    const h = harness();
    await start(h);
    const wrong = scope({ bridgeGeneration: 'bridge-generation-2' });

    await expect(
      h.bridge.pause({ scope: wrong, positionSeconds: 10, atRoomTimeMs: 2_100 }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(h.bridge.snapshot()).toMatchObject({
      scope: { bridgeGeneration: 'bridge-generation-1' },
      phase: 'playing',
    });
    expect(h.fake.port.pause).not.toHaveBeenCalled();

    await expect(h.bridge.retire(wrong)).resolves.toMatchObject({ status: 'superseded' });
    await expect(h.bridge.retire(scope())).resolves.toMatchObject({ status: 'applied' });
    expectCanonical(h.bridge.snapshot(), {
      scope: null,
      phase: 'idle',
      durationSeconds: null,
      renderer: { hasCurrent: false, hasCandidate: false },
    });
  });
});
