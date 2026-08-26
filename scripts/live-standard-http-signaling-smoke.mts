#!/usr/bin/env node

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const APP_ORIGIN = 'https://musixquare.com';
const BRIDGE_PREFIX = `${APP_ORIGIN}/api/standard-signaling/v1/bridge`;
const REQUEST_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 12_000;
const MAX_JSON_BYTES = 128 * 1024;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('HTTP signaling smoke response too large');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`HTTP signaling smoke received invalid JSON (HTTP ${response.status})`);
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('HTTP_SIGNALING_SMOKE_TIMEOUT')),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    return { response, payload: await readJsonResponse(response) };
  } finally {
    clearTimeout(timeout);
  }
}

function hasLeadingZeroBits(bytes: Uint8Array, difficulty: number): boolean {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

export function solveCapabilityProof(challenge: string, difficulty: number): string {
  if (!challenge || !Number.isSafeInteger(difficulty) || difficulty < 8 || difficulty > 24) {
    throw new Error('HTTP signaling smoke received an invalid proof-of-work challenge');
  }
  for (let nonce = 0; nonce < 50_000_000; nonce += 1) {
    const digest = createHash('sha256').update(`mxqr-pow-v1:${challenge}:${nonce}`).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return String(nonce);
  }
  throw new Error('HTTP signaling smoke proof-of-work budget exhausted');
}

export async function mintStandardSignalingCapability(): Promise<string> {
  const commonHeaders = {
    Origin: APP_ORIGIN,
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
  };
  const security = await fetchJson(`${APP_ORIGIN}/api/security-config`, {
    method: 'GET',
    headers: { Origin: APP_ORIGIN, 'Cache-Control': 'no-cache' },
  });
  if (!security.response.ok || !isJsonObject(security.payload)) {
    throw new Error(`HTTP signaling security config failed (HTTP ${security.response.status})`);
  }
  if (security.payload.capabilityRequired !== true) {
    throw new Error('HTTP signaling smoke requires production capability protection');
  }
  if (
    security.payload.turnstileRequired === true ||
    security.payload.proofOfWorkRequired !== true
  ) {
    throw new Error('HTTP signaling smoke cannot silently satisfy the configured capability mode');
  }

  const challenge = await fetchJson(`${APP_ORIGIN}/api/capability-challenge`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ scopes: ['standard-signaling'] }),
  });
  if (!challenge.response.ok || !isJsonObject(challenge.payload)) {
    throw new Error(`HTTP signaling challenge failed (HTTP ${challenge.response.status})`);
  }
  const challengeValue = challenge.payload.challenge;
  const difficulty = challenge.payload.difficulty;
  if (typeof challengeValue !== 'string' || typeof difficulty !== 'number') {
    throw new Error('HTTP signaling challenge response was malformed');
  }
  const solution = solveCapabilityProof(challengeValue, difficulty);
  const minted = await fetchJson(`${APP_ORIGIN}/api/capability-token`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      scopes: ['standard-signaling'],
      proofOfWork: { challenge: challengeValue, solution },
    }),
  });
  if (!minted.response.ok || !isJsonObject(minted.payload)) {
    throw new Error(`HTTP signaling capability mint failed (HTTP ${minted.response.status})`);
  }
  const token = minted.payload.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('HTTP signaling capability mint returned an invalid token');
  }
  return token;
}

interface BridgeEvent {
  readonly sseq: number;
  readonly data: string;
}

export class StandardHttpBridgeSmokeClient {
  private clientSequence = 0;
  private serverAck = 0;
  private requestEpoch = 0;
  private readonly queued: JsonObject[] = [];
  private readonly sessionToken: string;

  private constructor(sessionToken: string) {
    this.sessionToken = sessionToken;
  }

  static async open(
    capabilityToken: string,
    input: { roomId: string; role: 'host' | 'guest'; peerId: string },
  ): Promise<StandardHttpBridgeSmokeClient> {
    const opened = await fetchJson(`${BRIDGE_PREFIX}/open`, {
      method: 'POST',
      headers: {
        Origin: APP_ORIGIN,
        'Content-Type': 'application/json',
        'X-MXQR-Capability': capabilityToken,
      },
      body: JSON.stringify(input),
    });
    const keys = isJsonObject(opened.payload) ? Object.keys(opened.payload) : [];
    const token = isJsonObject(opened.payload) ? opened.payload.sessionToken : null;
    if (
      !opened.response.ok ||
      keys.length !== 1 ||
      keys[0] !== 'sessionToken' ||
      typeof token !== 'string'
    ) {
      throw new Error(`HTTP signaling bridge open failed (HTTP ${opened.response.status})`);
    }
    return new StandardHttpBridgeSmokeClient(token);
  }

  private authorizationHeaders(): Record<string, string> {
    return {
      Origin: APP_ORIGIN,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.sessionToken}`,
    };
  }

  async send(frame: JsonObject): Promise<void> {
    this.clientSequence += 1;
    const sent = await fetchJson(`${BRIDGE_PREFIX}/send`, {
      method: 'POST',
      headers: this.authorizationHeaders(),
      body: JSON.stringify({ v: 1, cseq: this.clientSequence, frame: JSON.stringify(frame) }),
    });
    if (
      !sent.response.ok ||
      !isJsonObject(sent.payload) ||
      sent.payload.v !== 1 ||
      sent.payload.ack !== this.clientSequence
    ) {
      throw new Error(`HTTP signaling bridge send failed (HTTP ${sent.response.status})`);
    }
  }

  async poll(waitMs = 1_000): Promise<JsonObject[]> {
    this.requestEpoch += 1;
    const polled = await fetchJson(`${BRIDGE_PREFIX}/poll`, {
      method: 'POST',
      headers: this.authorizationHeaders(),
      body: JSON.stringify({
        v: 1,
        requestEpoch: this.requestEpoch,
        ack: this.serverAck,
        waitMs,
      }),
    });
    if (!polled.response.ok || !isJsonObject(polled.payload)) {
      throw new Error(`HTTP signaling bridge poll failed (HTTP ${polled.response.status})`);
    }
    if (polled.payload.v !== 1 || !Array.isArray(polled.payload.events)) {
      throw new Error('HTTP signaling bridge poll response was malformed');
    }
    if (polled.payload.terminal !== undefined) {
      throw new Error('HTTP signaling bridge closed before smoke completion');
    }
    const messages: JsonObject[] = [];
    for (const rawEvent of polled.payload.events) {
      if (
        !isJsonObject(rawEvent) ||
        typeof rawEvent.sseq !== 'number' ||
        !Number.isSafeInteger(rawEvent.sseq) ||
        rawEvent.sseq !== this.serverAck + 1 ||
        typeof rawEvent.data !== 'string'
      ) {
        throw new Error('HTTP signaling bridge event sequence was malformed');
      }
      const event: BridgeEvent = {
        sseq: rawEvent.sseq,
        data: rawEvent.data,
      };
      this.serverAck = event.sseq;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        throw new Error('HTTP signaling bridge event contained invalid signaling JSON');
      }
      if (!isJsonObject(message)) {
        throw new Error('HTTP signaling bridge event contained a non-object signaling frame');
      }
      messages.push(message);
    }
    return messages;
  }

  async waitFor(
    predicate: (message: JsonObject) => boolean,
    description: string,
  ): Promise<JsonObject> {
    const queuedIndex = this.queued.findIndex(predicate);
    if (queuedIndex >= 0) return this.queued.splice(queuedIndex, 1)[0] as JsonObject;
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const messages = await this.poll(Math.min(1_500, Math.max(0, deadline - Date.now())));
      const index = messages.findIndex(predicate);
      if (index >= 0) {
        const [matched] = messages.splice(index, 1);
        this.queued.push(...messages);
        if (matched) return matched;
      }
      this.queued.push(...messages);
    }
    throw new Error(`HTTP signaling bridge timed out waiting for ${description}`);
  }

  async close(): Promise<void> {
    try {
      await fetchJson(`${BRIDGE_PREFIX}/close`, {
        method: 'POST',
        headers: this.authorizationHeaders(),
      });
    } catch {
      // Cleanup is best-effort; the bridge lease is the bounded fallback.
    }
  }
}

export async function main(): Promise<void> {
  const expectedVersion = process.env.MXQR_EXPECTED_SIGNALING_VERSION?.trim() || '';
  const capability = await mintStandardSignalingCapability();
  const roomId = String(randomInt(100_000, 1_000_000));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const hostPeerId = `http-host-${suffix}`;
  const guestPeerId = `http-guest-${suffix}`;
  const hostSecret = `http-${randomUUID()}`;
  const reconnectSecret = randomBytes(32).toString('base64url');
  const pinMutationId = randomBytes(24).toString('base64url');
  const negotiationId = `http-smoke-${suffix}`;
  const host = await StandardHttpBridgeSmokeClient.open(capability, {
    roomId,
    role: 'host',
    peerId: hostPeerId,
  });
  let guest: StandardHttpBridgeSmokeClient | null = null;
  try {
    await host.send({
      type: 'host-auth',
      secret: hostSecret,
      desiredRoomPassword: '',
      pinMutationId,
    });
    const hostOpen = await host.waitFor(
      (message) => message.type === 'peer-open',
      'host peer-open',
    );
    if (expectedVersion && hostOpen.workerVersionId !== expectedVersion) {
      throw new Error('HTTP signaling host reached an unexpected Worker version');
    }
    if (hostOpen.roomId !== roomId || hostOpen.roomPasswordApplied !== true) {
      throw new Error('HTTP signaling host admission mismatch');
    }
    // Modern Standard-room admission keeps a mutation fence until the host
    // echoes its current desired PIN, including the passwordless case. A live
    // smoke must cross that exact boundary before admitting a guest.
    await host.send({
      type: 'room-password-set',
      password: '',
      pinMutationId,
    });
    const pinResult = await host.waitFor(
      (message) => message.type === 'room-password-result',
      'host PIN final confirmation',
    );
    if (pinResult.mutationId !== pinMutationId || pinResult.applied !== true) {
      throw new Error('HTTP signaling host PIN final confirmation mismatch');
    }

    guest = await StandardHttpBridgeSmokeClient.open(capability, {
      roomId,
      role: 'guest',
      peerId: guestPeerId,
    });
    await guest.send({ type: 'guest-auth', password: '', reconnectSecret });
    const guestOpen = await guest.waitFor(
      (message) => message.type === 'peer-open',
      'guest peer-open',
    );
    if (expectedVersion && guestOpen.workerVersionId !== expectedVersion) {
      throw new Error('HTTP signaling guest reached an unexpected Worker version');
    }
    if (guestOpen.roomId !== roomId || guestOpen.peerId !== guestPeerId) {
      throw new Error('HTTP signaling guest admission mismatch');
    }

    await guest.send({
      type: 'signal-offer',
      to: 'host',
      negotiationId,
      sdp: { type: 'offer', sdp: 'v=0\r\ns=MUSIXQUARE-http-smoke-offer\r\n' },
      metadata: { httpBridgeSmoke: true },
    });
    const offer = await host.waitFor(
      (message) => message.type === 'signal-offer' && message.from === guestPeerId,
      'relayed offer',
    );
    if (!isJsonObject(offer.sdp) || offer.sdp.type !== 'offer') {
      throw new Error('HTTP signaling offer relay mismatch');
    }
    await host.send({
      type: 'signal-answer',
      to: guestPeerId,
      negotiationId,
      sdp: { type: 'answer', sdp: 'v=0\r\ns=MUSIXQUARE-http-smoke-answer\r\n' },
    });
    const answer = await guest.waitFor(
      (message) => message.type === 'signal-answer' && message.from === hostPeerId,
      'relayed answer',
    );
    if (!isJsonObject(answer.sdp) || answer.sdp.type !== 'answer') {
      throw new Error('HTTP signaling answer relay mismatch');
    }

    console.log(
      JSON.stringify({
        ok: true,
        expectedVersion: expectedVersion || null,
        admission: { host: true, guest: true },
        relay: { offer: true, answer: true },
      }),
    );
  } finally {
    await guest?.close();
    await host.close();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
