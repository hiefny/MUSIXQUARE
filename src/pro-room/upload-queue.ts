import { PRO_ROOM_MAX_ASSET_BYTES } from './contracts.ts';
import type { ProRoomLocalFileRetryState } from './playlist-state-manager.ts';

type ProRoomUploadPhase = 'waiting' | 'uploading' | 'confirming' | 'completed' | 'failed';

export interface ProRoomUploadRow {
  readonly id: string;
  readonly batchId: string;
  readonly name: string;
  readonly size: number;
  readonly phase: ProRoomUploadPhase;
}

interface ProRoomUploadTask {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly file: File;
  readonly batchId: string;
  batchRound: number;
  phase: ProRoomUploadPhase;
  progressPercent: number;
  attempt: number;
  controller: AbortController | null;
  readonly retryState: ProRoomLocalFileRetryState;
  failure: ProRoomUploadFailure | null;
}

interface ProRoomUploadFailure {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly code: string | null;
  readonly retryable: boolean;
}

interface ProRoomUploadBatch {
  readonly id: string;
  round: number;
  requestedCount: number;
  roundTaskIds: string[];
  pendingIds: Set<string>;
  failedIds: Set<string>;
  cancelledIds: Set<string>;
  settled: boolean;
}

interface ProRoomUploadRunContext {
  readonly signal: AbortSignal;
  readonly batchId: string;
  readonly current: number;
  readonly total: number;
  readonly round: number;
  readonly isRetry: boolean;
  onProgress(fraction: number): void;
}

interface ProRoomUploadRunInput {
  readonly id: string;
  readonly file: File;
  readonly retryState: ProRoomLocalFileRetryState;
}

interface ProRoomUploadBatchSettledResult {
  readonly batchId: string;
  readonly round: number;
  readonly requestedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly failedIds: readonly string[];
  readonly failures: readonly ProRoomUploadFailure[];
  readonly retryableCount: number;
}

interface ProRoomUploadQueueOptions {
  run(input: ProRoomUploadRunInput, context: ProRoomUploadRunContext): Promise<void>;
  onBatchSettled?(result: ProRoomUploadBatchSettledResult): void;
  reportFailure?(error: unknown): void;
  signal?: AbortSignal;
  createId?: () => string;
}

export type UploadQueueListener = () => void;

function defaultUploadId(): string {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
    throw new Error('PRO_ROOM_UPLOAD_SECURE_RANDOM_UNAVAILABLE');
  }
  return globalThis.crypto.randomUUID();
}

function clampPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

function publicRow(task: ProRoomUploadTask): ProRoomUploadRow {
  return {
    id: task.id,
    batchId: task.batchId,
    name: task.name,
    size: task.size,
    phase: task.phase,
  };
}

function uploadFailure(task: ProRoomUploadTask, error: unknown): ProRoomUploadFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return {
    id: task.id,
    name: task.name,
    size: task.size,
    code,
    // A retained retry stays pinned to the playlist slot its upload started
    // in, so a playlist switch fails the same way on every retry. A room
    // that cannot hold more tracks does not free room before the user removes
    // some and server cleanup runs.
    retryable:
      code !== 'PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID' &&
      code !== 'PRO_ROOM_MEDIA_UPLOAD_RETRY_MISMATCH' &&
      code !== 'PRO_ROOM_MEDIA_COMPLETE_MISMATCH' &&
      code !== 'PRO_ROOM_PLAYLIST_QUEUE_ITEM_COLLISION' &&
      code !== 'PRO_ROOM_PLAYLIST_SWITCHED' &&
      code !== 'ROOM_STATE_CAPACITY_EXCEEDED' &&
      code !== 'ASSET_CAPACITY_EXCEEDED' &&
      code !== 'ASSET_NOT_FOUND' &&
      code !== 'ASSET_NOT_READY' &&
      code !== 'UPLOAD_MISMATCH' &&
      code !== 'UPLOAD_INCOMPLETE',
  };
}

/**
 * Session-local projection of PRO uploads.
 *
 * These rows deliberately never enter playlist state. The server snapshot
 * remains the only source of committed queue items; a successful temporary row
 * is removed after observers have seen its terminal state.
 */
export class ProRoomUploadQueue {
  readonly #run: ProRoomUploadQueueOptions['run'];
  readonly #onBatchSettled?: ProRoomUploadQueueOptions['onBatchSettled'];
  readonly #reportFailure?: ProRoomUploadQueueOptions['reportFailure'];
  readonly #createId: () => string;
  readonly #listeners = new Set<UploadQueueListener>();
  readonly #tasks: ProRoomUploadTask[] = [];
  readonly #batches = new Map<string, ProRoomUploadBatch>();
  readonly #lifetimeSignal?: AbortSignal;
  #pumpPromise: Promise<void> | null = null;
  #nextBatchSequence = 0;
  #disposed = false;

  constructor(options: ProRoomUploadQueueOptions) {
    this.#run = options.run;
    this.#onBatchSettled = options.onBatchSettled;
    this.#reportFailure = options.reportFailure;
    this.#createId = options.createId ?? defaultUploadId;
    this.#lifetimeSignal = options.signal;
    if (options.signal?.aborted) {
      this.#disposed = true;
    } else {
      options.signal?.addEventListener('abort', this.#handleLifetimeAbort, { once: true });
    }
  }

  get rows(): readonly ProRoomUploadRow[] {
    return this.#tasks.map(publicRow);
  }

  subscribe(listener: UploadQueueListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  enqueueFiles(files: readonly File[]): string[] {
    if (this.#disposed || files.length === 0) return [];
    const batchId = `batch-${++this.#nextBatchSequence}`;
    const tasks: ProRoomUploadTask[] = [];
    const reservedIds = new Set(this.#tasks.map((task) => task.id));
    for (const file of files) {
      const id = this.#createId();
      if (!id || reservedIds.has(id)) {
        throw new Error('PRO_ROOM_UPLOAD_ID_INVALID');
      }
      reservedIds.add(id);
      tasks.push({
        id,
        file,
        name: file.name,
        size: file.size,
        batchId,
        batchRound: 1,
        phase: 'waiting',
        progressPercent: 0,
        attempt: 0,
        controller: null,
        retryState: { media: {} },
        failure: null,
      });
    }
    const ids = tasks.map((task) => task.id);
    this.#batches.set(batchId, {
      id: batchId,
      round: 1,
      requestedCount: tasks.length,
      roundTaskIds: [...ids],
      pendingIds: new Set(ids),
      failedIds: new Set(),
      cancelledIds: new Set(),
      settled: false,
    });
    this.#tasks.push(...tasks);
    this.#notify();
    this.#ensurePump();
    return ids;
  }

  retryFailedBatch(batchId: string): boolean {
    const batch = this.#batches.get(batchId);
    if (!batch || !batch.settled || batch.failedIds.size === 0 || this.#disposed) return false;
    const failedTasks = batch.roundTaskIds
      .map((id) => this.#tasks.find((task) => task.id === id))
      .filter((task): task is ProRoomUploadTask =>
        Boolean(
          task &&
          task.batchId === batch.id &&
          task.batchRound === batch.round &&
          task.phase === 'failed' &&
          task.failure?.retryable &&
          batch.failedIds.has(task.id),
        ),
      );
    if (failedTasks.length === 0) {
      this.dismissFailedBatch(batchId);
      return false;
    }

    // The dialog has already shown permanent failures. Release their File
    // objects when the user retries only the recoverable remainder.
    const retriedIds = new Set(failedTasks.map((task) => task.id));
    const retained = this.#tasks.filter(
      (task) =>
        task.batchId !== batchId || !batch.failedIds.has(task.id) || retriedIds.has(task.id),
    );
    this.#tasks.splice(0, this.#tasks.length, ...retained);

    batch.round += 1;
    batch.requestedCount = failedTasks.length;
    batch.roundTaskIds = failedTasks.map((task) => task.id);
    batch.pendingIds = new Set(batch.roundTaskIds);
    batch.failedIds.clear();
    batch.cancelledIds.clear();
    batch.settled = false;
    for (const task of failedTasks) {
      task.batchRound = batch.round;
      task.phase = 'waiting';
      task.progressPercent = 0;
      task.failure = null;
    }
    this.#notify();
    this.#ensurePump();
    return true;
  }

  dismissFailedBatch(batchId: string): boolean {
    const batch = this.#batches.get(batchId);
    if (!batch || !batch.settled || batch.failedIds.size === 0) return false;
    const failedIds = new Set(batch.failedIds);
    const retained = this.#tasks.filter(
      (task) => task.batchId !== batchId || !failedIds.has(task.id) || task.phase !== 'failed',
    );
    const removed = retained.length !== this.#tasks.length;
    this.#tasks.splice(0, this.#tasks.length, ...retained);
    this.#batches.delete(batchId);
    if (removed) this.#notify();
    return removed;
  }

  acknowledgeCommitted(ids: ReadonlySet<string>): boolean {
    if (ids.size === 0 || this.#tasks.length === 0) return false;
    const committed = this.#tasks.filter((task) => ids.has(task.id));
    if (committed.length === 0) return false;
    for (const task of committed) {
      task.controller?.abort(new DOMException('PRO upload committed', 'AbortError'));
    }
    const retained = this.#tasks.filter((task) => !ids.has(task.id));
    this.#tasks.splice(0, this.#tasks.length, ...retained);
    for (const task of committed) this.#acknowledgeBatchTask(task);
    this.#notify();
    return true;
  }

  cancel(id: string): boolean {
    const index = this.#tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    const task = this.#tasks[index]!;
    if (task.phase !== 'waiting' && task.phase !== 'uploading') return false;
    this.#tasks.splice(index, 1);
    task.controller?.abort(new DOMException('PRO upload cancelled', 'AbortError'));
    this.#finishBatchTask(task, 'cancelled');
    this.#notify();
    return true;
  }

  reset(): void {
    if (this.#disposed && this.#tasks.length === 0) return;
    this.#disposed = true;
    this.#lifetimeSignal?.removeEventListener('abort', this.#handleLifetimeAbort);
    for (const task of this.#tasks) {
      task.controller?.abort(new DOMException('PRO upload queue reset', 'AbortError'));
    }
    this.#tasks.length = 0;
    this.#batches.clear();
    this.#notify();
  }

  async whenIdle(): Promise<void> {
    while (this.#pumpPromise) await this.#pumpPromise;
  }

  readonly #handleLifetimeAbort = (): void => {
    this.reset();
  };

  #ensurePump(): void {
    if (this.#pumpPromise || this.#disposed) return;
    this.#pumpPromise = this.#pump().finally(() => {
      this.#pumpPromise = null;
      if (!this.#disposed && this.#tasks.some((task) => task.phase === 'waiting')) {
        this.#ensurePump();
      }
    });
  }

  async #pump(): Promise<void> {
    while (!this.#disposed) {
      const task = this.#tasks.find((candidate) => candidate.phase === 'waiting');
      if (!task) return;
      task.attempt += 1;
      const attempt = task.attempt;
      const controller = new AbortController();
      task.controller = controller;
      task.phase = 'uploading';
      task.progressPercent = 0;
      this.#notify();

      const batch = this.#batches.get(task.batchId);
      if (
        !batch ||
        batch.settled ||
        batch.round !== task.batchRound ||
        !batch.pendingIds.has(task.id)
      ) {
        task.phase = 'failed';
        this.#notify();
        continue;
      }
      const round = batch.round;
      const current = batch.roundTaskIds.indexOf(task.id) + 1;
      const total = batch.requestedCount;

      const abortFromLifetime = () =>
        controller.abort(this.#lifetimeSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
      this.#lifetimeSignal?.addEventListener('abort', abortFromLifetime, { once: true });
      try {
        if (
          !Number.isSafeInteger(task.size) ||
          task.size <= 0 ||
          task.size > PRO_ROOM_MAX_ASSET_BYTES
        ) {
          throw Object.assign(new Error('PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID'), {
            code: 'PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID',
          });
        }
        await this.#run(
          { id: task.id, file: task.file, retryState: task.retryState },
          {
            signal: controller.signal,
            batchId: batch.id,
            current,
            total,
            round,
            isRetry: round > 1 || attempt > 1,
            onProgress: (fraction) => {
              if (
                controller.signal.aborted ||
                task.controller !== controller ||
                task.attempt !== attempt ||
                !this.#tasks.includes(task)
              ) {
                return;
              }
              const percent = clampPercent(fraction);
              const nextPercent = Math.max(task.progressPercent, percent);
              const phase: ProRoomUploadPhase = nextPercent >= 100 ? 'confirming' : 'uploading';
              if (task.progressPercent === nextPercent && task.phase === phase) return;
              const phaseChanged = task.phase !== phase;
              task.progressPercent = nextPercent;
              task.phase = phase;
              if (phaseChanged) this.#notify();
            },
          },
        );
        if (controller.signal.aborted || task.attempt !== attempt || !this.#tasks.includes(task)) {
          continue;
        }
        task.phase = 'completed';
        task.progressPercent = 100;
        task.controller = null;
        this.#notify();
        this.#finishBatchTask(task, 'completed');
        queueMicrotask(() => {
          const index = this.#tasks.indexOf(task);
          if (index < 0 || task.phase !== 'completed' || task.attempt !== attempt) return;
          this.#tasks.splice(index, 1);
          this.#notify();
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          task.attempt !== attempt ||
          !this.#tasks.includes(task) ||
          this.#disposed
        ) {
          continue;
        }
        task.phase = 'failed';
        task.failure = uploadFailure(task, error);
        task.controller = null;
        this.#notify();
        try {
          this.#reportFailure?.(error);
        } catch {
          // Failure reporting is observational and cannot own queue progress.
        }
        this.#finishBatchTask(task, 'failed');
      } finally {
        this.#lifetimeSignal?.removeEventListener('abort', abortFromLifetime);
        if (task.controller === controller) task.controller = null;
      }
    }
  }

  #finishBatchTask(task: ProRoomUploadTask, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const batch = this.#batches.get(task.batchId);
    if (
      !batch ||
      batch.settled ||
      batch.round !== task.batchRound ||
      !batch.pendingIds.delete(task.id)
    ) {
      return;
    }
    if (outcome === 'failed') batch.failedIds.add(task.id);
    if (outcome === 'cancelled') batch.cancelledIds.add(task.id);
    if (batch.pendingIds.size === 0) this.#settleBatch(batch);
  }

  #acknowledgeBatchTask(task: ProRoomUploadTask): void {
    const batch = this.#batches.get(task.batchId);
    if (!batch || batch.round !== task.batchRound) return;
    if (!batch.settled && batch.pendingIds.has(task.id)) {
      this.#finishBatchTask(task, 'completed');
      return;
    }
    if (!batch.settled || !batch.failedIds.delete(task.id)) return;
    if (batch.failedIds.size === 0) this.#batches.delete(batch.id);
  }

  #settleBatch(batch: ProRoomUploadBatch): void {
    if (batch.settled || batch.pendingIds.size !== 0) return;
    batch.settled = true;
    const failedIds = batch.roundTaskIds.filter((id) => batch.failedIds.has(id));
    batch.failedIds = new Set(failedIds);
    const failures = failedIds.flatMap((id) => {
      const failure = this.#tasks.find((task) => task.id === id)?.failure;
      return failure ? [failure] : [];
    });
    const result: ProRoomUploadBatchSettledResult = {
      batchId: batch.id,
      round: batch.round,
      requestedCount: batch.requestedCount,
      failedCount: failedIds.length,
      cancelledCount: batch.cancelledIds.size,
      failedIds,
      failures,
      retryableCount: failures.filter((failure) => failure.retryable).length,
    };
    if (failedIds.length === 0) this.#batches.delete(batch.id);
    try {
      this.#onBatchSettled?.(result);
    } catch {
      // Batch observers cannot own upload integrity or queue progression.
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // UI observers cannot own transfer integrity or queue progression.
      }
    }
  }
}
