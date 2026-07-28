import { describe, expect, it } from 'vitest';

import { ENCODED_SOURCE_PORT_MAX_READ_BYTES } from '../../sources/encoded-source-port.ts';
import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
} from '../../streaming/pcm-stream-protocol.ts';
import {
  LINEAR_PCM_DECODER_PROTOCOL_VERSION,
  isLinearPcmDecoderGeneration,
  isLinearPcmSourceLifetimeGeneration,
  isLinearPcmSourceSize,
} from '../decoder-protocol.ts';
import {
  LINEAR_PCM_STREAM_MAX_CHANNELS,
  LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
  LINEAR_PCM_STREAM_MAX_READ_BYTES,
} from '../stream-protocol.ts';

describe('linear PCM decoder protocol leaf contract', () => {
  it('shares PCM ring bounds but keeps a distinct decoder-control protocol version', () => {
    expect(LINEAR_PCM_DECODER_PROTOCOL_VERSION).toBe(2);
    expect(PCM_STREAM_PROTOCOL_VERSION).toBe(3);
    expect(LINEAR_PCM_STREAM_MAX_CHANNELS).toBe(PCM_STREAM_MAX_CHANNELS);
    expect(LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES).toBe(PCM_STREAM_MAX_MESSAGE_FRAMES);
    expect(LINEAR_PCM_STREAM_MAX_READ_BYTES).toBe(ENCODED_SOURCE_PORT_MAX_READ_BYTES);
  });

  it.each([
    [1, true],
    [Number.MAX_SAFE_INTEGER, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    ['1', false],
  ])('validates decoder/source generations without coercing %p', (value, expected) => {
    expect(isLinearPcmDecoderGeneration(value)).toBe(expected);
    expect(isLinearPcmSourceLifetimeGeneration(value)).toBe(expected);
  });

  it.each([
    [1, true],
    [5 * 1_024 * 1_024 * 1_024, true],
    [0, false],
    [-1, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])('validates encoded source size %p', (value, expected) => {
    expect(isLinearPcmSourceSize(value)).toBe(expected);
  });
});
