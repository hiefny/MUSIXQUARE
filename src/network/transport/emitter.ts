type Listener = (...args: never[]) => void;

export class TinyEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, callback: Listener): void {
    const callbacks = this.listeners.get(event) ?? new Set<Listener>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
  }

  off(event: string, callback: Listener): void {
    const callbacks = this.listeners.get(event);
    if (!callbacks) return;
    callbacks.delete(callback);
    if (callbacks.size === 0) this.listeners.delete(event);
  }

  emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event);
    if (!callbacks) return;
    for (const callback of [...callbacks]) {
      (callback as (...payload: unknown[]) => void)(...args);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
