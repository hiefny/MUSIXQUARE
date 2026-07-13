import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  EncodedSourceBusyError,
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { readM4aAacLcMetadata, snapshotM4aAacLcManifest } from '../metadata.ts';
import {
  closeM4aAacRuntime,
  createM4aAacGenerationStartPlan,
  openM4aAacRuntime,
  requireM4aAacGenerationStartPlan,
} from '../runtime.ts';
import { buildM4aAacFixture, M4aAacFixtureMemorySource } from './m4a-aac-fixture.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

interface RuntimeReadRecord {
  readonly offset: number;
  readonly length: number;
}

class ControlledRuntimeSource implements EncodedRandomAccessSource {
  readonly reads: RuntimeReadRecord[] = [];
  closeCalls = 0;
  onRead:
    | ((read: Readonly<RuntimeReadRecord>, signal: AbortSignal) => void | Promise<void>)
    | null = null;
  nextFailure: unknown = undefined;
  hasNextFailure = false;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity: string,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, abortSignal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(abortSignal);
    const read = Object.freeze({ offset, length });
    this.reads.push(read);
    if (this.hasNextFailure) {
      this.hasNextFailure = false;
      throw this.nextFailure;
    }
    await this.onRead?.(read, abortSignal);
    throwIfAborted(abortSignal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ObservableReadableBoxReader extends IsoBmffBoxReader {
  readableCalls = 0;
  afterReadable: ((call: number) => void) | null = null;

  override assertReadable(abortSignal: AbortSignal): void {
    super.assertReadable(abortSignal);
    this.readableCalls += 1;
    this.afterReadable?.(this.readableCalls);
  }
}

function findBoxType(bytes: Uint8Array, type: string): number {
  const encoded = new TextEncoder().encode(type);
  for (let offset = 0; offset <= bytes.byteLength - encoded.byteLength; offset += 1) {
    if (encoded.every((byte, index) => bytes[offset + index] === byte)) return offset;
  }
  throw new Error(`Missing fixture box ${type}`);
}

function writeBoxBodyUint32(bytes: Uint8Array, type: string, bodyOffset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    findBoxType(bytes, type) + 4 + bodyOffset,
    value,
    false,
  );
}

async function transferableManifest(fixture: ReturnType<typeof buildM4aAacFixture>) {
  const manifest = await readM4aAacLcMetadata(fixture.source, signal());
  return structuredClone(snapshotM4aAacLcManifest(manifest));
}

async function openControlledRuntime(
  identity: string,
  createReader: (source: ControlledRuntimeSource) => IsoBmffBoxReader = (source) =>
    new IsoBmffBoxReader(source),
) {
  const built = buildM4aAacFixture();
  const source = new ControlledRuntimeSource(built.bytes.slice(), identity);
  const manifest = structuredClone(
    snapshotM4aAacLcManifest(await readM4aAacLcMetadata(source, signal())),
  );
  const reader = createReader(source);
  const runtime = await openM4aAacRuntime(reader, manifest, signal());
  source.reads.length = 0;
  if (reader instanceof ObservableReadableBoxReader) reader.readableCalls = 0;
  return { built, source, reader, runtime };
}

describe('source-bound M4A AAC runtime opening', () => {
  it('atomically reopens authenticated indexes and exposes only bounded decoder info', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    fixture.source.reads.length = 0;

    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );

    expect(runtime.info).toMatchObject({
      format: 'm4a-aac-lc',
      sourceSize: fixture.bytes.byteLength,
      sourceIdentity: fixture.source.identity,
      codec: 'mp4a.40.2',
      sampleRateHz: 48_000,
      channelCount: 2,
      audioSpecificConfig: [0x11, 0x90, 0x56, 0xe5, 0x00],
      accessUnitCount: 6,
      totalEncodedBytes: 112,
      sourceRequiredPrerollAccessUnits: 1,
      transformPrerollPolicyAccessUnits: 1,
      timeline: {
        headTrimCoreFrames: 1_024,
        tailTrimCoreFrames: 512,
        totalMediaFrames: 4_608,
      },
    });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.info)).toBe(true);
    expect(Object.isFrozen(runtime.info.audioSpecificConfig)).toBe(true);
    expect(Object.isFrozen(runtime.info.timeline)).toBe(true);
    expect(fixture.source.reads.map(({ length }) => length)).toEqual([12, 20, 8]);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('keeps absent source roll evidence separate from the fixed product preroll policy', async () => {
    const fixture = buildM4aAacFixture({ includeRollRecovery: false });
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.info.sourceRequiredPrerollAccessUnits).toBeNull();
    expect(runtime.info.transformPrerollPolicyAccessUnits).toBe(1);
    expect(runtime.createGenerationStartPlan(0).actualPrerollAccessUnits).toBe(1);
  });

  it('rejects exact source-size and identity mismatches before reading the foreign source', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const wrongIdentity = buildM4aAacFixture({ sourceIdentity: 'foreign-m4a-source' }).source;
    const wrongSizeFixture = buildM4aAacFixture({ sourceIdentity: fixture.source.identity });
    const wrongSizeSource = new M4aAacFixtureMemorySource(
      wrongSizeFixture.bytes.slice(0, -1),
      fixture.source.identity,
    );

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(wrongIdentity), manifest, signal()),
    ).rejects.toThrow(/source binding/);
    expect(wrongIdentity.reads).toHaveLength(0);

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(wrongSizeSource), manifest, signal()),
    ).rejects.toThrow(/source binding/);
    expect(wrongSizeSource.reads).toHaveLength(0);
  });

  it('rejects transferred stsc geometry changed without matching source evidence', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const forged = {
      ...manifest,
      chunks: {
        ...manifest.chunks,
        runs: [
          {
            firstChunk: 1,
            endChunkExclusive: 2,
            firstSampleOrdinal: 0,
            samplesPerChunk: 4,
          },
          {
            firstChunk: 2,
            endChunkExclusive: 4,
            firstSampleOrdinal: 4,
            samplesPerChunk: 1,
          },
        ],
      },
    };

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(fixture.source), forged, signal()),
    ).rejects.toThrow(/stsc (?:evidence conflicts|runs do not match)/i);
  });

  it('rejects tampered manifest digests and changed source metadata pages', async () => {
    const digestFixture = buildM4aAacFixture();
    const digestManifest = await transferableManifest(digestFixture);
    const forgedDigest = {
      ...digestManifest,
      sampleSizes: {
        ...digestManifest.sampleSizes,
        headerSha256: '0'.repeat(64),
      },
    };
    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(digestFixture.source), forgedDigest, signal()),
    ).rejects.toThrow(/header changed/i);

    const pageFixture = buildM4aAacFixture();
    const pageManifest = await transferableManifest(pageFixture);
    pageFixture.bytes[pageManifest.chunks.sampleToChunk.bodyStart + 12]! ^= 1;
    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(pageFixture.source), pageManifest, signal()),
    ).rejects.toThrow(/stsc body changed/i);
  });

  it('preserves a pre-abort reason before inspecting a hostile manifest', async () => {
    const fixture = buildM4aAacFixture();
    let inspected = false;
    const hostile = new Proxy(Object.create(null), {
      ownKeys() {
        inspected = true;
        throw new Error('manifest inspection must not win');
      },
    });
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'runtime-open-before' });
    controller.abort(reason);

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(fixture.source), hostile, controller.signal),
    ).rejects.toBe(reason);
    expect(inspected).toBe(false);
    expect(fixture.source.reads).toHaveLength(0);
  });

  it('preserves an abort that reenters during hostile synchronous manifest inspection', async () => {
    const fixture = buildM4aAacFixture();
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'runtime-open-during-manifest-inspection' });
    const hostile = new Proxy(Object.create(null), {
      ownKeys(): never {
        controller.abort(reason);
        throw new Error('manifest inspection error must not replace abort');
      },
    });

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(fixture.source), hostile, controller.signal),
    ).rejects.toBe(reason);
    expect(fixture.source.reads).toHaveLength(0);
  });
});

describe('M4A AAC runtime access-unit reader authority', () => {
  it('opens at the exact issued plan ordinal and logical byte prefix', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-plan');
    const plan = fixture.runtime.createGenerationStartPlan(2_049);
    const expectedPrefix = fixture.built.expected.accessUnitSizes
      .slice(0, plan.decodeStartAccessUnitOrdinal)
      .reduce((total, size) => total + size, 0);

    const cursor = await fixture.runtime.openAccessUnitReader(plan, signal());

    expect(cursor.nextAccessUnitOrdinal).toBe(plan.decodeStartAccessUnitOrdinal);
    expect(cursor.consumedEncodedBytes).toBe(expectedPrefix);
    await expect(cursor.readNext(signal())).resolves.toEqual({
      bytes: fixture.built.expected.accessUnitPayloads[plan.decodeStartAccessUnitOrdinal],
      descriptor: {
        ordinal: plan.decodeStartAccessUnitOrdinal,
        sourceOffset: fixture.built.expected.accessUnitOffsets[plan.decodeStartAccessUnitOrdinal],
        byteLength: fixture.built.expected.accessUnitSizes[plan.decodeStartAccessUnitOrdinal],
        chunkOrdinal: 1,
        encodedBytePrefix: expectedPrefix,
      },
    });
    fixture.runtime.close();
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('rejects cloned and foreign plans before source reads without consuming cursor authority', async () => {
    const local = await openControlledRuntime('runtime-cursor-local-plan');
    const foreign = await openControlledRuntime('runtime-cursor-foreign-plan');
    const localPlan = local.runtime.createGenerationStartPlan(0);
    const foreignPlan = foreign.runtime.createGenerationStartPlan(0);

    await expect(
      local.runtime.openAccessUnitReader(structuredClone(localPlan), signal()),
    ).rejects.toThrow(/not issued/i);
    await expect(local.runtime.openAccessUnitReader(foreignPlan, signal())).rejects.toThrow(
      /different runtime/i,
    );
    expect(local.source.reads).toHaveLength(0);

    await expect(local.runtime.openAccessUnitReader(localPlan, signal())).resolves.toMatchObject({
      nextAccessUnitOrdinal: 0,
      consumedEncodedBytes: 0,
    });
    local.runtime.close();
    foreign.runtime.close();
    expect(local.source.closeCalls).toBe(0);
    expect(foreign.source.closeCalls).toBe(0);
  });

  it('issues exactly one cursor even after the returned cursor is closed', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-once');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const cursor = await fixture.runtime.openAccessUnitReader(plan, signal());
    cursor.close();
    const reads = fixture.source.reads.length;

    await expect(fixture.runtime.openAccessUnitReader(plan, signal())).rejects.toThrow(
      /already issued/i,
    );
    expect(fixture.source.reads).toHaveLength(reads);
    fixture.runtime.close();
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('rejects concurrent and source-reentrant opens without stealing the first operation', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-concurrent');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    let enteredResolve: (() => void) | null = null;
    let release: (() => void) | null = null;
    let reentrant: Promise<unknown> | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = () => {
      fixture.source.onRead = null;
      reentrant = fixture.runtime.openAccessUnitReader(plan, signal());
      void reentrant.catch(() => undefined);
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const opening = fixture.runtime.openAccessUnitReader(plan, signal());
    await entered;
    await expect(fixture.runtime.openAccessUnitReader(plan, signal())).rejects.toThrow(
      /concurrent or reentrant/i,
    );
    if (reentrant === null) throw new Error('source did not attempt runtime cursor reentry');
    await expect(reentrant).rejects.toThrow(/concurrent or reentrant/i);
    if (release === null) throw new Error('runtime cursor open did not block');
    release();
    await expect(opening).resolves.toMatchObject({ nextAccessUnitOrdinal: 0 });
    fixture.runtime.close();
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('allows exact-abort and transient Busy opens to retry', async () => {
    let abortReader: ObservableReadableBoxReader | null = null;
    const aborted = await openControlledRuntime(
      'runtime-cursor-abort-retry',
      (source) => (abortReader = new ObservableReadableBoxReader(source)),
    );
    const abortedPlan = aborted.runtime.createGenerationStartPlan(0);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'runtime-cursor-sync-abort' });
    if (abortReader === null) throw new Error('observable runtime reader was not constructed');
    const activeAbortReader: ObservableReadableBoxReader = abortReader;
    activeAbortReader.afterReadable = () => {
      activeAbortReader.afterReadable = null;
      controller.abort(reason);
      throw new Error('secondary synchronous source validation error');
    };

    await expect(aborted.runtime.openAccessUnitReader(abortedPlan, controller.signal)).rejects.toBe(
      reason,
    );
    await expect(
      aborted.runtime.openAccessUnitReader(abortedPlan, signal()),
    ).resolves.toMatchObject({
      nextAccessUnitOrdinal: 0,
    });
    aborted.runtime.close();

    const busyFixture = await openControlledRuntime('runtime-cursor-busy-retry');
    const busyPlan = busyFixture.runtime.createGenerationStartPlan(0);
    const busy = new EncodedSourceBusyError('runtime cursor temporarily busy');
    busyFixture.source.nextFailure = busy;
    busyFixture.source.hasNextFailure = true;
    await expect(busyFixture.runtime.openAccessUnitReader(busyPlan, signal())).rejects.toBe(busy);
    await expect(
      busyFixture.runtime.openAccessUnitReader(busyPlan, signal()),
    ).resolves.toMatchObject({ nextAccessUnitOrdinal: 0 });
    busyFixture.runtime.close();
    expect(aborted.source.closeCalls).toBe(0);
    expect(busyFixture.source.closeCalls).toBe(0);
  });

  it('sticks the exact first structural cursor-open failure without later source I/O', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-structural-poison');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const firstStszEntry = findBoxType(fixture.source.bytes, 'stsz') + 4 + 12;
    fixture.source.bytes[firstStszEntry]! ^= 1;

    const failure = await fixture.runtime
      .openAccessUnitReader(plan, signal())
      .catch((error: unknown) => error);
    fixture.source.bytes[firstStszEntry]! ^= 1;
    const readsAfterFailure = fixture.source.reads.length;

    await expect(fixture.runtime.openAccessUnitReader(plan, signal())).rejects.toBe(failure);
    expect(fixture.source.reads).toHaveLength(readsAfterFailure);
    fixture.runtime.close();
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('uses intrinsic AbortSignal state and EventTarget methods before claiming its sole cursor', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-hostile-caller-signal');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const callerSignal = new AbortController().signal;
    let abortedGetterCalls = 0;
    let reasonGetterCalls = 0;
    let addCalls = 0;
    let removeCalls = 0;
    let nested: Promise<unknown> | null = null;
    Object.defineProperties(callerSignal, {
      aborted: {
        configurable: true,
        get() {
          abortedGetterCalls += 1;
          nested ??= fixture.runtime.openAccessUnitReader(plan, signal());
          void nested.catch(() => undefined);
          return false;
        },
      },
      reason: {
        configurable: true,
        get() {
          reasonGetterCalls += 1;
          return undefined;
        },
      },
      addEventListener: {
        configurable: true,
        value() {
          addCalls += 1;
          throw new Error('caller-owned addEventListener must not run');
        },
      },
      removeEventListener: {
        configurable: true,
        value() {
          removeCalls += 1;
          fixture.runtime.close();
          throw new Error('caller-owned removeEventListener must not run');
        },
      },
    });

    const cursor = await fixture.runtime.openAccessUnitReader(plan, callerSignal);

    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(nested).toBeNull();
    expect(abortedGetterCalls).toBe(0);
    expect(reasonGetterCalls).toBe(0);
    expect(addCalls).toBe(0);
    expect(removeCalls).toBe(0);
    fixture.runtime.close();
    await expect(cursor.readNext(signal())).rejects.toThrow(/closed/i);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('preserves caller abort during blocked open and permits an exact retry', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-blocked-caller-abort');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'runtime-cursor-blocked-caller-abort' });
    let enteredResolve: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = (_read, activeSignal) => {
      fixture.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true });
      });
    };

    const opening = fixture.runtime.openAccessUnitReader(plan, controller.signal);
    await entered;
    controller.abort(reason);

    await expect(opening).rejects.toBe(reason);
    await expect(fixture.runtime.openAccessUnitReader(plan, signal())).resolves.toMatchObject({
      nextAccessUnitOrdinal: 0,
    });
    fixture.runtime.close();
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('closes its active cursor while retaining borrowed source ownership', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-active-close');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const cursor = await fixture.runtime.openAccessUnitReader(plan, signal());
    let shadowCloseCalls = 0;
    Object.defineProperty(cursor, 'close', {
      configurable: true,
      value: () => {
        shadowCloseCalls += 1;
        throw new Error('runtime must not trust the public cursor close property');
      },
    });

    fixture.runtime.close();

    expect(shadowCloseCalls).toBe(0);
    await expect(cursor.readNext(signal())).rejects.toThrow(/closed/i);
    await expect(fixture.runtime.openAccessUnitReader(plan, signal())).rejects.toThrow(
      /runtime is closed/i,
    );
    expect(fixture.runtime.info.sourceIdentity).toBe(fixture.source.identity);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('actively aborts a cooperative source read when its owning runtime closes', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-active-read-close');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    const cursor = await fixture.runtime.openAccessUnitReader(plan, signal());
    fixture.source.reads.length = 0;
    let enteredResolve: (() => void) | null = null;
    let observedReadSignal: AbortSignal | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = (_read, activeSignal) => {
      fixture.source.onRead = null;
      observedReadSignal = activeSignal;
      enteredResolve?.();
      return new Promise<void>((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true });
      });
    };

    const activeRead = cursor.readNext(signal());
    await entered;
    const readsAtClose = fixture.source.reads.length;
    fixture.runtime.close();

    await expect(activeRead).rejects.toThrow(/closed/i);
    expect(observedReadSignal?.aborted).toBe(true);
    expect(fixture.source.reads).toHaveLength(readsAtClose);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(cursor.consumedEncodedBytes).toBe(0);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('aborts a blocked open on runtime close without starting later source I/O', async () => {
    const fixture = await openControlledRuntime('runtime-cursor-blocked-close');
    const plan = fixture.runtime.createGenerationStartPlan(0);
    let enteredResolve: (() => void) | null = null;
    let release: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = () => {
      fixture.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const opening = fixture.runtime.openAccessUnitReader(plan, signal());
    await entered;
    fixture.runtime.close();
    const readsAtClose = fixture.source.reads.length;
    if (release === null) throw new Error('runtime cursor source read did not block');
    release();

    await expect(opening).rejects.toThrow(/runtime is closed/i);
    expect(fixture.source.reads).toHaveLength(readsAtClose);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('closes a cursor completed during a reentrant final runtime close', async () => {
    let baselineReader: ObservableReadableBoxReader | null = null;
    const baseline = await openControlledRuntime(
      'runtime-cursor-late-baseline',
      (source) => (baselineReader = new ObservableReadableBoxReader(source)),
    );
    const baselinePlan = baseline.runtime.createGenerationStartPlan(0);
    await baseline.runtime.openAccessUnitReader(baselinePlan, signal());
    if (baselineReader === null) throw new Error('baseline reader was not constructed');
    const finalReadableCall = baselineReader.readableCalls;
    expect(finalReadableCall).toBeGreaterThan(0);
    baseline.runtime.close();

    let closingReader: ObservableReadableBoxReader | null = null;
    const closing = await openControlledRuntime(
      'runtime-cursor-late-close',
      (source) => (closingReader = new ObservableReadableBoxReader(source)),
    );
    const closingPlan = closing.runtime.createGenerationStartPlan(0);
    if (closingReader === null) throw new Error('closing reader was not constructed');
    const activeClosingReader: ObservableReadableBoxReader = closingReader;
    activeClosingReader.afterReadable = (call) => {
      if (call !== finalReadableCall) return;
      activeClosingReader.afterReadable = null;
      closing.runtime.close();
    };

    await expect(closing.runtime.openAccessUnitReader(closingPlan, signal())).rejects.toThrow(
      /runtime is closed/i,
    );
    expect(activeClosingReader.readableCalls).toBe(finalReadableCall);
    expect(closing.source.closeCalls).toBe(0);
  });
});

describe('M4A AAC generation start authority', () => {
  it('maps audible media frames to exact one-AU preroll and discard coordinates', async () => {
    const fixture = buildM4aAacFixture();
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.createGenerationStartPlan(0)).toEqual({
      mediaFrame: 0,
      rawTargetCoreFrame: 1_024,
      targetAccessUnitOrdinal: 1,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_024,
    });
    expect(runtime.createGenerationStartPlan(2_049)).toEqual({
      mediaFrame: 2_049,
      rawTargetCoreFrame: 3_073,
      targetAccessUnitOrdinal: 3,
      coreFrameWithinTargetAccessUnit: 1,
      decodeStartAccessUnitOrdinal: 2,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_025,
    });
    expect(runtime.createGenerationStartPlan(4_607)).toEqual({
      mediaFrame: 4_607,
      rawTargetCoreFrame: 5_631,
      targetAccessUnitOrdinal: 5,
      coreFrameWithinTargetAccessUnit: 511,
      decodeStartAccessUnitOrdinal: 4,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_535,
    });
    expect(() => runtime.createGenerationStartPlan(4_608)).toThrow(/exclusive media EOF/i);
    expect(() => runtime.createGenerationStartPlan(4_609)).toThrow(/outside/i);
    expect(() => runtime.createGenerationStartPlan(-0)).toThrow(/mediaFrame/i);
    expect(() => runtime.createGenerationStartPlan(0.5)).toThrow(/mediaFrame/i);
  });

  it('clamps product preroll to zero for a valid target in access unit zero', async () => {
    const fixture = buildM4aAacFixture({ includeITunSmpb: false });
    // Convert the canonical fixture to an untrimmed 5,632-frame timeline.
    writeBoxBodyUint32(fixture.bytes, 'elst', 8, 117);
    writeBoxBodyUint32(fixture.bytes, 'elst', 12, 0);
    writeBoxBodyUint32(fixture.bytes, 'tkhd', 20, 117);
    writeBoxBodyUint32(fixture.bytes, 'mvhd', 16, 117);
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.info.timeline.headTrimCoreFrames).toBe(0);
    expect(runtime.createGenerationStartPlan(0)).toEqual({
      mediaFrame: 0,
      rawTargetCoreFrame: 0,
      targetAccessUnitOrdinal: 0,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 0,
      discardCoreFrames: 0,
    });
  });

  it('accepts only unchanged plans issued by the exact live same-realm runtime', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );
    const foreignRuntime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );
    const plan = createM4aAacGenerationStartPlan(runtime, 17);

    expect(requireM4aAacGenerationStartPlan(runtime, plan)).toBe(plan);
    expect(runtime.requireGenerationStartPlan(plan)).toBe(plan);
    expect(() => requireM4aAacGenerationStartPlan(runtime, structuredClone(plan))).toThrow(
      /not issued/i,
    );
    expect(() => requireM4aAacGenerationStartPlan(foreignRuntime, plan)).toThrow(
      /different runtime/i,
    );
    expect(() => createM4aAacGenerationStartPlan({ ...runtime }, 17)).toThrow(/provenance/i);

    let getterRan = false;
    const hostilePlan = Object.create(null);
    Object.defineProperty(hostilePlan, 'mediaFrame', {
      enumerable: true,
      get() {
        getterRan = true;
        throw new Error('hostile plan getter must not run');
      },
    });
    expect(() => runtime.requireGenerationStartPlan(hostilePlan)).toThrow(/not issued/i);
    expect(getterRan).toBe(false);
  });

  it('drops live authority idempotently while preserving public info and borrowed ownership', async () => {
    const fixture = buildM4aAacFixture();
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );
    const plan = runtime.createGenerationStartPlan(0);

    runtime.close();
    runtime.close();
    closeM4aAacRuntime(runtime);
    expect(runtime.info.sourceIdentity).toBe(fixture.source.identity);
    expect(fixture.source.closeCalls).toBe(0);
    expect(() => runtime.createGenerationStartPlan(0)).toThrow(/runtime is closed/i);
    expect(() => runtime.requireGenerationStartPlan(plan)).toThrow(/runtime is closed/i);
    expect(() => closeM4aAacRuntime({ ...runtime })).toThrow(/provenance/i);
  });
});
