/** Groups an AbortSignal with timers owned by one logical session. */

import { clearManagedTimer, setManagedTimer } from './timers.ts';

let nextScopeId = 0;

export class SessionScope {
  private _controller = new AbortController();
  private _timers = new Map<string, string>();
  private readonly _timerPrefix = `session-scope:${++nextScopeId}:`;

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get aborted(): boolean {
    return this._controller.signal.aborted;
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

  /** Abort the signal and clear registered timer names. Safe to call repeatedly. */
  dispose(): void {
    if (!this._controller.signal.aborted) {
      this._controller.abort();
    }
    for (const name of Array.from(this._timers.keys())) {
      this.clearTimer(name);
    }
  }

  static replace(prev: SessionScope | null): SessionScope {
    prev?.dispose();
    return new SessionScope();
  }
}
