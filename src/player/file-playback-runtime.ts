import { getState } from '../core/state.ts';
import type { QueueItemId } from '../types/index.ts';
import { getCurrentAudioBuffer } from './_state.ts';
import { FilePlaybackManager, type FilePlaybackManagerSnapshot } from './file-playback-manager.ts';
import type {
  FilePlaybackPosition,
  FilePlaybackSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';

export interface LegacyFilePlaybackView {
  readonly audioBuffer: AudioBuffer | null;
  readonly queueItemId: QueueItemId | null;
}

export type LegacyFilePlaybackViewProvider = () => LegacyFilePlaybackView;

export interface FilePlaybackRuntimeOptions {
  readonly manager?: FilePlaybackManager;
  readonly legacyView?: LegacyFilePlaybackViewProvider;
  readonly monotonicNow?: () => number;
}

export interface FilePlaybackAvailability {
  readonly available: boolean;
  readonly backend: 'audio-buffer' | 'streaming-flac' | 'legacy-audio-buffer' | null;
  readonly queueItemId: QueueItemId | null;
  readonly durationSeconds: number | null;
}

const PLAYABLE_MANAGED_PHASES: ReadonlySet<FilePlaybackSourcePhase> = new Set([
  'ready',
  'connected',
  'armed',
  'playing',
  'paused',
  'ended',
  'cancelled',
]);

function defaultLegacyView(): LegacyFilePlaybackView {
  const resident = getState('files.current');
  return {
    audioBuffer: getCurrentAudioBuffer(),
    queueItemId: resident?.queueItemId ?? null,
  };
}

function finiteDuration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function snapshotMatches(
  snapshot: FilePlaybackSourceSnapshot | null,
  queueItemId?: QueueItemId | null,
): snapshot is FilePlaybackSourceSnapshot {
  return !!snapshot && (queueItemId == null || snapshot.queueItemId === queueItemId);
}

/**
 * Runtime-only bridge used while product call sites migrate away from the
 * legacy global AudioBuffer. Native sources stay in FilePlaybackManager; UI
 * and synchronization code consume JSON-safe views from this facade.
 */
export class FilePlaybackRuntime {
  readonly #manager: FilePlaybackManager;
  readonly #legacyView: LegacyFilePlaybackViewProvider;
  readonly #monotonicNow: () => number;

  constructor(options: FilePlaybackRuntimeOptions = {}) {
    this.#manager = options.manager ?? new FilePlaybackManager();
    this.#legacyView = options.legacyView ?? defaultLegacyView;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  manager(): FilePlaybackManager {
    return this.#manager;
  }

  snapshot(): FilePlaybackManagerSnapshot {
    return this.#manager.snapshot();
  }

  activeSource(): FilePlaybackSource | null {
    return this.#manager.activeSource();
  }

  standbySource(): FilePlaybackSource | null {
    return this.#manager.standbySource();
  }

  activeSnapshot(): FilePlaybackSourceSnapshot | null {
    return this.#manager.snapshot().active;
  }

  availability(queueItemId?: QueueItemId | null): FilePlaybackAvailability {
    const managed = this.activeSnapshot();
    if (snapshotMatches(managed, queueItemId) && PLAYABLE_MANAGED_PHASES.has(managed.phase)) {
      return Object.freeze({
        available: true,
        backend: managed.backend,
        queueItemId: managed.queueItemId,
        durationSeconds: finiteDuration(managed.durationSeconds),
      });
    }

    const legacy = this.#legacyView();
    const legacyMatches =
      !!legacy.audioBuffer &&
      legacy.queueItemId !== null &&
      (queueItemId == null || legacy.queueItemId === queueItemId);
    if (legacyMatches) {
      return Object.freeze({
        available: true,
        backend: 'legacy-audio-buffer',
        queueItemId: legacy.queueItemId,
        durationSeconds: finiteDuration(legacy.audioBuffer?.duration),
      });
    }

    return Object.freeze({
      available: false,
      backend: null,
      queueItemId: null,
      durationSeconds: null,
    });
  }

  hasPlayableSource(queueItemId?: QueueItemId | null): boolean {
    return this.availability(queueItemId).available;
  }

  durationSeconds(queueItemId?: QueueItemId | null): number | null {
    return this.availability(queueItemId).durationSeconds;
  }

  position(queueItemId?: QueueItemId | null): FilePlaybackPosition | null {
    const source = this.activeSource();
    if (!source || (queueItemId != null && source.queueItemId !== queueItemId)) return null;
    try {
      return source.positionAt(this.#monotonicNow());
    } catch {
      // A source can be destroyed between the ownership read and position
      // query. Callers fall back to the existing legacy timing projection.
      return null;
    }
  }

  discardQueueItem(queueItemId: QueueItemId): Promise<void> {
    return this.#manager.discardQueueItem(queueItemId);
  }

  clear(): Promise<void> {
    return this.#manager.clear();
  }
}

const filePlaybackRuntime = new FilePlaybackRuntime();

export function getFilePlaybackRuntime(): FilePlaybackRuntime {
  return filePlaybackRuntime;
}

export function getFilePlaybackManager(): FilePlaybackManager {
  return filePlaybackRuntime.manager();
}

export function getActiveFilePlaybackSnapshot(): FilePlaybackSourceSnapshot | null {
  return filePlaybackRuntime.activeSnapshot();
}

export function hasPlayableFileSource(queueItemId?: QueueItemId | null): boolean {
  return filePlaybackRuntime.hasPlayableSource(queueItemId);
}

export function getFilePlaybackDuration(queueItemId?: QueueItemId | null): number | null {
  return filePlaybackRuntime.durationSeconds(queueItemId);
}

export function getManagedFilePlaybackPosition(
  queueItemId?: QueueItemId | null,
): FilePlaybackPosition | null {
  return filePlaybackRuntime.position(queueItemId);
}

export function discardFilePlaybackQueueItem(queueItemId: QueueItemId): Promise<void> {
  return filePlaybackRuntime.discardQueueItem(queueItemId);
}

export function clearFilePlaybackRuntime(): Promise<void> {
  return filePlaybackRuntime.clear();
}
