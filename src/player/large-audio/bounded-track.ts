import type { LargeAudioPlayback, LargeAudioTrack } from '../file-playback-resource.ts';
import {
  BoundedPlayback,
  pcmBytes,
  pcmChunkDuration,
  type PcmChunk,
  type PcmIterator,
} from './bounded-playback.ts';
import { beginLargeAudioResource } from './diagnostics.ts';

const PRIME_SECONDS = 1;
const PRIME_BYTES = 2 * 1024 * 1024;

function aborted(): DOMException {
  return new DOMException('Large audio preparation superseded', 'AbortError');
}

interface PreparedRead {
  readonly offset: number;
  iterator: PcmIterator | null;
  signal?: AbortSignal;
  ready: boolean;
  chunks: PcmChunk[];
  cancel(): void;
}

/** A reader can be retired through both a generator finally and its owner. */
function ownReader(
  reader: PcmIterator,
  onRetiring: (closing: ReturnType<PcmIterator['return']>) => void,
): PcmIterator {
  const releaseResource = beginLargeAudioResource('readers');
  let closing: ReturnType<PcmIterator['return']> | null = null;
  return {
    next: (...args) => reader.next(...args),
    return: () => {
      if (!closing) {
        closing = Promise.resolve()
          .then(() => reader.return())
          .finally(releaseResource);
        onRetiring(closing);
      }
      return closing;
    },
    throw: (error) => reader.throw(error),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await this.return();
    },
  };
}

/** Owns bounded PCM preparation, source leases, and decoder lifetime. */
export class BoundedAudioTrack implements LargeAudioTrack {
  readonly kind = 'large-audio';
  readonly length: number;
  private disposed = false;
  private readonly releaseResource = beginLargeAudioResource('tracks');
  private prepared: PreparedRead | null = null;
  private readonly retiringReaders = new Set<ReturnType<PcmIterator['return']>>();
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

  private async waitForRetiringReaders(cancelled: Promise<never>): Promise<void> {
    do {
      await Promise.race([Promise.allSettled(this.retiringReaders), cancelled]);
      // A playing source can be stopped while another reader is retiring.
      // Include its new retirement before opening the waiting replacement.
    } while (this.retiringReaders.size > 0);
  }

  private openOwnedReader(position: number): PcmIterator {
    let cancelOpening!: () => void;
    let wasCancelled = false;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelOpening = () => reject(aborted());
    });
    // return() can precede the generator's first next(), before it has installed
    // its race handler. Cancellation still must not reject out of band.
    void cancelled.catch(() => undefined);
    const reader = async function* (this: BoundedAudioTrack): PcmIterator {
      let opened: PcmIterator | null = null;
      try {
        await this.waitForRetiringReaders(cancelled);
        if (wasCancelled || this.disposed) return;
        opened = this.openReader(position);
        for (;;) {
          const result = await opened.next();
          if (result.done) return;
          yield result.value;
        }
      } catch (error) {
        if (!wasCancelled) throw error;
      } finally {
        await opened?.return();
      }
    }.call(this);
    return ownReader(reader, (closing) => {
      // Unblock a not-yet-opened reader before adding its own retirement to the
      // gate; otherwise cancelled cold starts could wait for each other forever.
      wasCancelled = true;
      cancelOpening();
      this.retiringReaders.add(closing);
      const retired = (): void => {
        this.retiringReaders.delete(closing);
      };
      void closing.then(retired, retired);
    });
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
    let rejectCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    let wasCancelled = false;
    const entry: PreparedRead = {
      offset,
      iterator: null,
      signal,
      ready: false,
      chunks: [],
      cancel: () => {
        if (wasCancelled) return;
        wasCancelled = true;
        entry.signal?.removeEventListener('abort', entry.cancel);
        if (this.prepared === entry) this.prepared = null;
        entry.chunks = [];
        rejectCancelled(aborted());
        entry.iterator?.return().catch(() => undefined);
      },
    };
    this.prepared = entry;
    signal?.addEventListener('abort', entry.cancel, { once: true });
    try {
      // AsyncGenerator.return cannot interrupt a pending decoder frame. Await
      // retired readers before opening the newest seek, rather than accumulating
      // a Worker per superseded request or paused playback. Waiting intents are
      // cancellable and do not open a decoder. Still-active output is not retired
      // and continues while a replacement is prepared.
      await this.waitForRetiringReaders(cancelled);
      if (this.disposed || this.prepared !== entry || signal?.aborted) throw aborted();
      const iterator = this.openOwnedReader(offset);
      entry.iterator = iterator;
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
        if (result.value.timestamp + pcmChunkDuration(result.value) > offset) {
          entry.chunks.push(result.value);
          bytes += pcmBytes(result.value.buffer);
          if (
            result.value.timestamp + pcmChunkDuration(result.value) >=
              Math.min(this.duration, offset + PRIME_SECONDS) ||
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
      prepared.iterator &&
      !prepared.signal?.aborted &&
      prepared.offset <= offset &&
      offset - prepared.offset <= 1;
    if (!reusable) prepared?.cancel();
    else prepared.signal?.removeEventListener('abort', prepared.cancel);
    const reader = reusable ? prepared.iterator! : this.openOwnedReader(offset);
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
        return this.openOwnedReader(position);
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
      this.releaseResource();
    }
  }
}
