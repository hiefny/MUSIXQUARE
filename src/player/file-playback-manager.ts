import type { QueueItemId } from '../types/index.ts';
import type { FilePlaybackSource, FilePlaybackSourceSnapshot } from './file-playback-source.ts';

export interface FilePlaybackManagerSnapshot {
  readonly active: FilePlaybackSourceSnapshot | null;
  readonly standby: FilePlaybackSourceSnapshot | null;
}

export type FilePlaybackPublication =
  | {
      readonly published: true;
      readonly snapshot: FilePlaybackSourceSnapshot;
    }
  | {
      readonly published: false;
      readonly reason: 'superseded' | 'duplicates-active';
      readonly snapshot: FilePlaybackSourceSnapshot;
    };

function sameSource(left: FilePlaybackSource | null, right: FilePlaybackSource | null): boolean {
  return left === right;
}

async function destroyQuietly(source: FilePlaybackSource | null): Promise<void> {
  if (!source) return;
  try {
    await source.destroy();
  } catch {
    // Teardown is best-effort here. Backends report cleanup diagnostics; a
    // failed old teardown must not publish that old source again.
  }
}

/**
 * Owns native file playback sources outside the serializable application tree.
 *
 * Exactly one active and one speculative standby source may exist. Async
 * preparation uses independent epochs so a slow previous preload cannot
 * publish after reorder, removal, or a newer target selection.
 */
export class FilePlaybackManager {
  private active: FilePlaybackSource | null = null;
  private standby: FilePlaybackSource | null = null;
  private activeEpoch = 0;
  private standbyEpoch = 0;

  activeSource(): FilePlaybackSource | null {
    return this.active;
  }

  standbySource(): FilePlaybackSource | null {
    return this.standby;
  }

  snapshot(): FilePlaybackManagerSnapshot {
    return Object.freeze({
      active: this.active?.getSnapshot() ?? null,
      standby: this.standby?.getSnapshot() ?? null,
    });
  }

  async prepareStandby(source: FilePlaybackSource): Promise<FilePlaybackPublication> {
    const epoch = ++this.standbyEpoch;
    if (sameSource(this.standby, source)) {
      return { published: true, snapshot: source.getSnapshot() };
    }
    if (this.active?.queueItemId === source.queueItemId) {
      if (!sameSource(this.active, source)) await destroyQuietly(source);
      return {
        published: false,
        reason: 'duplicates-active',
        snapshot: source.getSnapshot(),
      };
    }

    let prepared: FilePlaybackSourceSnapshot;
    try {
      prepared = await source.prepare();
    } catch (error) {
      await destroyQuietly(source);
      throw error;
    }

    if (epoch !== this.standbyEpoch || this.active?.queueItemId === source.queueItemId) {
      await destroyQuietly(source);
      return { published: false, reason: 'superseded', snapshot: prepared };
    }

    const previous = this.standby;
    this.standby = source;
    if (previous && !sameSource(previous, source)) await destroyQuietly(previous);
    return { published: true, snapshot: source.getSnapshot() };
  }

  async activate(
    source: FilePlaybackSource,
    destination: AudioNode,
  ): Promise<FilePlaybackPublication> {
    const epoch = ++this.activeEpoch;
    if (sameSource(this.active, source)) {
      return { published: true, snapshot: source.getSnapshot() };
    }
    if (sameSource(this.standby, source)) {
      ++this.standbyEpoch;
      this.standby = null;
    }

    let prepared: FilePlaybackSourceSnapshot;
    try {
      const current = source.getSnapshot();
      prepared =
        current.phase === 'new' || current.phase === 'preparing' ? await source.prepare() : current;
    } catch (error) {
      await destroyQuietly(source);
      throw error;
    }
    if (epoch !== this.activeEpoch) {
      await destroyQuietly(source);
      return { published: false, reason: 'superseded', snapshot: prepared };
    }

    const previous = this.active;
    this.active = null;
    if (previous && !sameSource(previous, source)) await destroyQuietly(previous);
    if (epoch !== this.activeEpoch) {
      await destroyQuietly(source);
      return { published: false, reason: 'superseded', snapshot: prepared };
    }

    let connected: FilePlaybackSourceSnapshot;
    try {
      connected = await source.connect(destination);
    } catch (error) {
      await destroyQuietly(source);
      throw error;
    }
    if (epoch !== this.activeEpoch) {
      await destroyQuietly(source);
      return { published: false, reason: 'superseded', snapshot: connected };
    }

    this.active = source;
    return { published: true, snapshot: connected };
  }

  async promoteStandby(
    queueItemId: QueueItemId,
    destination: AudioNode,
  ): Promise<FilePlaybackPublication | null> {
    const source = this.standby;
    if (!source || source.queueItemId !== queueItemId) return null;
    ++this.standbyEpoch;
    this.standby = null;
    return this.activate(source, destination);
  }

  async discardQueueItem(queueItemId: QueueItemId): Promise<void> {
    const pending: Promise<void>[] = [];
    if (this.active?.queueItemId === queueItemId) {
      ++this.activeEpoch;
      const source = this.active;
      this.active = null;
      pending.push(destroyQuietly(source));
    }
    if (this.standby?.queueItemId === queueItemId) {
      ++this.standbyEpoch;
      const source = this.standby;
      this.standby = null;
      pending.push(destroyQuietly(source));
    }
    await Promise.all(pending);
  }

  async clear(): Promise<void> {
    ++this.activeEpoch;
    ++this.standbyEpoch;
    const active = this.active;
    const standby = this.standby;
    this.active = null;
    this.standby = null;
    await Promise.all([
      destroyQuietly(active),
      sameSource(active, standby) ? Promise.resolve() : destroyQuietly(standby),
    ]);
  }
}
