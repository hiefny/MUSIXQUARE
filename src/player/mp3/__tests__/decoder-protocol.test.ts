import { describe, expect, it } from 'vitest';

import { ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH } from '../../sources/encoded-audio-source.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmSupplyMessage,
} from '../../streaming/pcm-stream-protocol.ts';
import {
  MP3_DECODER_DESCRIPTOR_KEYS,
  MP3_DECODER_MAX_ERROR_CODE_LENGTH,
  MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS,
  MP3_DECODER_PROTOCOL_VERSION,
  MP3_DECODER_START_PLAN_KEYS,
  MP3_SAMPLE_TIMELINE_KEYS,
  createMp3DecoderStartPlan,
  isMp3DecoderGeneration,
  isMp3SourceLifetimeGeneration,
  isMp3SourceSize,
  mp3DecoderCommandTransferables,
  mp3FrameIndexPointFromEvent,
  parseMp3DecoderCommand,
  parseMp3DecoderEvent,
  sameMp3DecoderDescriptor,
  snapshotMp3DecoderDescriptor,
  validateMp3DecoderDescriptor,
  type Mp3DecoderDescriptor,
  type Mp3DecoderEvent,
  type Mp3DecoderOpenCommand,
  type Mp3DecoderStartPlan,
} from '../decoder-protocol.ts';
import { MpegLayer3SeekIndex, type MpegLayer3ReservoirPrelude } from '../seek-index.ts';
import { createMp3SampleTimeline, type Mp3SampleTimeline } from '../timeline.ts';

const SAMPLES_PER_FRAME = 1_152 as const;
const FRAME_BYTES = 417;
const MAIN_DATA_CAPACITY_BYTES = 381;
const AUDIO_FRAME_COUNT = 100;
const FIRST_AUDIO_FRAME_OFFSET = 1_000;
const AUDIO_END_BYTE_OFFSET = FIRST_AUDIO_FRAME_OFFSET + FRAME_BYTES * AUDIO_FRAME_COUNT;
const SOURCE_SIZE = AUDIO_END_BYTE_OFFSET + 1_300;
const TARGET_FRAME_ORDINAL = 5;
const TARGET_MEDIA_FRAME = TARGET_FRAME_ORDINAL * SAMPLES_PER_FRAME + 123;
const SOURCE_IDENTITY = 'mp3-source:0123456789abcdef';

const TIMELINE = createMp3SampleTimeline({
  totalRawSamples: AUDIO_FRAME_COUNT * SAMPLES_PER_FRAME,
  samplesPerFrame: SAMPLES_PER_FRAME,
  gapless: null,
});

function point(frameOrdinal: number, mainDataBeginBytes = 0) {
  return Object.freeze({
    rawSample: frameOrdinal * SAMPLES_PER_FRAME,
    byteOffset: FIRST_AUDIO_FRAME_OFFSET + frameOrdinal * FRAME_BYTES,
    frameOrdinal,
    mainDataCapacityBytes: MAIN_DATA_CAPACITY_BYTES,
    mainDataBeginBytes,
  });
}

function indexThrough(lastFrameOrdinal: number): MpegLayer3SeekIndex {
  const index = new MpegLayer3SeekIndex({
    sourceSize: SOURCE_SIZE,
    firstAudioFrameOffset: FIRST_AUDIO_FRAME_OFFSET,
    audioEndByteOffset: AUDIO_END_BYTE_OFFSET,
    totalRawSamples: AUDIO_FRAME_COUNT * SAMPLES_PER_FRAME,
    samplesPerFrame: SAMPLES_PER_FRAME,
    firstFrameMainDataCapacityBytes: MAIN_DATA_CAPACITY_BYTES,
    firstFrameMainDataBeginBytes: 0,
  });
  for (let frameOrdinal = 1; frameOrdinal <= lastFrameOrdinal; frameOrdinal += 1) {
    const value = point(frameOrdinal);
    expect(
      index.addVerifiedFrame(
        value.rawSample,
        value.byteOffset,
        value.frameOrdinal,
        value.mainDataCapacityBytes,
        value.mainDataBeginBytes,
      ),
    ).toBe(true);
  }
  return index;
}

const SCAN_PRELUDE = indexThrough(0).reservoirPrelude(TARGET_FRAME_ORDINAL * SAMPLES_PER_FRAME, 2);
const START_PLAN = createMp3DecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, SCAN_PRELUDE);

function descriptor(
  options: {
    readonly patch?: Record<string, unknown>;
    readonly timelinePatch?: Record<string, unknown>;
    readonly startPatch?: Record<string, unknown>;
  } = {},
): Mp3DecoderDescriptor {
  const timeline = Object.freeze({
    ...TIMELINE,
    ...options.timelinePatch,
  }) as Mp3SampleTimeline;
  const startPlan = Object.freeze({
    ...START_PLAN,
    ...options.startPatch,
  }) as Mp3DecoderStartPlan;
  return Object.freeze({
    format: 'mp3' as const,
    sourceSize: SOURCE_SIZE,
    sourceIdentity: SOURCE_IDENTITY,
    version: '1' as const,
    sourceSampleRate: 44_100,
    outputSampleRate: 48_000,
    channels: 2 as const,
    samplesPerFrame: SAMPLES_PER_FRAME,
    firstAudioFrameOffset: FIRST_AUDIO_FRAME_OFFSET,
    audioEndByteOffset: AUDIO_END_BYTE_OFFSET,
    audioFrameCount: AUDIO_FRAME_COUNT,
    timeline,
    startPlan,
    ...options.patch,
  }) as Mp3DecoderDescriptor;
}

const DESCRIPTOR = descriptor();

function openCommand(
  sourcePort: MessagePort,
  pcmPort: MessagePort,
  value: Mp3DecoderDescriptor = DESCRIPTOR,
): Mp3DecoderOpenCommand {
  return {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 11,
    decoderGeneration: 29,
    descriptor: value,
    sourcePort,
    pcmPort,
  };
}

function eventIdentity() {
  return {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
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

describe('MP3 decoder protocol', () => {
  it('keeps codec control separate while reusing the common PCM supply protocol', () => {
    expect(MP3_DECODER_PROTOCOL_VERSION).toBe(2);
    expect(PCM_STREAM_PROTOCOL_VERSION).toBe(3);
    expect(MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS).toBe(8_192);

    const supply: PcmSupplyMessage = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: 29,
    };
    expect(supply).toEqual({ protocolVersion: 3, type: 'eof', generation: 29 });
  });

  it.each([
    [1, true],
    [Number.MAX_SAFE_INTEGER, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    ['1', false],
  ])('validates both generation axes without coercing %p', (value, expected) => {
    expect(isMp3SourceLifetimeGeneration(value)).toBe(expected);
    expect(isMp3DecoderGeneration(value)).toBe(expected);
  });

  it.each([
    [1, true],
    [5 * 1_024 * 1_024 * 1_024, true],
    [0, false],
    [-1, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])('validates non-empty encoded source size %p', (value, expected) => {
    expect(isMp3SourceSize(value)).toBe(expected);
  });

  it('uses exact stable key sets for all nested descriptor records', () => {
    expect(MP3_DECODER_DESCRIPTOR_KEYS).toEqual([
      'format',
      'sourceSize',
      'sourceIdentity',
      'version',
      'sourceSampleRate',
      'outputSampleRate',
      'channels',
      'samplesPerFrame',
      'firstAudioFrameOffset',
      'audioEndByteOffset',
      'audioFrameCount',
      'timeline',
      'startPlan',
    ]);
    expect(MP3_SAMPLE_TIMELINE_KEYS).toHaveLength(6);
    expect(MP3_DECODER_START_PLAN_KEYS).toHaveLength(8);
  });

  it('collapses sparse and verified reservoir plans into one bounded worker scan plan', () => {
    expect(START_PLAN).toEqual({
      mediaFrame: TARGET_MEDIA_FRAME,
      rawSample: TARGET_MEDIA_FRAME,
      audioFrameOrdinal: TARGET_FRAME_ORDINAL,
      sampleWithinAudioFrame: 123,
      scanAnchorByteOffset: FIRST_AUDIO_FRAME_OFFSET,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: 2,
      historyFrameLimit: 5,
    });

    const verifiedPrelude = indexThrough(TARGET_FRAME_ORDINAL).reservoirPrelude(
      TARGET_FRAME_ORDINAL * SAMPLES_PER_FRAME,
      2,
    );
    expect(verifiedPrelude.kind).toBe('verified-history');
    expect(createMp3DecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, verifiedPrelude)).toEqual({
      mediaFrame: TARGET_MEDIA_FRAME,
      rawSample: TARGET_MEDIA_FRAME,
      audioFrameOrdinal: TARGET_FRAME_ORDINAL,
      sampleWithinAudioFrame: 123,
      scanAnchorByteOffset: FIRST_AUDIO_FRAME_OFFSET + 3 * FRAME_BYTES,
      scanAnchorFrameOrdinal: 3,
      minimumWarmupFrames: 2,
      historyFrameLimit: 2,
    });
  });

  it('clamps verified warmup to the available origin history', () => {
    const originIndex = indexThrough(2);
    const originPrelude = originIndex.reservoirPrelude(0);
    const originPlan = createMp3DecoderStartPlan(TIMELINE, 0, originPrelude);
    expect(originPlan).toMatchObject({
      audioFrameOrdinal: 0,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: 0,
      historyFrameLimit: 0,
    });
    expect(
      snapshotMp3DecoderDescriptor(descriptor({ startPatch: { ...originPlan } })),
    ).not.toBeNull();

    const earlyMediaFrame = 2 * SAMPLES_PER_FRAME;
    const earlyPrelude = originIndex.reservoirPrelude(earlyMediaFrame);
    expect(createMp3DecoderStartPlan(TIMELINE, earlyMediaFrame, earlyPrelude)).toMatchObject({
      audioFrameOrdinal: 2,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: 2,
      historyFrameLimit: 2,
    });
  });

  it('rejects EOF and forged reservoir targets before a Worker realm is opened', () => {
    expect(() =>
      createMp3DecoderStartPlan(TIMELINE, TIMELINE.totalMediaFrames, SCAN_PRELUDE),
    ).toThrow(/exclusive media EOF/i);

    const forged = {
      ...SCAN_PRELUDE,
      targetFrameOrdinal: TARGET_FRAME_ORDINAL - 1,
    } as MpegLayer3ReservoirPrelude;
    expect(() => createMp3DecoderStartPlan(TIMELINE, TARGET_MEDIA_FRAME, forged)).toThrow(
      /different media frame/i,
    );
  });

  it('snapshots and freezes one self-consistent source-bound descriptor', () => {
    expect(() => validateMp3DecoderDescriptor(DESCRIPTOR)).not.toThrow();
    const parsed = snapshotMp3DecoderDescriptor(DESCRIPTOR);
    expect(parsed).toEqual(DESCRIPTOR);
    expect(parsed).not.toBe(DESCRIPTOR);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.timeline)).toBe(true);
    expect(Object.isFrozen(parsed?.startPlan)).toBe(true);
    expect(sameMp3DecoderDescriptor(parsed, DESCRIPTOR)).toBe(true);
    expect(sameMp3DecoderDescriptor(parsed, descriptor({ startPatch: { mediaFrame: 1 } }))).toBe(
      false,
    );
  });

  it.each([
    ['empty identity', { patch: { sourceIdentity: '' } }],
    [
      'oversized identity',
      { patch: { sourceIdentity: 'x'.repeat(ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH + 1) } },
    ],
    ['wrong MPEG rate', { patch: { sourceSampleRate: 22_050 } }],
    ['wrong MPEG frame size', { patch: { samplesPerFrame: 576 } }],
    ['too many channels', { patch: { channels: 3 } }],
    [
      'excessive output rate',
      { patch: { outputSampleRate: MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ + 1 } },
    ],
    ['source smaller than audio', { patch: { sourceSize: AUDIO_END_BYTE_OFFSET - 1 } }],
    ['empty audio span', { patch: { firstAudioFrameOffset: AUDIO_END_BYTE_OFFSET } }],
    ['frame count mismatch', { patch: { audioFrameCount: AUDIO_FRAME_COUNT + 1 } }],
    ['timeline raw mismatch', { timelinePatch: { totalRawSamples: 1_152 } }],
    ['timeline trim mismatch', { timelinePatch: { rawEofSampleExclusive: 50 } }],
    ['target raw mismatch', { startPatch: { rawSample: TARGET_MEDIA_FRAME + 1 } }],
    ['target ordinal mismatch', { startPatch: { audioFrameOrdinal: 4 } }],
    ['history beyond target', { startPatch: { historyFrameLimit: TARGET_FRAME_ORDINAL + 1 } }],
    ['anchor after history window', { startPatch: { scanAnchorFrameOrdinal: 1 } }],
    ['anchor byte mismatch', { startPatch: { scanAnchorByteOffset: 2_000 } }],
  ])('rejects descriptor contradiction: %s', (_label, options) => {
    expect(snapshotMp3DecoderDescriptor(descriptor(options))).toBeNull();
  });

  it('rejects the exclusive EOF even when all supplied target fields match it', () => {
    expect(
      snapshotMp3DecoderDescriptor(
        descriptor({
          startPatch: {
            mediaFrame: TIMELINE.totalMediaFrames,
            rawSample: TIMELINE.totalRawSamples,
            audioFrameOrdinal: AUDIO_FRAME_COUNT,
            sampleWithinAudioFrame: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects extras, symbols, accessors, wrong prototypes, and nested near-misses', () => {
    expect(snapshotMp3DecoderDescriptor({ ...DESCRIPTOR, extra: true })).toBeNull();
    expect(snapshotMp3DecoderDescriptor({ ...DESCRIPTOR, [Symbol('extra')]: true })).toBeNull();

    const accessor = { ...DESCRIPTOR } as Record<string, unknown>;
    Object.defineProperty(accessor, 'format', { enumerable: true, get: () => 'mp3' });
    expect(snapshotMp3DecoderDescriptor(accessor)).toBeNull();

    const wrongPrototype = Object.assign(Object.create({ inherited: true }), DESCRIPTOR);
    expect(snapshotMp3DecoderDescriptor(wrongPrototype)).toBeNull();
    expect(snapshotMp3DecoderDescriptor(descriptor({ timelinePatch: { extra: true } }))).toBeNull();
    expect(snapshotMp3DecoderDescriptor(descriptor({ startPatch: { extra: true } }))).toBeNull();
  });

  it('strictly parses the atomic two-port open command and immutable descriptor snapshot', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const parsed = parseMp3DecoderCommand(openCommand(source.port2, pcm.port2));
    expect(parsed).toMatchObject({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'open-decoder',
      sourceLifetimeGeneration: 11,
      decoderGeneration: 29,
    });
    expect(parsed?.type === 'open-decoder' && parsed.sourcePort).toBe(source.port2);
    expect(parsed?.type === 'open-decoder' && parsed.pcmPort).toBe(pcm.port2);
    expect(parsed?.type === 'open-decoder' && parsed.descriptor).not.toBe(DESCRIPTOR);
    expect(Object.isFrozen(parsed)).toBe(true);
    closeChannels(source, pcm);
  });

  it('provides the exact transfer list and survives a real structured-clone handoff', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const command = openCommand(source.port2, pcm.port2);
    const transfer = mp3DecoderCommandTransferables(command);
    expect(transfer).toEqual([source.port2, pcm.port2]);

    const cloned = structuredClone(command, { transfer });
    const parsed = parseMp3DecoderCommand(cloned);
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

  it('rejects noncanonical commands, bad generations, and fake or aliased ports', () => {
    const source = new MessageChannel();
    const pcm = new MessageChannel();
    const valid = openCommand(source.port2, pcm.port2);
    expect(parseMp3DecoderCommand({ ...valid, extra: true })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, [Symbol('extra')]: true })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, protocolVersion: 1 })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, sourceLifetimeGeneration: 0 })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, decoderGeneration: 1.5 })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, sourcePort: {} })).toBeNull();
    expect(parseMp3DecoderCommand({ ...valid, pcmPort: source.port2 })).toBeNull();

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'type', {
      enumerable: true,
      get: () => 'open-decoder',
    });
    expect(parseMp3DecoderCommand(accessor)).toBeNull();
    expect(parseMp3DecoderCommand(Object.assign(Object.create({}), valid))).toBeNull();
    closeChannels(source, pcm);
  });

  it('parses the only non-transfer command with its exact shape', () => {
    const stop = {
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 11,
      decoderGeneration: 29,
    } as const;
    expect(parseMp3DecoderCommand(stop)).toEqual(stop);
    expect(mp3DecoderCommandTransferables(stop)).toEqual([]);
    expect(parseMp3DecoderCommand({ ...stop, sourcePort: {} })).toBeNull();
  });

  it('parses only the needed ready, progress, EOF, stop, error, and index events', () => {
    const events: readonly Mp3DecoderEvent[] = [
      { ...eventIdentity(), type: 'decoder-ready', descriptor: DESCRIPTOR },
      {
        ...eventIdentity(),
        type: 'decode-progress',
        decodedInputBytes: 4_170,
        decodedRawSamples: 11_520,
        producedOutputFrames: 12_538,
      },
      {
        ...eventIdentity(),
        type: 'decoder-eof',
        decodedInputBytes: AUDIO_END_BYTE_OFFSET,
        decodedRawSamples: TIMELINE.rawEofSampleExclusive,
        producedOutputFrames: 100_000,
      },
      { ...eventIdentity(), type: 'decoder-stopped' },
      { ...eventIdentity(), type: 'decoder-error', code: 'decode-failed', message: 'failed' },
      { ...eventIdentity(), type: 'frame-index-point', ...point(5) },
      { ...eventIdentity(), type: 'decoder-retired' },
      {
        ...eventIdentity(),
        type: 'worker-retired',
        retryWaitSequence: 2,
        activeRetryWaits: 0,
      },
      {
        ...eventIdentity(),
        type: 'retry-wait-delta',
        delta: 1,
        retryWaitSequence: 1,
        activeRetryWaits: 1,
      },
    ];
    for (const event of events) expect(parseMp3DecoderEvent(event)).toEqual(event);

    expect(parseMp3DecoderEvent({ ...events[1], decodedRawSamples: -1 })).toBeNull();
    expect(parseMp3DecoderEvent({ ...events[2], extra: true })).toBeNull();
    expect(parseMp3DecoderEvent({ ...events[4], message: '' })).toBeNull();
    expect(
      parseMp3DecoderEvent({
        ...events[4],
        code: 'x'.repeat(MP3_DECODER_MAX_ERROR_CODE_LENGTH + 1),
      }),
    ).toBeNull();
    expect(
      parseMp3DecoderEvent({
        ...events[4],
        message: 'x'.repeat(MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH + 1),
      }),
    ).toBeNull();
    expect(
      parseMp3DecoderEvent({ ...events[5], mainDataCapacityBytes: MAX_SAFE_FRAME_BYTES }),
    ).toBeNull();
    expect(
      parseMp3DecoderEvent({
        ...eventIdentity(),
        type: 'retry-wait-delta',
        delta: -1,
        retryWaitSequence: 2,
        activeRetryWaits: -1,
      }),
    ).toBeNull();
  });

  it('turns a progressive event into an index point only after descriptor geometry checks', () => {
    const event = parseMp3DecoderEvent({
      ...eventIdentity(),
      type: 'frame-index-point',
      ...point(5),
    });
    expect(event?.type).toBe('frame-index-point');
    if (!event || event.type !== 'frame-index-point') throw new Error('Expected index event');
    expect(mp3FrameIndexPointFromEvent(event, DESCRIPTOR)).toEqual(point(5));

    const wrongRaw = { ...event, rawSample: event.rawSample + 1 };
    expect(() => mp3FrameIndexPointFromEvent(wrongRaw, DESCRIPTOR)).toThrow(/raw sample/i);
    const wrongOffset = { ...event, byteOffset: FIRST_AUDIO_FRAME_OFFSET + 1 };
    expect(() => mp3FrameIndexPointFromEvent(wrongOffset, DESCRIPTOR)).toThrow(/geometry/i);
    const wrongOrigin = { ...event, ...point(0, 1) };
    expect(() => mp3FrameIndexPointFromEvent(wrongOrigin, DESCRIPTOR)).toThrow(/frame zero/i);
  });
});

const MAX_SAFE_FRAME_BYTES = 1_441;
