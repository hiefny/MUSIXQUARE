/**
 * MUSIXQUARE — EventBus (Singleton)
 * Type-safe inter-module communication.
 * Same-domain modules use direct imports; cross-domain uses this bus.
 */

import { log } from './log.ts';
import type { EventMap } from '../types/index.ts';

// ── Type-level helpers ──────────────────────────────────────────

// 3.0: Escape hatch removed — only declared EventMap keys + state:${StatePath} are valid.
// Typos like bus.emit('audo:ready') → compile error.
type EventKey = keyof EventMap;

type EventArgs<K extends EventKey> = EventMap[K];

type TypedListener<K extends EventKey> = (...args: EventArgs<K>) => void;

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
    (wrapper as unknown as Record<string, unknown>)._originalFn = fn;
    return this.on(event, wrapper as TypedListener<K>);
  }

  /**
   * Unsubscribe a specific listener.
   */
  off<K extends EventKey>(event: K, fn: TypedListener<K>): void {
    const set = this._listeners.get(event as string);
    if (set) {
      // Direct match
      if (set.delete(fn as AnyListener)) {
        if (set.size === 0) this._listeners.delete(event as string);
        return;
      }
      // Match by original fn (for once() wrappers)
      for (const listener of set) {
        if ((listener as unknown as Record<string, unknown>)._originalFn === fn) {
          set.delete(listener);
          if (set.size === 0) this._listeners.delete(event as string);
          return;
        }
      }
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
        log.error(`[EventBus] Error in handler for "${event as string}":`, e);
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

// ── Bus Scope ──────────────────────────────────────────────────

/**
 * Group-unsubscribe helper for modules that re-initialize.
 * Wraps `bus.on` and collects cleanups so a single `dispose()`
 * drops every subscription registered through this scope.
 */
export interface BusScope {
  on<K extends EventKey>(event: K, fn: TypedListener<K>): void;
  dispose(): void;
}

export function createBusScope(): BusScope {
  const cleanups: Array<() => void> = [];
  return {
    on(event, fn) {
      cleanups.push(bus.on(event, fn));
    },
    dispose() {
      for (const u of cleanups) u();
      cleanups.length = 0;
    },
  };
}
