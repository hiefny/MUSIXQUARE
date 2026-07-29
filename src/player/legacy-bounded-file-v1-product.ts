import { log } from '../core/log.ts';
import { INSTANCE_ID } from '../core/session.ts';
import { MSG } from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { safeSend } from '../network/peer-state.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { AnyProtocolMsg, DataConnection, QueueItemId } from '../types/index.ts';
import { isLegacyBoundedFileEnabled } from './legacy-bounded-file-gate.ts';
import {
  createLegacyBoundedFileV1Runtime,
  type LegacyBoundedFileV1CanonicalControl,
  type LegacyBoundedFileV1DescriptorFrame,
  type LegacyBoundedFileV1DescriptorOutcome,
  type LegacyBoundedFileV1FallbackCommit,
  type LegacyBoundedFileV1GuestTransferInput,
  type LegacyBoundedFileV1HostControlScheduleOutcome,
  type LegacyBoundedFileV1HostPrepareInput,
  type LegacyBoundedFileV1NaturalEndOutcome,
  type LegacyBoundedFileV1OfferOutcome,
  type LegacyBoundedFileV1PrepareOutcome,
  type LegacyBoundedFileV1QueueItemRemovalOutcome,
  type LegacyBoundedFileV1RoomBeginOutcome,
  type LegacyBoundedFileV1RuntimeContract,
  type LegacyBoundedFileV1RuntimeSnapshot,
  type LegacyBoundedFileV1ControlOutcome,
  type LegacyBoundedFileV1WireFrame,
} from './legacy-bounded-file-v1-runtime.ts';

const STANDARD_STORAGE_ROOM_ID_RE = /^[1-9]\d{5}$/u;

/**
 * Resolves after the exact stable-V1 selection boundary has been committed
 * and its data path launched. It deliberately does not wait for the complete
 * media payload. Rejecting prevents the host delivery barrier from releasing.
 */
type LegacyBoundedFileV1LegacyFallbackDispatcher = (
  connection: DataConnection,
  commit: Readonly<LegacyBoundedFileV1FallbackCommit>,
) => void | Promise<void>;

export interface LegacyBoundedFileV1GuestDescriptorEvent {
  readonly connection: DataConnection;
  readonly frame: Readonly<LegacyBoundedFileV1DescriptorFrame>;
  readonly outcome: Readonly<LegacyBoundedFileV1DescriptorOutcome>;
}

type LegacyBoundedFileV1GuestDescriptorObserver = (
  event: Readonly<LegacyBoundedFileV1GuestDescriptorEvent>,
) => void | Promise<void>;

interface LegacyBoundedFileV1ProductContract {
  /**
   * Installs the three additive bounded-V1 wire handlers exactly once.
   * Ordinary production artifacts return false and install nothing.
   */
  initialize(): boolean;
  registerLegacyFallbackDispatcher(
    dispatcher: LegacyBoundedFileV1LegacyFallbackDispatcher,
  ): () => void;
  registerGuestDescriptorObserver(observer: LegacyBoundedFileV1GuestDescriptorObserver): () => void;
  beginHostRoom(storageRoomId: string): Promise<LegacyBoundedFileV1RoomBeginOutcome>;
  beginGuestRoom(hostConnection: DataConnection): Promise<LegacyBoundedFileV1RoomBeginOutcome>;
  endRoom(): Promise<void>;
  retireConnection(connection: DataConnection): Promise<boolean>;
  announceGuestCapability(connection: DataConnection): boolean;
  prepareHost(
    input: Readonly<LegacyBoundedFileV1HostPrepareInput>,
  ): Promise<LegacyBoundedFileV1PrepareOutcome>;
  offerHostCurrent(connection: DataConnection): Promise<LegacyBoundedFileV1OfferOutcome>;
  /**
   * Waits for this exact peer's ordered selection boundary, not for its whole
   * media payload. A negotiated peer settles after marker + descriptor have
   * both been accepted by the data channel. A stable-V1 fallback settles only
   * after its dispatcher has committed FILE_PREPARE (or an explicit
   * unavailable result) and launched the exact data path. This is the barrier
   * that PLAY/PAUSE must follow.
   */
  offerHostCurrentSettled(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1OfferOutcome>;
  beginGuestTransfer(input: Readonly<LegacyBoundedFileV1GuestTransferInput>): boolean;
  abandonGuestTransfer(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<boolean>;
  applyControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1ControlOutcome>;
  scheduleHostControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1HostControlScheduleOutcome>;
  cancelPendingHostControl(
    queueItemId: QueueItemId,
    legacySessionId: number,
    positionSeconds: number,
  ): Promise<LegacyBoundedFileV1ControlOutcome> | null;
  removeQueueItem(queueItemId: QueueItemId): Promise<LegacyBoundedFileV1QueueItemRemovalOutcome>;
  flushDeferredQueueItemRemovals(): Promise<number>;
  retireCurrent(queueItemId: QueueItemId, legacySessionId: number): Promise<boolean>;
  settleHostNaturalEnd(
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1NaturalEndOutcome>;
  ownsSession(queueItemId: QueueItemId, legacySessionId: number): boolean;
  ownsGuestTransfer(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): boolean;
  hasReadyRenderer(queueItemId: QueueItemId, legacySessionId: number): boolean;
  positionSeconds(): number | null;
  durationSeconds(): number | null;
  snapshot(): Readonly<LegacyBoundedFileV1RuntimeSnapshot>;
}

const BYPASS_SNAPSHOT: Readonly<LegacyBoundedFileV1RuntimeSnapshot> = Object.freeze({
  schemaVersion: 1,
  active: false,
  role: 'bypass',
  roomKind: null,
  roomEpoch: null,
  generation: 0,
  current: null,
  hostConnections: 0,
  guestCapabilityAnnounced: false,
});

function bypassRoomBegin(): LegacyBoundedFileV1RoomBeginOutcome {
  return Object.freeze({ status: 'bypass' });
}

function bypassPrepare(): LegacyBoundedFileV1PrepareOutcome {
  return Object.freeze({ status: 'bypass' });
}

function bypassOffer(): LegacyBoundedFileV1OfferOutcome {
  return Object.freeze({ status: 'bypass' });
}

function bypassControl(): LegacyBoundedFileV1ControlOutcome {
  return Object.freeze({ status: 'bypass' });
}

function bypassHostControlSchedule(): LegacyBoundedFileV1HostControlScheduleOutcome {
  return Object.freeze({ status: 'bypass' });
}

function bypassNaturalEnd(): LegacyBoundedFileV1NaturalEndOutcome {
  return Object.freeze({ status: 'bypass' });
}

class LegacyBoundedFileV1Product implements LegacyBoundedFileV1ProductContract {
  readonly #runtime: LegacyBoundedFileV1RuntimeContract<DataConnection>;
  readonly #gateEnabled: boolean;
  #initialized = false;
  #ownsRoom = false;
  #runtimeMayOwnRoom = false;
  #lifecycleInvocation = 0;
  #lifecycleLane: Promise<void> = Promise.resolve();
  #roomSequence = 0;
  #fallbackDispatcher: LegacyBoundedFileV1LegacyFallbackDispatcher | null = null;
  #guestDescriptorObserver: LegacyBoundedFileV1GuestDescriptorObserver | null = null;

  constructor() {
    this.#gateEnabled = isLegacyBoundedFileEnabled();
    this.#runtime = createLegacyBoundedFileV1Runtime<DataConnection>({
      nowRoomTimeMs: getHostNow,
      emitFrame: (connection, frame) => this.#emitWireFrame(connection, frame),
      onLegacyFallback: (connection, commit) => this.#dispatchLegacyFallback(connection, commit),
      onFailure: (failure) => {
        // Do not include errors here: R2 failures may carry signed request
        // material. Stage-only diagnostics are enough for the beta boundary.
        log.warn(`[LegacyBoundedV1Product] Runtime failure at ${failure.stage}`);
      },
    });
  }

  initialize(): boolean {
    if (!this.#gateEnabled) return false;
    if (this.#initialized) return true;

    registerHandlers({
      [MSG.FILE_BOUNDED_V1_CAPABILITY]: (frame, connection) => {
        if (!this.#canRouteWire()) return;
        this.#runtime.adoptHostCapability(connection, frame);
      },
      [MSG.FILE_R2_RECORD_DESCRIPTOR]: async (frame, connection) => {
        if (!this.#canRouteWire()) return;
        const outcome = await this.#runtime.adoptGuestDescriptor(connection, frame);
        this.#notifyGuestDescriptorObserver(connection, frame, outcome);
      },
      [MSG.FILE_R2_RECORD_RESULT]: (frame, connection) => {
        if (!this.#canRouteWire()) return;
        this.#runtime.adoptHostResult(connection, frame);
      },
    });
    this.#initialized = true;
    return true;
  }

  registerLegacyFallbackDispatcher(
    dispatcher: LegacyBoundedFileV1LegacyFallbackDispatcher,
  ): () => void {
    if (typeof dispatcher !== 'function') {
      throw new TypeError('Legacy bounded V1 fallback dispatcher must be a function');
    }
    this.#fallbackDispatcher = dispatcher;
    return () => {
      if (this.#fallbackDispatcher === dispatcher) this.#fallbackDispatcher = null;
    };
  }

  registerGuestDescriptorObserver(
    observer: LegacyBoundedFileV1GuestDescriptorObserver,
  ): () => void {
    if (typeof observer !== 'function') {
      throw new TypeError('Legacy bounded V1 guest descriptor observer must be a function');
    }
    this.#guestDescriptorObserver = observer;
    return () => {
      if (this.#guestDescriptorObserver === observer) {
        this.#guestDescriptorObserver = null;
      }
    };
  }

  async beginHostRoom(storageRoomId: string): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    const invocation = ++this.#lifecycleInvocation;
    this.#ownsRoom = false;
    const roomEpoch = `v1:${INSTANCE_ID}:${(++this.#roomSequence).toString(36)}`;
    return this.#enqueueLifecycle(async () => {
      if (invocation !== this.#lifecycleInvocation) return bypassRoomBegin();
      if (!this.#isStandardEnabled()) {
        await this.#cleanupRuntimeRoom();
        return bypassRoomBegin();
      }
      if (!STANDARD_STORAGE_ROOM_ID_RE.test(storageRoomId)) {
        // A malformed successor cannot leave the prior room silently owned.
        // Revoke and drain the previous incarnation before rejecting setup.
        await this.#cleanupRuntimeRoom();
        throw new TypeError('Legacy bounded V1 host storage room id is invalid');
      }

      this.#runtimeMayOwnRoom = true;
      let outcome: LegacyBoundedFileV1RoomBeginOutcome;
      try {
        outcome = await this.#runtime.beginHostRoom({
          kind: 'standard',
          roomEpoch,
          storageRoomId,
          roomToken: Object.freeze(Object.create(null)) as object,
        });
      } catch (error) {
        this.#runtimeMayOwnRoom = false;
        throw error;
      }
      this.#runtimeMayOwnRoom = outcome.status === 'active';
      if (invocation !== this.#lifecycleInvocation) return bypassRoomBegin();
      this.#ownsRoom = outcome.status === 'active';
      return outcome;
    });
  }

  async beginGuestRoom(
    hostConnection: DataConnection,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    const invocation = ++this.#lifecycleInvocation;
    this.#ownsRoom = false;
    return this.#enqueueLifecycle(async () => {
      if (invocation !== this.#lifecycleInvocation) return bypassRoomBegin();
      if (!this.#isStandardEnabled()) {
        await this.#cleanupRuntimeRoom();
        return bypassRoomBegin();
      }

      this.#runtimeMayOwnRoom = true;
      let outcome: LegacyBoundedFileV1RoomBeginOutcome;
      try {
        outcome = await this.#runtime.beginGuestRoom({
          kind: 'standard',
          hostConnection,
        });
      } catch (error) {
        this.#runtimeMayOwnRoom = false;
        throw error;
      }
      this.#runtimeMayOwnRoom = outcome.status === 'active';
      if (invocation !== this.#lifecycleInvocation) return bypassRoomBegin();
      this.#ownsRoom = outcome.status === 'active';
      return outcome;
    });
  }

  async endRoom(): Promise<void> {
    ++this.#lifecycleInvocation;
    this.#ownsRoom = false;
    await this.#enqueueLifecycle(() => this.#cleanupRuntimeRoom());
  }

  retireConnection(connection: DataConnection): Promise<boolean> {
    return this.#canOperate() ? this.#runtime.retireConnection(connection) : Promise.resolve(false);
  }

  announceGuestCapability(connection: DataConnection): boolean {
    return this.#canOperate() && this.#runtime.announceGuestCapability(connection);
  }

  prepareHost(
    input: Readonly<LegacyBoundedFileV1HostPrepareInput>,
  ): Promise<LegacyBoundedFileV1PrepareOutcome> {
    return this.#canOperate() ? this.#runtime.prepareHost(input) : Promise.resolve(bypassPrepare());
  }

  offerHostCurrent(connection: DataConnection): Promise<LegacyBoundedFileV1OfferOutcome> {
    return this.#canOperate()
      ? this.#runtime.offerHostCurrent(connection)
      : Promise.resolve(bypassOffer());
  }

  async offerHostCurrentSettled(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1OfferOutcome> {
    if (!this.#canOperate()) return bypassOffer();
    const lifecycleInvocation = this.#lifecycleInvocation;
    const outcome = await this.#runtime.offerHostCurrentSettled(
      connection,
      queueItemId,
      legacySessionId,
    );
    // A waiter may settle while the application replaces or ends its room.
    // Never let that stale delivery proof authorize a subsequent PLAY/PAUSE
    // in a successor incarnation or after switching to a PRO room.
    return lifecycleInvocation === this.#lifecycleInvocation && this.#canOperate()
      ? outcome
      : bypassOffer();
  }

  beginGuestTransfer(input: Readonly<LegacyBoundedFileV1GuestTransferInput>): boolean {
    return this.#canOperate() && this.#runtime.beginGuestTransfer(input);
  }

  abandonGuestTransfer(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<boolean> {
    return this.#canOperate()
      ? this.#runtime.abandonGuestTransfer(connection, queueItemId, legacySessionId)
      : Promise.resolve(false);
  }

  applyControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1ControlOutcome> {
    return this.#canOperate()
      ? this.#runtime.applyControl(control)
      : Promise.resolve(bypassControl());
  }

  scheduleHostControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1HostControlScheduleOutcome> {
    return this.#canOperate()
      ? this.#runtime.scheduleHostControl(control)
      : Promise.resolve(bypassHostControlSchedule());
  }

  cancelPendingHostControl(
    queueItemId: QueueItemId,
    legacySessionId: number,
    positionSeconds: number,
  ): Promise<LegacyBoundedFileV1ControlOutcome> | null {
    return this.#canOperate()
      ? this.#runtime.cancelPendingHostControl(queueItemId, legacySessionId, positionSeconds)
      : null;
  }

  removeQueueItem(queueItemId: QueueItemId): Promise<LegacyBoundedFileV1QueueItemRemovalOutcome> {
    return this.#canOperate()
      ? this.#runtime.removeQueueItem(queueItemId)
      : Promise.resolve('bypass');
  }

  flushDeferredQueueItemRemovals(): Promise<number> {
    return this.#canOperate() ? this.#runtime.flushDeferredQueueItemRemovals() : Promise.resolve(0);
  }

  retireCurrent(queueItemId: QueueItemId, legacySessionId: number): Promise<boolean> {
    return this.#canOperate()
      ? this.#runtime.retireCurrent(queueItemId, legacySessionId)
      : Promise.resolve(false);
  }

  async settleHostNaturalEnd(
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1NaturalEndOutcome> {
    if (!this.#canOperate()) return bypassNaturalEnd();
    const lifecycleInvocation = this.#lifecycleInvocation;
    const outcome = await this.#runtime.settleHostNaturalEnd(queueItemId, legacySessionId);
    // Polling may settle after selection or room replacement. Never let a
    // retired incarnation advance its successor playlist.
    return lifecycleInvocation === this.#lifecycleInvocation && this.#canOperate()
      ? outcome
      : bypassNaturalEnd();
  }

  ownsSession(queueItemId: QueueItemId, legacySessionId: number): boolean {
    return this.#canOperate() && this.#runtime.ownsSession(queueItemId, legacySessionId);
  }

  ownsGuestTransfer(
    connection: DataConnection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): boolean {
    return (
      this.#canOperate() &&
      this.#runtime.ownsGuestTransfer(connection, queueItemId, legacySessionId)
    );
  }

  hasReadyRenderer(queueItemId: QueueItemId, legacySessionId: number): boolean {
    return this.#canOperate() && this.#runtime.hasReadyRenderer(queueItemId, legacySessionId);
  }

  positionSeconds(): number | null {
    return this.#canOperate() ? this.#runtime.positionSeconds() : null;
  }

  durationSeconds(): number | null {
    return this.#canOperate() ? this.#runtime.durationSeconds() : null;
  }

  snapshot(): Readonly<LegacyBoundedFileV1RuntimeSnapshot> {
    return this.#canOperate() ? this.#runtime.snapshot() : BYPASS_SNAPSHOT;
  }

  #isStandardEnabled(): boolean {
    return this.#gateEnabled && getRoomContext().kind === 'standard';
  }

  #canOperate(): boolean {
    return this.#ownsRoom && this.#isStandardEnabled();
  }

  #canRouteWire(): boolean {
    return this.#initialized && this.#canOperate();
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleLane.then(operation);
    this.#lifecycleLane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #cleanupRuntimeRoom(): Promise<void> {
    if (!this.#runtimeMayOwnRoom) return;
    this.#runtimeMayOwnRoom = false;
    await this.#runtime.endRoom();
  }

  #emitWireFrame(
    connection: DataConnection,
    frame: Readonly<LegacyBoundedFileV1WireFrame>,
  ): boolean {
    if (!this.#canOperate()) return false;
    if (frame.type !== MSG.FILE_R2_RECORD_DESCRIPTOR) {
      return safeSend(connection, frame as unknown as AnyProtocolMsg);
    }

    // Publish the stable V1 selection boundary only after this exact peer has
    // advertised bounded-V1 support. The runtime calls this seam for a
    // descriptor only after capability negotiation succeeds, so legacy peers
    // never observe an unknown r2-record marker while their exact fallback is
    // still pending.
    const markerSent = safeSend(connection, {
      type: MSG.FILE_PREPARE,
      name: frame.publication.name,
      mime: frame.publication.mime,
      size: frame.publication.encodedSize,
      queueItemId: frame.scope.queueItemId,
      sessionId: frame.legacySessionId,
      autoPlayDelayMs: 0,
      delivery: 'r2-record',
    });
    if (!markerSent) return false;

    // Descriptor authority is useful only after the ordered FILE_PREPARE
    // marker. Returning false makes the negotiation ledger commit the exact
    // per-connection stable-V1 fallback instead of leaving a guest waiting on
    // a descriptor whose selection boundary never arrived.
    return safeSend(connection, frame as unknown as AnyProtocolMsg);
  }

  #notifyGuestDescriptorObserver(
    connection: DataConnection,
    frame: Readonly<LegacyBoundedFileV1DescriptorFrame>,
    outcome: Readonly<LegacyBoundedFileV1DescriptorOutcome>,
  ): void {
    const observer = this.#guestDescriptorObserver;
    if (!observer) return;
    const event: Readonly<LegacyBoundedFileV1GuestDescriptorEvent> = Object.freeze({
      connection,
      frame,
      outcome,
    });
    try {
      const result = observer(event);
      if (result && typeof result.then === 'function') {
        void result.catch(() => {
          log.warn('[LegacyBoundedV1Product] Guest descriptor observer rejected');
        });
      }
    } catch {
      log.warn('[LegacyBoundedV1Product] Guest descriptor observer failed');
    }
  }

  async #dispatchLegacyFallback(
    connection: DataConnection,
    commit: Readonly<LegacyBoundedFileV1FallbackCommit>,
  ): Promise<void> {
    const dispatcher = this.#fallbackDispatcher;
    if (!dispatcher) {
      log.warn(
        '[LegacyBoundedV1Product] Legacy fallback requested before its dispatcher was registered',
      );
      throw new Error('Legacy bounded V1 fallback dispatcher is unavailable');
    }
    try {
      // This promise is part of the host delivery barrier. Do not detach it:
      // PLAY/PAUSE may follow only after the exact stable-V1 fallback has
      // established its FILE_PREPARE/data path for this connection.
      await dispatcher(connection, commit);
    } catch {
      // Never forward a transport or signed-request error through the product
      // boundary. The runtime needs only a generic rejection to fail closed.
      log.warn('[LegacyBoundedV1Product] Legacy fallback dispatcher rejected');
      throw new Error('Legacy bounded V1 fallback dispatch failed');
    }
  }
}

/**
 * The sole product-facing bounded V1 coordinator. It never imports the old
 * high-level V2 runtime/controller/router and has no connection-close API.
 */
export const legacyBoundedFileV1Product: LegacyBoundedFileV1ProductContract =
  new LegacyBoundedFileV1Product();
