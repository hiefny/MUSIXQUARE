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
    return this.#open(() => this.api.createSession(input, signal), input.code, signal);
  }

  async activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(() => this.api.activate(input, signal), input.code, signal);
  }

  async refresh(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const roomCode = this.#requireRoomCode();
    const incoming = await this.api.getSnapshot(roomCode, signal);
    return this.#accept(incoming, false, signal);
  }

  async heartbeat(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const roomCode = this.#requireRoomCode();
    const incoming = await this.api.heartbeat(roomCode, signal);
    return this.#accept(incoming, true, signal);
  }

  async leave(signal?: AbortSignal): Promise<void> {
    const roomCode = this.#snapshot?.roomCode ?? null;
    const epoch = ++this.#operationEpoch;
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
    authenticate: () => Promise<ProRoomSnapshot>,
    expectedRoomCode: string,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    const operationEpoch = ++this.#operationEpoch;
    const incoming = await authenticate();
    if (operationEpoch !== this.#operationEpoch) throw new Error('PRO_ROOM_SESSION_SUPERSEDED');
    if (incoming.roomCode !== expectedRoomCode) throw new Error('PRO_ROOM_SESSION_MISMATCH');

    const accepted = this.#commit(incoming);
    try {
      const access = await this.api.createSignalingTicket(expectedRoomCode, signal);
      if (operationEpoch !== this.#operationEpoch) throw new Error('PRO_ROOM_SESSION_SUPERSEDED');
      this.#assertAccessMatches(accepted, access);
      await this.transport.connect(accepted, access, signal);
    } catch (error) {
      if (operationEpoch === this.#operationEpoch) {
        this.#clear();
        void this.api.leavePresence(expectedRoomCode, signal).catch(() => undefined);
        void this.api.closeSession(expectedRoomCode, signal).catch(() => undefined);
      }
      throw error;
    }
    return accepted;
  }

  async #accept(
    incoming: ProRoomSnapshot,
    allowTransportReconfigure: boolean,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
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
        this.#assertAccessMatches(accepted, access);
        await this.transport.reconfigure(accepted, access, signal);
      } catch (error) {
        await this.transport.disconnect();
        this.#clear();
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
    this.observer.snapshot(accepted);
    this.observer.authority(context);
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

  #clear(): void {
    this.#snapshot = null;
    this.#context = null;
    this.observer.cleared();
  }
}
