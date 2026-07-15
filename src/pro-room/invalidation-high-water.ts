interface RevisionPair {
  revision: number;
  playlistRevision: number;
}

/** Coalesce untrusted member hints without letting one forged maximum stick forever. */
export class ProRoomInvalidationHighWater {
  #revision = -1;
  #playlistRevision = -1;
  #generation = 0;

  get revision(): number {
    return this.#revision;
  }

  get playlistRevision(): number {
    return this.#playlistRevision;
  }

  get pending(): boolean {
    return this.#revision >= 0 || this.#playlistRevision >= 0;
  }

  offer(hint: RevisionPair, current: RevisionPair): boolean {
    if (hint.revision <= current.revision && hint.playlistRevision <= current.playlistRevision) {
      return false;
    }
    if (hint.revision <= this.#revision && hint.playlistRevision <= this.#playlistRevision) {
      return false;
    }
    this.#revision = Math.max(this.#revision, hint.revision);
    this.#playlistRevision = Math.max(this.#playlistRevision, hint.playlistRevision);
    this.#generation += 1;
    return true;
  }

  acknowledge(snapshot: RevisionPair): void {
    if (snapshot.revision >= this.#revision) this.#revision = -1;
    if (snapshot.playlistRevision >= this.#playlistRevision) this.#playlistRevision = -1;
  }

  beginHeartbeat(): number {
    return this.#generation;
  }

  finishHeartbeat(snapshot: RevisionPair, generationAtStart: number): void {
    this.acknowledge(snapshot);
    // A mark that survived a full authoritative heartbeat was forged/stale.
    // Do not clear a genuinely newer hint that arrived while it was in flight.
    if (generationAtStart === this.#generation) this.reset();
  }

  reset(): void {
    this.#revision = -1;
    this.#playlistRevision = -1;
  }
}
