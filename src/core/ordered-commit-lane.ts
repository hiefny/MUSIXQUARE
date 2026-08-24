/** Concurrent preparation with arrival-ordered, lifecycle-bound commits. */

import { SessionScope } from './session-scope.ts';

interface OrderedCommitTask<T> {
  /** Starts immediately and may run concurrently with other preparations. */
  prepare(signal: AbortSignal): T | Promise<T>;
  /** Runs only after earlier commits in this lane have settled. */
  commit(value: T, signal: AbortSignal): void | Promise<void>;
}

type Prepared<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

const LANE_ABORTED = Symbol('ordered-commit-lane-aborted');

/**
 * Serializes only the mutation boundary, not the expensive preparation.
 * Create separate instances for independent domains so a slow task cannot
 * block unrelated control, heartbeat, or data-plane work.
 */
export class OrderedCommitLane {
  readonly #scope: SessionScope;
  readonly #aborted: Promise<typeof LANE_ABORTED>;
  #tail: Promise<void> = Promise.resolve();

  constructor(parentScope: SessionScope) {
    this.#scope = parentScope.child();
    this.#aborted = new Promise((resolve) => {
      this.#scope.own(() => resolve(LANE_ABORTED));
    });
  }

  get signal(): AbortSignal {
    return this.#scope.signal;
  }

  get disposed(): boolean {
    return this.#scope.aborted;
  }

  /** Stop this lane without disposing sibling resources in the parent scope. */
  dispose(): void {
    this.#scope.dispose();
  }

  enqueue<T>(task: OrderedCommitTask<T>): Promise<void> {
    if (this.disposed) return Promise.resolve();

    // Invoke preparation before touching the tail: all preparations start in
    // arrival order without waiting for an earlier network or metadata read.
    let prepared: Promise<Prepared<T>>;
    try {
      prepared = Promise.resolve(task.prepare(this.signal)).then(
        (value): Prepared<T> => ({ ok: true, value }),
        (error): Prepared<T> => ({ ok: false, error }),
      );
    } catch (error) {
      prepared = Promise.resolve({ ok: false, error });
    }

    const operation = this.#tail.then(async () => {
      if (this.disposed) return;
      const result = await Promise.race([prepared, this.#aborted]);
      if (result === LANE_ABORTED || this.disposed) return;
      if (!result.ok) throw result.error;
      // A commit must still use the signal to suppress its own post-await side
      // effects. Racing it here is a liveness guarantee for lane callers: a
      // non-cooperative commit cannot keep teardown or queued task promises
      // pending forever after this lane has lost ownership.
      await Promise.race([Promise.resolve(task.commit(result.value, this.signal)), this.#aborted]);
    });

    // Keep the internal queue live after a rejected task. The original
    // operation remains rejectable to its caller while this handled branch
    // also prevents an ignored result from becoming an unhandled rejection.
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
