/**
 * Serializes PRO presence heartbeats while allowing an authority-change event
 * to demand one fresh reconciliation after the currently running request.
 * Ordinary overlapping heartbeat triggers are coalesced without a follow-up.
 */
export class ProRoomHeartbeatSingleFlight {
  #generation = 0;
  #inFlight = false;
  #followUpRequested = false;
  #current: Promise<void> | null = null;

  run(operation: () => Promise<void>, options: { forceFollowUp?: boolean } = {}): Promise<void> {
    if (this.#inFlight) {
      if (options.forceFollowUp === true) this.#followUpRequested = true;
      return this.#current ?? Promise.resolve();
    }

    const generation = this.#generation;
    this.#inFlight = true;
    this.#followUpRequested = false;
    // Defer the operation by one microtask so #current is installed before a
    // synchronous callback can re-enter run() through an epoch-close event.
    const current = Promise.resolve().then(() => this.#drain(operation, generation));
    this.#current = current;
    return current;
  }

  reset(): void {
    this.#generation += 1;
    this.#inFlight = false;
    this.#followUpRequested = false;
    this.#current = null;
  }

  async #drain(operation: () => Promise<void>, generation: number): Promise<void> {
    try {
      if (generation !== this.#generation) return;
      do {
        this.#followUpRequested = false;
        await operation();
        if (generation !== this.#generation) return;
      } while (this.#followUpRequested);
    } finally {
      if (generation === this.#generation) {
        this.#inFlight = false;
        this.#followUpRequested = false;
        this.#current = null;
      }
    }
  }
}
