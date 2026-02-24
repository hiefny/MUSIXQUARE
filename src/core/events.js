// @ts-check
/**
 * MUSIXQUARE 2.0 - Event Bus
 *
 * 모듈간 통신의 유일한 경로. 전역 변수 대신 이벤트로 소통.
 *
 * Usage:
 *   import { bus } from '../core/events.js';
 *   bus.on('playback:play', (offset) => { ... });
 *   bus.emit('playback:play', 0);
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._onceListeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void} unsubscribe function
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /**
   * Subscribe once. Automatically removed after first call.
   * @param {string} event
   * @param {Function} fn
   */
  once(event, fn) {
    if (!this._onceListeners.has(event)) {
      this._onceListeners.set(event, new Set());
    }
    this._onceListeners.get(event).add(fn);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
    this._onceListeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event with optional payload.
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const fn of listeners) {
        try { fn(...args); } catch (e) { console.error(`[EventBus] Error in "${event}" listener:`, e); }
      }
    }
    const once = this._onceListeners.get(event);
    if (once) {
      for (const fn of once) {
        try { fn(...args); } catch (e) { console.error(`[EventBus] Error in once "${event}" listener:`, e); }
      }
      once.clear();
    }
  }

  /**
   * Remove all listeners (useful for session teardown).
   * @param {string} [event] - If provided, only clear that event. Otherwise clear all.
   */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
      this._onceListeners.delete(event);
    } else {
      this._listeners.clear();
      this._onceListeners.clear();
    }
  }

  /** Debug: list all registered events and listener counts. */
  debug() {
    const info = {};
    for (const [event, fns] of this._listeners) {
      info[event] = (info[event] || 0) + fns.size;
    }
    for (const [event, fns] of this._onceListeners) {
      info[event] = (info[event] || 0) + fns.size;
    }
    return info;
  }
}

/** Singleton event bus for the entire app. */
export const bus = new EventBus();
