/**
 * MUSIXQUARE — SessionScope
 *
 * Unified async lifecycle management.
 * Wraps AbortController + managed timer registry so that
 * long-running operations (file transfer, preload, YouTube load, track decode)
 * can be cleanly cancelled when a new operation starts.
 *
 * Usage:
 *   let _scope: SessionScope | null = null;
 *
 *   function startOperation() {
 *     _scope = SessionScope.replace(_scope);  // cancels previous
 *     const { signal } = _scope;
 *     // in async loop: if (signal.aborted) return;
 *     // register scoped timers: _scope.timer('name', fn, ms);
 *   }
 */

import { setManagedTimer, clearManagedTimer } from './timers.ts';

export class SessionScope {
  private _controller = new AbortController();
  private _timers = new Set<string>();

  /** AbortSignal — pass to fetch() or check in async loops. */
  get signal(): AbortSignal { return this._controller.signal; }

  /** Whether this scope has been disposed/cancelled. */
  get aborted(): boolean { return this._controller.signal.aborted; }

  /**
   * Register a managed timer scoped to this session.
   * When the scope is disposed, all registered timers are automatically cleared.
   */
  timer(name: string, fn: () => void, delayMs: number, opts?: { interval?: boolean }): void {
    this._timers.add(name);
    setManagedTimer(name, fn, delayMs, opts);
  }

  /**
   * Clear a specific timer registered in this scope.
   */
  clearTimer(name: string): void {
    this._timers.delete(name);
    clearManagedTimer(name);
  }

  /**
   * Dispose this scope — abort signal + clear all registered timers.
   * Safe to call multiple times.
   */
  dispose(): void {
    if (!this._controller.signal.aborted) {
      this._controller.abort();
    }
    for (const name of this._timers) {
      clearManagedTimer(name);
    }
    this._timers.clear();
  }

  /**
   * Replace a previous scope: dispose it, then create and return a new one.
   * This is the primary entry point for session transitions.
   *
   * @example
   *   _loadScope = SessionScope.replace(_loadScope);
   */
  static replace(prev: SessionScope | null): SessionScope {
    prev?.dispose();
    return new SessionScope();
  }
}
