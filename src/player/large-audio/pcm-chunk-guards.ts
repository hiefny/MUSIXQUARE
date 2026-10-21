import { pcmChunkDuration, type PcmChunk, type PcmIterator } from './bounded-playback.ts';

export const PCM_INTERPOLATION_GUARD_FRAMES = 2;
const TIMESTAMP_TOLERANCE_SECONDS = 0.000001;
// Decoders emit one codec frame per chunk. As separate sources, 300-750 would
// be pending across the eight-second lookahead; quarter-second sources leave
// about 32, each well under a second.
const MERGE_SECONDS = 0.25;
const MAX_MERGE_SECONDS = 0.5;
// High-rate surround PCM reaches this before a quarter second, keeping each
// merged source a small share of the schedule budget.
const MAX_MERGE_BYTES = 1024 * 1024;

/** Same format, starting where the preceding PCM ends within timestamp rounding. */
function continuesAt(
  next: PcmChunk | undefined,
  timestamp: number,
  sampleRate: number,
  numberOfChannels: number,
): next is PcmChunk {
  return (
    next !== undefined &&
    next.buffer.sampleRate === sampleRate &&
    next.buffer.numberOfChannels === numberOfChannels &&
    Math.abs(next.timestamp - timestamp) <= TIMESTAMP_TOLERANCE_SECONDS
  );
}

/**
 * Preserve the real next samples for native resampling at a chunk boundary.
 * The scheduler stops at duration, so these samples never extend the timeline.
 * Normally one next chunk supplies both samples; one-sample chunks need two.
 *
 * Chunks that start at or after mergeFrom are first joined, while contiguous
 * and of one format, into one buffer of about a quarter second. The next
 * unjoined chunk still supplies its guard samples and shared boundary.
 */
export async function* guardPcmChunkBoundaries(
  reader: PcmIterator,
  audibleEnd = Infinity,
  mergeFrom = Infinity,
): PcmIterator {
  const pending: PcmChunk[] = [];
  let finished = false;
  const peek = async (index: number): Promise<PcmChunk | undefined> => {
    if (index >= pending.length && !finished) {
      const result = await reader.next();
      if (result.done) finished = true;
      else {
        if (result.value.buffer.length < 1) throw new Error('Empty bounded audio chunk');
        pending.push(result.value);
      }
    }
    return pending[index];
  };
  try {
    for (;;) {
      let current = await peek(0);
      if (!current) return;
      if (current.timestamp >= audibleEnd) return;
      let duration = pcmChunkDuration(current);
      const { sampleRate, numberOfChannels } = current.buffer;
      const timestamp = current.timestamp;
      let nextTimestamp = timestamp + duration;
      let length = current.buffer.length;
      let count = 1;
      if (timestamp >= mergeFrom) {
        const maxLength = Math.min(
          MAX_MERGE_SECONDS * sampleRate,
          MAX_MERGE_BYTES / (numberOfChannels * Float32Array.BYTES_PER_ELEMENT),
        );
        // At the audible end, a gap or end of stream, yield the shorter buffer
        // instead of waiting for a full quarter second.
        while (length < MERGE_SECONDS * sampleRate && nextTimestamp < audibleEnd) {
          const next = await peek(count);
          // Joined samples are placed by frame count. Compare with the end of
          // the joined frames so tolerated timestamp rounding cannot accumulate.
          if (
            !continuesAt(next, timestamp + length / sampleRate, sampleRate, numberOfChannels) ||
            length + next.buffer.length > maxLength
          )
            break;
          length += next.buffer.length;
          nextTimestamp = next.timestamp + pcmChunkDuration(next);
          duration = nextTimestamp - timestamp;
          count++;
        }
      }
      const buffer = new AudioBuffer({
        length: length + PCM_INTERPOLATION_GUARD_FRAMES,
        numberOfChannels,
        sampleRate,
      });
      let frame = 0;
      for (const chunk of pending.splice(0, count)) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
          buffer.copyToChannel(chunk.buffer.getChannelData(channel), channel, frame);
        }
        frame += chunk.buffer.length;
      }
      let neighborFrames = PCM_INTERPOLATION_GUARD_FRAMES;
      if (Number.isFinite(audibleEnd)) {
        const missingFrames =
          (audibleEnd - timestamp) * sampleRate + PCM_INTERPOLATION_GUARD_FRAMES - length;
        // Subtracting long absolute timestamps can put an exact integer frame
        // just above that integer. Tolerate only floating-point arithmetic error,
        // not a meaningful fractional sample that still needs its next neighbor.
        const roundingError =
          4 * Number.EPSILON * Math.max(1, Math.abs(audibleEnd), Math.abs(timestamp)) * sampleRate;
        neighborFrames = Math.max(
          0,
          Math.min(PCM_INTERPOLATION_GUARD_FRAMES, Math.ceil(missingFrames - roundingError)),
        );
      }
      current = undefined;
      let copied = 0;
      // Count real guard samples already inside the final PCM. A short next
      // chunk must not force another read after it supplies the missing samples.
      for (let index = 0; copied < neighborFrames; index++) {
        const next = await peek(index);
        if (!continuesAt(next, nextTimestamp, sampleRate, numberOfChannels)) break;
        // Packet timestamps can be rounded to integer microseconds while PCM
        // durations remain sample-exact. Use one shared boundary so native
        // output-frame rounding cannot leave a one-frame gap or overlap.
        if (index === 0) duration = next.timestamp - timestamp;
        const frames = Math.min(neighborFrames - copied, next.buffer.length);
        for (let channel = 0; channel < numberOfChannels; channel++) {
          buffer.copyToChannel(
            next.buffer.getChannelData(channel).subarray(0, frames),
            channel,
            length + copied,
          );
        }
        copied += frames;
        nextTimestamp = next.timestamp + pcmChunkDuration(next);
      }
      // End-of-stream or a real timestamp/format gap has silence after it. Do
      // not fabricate samples by repeating or extrapolating the previous tail.
      yield { buffer, timestamp, duration };
      // The final source still receives its genuine interpolation neighbors,
      // but edited-out PCM is never another audible chunk to prime or schedule.
      if (timestamp + duration >= audibleEnd) return;
    }
  } finally {
    pending.length = 0;
    await reader.return();
  }
}
