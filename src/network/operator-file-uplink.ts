/**
 * Standard-room administrator -> host local-file uplink.
 *
 * This is deliberately a separate protocol and state machine from FILE_* and
 * PRELOAD_*. Those transports distribute host-owned queue media downstream;
 * using them in reverse would let two unrelated transfer owners corrupt each
 * other's session/reorder state.
 *
 * The uplink is RAM-only. The sender slices one bounded chunk at a time and
 * the host retains at most one shared 200 MiB in-flight encoded-byte
 * reservation across all active administrators. OPFS/IndexedDB are not used
 * here. Resident playlist Files and the browser's Blob assembly peak are
 * separate from that transport reservation.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { CHUNK_SIZE, MSG, REMOTE_SHARE_MAX_BYTES } from '../core/constants.ts';
import {
  partitionAudioFileCandidates,
  resolveAudioMime,
  stripRecognizedAudioFileExtension,
} from '../media/audio-file.ts';
import { canAppendPlaylistItems } from '../player/queue-model.ts';
import { getRoomContext, hasRoomCapability, verifyPeerCapability } from '../rooms/authority.ts';
import { pumpChunksToPeers } from '../storage/chunk-pump.ts';
import type {
  ConnectedPeer,
  DataConnection,
  ProtocolMsg,
  StandardOperatorFileUplinkProgress,
} from '../types/index.ts';
import { safeSend } from './peer-state.ts';
import { registerHandlers, registerInboundRateLimitExemptionGuard } from './protocol.ts';

const MAX_FILE_BYTES = REMOTE_SHARE_MAX_BYTES;
const MAX_RESERVED_HOST_BYTES = REMOTE_SHARE_MAX_BYTES;
const HOST_INACTIVITY_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const COMPLETE_TIMEOUT_MS = 30_000;
const COMPLETE_RETRY_TIMEOUT_MS = 8_000;
const BUFFERED_AMOUNT_LIMIT = 4 * 1024 * 1024;
const BACKPRESSURE_TIMEOUT_MS = 15_000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 128;
const PROGRESS_BYTE_INTERVAL = 1024 * 1024;

type UplinkTerminalCode =
  | 'cancelled'
  | 'connection-lost'
  | 'file-too-large'
  | 'host-busy'
  | 'invalid-file'
  | 'operator-revoked'
  | 'protocol-error'
  | 'queue-full'
  | 'ready-timeout'
  | 'receive-timeout'
  | 'session-reset'
  | 'superseded'
  | 'upload-failed';

interface HostUpload {
  readonly conn: DataConnection;
  readonly peerId: string;
  readonly roomCode: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly total: number;
  chunks: ArrayBuffer[];
  expectedChunkIndex: number;
  receivedBytes: number;
  lastReportedBytes: number;
  finishReceived: boolean;
  timeoutKey: string | null;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface OutgoingBatch {
  readonly requestId: string;
  readonly summaryNegotiated: boolean;
  cancelled: boolean;
  cancelCode: UplinkTerminalCode | null;
}

interface OutgoingUpload {
  readonly batch: OutgoingBatch;
  readonly conn: DataConnection;
  readonly requestId: string;
  readonly sessionId: string;
  readonly file: File;
  readonly mime: string;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly ready: Deferred;
  readonly completed: Deferred;
  accepted: boolean;
  loaded: number;
  failure: UplinkError | null;
  remoteComplete: boolean;
  terminalProgressEmitted: boolean;
}

interface SettledHostSession {
  readonly settledAt: number;
  readonly roomCode: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly total: number;
  readonly loaded: number;
  readonly status: 'complete' | 'rejected' | 'aborted';
  readonly code: UplinkTerminalCode | null;
}

class UplinkError extends Error {
  constructor(readonly code: UplinkTerminalCode) {
    super(code);
    this.name = 'UplinkError';
  }
}

let initialized = false;
let reservedHostBytes = 0;
let outgoingBatch: OutgoingBatch | null = null;
let outgoingUpload: OutgoingUpload | null = null;
let waitTimerSequence = 0;
const hostUploads = new Map<string, HostUpload>();
const settledHostSessions = new Map<string, SettledHostSession>();
const hostBatchCommits = new Map<
  string,
  {
    conn: DataConnection;
    roomCode: string;
    fileCount: number;
    committedCount: number;
    firstTitle: string | null;
    updatedAt: number;
  }
>();
const announcedHostBatches = new Map<string, number>();

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A terminal status can arrive after START acceptance but before the sender
  // reaches its `await completed` line (for example while the chunk pump is
  // waiting on backpressure). Mark the promise as observed immediately; the
  // original promise still rejects normally when it is awaited later.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeProgress(
  direction: 'send' | 'receive',
  phase: StandardOperatorFileUplinkProgress['phase'],
  values: {
    requestId: string;
    sessionId: string;
    fileName: string;
    loaded: number;
    total: number;
    fileIndex?: number;
    fileCount?: number;
    code?: string;
  },
): StandardOperatorFileUplinkProgress {
  return {
    direction,
    phase,
    requestId: values.requestId,
    sessionId: values.sessionId,
    fileName: values.fileName,
    loaded: values.loaded,
    total: values.total,
    ...(values.fileIndex === undefined ? {} : { fileIndex: values.fileIndex }),
    ...(values.fileCount === undefined ? {} : { fileCount: values.fileCount }),
    ...(values.code === undefined ? {} : { code: values.code }),
  };
}

function emitSendProgress(
  upload: OutgoingUpload,
  phase: StandardOperatorFileUplinkProgress['phase'],
  loaded: number,
  code?: string,
): void {
  if (phase === 'complete' || phase === 'aborted' || phase === 'error') {
    if (upload.terminalProgressEmitted) return;
    upload.terminalProgressEmitted = true;
  }
  bus.emit(
    'standard-room:operator-file-uplink-progress',
    makeProgress('send', phase, {
      requestId: upload.requestId,
      sessionId: upload.sessionId,
      fileName: upload.file.name,
      loaded,
      total: upload.file.size,
      fileIndex: upload.fileIndex,
      fileCount: upload.fileCount,
      code,
    }),
  );
}

function emitReceiveProgress(
  upload: HostUpload,
  phase: StandardOperatorFileUplinkProgress['phase'],
  code?: string,
): void {
  bus.emit(
    'standard-room:operator-file-uplink-progress',
    makeProgress('receive', phase, {
      requestId: upload.requestId,
      sessionId: upload.sessionId,
      fileName: upload.name,
      loaded: upload.receivedBytes,
      total: upload.size,
      code,
    }),
  );
}

function isValidFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_FILE_NAME_LENGTH &&
    name.trim() === name &&
    !name.includes('/') &&
    !name.includes('\\') &&
    ![...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

function isValidMime(mime: string): boolean {
  return mime.length > 0 && mime.length <= MAX_MIME_LENGTH && mime.trim() === mime;
}

function isValidAudioFile(file: File): boolean {
  return partitionAudioFileCandidates([file]).accepted.length === 1;
}

function currentRoomCode(): string {
  return getState('network.sessionCode');
}

function isExactAuthorizedHostConnection(conn: DataConnection): boolean {
  return (
    getRoomContext().kind === 'standard' &&
    getState('network.appRole') === 'host' &&
    !getState('network.hostConn') &&
    !!conn.peer &&
    getState('network.activeHostConnByPeerId').get(conn.peer) === conn &&
    verifyPeerCapability(conn, 'asset.upload')
  );
}

function isCurrentOutgoingAuthority(conn: DataConnection): boolean {
  return (
    getRoomContext().kind === 'standard' &&
    getState('network.appRole') === 'guest' &&
    getState('network.hostConn') === conn &&
    conn.open === true &&
    hasRoomCapability('asset.upload')
  );
}

function isActiveAuthorizedUploadChunk(
  data: Readonly<Record<string, unknown>>,
  conn: DataConnection,
): boolean {
  if (
    Object.keys(data).length !== 5 ||
    data.type !== MSG.OPERATOR_FILE_UPLOAD_CHUNK ||
    typeof data.requestId !== 'string' ||
    typeof data.sessionId !== 'string' ||
    typeof data.chunkIndex !== 'number' ||
    !Number.isSafeInteger(data.chunkIndex) ||
    data.chunkIndex < 0
  ) {
    return false;
  }
  const chunk = data.chunk;
  const isBuffer =
    chunk instanceof ArrayBuffer ||
    chunk instanceof Uint8Array ||
    (chunk != null &&
      typeof chunk === 'object' &&
      Object.prototype.toString.call(chunk) === '[object ArrayBuffer]');
  if (!isBuffer) return false;
  const byteLength = (chunk as ArrayBuffer | Uint8Array).byteLength;
  if (byteLength <= 0 || byteLength > CHUNK_SIZE) return false;

  const upload = hostUploads.get(conn.peer);
  return (
    !!upload &&
    upload.conn === conn &&
    upload.requestId === data.requestId &&
    upload.sessionId === data.sessionId &&
    upload.roomCode === currentRoomCode() &&
    isExactAuthorizedHostConnection(conn)
  );
}

function sendStatus(
  conn: DataConnection,
  requestId: string,
  sessionId: string,
  status: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_STATUS>['status'],
  loaded: number,
  total: number,
  code: string | null = null,
): boolean {
  return safeSend(conn, {
    type: MSG.OPERATOR_FILE_UPLOAD_STATUS,
    requestId,
    sessionId,
    status,
    loaded,
    total,
    code,
  });
}

function pruneSettledSessions(now = Date.now()): void {
  const cutoff = now - 10 * 60 * 1000;
  for (const [key, settled] of settledHostSessions) {
    if (settled.settledAt < cutoff) settledHostSessions.delete(key);
  }
  while (settledHostSessions.size > 256) {
    const oldest = settledHostSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    settledHostSessions.delete(oldest);
  }
}

function hostSessionKey(peerId: string, sessionId: string): string {
  return `${peerId}:${sessionId}`;
}

function hostBatchKey(peerId: string, requestId: string): string {
  return `${peerId}:${requestId}`;
}

function trackTitleFromFileName(name: string): string {
  return stripRecognizedAudioFileExtension(name);
}

function recordHostBatchCommit(upload: HostUpload): void {
  const key = hostBatchKey(upload.peerId, upload.requestId);
  const existing = hostBatchCommits.get(key);
  if (existing) {
    if (existing.conn !== upload.conn || existing.roomCode !== upload.roomCode) return;
    existing.firstTitle ??= trackTitleFromFileName(upload.name);
    existing.committedCount += 1;
    existing.updatedAt = Date.now();
    return;
  }
  // A pre-batch client has no additive BATCH_START terminal. Preserve rolling
  // compatibility by announcing each authoritative file commit immediately.
  bus.emit(
    'standard-room:operator-files-added',
    upload.conn,
    1,
    trackTitleFromFileName(upload.name),
  );
}

function pruneHostBatchLedgers(now = Date.now()): void {
  const cutoff = now - 10 * 60 * 1000;
  for (const [key, batch] of hostBatchCommits) {
    if (batch.updatedAt < cutoff) hostBatchCommits.delete(key);
  }
  while (hostBatchCommits.size > 256) {
    const oldest = hostBatchCommits.keys().next().value as string | undefined;
    if (!oldest) break;
    hostBatchCommits.delete(oldest);
  }
  for (const [key, announcedAt] of announcedHostBatches) {
    if (announcedAt < cutoff) announcedHostBatches.delete(key);
  }
  while (announcedHostBatches.size > 256) {
    const oldest = announcedHostBatches.keys().next().value as string | undefined;
    if (!oldest) break;
    announcedHostBatches.delete(oldest);
  }
}

function handleUploadBatchStart(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_BATCH_START>,
  conn: DataConnection,
): void {
  if (!isExactAuthorizedHostConnection(conn)) return;
  const roomCode = currentRoomCode();
  if (!roomCode) return;
  pruneHostBatchLedgers();
  const key = hostBatchKey(conn.peer, data.requestId);
  if (announcedHostBatches.has(key)) return;
  const existing = hostBatchCommits.get(key);
  if (existing) {
    if (
      existing.conn === conn &&
      existing.roomCode === roomCode &&
      existing.fileCount === data.fileCount
    ) {
      existing.updatedAt = Date.now();
    }
    return;
  }
  hostBatchCommits.set(key, {
    conn,
    roomCode,
    fileCount: data.fileCount,
    committedCount: 0,
    firstTitle: null,
    updatedAt: Date.now(),
  });
  pruneHostBatchLedgers();
}

function clearHostBatchLedgersForPeer(peerId: string): void {
  const prefix = `${peerId}:`;
  for (const key of hostBatchCommits.keys()) {
    if (key.startsWith(prefix)) hostBatchCommits.delete(key);
  }
}

function handleUploadBatchComplete(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_BATCH_COMPLETE>,
  conn: DataConnection,
): void {
  if (!isExactAuthorizedHostConnection(conn)) return;
  const roomCode = currentRoomCode();
  if (!roomCode) return;
  const key = hostBatchKey(conn.peer, data.requestId);
  pruneHostBatchLedgers();
  if (announcedHostBatches.has(key)) return;
  const batch = hostBatchCommits.get(key);
  if (
    !batch ||
    batch.conn !== conn ||
    batch.roomCode !== roomCode ||
    batch.committedCount !== data.committedCount ||
    data.committedCount > batch.fileCount
  ) {
    return;
  }
  hostBatchCommits.delete(key);
  announcedHostBatches.set(key, Date.now());
  bus.emit(
    'standard-room:operator-files-added',
    conn,
    batch.committedCount,
    batch.firstTitle ?? undefined,
  );
}

function rememberSettledHostSession(
  upload: HostUpload,
  status: SettledHostSession['status'],
  code: UplinkTerminalCode | null,
): SettledHostSession {
  const settled: SettledHostSession = {
    settledAt: Date.now(),
    roomCode: upload.roomCode,
    requestId: upload.requestId,
    sessionId: upload.sessionId,
    name: upload.name,
    mime: upload.mime,
    size: upload.size,
    total: upload.total,
    loaded: upload.receivedBytes,
    status,
    code,
  };
  settledHostSessions.set(hostSessionKey(upload.peerId, upload.sessionId), settled);
  pruneSettledSessions();
  return settled;
}

function sendSettledHostStatus(conn: DataConnection, settled: SettledHostSession): boolean {
  if (settled.status === 'complete') {
    return sendStatus(
      conn,
      settled.requestId,
      settled.sessionId,
      'complete',
      settled.size,
      settled.size,
    );
  }
  return sendStatus(
    conn,
    settled.requestId,
    settled.sessionId,
    settled.status,
    settled.loaded,
    settled.size,
    settled.code || 'upload-failed',
  );
}

function settledMatchesStart(
  settled: SettledHostSession,
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_START>,
  roomCode: string,
  resolvedMime: string,
): boolean {
  return (
    settled.roomCode === roomCode &&
    settled.requestId === data.requestId &&
    settled.sessionId === data.sessionId &&
    settled.name === data.name &&
    settled.mime === resolvedMime &&
    settled.size === data.size &&
    settled.total === data.total
  );
}

function clearHostUpload(
  upload: HostUpload,
  code: UplinkTerminalCode | null,
  notifyPeer: boolean,
): void {
  if (hostUploads.get(upload.peerId) !== upload) return;
  hostUploads.delete(upload.peerId);
  if (upload.timeoutKey !== null) clearManagedTimer(upload.timeoutKey);
  upload.timeoutKey = null;
  reservedHostBytes = Math.max(0, reservedHostBytes - upload.size);
  upload.chunks.length = 0;
  if (code) {
    const settled = rememberSettledHostSession(
      upload,
      code === 'cancelled' ? 'aborted' : 'rejected',
      code,
    );
    if (notifyPeer) {
      sendSettledHostStatus(upload.conn, settled);
    }
    emitReceiveProgress(upload, code === 'cancelled' ? 'aborted' : 'error', code);
  }
}

function armHostTimeout(upload: HostUpload): void {
  if (upload.timeoutKey !== null) clearManagedTimer(upload.timeoutKey);
  const timeoutKey = `operator-file-uplink-host-${upload.peerId}-${upload.sessionId}`;
  upload.timeoutKey = timeoutKey;
  setManagedTimer(
    timeoutKey,
    () => {
      if (hostUploads.get(upload.peerId) !== upload) return;
      clearHostUpload(upload, 'receive-timeout', true);
    },
    HOST_INACTIVITY_TIMEOUT_MS,
  );
}

function abortHostUploadForPeer(
  peerId: string,
  code: UplinkTerminalCode,
  notifyPeer: boolean,
): void {
  const upload = hostUploads.get(peerId);
  if (upload) clearHostUpload(upload, code, notifyPeer);
}

function abortAllHostUploads(code: UplinkTerminalCode): void {
  for (const upload of [...hostUploads.values()]) clearHostUpload(upload, code, false);
}

function rejectStart(
  conn: DataConnection,
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_START>,
  code: UplinkTerminalCode,
): void {
  sendStatus(conn, data.requestId, data.sessionId, 'rejected', 0, data.size, code);
}

function handleUploadStart(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_START>,
  conn: DataConnection,
): void {
  if (!isExactAuthorizedHostConnection(conn)) {
    rejectStart(conn, data, 'operator-revoked');
    return;
  }

  const roomCode = currentRoomCode();
  if (!roomCode) {
    rejectStart(conn, data, 'session-reset');
    return;
  }

  const resolvedMime = resolveAudioMime(data.name, data.mime);
  pruneSettledSessions();
  const settled = settledHostSessions.get(hostSessionKey(conn.peer, data.sessionId));
  if (settled) {
    if (settledMatchesStart(settled, data, roomCode, resolvedMime)) {
      sendSettledHostStatus(conn, settled);
    } else {
      rejectStart(conn, data, 'protocol-error');
    }
    return;
  }

  const existing = hostUploads.get(conn.peer);
  if (existing) {
    if (
      existing.conn === conn &&
      existing.requestId === data.requestId &&
      existing.sessionId === data.sessionId &&
      existing.name === data.name &&
      existing.mime === resolvedMime &&
      existing.size === data.size &&
      existing.total === data.total
    ) {
      armHostTimeout(existing);
      if (
        !sendStatus(
          conn,
          data.requestId,
          data.sessionId,
          'ready',
          existing.receivedBytes,
          data.size,
        )
      ) {
        clearHostUpload(existing, 'connection-lost', false);
      }
      return;
    }
    rejectStart(conn, data, 'host-busy');
    return;
  }

  const metadataCandidate = new File([], data.name, { type: resolvedMime });
  if (
    !isValidFileName(data.name) ||
    !isValidMime(resolvedMime) ||
    !isValidAudioFile(metadataCandidate) ||
    data.size <= 0 ||
    data.size > MAX_FILE_BYTES ||
    data.total !== Math.ceil(data.size / CHUNK_SIZE)
  ) {
    rejectStart(conn, data, 'invalid-file');
    return;
  }

  if (reservedHostBytes + data.size > MAX_RESERVED_HOST_BYTES) {
    rejectStart(conn, data, 'host-busy');
    return;
  }

  // Reserve one queue occurrence along with the byte reservation. Without a
  // preflight, a full queue would force the sender to transfer and assemble an
  // entire file only to reject it at commit time.
  if (!canAppendPlaylistItems(hostUploads.size + 1)) {
    rejectStart(conn, data, 'queue-full');
    return;
  }

  const upload: HostUpload = {
    conn,
    peerId: conn.peer,
    roomCode,
    requestId: data.requestId,
    sessionId: data.sessionId,
    name: data.name,
    mime: resolvedMime,
    size: data.size,
    total: data.total,
    chunks: [],
    expectedChunkIndex: 0,
    receivedBytes: 0,
    lastReportedBytes: 0,
    finishReceived: false,
    timeoutKey: null,
  };
  hostUploads.set(conn.peer, upload);
  reservedHostBytes += data.size;
  armHostTimeout(upload);
  emitReceiveProgress(upload, 'waiting');
  if (!sendStatus(conn, data.requestId, data.sessionId, 'ready', 0, data.size)) {
    clearHostUpload(upload, 'connection-lost', false);
  }
}

function handleUploadChunk(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_CHUNK>,
  conn: DataConnection,
): void {
  const upload = hostUploads.get(conn.peer);
  if (
    !upload ||
    upload.conn !== conn ||
    upload.requestId !== data.requestId ||
    upload.sessionId !== data.sessionId
  ) {
    return;
  }
  if (!isExactAuthorizedHostConnection(conn) || upload.roomCode !== currentRoomCode()) {
    clearHostUpload(upload, 'operator-revoked', true);
    return;
  }

  const source =
    data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk as ArrayBuffer);
  const expectedLength = Math.min(CHUNK_SIZE, upload.size - upload.receivedBytes);
  if (
    data.chunkIndex !== upload.expectedChunkIndex ||
    data.chunkIndex >= upload.total ||
    source.byteLength !== expectedLength ||
    upload.receivedBytes + source.byteLength > upload.size
  ) {
    clearHostUpload(upload, 'protocol-error', true);
    return;
  }

  // Own the bytes independently of the transport adapter's inbound buffer.
  const owned = new Uint8Array(source.byteLength);
  owned.set(source);
  upload.chunks.push(owned.buffer);
  upload.expectedChunkIndex += 1;
  upload.receivedBytes += source.byteLength;
  armHostTimeout(upload);

  if (
    upload.receivedBytes === upload.size ||
    upload.receivedBytes - upload.lastReportedBytes >= PROGRESS_BYTE_INTERVAL
  ) {
    upload.lastReportedBytes = upload.receivedBytes;
    sendStatus(
      conn,
      upload.requestId,
      upload.sessionId,
      'progress',
      upload.receivedBytes,
      upload.size,
    );
    emitReceiveProgress(upload, 'uploading');
  }

  // Rolling releases can pair a new host with an older administrator client
  // whose FINISH still travels on the separate control channel. Remember an
  // early FINISH and commit only after the ordered bulk stream catches up.
  if (upload.finishReceived && isHostUploadComplete(upload)) {
    finalizeHostUpload(upload);
  }
}

function isHostUploadComplete(upload: HostUpload): boolean {
  return (
    upload.expectedChunkIndex === upload.total &&
    upload.receivedBytes === upload.size &&
    upload.chunks.length === upload.total
  );
}

function finalizeHostUpload(upload: HostUpload): void {
  if (hostUploads.get(upload.peerId) !== upload) return;
  const { conn } = upload;
  if (!isExactAuthorizedHostConnection(conn) || upload.roomCode !== currentRoomCode()) {
    clearHostUpload(upload, 'operator-revoked', true);
    return;
  }
  if (!upload.finishReceived || !isHostUploadComplete(upload)) return;

  if (upload.timeoutKey !== null) clearManagedTimer(upload.timeoutKey);
  upload.timeoutKey = null;
  emitReceiveProgress(upload, 'assembling');

  try {
    const file = new File(upload.chunks, upload.name, {
      type: upload.mime,
      lastModified: Date.now(),
    });
    if (file.size !== upload.size || !isValidAudioFile(file)) {
      clearHostUpload(upload, 'invalid-file', true);
      return;
    }

    // Playlist listeners are synchronous. Require an explicit success fence
    // so a missing listener, a full queue, or an exception swallowed by
    // EventBus can never become a false-positive completion ACK.
    const commit = { outcome: false as true | false | 'queue-full' };
    bus.emit(
      'standard-room:operator-file-received',
      file,
      (outcome) => {
        commit.outcome = outcome;
      },
      conn,
    );
    if (commit.outcome !== true) {
      clearHostUpload(
        upload,
        commit.outcome === 'queue-full' ? 'queue-full' : 'upload-failed',
        true,
      );
      return;
    }

    // A synchronous playlist listener must not be able to turn an authority
    // loss into a success ACK through re-entrancy.
    if (
      hostUploads.get(upload.peerId) !== upload ||
      !isExactAuthorizedHostConnection(conn) ||
      upload.roomCode !== currentRoomCode()
    ) {
      clearHostUpload(upload, 'operator-revoked', true);
      return;
    }

    recordHostBatchCommit(upload);

    hostUploads.delete(upload.peerId);
    if (upload.timeoutKey !== null) clearManagedTimer(upload.timeoutKey);
    upload.timeoutKey = null;
    reservedHostBytes = Math.max(0, reservedHostBytes - upload.size);
    const settled = rememberSettledHostSession(upload, 'complete', null);
    upload.chunks.length = 0;
    sendSettledHostStatus(conn, settled);
    emitReceiveProgress(upload, 'complete');
  } catch (error) {
    log.warn('[OperatorFileUplink] Host assembly or playlist commit failed', error);
    clearHostUpload(upload, 'upload-failed', true);
  }
}

function handleUploadFinish(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_FINISH>,
  conn: DataConnection,
): void {
  const upload = hostUploads.get(conn.peer);
  if (
    !upload ||
    upload.conn !== conn ||
    upload.requestId !== data.requestId ||
    upload.sessionId !== data.sessionId
  ) {
    pruneSettledSessions();
    const settled = settledHostSessions.get(hostSessionKey(conn.peer, data.sessionId));
    if (
      settled &&
      settled.requestId === data.requestId &&
      settled.roomCode === currentRoomCode() &&
      isExactAuthorizedHostConnection(conn)
    ) {
      sendSettledHostStatus(conn, settled);
    }
    return;
  }
  if (!isExactAuthorizedHostConnection(conn) || upload.roomCode !== currentRoomCode()) {
    clearHostUpload(upload, 'operator-revoked', true);
    return;
  }
  upload.finishReceived = true;
  armHostTimeout(upload);
  finalizeHostUpload(upload);
}

function handleUploadAbort(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_ABORT>,
  conn: DataConnection,
): void {
  const upload = hostUploads.get(conn.peer);
  if (
    !upload ||
    upload.conn !== conn ||
    upload.requestId !== data.requestId ||
    upload.sessionId !== data.sessionId
  ) {
    return;
  }
  clearHostUpload(upload, 'cancelled', true);
}

function handleUploadStatus(
  data: ProtocolMsg<typeof MSG.OPERATOR_FILE_UPLOAD_STATUS>,
  conn: DataConnection,
): void {
  const upload = outgoingUpload;
  if (
    !upload ||
    upload.conn !== conn ||
    upload.requestId !== data.requestId ||
    upload.sessionId !== data.sessionId ||
    !isCurrentOutgoingAuthority(conn)
  ) {
    return;
  }

  if (data.total !== upload.file.size || data.loaded > upload.file.size) {
    const error = new UplinkError('protocol-error');
    upload.failure = error;
    emitSendProgress(upload, 'error', upload.loaded, error.code);
    if (upload.accepted) upload.completed.reject(error);
    else upload.ready.reject(error);
    return;
  }

  if (data.status === 'ready') {
    upload.accepted = true;
    upload.ready.resolve();
    emitSendProgress(upload, 'uploading', data.loaded);
    return;
  }
  if (data.status === 'progress') {
    emitSendProgress(upload, 'uploading', data.loaded);
    return;
  }
  if (data.status === 'complete') {
    upload.remoteComplete = true;
    upload.accepted = true;
    upload.loaded = upload.file.size;
    emitSendProgress(upload, 'complete', upload.file.size);
    // A duplicate START can recover a previously committed upload by replying
    // with COMPLETE directly, before READY. Settle both fences and let the
    // sender skip the chunk pump.
    upload.ready.resolve();
    upload.completed.resolve();
    return;
  }

  const code = (data.code || (data.status === 'aborted' ? 'cancelled' : 'upload-failed')) as
    | UplinkTerminalCode
    | 'upload-failed';
  const error = new UplinkError(code);
  upload.failure = error;
  emitSendProgress(upload, data.status === 'aborted' ? 'aborted' : 'error', data.loaded, code);
  if (upload.accepted) upload.completed.reject(error);
  else upload.ready.reject(error);
}

async function waitFor(promise: Promise<void>, timeoutMs: number, code: UplinkTerminalCode) {
  const timeoutKey = `operator-file-uplink-wait-${++waitTimerSequence}`;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setManagedTimer(timeoutKey, () => reject(new UplinkError(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearManagedTimer(timeoutKey);
  }
}

function cancelOutgoing(code: UplinkTerminalCode, notifyHost: boolean): void {
  const batch = outgoingBatch;
  if (batch) {
    batch.cancelled = true;
    batch.cancelCode = code;
  }
  const upload = outgoingUpload;
  if (!upload) return;
  if (notifyHost && upload.conn.open) {
    safeSend(upload.conn, {
      type: MSG.OPERATOR_FILE_UPLOAD_ABORT,
      requestId: upload.requestId,
      sessionId: upload.sessionId,
      reason: code,
    });
  }
  const error = new UplinkError(code);
  upload.failure = error;
  emitSendProgress(upload, 'aborted', upload.loaded, code);
  if (upload.accepted) upload.completed.reject(error);
  else upload.ready.reject(error);
}

function createPseudoPeer(conn: DataConnection): ConnectedPeer {
  return {
    id: conn.peer,
    slot: 0,
    label: conn.peer,
    conn,
    isOp: true,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: getState('network.connectionType'),
    lastHeartbeat: Date.now(),
  };
}

async function uploadOne(
  batch: OutgoingBatch,
  conn: DataConnection,
  file: File,
  fileIndex: number,
  fileCount: number,
): Promise<void> {
  const mime = resolveAudioMime(file.name, file.type);
  const sessionId = createId();
  const upload: OutgoingUpload = {
    batch,
    conn,
    requestId: batch.requestId,
    sessionId,
    file,
    mime,
    fileIndex,
    fileCount,
    ready: createDeferred(),
    completed: createDeferred(),
    accepted: false,
    loaded: 0,
    failure: null,
    remoteComplete: false,
    terminalProgressEmitted: false,
  };
  outgoingUpload = upload;
  const total = Math.ceil(file.size / CHUNK_SIZE);
  emitSendProgress(upload, 'waiting', 0);

  try {
    if (file.size > MAX_FILE_BYTES) {
      throw new UplinkError('file-too-large');
    }
    if (
      !isValidFileName(file.name) ||
      !isValidMime(mime) ||
      !isValidAudioFile(file) ||
      file.size <= 0
    ) {
      throw new UplinkError('invalid-file');
    }
    if (!isCurrentOutgoingAuthority(conn) || batch.cancelled) {
      throw new UplinkError(batch.cancelCode || 'operator-revoked');
    }
    if (
      !safeSend(conn, {
        type: MSG.OPERATOR_FILE_UPLOAD_START,
        requestId: batch.requestId,
        sessionId,
        name: file.name,
        mime,
        size: file.size,
        total,
      })
    ) {
      throw new UplinkError('connection-lost');
    }
    await waitFor(upload.ready.promise, READY_TIMEOUT_MS, 'ready-timeout');
    if (upload.remoteComplete) return;

    const pseudoPeer = createPseudoPeer(conn);
    const result = await pumpChunksToPeers({
      file,
      chunkSize: CHUNK_SIZE,
      peers: [pseudoPeer],
      buildChunkMsg: (chunk, chunkIndex) => ({
        type: MSG.OPERATOR_FILE_UPLOAD_CHUNK,
        requestId: batch.requestId,
        sessionId,
        chunkIndex,
        chunk,
      }),
      bufferedLimit: BUFFERED_AMOUNT_LIMIT,
      stallTimeoutMs: BACKPRESSURE_TIMEOUT_MS,
      isWritable: () =>
        isCurrentOutgoingAuthority(conn) && !batch.cancelled && upload.failure === null,
      shouldContinue: () =>
        isCurrentOutgoingAuthority(conn) && !batch.cancelled && upload.failure === null,
      onChunkComplete: (_chunkIndex, byteLength) => {
        upload.loaded += byteLength;
        emitSendProgress(upload, 'uploading', upload.loaded);
      },
    });
    if (upload.failure) throw upload.failure;
    if (result.status !== 'complete' || result.excluded.size > 0 || batch.cancelled) {
      throw new UplinkError(batch.cancelCode || 'connection-lost');
    }
    if (
      !safeSend(conn, {
        type: MSG.OPERATOR_FILE_UPLOAD_FINISH,
        requestId: batch.requestId,
        sessionId,
      })
    ) {
      throw new UplinkError('connection-lost');
    }
    emitSendProgress(upload, 'assembling', file.size);
    try {
      await waitFor(upload.completed.promise, COMPLETE_TIMEOUT_MS, 'upload-failed');
    } catch (error) {
      // The host commits before acknowledging. If only that final ACK was
      // lost, replaying the idempotent FINISH lets its settled-session ledger
      // return COMPLETE without publishing a duplicate queue row.
      if (
        upload.failure ||
        upload.remoteComplete ||
        batch.cancelled ||
        !isCurrentOutgoingAuthority(conn) ||
        !(error instanceof UplinkError) ||
        error.code !== 'upload-failed' ||
        !safeSend(conn, {
          type: MSG.OPERATOR_FILE_UPLOAD_FINISH,
          requestId: batch.requestId,
          sessionId,
        })
      ) {
        throw error;
      }
      await waitFor(upload.completed.promise, COMPLETE_RETRY_TIMEOUT_MS, 'upload-failed');
    }
  } catch (error) {
    const code = error instanceof UplinkError ? error.code : 'upload-failed';
    if (upload.accepted && conn.open && !batch.cancelled) {
      safeSend(conn, {
        type: MSG.OPERATOR_FILE_UPLOAD_ABORT,
        requestId: batch.requestId,
        sessionId,
        reason: code,
      });
    }
    emitSendProgress(upload, batch.cancelled ? 'aborted' : 'error', upload.loaded, code);
    throw error;
  } finally {
    // A failed file must never retain the one-active slot and permanently
    // block a later file or retry.
    if (outgoingUpload === upload) outgoingUpload = null;
  }
}

/**
 * Queue a standard-room administrator's selected files to the host. Files are
 * sent strictly one at a time. A per-file failure is reported and cleaned up;
 * authority loss/session teardown cancels the active file and every not-yet
 * started file in the batch.
 */
export async function uploadStandardOperatorFiles(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  if (outgoingBatch) {
    const first = files[0];
    if (first) {
      bus.emit(
        'standard-room:operator-file-uplink-progress',
        makeProgress('send', 'error', {
          requestId: outgoingBatch.requestId,
          sessionId: createId(),
          fileName: first.name,
          loaded: 0,
          total: first.size,
          code: 'host-busy',
        }),
      );
    }
    return;
  }
  const conn = getState('network.hostConn');
  if (!conn || !isCurrentOutgoingAuthority(conn)) return;

  const requestId = createId();
  const hasUploadCandidate = files.some((file) => {
    const mime = resolveAudioMime(file.name, file.type);
    return (
      file.size > 0 &&
      file.size <= MAX_FILE_BYTES &&
      isValidFileName(file.name) &&
      isValidMime(mime) &&
      isValidAudioFile(file)
    );
  });
  const summaryNegotiated =
    hasUploadCandidate &&
    files.length <= 1000 &&
    safeSend(conn, {
      type: MSG.OPERATOR_FILE_UPLOAD_BATCH_START,
      requestId,
      fileCount: files.length,
    });
  const batch: OutgoingBatch = {
    requestId,
    summaryNegotiated,
    cancelled: false,
    cancelCode: null,
  };
  outgoingBatch = batch;
  // BATCH_START is additive negotiation: an older host ignores it and keeps
  // accepting the unchanged per-file START/CHUNK/FINISH protocol.
  let committedCount = 0;
  try {
    for (let index = 0; index < files.length; index++) {
      if (batch.cancelled || outgoingBatch !== batch) break;
      const file = files[index];
      if (!file) continue;
      try {
        await uploadOne(batch, conn, file, index, files.length);
        committedCount += 1;
      } catch (error) {
        log.warn('[OperatorFileUplink] File upload failed', error);
        // A stale/unsupported authority cannot accept any later file. Other
        // per-file failures release their slot and allow the queue to proceed.
        const code = error instanceof UplinkError ? error.code : 'upload-failed';
        if (
          code === 'connection-lost' ||
          code === 'host-busy' ||
          code === 'operator-revoked' ||
          code === 'queue-full' ||
          code === 'ready-timeout' ||
          code === 'session-reset'
        ) {
          batch.cancelled = true;
          batch.cancelCode = code;
        }
      }
    }
  } finally {
    if (batch.summaryNegotiated && committedCount > 0 && isCurrentOutgoingAuthority(conn)) {
      safeSend(conn, {
        type: MSG.OPERATOR_FILE_UPLOAD_BATCH_COMPLETE,
        requestId: batch.requestId,
        committedCount,
      });
    }
    if (outgoingUpload?.batch === batch) outgoingUpload = null;
    if (outgoingBatch === batch) outgoingBatch = null;
  }
}

/** Register protocol and lifecycle listeners once at application bootstrap. */
export function initStandardOperatorFileUplink(): void {
  if (initialized) return;
  initialized = true;

  registerInboundRateLimitExemptionGuard(
    MSG.OPERATOR_FILE_UPLOAD_CHUNK,
    isActiveAuthorizedUploadChunk,
  );

  registerHandlers({
    [MSG.OPERATOR_FILE_UPLOAD_BATCH_START]: handleUploadBatchStart,
    [MSG.OPERATOR_FILE_UPLOAD_START]: handleUploadStart,
    [MSG.OPERATOR_FILE_UPLOAD_BATCH_COMPLETE]: handleUploadBatchComplete,
    [MSG.OPERATOR_FILE_UPLOAD_CHUNK]: handleUploadChunk,
    [MSG.OPERATOR_FILE_UPLOAD_FINISH]: handleUploadFinish,
    [MSG.OPERATOR_FILE_UPLOAD_ABORT]: handleUploadAbort,
    [MSG.OPERATOR_FILE_UPLOAD_STATUS]: handleUploadStatus,
  });

  bus.on('network:peer-disconnected', (peerId) => {
    abortHostUploadForPeer(peerId, 'connection-lost', false);
    clearHostBatchLedgersForPeer(peerId);
  });
  bus.on('network:peer-connection-replaced', (peerId) => {
    abortHostUploadForPeer(peerId, 'superseded', false);
    clearHostBatchLedgersForPeer(peerId);
  });
  bus.on('state:network.connectedPeers', () => {
    for (const upload of [...hostUploads.values()]) {
      if (!isExactAuthorizedHostConnection(upload.conn)) {
        clearHostUpload(upload, 'operator-revoked', true);
      }
    }
  });
  const cancelIfOutgoingAuthorityWasRevoked = (): void => {
    if (outgoingUpload && !hasRoomCapability('asset.upload')) {
      cancelOutgoing('operator-revoked', true);
    }
  };
  bus.on('state:network.isOperator', cancelIfOutgoingAuthorityWasRevoked);
  bus.on('state:network.standardRoomCapabilities', cancelIfOutgoingAuthorityWasRevoked);
  bus.on('state:network.hostConn', () => {
    if (outgoingUpload && getState('network.hostConn') !== outgoingUpload.conn) {
      cancelOutgoing('connection-lost', false);
    }
  });
  bus.on('state:network.appRole', () => {
    if (getState('network.appRole') === 'idle') {
      cancelOutgoing('session-reset', false);
      abortAllHostUploads('session-reset');
      hostBatchCommits.clear();
      announcedHostBatches.clear();
    }
  });
  bus.on('state:network.sessionCode', () => {
    if (outgoingUpload || hostUploads.size > 0 || hostBatchCommits.size > 0) {
      cancelOutgoing('session-reset', false);
      abortAllHostUploads('session-reset');
      hostBatchCommits.clear();
      announcedHostBatches.clear();
    }
  });
  bus.on('state:room.context', () => {
    if (getRoomContext().kind !== 'standard') {
      cancelOutgoing('session-reset', false);
      abortAllHostUploads('session-reset');
      hostBatchCommits.clear();
      announcedHostBatches.clear();
    }
  });
}
