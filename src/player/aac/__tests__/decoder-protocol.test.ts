import { describe, expect, it } from 'vitest';

import { ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH } from '../../sources/encoded-audio-source.ts';
import { expectedLanczosOutputFrames } from '../../streaming/resampler-plan.ts';
import {
  AAC_CORE_CONFIGURATION_KEYS,
  AAC_CORE_TIMELINE_KEYS,
  AAC_DECODER_DESCRIPTOR_KEYS,
  AAC_DECODER_MAX_ERROR_CODE_LENGTH,
  AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS,
  AAC_DECODER_PROTOCOL_VERSION,
  AAC_DECODER_START_PLAN_KEYS,
  aacDecoderCommandTransferables,
  createAacDecoderStartPlan,
  isAacDecoderGeneration,
  isAacSourceLifetimeGeneration,
  parseAacDecoderCommand,
  parseAacDecoderEvent,
  sameAacDecoderDescriptor,
  snapshotAacDecoderDescriptor,
  validateAacDecoderDescriptor,
  type AacDecoderDescriptor,
  type AacDecoderEvent,
  type AacDecoderOpenCommand,
  type AacDecoderStartPlan,
} from '../decoder-protocol.ts';
import type { AdtsCoreConfiguration } from '../incremental-frame-reader.ts';
import { createAdtsCoreTimeline, type AdtsCoreTimeline } from '../timeline.ts';

const ACCESS_UNIT_BYTES = 20;
const FRAME_COUNT = 10;
const SOURCE_SIZE = FRAME_COUNT * ACCESS_UNIT_BYTES;
const SOURCE_IDENTITY = 'adts-source:0123456789abcdef';
const TARGET_ACCESS_UNIT_ORDINAL = 5;
const TARGET_MEDIA_FRAME = TARGET_ACCESS_UNIT_ORDINAL * 1_024 + 123;

const CORE_CONFIGURATION: Readonly<AdtsCoreConfiguration> = Object.freeze({
  mpegId: 0,
  profile: 1,
  coreAudioObjectType: 2,
  sampleRateIndex: 4,
  channelConfiguration: 2,
  protectionAbsent: true,
  rawDataBlocks: 1,
});
const TIMELINE = createAdtsCoreTimeline(FRAME_COUNT);
const SPARSE_ANCHOR = Object.freeze({
  frameOrdinal: 3,
  byteOffset: 3 * ACCESS_UNIT_BYTES,
});
const START_PLAN = createAacDecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, SPARSE_ANCHOR);

interface DescriptorOptions {
  readonly patch?: Record<string, unknown>;
  readonly configurationPatch?: Record<string, unknown>;
  readonly timelinePatch?: Record<string, unknown>;
  readonly startPatch?: Record<string, unknown>;
}

function descriptor(options: DescriptorOptions = {}): AacDecoderDescriptor {
  const coreConfiguration = Object.freeze({
    ...CORE_CONFIGURATION,
    ...options.configurationPatch,
  }) as AdtsCoreConfiguration;
  const timeline = Object.freeze({
    ...TIMELINE,
    ...options.timelinePatch,
  }) as AdtsCoreTimeline;
  const startPlan = Object.freeze({
    ...START_PLAN,
    ...options.startPatch,
  }) as AacDecoderStartPlan;
  return Object.freeze({
    format: 'aac-adts' as const,
    sourceSize: SOURCE_SIZE,
    sourceIdentity: SOURCE_IDENTITY,
    audioStartByte: 0,
    coreConfiguration,
    coreSampleRateHz: 44_100,
    outputSampleRateHz: 48_000,
    channels: 2 as const,
    frameCount: FRAME_COUNT,
    audioEndByteOffset: SOURCE_SIZE,
    timeline,
    startPlan,
    ...options.patch,
  }) as AacDecoderDescriptor;
}

const DESCRIPTOR = descriptor();
const EXPECTED_OUTPUT_FRAMES = expectedLanczosOutputFrames({
  inputSampleRate: DESCRIPTOR.coreSampleRateHz,
  outputSampleRate: DESCRIPTOR.outputSampleRateHz,
  totalSourceFrames: DESCRIPTOR.timeline.totalMediaFrames,
  startSourceFrame: DESCRIPTOR.startPlan.mediaFrame,
});

function openCommand(
  sourcePort: MessagePort,
  pcmPort: MessagePort,
  value: AacDecoderDescriptor = DESCRIPTOR,
): AacDecoderOpenCommand {
  return {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 11,
    decoderGeneration: 29,
    backendId: 'webcodecs',
    descriptor: value,
    sourcePort,
    pcmPort,
  };
}

function eventIdentity() {
  return {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    sourceLifetimeGeneration: 11,
    decoderGeneration: 29,
  } as const;
}

function closeChannels(...channels: MessageChannel[]): void {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
}

describe('AAC decoder start planning', () => {
  it('publishes stable exact-key wire shapes', () => {
    expect(AAC_CORE_CONFIGURATION_KEYS).toHaveLength(7);
    expect(AAC_CORE_TIMELINE_KEYS).toHaveLength(3);
    expect(AAC_DECODER_START_PLAN_KEYS).toHaveLength(8);
    expect(AAC_DECODER_DESCRIPTOR_KEYS).toHaveLength(12);
  });

  it('uses one transform AU of preroll by default with an earlier sparse anchor', () => {
    expect(START_PLAN).toEqual({
      mediaFrame: TARGET_MEDIA_FRAME,
      coreFrame: TARGET_MEDIA_FRAME,
      accessUnitOrdinal: TARGET_ACCESS_UNIT_ORDINAL,
      coreFrameWithinAccessUnit: 123,
      scanAnchorByteOffset: 3 * ACCESS_UNIT_BYTES,
      scanAnchorAccessUnitOrdinal: 3,
      decodeStartAccessUnitOrdinal: 4,
      discardCoreFrames: 1_024 + 123,
    });
  });

  it('clamps the default preroll at origin and preserves an exact within-AU discard', () => {
    const plan = createAacDecoderStartPlan(TIMELINE, 77, { frameOrdinal: 0, byteOffset: 0 });
    expect(plan).toEqual({
      mediaFrame: 77,
      coreFrame: 77,
      accessUnitOrdinal: 0,
      coreFrameWithinAccessUnit: 77,
      scanAnchorByteOffset: 0,
      scanAnchorAccessUnitOrdinal: 0,
      decodeStartAccessUnitOrdinal: 0,
      discardCoreFrames: 77,
    });
  });

  it('allows a bounded future preroll policy without changing the wire shape', () => {
    const noPreroll = createAacDecoderStartPlan(
      TIMELINE,
      TARGET_MEDIA_FRAME,
      { frameOrdinal: 5, byteOffset: 5 * ACCESS_UNIT_BYTES },
      { prerollAccessUnits: 0 },
    );
    expect(noPreroll.decodeStartAccessUnitOrdinal).toBe(5);
    expect(noPreroll.discardCoreFrames).toBe(123);

    const bounded = createAacDecoderStartPlan(
      TIMELINE,
      TARGET_MEDIA_FRAME,
      { frameOrdinal: 0, byteOffset: 0 },
      { prerollAccessUnits: AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS },
    );
    expect(bounded.decodeStartAccessUnitOrdinal).toBe(0);
    expect(bounded.discardCoreFrames).toBe(TARGET_MEDIA_FRAME);
  });

  it('rejects EOF, late or forged anchors, and noncanonical preroll options', () => {
    expect(() =>
      createAacDecoderStartPlan(TIMELINE, TIMELINE.totalMediaFrames, {
        frameOrdinal: 0,
        byteOffset: 0,
      }),
    ).toThrow(/exclusive media EOF/i);
    expect(() =>
      createAacDecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, {
        frameOrdinal: 5,
        byteOffset: 5 * ACCESS_UNIT_BYTES,
      }),
    ).toThrow(/after the selected decode start/i);
    expect(() =>
      createAacDecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, { frameOrdinal: 3, byteOffset: 1 }),
    ).toThrow(/byte offset/i);
    expect(() =>
      createAacDecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, SPARSE_ANCHOR, {
        prerollAccessUnits: AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS + 1,
      }),
    ).toThrow(/prerollAccessUnits/i);
    expect(() =>
      createAacDecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, SPARSE_ANCHOR, {
        extra: true,
      } as never),
    ).toThrow(/only prerollAccessUnits/i);
  });
});

describe('AAC decoder descriptor boundary', () => {
  it('snapshots and deeply freezes one self-consistent raw ADTS descriptor', () => {
    expect(() => validateAacDecoderDescriptor(DESCRIPTOR)).not.toThrow();
    const parsed = snapshotAacDecoderDescriptor(DESCRIPTOR);
    expect(parsed).toEqual(DESCRIPTOR);
    expect(parsed).not.toBe(DESCRIPTOR);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(parsed?.timeline)).toBe(true);
    expect(Object.isFrozen(parsed?.startPlan)).toBe(true);
    expect(sameAacDecoderDescriptor(parsed, DESCRIPTOR)).toBe(true);
    expect(
      sameAacDecoderDescriptor(parsed, descriptor({ patch: { outputSampleRateHz: 44_100 } })),
    ).toBe(false);
  });

  it('accepts ordered backend-policy starts without fixing the wire contract to one AU', () => {
    const noPreroll = createAacDecoderStartPlan(
      TIMELINE,
      TARGET_MEDIA_FRAME,
      { frameOrdinal: 5, byteOffset: 5 * ACCESS_UNIT_BYTES },
      { prerollAccessUnits: 0 },
    );
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({ startPatch: noPreroll as unknown as Record<string, unknown> }),
      ),
    ).not.toBeNull();

    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          startPatch: {
            scanAnchorByteOffset: 0,
            scanAnchorAccessUnitOrdinal: 0,
            decodeStartAccessUnitOrdinal: 2,
            discardCoreFrames: 3 * 1_024 + 123,
          },
        }),
      ),
    ).not.toBeNull();
  });

  it('keeps generic backend preroll within the protocol ceiling', () => {
    const targetOrdinal = AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS + 1;
    const targetFrame = targetOrdinal * 1_024;
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          startPatch: {
            mediaFrame: targetFrame,
            coreFrame: targetFrame,
            accessUnitOrdinal: targetOrdinal,
            coreFrameWithinAccessUnit: 0,
            scanAnchorByteOffset: 0,
            scanAnchorAccessUnitOrdinal: 0,
            decodeStartAccessUnitOrdinal: 0,
            discardCoreFrames: targetFrame,
          },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['empty identity', { patch: { sourceIdentity: '' } }],
    [
      'oversized identity',
      { patch: { sourceIdentity: 'x'.repeat(ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH + 1) } },
    ],
    ['non MPEG-4 config', { configurationPatch: { mpegId: 1 } }],
    ['non AAC-LC config', { configurationPatch: { profile: 0, coreAudioObjectType: 1 } }],
    ['CRC config', { configurationPatch: { protectionAbsent: false } }],
    ['wrong rate for index', { patch: { coreSampleRateHz: 48_000 } }],
    ['wrong channels for config', { patch: { channels: 1 } }],
    [
      'excessive output rate',
      { patch: { outputSampleRateHz: AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ + 1 } },
    ],
    ['audio span before EOF', { patch: { audioEndByteOffset: SOURCE_SIZE - 1 } }],
    ['frame count mismatch', { patch: { frameCount: FRAME_COUNT - 1 } }],
    ['timeline total mismatch', { timelinePatch: { totalMediaFrames: 1_024 } }],
    ['target core mismatch', { startPatch: { coreFrame: TARGET_MEDIA_FRAME + 1 } }],
    ['target AU mismatch', { startPatch: { accessUnitOrdinal: 4 } }],
    ['target within-AU mismatch', { startPatch: { coreFrameWithinAccessUnit: 122 } }],
    ['decode start after target', { startPatch: { decodeStartAccessUnitOrdinal: 6 } }],
    ['anchor after decode start', { startPatch: { scanAnchorAccessUnitOrdinal: 5 } }],
    ['wrong exact discard', { startPatch: { discardCoreFrames: 123 } }],
    ['forged anchor byte', { startPatch: { scanAnchorByteOffset: 23 } }],
  ])('rejects descriptor contradiction: %s', (_label, options) => {
    expect(snapshotAacDecoderDescriptor(descriptor(options))).toBeNull();
  });

  it('checks both minimum and maximum ADTS access-unit span geometry safely', () => {
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          patch: { sourceSize: FRAME_COUNT * 8, audioEndByteOffset: FRAME_COUNT * 8 },
          startPatch: { scanAnchorByteOffset: SPARSE_ANCHOR.frameOrdinal * 8 },
        }),
      ),
    ).not.toBeNull();
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          patch: {
            sourceSize: FRAME_COUNT * 8_191,
            audioEndByteOffset: FRAME_COUNT * 8_191,
          },
          startPatch: { scanAnchorByteOffset: SPARSE_ANCHOR.frameOrdinal * 8_191 },
        }),
      ),
    ).not.toBeNull();
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          patch: { sourceSize: FRAME_COUNT * 8 - 1, audioEndByteOffset: FRAME_COUNT * 8 - 1 },
        }),
      ),
    ).toBeNull();
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          patch: {
            sourceSize: FRAME_COUNT * 8_191 + 1,
            audioEndByteOffset: FRAME_COUNT * 8_191 + 1,
          },
        }),
      ),
    ).toBeNull();

    const maximumTimeline = createAdtsCoreTimeline(Math.floor(Number.MAX_SAFE_INTEGER / 1_024));
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          patch: {
            sourceSize: Number.MAX_SAFE_INTEGER,
            audioEndByteOffset: Number.MAX_SAFE_INTEGER,
            frameCount: maximumTimeline.frameCount,
          },
          timelinePatch: maximumTimeline as unknown as Record<string, unknown>,
          startPatch: {
            mediaFrame: 0,
            coreFrame: 0,
            accessUnitOrdinal: 0,
            coreFrameWithinAccessUnit: 0,
            scanAnchorByteOffset: 0,
            scanAnchorAccessUnitOrdinal: 0,
            decodeStartAccessUnitOrdinal: 0,
            discardCoreFrames: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects exclusive EOF even when all target coordinates are forged consistently', () => {
    expect(
      snapshotAacDecoderDescriptor(
        descriptor({
          startPatch: {
            mediaFrame: TIMELINE.totalMediaFrames,
            coreFrame: TIMELINE.totalMediaFrames,
            accessUnitOrdinal: FRAME_COUNT,
            coreFrameWithinAccessUnit: 0,
            decodeStartAccessUnitOrdinal: FRAME_COUNT - 1,
            discardCoreFrames: 1_024,
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects extras, symbols, accessors, wrong prototypes, and nested near-misses', () => {
    expect(snapshotAacDecoderDescriptor({ ...DESCRIPTOR, extra: true })).toBeNull();
    expect(snapshotAacDecoderDescriptor({ ...DESCRIPTOR, [Symbol('extra')]: true })).toBeNull();

    let accessorCalls = 0;
    const accessor = { ...DESCRIPTOR } as Record<string, unknown>;
    Object.defineProperty(accessor, 'format', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'aac-adts';
      },
    });
    expect(snapshotAacDecoderDescriptor(accessor)).toBeNull();
    expect(accessorCalls).toBe(0);

    expect(snapshotAacDecoderDescriptor(Object.assign(Object.create({}), DESCRIPTOR))).toBeNull();
    expect(
      snapshotAacDecoderDescriptor(descriptor({ configurationPatch: { extra: true } })),
    ).toBeNull();
    expect(snapshotAacDecoderDescriptor(descriptor({ timelinePatch: { extra: true } }))).toBeNull();
    expect(snapshotAacDecoderDescriptor(descriptor({ startPatch: { extra: true } }))).toBeNull();
  });

  it('uses one coherent reflection snapshot under reentrant proxy mutation', () => {
    const backing = { ...DESCRIPTOR } as Record<string, unknown>;
    const proxy = new Proxy(backing, {
      ownKeys(target) {
        target.sourceIdentity = 'adts-source:reentrant-snapshot';
        return Reflect.ownKeys(target);
      },
    });
    const parsed = snapshotAacDecoderDescriptor(proxy);
    expect(parsed?.sourceIdentity).toBe('adts-source:reentrant-snapshot');
    backing.sourceIdentity = 'adts-source:mutated-later';
    expect(parsed?.sourceIdentity).toBe('adts-source:reentrant-snapshot');
  });
});

describe('AAC decoder command boundary', () => {
  it('recognizes only positive generation identities', () => {
    expect(isAacSourceLifetimeGeneration(1)).toBe(true);
    expect(isAacDecoderGeneration(29)).toBe(true);
    expect(isAacSourceLifetimeGeneration(0)).toBe(false);
    expect(isAacDecoderGeneration(1.5)).toBe(false);
  });

  it('parses an exact two-port open command into an immutable descriptor snapshot', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const parsed = parseAacDecoderCommand(openCommand(source.port2, pcm.port2));
    expect(parsed).toMatchObject({
      protocolVersion: 1,
      type: 'open-decoder',
      sourceLifetimeGeneration: 11,
      decoderGeneration: 29,
      backendId: 'webcodecs',
    });
    expect(parsed?.type === 'open-decoder' && parsed.sourcePort).toBe(source.port2);
    expect(parsed?.type === 'open-decoder' && parsed.pcmPort).toBe(pcm.port2);
    expect(parsed?.type === 'open-decoder' && parsed.descriptor).not.toBe(DESCRIPTOR);
    expect(Object.isFrozen(parsed)).toBe(true);
    closeChannels(source, pcm);
  });

  it('provides the exact transfer list and survives a structured-clone handoff', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const command = openCommand(source.port2, pcm.port2);
    const transfer = aacDecoderCommandTransferables(command);
    expect(transfer).toEqual([source.port2, pcm.port2]);

    const cloned = structuredClone(command, { transfer });
    const parsed = parseAacDecoderCommand(cloned);
    expect(parsed?.type).toBe('open-decoder');
    if (parsed?.type === 'open-decoder') {
      expect(parsed.sourcePort).toBeInstanceOf(MessagePort);
      expect(parsed.pcmPort).toBeInstanceOf(MessagePort);
      parsed.sourcePort.close();
      parsed.pcmPort.close();
    }
    source.port1.close();
    pcm.port1.close();
  });

  it('rejects noncanonical commands, invalid generations, and fake or aliased ports', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const valid = openCommand(source.port2, pcm.port2);
    expect(parseAacDecoderCommand({ ...valid, extra: true })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, [Symbol('extra')]: true })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, protocolVersion: 2 })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, backendId: 'automatic' })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, sourceLifetimeGeneration: 0 })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, decoderGeneration: 0 })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, decoderGeneration: 11 })).not.toBeNull();
    expect(parseAacDecoderCommand({ ...valid, sourcePort: {} })).toBeNull();
    expect(parseAacDecoderCommand({ ...valid, pcmPort: source.port2 })).toBeNull();

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'type', {
      enumerable: true,
      get: () => 'open-decoder',
    });
    expect(parseAacDecoderCommand(accessor)).toBeNull();
    expect(parseAacDecoderCommand(Object.assign(Object.create({}), valid))).toBeNull();
    closeChannels(source, pcm);
  });

  it('parses the exact non-transfer stop command', () => {
    const stop = {
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 11,
      decoderGeneration: 29,
    } as const;
    expect(parseAacDecoderCommand(stop)).toEqual(stop);
    expect(aacDecoderCommandTransferables(stop)).toEqual([]);
    expect(parseAacDecoderCommand({ ...stop, sourcePort: {} })).toBeNull();
    expect(parseAacDecoderCommand({ ...stop, decoderGeneration: 11 })).toEqual({
      ...stop,
      decoderGeneration: 11,
    });
  });
});

describe('AAC decoder event boundary', () => {
  it('parses every admitted event and both explicit backend identities', () => {
    const events: readonly AacDecoderEvent[] = [
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
      {
        ...eventIdentity(),
        type: 'decode-progress',
        decodedInputBytes: 100,
        decodedCoreFrames: 5_120,
        producedOutputFrames: 0,
      },
      {
        ...eventIdentity(),
        type: 'decoder-eof',
        decodedInputBytes: SOURCE_SIZE,
        decodedCoreFrames: TIMELINE.totalMediaFrames,
        producedOutputFrames: EXPECTED_OUTPUT_FRAMES,
      },
      { ...eventIdentity(), type: 'decoder-stopped' },
      { ...eventIdentity(), type: 'decoder-error', code: 'decode-failed', message: 'failed' },
    ];

    for (const event of events) {
      const parsed = parseAacDecoderEvent(event);
      expect(parsed).toEqual(event);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    const ready = parseAacDecoderEvent(events[0]);
    expect(ready?.type === 'decoder-ready' && ready.descriptor).not.toBe(DESCRIPTOR);
  });

  it('rejects unknown events, backend drift, bad counters, extras, and invalid generations', () => {
    const progress = {
      ...eventIdentity(),
      type: 'decode-progress',
      decodedInputBytes: 100,
      decodedCoreFrames: 1_024,
      producedOutputFrames: 1_114,
    } as const;
    expect(parseAacDecoderEvent({ ...progress, decodedCoreFrames: -1 })).toBeNull();
    expect(
      parseAacDecoderEvent({ ...progress, decodedInputBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeNull();
    expect(parseAacDecoderEvent({ ...progress, extra: true })).toBeNull();
    expect(parseAacDecoderEvent({ ...progress, decoderGeneration: 0 })).toBeNull();
    expect(parseAacDecoderEvent({ ...progress, decoderGeneration: 11 })).toEqual({
      ...progress,
      decoderGeneration: 11,
    });
    expect(parseAacDecoderEvent({ ...eventIdentity(), type: 'frame-index-point' })).toBeNull();
    expect(
      parseAacDecoderEvent({
        ...eventIdentity(),
        type: 'decoder-ready',
        descriptor: DESCRIPTOR,
        backendId: 'unmeasured-backend',
      }),
    ).toBeNull();
  });

  it('enforces non-empty bounded decoder error fields', () => {
    const error = {
      ...eventIdentity(),
      type: 'decoder-error',
      code: 'decode-failed',
      message: 'failed',
    } as const;
    expect(
      parseAacDecoderEvent({
        ...error,
        code: 'c'.repeat(AAC_DECODER_MAX_ERROR_CODE_LENGTH),
        message: 'm'.repeat(AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH),
      }),
    ).not.toBeNull();
    expect(parseAacDecoderEvent({ ...error, code: '' })).toBeNull();
    expect(parseAacDecoderEvent({ ...error, message: '' })).toBeNull();
    expect(
      parseAacDecoderEvent({
        ...error,
        code: 'x'.repeat(AAC_DECODER_MAX_ERROR_CODE_LENGTH + 1),
      }),
    ).toBeNull();
    expect(
      parseAacDecoderEvent({
        ...error,
        message: 'x'.repeat(AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH + 1),
      }),
    ).toBeNull();
  });

  it('rejects event accessors and non-plain prototypes without invoking application getters', () => {
    let calls = 0;
    const accessor = Object.defineProperty(
      {
        ...eventIdentity(),
        type: 'decoder-stopped',
      },
      'type',
      {
        enumerable: true,
        get() {
          calls += 1;
          return 'decoder-stopped';
        },
      },
    );
    expect(parseAacDecoderEvent(accessor)).toBeNull();
    expect(calls).toBe(0);
    expect(
      parseAacDecoderEvent(
        Object.assign(Object.create({ inherited: true }), {
          ...eventIdentity(),
          type: 'decoder-stopped',
        }),
      ),
    ).toBeNull();
  });
});
