import { pcmChunkDuration, type PcmChunk, type PcmIterator } from './bounded-playback.ts';

const GUARD_FRAMES = 2;
const TIMESTAMP_TOLERANCE_SECONDS = 0.000001;

/**
 * Preserve the real next samples for native resampling at a chunk boundary.
 * The scheduler stops at duration, so these samples never extend the timeline.
 * Normally one next chunk supplies both samples; one-sample chunks need two.
 */
export async function* guardPcmChunkBoundaries(reader: PcmIterator): PcmIterator {
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
      pending.shift();
      let duration = pcmChunkDuration(current);
      const { sampleRate, numberOfChannels, length } = current.buffer;
      const buffer = new AudioBuffer({
        length: length + GUARD_FRAMES,
        numberOfChannels,
        sampleRate,
      });
      for (let channel = 0; channel < numberOfChannels; channel++) {
        buffer.copyToChannel(current.buffer.getChannelData(channel), channel);
      }
      const timestamp = current.timestamp;
      let nextTimestamp = timestamp + duration;
      current = undefined;
      let copied = 0;
      for (let index = 0; copied < GUARD_FRAMES; index++) {
        const next = await peek(index);
        if (
          !next ||
          next.buffer.sampleRate !== sampleRate ||
          next.buffer.numberOfChannels !== numberOfChannels ||
          Math.abs(next.timestamp - nextTimestamp) > TIMESTAMP_TOLERANCE_SECONDS
        )
          break;
        // Packet timestamps can be rounded to integer microseconds while PCM
        // durations remain sample-exact. Use one shared boundary so native
        // output-frame rounding cannot leave a one-frame gap or overlap.
        if (index === 0) duration = next.timestamp - timestamp;
        const frames = Math.min(GUARD_FRAMES - copied, next.buffer.length);
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
    }
  } finally {
    pending.length = 0;
    await reader.return();
  }
}
