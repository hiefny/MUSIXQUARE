import { ALL_FORMATS, PCM_AUDIO_CODECS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import type { PcmIterator } from './bounded-playback.ts';
import { BoundedAudioTrack } from './bounded-track.ts';
import { readMp3GaplessTrim } from './mp3-gapless.ts';
import { registerIncrementalAudioDecoders } from './wasm-decoders.ts';

const ENCODED_READ_CACHE_BYTES = 2 * 1024 * 1024;
const COMPRESSED_SEEK_PREROLL_SECONDS = 0.5;

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
      !(PCM_AUDIO_CODECS as readonly (string | null)[]).includes(codec)
    ) {
      throw new Error(`Unsupported large audio codec: ${codec ?? 'unknown'}`);
    }
    if (!(await track.canDecode())) {
      throw new Error('This large audio track has no supported incremental decoder');
    }
    // Some elementary-stream demuxers initialize their first-frame parser on
    // demand. Finish that mutation before asking them to scan to the end.
    const firstTimestamp = await track.getFirstTimestamp();
    const [rawDuration, sampleRate, numberOfChannels] = await Promise.all([
      track.computeDuration(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ]);
    assertCurrent();
    const trim =
      codec === 'mp3' ? await readMp3GaplessTrim(blob) : { startSamples: 0, endSamples: 0 };
    assertCurrent();
    const origin = Math.max(0, firstTimestamp) + trim.startSamples / sampleRate;
    const duration = rawDuration - origin - trim.endSamples / sampleRate;
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
    const sink = new AudioBufferSink(track);
    const openReader = async function* (position: number): PcmIterator {
      // MPEG's bit reservoir and synthesis filters need preceding frames after
      // random access. Decode a small preroll and keep its timestamps; prepare
      // discards it without delaying the requested audible start.
      const preroll = codec === 'mp3' ? COMPRESSED_SEEK_PREROLL_SECONDS : 0;
      const startsAt = Math.max(firstTimestamp, position + origin - preroll);
      for await (const chunk of sink.buffers(startsAt)) {
        yield { buffer: chunk.buffer, timestamp: chunk.timestamp - origin };
      }
    };
    return new BoundedAudioTrack(duration, sampleRate, numberOfChannels, openReader, () =>
      input.dispose(),
    );
  } catch (error) {
    input.dispose();
    throw error;
  } finally {
    clearManagedTimer(timerName);
  }
}
