import { beforeAll, describe, expect, it } from 'vitest';

import { readM4aAacLcMetadata, snapshotM4aAacLcManifest } from '../metadata.ts';
import {
  M4A_AAC_DECODER_DESCRIPTOR_KEYS,
  M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS,
  M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH,
  M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  M4A_AAC_DECODER_PROTOCOL_VERSION,
  M4A_AAC_DECODER_START_PLAN_KEYS,
  createM4aAacDecoderStartPlan,
  isM4aAacDecoderGeneration,
  isM4aAacSourceLifetimeGeneration,
  m4aAacDecoderCommandTransferables,
  parseM4aAacDecoderCommand,
  parseM4aAacDecoderEvent,
  sameM4aAacDecoderDescriptor,
  snapshotM4aAacDecoderDescriptor,
  validateM4aAacDecoderDescriptor,
  type M4aAacDecoderDescriptor,
  type M4aAacDecoderEvent,
  type M4aAacDecoderOpenCommand,
  type M4aAacDecoderStartPlan,
} from '../decoder-protocol.ts';
import { createM4aAacDecoderDescriptor } from '../decoder-helpers.ts';
import type { M4aAacLcManifest } from '../metadata.ts';
import { buildM4aAacFixture } from './m4a-aac-fixture.ts';

const OUTPUT_SAMPLE_RATE_HZ = 44_100;
const TARGET_MEDIA_FRAME = 2_049;

let MANIFEST: Readonly<M4aAacLcManifest>;
let DESCRIPTOR: Readonly<M4aAacDecoderDescriptor>;

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeAll(async () => {
  const fixture = buildM4aAacFixture();
  const issued = await readM4aAacLcMetadata(fixture.source, signal());
  MANIFEST = structuredClone(snapshotM4aAacLcManifest(issued));
  DESCRIPTOR = createM4aAacDecoderDescriptor({
    manifest: MANIFEST,
    outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
    mediaFrame: TARGET_MEDIA_FRAME,
  });
});

function openCommand(
  sourcePort: MessagePort,
  pcmPort: MessagePort,
  descriptor = DESCRIPTOR,
): M4aAacDecoderOpenCommand {
  return {
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 7,
    decoderGeneration: 19,
    backendId: 'webcodecs',
    descriptor,
    sourcePort,
    pcmPort,
  };
}

function eventIdentity() {
  return {
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    sourceLifetimeGeneration: 7,
    decoderGeneration: 19,
  } as const;
}

function closeChannels(...channels: MessageChannel[]): void {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
}

describe('M4A AAC decoder descriptor boundary', () => {
  it('publishes stable logical-only wire shapes', () => {
    expect(M4A_AAC_DECODER_START_PLAN_KEYS).toEqual([
      'mediaFrame',
      'rawTargetCoreFrame',
      'targetAccessUnitOrdinal',
      'coreFrameWithinTargetAccessUnit',
      'decodeStartAccessUnitOrdinal',
      'actualPrerollAccessUnits',
      'discardCoreFrames',
    ]);
    expect(M4A_AAC_DECODER_DESCRIPTOR_KEYS).toEqual([
      'format',
      'sourceSize',
      'sourceIdentity',
      'manifest',
      'outputSampleRateHz',
      'transformPrerollPolicyAccessUnits',
      'startPlan',
    ]);
    expect(M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS).toEqual([
      'nextAccessUnitOrdinal',
      'consumedEncodedBytes',
      'decodedRawCoreFrames',
      'acceptedMediaFrames',
      'producedOutputFrames',
    ]);
    expect(M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS.some((key) => /offset/i.test(key))).toBe(false);
  });

  it('derives exact fixed-preroll coordinates from the canonical manifest', () => {
    expect(createM4aAacDecoderStartPlan(MANIFEST, TARGET_MEDIA_FRAME)).toEqual({
      mediaFrame: 2_049,
      rawTargetCoreFrame: 3_073,
      targetAccessUnitOrdinal: 3,
      coreFrameWithinTargetAccessUnit: 1,
      decodeStartAccessUnitOrdinal: 2,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_025,
    });
    expect(() => createM4aAacDecoderStartPlan(MANIFEST, 4_608)).toThrow(/exclusive media EOF/i);
    expect(() => createM4aAacDecoderStartPlan(MANIFEST, 4_609)).toThrow(/outside/i);
    expect(() => createM4aAacDecoderStartPlan(MANIFEST, -0)).toThrow(/mediaFrame/i);
  });

  it('canonicalizes and deeply detaches the manifest and start plan', () => {
    const candidate = structuredClone(DESCRIPTOR) as M4aAacDecoderDescriptor;
    const parsed = snapshotM4aAacDecoderDescriptor(candidate);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe(candidate);
    expect(parsed?.manifest).not.toBe(candidate.manifest);
    expect(parsed?.startPlan).not.toBe(candidate.startPlan);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.manifest)).toBe(true);
    expect(Object.isFrozen(parsed?.manifest.chunks.runs)).toBe(true);
    expect(Object.isFrozen(parsed?.startPlan)).toBe(true);

    const mutable = candidate.manifest.container.compatibleBrands as string[];
    mutable[0] = 'free';
    expect(parsed?.manifest.container.compatibleBrands[0]).not.toBe('free');
    expect(() => validateM4aAacDecoderDescriptor(candidate)).not.toThrow();
  });

  it('recomputes the plan and rejects every redundant contradiction', () => {
    expect(
      snapshotM4aAacDecoderDescriptor({ ...DESCRIPTOR, sourceSize: DESCRIPTOR.sourceSize + 1 }),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({ ...DESCRIPTOR, sourceIdentity: 'foreign-source' }),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({
        ...DESCRIPTOR,
        transformPrerollPolicyAccessUnits: 0,
      }),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({
        ...DESCRIPTOR,
        startPlan: { ...DESCRIPTOR.startPlan, decodeStartAccessUnitOrdinal: 1 },
      }),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({
        ...DESCRIPTOR,
        startPlan: { ...DESCRIPTOR.startPlan, mediaFrame: TARGET_MEDIA_FRAME + 1 },
      }),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({
        ...DESCRIPTOR,
        manifest: {
          ...DESCRIPTOR.manifest,
          sourceIdentity: 'foreign-manifest-source',
        },
      }),
    ).toBeNull();
  });

  it('rejects accessors, symbols, classes, sparse arrays, and nested extras', () => {
    let accessorCalls = 0;
    const accessor = { ...DESCRIPTOR } as Record<string, unknown>;
    Object.defineProperty(accessor, 'format', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'm4a-aac-lc';
      },
    });
    expect(snapshotM4aAacDecoderDescriptor(accessor)).toBeNull();
    expect(accessorCalls).toBe(0);
    expect(snapshotM4aAacDecoderDescriptor({ ...DESCRIPTOR, [Symbol('extra')]: true })).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor(Object.assign(Object.create({}), DESCRIPTOR)),
    ).toBeNull();
    expect(
      snapshotM4aAacDecoderDescriptor({
        ...DESCRIPTOR,
        startPlan: { ...DESCRIPTOR.startPlan, extra: true },
      }),
    ).toBeNull();

    const sparseManifest = structuredClone(DESCRIPTOR.manifest);
    delete (sparseManifest.container.compatibleBrands as string[])[1];
    expect(snapshotM4aAacDecoderDescriptor({ ...DESCRIPTOR, manifest: sparseManifest })).toBeNull();
  });

  it('compares independently cloned descriptor echoes without trusting identity', () => {
    const clone = structuredClone(DESCRIPTOR);
    expect(sameM4aAacDecoderDescriptor(DESCRIPTOR, clone)).toBe(true);
    expect(
      sameM4aAacDecoderDescriptor(DESCRIPTOR, {
        ...clone,
        outputSampleRateHz: 48_000,
      }),
    ).toBe(false);
    expect(sameM4aAacDecoderDescriptor(DESCRIPTOR, {})).toBe(false);
  });
});

describe('M4A AAC decoder command boundary', () => {
  it('accepts only positive source-lifetime and decoder generations', () => {
    expect(isM4aAacSourceLifetimeGeneration(1)).toBe(true);
    expect(isM4aAacDecoderGeneration(19)).toBe(true);
    expect(isM4aAacSourceLifetimeGeneration(0)).toBe(false);
    expect(isM4aAacDecoderGeneration(1.5)).toBe(false);
  });

  it('parses an exact two-port open command into a detached immutable echo', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const parsed = parseM4aAacDecoderCommand(openCommand(source.port2, pcm.port2));
    expect(parsed).toMatchObject({
      protocolVersion: 1,
      type: 'open-decoder',
      sourceLifetimeGeneration: 7,
      decoderGeneration: 19,
      backendId: 'webcodecs',
    });
    expect(parsed?.type === 'open-decoder' && parsed.sourcePort).toBe(source.port2);
    expect(parsed?.type === 'open-decoder' && parsed.pcmPort).toBe(pcm.port2);
    expect(parsed?.type === 'open-decoder' && parsed.descriptor).not.toBe(DESCRIPTOR);
    expect(Object.isFrozen(parsed)).toBe(true);
    closeChannels(source, pcm);
  });

  it('provides the exact transfer list and survives structured clone', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const command = openCommand(source.port2, pcm.port2);
    const transfer = m4aAacDecoderCommandTransferables(command);
    expect(transfer).toEqual([source.port2, pcm.port2]);

    const cloned = structuredClone(command, { transfer });
    const parsed = parseM4aAacDecoderCommand(cloned);
    expect(parsed?.type).toBe('open-decoder');
    if (parsed?.type === 'open-decoder') {
      parsed.sourcePort.close();
      parsed.pcmPort.close();
    }
    source.port1.close();
    pcm.port1.close();
  });

  it('rejects extras, invalid generations/backends, fake ports, and aliases', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const valid = openCommand(source.port2, pcm.port2);
    expect(parseM4aAacDecoderCommand({ ...valid, extra: true })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, [Symbol('extra')]: true })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, protocolVersion: 2 })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, backendId: 'automatic' })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, sourceLifetimeGeneration: 0 })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, decoderGeneration: 0 })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, sourcePort: {} })).toBeNull();
    expect(parseM4aAacDecoderCommand({ ...valid, pcmPort: source.port2 })).toBeNull();
    closeChannels(source, pcm);
  });

  it('parses the exact no-transfer stop command', () => {
    const stop = {
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 7,
      decoderGeneration: 19,
    } as const;
    expect(parseM4aAacDecoderCommand(stop)).toEqual(stop);
    expect(m4aAacDecoderCommandTransferables(stop)).toEqual([]);
    expect(parseM4aAacDecoderCommand({ ...stop, sourcePort: {} })).toBeNull();
  });
});

describe('M4A AAC decoder event boundary', () => {
  it('parses ready, logical progress, EOF, stopped, and error events', () => {
    const progress = {
      nextAccessUnitOrdinal: 4,
      consumedEncodedBytes: 60,
      decodedRawCoreFrames: 4_096,
      acceptedMediaFrames: 1_024,
      producedOutputFrames: 940,
    } as const;
    const events: readonly M4aAacDecoderEvent[] = [
      {
        ...eventIdentity(),
        type: 'decoder-ready',
        descriptor: DESCRIPTOR,
        backendId: 'webcodecs',
      },
      {
        ...eventIdentity(),
        type: 'decoder-ready',
        descriptor: DESCRIPTOR,
        backendId: 'symphonia-wasm',
      },
      { ...eventIdentity(), type: 'decode-progress', ...progress },
      { ...eventIdentity(), type: 'decoder-eof', ...progress },
      { ...eventIdentity(), type: 'decoder-stopped' },
      { ...eventIdentity(), type: 'decoder-error', code: 'decode-failed', message: 'failed' },
    ];

    for (const event of events) {
      const parsed = parseM4aAacDecoderEvent(event);
      expect(parsed).toEqual(event);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    const ready = parseM4aAacDecoderEvent(events[0]);
    expect(ready?.type === 'decoder-ready' && ready.descriptor).not.toBe(DESCRIPTOR);
  });

  it('rejects physical offsets, bad counters, extras, bad backend, and invalid generations', () => {
    const progress = {
      ...eventIdentity(),
      type: 'decode-progress',
      nextAccessUnitOrdinal: 4,
      consumedEncodedBytes: 60,
      decodedRawCoreFrames: 4_096,
      acceptedMediaFrames: 1_024,
      producedOutputFrames: 940,
    } as const;
    expect(parseM4aAacDecoderEvent({ ...progress, byteOffset: 99 })).toBeNull();
    expect(parseM4aAacDecoderEvent({ ...progress, consumedEncodedBytes: -1 })).toBeNull();
    expect(
      parseM4aAacDecoderEvent({ ...progress, producedOutputFrames: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeNull();
    expect(parseM4aAacDecoderEvent({ ...progress, decoderGeneration: 0 })).toBeNull();
    expect(
      parseM4aAacDecoderEvent({
        ...eventIdentity(),
        type: 'decoder-ready',
        descriptor: DESCRIPTOR,
        backendId: 'unmeasured-backend',
      }),
    ).toBeNull();
  });

  it('enforces bounded non-empty errors and never invokes event accessors', () => {
    const error = {
      ...eventIdentity(),
      type: 'decoder-error',
      code: 'decode-failed',
      message: 'failed',
    } as const;
    expect(
      parseM4aAacDecoderEvent({
        ...error,
        code: 'c'.repeat(M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH),
        message: 'm'.repeat(M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH),
      }),
    ).not.toBeNull();
    expect(parseM4aAacDecoderEvent({ ...error, code: '' })).toBeNull();
    expect(parseM4aAacDecoderEvent({ ...error, message: '' })).toBeNull();

    let calls = 0;
    const accessor = Object.defineProperty(
      { ...eventIdentity(), type: 'decoder-stopped' },
      'type',
      {
        enumerable: true,
        get() {
          calls += 1;
          return 'decoder-stopped';
        },
      },
    );
    expect(parseM4aAacDecoderEvent(accessor)).toBeNull();
    expect(calls).toBe(0);
  });
});
