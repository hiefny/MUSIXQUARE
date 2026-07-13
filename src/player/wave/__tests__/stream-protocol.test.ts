import { describe, expect, it } from 'vitest';

import { ENCODED_SOURCE_PORT_MAX_READ_BYTES } from '../../sources/encoded-source-port.ts';
import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
} from '../../streaming/pcm-stream-protocol.ts';
import {
  WAVE_STREAM_MAX_CHANNELS,
  WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
  WAVE_STREAM_MAX_READ_BYTES,
  WAVE_STREAM_MAX_SOURCE_IDENTITY_LENGTH,
  WAVE_STREAM_PROTOCOL_VERSION,
  isWaveDecoderGeneration,
  isWaveSourceIdentity,
  isWaveSourceLifetimeGeneration,
  isWaveSourceSize,
} from '../stream-protocol.ts';

describe('WAVE stream protocol leaf contract', () => {
  it('shares PCM ring bounds but keeps a distinct decoder-control protocol version', () => {
    expect(WAVE_STREAM_PROTOCOL_VERSION).toBe(1);
    expect(PCM_STREAM_PROTOCOL_VERSION).toBe(2);
    expect(WAVE_STREAM_MAX_CHANNELS).toBe(PCM_STREAM_MAX_CHANNELS);
    expect(WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES).toBe(PCM_STREAM_MAX_MESSAGE_FRAMES);
    expect(WAVE_STREAM_MAX_READ_BYTES).toBe(ENCODED_SOURCE_PORT_MAX_READ_BYTES);
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
    expect(isWaveDecoderGeneration(value)).toBe(expected);
    expect(isWaveSourceLifetimeGeneration(value)).toBe(expected);
  });

  it.each([
    [1, true],
    [5 * 1_024 * 1_024 * 1_024, true],
    [0, false],
    [-1, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])('validates encoded source size %p', (value, expected) => {
    expect(isWaveSourceSize(value)).toBe(expected);
  });

  it('bounds opaque source identities without trimming or coercion', () => {
    expect(isWaveSourceIdentity('wave:fixture')).toBe(true);
    expect(isWaveSourceIdentity('x'.repeat(WAVE_STREAM_MAX_SOURCE_IDENTITY_LENGTH))).toBe(true);
    expect(isWaveSourceIdentity('')).toBe(false);
    expect(isWaveSourceIdentity('x'.repeat(WAVE_STREAM_MAX_SOURCE_IDENTITY_LENGTH + 1))).toBe(
      false,
    );
    expect(isWaveSourceIdentity(1)).toBe(false);
  });
});
