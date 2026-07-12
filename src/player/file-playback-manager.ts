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

interface ManagedSource {
  readonly source: FilePlaybackSource;
  preparePromise: Promise<FilePlaybackSourceSnapshot> | null;
  destroyPromise: Promise<void> | null;
  destroyed: boolean;
  lastSnapshot: FilePlaybackSourceSnapshot;
}

interface PendingOperation {
  readonly state: ManagedSource;
  readonly cancelled: Promise<void>;
  cancel(): void;
}

interface PendingStandbyOperation extends PendingOperation {
  promise: Promise<FilePlaybackPublication>;
}

interface PendingActiveOperation extends PendingOperation {
  readonly destination: AudioNode;
  promise: Promise<FilePlaybackPublication>;
}

type PendingOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cancelled' };

function createPendingOperation<T extends PendingOperation>(
  operation: Omit<T, 'cancelled' | 'cancel'>,
): T {
  let cancelled = false;
  let resolveCancelled!: () => void;
  const cancelledPromise = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  return {
    ...operation,
    cancelled: cancelledPromise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolveCancelled();
    },
  } as T;
}

function waitForOperation<T>(
  operation: PendingOperation,
  task: Promise<T>,
): Promise<PendingOutcome<T>> {
  return Promise.race([
    task.then(
      (value): PendingOutcome<T> => ({ kind: 'value', value }),
      (error: unknown): PendingOutcome<T> => ({ kind: 'error', error }),
    ),
    operation.cancelled.then((): PendingOutcome<T> => ({ kind: 'cancelled' })),
  ]);
}

/**
 * Owns native file playback sources outside the serializable application tree.
 *
 * Exactly one active and one speculative standby source may be published. The
 * pending slot records below are also ownership: replacing, removing, or
 * clearing a slot cancels its continuation before destroying an unowned source.
 * That makes late prepare/connect completion unable to revive a removed item.
 */
export class FilePlaybackManager {
  private active: FilePlaybackSource | null = null;
  private standby: FilePlaybackSource | null = null;
  private pendingActive: PendingActiveOperation | null = null;
  private pendingStandby: PendingStandbyOperation | null = null;
  private readonly sourceStates = new WeakMap<FilePlaybackSource, ManagedSource>();
  private readonly discardedQueueItems = new Set<QueueItemId>();

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

  prepareStandby(source: FilePlaybackSource): Promise<FilePlaybackPublication> {
    const state = this.stateFor(source);
    if (this.discardedQueueItems.has(source.queueItemId) || state.destroyed) {
      return this.rejectAndDestroy(state, 'superseded');
    }

    if (this.pendingStandby?.state === state) return this.pendingStandby.promise;
    if (this.standby === source) {
      return Promise.resolve({ published: true, snapshot: this.snapshotOf(state) });
    }

    if (this.active?.queueItemId === source.queueItemId) {
      return this.rejectDuplicateOfActive(state);
    }

    const pendingActive = this.pendingActive;
    if (pendingActive?.state.source.queueItemId === source.queueItemId) {
      if (pendingActive.state !== state) return this.rejectDuplicateOfActive(state);
      return pendingActive.promise.then((publication) => ({
        published: false,
        reason: publication.published ? 'duplicates-active' : 'superseded',
        snapshot: this.snapshotOf(state),
      }));
    }

    const previousPending = this.pendingStandby;
    const operation = createPendingOperation<PendingStandbyOperation>({
      state,
      promise: null as unknown as Promise<FilePlaybackPublication>,
    });
    this.pendingStandby = operation;
    operation.promise = this.runStandby(operation);

    if (previousPending) {
      previousPending.cancel();
      void this.destroyIfUnowned(previousPending.state);
    }
    return operation.promise;
  }

  activate(source: FilePlaybackSource, destination: AudioNode): Promise<FilePlaybackPublication> {
    const state = this.stateFor(source);
    if (this.discardedQueueItems.has(source.queueItemId) || state.destroyed) {
      return this.rejectAndDestroy(state, 'superseded');
    }

    if (this.pendingActive?.state === state) return this.pendingActive.promise;
    if (this.active === source) {
      return Promise.resolve({ published: true, snapshot: this.snapshotOf(state) });
    }

    const previousPendingActive = this.pendingActive;
    const claimedPendingStandby = this.pendingStandby?.state === state ? this.pendingStandby : null;
    const conflictingPendingStandby =
      this.pendingStandby?.state.source.queueItemId === source.queueItemId &&
      this.pendingStandby.state !== state
        ? this.pendingStandby
        : null;

    if (claimedPendingStandby || conflictingPendingStandby) this.pendingStandby = null;
    if (this.standby === source) this.standby = null;

    const operation = createPendingOperation<PendingActiveOperation>({
      state,
      destination,
      promise: null as unknown as Promise<FilePlaybackPublication>,
    });
    this.pendingActive = operation;
    operation.promise = this.runActive(operation);

    if (previousPendingActive) {
      previousPendingActive.cancel();
      void this.destroyIfUnowned(previousPendingActive.state);
    }
    if (claimedPendingStandby) claimedPendingStandby.cancel();
    if (conflictingPendingStandby) {
      conflictingPendingStandby.cancel();
      void this.destroyIfUnowned(conflictingPendingStandby.state);
    }
    return operation.promise;
  }

  promoteStandby(
    queueItemId: QueueItemId,
    destination: AudioNode,
  ): Promise<FilePlaybackPublication | null> {
    const source =
      this.pendingStandby?.state.source.queueItemId === queueItemId
        ? this.pendingStandby.state.source
        : this.standby?.queueItemId === queueItemId
          ? this.standby
          : null;
    return source ? this.activate(source, destination) : Promise.resolve(null);
  }

  async discardQueueItem(queueItemId: QueueItemId): Promise<void> {
    this.discardedQueueItems.add(queueItemId);
    const states = new Set<ManagedSource>();

    if (this.active?.queueItemId === queueItemId) {
      states.add(this.stateFor(this.active));
      this.active = null;
    }
    if (this.standby?.queueItemId === queueItemId) {
      states.add(this.stateFor(this.standby));
      this.standby = null;
    }
    if (this.pendingActive?.state.source.queueItemId === queueItemId) {
      const operation = this.pendingActive;
      this.pendingActive = null;
      states.add(operation.state);
      operation.cancel();
    }
    if (this.pendingStandby?.state.source.queueItemId === queueItemId) {
      const operation = this.pendingStandby;
      this.pendingStandby = null;
      states.add(operation.state);
      operation.cancel();
    }

    await Promise.all([...states].map((state) => this.destroyState(state)));
  }

  async clear(): Promise<void> {
    const states = new Set<ManagedSource>();
    if (this.active) states.add(this.stateFor(this.active));
    if (this.standby) states.add(this.stateFor(this.standby));
    if (this.pendingActive) states.add(this.pendingActive.state);
    if (this.pendingStandby) states.add(this.pendingStandby.state);

    const pendingActive = this.pendingActive;
    const pendingStandby = this.pendingStandby;
    this.active = null;
    this.standby = null;
    this.pendingActive = null;
    this.pendingStandby = null;
    pendingActive?.cancel();
    pendingStandby?.cancel();

    // A full clear is an authority/session boundary. Late operations above
    // are still excluded by cancelled ownership and destroyed source state,
    // while a future authoritative snapshot may legitimately reuse an ID.
    this.discardedQueueItems.clear();

    await Promise.all([...states].map((state) => this.destroyState(state)));
  }

  private async runStandby(operation: PendingStandbyOperation): Promise<FilePlaybackPublication> {
    const { state } = operation;
    const outcome = await waitForOperation(operation, this.prepareOnce(state));
    if (outcome.kind === 'cancelled') {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }
    if (outcome.kind === 'error') {
      if (this.pendingStandby !== operation || state.destroyed) {
        await this.destroyIfUnowned(state);
        return this.unpublished(state, 'superseded');
      }
      this.pendingStandby = null;
      await this.destroyState(state);
      throw outcome.error;
    }

    if (
      this.pendingStandby !== operation ||
      state.destroyed ||
      this.discardedQueueItems.has(state.source.queueItemId)
    ) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    if (
      this.active?.queueItemId === state.source.queueItemId ||
      this.pendingActive?.state.source.queueItemId === state.source.queueItemId
    ) {
      const duplicatesPublishedActive = this.active?.queueItemId === state.source.queueItemId;
      this.pendingStandby = null;
      await this.destroyIfUnowned(state);
      return this.unpublished(
        state,
        duplicatesPublishedActive ? 'duplicates-active' : 'superseded',
      );
    }

    const previous = this.standby;
    this.standby = state.source;
    if (previous && previous !== state.source) {
      await this.destroyIfUnowned(this.stateFor(previous));
    }

    if (
      this.pendingStandby !== operation ||
      this.standby !== state.source ||
      state.destroyed ||
      this.discardedQueueItems.has(state.source.queueItemId)
    ) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    this.pendingStandby = null;
    return { published: true, snapshot: this.snapshotOf(state) };
  }

  private async runActive(operation: PendingActiveOperation): Promise<FilePlaybackPublication> {
    const { state } = operation;
    const prepared = await waitForOperation(operation, this.prepareOnce(state));
    const preparedFailure = await this.handleActiveOutcome(operation, prepared);
    if (preparedFailure) return preparedFailure;

    const connected = await waitForOperation(
      operation,
      this.connectAndRemember(state, operation.destination),
    );
    const connectedFailure = await this.handleActiveOutcome(operation, connected);
    if (connectedFailure) return connectedFailure;

    if (!this.canPublishActive(operation)) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    const previousActive = this.active;
    const duplicateStandby =
      this.standby?.queueItemId === state.source.queueItemId ? this.standby : null;
    const duplicatePendingStandby =
      this.pendingStandby?.state.source.queueItemId === state.source.queueItemId
        ? this.pendingStandby
        : null;

    this.active = state.source;
    if (duplicateStandby) this.standby = null;
    if (duplicatePendingStandby) {
      this.pendingStandby = null;
      duplicatePendingStandby.cancel();
    }

    const cleanupStates = new Set<ManagedSource>();
    if (previousActive && previousActive !== state.source) {
      cleanupStates.add(this.stateFor(previousActive));
    }
    if (duplicateStandby && duplicateStandby !== state.source) {
      cleanupStates.add(this.stateFor(duplicateStandby));
    }
    if (duplicatePendingStandby && duplicatePendingStandby.state !== state) {
      cleanupStates.add(duplicatePendingStandby.state);
    }
    await Promise.all([...cleanupStates].map((candidate) => this.destroyIfUnowned(candidate)));

    if (!this.canPublishActive(operation) || this.active !== state.source) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    this.pendingActive = null;
    return { published: true, snapshot: this.snapshotOf(state) };
  }

  private async handleActiveOutcome<T>(
    operation: PendingActiveOperation,
    outcome: PendingOutcome<T>,
  ): Promise<FilePlaybackPublication | null> {
    if (outcome.kind === 'value' && this.canPublishActive(operation)) return null;
    if (
      outcome.kind === 'error' &&
      this.pendingActive === operation &&
      !operation.state.destroyed
    ) {
      this.pendingActive = null;
      await this.destroyState(operation.state);
      throw outcome.error;
    }
    await this.destroyIfUnowned(operation.state);
    return this.unpublished(operation.state, 'superseded');
  }

  private canPublishActive(operation: PendingActiveOperation): boolean {
    return (
      this.pendingActive === operation &&
      !operation.state.destroyed &&
      !this.discardedQueueItems.has(operation.state.source.queueItemId)
    );
  }

  private stateFor(source: FilePlaybackSource): ManagedSource {
    const existing = this.sourceStates.get(source);
    if (existing) return existing;
    const state: ManagedSource = {
      source,
      preparePromise: null,
      destroyPromise: null,
      destroyed: false,
      lastSnapshot: source.getSnapshot(),
    };
    this.sourceStates.set(source, state);
    return state;
  }

  private snapshotOf(state: ManagedSource): FilePlaybackSourceSnapshot {
    if (!state.destroyed) {
      try {
        state.lastSnapshot = state.source.getSnapshot();
      } catch {
        // Preserve the last valid snapshot if a failed backend cannot report.
      }
    }
    return state.lastSnapshot;
  }

  private prepareOnce(state: ManagedSource): Promise<FilePlaybackSourceSnapshot> {
    if (state.preparePromise) return state.preparePromise;
    const current = this.snapshotOf(state);
    if (current.phase !== 'new' && current.phase !== 'preparing') {
      state.preparePromise = Promise.resolve(current);
      return state.preparePromise;
    }
    try {
      state.preparePromise = Promise.resolve(state.source.prepare()).then((snapshot) => {
        state.lastSnapshot = snapshot;
        return snapshot;
      });
    } catch (error) {
      state.preparePromise = Promise.reject(error);
    }
    return state.preparePromise;
  }

  private async connectAndRemember(
    state: ManagedSource,
    destination: AudioNode,
  ): Promise<FilePlaybackSourceSnapshot> {
    const snapshot = await state.source.connect(destination);
    state.lastSnapshot = snapshot;
    return snapshot;
  }

  private owns(state: ManagedSource): boolean {
    return (
      this.active === state.source ||
      this.standby === state.source ||
      this.pendingActive?.state === state ||
      this.pendingStandby?.state === state
    );
  }

  private destroyIfUnowned(state: ManagedSource): Promise<void> {
    return this.owns(state) ? Promise.resolve() : this.destroyState(state);
  }

  private destroyState(state: ManagedSource): Promise<void> {
    if (state.destroyPromise) return state.destroyPromise;
    state.destroyed = true;

    let finish!: () => void;
    state.destroyPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      Promise.resolve(state.source.destroy()).then(finish, finish);
    } catch {
      finish();
    }
    return state.destroyPromise;
  }

  private rejectDuplicateOfActive(state: ManagedSource): Promise<FilePlaybackPublication> {
    if (this.active === state.source) {
      return Promise.resolve(this.unpublished(state, 'duplicates-active'));
    }
    return this.rejectAndDestroy(state, 'duplicates-active');
  }

  private async rejectAndDestroy(
    state: ManagedSource,
    reason: 'superseded' | 'duplicates-active',
  ): Promise<FilePlaybackPublication> {
    const publication = this.unpublished(state, reason);
    await this.destroyIfUnowned(state);
    return publication;
  }

  private unpublished(
    state: ManagedSource,
    reason: 'superseded' | 'duplicates-active',
  ): FilePlaybackPublication {
    return { published: false, reason, snapshot: this.snapshotOf(state) };
  }
}
