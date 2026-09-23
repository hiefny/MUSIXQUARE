/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentAudioBufferPcmBytes,
  getCurrentAudioBuffer,
  liveAudioBufferCount,
  liveAudioBufferPcmBytes,
  setCurrentAudioBuffer,
} from '../_state.ts';
import {
  isLargeAudioTrack,
  releaseFilePlaybackResource,
  retainFilePlaybackResource,
  type LargeAudioTrack,
} from '../file-playback-resource.ts';
import { createLargeFileSource } from '../large-file-source.ts';

function createTrack() {
  let pcmBytes = 512 * 1024;
  const dispose = vi.fn();
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    get bufferedPcmBytes() {
      return pcmBytes;
    },
    prepare: vi.fn(async () => {}),
    createPlayback: vi.fn(() => ({ ended: false, stop: vi.fn(), disconnect: vi.fn() })),
    dispose,
  };
  return { track, dispose, setPcmBytes: (value: number) => (pcmBytes = value) };
}

function nativeBuffer(): AudioBuffer {
  return {
    duration: 2,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 96_000,
  } as AudioBuffer;
}

afterEach(() => setCurrentAudioBuffer(null));

describe('file playback resource ownership', () => {
  it('keeps decoder ownership until decode, state, output and demo snapshot leases all finish', () => {
    const { track, dispose } = createTrack();
    retainFilePlaybackResource(track); // Decode result waiting for publication.
    setCurrentAudioBuffer(track);
    const source = createLargeFileSource(track, {} as AudioContext, {} as AudioNode, vi.fn());
    retainFilePlaybackResource(track); // Demo snapshot survives state replacement.

    releaseFilePlaybackResource(track); // Decode commits its result.
    setCurrentAudioBuffer(null);
    expect(dispose).not.toHaveBeenCalled();
    source.stop();
    expect(dispose).not.toHaveBeenCalled();
    releaseFilePlaybackResource(track); // Abandoned snapshot.
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
    source.stop();
    releaseFilePlaybackResource(track);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('retains a restored decoder before the demo snapshot releases its lease', () => {
    const { track, dispose } = createTrack();
    setCurrentAudioBuffer(track);
    retainFilePlaybackResource(track);
    setCurrentAudioBuffer(nativeBuffer());
    expect(dispose).not.toHaveBeenCalled();

    setCurrentAudioBuffer(track);
    releaseFilePlaybackResource(track);
    expect(getCurrentAudioBuffer()).toBe(track);
    expect(dispose).not.toHaveBeenCalled();
    setCurrentAudioBuffer(nativeBuffer());
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('does not accumulate ownership when the current resource is published twice', () => {
    const { track, dispose } = createTrack();
    setCurrentAudioBuffer(track);
    setCurrentAudioBuffer(track);
    setCurrentAudioBuffer(null);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('uses retained PCM bytes for a bounded track and resumes native accounting for a small track', () => {
    const { track, dispose, setPcmBytes } = createTrack();
    const nativeBefore = liveAudioBufferCount().everSeen;
    const retainedNativeBefore = liveAudioBufferPcmBytes();
    setCurrentAudioBuffer(track);
    expect(isLargeAudioTrack(getCurrentAudioBuffer())).toBe(true);
    expect(currentAudioBufferPcmBytes()).toBe(512 * 1024);
    expect(liveAudioBufferCount().everSeen).toBe(nativeBefore);
    expect(liveAudioBufferPcmBytes()).toBe(retainedNativeBefore);

    setPcmBytes(128 * 1024);
    expect(currentAudioBufferPcmBytes()).toBe(128 * 1024);
    const small = nativeBuffer();
    setCurrentAudioBuffer(small);
    expect(isLargeAudioTrack(getCurrentAudioBuffer())).toBe(false);
    expect(currentAudioBufferPcmBytes()).toBe(768_000);
    expect(liveAudioBufferCount().everSeen).toBe(nativeBefore + 1);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
    setCurrentAudioBuffer(small);
    expect(liveAudioBufferCount().everSeen).toBe(nativeBefore + 1);
    setCurrentAudioBuffer(null);
    expect(currentAudioBufferPcmBytes()).toBe(0);
  });

  it('keeps native buffers and null outside explicit decoder disposal', () => {
    const small = nativeBuffer();
    expect(() => {
      retainFilePlaybackResource(null);
      releaseFilePlaybackResource(null);
      retainFilePlaybackResource(small);
      releaseFilePlaybackResource(small);
      releaseFilePlaybackResource(small);
    }).not.toThrow();
    expect(isLargeAudioTrack(small)).toBe(false);
    expect(isLargeAudioTrack(null)).toBe(false);
  });
});
