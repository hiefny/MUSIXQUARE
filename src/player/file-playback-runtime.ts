import { getState } from '../core/state.ts';
import type { QueueItemId } from '../types/index.ts';
import { getCurrentAudioBuffer } from './_state.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import { FilePlaybackManager, type FilePlaybackManagerSnapshot } from './file-playback-manager.ts';
import { getFilePlaybackProductRuntime } from './file-playback-product-runtime.ts';
import { createPlaybackStateIdentity } from './playback-identity.ts';
import { isQueueItemId } from './queue-model.ts';
import type {
  FilePlaybackPosition,
  FilePlaybackSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';
import { createFilePlaybackSourceSnapshot } from './file-playback-source.ts';

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
  readonly backend: 'audio-buffer' | 'bounded-stream' | 'legacy-audio-buffer' | null;
  readonly queueItemId: QueueItemId | null;
  readonly durationSeconds: number | null;
}

/** Narrow JSON-safe projection capability implemented by the product runtime. */
export interface FilePlaybackProductProjectionPort {
  currentHostRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  currentGuestRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  hostPositionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
  guestPositionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
}

export interface FilePlaybackReadProjectionOptions {
  /** Captured once for this projection facade's complete document lifetime. */
  readonly v2Enabled: boolean;
  readonly legacyRuntime: FilePlaybackRuntime;
  readonly productRuntime: FilePlaybackProductProjectionPort;
  readonly monotonicNow?: () => number;
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

function canonicalPosition(value: unknown): FilePlaybackPosition | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = Object.freeze([
      'bufferedAheadSeconds',
      'phase',
      'positionSeconds',
      'queueItemId',
      'run',
      'underrunCount',
    ] as const);
    const expected = new Set<string>(expectedKeys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    if (
      !isQueueItemId(snapshot.queueItemId) ||
      !PLAYABLE_MANAGED_PHASES.has(snapshot.phase as FilePlaybackSourcePhase) ||
      typeof snapshot.positionSeconds !== 'number' ||
      !Number.isFinite(snapshot.positionSeconds) ||
      snapshot.positionSeconds < 0 ||
      typeof snapshot.bufferedAheadSeconds !== 'number' ||
      !Number.isFinite(snapshot.bufferedAheadSeconds) ||
      snapshot.bufferedAheadSeconds < 0 ||
      typeof snapshot.underrunCount !== 'number' ||
      !Number.isSafeInteger(snapshot.underrunCount) ||
      snapshot.underrunCount < 0
    ) {
      return null;
    }
    if (snapshot.run === null) return null;
    const run = createPlaybackStateIdentity(
      snapshot.run as Parameters<typeof createPlaybackStateIdentity>[0],
    );
    if (run.queueItemId !== snapshot.queueItemId) return null;
    return Object.freeze({
      queueItemId: snapshot.queueItemId as QueueItemId,
      run,
      phase: snapshot.phase as FilePlaybackSourcePhase,
      positionSeconds: snapshot.positionSeconds,
      bufferedAheadSeconds: snapshot.bufferedAheadSeconds,
      underrunCount: snapshot.underrunCount,
    });
  } catch {
    return null;
  }
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
    const cutoverPort = this.#manager.currentCutoverPort();
    if (cutoverPort) {
      const position = this.#manager.currentCutoverPosition(cutoverPort, this.#monotonicNow());
      if (!position || (queueItemId != null && position.queueItemId !== queueItemId)) return null;
      return position;
    }

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

/**
 * Document-lifetime read bridge between the selected product engine and the
 * legacy runtime. V2 never consults the legacy manager or AudioBuffer shadow:
 * until guest projection exists, a guest therefore returns null/false.
 */
export class FilePlaybackReadProjection {
  readonly #v2Enabled: boolean;
  readonly #legacyRuntime: FilePlaybackRuntime;
  readonly #productRuntime: FilePlaybackProductProjectionPort;
  readonly #monotonicNow: () => number;

  constructor(options: FilePlaybackReadProjectionOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.v2Enabled !== 'boolean' ||
      !(options.legacyRuntime instanceof FilePlaybackRuntime) ||
      !options.productRuntime ||
      typeof options.productRuntime !== 'object' ||
      typeof options.productRuntime.currentHostRendererSnapshot !== 'function' ||
      typeof options.productRuntime.currentGuestRendererSnapshot !== 'function' ||
      typeof options.productRuntime.hostPositionAt !== 'function' ||
      typeof options.productRuntime.guestPositionAt !== 'function' ||
      (options.monotonicNow !== undefined && typeof options.monotonicNow !== 'function')
    ) {
      throw new TypeError('File playback read projection options are invalid');
    }
    this.#v2Enabled = options.v2Enabled;
    this.#legacyRuntime = options.legacyRuntime;
    this.#productRuntime = options.productRuntime;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  activeSnapshot(): FilePlaybackSourceSnapshot | null {
    if (!this.#v2Enabled) return this.#legacyRuntime.activeSnapshot();
    try {
      const snapshot =
        this.#productRuntime.currentHostRendererSnapshot() ??
        this.#productRuntime.currentGuestRendererSnapshot();
      if (!snapshot) return null;
      const canonical = createFilePlaybackSourceSnapshot(snapshot);
      return isQueueItemId(canonical.queueItemId) ? canonical : null;
    } catch {
      return null;
    }
  }

  hasPlayableSource(queueItemId?: QueueItemId | null): boolean {
    if (!this.#v2Enabled) return this.#legacyRuntime.hasPlayableSource(queueItemId);
    const snapshot = this.activeSnapshot();
    return snapshotMatches(snapshot, queueItemId) && PLAYABLE_MANAGED_PHASES.has(snapshot.phase);
  }

  durationSeconds(queueItemId?: QueueItemId | null): number | null {
    if (!this.#v2Enabled) return this.#legacyRuntime.durationSeconds(queueItemId);
    const snapshot = this.activeSnapshot();
    return snapshotMatches(snapshot, queueItemId) && PLAYABLE_MANAGED_PHASES.has(snapshot.phase)
      ? finiteDuration(snapshot.durationSeconds)
      : null;
  }

  position(queueItemId?: QueueItemId | null): FilePlaybackPosition | null {
    if (!this.#v2Enabled) return this.#legacyRuntime.position(queueItemId);
    try {
      const now = this.#monotonicNow();
      if (!Number.isFinite(now) || now < 0) return null;
      const position = canonicalPosition(
        this.#productRuntime.hostPositionAt(now) ?? this.#productRuntime.guestPositionAt(now),
      );
      return position && (queueItemId == null || position.queueItemId === queueItemId)
        ? position
        : null;
    } catch {
      return null;
    }
  }
}

const filePlaybackRuntime = new FilePlaybackRuntime();
const productProjectionPort: FilePlaybackProductProjectionPort = Object.freeze({
  currentHostRendererSnapshot: () => getFilePlaybackProductRuntime().currentHostRendererSnapshot(),
  currentGuestRendererSnapshot: () =>
    getFilePlaybackProductRuntime().currentGuestRendererSnapshot(),
  hostPositionAt: (localPerformanceTimeMs: number) =>
    getFilePlaybackProductRuntime().hostPositionAt(localPerformanceTimeMs),
  guestPositionAt: (localPerformanceTimeMs: number) =>
    getFilePlaybackProductRuntime().guestPositionAt(localPerformanceTimeMs),
});
const filePlaybackReadProjection = new FilePlaybackReadProjection({
  v2Enabled: isFilePlaybackEngineV2Enabled(),
  legacyRuntime: filePlaybackRuntime,
  productRuntime: productProjectionPort,
});

export function getFilePlaybackManager(): FilePlaybackManager {
  return filePlaybackRuntime.manager();
}

export function getActiveFilePlaybackSnapshot(): FilePlaybackSourceSnapshot | null {
  return filePlaybackReadProjection.activeSnapshot();
}

export function hasPlayableFileSource(queueItemId?: QueueItemId | null): boolean {
  return filePlaybackReadProjection.hasPlayableSource(queueItemId);
}

export function getManagedFilePlaybackPosition(
  queueItemId?: QueueItemId | null,
): FilePlaybackPosition | null {
  return filePlaybackReadProjection.position(queueItemId);
}

/** Migration-only legacy mutation; this intentionally does not clear a live V2 product room. */
export function clearFilePlaybackRuntime(): Promise<void> {
  return filePlaybackRuntime.clear();
}
