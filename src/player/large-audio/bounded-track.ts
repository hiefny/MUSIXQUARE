import type { LargeAudioPlayback, LargeAudioTrack } from '../file-playback-resource.ts';
import { BoundedPlayback, pcmBytes, type PcmChunk, type PcmIterator } from './bounded-playback.ts';

const PRIME_SECONDS = 1;
const PRIME_BYTES = 2 * 1024 * 1024;

function aborted(): DOMException {
  return new DOMException('Large audio preparation superseded', 'AbortError');
}

interface PreparedRead {
  readonly offset: number;
  readonly iterator: PcmIterator;
  signal?: AbortSignal;
  ready: boolean;
  chunks: PcmChunk[];
  cancel(): void;
}

/** Owns bounded PCM preparation, source leases, and decoder lifetime. */
export class BoundedAudioTrack implements LargeAudioTrack {
  readonly kind = 'large-audio';
  readonly length: number;
  private disposed = false;
  private prepared: PreparedRead | null = null;
  private readonly playbacks = new Set<BoundedPlayback>();

  constructor(
    readonly duration: number,
    readonly sampleRate: number,
    readonly numberOfChannels: number,
    private readonly openReader: (position: number) => PcmIterator,
    private readonly disposeInput: () => void,
  ) {
    this.length = Math.round(duration * sampleRate);
  }

  get bufferedPcmBytes(): number {
    let bytes =
      this.prepared?.chunks.reduce((total, chunk) => total + pcmBytes(chunk.buffer), 0) ?? 0;
    for (const playback of this.playbacks) bytes += playback.bufferedPcmBytes;
    return bytes;
  }

  async prepare(position: number, signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) throw aborted();
    if (!Number.isFinite(position)) throw new RangeError('Invalid bounded audio position');
    const offset = Math.min(this.duration, Math.max(0, position));
    if (this.prepared?.offset === offset && this.prepared.ready) {
      const cached = this.prepared;
      cached.signal?.removeEventListener('abort', cached.cancel);
      cached.signal = signal;
      signal?.addEventListener('abort', cached.cancel, { once: true });
      return;
    }
    this.prepared?.cancel();
    const iterator = this.openReader(offset);
    let rejectCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const entry: PreparedRead = {
      offset,
      iterator,
      signal,
      ready: false,
      chunks: [],
      cancel: () => {
        entry.signal?.removeEventListener('abort', entry.cancel);
        if (this.prepared === entry) this.prepared = null;
        entry.chunks = [];
        rejectCancelled(aborted());
        iterator.return().catch(() => undefined);
      },
    };
    this.prepared = entry;
    signal?.addEventListener('abort', entry.cancel, { once: true });
    try {
      let bytes = 0;
      for (;;) {
        const result = await Promise.race([iterator.next(), cancelled]);
        if (this.disposed || this.prepared !== entry || signal?.aborted) throw aborted();
        if (result.done) {
          if (entry.chunks.length === 0 && offset < this.duration - 1 / this.sampleRate) {
            throw new Error('Large audio ended before the requested playback position');
          }
          break;
        }
        if (result.value.timestamp + result.value.buffer.duration > offset) {
          entry.chunks.push(result.value);
          bytes += pcmBytes(result.value.buffer);
          if (
            result.value.timestamp + result.value.buffer.duration >= offset + PRIME_SECONDS ||
            bytes >= PRIME_BYTES
          )
            break;
        }
      }
      entry.ready = true;
    } catch (error) {
      entry.cancel();
      throw error;
    }
  }

  createPlayback(options: Parameters<LargeAudioTrack['createPlayback']>[0]): LargeAudioPlayback {
    if (this.disposed) throw aborted();
    const prepared = this.prepared;
    this.prepared = null;
    const offset = Math.min(this.duration, Math.max(0, options.offset));
    // The transport may advance the requested offset slightly after preparing
    // PCM to compensate for preparation time. Reuse its reader and clip stale
    // samples; don't throw away a warmed decoder for that tiny clock advance.
    const reusable =
      prepared &&
      prepared.ready &&
      !prepared.signal?.aborted &&
      prepared.offset <= offset &&
      offset - prepared.offset <= 1;
    if (!reusable) prepared?.cancel();
    else prepared.signal?.removeEventListener('abort', prepared.cancel);
    const reader = reusable ? prepared.iterator : this.openReader(offset);
    const chunks = reusable ? prepared.chunks : [];
    const firstChunk = chunks.shift() ?? null;
    const iterator = (async function* (): PcmIterator {
      try {
        while (chunks.length) yield chunks.shift()!;
        yield* reader;
      } finally {
        chunks.length = 0;
        await reader.return();
      }
    })();
    let playback: BoundedPlayback | null = null;
    const instance = new BoundedPlayback({
      ...options,
      offset,
      duration: this.duration,
      iterator,
      firstChunk,
      getPendingPcmBuffers: () => chunks.map((chunk) => chunk.buffer),
      reopenReader: (position) => {
        chunks.length = 0;
        return this.openReader(position);
      },
      onreleased: () => {
        chunks.length = 0;
        reader.return().catch(() => undefined);
        if (playback) this.playbacks.delete(playback);
      },
    });
    playback = instance;
    if (instance.active) this.playbacks.add(instance);
    return instance;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prepared?.cancel();
    try {
      for (const playback of this.playbacks) {
        try {
          playback.stop();
        } catch {
          /* Release the remaining readers too. */
        }
      }
    } finally {
      this.playbacks.clear();
      this.disposeInput();
    }
  }
}
