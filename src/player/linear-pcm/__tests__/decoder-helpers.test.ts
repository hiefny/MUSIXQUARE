import { describe, expect, it } from 'vitest';

import {
  decodeInterleavedLinearPcm,
  linearPcmSourceFrameByteOffset,
  planLinearPcmInputRead,
} from '../decoder-helpers.ts';
import { LinearPcmDecodeError, type LinearPcmSampleLayout } from '../sample-format.ts';
import {
  LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
  type LinearPcmStreamDescriptor,
} from '../stream-protocol.ts';

const STEREO_S16: LinearPcmSampleLayout = {
  channels: 2,
  encoding: 'pcm-s16le',
  containerBitsPerSample: 16,
  validBitsPerSample: 16,
  blockAlign: 4,
};

describe('container-neutral linear PCM helpers', () => {
  it('deinterleaves bounded PCM independently of an encoded container', () => {
    const backing = new Uint8Array(12);
    const view = new DataView(backing.buffer);
    view.setInt16(2, -32_768, true);
    view.setInt16(4, 16_384, true);
    view.setInt16(6, 0, true);
    view.setInt16(8, 32_767, true);

    const decoded = decodeInterleavedLinearPcm(backing.subarray(2, 10), STEREO_S16);

    expect(decoded.frames).toBe(2);
    expect(Array.from(decoded.channels[0]!)).toEqual([-1, 0]);
    expect(Array.from(decoded.channels[1]!)).toEqual([0.5, 32_767 / 32_768]);
  });

  it('keeps strict high-aligned valid-bit validation in the shared converter', () => {
    const layout: LinearPcmSampleLayout = {
      channels: 1,
      encoding: 'pcm-s16le',
      containerBitsPerSample: 16,
      validBitsPerSample: 12,
      blockAlign: 2,
    };

    expect(() => decodeInterleavedLinearPcm(Uint8Array.of(0xf1, 0x7f), layout)).toThrow(
      LinearPcmDecodeError,
    );
  });

  it('maps sparse source frames and plans reads without container-specific state', () => {
    const logicalFileBytes = 5 * 1_024 * 1_024 * 1_024;
    const dataOffset = 80;
    const dataBytes = logicalFileBytes - dataOffset;
    const descriptor: LinearPcmStreamDescriptor = {
      sourceSampleRate: 48_000,
      outputSampleRate: 48_000,
      ...STEREO_S16,
      dataOffset,
      dataBytes,
      logicalFileBytes,
      totalSourceFrames: dataBytes / STEREO_S16.blockAlign,
      targetSourceFrame: 0,
    };

    expect(linearPcmSourceFrameByteOffset(descriptor, descriptor.totalSourceFrames)).toBe(
      logicalFileBytes,
    );
    expect(planLinearPcmInputRead(descriptor, 0)).toEqual({
      sourceFrame: 0,
      byteOffset: dataOffset,
      frames: 16_384,
      bytes: 65_536,
      final: false,
    });
    expect(() =>
      planLinearPcmInputRead(descriptor, 0, LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES + 1),
    ).toThrow('maximumFrames');
  });
});
