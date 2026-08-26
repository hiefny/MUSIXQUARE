import { fetchWithCapability } from '../../core/capability.ts';
import {
  cancelResponseBody,
  readBoundedJsonResponse,
  withRequestDeadline,
} from '../../core/request-lifetime.ts';

const HTTP_CONNECTING = 0;
const HTTP_OPEN = 1;
const HTTP_CLOSING = 2;
const HTTP_CLOSED = 3;
const OPEN_DEADLINE_MS = 8_000;
const SEND_DEADLINE_MS = 8_000;
const CLOSE_DEADLINE_MS = 5_000;
const POLL_WAIT_MS = 15_000;
const POLL_DEADLINE_MS = 20_000;
const POLL_RETRY_DELAY_MS = 250;
const QUICK_EMPTY_POLL_FLOOR_MS = 500;
const CONTROL_RESPONSE_MAX_BYTES = 96 * 1024;
const SIGNALING_FRAME_MAX_BYTES = 64 * 1024;
// A mobile interface hand-off can release a burst of trickled ICE candidates
// while one HTTPS uplink is still in flight. The byte budget remains the hard
// memory bound; this count prevents ordinary multi-interface ICE from being
// mistaken for queue abuse.
const PENDING_FRAME_MAX_COUNT = 64;
const PENDING_FRAME_MAX_BYTES = 96 * 1024;
const SEND_BODY_MAX_BYTES = 96 * 1024;
const POLL_EVENT_LIMIT = 128;
const SESSION_TOKEN_RE = /^[A-Za-z0-9._~-]{32,4096}$/;
const REFRESH_POLL_ROUTE = new Error('HTTP_SIGNALING_REFRESH_POLL_ROUTE');
const textEncoder = new TextEncoder();

type HttpSignalingPhase = 'open' | 'send' | 'poll' | 'close';

interface QueuedFrame {
  readonly data: string;
  readonly bytes: number;
}

interface BridgeEvent {
  readonly sseq: number;
  readonly data: string;
}

interface BridgeTerminal {
  readonly code: number;
  readonly reason: string;
}

interface BridgePollResponse {
  readonly events: BridgeEvent[];
  readonly terminal?: BridgeTerminal;
}

interface StandardHttpSignalingDiagnostic {
  readonly phase: HttpSignalingPhase;
  readonly status: number | null;
}

interface StandardHttpSignalingSocketOptions {
  readonly roomId: string;
  readonly role: 'host' | 'guest';
  readonly peerId: string;
  readonly endpointPrefix?: string;
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseOpenResponse(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ['sessionToken']) &&
    typeof record.sessionToken === 'string' &&
    SESSION_TOKEN_RE.test(record.sessionToken)
    ? record.sessionToken
    : null;
}

function parseSendResponse(value: unknown, cseq: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ['v', 'ack']) && record.v === 1 && record.ack === cseq;
}

function parseBridgeEvent(value: unknown): BridgeEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ['sseq', 'data']) ||
    !Number.isSafeInteger(record.sseq) ||
    (record.sseq as number) < 1 ||
    typeof record.data !== 'string' ||
    utf8ByteLength(record.data) > SIGNALING_FRAME_MAX_BYTES
  ) {
    return null;
  }
  return { sseq: record.sseq as number, data: record.data };
}

function parseBridgeTerminal(value: unknown): BridgeTerminal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ['code', 'reason']) ||
    !Number.isSafeInteger(record.code) ||
    (record.code as number) < 1000 ||
    (record.code as number) > 4999 ||
    typeof record.reason !== 'string' ||
    utf8ByteLength(record.reason) > 123
  ) {
    return null;
  }
  return { code: record.code as number, reason: record.reason };
}

function parsePollResponse(value: unknown): BridgePollResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ['v', 'events'], ['terminal']) ||
    record.v !== 1 ||
    !Array.isArray(record.events) ||
    record.events.length > POLL_EVENT_LIMIT
  ) {
    return null;
  }
  const events: BridgeEvent[] = [];
  for (const event of record.events) {
    const parsed = parseBridgeEvent(event);
    if (!parsed) return null;
    events.push(parsed);
  }
  const terminal = record.terminal === undefined ? undefined : parseBridgeTerminal(record.terminal);
  if (record.terminal !== undefined && !terminal) return null;
  return { events, ...(terminal ? { terminal } : {}) };
}

function createCloseEvent(code: number, reason: string, wasClean: boolean): Event {
  if (typeof CloseEvent === 'function') {
    return new CloseEvent('close', { code, reason, wasClean });
  }
  return Object.assign(new Event('close'), { code, reason, wasClean });
}

function createMessageEvent(data: string): Event {
  if (typeof MessageEvent === 'function') return new MessageEvent('message', { data });
  return Object.assign(new Event('message'), { data });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Standard-room-only HTTPS bridge implementing the WebSocket subset consumed
 * by CloudflareSignalingPeer.
 *
 * Uplink sequencing and downlink polling deliberately use separate lanes. A
 * route refresh may abort an ambiguous long poll, while an accepted signaling
 * frame is retried only with its exact cseq and body. The RAM-only bearer is
 * sent in an Authorization header and never placed in a URL or storage.
 */
export class StandardHttpSignalingSocket extends EventTarget {
  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly binaryType = 'blob';
  readyState = HTTP_CONNECTING;
  diagnostic: StandardHttpSignalingDiagnostic | null = null;

  readonly #options: StandardHttpSignalingSocketOptions;
  readonly #endpoint: string;
  private readonly lifetimeController = new AbortController();
  private pollController: AbortController | null = null;
  #sessionToken: string | null = null;
  private lastClientAck = 0;
  private lastServerSequence = 0;
  private pollRequestEpoch = 0;
  readonly #pendingFrames: QueuedFrame[] = [];
  #pendingFrameBytes = 0;
  private sendLoopRunning = false;
  private pollLoopStarted = false;
  private closeDispatched = false;

  constructor(options: StandardHttpSignalingSocketOptions) {
    super();
    if (!/^[1-9]\d{5}$/.test(options.roomId)) throw new Error('INVALID_HTTP_SIGNALING_ROOM');
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(options.peerId)) {
      throw new Error('INVALID_HTTP_SIGNALING_PEER');
    }
    const prefix = options.endpointPrefix ?? '/api/standard-signaling/v1/bridge';
    if (!/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(prefix)) {
      throw new Error('INVALID_HTTP_SIGNALING_ENDPOINT');
    }
    this.#options = options;
    this.#endpoint = prefix.replace(/\/+$/, '');
    this.url = `${this.#endpoint}/open`;
    globalThis.addEventListener?.('online', this.refreshPollRoute);
    globalThis.document?.addEventListener?.('visibilitychange', this.refreshVisiblePollRoute);
    queueMicrotask(() => void this.openBridge());
  }

  get bufferedAmount(): number {
    return this.#pendingFrameBytes;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== HTTP_OPEN || !this.#sessionToken) {
      throw new DOMException('HTTP signaling channel is not open', 'InvalidStateError');
    }
    if (typeof data !== 'string') {
      throw new TypeError('HTTP signaling accepts text frames only');
    }
    const bytes = utf8ByteLength(data);
    const maximumEnvelope = JSON.stringify({
      v: 1,
      cseq: Number.MAX_SAFE_INTEGER,
      frame: data,
    });
    if (
      bytes > SIGNALING_FRAME_MAX_BYTES ||
      utf8ByteLength(maximumEnvelope) > SEND_BODY_MAX_BYTES
    ) {
      throw new DOMException('HTTP signaling frame is too large', 'DataError');
    }
    if (
      this.#pendingFrames.length >= PENDING_FRAME_MAX_COUNT ||
      this.#pendingFrameBytes + bytes > PENDING_FRAME_MAX_BYTES
    ) {
      throw new DOMException('HTTP signaling queue is full', 'QuotaExceededError');
    }
    this.#pendingFrames.push({ data, bytes });
    this.#pendingFrameBytes += bytes;
    this.startSendLoop();
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === HTTP_CLOSED || this.readyState === HTTP_CLOSING) return;
    this.readyState = HTTP_CLOSING;
    const token = this.#sessionToken;
    this.#sessionToken = null;
    this.detachRouteRefreshListeners();
    this.lifetimeController.abort(new Error('HTTP_SIGNALING_CLOSED'));
    this.pollController?.abort(new Error('HTTP_SIGNALING_CLOSED'));
    if (token) this.notifyClose(token);
    this.finishClose(code, reason, true);
  }

  private readonly refreshPollRoute = (): void => {
    if (this.readyState === HTTP_OPEN) this.pollController?.abort(REFRESH_POLL_ROUTE);
  };

  private readonly refreshVisiblePollRoute = (): void => {
    if (globalThis.document?.visibilityState === 'visible') this.refreshPollRoute();
  };

  private detachRouteRefreshListeners(): void {
    globalThis.removeEventListener?.('online', this.refreshPollRoute);
    globalThis.document?.removeEventListener?.('visibilitychange', this.refreshVisiblePollRoute);
  }

  private async openBridge(): Promise<void> {
    if (this.readyState !== HTTP_CONNECTING) return;
    const body = JSON.stringify({
      roomId: this.#options.roomId,
      role: this.#options.role,
      peerId: this.#options.peerId,
    });
    let responseStatus: number | null = null;
    let value: unknown;
    try {
      value = await withRequestDeadline(
        async (signal) => {
          const response = await fetchWithCapability(this.url, 'standard-signaling', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body,
            signal,
          });
          responseStatus = response.status;
          this.diagnostic = { phase: 'open', status: response.status };
          if (!response.ok) {
            await cancelResponseBody(response);
            throw new Error(`HTTP_SIGNALING_OPEN_${response.status}`);
          }
          return readBoundedJsonResponse(response, CONTROL_RESPONSE_MAX_BYTES, signal);
        },
        {
          signal: this.lifetimeController.signal,
          timeoutMs: OPEN_DEADLINE_MS,
          timeoutReason: 'HTTP_SIGNALING_OPEN_TIMEOUT',
        },
      );
    } catch (error) {
      if (!this.lifetimeController.signal.aborted) this.fail('open', responseStatus, error);
      return;
    }
    if (this.readyState !== HTTP_CONNECTING) return;
    const token = parseOpenResponse(value);
    if (!token) {
      this.fail('open', responseStatus, new Error('INVALID_HTTP_SIGNALING_OPEN_RESPONSE'));
      return;
    }

    this.#sessionToken = token;
    this.readyState = HTTP_OPEN;
    this.dispatchEvent(new Event('open'));
    if (this.readyState !== HTTP_OPEN || this.#sessionToken === null) return;
    this.startSendLoop();
    if (!this.pollLoopStarted) {
      this.pollLoopStarted = true;
      this.runPollLoop().catch((error) => {
        if (!this.lifetimeController.signal.aborted && this.readyState === HTTP_OPEN) {
          this.fail('poll', this.diagnostic?.status ?? null, error);
        }
      });
    }
  }

  private startSendLoop(): void {
    if (
      this.sendLoopRunning ||
      this.readyState !== HTTP_OPEN ||
      !this.#sessionToken ||
      this.#pendingFrames.length === 0
    ) {
      return;
    }
    this.sendLoopRunning = true;
    this.runSendLoop().catch((error) => {
      if (!this.lifetimeController.signal.aborted && this.readyState === HTTP_OPEN) {
        this.fail('send', this.diagnostic?.status ?? null, error);
      }
    });
  }

  private async runSendLoop(): Promise<void> {
    try {
      while (
        this.readyState === HTTP_OPEN &&
        this.#sessionToken &&
        this.#pendingFrames.length > 0
      ) {
        const queued = this.#pendingFrames[0];
        if (!queued) return;
        const cseq = this.lastClientAck + 1;
        if (!Number.isSafeInteger(cseq))
          throw new Error('HTTP_SIGNALING_CLIENT_SEQUENCE_EXHAUSTED');
        const body = JSON.stringify({ v: 1, cseq, frame: queued.data });
        if (utf8ByteLength(body) > SEND_BODY_MAX_BYTES) {
          throw new Error('HTTP_SIGNALING_SEND_BODY_TOO_LARGE');
        }
        await this.sendFrame(cseq, body);
        if (this.readyState !== HTTP_OPEN || !this.#sessionToken) return;
        if (this.#pendingFrames[0] !== queued) {
          throw new Error('HTTP_SIGNALING_SEND_QUEUE_AUTHORITY_LOST');
        }
        this.#pendingFrames.shift();
        this.#pendingFrameBytes = Math.max(0, this.#pendingFrameBytes - queued.bytes);
        this.lastClientAck = cseq;
      }
    } catch (error) {
      if (!this.lifetimeController.signal.aborted && this.readyState === HTTP_OPEN) {
        this.fail('send', this.diagnostic?.status ?? null, error);
      }
    } finally {
      this.sendLoopRunning = false;
      if (this.readyState === HTTP_OPEN && this.#sessionToken && this.#pendingFrames.length > 0) {
        this.startSendLoop();
      }
    }
  }

  private async sendFrame(cseq: number, body: string): Promise<void> {
    const token = this.#sessionToken;
    if (!token) throw new Error('HTTP_SIGNALING_SESSION_UNAVAILABLE');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let retryAllowed = true;
      let value: unknown;
      try {
        value = await withRequestDeadline(
          async (signal) => {
            const response = await fetch(`${this.#endpoint}/send`, {
              method: 'POST',
              credentials: 'omit',
              cache: 'no-store',
              redirect: 'error',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body,
              signal,
            });
            this.diagnostic = { phase: 'send', status: response.status };
            if (!response.ok) {
              retryAllowed = response.status >= 500;
              await cancelResponseBody(response);
              throw new Error(`HTTP_SIGNALING_SEND_${response.status}`);
            }
            return readBoundedJsonResponse(response, CONTROL_RESPONSE_MAX_BYTES, signal);
          },
          {
            signal: this.lifetimeController.signal,
            timeoutMs: SEND_DEADLINE_MS,
            timeoutReason: 'HTTP_SIGNALING_SEND_TIMEOUT',
          },
        );
      } catch (error) {
        if (this.lifetimeController.signal.aborted || attempt === 1 || !retryAllowed) throw error;
        continue;
      }
      if (!parseSendResponse(value, cseq)) {
        throw new Error('INVALID_HTTP_SIGNALING_SEND_RESPONSE');
      }
      return;
    }
    throw new Error('HTTP_SIGNALING_SEND_FAILED');
  }

  private async runPollLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (this.readyState === HTTP_OPEN && this.#sessionToken) {
      const controller = new AbortController();
      this.pollController = controller;
      const onLifetimeAbort = () => controller.abort(this.lifetimeController.signal.reason);
      this.lifetimeController.signal.addEventListener('abort', onLifetimeAbort, { once: true });
      const startedAt = Date.now();
      try {
        const response = await this.pollOnce(controller.signal);
        if (this.readyState !== HTTP_OPEN || !this.#sessionToken) return;
        consecutiveFailures = 0;
        if (!(await this.applyPollResponse(response))) return;
        const elapsedMs = Date.now() - startedAt;
        if (
          response.events.length === 0 &&
          !response.terminal &&
          elapsedMs < QUICK_EMPTY_POLL_FLOOR_MS
        ) {
          await abortableDelay(
            QUICK_EMPTY_POLL_FLOOR_MS - elapsedMs,
            this.lifetimeController.signal,
          );
        }
      } catch (error) {
        if (controller.signal.reason === REFRESH_POLL_ROUTE && this.readyState === HTTP_OPEN) {
          consecutiveFailures = 0;
          continue;
        }
        if (this.lifetimeController.signal.aborted || this.readyState !== HTTP_OPEN) return;
        consecutiveFailures += 1;
        if (consecutiveFailures <= 1) {
          try {
            await abortableDelay(POLL_RETRY_DELAY_MS, this.lifetimeController.signal);
          } catch {
            return;
          }
          continue;
        }
        this.fail('poll', this.diagnostic?.status ?? null, error);
        return;
      } finally {
        this.lifetimeController.signal.removeEventListener('abort', onLifetimeAbort);
        if (this.pollController === controller) this.pollController = null;
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<BridgePollResponse> {
    const token = this.#sessionToken;
    if (!token) throw new Error('HTTP_SIGNALING_SESSION_UNAVAILABLE');
    const requestEpoch = ++this.pollRequestEpoch;
    if (!Number.isSafeInteger(requestEpoch)) {
      throw new Error('HTTP_SIGNALING_POLL_EPOCH_EXHAUSTED');
    }
    const body = JSON.stringify({
      v: 1,
      requestEpoch,
      ack: this.lastServerSequence,
      waitMs: POLL_WAIT_MS,
    });
    return withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${this.#endpoint}/poll`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: requestSignal,
        });
        this.diagnostic = { phase: 'poll', status: response.status };
        if (!response.ok) {
          await cancelResponseBody(response);
          throw new Error(`HTTP_SIGNALING_POLL_${response.status}`);
        }
        const value = await readBoundedJsonResponse(
          response,
          CONTROL_RESPONSE_MAX_BYTES,
          requestSignal,
        );
        const parsed = parsePollResponse(value);
        if (!parsed) throw new Error('INVALID_HTTP_SIGNALING_POLL_RESPONSE');
        return parsed;
      },
      {
        signal,
        timeoutMs: POLL_DEADLINE_MS,
        timeoutReason: 'HTTP_SIGNALING_POLL_TIMEOUT',
      },
    );
  }

  private async applyPollResponse(response: BridgePollResponse): Promise<boolean> {
    for (const event of response.events) {
      if (event.sseq <= this.lastServerSequence) continue;
      if (event.sseq !== this.lastServerSequence + 1) {
        this.fail('poll', 200, new Error('HTTP_SIGNALING_SERVER_SEQUENCE_GAP'));
        return false;
      }
      this.dispatchEvent(createMessageEvent(event.data));
      // Existing peer handlers intentionally parse frames asynchronously. Give
      // each frame its receive-order turn before applying a terminal marker.
      await Promise.resolve();
      if (this.readyState !== HTTP_OPEN) return false;
      this.lastServerSequence = event.sseq;
    }
    if (!response.terminal) return true;
    this.#sessionToken = null;
    this.detachRouteRefreshListeners();
    this.lifetimeController.abort(new Error('HTTP_SIGNALING_REMOTE_CLOSE'));
    this.finishClose(
      response.terminal.code,
      response.terminal.reason,
      response.terminal.code === 1000,
    );
    return false;
  }

  private notifyClose(token: string): void {
    this.diagnostic = { phase: 'close', status: null };
    try {
      withRequestDeadline(
        async (signal) => {
          const response = await fetch(`${this.#endpoint}/close`, {
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            keepalive: true,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
            signal,
          });
          this.diagnostic = { phase: 'close', status: response.status };
          if (!response.ok) {
            await cancelResponseBody(response);
            return;
          }
          const value = await readBoundedJsonResponse(response, CONTROL_RESPONSE_MAX_BYTES, signal);
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !hasExactKeys(value as Record<string, unknown>, ['ok']) ||
            (value as Record<string, unknown>).ok !== true
          ) {
            throw new Error('INVALID_HTTP_SIGNALING_CLOSE_RESPONSE');
          }
        },
        {
          timeoutMs: CLOSE_DEADLINE_MS,
          timeoutReason: 'HTTP_SIGNALING_CLOSE_TIMEOUT',
        },
      ).catch(() => undefined);
    } catch {
      // Close notification is best-effort; the bridge lease is authoritative.
    }
  }

  private fail(phase: HttpSignalingPhase, status: number | null, cause: unknown): void {
    if (this.readyState === HTTP_CLOSED || this.readyState === HTTP_CLOSING) return;
    this.diagnostic = { phase, status };
    const event = Object.assign(new Event('error'), { cause, phase, status });
    this.dispatchEvent(event);
    if (this.readyState === HTTP_CLOSED || this.readyState === HTTP_CLOSING) return;
    this.#sessionToken = null;
    this.detachRouteRefreshListeners();
    this.lifetimeController.abort(cause);
    this.pollController?.abort(cause);
    this.finishClose(1006, '', false);
  }

  private finishClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.readyState = HTTP_CLOSED;
    this.dispatchEvent(createCloseEvent(code, reason, wasClean));
  }
}

export function isStandardHttpSignalingSocket(
  value: unknown,
): value is StandardHttpSignalingSocket {
  return value instanceof StandardHttpSignalingSocket;
}
