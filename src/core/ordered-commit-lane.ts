/** Concurrent preparation with arrival-ordered, lifecycle-bound commits. */

import { SessionScope } from './session-scope.ts';
import { raceWithAbortSignal } from './request-lifetime.ts';

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
  #tail: Promise<void> = Promise.resolve();

  constructor(parentScope: SessionScope) {
    this.#scope = parentScope.child();
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

  async #waitWhileOwned<T>(operation: PromiseLike<T>): Promise<T | typeof LANE_ABORTED> {
    try {
      return await raceWithAbortSignal(operation, this.signal);
    } catch (error) {
      if (this.disposed) return LANE_ABORTED;
      throw error;
    }
  }

  enqueue<T>(task: OrderedCommitTask<T>): Promise<void> {
    if (this.disposed) return Promise.resolve();

    // Reserve this task's commit position before preparation starts. A
    // synchronous preparation may re-enter enqueue(), but the nested task must
    // still commit after the task whose preparation triggered it.
    let prepared!: Promise<Prepared<T>>;
    const operation = this.#tail.then(async () => {
      if (this.disposed) return;
      const result = await this.#waitWhileOwned(prepared);
      if (result === LANE_ABORTED || this.disposed) return;
      if (!result.ok) throw result.error;
      // A commit must still use the signal to suppress its own post-await side
      // effects. Racing it here is a liveness guarantee for lane callers: a
      // non-cooperative commit cannot keep teardown or queued task promises
      // pending forever after this lane has lost ownership.
      await this.#waitWhileOwned(Promise.resolve(task.commit(result.value, this.signal)));
    });

    // Keep the internal queue live after a rejected task. The original
    // operation remains rejectable to its caller while this handled branch
    // also prevents an ignored result from becoming an unhandled rejection.
    this.#tail = operation.catch(() => undefined);

    // Preparations still start immediately and concurrently after their commit
    // positions have been reserved.
    try {
      prepared = Promise.resolve(task.prepare(this.signal)).then(
        (value): Prepared<T> => ({ ok: true, value }),
        (error): Prepared<T> => ({ ok: false, error }),
      );
    } catch (error) {
      prepared = Promise.resolve({ ok: false, error });
    }
    return operation;
  }
}
