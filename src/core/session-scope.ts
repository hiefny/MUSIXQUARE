/** Groups cancellable resources owned by one logical session. */

import { clearManagedTimer, setManagedTimer } from './timers.ts';
import { log } from './log.ts';

let nextScopeId = 0;

type ScopeCleanup = () => void;

export class SessionScope {
  private _controller = new AbortController();
  private _timers = new Map<string, string>();
  private _cleanups = new Set<ScopeCleanup>();
  private readonly _timerPrefix = `session-scope:${++nextScopeId}:`;

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get aborted(): boolean {
    return this._controller.signal.aborted;
  }

  /** Throw the signal's AbortError when this scope no longer owns work. */
  throwIfAborted(): void {
    this.signal.throwIfAborted();
  }

  /**
   * Own an arbitrary synchronous cleanup.
   *
   * The returned disposer is safe to call repeatedly and releases the resource
   * immediately. Scope disposal releases remaining resources in reverse
   * registration order. A resource registered after disposal is released
   * immediately so it cannot escape a raced lifecycle boundary.
   */
  own(cleanup: ScopeCleanup): ScopeCleanup {
    let active = true;
    const disposeOwnedResource = (): void => {
      if (!active) return;
      active = false;
      this._cleanups.delete(disposeOwnedResource);
      try {
        cleanup();
      } catch (error) {
        // One faulty teardown must not strand the resources registered before it.
        log.error('[SessionScope] Owned cleanup failed:', error);
      }
    };

    if (this.aborted) {
      disposeOwnedResource();
    } else {
      this._cleanups.add(disposeOwnedResource);
    }
    return disposeOwnedResource;
  }

  /** Create a child that is disposed with this scope but may finish earlier. */
  child(): SessionScope {
    const child = new SessionScope();
    const disposeChild = this.own(() => child.dispose());
    // Finishing the child early also detaches its parent-held cleanup, avoiding
    // retention when a long-lived session creates many short operations.
    child.own(disposeChild);
    return child;
  }

  /** Register a scope-local timer. Equal names in other scopes cannot collide. */
  timer(name: string, fn: () => void, delayMs: number, opts?: { interval?: boolean }): void {
    this.clearTimer(name);
    if (this.aborted) return;

    const interval = opts?.interval === true;
    const managedName = `${this._timerPrefix}${name}`;
    this._timers.set(name, managedName);
    setManagedTimer(
      managedName,
      () => {
        if (this._timers.get(name) !== managedName) return;
        if (!interval) this._timers.delete(name);
        if (this.aborted) return;
        fn();
      },
      delayMs,
      opts,
    );
  }

  clearTimer(name: string): void {
    const managedName = this._timers.get(name);
    if (!managedName) return;
    clearManagedTimer(managedName);
    this._timers.delete(name);
  }

  /** Abort and release every owned resource. Safe to call repeatedly. */
  dispose(): void {
    if (this._controller.signal.aborted) return;

    // Publish cancellation before teardown. Abort-aware work can become inert
    // synchronously even when a later resource cleanup throws.
    this._controller.abort();
    for (const name of Array.from(this._timers.keys())) {
      this.clearTimer(name);
    }
    for (const cleanup of Array.from(this._cleanups).reverse()) {
      cleanup();
    }
  }

  static replace(prev: SessionScope | null): SessionScope {
    prev?.dispose();
    return new SessionScope();
  }
}
