/**
 * MUSIXQUARE 2.0 — EventBus (Singleton)
 * Type-safe inter-module communication.
 * Same-domain modules use direct imports; cross-domain uses this bus.
 */

import type { EventMap } from '../types/index.ts';

// ── Type-level helpers ──────────────────────────────────────────

type EventKey = keyof EventMap | (string & {});

type EventArgs<K> = K extends keyof EventMap ? EventMap[K] : unknown[];

type TypedListener<K> = (...args: EventArgs<K>) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

class EventBusImpl {
  private _listeners = new Map<string, Set<AnyListener>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<K extends EventKey>(event: K, fn: TypedListener<K>): () => void {
    let set = this._listeners.get(event as string);
    if (!set) {
      set = new Set();
      this._listeners.set(event as string, set);
    }
    set.add(fn as AnyListener);
    return () => this.off(event, fn);
  }

  /**
   * Subscribe once — auto-removes after first invocation.
   */
  once<K extends EventKey>(event: K, fn: TypedListener<K>): () => void {
    const wrapper: AnyListener = (...args) => {
      this.off(event, wrapper as TypedListener<K>);
      (fn as AnyListener)(...args);
    };
    return this.on(event, wrapper as TypedListener<K>);
  }

  /**
   * Unsubscribe a specific listener.
   */
  off<K extends EventKey>(event: K, fn: TypedListener<K>): void {
    const set = this._listeners.get(event as string);
    if (set) {
      set.delete(fn as AnyListener);
      if (set.size === 0) this._listeners.delete(event as string);
    }
  }

  /**
   * Emit an event with payload.
   */
  emit<K extends EventKey>(event: K, ...args: EventArgs<K>): void {
    const set = this._listeners.get(event as string);
    if (!set) return;
    const snapshot = [...set];
    for (const fn of snapshot) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[EventBus] Error in handler for "${event as string}":`, e);
      }
    }
  }

  /**
   * Remove all listeners for a specific event, or all events if none specified.
   */
  clear(event?: EventKey): void {
    if (event) {
      this._listeners.delete(event as string);
    } else {
      this._listeners.clear();
    }
  }

  /**
   * Debug: list registered events and listener counts.
   */
  debug(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, set] of this._listeners) {
      result[key] = set.size;
    }
    return result;
  }
}

/** Singleton EventBus instance */
export const bus = new EventBusImpl();
