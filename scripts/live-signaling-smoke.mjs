#!/usr/bin/env node

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const APP_ORIGIN = 'https://musixquare.com';
const SIGNALING_ORIGIN = 'wss://signal.musixquare.com/api/rooms';
const MESSAGE_TIMEOUT_MS = 10_000;
export const STALE_VERSION_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 8_000]);

export class StaleSignalingVersionError extends Error {
  constructor(expectedVersion, actualVersion) {
    super(
      `signaling host served ${actualVersion || 'an unversioned deployment'}; expected ${expectedVersion}`,
    );
    this.name = 'StaleSignalingVersionError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion || null;
  }
}

export function assertPeerOpenVersion(message, expectedVersion, label, retryIfStale = false) {
  if (!expectedVersion) return;
  const actualVersion =
    typeof message?.workerVersionId === 'string' ? message.workerVersionId.trim() : '';
  if (actualVersion === expectedVersion) return;
  if (retryIfStale) throw new StaleSignalingVersionError(expectedVersion, actualVersion);
  throw new Error(
    `${label} signaling version mismatch: expected ${expectedVersion}, received ${actualVersion || '<missing>'}`,
  );
}

function socketUrl(roomId, role, peerId) {
  const url = new URL(`${SIGNALING_ORIGIN}/${roomId}/ws`);
  url.searchParams.set('role', role);
  url.searchParams.set('peerId', peerId);
  return url.toString();
}

function createSocketInbox(url, label) {
  const socket = new WebSocket(url, { origin: APP_ORIGIN });
  const queued = [];
  const waiters = new Set();
  let terminalError = null;

  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} open timeout`)), MESSAGE_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  function rejectWaiters(error) {
    terminalError = error;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  }

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queued.push(message);
  });
  socket.on('error', (error) => rejectWaiters(error));
  socket.on('close', (code, reason) => {
    if (code === 1000) return;
    rejectWaiters(new Error(`${label} closed ${code}: ${reason.toString()}`));
  });

  function waitFor(predicate, description) {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
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

function waitForType(inbox, type) {
  return inbox.waitFor((message) => message?.type === type, type);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withStaleVersionRetry(
  operation,
  {
    retryDelaysMs = STALE_VERSION_RETRY_DELAYS_MS,
    wait = delay,
    onRetry = ({ error, attempt, delayMs }) => {
      console.warn(
        `[signaling smoke] ${error.message}; retrying with a fresh room in ${delayMs}ms ` +
          `(attempt ${attempt + 1}/${retryDelaysMs.length + 1})`,
      );
    },
  } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof StaleSignalingVersionError)) throw error;
      const delayMs = retryDelaysMs[attempt - 1];
      if (delayMs === undefined) throw error;
      onRetry?.({ error, attempt, delayMs });
      await wait(delayMs);
    }
  }
}

function withTimeout(promise, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      MESSAGE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function expectGuestRejection(
  inbox,
  expectedErrorType,
  expectedCloseReason,
  expectedCloseCode = 1008,
) {
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

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, 'smoke complete');
  });
}

async function runRoomAttempt(password, expectedVersion) {
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
  const host = createSocketInbox(
    socketUrl(roomId, 'host', hostPeerId),
    `${password ? 'protected' : 'passwordless'} host`,
  );
  const guestSockets = new Set();
  const createGuest = (peerId, label) => {
    const inbox = createSocketInbox(socketUrl(roomId, 'guest', peerId), label);
    guestSockets.add(inbox);
    return inbox;
  };
  let originalGuest;
  let reconnectedGuest;

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
        JSON.stringify({ type: 'guest-auth', password: '00000000' }),
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
    await expectGuestRejection(
      missingSecretGuest,
      'guest-reconnect-denied',
      'GUEST_RECONNECT_DENIED',
    );

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
        candidate: { candidate: `original-still-live-${suffix}` },
      }),
    );
    await host.waitFor(
      (message) =>
        message?.type === 'signal-candidate' &&
        message?.from === guestPeerId &&
        message?.candidate?.candidate === `original-still-live-${suffix}`,
      'original guest after rejected replacements',
    );

    await closeSocket(originalGuest.socket);
    await host.waitFor(
      (message) => message?.type === 'peer-left' && message?.peerId === guestPeerId,
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

    const offer = {
      type: 'signal-offer',
      to: 'host',
      sdp: { type: 'offer', sdp: 'v=0\r\ns=musixquare-live-smoke-offer\r\n' },
      metadata: { liveSmoke: true },
      futureField: 'forward-compatible',
    };
    reconnectedGuest.socket.send(JSON.stringify(offer));
    const relayedOffer = await host.waitFor(
      (message) => message?.type === 'signal-offer' && message?.from === guestPeerId,
      'relayed guest offer',
    );
    if (relayedOffer.sdp?.type !== 'offer' || relayedOffer.futureField !== offer.futureField) {
      throw new Error('guest offer relay mismatch');
    }

    const answer = {
      type: 'signal-answer',
      to: guestPeerId,
      sdp: { type: 'answer', sdp: 'v=0\r\ns=musixquare-live-smoke-answer\r\n' },
      futureField: 'forward-compatible',
    };
    host.socket.send(JSON.stringify(answer));
    const relayedAnswer = await reconnectedGuest.waitFor(
      (message) => message?.type === 'signal-answer' && message?.from === hostPeerId,
      'relayed host answer',
    );
    if (relayedAnswer.sdp?.type !== 'answer' || relayedAnswer.futureField !== answer.futureField) {
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
      offer: true,
      answer: true,
    };
  } finally {
    for (const inbox of guestSockets) await closeSocket(inbox.socket);
    await closeSocket(host.socket);
  }
}

async function runRoom(password, expectedVersion) {
  return withStaleVersionRetry(() => runRoomAttempt(password, expectedVersion));
}

export async function main() {
  const expectedVersion = process.env.MXQR_EXPECTED_SIGNALING_VERSION?.trim() || '';
  const rooms = [];
  rooms.push(await runRoom('', expectedVersion));
  rooms.push(await runRoom('24681357', expectedVersion));
  console.log(JSON.stringify({ ok: true, expectedVersion: expectedVersion || null, rooms }));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
