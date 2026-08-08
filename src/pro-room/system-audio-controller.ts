import type {
  CommitProRoomSystemAudioInput,
  ProRoomSystemAudioLeaseGrant,
  UpdateProRoomSystemAudioLeaseInput,
} from './api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
  ProRoomSystemAudioStatus,
} from './contracts.ts';
import { parseProRoomSystemAudioState } from './snapshot.ts';

interface ProRoomSystemAudioApi {
  getSystemAudioState(code: string, signal?: AbortSignal): Promise<ProRoomSystemAudioState>;
  acquireSystemAudioLease(
    code: string,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioLeaseGrant>;
  commitSystemAudioPublication(
    input: CommitProRoomSystemAudioInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState>;
  heartbeatSystemAudioLease(
    input: UpdateProRoomSystemAudioLeaseInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState>;
  releaseSystemAudioLease(
    input: UpdateProRoomSystemAudioLeaseInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState>;
}

export type { ProRoomSystemAudioApi as ProRoomSystemAudioApiForTests };

export type ProRoomSystemAudioLeaseLossReason =
  | 'authoritative-revocation'
  | 'session-changed'
  | 'reset';

export interface ProRoomSystemAudioViewState {
  roomCode: string | null;
  initialized: boolean;
  phase: ProRoomSystemAudioStatus;
  generation: number | null;
  ownerParticipantId: string | null;
  isLocalOwner: boolean;
  localRequestPending: boolean;
  canStart: boolean;
  canStop: boolean;
  claimExpiresAt: number | null;
  liveExpiresAt: number | null;
  publication: ProRoomSystemAudioPublication | null;
}

interface ProRoomSystemAudioControllerObserver {
  state(state: ProRoomSystemAudioViewState): void;
  localLeaseLost?(reason: ProRoomSystemAudioLeaseLossReason): void;
}

/** Explicit test seam for constructing controller observers. */
export type ProRoomSystemAudioControllerObserverForTests = ProRoomSystemAudioControllerObserver;

export class ProRoomSystemAudioControllerError extends Error {
  constructor(readonly code: string) {
    super(`PRO_ROOM_SYSTEM_AUDIO_${code}`);
    this.name = 'ProRoomSystemAudioControllerError';
  }
}

interface BoundSession {
  roomCode: string;
  participantId: string;
  presenceIncarnationId: string;
}

interface PrivateLease {
  generation: number;
  leaseId: string;
}

const STATE_RANK: Record<ProRoomSystemAudioStatus, number> = {
  preparing: 0,
  live: 1,
  // A release/revocation may retain the fenced generation. Treat idle as the
  // terminal state for that generation so a late GET cannot resurrect it.
  idle: 2,
};

function clonePublication(
  publication: ProRoomSystemAudioPublication | null,
): ProRoomSystemAudioPublication | null {
  if (!publication) return null;
  return {
    publicationId: publication.publicationId,
    sessionId: publication.sessionId,
    tracks: publication.tracks.map((track) => ({ ...track })) as [
      ProRoomSystemAudioPublication['tracks'][0],
      ProRoomSystemAudioPublication['tracks'][1],
    ],
  };
}

function cloneState(state: ProRoomSystemAudioState): ProRoomSystemAudioState {
  if (state.status === 'idle') return { ...state };
  if (state.status === 'preparing') return { ...state };
  return { ...state, publication: clonePublication(state.publication)! };
}

function statesEqual(left: ProRoomSystemAudioState, right: ProRoomSystemAudioState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owns only the authenticated PRO system-audio lease lifecycle. It never
 * opens getDisplayMedia or derives ownership from a browser transport role.
 * Callers can therefore start capture and acquire in parallel from the same
 * user-activation tick.
 */
export class ProRoomSystemAudioController {
  #session: BoundSession | null = null;
  #state: ProRoomSystemAudioState | null = null;
  #lease: PrivateLease | null = null;
  #operationEpoch = 0;
  #acquirePending = false;
  #acquireFlight: Promise<ProRoomSystemAudioState> | null = null;

  constructor(
    private readonly api: ProRoomSystemAudioApi,
    private readonly observer: ProRoomSystemAudioControllerObserver,
  ) {}

  /** Bind the current authenticated tab incarnation; room-manager state is intentionally irrelevant. */
  bindSession(snapshot: ProRoomSnapshot): void {
    const viewer = snapshot.viewer;
    if (snapshot.status !== 'active' || !viewer) {
      this.reset();
      return;
    }
    const next: BoundSession = {
      roomCode: snapshot.roomCode,
      participantId: viewer.participantId,
      presenceIncarnationId: viewer.presenceIncarnationId,
    };
    if (
      this.#session?.roomCode === next.roomCode &&
      this.#session.participantId === next.participantId &&
      this.#session.presenceIncarnationId === next.presenceIncarnationId
    ) {
      return;
    }

    const lostLocalLease = this.#isLocalOwner(this.#state);
    this.#operationEpoch += 1;
    this.#session = next;
    this.#state = null;
    this.#lease = null;
    this.#acquirePending = false;
    this.#acquireFlight = null;
    if (lostLocalLease) this.observer.localLeaseLost?.('session-changed');
    this.#emit();
  }

  getCurrentState(): ProRoomSystemAudioState | null {
    return this.#state ? cloneState(this.#state) : null;
  }

  getCurrentLease(): {
    roomCode: string;
    generation: number;
    status: Exclude<ProRoomSystemAudioStatus, 'idle'>;
    hasCredential: boolean;
  } | null {
    const session = this.#session;
    const state = this.#state;
    if (!session || !state || state.status === 'idle' || !this.#isLocalOwner(state)) return null;
    return {
      roomCode: session.roomCode,
      generation: state.generation,
      status: state.status,
      hasCredential: this.#lease?.generation === state.generation,
    };
  }

  getViewState(): ProRoomSystemAudioViewState {
    const session = this.#session;
    const state = this.#state;
    const localRequestPending = this.#acquirePending;
    const phase = localRequestPending ? 'preparing' : (state?.status ?? 'idle');
    const isLocalOwner = this.#isLocalOwner(state);
    const hasCredential = Boolean(
      state && this.#lease && this.#lease.generation === state.generation && isLocalOwner,
    );
    return {
      roomCode: session?.roomCode ?? null,
      initialized: state !== null,
      phase,
      generation: state?.generation ?? null,
      ownerParticipantId: state?.ownerParticipantId ?? null,
      isLocalOwner,
      localRequestPending,
      canStart: Boolean(session && state?.status === 'idle' && !localRequestPending),
      canStop: Boolean(state && state.status !== 'idle' && isLocalOwner && hasCredential),
      claimExpiresAt: state?.claimExpiresAt ?? null,
      liveExpiresAt: state?.liveExpiresAt ?? null,
      publication: clonePublication(state?.publication ?? null),
    };
  }

  async refreshProSystemAudioState(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
    const { roomCode, epoch } = this.#captureOperation();
    const incoming = await this.api.getSystemAudioState(roomCode, signal);
    this.#assertOperationCurrent(roomCode, epoch);
    return this.acceptProSystemAudioState(incoming);
  }

  acceptProSystemAudioState(value: unknown): ProRoomSystemAudioState {
    if (!this.#session) throw new ProRoomSystemAudioControllerError('SESSION_INACTIVE');
    const incoming = parseProRoomSystemAudioState(value);
    if (!incoming) throw new ProRoomSystemAudioControllerError('INVALID_STATE');
    return this.#acceptParsedState(incoming, false);
  }

  #acceptAuthenticatedProSystemAudioState(value: unknown): ProRoomSystemAudioState {
    if (!this.#session) throw new ProRoomSystemAudioControllerError('SESSION_INACTIVE');
    const incoming = parseProRoomSystemAudioState(value);
    if (!incoming) throw new ProRoomSystemAudioControllerError('INVALID_STATE');
    return this.#acceptParsedState(incoming, true);
  }

  #acceptParsedState(
    incoming: ProRoomSystemAudioState,
    allowEqualRankConflict: boolean,
  ): ProRoomSystemAudioState {
    const current = this.#state;
    if (current) {
      if (incoming.generation < current.generation) return cloneState(current);
      if (incoming.generation === current.generation) {
        const incomingRank = STATE_RANK[incoming.status];
        const currentRank = STATE_RANK[current.status];
        if (incomingRank < currentRank) return cloneState(current);
        if (incomingRank === currentRank) {
          if (!statesEqual(current, incoming)) {
            // Peer fanout is only a hint and must not be able to rewrite an
            // equal-generation state. A dedicated authenticated GET is the
            // server source of truth, however, so heartbeat reconciliation
            // may accept an owner/terminal change at the same rank.
            if (!allowEqualRankConflict) {
              throw new ProRoomSystemAudioControllerError('STATE_CONFLICT');
            }
          } else {
            return cloneState(current);
          }
        }
      }
    }

    const wasLocalOwner = this.#isLocalOwner(current);
    const previousGeneration = current?.generation ?? null;
    this.#state = cloneState(incoming);
    if (
      !this.#isLocalOwner(incoming) ||
      incoming.status === 'idle' ||
      this.#lease?.generation !== incoming.generation
    ) {
      this.#lease = null;
    }
    if (
      wasLocalOwner &&
      (incoming.status === 'idle' ||
        !this.#isLocalOwner(incoming) ||
        incoming.generation !== previousGeneration)
    ) {
      this.observer.localLeaseLost?.('authoritative-revocation');
    }
    this.#emit();
    return cloneState(this.#state);
  }

  acquireProSystemAudioLease(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
    if (this.#acquireFlight) return this.#acquireFlight;
    const session = this.#requireSession();
    if (!this.#state) throw new ProRoomSystemAudioControllerError('STATE_UNINITIALIZED');
    if (this.#state.status !== 'idle' && !this.#isLocalOwner(this.#state)) {
      throw new ProRoomSystemAudioControllerError('OWNED_BY_ANOTHER_PARTICIPANT');
    }
    const epoch = this.#operationEpoch;
    this.#acquirePending = true;
    this.#emit();

    const flight = this.api
      .acquireSystemAudioLease(session.roomCode, signal)
      .then((grant) => {
        this.#assertOperationCurrent(session.roomCode, epoch);
        const parsed = parseProRoomSystemAudioState(grant.systemAudio);
        if (
          !parsed ||
          parsed.status === 'idle' ||
          parsed.ownerParticipantId !== session.participantId
        ) {
          throw new ProRoomSystemAudioControllerError('INVALID_LEASE_GRANT');
        }
        if (this.#state && parsed.generation < this.#state.generation) {
          throw new ProRoomSystemAudioControllerError('LEASE_SUPERSEDED');
        }
        this.#lease = { generation: parsed.generation, leaseId: grant.leaseId };
        const accepted = this.acceptProSystemAudioState(parsed);
        if (
          accepted.status === 'idle' ||
          accepted.generation !== parsed.generation ||
          accepted.ownerParticipantId !== session.participantId
        ) {
          this.#lease = null;
          throw new ProRoomSystemAudioControllerError('LEASE_SUPERSEDED');
        }
        return accepted;
      })
      .finally(() => {
        if (this.#acquireFlight !== flight) return;
        this.#acquireFlight = null;
        this.#acquirePending = false;
        this.#emit();
      });
    this.#acquireFlight = flight;
    return flight;
  }

  async commitProSystemAudioPublication(
    publication: ProRoomSystemAudioPublication,
    signal?: AbortSignal,
  ): Promise<ProRoomSystemAudioState> {
    const { roomCode, epoch, generation, leaseId } = this.#captureLease();
    const incoming = await this.api.commitSystemAudioPublication(
      { code: roomCode, generation, leaseId, publication },
      signal,
    );
    this.#assertOperationCurrent(roomCode, epoch);
    const accepted = this.acceptProSystemAudioState(incoming);
    if (accepted.status !== 'live' || !this.#isLocalOwner(accepted)) {
      throw new ProRoomSystemAudioControllerError('COMMIT_NOT_LIVE');
    }
    return accepted;
  }

  async heartbeatProSystemAudioLease(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
    const { roomCode, epoch, generation, leaseId } = this.#captureLease();
    let incoming: ProRoomSystemAudioState;
    try {
      incoming = await this.api.heartbeatSystemAudioLease(
        { code: roomCode, generation, leaseId },
        signal,
      );
    } catch (heartbeatError) {
      // A rejected heartbeat can mean either a transient transport failure or
      // that the server already fenced this credential (for example when a
      // fifth device joined). Reconcile against the authenticated resource
      // before retrying so a revoked publisher cannot keep streaming
      // after authoritative revocation.
      this.#assertOperationCurrent(roomCode, epoch);
      let accepted: ProRoomSystemAudioState;
      try {
        const observed = await this.api.getSystemAudioState(roomCode, signal);
        this.#assertOperationCurrent(roomCode, epoch);
        accepted = this.#acceptAuthenticatedProSystemAudioState(observed);
      } catch (reconcileError) {
        if (
          reconcileError instanceof ProRoomSystemAudioControllerError &&
          reconcileError.code === 'OPERATION_SUPERSEDED'
        ) {
          throw reconcileError;
        }
        throw heartbeatError;
      }

      const sameLeaseStillAuthoritative =
        accepted.generation === generation &&
        accepted.status !== 'idle' &&
        this.#isLocalOwner(accepted) &&
        this.#lease?.generation === generation;
      if (sameLeaseStillAuthoritative) throw heartbeatError;
      return accepted;
    }
    this.#assertOperationCurrent(roomCode, epoch);
    return this.acceptProSystemAudioState(incoming);
  }

  async releaseProSystemAudioLease(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
    const { roomCode, epoch, generation, leaseId } = this.#captureLease();
    let incoming: ProRoomSystemAudioState;
    try {
      incoming = await this.api.releaseSystemAudioLease(
        { code: roomCode, generation, leaseId },
        signal,
      );
    } catch (releaseError) {
      // The server may have committed the release even when its response was
      // lost. Reconcile once before surfacing the transport error so callers
      // do not retry an already-fenced credential forever.
      this.#assertOperationCurrent(roomCode, epoch);
      try {
        const observed = await this.api.getSystemAudioState(roomCode, signal);
        this.#assertOperationCurrent(roomCode, epoch);
        const accepted = this.acceptProSystemAudioState(observed);
        const releaseConfirmed =
          (accepted.status === 'idle' && accepted.generation >= generation) ||
          (accepted.generation > generation && !this.#isLocalOwner(accepted));
        if (releaseConfirmed) return accepted;
      } catch (reconcileError) {
        if (
          reconcileError instanceof ProRoomSystemAudioControllerError &&
          reconcileError.code === 'OPERATION_SUPERSEDED'
        ) {
          throw reconcileError;
        }
      }
      throw releaseError;
    }
    this.#assertOperationCurrent(roomCode, epoch);
    const accepted = this.acceptProSystemAudioState(incoming);
    if (accepted.status !== 'idle') {
      throw new ProRoomSystemAudioControllerError('RELEASE_NOT_IDLE');
    }
    return accepted;
  }

  reset(): void {
    const lostLocalLease = this.#isLocalOwner(this.#state);
    this.#operationEpoch += 1;
    this.#session = null;
    this.#state = null;
    this.#lease = null;
    this.#acquirePending = false;
    this.#acquireFlight = null;
    if (lostLocalLease) this.observer.localLeaseLost?.('reset');
    this.#emit();
  }

  #captureOperation(): { roomCode: string; epoch: number } {
    const session = this.#requireSession();
    return { roomCode: session.roomCode, epoch: this.#operationEpoch };
  }

  #captureLease(): {
    roomCode: string;
    epoch: number;
    generation: number;
    leaseId: string;
  } {
    const session = this.#requireSession();
    const state = this.#state;
    const lease = this.#lease;
    if (
      !state ||
      state.status === 'idle' ||
      !this.#isLocalOwner(state) ||
      !lease ||
      lease.generation !== state.generation
    ) {
      throw new ProRoomSystemAudioControllerError('LEASE_UNAVAILABLE');
    }
    return {
      roomCode: session.roomCode,
      epoch: this.#operationEpoch,
      generation: lease.generation,
      leaseId: lease.leaseId,
    };
  }

  #requireSession(): BoundSession {
    if (!this.#session) throw new ProRoomSystemAudioControllerError('SESSION_INACTIVE');
    return this.#session;
  }

  #assertOperationCurrent(roomCode: string, epoch: number): void {
    if (epoch !== this.#operationEpoch || this.#session?.roomCode !== roomCode) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
  }

  #isLocalOwner(state: ProRoomSystemAudioState | null): boolean {
    return Boolean(
      state &&
      state.status !== 'idle' &&
      this.#session &&
      state.ownerParticipantId === this.#session.participantId,
    );
  }

  #emit(): void {
    this.observer.state(this.getViewState());
  }
}
