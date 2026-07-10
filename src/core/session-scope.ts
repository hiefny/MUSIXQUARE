/**
 * Groups an AbortSignal with names registered in the page-wide managed timer
 * registry. Timer keys are not namespaced by scope: concurrently live scopes
 * must use distinct names or one scope can replace or clear another's timer.
 */

import { setManagedTimer, clearManagedTimer } from './timers.ts';

export class SessionScope {
  private _controller = new AbortController();
  private _timers = new Set<string>();

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get aborted(): boolean {
    return this._controller.signal.aborted;
  }

  /** Register ownership of a page-global timer name for disposal with this scope. */
  timer(name: string, fn: () => void, delayMs: number, opts?: { interval?: boolean }): void {
    this._timers.add(name);
    setManagedTimer(name, fn, delayMs, opts);
  }

  clearTimer(name: string): void {
    this._timers.delete(name);
    clearManagedTimer(name);
  }

  /** Abort the signal and clear registered timer names. Safe to call repeatedly. */
  dispose(): void {
    if (!this._controller.signal.aborted) {
      this._controller.abort();
    }
    for (const name of this._timers) {
      clearManagedTimer(name);
    }
    this._timers.clear();
  }

  static replace(prev: SessionScope | null): SessionScope {
    prev?.dispose();
    return new SessionScope();
  }
}
