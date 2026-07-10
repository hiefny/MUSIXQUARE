#!/usr/bin/env node

import { randomInt, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const APP_ORIGIN = 'https://musixquare.com';
const SIGNALING_ORIGIN = 'wss://signal.musixquare.com/api/rooms';
const MESSAGE_TIMEOUT_MS = 10_000;

function socketUrl(roomId, role, peerId, secret = '') {
  const url = new URL(`${SIGNALING_ORIGIN}/${roomId}/ws`);
  url.searchParams.set('role', role);
  url.searchParams.set('peerId', peerId);
  if (secret) url.searchParams.set('secret', secret);
  return url.toString();
}

function createSocketInbox(url, label) {
  const socket = new WebSocket(url, { origin: APP_ORIGIN });
  const queued = [];
  const waiters = new Set();
  let terminalError = null;

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

  return { socket, opened, waitFor };
}

function waitForType(inbox, type) {
  return inbox.waitFor((message) => message?.type === type, type);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function runRoom(password) {
  if (password && !/^\d{8}$/.test(password)) {
    throw new Error('protected-room smoke password must be exactly eight digits');
  }
  const roomId = String(randomInt(100_000, 1_000_000));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const hostPeerId = `host-${suffix}`;
  const guestPeerId = `guest-${suffix}`;
  const hostSecret = `secret-${randomUUID()}`;
  const host = createSocketInbox(
    socketUrl(roomId, 'host', hostPeerId, hostSecret),
    `${password ? 'protected' : 'passwordless'} host`,
  );
  let guest;
  let invalidPasswordGuest;

  try {
    await host.opened;
    const hostOpen = await waitForType(host, 'peer-open');
    if (hostOpen.roomId !== roomId) throw new Error('host room mismatch');
    host.socket.send(JSON.stringify({ type: 'room-password-set', password }));
    // room-password-set has no acknowledgement; let that frame settle before
    // opening the independent guest socket.
    await delay(150);

    if (password) {
      invalidPasswordGuest = createSocketInbox(
        socketUrl(roomId, 'guest', `invalid-${suffix}`),
        'invalid-password guest',
      );
      await invalidPasswordGuest.opened;
      invalidPasswordGuest.socket.send(
        JSON.stringify({ type: 'guest-auth', password: '00000000' }),
      );
      const rejection = await invalidPasswordGuest.waitFor(
        (message) => message?.type === 'error' || message?.type === 'peer-open',
        'wrong-password rejection',
      );
      if (rejection.type !== 'error' || rejection.errorType !== 'room-password-invalid') {
        throw new Error('protected room admitted a guest with the wrong password');
      }
      await closeSocket(invalidPasswordGuest.socket);
      invalidPasswordGuest = undefined;
    }

    guest = createSocketInbox(
      socketUrl(roomId, 'guest', guestPeerId),
      `${password ? 'protected' : 'passwordless'} guest`,
    );
    await guest.opened;
    // This is the first frame emitted by the production client for both room
    // modes. In a passwordless room it must remain a harmless no-op.
    guest.socket.send(JSON.stringify({ type: 'guest-auth', password }));
    const guestOpen = await waitForType(guest, 'peer-open');
    if (guestOpen.roomId !== roomId || guestOpen.peerId !== guestPeerId) {
      throw new Error('guest room or peer mismatch');
    }

    const offer = {
      type: 'signal-offer',
      to: 'host',
      sdp: { type: 'offer', sdp: 'v=0\r\ns=musixquare-live-smoke-offer\r\n' },
      metadata: { liveSmoke: true },
      futureField: 'forward-compatible',
    };
    guest.socket.send(JSON.stringify(offer));
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
    const relayedAnswer = await guest.waitFor(
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
      offer: true,
      answer: true,
    };
  } finally {
    if (invalidPasswordGuest) await closeSocket(invalidPasswordGuest.socket);
    if (guest) await closeSocket(guest.socket);
    await closeSocket(host.socket);
  }
}

const rooms = [];
rooms.push(await runRoom(''));
rooms.push(await runRoom('24681357'));
console.log(JSON.stringify({ ok: true, rooms }));
