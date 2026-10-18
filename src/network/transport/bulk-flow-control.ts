import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import type { TransportBulkFlowControl } from './types.ts';

const FRAME_TYPE = 'mxqr-bulk-flow';
const VERSION = 1;
const WINDOW_BYTES = 128 * 1024;
const RECEIPT_BYTES = 64 * 1024;
const RECEIPT_DELAY_MS = 20;
const LEGACY_GRACE_MS = 1000;
const NONCE_RE = /^[a-f0-9]{32}$/u;

type ControlFrame =
  | { type: typeof FRAME_TYPE; version: 1; kind: 'hello'; nonce: string }
  | {
      type: typeof FRAME_TYPE;
      version: 1;
      kind: 'receipt';
      nonce: string;
      receivedBytes: number;
    };

/** Payload accounting excludes the small existing binary frame header. */
export function creditedFileChunkBytes(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = payload as Record<string, unknown>;
  if (value.type !== MSG.FILE_CHUNK && value.type !== MSG.PRELOAD_CHUNK) return 0;
  const chunk = value.chunk;
  const bytes = chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
  return bytes > 0 && bytes <= CHUNK_SIZE ? bytes : 0;
}

function createNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Network receipt credit for one exact ordered bulk/control channel pair.
 * Counters cover the entire connection, including legacy grace and cancelled
 * file attempts. A receipt proves transport delivery, never storage readiness.
 * No file/session state, payload queue or per-chunk timer is retained here.
 */
export class BulkFlowControl implements TransportBulkFlowControl {
  private readonly nonce = createNonce();
  private remoteNonce: string | null = null;
  private started = false;
  private disposed = false;
  private legacy = false;
  private sentBytes = 0;
  private acknowledgedBytes = 0;
  private receivedBytes = 0;
  private reportedBytes = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly sendControl: (frame: ControlFrame) => void,
    private readonly onControlFailure?: () => void,
  ) {}

  /** Called after admission settles, before application transfer events. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.remoteNonce === null) {
      // eslint-disable-next-line no-restricted-globals -- owned by this exact transport; room timer cleanup must not strand a live capacity waiter
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.disposed || this.remoteNonce !== null) return;
        this.legacy = true;
        this.notify();
      }, LEGACY_GRACE_MS);
    }
    this.send({ type: FRAME_TYPE, version: VERSION, kind: 'hello', nonce: this.nonce });
    if (this.remoteNonce !== null) this.flushReceipt(true);
  }

  hasCapacity(nextPayloadBytes: number): boolean {
    if (
      this.disposed ||
      !this.started ||
      !Number.isSafeInteger(nextPayloadBytes) ||
      nextPayloadBytes < 0 ||
      nextPayloadBytes > CHUNK_SIZE
    ) {
      return false;
    }
    return (
      this.legacy || this.sentBytes - this.acknowledgedBytes + nextPayloadBytes <= WINDOW_BYTES
    );
  }

  subscribe(listener: () => void): () => void {
    if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record only after RTCDataChannel.send accepted the bytes successfully. */
  noteSent(bytes: number): void {
    if (!this.disposed && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= CHUNK_SIZE) {
      this.sentBytes += bytes;
    }
  }

  /** Called after binary decoding, even when the app will discard stale bytes. */
  noteReceived(bytes: number): void {
    if (this.disposed || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > CHUNK_SIZE) return;
    this.receivedBytes += bytes;
    if (!this.started || this.remoteNonce === null) return;
    if (this.receivedBytes - this.reportedBytes >= RECEIPT_BYTES) this.flushReceipt();
    else if (this.receiptTimer === null) {
      // eslint-disable-next-line no-restricted-globals -- one bounded receipt flush per exact transport, disposed with its channels
      this.receiptTimer = setTimeout(() => {
        this.receiptTimer = null;
        this.flushReceipt();
      }, RECEIPT_DELAY_MS);
    }
  }

  /** Consume reserved frames on either lane, but trust only the control lane. */
  handleControl(payload: unknown, fromControlChannel: boolean): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const frame = payload as Record<string, unknown>;
    if (frame.type !== FRAME_TYPE) return false;
    if (this.disposed || !fromControlChannel) return true;
    if (
      frame.version !== VERSION ||
      typeof frame.nonce !== 'string' ||
      !NONCE_RE.test(frame.nonce)
    ) {
      return true;
    }
    if (frame.kind === 'hello') {
      if (Object.keys(frame).length !== 4 || this.remoteNonce !== null) return true;
      this.remoteNonce = frame.nonce;
      this.legacy = false;
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      // Remote admission may finish first. Local start() sends the pending reply.
      if (this.started) this.flushReceipt(true);
      this.notify();
      return true;
    }
    if (
      frame.kind !== 'receipt' ||
      Object.keys(frame).length !== 5 ||
      this.remoteNonce === null ||
      frame.nonce !== this.nonce ||
      !Number.isSafeInteger(frame.receivedBytes) ||
      (frame.receivedBytes as number) <= this.acknowledgedBytes ||
      (frame.receivedBytes as number) > this.sentBytes
    ) {
      return true;
    }
    this.acknowledgedBytes = frame.receivedBytes as number;
    this.notify();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    if (this.receiptTimer !== null) clearTimeout(this.receiptTimer);
    this.graceTimer = null;
    this.receiptTimer = null;
    this.notify();
    this.listeners.clear();
  }

  private flushReceipt(force = false): void {
    if (this.receiptTimer !== null) clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
    if (
      this.disposed ||
      !this.started ||
      this.remoteNonce === null ||
      (!force && this.receivedBytes === this.reportedBytes)
    ) {
      return;
    }
    if (
      this.send({
        type: FRAME_TYPE,
        version: VERSION,
        kind: 'receipt',
        nonce: this.remoteNonce,
        receivedBytes: this.receivedBytes,
      })
    ) {
      this.reportedBytes = this.receivedBytes;
    }
  }

  private send(frame: ControlFrame): boolean {
    try {
      this.sendControl(frame);
      return true;
    } catch {
      // Once a hello/receipt is lost locally there may be no more bytes to
      // trigger another receipt. Retire this connection rather than strand
      // every future file attempt behind its lifetime credit counter.
      this.dispose();
      this.onControlFailure?.();
      return false;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
