import { getPrimedFilePlaybackProductAudio } from '../audio/file-playback-audio-readiness.ts';
import type { QueueItemId } from '../types/index.ts';
import { createFilePlaybackMediaScope } from './file-playback-media-scope.ts';
import {
  createFilePlaybackR2RecordDeliveryProvider,
  type FilePlaybackR2RecordDeliveryProviderContract,
} from './file-playback-r2-record-delivery-provider.ts';
import {
  FilePlaybackR2RecordDescriptorRegistry,
  sameFilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDescriptorRef,
} from './file-playback-r2-record-descriptor.ts';
import {
  FilePlaybackR2WholeBlobPublisher,
  type FilePlaybackR2RecordPublication,
  type FilePlaybackR2WholeBlobPublishSource,
} from './file-playback-r2-whole-blob-publisher.ts';
import { isQueueItemId } from './queue-model.ts';
import { isLegacyBoundedFileEnabled } from './legacy-bounded-file-gate.ts';
import { createLegacyBoundedFilePort } from './legacy-bounded-file-port.ts';
import type { LegacyBoundedFilePortContract } from './legacy-bounded-file-port-contract.ts';
import {
  createLegacyBoundedFileV1Bridge,
  type LegacyBoundedFileV1BridgeContract,
  type LegacyBoundedV1BridgeSnapshot,
  type LegacyBoundedV1ControlOutcome,
  type LegacyBoundedV1PrepareOutcome,
  type LegacyBoundedV1ScheduleOutcome,
} from './legacy-bounded-file-v1-bridge.ts';
import { createLegacyBoundedFileV1NegotiationLedger } from './legacy-bounded-file-v1-negotiation.ts';
import {
  createLegacyBoundedFileV1BlobBinding,
  createLegacyBoundedFileV1R2Binding,
  createLegacyBoundedFileV1SourceAdapter,
  type LegacyBoundedFileV1EncodedSourceBinding,
  type LegacyBoundedFileV1SourceAdapter,
  type LegacyBoundedFileV1SourceAdapterOptions,
} from './legacy-bounded-file-v1-source.ts';

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const STANDARD_STORAGE_ROOM_ID_RE = /^[1-9]\d{5}$/u;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const NATURAL_END_MIN_DURATION_SECONDS = 0.1;
const NATURAL_END_EPSILON_SECONDS = 0.05;
const ORPHAN_PUBLISHER_CLEANUP_RETRY_BASE_MS = 1_000;
const ORPHAN_PUBLISHER_CLEANUP_RETRY_MAX_MS = 60_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type RoomKind = 'standard' | 'pro';
type RuntimeRole = 'idle' | 'host' | 'guest' | 'bypass';
type DeliveryPurpose = 'current' | 'preload';

interface LegacyBoundedFileV1CapabilityFrame {
  readonly type: 'file-bounded-v1-capability';
  readonly bridgeVersion: 1;
  readonly descriptorVersion: 1;
}

export interface LegacyBoundedFileV1DescriptorFrame {
  readonly type: 'file-r2-record-descriptor';
  readonly bridgeVersion: 1;
  readonly legacySessionId: number;
  readonly purpose: DeliveryPurpose;
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly publication: Readonly<FilePlaybackR2RecordPublication>;
}

interface LegacyBoundedFileV1ResultFrame {
  readonly type: 'file-r2-record-result';
  readonly bridgeVersion: 1;
  readonly legacySessionId: number;
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly outcome: 'ready' | 'fallback';
}

export type LegacyBoundedFileV1WireFrame =
  | LegacyBoundedFileV1CapabilityFrame
  | LegacyBoundedFileV1DescriptorFrame
  | LegacyBoundedFileV1ResultFrame;

interface LegacyBoundedFileV1HostRoomInput {
  readonly kind: RoomKind;
  /** Stable V1 application-session incarnation, not the reusable room code. */
  readonly roomEpoch: string;
  readonly storageRoomId: string;
  readonly roomToken: object;
}

interface LegacyBoundedFileV1GuestRoomInput<Connection extends object> {
  readonly kind: RoomKind;
  readonly hostConnection: Connection;
}

export interface LegacyBoundedFileV1HostPrepareInput {
  readonly blob: Blob;
  readonly name: string;
  readonly mime: string;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly legacySessionId: number;
}

export interface LegacyBoundedFileV1GuestTransferInput {
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
}

interface LegacyBoundedFileV1ControlTarget {
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
}

export type LegacyBoundedFileV1CanonicalControl =
  | Readonly<
      LegacyBoundedFileV1ControlTarget & {
        readonly kind: 'play' | 'seek-playing';
        readonly positionSeconds: number;
        readonly startAtRoomTimeMs: number;
      }
    >
  | Readonly<
      LegacyBoundedFileV1ControlTarget & {
        readonly kind: 'pause' | 'seek-paused' | 'stop';
        readonly positionSeconds: number;
        readonly atRoomTimeMs: number;
      }
    >;

type LegacyBoundedFileV1FallbackReason =
  | 'capability-unavailable'
  | 'capability-timeout'
  | 'descriptor-send-failed'
  | 'descriptor-result-timeout'
  | 'guest-fallback'
  | 'timeout-scheduling-failed'
  | 'publication-failed'
  | 'local-fallback';

export interface LegacyBoundedFileV1FallbackCommit {
  readonly legacySessionId: number;
  readonly purpose: DeliveryPurpose;
  readonly queueItemId: QueueItemId;
  readonly reason: LegacyBoundedFileV1FallbackReason;
}

interface LegacyBoundedFileV1RuntimeFailure {
  readonly stage:
    | 'room-begin'
    | 'host-prepare'
    | 'host-publication'
    | 'guest-descriptor'
    | 'control'
    | 'cleanup'
    | 'callback';
  readonly error: unknown;
}

interface RecordPublisherContract {
  publishRecordSet(
    source: Readonly<FilePlaybackR2WholeBlobPublishSource>,
    options: {
      readonly storageRoomId: string;
      readonly applicationSessionId: string;
    },
  ): Promise<Readonly<FilePlaybackR2RecordPublication>>;
  cancelPendingRecordSet(queueItemId: QueueItemId): Promise<boolean>;
  removeQueueItem(queueItemId: QueueItemId): Promise<boolean>;
  close(): Promise<void>;
}

interface DescriptorRegistryContract {
  register(value: unknown): Readonly<FilePlaybackR2RecordDescriptorRef>;
  retire(scope: unknown): Promise<void>;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}

interface RuntimeAudioGraph {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
}

interface RuntimeFactories {
  readonly gateEnabled: () => boolean;
  readonly getAudioGraph: () => Promise<Readonly<RuntimeAudioGraph>>;
  readonly createPort: (options: {
    readonly nowRoomTimeMs: () => number;
  }) => LegacyBoundedFilePortContract;
  readonly createBridge: (options: {
    readonly port: LegacyBoundedFilePortContract;
    readonly nowRoomTimeMs: () => number;
  }) => LegacyBoundedFileV1BridgeContract;
  readonly createPublisher: (roomToken: object) => RecordPublisherContract;
  readonly createRegistry: () => DescriptorRegistryContract;
  readonly createProvider: (
    registry: DescriptorRegistryContract,
  ) => FilePlaybackR2RecordDeliveryProviderContract;
  readonly createBlobBinding: (
    blob: Blob,
    sourceIdentity: string,
    name: string,
    mime: string,
  ) => Readonly<LegacyBoundedFileV1EncodedSourceBinding>;
  readonly createR2Binding: (
    provider: FilePlaybackR2RecordDeliveryProviderContract,
    scope: Readonly<FilePlaybackR2RecordDeliveryScope>,
    descriptor: Readonly<FilePlaybackR2RecordDescriptorRef>,
  ) => Readonly<LegacyBoundedFileV1EncodedSourceBinding>;
  readonly createSourceAdapter: (
    options: LegacyBoundedFileV1SourceAdapterOptions,
  ) => Readonly<LegacyBoundedFileV1SourceAdapter>;
  readonly createIdentifier: (purpose: string) => string;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeout: (handle: TimerHandle) => void;
}

/**
 * Narrow construction seams. Product callers should omit this object; it
 * exists so lifecycle and stale-completion behavior can be tested without a
 * browser decoder, R2 account, or real clock.
 */
export type LegacyBoundedFileV1RuntimeSeams = Partial<RuntimeFactories>;

interface LegacyBoundedFileV1RuntimeOptions<Connection extends object> {
  /** The same monotonic host-room clock already used by stable V1 controls. */
  readonly nowRoomTimeMs: () => number;
  readonly emitFrame: (
    connection: Connection,
    frame: Readonly<LegacyBoundedFileV1WireFrame>,
  ) => boolean | void;
  readonly onLegacyFallback: (
    connection: Connection,
    commit: Readonly<LegacyBoundedFileV1FallbackCommit>,
  ) => void | Promise<void>;
  readonly onFailure?: (failure: Readonly<LegacyBoundedFileV1RuntimeFailure>) => void;
  readonly capabilityTimeoutMs?: number;
  readonly descriptorResultTimeoutMs?: number;
  readonly seamsForTests?: LegacyBoundedFileV1RuntimeSeams;
}

export interface LegacyBoundedFileV1CurrentSnapshot {
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
  readonly state: 'preparing' | 'ready' | 'retiring' | 'fallback' | 'failed';
  readonly phase: LegacyBoundedV1BridgeSnapshot['phase'];
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly pendingControl: LegacyBoundedFileV1CanonicalControl['kind'] | null;
}

export interface LegacyBoundedFileV1RuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly active: boolean;
  readonly role: RuntimeRole;
  readonly roomKind: RoomKind | null;
  readonly roomEpoch: string | null;
  readonly generation: number;
  readonly current: Readonly<LegacyBoundedFileV1CurrentSnapshot> | null;
  readonly hostConnections: number;
  readonly guestCapabilityAnnounced: boolean;
}

export type LegacyBoundedFileV1RoomBeginOutcome =
  | Readonly<{ readonly status: 'active'; readonly role: 'host' | 'guest' }>
  | Readonly<{ readonly status: 'bypass' }>;

export type LegacyBoundedFileV1PrepareOutcome =
  | Readonly<{
      readonly status: 'ready';
      readonly durationSeconds: number;
    }>
  | Readonly<{ readonly status: 'fallback' }>
  | Readonly<{ readonly status: 'superseded' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>
  | Readonly<{ readonly status: 'bypass' }>;

export type LegacyBoundedFileV1OfferOutcome =
  | Readonly<{
      readonly status: 'pending' | 'descriptor-sent' | 'ready' | 'legacy-committed' | 'retired';
    }>
  | Readonly<{ readonly status: 'superseded' | 'fallback' | 'bypass' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

export type LegacyBoundedFileV1DescriptorOutcome =
  | Readonly<{ readonly status: 'ready'; readonly durationSeconds: number }>
  | Readonly<{ readonly status: 'fallback' | 'stale' | 'bypass' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

export type LegacyBoundedFileV1ControlOutcome =
  | Readonly<{
      readonly status: 'applied';
      readonly snapshot: Readonly<LegacyBoundedFileV1CurrentSnapshot>;
    }>
  | Readonly<{ readonly status: 'buffered' | 'superseded' | 'fallback' | 'bypass' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

export type LegacyBoundedFileV1HostControlScheduleOutcome =
  | Readonly<{
      readonly status: 'scheduled';
      readonly startAtRoomTimeMs: number;
      readonly snapshot: Readonly<LegacyBoundedFileV1CurrentSnapshot>;
      readonly settled: Promise<LegacyBoundedFileV1ControlOutcome>;
    }>
  | Readonly<{ readonly status: 'superseded' | 'fallback' | 'bypass' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

export type LegacyBoundedFileV1NaturalEndOutcome =
  | Readonly<{
      readonly status: 'settled';
      readonly snapshot: Readonly<LegacyBoundedFileV1CurrentSnapshot>;
    }>
  | Readonly<{ readonly status: 'not-ended' | 'superseded' | 'bypass' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

export type LegacyBoundedFileV1QueueItemRemovalOutcome =
  | 'removed'
  | 'deferred'
  | 'bypass'
  | 'failed';

export interface LegacyBoundedFileV1RuntimeContract<Connection extends object> {
  beginHostRoom(
    input: Readonly<LegacyBoundedFileV1HostRoomInput>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome>;
  beginGuestRoom(
    input: Readonly<LegacyBoundedFileV1GuestRoomInput<Connection>>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome>;
  endRoom(): Promise<void>;
  retireConnection(connection: Connection): Promise<boolean>;
  announceGuestCapability(connection: Connection): boolean;
  adoptHostCapability(connection: Connection, frame: unknown): string;
  adoptHostResult(connection: Connection, frame: unknown): string;
  prepareHost(
    input: Readonly<LegacyBoundedFileV1HostPrepareInput>,
  ): Promise<LegacyBoundedFileV1PrepareOutcome>;
  offerHostCurrent(connection: Connection): Promise<LegacyBoundedFileV1OfferOutcome>;
  /**
   * Exact late-join ordering barrier. It uses the negotiation ledger's own
   * capability/result deadlines and the stable-V1 fallback acknowledgement;
   * it creates no independent timer.
   */
  offerHostCurrentSettled(
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1OfferOutcome>;
  beginGuestTransfer(input: Readonly<LegacyBoundedFileV1GuestTransferInput>): boolean;
  abandonGuestTransfer(
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<boolean>;
  adoptGuestDescriptor(
    connection: Connection,
    frame: Readonly<LegacyBoundedFileV1DescriptorFrame>,
  ): Promise<LegacyBoundedFileV1DescriptorOutcome>;
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
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): boolean;
  hasReadyRenderer(queueItemId: QueueItemId, legacySessionId: number): boolean;
  positionSeconds(): number | null;
  durationSeconds(): number | null;
  snapshot(): Readonly<LegacyBoundedFileV1RuntimeSnapshot>;
}

interface HostRoom<Connection extends object> {
  readonly generation: number;
  readonly roomEpoch: string;
  readonly storageRoomId: string;
  readonly publisher: RecordPublisherContract;
  readonly port: LegacyBoundedFilePortContract;
  readonly bridge: LegacyBoundedFileV1BridgeContract;
  readonly connections: Map<Connection, HostConnection>;
  readonly retiredConnections: WeakSet<Connection>;
  readonly deferredQueueItemRemovals: Set<QueueItemId>;
  current: HostCurrent<Connection> | null;
}

interface HostConnection {
  capability: 'unknown' | 'capable' | 'legacy-only';
  bridgeGeneration: string;
  readonly fallbackAcks: Map<string, Promise<void>>;
  frame: Readonly<LegacyBoundedFileV1DescriptorFrame> | null;
}

interface HostCurrent<Connection extends object> {
  readonly generation: number;
  readonly token: number;
  readonly input: Readonly<LegacyBoundedFileV1HostPrepareInput>;
  readonly scope: Readonly<BridgeScope>;
  readonly open: (signal: AbortSignal) => Promise<unknown>;
  readonly publication: Promise<Readonly<FilePlaybackR2RecordPublication>>;
  readonly ledger: ReturnType<
    typeof createLegacyBoundedFileV1NegotiationLedger<
      Connection,
      FilePlaybackR2RecordPublication,
      TimerHandle
    >
  >;
  readonly settlementWaiters: Map<Connection, Set<HostOfferSettlementWaiter>>;
  readonly legacyFallbackAcks: Map<Connection, Promise<void>>;
  readonly legacyFallbackStates: Map<
    Connection,
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'committed' }>
    | Readonly<{ status: 'failed'; error: unknown }>
  >;
  cleanupBarrierArmed: boolean;
  naturalEndSettlement: Promise<LegacyBoundedFileV1NaturalEndOutcome> | null;
  retirement: Promise<boolean> | null;
  state: 'preparing' | 'ready' | 'retiring' | 'fallback' | 'failed';
}

interface HostOfferSettlementWaiter {
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
  readonly resolve: (outcome: LegacyBoundedFileV1OfferOutcome) => void;
}

interface GuestRoom<Connection extends object> {
  readonly generation: number;
  readonly connection: Connection;
  readonly registry: DescriptorRegistryContract;
  readonly provider: FilePlaybackR2RecordDeliveryProviderContract;
  readonly port: LegacyBoundedFilePortContract;
  readonly bridge: LegacyBoundedFileV1BridgeContract;
  capabilityAnnounced: boolean;
  connectionRetired: boolean;
  current: GuestCurrent | null;
  /**
   * Exact source retirement precedes successor preparation. Without this
   * drain, a late A retire can revoke the shared bridge while B is preparing.
   */
  transitionDrain: Promise<void>;
}

interface GuestCurrent {
  readonly generation: number;
  readonly token: number;
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
  state: 'preparing' | 'ready' | 'retiring' | 'fallback' | 'failed';
  scope: Readonly<BridgeScope> | null;
  deliveryScope: Readonly<FilePlaybackR2RecordDeliveryScope> | null;
  descriptor: Readonly<FilePlaybackR2RecordDescriptorRef> | null;
  open: ((signal: AbortSignal) => Promise<unknown>) | null;
  descriptorPromise: Promise<LegacyBoundedFileV1DescriptorOutcome> | null;
  pendingControl: Readonly<LegacyBoundedFileV1CanonicalControl> | null;
  retirement: Promise<void> | null;
}

interface BridgeScope extends FilePlaybackR2RecordDeliveryScope {
  readonly descriptorId: string;
  readonly descriptorVersion: number;
}

const CAPABILITY_FRAME: Readonly<LegacyBoundedFileV1CapabilityFrame> = freezeRecord({
  type: 'file-bounded-v1-capability',
  bridgeVersion: 1,
  descriptorVersion: 1,
});
const GUEST_READY_RENDEZVOUS_LEAD_MS = 250;

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function exactCapabilityFrame(value: unknown): value is LegacyBoundedFileV1CapabilityFrame {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 3 ||
      !keys.every(
        (key) =>
          typeof key === 'string' &&
          (key === 'type' || key === 'bridgeVersion' || key === 'descriptorVersion'),
      )
    ) {
      return false;
    }
    for (const key of ['type', 'bridgeVersion', 'descriptorVersion'] as const) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return (
      descriptors.type.value === CAPABILITY_FRAME.type &&
      descriptors.bridgeVersion.value === 1 &&
      descriptors.descriptorVersion.value === 1
    );
  } catch {
    return false;
  }
}

function positiveSession(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validHostPrepare(
  input: Readonly<LegacyBoundedFileV1HostPrepareInput>,
): input is Readonly<LegacyBoundedFileV1HostPrepareInput> {
  return (
    !!input &&
    input.blob instanceof Blob &&
    input.blob.size > 0 &&
    typeof input.name === 'string' &&
    input.name.length > 0 &&
    input.name.length <= MAX_FILE_NAME_LENGTH &&
    typeof input.mime === 'string' &&
    input.mime.length <= MAX_MIME_LENGTH &&
    MIME_RE.test(input.mime) &&
    isQueueItemId(input.queueItemId) &&
    identifier(input.sourceIdentity) &&
    identifier(input.transferSessionId) &&
    positiveSession(input.legacySessionId)
  );
}

function validControl(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
): control is Readonly<LegacyBoundedFileV1CanonicalControl> {
  if (
    !control ||
    !isQueueItemId(control.queueItemId) ||
    !positiveSession(control.legacySessionId) ||
    !finiteNonNegative(control.positionSeconds)
  ) {
    return false;
  }
  if (control.kind === 'play' || control.kind === 'seek-playing') {
    return finiteNonNegative(control.startAtRoomTimeMs);
  }
  if (control.kind === 'pause' || control.kind === 'seek-paused' || control.kind === 'stop') {
    return finiteNonNegative(control.atRoomTimeMs);
  }
  return false;
}

function rebaseBufferedGuestControl(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  nowRoomTimeMs: number,
  durationSeconds: number | null,
): Readonly<LegacyBoundedFileV1CanonicalControl> {
  if (control.kind !== 'play' && control.kind !== 'seek-playing') return control;
  if (!finiteNonNegative(nowRoomTimeMs)) {
    throw new Error('Legacy bounded V1 guest room clock is invalid');
  }

  const startAtRoomTimeMs = Math.max(
    control.startAtRoomTimeMs,
    nowRoomTimeMs + GUEST_READY_RENDEZVOUS_LEAD_MS,
  );
  const elapsedSeconds = Math.max(0, startAtRoomTimeMs - control.startAtRoomTimeMs) / 1_000;
  const projectedPosition = control.positionSeconds + elapsedSeconds;
  const positionSeconds =
    durationSeconds !== null && durationSeconds > 0
      ? Math.min(projectedPosition, Math.max(0, durationSeconds - 0.001))
      : projectedPosition;
  return freezeRecord({
    ...control,
    positionSeconds,
    startAtRoomTimeMs,
  });
}

function sameControlTarget(
  current: { readonly queueItemId: QueueItemId; readonly legacySessionId: number },
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
): boolean {
  return (
    current.queueItemId === control.queueItemId &&
    current.legacySessionId === control.legacySessionId
  );
}

function sameDescriptor(
  left: Readonly<FilePlaybackR2RecordDescriptorRef>,
  right: Readonly<FilePlaybackR2RecordDescriptorRef>,
): boolean {
  return (
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    sameFilePlaybackR2RecordDeliveryScope(left.scope, right.scope)
  );
}

function bridgeScope(
  scope: Readonly<FilePlaybackR2RecordDeliveryScope>,
  descriptorId: string,
  descriptorVersion: number,
): Readonly<BridgeScope> {
  return freezeRecord({
    ...scope,
    descriptorId,
    descriptorVersion,
  });
}

function sameBridgeScope(
  left: Readonly<BridgeScope>,
  right: LegacyBoundedV1BridgeSnapshot['scope'],
): boolean {
  return (
    !!right &&
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    sameFilePlaybackR2RecordDeliveryScope(left, right)
  );
}

function fallbackKey(
  legacySessionId: number,
  purpose: DeliveryPurpose,
  queueItemId: QueueItemId,
): string {
  return `${legacySessionId}:${purpose}:${queueItemId}`;
}

function currentIdentity<Connection extends object>(
  current: HostCurrent<Connection> | GuestCurrent,
): Readonly<{ queueItemId: QueueItemId; legacySessionId: number }> {
  return 'input' in current
    ? freezeRecord({
        queueItemId: current.input.queueItemId,
        legacySessionId: current.input.legacySessionId,
      })
    : freezeRecord({
        queueItemId: current.queueItemId,
        legacySessionId: current.legacySessionId,
      });
}

function defaultIdentifier(purpose: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error('LEGACY_BOUNDED_V1_IDENTIFIER_UNAVAILABLE');
  return `${purpose}:${uuid}`;
}

function defaultFactories(
  overrides: LegacyBoundedFileV1RuntimeSeams | undefined,
): Readonly<RuntimeFactories> {
  const defaults: RuntimeFactories = {
    gateEnabled: isLegacyBoundedFileEnabled,
    getAudioGraph: getPrimedFilePlaybackProductAudio,
    createPort: createLegacyBoundedFilePort,
    createBridge: createLegacyBoundedFileV1Bridge,
    createPublisher: (roomToken) => new FilePlaybackR2WholeBlobPublisher({ roomToken }),
    createRegistry: () => new FilePlaybackR2RecordDescriptorRegistry(),
    createProvider: (registry) =>
      createFilePlaybackR2RecordDeliveryProvider(
        registry as FilePlaybackR2RecordDescriptorRegistry,
      ),
    createBlobBinding: (blob, sourceIdentity, name, mime) =>
      createLegacyBoundedFileV1BlobBinding({
        blob,
        sourceIdentity,
        metadata: { name, mime },
      }),
    createR2Binding: (provider, scope, descriptor) =>
      createLegacyBoundedFileV1R2Binding({ provider, scope, descriptor }),
    createSourceAdapter: createLegacyBoundedFileV1SourceAdapter,
    createIdentifier: defaultIdentifier,
    scheduleTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    cancelTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  const factories = Object.freeze({ ...defaults, ...(overrides ?? {}) });
  for (const value of Object.values(factories)) {
    if (typeof value !== 'function') {
      throw new TypeError('Legacy bounded V1 runtime factory seam is invalid');
    }
  }
  return factories;
}

class LegacyBoundedFileV1Runtime<
  Connection extends object,
> implements LegacyBoundedFileV1RuntimeContract<Connection> {
  readonly #options: LegacyBoundedFileV1RuntimeOptions<Connection>;
  readonly #factories: Readonly<RuntimeFactories>;
  readonly #enabled: boolean;
  #role: RuntimeRole = 'idle';
  #roomKind: RoomKind | null = null;
  #generation = 0;
  #token = 0;
  #host: HostRoom<Connection> | null = null;
  #guest: GuestRoom<Connection> | null = null;
  #cleanup: Promise<void> | null = null;
  #lifecycleTail: Promise<void> = Promise.resolve();
  readonly #orphanPublisherCleanups = new Set<RecordPublisherContract>();
  #orphanPublisherCleanupTimer: TimerHandle | null = null;
  #orphanPublisherCleanupAttempt = 0;
  #orphanPublisherCleanupInFlight: Promise<void> | null = null;

  constructor(options: LegacyBoundedFileV1RuntimeOptions<Connection>) {
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.nowRoomTimeMs !== 'function' ||
      typeof options.emitFrame !== 'function' ||
      typeof options.onLegacyFallback !== 'function' ||
      (options.onFailure !== undefined && typeof options.onFailure !== 'function')
    ) {
      throw new TypeError('Legacy bounded V1 runtime options are invalid');
    }
    this.#options = options;
    this.#factories = defaultFactories(options.seamsForTests);
    this.#enabled = this.#safeGate();
  }

  beginHostRoom(
    input: Readonly<LegacyBoundedFileV1HostRoomInput>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    return this.#enqueueLifecycle(() => this.#beginHostRoom(input));
  }

  async #beginHostRoom(
    input: Readonly<LegacyBoundedFileV1HostRoomInput>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    await this.#endRoomNow();
    void this.#retryOrphanPublisherCleanups();
    this.#generation += 1;
    this.#roomKind = input?.kind ?? null;
    if (!this.#enabled || input?.kind === 'pro') {
      this.#role = 'bypass';
      return freezeRecord({ status: 'bypass' });
    }
    if (
      input?.kind !== 'standard' ||
      !identifier(input.roomEpoch) ||
      !STANDARD_STORAGE_ROOM_ID_RE.test(input.storageRoomId) ||
      !input.roomToken ||
      typeof input.roomToken !== 'object'
    ) {
      throw new TypeError('Legacy bounded V1 host room input is invalid');
    }

    let port: LegacyBoundedFilePortContract | null = null;
    let publisher: RecordPublisherContract | null = null;
    try {
      const generation = this.#generation;
      port = this.#factories.createPort({ nowRoomTimeMs: this.#options.nowRoomTimeMs });
      const bridge = this.#factories.createBridge({
        port,
        nowRoomTimeMs: this.#options.nowRoomTimeMs,
      });
      publisher = this.#factories.createPublisher(input.roomToken);
      const connections = new Map<Connection, HostConnection>();
      const room: HostRoom<Connection> = {
        generation,
        roomEpoch: input.roomEpoch,
        storageRoomId: input.storageRoomId,
        publisher,
        port,
        bridge,
        connections,
        retiredConnections: new WeakSet(),
        deferredQueueItemRemovals: new Set(),
        current: null,
      };
      this.#host = room;
      this.#guest = null;
      this.#role = 'host';
      return freezeRecord({ status: 'active', role: 'host' });
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(port ? [port.clear()] : []),
        ...(publisher ? [publisher.close()] : []),
      ]);
      if (publisher && cleanupResults.at(-1)?.status === 'rejected') {
        this.#retainOrphanPublisherCleanup(
          publisher,
          (cleanupResults.at(-1) as PromiseRejectedResult).reason,
        );
      }
      this.#role = 'idle';
      this.#roomKind = null;
      this.#reportFailure('room-begin', error);
      throw error;
    }
  }

  beginGuestRoom(
    input: Readonly<LegacyBoundedFileV1GuestRoomInput<Connection>>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    return this.#enqueueLifecycle(() => this.#beginGuestRoom(input));
  }

  async #beginGuestRoom(
    input: Readonly<LegacyBoundedFileV1GuestRoomInput<Connection>>,
  ): Promise<LegacyBoundedFileV1RoomBeginOutcome> {
    await this.#endRoomNow();
    void this.#retryOrphanPublisherCleanups();
    this.#generation += 1;
    this.#roomKind = input?.kind ?? null;
    if (!this.#enabled || input?.kind === 'pro') {
      this.#role = 'bypass';
      return freezeRecord({ status: 'bypass' });
    }
    if (
      input?.kind !== 'standard' ||
      !input.hostConnection ||
      typeof input.hostConnection !== 'object'
    ) {
      throw new TypeError('Legacy bounded V1 guest room input is invalid');
    }

    let provider: FilePlaybackR2RecordDeliveryProviderContract | null = null;
    let port: LegacyBoundedFilePortContract | null = null;
    try {
      const registry = this.#factories.createRegistry();
      provider = this.#factories.createProvider(registry);
      port = this.#factories.createPort({ nowRoomTimeMs: this.#options.nowRoomTimeMs });
      const bridge = this.#factories.createBridge({
        port,
        nowRoomTimeMs: this.#options.nowRoomTimeMs,
      });
      this.#guest = {
        generation: this.#generation,
        connection: input.hostConnection,
        registry,
        provider,
        port,
        bridge,
        capabilityAnnounced: false,
        connectionRetired: false,
        current: null,
        transitionDrain: Promise.resolve(),
      };
      this.#host = null;
      this.#role = 'guest';
      return freezeRecord({ status: 'active', role: 'guest' });
    } catch (error) {
      await Promise.allSettled([
        ...(port ? [port.clear()] : []),
        ...(provider ? [provider.dispose()] : []),
      ]);
      this.#role = 'idle';
      this.#roomKind = null;
      this.#reportFailure('room-begin', error);
      throw error;
    }
  }

  endRoom(): Promise<void> {
    return this.#enqueueLifecycle(() => this.#endRoomNow());
  }

  #endRoomNow(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    const host = this.#host;
    const guest = this.#guest;
    if (!host && !guest) {
      this.#role = 'idle';
      this.#roomKind = null;
      void this.#retryOrphanPublisherCleanups();
      return Promise.resolve();
    }
    this.#generation += 1;
    this.#token += 1;
    this.#host = null;
    this.#guest = null;
    this.#role = 'idle';
    this.#roomKind = null;
    const cleanup = (async () => {
      const tasks: Promise<unknown>[] = [];
      if (host) {
        if (host.current) {
          this.#settleAllHostOfferWaiters(host.current, freezeRecord({ status: 'retired' }));
          for (const connection of host.connections.keys()) {
            host.current.ledger.retireConnection(connection);
          }
          tasks.push(host.bridge.retire(host.current.scope));
        }
        tasks.push(
          host.port.clear(),
          host.publisher.close().catch((error) => {
            this.#retainOrphanPublisherCleanup(host.publisher, error);
          }),
        );
      }
      if (guest) {
        if (guest.current) this.#enqueueGuestRetirement(guest, guest.current);
        tasks.push(
          guest.transitionDrain.then(async () => {
            await Promise.allSettled([guest.port.clear(), guest.provider.dispose()]);
          }),
        );
      }
      const results = await Promise.allSettled(tasks);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) this.#reportFailure('cleanup', rejected.reason);
    })().finally(() => {
      if (this.#cleanup === cleanup) this.#cleanup = null;
    });
    this.#cleanup = cleanup;
    return cleanup;
  }

  #retainOrphanPublisherCleanup(publisher: RecordPublisherContract, error: unknown): void {
    this.#orphanPublisherCleanups.add(publisher);
    this.#reportFailure('cleanup', error);
    this.#scheduleOrphanPublisherCleanup();
  }

  #scheduleOrphanPublisherCleanup(): void {
    if (
      this.#orphanPublisherCleanups.size === 0 ||
      this.#orphanPublisherCleanupTimer !== null ||
      this.#orphanPublisherCleanupInFlight
    ) {
      return;
    }
    const delayMs = Math.min(
      ORPHAN_PUBLISHER_CLEANUP_RETRY_MAX_MS,
      ORPHAN_PUBLISHER_CLEANUP_RETRY_BASE_MS *
        2 ** Math.min(this.#orphanPublisherCleanupAttempt, 6),
    );
    this.#orphanPublisherCleanupAttempt += 1;
    this.#orphanPublisherCleanupTimer = this.#factories.scheduleTimeout(() => {
      this.#orphanPublisherCleanupTimer = null;
      void this.#retryOrphanPublisherCleanups();
    }, delayMs);
  }

  #retryOrphanPublisherCleanups(): Promise<void> {
    if (this.#orphanPublisherCleanupInFlight) {
      return this.#orphanPublisherCleanupInFlight;
    }
    if (this.#orphanPublisherCleanups.size === 0) {
      this.#orphanPublisherCleanupAttempt = 0;
      if (this.#orphanPublisherCleanupTimer !== null) {
        this.#factories.cancelTimeout(this.#orphanPublisherCleanupTimer);
        this.#orphanPublisherCleanupTimer = null;
      }
      return Promise.resolve();
    }
    if (this.#orphanPublisherCleanupTimer !== null) {
      this.#factories.cancelTimeout(this.#orphanPublisherCleanupTimer);
      this.#orphanPublisherCleanupTimer = null;
    }

    const publishers = [...this.#orphanPublisherCleanups];
    const retry = Promise.allSettled(publishers.map((publisher) => publisher.close()))
      .then((results) => {
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            this.#orphanPublisherCleanups.delete(publishers[index]);
          }
        });
      })
      .finally(() => {
        if (this.#orphanPublisherCleanupInFlight === retry) {
          this.#orphanPublisherCleanupInFlight = null;
        }
        if (this.#orphanPublisherCleanups.size === 0) {
          this.#orphanPublisherCleanupAttempt = 0;
        } else {
          this.#scheduleOrphanPublisherCleanup();
        }
      });
    this.#orphanPublisherCleanupInFlight = retry;
    return retry;
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#lifecycleTail.then(operation, operation);
    this.#lifecycleTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async retireConnection(connection: Connection): Promise<boolean> {
    const host = this.#host;
    if (this.#role === 'host' && host) {
      if (host.retiredConnections.has(connection)) return false;
      host.retiredConnections.add(connection);
      const existed = host.connections.delete(connection);
      const retired = host.current?.ledger.retireConnection(connection) ?? false;
      if (host.current) {
        host.current.legacyFallbackAcks.delete(connection);
        host.current.legacyFallbackStates.delete(connection);
        this.#settleHostOfferWaiters(host.current, connection, freezeRecord({ status: 'retired' }));
      }
      this.#requestDeferredQueueItemRemovalFlush();
      return existed || retired;
    }
    const guest = this.#guest;
    if (
      this.#role !== 'guest' ||
      !guest ||
      guest.connection !== connection ||
      guest.connectionRetired
    ) {
      return false;
    }
    guest.connectionRetired = true;
    const current = guest.current;
    guest.capabilityAnnounced = false;
    if (current) {
      current.state = 'retiring';
      try {
        await this.#enqueueGuestRetirement(guest, current);
      } finally {
        if (guest.current === current) guest.current = null;
      }
    } else {
      await guest.transitionDrain;
    }
    return true;
  }

  announceGuestCapability(connection: Connection): boolean {
    const guest = this.#guest;
    if (
      this.#role !== 'guest' ||
      !guest ||
      guest.connection !== connection ||
      guest.connectionRetired ||
      guest.capabilityAnnounced
    ) {
      return false;
    }
    if (!this.#safeEmit(connection, CAPABILITY_FRAME)) return false;
    guest.capabilityAnnounced = true;
    return true;
  }

  adoptHostCapability(connection: Connection, frame: unknown): string {
    const host = this.#host;
    if (this.#role !== 'host' || !host) return 'bypass';
    if (host.retiredConnections.has(connection)) return 'retired';
    if (!exactCapabilityFrame(frame)) return 'invalid';
    let connectionState: HostConnection;
    try {
      connectionState = this.#hostConnection(host, connection);
    } catch (error) {
      this.#reportFailure('host-publication', error);
      return 'invalid';
    }
    if (connectionState.capability === 'legacy-only') return 'legacy-committed';
    const duplicate = connectionState.capability === 'capable';
    connectionState.capability = 'capable';
    const current = host.current;
    if (!current) return duplicate ? 'duplicate' : 'accepted';
    const outcome = current.ledger.recordCapability(connection, frame);
    this.#settleHostOfferFromLedger(current, connection);
    return outcome.status;
  }

  adoptHostResult(connection: Connection, frame: unknown): string {
    const host = this.#host;
    if (this.#role !== 'host' || !host) return 'bypass';
    if (host.retiredConnections.has(connection)) return 'retired';
    const current = host.current;
    if (!current) return 'stale';
    const outcome = current.ledger.recordResult(connection, frame);
    this.#settleHostOfferFromLedger(current, connection);
    if (outcome.status === 'ready') this.#requestDeferredQueueItemRemovalFlush();
    return outcome.status;
  }

  async prepareHost(
    input: Readonly<LegacyBoundedFileV1HostPrepareInput>,
  ): Promise<LegacyBoundedFileV1PrepareOutcome> {
    const host = this.#host;
    if (this.#role !== 'host' || !host) return freezeRecord({ status: 'bypass' });
    if (!validHostPrepare(input)) {
      const error = new TypeError('Legacy bounded V1 host media input is invalid');
      this.#reportFailure('host-prepare', error);
      return freezeRecord({ status: 'failed', error });
    }

    const priorRetirement = host.current?.retirement;
    if (priorRetirement) {
      await priorRetirement;
      if (this.#role !== 'host' || this.#host !== host) {
        return freezeRecord({ status: 'superseded' });
      }
    }

    const token = ++this.#token;
    let current: HostCurrent<Connection>;
    let nextConnectionGenerations: Map<Connection, string>;
    try {
      // The stable transfer session is a control generation and legitimately
      // changes on A→B→A. R2 record assets, however, are upload-once per room
      // and immutable queue occurrence. Derive that media lifetime here from
      // room + queue identity so a revisit reuses the exact publication rather
      // than conflicting with its own prior bytes.
      const mediaScope = createFilePlaybackMediaScope(host.roomEpoch, input.queueItemId);
      const canonicalInput: Readonly<LegacyBoundedFileV1HostPrepareInput> = freezeRecord({
        ...input,
        sourceIdentity: mediaScope.sourceIdentity,
        transferSessionId: mediaScope.transferSessionId,
      });
      nextConnectionGenerations = new Map(
        Array.from(host.connections.keys(), (connection) => [
          connection,
          this.#newIdentifier('peer'),
        ]),
      );
      const deliveryScope: Readonly<FilePlaybackR2RecordDeliveryScope> = freezeRecord({
        roomEpoch: host.roomEpoch,
        bridgeGeneration: this.#newIdentifier('host'),
        bindingId: canonicalInput.transferSessionId,
        queueItemId: canonicalInput.queueItemId,
        sourceIdentity: canonicalInput.sourceIdentity,
      });
      const scope = bridgeScope(deliveryScope, this.#newIdentifier('local'), 1);
      const binding = this.#factories.createBlobBinding(
        canonicalInput.blob,
        canonicalInput.sourceIdentity,
        canonicalInput.name,
        canonicalInput.mime,
      );
      const open = this.#createOpener(binding, canonicalInput.queueItemId);
      const publication = host.publisher.publishRecordSet(
        freezeRecord({
          blob: canonicalInput.blob,
          name: canonicalInput.name,
          mime: canonicalInput.mime,
          queueItemId: canonicalInput.queueItemId,
          sourceIdentity: canonicalInput.sourceIdentity,
          transferSessionId: canonicalInput.transferSessionId,
        }),
        freezeRecord({
          storageRoomId: host.storageRoomId,
          applicationSessionId: host.roomEpoch,
        }),
      );
      current = {
        generation: host.generation,
        token,
        input: canonicalInput,
        scope,
        open,
        publication,
        ledger: this.#createHostLedger(host),
        settlementWaiters: new Map(),
        legacyFallbackAcks: new Map(),
        legacyFallbackStates: new Map(),
        cleanupBarrierArmed: false,
        naturalEndSettlement: null,
        retirement: null,
        state: 'preparing',
      };
    } catch (error) {
      this.#reportFailure('host-prepare', error);
      return freezeRecord({ status: 'failed', error });
    }

    const prior = host.current;
    if (prior) {
      this.#settleAllHostOfferWaiters(prior, freezeRecord({ status: 'superseded' }));
      for (const connection of host.connections.keys()) {
        prior.ledger.retireConnection(connection);
      }
    }
    for (const [connection, connectionState] of host.connections) {
      connectionState.bridgeGeneration =
        nextConnectionGenerations.get(connection) ?? connectionState.bridgeGeneration;
      connectionState.frame = null;
      connectionState.fallbackAcks.clear();
    }
    host.current = current;
    void current.publication.catch((error) => {
      if (
        this.#isCurrentHost(host, current) &&
        (current.state === 'preparing' || current.state === 'ready')
      ) {
        this.#reportFailure('host-publication', error);
      }
    });
    if (prior && prior.input.queueItemId !== current.input.queueItemId) {
      // A queue occurrence owns one immutable publication across repeat
      // visits. A different occurrence may cancel only unfinished work; the
      // publisher deliberately preserves completed sets for active readers
      // until explicit queue removal or room teardown.
      // cancelPendingRecordSet performs its abort synchronously before waiting
      // for remote cleanup. Keep that cleanup off the successor's critical
      // prepare path; a rejection is stage-redacted and the publisher retains
      // enough state for room-close cleanup.
      void host.publisher
        .cancelPendingRecordSet(prior.input.queueItemId)
        .catch((error) => this.#reportFailure('cleanup', error));
    }
    // Record publications are room/queue-occurrence assets, not renderer
    // assets. Retain the prior queue item for repeat-mode playback; only room
    // teardown (or an explicit future queue-removal API) may delete it.

    let outcome: LegacyBoundedV1PrepareOutcome;
    try {
      outcome = await host.bridge.prepare({
        scope: current.scope,
        open: current.open as Parameters<LegacyBoundedFileV1BridgeContract['prepare']>[0]['open'],
      });
    } catch (error) {
      if (!this.#isCurrentHost(host, current)) {
        return freezeRecord({ status: 'superseded' });
      }
      current.state = 'failed';
      this.#reportFailure('host-prepare', error);
      return freezeRecord({ status: 'failed', error });
    }
    if (!this.#isCurrentHost(host, current)) {
      // An exact owner-switch retirement already owns this drain. Only a
      // genuinely superseded preparation needs an independent cleanup call.
      if (current.state !== 'retiring') void host.bridge.retire(current.scope);
      return freezeRecord({ status: 'superseded' });
    }
    if (outcome.status === 'ready' && outcome.snapshot.durationSeconds !== null) {
      current.state = 'ready';
      return freezeRecord({
        status: 'ready',
        durationSeconds: outcome.snapshot.durationSeconds,
      });
    }
    if (outcome.status === 'fallback') {
      current.state = 'fallback';
      void host.publisher.removeQueueItem(input.queueItemId).catch(() => undefined);
      return freezeRecord({ status: 'fallback' });
    }
    if (outcome.status === 'superseded') {
      return freezeRecord({ status: 'superseded' });
    }
    current.state = 'failed';
    const error =
      outcome.status === 'failed'
        ? outcome.error
        : new Error('Legacy bounded V1 host preparation produced no duration');
    this.#reportFailure('host-prepare', error);
    return freezeRecord({ status: 'failed', error });
  }

  async offerHostCurrent(connection: Connection): Promise<LegacyBoundedFileV1OfferOutcome> {
    const purpose = 'current' as const;
    const host = this.#host;
    if (this.#role !== 'host' || !host) return freezeRecord({ status: 'bypass' });
    if (host.retiredConnections.has(connection)) {
      return freezeRecord({ status: 'retired' });
    }
    const current = host.current;
    if (!current || current.state === 'fallback' || current.state === 'failed') {
      if (current) {
        this.#fallbackOnce(host, connection, {
          legacySessionId: current.input.legacySessionId,
          purpose,
          queueItemId: current.input.queueItemId,
          reason: 'local-fallback',
        });
      }
      return freezeRecord({ status: 'fallback' });
    }
    if (current.state !== 'ready') return freezeRecord({ status: 'superseded' });

    let connectionState: HostConnection;
    try {
      connectionState = this.#hostConnection(host, connection);
    } catch (error) {
      this.#reportFailure('host-publication', error);
      return freezeRecord({ status: 'failed', error });
    }
    if (connectionState.capability === 'capable') {
      current.ledger.recordCapability(connection, CAPABILITY_FRAME);
    } else if (connectionState.capability === 'legacy-only') {
      current.ledger.commitConnectionToLegacy(connection);
    }
    const existingFallbackAcknowledgement = current.legacyFallbackAcks.get(connection);
    if (existingFallbackAcknowledgement) {
      const fallbackState = current.legacyFallbackStates.get(connection);
      if (fallbackState?.status === 'failed') {
        return freezeRecord({ status: 'failed', error: fallbackState.error });
      }
      if (fallbackState?.status === 'pending') {
        return freezeRecord({ status: 'pending' });
      }
      return freezeRecord({ status: 'legacy-committed' });
    }
    let publication: Readonly<FilePlaybackR2RecordPublication>;
    const pinnedFrame = connectionState.frame;
    if (
      pinnedFrame &&
      pinnedFrame.legacySessionId === current.input.legacySessionId &&
      pinnedFrame.purpose === purpose &&
      pinnedFrame.scope.queueItemId === current.input.queueItemId &&
      pinnedFrame.scope.sourceIdentity === current.input.sourceIdentity &&
      pinnedFrame.scope.bindingId === current.input.transferSessionId
    ) {
      // An accepted descriptor remains valid for this exact connection even
      // when the publisher rotates future offers away from a near-expiry set.
      // Never revoke an active reader merely to refresh a reconnect.
      publication = pinnedFrame.publication;
    } else {
      try {
        // Re-enter the publisher for every unpinned peer offer. It returns the
        // reusable set cheaply, rotates a near-expiry set, or retries a prior
        // failed publication. Existing connection frames stay pinned above.
        publication = await host.publisher.publishRecordSet(
          freezeRecord({
            blob: current.input.blob,
            name: current.input.name,
            mime: current.input.mime,
            queueItemId: current.input.queueItemId,
            sourceIdentity: current.input.sourceIdentity,
            transferSessionId: current.input.transferSessionId,
          }),
          freezeRecord({
            storageRoomId: host.storageRoomId,
            applicationSessionId: host.roomEpoch,
          }),
        );
      } catch (error) {
        if (!this.#isCurrentHost(host, current)) {
          return freezeRecord({ status: 'superseded' });
        }
        const acknowledgement = this.#fallbackOnce(host, connection, {
          legacySessionId: current.input.legacySessionId,
          purpose,
          queueItemId: current.input.queueItemId,
          reason: 'publication-failed',
        });
        current.legacyFallbackAcks.set(connection, acknowledgement);
        this.#settleHostLegacyOfferAfterAck(current, connection);
        return freezeRecord({ status: 'failed', error });
      }
    }
    if (!this.#isCurrentHost(host, current)) {
      return freezeRecord({ status: 'superseded' });
    }
    if (
      host.retiredConnections.has(connection) ||
      host.connections.get(connection) !== connectionState
    ) {
      return freezeRecord({ status: 'retired' });
    }

    let outcome: ReturnType<HostCurrent<Connection>['ledger']['offerDescriptor']>;
    try {
      let frame = connectionState.frame;
      if (
        !frame ||
        frame.legacySessionId !== current.input.legacySessionId ||
        frame.purpose !== purpose
      ) {
        const scope: Readonly<FilePlaybackR2RecordDeliveryScope> = freezeRecord({
          roomEpoch: host.roomEpoch,
          bridgeGeneration: connectionState.bridgeGeneration,
          bindingId: current.input.transferSessionId,
          queueItemId: current.input.queueItemId,
          sourceIdentity: current.input.sourceIdentity,
        });
        frame = freezeRecord({
          type: 'file-r2-record-descriptor',
          bridgeVersion: 1,
          legacySessionId: current.input.legacySessionId,
          purpose,
          scope,
          descriptorId: this.#newIdentifier('descriptor'),
          descriptorVersion: 1,
          publication,
        });
        connectionState.frame = frame;
      }
      outcome = current.ledger.offerDescriptor(connection, frame);
    } catch (error) {
      this.#reportFailure('host-publication', error);
      return freezeRecord({ status: 'failed', error });
    }
    if (
      outcome.status === 'pending' ||
      outcome.status === 'descriptor-sent' ||
      outcome.status === 'ready' ||
      outcome.status === 'legacy-committed' ||
      outcome.status === 'retired'
    ) {
      return freezeRecord({ status: outcome.status });
    }
    const error = new Error(`Legacy bounded V1 descriptor offer rejected: ${outcome.status}`);
    this.#reportFailure('host-publication', error);
    return freezeRecord({ status: 'failed', error });
  }

  async offerHostCurrentSettled(
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1OfferOutcome> {
    const host = this.#host;
    if (this.#role !== 'host' || !host) return freezeRecord({ status: 'bypass' });
    if (!isQueueItemId(queueItemId) || !positiveSession(legacySessionId)) {
      const error = new TypeError('Legacy bounded V1 settled offer target is invalid');
      this.#reportFailure('host-publication', error);
      return freezeRecord({ status: 'failed', error });
    }
    const current = host.current;
    if (
      !current ||
      current.input.queueItemId !== queueItemId ||
      current.input.legacySessionId !== legacySessionId
    ) {
      return freezeRecord({ status: 'superseded' });
    }
    if (host.retiredConnections.has(connection)) {
      return freezeRecord({ status: 'retired' });
    }

    let resolveWaiter!: (outcome: LegacyBoundedFileV1OfferOutcome) => void;
    const settled = new Promise<LegacyBoundedFileV1OfferOutcome>((resolve) => {
      resolveWaiter = resolve;
    });
    const waiter: HostOfferSettlementWaiter = {
      queueItemId,
      legacySessionId,
      resolve: resolveWaiter,
    };
    const waiters = current.settlementWaiters.get(connection) ?? new Set();
    waiters.add(waiter);
    current.settlementWaiters.set(connection, waiters);

    let initial: LegacyBoundedFileV1OfferOutcome;
    try {
      initial = await this.offerHostCurrent(connection);
    } catch (error) {
      this.#removeHostOfferWaiter(current, connection, waiter);
      this.#reportFailure('host-publication', error);
      return freezeRecord({ status: 'failed', error });
    }
    if (
      initial.status === 'legacy-committed' ||
      (initial.status === 'failed' && current.legacyFallbackAcks.has(connection))
    ) {
      this.#settleHostLegacyOfferAfterAck(current, connection);
      return settled;
    }
    if (initial.status !== 'pending') {
      this.#removeHostOfferWaiter(current, connection, waiter);
      return initial;
    }
    this.#settleHostOfferFromLedger(current, connection);
    return settled;
  }

  beginGuestTransfer(input: Readonly<LegacyBoundedFileV1GuestTransferInput>): boolean {
    const guest = this.#guest;
    if (
      this.#role !== 'guest' ||
      !guest ||
      guest.connectionRetired ||
      !input ||
      !isQueueItemId(input.queueItemId) ||
      !positiveSession(input.legacySessionId)
    ) {
      return false;
    }
    const prior = guest.current;
    if (
      prior &&
      prior.queueItemId === input.queueItemId &&
      prior.legacySessionId === input.legacySessionId &&
      prior.state !== 'fallback' &&
      prior.state !== 'failed'
    ) {
      return true;
    }
    const current: GuestCurrent = {
      generation: guest.generation,
      token: ++this.#token,
      queueItemId: input.queueItemId,
      legacySessionId: input.legacySessionId,
      state: 'preparing',
      scope: null,
      deliveryScope: null,
      descriptor: null,
      open: null,
      descriptorPromise: null,
      pendingControl: null,
      retirement: null,
    };
    guest.current = current;
    if (prior) void this.#enqueueGuestRetirement(guest, prior);
    return true;
  }

  async abandonGuestTransfer(
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<boolean> {
    const guest = this.#guest;
    const current = guest?.current;
    if (
      this.#role !== 'guest' ||
      !guest ||
      guest.connection !== connection ||
      guest.connectionRetired ||
      !current ||
      current.queueItemId !== queueItemId ||
      current.legacySessionId !== legacySessionId
    ) {
      return false;
    }
    current.state = 'retiring';
    try {
      await this.#enqueueGuestRetirement(guest, current);
      return true;
    } finally {
      if (guest.current === current) guest.current = null;
    }
  }

  adoptGuestDescriptor(
    connection: Connection,
    frame: Readonly<LegacyBoundedFileV1DescriptorFrame>,
  ): Promise<LegacyBoundedFileV1DescriptorOutcome> {
    const guest = this.#guest;
    if (
      this.#role !== 'guest' ||
      !guest ||
      guest.connection !== connection ||
      guest.connectionRetired
    ) {
      return Promise.resolve(freezeRecord({ status: 'bypass' }));
    }
    const current = guest.current;
    if (
      !current ||
      frame?.type !== 'file-r2-record-descriptor' ||
      frame.bridgeVersion !== 1 ||
      frame.descriptorVersion !== 1 ||
      frame.legacySessionId !== current.legacySessionId ||
      frame.scope?.queueItemId !== current.queueItemId
    ) {
      return Promise.resolve(freezeRecord({ status: 'stale' }));
    }

    if (current.descriptor && current.descriptorPromise) {
      const candidate: Readonly<FilePlaybackR2RecordDescriptorRef> = freezeRecord({
        scope: frame.scope,
        descriptorId: frame.descriptorId,
        descriptorVersion: 1,
      });
      return sameDescriptor(current.descriptor, candidate)
        ? current.descriptorPromise
        : Promise.resolve(freezeRecord({ status: 'stale' }));
    }

    const promise = this.#prepareGuestDescriptor(guest, current, connection, frame);
    current.descriptorPromise = promise;
    return promise;
  }

  async applyControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1ControlOutcome> {
    if (this.#role !== 'host' && this.#role !== 'guest') {
      return freezeRecord({ status: 'bypass' });
    }
    if (!validControl(control)) {
      const error = new TypeError('Legacy bounded V1 canonical control is invalid');
      this.#reportFailure('control', error);
      return freezeRecord({ status: 'failed', error });
    }
    const host = this.#host;
    if (this.#role === 'host' && host?.current) {
      const current = host.current;
      if (!sameControlTarget(current.input, control)) {
        return freezeRecord({ status: 'superseded' });
      }
      if (current.state !== 'ready') return freezeRecord({ status: 'bypass' });
      const outcome = await this.#runControl(host.bridge, current, control);
      if (
        outcome.status === 'applied' &&
        (control.kind === 'play' || control.kind === 'seek-playing') &&
        this.#isCurrentHost(host, current)
      ) {
        current.naturalEndSettlement = null;
      }
      return outcome;
    }
    const guest = this.#guest;
    if (this.#role !== 'guest' || !guest?.current) {
      return freezeRecord({ status: 'bypass' });
    }
    const current = guest.current;
    if (!sameControlTarget(current, control)) return freezeRecord({ status: 'superseded' });
    if (current.state === 'preparing') {
      current.pendingControl = freezeRecord({
        ...control,
      }) as Readonly<LegacyBoundedFileV1CanonicalControl>;
      return freezeRecord({ status: 'buffered' });
    }
    if (current.state !== 'ready' || !current.scope || !current.open) {
      return freezeRecord({ status: current.state === 'fallback' ? 'fallback' : 'bypass' });
    }
    return this.#runControl(guest.bridge, current, control);
  }

  async scheduleHostControl(
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1HostControlScheduleOutcome> {
    const host = this.#host;
    if (this.#role !== 'host' || !host) {
      return freezeRecord({ status: 'bypass' });
    }
    if (!validControl(control) || (control.kind !== 'play' && control.kind !== 'seek-playing')) {
      const error = new TypeError('Legacy bounded V1 scheduled host control is invalid');
      this.#reportFailure('control', error);
      return freezeRecord({ status: 'failed', error });
    }
    const current = host.current;
    if (!current || !sameControlTarget(current.input, control)) {
      return freezeRecord({ status: 'superseded' });
    }
    if (current.state !== 'ready' || !current.scope || !current.open) {
      return freezeRecord({ status: current.state === 'fallback' ? 'fallback' : 'bypass' });
    }

    let outcome: LegacyBoundedV1ScheduleOutcome;
    try {
      outcome =
        control.kind === 'play'
          ? await host.bridge.schedulePlay({
              scope: current.scope,
              open: current.open as Parameters<
                LegacyBoundedFileV1BridgeContract['schedulePlay']
              >[0]['open'],
              positionSeconds: control.positionSeconds,
              startAtRoomTimeMs: control.startAtRoomTimeMs,
            })
          : await host.bridge.scheduleSeekPlaying({
              scope: current.scope,
              open: current.open as Parameters<
                LegacyBoundedFileV1BridgeContract['scheduleSeekPlaying']
              >[0]['open'],
              positionSeconds: control.positionSeconds,
              startAtRoomTimeMs: control.startAtRoomTimeMs,
            });
    } catch (error) {
      if (this.#isCurrentHost(host, current)) current.state = 'failed';
      this.#reportFailure('control', error);
      return freezeRecord({ status: 'failed', error });
    }
    if (outcome.status !== 'scheduled') {
      if (outcome.status === 'superseded') return freezeRecord({ status: 'superseded' });
      if (outcome.status === 'fallback') {
        if (this.#isCurrentHost(host, current)) current.state = 'fallback';
        return freezeRecord({ status: 'fallback' });
      }
      if (this.#isCurrentHost(host, current)) current.state = 'failed';
      this.#reportFailure('control', outcome.error);
      return freezeRecord({ status: 'failed', error: outcome.error });
    }
    if (!this.#isCurrentHost(host, current)) {
      return freezeRecord({ status: 'superseded' });
    }
    const snapshot = this.#currentSnapshot();
    if (!snapshot) return freezeRecord({ status: 'superseded' });
    const settled = outcome.settled.then((settlement) => {
      const mapped = this.#mapBridgeControlOutcome(current, settlement);
      if (mapped.status === 'applied' && this.#isCurrentHost(host, current)) {
        current.naturalEndSettlement = null;
      }
      return mapped;
    });
    return freezeRecord({
      status: 'scheduled',
      startAtRoomTimeMs: outcome.startAtRoomTimeMs,
      snapshot,
      settled,
    });
  }

  cancelPendingHostControl(
    queueItemId: QueueItemId,
    legacySessionId: number,
    positionSeconds: number,
  ): Promise<LegacyBoundedFileV1ControlOutcome> | null {
    const host = this.#host;
    const current = host?.current;
    if (
      this.#role !== 'host' ||
      !host ||
      !current ||
      current.input.queueItemId !== queueItemId ||
      current.input.legacySessionId !== legacySessionId ||
      current.state !== 'ready' ||
      !current.scope ||
      !finiteNonNegative(positionSeconds)
    ) {
      return null;
    }
    const pendingKind = host.bridge.snapshot().pending?.kind;
    if (pendingKind !== 'play' && pendingKind !== 'seek-playing') return null;
    let atRoomTimeMs: number;
    try {
      atRoomTimeMs = this.#options.nowRoomTimeMs();
      if (!finiteNonNegative(atRoomTimeMs)) return null;
    } catch {
      return null;
    }
    const cancellation = host.bridge.pause({
      scope: current.scope,
      positionSeconds,
      atRoomTimeMs,
    });
    const mapped = cancellation.then(
      (outcome) => this.#mapBridgeControlOutcome(current, outcome),
      (error) => {
        if (this.#isCurrentHost(host, current)) current.state = 'failed';
        this.#reportFailure('control', error);
        return freezeRecord({ status: 'failed' as const, error });
      },
    );
    return mapped;
  }

  async removeQueueItem(
    queueItemId: QueueItemId,
  ): Promise<LegacyBoundedFileV1QueueItemRemovalOutcome> {
    if (!isQueueItemId(queueItemId)) {
      const error = new TypeError('Legacy bounded V1 queue item removal target is invalid');
      this.#reportFailure('cleanup', error);
      return 'failed';
    }
    const host = this.#host;
    if (this.#role !== 'host' || !host) return 'bypass';
    if (
      host.current &&
      (host.current.input.queueItemId === queueItemId || !host.current.cleanupBarrierArmed)
    ) {
      // A successor becomes host.current before its guests necessarily stop
      // reading the predecessor. Until the application has enumerated and
      // armed the successor peer barrier, even a non-current occurrence is
      // protected from deletion.
      host.deferredQueueItemRemovals.add(queueItemId);
      return 'deferred';
    }
    host.deferredQueueItemRemovals.delete(queueItemId);
    try {
      await host.publisher.removeQueueItem(queueItemId);
      return 'removed';
    } catch (error) {
      // The publisher retains authenticated cleanup authority on failure.
      // Preserve the logical request as well so a later drain can retry it;
      // otherwise a transient DELETE failure would orphan the record set.
      host.deferredQueueItemRemovals.add(queueItemId);
      this.#reportFailure('cleanup', error);
      return 'failed';
    }
  }

  async flushDeferredQueueItemRemovals(): Promise<number> {
    const host = this.#host;
    if (this.#role !== 'host' || !host) return 0;
    // The application calls this only after it has enumerated the complete
    // live-peer successor barrier. Until then the runtime cannot distinguish
    // a truly guest-free room from a connected peer that has not announced
    // capability yet.
    if (host.current) host.current.cleanupBarrierArmed = true;
    return this.#drainDeferredQueueItemRemovals(host);
  }

  async #drainDeferredQueueItemRemovals(host: HostRoom<Connection>): Promise<number> {
    if (this.#host !== host || this.#role !== 'host') return 0;
    if (!this.#hostCurrentHasReleasedPriorReaders(host)) return 0;
    const currentQueueItemId = host.current?.input.queueItemId ?? null;
    const removable = [...host.deferredQueueItemRemovals].filter(
      (queueItemId) => queueItemId !== currentQueueItemId,
    );
    let removed = 0;
    for (const queueItemId of removable) {
      // Remove from the pending set before the await so concurrent flushes
      // cannot issue duplicate physical deletes. A failed attempt is restored
      // for an exact later retry.
      host.deferredQueueItemRemovals.delete(queueItemId);
      try {
        await host.publisher.removeQueueItem(queueItemId);
        removed += 1;
      } catch (error) {
        host.deferredQueueItemRemovals.add(queueItemId);
        this.#reportFailure('cleanup', error);
      }
    }
    return removed;
  }

  async retireCurrent(queueItemId: QueueItemId, legacySessionId: number): Promise<boolean> {
    const host = this.#host;
    if (this.#role === 'host' && host?.current) {
      const current = host.current;
      if (
        current.input.queueItemId !== queueItemId ||
        current.input.legacySessionId !== legacySessionId
      ) {
        return false;
      }
      if (current.retirement) return current.retirement;
      current.state = 'retiring';
      this.#settleAllHostOfferWaiters(current, freezeRecord({ status: 'retired' }));
      for (const connection of host.connections.keys()) {
        current.ledger.retireConnection(connection);
      }
      const retirement = (async () => {
        try {
          await host.bridge.retire(current.scope);
          return true;
        } finally {
          if (host.current === current) host.current = null;
          this.#requestDeferredQueueItemRemovalFlush();
        }
      })();
      current.retirement = retirement;
      return retirement;
    }
    const guest = this.#guest;
    if (this.#role === 'guest' && guest?.current) {
      const current = guest.current;
      if (current.queueItemId !== queueItemId || current.legacySessionId !== legacySessionId) {
        return false;
      }
      // Retain the exact incarnation until both the bridge and delivery source
      // have retired. Repeated owner switches can then join this same drain
      // instead of mistaking an early `current=null` for released output.
      current.state = 'retiring';
      try {
        await this.#enqueueGuestRetirement(guest, current);
        return true;
      } finally {
        if (guest.current === current) guest.current = null;
      }
    }
    return false;
  }

  settleHostNaturalEnd(
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): Promise<LegacyBoundedFileV1NaturalEndOutcome> {
    const host = this.#host;
    if (this.#role !== 'host' || !host) {
      return Promise.resolve(freezeRecord({ status: 'bypass' }));
    }
    if (!isQueueItemId(queueItemId) || !positiveSession(legacySessionId)) {
      const error = new TypeError('Legacy bounded V1 natural-end target is invalid');
      this.#reportFailure('control', error);
      return Promise.resolve(freezeRecord({ status: 'failed', error }));
    }
    const current = host.current;
    if (
      !current ||
      current.input.queueItemId !== queueItemId ||
      current.input.legacySessionId !== legacySessionId
    ) {
      return Promise.resolve(freezeRecord({ status: 'superseded' }));
    }
    if (current.naturalEndSettlement) return current.naturalEndSettlement;
    const observation = host.bridge.snapshot();
    if (
      current.state !== 'ready' ||
      !sameBridgeScope(current.scope, observation.scope) ||
      observation.phase !== 'playing' ||
      observation.durationSeconds === null ||
      observation.durationSeconds <= NATURAL_END_MIN_DURATION_SECONDS ||
      observation.positionSeconds < observation.durationSeconds - NATURAL_END_EPSILON_SECONDS
    ) {
      return Promise.resolve(freezeRecord({ status: 'not-ended' }));
    }

    const settlement = (async (): Promise<LegacyBoundedFileV1NaturalEndOutcome> => {
      let atRoomTimeMs: number;
      try {
        atRoomTimeMs = this.#options.nowRoomTimeMs();
        if (!finiteNonNegative(atRoomTimeMs)) {
          throw new Error('Legacy bounded V1 room clock is invalid');
        }
      } catch (error) {
        this.#reportFailure('control', error);
        return freezeRecord({ status: 'failed', error });
      }
      const outcome = await this.#runControl(
        host.bridge,
        current,
        freezeRecord({
          kind: 'stop',
          queueItemId,
          legacySessionId,
          positionSeconds: 0,
          atRoomTimeMs,
        }),
      );
      if (outcome.status === 'applied') {
        if (!this.#isCurrentHost(host, current)) {
          return freezeRecord({ status: 'superseded' });
        }
        return freezeRecord({ status: 'settled', snapshot: outcome.snapshot });
      }
      if (outcome.status === 'superseded') {
        return freezeRecord({ status: 'superseded' });
      }
      if (outcome.status === 'failed') {
        return freezeRecord({ status: 'failed', error: outcome.error });
      }
      const error = new Error('Legacy bounded V1 natural-end stop did not settle');
      this.#reportFailure('control', error);
      return freezeRecord({ status: 'failed', error });
    })();
    current.naturalEndSettlement = settlement;
    return settlement;
  }

  ownsSession(queueItemId: QueueItemId, legacySessionId: number): boolean {
    if (!isQueueItemId(queueItemId) || !positiveSession(legacySessionId)) return false;
    const current = this.#host?.current ?? this.#guest?.current;
    const identity = current ? currentIdentity(current) : null;
    return (
      !!current &&
      identity?.queueItemId === queueItemId &&
      identity.legacySessionId === legacySessionId &&
      current.state !== 'fallback' &&
      current.state !== 'failed'
    );
  }

  ownsGuestTransfer(
    connection: Connection,
    queueItemId: QueueItemId,
    legacySessionId: number,
  ): boolean {
    const guest = this.#guest;
    return (
      this.#role === 'guest' &&
      !!guest &&
      guest.connection === connection &&
      !guest.connectionRetired &&
      this.ownsSession(queueItemId, legacySessionId)
    );
  }

  hasReadyRenderer(queueItemId: QueueItemId, legacySessionId: number): boolean {
    const current = this.#host?.current ?? this.#guest?.current;
    const identity = current ? currentIdentity(current) : null;
    return (
      !!current &&
      identity?.queueItemId === queueItemId &&
      identity.legacySessionId === legacySessionId &&
      current.state === 'ready'
    );
  }

  positionSeconds(): number | null {
    return this.#currentSnapshot()?.positionSeconds ?? null;
  }

  durationSeconds(): number | null {
    return this.#currentSnapshot()?.durationSeconds ?? null;
  }

  snapshot(): Readonly<LegacyBoundedFileV1RuntimeSnapshot> {
    return freezeRecord({
      schemaVersion: 1,
      active: this.#role === 'host' || this.#role === 'guest',
      role: this.#role,
      roomKind: this.#roomKind,
      roomEpoch: this.#host?.roomEpoch ?? null,
      generation: this.#generation,
      current: this.#currentSnapshot(),
      hostConnections: this.#host?.connections.size ?? 0,
      guestCapabilityAnnounced: this.#guest?.capabilityAnnounced ?? false,
    });
  }

  async #prepareGuestDescriptor(
    guest: GuestRoom<Connection>,
    current: GuestCurrent,
    connection: Connection,
    frame: Readonly<LegacyBoundedFileV1DescriptorFrame>,
  ): Promise<LegacyBoundedFileV1DescriptorOutcome> {
    try {
      // `beginGuestTransfer` is intentionally synchronous for FILE_PREPARE.
      // The descriptor side pays the asynchronous retirement barrier and then
      // rechecks exact current authority before it touches secrets or audio.
      await guest.transitionDrain;
      if (!this.#isCurrentGuest(guest, current)) {
        return freezeRecord({ status: 'stale' });
      }
      const ref = guest.registry.register({
        scope: frame.scope,
        descriptorId: frame.descriptorId,
        descriptorVersion: frame.descriptorVersion,
        publication: frame.publication,
      });
      const scope = bridgeScope(ref.scope, ref.descriptorId, ref.descriptorVersion);
      const binding = this.#factories.createR2Binding(guest.provider, ref.scope, ref);
      const open = this.#createOpener(binding, current.queueItemId);
      current.scope = scope;
      current.deliveryScope = ref.scope;
      current.descriptor = ref;
      current.open = open;
      const outcome = await guest.bridge.prepare({
        scope,
        open: open as Parameters<LegacyBoundedFileV1BridgeContract['prepare']>[0]['open'],
      });
      if (!this.#isCurrentGuest(guest, current)) {
        current.pendingControl = null;
        await this.#enqueueGuestRetirement(guest, current);
        return freezeRecord({ status: 'stale' });
      }
      if (outcome.status === 'ready' && outcome.snapshot.durationSeconds !== null) {
        current.state = 'ready';
        const pending = current.pendingControl;
        current.pendingControl = null;
        if (pending) {
          const rebased = rebaseBufferedGuestControl(
            pending,
            this.#options.nowRoomTimeMs(),
            outcome.snapshot.durationSeconds,
          );
          await this.#runControl(guest.bridge, current, rebased);
          if (!this.#isCurrentGuest(guest, current)) {
            return freezeRecord({ status: 'stale' });
          }
          // #runControl may mutate this shared record across an await; retain
          // the full state union instead of TypeScript's pre-await `ready`
          // narrowing.
          const settledState = current.state as GuestCurrent['state'];
          if (settledState === 'fallback' || settledState === 'failed') {
            this.#sendGuestResult(connection, frame, 'fallback');
            await this.#enqueueGuestRetirement(guest, current);
            if (settledState === 'failed') {
              const error = new Error(
                'Legacy bounded V1 buffered guest control failed during descriptor readiness',
              );
              return freezeRecord({ status: 'failed', error });
            }
            return freezeRecord({ status: 'fallback' });
          }
        }
        this.#sendGuestResult(connection, frame, 'ready');
        return freezeRecord({
          status: 'ready',
          durationSeconds: outcome.snapshot.durationSeconds,
        });
      }
      current.state = outcome.status === 'failed' ? 'failed' : 'fallback';
      current.pendingControl = null;
      this.#sendGuestResult(connection, frame, 'fallback');
      await this.#enqueueGuestRetirement(guest, current);
      if (outcome.status === 'failed') {
        this.#reportFailure('guest-descriptor', outcome.error);
        return freezeRecord({ status: 'failed', error: outcome.error });
      }
      return freezeRecord({ status: 'fallback' });
    } catch (error) {
      current.pendingControl = null;
      await this.#enqueueGuestRetirement(guest, current);
      if (!this.#isCurrentGuest(guest, current)) {
        return freezeRecord({ status: 'stale' });
      }
      current.state = 'failed';
      this.#sendGuestResult(connection, frame, 'fallback');
      this.#reportFailure('guest-descriptor', error);
      return freezeRecord({ status: 'failed', error });
    }
  }

  async #runControl(
    bridge: LegacyBoundedFileV1BridgeContract,
    current: HostCurrent<Connection> | GuestCurrent,
    control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  ): Promise<LegacyBoundedFileV1ControlOutcome> {
    const scope = current.scope;
    const open = current.open;
    if (!scope || !open) return freezeRecord({ status: 'bypass' });
    let outcome: LegacyBoundedV1ControlOutcome;
    try {
      if (control.kind === 'play') {
        outcome = await bridge.play({
          scope,
          open: open as Parameters<LegacyBoundedFileV1BridgeContract['play']>[0]['open'],
          positionSeconds: control.positionSeconds,
          startAtRoomTimeMs: control.startAtRoomTimeMs,
        });
      } else if (control.kind === 'seek-playing') {
        outcome = await bridge.seekPlaying({
          scope,
          open: open as Parameters<LegacyBoundedFileV1BridgeContract['seekPlaying']>[0]['open'],
          positionSeconds: control.positionSeconds,
          startAtRoomTimeMs: control.startAtRoomTimeMs,
        });
      } else if (control.kind === 'pause') {
        outcome = await bridge.pause({
          scope,
          positionSeconds: control.positionSeconds,
          atRoomTimeMs: control.atRoomTimeMs,
        });
      } else if (control.kind === 'seek-paused') {
        outcome = await bridge.seekPaused({
          scope,
          positionSeconds: control.positionSeconds,
          atRoomTimeMs: control.atRoomTimeMs,
        });
      } else if (control.kind === 'stop') {
        outcome = await bridge.stop({
          scope,
          positionSeconds: control.positionSeconds,
          atRoomTimeMs: control.atRoomTimeMs,
        });
      } else {
        throw new TypeError('Legacy bounded V1 control kind is invalid');
      }
    } catch (error) {
      if (this.#isActiveCurrent(current)) current.state = 'failed';
      this.#reportFailure('control', error);
      return freezeRecord({ status: 'failed', error });
    }
    return this.#mapBridgeControlOutcome(current, outcome);
  }

  #mapBridgeControlOutcome(
    current: HostCurrent<Connection> | GuestCurrent,
    outcome: LegacyBoundedV1ControlOutcome,
  ): LegacyBoundedFileV1ControlOutcome {
    if (outcome.status === 'applied') {
      if (!this.#isActiveCurrent(current)) return freezeRecord({ status: 'superseded' });
      const snapshot = this.#currentSnapshot();
      return snapshot
        ? freezeRecord({ status: 'applied', snapshot })
        : freezeRecord({ status: 'superseded' });
    }
    if (outcome.status === 'superseded') return freezeRecord({ status: 'superseded' });
    if (outcome.status === 'fallback') {
      if (this.#isActiveCurrent(current)) current.state = 'fallback';
      return freezeRecord({ status: 'fallback' });
    }
    if (this.#isActiveCurrent(current)) current.state = 'failed';
    this.#reportFailure('control', outcome.error);
    return freezeRecord({ status: 'failed', error: outcome.error });
  }

  #createOpener(
    binding: Readonly<LegacyBoundedFileV1EncodedSourceBinding>,
    queueItemId: QueueItemId,
  ): (signal: AbortSignal) => Promise<unknown> {
    return async (signal: AbortSignal) => {
      const graph = await this.#factories.getAudioGraph();
      const nowRoomTimeMs = this.#options.nowRoomTimeMs;
      const adapter = this.#factories.createSourceAdapter({
        binding,
        destination: graph.destination,
        queueItemId,
        audioContext: graph.audioContext,
        nowRoomTimeMs,
        roomTimeMsToContextTime: (roomTimeMs) =>
          graph.audioContext.currentTime + (roomTimeMs - nowRoomTimeMs()) / 1_000,
        localPerformanceMsToContextTime: (localPerformanceMs) =>
          graph.audioContext.currentTime + (localPerformanceMs - performance.now()) / 1_000,
      });
      const outcome = await adapter.open(signal);
      return outcome.status === 'opened' ? outcome.opened : null;
    };
  }

  #hostConnection(host: HostRoom<Connection>, connection: Connection): HostConnection {
    const existing = host.connections.get(connection);
    if (existing) return existing;
    const created: HostConnection = {
      capability: 'unknown',
      bridgeGeneration: this.#newIdentifier('peer'),
      fallbackAcks: new Map(),
      frame: null,
    };
    host.connections.set(connection, created);
    return created;
  }

  #createHostLedger(host: HostRoom<Connection>) {
    const ledger = createLegacyBoundedFileV1NegotiationLedger<
      Connection,
      FilePlaybackR2RecordPublication,
      TimerHandle
    >({
      capabilityTimeoutMs: this.#options.capabilityTimeoutMs ?? 750,
      descriptorResultTimeoutMs: this.#options.descriptorResultTimeoutMs ?? 15_000,
      scheduleTimeout: this.#factories.scheduleTimeout,
      cancelTimeout: this.#factories.cancelTimeout,
      onDescriptor: (connection, frame) =>
        this.#safeEmit(connection, frame as Readonly<LegacyBoundedFileV1DescriptorFrame>),
      onLegacyCommit: (connection, commit) => {
        const activeCurrent = host.current;
        if (
          this.#host !== host ||
          this.#generation !== host.generation ||
          !activeCurrent ||
          activeCurrent.ledger !== ledger
        ) {
          return;
        }
        const connectionState = host.connections.get(connection);
        if (
          connectionState &&
          (commit.reason === 'capability-timeout' || commit.reason === 'capability-unavailable')
        ) {
          connectionState.capability = 'legacy-only';
        }
        const acknowledgement = this.#fallbackOnce(host, connection, {
          legacySessionId: commit.legacySessionId,
          purpose: commit.purpose,
          queueItemId: commit.scope.queueItemId,
          reason: commit.reason,
        });
        activeCurrent.legacyFallbackAcks.set(connection, acknowledgement);
        this.#settleHostLegacyOfferAfterAck(activeCurrent, connection);
      },
      onCallbackError: (error) => this.#reportFailure('callback', error),
    });
    return ledger;
  }

  #settleHostOfferFromLedger(current: HostCurrent<Connection>, connection: Connection): void {
    const snapshot = current.ledger.snapshot(connection);
    if (!snapshot) return;
    if (snapshot.retired) {
      this.#settleHostOfferWaiters(current, connection, freezeRecord({ status: 'retired' }));
      return;
    }
    const delivery = snapshot.deliveries.find(
      (candidate) =>
        candidate.purpose === 'current' &&
        candidate.legacySessionId === current.input.legacySessionId &&
        candidate.scope.queueItemId === current.input.queueItemId,
    );
    if (
      delivery?.state === 'descriptor-sent' ||
      delivery?.state === 'ready' ||
      delivery?.state === 'retired'
    ) {
      this.#settleHostOfferWaiters(current, connection, freezeRecord({ status: delivery.state }));
    } else if (delivery?.state === 'legacy-committed') {
      this.#settleHostLegacyOfferAfterAck(current, connection);
    }
  }

  #settleHostLegacyOfferAfterAck(current: HostCurrent<Connection>, connection: Connection): void {
    const acknowledgement = current.legacyFallbackAcks.get(connection);
    if (!acknowledgement) return;
    const existingState = current.legacyFallbackStates.get(connection);
    if (existingState?.status === 'pending') return;
    if (existingState?.status === 'committed') {
      this.#settleHostOfferWaiters(
        current,
        connection,
        freezeRecord({ status: 'legacy-committed' }),
      );
      this.#requestDeferredQueueItemRemovalFlush();
      return;
    }
    if (existingState?.status === 'failed') {
      this.#settleHostOfferWaiters(
        current,
        connection,
        freezeRecord({ status: 'failed', error: existingState.error }),
      );
      return;
    }
    current.legacyFallbackStates.set(connection, freezeRecord({ status: 'pending' }));
    void acknowledgement.then(
      () => {
        if (!this.#isLiveHostConnectionForCurrent(current, connection)) return;
        current.legacyFallbackStates.set(connection, freezeRecord({ status: 'committed' }));
        this.#settleHostOfferWaiters(
          current,
          connection,
          freezeRecord({ status: 'legacy-committed' }),
        );
        this.#requestDeferredQueueItemRemovalFlush();
      },
      (error) => {
        if (!this.#isLiveHostConnectionForCurrent(current, connection)) return;
        current.legacyFallbackStates.set(connection, freezeRecord({ status: 'failed', error }));
        this.#settleHostOfferWaiters(
          current,
          connection,
          freezeRecord({ status: 'failed', error }),
        );
      },
    );
  }

  #isLiveHostConnectionForCurrent(
    current: HostCurrent<Connection>,
    connection: Connection,
  ): boolean {
    const host = this.#host;
    return (
      !!host &&
      host.current === current &&
      current.generation === host.generation &&
      !host.retiredConnections.has(connection) &&
      host.connections.has(connection)
    );
  }

  #hostCurrentHasReleasedPriorReaders(host: HostRoom<Connection>): boolean {
    const current = host.current;
    if (!current) return true;
    if (!current.cleanupBarrierArmed || current.state !== 'ready') return false;
    for (const connection of host.connections.keys()) {
      const snapshot = current.ledger.snapshot(connection);
      if (!snapshot) return false;
      if (snapshot.retired) continue;
      const delivery = snapshot.deliveries.find(
        (candidate) =>
          candidate.active &&
          candidate.purpose === 'current' &&
          candidate.legacySessionId === current.input.legacySessionId &&
          candidate.scope.queueItemId === current.input.queueItemId,
      );
      if (delivery?.state === 'ready') continue;
      if (
        delivery?.state === 'legacy-committed' &&
        current.legacyFallbackStates.get(connection)?.status === 'committed'
      ) {
        continue;
      }
      if (
        !delivery &&
        current.legacyFallbackAcks.has(connection) &&
        current.legacyFallbackStates.get(connection)?.status === 'committed'
      ) {
        // Publication can fail before a descriptor enters the ledger. Its
        // exact stable-V1 dispatcher acknowledgement is still a complete
        // successor data-path proof for this connection.
        continue;
      }
      // descriptor-sent is only a selection marker: the guest may still be
      // reading the previous set while it prepares the successor. Preserve
      // deferred assets until every live connection proves native readiness
      // or an acknowledged stable-V1 fallback.
      return false;
    }
    return true;
  }

  #requestDeferredQueueItemRemovalFlush(): void {
    const host = this.#host;
    if (!host) return;
    void this.#drainDeferredQueueItemRemovals(host).catch((error) => {
      this.#reportFailure('cleanup', error);
    });
  }

  #settleHostOfferWaiters(
    current: HostCurrent<Connection>,
    connection: Connection,
    outcome: LegacyBoundedFileV1OfferOutcome,
  ): void {
    const waiters = current.settlementWaiters.get(connection);
    if (!waiters) return;
    current.settlementWaiters.delete(connection);
    for (const waiter of waiters) {
      if (
        waiter.queueItemId === current.input.queueItemId &&
        waiter.legacySessionId === current.input.legacySessionId
      ) {
        waiter.resolve(outcome);
      } else {
        waiter.resolve(freezeRecord({ status: 'superseded' }));
      }
    }
  }

  #settleAllHostOfferWaiters(
    current: HostCurrent<Connection>,
    outcome: LegacyBoundedFileV1OfferOutcome,
  ): void {
    for (const connection of [...current.settlementWaiters.keys()]) {
      this.#settleHostOfferWaiters(current, connection, outcome);
    }
  }

  #removeHostOfferWaiter(
    current: HostCurrent<Connection>,
    connection: Connection,
    waiter: HostOfferSettlementWaiter,
  ): void {
    const waiters = current.settlementWaiters.get(connection);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) current.settlementWaiters.delete(connection);
  }

  #fallbackOnce(
    host: HostRoom<Connection>,
    connection: Connection,
    commit: Readonly<LegacyBoundedFileV1FallbackCommit>,
  ): Promise<void> {
    let connectionState: HostConnection;
    try {
      connectionState = this.#hostConnection(host, connection);
    } catch (error) {
      this.#reportFailure('callback', error);
      const rejection = Promise.reject(error);
      void rejection.catch(() => undefined);
      return rejection;
    }
    const key = fallbackKey(commit.legacySessionId, commit.purpose, commit.queueItemId);
    const existing = connectionState.fallbackAcks.get(key);
    if (existing) return existing;
    let acknowledgement: Promise<void>;
    try {
      acknowledgement = Promise.resolve(
        this.#options.onLegacyFallback(connection, freezeRecord({ ...commit })),
      );
    } catch (error) {
      this.#reportFailure('callback', error);
      acknowledgement = Promise.reject(error);
    }
    connectionState.fallbackAcks.set(key, acknowledgement);
    void acknowledgement.catch((error) => {
      this.#reportFailure('callback', error);
    });
    return acknowledgement;
  }

  #sendGuestResult(
    connection: Connection,
    descriptor: Readonly<LegacyBoundedFileV1DescriptorFrame>,
    outcome: 'ready' | 'fallback',
  ): void {
    this.#safeEmit(
      connection,
      freezeRecord({
        type: 'file-r2-record-result',
        bridgeVersion: 1,
        legacySessionId: descriptor.legacySessionId,
        scope: descriptor.scope,
        descriptorId: descriptor.descriptorId,
        descriptorVersion: 1,
        outcome,
      }),
    );
  }

  #safeEmit(connection: Connection, frame: Readonly<LegacyBoundedFileV1WireFrame>): boolean {
    try {
      return this.#options.emitFrame(connection, frame) !== false;
    } catch (error) {
      this.#reportFailure('callback', error);
      return false;
    }
  }

  #reportFailure(stage: LegacyBoundedFileV1RuntimeFailure['stage'], error: unknown): void {
    try {
      this.#options.onFailure?.(freezeRecord({ stage, error }));
    } catch {
      // Diagnostics never acquire playback or transport authority.
    }
  }

  #newIdentifier(purpose: string): string {
    const value = this.#factories.createIdentifier(purpose);
    if (!identifier(value)) {
      throw new Error('Legacy bounded V1 identifier factory returned an invalid value');
    }
    return value;
  }

  #safeGate(): boolean {
    try {
      return this.#factories.gateEnabled() === true;
    } catch (error) {
      this.#reportFailure('room-begin', error);
      return false;
    }
  }

  #isCurrentHost(host: HostRoom<Connection>, current: HostCurrent<Connection>): boolean {
    return (
      this.#host === host &&
      this.#generation === host.generation &&
      host.current === current &&
      current.generation === host.generation &&
      current.state !== 'retiring'
    );
  }

  #isCurrentGuest(guest: GuestRoom<Connection>, current: GuestCurrent): boolean {
    return (
      this.#guest === guest &&
      this.#generation === guest.generation &&
      guest.current === current &&
      current.generation === guest.generation &&
      current.state !== 'retiring'
    );
  }

  #isActiveCurrent(current: HostCurrent<Connection> | GuestCurrent): boolean {
    return (
      current.state !== 'retiring' &&
      (this.#host?.current === current || this.#guest?.current === current)
    );
  }

  #enqueueGuestRetirement(guest: GuestRoom<Connection>, current: GuestCurrent): Promise<void> {
    if (current.retirement) return current.retirement;
    current.pendingControl = null;
    const retirement = guest.transitionDrain.then(async () => {
      const scope = current.scope;
      if (!scope) return;
      await Promise.allSettled([guest.bridge.retire(scope), guest.provider.retire(scope)]);
    });
    current.retirement = retirement;
    guest.transitionDrain = retirement.catch((error) => {
      this.#reportFailure('cleanup', error);
    });
    return retirement;
  }

  #currentSnapshot(): Readonly<LegacyBoundedFileV1CurrentSnapshot> | null {
    const current = this.#host?.current ?? this.#guest?.current;
    const bridge = this.#host?.bridge ?? this.#guest?.bridge;
    if (!current || !bridge) return null;
    const identity = currentIdentity(current);
    const snapshot = bridge.snapshot();
    const ownsSnapshot = !!current.scope && sameBridgeScope(current.scope, snapshot.scope);
    return freezeRecord({
      queueItemId: identity.queueItemId,
      legacySessionId: identity.legacySessionId,
      state: current.state,
      phase: ownsSnapshot ? snapshot.phase : 'idle',
      positionSeconds: ownsSnapshot ? snapshot.positionSeconds : 0,
      durationSeconds: ownsSnapshot ? snapshot.durationSeconds : null,
      pendingControl: 'pendingControl' in current ? (current.pendingControl?.kind ?? null) : null,
    });
  }
}

/**
 * Construct the only Phase-2 product coordinator. It deliberately exposes no
 * peer-close, session-close, old-V2-router, or application-state mutation
 * capability: stable V1 remains the sole room-control authority.
 */
export function createLegacyBoundedFileV1Runtime<Connection extends object>(
  options: LegacyBoundedFileV1RuntimeOptions<Connection>,
): LegacyBoundedFileV1RuntimeContract<Connection> {
  return new LegacyBoundedFileV1Runtime(options);
}
