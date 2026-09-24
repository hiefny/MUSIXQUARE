import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { log } from '../../core/log.ts';
import type { LargeAudioPlayback } from '../file-playback-resource.ts';
import {
  beginLargeAudioResource,
  recordLargeAudioPcm,
  recordLargeAudioRead,
  recordLargeAudioReaderRestart,
  recordLargeAudioSupplyGap,
} from './diagnostics.ts';

/** Timestamp is relative to the same audible start used by the complete-PCM engine. */
export interface PcmChunk {
  readonly buffer: AudioBuffer;
  readonly timestamp: number;
  /** Audible span, excluding interpolation samples from the following chunk. */
  readonly duration?: number;
}

export type PcmIterator = AsyncGenerator<PcmChunk, void, unknown>;

const PCM_LOOKAHEAD_SECONDS = 8;
const MAX_SCHEDULED_PCM_BYTES = 16 * 1024 * 1024;
const PUMP_INTERVAL_MS = 100;
let playbackSequence = 0;

export function pcmBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

export function pcmChunkDuration(chunk: PcmChunk): number {
  return chunk.duration ?? chunk.buffer.duration;
}

interface BoundedPlaybackOptions {
  context: AudioContext;
  destination: AudioNode;
  when: number;
  offset: number;
  duration: number;
  iterator: PcmIterator;
  firstChunk: PcmChunk | null;
  getPendingPcmBuffers?(): readonly AudioBuffer[];
  reopenReader?(position: number): PcmIterator;
  onended(): void;
  onerror(error: unknown): void;
  onreleased(): void;
}

/** Schedules a bounded window on the existing AudioContext sample clock. */
export class BoundedPlayback implements LargeAudioPlayback {
  private readonly timerName = `large-audio-pump-${++playbackSequence}`;
  private readonly nodes = new Map<
    AudioBufferSourceNode,
    { buffer: AudioBuffer; endsAt: number }
  >();
  private nextChunk: PcmChunk | null;
  private iterator: PcmIterator;
  private readGeneration = 0;
  private reading = false;
  private finishedReading = false;
  private stopped = false;
  private naturallyEnded = false;
  private released = false;
  private readonly releaseDiagnosticResource = beginLargeAudioResource('playbacks');
  private scheduledThrough: number;
  private supplyGapActive = false;
  private lastGapWarningAt = -Infinity;

  constructor(private readonly options: BoundedPlaybackOptions) {
    this.scheduledThrough = options.when;
    this.nextChunk = options.firstChunk;
    options.firstChunk = null;
    this.iterator = options.iterator;
    // First PCM is prepared before the transport commits its start. Schedule
    // it synchronously so the promised sample-clock deadline is preserved.
    this.pump();
  }

  get ended(): boolean {
    return this.naturallyEnded;
  }

  get active(): boolean {
    return !this.stopped;
  }

  get bufferedPcmBytes(): number {
    const buffers = new Set(Array.from(this.nodes.values(), (entry) => entry.buffer));
    if (this.nextChunk) buffers.add(this.nextChunk.buffer);
    for (const buffer of this.options.getPendingPcmBuffers?.() ?? []) buffers.add(buffer);
    let bytes = 0;
    for (const buffer of buffers) bytes += pcmBytes(buffer);
    recordLargeAudioPcm(bytes);
    return bytes;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseDiagnosticResource();
    this.options.onreleased();
  }

  private closeIterator(): void {
    // A pending read cannot be synchronously cancelled by AsyncGenerator.
    // Its result is fenced by stopped; return also closes the decoder queue.
    this.iterator.return().catch(() => undefined);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearManagedTimer(this.timerName);
    this.nextChunk = null;
    for (const node of this.nodes.keys()) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // A source that already ended may reject stop on older WebKit.
      }
      try {
        node.disconnect();
      } catch {
        // Continue releasing the decoder even if native audio was torn down.
      }
    }
    this.nodes.clear();
    this.closeIterator();
    this.release();
  }

  disconnect(): void {
    this.stop();
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.options.onerror(error);
  }

  private scheduleAvailable(): void {
    const chunk = this.nextChunk;
    if (!chunk || this.stopped) return;
    const { context, when, offset, duration, destination } = this.options;
    const buffer = chunk.buffer;
    const bytes = pcmBytes(buffer);
    const chunkDuration = pcmChunkDuration(chunk);
    if (
      !Number.isFinite(chunk.timestamp) ||
      !Number.isFinite(chunkDuration) ||
      chunkDuration <= 0 ||
      chunkDuration > buffer.duration ||
      bytes > MAX_SCHEDULED_PCM_BYTES
    ) {
      throw new Error('Invalid or oversized bounded audio chunk');
    }
    recordLargeAudioPcm(bytes);
    const audibleStart = Math.max(offset, chunk.timestamp);
    const audibleEnd = Math.min(duration, chunk.timestamp + chunkDuration);
    const endsAt = when + audibleEnd - offset;
    const targetWhen = when + audibleStart - offset;
    // Never slide a late chunk forward. Drop its elapsed part and rejoin the
    // original timeline, including after background timer throttling.
    const startsAt = Math.max(context.currentTime, targetWhen);
    const skipped = startsAt - targetWhen;
    const sourceOffset = audibleStart - chunk.timestamp + skipped;
    const seconds = audibleEnd - audibleStart - skipped;
    if (seconds <= 0) {
      this.nextChunk = null;
      return;
    }
    if (
      this.nodes.size > 0 &&
      (targetWhen > context.currentTime + PCM_LOOKAHEAD_SECONDS ||
        this.bufferedPcmBytes > MAX_SCHEDULED_PCM_BYTES)
    ) {
      return;
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(destination);
    node.onended = () => {
      this.nodes.delete(node);
      try {
        node.disconnect();
      } catch {
        // The context/destination can disappear during session teardown.
      }
      node.onended = null;
      if (!this.stopped) this.pump();
    };
    try {
      // Keep fractional starts for the browser's resampler. A duration passed
      // to start() is rounded on the source clock independently of the next
      // chunk's start; explicit absolute stops share the output-clock boundary.
      // The reader supplies neighboring PCM beyond the logical end so source
      // offset rounding cannot exhaust the buffer one sample before that stop.
      node.start(startsAt, sourceOffset);
      node.stop(endsAt);
      this.nodes.set(node, { buffer, endsAt });
      this.scheduledThrough = Math.max(this.scheduledThrough, endsAt);
      this.supplyGapActive = false;
      this.nextChunk = null;
    } catch (error) {
      node.onended = null;
      try {
        node.disconnect();
      } catch {
        // Preserve the original source-start error.
      }
      throw error;
    }
  }

  private skipStaleWindow(): void {
    const { context, offset, when, duration, reopenReader } = this.options;
    if (!reopenReader || !this.nextChunk) return;
    const position = offset + Math.max(0, context.currentTime - when);
    const bufferedEnd = this.nextChunk.timestamp + pcmChunkDuration(this.nextChunk);
    if (position - bufferedEnd <= PCM_LOOKAHEAD_SECONDS) return;
    for (const [node, entry] of this.nodes) {
      if (entry.endsAt > context.currentTime) continue;
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* Already elapsed. */
      }
      try {
        node.disconnect();
      } catch {
        /* Context may have restarted. */
      }
      this.nodes.delete(node);
    }
    this.readGeneration++;
    recordLargeAudioReaderRestart();
    this.closeIterator();
    this.reading = false;
    this.nextChunk = null;
    if (position >= duration) {
      this.finishedReading = true;
    } else {
      this.finishedReading = false;
      this.iterator = reopenReader(position);
    }
  }

  private observeOutputSupply(): void {
    const { context, when, offset, duration } = this.options;
    const now = context.currentTime;
    // A source may report ended before its final audio-clock deadline. Only
    // diagnose time with no scheduled output, not the node callback itself.
    const elapsedEnd = Math.min(now, when + duration - offset);
    const gap = elapsedEnd - this.scheduledThrough;
    // Ignore tiny startup/scheduling variation. This threshold only filters local
    // diagnostics; it never changes playback, buffering, or sync policy.
    if (gap <= 0.02) return;
    recordLargeAudioSupplyGap(gap, !this.supplyGapActive);
    if (!this.supplyGapActive && now - this.lastGapWarningAt >= 10) {
      log.warn('[LargeAudio] PCM supply fell behind the audio clock', {
        gapMs: Math.round(gap * 1_000),
        reading: this.reading,
        finishedReading: this.finishedReading,
      });
      this.lastGapWarningAt = now;
    }
    this.supplyGapActive = true;
  }

  private pump(): void {
    if (this.stopped) return;
    try {
      this.observeOutputSupply();
      this.skipStaleWindow();
      this.scheduleAvailable();
      if (
        this.finishedReading &&
        !this.nextChunk &&
        this.nodes.size === 0 &&
        this.options.context.currentTime >=
          this.options.when + this.options.duration - this.options.offset
      ) {
        this.naturallyEnded = true;
        this.stop();
        this.options.onended();
        return;
      }
      if (!this.nextChunk && !this.reading && !this.finishedReading) {
        this.reading = true;
        const generation = this.readGeneration;
        const readStartedAt = performance.now();
        this.iterator.next().then(
          (result) => {
            recordLargeAudioRead(performance.now() - readStartedAt);
            if (generation !== this.readGeneration) return;
            this.reading = false;
            if (this.stopped) return;
            if (result.done) this.finishedReading = true;
            else this.nextChunk = result.value;
            this.pump();
          },
          (error: unknown) => {
            recordLargeAudioRead(performance.now() - readStartedAt);
            if (generation !== this.readGeneration) return;
            this.reading = false;
            this.fail(error);
          },
        );
      }
      setManagedTimer(this.timerName, () => this.pump(), PUMP_INTERVAL_MS);
    } catch (error) {
      this.fail(error);
    }
  }
}
