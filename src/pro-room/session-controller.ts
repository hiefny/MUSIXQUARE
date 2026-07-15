import type {
  ActivateProRoomInput,
  CreateProRoomSessionInput,
  ProRoomSignalingAccess,
} from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import { projectProRoomContext } from './context.ts';
import { applyProRoomSnapshotMonotonically } from './revision.ts';
import type { RoomContext } from '../types/index.ts';

export interface ProRoomSessionApi {
  activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  createSession(input: CreateProRoomSessionInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  getSnapshot(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  heartbeat(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  leavePresence(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  createSignalingTicket(code: string, signal?: AbortSignal): Promise<ProRoomSignalingAccess>;
  closeSession(code: string, signal?: AbortSignal): Promise<void>;
}

export interface ProRoomTransportBridge {
  connect(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): Promise<void>;
  reconfigure(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): Promise<void>;
  refreshCredentials?(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  disconnect(): void | Promise<void>;
}

export interface ProRoomSessionObserver {
  snapshot(snapshot: ProRoomSnapshot): void;
  authority(context: RoomContext): void;
  cleared(): void;
}

function authorityChanged(previous: RoomContext | null, next: RoomContext): boolean {
  return (
    previous !== null &&
    (previous.roomId !== next.roomId ||
      previous.role !== next.role ||
      previous.coordinatorId !== next.coordinatorId ||
      previous.epoch !== next.epoch)
  );
}

export class ProRoomSessionController {
  #snapshot: ProRoomSnapshot | null = null;
  #context: RoomContext | null = null;
  #operationEpoch = 0;
  #openAbort: AbortController | null = null;
  #pendingRoomCode: string | null = null;

  constructor(
    private readonly api: ProRoomSessionApi,
    private readonly transport: ProRoomTransportBridge,
    private readonly observer: ProRoomSessionObserver,
  ) {}

  get snapshot(): ProRoomSnapshot | null {
    return this.#snapshot;
  }

  get context(): RoomContext | null {
    return this.#context;
  }

  async join(input: CreateProRoomSessionInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.createSession(input, operationSignal),
      input.code,
      signal,
    );
  }

  async resume(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.getSnapshot(code, operationSignal),
      code,
      signal,
    );
  }

  async activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.activate(input, operationSignal),
      input.code,
      signal,
    );
  }

  async refresh(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    const incoming = await this.api.getSnapshot(roomCode, signal);
    this.#assertOperationCurrent(operationEpoch);
    return this.#accept(incoming, false, signal, operationEpoch);
  }

  async heartbeat(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    const incoming = await this.api.heartbeat(roomCode, signal);
    this.#assertOperationCurrent(operationEpoch);
    return this.#accept(incoming, true, signal, operationEpoch);
  }

  /**
   * Rotate the short-lived signaling credential without changing room
   * authority. If the active facade can no longer accept an in-place refresh,
   * rebuild it from the same authoritative snapshot.
   */
  async refreshSignaling(signal?: AbortSignal): Promise<void> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    const snapshot = this.#snapshot;
    if (!snapshot) throw new Error('PRO_ROOM_SESSION_INACTIVE');
    const access = await this.api.createSignalingTicket(roomCode, signal);
    this.#assertOperationCurrent(operationEpoch);
    this.#assertAccessMatches(snapshot, access);
    const refreshed = this.transport.refreshCredentials
      ? await this.transport.refreshCredentials(snapshot, access, signal)
      : false;
    this.#assertOperationCurrent(operationEpoch);
    if (!refreshed) {
      await this.transport.reconfigure(snapshot, access, signal);
      this.#assertOperationCurrent(operationEpoch);
    }
  }

  async leave(signal?: AbortSignal): Promise<void> {
    const roomCode = this.#snapshot?.roomCode ?? this.#pendingRoomCode;
    const epoch = ++this.#operationEpoch;
    this.#openAbort?.abort();
    this.#openAbort = null;
    this.#pendingRoomCode = null;
    try {
      if (roomCode) await this.api.leavePresence(roomCode, signal);
    } finally {
      try {
        await this.transport.disconnect();
      } finally {
        if (roomCode) {
          try {
            await this.api.closeSession(roomCode, signal);
          } catch {
            // Presence has already been released and local credentials are
            // cookie-only. A close failure must not resurrect local authority.
          }
        }
        if (epoch === this.#operationEpoch) this.#clear();
      }
    }
  }

  async #open(
    authenticate: (signal: AbortSignal) => Promise<ProRoomSnapshot>,
    expectedRoomCode: string,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    const operationEpoch = ++this.#operationEpoch;
    this.#openAbort?.abort();
    const operationAbort = new AbortController();
    this.#openAbort = operationAbort;
    this.#pendingRoomCode = expectedRoomCode;
    const forwardAbort = () => operationAbort.abort();
    if (signal?.aborted) operationAbort.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let authenticated = false;
    let committed = false;

    try {
      const incoming = await authenticate(operationAbort.signal);
      authenticated = true;
      this.#assertOperationCurrent(operationEpoch);
      if (incoming.roomCode !== expectedRoomCode) throw new Error('PRO_ROOM_SESSION_MISMATCH');

      const accepted = this.#commit(incoming);
      committed = true;
      const access = await this.api.createSignalingTicket(expectedRoomCode, operationAbort.signal);
      this.#assertOperationCurrent(operationEpoch);
      this.#assertAccessMatches(accepted, access);
      await this.transport.connect(accepted, access, operationAbort.signal);
      this.#assertOperationCurrent(operationEpoch);
      return accepted;
    } catch (error) {
      if (operationEpoch === this.#operationEpoch) {
        if (committed) this.#clear();
        if (authenticated) {
          void this.api.leavePresence(expectedRoomCode).catch(() => undefined);
          void this.api.closeSession(expectedRoomCode).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.#openAbort === operationAbort) this.#openAbort = null;
      if (operationEpoch === this.#operationEpoch) this.#pendingRoomCode = null;
    }
  }

  async #accept(
    incoming: ProRoomSnapshot,
    allowTransportReconfigure: boolean,
    signal?: AbortSignal,
    operationEpoch = this.#operationEpoch,
  ): Promise<ProRoomSnapshot> {
    this.#assertOperationCurrent(operationEpoch);
    const previousContext = this.#context;
    const accepted = this.#commit(incoming);
    const nextContext = this.#context;
    if (
      allowTransportReconfigure &&
      nextContext &&
      authorityChanged(previousContext, nextContext)
    ) {
      try {
        const access = await this.api.createSignalingTicket(accepted.roomCode, signal);
        this.#assertOperationCurrent(operationEpoch);
        this.#assertAccessMatches(accepted, access);
        await this.transport.reconfigure(accepted, access, signal);
        this.#assertOperationCurrent(operationEpoch);
      } catch (error) {
        if (operationEpoch === this.#operationEpoch) {
          await this.transport.disconnect();
          this.#clear();
        }
        throw error;
      }
    }
    return accepted;
  }

  #commit(incoming: ProRoomSnapshot): ProRoomSnapshot {
    const result = applyProRoomSnapshotMonotonically(this.#snapshot, incoming);
    if (
      result.outcome === 'stale' ||
      result.outcome === 'conflict' ||
      result.outcome === 'invalid'
    ) {
      throw new Error(`PRO_ROOM_SNAPSHOT_${result.outcome.toUpperCase()}`);
    }
    const accepted = result.snapshot;
    if (!accepted) throw new Error('PRO_ROOM_SNAPSHOT_INVALID');
    const context = projectProRoomContext(accepted);
    if (!context) throw new Error('PRO_ROOM_NOT_ACTIVE');

    this.#snapshot = accepted;
    this.#context = context;
    // Publish capabilities before the snapshot so synchronous UI/projector
    // listeners never process PRO data under the previous room's authority.
    this.observer.authority(context);
    this.observer.snapshot(accepted);
    return accepted;
  }

  #assertAccessMatches(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): void {
    const context = projectProRoomContext(snapshot);
    if (!context) throw new Error('PRO_ROOM_NOT_ACTIVE');
    const expectedRole = context.role === 'coordinator' ? 'coordinator' : 'member';
    if (access.role !== expectedRole || access.coordinatorEpoch !== context.epoch) {
      throw new Error('PRO_ROOM_SIGNALING_TICKET_MISMATCH');
    }
  }

  #requireRoomCode(): string {
    const roomCode = this.#snapshot?.roomCode;
    if (!roomCode) throw new Error('PRO_ROOM_SESSION_INACTIVE');
    return roomCode;
  }

  #assertOperationCurrent(operationEpoch: number): void {
    if (operationEpoch !== this.#operationEpoch) {
      throw new Error('PRO_ROOM_SESSION_SUPERSEDED');
    }
  }

  #clear(): void {
    this.#snapshot = null;
    this.#context = null;
    this.observer.cleared();
  }
}
