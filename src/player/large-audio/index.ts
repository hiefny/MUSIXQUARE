import {
  ALL_FORMATS,
  PCM_AUDIO_CODECS,
  AdtsInputFormat,
  AudioBufferSink,
  BlobSource,
  Input,
  Mp4InputFormat,
} from 'mediabunny';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import type { PcmIterator } from './bounded-playback.ts';
import { BoundedAudioTrack } from './bounded-track.ts';
import { readMp3GaplessTrim } from './mp3-gapless.ts';
import { registerIncrementalAudioDecoders } from './wasm-decoders.ts';
import { IncrementalAacDecoder } from './aac-decoder.ts';
import { readAacContainerTiming } from './aac-container-timing.ts';
import { guardPcmChunkBoundaries } from './pcm-chunk-guards.ts';

const ENCODED_READ_CACHE_BYTES = 2 * 1024 * 1024;
const COMPRESSED_SEEK_PREROLL_SECONDS = 0.5;
const AAC_SEEK_PREROLL_SECONDS = 1;

let openSequence = 0;

function aborted(): DOMException {
  return new DOMException('Large audio preparation superseded', 'AbortError');
}

/** Open encoded bytes without allocating a complete-track AudioBuffer. */
export async function openLargeAudioTrack(
  blob: Blob,
  options: { isCurrent?: () => boolean } = {},
): Promise<LargeAudioTrack> {
  registerIncrementalAudioDecoders();
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: ENCODED_READ_CACHE_BYTES }),
  });
  const timerName = `large-audio-open-${++openSequence}`;
  const assertCurrent = (): void => {
    if (options.isCurrent?.() === false) throw aborted();
  };
  if (options.isCurrent) {
    setManagedTimer(
      timerName,
      () => {
        if (options.isCurrent?.() === false) input.dispose();
      },
      100,
      { interval: true },
    );
  }
  try {
    assertCurrent();
    const track = await input.getPrimaryAudioTrack();
    assertCurrent();
    if (!track) {
      throw new Error('This large audio track has no supported incremental decoder');
    }
    const codec = await track.getCodec();
    // Decoder availability alone does not guarantee that encoder priming,
    // random access and end padding match decodeAudioData's audible timeline.
    // Keep unverified codecs out of the bounded path instead of drifting or
    // silently allocating a complete-track PCM fallback.
    if (
      codec !== 'mp3' &&
      codec !== 'flac' &&
      codec !== 'aac' &&
      !(PCM_AUDIO_CODECS as readonly (string | null)[]).includes(codec)
    ) {
      throw new Error(`Unsupported large audio codec: ${codec ?? 'unknown'}`);
    }
    const aacConfig = codec === 'aac' ? await track.getDecoderConfig() : null;
    if (codec === 'aac' && !IncrementalAacDecoder.supports(codec, aacConfig)) {
      throw new Error('Unsupported large AAC profile');
    }
    if (codec === 'aac') {
      const format = await input.getFormat();
      if (!(format instanceof Mp4InputFormat) && !(format instanceof AdtsInputFormat)) {
        throw new Error('Unsupported large AAC container');
      }
    }
    if (!(await track.canDecode())) {
      throw new Error('This large audio track has no supported incremental decoder');
    }
    // Some elementary-stream demuxers initialize their first-frame parser on
    // demand. Finish that mutation before asking them to scan to the end.
    const firstTimestamp = await track.getFirstTimestamp();
    const [rawDuration, encodedSampleRate, encodedNumberOfChannels] = await Promise.all([
      track.computeDuration(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ]);
    assertCurrent();
    const sink = new AudioBufferSink(track);
    let sampleRate = encodedSampleRate;
    let numberOfChannels = encodedNumberOfChannels;
    if (codec === 'aac') {
      // ADTS and implicit HE-AAC metadata describe the AAC core, which may
      // decode to twice the sample rate and (with PS) two output channels.
      // Inspect one actual output buffer rather than guessing those properties.
      const probe = sink.buffers(firstTimestamp);
      try {
        const first = await probe.next();
        assertCurrent();
        if (first.done) throw new Error('Large AAC track contains no decoded audio');
        sampleRate = first.value.buffer.sampleRate;
        numberOfChannels = first.value.buffer.numberOfChannels;
      } finally {
        await probe.return();
      }
    }
    const trim =
      codec === 'mp3' ? await readMp3GaplessTrim(blob) : { startSamples: 0, endSamples: 0 };
    assertCurrent();
    const aacTiming = aacConfig
      ? await readAacContainerTiming(blob, track.id, aacConfig, options.isCurrent)
      : null;
    assertCurrent();
    const origin =
      aacTiming?.origin ?? Math.max(0, firstTimestamp) + trim.startSamples / sampleRate;
    const duration =
      Math.min(rawDuration, aacTiming?.end ?? rawDuration) - origin - trim.endSamples / sampleRate;
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(numberOfChannels) ||
      numberOfChannels < 1 ||
      numberOfChannels > 32 ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0
    ) {
      throw new Error('Invalid large audio track metadata');
    }
    const openReader = async function* (position: number): PcmIterator {
      // MPEG's bit reservoir and AAC's filterbank/parametric-stereo state need
      // preceding frames after random access. Decode a bounded preroll and keep
      // its timestamps; prepare discards it before the requested audible start.
      const preroll =
        codec === 'aac'
          ? AAC_SEEK_PREROLL_SECONDS
          : codec === 'mp3'
            ? COMPRESSED_SEEK_PREROLL_SECONDS
            : 0;
      const startsAt = Math.max(firstTimestamp, position + origin - preroll);
      for await (const chunk of sink.buffers(startsAt)) {
        yield { buffer: chunk.buffer, timestamp: chunk.timestamp - origin };
      }
    };
    return new BoundedAudioTrack(
      duration,
      sampleRate,
      numberOfChannels,
      (position) => guardPcmChunkBoundaries(openReader(position)),
      () => input.dispose(),
    );
  } catch (error) {
    input.dispose();
    throw error;
  } finally {
    clearManagedTimer(timerName);
  }
}
