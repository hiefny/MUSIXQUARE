/**
 * Mechanics shared by the PRO room's persisted resources (room effects and
 * queue mode): one serial mutation lock and one coalescing refresh flight per
 * resource.
 *
 * The domain rules deliberately stay with the caller. Whether a snapshot still
 * requires a refresh and which of two snapshots is newer are injected, and
 * the checkpoint, conflict, retry, and cancellation algorithms are not part of
 * this lane because the two resources intentionally differ there.
 *
 * Refresh contract (unchanged from the per-resource copies it replaces):
 * - The runtime generation is read when refresh() is called and again on every
 *   pass; a pass whose flight generation is stale resolves false without
 *   running, and a stale flight never starts another pass.
 * - A call for the same generation and room joins the in-flight refresh: its
 *   snapshot is folded into the pending target and it receives the identical
 *   flight promise. Only the creator's runUnlocked is ever used.
 * - After each pass, a pending snapshot for the same room that still requires
 *   a refresh starts one more pass on the newer target, even after a failure.
 *   Otherwise the last pass's failure is rethrown, or the accumulated result
 *   (true if any pass applied) is returned.
 * - The in-flight slot is installed after the flight starts and is cleared
 *   only while it still holds that flight.
 */
interface PersistedResourceRefreshFlight<TSnapshot> {
  generation: number;
  roomCode: string;
  pendingSnapshot: TSnapshot | null;
  promise: Promise<boolean>;
}

interface PersistedResourceLaneOptions<TSnapshot> {
  readonly runtimeGeneration: () => number;
  readonly refreshStillRequired: (snapshot: TSnapshot) => boolean;
  readonly newerRefreshSnapshot: (current: TSnapshot, candidate: TSnapshot) => TSnapshot;
}

export class PersistedResourceLane<TSnapshot extends { readonly roomCode: string }> {
  readonly #options: PersistedResourceLaneOptions<TSnapshot>;
  #mutationTail: Promise<void> = Promise.resolve();
  #refreshInFlight: PersistedResourceRefreshFlight<TSnapshot> | null = null;

  constructor(options: PersistedResourceLaneOptions<TSnapshot>) {
    this.#options = options;
  }

  /** Runs operation after every earlier lane operation settles. */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Coalesces refreshes for one room and generation into a single flight. */
  refresh(
    snapshot: TSnapshot,
    runUnlocked: (target: TSnapshot) => Promise<boolean>,
  ): Promise<boolean> {
    const { runtimeGeneration, refreshStillRequired, newerRefreshSnapshot } = this.#options;
    const generation = runtimeGeneration();
    const existing = this.#refreshInFlight;
    if (existing && existing.generation === generation && existing.roomCode === snapshot.roomCode) {
      existing.pendingSnapshot = existing.pendingSnapshot
        ? newerRefreshSnapshot(existing.pendingSnapshot, snapshot)
        : snapshot;
      return existing.promise;
    }

    const flight: PersistedResourceRefreshFlight<TSnapshot> = {
      generation,
      roomCode: snapshot.roomCode,
      pendingSnapshot: null,
      promise: Promise.resolve(false),
    };
    flight.promise = (async () => {
      let target = snapshot;
      let applied = false;
      try {
        for (;;) {
          let failure: unknown = null;
          try {
            applied =
              (await this.enqueue(() =>
                flight.generation === runtimeGeneration()
                  ? runUnlocked(target)
                  : Promise.resolve(false),
              )) || applied;
          } catch (error) {
            failure = error;
          }

          if (flight.generation !== runtimeGeneration()) {
            if (failure) throw failure;
            return applied;
          }
          const pending = flight.pendingSnapshot;
          flight.pendingSnapshot = null;
          if (pending && pending.roomCode === flight.roomCode && refreshStillRequired(pending)) {
            target = newerRefreshSnapshot(target, pending);
            continue;
          }
          if (failure) throw failure;
          return applied;
        }
      } finally {
        if (this.#refreshInFlight === flight) this.#refreshInFlight = null;
      }
    })();
    this.#refreshInFlight = flight;
    return flight.promise;
  }

  /** Detaches from the current lock tail and refresh flight. */
  reset(): void {
    this.#mutationTail = Promise.resolve();
    this.#refreshInFlight = null;
  }
}
