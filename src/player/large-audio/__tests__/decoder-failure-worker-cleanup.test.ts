import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { openLargeAudioTrack } from '../index.ts';
import type { LargeAudioTrack } from '../../file-playback-resource.ts';
import { useRealDecoderRuntime } from './__helpers__/real-decoder-runtime.ts';

const workers = useRealDecoderRuntime();

async function aacFixture(corrupt: boolean): Promise<Blob> {
  const bytes = await readFile('e2e/fixtures/large-audio-chirp-lc-stereo.m4a');
  if (corrupt) {
    let corrupted = false;
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (size < 8) break;
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'mdat') {
        // Preserve the valid container and sample table; only encoded audio is
        // corrupt. FAAD's actual worker resolves its normal errors[] response.
        bytes.fill(0xff, offset + 8, offset + size);
        corrupted = true;
        break;
      }
      offset += size;
    }
    expect(corrupted).toBe(true);
  }
  return new Blob([new Uint8Array(bytes)]);
}

async function flacFixture(corrupt: boolean): Promise<Blob> {
  const bytes = await readFile('e2e/fixtures/large-audio-chirp.flac');
  if (corrupt) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(new Blob([new Uint8Array(bytes)])),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error('FLAC fixture has no audio track');
      const packet = await new EncodedPacketSink(track).getFirstPacket();
      if (!packet) throw new Error('FLAC fixture has no first packet');
      const offset = bytes.indexOf(packet.data);
      expect(offset).toBeGreaterThanOrEqual(0);
      // Keep the demuxable frame header and metadata, but damage actual coded
      // samples so libFLAC itself reports a lost-sync error in its worker.
      bytes.fill(0xff, offset + 10, offset + packet.data.length);
    } finally {
      input.dispose();
    }
  }
  return new Blob([new Uint8Array(bytes)]);
}

async function expectWorkersRetired(): Promise<void> {
  expect(workers.length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(workers.every((worker) => worker.terminated)).toBe(true), {
    timeout: 3_000,
  });
}

describe('real decoder worker retirement through Mediabunny', () => {
  it('retires valid AAC probe and prepared-reader workers after disposal', async () => {
    let track: LargeAudioTrack | undefined;
    try {
      track = await openLargeAudioTrack(await aacFixture(false));
      await track.prepare(0);
    } finally {
      track?.dispose();
    }
    await expectWorkersRetired();
  });

  it('retires a worker after real corrupt AAC data rejects opening', async () => {
    await expect(openLargeAudioTrack(await aacFixture(true))).rejects.toThrow(
      'Invalid number of channels',
    );
    await expectWorkersRetired();
  });

  it('retires a valid FLAC prepared-reader worker after disposal', async () => {
    let track: LargeAudioTrack | undefined;
    try {
      track = await openLargeAudioTrack(await flacFixture(false));
      await track.prepare(0);
    } finally {
      track?.dispose();
    }
    await expectWorkersRetired();
  });

  it('retires a worker after real corrupt FLAC data rejects preparation', async () => {
    const track = await openLargeAudioTrack(await flacFixture(true));
    try {
      await expect(track.prepare(0)).rejects.toThrow('FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC');
    } finally {
      track.dispose();
    }
    await expectWorkersRetired();
  });
});
