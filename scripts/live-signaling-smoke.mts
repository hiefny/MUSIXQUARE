#!/usr/bin/env node

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const APP_ORIGIN = 'https://musixquare.com';
const SIGNALING_ORIGIN = 'wss://signal.musixquare.com/api/rooms';
const MESSAGE_TIMEOUT_MS = 10_000;
export const STALE_VERSION_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 8_000]);

type JsonObject = Record<string, unknown>;

interface SocketClose {
  code: number;
  reason: string;
}

interface SocketWaiter {
  predicate: (message: JsonObject) => boolean;
  resolve: (message: JsonObject) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SocketLifecyclePort {
  readyState: number;
  once(event: 'open', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  once(
    event: 'unexpected-response',
    listener: (request: IncomingMessage, response: IncomingMessage) => void,
  ): this;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  terminate(): void;
  close(code?: number, reason?: string): void;
}

export interface SocketInbox<TSocket extends SocketLifecyclePort = WebSocket> {
  socket: TSocket;
  opened: Promise<void>;
  closed: Promise<SocketClose>;
  waitFor(predicate: (message: JsonObject) => boolean, description: string): Promise<JsonObject>;
}

interface SocketInboxOptions<TSocket extends SocketLifecyclePort> {
  expectedInitialHostVersion?: string;
  createWebSocket: (target: string, options: WebSocket.ClientOptions) => TSocket;
}

type ReadinessError =
  | StaleSignalingVersionError
  | InitialHostDeploymentConvergenceError
  | InitialHostSocketConvergenceError;

interface ReadinessRetryOptions {
  retryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
  onRetry?: (event: { error: ReadinessError; attempt: number; delayMs: number }) => void;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class StaleSignalingVersionError extends Error {
  readonly expectedVersion: string;
  readonly actualVersion: string | null;

  constructor(expectedVersion: string, actualVersion: string) {
    super(
      `signaling host served ${actualVersion || 'an unversioned deployment'}; expected ${expectedVersion}`,
    );
    this.name = 'StaleSignalingVersionError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion || null;
  }
}

export class InitialHostDeploymentConvergenceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(
      `initial host WebSocket upgrade returned HTTP ${statusCode} before the expected signaling deployment became ready`,
    );
    this.name = 'InitialHostDeploymentConvergenceError';
    this.statusCode = statusCode;
  }
}

export class InitialHostSocketConvergenceError extends Error {
  readonly closeCode: number;

  constructor(closeCode: number) {
    super(
      `initial host WebSocket closed ${closeCode} before the expected signaling deployment became ready`,
    );
    this.name = 'InitialHostSocketConvergenceError';
    this.closeCode = closeCode;
  }
}

export function initialHostHandshakeError(
  statusCode: unknown,
  expectedVersion: string,
  label: string,
): Error {
  const normalizedStatus = Number.isInteger(statusCode) ? statusCode : 0;
  if (expectedVersion && normalizedStatus === 500) {
    return new InitialHostDeploymentConvergenceError(normalizedStatus);
  }
  return new Error(`${label} WebSocket upgrade returned HTTP ${normalizedStatus || '<missing>'}`);
}

export function initialHostSocketCloseError(
  closeCode: number,
  closeReason: string,
  expectedVersion: string,
  receivedFrame: boolean,
  label: string,
): Error {
  if (expectedVersion && !receivedFrame && closeCode === 1006) {
    return new InitialHostSocketConvergenceError(closeCode);
  }
  return new Error(`${label} closed ${closeCode}: ${closeReason}`);
}

export function initialHostSocketError(
  error: Error,
  expectedVersion: string,
  receivedFrame: boolean,
): Error | null {
  // `ws` may emit `error` immediately before the informative 1006 `close`.
  // Defer only during the exact-version initial-host handshake so the close
  // classifier can distinguish propagation from a real protocol failure.
  return expectedVersion && !receivedFrame ? null : error;
}

export function settleUnexpectedInitialHostResponse(
  socket: { terminate(): void },
  response: { statusCode?: number | undefined; resume(): void },
  expectedVersion: string,
  label: string,
): Error {
  const error = initialHostHandshakeError(response.statusCode, expectedVersion, label);
  // Registering an `unexpected-response` listener suppresses ws's default
  // abortHandshake path. Discard the response and explicitly close the still-
  // CONNECTING client so a readiness retry never leaks a socket.
  response.resume();
  socket.terminate();
  return error;
}

export function assertPeerOpenVersion(
  message: unknown,
  expectedVersion: string,
  label: string,
  retryIfStale = false,
): void {
  if (!expectedVersion) return;
  const actualVersion =
    isJsonObject(message) && typeof message.workerVersionId === 'string'
      ? message.workerVersionId.trim()
      : '';
  if (actualVersion === expectedVersion) return;
  if (retryIfStale) throw new StaleSignalingVersionError(expectedVersion, actualVersion);
  throw new Error(
    `${label} signaling version mismatch: expected ${expectedVersion}, received ${actualVersion || '<missing>'}`,
  );
}

function socketUrl(roomId: string, role: 'host' | 'guest', peerId: string): string {
  const url = new URL(`${SIGNALING_ORIGIN}/${roomId}/ws`);
  url.searchParams.set('role', role);
  url.searchParams.set('peerId', peerId);
  return url.toString();
}

export function createSocketInbox(
  url: string,
  label: string,
  options?: { expectedInitialHostVersion?: string },
): SocketInbox<WebSocket>;
export function createSocketInbox<TSocket extends SocketLifecyclePort>(
  url: string,
  label: string,
  options: SocketInboxOptions<TSocket>,
): SocketInbox<TSocket>;
export function createSocketInbox(
  url: string,
  label: string,
  options: {
    expectedInitialHostVersion?: string;
    createWebSocket?: (
      target: string,
      clientOptions: WebSocket.ClientOptions,
    ) => SocketLifecyclePort;
  } = {},
): SocketInbox<SocketLifecyclePort> {
  const expectedInitialHostVersion = options.expectedInitialHostVersion ?? '';
  const socket: SocketLifecyclePort = options.createWebSocket
    ? options.createWebSocket(url, { origin: APP_ORIGIN })
    : new WebSocket(url, { origin: APP_ORIGIN });
  const queued: JsonObject[] = [];
  const waiters = new Set<SocketWaiter>();
  let terminalError: Error | null = null;
  let receivedFrame = false;

  const closed = new Promise<SocketClose>((resolveClose) => {
    socket.once('close', (code, reason) => {
      resolveClose({ code, reason: reason.toString() });
    });
  });

  const opened = new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} open timeout`)), MESSAGE_TIMEOUT_MS);
    if (expectedInitialHostVersion) {
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        reject(
          settleUnexpectedInitialHostResponse(socket, response, expectedInitialHostVersion, label),
        );
      });
    }
    socket.once('open', () => {
      clearTimeout(timer);
      resolveOpen();
    });
    socket.once('error', (error) => {
      const terminalError = initialHostSocketError(
        error,
        expectedInitialHostVersion,
        receivedFrame,
      );
      if (!terminalError) return;
      clearTimeout(timer);
      reject(terminalError);
    });
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      reject(
        initialHostSocketCloseError(
          code,
          reason.toString(),
          expectedInitialHostVersion,
          receivedFrame,
          label,
        ),
      );
    });
  });

  function rejectWaiters(error: Error): void {
    terminalError = error;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  }

  socket.on('message', (data) => {
    receivedFrame = true;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isJsonObject(message)) return;
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queued.push(message);
  });
  socket.on('error', (error) => {
    const terminalError = initialHostSocketError(error, expectedInitialHostVersion, receivedFrame);
    if (terminalError) rejectWaiters(terminalError);
  });
  socket.on('close', (code, reason) => {
    if (code === 1000) return;
    rejectWaiters(
      initialHostSocketCloseError(
        code,
        reason.toString(),
        expectedInitialHostVersion,
        receivedFrame,
        label,
      ),
    );
  });

  function waitFor(
    predicate: (message: JsonObject) => boolean,
    description: string,
  ): Promise<JsonObject> {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) {
      const queuedMessage = queued.splice(queuedIndex, 1)[0];
      if (queuedMessage) return Promise.resolve(queuedMessage);
    }
    if (terminalError) return Promise.reject(terminalError);
    return new Promise<JsonObject>((resolveMessage, reject) => {
      const waiter: SocketWaiter = {
        predicate,
        resolve: resolveMessage,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`${label} timed out waiting for ${description}`));
        }, MESSAGE_TIMEOUT_MS),
      };
      waiters.add(waiter);
    });
  }

  return { socket, opened, closed, waitFor };
}

function waitForType(inbox: SocketInbox, type: string): Promise<JsonObject> {
  return inbox.waitFor((message) => message.type === type, type);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function withSignalingReadinessRetry<Result>(
  operation: (attempt: number) => Promise<Result>,
  {
    retryDelaysMs = STALE_VERSION_RETRY_DELAYS_MS,
    wait = delay,
    onRetry = ({ error, attempt, delayMs }) => {
      console.warn(
        `[signaling smoke] ${error.message}; retrying with a fresh room in ${delayMs}ms ` +
          `(attempt ${attempt + 1}/${retryDelaysMs.length + 1})`,
      );
    },
  }: ReadinessRetryOptions = {},
): Promise<Result> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        !(error instanceof StaleSignalingVersionError) &&
        !(error instanceof InitialHostDeploymentConvergenceError) &&
        !(error instanceof InitialHostSocketConvergenceError)
      ) {
        throw error;
      }
      const delayMs = retryDelaysMs[attempt - 1];
      if (delayMs === undefined) throw error;
      onRetry?.({ error, attempt, delayMs });
      await wait(delayMs);
    }
  }
}

function withTimeout<Result>(promise: PromiseLike<Result>, description: string): Promise<Result> {
  return new Promise<Result>((resolveResult, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      MESSAGE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveResult(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function expectGuestRejection(
  inbox: SocketInbox,
  expectedErrorType: string,
  expectedCloseReason: string,
  expectedCloseCode = 1008,
): Promise<void> {
  const rejection = await inbox.waitFor(
    (message) => message?.type === 'error' || message?.type === 'peer-open',
    `${expectedErrorType} rejection`,
  );
  if (rejection.type !== 'error' || rejection.errorType !== expectedErrorType) {
    throw new Error(
      `guest admission returned ${rejection.type}/${rejection.errorType || 'unknown'}`,
    );
  }

  const closed = await withTimeout(inbox.closed, `${expectedErrorType} socket close`);
  if (closed.code !== expectedCloseCode || closed.reason !== expectedCloseReason) {
    throw new Error(
      `${expectedErrorType} closed ${closed.code}/${closed.reason || 'without reason'}`,
    );
  }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(resolveClose, 2_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolveClose();
    });
    socket.close(1000, 'smoke complete');
  });
}

interface RoomSmokeResult {
  roomId: string;
  passwordProtected: boolean;
  wrongPasswordRejected: true | null;
  missingReconnectSecretRejected: true;
  wrongReconnectSecretRejected: true;
  originalGuestSurvivedRejectedReplacements: true;
  disconnectedBindingProtected: true;
  legitimateReconnect: true;
  hostReconnect: true;
  offer: true;
  answer: true;
}

async function runRoomAttempt(password: string, expectedVersion: string): Promise<RoomSmokeResult> {
  if (password && !/^\d{8}$/.test(password)) {
    throw new Error('protected-room smoke password must be exactly eight digits');
  }
  const roomId = String(randomInt(100_000, 1_000_000));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const hostPeerId = `host-${suffix}`;
  const guestPeerId = `guest-${suffix}`;
  const hostSecret = `secret-${randomUUID()}`;
  const reconnectSecret = randomBytes(32).toString('base64url');
  const wrongReconnectSecret = randomBytes(32).toString('base64url');
  const negotiationId = `live-smoke-${suffix}`;
  const host = createSocketInbox(
    socketUrl(roomId, 'host', hostPeerId),
    `${password ? 'protected' : 'passwordless'} host`,
    { expectedInitialHostVersion: expectedVersion },
  );
  const guestSockets = new Set<SocketInbox>();
  const createGuest = (peerId: string, label: string): SocketInbox => {
    const inbox = createSocketInbox(socketUrl(roomId, 'guest', peerId), label);
    guestSockets.add(inbox);
    return inbox;
  };
  let originalGuest: SocketInbox | undefined;
  let reconnectedGuest: SocketInbox | undefined;
  let reconnectedHost: SocketInbox | undefined;

  try {
    await host.opened;
    // Exercise the current production contract: the host bearer credential is
    // the first WebSocket frame and never part of an edge-loggable URL.
    host.socket.send(JSON.stringify({ type: 'host-auth', secret: hostSecret }));
    const hostOpen = await waitForType(host, 'peer-open');
    assertPeerOpenVersion(hostOpen, expectedVersion, 'host peer-open', true);
    if (hostOpen.roomId !== roomId) throw new Error('host room mismatch');
    host.socket.send(JSON.stringify({ type: 'room-password-set', password }));
    // room-password-set has no acknowledgement; let that frame settle before
    // opening the independent guest socket.
    await delay(150);

    if (password) {
      const invalidPasswordGuest = createGuest(`invalid-${suffix}`, 'invalid-password guest');
      await invalidPasswordGuest.opened;
      invalidPasswordGuest.socket.send(
        JSON.stringify({
          type: 'guest-auth',
          password: '00000000',
          reconnectSecret: wrongReconnectSecret,
        }),
      );
      await expectGuestRejection(
        invalidPasswordGuest,
        'room-password-invalid',
        'ROOM_PASSWORD_INVALID',
        1011,
      );
    }

    originalGuest = createGuest(guestPeerId, `${password ? 'protected' : 'passwordless'} guest`);
    await originalGuest.opened;
    // The production client authenticates every guest with this first frame.
    // Passwordless rooms use an empty password while still binding the identity
    // to the reconnect secret.
    originalGuest.socket.send(JSON.stringify({ type: 'guest-auth', password, reconnectSecret }));
    const guestOpen = await waitForType(originalGuest, 'peer-open');
    assertPeerOpenVersion(guestOpen, expectedVersion, 'guest peer-open');
    if (guestOpen.roomId !== roomId || guestOpen.peerId !== guestPeerId) {
      throw new Error('guest room or peer mismatch');
    }

    const missingSecretGuest = createGuest(guestPeerId, 'missing-reconnect-secret guest');
    await missingSecretGuest.opened;
    missingSecretGuest.socket.send(JSON.stringify({ type: 'guest-auth', password }));
    await expectGuestRejection(missingSecretGuest, 'invalid-id', 'GUEST_AUTH_FIRST_FRAME_INVALID');

    const wrongSecretGuest = createGuest(guestPeerId, 'wrong-reconnect-secret guest');
    await wrongSecretGuest.opened;
    wrongSecretGuest.socket.send(
      JSON.stringify({
        type: 'guest-auth',
        password,
        reconnectSecret: wrongReconnectSecret,
      }),
    );
    await expectGuestRejection(
      wrongSecretGuest,
      'guest-reconnect-denied',
      'GUEST_RECONNECT_DENIED',
    );

    if (password) {
      const wrongPasswordReplacement = createGuest(guestPeerId, 'wrong-password replacement');
      await wrongPasswordReplacement.opened;
      wrongPasswordReplacement.socket.send(
        JSON.stringify({
          type: 'guest-auth',
          password: '00000000',
          reconnectSecret,
        }),
      );
      await expectGuestRejection(
        wrongPasswordReplacement,
        'room-password-invalid',
        'ROOM_PASSWORD_INVALID',
        1011,
      );
    }

    originalGuest.socket.send(
      JSON.stringify({
        type: 'signal-candidate',
        to: 'host',
        negotiationId,
        candidate: { candidate: `original-still-live-${suffix}` },
      }),
    );
    await host.waitFor(
      (message) =>
        message.type === 'signal-candidate' &&
        message.from === guestPeerId &&
        isJsonObject(message.candidate) &&
        message.candidate.candidate === `original-still-live-${suffix}`,
      'original guest after rejected replacements',
    );

    await closeSocket(originalGuest.socket);
    await host.waitFor(
      (message) => message.type === 'peer-left' && message.peerId === guestPeerId,
      'original guest departure',
    );

    const disconnectedWrongSecretGuest = createGuest(
      guestPeerId,
      'disconnected wrong-reconnect-secret guest',
    );
    await disconnectedWrongSecretGuest.opened;
    disconnectedWrongSecretGuest.socket.send(
      JSON.stringify({
        type: 'guest-auth',
        password,
        reconnectSecret: wrongReconnectSecret,
      }),
    );
    await expectGuestRejection(
      disconnectedWrongSecretGuest,
      'guest-reconnect-denied',
      'GUEST_RECONNECT_DENIED',
    );

    reconnectedGuest = createGuest(guestPeerId, 'legitimate reconnect guest');
    await reconnectedGuest.opened;
    reconnectedGuest.socket.send(JSON.stringify({ type: 'guest-auth', password, reconnectSecret }));
    const reconnectOpen = await waitForType(reconnectedGuest, 'peer-open');
    assertPeerOpenVersion(reconnectOpen, expectedVersion, 'reconnected guest peer-open');
    if (reconnectOpen.roomId !== roomId || reconnectOpen.peerId !== guestPeerId) {
      throw new Error('legitimate reconnect room or peer mismatch');
    }

    reconnectedHost = createSocketInbox(
      socketUrl(roomId, 'host', hostPeerId),
      `${password ? 'protected' : 'passwordless'} reconnect host`,
    );
    await reconnectedHost.opened;
    // Reconnect with the same RAM-only bearer proof and exercise the permanent
    // first-frame contract again. The query remains limited to routing IDs.
    reconnectedHost.socket.send(JSON.stringify({ type: 'host-auth', secret: hostSecret }));
    const reconnectedHostOpen = await waitForType(reconnectedHost, 'peer-open');
    assertPeerOpenVersion(reconnectedHostOpen, expectedVersion, 'reconnected host peer-open');
    if (reconnectedHostOpen.roomId !== roomId) throw new Error('reconnected host room mismatch');
    const replacedHostClose = await withTimeout(host.closed, 'replaced host socket close');
    if (replacedHostClose.code !== 1012 || replacedHostClose.reason !== 'HOST_REPLACED') {
      throw new Error(
        `replaced host closed ${replacedHostClose.code}/${replacedHostClose.reason || 'without reason'}`,
      );
    }

    const offer = {
      type: 'signal-offer',
      to: 'host',
      negotiationId,
      sdp: { type: 'offer', sdp: 'v=0\r\ns=musixquare-live-smoke-offer\r\n' },
      metadata: { liveSmoke: true },
      futureField: 'forward-compatible',
    };
    reconnectedGuest.socket.send(JSON.stringify(offer));
    const relayedOffer = await reconnectedHost.waitFor(
      (message) => message.type === 'signal-offer' && message.from === guestPeerId,
      'relayed guest offer',
    );
    if (
      !isJsonObject(relayedOffer.sdp) ||
      relayedOffer.sdp.type !== 'offer' ||
      relayedOffer.futureField !== offer.futureField
    ) {
      throw new Error('guest offer relay mismatch');
    }

    const answer = {
      type: 'signal-answer',
      to: guestPeerId,
      negotiationId,
      sdp: { type: 'answer', sdp: 'v=0\r\ns=musixquare-live-smoke-answer\r\n' },
      futureField: 'forward-compatible',
    };
    reconnectedHost.socket.send(JSON.stringify(answer));
    const relayedAnswer = await reconnectedGuest.waitFor(
      (message) => message.type === 'signal-answer' && message.from === hostPeerId,
      'relayed host answer',
    );
    if (
      !isJsonObject(relayedAnswer.sdp) ||
      relayedAnswer.sdp.type !== 'answer' ||
      relayedAnswer.futureField !== answer.futureField
    ) {
      throw new Error('host answer relay mismatch');
    }

    return {
      roomId,
      passwordProtected: Boolean(password),
      wrongPasswordRejected: password ? true : null,
      missingReconnectSecretRejected: true,
      wrongReconnectSecretRejected: true,
      originalGuestSurvivedRejectedReplacements: true,
      disconnectedBindingProtected: true,
      legitimateReconnect: true,
      hostReconnect: true,
      offer: true,
      answer: true,
    };
  } finally {
    for (const inbox of guestSockets) await closeSocket(inbox.socket);
    if (reconnectedHost) await closeSocket(reconnectedHost.socket);
    await closeSocket(host.socket);
  }
}

async function runRoom(password: string, expectedVersion: string): Promise<RoomSmokeResult> {
  return withSignalingReadinessRetry(() => runRoomAttempt(password, expectedVersion));
}

export async function main(): Promise<void> {
  const expectedVersion = process.env.MXQR_EXPECTED_SIGNALING_VERSION?.trim() || '';
  const rooms: RoomSmokeResult[] = [];
  rooms.push(await runRoom('', expectedVersion));
  rooms.push(await runRoom('24681357', expectedVersion));
  console.log(JSON.stringify({ ok: true, expectedVersion: expectedVersion || null, rooms }));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
