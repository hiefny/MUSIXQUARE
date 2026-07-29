type ProRoomUploadPhase = 'waiting' | 'uploading' | 'confirming' | 'completed' | 'failed';

export interface ProRoomUploadRow {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly phase: ProRoomUploadPhase;
  readonly progressPercent: number;
}

interface ProRoomUploadTask {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly file: File;
  phase: ProRoomUploadPhase;
  progressPercent: number;
  attempt: number;
  controller: AbortController | null;
}

interface ProRoomUploadRunContext {
  readonly signal: AbortSignal;
  readonly isRetry: boolean;
  onProgress(fraction: number): void;
}

interface ProRoomUploadRunInput {
  readonly id: string;
  readonly file: File;
}

interface ProRoomUploadQueueOptions {
  run(input: ProRoomUploadRunInput, context: ProRoomUploadRunContext): Promise<void>;
  reportFailure?(error: unknown): void;
  signal?: AbortSignal;
  createId?: () => string;
}

type UploadQueueListener = () => void;

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
    name: task.name,
    size: task.size,
    phase: task.phase,
    progressPercent: task.progressPercent,
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
  readonly #reportFailure?: ProRoomUploadQueueOptions['reportFailure'];
  readonly #createId: () => string;
  readonly #listeners = new Set<UploadQueueListener>();
  readonly #tasks: ProRoomUploadTask[] = [];
  readonly #lifetimeSignal?: AbortSignal;
  #pumpPromise: Promise<void> | null = null;
  #disposed = false;

  constructor(options: ProRoomUploadQueueOptions) {
    this.#run = options.run;
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
    const ids: string[] = [];
    for (const file of files) {
      const id = this.#createId();
      if (!id || this.#tasks.some((task) => task.id === id)) {
        throw new Error('PRO_ROOM_UPLOAD_ID_INVALID');
      }
      this.#tasks.push({
        id,
        file,
        name: file.name,
        size: file.size,
        phase: 'waiting',
        progressPercent: 0,
        attempt: 0,
        controller: null,
      });
      ids.push(id);
    }
    this.#notify();
    this.#ensurePump();
    return ids;
  }

  retry(id: string): boolean {
    const task = this.#tasks.find((candidate) => candidate.id === id);
    if (!task || task.phase !== 'failed' || this.#disposed) return false;
    task.phase = 'waiting';
    task.progressPercent = 0;
    this.#notify();
    this.#ensurePump();
    return true;
  }

  remove(id: string): boolean {
    const index = this.#tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0 || this.#tasks[index]?.phase !== 'failed') return false;
    this.#tasks.splice(index, 1);
    this.#notify();
    return true;
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

      const abortFromLifetime = () =>
        controller.abort(this.#lifetimeSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
      this.#lifetimeSignal?.addEventListener('abort', abortFromLifetime, { once: true });
      try {
        await this.#run(
          { id: task.id, file: task.file },
          {
            signal: controller.signal,
            isRetry: attempt > 1,
            onProgress: (fraction) => {
              if (
                controller.signal.aborted ||
                task.attempt !== attempt ||
                !this.#tasks.includes(task)
              ) {
                return;
              }
              const percent = clampPercent(fraction);
              const nextPercent = Math.max(task.progressPercent, percent);
              const phase: ProRoomUploadPhase = nextPercent >= 100 ? 'confirming' : 'uploading';
              if (task.progressPercent === nextPercent && task.phase === phase) return;
              task.progressPercent = nextPercent;
              task.phase = phase;
              this.#notify();
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
        task.controller = null;
        this.#notify();
        try {
          this.#reportFailure?.(error);
        } catch {
          // Failure reporting is observational and cannot own queue progress.
        }
      } finally {
        this.#lifetimeSignal?.removeEventListener('abort', abortFromLifetime);
        if (task.controller === controller) task.controller = null;
      }
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

let activeQueue: ProRoomUploadQueue | null = null;
let unsubscribeActiveQueue: (() => void) | null = null;
const activeQueueListeners = new Set<UploadQueueListener>();

function notifyActiveQueueListeners(): void {
  for (const listener of [...activeQueueListeners]) {
    try {
      listener();
    } catch {
      // One detached view must not block the remaining projection observers.
    }
  }
}

export function setActiveProRoomUploadQueue(queue: ProRoomUploadQueue | null): void {
  if (activeQueue === queue) return;
  unsubscribeActiveQueue?.();
  unsubscribeActiveQueue = null;
  activeQueue = queue;
  if (queue) unsubscribeActiveQueue = queue.subscribe(notifyActiveQueueListeners);
  notifyActiveQueueListeners();
}

export function getProRoomUploadRows(): readonly ProRoomUploadRow[] {
  return activeQueue?.rows ?? [];
}

export function subscribeProRoomUploadRows(listener: UploadQueueListener): () => void {
  activeQueueListeners.add(listener);
  return () => activeQueueListeners.delete(listener);
}

export function retryProRoomUpload(id: string): boolean {
  return activeQueue?.retry(id) ?? false;
}

export function removeProRoomUpload(id: string): boolean {
  return activeQueue?.remove(id) ?? false;
}

export function cancelProRoomUpload(id: string): boolean {
  return activeQueue?.cancel(id) ?? false;
}

export function acknowledgeCommittedProRoomUploads(ids: ReadonlySet<string>): boolean {
  return activeQueue?.acknowledgeCommitted(ids) ?? false;
}
