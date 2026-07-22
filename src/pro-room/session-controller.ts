import {
  ProRoomApiError,
  type ProRoomAccountDetachResult,
  type ProRoomPresenceIdentity,
  type ActivateProRoomInput,
  type CloseProRoomSessionFencedInput,
  type CreateProRoomSessionInput,
  type EnterProRoomPresenceOptions,
  type ProRoomSignalingAccess,
  type RecoverProRoomOwnerInput,
} from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import { projectProRoomContext } from './context.ts';
import { applyProRoomSnapshotMonotonically } from './revision.ts';
import type { RoomContext } from '../types/index.ts';

interface ProRoomSessionApi {
  activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  recoverOwner(input: RecoverProRoomOwnerInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  createSession(input: CreateProRoomSessionInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  enterPresence(code: string, options?: EnterProRoomPresenceOptions): Promise<ProRoomSnapshot>;
  attachCurrentAccount(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  detachCurrentAccount(code: string, signal?: AbortSignal): Promise<ProRoomAccountDetachResult>;
  getSnapshot(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  heartbeat(
    code: string,
    signal?: AbortSignal,
    knownSnapshot?: ProRoomSnapshot,
  ): Promise<ProRoomSnapshot>;
  leavePresence(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  createSignalingTicket(code: string, signal?: AbortSignal): Promise<ProRoomSignalingAccess>;
  closeSession(code: string, signal?: AbortSignal): Promise<void>;
  closeSessionFenced(input: CloseProRoomSessionFencedInput, signal?: AbortSignal): Promise<void>;
  clearPresenceIdentity?(code: string, expected?: ProRoomPresenceIdentity): void;
}

export type { ProRoomSessionApi as ProRoomSessionApiForTests };

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

function controlChannelIdentityChanged(previous: RoomContext | null, next: RoomContext): boolean {
  return (
    previous === null ||
    previous.roomId !== next.roomId ||
    previous.role !== next.role ||
    previous.coordinatorId !== next.coordinatorId ||
    previous.epoch !== next.epoch
  );
}

export class ProRoomSessionController {
  #snapshot: ProRoomSnapshot | null = null;
  #context: RoomContext | null = null;
  /** Room incarnation installed by the server control WebSocket. */
  #controlChannelContext: RoomContext | null = null;
  /** Sender metadata captured by the currently authenticated WebSocket. */
  #controlChannelDisplayName: string | null = null;
  /** Member grouping captured by the currently authenticated WebSocket. */
  #controlChannelMemberId: string | null = null;
  #operationEpoch = 0;
  #openAbort: AbortController | null = null;
  #pendingRoomCode: string | null = null;
  #ownedPresence: (ProRoomPresenceIdentity & { roomCode: string }) | null = null;
  #observerClearGeneration = 0;

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

  /** Capture a cheap local lease for runtime operations that bypass this API. */
  captureSessionLease(): number {
    if (!this.#snapshot) throw new Error('PRO_ROOM_SESSION_INACTIVE');
    return this.#operationEpoch;
  }

  isSessionLeaseCurrent(lease: number, roomCode: string): boolean {
    return lease === this.#operationEpoch && this.#snapshot?.roomCode === roomCode;
  }

  /**
   * Mark the server control channel as unusable without revoking the
   * authenticated room. The next heartbeat installs a fresh one-use ticket
   * even when the room incarnation has not changed.
   */
  invalidateControlChannel(): void {
    if (!this.#snapshot) return;
    this.#controlChannelContext = null;
    this.#controlChannelDisplayName = null;
    this.#controlChannelMemberId = null;
  }

  async join(input: CreateProRoomSessionInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.createSession(input, operationSignal),
      input.code,
      signal,
    );
  }

  async resume(code: string, options: EnterProRoomPresenceOptions = {}): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) =>
        this.api.enterPresence(code, {
          signal: operationSignal,
          ...(options.takeover === true ? { takeover: true } : {}),
        }),
      code,
      options.signal,
    );
  }

  async activate(input: ActivateProRoomInput, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.activate(input, operationSignal),
      input.code,
      signal,
    );
  }

  async recoverOwner(
    input: RecoverProRoomOwnerInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    return this.#open(
      (operationSignal) => this.api.recoverOwner(input, operationSignal),
      input.code,
      signal,
    );
  }

  async refresh(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    let incoming: ProRoomSnapshot;
    try {
      incoming = await this.api.getSnapshot(roomCode, signal);
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    return this.#accept(incoming, false, signal, operationEpoch);
  }

  async heartbeat(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    let incoming: ProRoomSnapshot;
    try {
      incoming = await this.api.heartbeat(roomCode, signal, this.#snapshot ?? undefined);
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    return this.#accept(incoming, true, signal, operationEpoch);
  }

  async attachCurrentAccount(
    signal?: AbortSignal,
    onCommitted?: (snapshot: ProRoomSnapshot) => void,
  ): Promise<ProRoomSnapshot> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    let incoming: ProRoomSnapshot;
    try {
      incoming = await this.api.attachCurrentAccount(roomCode, signal);
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    return this.#accept(incoming, true, signal, operationEpoch, onCommitted);
  }

  async detachCurrentAccount(
    signal?: AbortSignal,
    onCommitted?: (snapshot: ProRoomSnapshot) => void,
  ): Promise<ProRoomAccountDetachResult> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    let result: ProRoomAccountDetachResult;
    try {
      result = await this.api.detachCurrentAccount(roomCode, signal);
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    if (!result.snapshot) {
      // The server has committed account detachment, but the old presence no
      // longer exists and therefore cannot produce a signed replacement
      // snapshot. Do not manufacture one from the authenticated local cache;
      // the runtime must fail closed and reopen through ordinary enterPresence.
      return result;
    }
    const accepted = await this.#accept(result.snapshot, true, signal, operationEpoch, onCommitted);
    return { ...result, snapshot: accepted };
  }

  /**
   * Re-enter after a committed detach reports that the old presence expired.
   *
   * The missing snapshot is not an error and must never be replaced with the
   * cached authenticated projection. Retire that absent incarnation locally,
   * then use the ordinary, non-takeover presence entry endpoint to obtain a
   * new signed anonymous snapshot and signaling ticket.
   */
  async reenterAfterDetachedPresence(signal?: AbortSignal): Promise<ProRoomSnapshot> {
    const roomCode = this.#requireRoomCode();
    const replacementEpoch = ++this.#operationEpoch;
    this.#openAbort?.abort();
    this.#openAbort = null;
    this.#pendingRoomCode = null;

    try {
      await this.transport.disconnect();
    } catch {
      // A successful replacement connect below owns the transport afterwards;
      // an old-channel teardown error must not resurrect cached authority.
    }
    this.#assertOperationCurrent(replacementEpoch);
    this.#clear(false);
    if (signal?.aborted) {
      this.#observerClearGeneration += 1;
      this.observer.cleared();
      throw new DOMException('Aborted', 'AbortError');
    }

    const clearGeneration = this.#observerClearGeneration;
    try {
      // Deliberately omit takeover. A genuinely active sibling tab keeps the
      // existing single-tab protection and must win over this recovery.
      return await this.resume(roomCode, { signal });
    } catch (error) {
      // #open() already publishes cleared() when it committed a snapshot and
      // later failed to connect. Authentication/network failures before that
      // point still need to end the old runtime instead of leaving it active
      // with no controller session.
      if (this.#observerClearGeneration === clearGeneration) {
        this.#observerClearGeneration += 1;
        this.observer.cleared();
      }
      throw error;
    }
  }

  /**
   * Rotate the short-lived credential without changing the room incarnation.
   * If the active server channel cannot accept an in-place refresh, rebuild it
   * from the same authoritative snapshot.
   */
  async refreshSignaling(signal?: AbortSignal): Promise<void> {
    const operationEpoch = this.#operationEpoch;
    const roomCode = this.#requireRoomCode();
    const snapshot = this.#snapshot;
    if (!snapshot) throw new Error('PRO_ROOM_SESSION_INACTIVE');
    let access: ProRoomSignalingAccess;
    try {
      access = await this.api.createSignalingTicket(roomCode, signal);
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    this.#assertAccessMatches(snapshot, access);
    let refreshed: boolean;
    try {
      refreshed = this.transport.refreshCredentials
        ? await this.transport.refreshCredentials(snapshot, access, signal)
        : false;
    } catch (error) {
      this.#assertOperationCurrent(operationEpoch);
      throw error;
    }
    this.#assertOperationCurrent(operationEpoch);
    if (!refreshed) {
      try {
        await this.transport.reconfigure(snapshot, access, signal);
      } catch (error) {
        this.#assertOperationCurrent(operationEpoch);
        throw error;
      }
      this.#assertOperationCurrent(operationEpoch);
    }
    this.#controlChannelContext = this.#context;
    this.#controlChannelDisplayName = snapshot.viewer?.displayName ?? null;
    this.#controlChannelMemberId = snapshot.viewer?.memberId ?? null;
  }

  async leave(signal?: AbortSignal, capturedPresenceRelease?: Promise<void>): Promise<void> {
    const capturedSnapshot = this.#snapshot;
    const capturedPresenceIdentity = capturedSnapshot?.viewer
      ? {
          code: capturedSnapshot.roomCode,
          expectedParticipantId: capturedSnapshot.viewer.participantId,
          expectedPresenceIncarnationId: capturedSnapshot.viewer.presenceIncarnationId,
        }
      : null;
    ++this.#operationEpoch;
    this.#openAbort?.abort();
    this.#openAbort = null;
    this.#pendingRoomCode = null;

    // Disconnect and revoke local authority before the first await. The
    // caller can therefore enter an ordinary room (or another PRO room)
    // immediately even while the old room's checkpoint/presence requests are
    // still in flight. Capture the disconnect promise now: invoking the
    // shared transport later could tear down the replacement room instead.
    let disconnectError: unknown;
    let disconnectResult: void | Promise<void>;
    try {
      disconnectResult = this.transport.disconnect();
    } catch (error) {
      disconnectError = error;
      disconnectResult = undefined;
    }
    const disconnectCompletion = Promise.resolve(disconnectResult).catch((error) => {
      disconnectError = error;
    });
    this.#clear();

    // Everything below is bound only to the captured room/incarnation and can
    // finish in the background without consulting or mutating the
    // controller's new session state. `capturedPresenceRelease`, when
    // present, has already started an atomic final-checkpoint + presence-close
    // request with the old room cookie before local invalidation.
    try {
      if (capturedPresenceIdentity) {
        try {
          await capturedPresenceRelease;
        } catch {
          // The timeout wrapper deliberately does not abort the underlying
          // atomic request. The fenced session close below is safe in either
          // queue order and is the only allowed fallback for an authenticated
          // presence.
        }
      }
    } finally {
      await disconnectCompletion;
      if (capturedPresenceIdentity) {
        try {
          await this.api.closeSessionFenced(capturedPresenceIdentity, signal);
        } catch {
          // A replacement incarnation returns 409 by design. Network failure
          // is also non-fatal because local authority is already revoked and
          // presence TTL remains the final fallback.
        }
      }
    }
    if (disconnectError !== undefined) throw disconnectError;
  }

  /**
   * Drop a server-rejected session locally without issuing more authenticated
   * requests. This is used after terminal heartbeat/ticket responses where a
   * normal leave would only repeat the same 401/423 before cleanup.
   */
  async terminate(): Promise<void> {
    const hadSession = Boolean(
      this.#snapshot || this.#context || this.#pendingRoomCode || this.#openAbort,
    );
    ++this.#operationEpoch;
    this.#openAbort?.abort();
    this.#openAbort = null;
    this.#pendingRoomCode = null;
    let disconnectResult: void | Promise<void>;
    try {
      disconnectResult = this.transport.disconnect();
    } catch (error) {
      if (hadSession) this.#clear();
      throw error;
    }
    if (hadSession) this.#clear();
    await disconnectResult;
  }

  /**
   * Confirmed pagehide has already issued the atomic keepalive mutation. Only
   * release local transport/authority here; calling the explicit leave APIs
   * would race that mutation and would also revoke the resumable server session.
   */
  async closeForUnload(): Promise<void> {
    await this.terminate();
  }

  async #open(
    authenticate: (signal: AbortSignal) => Promise<ProRoomSnapshot>,
    expectedRoomCode: string,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    if (this.#snapshot || this.#ownedPresence || this.#pendingRoomCode) {
      throw new Error('PRO_ROOM_SESSION_ALREADY_ACTIVE');
    }
    const operationEpoch = ++this.#operationEpoch;
    this.#openAbort?.abort();
    const operationAbort = new AbortController();
    this.#openAbort = operationAbort;
    this.#pendingRoomCode = expectedRoomCode;
    const forwardAbort = () => operationAbort.abort();
    if (signal?.aborted) operationAbort.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let authenticated = false;
    let authenticatedSnapshot: ProRoomSnapshot | null = null;
    let committed = false;

    try {
      const incoming = await authenticate(operationAbort.signal);
      authenticated = true;
      authenticatedSnapshot = incoming;
      this.#assertOperationCurrent(operationEpoch);
      if (incoming.roomCode !== expectedRoomCode) throw new Error('PRO_ROOM_SESSION_MISMATCH');

      const accepted = this.#commit(incoming);
      committed = true;
      const access = await this.api.createSignalingTicket(expectedRoomCode, operationAbort.signal);
      this.#assertOperationCurrent(operationEpoch);
      this.#assertAccessMatches(accepted, access);
      await this.transport.connect(accepted, access, operationAbort.signal);
      this.#assertOperationCurrent(operationEpoch);
      this.#controlChannelContext = this.#context;
      this.#controlChannelDisplayName = accepted.viewer?.displayName ?? null;
      this.#controlChannelMemberId = accepted.viewer?.memberId ?? null;
      return accepted;
    } catch (error) {
      if (operationEpoch === this.#operationEpoch) {
        if (committed) this.#clear();
        if (authenticated) {
          const viewer = authenticatedSnapshot?.viewer;
          if (viewer) {
            void this.api
              .closeSessionFenced({
                code: expectedRoomCode,
                expectedParticipantId: viewer.participantId,
                expectedPresenceIncarnationId: viewer.presenceIncarnationId,
              })
              .catch(() => undefined);
          }
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
    onCommitted?: (snapshot: ProRoomSnapshot) => void,
  ): Promise<ProRoomSnapshot> {
    this.#assertOperationCurrent(operationEpoch);
    const accepted = this.#commit(incoming);
    onCommitted?.(accepted);
    const nextContext = this.#context;
    if (
      allowTransportReconfigure &&
      nextContext &&
      (controlChannelIdentityChanged(this.#controlChannelContext, nextContext) ||
        this.#controlChannelDisplayName !== accepted.viewer?.displayName ||
        this.#controlChannelMemberId !== accepted.viewer?.memberId)
    ) {
      try {
        const access = await this.api.createSignalingTicket(accepted.roomCode, signal);
        this.#assertOperationCurrent(operationEpoch);
        this.#assertAccessMatches(accepted, access);
        await this.transport.reconfigure(accepted, access, signal);
        this.#assertOperationCurrent(operationEpoch);
        this.#controlChannelContext = nextContext;
        this.#controlChannelDisplayName = accepted.viewer?.displayName ?? null;
        this.#controlChannelMemberId = accepted.viewer?.memberId ?? null;
      } catch (error) {
        // Preserve the authenticated room when replacing its server channel
        // fails. A later heartbeat mints a fresh one-use ticket and retries.
        this.#assertOperationCurrent(operationEpoch);
        throw error;
      }
    }
    return accepted;
  }

  #commit(incoming: ProRoomSnapshot): ProRoomSnapshot {
    const viewer = incoming.viewer;
    if (!viewer) throw new ProRoomApiError('PRESENCE_SUPERSEDED', 409);
    const incomingIdentity = {
      roomCode: incoming.roomCode,
      participantId: viewer.participantId,
      presenceIncarnationId: viewer.presenceIncarnationId,
    };
    if (
      this.#ownedPresence &&
      (this.#ownedPresence.roomCode !== incomingIdentity.roomCode ||
        this.#ownedPresence.participantId !== incomingIdentity.participantId ||
        this.#ownedPresence.presenceIncarnationId !== incomingIdentity.presenceIncarnationId)
    ) {
      // A snapshot that belongs to another tab must never replace this tab's
      // local authority, even if its room revision is otherwise newer.
      throw new ProRoomApiError('PRESENCE_SUPERSEDED', 409);
    }
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

    // A compact heartbeat deliberately resolves to the exact snapshot that is
    // already installed. Keep the transport-health path in #accept() alive so
    // an invalidated control channel can still be rebuilt, but do not project
    // duplicate authority/snapshot state into the runtime. Re-publishing it
    // would manufacture a fresh RoomContext and make unchanged 15-second
    // heartbeats look like real authority transitions to UI subscribers.
    if (result.outcome === 'duplicate') return accepted;

    const context = projectProRoomContext(accepted);
    if (!context) throw new Error('PRO_ROOM_NOT_ACTIVE');

    this.#ownedPresence ??= incomingIdentity;
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
    if (access.role !== 'member' || access.coordinatorEpoch !== context.epoch) {
      throw new Error('PRO_ROOM_SIGNALING_TICKET_MISMATCH');
    }
    const viewer = snapshot.viewer;
    if (
      !viewer ||
      access.presenceIncarnationId !== viewer.presenceIncarnationId ||
      !Number.isSafeInteger(access.ticketSequence) ||
      access.ticketSequence < 1
    ) {
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

  #clear(notifyObserver = true): void {
    this.#controlChannelContext = null;
    this.#controlChannelDisplayName = null;
    this.#controlChannelMemberId = null;
    const ownedPresence = this.#ownedPresence;
    this.#ownedPresence = null;
    this.#snapshot = null;
    this.#context = null;
    if (ownedPresence) {
      this.api.clearPresenceIdentity?.(ownedPresence.roomCode, {
        participantId: ownedPresence.participantId,
        presenceIncarnationId: ownedPresence.presenceIncarnationId,
      });
    }
    if (notifyObserver) {
      this.#observerClearGeneration += 1;
      this.observer.cleared();
    }
  }
}
